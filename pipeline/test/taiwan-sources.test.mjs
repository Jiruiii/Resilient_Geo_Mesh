import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isGeometryInBoundary, filterRecordsToBoundary } from '../lib/geo.mjs';
import { makeRawSnapshot } from '../lib/source.mjs';
import { parseOdsXml } from '../lib/feature-source.mjs';
import {
  createAreaResolvers,
  createTownCodeResolver,
  normalizeAreaCatalog,
  townNameMapFromAreaCatalog,
} from '../sources/areas.mjs';
import {
  fetchNcdrHazards,
  normalizeNcdrHazards,
} from '../sources/ncdr.mjs';
import {
  normalizeCwaEarthquakes,
} from '../sources/cwa.mjs';
import {
  normalizeTdxRoadEvents,
} from '../sources/tdx.mjs';
import { normalizeOsmFeatures } from '../sources/osm.mjs';
import { normalizeAddressText } from '../lib/address-packs.mjs';
import { findReviewedMedicalAddressCorrection } from '../sources/medical-address-corrections.mjs';
import {
  normalizeShelters,
} from '../sources/shelter.mjs';
import {
  mergeMedicalCoordinates,
  normalizeMedicalFacilitiesReport,
  partitionMedicalIdentityConflicts,
  reconcileEmergencyMedicalFacilities,
} from '../sources/medical.mjs';

const RETRIEVED_AT = '2026-09-25T00:00:00Z';
const EXPIRES_AT = '2026-10-25T00:00:00Z';

const TAIWAN_SCOPE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { COUNTYCODE: '63000', COUNTYNAME: '臺北市', TOWNCODE: '63000010', TOWNNAME: '內湖區' },
      geometry: { type: 'Polygon', coordinates: [[[121.50, 25.00], [121.65, 25.00], [121.65, 25.15], [121.50, 25.15], [121.50, 25.00]]] },
    },
    {
      type: 'Feature',
      properties: { COUNTYCODE: '10015', COUNTYNAME: '花蓮縣', TOWNCODE: '10015010', TOWNNAME: '花蓮市' },
      geometry: { type: 'Polygon', coordinates: [[[121.55, 23.90], [121.70, 23.90], [121.70, 24.10], [121.55, 24.10], [121.55, 23.90]]] },
    },
  ],
};

const TAIWAN_RESOLVERS = createAreaResolvers(normalizeAreaCatalog(TAIWAN_SCOPE));

function rawSnapshot(sourceId, payload, endpoint = `https://example.test/${sourceId}`) {
  return makeRawSnapshot({
    sourceId,
    request: { method: 'GET', url: endpoint, query: {} },
    responseStatus: 200,
    responseHeaders: { ETag: '"taiwan-test-1"' },
    retrievedAt: RETRIEVED_AT,
    payload,
  });
}

function response(payload) {
  return {
    status: 200,
    headers: new Headers({ ETag: '"live-1"' }),
    async json() { return payload; },
  };
}

test('generic boundary helpers retain features across Taiwan administrative areas', () => {
  const records = [
    { id: 'taipei', geometry: { type: 'Point', coordinates: [121.58, 25.08] } },
    { id: 'hualien', geometry: { type: 'Point', coordinates: [121.61, 24.02] } },
    { id: 'outside', geometry: { type: 'Point', coordinates: [120.00, 22.00] } },
  ];

  assert.equal(isGeometryInBoundary(records[0].geometry, TAIWAN_SCOPE), true);
  assert.equal(isGeometryInBoundary(records[1].geometry, TAIWAN_SCOPE), true);
  assert.deepEqual(
    filterRecordsToBoundary(records, TAIWAN_SCOPE).map((record) => record.id),
    ['taipei', 'hualien'],
  );
});

test('normalizes nationwide administrative boundaries into an AreaCatalog', () => {
  const catalog = normalizeAreaCatalog(TAIWAN_SCOPE, {
    retrievedAt: RETRIEVED_AT,
    source: 'NLSC',
    sourceVersion: 'boundary-test-1',
  });

  assert.equal(catalog.schema_version, 'area-catalog-v0');
  assert.equal(catalog.coverage, 'TW');
  assert.deepEqual(new Set(catalog.areas.map((area) => area.town_code)), new Set(['63000010', '10015010']));
  assert.ok(catalog.areas.some((area) => area.area_id === 'tw.63000010'));

  const resolvers = createAreaResolvers(catalog);
  assert.equal(
    resolvers.areaIdResolver({ 縣市及鄉鎮市區: '花蓮縣花蓮市' }, { type: 'Point', coordinates: [121.61, 24.02] }),
    'tw.10015010',
  );
  assert.equal(
    resolvers.boundaryResolver({ 縣市及鄉鎮市區: '臺北市內湖區' }, { type: 'Point', coordinates: [121.58, 25.08] }).type,
    'Feature',
  );
});

test('builds the canonical town-code name map from an area catalog', () => {
  const catalog = normalizeAreaCatalog(TAIWAN_SCOPE, {
    retrievedAt: RETRIEVED_AT,
    source: 'NLSC',
    sourceVersion: 'boundary-test-1',
  });
  assert.deepEqual(townNameMapFromAreaCatalog(catalog), {
    '63000010': '內湖區',
    '10015010': '花蓮市',
  });
});

test('restores a legacy town code only when its official point lies in one town', () => {
  const catalog = normalizeAreaCatalog(TAIWAN_SCOPE, {
    retrievedAt: RETRIEVED_AT,
    source: 'NLSC',
    sourceVersion: 'boundary-test-1',
  });
  const resolveTownCode = createTownCodeResolver(catalog);

  assert.equal(resolveTownCode('6300100', [121.58, 25.08]), '63000010');
  // The same malformed source code must still be resolved from each point,
  // rather than letting a prior lookup choose a town for a later record.
  assert.equal(resolveTownCode('6300100', [121.61, 24.02]), '10015010');
  assert.equal(resolveTownCode('1001501', [121.61, 24.02]), '10015010');
  assert.equal(resolveTownCode('63000010', [121.58, 25.08]), '63000010');
});

