import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CwaCredentialError,
  CwaSourceError,
  fetchCwaEarthquakes,
  fetchCwaWarnings,
  normalizeCwaTyphoonWarnings,
  normalizeCwaEarthquakes,
  normalizeCwaWarnings,
} from '../sources/cwa.mjs';
import {
  NcdrCredentialError,
  NcdrSourceError,
  classifyNcdrOperationalRelevance,
  fetchNcdrHazards,
  normalizeNcdrHazards,
} from '../sources/ncdr.mjs';
import { makeRawSnapshot } from '../lib/source.mjs';
import { isGeometryInBoundary } from '../lib/geo.mjs';
import { areaBoundary, createAreaResolvers, normalizeAreaCatalog } from '../sources/areas.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OFFICIAL_NEIHU_BOUNDARY = JSON.parse(readFileSync(
  path.join(ROOT, 'pipeline/sources/boundaries/taipei-neihu.geojson'),
  'utf8',
));
const TAIWAN_SCOPE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { level: 'county' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[121.0, 24.0], [121.5, 24.0], [121.5, 24.5], [121.0, 24.5], [121.0, 24.0]]],
      },
    },
    {
      type: 'Feature',
      properties: { level: 'county' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[121.5, 24.0], [122.0, 24.0], [122.0, 24.5], [121.5, 24.5], [121.5, 24.0]]],
      },
    },
  ],
};

const CWA_EARTHQUAKE_ENDPOINT = 'https://opendata.cwa.gov.tw/api/v1/rest/datastore/E-A0015-001';
const CWA_WARNING_ENDPOINT = 'https://opendata.cwa.gov.tw/api/v1/rest/datastore/W-C0033-001';
const NCDR_ENDPOINT = 'https://alerts.ncdr.nat.gov.tw/api/datastore';
const NCDR_DETAIL_ENDPOINT = 'https://alerts.ncdr.nat.gov.tw/api/dump/datastore';
const RETRIEVED_AT = '2026-09-04T04:00:00Z';
const NCDR_EXPIRES_AT = '2026-09-04T05:00:00Z';

function response({ status = 200, payload = {}, headers = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    async json() {
      return payload;
    },
  };
}

function cwaEarthquakePayload() {
  return {
    success: true,
    result: {
      resource_id: 'E-A0015-001',
      records: [
        {
          EarthquakeNo: '115001',
          IssueTime: '2026-09-04T12:05:00+08:00',
          EndTime: '2026-09-05T12:05:00+08:00',
          OriginTime: '2026-09-04T12:01:00+08:00',
          EpicenterLatitude: '25.1000',
          EpicenterLongitude: '121.5800',
          MagnitudeValue: '4.2',
          CountyName: '臺北市',
          AreaDesc: '臺北市地區',
          StationID: 'NEIHU-001',
          StationName: '內湖測站',
          StationLatitude: '25.0800',
          StationLongitude: '121.5800',
          SeismicIntensity: '3級',
          unit: 'gal',
        },
        {
          EarthquakeNo: '115002',
          IssueTime: '2026-09-04T13:05:00+08:00',
          EndTime: '2026-09-05T13:05:00+08:00',
          OriginTime: '2026-09-04T13:01:00+08:00',
          EpicenterLatitude: '25.0000',
          EpicenterLongitude: '121.5000',
          MagnitudeValue: '3.1',
          CountyName: '新北市',
          AreaDesc: '新北市地區',
          StationID: 'OUTSIDE-001',
          StationLatitude: '25.0000',
          StationLongitude: '121.5000',
          SeismicIntensity: '1級',
          unit: 'gal',
        },
      ],
    },
  };
}

