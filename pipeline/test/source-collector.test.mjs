import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetchNcdrHazards } from '../sources/ncdr.mjs';
import { makeRawSnapshot } from '../lib/source.mjs';
import { buildSignedAddressPackArtifact, buildSignedAddressPackCatalog } from '../lib/address-packs.mjs';
import { readSignedAddressPackFeatures } from '../lib/address-pack-reader.mjs';
import { generateEd25519KeyPair } from '../lib/crypto.mjs';
import { collectSource } from '../lib/source-collector.mjs';
import { getSourceDefinition } from '../../server/src/source-registry.mjs';

const NOW = new Date('2026-10-02T00:00:00Z');

function memoryCache(initial = {}) {
  const records = new Map(Object.entries(initial));
  const writes = [];
  return {
    writes,
    async readState(sourceId) { return records.get(sourceId)?.state ?? null; },
    async readSnapshot(sourceId) { return records.get(sourceId)?.snapshot ?? null; },
    async readNormalized(sourceId) { return records.get(sourceId)?.normalized ?? null; },
    async writeResult(sourceId, result) {
      records.set(sourceId, result);
      writes.push({ sourceId, result });
    },
  };
}

function rawSnapshot(sourceId, payload) {
  return makeRawSnapshot({
    sourceId,
    request: { method: 'GET', url: `https://example.test/${sourceId}`, query: {} },
    responseStatus: 200,
    responseHeaders: { ETag: `"${sourceId}-1"` },
    retrievedAt: NOW.toISOString(),
    payload,
  });
}

test('collectSource uses a live adapter, writes normalized output, and returns one result shape', async () => {
  const cacheStore = memoryCache();
  const definition = getSourceDefinition('cwa-earthquake');
  const event = { event_id: 'earthquake:one', event_type: 'EARTHQUAKE' };
  const result = await collectSource({
    definition,
    scope: { scope: 'taiwan', coverage: 'TW' },
    config: {},
    cacheStore,
    now: NOW,
    adapters: {
      'cwa-earthquake': async ({ mode }) => {
        assert.equal(mode, 'live');
        return {
          mode: 'live',
          rawSnapshot: rawSnapshot('cwa-earthquake', { records: [{ id: 'one' }] }),
          events: [event],
        };
      },
    },
  });

  assert.equal(result.sourceId, 'cwa-earthquake');
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.events, [event]);
  assert.equal(cacheStore.writes.length, 1);
  assert.deepEqual(cacheStore.writes[0].result.normalized.events, [event]);
});