test('area resolver honors a specific town code over the parent county code', () => {
  const catalog = normalizeAreaCatalog({
    ...TAIWAN_SCOPE,
    features: [
      ...TAIWAN_SCOPE.features,
      {
        type: 'Feature',
        properties: { COUNTYCODE: '10015', COUNTYNAME: '花蓮縣', TOWNCODE: '10015020', TOWNNAME: '新城鄉' },
        geometry: { type: 'Polygon', coordinates: [[[121.70, 23.90], [121.85, 23.90], [121.85, 24.10], [121.70, 24.10], [121.70, 23.90]]] },
      },
    ],
  });
  const resolvers = createAreaResolvers(catalog);
  const record = { COUNTYCODE: '10015', TOWNCODE: '10015020' };
  const geometry = { type: 'Point', coordinates: [121.78, 24.02] };

  assert.equal(resolvers.areaIdResolver(record, geometry), 'tw.10015020');
  assert.equal(resolvers.boundaryResolver(record, geometry).properties.area_id, 'tw.10015020');
});

test('parses the MOHW ODS medical master table into records', () => {
  const xml = `
    <table:table-row xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0">
      <table:table-cell><text:p>機構代碼</text:p></table:table-cell>
      <table:table-cell><text:p>機構名稱</text:p></table:table-cell>
      <table:table-cell><text:p>縣市區名</text:p></table:table-cell>
      <table:table-cell table:number-columns-repeated="16351"/>
    </table:table-row>
    <table:table-row xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0">
      <table:table-cell><text:p>H001</text:p></table:table-cell>
      <table:table-cell><text:p>花蓮醫院</text:p></table:table-cell>
      <table:table-cell><text:p>花蓮縣花蓮市</text:p></table:table-cell>
      <table:table-cell table:number-columns-repeated="16351"/>
    </table:table-row>`;

  assert.deepEqual(parseOdsXml(xml), [{ 機構代碼: 'H001', 機構名稱: '花蓮醫院', 縣市區名: '花蓮縣花蓮市' }]);
});

test('CWA nationwide normalization keeps records outside the old Neihu area', () => {
  const raw = rawSnapshot('cwa-earthquake', {
    result: {
      records: [
        {
          EarthquakeNo: 'TW-001',
          IssueTime: RETRIEVED_AT,
          EndTime: EXPIRES_AT,
          OriginTime: RETRIEVED_AT,
          EpicenterLatitude: '25.08',
          EpicenterLongitude: '121.58',
          StationLatitude: '25.08',
          StationLongitude: '121.58',
          StationID: 'TP-001',
          CountyName: '臺北市',
        },
        {
          EarthquakeNo: 'TW-002',
          IssueTime: RETRIEVED_AT,
          EndTime: EXPIRES_AT,
          OriginTime: RETRIEVED_AT,
          EpicenterLatitude: '24.02',
          EpicenterLongitude: '121.61',
          StationLatitude: '24.02',
          StationLongitude: '121.61',
          StationID: 'HL-001',
          CountyName: '花蓮縣',
        },
      ],
    },
  });

  const events = normalizeCwaEarthquakes(raw, {
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    coverage: 'TW',
    areaId: 'tw',
  });

  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.attributes.coverage), ['TW', 'TW']);
  assert.deepEqual(events.map((event) => event.attributes.area_id), ['tw', 'tw']);
});

test('normalizes the official nested CWA earthquake record shape', () => {
  const raw = rawSnapshot('cwa-earthquake', {
    records: {
      Earthquake: [{
        IssueTime: '2026-09-22T05:19:16+08:00',
        ValidTime: { EndTime: '2026-09-22T13:19:16+08:00' },
        EarthquakeNo: 115064,
        EarthquakeInfo: {
          OriginTime: '2026-09-22T05:16:13+08:00',
          Epicenter: { EpicenterLatitude: 23.21, EpicenterLongitude: 120.54 },
        },
      }],
    },
  });
  const events = normalizeCwaEarthquakes(raw, {
    boundary: { type: 'Polygon', coordinates: [[[119, 21], [122.5, 21], [122.5, 26.5], [119, 26.5], [119, 21]]] },
    scope: 'taiwan',
    coverage: 'TW',
    areaId: 'tw',
  });

  assert.equal(events.length, 1);
  assert.deepEqual(events[0].geometry, { type: 'Point', coordinates: [120.54, 23.21] });
  assert.equal(events[0].issued_at, '2026-09-21T21:16:13.000Z');
  assert.equal(events[0].expires_at, '2026-09-22T05:19:16.000Z');
});

test('NCDR alert API mode sends apikey in the query and redacts it from Raw', async () => {
  const calls = [];
  const key = 'real-alert-key-for-test';
  const snapshot = await fetchNcdrHazards({
    credentials: { apiKey: key },
    endpoint: 'https://alerts.ncdr.nat.gov.tw/webapi/api/datastore',
    authMode: 'query',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response({ data: [] });
    },
    retrievedAt: RETRIEVED_AT,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /apikey=real-alert-key-for-test/u);
  assert.equal(calls[0].init.headers.Token, undefined);
  assert.doesNotMatch(JSON.stringify(snapshot), /real-alert-key-for-test/u);
});

test('NCDR nationwide normalization retains a Hualien alert', () => {
  const raw = rawSnapshot('ncdr-hazard-events', {
    data: [{
      CAPID: 'NCDR-HUALIEN-001',
      event: '土石流警戒',
      sent: RETRIEVED_AT,
      expires: EXPIRES_AT,
      geometry: { type: 'Point', coordinates: [121.61, 24.02] },
      areaDesc: '花蓮縣花蓮市',
    }],
  });
  const events = normalizeNcdrHazards(raw, {
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    coverage: 'TW',
    areaId: 'tw',
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].attributes.coverage, 'TW');
  assert.equal(events[0].attributes.area_id, 'tw');
});

test('NCDR nationwide fallback does not resolve the fallback boundary as an event area', () => {
  const raw = rawSnapshot('ncdr-hazard-events', {
    data: [{
      CAPID: 'NCDR-NATIONWIDE-001',
      event: '全台災害通報',
      sent: RETRIEVED_AT,
      expires: EXPIRES_AT,
    }],
  });
  const resolvers = createAreaResolvers(normalizeAreaCatalog(TAIWAN_SCOPE));
  const events = normalizeNcdrHazards(raw, {
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    coverage: 'TW',
    ...resolvers,
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].attributes.area_id, 'tw');
});

