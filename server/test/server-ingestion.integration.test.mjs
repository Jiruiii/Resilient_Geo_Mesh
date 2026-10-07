import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { buildApp } from '../src/app.mjs';
import { createCollectorService } from '../src/collector-entrypoint.mjs';
import { createMemoryCacheStore } from '../../pipeline/lib/source-collector.mjs';
import { makeRawSnapshot } from '../../pipeline/lib/source.mjs';
import { generateEd25519KeyPair } from '../../pipeline/lib/crypto.mjs';
import { verifyFeatureBundle } from '../../pipeline/lib/feature-bundle.mjs';
import { verifyFeed } from '../../pipeline/lib/government-feed.mjs';
import { createReleaseStore } from '../src/storage/release-store.mjs';
import { publishGovernmentRelease, publishStaticLayer } from '../src/publisher/release-publisher.mjs';
import { getSourceDefinition } from '../src/source-registry.mjs';

const keys = generateEd25519KeyPair();
const signingKeyId = 'server-integration-test';
const fixtureEvent = JSON.parse(readFileSync(new URL('../../fixtures/events-batch-1.json', import.meta.url))).events[0];
const sourceIds = ['tdx-road-events', 'cwa-earthquake', 'ncdr-hazard-events', 'taiwan-shelter'];

function event(sourceId) {
  return {
    ...fixtureEvent,
    event_id: `${sourceId}:integration`,
    expires_at: '2026-10-03T12:00:00Z',
    attributes: { area_id: 'tw.63000100', theme: 'road', status: 'OPEN' },
  };
}

function shelterFeature() {
  const timestamp = '2026-10-02T12:00:00Z';
  return {
    schema_version: 'feature-v0',
    namespace: 'official.shelter',
    dataset_id: 'resilientgeo-taiwan',
    layer_id: 'taiwan-shelter',
    feature_id: 'shelter:integration',
    feature_type: 'SHELTER',
    geometry: { type: 'Point', coordinates: [121.505, 25.005] },
    properties: { name: 'Integration shelter' },
    source: 'taiwan-shelter',
    source_version: 'integration',
    issued_at: timestamp,
    expires_at: '2026-10-03T12:00:00Z',
    signature_algorithm: 'Ed25519',
    signing_key_id: signingKeyId,
    provenance: {
      original_source: 'taiwan-shelter',
      received_at: timestamp,
      transport_source: { kind: 'fake-upstream' },
    },
  };
}

function snapshot(sourceId, now, revision) {
  return makeRawSnapshot({
    sourceId,
    request: { method: 'GET', url: `https://upstream.test/${sourceId}`, query: {} },
    responseStatus: 200,
    responseHeaders: { etag: `"${sourceId}-${revision}"` },
    retrievedAt: now.toISOString(),
    payload: { source_id: sourceId, revision, records: [] },
  });
}

async function temporaryRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'resilientgeo-integration-'));
}

