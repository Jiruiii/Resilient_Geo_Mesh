import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DEFAULT_MAX_SOURCE_AGE_MS = 48 * 60 * 60 * 1000;
const FAILED_SOURCE_STATUSES = new Set(['unavailable', 'blocked_by_auth', 'stale']);

function dateMilliseconds(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function issue(code, message, sourceId = undefined) {
  return { code, message, ...(sourceId ? { source_id: sourceId } : {}) };
}

export function validateHealthReport({
  health,
  ready,
  feed,
  sourceStatus,
  now = new Date(),
  maxSourceAgeMs = DEFAULT_MAX_SOURCE_AGE_MS,
} = {}) {
  const currentTime = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(currentTime)) throw new TypeError('now must be a valid date');
  if (!Number.isSafeInteger(maxSourceAgeMs) || maxSourceAgeMs <= 0) {
    throw new TypeError('maxSourceAgeMs must be a positive integer');
  }

  const errors = [];
  const warnings = [];
  if (health?.status !== 'ok') errors.push(issue('HEALTH_NOT_OK', 'healthz is not ok'));
  if (ready?.status !== 'ready') errors.push(issue('READY_NOT_READY', 'readyz is not ready'));
  if (!Number.isSafeInteger(feed?.revision) || feed.revision < 1) {
    errors.push(issue('FEED_REVISION_INVALID', 'feed revision is invalid'));
  }
  const createdAt = dateMilliseconds(feed?.created_at);
  if (createdAt === null) errors.push(issue('FEED_CREATED_INVALID', 'feed created_at is invalid'));
  if (!Array.isArray(feed?.datasets)) {
    errors.push(issue('FEED_DATASETS_INVALID', 'feed datasets are invalid'));
  }
  const expiresAt = dateMilliseconds(feed?.expires_at);
  if (expiresAt === null || expiresAt <= currentTime) {
    errors.push(issue('FEED_EXPIRED', 'feed is expired'));
  }
  if (ready?.feed_revision !== undefined && ready.feed_revision !== feed?.revision) {
    errors.push(issue('READY_REVISION_MISMATCH', 'readyz and feed revisions differ'));
  }

  const failedSources = [];
  const sources = Array.isArray(sourceStatus?.sources) ? sourceStatus.sources : [];
  if (sources.length === 0) errors.push(issue('SOURCE_STATUS_EMPTY', 'source status is empty'));
  for (const source of sources) {
    const sourceId = source.source_id ?? 'unknown';
    if (source.status === 'disabled') continue;
    if (FAILED_SOURCE_STATUSES.has(source.status)) {
      const failure = {
        source_id: sourceId,
        status: source.status,
        error_code: source.error_code ?? null,
      };
      failedSources.push(failure);
      errors.push(issue('SOURCE_FAILED', `source status is ${source.status}`, sourceId));
    } else if (source.status === 'partial') {
      warnings.push(issue('SOURCE_PARTIAL', 'source is partially collected', sourceId));
    }
    const lastSuccess = dateMilliseconds(source.last_success_at ?? source.retrieved_at);
    if (lastSuccess === null) {
      errors.push(issue('SOURCE_NO_SUCCESS', 'source has no successful retrieval', sourceId));
    } else if (currentTime - lastSuccess > maxSourceAgeMs) {
      errors.push(issue('SOURCE_EXPIRED', 'source data is older than the configured limit', sourceId));
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    failed_sources: failedSources,
    feed_revision: feed?.revision ?? null,
    dataset_count: Array.isArray(feed?.datasets) ? feed.datasets.length : 0,
  };
}

function endpoint(baseUrl, pathname) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol)) throw new TypeError('baseUrl must use HTTP or HTTPS');
  return new URL(pathname, base).toString();
}

async function getJson(baseUrl, pathname, fetchImpl) {
  const response = await fetchImpl(endpoint(baseUrl, pathname), { method: 'GET' });
  if (!response || typeof response.status !== 'number' || !response.ok) {
    const error = new Error(`${pathname} returned HTTP ${response?.status ?? 'unknown'}`);
    error.code = 'HEALTH_HTTP_ERROR';
    throw error;
  }
  try {
    return await response.json();
  } catch (error) {
    const wrapped = new Error(`${pathname} returned invalid JSON`, { cause: error });
    wrapped.code = 'HEALTH_INVALID_JSON';
    throw wrapped;
  }
}

export async function runHealthCheck({
  baseUrl = process.env.SERVER_BASE_URL ?? 'http://127.0.0.1:8787',
  fetchImpl = globalThis.fetch,
  now = new Date(),
  maxSourceAgeMs = DEFAULT_MAX_SOURCE_AGE_MS,
} = {}) {
  const [health, ready, feed, sourceStatus] = await Promise.all([
    getJson(baseUrl, '/healthz', fetchImpl),
    getJson(baseUrl, '/readyz', fetchImpl),
    getJson(baseUrl, '/feed.json', fetchImpl),
    getJson(baseUrl, '/v1/source-status', fetchImpl),
  ]);
  return validateHealthReport({ health, ready, feed, sourceStatus, now, maxSourceAgeMs });
}

function cliOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--json') options.json = true;
    else if (item === '--base-url' || item === '--max-source-age-ms') {
      const value = argv[index + 1];
      if (!value) throw new Error(`missing value for ${item}`);
      options[item.slice(2).replaceAll('-', '_')] = value;
      index += 1;
    } else throw new Error(`unknown option: ${item}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = cliOptions(argv);
  const report = await runHealthCheck({
    baseUrl: options.base_url,
    maxSourceAgeMs: options.max_source_age_ms === undefined
      ? DEFAULT_MAX_SOURCE_AGE_MS
      : Number(options.max_source_age_ms),
  });
  const output = JSON.stringify(report, null, 2);
  console.log(output);
  if (!report.ok) process.exitCode = 1;
  return report;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.code ?? 'HEALTH_CHECK_ERROR', message: error.message }));
    process.exitCode = 1;
  });
}

export { DEFAULT_MAX_SOURCE_AGE_MS };
