import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_TDX_CITY_CODES,
  DEFAULT_TDX_NATIONWIDE_ENDPOINTS,
  TdxCredentialError,
  TdxSourceError,
  collectTdxRoadEvents,
  fetchTdxRoadEvents,
  normalizeTdxRoadEvents,
} from '../sources/tdx.mjs';
import { makeRawSnapshot } from '../lib/source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OFFICIAL_NEIHU_BOUNDARY = JSON.parse(readFileSync(
  path.join(ROOT, 'pipeline/sources/boundaries/taipei-neihu.geojson'),
  'utf8',
));

const ENDPOINT = 'https://tdx.transportdata.tw/api/basic/v1/Traffic/RoadEvent/LiveEvent/City/Taipei?$format=JSON';
const RETRIEVED_AT = '2026-09-04T00:05:00Z';
const UPDATE_TIME = '2026-09-04T00:00:00Z';

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

function tdxPayload() {
  return {
    UpdateTime: UPDATE_TIME,
    UpdateInterval: 60,
    Events: [
      {
        EventID: 'TDX-NEIHU-001',
        EventType: 'Accident',
        Description: '瑞光路交通事故',
        StartTime: UPDATE_TIME,
        EndTime: '2026-09-04T02:00:00Z',
        Severity: 'High',
        Location: {
          Address: { City: '臺北市', Town: '內湖區' },
          Position: { PositionLat: 25.08, PositionLon: 121.58 },
          CityRoad: { Roadways: [{ Town: '內湖區', RoadName: '瑞光路' }] },
        },
        ExtraSourceField: 'must be preserved',
      },
      {
        EventID: 'TDX-OUTSIDE-001',
        EventType: 'Construction',
        Description: '南港區施工',
        StartTime: UPDATE_TIME,
        EndTime: '2026-09-04T02:00:00Z',
        Location: {
          Address: { City: '臺北市', Town: '南港區' },
          Position: { PositionLat: 25.08, PositionLon: 121.54 },
        },
      },
    ],
  };
}

function rawSnapshot(payload = tdxPayload()) {
  return makeRawSnapshot({
    sourceId: 'tdx-road-events',
    request: { method: 'GET', url: ENDPOINT, query: { $format: 'JSON' } },
    responseStatus: 200,
    responseHeaders: { ETag: '"tdx-batch-1"', 'Content-Type': 'application/json' },
    retrievedAt: RETRIEVED_AT,
    payload,
  });
}

test('rejects TDX collection when client credentials are missing', async () => {
  await assert.rejects(
    fetchTdxRoadEvents({ clientId: '', clientSecret: '', fetchImpl: async () => response() }),
    (error) => error instanceof TdxCredentialError
      && /TDX_CLIENT_ID/u.test(error.message)
      && /TDX_CLIENT_SECRET/u.test(error.message),
  );
});

test('fetches a TDX token and stores only safe Raw snapshot metadata', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/auth/realms/TDXConnect/')) {
      return response({ payload: { access_token: 'access-token-for-test', expires_in: 3600 } });
    }
    return response({
      headers: { ETag: '"tdx-batch-1"', 'Content-Type': 'application/json', Authorization: 'secret' },
      payload: tdxPayload(),
    });
  };

  const snapshot = await fetchTdxRoadEvents({
    clientId: 'client-id-for-test',
    clientSecret: 'client-secret-for-test',
    endpoint: ENDPOINT,
    fetchImpl,
    retrievedAt: RETRIEVED_AT,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, 'POST');
  assert.match(String(calls[0].init.body), /client_secret=client-secret-for-test/u);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer access-token-for-test');
  assert.equal(snapshot.schema_version, 'raw-snapshot-v0');
  assert.equal(snapshot.source_id, 'tdx-road-events');
  assert.equal(snapshot.response.headers.etag, '"tdx-batch-1"');
  assert.equal(snapshot.payload.Events.length, 2);
  assert.doesNotMatch(JSON.stringify(snapshot), /client-secret-for-test/u);
  assert.doesNotMatch(JSON.stringify(snapshot), /access-token-for-test/u);
});

