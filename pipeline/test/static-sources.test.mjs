import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  fetchOsmNeihu,
  normalizeOsmFeatures,
} from '../sources/osm.mjs';
import {
  fetchShelters,
  normalizeShelters,
} from '../sources/shelter.mjs';
import {
  fetchMedicalFacilities,
  normalizeMedicalFacilities,
} from '../sources/medical.mjs';
import { makeRawSnapshot } from '../lib/source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BOUNDARY = JSON.parse(readFileSync(
  path.join(ROOT, 'pipeline/sources/boundaries/taipei-neihu.geojson'),
  'utf8',
));
const RETRIEVED_AT = '2026-09-04T04:00:00Z';
const EXPIRES_AT = '2026-10-04T04:00:00Z';

function response({ payload = {}, body = JSON.stringify(payload), headers = {}, status = 200 } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ 'Content-Type': 'application/json', ...headers }),
    async json() { return payload; },
    async text() { return body; },
  };
}

function rawSnapshot(sourceId, url, payload) {
  return makeRawSnapshot({
    sourceId,
    request: { method: 'GET', url, query: {} },
    responseStatus: 200,
    responseHeaders: { ETag: `"${sourceId}-fixture-1"` },
    retrievedAt: RETRIEVED_AT,
    payload,
  });
}

test('fetches OSM with the Neihu relation query and preserves Raw metadata', async () => {
  const calls = [];
  const snapshot = await fetchOsmNeihu({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response({ payload: { version: 0.6, elements: [] }, headers: { ETag: '"osm-1"' } });
    },
    retrievedAt: RETRIEVED_AT,
  });
  assert.equal(calls.length, 1);
  assert.match(decodeURIComponent(calls[0].url), /area\(3602905065\)/u);
  assert.equal(snapshot.source_id, 'osm-neihu');
  assert.equal(snapshot.response.headers.etag, '"osm-1"');
});

test('normalizes OSM roads and POIs to Neihu static features', () => {
  const raw = rawSnapshot('osm-neihu', 'https://overpass-api.de/api/interpreter', {
    version: 0.6,
    osm3s: { timestamp_osm_base: '2026-09-04T03:30:00Z' },
    elements: [
      {
        type: 'way',
        id: 1001,
        version: 4,
        timestamp: '2026-09-04T03:30:00Z',
        tags: { highway: 'primary', name: '成功路' },
        geometry: [
          { lat: 25.079, lon: 121.57 },
          { lat: 25.081, lon: 121.58 },
        ],
      },
      {
        type: 'node',
        id: 2001,
        lat: 25.08,
        lon: 121.58,
        tags: { amenity: 'hospital', name: '內湖醫院' },
      },
      {
        type: 'node',
        id: 2002,
        lat: 25,
        lon: 121.5,
        tags: { amenity: 'hospital', name: '外部醫院' },
      },
    ],
  });
  const features = normalizeOsmFeatures(raw, { boundary: BOUNDARY, expiresAt: EXPIRES_AT });
  assert.equal(features.length, 2);
  assert.equal(features[0].layer_id, 'osm-poi');
  assert.equal(features[0].feature_type, 'HOSPITAL');
  assert.equal(features[0].feature_id, 'osm:node:2001');
  assert.equal(features[0].namespace, 'official.osm');
  assert.equal(features[0].properties.source_record.tags.name, '內湖醫院');
  assert.equal(features[1].layer_id, 'osm-road');
  assert.equal(features[1].geometry.type, 'LineString');
  assert.equal(features[1].properties.source_record.id, 1001);
});

test('parses shelter CSV and keeps static location and planned capacity only', async () => {
  const csv = [
    '序號,縣市及鄉鎮市區,村里,避難收容處所地址,經度,緯度,避難收容處所名稱,預計收容人數,適用災害類別,開設狀態',
    'S001,臺北市內湖區,港墘里,內湖路一段1號,121.58,25.08,內湖國小,300,地震;水災,FULL',
    'S002,新北市,外部里,外部路1號,121.50,25.00,外部學校,100,地震,CLOSED',
  ].join('\n');
  const raw = await fetchShelters({
    fetchImpl: async () => response({ body: csv, headers: { 'Content-Type': 'text/csv', ETag: '"shelter-1"' } }),
    retrievedAt: RETRIEVED_AT,
  });
  const normalized = normalizeShelters(raw, { boundary: BOUNDARY, expiresAt: EXPIRES_AT });
  const { features } = normalized;
  assert.equal(raw.payload.records.length, 2);
  assert.equal(features.length, 1);
  assert.equal(features[0].feature_id, 'shelter:s001');
  assert.equal(features[0].properties.capacity, 300);
  assert.equal(features[0].properties.status, undefined);
  assert.equal('statusEvents' in normalized, false);
});

test('shelter normalization has no dynamic status output', () => {
  const raw = rawSnapshot('taipei-shelter', 'https://example.gov.tw/shelters.csv', {
    records: [{
      序號: 'S003',
      縣市及鄉鎮市區: '臺北市內湖區',
      避難收容處所地址: '內湖路三段3號',
      經度: '121.58',
      緯度: '25.08',
      避難收容處所名稱: '內湖活動中心',
      預計收容人數: '100',
    }],
  });
  const normalized = normalizeShelters(raw, { boundary: BOUNDARY, expiresAt: EXPIRES_AT });
  assert.equal(normalized.features.length, 1);
  assert.equal('statusEvents' in normalized, false);
});

test('normalizes Neihu hospitals and excludes outside facilities', () => {
  const raw = rawSnapshot('taipei-medical', 'https://data.taipei/api/v1/medical', {
    result: {
      results: [
        { 機構代碼: 'H001', 機構名稱: '內湖醫院', 行政區: '內湖區', 地址: '臺北市內湖區成功路1號', 經度: '121.58', 緯度: '25.08', 分類: '醫院' },
        { 機構代碼: 'H002', 機構名稱: '外部醫院', 行政區: '信義區', 地址: '臺北市信義區', 經度: '121.56', 緯度: '25.03', 分類: '醫院' },
      ],
    },
  });
  const features = normalizeMedicalFacilities(raw, { boundary: BOUNDARY, expiresAt: EXPIRES_AT });
  assert.equal(features.length, 1);
  assert.equal(features[0].layer_id, 'medical');
  assert.equal(features[0].feature_id, 'medical:h001');
  assert.equal(features[0].feature_type, 'HOSPITAL');
  assert.equal(features[0].properties.source_record['機構名稱'], '內湖醫院');
});

test('rejects static source records without usable identity or geometry', () => {
  const raw = rawSnapshot('taipei-medical', 'https://data.taipei/api/v1/medical', {
    records: [{ 機構名稱: '', 行政區: '內湖區', 地址: '臺北市內湖區' }],
  });
  assert.throws(
    () => normalizeMedicalFacilities(raw, { boundary: BOUNDARY, expiresAt: EXPIRES_AT }),
    /identity|geometry|coordinate/u,
  );
});
