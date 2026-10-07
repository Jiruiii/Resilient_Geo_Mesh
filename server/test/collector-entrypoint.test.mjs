import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createMemoryCacheStore } from '../../pipeline/lib/source-collector.mjs';
import { generateEd25519KeyPair } from '../../pipeline/lib/crypto.mjs';
import { TAIWAN_COUNTIES } from '../../pipeline/sources/taiwan-counties.mjs';
import { isPublishableResult } from '../src/collector/medical-release-policy.mjs';
import {
  createCollectorService,
  resolveInitialSourceIds,
} from '../src/collector-entrypoint.mjs';
import { createReleaseStore } from '../src/storage/release-store.mjs';
import { defaultSourceIds, SOURCE_REGISTRY } from '../src/source-registry.mjs';

const NOW = new Date('2026-10-02T12:00:00Z');
const keys = generateEd25519KeyPair();
const signingKey = { privateKey: keys.privateKey, publicKey: keys.publicKey, keyId: 'collector-transaction-test' };
const eventFixture = JSON.parse(readFileSync(new URL('../../fixtures/events-batch-1.json', import.meta.url))).events[0];

function layerFeature(layerId, featureId) {
  return {
    schema_version: 'feature-v0',
    namespace: layerId === 'taiwan-emergency-medical' ? 'official.emergency-medical' : 'official.static',
    dataset_id: `dataset-${layerId}`,
    layer_id: layerId,
    feature_id: featureId,
    feature_type: layerId === 'taiwan-emergency-medical' ? 'HOSPITAL' : 'SHELTER',
    geometry: { type: 'Point', coordinates: [121.5, 25] },
    properties: { name: featureId },
    source: layerId,
    source_version: 'collector-test-v1',
    issued_at: NOW.toISOString(),
    expires_at: new Date(NOW.getTime() + 86_400_000).toISOString(),
    signature_algorithm: 'Ed25519',
    signing_key_id: signingKey.keyId,
    provenance: {
      original_source: layerId,
      received_at: NOW.toISOString(),
      transport_source: { kind: 'server', node_id: 'collector-test' },
    },
  };
}

function completeMedicalResult() {
  const point = layerFeature('taiwan-medical', 'medical:atomic001');
  point.feature_type = 'CLINIC';
  point.properties = {
    name: 'Atomic pointer clinic',
    address: '臺北市內湖區內湖路1號',
    administrative_area: '臺北市內湖區',
    county_code: '63000',
    coordinate_source: 'official-medical-coordinate',
    coordinate_source_version: 'collector-test-v1',
    coordinate_match_method: 'source_coordinates',
    source_record: {
      機構代碼: 'ATOMIC001',
      機構名稱: 'Atomic pointer clinic',
      地址: '臺北市內湖區內湖路1號',
    },
  };
  const directory = layerFeature('taiwan-medical-directory', 'medical-directory:atomic001');
  directory.feature_type = 'MEDICAL_DIRECTORY_ENTRY';
  directory.geometry = null;
  directory.properties = {
    geometry_status: 'located',
    point_feature_id: point.feature_id,
    county_code: '63000',
  };
  return {
    sourceId: 'taiwan-medical',
    kind: 'static',
    status: 'ok',
    publishable: true,
    features: [point],
    normalized: {
      unresolved_medical_count: 0,
      unresolved_medical: [],
      excluded_medical: [],
      coordinate_report: {
        source_count: 1,
        matched_count: 1,
        unresolved_count: 0,
        county_coverage: {
          status: 'complete',
          county_count: TAIWAN_COUNTIES.length,
          source_count: 1,
          located_count: 1,
          unlocated_count: 0,
          excluded_count: 0,
          unassigned_count: 0,
          counties: TAIWAN_COUNTIES.map((county) => ({
            county_code: county.code,
            county_name: county.name,
            status: 'complete',
            master_count: county.code === '63000' ? 1 : 0,
            located_count: county.code === '63000' ? 1 : 0,
            unlocated_count: 0,
            excluded_count: 0,
          })),
        },
      },
      medical_directory_features: [directory],
    },
    emergencyMedicalFeatures: [layerFeature('taiwan-emergency-medical', 'emergency:atomic-pointer')],
  };
}

test('medical publication accepts manually reviewed address corrections', () => {
  const result = completeMedicalResult();
  result.features[0].properties.coordinate_match_method = 'reviewed_address_correction';

  assert.equal(isPublishableResult(result), true);
});

function cachedResult(sourceId, event) {
  return {
    snapshot: {
      schema_version: 'raw-snapshot-v0',
      source_id: sourceId,
      request: { method: 'GET', url: `https://upstream.test/${sourceId}`, query: {} },
      response: { status: 200, headers: {} },
      retrieved_at: NOW.toISOString(),
      payload: { records: [] },
    },
    normalized: {
      schema_version: 'event-batch-v0',
      source_id: sourceId,
      retrieved_at: NOW.toISOString(),
      event_count: 1,
      events: [event],
    },
    state: {
      schema_version: 'source-state-v1',
      source_id: sourceId,
      status: 'ok',
      checked_at: NOW.toISOString(),
      retrieved_at: NOW.toISOString(),
      last_success_at: NOW.toISOString(),
      error_code: null,
    },
  };
}