test('TDX nationwide normalization keeps all in-scope cities and adds chunk fields', () => {
  const raw = rawSnapshot('tdx-road-events', {
    UpdateTime: RETRIEVED_AT,
    Events: [
      {
        EventID: 'TDX-TAIPEI-001',
        EventType: 'Accident',
        StartTime: RETRIEVED_AT,
        EndTime: EXPIRES_AT,
        Location: { Position: { PositionLat: 25.08, PositionLon: 121.58 }, Address: { Town: '內湖區' } },
      },
      {
        EventID: 'TDX-HUALIEN-001',
        EventType: 'Construction',
        StartTime: RETRIEVED_AT,
        EndTime: EXPIRES_AT,
        Location: { Position: { PositionLat: 24.02, PositionLon: 121.61 }, Address: { Town: '花蓮市' } },
      },
    ],
  });
  const events = normalizeTdxRoadEvents(raw, {
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    coverage: 'TW',
    areaId: 'tw',
  });

  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.attributes.area_id), ['tw', 'tw']);
  assert.deepEqual(events.map((event) => event.attributes.theme), ['road', 'road']);
});

test('nationwide shelter normalization does not filter by Neihu text', () => {
  const raw = rawSnapshot('taiwan-shelter', {
    records: [
      {
        序號: 'TP-001', 縣市及鄉鎮市區: '臺北市內湖區', 避難收容處所地址: '內湖路1號',
        經度: '121.58', 緯度: '25.08', 避難收容處所名稱: '台北避難所', 預計收容人數: '100',
      },
      {
        序號: 'HL-001', 縣市及鄉鎮市區: '花蓮縣花蓮市', 避難收容處所地址: '花蓮路1號',
        經度: '121.61', 緯度: '24.02', 避難收容處所名稱: '花蓮避難所', 預計收容人數: '200',
      },
    ],
  });
  const normalized = normalizeShelters(raw, {
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    ...TAIWAN_RESOLVERS,
    sourceId: 'taiwan-shelter',
    source: 'FIRE_AGENCY',
    datasetId: 'resilientgeo-taiwan',
    coverage: 'TW',
  });

  assert.equal(normalized.features.length, 2);
  assert.deepEqual(normalized.features.map((feature) => feature.properties.coverage), ['TW', 'TW']);
});

test('nationwide shelter keeps only points consistent with administrative area and address', () => {
  const raw = rawSnapshot('taiwan-shelter', {
    records: [
      {
        序號: 'TP-VALID', 縣市及鄉鎮市區: '臺北市內湖區', 避難收容處所地址: '內湖路1號',
        經度: '121.58', 緯度: '25.08', 避難收容處所名稱: '臺北收容點',
      },
      {
        序號: 'TP-WRONG-POINT', 縣市及鄉鎮市區: '臺北市內湖區', 避難收容處所地址: '臺北市內湖區內湖路2號',
        經度: '121.61', 緯度: '24.02', 避難收容處所名稱: '錯誤座標點',
      },
      {
        序號: 'TP-ADDRESS-CONFLICT', 縣市及鄉鎮市區: '臺北市內湖區', 避難收容處所地址: '花蓮縣花蓮市花蓮路3號',
        經度: '121.58', 緯度: '25.08', 避難收容處所名稱: '地址衝突點',
      },
    ],
  });
  const normalized = normalizeShelters(raw, {
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    ...TAIWAN_RESOLVERS,
    sourceId: 'taiwan-shelter',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
  });

  assert.equal(normalized.source_count, 3);
  assert.equal(normalized.located_count, 1);
  assert.equal(normalized.unlocated_count, 2);
  assert.equal(normalized.excluded_count, 0);
  assert.deepEqual(normalized.location_issue_counts, {
    coordinate_admin_area_mismatch: 1,
    address_area_mismatch: 1,
  });
  assert.deepEqual(normalized.features.map((feature) => feature.feature_id), ['shelter:tp-valid']);
  assert.equal(normalized.county_coverage.length, 23);
  assert.deepEqual(normalized.county_coverage.find((county) => county.county_code === '63000'), {
    county_code: '63000', county_name: '臺北市', source_count: 3,
    located_count: 1, unlocated_count: 2, excluded_count: 0,
  });
  assert.equal(normalized.county_coverage.at(-1).source_count, 0);
});

test('nationwide shelter normalization requires the Taiwan administrative resolver', () => {
  const raw = rawSnapshot('taiwan-shelter', {
    records: [{
      序號: 'TP-001', 縣市及鄉鎮市區: '臺北市內湖區', 避難收容處所地址: '內湖路1號',
      經度: '121.58', 緯度: '25.08', 避難收容處所名稱: '臺北收容點',
    }],
  });

  assert.throws(() => normalizeShelters(raw, {
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-shelter',
    expiresAt: EXPIRES_AT,
  }), { code: 'SHELTER_AREA_RESOLVER_REQUIRED' });
});

test('nationwide OSM normalization keeps non-Neihu POIs with Taiwan metadata', () => {
  const raw = rawSnapshot('osm-taiwan', {
    version: 0.6,
    osm3s: { timestamp_osm_base: RETRIEVED_AT },
    elements: [{
      type: 'node',
      id: 9001,
      lat: 24.02,
      lon: 121.61,
      tags: { amenity: 'hospital', name: '花蓮醫院' },
    }],
  });
  const resolvers = createAreaResolvers(normalizeAreaCatalog(TAIWAN_SCOPE));
  const features = normalizeOsmFeatures(raw, {
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'osm-taiwan',
    coverage: 'TW',
    ...resolvers,
  });

  assert.equal(features.length, 1);
  assert.equal(features[0].properties.coverage, 'TW');
  assert.equal(features[0].properties.area_id, 'tw.10015010');
  assert.equal(features[0].properties.county_code, '10015');
  assert.equal(features[0].properties.town_code, '10015010');
});

