import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildMedicalCoordinateQueryPlan,
  fetchOfficialMedicalCoordinates,
  normalizeMedicalCoordinateFeatures,
} from '../sources/medical-coordinates.mjs';
import { isGeometryInBoundary } from '../lib/geo.mjs';

const BOUNDARY = {
  type: 'Polygon',
  coordinates: [[[121.50, 25.00], [121.65, 25.00], [121.65, 25.15], [121.50, 25.15], [121.50, 25.00]]],
};

function response(payload, headers = {}) {
  return {
    status: 200,
    ok: true,
    headers: new Headers(headers),
    async json() { return payload; },
  };
}

test('builds a deterministic coordinate query plan from the Taiwan boundary', () => {
  const plan = buildMedicalCoordinateQueryPlan(BOUNDARY, {
    radiusMeters: 5000,
    spacingMeters: 7000,
    maxQueries: 100,
  });

  assert.ok(plan.length > 1);
  assert.deepEqual(plan[0], { longitude: 121.5, latitude: 25 });
  assert.deepEqual(plan, buildMedicalCoordinateQueryPlan(BOUNDARY, {
    radiusMeters: 5000,
    spacingMeters: 7000,
    maxQueries: 100,
  }));
});

test('builds query bounds for a nationwide boundary with more coordinates than a spread call accepts', () => {
  const ring = Array.from({ length: 200_000 }, () => [121.5, 25]);
  const boundary = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [ring] },
    }],
  };

  assert.deepEqual(buildMedicalCoordinateQueryPlan(boundary, {
    spacingMeters: 10000,
    maxQueries: 10,
  }), [{ longitude: 121.5, latitude: 25 }]);
});

test('plans bounded in-boundary query points for each Taiwan town feature', () => {
  const town = (coordinates) => ({
    type: 'Feature',
    properties: { level: 'town' },
    geometry: { type: 'Polygon', coordinates: [coordinates] },
  });
  const boundary = {
    type: 'FeatureCollection',
    features: [
      town([[120, 24], [120.2, 24], [120.2, 24.2], [120, 24.2], [120, 24]]),
      town([[122, 26], [122.2, 26], [122.2, 26.2], [122, 26.2], [122, 26]]),
      town([[123, 27], [123.2, 27], [123.2, 27.05], [123.05, 27.05], [123.05, 27.2], [123, 27.2], [123, 27]]),
    ],
  };

  const plan = buildMedicalCoordinateQueryPlan(boundary, {
    spacingMeters: 10000,
    maxQueries: 3,
  });

  assert.deepEqual(plan, [
    { longitude: 120.1, latitude: 24.1 },
    { longitude: 122.1, latitude: 26.1 },
    { longitude: 123, latitude: 27 },
  ]);
  assert.ok(plan.every(({ longitude, latitude }) => isGeometryInBoundary({
    type: 'Point',
    coordinates: [longitude, latitude],
  }, boundary)));
});

test('selects each town representative within its own polygon when its center falls in a neighbor', () => {
  const boundary = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { level: 'town' },
        geometry: {
          type: 'Polygon',
          coordinates: [[[123, 27], [123.2, 27], [123.2, 27.05], [123.05, 27.05], [123.05, 27.2], [123, 27.2], [123, 27]]],
        },
      },
      {
        type: 'Feature',
        properties: { level: 'town' },
        geometry: {
          type: 'Polygon',
          coordinates: [[[123.06, 27.06], [123.14, 27.06], [123.14, 27.14], [123.06, 27.14], [123.06, 27.06]]],
        },
      },
    ],
  };

  assert.deepEqual(buildMedicalCoordinateQueryPlan(boundary, { maxQueries: 2 }), [
    { longitude: 123, latitude: 27 },
    { longitude: 123.1, latitude: 27.1 },
  ]);
});

test('keeps full-precision town query points inside narrow boundaries', () => {
  const boundary = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { level: 'town' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[121.1234567, 25], [121.1234569, 25], [121.1234568, 25.0000002], [121.1234567, 25]]],
      },
    }],
  };
  const plan = buildMedicalCoordinateQueryPlan(boundary, { maxQueries: 1 });

  assert.deepEqual(plan, [{ longitude: 121.1234568, latitude: 25.0000001 }]);
  assert.ok(isGeometryInBoundary({ type: 'Point', coordinates: [plan[0].longitude, plan[0].latitude] }, boundary));
});