test('collector initial run can select only an enabled source', () => {
  assert.deepEqual(resolveInitialSourceIds('taiwan-medical'), ['taiwan-medical']);
});

test('collector initial source selection defaults safely and rejects invalid IDs', () => {
  assert.deepEqual(resolveInitialSourceIds(undefined), [
    'cwa-earthquake',
    'cwa-weather-warning',
    'cwa-typhoon-warning',
    'ncdr-hazard-events',
    'taiwan-shelter',
    'taiwan-medical',
  ]);
  for (const value of ['unknown-source', 'osm-taiwan', 'taiwan-medical,taiwan-medical', 'taiwan-medical,']) {
    assert.throws(() => resolveInitialSourceIds(value), TypeError, value);
  }
});

test('scheduled source collection publishes a complete result set from fresh and cached sources', async () => {
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), 'resilientgeo-complete-results-'));
  try {
    const cacheStore = createMemoryCacheStore();
    const cachedEvent = { event_id: 'weather:cached', expires_at: '2026-10-03T00:00:00Z' };
    await cacheStore.writeResult('cwa-weather-warning', cachedResult('cwa-weather-warning', cachedEvent));

    let published;
    const collector = createCollectorService({
      config: { privateDataRoot: privateRoot },
      cacheStore,
      sourceIds: ['cwa-earthquake', 'cwa-weather-warning'],
      collectSources: async ({ sourceIds }) => sourceIds.map((sourceId) => ({
        sourceId,
        feedId: sourceId === 'cwa-earthquake' ? 'cwa-earthquake' : 'cwa-warning',
        kind: 'dynamic',
        status: 'ok',
        retrievedAt: NOW.toISOString(),
        events: [{ event_id: 'earthquake:fresh', expires_at: '2026-10-03T00:00:00Z' }],
      })),
      publisher: async (results) => {
        published = results;
        return { revision: 1 };
      },
    });

    await collector.runOnce({ selectedSourceIds: ['cwa-earthquake'], now: NOW });

    assert.deepEqual(published.map((result) => result.sourceId), [
      'cwa-earthquake',
      'cwa-weather-warning',
    ]);
    assert.equal(published[1].status, 'not_modified');
    assert.deepEqual(published[1].events, [cachedEvent]);
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test('collector commits feed, v2, and static layer versions through one release pointer', async () => {
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), 'resilientgeo-atomic-pointer-private-'));
  const publicRoot = await mkdtemp(path.join(os.tmpdir(), 'resilientgeo-atomic-pointer-public-'));
  let remotePointer = null;
  let pointerCommits = 0;
  const releasePointerStore = {
    async read() { return remotePointer; },
    async commit(pointer) { remotePointer = structuredClone(pointer); pointerCommits += 1; },
  };
  try {
    const collectSources = async ({ sourceIds }) => sourceIds.map((sourceId) => {
      const definition = SOURCE_REGISTRY.find((source) => source.sourceId === sourceId);
      if (definition.kind === 'dynamic') {
        return {
          sourceId,
          feedId: definition.feedId,
          kind: 'dynamic',
          status: 'ok',
          retrievedAt: NOW.toISOString(),
          events: [{
            ...eventFixture,
            event_id: `${definition.feedId}:atomic-pointer`,
            expires_at: new Date(NOW.getTime() + 86_400_000).toISOString(),
            attributes: { ...eventFixture.attributes, area_id: 'tw.63000100', theme: 'hazard' },
          }],
        };
      }
      if (sourceId === 'taiwan-medical') return completeMedicalResult();
      const features = [layerFeature(sourceId, `${sourceId}:atomic-pointer`)];
      return {
        sourceId,
        kind: 'static',
        status: 'ok',
        publishable: true,
        features,
        emergencyMedicalFeatures: [],
      };
    });
    const service = createCollectorService({
      config: { privateDataRoot: privateRoot, publicReleaseRoot: publicRoot, releasePointerStore },
      cacheStore: createMemoryCacheStore(),
      collectSources,
      signingKey,
    });

    const report = await service.runOnce({ now: NOW });
    const store = createReleaseStore({ releaseRoot: publicRoot });
    const pointer = await store.readCurrentPointer();
    const feed = await store.readFeed();
    const v2 = await store.readV2Feed();

    assert.equal(report.revision, 1);
    assert.equal(pointerCommits, 1);
    assert.equal(remotePointer.revision, feed.revision);
    assert.equal(v2.revision, feed.revision);
    assert.deepEqual(Object.keys(pointer.layers).sort(), [
      'taiwan-emergency-medical', 'taiwan-medical', 'taiwan-medical-directory', 'taiwan-shelter',
    ]);
    assert.equal((await store.readLayerBundle('taiwan-emergency-medical')).manifest.dataset_version, 1);
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
    await rm(publicRoot, { recursive: true, force: true });
  }
});