function cwaWarningPayload() {
  return {
    success: true,
    result: {
      resource_id: 'W-C0033-001',
      records: [
        {
          identifier: 'CWA-WARNING-NEIHU-001',
          IssueTime: '2026-09-04T03:00:00+08:00',
          EndTime: '2026-09-04T09:00:00+08:00',
          CountyName: '臺北市',
          AreaDesc: '臺北市',
          WarningType: '豪雨特報',
          Severity: 'Severe',
          Description: '臺北市有局部大雨發生的機率。',
        },
        {
          identifier: 'CWA-WARNING-OUTSIDE-001',
          IssueTime: '2026-09-04T03:00:00+08:00',
          EndTime: '2026-09-04T09:00:00+08:00',
          CountyName: '花蓮縣',
          AreaDesc: '花蓮縣',
          WarningType: '豪雨特報',
          Severity: 'Severe',
        },
      ],
    },
  };
}

function cwaEarthquakeApiPayload() {
  const payload = cwaEarthquakePayload();
  return {
    success: true,
    result: {
      resource_id: payload.result.resource_id,
      fields: [],
    },
    records: {
      datasetDescription: 'CWA earthquake reports',
      Earthquake: payload.result.records,
    },
  };
}

function cwaWarningApiPayload() {
  return {
    success: true,
    result: {
      resource_id: 'W-C0033-001',
      fields: [],
    },
    records: {
      location: [
        {
          locationName: '臺北市',
          geocode: 63000,
          hazardConditions: {
            hazards: [
              {
                info: {
                  language: 'zh-TW',
                  phenomena: '豪雨',
                  significance: '特報',
                },
                validTime: {
                  startTime: '2026-09-04 03:00:00',
                  endTime: '2026-09-04 09:00:00',
                },
              },
            ],
          },
        },
        {
          locationName: '花蓮縣',
          geocode: 10015,
          hazardConditions: {
            hazards: [],
          },
        },
      ],
    },
  };
}

function ncdrPayload() {
  return {
    data: [
      {
        CAPID: 'NCDR-NEIHU-FLOOD-001',
        event: '淹水警戒',
        sent: '2026-09-04T02:00:00+08:00',
        effective: '2026-09-04T02:00:00+08:00',
        expires: '2026-09-04T03:00:00+08:00',
        polygon: '25.0700,121.5700 25.0700,121.5900 25.0900,121.5900 25.0900,121.5700 25.0700,121.5700',
        areaDesc: '臺北市內湖區',
        severity: 'Severe',
        description: '內湖區淹水示警測試資料',
      },
      {
        CAPID: 'NCDR-OUTSIDE-001',
        event: '土石流警戒',
        sent: '2026-09-04T02:00:00+08:00',
        effective: '2026-09-04T02:00:00+08:00',
        expires: '2026-09-04T03:00:00+08:00',
        geometry: { type: 'Point', coordinates: [121.50, 25.00] },
        areaDesc: '新北市',
      },
      {
        CAPID: 'NCDR-EXPIRED-001',
        event: '雨量警戒',
        sent: '2026-09-03T02:00:00+08:00',
        effective: '2026-09-03T02:00:00+08:00',
        expires: '2026-09-03T03:00:00+08:00',
        geometry: { type: 'Point', coordinates: [121.58, 25.08] },
        areaDesc: '臺北市內湖區',
      },
    ],
  };
}

function rawSnapshot(sourceId, endpoint, payload) {
  return makeRawSnapshot({
    sourceId,
    request: { method: 'GET', url: endpoint, query: { format: 'JSON' } },
    responseStatus: 200,
    responseHeaders: { ETag: `"${sourceId}-snapshot-1"`, 'Content-Type': 'application/json' },
    retrievedAt: RETRIEVED_AT,
    payload,
  });
}

test('rejects CWA collection when the API key is missing', async () => {
  await assert.rejects(
    fetchCwaEarthquakes({ apiKey: '', fetchImpl: async () => response() }),
    (error) => error instanceof CwaCredentialError
      && /CWA_API_KEY/u.test(error.message),
  );
});