test('fetches multiple TDX city endpoints for Taiwan scope and retains endpoint provenance', async () => {
  const endpoints = [
    'https://tdx.test/City/Taipei?$format=JSON',
    'https://tdx.test/City/Hualien?$format=JSON',
  ];
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/auth/realms/TDXConnect/')) {
      return response({ payload: { access_token: 'access-token-for-test' } });
    }
    const city = url.includes('Hualien') ? 'Hualien' : 'Taipei';
    return response({
      headers: { ETag: `"${city.toLowerCase()}-1"` },
      payload: { UpdateTime: UPDATE_TIME, Events: [{ EventID: `TDX-${city}-001` }] },
    });
  };

  const snapshot = await fetchTdxRoadEvents({
    clientId: 'client-id-for-test',
    clientSecret: 'client-secret-for-test',
    endpoints,
    scope: 'taiwan',
    endpointDelayMs: 0,
    fetchImpl,
    retrievedAt: RETRIEVED_AT,
  });

  assert.deepEqual(calls, [
    'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token',
    ...endpoints,
  ]);
  assert.equal(snapshot.payload.Events.length, 2);
  assert.deepEqual(snapshot.payload.sources.map((source) => source.endpoint), endpoints);
  assert.deepEqual(DEFAULT_TDX_NATIONWIDE_ENDPOINTS.length > 10, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /access-token-for-test/u);
});

test('uses only the currently accepted TDX RoadEvent city codes by default', () => {
  assert.deepEqual(DEFAULT_TDX_CITY_CODES, [
    'Taipei', 'NewTaipei', 'Taoyuan', 'Taichung', 'Tainan', 'Kaohsiung',
    'Keelung', 'MiaoliCounty', 'ChiayiCounty', 'PingtungCounty', 'YilanCounty', 'KinmenCounty',
  ]);
});

test('paces sequential TDX endpoint requests', async () => {
  const endpoints = [
    'https://tdx.test/City/Taipei?$format=JSON',
    'https://tdx.test/City/Kaohsiung?$format=JSON',
  ];
  const delays = [];
  const calls = [];
  const snapshot = await fetchTdxRoadEvents({
    clientId: 'client-id-for-test',
    clientSecret: 'client-secret-for-test',
    endpoints,
    scope: 'taiwan',
    endpointDelayMs: 1250,
    sleepImpl: async (milliseconds) => delays.push(milliseconds),
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes('/auth/realms/TDXConnect/')) return response({ payload: { access_token: 'access-token-for-test' } });
      return response({ payload: { UpdateTime: UPDATE_TIME, Events: [] } });
    },
    retrievedAt: RETRIEVED_AT,
  });

  assert.equal(snapshot.payload.sources.length, 2);
  assert.deepEqual(calls.slice(1), endpoints);
  assert.deepEqual(delays, [1250]);
});

test('keeps successful Taiwan endpoints when one TDX city endpoint is unavailable', async () => {
  const endpoints = [
    'https://tdx.test/City/Taipei?$format=JSON',
    'https://tdx.test/City/HualienCounty?$format=JSON',
  ];
  const snapshot = await fetchTdxRoadEvents({
    clientId: 'client-id-for-test',
    clientSecret: 'client-secret-for-test',
    endpoints,
    scope: 'taiwan',
    endpointDelayMs: 0,
    fetchImpl: async (url) => {
      if (url.includes('/auth/realms/TDXConnect/')) return response({ payload: { access_token: 'access-token-for-test' } });
      if (url.includes('HualienCounty')) return {
        status: 401,
        headers: new Headers(),
        async json() { return {}; },
      };
      return response({ payload: tdxPayload() });
    },
    retrievedAt: RETRIEVED_AT,
  });

  assert.equal(snapshot.payload.partial, true);
  assert.equal(snapshot.payload.Events.length, 2);
  assert.equal(snapshot.payload.sources[1].status, 401);
  assert.equal(snapshot.payload.sources[1].error_code, 'HTTP_ERROR');
  assert.doesNotMatch(JSON.stringify(snapshot), /access-token-for-test/u);
});

