import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acquireCollectorLock } from '../src/collector/collector-lock.mjs';
import { runScheduledCollection } from '../src/collector/collector-runner.mjs';

test('acquireCollectorLock permits one writer and releases it for the next writer', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'resilientgeo-collector-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'collector.lock');
  const release = await acquireCollectorLock(lockPath);
  await assert.rejects(acquireCollectorLock(lockPath), /already held/u);
  await release();
  const secondRelease = await acquireCollectorLock(lockPath);
  await secondRelease();
});

test('acquireCollectorLock recovers an empty stale lock', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'resilientgeo-stale-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'collector.lock');
  await writeFile(lockPath, '');

  const release = await acquireCollectorLock(lockPath);
  await release();
});

test('acquireCollectorLock recovers a persisted lock after a container PID is reused', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'resilientgeo-reused-pid-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'collector.lock');
  await writeFile(lockPath, JSON.stringify({
    pid: process.pid,
    acquired_at: '2026-10-02T07:39:31.826Z',
  }));

  const release = await acquireCollectorLock(lockPath);
  await release();
});

test('runScheduledCollection skips a source when the global lock is held', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'resilientgeo-overlap-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'collector.lock');
  const heldRelease = await acquireCollectorLock(lockPath);
  let collected = false;
  let published = false;

  const report = await runScheduledCollection({
    sourceIds: ['tdx-road-events'],
    config: { collectorLockPath: lockPath },
    collectSources: async () => {
      collected = true;
      return [];
    },
    publisher: async () => {
      published = true;
      return { revision: 1 };
    },
  });

  assert.deepEqual(report, { skipped: true, reason: 'lock_held' });
  assert.equal(collected, false);
  assert.equal(published, false);
  await heldRelease();
});

test('runScheduledCollection publishes collected results under one global run', async () => {
  const calls = [];
  const published = [];
  const report = await runScheduledCollection({
    sourceIds: ['tdx-road-events', 'cwa-earthquake'],
    config: { collectorLockPath: '/tmp/resilientgeo-test-collector.lock' },
    cacheStore: {},
    now: new Date('2026-10-02T00:00:00Z'),
    collectSources: async ({ sourceIds }) => {
      calls.push(sourceIds);
      return sourceIds.map((sourceId) => ({ sourceId, status: 'ok', events: [] }));
    },
    publisher: async (results) => {
      published.push(results);
      return { revision: 1 };
    },
  });

  assert.deepEqual(calls, [['tdx-road-events', 'cwa-earthquake']]);
  assert.equal(published.length, 1);
  assert.equal(report.revision, 1);
  assert.equal(report.source_count, 2);
});

test('runScheduledCollection preserves the current release when a source fails', async () => {
  let published = false;
  const report = await runScheduledCollection({
    sourceIds: ['cwa-earthquake', 'ncdr-hazard-events'],
    config: { collectorLockPath: '/tmp/resilientgeo-test-source-failure.lock' },
    cacheStore: {},
    collectSources: async () => [
      { sourceId: 'cwa-earthquake', status: 'ok', events: [] },
      {
        sourceId: 'ncdr-hazard-events',
        status: 'unavailable',
        errorCode: 'NCDR_REQUEST_ERROR',
        usedLastKnownGood: true,
        events: [{ event_id: 'shelter:previous' }],
      },
    ],
    publisher: async () => {
      published = true;
      return { revision: 2 };
    },
  });

  assert.equal(report.skipped, true);
  assert.equal(report.reason, 'source_failure');
  assert.equal(report.source_count, 2);
  assert.equal(published, false);
});

test('runScheduledCollection routes incomplete medical data to source-status publication', async () => {
  let published;
  let failureResults;
  const report = await runScheduledCollection({
    sourceIds: ['cwa-earthquake', 'taiwan-medical'],
    config: { collectorLockPath: '/tmp/resilientgeo-test-partial-static.lock' },
    collectSources: async () => [
      { sourceId: 'cwa-earthquake', status: 'ok', events: [{ event_id: 'earthquake:one' }] },
      {
        sourceId: 'taiwan-medical',
        kind: 'static',
        status: 'ok',
        publishable: true,
        features: [{ feature_id: 'medical:one' }],
        unresolved_count: 1,
        normalized: {
          unresolved_medical_count: 1,
          coordinate_report: {
            source_count: 12,
            matched_count: 1,
            unresolved_count: 11,
          },
        },
      },
    ],
    publisher: async (results) => {
      published = results;
      return { revision: 3 };
    },
    onFailure: async (results) => {
      failureResults = results;
      return { status_revision: 2 };
    },
  });

  assert.equal(report.skipped, true);
  assert.equal(report.reason, 'source_failure');
  assert.equal(report.status_revision, 2);
  assert.equal(published, undefined);
  assert.equal(failureResults[1].status, 'partial');
  assert.equal(failureResults[1].errorCode, 'MEDICAL_LAYER_INCOMPLETE');
  assert.deepEqual(failureResults[1].coordinateReport, {
    source_count: 12,
    matched_count: 1,
    unresolved_count: 11,
  });
});

test('runScheduledCollection still allows non-medical non-empty partial static data', async () => {
  let published;
  const report = await runScheduledCollection({
    sourceIds: ['taiwan-shelter'],
    config: { collectorLockPath: '/tmp/resilientgeo-test-partial-shelter.lock' },
    collectSources: async () => [{
      sourceId: 'taiwan-shelter',
      kind: 'static',
      status: 'partial',
      publishable: true,
      features: [{ feature_id: 'shelter:one' }],
    }],
    publisher: async (results) => {
      published = results;
      return { revision: 4 };
    },
  });

  assert.equal(report.revision, 4);
  assert.equal(published[0].status, 'partial');
});

test('runScheduledCollection reports failed results without invoking the release publisher', async () => {
  let failureResults;
  const report = await runScheduledCollection({
    sourceIds: ['cwa-earthquake'],
    config: { collectorLockPath: '/tmp/resilientgeo-test-failure-status.lock' },
    collectSources: async () => [{ sourceId: 'cwa-earthquake', status: 'unavailable', errorCode: 'HTTP_ERROR' }],
    publisher: async () => { throw new Error('must not publish failed feed'); },
    onFailure: async (results) => {
      failureResults = results;
      return { status_revision: 2 };
    },
  });

  assert.equal(report.reason, 'source_failure');
  assert.equal(report.status_revision, 2);
  assert.equal(failureResults[0].errorCode, 'HTTP_ERROR');
});

test('runScheduledCollection stops before pointer publication when the Azure lease is lost', async () => {
  let leaseLost = false;
  let released = false;
  let published = false;
  await assert.rejects(runScheduledCollection({
    sourceIds: ['cwa-earthquake'],
    config: {
      collectorLockProvider: {
        async acquire() {
          return {
            async assertHeld() {
              if (leaseLost) {
                const error = new Error('lease lost');
                error.code = 'COLLECTOR_LEASE_LOST';
                throw error;
              }
            },
            async release() { released = true; },
          };
        },
      },
    },
    collectSources: async () => {
      leaseLost = true;
      return [{ sourceId: 'cwa-earthquake', status: 'ok', events: [{ event_id: 'earthquake:one' }] }];
    },
    publisher: async () => {
      published = true;
      return { revision: 1 };
    },
  }), { code: 'COLLECTOR_LEASE_LOST' });

  assert.equal(published, false);
  assert.equal(released, true);
});
