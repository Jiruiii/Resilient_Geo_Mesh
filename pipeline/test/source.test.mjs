import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SourceRequestError,
  makeRawSnapshot,
  requestJsonConditional,
  requestJson,
  requestText,
  validateRawSnapshot,
} from '../lib/source.mjs';
import {
  GeoValidationError,
  filterRecordsToNeihu,
  isGeometryInNeihu,
  normalizeCoordinate,
} from '../lib/geo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OFFICIAL_NEIHU_BOUNDARY = JSON.parse(readFileSync(
  path.join(ROOT, 'pipeline/sources/boundaries/taipei-neihu.geojson'),
  'utf8',
));

const BOUNDARY = {
  type: 'Feature',
  properties: { name: 'test boundary' },
  geometry: {
    type: 'Polygon',
    coordinates: [[
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ]],
  },
};

function response({ status = 200, payload = { records: [] }, headers = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    async json() {
      return payload;
    },
  };
}

test('creates a Raw snapshot without storing request secrets', () => {
  const snapshot = makeRawSnapshot({
    sourceId: 'test-source',
    request: {
      method: 'GET',
      url: 'https://example.gov.tw/data?api_key=secret&format=json',
      query: { api_key: 'secret', format: 'json' },
      headers: {
        Authorization: 'Bearer secret',
        'X-Api-Key': 'secret',
        'Client-Secret': 'secret',
      },
    },
    responseStatus: 200,
    responseHeaders: {
      ETag: '"snapshot-1"',
      'Last-Modified': 'Wed, 04 Sep 2026 00:00:00 GMT',
      'Content-Type': 'application/json',
      Authorization: 'Bearer response-secret',
    },
    retrievedAt: '2026-09-04T00:05:00Z',
    payload: { records: [{ id: '1' }] },
  });

  assert.deepEqual(snapshot, {
    schema_version: 'raw-snapshot-v0',
    source_id: 'test-source',
    request: {
      method: 'GET',
      url: 'https://example.gov.tw/data?format=json',
      query: { format: 'json' },
    },
    response: {
      status: 200,
      headers: {
        etag: '"snapshot-1"',
        last_modified: 'Wed, 04 Sep 2026 00:00:00 GMT',
        content_type: 'application/json',
      },
    },
    retrieved_at: '2026-09-04T00:05:00Z',
    payload: { records: [{ id: '1' }] },
  });
  assert.deepEqual(validateRawSnapshot(snapshot), []);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret/u);
});

test('rejects invalid Raw snapshot inputs before curation', () => {
  assert.throws(
    () => makeRawSnapshot({
      sourceId: '',
      request: { method: 'GET', url: 'https://example.gov.tw' },
      responseStatus: 200,
      retrievedAt: '2026-09-04T00:05:00Z',
      payload: {},
    }),
    /sourceId/u,
  );
  assert.throws(
    () => makeRawSnapshot({
      sourceId: 'test-source',
      request: { method: 'GET', url: 'https://example.gov.tw' },
      responseStatus: 500,
      retrievedAt: '2026-09-04T00:05:00Z',
      payload: {},
    }),
    /2xx/u,
  );
  assert.throws(
    () => makeRawSnapshot({
      sourceId: 'test-source',
      request: { method: 'GET', url: 'https://example.gov.tw' },
      responseStatus: 200,
      retrievedAt: '2026/09/04',
      payload: {},
    }),
    /retrievedAt/u,
  );
  assert.throws(
    () => makeRawSnapshot({
      sourceId: 'test-source',
      request: { method: 'GET', url: 'https://example.gov.tw' },
      responseStatus: 200,
      retrievedAt: '2026-09-04T00:05:00Z',
      payload: null,
    }),
    /payload/u,
  );
});

test('requestJson raises a typed error for an HTTP failure', async () => {
  const fetchImpl = async () => response({ status: 503, payload: { error: 'unavailable' } });
  await assert.rejects(
    requestJson('https://example.gov.tw/data', { fetchImpl, maxAttempts: 1 }),
    (error) => {
      assert.equal(error instanceof SourceRequestError, true);
      assert.equal(error.status, 503);
      assert.equal(error.code, 'HTTP_ERROR');
      return true;
    },
  );
});

test('requestJson honors Retry-After before retrying a rate-limited response', async () => {
  const delays = [];
  let attempts = 0;
  const result = await requestJson('https://example.gov.tw/data', {
    maxAttempts: 2,
    sleepImpl: async (milliseconds) => delays.push(milliseconds),
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return response({ status: 429, headers: { 'Retry-After': '3' } });
      return response({ payload: { records: [{ id: 'recovered' }] } });
    },
  });

  assert.equal(result.payload.records[0].id, 'recovered');
  assert.deepEqual(delays, [3000]);
});