test('collectSource keeps successful TDX events and marks a partial result', async () => {
  const cacheStore = memoryCache();
  const result = await collectSource({
    definition: getSourceDefinition('tdx-road-events'),
    scope: { scope: 'taiwan', coverage: 'TW' },
    config: {},
    cacheStore,
    now: NOW,
    adapters: {
      'tdx-road-events': async () => ({
        mode: 'live',
        rawSnapshot: rawSnapshot('tdx-road-events', { Events: [{ id: 'road-one' }], partial: true }),
        events: [{ event_id: 'tdx:road-one', event_type: 'ROAD_STATUS' }],
        unresolved: [{ endpoint: 'https://tdx.test/failed', error_code: 'HTTP_ERROR' }],
      }),
    },
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.events.length, 1);
  assert.equal(result.unresolved_count, 1);
});

test('collectSource rejects fixture output instead of publishing it as live data', async () => {
  await assert.rejects(
    collectSource({
      definition: getSourceDefinition('cwa-earthquake'),
      scope: { scope: 'taiwan', coverage: 'TW' },
      config: {},
      cacheStore: memoryCache(),
      now: NOW,
      adapters: {
        'cwa-earthquake': async () => ({
          mode: 'fixture',
          rawSnapshot: rawSnapshot('cwa-earthquake', { records: [] }),
          events: [],
        }),
      },
    }),
    (error) => error.code === 'FIXTURE_NOT_ALLOWED',
  );
});

test('collectSource returns last-known-good data when the upstream fails', async () => {
  const previousEvents = [{ event_id: 'cwa:previous', event_type: 'WEATHER_WARNING' }];
  const cacheStore = memoryCache({
    'cwa-weather-warning': {
      snapshot: rawSnapshot('cwa-weather-warning', { records: [{ id: 'previous' }] }),
      normalized: { schema_version: 'event-batch-v0', events: previousEvents },
      state: { schema_version: 'source-state-v1', source_id: 'cwa-weather-warning', status: 'ok' },
    },
  });
  const result = await collectSource({
    definition: getSourceDefinition('cwa-weather-warning'),
    scope: { scope: 'taiwan', coverage: 'TW' },
    config: {},
    cacheStore,
    now: NOW,
    adapters: {
      'cwa-weather-warning': async () => {
        const error = new Error('upstream unavailable');
        error.code = 'NETWORK_ERROR';
        throw error;
      },
    },
  });

  assert.equal(result.status, 'unavailable');
  assert.equal(result.usedLastKnownGood, true);
  assert.deepEqual(result.events, previousEvents);
  assert.equal(cacheStore.writes.length, 0);
});

test('NCDR reuses details for unchanged CAPIDs and fetches only new details', async () => {
  const calls = [];
  const endpoint = 'https://alerts.example.test/api/datastore';
  const detail = {
    identifier: 'CAP-ONE',
    sender: 'ncdr@example.test',
    sent: NOW.toISOString(),
    status: 'Actual',
    msgType: 'Alert',
    scope: 'Public',
    info: {
      language: 'zh-TW',
      event: '測試警戒',
      urgency: 'Immediate',
      severity: 'Severe',
      effective: NOW.toISOString(),
      expires: '2026-10-03T00:00:00Z',
      description: '測試警戒',
      area: { areaDesc: '臺北市', polygon: '25.00,121.50 25.00,121.51 25.01,121.51 25.00,121.50' },
    },
  };
  const indexPayload = { success: true, result: [{ capid: 'CAP-ONE', effective: NOW.toISOString() }] };
  const fetchImpl = async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    if (parsed.pathname === '/api/datastore') return {
      status: 200,
      ok: true,
      headers: new Headers({ ETag: '"index-1"' }),
      async json() { return indexPayload; },
    };
    return {
      status: 200,
      ok: true,
      headers: new Headers(),
      async json() { return detail; },
    };
  };

  const first = await fetchNcdrHazards({
    credentials: { apiKey: 'test-key' }, endpoint, authMode: 'query', detailConcurrency: 1,
    fetchImpl, retrievedAt: NOW.toISOString(),
  });
  const firstCallCount = calls.length;
  const second = await fetchNcdrHazards({
    credentials: { apiKey: 'test-key' }, endpoint, authMode: 'query', detailConcurrency: 1,
    fetchImpl, retrievedAt: '2026-10-02T00:10:00Z', previousSnapshot: first,
  });

  assert.equal(firstCallCount, 2);
  assert.equal(calls.length, firstCallCount + 1);
  assert.equal(second.payload.details.length, 1);
  assert.equal(second.payload.details[0].capid, 'CAP-ONE');
});

test('medical collection uses official coordinate candidates and reports matched/unresolved counts', async () => {
  const raw = {
    records: [
      { 機構代碼: 'H001', 機構名稱: '內湖醫院', 縣市鄉鎮: '臺北市內湖區', 地址: '內湖路1號' },
      { 機構代碼: 'H002', 機構名稱: '未定位診所', 縣市鄉鎮: '臺北市內湖區', 地址: '內湖路2號' },
    ],
  };
  const result = await collectSource({
    definition: getSourceDefinition('taiwan-medical'),
    scope: {
      scope: 'taiwan',
      coverage: 'TW',
      boundary: { type: 'Polygon', coordinates: [[[121.5, 25], [121.65, 25], [121.65, 25.15], [121.5, 25.15], [121.5, 25]]] },
    },
    config: {
      env: { MEDICAL_DATA_ENDPOINT: 'https://mohw.example.test/medical.json', MEDICAL_DATA_FORMAT: 'json' },
      medicalCoordinateFeatures: [{
        geometry: { type: 'Point', coordinates: [121.58, 25.08] },
        properties: {
          institution_code: 'H001',
          name: '內湖醫院',
          address: '內湖路1號',
          coordinate_source: 'nlsc-medical-coordinates',
          coordinate_source_version: 'nlsc-v1',
        },
      }],
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        headers: new Headers({ ETag: '"medical-v1"' }),
        async text() { return JSON.stringify(raw); },
      }),
    },
    cacheStore: memoryCache(),
    now: NOW,
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.publishable, true);
  assert.equal(result.features.length, 1);
  assert.equal(result.unresolved_count, 1);
  assert.equal(result.normalized.coordinate_report.matched_count, 1);
  assert.equal(result.normalized.coordinate_report.unresolved_count, 1);
  assert.equal(result.features[0].properties.coordinate_match_method, 'institution_code');
  const directory = result.normalized.medical_directory_features;
  assert.equal(directory.length, 2);
  assert.equal(directory.find((entry) => entry.properties.geometry_status === 'located').geometry, null);
  assert.equal(directory.find((entry) => entry.properties.geometry_status === 'located').properties.point_feature_id, result.features[0].feature_id);
  assert.equal(directory.find((entry) => entry.properties.geometry_status === 'unresolved').properties.point_feature_id, null);
});