test('fetches CWA earthquake data and keeps the API key out of Raw', async () => {
  const calls = [];
  const apiKey = 'cwa-api-key-for-test';
  const snapshot = await fetchCwaEarthquakes({
    apiKey,
    endpoint: CWA_EARTHQUAKE_ENDPOINT,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response({
        payload: cwaEarthquakePayload(),
        headers: { ETag: '"cwa-eq-1"' },
      });
    },
    retrievedAt: RETRIEVED_AT,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /format=JSON/u);
  assert.match(calls[0].url, /Authorization=cwa-api-key-for-test/u);
  assert.equal(snapshot.source_id, 'cwa-earthquake');
  assert.equal(snapshot.response.headers.etag, '"cwa-eq-1"');
  assert.equal(snapshot.payload.result.records.length, 2);
  assert.doesNotMatch(JSON.stringify(snapshot), /cwa-api-key-for-test/u);
});

test('normalizes CWA earthquakes, keeps Neihu observations, and excludes outside records', () => {
  const raw = rawSnapshot('cwa-earthquake', CWA_EARTHQUAKE_ENDPOINT, cwaEarthquakePayload());
  const events = normalizeCwaEarthquakes(raw, { boundary: OFFICIAL_NEIHU_BOUNDARY });

  assert.equal(events.length, 1);
  assert.equal(events[0].event_id, 'cwa:earthquake:115001:neihu-001');
  assert.equal(events[0].event_type, 'EARTHQUAKE_INTENSITY');
  assert.deepEqual(events[0].geometry, { type: 'Point', coordinates: [121.58, 25.08] });
  assert.equal(events[0].issued_at, '2026-09-04T04:01:00.000Z');
  assert.equal(events[0].expires_at, '2026-09-05T04:05:00.000Z');
  assert.equal(events[0].attributes.area_id, 'neihu');
  assert.equal(events[0].attributes.theme, 'earthquake');
  assert.equal(events[0].attributes.alert_id, '115001');
  assert.equal(events[0].attributes.affected_area, '臺北市地區');
  assert.equal(events[0].attributes.source_description, '臺北市地區');
  assert.equal(events[0].attributes.original_unit, 'gal');
  assert.equal(events[0].attributes.source_record.StationID, 'NEIHU-001');
});

test('normalizes the CWA earthquake API shape with records grouped under Earthquake', () => {
  const raw = rawSnapshot('cwa-earthquake', CWA_EARTHQUAKE_ENDPOINT, cwaEarthquakeApiPayload());
  const events = normalizeCwaEarthquakes(raw, { boundary: OFFICIAL_NEIHU_BOUNDARY });

  assert.equal(events.length, 1);
  assert.equal(events[0].event_id, 'cwa:earthquake:115001:neihu-001');
});

test('nationwide earthquake keeps the real offshore epicentre instead of all land polygons', () => {
  const payload = cwaEarthquakeApiPayload();
  payload.records.Earthquake = [{ ...payload.records.Earthquake[0],
    StationLatitude: undefined, StationLongitude: undefined,
    EpicenterLatitude: '25.2', EpicenterLongitude: '123.1' }];
  const raw = rawSnapshot('cwa-earthquake', CWA_EARTHQUAKE_ENDPOINT, payload);
  const events = normalizeCwaEarthquakes(raw, { scope: 'taiwan', boundary: TAIWAN_SCOPE });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].geometry, { type: 'Point', coordinates: [123.1, 25.2] });
  assert.equal(events[0].attributes.coverage_level, 'epicentre');
});