test('medical normalization reports unresolved nationwide rows instead of inventing coordinates', () => {
  const raw = rawSnapshot('taiwan-medical', {
    records: [
      { 機構代碼: 'H001', 機構名稱: '台北醫院', 縣市鄉鎮: '臺北市內湖區', 地址: '內湖路1號' },
      { 機構代碼: 'H002', 機構名稱: '花蓮醫院', 縣市鄉鎮: '花蓮縣花蓮市', 地址: '花蓮路1號', 經度: '121.61', 緯度: '24.02' },
    ],
  });
  const report = normalizeMedicalFacilitiesReport(raw, {
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    source: 'MOHW',
    datasetId: 'resilientgeo-taiwan',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
  });

  assert.equal(report.features.length, 1);
  assert.equal(report.unresolved.length, 1);
  assert.equal(report.unresolved[0].medical_id, 'h001');
  assert.equal(report.unresolved[0].geometry_status, 'unresolved');
  assert.equal(report.features[0].properties.coverage, 'TW');
  assert.equal(report.features[0].properties.coordinate_source, 'mohw-medical-master');
  assert.equal(report.features[0].properties.coordinate_source_version, report.features[0].source_version);
  assert.equal(report.features[0].properties.coordinate_match_method, 'source_coordinates');
});

test('keeps a nearby-address candidate out of the medical point layer', () => {
  const feature = {
    feature_id: 'medical:H001',
    properties: {
      coordinate_match_method: 'nearby_address_candidate',
      source_record: { 機構代碼: 'H001', 機構名稱: '候選診所', 地址: '臺北市內湖區內湖路1號' },
    },
  };

  const result = partitionMedicalIdentityConflicts({ features: [feature] });

  assert.deepEqual(result.features, []);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].coordinate_failure_reason, 'unverified_coordinate_match');
  assert.equal(result.identity_conflict_count, 0);
  assert.equal(result.unresolved_reason_counts.unverified_coordinate_match, 1);
});

test('medical coordinate supplement resolves only an unambiguous official coordinate match', () => {
  const raw = rawSnapshot('taiwan-medical', {
    records: [{
      機構代碼: 'H001', 機構名稱: '台北醫院', 縣市鄉鎮: '臺北市內湖區', 地址: '內湖路1號',
    }],
  });
  const report = normalizeMedicalFacilitiesReport(raw, {
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
  });
  const merged = mergeMedicalCoordinates(report, [{
    layer_id: 'official-medical-coordinate',
    feature_type: 'HOSPITAL',
    geometry: { type: 'Point', coordinates: [121.58, 25.08] },
    properties: {
      institution_code: 'H001',
      name: '台北醫院',
      address: '內湖路1號',
      coordinate_source: 'nlsc-medical-coordinates',
      coordinate_source_version: 'nlsc-v1',
    },
  }], {
    rawSnapshot: raw,
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
  });

  assert.equal(merged.features.length, 1);
  assert.equal(merged.unresolved.length, 0);
  assert.deepEqual(merged.features[0].geometry, { type: 'Point', coordinates: [121.58, 25.08] });
  assert.equal(merged.features[0].properties.coordinate_source, 'nlsc-medical-coordinates');
  assert.equal(merged.features[0].properties.coordinate_match_method, 'institution_code');
});

test('medical coordinate supplement matches an official subdoor written with a hyphen or 之', () => {
  const boundary = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { level: 'town', county_code: '09007', county_name: '連江縣', town_code: '09007020', town_name: '北竿鄉' },
      geometry: { type: 'Polygon', coordinates: [[[119.95, 26.18], [120.05, 26.18], [120.05, 26.28], [119.95, 26.28], [119.95, 26.18]]] },
    }],
  };
  const raw = rawSnapshot('taiwan-medical', {
    records: [{
      機構代碼: '2391020010', 機構名稱: '連江縣北竿鄉衛生所', 縣市鄉鎮: '連江縣北竿鄉',
      地址: '連江縣北竿鄉塘岐村281-6號',
    }],
  });
  const report = normalizeMedicalFacilitiesReport(raw, {
    boundary, scope: 'taiwan', sourceId: 'taiwan-medical', coverage: 'TW', expiresAt: EXPIRES_AT,
  });
  const merged = mergeMedicalCoordinates(report, [{
    geometry: { type: 'Point', coordinates: [119.999358, 26.226163] },
    properties: {
      name: '連江縣北竿鄉衛生所', address: '連江縣北竿鄉塘岐村281之6號',
      coordinate_source: 'nlsc-medical-coordinates', coordinate_source_version: 'nlsc-v1',
    },
  }], {
    rawSnapshot: raw, boundary, scope: 'taiwan', sourceId: 'taiwan-medical', coverage: 'TW', expiresAt: EXPIRES_AT,
  });

  assert.equal(merged.features.length, 1);
  assert.equal(merged.unresolved.length, 0);
  assert.equal(merged.features[0].properties.coordinate_match_method, 'name_address');
  assert.deepEqual(merged.features[0].geometry.coordinates, [119.999358, 26.226163]);
});

test('medical coordinate matching indexes candidates instead of rescanning all candidates per unresolved record', () => {
  const raw = rawSnapshot('taiwan-medical', {
    records: Array.from({ length: 120 }, (_, index) => ({
      機構名稱: `未定位院所${index}`,
      縣市鄉鎮: '臺北市內湖區',
      地址: `內湖路${index + 1}號`,
    })),
  });
  const report = normalizeMedicalFacilitiesReport(raw, {
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
  });
  let candidatePropertyReads = 0;
  const coordinateFeatures = Array.from({ length: 250 }, (_, index) => ({
    geometry: { type: 'Point', coordinates: [121.58, 25.08] },
    get properties() {
      candidatePropertyReads += 1;
      return { name: `其他院所${index}`, address: `其他路${index + 1}號`, coordinate_source: 'nlsc' };
    },
  }));
  let addressCandidatePropertyReads = 0;
  const addressCoordinateFeatures = Array.from({ length: 250 }, (_, index) => ({
    geometry: { type: 'Point', coordinates: [121.58, 25.08] },
    get properties() {
      addressCandidatePropertyReads += 1;
      return {
        address: `臺北市內湖區其他門牌路${index + 1}號`,
        administrative_area: '臺北市內湖區',
        county_code: '63000',
        coordinate_source: 'official-doorplate:63000',
      };
    },
  }));

  const merged = mergeMedicalCoordinates(report, coordinateFeatures, {
    rawSnapshot: raw,
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
    addressCoordinateFeatures,
  });

  assert.equal(merged.features.length, 0);
  assert.equal(merged.unresolved.length, 120);
  assert.ok(candidatePropertyReads <= coordinateFeatures.length * 4,
    `expected indexed matching to read candidate properties once, got ${candidatePropertyReads} reads`);
  assert.ok(addressCandidatePropertyReads <= addressCoordinateFeatures.length * 4,
    `expected indexed address matching to read candidate properties once, got ${addressCandidatePropertyReads} reads`);
});