test('medical collection preserves located points and reports partial when an NLSC query fails', async () => {
  const raw = {
    records: [{ 機構代碼: 'H001', 機構名稱: '內湖醫院', 縣市鄉鎮: '臺北市內湖區', 地址: '內湖路1號' }],
  };
  const result = await collectSource({
    definition: getSourceDefinition('taiwan-medical'),
    scope: {
      scope: 'taiwan',
      coverage: 'TW',
      boundary: { type: 'Polygon', coordinates: [[[121.5, 25], [121.65, 25], [121.65, 25.15], [121.5, 25.15], [121.5, 25]]] },
    },
    config: {
      env: {
        MEDICAL_DATA_ENDPOINT: 'https://mohw.example.test/medical.json',
        MEDICAL_DATA_FORMAT: 'json',
        MEDICAL_COORDINATE_QUERY_POINTS: JSON.stringify([
          { longitude: 121.52, latitude: 25.02 },
          { longitude: 121.60, latitude: 25.10 },
        ]),
        MEDICAL_COORDINATE_RADIUS_METERS: 1000,
        MEDICAL_COORDINATE_MAX_QUERIES: 2,
        MEDICAL_COORDINATE_CONCURRENCY: 1,
      },
      fetchImpl: async (url) => {
        if (url.includes('mohw.example.test')) {
          return {
            status: 200,
            ok: true,
            headers: new Headers(),
            async text() { return JSON.stringify(raw); },
          };
        }
        if (url.includes('/121.6/25.1/')) {
          return { status: 404, headers: new Headers(), async json() { return { message: 'not found' }; } };
        }
        return {
          status: 200,
          ok: true,
          headers: new Headers(),
          async json() {
            return { records: [{
              機構代碼: 'H001', 設施名稱: '內湖醫院', 門牌: '內湖路1號', 經度: 121.58, 緯度: 25.08,
            }] };
          },
        };
      },
    },
    cacheStore: memoryCache(),
    now: NOW,
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.publishable, true);
  assert.equal(result.features.length, 1);
  assert.equal(result.coordinateReport.query_count, 2);
  assert.equal(result.coordinateReport.successful_query_count, 1);
  assert.equal(result.coordinateReport.failed_query_count, 1);
  assert.equal(result.coordinateReport.matched_count, 1);
  assert.equal(result.coordinateReport.unresolved_count, 0);
});

test('medical collector uses the signed exact-address pack for unresolved records', async () => {
  const keys = generateEd25519KeyPair();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'medical-address-packs-'));
  try {
    const pack = {
      schema_version: 'address-pack-v1', county_code: '63000', county_name: '臺北市',
      source_version: '2026-10', coordinate_system: 'EPSG:3826',
      coordinate_order: 'longitude,latitude',
      records: [{
        id: 'address:63000:1', name: '臺北市內湖區內湖路2號',
        address: '臺北市內湖區內湖路2號', region: '臺北市內湖區',
        county_code: '63000', town_code: '63000010', coordinate: [121.59, 25.09],
      }, {
        id: 'address:63000:2', name: '臺北市松山區南京東路5段166號',
        address: '臺北市松山區南京東路5段166號', region: '臺北市松山區',
        county_code: '63000', town_code: '63000010', coordinate: [121.563231, 25.051227],
      }, {
        id: 'address:63000:3', name: '臺北市松山區南京東路5段168號',
        address: '臺北市松山區南京東路5段168號', region: '臺北市松山區',
        county_code: '63000', town_code: '63000010', coordinate: [121.563308, 25.051226],
      }, {
        id: 'address:63000:4', name: '臺北市內湖里康寧路1號',
        address: '臺北市內湖里康寧路1號', region: '臺北市',
        county_code: '63000', town_code: '6300100', coordinate: [121.59, 25.08],
      }],
      summary: { source_count: 4, located_count: 4, unlocated_count: 0, excluded_count: 0, coverage_status: 'complete' },
    };
    const artifact = await buildSignedAddressPackArtifact(pack, {
      privateKey: keys.privateKey, signingKeyId: 'medical-address-test-key',
      sourceUrl: 'https://data.gov.tw/dataset/155472', createdAt: NOW.toISOString(),
    });
    await writeFile(path.join(directory, artifact.dataFile), artifact.data);
    await writeFile(path.join(directory, artifact.manifestFile), JSON.stringify(artifact.manifest));
    const counties = Array.from({ length: 22 }, (_, index) => ({
      county_code: String(10000 + index).padStart(5, '0'), county_name: `縣市${index}`,
      coverage_status: 'unavailable', manifest_url: null, manifest_sha256: null,
    }));
    counties[0] = {
      county_code: '63000', county_name: '臺北市', coverage_status: 'complete',
      source_count: 4, located_count: 4, unlocated_count: 0, excluded_count: 0,
      manifest_url: `/address-packs/${artifact.manifestFile}`,
      manifest_sha256: artifact.manifestSha256,
    };
    const catalog = buildSignedAddressPackCatalog(counties, {
      privateKey: keys.privateKey, signingKeyId: 'medical-address-test-key', createdAt: NOW.toISOString(),
    });
    await writeFile(path.join(directory, 'catalog.json'), JSON.stringify(catalog));
    const directAddressFeatures = await readSignedAddressPackFeatures({
      directory, publicKey: keys.publicKey, addresses: ['臺北市內湖區內湖路2號'],
    });
    assert.equal(directAddressFeatures.length, 1);

    const result = await collectSource({
      definition: getSourceDefinition('taiwan-medical'),
      scope: {
        scope: 'taiwan', coverage: 'TW',
        boundary: { type: 'Polygon', coordinates: [[[121.5, 25], [121.65, 25], [121.65, 25.15], [121.5, 25.15], [121.5, 25]]] },
        townNamesByCode: { '63000010': '內湖區' },
        townCodeResolver(sourceCode, coordinate) {
          return sourceCode === '6300100' && coordinate[0] === 121.59 ? '63000010' : null;
        },
      },
      config: {
        env: { MEDICAL_DATA_ENDPOINT: 'https://mohw.example.test/medical.json', MEDICAL_DATA_FORMAT: 'json' },
        medicalCoordinateFeatures: [],
        medicalAddressPacksDirectory: directory,
        addressPackPublicKey: keys.publicKey,
        fetchImpl: async () => ({
          status: 200, ok: true, headers: new Headers({ ETag: '"medical-address-v1"' }),
          async text() { return JSON.stringify({ records: [
            { 機構代碼: 'H002', 機構名稱: '門牌診所', 縣市鄉鎮: '臺北市內湖區', 地址: '臺北市內湖區內湖路2號1樓' },
            { 機構代碼: '3501015544', 機構名稱: '微醫未來美學診所', 縣市鄉鎮: '臺北市松山區', 地址: '臺北市松山區南京東路5段166、168號11樓' },
            { 機構代碼: 'H003', 機構名稱: '行政區補回診所', 縣市鄉鎮: '臺北市內湖區', 地址: '臺北市內湖區康寧路1號' },
          ] }); },
        }),
      },
      cacheStore: memoryCache(),
      now: NOW,
    });
    assert.equal(result.features.length, 3);
    assert.equal(result.unresolved_count, 0);
    const exactMatch = result.features.find((feature) => feature.properties.source_record.機構代碼 === 'H002');
    assert.deepEqual(exactMatch.geometry.coordinates, [121.59, 25.09]);
    assert.equal(exactMatch.properties.coordinate_match_method, 'exact_address_doorplate');
    const correctedMatch = result.features.find((feature) => feature.properties.source_record.機構代碼 === '3501015544');
    assert.deepEqual(correctedMatch.geometry.coordinates, [121.563308, 25.051226]);
    assert.equal(correctedMatch.properties.coordinate_match_method, 'reviewed_address_correction');
    const restoredTownMatch = result.features.find((feature) => feature.properties.source_record.機構代碼 === 'H003');
    assert.deepEqual(restoredTownMatch.geometry.coordinates, [121.59, 25.08]);
    assert.equal(restoredTownMatch.properties.coordinate_match_method, 'exact_address_doorplate');
    assert.equal(result.normalized.coordinate_report.source_ids[0], 'official-doorplate:63000');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('medical collection fails closed when official coordinates cannot produce a non-empty layer', async () => {
  const cache = memoryCache();
  const result = await collectSource({
    definition: getSourceDefinition('taiwan-medical'),
    scope: {
      scope: 'taiwan',
      coverage: 'TW',
      boundary: { type: 'Polygon', coordinates: [[[121.5, 25], [121.65, 25], [121.65, 25.15], [121.5, 25.15], [121.5, 25]]] },
    },
    config: {
      env: { MEDICAL_DATA_ENDPOINT: 'https://mohw.example.test/medical.json', MEDICAL_DATA_FORMAT: 'json' },
      medicalCoordinateFeatures: [],
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        headers: new Headers(),
        async text() { return JSON.stringify({ records: [{ 機構代碼: 'H001', 機構名稱: '內湖醫院', 縣市鄉鎮: '臺北市內湖區', 地址: '內湖路1號' }] }); },
      }),
    },
    cacheStore: cache,
    now: NOW,
  });

  assert.equal(result.status, 'unavailable');
  assert.equal(result.errorCode, 'MEDICAL_LAYER_EMPTY');
  assert.equal(result.publishable, false);
  const { county_coverage: countyCoverage, ...coordinateReport } = result.coordinateReport;
  assert.deepEqual(coordinateReport, {
    source_count: 1,
    source_ids: [],
    query_count: 0,
    successful_query_count: 0,
    failed_query_count: 0,
    failed_query_error_counts: {},
    failed_fallback_source_count: 0,
    candidate_count: 0,
    matched_count: 0,
    unresolved_count: 1,
    rejected_coordinate_count: 0,
    unresolved_reason_counts: {
      no_coordinate_candidate: 1,
      name_address_mismatch: 0,
      multiple_candidates: 0,
      source_missing: 0,
    },
    emergency_hospital_count: null,
    emergency_located_count: null,
    emergency_unresolved_count: null,
    emergency_medical_source_version: null,
    emergency_medical_coverage: 'unavailable',
    emergency_unresolved_reason_counts: null,
  });
  assert.equal(countyCoverage.county_count, 22);
  assert.equal(countyCoverage.source_count, 1);
  assert.equal(countyCoverage.unlocated_count, 1);
  assert.equal(countyCoverage.counties.find((row) => row.county_code === '63000').unlocated_count, 1);
  assert.equal(cache.writes.length, 0);
});