test('normalizes CWA city-level warnings as Neihu-applicable events with explicit city coverage', () => {
  const raw = rawSnapshot('cwa-weather-warning', CWA_WARNING_ENDPOINT, cwaWarningPayload());
  const events = normalizeCwaWarnings(raw, { boundary: OFFICIAL_NEIHU_BOUNDARY });

  assert.equal(events.length, 1);
  assert.equal(events[0].event_id, 'cwa:warning:cwa-warning-neihu-001');
  assert.equal(events[0].event_type, 'WEATHER_WARNING');
  assert.equal(events[0].attributes.coverage_level, 'city');
  assert.equal(events[0].attributes.area_id, 'neihu');
  assert.equal(events[0].attributes.theme, 'weather');
  assert.equal(events[0].attributes.alert_id, 'CWA-WARNING-NEIHU-001');
  assert.equal(events[0].attributes.affected_area, '臺北市');
  assert.equal(events[0].attributes.source_description, '臺北市有局部大雨發生的機率。');
  assert.equal(events[0].expires_at, '2026-09-04T01:00:00.000Z');
  assert.deepEqual(events[0].geometry, OFFICIAL_NEIHU_BOUNDARY.features[0].geometry);
});

test('normalizes the CWA warning API shape with records grouped under location', () => {
  const raw = rawSnapshot('cwa-weather-warning', CWA_WARNING_ENDPOINT, cwaWarningApiPayload());
  const events = normalizeCwaWarnings(raw, { boundary: OFFICIAL_NEIHU_BOUNDARY });

  assert.equal(events.length, 1);
  assert.equal(events[0].event_id, 'cwa:warning:w-c0033-001:63000:2026-09-04-03:00:00:0');
  assert.equal(events[0].attributes.affected_area, '臺北市');
  assert.equal(events[0].attributes.source_description, '豪雨');
  assert.equal(events[0].issued_at, '2026-09-03T19:00:00.000Z');
  assert.equal(events[0].expires_at, '2026-09-04T01:00:00.000Z');
  assert.equal(events[0].attributes.source_record.hazard.info.phenomena, '豪雨');
});

test('county wind warnings publish compact reference points within the correct county', () => {
  const square = (left, bottom, right, top) => [[
    [left, bottom], [right, bottom], [right, top], [left, top], [left, bottom],
  ]];
  const catalog = normalizeAreaCatalog({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { COUNTYCODE: '65000', COUNTYNAME: '新北市' },
      geometry: { type: 'Polygon', coordinates: square(121, 24, 122, 25) } },
    { type: 'Feature', properties: { COUNTYCODE: '65000', COUNTYNAME: '新北市', TOWNCODE: '65000010', TOWNNAME: '板橋區' },
      geometry: { type: 'Polygon', coordinates: square(121, 24, 121.2, 24.2) } },
    { type: 'Feature', properties: { COUNTYCODE: '10016', COUNTYNAME: '澎湖縣' },
      geometry: { type: 'MultiPolygon', coordinates: [square(119, 23, 119.8, 23.8), square(120, 23, 120.1, 23.1)] } },
    { type: 'Feature', properties: { COUNTYCODE: '10016', COUNTYNAME: '澎湖縣', TOWNCODE: '10016010', TOWNNAME: '馬公市' },
      geometry: { type: 'Polygon', coordinates: square(119, 23, 119.2, 23.2) } },
  ] });
  const payload = { success: true, result: { resource_id: 'W-C0033-001' }, records: {
    location: ['新北市', '澎湖縣'].map((locationName, index) => ({
      locationName,
      geocode: index === 0 ? 65 : 10016,
      hazardConditions: { hazards: [{ info: { phenomena: '陸上強風' }, validTime: {
        startTime: '2026-10-21 11:00:00', endTime: '2026-10-21 23:00:00',
      } }] },
    })),
  } };
  const events = normalizeCwaWarnings(rawSnapshot('cwa-weather-warning', CWA_WARNING_ENDPOINT, payload), {
    scope: 'taiwan', coverage: 'TW', boundary: areaBoundary(catalog), ...createAreaResolvers(catalog),
  });
  assert.deepEqual(events.map((event) => event.attributes.area_id), ['tw.65000', 'tw.10016']);
  for (const event of events) {
    assert.equal(event.geometry.type, 'Point');
    assert.equal(event.attributes.map_location_kind, 'area_reference');
    assert.equal(event.attributes.coverage_level, 'county');
    assert.equal(isGeometryInBoundary(event.geometry,
      catalog.areas.find((area) => area.area_id === event.attributes.area_id).geometry), true);
  }
  assert.deepEqual(events.map((event) => event.attributes.affected_area), ['新北市', '澎湖縣']);
});

