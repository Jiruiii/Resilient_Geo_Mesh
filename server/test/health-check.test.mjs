import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runHealthCheck, validateHealthReport } from '../src/ops/health-check.mjs';

const NOW = new Date('2026-10-02T12:00:00Z');

function validPayload() {
  return {
    health: { status: 'ok' },
    ready: { status: 'ready', feed_revision: 7, checked_at: NOW.toISOString() },
    feed: {
      schema_version: 'government-feed-v1',
      revision: 7,
      created_at: '2026-10-02T11:50:00Z',
      expires_at: '2026-10-03T11:50:00Z',
      datasets: [{ source_id: 'ncdr' }],
    },
    sourceStatus: {
      sources: [{
        source_id: 'ncdr-hazard-events',
        status: 'ok',
        checked_at: NOW.toISOString(),
        retrieved_at: NOW.toISOString(),
        last_success_at: NOW.toISOString(),
        error_code: null,
      }],
    },
  };
}

test('health validation accepts a current empty feed but detects expired feeds and failed sources', () => {
  const emptyPayload = validPayload();
  emptyPayload.feed.datasets = [];
  const emptyReport = validateHealthReport({ ...emptyPayload, now: NOW, maxSourceAgeMs: 60_000 });
  assert.equal(emptyReport.ok, true);
  assert.equal(emptyReport.dataset_count, 0);

  const payload = validPayload();
  payload.feed.expires_at = '2026-10-02T11:00:00Z';
  payload.sourceStatus.sources[0].status = 'unavailable';
  payload.sourceStatus.sources[0].error_code = 'HTTP_ERROR';

  const report = validateHealthReport({ ...payload, now: NOW, maxSourceAgeMs: 60_000 });

  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.code === 'FEED_EXPIRED'));
  assert.ok(report.errors.some((error) => error.code === 'SOURCE_FAILED'));
});

test('runHealthCheck reads the four public endpoints without calling upstream sources', async () => {
  const payload = validPayload();
  const calls = [];
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    calls.push(pathname);
    const body = pathname === '/healthz'
      ? payload.health
      : pathname === '/readyz'
        ? payload.ready
        : pathname === '/feed.json'
          ? payload.feed
          : payload.sourceStatus;
    return { status: 200, ok: true, async json() { return body; } };
  };

  const report = await runHealthCheck({
    baseUrl: 'http://127.0.0.1:8787',
    fetchImpl,
    now: NOW,
    maxSourceAgeMs: 60 * 60 * 1000,
  });

  assert.equal(report.ok, true);
  assert.deepEqual(calls.sort(), ['/feed.json', '/healthz', '/readyz', '/v1/source-status']);
  assert.equal(report.feed_revision, 7);
  assert.deepEqual(report.failed_sources, []);
});
