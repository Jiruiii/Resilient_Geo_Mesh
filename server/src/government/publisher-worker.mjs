import path from 'node:path';

import { buildAttestation } from '../../../pipeline/lib/attest.mjs';
import { publishGovernmentRelease } from '../publisher/release-publisher.mjs';
import { acquireCollectorLock } from '../collector/collector-lock.mjs';

function announcementEvent(row, now) {
  const retracted = row.retracted === true;
  const issuedAt = retracted ? row.updated_at : row.updated_at;
  const location = row.location;
  return {
    schema_version: 'event-v0',
    namespace: 'official.announcement',
    event_id: row.event_id,
    event_type: 'GOVERNMENT_ANNOUNCEMENT',
    geometry: location
      ? { type: 'Point', coordinates: [location.longitude, location.latitude] }
      // event-v0 requires geometry; this private anchor is suppressed from the map unless a location was supplied.
      : { type: 'Point', coordinates: [121, 23.5] },
    severity: row.severity,
    source: 'GOVERNMENT',
    source_version: row.updated_at,
    event_version: row.event_version,
    issued_at: issuedAt,
    expires_at: retracted ? now.toISOString() : row.expires_at,
    attributes: {
      title: row.title,
      content: row.content,
      category: row.category,
      area_id: row.area_id,
      theme: 'announcement',
      has_map_location: Boolean(location),
      ...(retracted ? { publication_retracted: true, retraction_issued_at: now.toISOString() } : {}),
    },
    provenance: {
      original_source: 'government-workbench',
      received_at: now.toISOString(),
      transport_source: { kind: 'server', node_id: 'government-publisher' },
    },
  };
}

function attestationEvent(record, signingKey, now) {
  return buildAttestation({
    report: record.event,
    verdict: record.verdict,
    note: record.note ?? undefined,
    privateKey: signingKey.privateKey,
    keyId: signingKey.keyId,
    issuedAt: record.issued_at ?? now,
  });
}

async function withPublisherLock({ lockProvider, lockPath }, callback) {
  if (lockProvider?.acquire) {
    const lease = await lockProvider.acquire();
    try {
      await lease.assertHeld();
      return await callback(lease.assertHeld);
    } finally { await lease.release(); }
  }
  const release = await acquireCollectorLock(lockPath ?? path.join('/tmp/resilientgeo', 'collector.lock'));
  try { return await callback(async () => {}); } finally { await release(); }
}

/** Publish one claimed outbox batch through the central signed event-v0 feed. */
export async function publishGovernmentOutboxBatch({
  store,
  releaseRoot,
  signingKey,
  releasePointerStore,
  lockProvider,
  lockPath,
  now = new Date(),
  batchSize = 50,
} = {}) {
  if (!store) throw new TypeError('government store is required');
  if (!signingKey?.privateKey || !signingKey?.publicKey || !signingKey?.keyId) {
    throw new TypeError('central signing key is required');
  }
  try {
    return await withPublisherLock({ lockProvider, lockPath }, async (assertLockHeld) => {
      const items = await store.claimOutbox({ now, limit: batchSize });
      if (items.length === 0) return { published: false, reason: 'empty' };
      try {
        const [announcementRows, attestationRows] = await Promise.all([
          store.currentAnnouncementEvents(),
          store.currentAttestations(),
        ]);
        const announcements = announcementRows.map((row) => announcementEvent(row, now));
        const reportIds = new Set(attestationRows.map((row) => row.event.event_id));
        const staleAttestations = items.filter((item) => item.aggregateType === 'ATTESTATION' && !reportIds.has(item.aggregateId));
        if (staleAttestations.length > 0) {
          await store.markOutboxRejected(staleAttestations, 'REPORT_EXPIRED', now);
        }
        const attestations = attestationRows.map((row) => attestationEvent(row, signingKey, now));
        const publishable = items.filter((item) => !staleAttestations.includes(item));
        if (publishable.length === 0) return { published: false, reason: 'expired_reports' };
        await assertLockHeld();
        const publication = await publishGovernmentRelease({
          releaseRoot,
          results: [
            { id: 'government-announcements', namespace: 'official.announcement', status: 'ok', events: announcements },
            { id: 'government-attestations', namespace: 'official.verified', status: 'ok', events: attestations },
          ],
          signingKey: { ...signingKey, signingKeyId: signingKey.keyId },
          now,
          releasePointerStore,
        });
        await assertLockHeld();
        await store.markOutboxPublished(publishable, now);
        return { published: true, count: publishable.length, revision: publication.revision, unchanged: publication.unchanged };
      } catch (error) {
        await store.retryOutbox(items, error.code ?? 'PUBLISH_FAILED', now);
        return { published: false, reason: 'retry_scheduled', code: error.code ?? 'PUBLISH_FAILED' };
      }
    });
  } catch (error) {
    if (error.code === 'COLLECTOR_LOCK_HELD') return { published: false, reason: 'lock_held' };
    throw error;
  }
}

export { announcementEvent };
