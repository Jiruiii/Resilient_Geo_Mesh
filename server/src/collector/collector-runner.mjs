import path from 'node:path';
import { collectSources as defaultCollectSources } from '../../../pipeline/lib/source-collector.mjs';
import { acquireCollectorLock } from './collector-lock.mjs';
import { isPublishableResult } from './medical-release-policy.mjs';

export async function runScheduledCollection({
  sourceIds,
  scope,
  config = {},
  cacheStore,
  publisher,
  now = new Date(),
  collectSources = defaultCollectSources,
  onFailure,
} = {}) {
  if (typeof publisher !== 'function') throw new TypeError('publisher is required');
  const lockPath = config.collectorLockPath
    ?? path.join(config.privateDataRoot ?? '/tmp/resilientgeo', 'collector.lock');
  let release;
  let assertLockHeld = async () => {};
  try {
    if (config.collectorLockProvider && typeof config.collectorLockProvider.acquire === 'function') {
      const lease = await config.collectorLockProvider.acquire();
      release = () => lease.release();
      assertLockHeld = () => lease.assertHeld();
    } else {
      release = await acquireCollectorLock(lockPath);
    }
  } catch (error) {
    if (error.code === 'COLLECTOR_LOCK_HELD') return { skipped: true, reason: 'lock_held' };
    throw error;
  }
  try {
    const results = await collectSources({ sourceIds, scope, config, cacheStore, now });
    const failed = results.filter((result) => !isPublishableResult(result));
    await assertLockHeld();
    if (failed.length > 0) {
      const statusResults = results.map((result) => {
        const sourceId = result?.sourceId ?? result?.id;
        if (sourceId !== 'taiwan-medical' || isPublishableResult(result)
          || ['unavailable', 'blocked_by_auth'].includes(result?.status)) return result;
        return {
          ...result,
          status: 'partial',
          errorCode: result.errorCode ?? 'MEDICAL_LAYER_INCOMPLETE',
          coordinateReport: result.coordinateReport ?? result.normalized?.coordinate_report,
        };
      });
      const statusPublication = typeof onFailure === 'function'
        ? await onFailure(statusResults, { assertLockHeld })
        : {};
      return {
        skipped: true,
        reason: 'source_failure',
        source_count: statusResults.length,
        source_statuses: statusResults.map(({ sourceId, id, status, errorCode }) => ({
          source_id: sourceId ?? id,
          status,
          error_code: errorCode ?? null,
        })),
        failed_sources: statusResults.filter((result) => !isPublishableResult(result))
          .map(({ sourceId, id, status, errorCode }) => ({
          source_id: sourceId ?? id,
          status,
          error_code: errorCode ?? null,
        })),
        ...statusPublication,
      };
    }
    const publication = await publisher(results, { assertLockHeld });
    return {
      ...publication,
      source_count: results.length,
      source_statuses: results.map(({ sourceId, status }) => ({ source_id: sourceId, status })),
    };
  } finally {
    await release();
  }
}
