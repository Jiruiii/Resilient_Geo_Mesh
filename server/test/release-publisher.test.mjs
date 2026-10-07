import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { generateEd25519KeyPair } from '../../pipeline/lib/crypto.mjs';
import { TAIWAN_COUNTIES } from '../../pipeline/sources/taiwan-counties.mjs';
import { verifyBundle } from '../../pipeline/lib/contract.mjs';
import { verifyFeatureBundle } from '../../pipeline/lib/feature-bundle.mjs';
import { buildGovernmentFeed, verifyFeed } from '../../pipeline/lib/government-feed.mjs';
import { verifyGovernmentFeedV2 } from '../../pipeline/lib/government-feed-v2.mjs';
import { createReleaseStore } from '../src/storage/release-store.mjs';
import { runScheduledCollection } from '../src/collector/collector-runner.mjs';
import {
  publishGovernmentRelease,
  publishSourceStatus,
  publishStaticLayer,
  readCurrentFeed,
  readCurrentLayer,
} from '../src/publisher/release-publisher.mjs';

const keys = generateEd25519KeyPair();
const signingKey = {
  privateKey: keys.privateKey,
  publicKey: keys.publicKey,
  keyId: 'server-release-test',
};
const now = new Date('2026-10-02T12:00:00Z');
const fixtureEvent = JSON.parse(readFileSync(new URL('../../fixtures/events-batch-1.json', import.meta.url))).events[0];

function event(status = 'CLOSED') {
  return {
    ...fixtureEvent,
    event_id: 'road:release-test',
    expires_at: '2026-10-03T12:00:00Z',
    attributes: { area_id: 'tw.63000100', theme: 'road', status },
  };
}

function feature(layerId = 'taiwan-shelter') {
  return {
    schema_version: 'feature-v0',
    namespace: 'official.shelter',
    dataset_id: 'resilientgeo-taiwan',
    layer_id: layerId,
    feature_id: 'shelter:release-test',
    feature_type: 'SHELTER',
    geometry: { type: 'Point', coordinates: [121.505, 25.005] },
    properties: { name: 'Release test shelter' },
    source: 'taiwan-shelter',
    source_version: 'release-test',
    issued_at: now.toISOString(),
    expires_at: '2026-10-03T12:00:00Z',
    signature_algorithm: 'Ed25519',
    signing_key_id: signingKey.keyId,
    provenance: {
      original_source: 'taiwan-shelter',
      received_at: now.toISOString(),
      transport_source: { kind: 'server' },
    },
  };
}

function medicalPoint(code = 'FAC001') {
  const value = feature('taiwan-medical');
  return {
    ...value,
    feature_id: `medical:${code.toLowerCase()}`,
    feature_type: 'CLINIC',
    properties: {
      name: 'Release test clinic',
      address: '臺北市內湖區內湖路1號',
      administrative_area: '臺北市內湖區',
      county_code: '63000',
      coordinate_source: 'official-doorplate:63000',
      coordinate_source_version: 'release-test-v1',
      coordinate_match_method: 'exact_address_doorplate',
      source_record: {
        機構代碼: code,
        機構名稱: 'Release test clinic',
        地址: '臺北市內湖區內湖路1號',
      },
    },
  };
}

function medicalDirectoryEntry(featureValue, id = featureValue.feature_id) {
  return {
    ...feature('taiwan-medical-directory'),
    feature_id: `medical-directory:${id.replace(/^medical:/u, '')}`,
    feature_type: 'MEDICAL_DIRECTORY_ENTRY',
    geometry: null,
    properties: {
      geometry_status: 'located',
      point_feature_id: featureValue.feature_id,
      county_code: featureValue.properties.county_code,
    },
  };
}

function completeMedicalResult() {
  const point = medicalPoint();
  return {
    sourceId: 'taiwan-medical',
    kind: 'static',
    status: 'ok',
    publishable: true,
    features: [point],
    normalized: {
      coordinate_report: {
        source_count: 1,
        matched_count: 1,
        unresolved_count: 0,
        rejected_coordinate_count: 0,
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
      unresolved_medical_count: 0,
      unresolved_medical: [],
      excluded_medical: [],
      medical_directory_features: [medicalDirectoryEntry(point)],
    },
  };
}

async function temporaryRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'resilientgeo-release-'));
}