test('medical coordinate supplement uses only a unique exact address in a signed county pack', () => {
  const raw = rawSnapshot('taiwan-medical', {
    records: [
      { 機構代碼: 'H101', 機構名稱: '門牌醫院', 縣市鄉鎮: '臺北市內湖區', 地址: '臺北市 內湖區 內湖路 １號' },
      { 機構代碼: 'H102', 機構名稱: '重複門牌診所', 縣市鄉鎮: '臺北市內湖區', 地址: '臺北市內湖區內湖路2號' },
    ],
  });
  const report = normalizeMedicalFacilitiesReport(raw, {
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
  });
  const addressCoordinateFeatures = [
    {
      geometry: { type: 'Point', coordinates: [121.58, 25.08] },
      properties: {
        address: '臺北市內湖區內湖路1號',
        administrative_area: '臺北市內湖區',
        county_code: '63000',
        coordinate_source: 'official-doorplate:63000',
      },
    },
    {
      geometry: { type: 'Point', coordinates: [121.59, 25.09] },
      properties: {
        address: '臺北市內湖區內湖路2號',
        administrative_area: '臺北市內湖區',
        county_code: '63000',
        coordinate_source: 'official-doorplate:63000',
      },
    },
    {
      geometry: { type: 'Point', coordinates: [121.60, 25.10] },
      properties: {
        address: '臺北市內湖區內湖路２號',
        administrative_area: '臺北市內湖區',
        county_code: '63000',
        coordinate_source: 'official-doorplate:63000',
      },
    },
  ];
  const merged = mergeMedicalCoordinates(report, [], {
    rawSnapshot: raw,
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
    addressCoordinateFeatures,
  });

  assert.equal(merged.features.length, 1);
  assert.equal(merged.features[0].feature_id, 'medical:h101');
  assert.deepEqual(merged.features[0].geometry.coordinates, [121.58, 25.08]);
  assert.equal(merged.features[0].properties.coordinate_match_method, 'exact_address_doorplate');
  assert.equal(merged.features[0].properties.coordinate_source, 'official-doorplate:63000');
  assert.equal(merged.unresolved.length, 1);
  assert.equal(merged.unresolved[0].coordinate_failure_reason, 'multiple_candidates');
});

test('medical coordinate supplement matches a bare floor annotation to its official building doorplate', () => {
  const alias = '臺北市內湖區內湖路１號1樓';
  const raw = rawSnapshot('taiwan-medical', {
    records: [{ 機構代碼: 'H301', 機構名稱: '別名診所', 縣市鄉鎮: '臺北市內湖區', 地址: alias }],
  });
  const report = normalizeMedicalFacilitiesReport(raw, {
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
  });
  const merged = mergeMedicalCoordinates(report, [], {
    rawSnapshot: raw,
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
    addressCoordinateFeatures: [{
      geometry: { type: 'Point', coordinates: [121.58, 25.08] },
      properties: {
        address: '臺北市內湖區內湖路1號',
        matched_address_keys: [normalizeAddressText('臺北市內湖區內湖路1號')],
        administrative_area: '臺北市內湖區',
        county_code: '63000',
        coordinate_source: 'official-doorplate:63000',
        coordinate_source_version: '11509',
      },
    }],
  });

  assert.equal(merged.features.length, 1);
  assert.equal(merged.features[0].properties.coordinate_match_method, 'exact_address_doorplate');
  assert.equal(merged.features[0].properties.coordinate_source_version, '11509');
  assert.equal(merged.unresolved.length, 0);
});

test('medical coordinate matching uses the first listed doorplate even when alternatives are nearby', () => {
  const address = '臺北市松山區敦化南路一段69號2樓、67號2樓';
  const raw = rawSnapshot('taiwan-medical', {
    records: [{ 機構代碼: 'H303', 機構名稱: '近鄰門牌診所', 縣市鄉鎮: '臺北市松山區', 地址: address }],
  });
  const report = normalizeMedicalFacilitiesReport(raw, {
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
  });
  const merged = mergeMedicalCoordinates(report, [], {
    rawSnapshot: raw,
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
    addressCoordinateFeatures: [
      {
        geometry: { type: 'Point', coordinates: [121.549268, 25.045368] },
        properties: {
          address: '臺北市松山區敦化南路1段69號',
          matched_address_keys: [normalizeAddressText('臺北市松山區敦化南路1段69號')],
          administrative_area: '臺北市松山區', county_code: '63000',
          coordinate_source: 'official-doorplate:63000',
        },
      },
      {
        geometry: { type: 'Point', coordinates: [121.549268, 25.045413] },
        properties: {
          address: '臺北市松山區敦化南路1段67號',
          matched_address_keys: [normalizeAddressText('臺北市松山區敦化南路1段67號')],
          administrative_area: '臺北市松山區', county_code: '63000',
          coordinate_source: 'official-doorplate:63000',
        },
      },
    ],
  });

  assert.equal(merged.features.length, 1);
  assert.deepEqual(merged.features[0].geometry.coordinates, [121.549268, 25.045368]);
  assert.equal(merged.features[0].properties.coordinate_match_method, 'exact_address_doorplate');
  assert.equal(merged.unresolved.length, 0);
});

test('medical coordinate matching selects 424 as the first listed doorplate', () => {
  const address = '臺北市松山區八德路二段424,426號';
  const raw = rawSnapshot('taiwan-medical', {
    records: [{ 機構代碼: 'H304', 機構名稱: '遠距門牌診所', 縣市鄉鎮: '臺北市松山區', 地址: address }],
  });
  const report = normalizeMedicalFacilitiesReport(raw, {
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
  });
  const merged = mergeMedicalCoordinates(report, [], {
    rawSnapshot: raw,
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
    addressCoordinateFeatures: [
      {
        geometry: { type: 'Point', coordinates: [121.547277, 25.048053] },
        properties: {
          address: '臺北市松山區八德路2段424號',
          matched_address_keys: [normalizeAddressText('臺北市松山區八德路2段424號')],
          administrative_area: '臺北市松山區', county_code: '63000',
          coordinate_source: 'official-doorplate:63000',
        },
      },
      {
        geometry: { type: 'Point', coordinates: [121.547495, 25.047488] },
        properties: {
          address: '臺北市松山區八德路2段426號',
          matched_address_keys: [normalizeAddressText('臺北市松山區八德路2段426號')],
          administrative_area: '臺北市松山區', county_code: '63000',
          coordinate_source: 'official-doorplate:63000',
        },
      },
    ],
  });

  assert.equal(merged.features.length, 1);
  assert.deepEqual(merged.features[0].geometry.coordinates, [121.547277, 25.048053]);
  assert.equal(merged.features[0].properties.coordinate_match_method, 'exact_address_doorplate');
  assert.equal(merged.unresolved.length, 0);
});