test('medical empty-layer failure reports unmatched coordinate candidates for this attempt', async () => {
  const cache = memoryCache();
  const result = await collectSource({
    definition: getSourceDefinition('taiwan-medical'),
    scope: {
      scope: 'taiwan',
      coverage: 'TW',
      boundary: { type: 'Polygon', coordinates: [[[121.5, 25], [121.65, 25], [121.65, 25.15], [121.5, 25.15], [121.5, 25]]] },
    },
    config: {
      env: { MEDICAL_DATA_ENDPOINT: 'https://mohw.example.test/medical.json', MEDICAL_DATA_FORMAT: 'json' },
      medicalCoordinateFeatures: [{
        geometry: { type: 'Point', coordinates: [121.58, 25.08] },
        properties: {
          institution_code: 'OTHER',
          name: '其他醫院',
          address: '其他地址',
          coordinate_source: 'nlsc-medical-coordinates',
          coordinate_source_version: 'nlsc-v1',
        },
      }],
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        headers: new Headers(),
        async text() { return JSON.stringify({ records: [{ 機構代碼: 'H001', 機構名稱: '內湖醫院', 縣市鄉鎮: '臺北市內湖區', 地址: '內湖路1號' }] }); },
      }),
    },
    cacheStore: cache,
    now: NOW,
  });

  assert.equal(result.status, 'unavailable');
  assert.equal(result.errorCode, 'MEDICAL_LAYER_EMPTY');
  const { county_coverage: countyCoverage, ...coordinateReport } = result.coordinateReport;
  assert.deepEqual(coordinateReport, {
    source_count: 1,
    source_ids: ['nlsc-medical-coordinates'],
    query_count: 0,
    successful_query_count: 0,
    failed_query_count: 0,
    failed_query_error_counts: {},
    failed_fallback_source_count: 0,
    candidate_count: 1,
    matched_count: 0,
    unresolved_count: 1,
    rejected_coordinate_count: 0,
    unresolved_reason_counts: {
      no_coordinate_candidate: 0,
      name_address_mismatch: 1,
      multiple_candidates: 0,
      source_missing: 0,
    },
    emergency_hospital_count: null,
    emergency_located_count: null,
    emergency_unresolved_count: null,
    emergency_medical_source_version: null,
    emergency_medical_coverage: 'unavailable',
    emergency_unresolved_reason_counts: null,
  });
  assert.equal(countyCoverage.county_count, 22);
  assert.equal(countyCoverage.source_count, 1);
  assert.equal(countyCoverage.unlocated_count, 1);
  assert.equal(countyCoverage.counties.find((row) => row.county_code === '63000').unlocated_count, 1);
  assert.equal(cache.writes.length, 0);
});