test('normalizes TDX events, preserves Raw outside Neihu, and keeps unmapped fields', () => {
  const raw = rawSnapshot();
  const events = normalizeTdxRoadEvents(raw, {
    namespace: 'official.tdx',
    signingKeyId: 'tdx-test-key-2026',
    boundary: OFFICIAL_NEIHU_BOUNDARY,
    receivedAt: RETRIEVED_AT,
  });

  assert.equal(raw.payload.Events.length, 2);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    schema_version: 'event-v0',
    namespace: 'official.tdx',
    event_id: 'tdx:tdx-neihu-001',
    event_type: 'ROAD_ACCIDENT',
    geometry: { type: 'Point', coordinates: [121.58, 25.08] },
    severity: 'HIGH',
    source: 'TDX',
    source_version: UPDATE_TIME,
    event_version: 1,
    issued_at: UPDATE_TIME,
    expires_at: '2026-09-04T02:00:00Z',
    attributes: {
      source_record: raw.payload.Events[0],
    },
    signature_algorithm: 'Ed25519',
    signing_key_id: 'tdx-test-key-2026',
    provenance: {
      original_source: raw.request.url,
      received_at: RETRIEVED_AT,
      transport_source: { kind: 'server', node_id: 'tdx-collector' },
    },
  });
});

test('collects the complete Raw snapshot and curated Neihu events together', async () => {
  const result = await collectTdxRoadEvents({
    clientId: 'client-id-for-test',
    clientSecret: 'client-secret-for-test',
    endpoint: ENDPOINT,
    fetchImpl: async (url) => url.includes('/auth/realms/TDXConnect/')
      ? response({ payload: { access_token: 'access-token-for-test' } })
      : response({ payload: tdxPayload() }),
    retrievedAt: RETRIEVED_AT,
    boundary: OFFICIAL_NEIHU_BOUNDARY,
  });

  assert.equal(result.rawSnapshot.payload.Events.length, 2);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].event_id, 'tdx:tdx-neihu-001');
});

test('normalizes the checked-in Neihu TDX fixture without credentials', () => {
  const raw = JSON.parse(readFileSync(
    path.join(ROOT, 'data/fixtures/neihu/tdx-raw-batch-1.json'),
    'utf8',
  ));
  const events = normalizeTdxRoadEvents(raw, { boundary: OFFICIAL_NEIHU_BOUNDARY });

  assert.equal(raw.fixture_metadata.mode, 'local_fixture');
  assert.equal(raw.payload.Events.length, 2);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_id, 'tdx:tdx-neihu-001');
  assert.equal(events[0].attributes.source_record.ExtraSourceField, 'preserve-me');
});

test('adapts official compact TDX fields and WKT representative positions', () => {
  const raw = rawSnapshot({
    UpdateTime: UPDATE_TIME,
    Events: [{
      EventID: 'TDX-NEIHU-WKT-001',
      EventType: 1,
      EffectiveTime: UPDATE_TIME,
      ExpireTime: '2026-09-04T02:00:00Z',
      Positions: 'POINT (121.58 25.08)',
      Location: { Address: { City: '臺北市', Town: '內湖區' } },
    }],
  });
  const events = normalizeTdxRoadEvents(raw, { boundary: OFFICIAL_NEIHU_BOUNDARY });

  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'ROAD_ACCIDENT');
  assert.deepEqual(events[0].geometry, { type: 'Point', coordinates: [121.58, 25.08] });
  assert.equal(events[0].issued_at, UPDATE_TIME);
  assert.equal(events[0].expires_at, '2026-09-04T02:00:00Z');
});