test('medical coordinate matching selects the first listed doorplate even when later alternatives are distant', () => {
  const address = '臺北市松山區八德路二段424,426號';
  const raw = rawSnapshot('taiwan-medical', {
    records: [{ 機構代碼: 'H305', 機構名稱: '遠距門牌診所', 縣市鄉鎮: '臺北市松山區', 地址: address }],
  });
  const report = normalizeMedicalFacilitiesReport(raw, {
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
  });
  const merged = mergeMedicalCoordinates(report, [], {
    rawSnapshot: raw,
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
    addressCoordinateFeatures: [
      {
        geometry: { type: 'Point', coordinates: [121.547277, 25.048053] },
        properties: {
          address: '臺北市松山區八德路2段424號',
          matched_address_keys: [normalizeAddressText('臺北市松山區八德路2段424號')],
          administrative_area: '臺北市松山區', county_code: '63000',
          coordinate_source: 'official-doorplate:63000',
        },
      },
      {
        geometry: { type: 'Point', coordinates: [121.550000, 25.050000] },
        properties: {
          address: '臺北市松山區八德路2段426號',
          matched_address_keys: [normalizeAddressText('臺北市松山區八德路2段426號')],
          administrative_area: '臺北市松山區', county_code: '63000',
          coordinate_source: 'official-doorplate:63000',
        },
      },
    ],
  });

  assert.equal(merged.features.length, 1);
  assert.deepEqual(merged.features[0].geometry.coordinates, [121.547277, 25.048053]);
  assert.equal(merged.features[0].properties.coordinate_match_method, 'exact_address_doorplate');
  assert.equal(merged.unresolved.length, 0);
});

test('medical coordinate matching uses the first full address when multiple streets are listed', () => {
  const address = '臺北市松山區南京東路四段66號2樓、寧安街68巷25號2樓';
  const raw = rawSnapshot('taiwan-medical', {
    records: [{ 機構代碼: 'H306', 機構名稱: '雙地址診所', 縣市鄉鎮: '臺北市松山區', 地址: address }],
  });
  const report = normalizeMedicalFacilitiesReport(raw, {
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
  });
  const merged = mergeMedicalCoordinates(report, [], {
    rawSnapshot: raw,
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
    addressCoordinateFeatures: [
      {
        geometry: { type: 'Point', coordinates: [121.558100, 25.051100] },
        properties: {
          address: '臺北市松山區南京東路4段66號',
          matched_address_keys: [normalizeAddressText('臺北市松山區南京東路4段66號')],
          administrative_area: '臺北市松山區', county_code: '63000',
          coordinate_source: 'official-doorplate:63000',
        },
      },
      {
        geometry: { type: 'Point', coordinates: [121.558300, 25.051200] },
        properties: {
          address: '臺北市松山區寧安街68巷25號',
          matched_address_keys: [normalizeAddressText('臺北市松山區寧安街68巷25號')],
          administrative_area: '臺北市松山區', county_code: '63000',
          coordinate_source: 'official-doorplate:63000',
        },
      },
    ],
  });

  assert.equal(merged.features.length, 1);
  assert.deepEqual(merged.features[0].geometry.coordinates, [121.558100, 25.051100]);
  assert.equal(merged.features[0].properties.coordinate_match_method, 'exact_address_doorplate');
  assert.equal(merged.unresolved.length, 0);
});

test('medical coordinate matching uses the first doorplate in a compound doorplate list', () => {
  const address = '臺北市內湖區內湖路1、2號11樓';
  const raw = rawSnapshot('taiwan-medical', {
    records: [{ 機構代碼: 'H302', 機構名稱: '複合門牌診所', 縣市鄉鎮: '臺北市內湖區', 地址: address }],
  });
  const report = normalizeMedicalFacilitiesReport(raw, {
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
  });
  const merged = mergeMedicalCoordinates(report, [], {
    rawSnapshot: raw,
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
    addressCoordinateFeatures: ['1', '2'].map((number, index) => ({
      geometry: { type: 'Point', coordinates: [121.58 + index * 0.001, 25.08] },
      properties: {
        address: `臺北市內湖區內湖路${number}號`,
        matched_address_keys: [normalizeAddressText(`臺北市內湖區內湖路${number}號`)],
        administrative_area: '臺北市內湖區',
        county_code: '63000',
        coordinate_source: 'official-doorplate:63000',
      },
    })),
  });

  assert.equal(merged.features.length, 1);
  assert.deepEqual(merged.features[0].geometry.coordinates, [121.58, 25.08]);
  assert.equal(merged.features[0].properties.coordinate_match_method, 'exact_address_doorplate');
  assert.equal(merged.unresolved.length, 0);
});