test('one scheduled collector feeds repeated API reads, conditional cache hits, and last-known-good release', async () => {
  const releaseRoot = await temporaryRoot();
  const privateRoot = await temporaryRoot();
  try {
    const cacheStore = createMemoryCacheStore();
    const calls = { tdx: 0, cwa: 0, ncdrIndex: 0, ncdrDetail: 0, shelter: 0 };
    let round = 1;
    let failCwa = false;
    let latestStates = [];
    let publicationNow = new Date('2026-10-02T12:00:00Z');
    const adapters = Object.fromEntries(sourceIds.map((sourceId) => [sourceId, async ({ previousSnapshot }) => {
      if (round > 1 && sourceId === 'cwa-earthquake' && failCwa) {
        const error = new Error('fake upstream returned 503');
        error.code = 'UPSTREAM_503';
        error.status = 503;
        throw error;
      }
      if (previousSnapshot) return { mode: 'live', notModified: true };
      if (sourceId === 'tdx-road-events') calls.tdx += 1;
      if (sourceId === 'cwa-earthquake') calls.cwa += 1;
      if (sourceId === 'ncdr-hazard-events') {
        calls.ncdrIndex += 1;
        calls.ncdrDetail += 1;
      }
      if (sourceId === 'taiwan-shelter') calls.shelter += 1;
      const rawSnapshot = snapshot(sourceId, publicationNow, round);
      if (sourceId === 'taiwan-shelter') {
        return {
          mode: 'live',
          rawSnapshot,
          normalized: {
            schema_version: 'static-normalized-v0',
            source_id: sourceId,
            retrieved_at: rawSnapshot.retrieved_at,
            feature_count: 1,
            status_event_count: 0,
            features: [shelterFeature()],
            status_events: [],
          },
          features: [shelterFeature()],
          status_events: [],
        };
      }
      const events = [event(sourceId)];
      return {
        mode: 'live',
        rawSnapshot,
        normalized: {
          schema_version: 'event-batch-v0',
          source_id: sourceId,
          retrieved_at: rawSnapshot.retrieved_at,
          event_count: events.length,
          events,
        },
        events,
      };
    }]));

    const publisher = async (results) => {
      const government = await publishGovernmentRelease({
        releaseRoot,
        previousRoot: releaseRoot,
        results,
        signingKey: { privateKey: keys.privateKey, publicKey: keys.publicKey, keyId: signingKeyId },
        now: publicationNow,
      });
      for (const result of results.filter((item) => item.kind === 'static' && item.features.length > 0)) {
        if (result.status === 'not_modified') continue;
        await publishStaticLayer({
          layerId: result.feedId ?? result.sourceId,
          features: result.features,
          releaseRoot,
          signingKey: { privateKey: keys.privateKey, publicKey: keys.publicKey, keyId: signingKeyId },
          now: publicationNow,
        });
      }
      latestStates = results.map((result) => ({
        source_id: result.sourceId,
        status: result.status,
        checked_at: publicationNow.toISOString(),
        retrieved_at: result.retrievedAt ?? null,
        last_success_at: result.status === 'unavailable' ? null : result.retrievedAt ?? null,
        revision: government.revision,
        error_code: result.errorCode ?? null,
      }));
      return government;
    };

    const collector = createCollectorService({
      config: { privateDataRoot: privateRoot, collectorLockPath: path.join(privateRoot, 'collector.lock') },
      cacheStore,
      sourceIds,
      adapters,
      collectSources: async ({ sourceIds: selected, config, cacheStore: store, now }) => {
        const { collectSources } = await import('../../pipeline/lib/source-collector.mjs');
        return collectSources({ sourceIds: selected, config, cacheStore: store, now, adapters });
      },
      publisher,
    });

    await collector.runOnce({ now: publicationNow });
    const releaseStore = createReleaseStore({ releaseRoot });
    const app = buildApp({
      config: { signingPublicKey: keys.publicKey, signingKeyId, serverVersion: 'integration' },
      releaseStore,
      sourceStateStore: { async list() { return latestStates; } },
      logger: false,
    });
    try {
      const firstReads = await Promise.all([
        app.inject('/feed.json'),
        app.inject('/feed.json'),
        app.inject('/feed.json'),
      ]);
      assert.deepEqual(firstReads.map((response) => response.statusCode), [200, 200, 200]);
      assert.deepEqual(calls, { tdx: 1, cwa: 1, ncdrIndex: 1, ncdrDetail: 1, shelter: 1 });
      const firstFeed = await releaseStore.readFeed();
      assert.doesNotThrow(() => verifyFeed(firstFeed, keys.publicKey, { signingKeyId }));
      const firstLayer = await releaseStore.readLayerBundle('taiwan-shelter');
      assert.equal(verifyFeatureBundle(firstLayer, keys.publicKey, { trustedKeyIds: [signingKeyId] }).valid, true);

      round = 2;
      failCwa = true;
      publicationNow = new Date('2026-10-02T12:10:00Z');
      await collector.runOnce({ now: publicationNow });
      assert.deepEqual(calls, { tdx: 1, cwa: 1, ncdrIndex: 1, ncdrDetail: 1, shelter: 1 });
      const secondReads = await Promise.all([app.inject('/feed.json'), app.inject('/v1/metadata')]);
      assert.equal(secondReads[0].statusCode, 200);
      assert.equal(secondReads[1].statusCode, 200);
      const status = await app.inject('/v1/source-status');
      const cwaStatus = status.json().sources.find((source) => source.source_id === 'cwa-earthquake');
      assert.equal(cwaStatus.status, 'ok');
      const secondFeed = await releaseStore.readFeed();
      assert.deepEqual(secondFeed, firstFeed);
      assert.equal(secondFeed.datasets.some((dataset) => dataset.source_id === 'tdx-road'), true);
    } finally {
      await app.close();
    }

    assert.equal(getSourceDefinition('tdx-road-events').feedId, 'tdx-road');
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
    await rm(privateRoot, { recursive: true, force: true });
  }
});