test('normalizes the official CWA typhoon records.info shape as one nationwide warning', () => {
  const raw = rawSnapshot('cwa-typhoon-warning', 'https://opendata.cwa.gov.tw/api/v1/rest/datastore/W-C0034-001', {
    success: true,
    result: { resource_id: 'W-C0034-001' },
    records: {
      info: [{
        language: 'zh-TW',
        category: 'Met',
        event: '颱風警報',
        urgency: 'Immediate',
        severity: 'Severe',
        certainty: 'Observed',
        effective: RETRIEVED_AT,
        expires: '2026-09-05T04:00:00Z',
        headline: '颱風警報測試',
        description: { section: [{ title: '概況', value: '測試' }] },
        area: [
          { areaDesc: '臺北市', geocode: { valueName: 'TWD97', value: '63000' } },
          { areaDesc: '花蓮縣', geocode: { valueName: 'TWD97', value: '10015' } },
        ],
      }],
    },
  });
  const events = normalizeCwaTyphoonWarnings(raw, {
    boundary: TAIWAN_SCOPE,
    scope: 'taiwan',
    coverage: 'TW',
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'TYPHOON_WARNING');
  assert.equal(events[0].attributes.theme, 'typhoon');
  assert.equal(events[0].attributes.coverage_level, 'nationwide');
  assert.equal(events[0].attributes.area_id, 'tw');
  assert.equal(events[0].geometry.type, 'MultiPolygon');
  assert.equal(events[0].attributes.affected_area, '臺北市、花蓮縣');
  assert.equal(events[0].attributes.source_description, '颱風警報測試');
});

test('rejects a CWA warning with malformed time or an invalid source id', () => {
  const malformed = rawSnapshot('cwa-weather-warning', CWA_WARNING_ENDPOINT, {
    result: { records: [{ ...cwaWarningPayload().result.records[0], EndTime: 'not-a-time' }] },
  });
  assert.throws(
    () => normalizeCwaWarnings(malformed, { boundary: OFFICIAL_NEIHU_BOUNDARY }),
    (error) => error instanceof CwaSourceError && /TIME/u.test(error.code),
  );

  const invalidSource = rawSnapshot('wrong-source', CWA_WARNING_ENDPOINT, cwaWarningPayload());
  assert.throws(
    () => normalizeCwaWarnings(invalidSource, { boundary: OFFICIAL_NEIHU_BOUNDARY }),
    (error) => error instanceof CwaSourceError && /SOURCE_ID/u.test(error.code),
  );
});

test('rejects CWA records without stable identity or usable geometry', () => {
  const raw = rawSnapshot('cwa-earthquake', CWA_EARTHQUAKE_ENDPOINT, {
    result: {
      records: [{
        IssueTime: '2026-09-04T12:05:00+08:00',
        EndTime: '2026-09-05T12:05:00+08:00',
        CountyName: '臺北市',
      }],
    },
  });
  assert.throws(
    () => normalizeCwaEarthquakes(raw, { boundary: OFFICIAL_NEIHU_BOUNDARY }),
    (error) => error instanceof CwaSourceError && /ID/u.test(error.code),
  );
});

test('rejects NCDR collection when the token is missing', async () => {
  await assert.rejects(
    fetchNcdrHazards({ credentials: {}, fetchImpl: async () => response() }),
    (error) => error instanceof NcdrCredentialError
      && /NCDR_API_KEY/u.test(error.message),
  );
});

test('fetches NCDR data with a token header and keeps the token out of Raw', async () => {
  const calls = [];
  const token = 'ncdr-token-for-test';
  const snapshot = await fetchNcdrHazards({
    credentials: { apiKey: token },
    endpoint: NCDR_ENDPOINT,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response({ payload: ncdrPayload(), headers: { ETag: '"ncdr-1"' } });
    },
    retrievedAt: RETRIEVED_AT,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.Token, token);
  assert.equal(snapshot.source_id, 'ncdr-hazard-events');
  assert.equal(snapshot.response.headers.etag, '"ncdr-1"');
  assert.doesNotMatch(JSON.stringify(snapshot), /ncdr-token-for-test/u);
});

test('does not retain the NCDR query key in request errors', async () => {
  const key = 'real-alert-key-for-error-test';
  await assert.rejects(
    fetchNcdrHazards({
      credentials: { apiKey: key },
      endpoint: NCDR_ENDPOINT,
      authMode: 'query',
      fetchImpl: async () => response({ status: 401, payload: { error: 'unauthorized' } }),
      retrievedAt: RETRIEVED_AT,
    }),
    (error) => !JSON.stringify({
      message: error.message,
      cause: error.cause,
      cause_url: error.cause?.url,
    }).includes(key),
  );
});

test('fetches the official NCDR index and then dumps each CAP detail', async () => {
  const calls = [];
  const key = 'real-alert-key-for-test';
  const detail = {
    identifier: 'CAP-HUALIEN-001',
    sender: 'ncdr@example.test',
    sent: RETRIEVED_AT,
    status: 'Actual',
    msgType: 'Alert',
    scope: 'Public',
    info: {
      language: 'zh-TW',
      event: '土石流警戒',
      urgency: 'Immediate',
      severity: 'Severe',
      effective: RETRIEVED_AT,
      expires: NCDR_EXPIRES_AT,
      description: '花蓮縣土石流警戒',
      area: {
        areaDesc: '花蓮縣花蓮市',
        polygon: '24.0000,121.6000 24.0000,121.6200 24.0200,121.6200 24.0200,121.6000 24.0000,121.6000',
      },
    },
  };
  const snapshot = await fetchNcdrHazards({
    credentials: { apiKey: key },
    endpoint: NCDR_ENDPOINT,
    authMode: 'query',
    detailConcurrency: 1,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const parsed = new URL(url);
      if (parsed.pathname === '/api/datastore') {
        return response({
          payload: {
            success: true,
            result: [{
              capid: 'CAP-HUALIEN-001',
              capCode: 'HUALIEN-LANDSLIDE',
              effective: RETRIEVED_AT,
              expires: NCDR_EXPIRES_AT,
              description: '花蓮縣土石流警戒',
            }],
          },
        });
      }
      assert.equal(parsed.pathname, '/api/dump/datastore');
      assert.equal(parsed.searchParams.get('capid'), 'CAP-HUALIEN-001');
      return response({ payload: detail });
    },
    retrievedAt: RETRIEVED_AT,
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/api\/datastore\?[^#]*apikey=real-alert-key-for-test/u);
  assert.match(calls[1].url, /\/api\/dump\/datastore\?[^#]*apikey=real-alert-key-for-test/u);
  assert.equal(snapshot.payload.index.result.length, 1);
  assert.equal(snapshot.payload.details.length, 1);
  assert.deepEqual(snapshot.payload.details[0].payload, detail);
  assert.equal(snapshot.payload.partial, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /real-alert-key-for-test/u);
});

test('normalizes the official nested NCDR CAP detail shape nationwide', async () => {
  const snapshot = await fetchNcdrHazards({
    credentials: { apiKey: 'real-alert-key-for-test' },
    endpoint: NCDR_ENDPOINT,
    authMode: 'query',
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/datastore') {
        return response({
          payload: {
            success: true,
            result: [{ capid: 'CAP-HUALIEN-001' }],
          },
        });
      }
      assert.equal(parsed.pathname, NCDR_DETAIL_ENDPOINT.replace('https://alerts.ncdr.nat.gov.tw', ''));
      return response({
        payload: {
          identifier: 'CAP-HUALIEN-001',
          sender: 'ncdr@example.test',
          sent: RETRIEVED_AT,
          status: 'Actual',
          msgType: 'Alert',
          scope: 'Public',
          references: 'ncdr@example.test,CAP-HUALIEN-000,1',
          info: {
            language: 'zh-TW',
            event: '土石流警戒',
            urgency: 'Immediate',
            severity: 'Severe',
            effective: RETRIEVED_AT,
            expires: NCDR_EXPIRES_AT,
            description: '花蓮縣土石流警戒',
            area: {
              areaDesc: '花蓮縣花蓮市',
              polygon: '24.0000,121.6000 24.0000,121.6200 24.0200,121.6200 24.0200,121.6000 24.0000,121.6000',
            },
          },
        },
      });
    },
    retrievedAt: RETRIEVED_AT,
  });
  const events = normalizeNcdrHazards(snapshot, {
    boundary: {
      type: 'Polygon',
      coordinates: [[[121.55, 23.90], [121.70, 23.90], [121.70, 24.10], [121.55, 24.10], [121.55, 23.90]]],
    },
    scope: 'taiwan',
    coverage: 'TW',
    areaId: 'tw',
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].event_id, 'ncdr:cap-hualien-001');
  assert.equal(events[0].event_type, 'DEBRIS_FLOW_WARNING');
  assert.equal(events[0].severity, 'HIGH');
  assert.equal(events[0].attributes.affected_area, '花蓮縣花蓮市');
  assert.equal(events[0].attributes.source_description, '花蓮縣土石流警戒');
  assert.equal(events[0].geometry.type, 'Polygon');
  assert.equal(events[0].attributes.source_record.identifier, 'CAP-HUALIEN-001');
});

test('normalizes CAP circles and category-specific NCDR events', () => {
  const raw = rawSnapshot('ncdr-hazard-events', NCDR_ENDPOINT, {
    details: [{
      capid: 'CAP-TAICHUNG-FIRE-001',
      payload: {
        identifier: 'CAP-TAICHUNG-FIRE-001',
        sent: RETRIEVED_AT,
        info: [{
          language: 'zh-TW',
          category: 'Fire',
          event: '火災',
          effective: RETRIEVED_AT,
          expires: NCDR_EXPIRES_AT,
          severity: 'Severe',
          description: '臺中市火災警示',
          area: [{
            areaDesc: '臺中市東區',
            circle: '24.136099938432526,120.68659989934919 0.5',
          }],
        }],
      },
    }],
    partial: false,
  });
  const events = normalizeNcdrHazards(raw, {
    boundary: {
      type: 'Polygon',
      coordinates: [[[120.60, 24.05], [120.80, 24.05], [120.80, 24.25], [120.60, 24.25], [120.60, 24.05]]],
    },
    scope: 'taiwan',
    coverage: 'TW',
    areaId: 'tw',
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'FIRE_WARNING');
  assert.equal(events[0].geometry.type, 'Point');
  assert.deepEqual(events[0].geometry.coordinates, [120.68659989934919, 24.136099938432526]);
  assert.equal(events[0].attributes.affected_area, '臺中市東區');
});

test('keeps fire-safety inspections and marine fire descriptions out of the fire category', () => {
  const raw = rawSnapshot('ncdr-hazard-events', NCDR_ENDPOINT, {
    details: [
      {
        capid: 'NFA-FIRE-INSPECTION-001',
        payload: {
          identifier: 'NFA-FIRE-INSPECTION-001',
          sent: RETRIEVED_AT,
          info: [{
            language: 'zh-TW',
            category: 'Other',
            event: '消防安全檢查重大不合格場所',
            eventCode: { valueName: 'profile:CAP-TWP:Event:1.0', value: 'Dangerfield' },
            effective: RETRIEVED_AT,
            expires: NCDR_EXPIRES_AT,
            severity: 'Severe',
            description: '新北市消防安全設備不合格',
            area: [{ areaDesc: '新北市', circle: '25.0,121.5 1' }],
          }],
        },
      },
      {
        capid: 'OCA-MARINE-FIRE-001',
        payload: {
          identifier: 'OCA-MARINE-FIRE-001',
          sent: RETRIEVED_AT,
          info: [{
            language: 'zh-TW',
            category: 'Env',
            event: '海洋污染',
            eventCode: { valueName: 'profile:CAP-TWP:Event:1.0', value: 'marinePollution' },
            effective: RETRIEVED_AT,
            expires: NCDR_EXPIRES_AT,
            severity: 'Minor',
            description: '旗津區中州漁港漁船火災',
            area: [{ areaDesc: '高雄市', circle: '22.6,120.3 0.5' }],
          }],
        },
      },
    ],
    partial: false,
  });
  const events = normalizeNcdrHazards(raw, {
    boundary: {
      type: 'Polygon',
      coordinates: [[[119.0, 21.0], [123.0, 21.0], [123.0, 26.0], [119.0, 26.0], [119.0, 21.0]]],
    },
    scope: 'taiwan',
    coverage: 'TW',
    areaId: 'tw',
  });

  assert.equal(events.find((event) => event.event_id.endsWith('nfa-fire-inspection-001'))
    .attributes.ncdr_category_label, '其他 NCDR 事件');
  assert.equal(events.find((event) => event.event_id.endsWith('oca-marine-fire-001'))
    .attributes.ncdr_category_label, '其他 NCDR 事件');
});

test('normalizes NCDR CAP polygons, excludes outside hazards, and retains expired events', () => {
  const raw = rawSnapshot('ncdr-hazard-events', NCDR_ENDPOINT, ncdrPayload());
  const events = normalizeNcdrHazards(raw, { boundary: OFFICIAL_NEIHU_BOUNDARY });

  assert.equal(events.length, 2);
  assert.equal(events[0].event_id, 'ncdr:ncdr-neihu-flood-001');
  assert.equal(events[0].event_type, 'FLOOD_WARNING');
  assert.equal(events[0].geometry.type, 'Polygon');
  assert.equal(events[0].attributes.area_id, 'neihu');
  assert.equal(events[0].attributes.theme, 'flood');
  assert.equal(events[1].event_id, 'ncdr:ncdr-expired-001');
  assert.equal(events[1].expires_at, '2026-09-02T19:00:00.000Z');
});

test('classifies NCDR events by operational relevance instead of severity alone', () => {
  assert.equal(
    classifyNcdrOperationalRelevance({
      eventType: 'SAFETY_ALERT',
      description: '消防安全設備不合格',
    }),
    'BACKGROUND',
  );
  assert.equal(
    classifyNcdrOperationalRelevance({
      eventType: 'NCDR_HAZARD',
      description: '疏散避難，請勿進入警戒區',
    }),
    'EVACUATION',
  );
  assert.equal(
    classifyNcdrOperationalRelevance({
      eventType: 'SAFETY_ALERT',
      description: '道路封閉，請改道通行',
    }),
    'ROUTE_CHANGE',
  );
  assert.equal(
    classifyNcdrOperationalRelevance({
      eventType: 'RESERVOIR_RELEASE_WARNING',
      description: '水庫放流警戒',
    }),
    'HIGH_IMPACT',
  );
});

test('rejects an NCDR hazard with missing geometry and preserves explicit source errors', () => {
  const raw = rawSnapshot('ncdr-hazard-events', NCDR_ENDPOINT, {
    data: [{
      CAPID: 'NCDR-NO-GEOMETRY-001',
      event: '淹水警戒',
      sent: '2026-09-04T02:00:00+08:00',
      expires: '2026-09-04T03:00:00+08:00',
      areaDesc: '臺東縣',
    }],
  });
  assert.throws(
    () => normalizeNcdrHazards(raw, { boundary: OFFICIAL_NEIHU_BOUNDARY }),
    (error) => error instanceof NcdrSourceError && /GEOMETRY/u.test(error.code),
  );
});