test('reviewed medical address correction selects the confirmed doorplate from a compound address', () => {
  const originalAddress = '臺北市松山區南京東路5段166、168號11樓';
  const correctedAddress = '臺北市松山區南京東路5段168號11樓';
  const raw = rawSnapshot('taiwan-medical', {
    records: [{ 機構代碼: '3501015544', 機構名稱: '微醫未來美學診所', 縣市鄉鎮: '臺北市松山區', 地址: originalAddress }],
  });
  const report = normalizeMedicalFacilitiesReport(raw, {
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
  });
  const merged = mergeMedicalCoordinates(report, [], {
    rawSnapshot: raw,
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
    addressCoordinateFeatures: [
      {
        geometry: { type: 'Point', coordinates: [121.563231, 25.051227] },
        properties: {
          address: '臺北市松山區南京東路5段166號',
          matched_address_keys: [normalizeAddressText('臺北市松山區南京東路5段166號')],
          administrative_area: '臺北市松山區', county_code: '63000',
          coordinate_source: 'official-doorplate:63000',
        },
      },
      {
        geometry: { type: 'Point', coordinates: [121.563308, 25.051226] },
        properties: {
          address: '臺北市松山區南京東路5段168號',
          matched_address_keys: [normalizeAddressText('臺北市松山區南京東路5段168號')],
          administrative_area: '臺北市松山區', county_code: '63000',
          coordinate_source: 'official-doorplate:63000',
        },
      },
    ],
  });

  assert.equal(merged.features.length, 1);
  assert.deepEqual(merged.features[0].geometry.coordinates, [121.563308, 25.051226]);
  assert.equal(merged.features[0].properties.address, correctedAddress);
  assert.equal(merged.features[0].properties.source_record.地址, originalAddress);
  assert.equal(merged.features[0].properties.coordinate_match_method, 'reviewed_address_correction');
  assert.equal(merged.features[0].properties.coordinate_match_correction_id, 'medical-address-correction-3501015544');
  assert.equal(merged.features[0].properties.coordinate_source, 'official-doorplate:63000');
  assert.equal(merged.unresolved.length, 0);
});

test('reviewed medical address correction requires both the exact institution code and source address', () => {
  const sourceAddress = '臺北市松山區南京東路5段166、168號11樓';
  assert.ok(findReviewedMedicalAddressCorrection({
    address: sourceAddress,
    source_record: { 機構代碼: '3501015544' },
  }));
  assert.equal(findReviewedMedicalAddressCorrection({
    address: sourceAddress,
    source_record: { 機構代碼: '3501015545' },
  }), null);
  assert.equal(findReviewedMedicalAddressCorrection({
    address: '臺北市松山區南京東路5段166號11樓',
    source_record: { 機構代碼: '3501015544' },
  }), null);
});

test('medical coordinate matching rejects a near address and conflicting county code', () => {
  const raw = rawSnapshot('taiwan-medical', {
    records: [
      { 機構代碼: 'H401', 機構名稱: '近似地址診所', 縣市鄉鎮: '臺北市內湖區', 地址: '臺北市內湖區內湖路1號' },
      { 機構代碼: 'H402', 機構名稱: '跨縣代碼診所', 縣市鄉鎮: '臺北市內湖區', 地址: '臺北市內湖區內湖路2號' },
    ],
  });
  const report = normalizeMedicalFacilitiesReport(raw, {
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
  });
  const merged = mergeMedicalCoordinates(report, [], {
    rawSnapshot: raw,
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
    addressCoordinateFeatures: [
      {
        geometry: { type: 'Point', coordinates: [121.58, 25.08] },
        properties: {
          address: '臺北市內湖區內湖路11號',
          matched_address_keys: [normalizeAddressText('臺北市內湖區內湖路11號')],
          administrative_area: '臺北市內湖區',
          county_code: '63000',
          coordinate_source: 'official-doorplate:63000',
        },
      },
      {
        geometry: { type: 'Point', coordinates: [121.59, 25.09] },
        properties: {
          address: '臺北市內湖區內湖路2號',
          matched_address_keys: [normalizeAddressText('臺北市內湖區內湖路2號')],
          administrative_area: '臺北市內湖區',
          county_code: '65000',
          coordinate_source: 'official-doorplate:65000',
        },
      },
    ],
  });

  assert.equal(merged.features.length, 0);
  assert.equal(merged.unresolved.length, 2);
});

test('medical address matching collapses nearby duplicate doorplate points and keeps distant points ambiguous', () => {
  const address = '臺北市內湖區內湖路3號';
  const raw = rawSnapshot('taiwan-medical', {
    records: [{ 機構代碼: 'H501', 機構名稱: '重複門牌診所', 縣市鄉鎮: '臺北市內湖區', 地址: address }],
  });
  const report = normalizeMedicalFacilitiesReport(raw, {
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
  });
  const candidate = (coordinates) => ({
    geometry: { type: 'Point', coordinates },
    properties: {
      address,
      matched_address_keys: [normalizeAddressText(address)],
      administrative_area: '臺北市內湖區',
      county_code: '63000',
      coordinate_source: 'official-doorplate:63000',
    },
  });
  const options = {
    rawSnapshot: raw,
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
    addressCoordinateFeatures: [candidate([121.58, 25.08]), candidate([121.58, 25.08])],
  };
  const merged = mergeMedicalCoordinates(report, [], options);

  assert.equal(merged.features.length, 1);
  assert.equal(merged.unresolved.length, 0);

  const ambiguous = mergeMedicalCoordinates(report, [], {
    ...options,
    addressCoordinateFeatures: [candidate([121.58, 25.08]), candidate([121.5801, 25.0801])],
  });
  assert.equal(ambiguous.features.length, 1);
  assert.equal(ambiguous.features[0].properties.coordinate_match_method, 'nearby_address_candidate');
  assert.equal(ambiguous.unresolved.length, 0);

  const distant = mergeMedicalCoordinates(report, [], {
    ...options,
    addressCoordinateFeatures: [candidate([121.58, 25.08]), candidate([121.59, 25.09])],
  });
  assert.equal(distant.features.length, 0);
  assert.equal(distant.unresolved[0].coordinate_failure_reason, 'multiple_candidates');
});

test('medical coordinate matching keeps duplicate or ambiguous official candidates unresolved', () => {
  const raw = rawSnapshot('taiwan-medical', {
    records: [
      { 機構代碼: 'H001', 機構名稱: '代碼醫院', 縣市鄉鎮: '臺北市內湖區', 地址: '內湖路1號' },
      { 機構代碼: 'H002', 機構名稱: '同名診所', 縣市鄉鎮: '臺北市內湖區', 地址: '內湖路2號' },
    ],
  });
  const report = normalizeMedicalFacilitiesReport(raw, {
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
  });
  const merged = mergeMedicalCoordinates(report, [
    {
      geometry: { type: 'Point', coordinates: [121.58, 25.08] },
      properties: { institution_code: 'H001', name: '代碼醫院', address: '內湖路1號', coordinate_source: 'nlsc' },
    },
    {
      geometry: { type: 'Point', coordinates: [121.59, 25.09] },
      properties: { name: '同名診所', address: '內湖路2號', coordinate_source: 'fallback-a' },
    },
    {
      geometry: { type: 'Point', coordinates: [121.60, 25.10] },
      properties: { name: '同名診所', address: '內湖路2號', coordinate_source: 'fallback-b' },
    },
  ], {
    rawSnapshot: raw,
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
  });

  assert.equal(merged.features.length, 1);
  assert.equal(merged.features[0].properties.coordinate_match_method, 'institution_code');
  assert.equal(merged.unresolved.length, 1);
  assert.equal(merged.unresolved[0].medical_id, 'h002');
});