test('publishes a server-signed government release without Android trust assets', async () => {
  const releaseRoot = await temporaryRoot();
  try {
    const metadata = await publishGovernmentRelease({
      releaseRoot,
      previousRoot: releaseRoot,
      results: [{ id: 'tdx-road', status: 'ok', events: [event()], retrievedAt: now.toISOString() }],
      signingKey,
      now,
    });
    const feed = await readCurrentFeed(releaseRoot);
    assert.equal(metadata.revision, 1);
    assert.equal(feed.signing_key_id, signingKey.keyId);
    assert.doesNotThrow(() => verifyFeed(feed, keys.publicKey, { signingKeyId: signingKey.keyId }));

    const chunk = JSON.parse(await readFile(path.join(releaseRoot, feed.datasets[0].chunk_paths[0]), 'utf8'));
    assert.equal(verifyBundle({ manifest: feed.datasets[0].manifest, chunks: [chunk] }, keys.publicKey, {
      trustedKeyIds: [signingKey.keyId],
    }).valid, true);
    const statuses = await createReleaseStore({ releaseRoot }).readSourceStatus();
    assert.equal(statuses[0].source_id, 'tdx-road');
    assert.equal(statuses[0].status, 'ok');
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test('rejects incomplete medical results without replacing the last known good release or layer', async () => {
  const releaseRoot = await temporaryRoot();
  try {
    await publishGovernmentRelease({
      releaseRoot,
      results: [{ id: 'tdx-road', status: 'ok', events: [event()] }],
      signingKey,
      now,
    });
    await publishStaticLayer({
      layerId: 'taiwan-medical',
      features: [medicalPoint('OLD001')],
      releaseRoot,
      signingKey,
      now,
    });
    const feedBefore = await readFile(path.join(releaseRoot, 'current', 'feed.json'));
    const layerBefore = await readCurrentLayer(releaseRoot, 'taiwan-medical');
    const incomplete = completeMedicalResult();
    incomplete.status = 'partial';
    incomplete.features = [medicalPoint('FAC001')];
    incomplete.normalized.coordinate_report = {
      source_count: 10,
      matched_count: 1,
      unresolved_count: 9,
      rejected_coordinate_count: 0,
    };
    incomplete.normalized.medical_directory_features = [medicalDirectoryEntry(incomplete.features[0])];

    await assert.rejects(publishGovernmentRelease({
      releaseRoot,
      previousRoot: releaseRoot,
      results: [
        { id: 'tdx-road', status: 'ok', events: [event('OPEN')] },
        incomplete,
      ],
      signingKey,
      now: new Date(now.getTime() + 60_000),
    }), { code: 'SOURCE_FAILURE' });

    assert.deepEqual(await readFile(path.join(releaseRoot, 'current', 'feed.json')), feedBefore);
    assert.deepEqual(await readCurrentLayer(releaseRoot, 'taiwan-medical'), layerBefore);
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test('accepts a complete, uniquely linked medical point and directory result', async () => {
  const releaseRoot = await temporaryRoot();
  try {
    const result = await publishGovernmentRelease({
      releaseRoot,
      results: [
        { id: 'tdx-road', status: 'ok', events: [event()] },
        completeMedicalResult(),
      ],
      signingKey,
      now,
    });
    assert.equal(result.revision, 1);
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test('rejects duplicate medical institutional codes and mismatched directory links', async () => {
  const releaseRoot = await temporaryRoot();
  try {
    const duplicateCode = completeMedicalResult();
    const secondPoint = medicalPoint('FAC001');
    secondPoint.feature_id = 'medical:fac001-copy';
    duplicateCode.features.push(secondPoint);
    duplicateCode.normalized.coordinate_report.source_count = 2;
    duplicateCode.normalized.coordinate_report.matched_count = 2;
    duplicateCode.normalized.coordinate_report.county_coverage.source_count = 2;
    duplicateCode.normalized.coordinate_report.county_coverage.located_count = 2;
    duplicateCode.normalized.coordinate_report.county_coverage.counties
      .find((county) => county.county_code === '63000').master_count = 2;
    duplicateCode.normalized.coordinate_report.county_coverage.counties
      .find((county) => county.county_code === '63000').located_count = 2;
    secondPoint.feature_id = 'medical:fac001';
    duplicateCode.normalized.medical_directory_features.push(medicalDirectoryEntry(secondPoint, 'copy'));

    await assert.rejects(publishGovernmentRelease({
      releaseRoot,
      results: [{ id: 'tdx-road', status: 'ok', events: [event()] }, duplicateCode],
      signingKey,
      now,
    }), { code: 'SOURCE_FAILURE' });

    const brokenDirectory = completeMedicalResult();
    brokenDirectory.normalized.medical_directory_features[0].properties.point_feature_id = 'medical:missing';
    await assert.rejects(publishGovernmentRelease({
      releaseRoot,
      results: [{ id: 'tdx-road', status: 'ok', events: [event()] }, brokenDirectory],
      signingKey,
      now,
    }), { code: 'SOURCE_FAILURE' });

    const untrustedCoordinates = completeMedicalResult();
    untrustedCoordinates.features[0].properties.coordinate_source = 'osm-medical-centroid';
    await assert.rejects(publishGovernmentRelease({
      releaseRoot,
      results: [{ id: 'tdx-road', status: 'ok', events: [event()] }, untrustedCoordinates],
      signingKey,
      now,
    }), { code: 'SOURCE_FAILURE' });
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test('publishes v2 content-addressed chunks and excludes raw source records from public contracts', async () => {
  const releaseRoot = await temporaryRoot();
  try {
    const privateEvent = event();
    privateEvent.attributes.source_record = { upstream_secret: 'raw-private-value' };
    const privateFeature = feature();
    privateFeature.properties.source_record = { upstream_secret: 'raw-private-value' };
    await publishGovernmentRelease({
      releaseRoot,
      results: [{ id: 'tdx-road', status: 'ok', events: [privateEvent] }],
      signingKey,
      now,
    });
    await publishStaticLayer({
      layerId: 'taiwan-shelter',
      features: [privateFeature],
      releaseRoot,
      signingKey,
      now,
    });

    const store = createReleaseStore({ releaseRoot });
    const feed = await store.readFeed();
    const v1 = await store.readGovernmentChunk(1, 'tdx-road', '0.json');
    const v2 = await store.readV2Feed();
    const v2Chunks = await Promise.all(v2.chunks.map((entry) => store.readV2Chunk(entry.sha256.slice('sha256:'.length))));
    const layer = await store.readLayerBundle('taiwan-shelter');
    assert.equal(v1.events[0].attributes.source_record, undefined);
    assert.equal(layer.chunks[0].features[0].properties.source_record, undefined);
    assert.equal(JSON.stringify({ feed, v1, v2, v2Chunks, layer }).includes('raw-private-value'), false);
    assert.equal(verifyGovernmentFeedV2(v2, v2Chunks, keys.publicKey, {
      trustedKeyIds: [signingKey.keyId],
      now,
    }).valid, true);
    const pointer = await store.readCurrentPointer();
    assert.equal(pointer.feed_path, 'releases/1/feed.json');
    assert.equal(pointer.v2_manifest_path, `v2/manifests/${v2.manifest_hash.slice('sha256:'.length)}.json`);
    assert.equal(pointer.layers['taiwan-shelter'], layer.manifest.dataset_version);
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test('publishes static layers as signed manifest and chunks', async () => {
  const releaseRoot = await temporaryRoot();
  try {
    const metadata = await publishStaticLayer({
      layerId: 'taiwan-shelter',
      features: [feature()],
      releaseRoot,
      signingKey,
      now,
    });
    const layer = await readCurrentLayer(releaseRoot, 'taiwan-shelter');
    assert.equal(metadata.manifest.layer_id, 'taiwan-shelter');
    assert.equal(layer.manifest.layer_id, 'taiwan-shelter');
    assert.equal(verifyFeatureBundle(layer, keys.publicKey, {
      trustedKeyIds: [signingKey.keyId],
      now,
    }).valid, true);
    const next = await publishStaticLayer({
      layerId: 'taiwan-shelter',
      features: [feature()],
      releaseRoot,
      signingKey,
      now: new Date(now.getTime() + 3_600_000),
    });
    assert.equal(next.datasetVersion, 1);
    assert.equal(next.unchanged, true);
    assert.equal((await readCurrentLayer(releaseRoot, 'taiwan-shelter')).manifest.dataset_version, 1);
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test('publishes signed medical search records without inventing map geometry', async () => {
  const releaseRoot = await temporaryRoot();
  try {
    const directoryEntry = {
      ...feature('taiwan-medical-directory'),
      namespace: 'official.medical',
      dataset_id: 'resilientgeo-taiwan-medical-directory',
      feature_id: 'medical-directory:unresolved-1',
      feature_type: 'MEDICAL_DIRECTORY_ENTRY',
      geometry: null,
      properties: {
        name: '待定位診所', address: '臺北市大安區仁愛路1號',
        administrative_area: '臺北市大安區', county_code: '63000',
        geometry_status: 'unresolved', point_feature_id: null,
      },
    };
    const metadata = await publishStaticLayer({
      layerId: 'taiwan-medical-directory',
      features: [directoryEntry],
      releaseRoot,
      signingKey,
      now,
    });
    const bundle = await readCurrentLayer(releaseRoot, 'taiwan-medical-directory');
    assert.equal(metadata.manifest.total_feature_count, 1);
    assert.deepEqual(bundle.manifest.bbox, [118, 21.8, 122.2, 26.5]);
    assert.equal(bundle.chunks[0].features[0].geometry, null);
    assert.equal(bundle.chunks[0].features[0].properties.point_feature_id, null);
    assert.equal(verifyFeatureBundle(bundle, keys.publicKey, {
      trustedKeyIds: [signingKey.keyId], now,
    }).valid, true);
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test('unchanged government data updates source status without advancing the signed feed revision', async () => {
  const releaseRoot = await temporaryRoot();
  try {
    await publishGovernmentRelease({
      releaseRoot,
      previousRoot: releaseRoot,
      results: [{ id: 'tdx-road', status: 'ok', events: [event()], retrievedAt: now.toISOString() }],
      signingKey,
      now,
    });
    const before = await readFile(path.join(releaseRoot, 'current', 'feed.json'));
    const later = new Date(now.getTime() + 10 * 60_000);
    const result = await publishGovernmentRelease({
      releaseRoot,
      previousRoot: releaseRoot,
      results: [{ id: 'tdx-road', status: 'ok', events: [event()], retrievedAt: later.toISOString() }],
      signingKey,
      now: later,
    });

    assert.equal(result.revision, 1);
    assert.equal(result.unchanged, true);
    assert.deepEqual(await readFile(path.join(releaseRoot, 'current', 'feed.json')), before);
    const statuses = await createReleaseStore({ releaseRoot }).readSourceStatus();
    assert.equal(statuses[0].checked_at, later.toISOString());
    assert.equal(statuses[0].revision, 1);
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test('government feed is renewed before its signed validity window expires', async () => {
  const releaseRoot = await temporaryRoot();
  try {
    await publishGovernmentRelease({
      releaseRoot,
      previousRoot: releaseRoot,
      results: [{ id: 'tdx-road', status: 'ok', events: [event()] }],
      signingKey,
      now,
    });
    const renewalTime = new Date(now.getTime() + 23 * 60 * 60_000 + 30 * 60_000);
    const result = await publishGovernmentRelease({
      releaseRoot,
      previousRoot: releaseRoot,
      results: [{ id: 'tdx-road', status: 'ok', events: [event()] }],
      signingKey,
      now: renewalTime,
    });

    assert.equal(result.revision, 2);
    assert.equal(result.unchanged, false);
    assert.ok(Date.parse(result.feed.expires_at) > renewalTime.getTime());
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test('marks non-default TDX and OSM sources as disabled when a run omits them', async () => {
  const releaseRoot = await temporaryRoot();
  try {
    await publishGovernmentRelease({
      releaseRoot,
      previousRoot: releaseRoot,
      results: [
        { sourceId: 'tdx-road-events', id: 'tdx-road', status: 'ok', events: [event()] },
        { sourceId: 'osm-taiwan', kind: 'static', status: 'ok', features: [] },
      ],
      signingKey,
      now,
    });
    await publishGovernmentRelease({
      releaseRoot,
      previousRoot: releaseRoot,
      results: [{ sourceId: 'ncdr-hazard-events', id: 'ncdr', status: 'ok', events: [event()] }],
      signingKey,
      now: new Date(now.getTime() + 600000),
    });

    const statuses = await createReleaseStore({ releaseRoot }).readSourceStatus();
    assert.equal(statuses.find((status) => status.source_id === 'tdx-road-events').status, 'disabled');
    assert.equal(statuses.find((status) => status.source_id === 'osm-taiwan').status, 'disabled');
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test('failed release publication leaves the current feed byte-for-byte unchanged', async () => {
  const releaseRoot = await temporaryRoot();
  try {
    await publishGovernmentRelease({
      releaseRoot,
      previousRoot: releaseRoot,
      results: [{ id: 'tdx-road', status: 'ok', events: [event()] }],
      signingKey,
      now,
    });
    const before = await readFile(path.join(releaseRoot, 'current', 'feed.json'));
    await assert.rejects(publishGovernmentRelease({
      releaseRoot,
      previousRoot: releaseRoot,
      results: [{ id: '../unsafe', status: 'ok', events: [event()] }],
      signingKey,
      now: new Date(now.getTime() + 600_000),
    }), /Invalid source id/u);
    const after = await readFile(path.join(releaseRoot, 'current', 'feed.json'));
    assert.deepEqual(after, before);
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test('publisher publishes a signed empty feed after a successful source check', async () => {
  const releaseRoot = await temporaryRoot();
  try {
    await publishGovernmentRelease({
      releaseRoot,
      previousRoot: releaseRoot,
      results: [{ id: 'tdx-road', status: 'ok', events: [event()] }],
      signingKey,
      now,
    });
    const before = await readFile(path.join(releaseRoot, 'current', 'feed.json'));

    const result = await publishGovernmentRelease({
      releaseRoot,
      previousRoot: releaseRoot,
      results: [{ id: 'tdx-road', status: 'ok', events: [] }],
      signingKey,
      now: new Date('2026-10-04T12:00:00Z'),
    });

    assert.equal(result.revision, 2);
    assert.deepEqual(result.feed.datasets, []);
    assert.equal(result.feed.sources[0].event_count, 0);
    assert.notDeepEqual(await readFile(path.join(releaseRoot, 'current', 'feed.json')), before);
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test('publisher refuses to replace a release when no source was checked', async () => {
  const releaseRoot = await temporaryRoot();
  try {
    await publishGovernmentRelease({
      releaseRoot,
      previousRoot: releaseRoot,
      results: [{ id: 'tdx-road', status: 'ok', events: [event()] }],
      signingKey,
      now,
    });
    const before = await readFile(path.join(releaseRoot, 'current', 'feed.json'));
    await assert.rejects(publishGovernmentRelease({
      releaseRoot,
      previousRoot: releaseRoot,
      results: [],
      signingKey,
      now: new Date('2026-10-04T12:00:00Z'),
    }), { code: 'NO_SOURCE_RESULTS' });
    assert.deepEqual(await readFile(path.join(releaseRoot, 'current', 'feed.json')), before);
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test('publisher rejects failed source results and keeps the previous complete release', async () => {
  const releaseRoot = await temporaryRoot();
  try {
    await publishGovernmentRelease({
      releaseRoot,
      previousRoot: releaseRoot,
      results: [{ id: 'tdx-road', status: 'ok', events: [event()] }],
      signingKey,
      now,
    });
    const before = await readFile(path.join(releaseRoot, 'current', 'feed.json'));

    await assert.rejects(publishGovernmentRelease({
      releaseRoot,
      previousRoot: releaseRoot,
      results: [{ id: 'tdx-road', status: 'unavailable', events: [event()] }],
      signingKey,
      now: new Date(now.getTime() + 600_000),
    }), /source failure/u);

    const after = await readFile(path.join(releaseRoot, 'current', 'feed.json'));
    assert.deepEqual(after, before);
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test('failed collection updates public source status without replacing the current feed', async () => {
  const releaseRoot = await temporaryRoot();
  try {
    await publishGovernmentRelease({
      releaseRoot,
      previousRoot: releaseRoot,
      results: [{ id: 'tdx-road', status: 'ok', events: [event()] }],
      signingKey,
      now,
    });
    const before = await readFile(path.join(releaseRoot, 'current', 'feed.json'));

    const result = await publishSourceStatus({
      releaseRoot,
      results: [{ sourceId: 'tdx-road-events', status: 'unavailable', errorCode: 'HTTP_ERROR' }],
      now: new Date(now.getTime() + 600_000),
    });

    assert.equal(result.revision, 1);
    assert.deepEqual(await readFile(path.join(releaseRoot, 'current', 'feed.json')), before);
    const statuses = await createReleaseStore({ releaseRoot }).readSourceStatus();
    assert.equal(statuses.find((status) => status.source_id === 'tdx-road-events').status, 'unavailable');
    assert.equal(statuses.find((status) => status.source_id === 'tdx-road-events').error_code, 'HTTP_ERROR');
    assert.equal(statuses.find((status) => status.source_id === 'tdx-road-events').revision, 1);
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test('medical empty-layer report replaces previous coverage counters in source status', async () => {
  const releaseRoot = await temporaryRoot();
  try {
    await publishGovernmentRelease({
      releaseRoot,
      previousRoot: releaseRoot,
      results: [{ id: 'tdx-road', sourceId: 'tdx-road-events', status: 'ok', events: [event()] }],
      signingKey,
      now,
    });

    await publishSourceStatus({
      releaseRoot,
      results: [{
        sourceId: 'taiwan-medical',
        status: 'partial',
        coordinateReport: { query_count: 12, candidate_count: 8, matched_count: 5, unresolved_count: 3 },
      }],
      now,
    });

    await publishSourceStatus({
      releaseRoot,
      results: [{
        sourceId: 'taiwan-medical',
        status: 'unavailable',
        errorCode: 'MEDICAL_LAYER_EMPTY',
        coordinateReport: {
          source_ids: ['nlsc-medical-coordinates'],
          query_count: 15,
          successful_query_count: 13,
          failed_query_count: 2,
          failed_fallback_source_count: 0,
          candidate_count: 2,
          matched_count: 0,
          unresolved_count: 4,
          rejected_coordinate_count: 1,
        },
      }],
      now: new Date(now.getTime() + 600_000),
    });

    const medicalStatus = (await createReleaseStore({ releaseRoot }).readSourceStatus())
      .find((status) => status.source_id === 'taiwan-medical');
    assert.equal(medicalStatus.status, 'unavailable');
    assert.equal(medicalStatus.error_code, 'MEDICAL_LAYER_EMPTY');
    assert.deepEqual({
      query_count: medicalStatus.query_count,
      successful_query_count: medicalStatus.successful_query_count,
      failed_query_count: medicalStatus.failed_query_count,
      failed_fallback_source_count: medicalStatus.failed_fallback_source_count,
      candidate_count: medicalStatus.candidate_count,
      matched_count: medicalStatus.matched_count,
      unresolved_count: medicalStatus.unresolved_count,
      rejected_coordinate_count: medicalStatus.rejected_coordinate_count,
      coordinate_source_ids: medicalStatus.coordinate_source_ids,
    }, {
      query_count: 15,
      successful_query_count: 13,
      failed_query_count: 2,
      failed_fallback_source_count: 0,
      candidate_count: 2,
      matched_count: 0,
      unresolved_count: 4,
      rejected_coordinate_count: 1,
      coordinate_source_ids: ['nlsc-medical-coordinates'],
    });
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test('medical upstream failure without a current report does not reuse old counters', async () => {
  const releaseRoot = await temporaryRoot();
  try {
    await publishGovernmentRelease({
      releaseRoot,
      previousRoot: releaseRoot,
      results: [{ id: 'tdx-road', sourceId: 'tdx-road-events', status: 'ok', events: [event()] }],
      signingKey,
      now,
    });

    await publishSourceStatus({
      releaseRoot,
      results: [{
        sourceId: 'taiwan-medical',
        status: 'unavailable',
        errorCode: 'MEDICAL_SOURCE_ERROR',
        normalized: {
          coordinate_report: { query_count: 12, candidate_count: 8, matched_count: 5, unresolved_count: 3 },
        },
      }],
      now: new Date(now.getTime() + 600_000),
    });

    const medicalStatus = (await createReleaseStore({ releaseRoot }).readSourceStatus())
      .find((status) => status.source_id === 'taiwan-medical');
    assert.equal(medicalStatus.status, 'unavailable');
    assert.equal(Object.hasOwn(medicalStatus, 'matched_count'), false);
    assert.equal(Object.hasOwn(medicalStatus, 'candidate_count'), false);
    assert.equal(Object.hasOwn(medicalStatus, 'query_count'), false);
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test('publisher preserves partial medical coverage counters in source status without making it releasable', async () => {
  const releaseRoot = await temporaryRoot();
  try {
    await publishGovernmentRelease({
      releaseRoot,
      previousRoot: releaseRoot,
      results: [{ id: 'tdx-road', sourceId: 'tdx-road-events', status: 'ok', events: [event()] }],
      signingKey,
      now,
    });

    await publishSourceStatus({
      releaseRoot,
      results: [{
        sourceId: 'taiwan-medical',
        status: 'partial',
        coordinateReport: {
          source_ids: ['nlsc-medical-coordinates', 'official-doorplate:10007'],
          query_count: 12,
          candidate_count: 8,
          matched_count: 5,
          unresolved_count: 3,
          rejected_coordinate_count: 1,
          emergency_hospital_count: 12,
          emergency_located_count: 10,
          emergency_unresolved_count: 2,
          emergency_medical_source_version: 'mohw-emergency-2026-10',
          emergency_medical_coverage: 'partial',
          emergency_unresolved_reason_counts: {
            no_coordinate_candidate: 1,
            name_address_mismatch: 0,
            multiple_candidates: 1,
            source_missing: 0,
          },
        },
      }],
      now,
    });

    const statuses = await createReleaseStore({ releaseRoot }).readSourceStatus();
    const medicalStatus = statuses.find((status) => status.source_id === 'taiwan-medical');
    assert.equal(medicalStatus.status, 'partial');
    assert.equal(medicalStatus.error_code, null);
    assert.deepEqual({
      query_count: medicalStatus.query_count,
      candidate_count: medicalStatus.candidate_count,
      matched_count: medicalStatus.matched_count,
      unresolved_count: medicalStatus.unresolved_count,
      rejected_coordinate_count: medicalStatus.rejected_coordinate_count,
      coordinate_source_ids: medicalStatus.coordinate_source_ids,
      emergency_hospital_count: medicalStatus.emergency_hospital_count,
      emergency_located_count: medicalStatus.emergency_located_count,
      emergency_unresolved_count: medicalStatus.emergency_unresolved_count,
      emergency_medical_source_version: medicalStatus.emergency_medical_source_version,
      emergency_medical_coverage: medicalStatus.emergency_medical_coverage,
      emergency_unresolved_reason_counts: medicalStatus.emergency_unresolved_reason_counts,
    }, {
      query_count: 12,
      candidate_count: 8,
      matched_count: 5,
      unresolved_count: 3,
      rejected_coordinate_count: 1,
      coordinate_source_ids: ['nlsc-medical-coordinates', 'official-doorplate:10007'],
      emergency_hospital_count: 12,
      emergency_located_count: 10,
      emergency_unresolved_count: 2,
      emergency_medical_source_version: 'mohw-emergency-2026-10',
      emergency_medical_coverage: 'partial',
      emergency_unresolved_reason_counts: {
        no_coordinate_candidate: 1,
        name_address_mismatch: 0,
        multiple_candidates: 1,
        source_missing: 0,
      },
    });
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test('publisher accepts the existing government feed builder contract with explicit server key metadata', () => {
  const output = buildGovernmentFeed({
    privateKey: signingKey.privateKey,
    publicKey: signingKey.publicKey,
    signingKeyId: signingKey.keyId,
    now,
    results: [{ id: 'tdx-road', status: 'ok', events: [event()] }],
  });
  assert.equal(output.feed.signing_key_id, signingKey.keyId);
});