test('requestJson returns payload and safe response metadata', async () => {
  const result = await requestJson('https://example.gov.tw/data', {
    fetchImpl: async () => response({
      headers: {
        ETag: '"snapshot-2"',
        'Last-Modified': 'Thu, 05 Sep 2026 00:00:00 GMT',
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: 'Bearer should-not-be-copied',
      },
      payload: { records: [{ id: '2' }] },
    }),
  });
  assert.deepEqual(result, {
    status: 200,
    headers: {
      etag: '"snapshot-2"',
      last_modified: 'Thu, 05 Sep 2026 00:00:00 GMT',
      content_type: 'application/json; charset=utf-8',
    },
    payload: { records: [{ id: '2' }] },
  });
});

test('requestJsonConditional sends validators and accepts a 304 response', async () => {
  const requests = [];
  const notModified = await requestJsonConditional('https://example.gov.tw/data', {
    validators: {
      etag: '"snapshot-2"',
      lastModified: 'Thu, 05 Sep 2026 00:00:00 GMT',
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, headers: init.headers });
      return response({
        status: 304,
        headers: {
          ETag: '"snapshot-2"',
          'Last-Modified': 'Thu, 05 Sep 2026 00:00:00 GMT',
        },
      });
    },
    maxAttempts: 1,
  });

  assert.equal(notModified.notModified, true);
  assert.equal(notModified.status, 304);
  assert.equal(requests[0].headers['If-None-Match'], '"snapshot-2"');
  assert.equal(requests[0].headers['If-Modified-Since'], 'Thu, 05 Sep 2026 00:00:00 GMT');
});

test('requestText returns body and safe response metadata', async () => {
  const result = await requestText('https://example.gov.tw/data', {
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      headers: new Headers({
        ETag: '"text-1"',
        'Content-Type': 'text/csv; charset=utf-8',
        Authorization: 'Bearer should-not-be-copied',
      }),
      async text() { return 'id,name\n1,內湖'; },
    }),
  });
  assert.deepEqual(result, {
    status: 200,
    headers: {
      etag: '"text-1"',
      content_type: 'text/csv; charset=utf-8',
    },
    body: 'id,name\n1,內湖',
  });
});

test('recognizes an inside point and rejects an outside point', () => {
  assert.equal(isGeometryInNeihu({ type: 'Point', coordinates: [5, 5] }, BOUNDARY), true);
  assert.equal(isGeometryInNeihu({ type: 'Point', coordinates: [15, 5] }, BOUNDARY), false);
});

test('uses the official WGS84 Neihu boundary snapshot', () => {
  assert.equal(OFFICIAL_NEIHU_BOUNDARY.type, 'FeatureCollection');
  assert.equal(OFFICIAL_NEIHU_BOUNDARY.features.length, 1);
  assert.equal(OFFICIAL_NEIHU_BOUNDARY.features[0].properties.district, '內湖區');
  assert.equal(OFFICIAL_NEIHU_BOUNDARY.features[0].geometry.type, 'Polygon');
  assert.equal(isGeometryInNeihu({ type: 'Point', coordinates: [121.58, 25.08] }, OFFICIAL_NEIHU_BOUNDARY), true);
  assert.equal(isGeometryInNeihu({ type: 'Point', coordinates: [121.54, 25.08] }, OFFICIAL_NEIHU_BOUNDARY), false);
});

test('keeps a line crossing the Neihu boundary by envelope intersection', () => {
  assert.equal(isGeometryInNeihu({
    type: 'LineString',
    coordinates: [[-5, 5], [5, 5]],
  }, BOUNDARY), true);
  assert.equal(isGeometryInNeihu({
    type: 'LineString',
    coordinates: [[-5, 15], [-1, 15]],
  }, BOUNDARY), false);
});

test('filters records to Neihu and throws on a record without geometry', () => {
  const records = [
    { id: 'inside', geometry: { type: 'Point', coordinates: [5, 5] } },
    { id: 'outside', geometry: { type: 'Point', coordinates: [15, 5] } },
  ];
  assert.deepEqual(filterRecordsToNeihu(records, BOUNDARY), [records[0]]);
  assert.throws(
    () => filterRecordsToNeihu([...records, { id: 'missing-geometry' }], BOUNDARY),
    (error) => error instanceof GeoValidationError && /geometry/u.test(error.message),
  );
});

test('normalizes WGS84 coordinates and rejects reversed latitude-longitude input', () => {
  assert.deepEqual(normalizeCoordinate([121.58, 25.08]), [121.58, 25.08]);
  assert.throws(() => normalizeCoordinate([25.08, 121.58]), /latitude/u);
  assert.throws(() => normalizeCoordinate([181, 25.08]), /longitude/u);
});