test('medical institution codes do not override mismatched names, addresses, or county labels', () => {
  const raw = rawSnapshot('taiwan-medical', {
    records: [
      { 機構代碼: 'H001', 機構名稱: '代碼醫院', 縣市鄉鎮: '臺北市內湖區', 地址: '內湖路1號' },
      { 機構代碼: 'H002', 機構名稱: '花蓮醫院', 縣市鄉鎮: '花蓮縣花蓮市', 地址: '花蓮路2號' },
    ],
  });
  const report = normalizeMedicalFacilitiesReport(raw, {
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
  });
  const merged = mergeMedicalCoordinates(report, [
    {
      geometry: { type: 'Point', coordinates: [121.58, 25.08] },
      properties: { institution_code: 'H001', name: '代碼醫院', address: '不同路段9號', coordinate_source: 'nlsc' },
    },
    {
      geometry: { type: 'Point', coordinates: [121.61, 24.02] },
      properties: {
        institution_code: 'H002', name: '花蓮醫院', address: '花蓮路2號',
        administrative_area: '臺北市內湖區', coordinate_source: 'nlsc',
      },
    },
  ], {
    rawSnapshot: raw,
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
  });

  assert.equal(merged.features.length, 0);
  assert.deepEqual(merged.unresolved.map((row) => row.coordinate_failure_reason), [
    'name_address_mismatch', 'name_address_mismatch',
  ]);
});

test('medical unresolved rows include auditable coordinate failure reasons', () => {
  const raw = rawSnapshot('taiwan-medical', {
    records: [
      { 機構代碼: 'H001', 機構名稱: '無候選醫院', 縣市鄉鎮: '臺北市內湖區', 地址: '內湖路1號' },
      { 機構代碼: 'H002', 機構名稱: '名稱不符醫院', 縣市鄉鎮: '臺北市內湖區', 地址: '內湖路2號' },
      { 機構代碼: 'H003', 機構名稱: '多候選醫院', 縣市鄉鎮: '臺北市內湖區', 地址: '內湖路3號' },
    ],
  });
  const report = normalizeMedicalFacilitiesReport(raw, {
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
  });
  const merged = mergeMedicalCoordinates(report, [
    { geometry: { type: 'Point', coordinates: [121.58, 25.08] }, properties: { name: '其他醫院', address: '別處' } },
    { geometry: { type: 'Point', coordinates: [121.59, 25.09] }, properties: { name: '多候選醫院', address: '內湖路3號' } },
    { geometry: { type: 'Point', coordinates: [121.60, 25.10] }, properties: { name: '多候選醫院', address: '內湖路3號' } },
  ], {
    rawSnapshot: raw,
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    sourceId: 'taiwan-medical',
    coverage: 'TW',
    expiresAt: EXPIRES_AT,
  });

  assert.deepEqual(merged.unresolved.map((row) => row.coordinate_failure_reason).sort(), [
    'multiple_candidates', 'name_address_mismatch', 'name_address_mismatch',
  ]);
  assert.deepEqual(merged.unresolved_reason_counts, {
    no_coordinate_candidate: 0,
    name_address_mismatch: 2,
    multiple_candidates: 1,
    source_missing: 0,
  });
});

test('emergency medical layer uses reviewed institution codes and reports partial coverage', () => {
  const result = reconcileEmergencyMedicalFacilities({
    roster: {
      schema_version: 'emergency-medical-roster-v1',
      source_version: 'mohw-2026-04-29',
      source_url: 'https://www.mohw.gov.tw/official-emergency-roster.pdf',
      facilities: [
        { roster_id: 'roster:001', name: '內湖急救醫院', county: '臺北市', emergency_level: '重度級' },
        { roster_id: 'roster:002', name: '尚未配對醫院', county: '花蓮縣', emergency_level: '一般級' },
      ],
    },
    crosswalk: {
      schema_version: 'emergency-medical-crosswalk-v1',
      version: 'review-2026-10-03-1',
      mappings: [{
        roster_id: 'roster:001',
        institution_code: '0201010010',
        evidence_url: 'https://example.test/mohw-code-and-coordinate',
        evidence_version: 'medical-master-v2026-1',
        reviewer: 'data-steward',
        reviewed_at: RETRIEVED_AT,
      }],
    },
    medicalFeatures: [{
      schema_version: 'feature-v0',
      dataset_id: 'resilientgeo-taiwan',
      layer_id: 'taiwan-medical',
      feature_id: 'medical:0201010010',
      feature_type: 'HOSPITAL',
      namespace: 'official.medical',
      geometry: { type: 'Point', coordinates: [121.58, 25.08] },
      properties: {
        name: '內湖急救醫院',
        address: '內湖路1號',
        source_record: { 機構代碼: '0201010010' },
        institution_code: '0201010010',
        coordinate_source: 'nlsc-medical-coordinates',
        coordinate_match_method: 'institution_code',
      },
      source: 'taiwan-medical',
      source_version: 'medical-v1',
      issued_at: RETRIEVED_AT,
      expires_at: EXPIRES_AT,
      provenance: { original_source: 'https://example.test', received_at: RETRIEVED_AT, transport_source: { kind: 'server' } },
    }],
    now: new Date(RETRIEVED_AT),
  });

  assert.equal(result.report.hospital_count, 2);
  assert.equal(result.report.located_count, 1);
  assert.equal(result.report.unresolved_count, 1);
  assert.equal(result.report.coverage, 'partial');
  assert.equal(result.report.source_version, 'mohw-2026-04-29');
  assert.equal(result.features[0].layer_id, 'taiwan-emergency-medical');
  assert.equal(result.features[0].properties.institution_code, '0201010010');
  assert.equal('source_record' in result.features[0].properties, false);
});