test('normalizes official coordinate records and rejects points outside the boundary', () => {
  const result = normalizeMedicalCoordinateFeatures({
    records: [
      {
        機構代碼: 'H001',
        設施名稱: '內湖醫院',
        門牌: '臺北市內湖區成功路1號',
        經度: '121.58',
        緯度: '25.08',
      },
      {
        機構代碼: 'OUTSIDE',
        設施名稱: '外部醫院',
        門牌: '外部地址',
        經度: '120.00',
        緯度: '22.00',
      },
    ],
  }, {
    boundary: BOUNDARY,
    sourceId: 'nlsc-medical-coordinates',
    sourceVersion: 'nlsc-2026-10',
  });

  assert.equal(result.features.length, 1);
  assert.equal(result.rejected_coordinate_count, 1);
  assert.deepEqual(result.features[0].geometry, { type: 'Point', coordinates: [121.58, 25.08] });
  assert.equal(result.features[0].properties.institution_code, 'H001');
  assert.equal(result.features[0].properties.coordinate_source, 'nlsc-medical-coordinates');
  assert.equal(result.features[0].properties.coordinate_source_version, 'nlsc-2026-10');
});

test('parses the NLSC point response shape with lon/lat and addr fields', () => {
  const result = normalizeMedicalCoordinateFeatures([
    {
      type: 'Point',
      lon: 121.59,
      lat: 25.09,
      name: '國土醫療設施',
      addr: '臺北市內湖區測試路1號',
    },
  ], { boundary: BOUNDARY, sourceVersion: 'nlsc-response-v1' });

  assert.equal(result.features.length, 1);
  assert.deepEqual(result.features[0].geometry.coordinates, [121.59, 25.09]);
  assert.equal(result.features[0].properties.name, '國土醫療設施');
  assert.equal(result.features[0].properties.address, '臺北市內湖區測試路1號');
});

test('queries NLSC once per planned point and merges reviewed official fallback sources', async () => {
  const calls = [];
  const result = await fetchOfficialMedicalCoordinates({
    endpoint: 'https://api.nlsc.gov.tw/other/MarkBufferAnlys/med',
    fallbackEndpoints: ['https://health.example.gov.tw/medical/coordinates.json'],
    queryPoints: [{ longitude: 121.58, latitude: 25.08 }],
    radiusMeters: 1000,
    boundary: BOUNDARY,
    retrievedAt: '2026-10-02T00:00:00Z',
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes('health.example.gov.tw')) {
        return response({
          records: [{
            機構代碼: 'H002', 設施名稱: '衛生所', 門牌: '內湖路2號', 經度: 121.59, 緯度: 25.09,
          }],
        }, { ETag: '"fallback-v1"' });
      }
      return response({
        records: [{
          機構代碼: 'H001', 設施名稱: '內湖醫院', 門牌: '成功路1號', 經度: 121.58, 緯度: 25.08,
        }],
      }, { ETag: '"nlsc-v1"' });
    },
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0], /121\.58\/25\.08\/1000$/u);
  assert.deepEqual(result.source_ids, ['nlsc-medical-coordinates', 'official-medical-fallback-1']);
  assert.equal(result.features.length, 2);
  assert.deepEqual(
    result.features.map((feature) => feature.properties.institution_code).sort(),
    ['H001', 'H002'],
  );
});

test('keeps candidates from successful NLSC queries when another query fails', async () => {
  const result = await fetchOfficialMedicalCoordinates({
    endpoint: 'https://api.nlsc.gov.tw/other/MarkBufferAnlys/med',
    queryPoints: [
      { longitude: 121.52, latitude: 25.02 },
      { longitude: 121.55, latitude: 25.05 },
      { longitude: 121.60, latitude: 25.10 },
    ],
    radiusMeters: 1000,
    maxQueries: 3,
    concurrency: 1,
    boundary: BOUNDARY,
    fetchImpl: async (url) => {
      if (url.includes('/121.55/25.05/')) {
        return { ...response({ message: 'not found' }), status: 404 };
      }
      return response({ records: [{
        機構代碼: 'H001',
        設施名稱: '內湖醫院',
        門牌: '臺北市內湖區成功路1號',
        經度: 121.58,
        緯度: 25.08,
      }] });
    },
  });

  assert.equal(result.query_count, 3);
  assert.equal(result.successful_query_count, 2);
  assert.equal(result.failed_query_count, 1);
  assert.deepEqual(result.failed_query_error_counts, { HTTP_ERROR: 1 });
  assert.equal(result.features.length, 1);
});