test('adapts the live TDX envelope and derives freshness expiry from UpdateInterval', () => {
  const raw = rawSnapshot({
    UpdateTime: '2026-09-04T00:00:00Z',
    UpdateInterval: 60,
    LiveEvents: [{
      EventID: 'TDX-NEIHU-LIVE-001',
      EventType: 1,
      EffectiveTime: '2026-09-03T23:59:00Z',
      LastUpdateTime: '2026-09-04T00:00:00Z',
      Positions: 'POINT (121.58 25.08)',
      Location: { Other: '內湖區瑞光路' },
    }],
  });
  const events = normalizeTdxRoadEvents(raw, { boundary: OFFICIAL_NEIHU_BOUNDARY });

  assert.equal(events.length, 1);
  assert.equal(events[0].source_version, '2026-09-04T00:00:00Z');
  assert.equal(events[0].issued_at, '2026-09-03T23:59:00Z');
  assert.equal(events[0].expires_at, '2026-09-04T00:01:00.000Z');
});

test('derives a marked source freshness TTL when a live TDX event has no end time', () => {
  const raw = rawSnapshot({
    UpdateTime: '2026-09-04T00:00:00Z',
    Events: [{
      EventID: 'TDX-NEIHU-LIVE-NO-END-001',
      EventType: 2,
      EffectiveTime: '2026-09-03T23:59:00Z',
      LastUpdateTime: '2026-09-04T00:00:00Z',
      Positions: 'POINT (121.58 25.08)',
      Location: { Other: '內湖區瑞光路' },
    }],
  });
  const events = normalizeTdxRoadEvents(raw, {
    boundary: OFFICIAL_NEIHU_BOUNDARY,
    freshnessSeconds: 900,
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].expires_at, '2026-09-04T00:15:00.000Z');
  assert.equal(events[0].attributes.expiry_source, 'source_freshness_ttl');
  assert.equal(events[0].attributes.freshness_ttl_seconds, 900);
});

test('keeps nationwide TDX collection running when one event has unresolved geometry', () => {
  const raw = rawSnapshot({
    UpdateTime: '2026-09-04T00:00:00Z',
    Events: [
      {
        EventID: 'TDX-NEIHU-LIVE-VALID-001',
        EventType: 2,
        EffectiveTime: '2026-09-03T23:59:00Z',
        Positions: 'POINT (121.58 25.08)',
        Location: { Other: '臺北市-內湖區' },
      },
      {
        EventID: 'TDX-TAICHUNG-LIVE-NO-GEOMETRY-001',
        EventType: 3,
        EffectiveTime: '2026-09-03T23:59:00Z',
        Positions: 'POINT ( )',
        Location: { Other: '臺中市-豐原區' },
      },
    ],
  });
  const events = normalizeTdxRoadEvents(raw, {
    boundary: OFFICIAL_NEIHU_BOUNDARY,
    scope: 'taiwan',
    allowUnresolved: true,
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].event_id, 'tdx:tdx-neihu-live-valid-001');
});

test('rejects TDX records without stable identity, geometry, or valid source time', () => {
  const base = tdxPayload().Events[0];
  const cases = [
    { name: 'stable identity', record: { ...base, EventID: undefined } },
    { name: 'geometry', record: { ...base, Location: { Address: { Town: '內湖區' } } } },
    { name: 'source start time', record: { ...base, StartTime: undefined } },
    { name: 'source start time', record: { ...base, StartTime: '2026/09/04 08:00:00' } },
  ];

  for (const item of cases) {
    assert.throws(
      () => normalizeTdxRoadEvents(rawSnapshot({ ...tdxPayload(), Events: [item.record] }), {
        boundary: OFFICIAL_NEIHU_BOUNDARY,
      }),
      (error) => error instanceof TdxSourceError && new RegExp(item.name, 'u').test(error.message),
    );
  }
});
