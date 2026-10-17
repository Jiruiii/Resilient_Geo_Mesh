# 04 Web 送出與 Dart 共用模型

> 總覽與 Global Constraints：[README.md](README.md)。Web 用 WebCrypto Ed25519 產生與 Android 同格式的已簽章事件，存入 IndexedDB outbox，再送到 03 的 API。Dart 端定義兩平台共用的求救模型與 `RescueService` 介面，Android 實作走 MethodChannel（02 Task 8），Web 實作走 `dart:js_interop`。

| 檔案 | 責任 |
|---|---|
| `flutter/web/rescue_outbox.js`（新） | 金鑰、建構與簽章、驗章、IndexedDB outbox、上傳、附近查詢 |
| `flutter/web/index.html`（改） | 在 `nlsc_static_layers.js` 之後載入 `rescue_outbox.js` |
| `flutter/lib/data/rescue_request_models.dart`（新） | 共用列舉、草稿、urgency 推導、事件檢視、送出狀態 |
| `flutter/lib/data/rescue_service.dart`（新） | `RescueService` 介面、Android 實作、錯誤型別 |
| `flutter/lib/data/rescue_web.dart`、`rescue_web_stub.dart`、`rescue_web_web.dart`（新） | Web 實作（conditional import） |
| `flutter/lib/data/map_bridge.dart`（改） | 三個 rescue 方法 |

---

### Task 15: `rescue_outbox.js`

**Files:**
- Create: `flutter/web/rescue_outbox.js`
- Modify: `flutter/web/index.html:20-21`
- Test: `pipeline/test/rescue-outbox-web.test.mjs`

**Interfaces:**
- Consumes: `global.ResilientGeoNLSCStatic.canonicalize(value): string`、`global.ResilientGeoNLSCStatic.sha256(string): Promise<'sha256:<hex>'>`（`nlsc_static_layers.js`）；03 的 API；01 的錯誤代碼
- Produces（全域函式，全部回傳 `Promise<string>`，**永不 reject**；字串是 JSON 信封 `{ "ok": true, "value": ... }` 或 `{ "ok": false, "error": "<code>" }`，讓 Dart 不必跨語言捕捉 JS 例外）：

| 函式 | 參數 | 成功時的 `value` |
|---|---|---|
| `rescueCapabilities()` | 無 | `{ signing: bool, verifying: bool, storage: bool }` |
| `rescueSubmit(argsJson)` | 表單 map（同 02 Task 8）JSON | session |
| `rescueRevise(eventId, action, argsJson)` | action 為 `UPDATE`/`EXTEND`/`RESOLVE`/`CANCEL`；`argsJson` 只在 UPDATE 時為表單，否則 `''` | session |
| `rescueOwnSessions()` | 無 | `[session]` |
| `rescueFlush()` | 無 | `[session]` |
| `rescueNearby(bboxJson)` | `[minLon, minLat, maxLon, maxLat]` | `{ events: [event + apply_state] }` |

session：`{ request: <event + apply_state 'UNVERIFIED'|'EXPIRED'>, delivery_state: 'WAITING_UPLOAD'|'UPLOADING'|'ACCEPTED'|'REJECTED', reason: string|null }`

上傳與下載的單位是 crowd-rescue chunk（03 Task 12）：送出時瀏覽器用同一把裝置金鑰把事件包成 chunk，outbox 同時保存事件與 chunk；`rescueNearby` 從回應的 `chunks` 取出事件逐一驗章。

`error` 代碼：`signing_unsupported`、`storage_unavailable`、`server_unavailable`、`rescue_active_exists`、`rescue_not_found`、`rate_limited:<秒>`、01 的欄位與修訂代碼。

測試用：`global.ResilientGeoRescue = { deriveUrgency, fieldErrors, eventErrors, transitionErrors, verifyEvent(event, nowMs), buildRequest(input, { issuedAt, requestUuid, keyPair }), buildRevision(previous, { action, input, issuedAt, keyPair }), buildChunk(event, privateKey), inputFromEvent(event), inputFromArguments(args) }`

- [ ] **Step 1: 寫失敗的測試**

`pipeline/test/rescue-outbox-web.test.mjs`：

```js
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const staticScript = await readFile(path.join(ROOT, 'flutter/web/nlsc_static_layers.js'), 'utf8');
const rescueScript = await readFile(path.join(ROOT, 'flutter/web/rescue_outbox.js'), 'utf8').catch(() => '');
const fixture = JSON.parse(await readFile(path.join(ROOT, 'fixtures/rescue-requests-v0.json'), 'utf8'));
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const eventCase = (name) => fixture.event_cases.find((entry) => entry.name === name).event;

/** IndexedDB stand-in that keeps values by reference so CryptoKey objects survive. */
function memoryIndexedDB() {
  const databases = new Map();
  const later = (request, value) => {
    request.result = value;
    queueMicrotask(() => request.onsuccess?.());
    return request;
  };
  return {
    open(name) {
      const request = {};
      queueMicrotask(() => {
        let database = databases.get(name);
        const isNew = !database;
        if (isNew) {
          const stores = new Map();
          database = {
            stores,
            objectStoreNames: { contains: (store) => stores.has(store) },
            createObjectStore(store) { stores.set(store, new Map()); },
            transaction(store) {
              const map = stores.get(store);
              const transaction = {};
              transaction.objectStore = () => ({
                get: (key) => later({}, map.get(key)),
                getAll: () => later({}, [...map.values()]),
                put(value, key) {
                  map.set(key, value);
                  queueMicrotask(() => transaction.oncomplete?.());
                  return {};
                },
              });
              return transaction;
            },
            close() {},
          };
          databases.set(name, database);
        }
        request.result = database;
        if (isNew) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

function browser({ indexedDB = memoryIndexedDB(), fetch = async () => { throw new TypeError('offline'); }, now = () => Date.parse(fixture.now), crypto = webcrypto } = {}) {
  class BrowserDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now()])); }
    static now() { return now(); }
  }
  const context = vm.createContext({
    crypto, TextEncoder, URL, Date: BrowserDate, console, indexedDB, fetch,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    location: { origin: 'https://map.example.test' },
    globalThis: undefined,
  });
  vm.runInContext('globalThis = globalThis ?? this', context);
  vm.runInContext(staticScript, context);
  vm.runInContext(rescueScript, context);
  return context;
}

async function fixtureKeyPair(label) {
  const seed = Buffer.alloc(32);
  Buffer.from(label, 'utf8').copy(seed);
  const pkcs8 = Buffer.concat([PKCS8_PREFIX, seed]);
  const spki = createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' });
  return {
    privateKey: await webcrypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']),
    publicKey: await webcrypto.subtle.importKey('spki', spki, { name: 'Ed25519' }, true, ['verify']),
  };
}

/** Calls an exported function and unwraps its `{ ok, value | error }` envelope. */
async function call(context, name, ...args) {
  const envelope = JSON.parse(await context[name](...args));
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.value;
}

const form = {
  request_type: 'TRAPPED_DEBRIS',
  subject: 'SELF',
  people_count: 1,
  triage: { immobile: 'YES', breathing_difficulty: 'NO', severe_bleeding: 'NO', conscious: 'YES' },
  description: 'web test',
  location: { lon: 121.5761, lat: 25.0795, source: 'CURRENT_LOCATION' },
};

test('the web script installs its API', () => {
  const context = browser();
  for (const name of ['rescueCapabilities', 'rescueSubmit', 'rescueRevise', 'rescueOwnSessions', 'rescueFlush', 'rescueNearby']) {
    assert.equal(typeof context[name], 'function', name);
  }
  assert.equal(typeof context.ResilientGeoRescue?.verifyEvent, 'function');
});

test('every fixture event case verifies the same way as JS', async () => {
  const context = browser();
  for (const entry of fixture.event_cases) {
    const result = await context.ResilientGeoRescue.verifyEvent(structuredClone(entry.event), Date.parse(fixture.now));
    assert.equal(result.valid, entry.expect.valid, `${entry.name}: ${JSON.stringify(result)}`);
    if (!entry.expect.valid) {
      assert.equal(result.stage, entry.expect.stage, entry.name);
      if (entry.expect.error) assert.equal(result.errors[0], entry.expect.error, entry.name);
    }
  }
});

test('the browser builders reproduce the fixture timeline byte for byte', async () => {
  const context = browser();
  const rescue = context.ResilientGeoRescue;
  const keyPair = await fixtureKeyPair(fixture.seeds.device);
  const create = fixture.inputs.create;
  let latest = await rescue.buildRequest(create, { issuedAt: Date.parse(create.issuedAt), requestUuid: create.requestUuid, keyPair });
  assert.deepEqual(JSON.parse(JSON.stringify(latest)), eventCase('valid_v1'));
  const names = ['valid_v2_update', 'valid_v3_extend', 'valid_v4_resolved'];
  for (const [index, revision] of fixture.inputs.revisions.entries()) {
    const input = revision.action === 'UPDATE' ? { ...rescue.inputFromEvent(latest), ...revision.changes } : null;
    latest = await rescue.buildRevision(latest, { action: revision.action, input, issuedAt: Date.parse(revision.issuedAt), keyPair });
    assert.deepEqual(JSON.parse(JSON.stringify(latest)), eventCase(names[index]), names[index]);
  }
});

test('the browser wraps a request in the same signed chunk as JS and Kotlin', async () => {
  const context = browser();
  const keyPair = await fixtureKeyPair(fixture.seeds.device);
  const chunk = await context.ResilientGeoRescue.buildChunk(eventCase('valid_v1'), keyPair.privateKey);
  const expected = fixture.chunk_cases.find((entry) => entry.name === 'valid_rescue_chunk').chunk;
  assert.deepEqual(JSON.parse(JSON.stringify(chunk)), expected);
});

test('submit keeps the request waiting until the server accepts it', async () => {
  const indexedDB = memoryIndexedDB();
  const offline = browser({ indexedDB });
  const waiting = await call(offline, 'rescueSubmit', JSON.stringify(form));
  assert.equal(waiting.delivery_state, 'WAITING_UPLOAD');
  assert.equal(waiting.reason, 'network_unavailable');
  assert.equal(waiting.request.apply_state, 'UNVERIFIED');

  const posts = [];
  const online = browser({
    indexedDB,
    fetch: async (url, init) => {
      posts.push({ url: String(url), body: JSON.parse(init.body) });
      return { status: 201, ok: true, json: async () => ({ result: 'accepted' }) };
    },
  });
  const [accepted] = await call(online, 'rescueFlush');
  assert.equal(accepted.delivery_state, 'ACCEPTED');
  assert.equal(posts[0].url, 'https://map.example.test/v1/crowd/rescue-events');
  assert.equal(posts[0].body.dataset_id, 'crowd-rescue');
  assert.equal(posts[0].body.chunk_id, `crowd-rescue:${waiting.request.event_id}`);
  assert.equal(posts[0].body.events[0].event_id, waiting.request.event_id);
  assert.equal(posts[0].body.signing_key_id, waiting.request.signing_key_id);
});

test('a server rejection is never shown as success', async () => {
  const context = browser({
    fetch: async () => ({ status: 400, ok: false, json: async () => ({ error: 'rejected', reason: 'rescue_severity_mismatch' }) }),
  });
  const session = await call(context, 'rescueSubmit', JSON.stringify(form));
  assert.equal(session.delivery_state, 'REJECTED');
  assert.equal(session.reason, 'rescue_severity_mismatch');
});

test('one ACTIVE request per browser key and a 30 second cooldown', async () => {
  let clock = Date.parse(fixture.now);
  const indexedDB = memoryIndexedDB();
  const context = browser({ indexedDB, now: () => clock });
  const first = await call(context, 'rescueSubmit', JSON.stringify(form));
  await assert.rejects(call(context, 'rescueSubmit', JSON.stringify(form)), /rescue_active_exists/);
  await assert.rejects(call(context, 'rescueRevise', first.request.event_id, 'RESOLVE', ''), /rate_limited:30/);
  clock += 31_000;
  const resolved = await call(context, 'rescueRevise', first.request.event_id, 'RESOLVE', '');
  assert.equal(resolved.request.attributes.status, 'RESOLVED');
  assert.equal(resolved.request.event_version, 2);
  const reopened = browser({ indexedDB, now: () => clock });
  assert.equal((await call(reopened, 'rescueOwnSessions'))[0].request.attributes.status, 'RESOLVED');
});

test('nearby only returns verified, active rescue requests', async () => {
  const context = browser({
    fetch: async (url) => {
      assert.match(String(url), /\/v1\/crowd\/rescue-events\?bbox=121\.57%2C25\.05%2C121\.6%2C25\.08$/u);
      const validChunk = fixture.chunk_cases.find((entry) => entry.name === 'valid_rescue_chunk').chunk;
      // Only the event inside each chunk is checked here; a forged wrapper
      // around a bad event must still be refused.
      return {
        status: 200,
        ok: true,
        json: async () => ({ chunks: [validChunk, { events: [eventCase('tampered')] }, { events: [eventCase('severity_mismatch')] }, { bogus: true }] }),
      };
    },
  });
  const { events } = await call(context, 'rescueNearby', JSON.stringify([121.57, 25.05, 121.6, 25.08]));
  assert.equal(events.length, 1);
  assert.equal(events[0].payload_hash, eventCase('valid_v1').payload_hash);
  assert.equal(events[0].apply_state, 'UNVERIFIED');
});

test('a browser without Ed25519 reports it instead of pretending to sign', async () => {
  const subtle = {
    digest: (...args) => webcrypto.subtle.digest(...args),
    generateKey: async () => { throw new Error('NotSupportedError'); },
    importKey: async () => { throw new Error('NotSupportedError'); },
  };
  const context = browser({ crypto: { subtle, randomUUID: () => webcrypto.randomUUID() } });
  assert.deepEqual(await call(context, 'rescueCapabilities'), { signing: false, verifying: false, storage: true });
  await assert.rejects(call(context, 'rescueSubmit', JSON.stringify(form)), /signing_unsupported/);
});

test('exported functions never reject; failures come back in the envelope', async () => {
  const context = browser();
  const envelope = JSON.parse(await context.rescueSubmit('{not json'));
  assert.equal(envelope.ok, false);
  assert.equal(typeof envelope.error, 'string');
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test pipeline/test/rescue-outbox-web.test.mjs`
Expected: FAIL（`rescueSubmit` 等函式不存在）

- [ ] **Step 3: 實作 `flutter/web/rescue_outbox.js`**

```js
(function installRescueOutbox(global) {
  // Mirror of pipeline/lib/rescue-contract.mjs + rescue-request.mjs for the
  // browser. pipeline/test/rescue-outbox-web.test.mjs replays the shared
  // fixture against this file, so error codes and canonical bytes must match.
  const encoder = new TextEncoder();
  const helper = () => {
    const value = global.ResilientGeoNLSCStatic;
    if (!value) throw new Error('rescue_helper_missing');
    return value;
  };

  const NAMESPACE = 'crowd.rescue';
  const EVENT_TYPE = 'RESCUE_REQUEST';
  const SOURCE = 'CROWD';
  const SOURCE_VERSION = 'rescue-request-v0';
  const TTL_MS = 6 * 60 * 60 * 1000;
  const MAX_LIFETIME_MS = 72 * 60 * 60 * 1000;
  const MAX_EVENT_VERSION = 200;
  const PEOPLE_MAX = 50;
  const DESCRIPTION_MAX = 160;
  const HINT_TEXT_MAX = 80;
  const COOLDOWN_MS = 30 * 1000;
  const REQUEST_TYPES = ['FIRST_AID_NEEDED', 'IMMOBILE', 'TRAPPED', 'TRAPPED_DEBRIS', 'OTHER_RESCUE'];
  const STATUSES = ['ACTIVE', 'RESOLVED', 'CANCELLED'];
  const SUBJECTS = ['SELF', 'OTHERS'];
  const TRIAGE_FIELDS = ['immobile', 'breathing_difficulty', 'severe_bleeding', 'conscious'];
  const TRIAGE_ANSWERS = ['YES', 'NO', 'UNKNOWN'];
  const LOCATION_SOURCES = ['CURRENT_LOCATION', 'MAP_PICK'];
  const HINT_KINDS = ['COUNTY', 'DISTRICT', 'VILLAGE', 'ROAD', 'FACILITY'];
  const HINT_PRECISIONS = ['AREA', 'ROAD', 'POINT'];
  const BOUNDS = [116.5, 20.5, 122.5, 26.8];
  const ATTRIBUTE_KEYS = new Set([
    'request_type', 'status', 'subject', 'people_count', 'triage', 'description',
    'location_source', 'location_hint', 'first_issued_at', 'area_id', 'theme',
  ]);
  const EVENT_ID_RE = /^rescue:([0-9a-f]{32}):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const PAYLOAD_FIELDS = [
    'namespace', 'event_id', 'event_type', 'geometry', 'severity', 'source',
    'source_version', 'event_version', 'issued_at', 'expires_at', 'attributes',
  ];
  const DATABASE = 'resilientgeo-rescue-v1';
  const KEY_STORE = 'keys';
  const SESSION_STORE = 'sessions';
  const ENDPOINT = '/v1/crowd/rescue-events';

  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const codePoints = (value) => [...value].length;
  const roundCoordinate = (value) => Number(value.toFixed(6));
  const isoSeconds = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  const isTerminal = (status) => status === 'RESOLVED' || status === 'CANCELLED';

  function deriveUrgency(requestType, triage) {
    if (requestType === 'TRAPPED_DEBRIS') return 'CRITICAL';
    if (triage?.breathing_difficulty === 'YES' || triage?.severe_bleeding === 'YES' || triage?.conscious === 'NO') return 'CRITICAL';
    if (requestType === 'TRAPPED' || requestType === 'IMMOBILE' || triage?.immobile === 'YES') return 'HIGH';
    return 'MEDIUM';
  }

  function hintValid(hint) {
    if (hint === undefined || hint === null) return true;
    if (!isObject(hint)) return false;
    return hint.method === 'ADDRESS' && HINT_KINDS.includes(hint.kind) && HINT_PRECISIONS.includes(hint.precision)
      && ['query', 'label'].every((field) => typeof hint[field] === 'string' && codePoints(hint[field]) <= HINT_TEXT_MAX);
  }

  function triageValid(triage, subject) {
    if (!isObject(triage)) return false;
    const keys = Object.keys(triage);
    if (keys.length !== TRIAGE_FIELDS.length || !TRIAGE_FIELDS.every((field) => keys.includes(field))) return false;
    if (!TRIAGE_FIELDS.every((field) => TRIAGE_ANSWERS.includes(triage[field]))) return false;
    return subject !== 'SELF' || triage.conscious === 'YES';
  }

  function coordinatesValid(lon, lat) {
    return typeof lon === 'number' && typeof lat === 'number' && Number.isFinite(lon) && Number.isFinite(lat)
      && lon >= BOUNDS[0] && lon <= BOUNDS[2] && lat >= BOUNDS[1] && lat <= BOUNDS[3];
  }

  function fieldErrors({ requestType, subject, peopleCount, triage, description, lon, lat, locationSource, locationHint }) {
    const errors = [];
    if (!REQUEST_TYPES.includes(requestType)) errors.push('rescue_field_invalid:request_type');
    if (!SUBJECTS.includes(subject)) errors.push('rescue_field_invalid:subject');
    if (!Number.isInteger(peopleCount) || peopleCount < 1 || peopleCount > PEOPLE_MAX) errors.push('rescue_field_invalid:people_count');
    if (!triageValid(triage, subject)) errors.push('rescue_field_invalid:triage');
    if (typeof description !== 'string' || codePoints(description.trim()) > DESCRIPTION_MAX) errors.push('rescue_field_invalid:description');
    if (!LOCATION_SOURCES.includes(locationSource)) errors.push('rescue_field_invalid:location_source');
    if (!hintValid(locationHint)) errors.push('rescue_field_invalid:location_hint');
    if (!coordinatesValid(lon, lat)) errors.push('rescue_geometry_invalid');
    return errors;
  }

  function eventErrors(event) {
    const attributes = isObject(event.attributes) ? event.attributes : {};
    if (event.namespace !== NAMESPACE || event.event_type !== EVENT_TYPE || event.source !== SOURCE
      || event.source_version !== SOURCE_VERSION || attributes.area_id !== 'crowd' || attributes.theme !== 'rescue') {
      return ['rescue_identity_invalid'];
    }
    const match = EVENT_ID_RE.exec(event.event_id);
    if (!match || `device:${match[1]}` !== event.signing_key_id) return ['rescue_event_id_unbound'];
    const geometry = event.geometry;
    if (geometry?.type !== 'Point' || !Array.isArray(geometry.coordinates) || geometry.coordinates.length !== 2) {
      return ['rescue_geometry_invalid'];
    }
    if (Object.keys(attributes).some((key) => !ATTRIBUTE_KEYS.has(key))) return ['rescue_attributes_unknown'];
    const errors = fieldErrors({
      requestType: attributes.request_type,
      subject: attributes.subject,
      peopleCount: attributes.people_count,
      triage: attributes.triage,
      description: attributes.description,
      lon: geometry.coordinates[0],
      lat: geometry.coordinates[1],
      locationSource: attributes.location_source,
      locationHint: attributes.location_hint,
    });
    if (errors.length > 0) return [errors[0]];
    if (!STATUSES.includes(attributes.status)) return ['rescue_field_invalid:status'];
    if (event.severity !== deriveUrgency(attributes.request_type, attributes.triage)) return ['rescue_severity_mismatch'];
    if (event.event_version > MAX_EVENT_VERSION) return ['rescue_version_too_high'];
    const issued = Date.parse(event.issued_at);
    const expires = Date.parse(event.expires_at);
    const first = Date.parse(attributes.first_issued_at);
    if ([issued, expires, first].some(Number.isNaN) || first > issued || expires <= issued
      || (event.event_version === 1 && first !== issued)) {
      return ['rescue_time_invalid'];
    }
    if (expires - issued > TTL_MS) return ['rescue_ttl_too_long'];
    if (expires > first + MAX_LIFETIME_MS) return ['rescue_lifetime_exceeded'];
    return [];
  }

  function transitionErrors(stored, incoming) {
    if (stored.signing_key_id !== incoming.signing_key_id) return ['signer_mismatch'];
    if (isTerminal(stored.attributes?.status)) return ['rescue_terminal'];
    if (isTerminal(incoming.attributes?.status) && incoming.expires_at !== stored.expires_at) return ['rescue_terminal_expiry_changed'];
    if (incoming.attributes?.first_issued_at !== stored.attributes?.first_issued_at) return ['rescue_first_issued_changed'];
    return [];
  }

  function toBase64(buffer) {
    let binary = '';
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function fromBase64(value) {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  }

  async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  const keyIdForSpki = async (spkiBytes) => `device:${(await sha256Hex(spkiBytes)).slice(0, 32)}`;

  function payloadOf(event) {
    return Object.fromEntries(PAYLOAD_FIELDS.filter((field) => event[field] !== undefined).map((field) => [field, event[field]]));
  }

  async function signEvent(event, privateKey) {
    const { canonicalize, sha256 } = helper();
    const payload = payloadOf(event);
    const payloadHash = await sha256(canonicalize(payload));
    const signature = await crypto.subtle.sign(
      { name: 'Ed25519' },
      privateKey,
      encoder.encode(canonicalize({ ...payload, payload_hash: payloadHash })),
    );
    return { ...event, payload_hash: payloadHash, signature_algorithm: 'Ed25519', signature: toBase64(signature) };
  }

  function normalizedTriage(subject, triage = {}) {
    return {
      immobile: triage.immobile,
      breathing_difficulty: triage.breathing_difficulty,
      severe_bleeding: triage.severe_bleeding,
      conscious: subject === 'SELF' ? 'YES' : triage.conscious,
    };
  }

  async function assemble({ input, eventId, version, issued, expires, status, firstIssuedAt, keyPair }) {
    const triage = normalizedTriage(input.subject, input.triage);
    const errors = fieldErrors({ ...input, triage });
    if (errors.length > 0) throw new Error(errors.join('; '));
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey));
    const attributes = {
      request_type: input.requestType,
      status,
      subject: input.subject,
      people_count: input.peopleCount,
      triage,
      description: input.description.trim(),
      location_source: input.locationSource,
      first_issued_at: firstIssuedAt,
      area_id: 'crowd',
      theme: 'rescue',
    };
    if (input.locationHint) {
      const hint = input.locationHint;
      attributes.location_hint = { method: hint.method, query: hint.query, label: hint.label, kind: hint.kind, precision: hint.precision };
    }
    const event = {
      schema_version: 'event-v0',
      namespace: NAMESPACE,
      event_id: eventId,
      event_type: EVENT_TYPE,
      geometry: { type: 'Point', coordinates: [roundCoordinate(input.lon), roundCoordinate(input.lat)] },
      severity: deriveUrgency(attributes.request_type, triage),
      source: SOURCE,
      source_version: SOURCE_VERSION,
      event_version: version,
      issued_at: issued,
      expires_at: expires,
      attributes,
      signing_key_id: await keyIdForSpki(spki),
      signer_public_key: toBase64(spki),
      provenance: { original_source: 'crowd-app', received_at: issued, transport_source: { kind: 'local_report' } },
    };
    return signEvent(event, keyPair.privateKey);
  }

  async function buildRequest(input, { issuedAt, requestUuid, keyPair }) {
    const issued = isoSeconds(issuedAt);
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey));
    const keyId = await keyIdForSpki(spki);
    return assemble({
      input,
      eventId: `rescue:${keyId.slice('device:'.length)}:${requestUuid.toLowerCase()}`,
      version: 1,
      issued,
      expires: isoSeconds(Date.parse(issued) + TTL_MS),
      status: 'ACTIVE',
      firstIssuedAt: issued,
      keyPair,
    });
  }

  function inputFromEvent(event) {
    const attributes = event.attributes;
    return {
      requestType: attributes.request_type,
      subject: attributes.subject,
      peopleCount: attributes.people_count,
      triage: { ...attributes.triage },
      description: attributes.description,
      lon: event.geometry.coordinates[0],
      lat: event.geometry.coordinates[1],
      locationSource: attributes.location_source,
      locationHint: attributes.location_hint ? { ...attributes.location_hint } : undefined,
    };
  }

  function inputFromArguments(args) {
    if (!isObject(args) || !isObject(args.location)) throw new Error('rescue_field_invalid:request_type');
    return {
      requestType: args.request_type,
      subject: args.subject,
      peopleCount: args.people_count,
      triage: isObject(args.triage) ? { ...args.triage } : args.triage,
      description: typeof args.description === 'string' ? args.description : '',
      lon: args.location.lon,
      lat: args.location.lat,
      locationSource: args.location.source,
      locationHint: args.location_hint ?? undefined,
    };
  }

  async function buildRevision(previous, { action, input, issuedAt, keyPair }) {
    if (!['UPDATE', 'EXTEND', 'RESOLVE', 'CANCEL'].includes(action)) throw new Error('rescue_action_invalid');
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey));
    if (await keyIdForSpki(spki) !== previous.signing_key_id) throw new Error('rescue_revision_wrong_device');
    if (isTerminal(previous.attributes.status)) throw new Error('rescue_revision_terminal');
    const issued = isoSeconds(issuedAt);
    const issuedMs = Date.parse(issued);
    const previousExpires = Date.parse(previous.expires_at);
    if (issuedMs >= previousExpires) throw new Error('rescue_revision_expired');
    const firstIssuedAt = previous.attributes.first_issued_at;
    let expires = previous.expires_at;
    if (action === 'EXTEND') {
      const extended = Math.min(issuedMs + TTL_MS, Date.parse(firstIssuedAt) + MAX_LIFETIME_MS);
      if (extended <= previousExpires) throw new Error('rescue_extend_not_later');
      expires = isoSeconds(extended);
    }
    if (action === 'UPDATE' && !input) throw new Error('rescue_action_invalid');
    return assemble({
      input: action === 'UPDATE' ? input : inputFromEvent(previous),
      eventId: previous.event_id,
      version: previous.event_version + 1,
      issued,
      expires,
      status: action === 'RESOLVE' ? 'RESOLVED' : action === 'CANCEL' ? 'CANCELLED' : 'ACTIVE',
      firstIssuedAt,
      keyPair,
    });
  }

  const CHUNK_CONTENT_FIELDS = [
    'dataset_id', 'namespace', 'dataset_version', 'sequence', 'priority',
    'area_id', 'theme', 'bbox', 'content_type', 'content_encoding', 'events',
  ];

  /** Same envelope as buildCrowdChunk() in crowd-report.mjs for the crowd-rescue profile. */
  async function buildChunk(event, privateKey) {
    const { canonicalize, sha256 } = helper();
    const [lon, lat] = event.geometry.coordinates;
    const content = {
      schema_version: 'chunk-v0',
      chunk_id: `crowd-rescue:${event.event_id}`,
      manifest_id: 'crowd-rescue:none',
      manifest_hash: event.payload_hash,
      dataset_id: 'crowd-rescue',
      namespace: NAMESPACE,
      dataset_version: 1,
      sequence: 0,
      priority: event.severity === 'CRITICAL' || event.severity === 'HIGH' ? 'HIGH' : 'NORMAL',
      area_id: 'crowd',
      theme: 'rescue',
      bbox: [roundCoordinate(lon), roundCoordinate(lat), roundCoordinate(lon), roundCoordinate(lat)],
      created_at: event.issued_at,
      content_type: 'application/json',
      content_encoding: 'identity',
      event_count: 1,
      events: [event],
      signature_algorithm: 'Ed25519',
      signing_key_id: event.signing_key_id,
    };
    const payload = encoder.encode(canonicalize(Object.fromEntries(CHUNK_CONTENT_FIELDS.map((field) => [field, content[field]]))));
    const unsigned = { ...content, byte_length: payload.length, chunk_hash: await sha256(payload) };
    const signature = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, encoder.encode(canonicalize(unsigned)));
    return { ...unsigned, signature: toBase64(signature) };
  }

  function shapeValid(event) {
    return isObject(event) && event.schema_version === 'event-v0'
      && ['namespace', 'event_id', 'event_type', 'source', 'source_version', 'signing_key_id', 'signer_public_key', 'signature']
        .every((field) => typeof event[field] === 'string' && event[field].length > 0)
      && Number.isInteger(event.event_version) && event.event_version >= 1
      && !Number.isNaN(Date.parse(event.issued_at)) && !Number.isNaN(Date.parse(event.expires_at))
      && isObject(event.geometry) && isObject(event.attributes) && isObject(event.provenance)
      && typeof event.payload_hash === 'string' && /^sha256:[0-9a-f]{64}$/i.test(event.payload_hash)
      && event.signature_algorithm === 'Ed25519';
  }

  /** Same stages as verifyEvent() in contract.mjs, restricted to device-signed crowd.* events. */
  async function verifyEvent(event, nowMs) {
    if (!shapeValid(event)) return { valid: false, stage: 'schema', errors: ['event_shape_invalid'] };
    if (!event.signing_key_id.startsWith('device:') || !event.namespace.startsWith('crowd.')) {
      return { valid: false, stage: 'trust', errors: ['device keys may only sign crowd.* events'] };
    }
    let publicKey;
    try {
      const spki = fromBase64(event.signer_public_key);
      if (await keyIdForSpki(spki) !== event.signing_key_id) {
        return { valid: false, stage: 'trust', errors: ['signing_key_id does not match signer_public_key fingerprint'] };
      }
      publicKey = await crypto.subtle.importKey('spki', spki, { name: 'Ed25519' }, false, ['verify']);
    } catch {
      return { valid: false, stage: 'trust', errors: ['signer_public_key is not an Ed25519 SPKI key'] };
    }
    const { canonicalize, sha256 } = helper();
    const payload = payloadOf(event);
    if (await sha256(canonicalize(payload)) !== event.payload_hash) {
      return { valid: false, stage: 'integrity', errors: ['payload_hash_mismatch'] };
    }
    const signed = await crypto.subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      fromBase64(event.signature),
      encoder.encode(canonicalize({ ...payload, payload_hash: event.payload_hash })),
    ).catch(() => false);
    if (!signed) return { valid: false, stage: 'signature', errors: ['signature_invalid'] };
    if (event.namespace === NAMESPACE) {
      const errors = eventErrors(event);
      if (errors.length > 0) return { valid: false, stage: 'contract', errors };
    }
    return { valid: true, expired: nowMs >= Date.parse(event.expires_at), errors: [] };
  }

  // ---- IndexedDB ---------------------------------------------------------

  function openDatabase() {
    if (!global.indexedDB) return Promise.reject(new Error('storage_unavailable'));
    return new Promise((resolve, reject) => {
      const request = global.indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(KEY_STORE)) database.createObjectStore(KEY_STORE);
        if (!database.objectStoreNames.contains(SESSION_STORE)) database.createObjectStore(SESSION_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('storage_unavailable'));
    });
  }

  async function storeRequest(storeName, run) {
    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const request = run(database.transaction(storeName, 'readonly').objectStore(storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('storage_unavailable'));
      });
    } finally {
      database.close();
    }
  }

  async function storePut(storeName, key, value) {
    const database = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readwrite');
        transaction.objectStore(storeName).put(value, key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(new Error('storage_unavailable'));
      });
    } finally {
      database.close();
    }
  }

  const allSessions = () => storeRequest(SESSION_STORE, (store) => store.getAll());

  async function deviceKey() {
    const existing = await storeRequest(KEY_STORE, (store) => store.get('device'));
    if (existing) return existing;
    let pair;
    try {
      // The private key is non-extractable: it can sign but never leaves the browser.
      pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    } catch {
      throw new Error('signing_unsupported');
    }
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
    const record = { privateKey: pair.privateKey, publicKey: pair.publicKey, keyId: await keyIdForSpki(spki) };
    await storePut(KEY_STORE, 'device', record);
    return record;
  }

  function sessionView(record, nowMs) {
    const expired = nowMs >= Date.parse(record.request.expires_at);
    return {
      request: { ...record.request, apply_state: expired ? 'EXPIRED' : 'UNVERIFIED' },
      delivery_state: record.delivery_state,
      reason: record.reason ?? null,
    };
  }

  async function saveSession(event, chunk, deliveryState, reason) {
    const record = { request: event, chunk, delivery_state: deliveryState, reason, updated_at: Date.now() };
    await storePut(SESSION_STORE, event.event_id, record);
    return record;
  }

  /** Signs the event's chunk with the same device key and stores both as waiting for upload. */
  async function saveSigned(event, key) {
    return saveSession(event, await buildChunk(event, key.privateKey), 'WAITING_UPLOAD', null);
  }

  async function upload(record) {
    const state = (deliveryState, reason) => saveSession(record.request, record.chunk, deliveryState, reason);
    await state('UPLOADING', null);
    let response;
    try {
      response = await global.fetch(new URL(ENDPOINT, global.location.origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(record.chunk),
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch {
      return state('WAITING_UPLOAD', 'network_unavailable');
    }
    if (response.status === 200 || response.status === 201) return state('ACCEPTED', null);
    const body = await response.json().catch(() => ({}));
    if ([400, 409, 413].includes(response.status)) {
      return state('REJECTED', body.reason ?? body.error ?? `http_${response.status}`);
    }
    if (response.status === 404) return state('WAITING_UPLOAD', 'server_unavailable');
    if (response.status === 429) return state('WAITING_UPLOAD', 'rate_limited');
    return state('WAITING_UPLOAD', 'network_unavailable');
  }

  function guardLimits(sessions, key, nowMs, { creating }) {
    const own = sessions.filter((session) => session.request.signing_key_id === key.keyId);
    if (creating && own.some((session) => session.request.attributes.status === 'ACTIVE' && Date.parse(session.request.expires_at) > nowMs)) {
      throw new Error('rescue_active_exists');
    }
    const latest = Math.max(0, ...own.map((session) => Date.parse(session.request.issued_at)));
    const remaining = Math.ceil((latest + COOLDOWN_MS - nowMs) / 1000);
    if (remaining > 0) throw new Error(`rate_limited:${remaining}`);
  }

  async function rescueCapabilities() {
    let signing = false;
    let verifying = false;
    try {
      const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
      signing = true;
      verifying = Boolean(pair.publicKey);
    } catch {
      signing = false;
    }
    return { signing, verifying, storage: Boolean(global.indexedDB) };
  }

  async function rescueSubmit(argsJson) {
    const input = inputFromArguments(JSON.parse(argsJson));
    const key = await deviceKey();
    const nowMs = Date.now();
    guardLimits(await allSessions(), key, nowMs, { creating: true });
    const event = await buildRequest(input, { issuedAt: nowMs, requestUuid: crypto.randomUUID(), keyPair: key });
    const saved = await saveSigned(event, key);
    return sessionView(await upload(saved), Date.now());
  }

  async function rescueRevise(eventId, action, argsJson) {
    const key = await deviceKey();
    const sessions = await allSessions();
    const current = sessions.find((session) => session.request.event_id === eventId);
    if (!current) throw new Error('rescue_not_found');
    const nowMs = Date.now();
    guardLimits(sessions, key, nowMs, { creating: false });
    const input = argsJson ? inputFromArguments(JSON.parse(argsJson)) : null;
    const event = await buildRevision(current.request, { action, input, issuedAt: nowMs, keyPair: key });
    const saved = await saveSigned(event, key);
    return sessionView(await upload(saved), Date.now());
  }

  async function rescueOwnSessions() {
    const nowMs = Date.now();
    return (await allSessions()).map((record) => sessionView(record, nowMs));
  }

  let flushing = null;
  async function rescueFlush() {
    if (!flushing) {
      flushing = (async () => {
        for (const record of await allSessions()) {
          if (record.delivery_state === 'WAITING_UPLOAD' || record.delivery_state === 'UPLOADING') {
            if (Date.now() < Date.parse(record.request.expires_at)) await upload(record);
          }
        }
      })().finally(() => { flushing = null; });
    }
    await flushing;
    return rescueOwnSessions();
  }

  async function rescueNearby(bboxJson) {
    const bbox = JSON.parse(bboxJson);
    const url = new URL(ENDPOINT, global.location.origin);
    url.searchParams.set('bbox', bbox.join(','));
    const response = await global.fetch(url, { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) throw new Error(response.status === 404 ? 'server_unavailable' : `http_${response.status}`);
    const body = await response.json();
    const nowMs = Date.now();
    const events = [];
    for (const chunk of Array.isArray(body?.chunks) ? body.chunks : []) {
      const event = Array.isArray(chunk?.events) && chunk.events.length === 1 ? chunk.events[0] : null;
      if (!event) continue;
      const result = await verifyEvent(event, nowMs);
      if (!result.valid || result.expired || event.namespace !== NAMESPACE || event.attributes.status !== 'ACTIVE') continue;
      events.push({ ...event, apply_state: 'UNVERIFIED' });
    }
    return { events };
  }

  /** Dart reads `{ ok, value | error }` instead of catching a JS rejection. */
  const exported = (run) => async (...args) => {
    try {
      return JSON.stringify({ ok: true, value: await run(...args) });
    } catch (error) {
      return JSON.stringify({ ok: false, error: String(error?.message ?? error) });
    }
  };

  global.ResilientGeoRescue = {
    deriveUrgency, fieldErrors, eventErrors, transitionErrors, verifyEvent,
    buildRequest, buildRevision, buildChunk, inputFromEvent, inputFromArguments,
  };
  global.rescueCapabilities = exported(rescueCapabilities);
  global.rescueSubmit = exported(rescueSubmit);
  global.rescueRevise = exported(rescueRevise);
  global.rescueOwnSessions = exported(rescueOwnSessions);
  global.rescueFlush = exported(rescueFlush);
  global.rescueNearby = exported(rescueNearby);
  global.addEventListener?.('online', () => { void rescueFlush().catch(() => {}); });
})(globalThis);
```

- [ ] **Step 4: 在 `index.html` 載入**

在 `<script src="nlsc_government_feed.js"></script>` 之後加入：

```html
  <script src="rescue_outbox.js"></script>
```

- [ ] **Step 5: 執行測試確認通過**

Run: `node --test pipeline/test/rescue-outbox-web.test.mjs pipeline/test/nlsc-government-feed-web.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add flutter/web/rescue_outbox.js flutter/web/index.html pipeline/test/rescue-outbox-web.test.mjs
git commit -m "feat(web): sign rescue requests in the browser with an IndexedDB outbox"
```

---

### Task 16: Dart 共用模型與 `RescueService`

> 本任務把原本總覽列在 05 的「模型」併入，因為 `RescueService` 需要這些型別。05 從 Task 17 開始是 UI。

**Files:**
- Create: `flutter/lib/data/rescue_request_models.dart`
- Create: `flutter/lib/data/rescue_service.dart`
- Create: `flutter/lib/data/rescue_web.dart`、`flutter/lib/data/rescue_web_stub.dart`、`flutter/lib/data/rescue_web_web.dart`
- Modify: `flutter/lib/data/map_bridge.dart`
- Test: `flutter/test/rescue_request_models_test.dart`
- Test: `flutter/test/rescue_service_test.dart`

**Interfaces:**
- Consumes: `MeshEvent`、`GeoPoint`（map_models.dart）；`CrowdReportLocationSource`、`CrowdReportLocationHint`（crowd_report_models.dart）；02 Task 8 的 MethodChannel；Task 15 的 JS 函式
- Produces（`rescue_request_models.dart`）：
  - `const rescueNamespace = 'crowd.rescue'; const rescueEventType = 'RESCUE_REQUEST';`
  - `enum RescueRequestType { firstAidNeeded, immobile, trapped, trappedDebris, otherRescue }`，extension：`wireValue`、`label`、`static RescueRequestType? fromWire(Object?)`
  - `enum RescueSubject { self, others }`：`wireValue`、`label`
  - `enum TriageAnswer { yes, no, unknown }`：`wireValue`、`label`
  - `final class RescueTriage { immobile, breathingDifficulty, severeBleeding, conscious }`：`toWire(RescueSubject)`、`static RescueTriage? fromWire(Object?)`
  - `enum RescueUrgency { critical, high, medium }`：`wireValue`、`label`（危急／高／中）、`badge`（危／高／中）、`static fromWire`
  - `RescueUrgency deriveRescueUrgency(RescueRequestType, RescueTriage, RescueSubject)`
  - `String rescueUrgencyReason(RescueRequestType, RescueTriage, RescueSubject)`
  - `enum RescueStatus { active, resolved, cancelled }`：`wireValue`、`label`（進行中／已獲救或已安全／已取消）、`static fromWire`
  - `enum RescueAction { update, extend, resolve, cancel }`：`wireValue`
  - `final class RescueDraft`：欄位 `type, subject, peopleCount, triage, location, locationSource, locationHint, description`；`copyWith`；`String? validate()`；`Map<String, Object?> toArguments()`；`factory RescueDraft.initial()`；`factory RescueDraft.fromView(RescueRequestView)`
  - `final class RescueRequestView`：`event, type, status, subject, peopleCount, triage, description, urgency, firstIssuedAt, expiresAt`；`static RescueRequestView? fromEvent(MeshEvent)`；`bool isActiveAt(DateTime now)`；`bool canExtendAt(DateTime now)`
  - `bool isRescueEvent(MeshEvent)`
  - `enum RescueDelivery { meshPending, waitingUpload, uploading, accepted, rejected }`：`label`
  - `final class RescueSession { request: RescueRequestView; meshPending: bool; server: RescueDelivery; reason: String? }`；`factory RescueSession.fromMessage(Map<String, dynamic>)`；`String deliveryText()`
- Produces（`rescue_service.dart`）：
  - `enum RescueFailureCode { unsupported, invalidInput, conflict, rateLimited, signingUnavailable, storageUnavailable, serverUnavailable, unknown }`
  - `final class RescueFailure implements Exception { code, message, retryAfterSeconds }`；`String userMessage()`
  - `final class RescueCapabilities { canSign, canVerify, hasStorage, supportsMesh }`
  - `final class RescueBounds { minLon, minLat, maxLon, maxLat }`；`factory RescueBounds.around(GeoPoint, {double halfSpan = 0.024})`；`List<double> toList()`
  - `abstract class RescueService { Future<RescueCapabilities> capabilities(); Future<RescueSession> submit(RescueDraft); Future<RescueSession> revise(String eventId, RescueAction, {RescueDraft? draft}); Future<List<RescueSession>> ownSessions(); Future<List<RescueSession>> flush(); Future<List<MeshEvent>> nearby(RescueBounds); static RescueService forPlatform({required MapBridge bridge, bool? isWeb}); }`
  - `final class AndroidRescueService implements RescueService`；`final class WebRescueService implements RescueService`
- Produces（`map_bridge.dart`）：`Future<Map<String, dynamic>> submitRescueRequest(Map<String, Object?>)`、`reviseRescueRequest(String eventId, String action, Map<String, Object?>? request)`、`Future<List<Map<String, dynamic>>> getOwnRescueRequests()`、`Future<Map<String, dynamic>> syncRescueNearby(List<double> bbox)`（Android 端在 07 Task 28 實作；之前回 `notImplemented`）；這些方法直接拋出原始 `PlatformException`／`MissingPluginException`，由 `AndroidRescueService` 轉成 `RescueFailure`

- [ ] **Step 1: 寫模型測試**

`flutter/test/rescue_request_models_test.dart`：

```dart
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/crowd_report_models.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/rescue_request_models.dart';

RescueTriage _triage({
  TriageAnswer immobile = TriageAnswer.no,
  TriageAnswer breathing = TriageAnswer.no,
  TriageAnswer bleeding = TriageAnswer.no,
  TriageAnswer conscious = TriageAnswer.yes,
}) => RescueTriage(
  immobile: immobile,
  breathingDifficulty: breathing,
  severeBleeding: bleeding,
  conscious: conscious,
);

Map<String, dynamic> _fixture() => jsonDecode(
  File('../fixtures/rescue-requests-v0.json').readAsStringSync(),
) as Map<String, dynamic>;

MeshEvent _fixtureEvent(String name) {
  final cases = (_fixture()['event_cases'] as List).cast<Map<String, dynamic>>();
  final event = Map<String, dynamic>.from(cases.firstWhere((entry) => entry['name'] == name)['event'] as Map);
  return MeshEvent.fromJson(<String, dynamic>{...event, 'apply_state': 'UNVERIFIED'});
}

void main() {
  test('urgency table matches the contract and ignores people count', () {
    const others = RescueSubject.others;
    expect(deriveRescueUrgency(RescueRequestType.trappedDebris, _triage(), others), RescueUrgency.critical);
    expect(deriveRescueUrgency(RescueRequestType.firstAidNeeded, _triage(breathing: TriageAnswer.yes), others), RescueUrgency.critical);
    expect(deriveRescueUrgency(RescueRequestType.firstAidNeeded, _triage(bleeding: TriageAnswer.yes), others), RescueUrgency.critical);
    expect(deriveRescueUrgency(RescueRequestType.otherRescue, _triage(conscious: TriageAnswer.no), others), RescueUrgency.critical);
    expect(deriveRescueUrgency(RescueRequestType.otherRescue, _triage(conscious: TriageAnswer.no), RescueSubject.self), RescueUrgency.medium);
    expect(deriveRescueUrgency(RescueRequestType.trapped, _triage(), others), RescueUrgency.high);
    expect(deriveRescueUrgency(RescueRequestType.firstAidNeeded, _triage(immobile: TriageAnswer.yes), others), RescueUrgency.high);
    expect(deriveRescueUrgency(RescueRequestType.firstAidNeeded, _triage(), others), RescueUrgency.medium);
    expect(rescueUrgencyReason(RescueRequestType.trappedDebris, _triage(), others), '受困於瓦礫或倒塌建物下');
    expect(rescueUrgencyReason(RescueRequestType.firstAidNeeded, _triage(bleeding: TriageAnswer.yes), others), '大量出血');
  });

  test('draft validation and channel arguments', () {
    final empty = RescueDraft.initial();
    expect(empty.validate(), '請選擇求救位置');
    final draft = empty.copyWith(
      type: RescueRequestType.trappedDebris,
      subject: RescueSubject.self,
      peopleCount: 2,
      location: const GeoPoint(longitude: 121.5, latitude: 25.0),
      locationSource: CrowdReportLocationSource.currentLocation,
      description: '  一樓樓梯間  ',
    );
    expect(draft.validate(), isNull);
    expect(draft.copyWith(peopleCount: 0).validate(), '人數需介於 1 到 50');
    expect(draft.copyWith(description: '字' * 161).validate(), '描述不可超過 160 字');
    expect(draft.copyWith(location: const GeoPoint(longitude: 139.7, latitude: 35.7)).validate(), '求救位置不在支援範圍內');
    expect(draft.toArguments(), <String, Object?>{
      'request_type': 'TRAPPED_DEBRIS',
      'subject': 'SELF',
      'people_count': 2,
      'triage': <String, String>{
        'immobile': 'UNKNOWN',
        'breathing_difficulty': 'UNKNOWN',
        'severe_bleeding': 'UNKNOWN',
        'conscious': 'YES',
      },
      'description': '一樓樓梯間',
      'location': <String, Object?>{'lon': 121.5, 'lat': 25.0, 'source': 'CURRENT_LOCATION'},
    });
  });

  test('fixture events parse into a view with lifecycle helpers', () {
    final view = RescueRequestView.fromEvent(_fixtureEvent('valid_v1'))!;
    expect(view.type, RescueRequestType.trappedDebris);
    expect(view.status, RescueStatus.active);
    expect(view.urgency, RescueUrgency.critical);
    expect(view.peopleCount, 2);
    expect(view.isActiveAt(DateTime.parse('2026-10-12T04:00:00Z')), isTrue);
    expect(view.isActiveAt(DateTime.parse('2026-10-12T09:00:00Z')), isFalse);
    expect(view.canExtendAt(DateTime.parse('2026-10-12T04:00:00Z')), isTrue);
    final resolved = RescueRequestView.fromEvent(_fixtureEvent('valid_v4_resolved'))!;
    expect(resolved.status, RescueStatus.resolved);
    expect(resolved.isActiveAt(DateTime.parse('2026-10-12T10:00:00Z')), isFalse);
    final report = MeshEvent.fromJson(const <String, dynamic>{'namespace': 'crowd.reports', 'event_type': 'CROWD_REPORT'});
    expect(RescueRequestView.fromEvent(report), isNull);
  });

  test('sessions from Android and Web describe delivery truthfully', () {
    final request = _fixture()['event_cases'][0]['event'] as Map<String, dynamic>;
    final android = RescueSession.fromMessage(<String, dynamic>{
      'request': <String, dynamic>{...request, 'apply_state': 'UNVERIFIED'},
      'delivery_state': 'PENDING',
      'server_state': 'NOT_UPLOADED',
    });
    expect(android.meshPending, isTrue);
    expect(android.server, RescueDelivery.waitingUpload);
    expect(android.deliveryText(), '已存於本機，等待附近裝置轉傳；伺服器：等待上傳，尚未送出');

    final web = RescueSession.fromMessage(<String, dynamic>{
      'request': <String, dynamic>{...request, 'apply_state': 'UNVERIFIED'},
      'delivery_state': 'REJECTED',
      'reason': 'rescue_active_exists',
    });
    expect(web.meshPending, isFalse);
    expect(web.server, RescueDelivery.rejected);
    expect(web.deliveryText(), '未送出：此裝置已有進行中的求救');
  });
}
```

- [ ] **Step 2: 寫 service 測試**

`flutter/test/rescue_service_test.dart`：

```dart
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:resilientgeo_flutter/data/crowd_report_models.dart';
import 'package:resilientgeo_flutter/data/map_bridge.dart';
import 'package:resilientgeo_flutter/data/map_models.dart';
import 'package:resilientgeo_flutter/data/rescue_request_models.dart';
import 'package:resilientgeo_flutter/data/rescue_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('test/rescue-service');
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  final draft = RescueDraft.initial().copyWith(
    type: RescueRequestType.trapped,
    location: const GeoPoint(longitude: 121.5, latitude: 25.0),
    locationSource: CrowdReportLocationSource.mapPick,
  );

  tearDown(() => messenger.setMockMethodCallHandler(channel, null));

  test('Android errors become typed rescue failures', () async {
    messenger.setMockMethodCallHandler(channel, (call) async {
      expect(call.method, 'submitRescueRequest');
      expect((call.arguments as Map)['request_type'], 'TRAPPED');
      throw PlatformException(code: 'rate_limited', message: 'cooldown', details: <String, Object?>{'retry_after_seconds': 12});
    });
    final service = AndroidRescueService(MapBridge(methodChannel: channel));
    await expectLater(
      service.submit(draft),
      throwsA(isA<RescueFailure>()
          .having((failure) => failure.code, 'code', RescueFailureCode.rateLimited)
          .having((failure) => failure.retryAfterSeconds, 'retry', 12)),
    );
  });

  test('a missing Android host is reported as unsupported, not as success', () async {
    final service = AndroidRescueService(MapBridge(methodChannel: const MethodChannel('test/no-host')));
    await expectLater(
      service.submit(draft),
      throwsA(isA<RescueFailure>().having((failure) => failure.code, 'code', RescueFailureCode.unsupported)),
    );
  });

  test('bounds around a point stay inside the server limit', () {
    final bounds = RescueBounds.around(const GeoPoint(longitude: 121.5, latitude: 25.0));
    final values = bounds.toList();
    expect(values[2] - values[0], lessThanOrEqualTo(0.05));
    expect(values[3] - values[1], lessThanOrEqualTo(0.05));
  });

  test('failure messages are user facing and never echo the description', () {
    expect(const RescueFailure(code: RescueFailureCode.conflict, message: 'rescue_active_exists').userMessage(), '此裝置已有進行中的求救，請先更新或結束它');
    expect(const RescueFailure(code: RescueFailureCode.unsupported, message: 'x').userMessage(), '此環境無法安全簽署求救，未送出；仍可使用本機定位警報聲');
  });
}
```

- [ ] **Step 3: 執行測試確認失敗**

Run: `cd flutter; flutter test test/rescue_request_models_test.dart test/rescue_service_test.dart`
Expected: 編譯失敗（檔案不存在）

- [ ] **Step 4: 實作 `rescue_request_models.dart`**

```dart
import 'crowd_report_models.dart';
import 'map_models.dart';

const rescueNamespace = 'crowd.rescue';
const rescueEventType = 'RESCUE_REQUEST';
const rescueDescriptionMaxCodePoints = 160;
const rescuePeopleMax = 50;

/// Same bounds the contract enforces (pipeline/lib/crowd-common.mjs).
const _taiwanBounds = <double>[116.5, 20.5, 122.5, 26.8];

enum RescueRequestType { firstAidNeeded, immobile, trapped, trappedDebris, otherRescue }

extension RescueRequestTypeWire on RescueRequestType {
  String get wireValue => switch (this) {
    RescueRequestType.firstAidNeeded => 'FIRST_AID_NEEDED',
    RescueRequestType.immobile => 'IMMOBILE',
    RescueRequestType.trapped => 'TRAPPED',
    RescueRequestType.trappedDebris => 'TRAPPED_DEBRIS',
    RescueRequestType.otherRescue => 'OTHER_RESCUE',
  };

  String get label => switch (this) {
    RescueRequestType.firstAidNeeded => '需要醫療或急救協助',
    RescueRequestType.immobile => '無法移動',
    RescueRequestType.trapped => '受困',
    RescueRequestType.trappedDebris => '受困於瓦礫或倒塌建物下',
    RescueRequestType.otherRescue => '其他救援需求',
  };
}

RescueRequestType? rescueRequestTypeFromWire(Object? value) {
  for (final type in RescueRequestType.values) {
    if (type.wireValue == value) return type;
  }
  return null;
}

enum RescueSubject { self, others }

extension RescueSubjectWire on RescueSubject {
  String get wireValue => this == RescueSubject.self ? 'SELF' : 'OTHERS';
  String get label => this == RescueSubject.self ? '我自己' : '現場其他人';
}

enum TriageAnswer { yes, no, unknown }

extension TriageAnswerWire on TriageAnswer {
  String get wireValue => switch (this) {
    TriageAnswer.yes => 'YES',
    TriageAnswer.no => 'NO',
    TriageAnswer.unknown => 'UNKNOWN',
  };

  String get label => switch (this) {
    TriageAnswer.yes => '是',
    TriageAnswer.no => '否',
    TriageAnswer.unknown => '不確定',
  };
}

TriageAnswer? _answerFromWire(Object? value) {
  for (final answer in TriageAnswer.values) {
    if (answer.wireValue == value) return answer;
  }
  return null;
}

final class RescueTriage {
  const RescueTriage({
    this.immobile = TriageAnswer.unknown,
    this.breathingDifficulty = TriageAnswer.unknown,
    this.severeBleeding = TriageAnswer.unknown,
    this.conscious = TriageAnswer.unknown,
  });

  final TriageAnswer immobile;
  final TriageAnswer breathingDifficulty;
  final TriageAnswer severeBleeding;
  final TriageAnswer conscious;

  RescueTriage copyWith({
    TriageAnswer? immobile,
    TriageAnswer? breathingDifficulty,
    TriageAnswer? severeBleeding,
    TriageAnswer? conscious,
  }) => RescueTriage(
    immobile: immobile ?? this.immobile,
    breathingDifficulty: breathingDifficulty ?? this.breathingDifficulty,
    severeBleeding: severeBleeding ?? this.severeBleeding,
    conscious: conscious ?? this.conscious,
  );

  /// SELF requests are always recorded as conscious, as in the contract.
  TriageAnswer effectiveConscious(RescueSubject subject) =>
      subject == RescueSubject.self ? TriageAnswer.yes : conscious;

  Map<String, String> toWire(RescueSubject subject) => <String, String>{
    'immobile': immobile.wireValue,
    'breathing_difficulty': breathingDifficulty.wireValue,
    'severe_bleeding': severeBleeding.wireValue,
    'conscious': effectiveConscious(subject).wireValue,
  };

  static RescueTriage? fromWire(Object? value) {
    if (value is! Map) return null;
    final immobile = _answerFromWire(value['immobile']);
    final breathing = _answerFromWire(value['breathing_difficulty']);
    final bleeding = _answerFromWire(value['severe_bleeding']);
    final conscious = _answerFromWire(value['conscious']);
    if (immobile == null || breathing == null || bleeding == null || conscious == null) return null;
    return RescueTriage(
      immobile: immobile,
      breathingDifficulty: breathing,
      severeBleeding: bleeding,
      conscious: conscious,
    );
  }
}

enum RescueUrgency { critical, high, medium }

extension RescueUrgencyWire on RescueUrgency {
  String get wireValue => switch (this) {
    RescueUrgency.critical => 'CRITICAL',
    RescueUrgency.high => 'HIGH',
    RescueUrgency.medium => 'MEDIUM',
  };

  String get label => switch (this) {
    RescueUrgency.critical => '危急',
    RescueUrgency.high => '高',
    RescueUrgency.medium => '中',
  };

  String get badge => switch (this) {
    RescueUrgency.critical => '危',
    RescueUrgency.high => '高',
    RescueUrgency.medium => '中',
  };
}

RescueUrgency? rescueUrgencyFromWire(Object? value) {
  for (final urgency in RescueUrgency.values) {
    if (urgency.wireValue == value) return urgency;
  }
  return null;
}

/// Display copy of the contract's derivation; Android and the browser
/// recompute and verify it, so this only drives the form preview.
RescueUrgency deriveRescueUrgency(RescueRequestType type, RescueTriage triage, RescueSubject subject) {
  if (type == RescueRequestType.trappedDebris) return RescueUrgency.critical;
  if (triage.breathingDifficulty == TriageAnswer.yes ||
      triage.severeBleeding == TriageAnswer.yes ||
      triage.effectiveConscious(subject) == TriageAnswer.no) {
    return RescueUrgency.critical;
  }
  if (type == RescueRequestType.trapped || type == RescueRequestType.immobile || triage.immobile == TriageAnswer.yes) {
    return RescueUrgency.high;
  }
  return RescueUrgency.medium;
}

String rescueUrgencyReason(RescueRequestType type, RescueTriage triage, RescueSubject subject) {
  if (type == RescueRequestType.trappedDebris) return type.label;
  if (triage.breathingDifficulty == TriageAnswer.yes) return '呼吸困難';
  if (triage.severeBleeding == TriageAnswer.yes) return '大量出血';
  if (triage.effectiveConscious(subject) == TriageAnswer.no) return '失去意識';
  if (type == RescueRequestType.trapped) return '受困';
  if (type == RescueRequestType.immobile || triage.immobile == TriageAnswer.yes) return '無法移動';
  return '需要協助';
}

enum RescueStatus { active, resolved, cancelled }

extension RescueStatusWire on RescueStatus {
  String get wireValue => switch (this) {
    RescueStatus.active => 'ACTIVE',
    RescueStatus.resolved => 'RESOLVED',
    RescueStatus.cancelled => 'CANCELLED',
  };

  String get label => switch (this) {
    RescueStatus.active => '進行中',
    RescueStatus.resolved => '已安全／已獲救',
    RescueStatus.cancelled => '已取消',
  };
}

RescueStatus? rescueStatusFromWire(Object? value) {
  for (final status in RescueStatus.values) {
    if (status.wireValue == value) return status;
  }
  return null;
}

enum RescueAction { update, extend, resolve, cancel }

extension RescueActionWire on RescueAction {
  String get wireValue => switch (this) {
    RescueAction.update => 'UPDATE',
    RescueAction.extend => 'EXTEND',
    RescueAction.resolve => 'RESOLVE',
    RescueAction.cancel => 'CANCEL',
  };
}

const Object _unchanged = Object();

final class RescueDraft {
  const RescueDraft({
    required this.type,
    required this.subject,
    required this.peopleCount,
    required this.triage,
    required this.location,
    required this.locationSource,
    this.locationHint,
    required this.description,
  });

  factory RescueDraft.initial() => const RescueDraft(
    type: RescueRequestType.trappedDebris,
    subject: RescueSubject.self,
    peopleCount: 1,
    triage: RescueTriage(),
    location: null,
    locationSource: null,
    description: '',
  );

  factory RescueDraft.fromView(RescueRequestView view) {
    final geometry = view.event.geometry;
    return RescueDraft(
      type: view.type,
      subject: view.subject,
      peopleCount: view.peopleCount,
      triage: view.triage,
      location: geometry is PointGeometry ? geometry.point : null,
      locationSource: view.event.attributes?['location_source'] == 'MAP_PICK'
          ? CrowdReportLocationSource.mapPick
          : CrowdReportLocationSource.currentLocation,
      locationHint: null,
      description: view.description,
    );
  }

  final RescueRequestType type;
  final RescueSubject subject;
  final int peopleCount;
  final RescueTriage triage;
  final GeoPoint? location;
  final CrowdReportLocationSource? locationSource;
  final CrowdReportLocationHint? locationHint;
  final String description;

  RescueUrgency get urgency => deriveRescueUrgency(type, triage, subject);
  String get urgencyReason => rescueUrgencyReason(type, triage, subject);

  RescueDraft copyWith({
    RescueRequestType? type,
    RescueSubject? subject,
    int? peopleCount,
    RescueTriage? triage,
    Object? location = _unchanged,
    Object? locationSource = _unchanged,
    Object? locationHint = _unchanged,
    String? description,
  }) => RescueDraft(
    type: type ?? this.type,
    subject: subject ?? this.subject,
    peopleCount: peopleCount ?? this.peopleCount,
    triage: triage ?? this.triage,
    location: identical(location, _unchanged) ? this.location : location as GeoPoint?,
    locationSource: identical(locationSource, _unchanged)
        ? this.locationSource
        : locationSource as CrowdReportLocationSource?,
    locationHint: identical(locationHint, _unchanged)
        ? this.locationHint
        : locationHint as CrowdReportLocationHint?,
    description: description ?? this.description,
  );

  String? validate() {
    final point = location;
    if (point == null || locationSource == null) return '請選擇求救位置';
    if (!point.longitude.isFinite ||
        !point.latitude.isFinite ||
        point.longitude < _taiwanBounds[0] ||
        point.longitude > _taiwanBounds[2] ||
        point.latitude < _taiwanBounds[1] ||
        point.latitude > _taiwanBounds[3]) {
      return '求救位置不在支援範圍內';
    }
    if (peopleCount < 1 || peopleCount > rescuePeopleMax) return '人數需介於 1 到 50';
    if (description.trim().runes.length > rescueDescriptionMaxCodePoints) return '描述不可超過 160 字';
    return null;
  }

  Map<String, Object?> toArguments() {
    final error = validate();
    if (error != null) throw FormatException(error);
    final point = location!;
    return <String, Object?>{
      'request_type': type.wireValue,
      'subject': subject.wireValue,
      'people_count': peopleCount,
      'triage': triage.toWire(subject),
      'description': description.trim(),
      'location': <String, Object?>{
        'lon': point.longitude,
        'lat': point.latitude,
        'source': locationSource!.wireValue,
      },
      if (locationHint != null) 'location_hint': locationHint!.toChannelArguments(),
    };
  }
}

bool isRescueEvent(MeshEvent event) =>
    event.namespace == rescueNamespace && event.eventType == rescueEventType;

final class RescueRequestView {
  const RescueRequestView._({
    required this.event,
    required this.type,
    required this.status,
    required this.subject,
    required this.peopleCount,
    required this.triage,
    required this.description,
    required this.urgency,
    required this.firstIssuedAt,
    required this.expiresAt,
  });

  final MeshEvent event;
  final RescueRequestType type;
  final RescueStatus status;
  final RescueSubject subject;
  final int peopleCount;
  final RescueTriage triage;
  final String description;
  final RescueUrgency urgency;
  final DateTime firstIssuedAt;
  final DateTime expiresAt;

  String get eventId => event.eventId ?? '';

  static RescueRequestView? fromEvent(MeshEvent event) {
    if (!isRescueEvent(event)) return null;
    final attributes = event.attributes ?? const <String, dynamic>{};
    final type = rescueRequestTypeFromWire(attributes['request_type']);
    final status = rescueStatusFromWire(attributes['status']);
    final subject = switch (attributes['subject']) {
      'SELF' => RescueSubject.self,
      'OTHERS' => RescueSubject.others,
      _ => null,
    };
    final people = attributes['people_count'];
    final triage = RescueTriage.fromWire(attributes['triage']);
    final urgency = rescueUrgencyFromWire(event.severity);
    final first = DateTime.tryParse('${attributes['first_issued_at']}')?.toUtc();
    final expires = DateTime.tryParse(event.expiresAt ?? '')?.toUtc();
    if (type == null || status == null || subject == null || people is! int ||
        triage == null || urgency == null || first == null || expires == null) {
      return null;
    }
    final description = attributes['description'];
    return RescueRequestView._(
      event: event,
      type: type,
      status: status,
      subject: subject,
      peopleCount: people,
      triage: triage,
      description: description is String ? description : '',
      urgency: urgency,
      firstIssuedAt: first,
      expiresAt: expires,
    );
  }

  bool isActiveAt(DateTime now) => status == RescueStatus.active && expiresAt.isAfter(now.toUtc());

  /// Extension is allowed while active and before the 72 hour cap.
  bool canExtendAt(DateTime now) =>
      isActiveAt(now) && expiresAt.isBefore(firstIssuedAt.add(const Duration(hours: 72)));
}

enum RescueDelivery { meshPending, waitingUpload, uploading, accepted, rejected }

extension RescueDeliveryLabel on RescueDelivery {
  String get label => switch (this) {
    RescueDelivery.meshPending => '已存於本機，等待附近裝置轉傳',
    RescueDelivery.waitingUpload => '等待上傳，尚未送出',
    RescueDelivery.uploading => '上傳中',
    RescueDelivery.accepted => '伺服器已接收，仍未經查證',
    RescueDelivery.rejected => '未送出',
  };
}

const _reasonLabels = <String, String>{
  'rescue_active_exists': '此裝置已有進行中的求救',
  'network_unavailable': '目前無法連線',
  'server_unavailable': '伺服器尚未開放求救接收',
  'rate_limited': '送出太頻繁，稍後自動重試',
};

final class RescueSession {
  const RescueSession({
    required this.request,
    required this.meshPending,
    required this.server,
    this.reason,
  });

  final RescueRequestView request;

  /// Android only: stored in Room and waiting for nearby devices to relay it.
  final bool meshPending;
  final RescueDelivery server;
  final String? reason;

  factory RescueSession.fromMessage(Map<String, dynamic> message) {
    final raw = message['request'];
    if (raw is! Map) throw const FormatException('rescue session is missing request');
    final view = RescueRequestView.fromEvent(MeshEvent.fromJson(Map<String, dynamic>.from(raw)));
    if (view == null) throw const FormatException('rescue session request is not a rescue event');
    final delivery = message['delivery_state'];
    final meshPending = delivery == 'PENDING';
    final serverWire = meshPending ? message['server_state'] : delivery;
    final server = switch (serverWire) {
      'ACCEPTED' => RescueDelivery.accepted,
      'REJECTED' => RescueDelivery.rejected,
      'UPLOADING' => RescueDelivery.uploading,
      'WAITING_UPLOAD' || 'NOT_UPLOADED' => RescueDelivery.waitingUpload,
      _ => throw const FormatException('rescue session has an unknown delivery state'),
    };
    final reason = message['reason'] ?? message['server_reason'];
    return RescueSession(
      request: view,
      meshPending: meshPending,
      server: server,
      reason: reason is String ? reason : null,
    );
  }

  String deliveryText() {
    final reasonText = reason == null ? null : (_reasonLabels[reason] ?? reason);
    final serverText = server == RescueDelivery.rejected
        ? '未送出：${reasonText ?? '伺服器拒絕'}'
        : server.label;
    return meshPending ? '${RescueDelivery.meshPending.label}；伺服器：$serverText' : serverText;
  }
}
```

測試中 `deliveryText()` 的期望值與此一致（Android：`已存於本機，等待附近裝置轉傳；伺服器：等待上傳，尚未送出`；Web 被拒：`未送出：此裝置已有進行中的求救`）。

- [ ] **Step 5: `map_bridge.dart` 加 rescue 方法**

```dart
  /// Rescue requests. These rethrow the raw PlatformException /
  /// MissingPluginException; AndroidRescueService maps them to RescueFailure.
  Future<Map<String, dynamic>> submitRescueRequest(Map<String, Object?> request) =>
      _invokeRequiredMap('submitRescueRequest', request);

  Future<Map<String, dynamic>> reviseRescueRequest(
    String eventId,
    String action,
    Map<String, Object?>? request,
  ) => _invokeRequiredMap('reviseRescueRequest', <String, Object?>{
    'event_id': eventId,
    'action': action,
    'request': request,
  });

  Future<List<Map<String, dynamic>>> getOwnRescueRequests() async {
    final response = await _invokeRequiredMap('getOwnRescueRequests');
    final requests = response['requests'];
    if (requests is! List) throw const FormatException('getOwnRescueRequests response is missing requests');
    return requests.whereType<Map>().map((entry) => Map<String, dynamic>.from(entry)).toList(growable: false);
  }

  Future<Map<String, dynamic>> syncRescueNearby(List<double> bbox) =>
      _invokeRequiredMap('syncRescueNearby', <String, Object?>{'bbox': bbox});
```

`_invokeRequiredMap` 的參數型別是 `Map<String, dynamic>?`；`Map<String, Object?>` 可直接傳入。

- [ ] **Step 6: 實作 `rescue_service.dart`**

```dart
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'map_bridge.dart';
import 'map_models.dart';
import 'rescue_request_models.dart';
import 'rescue_web.dart';

enum RescueFailureCode {
  unsupported,
  invalidInput,
  conflict,
  rateLimited,
  signingUnavailable,
  storageUnavailable,
  serverUnavailable,
  unknown,
}

final class RescueFailure implements Exception {
  const RescueFailure({required this.code, required this.message, this.retryAfterSeconds});

  final RescueFailureCode code;

  /// A contract code or platform message; never shown verbatim when a
  /// friendlier sentence exists, and never contains the description.
  final String message;
  final int? retryAfterSeconds;

  String userMessage() => switch (code) {
    RescueFailureCode.unsupported => '此環境無法安全簽署求救，未送出；仍可使用本機定位警報聲',
    RescueFailureCode.invalidInput => '求救資料無效，未送出',
    RescueFailureCode.conflict => switch (message) {
      'rescue_active_exists' => '此裝置已有進行中的求救，請先更新或結束它',
      'rescue_revision_expired' => '這筆求救已過期，請重新建立',
      'rescue_extend_not_later' => '已達 72 小時上限，無法再延長，請重新建立',
      'rescue_revision_terminal' || 'rescue_terminal' => '這筆求救已結束',
      _ => '求救狀態已變更，請重新整理',
    },
    RescueFailureCode.rateLimited => '請稍候 ${retryAfterSeconds ?? 30} 秒再更新',
    RescueFailureCode.signingUnavailable => '裝置安全簽署不可用，求救未送出',
    RescueFailureCode.storageUnavailable => '無法儲存求救，未送出',
    RescueFailureCode.serverUnavailable => '伺服器尚未開放求救接收',
    RescueFailureCode.unknown => '求救未送出，請稍後再試',
  };

  @override
  String toString() => 'RescueFailure($code): $message';
}

final class RescueCapabilities {
  const RescueCapabilities({
    required this.canSign,
    required this.canVerify,
    required this.hasStorage,
    required this.supportsMesh,
  });

  final bool canSign;
  final bool canVerify;
  final bool hasStorage;
  final bool supportsMesh;
}

final class RescueBounds {
  const RescueBounds({required this.minLon, required this.minLat, required this.maxLon, required this.maxLat});

  /// The server accepts at most 0.05 degrees per side.
  factory RescueBounds.around(GeoPoint center, {double halfSpan = 0.024}) => RescueBounds(
    minLon: center.longitude - halfSpan,
    minLat: center.latitude - halfSpan,
    maxLon: center.longitude + halfSpan,
    maxLat: center.latitude + halfSpan,
  );

  final double minLon;
  final double minLat;
  final double maxLon;
  final double maxLat;

  List<double> toList() => <double>[minLon, minLat, maxLon, maxLat];
}

abstract class RescueService {
  Future<RescueCapabilities> capabilities();
  Future<RescueSession> submit(RescueDraft draft);
  Future<RescueSession> revise(String eventId, RescueAction action, {RescueDraft? draft});
  Future<List<RescueSession>> ownSessions();
  Future<List<RescueSession>> flush();

  /// Web: verified ACTIVE requests from the server, merged into the map.
  /// Android: asks the native side to download and ingest them through Room,
  /// so they arrive on the normal event stream; returns an empty list.
  Future<List<MeshEvent>> nearby(RescueBounds bounds);

  static RescueService forPlatform({required MapBridge bridge, bool? isWeb}) =>
      (isWeb ?? kIsWeb) ? WebRescueService() : AndroidRescueService(bridge);
}

final class AndroidRescueService implements RescueService {
  AndroidRescueService(this._bridge);

  final MapBridge _bridge;

  @override
  Future<RescueCapabilities> capabilities() async => const RescueCapabilities(
    canSign: true,
    canVerify: true,
    hasStorage: true,
    supportsMesh: true,
  );

  @override
  Future<RescueSession> submit(RescueDraft draft) =>
      _guard(() async => RescueSession.fromMessage(await _bridge.submitRescueRequest(draft.toArguments())));

  @override
  Future<RescueSession> revise(String eventId, RescueAction action, {RescueDraft? draft}) => _guard(
    () async => RescueSession.fromMessage(
      await _bridge.reviseRescueRequest(eventId, action.wireValue, draft?.toArguments()),
    ),
  );

  @override
  Future<List<RescueSession>> ownSessions() => _guard(
    () async => (await _bridge.getOwnRescueRequests()).map(RescueSession.fromMessage).toList(growable: false),
  );

  @override
  Future<List<RescueSession>> flush() => ownSessions();

  @override
  Future<List<MeshEvent>> nearby(RescueBounds bounds) async {
    await _guard(() => _bridge.syncRescueNearby(bounds.toList()));
    return const <MeshEvent>[];
  }

  Future<T> _guard<T>(Future<T> Function() run) async {
    try {
      return await run();
    } on MissingPluginException {
      throw const RescueFailure(code: RescueFailureCode.unsupported, message: 'native rescue bridge unavailable');
    } on PlatformException catch (error) {
      final details = error.details;
      final retry = details is Map ? details['retry_after_seconds'] : null;
      throw RescueFailure(
        code: switch (error.code) {
          'invalid_input' => RescueFailureCode.invalidInput,
          'conflict' => RescueFailureCode.conflict,
          'rate_limited' => RescueFailureCode.rateLimited,
          'signing_unavailable' => RescueFailureCode.signingUnavailable,
          'storage_unavailable' => RescueFailureCode.storageUnavailable,
          'server_unavailable' => RescueFailureCode.serverUnavailable,
          _ => RescueFailureCode.unknown,
        },
        message: error.message ?? error.code,
        retryAfterSeconds: retry is int ? retry : null,
      );
    } on FormatException catch (error) {
      throw RescueFailure(code: RescueFailureCode.invalidInput, message: error.message);
    }
  }
}

final class WebRescueService implements RescueService {
  @override
  Future<RescueCapabilities> capabilities() async {
    try {
      final map = await webRescueCall('capabilities') as Map<String, dynamic>;
      return RescueCapabilities(
        canSign: map['signing'] == true,
        canVerify: map['verifying'] == true,
        hasStorage: map['storage'] == true,
        supportsMesh: false,
      );
    } on WebRescueError {
      // Script missing or broken: report the real limitation, never assume support.
      return const RescueCapabilities(canSign: false, canVerify: false, hasStorage: false, supportsMesh: false);
    }
  }

  @override
  Future<RescueSession> submit(RescueDraft draft) => _guard(
    () async => RescueSession.fromMessage(
      await webRescueCall('submit', <Object?>[draft.toArguments()]) as Map<String, dynamic>,
    ),
  );

  @override
  Future<RescueSession> revise(String eventId, RescueAction action, {RescueDraft? draft}) => _guard(
    () async => RescueSession.fromMessage(
      await webRescueCall('revise', <Object?>[eventId, action.wireValue, draft?.toArguments()]) as Map<String, dynamic>,
    ),
  );

  @override
  Future<List<RescueSession>> ownSessions() => _sessions('own');

  @override
  Future<List<RescueSession>> flush() => _sessions('flush');

  @override
  Future<List<MeshEvent>> nearby(RescueBounds bounds) => _guard(() async {
    final map = await webRescueCall('nearby', <Object?>[bounds.toList()]) as Map<String, dynamic>;
    final events = map['events'];
    if (events is! List) return const <MeshEvent>[];
    return events.whereType<Map>().map((event) => MeshEvent.fromJson(Map<String, dynamic>.from(event))).toList(growable: false);
  });

  Future<List<RescueSession>> _sessions(String operation) => _guard(() async {
    final list = await webRescueCall(operation) as List<dynamic>;
    return list.whereType<Map>().map((entry) => RescueSession.fromMessage(Map<String, dynamic>.from(entry))).toList(growable: false);
  });

  Future<T> _guard<T>(Future<T> Function() run) async {
    try {
      return await run();
    } on WebRescueError catch (error) {
      final code = error.code;
      if (code.startsWith('rate_limited:')) {
        throw RescueFailure(
          code: RescueFailureCode.rateLimited,
          message: code,
          retryAfterSeconds: int.tryParse(code.substring('rate_limited:'.length)),
        );
      }
      throw RescueFailure(
        code: switch (code) {
          'signing_unsupported' || 'rescue_web_unavailable' => RescueFailureCode.unsupported,
          'storage_unavailable' => RescueFailureCode.storageUnavailable,
          'server_unavailable' => RescueFailureCode.serverUnavailable,
          final value when value.startsWith('rescue_field_invalid') || value == 'rescue_geometry_invalid' =>
            RescueFailureCode.invalidInput,
          'rescue_active_exists' || 'rescue_not_found' || 'rescue_revision_expired' || 'rescue_extend_not_later' ||
          'rescue_revision_terminal' || 'rescue_revision_wrong_device' => RescueFailureCode.conflict,
          _ => RescueFailureCode.unknown,
        },
        message: code,
      );
    }
  }
}
```

- [ ] **Step 7: Web 呼叫層（conditional import）**

`flutter/lib/data/rescue_web.dart`：

```dart
import 'rescue_web_stub.dart'
    if (dart.library.js_interop) 'rescue_web_web.dart'
    as implementation;

/// Error thrown by the browser rescue script; [code] is a contract code.
final class WebRescueError implements Exception {
  const WebRescueError(this.code);

  final String code;

  @override
  String toString() => 'WebRescueError($code)';
}

/// Calls one function of flutter/web/rescue_outbox.js and decodes its JSON.
/// [operation] is capabilities | submit | revise | own | flush | nearby.
Future<Object?> webRescueCall(String operation, [List<Object?> arguments = const <Object?>[]]) =>
    implementation.webRescueCall(operation, arguments);
```

`flutter/lib/data/rescue_web_stub.dart`：

```dart
import 'rescue_web.dart';

Future<Object?> webRescueCall(String operation, List<Object?> arguments) =>
    Future<Object?>.error(const WebRescueError('rescue_web_unavailable'));
```

`flutter/lib/data/rescue_web_web.dart`：

```dart
import 'dart:convert';
import 'dart:js_interop';

import 'rescue_web.dart';

@JS('rescueCapabilities')
external JSPromise<JSString> _capabilities();

@JS('rescueSubmit')
external JSPromise<JSString> _submit(JSString argsJson);

@JS('rescueRevise')
external JSPromise<JSString> _revise(JSString eventId, JSString action, JSString argsJson);

@JS('rescueOwnSessions')
external JSPromise<JSString> _own();

@JS('rescueFlush')
external JSPromise<JSString> _flush();

@JS('rescueNearby')
external JSPromise<JSString> _nearby(JSString bboxJson);

/// Every rescue_outbox.js export resolves to `{ ok, value | error }` and
/// never rejects, so no JS exception has to cross into Dart.
Future<Object?> webRescueCall(String operation, List<Object?> arguments) async {
  final JSPromise<JSString> promise = switch (operation) {
    'capabilities' => _capabilities(),
    'submit' => _submit(jsonEncode(arguments[0]).toJS),
    'revise' => _revise(
      (arguments[0] as String).toJS,
      (arguments[1] as String).toJS,
      (arguments[2] == null ? '' : jsonEncode(arguments[2])).toJS,
    ),
    'own' => _own(),
    'flush' => _flush(),
    'nearby' => _nearby(jsonEncode(arguments[0]).toJS),
    _ => throw ArgumentError.value(operation, 'operation'),
  };
  final envelope = jsonDecode((await promise.toDart).toDart);
  if (envelope is! Map || envelope['ok'] is! bool) throw const WebRescueError('rescue_web_unavailable');
  if (envelope['ok'] != true) throw WebRescueError('${envelope['error']}');
  return envelope['value'];
}
```

`rescue_web.dart` 與兩個實作互相 import，Dart 允許；`WebRescueError` 定義在 `rescue_web.dart`。若頁面沒載入 `rescue_outbox.js`，`@JS` 函式不存在，呼叫會在 Dart 端拋出 `NoSuchMethodError`／`TypeError`；`webRescueCall` 外層再包一層 `try { ... } on Object { throw const WebRescueError('rescue_web_unavailable'); }`（只包 `switch` 建立 promise 的部分，不包信封解析），讓 UI 顯示「此環境無法安全簽署求救」。

- [ ] **Step 8: 執行測試確認通過**

Run: `cd flutter; flutter test test/rescue_request_models_test.dart test/rescue_service_test.dart; flutter analyze`
Expected: PASS；analyze 無新警告

- [ ] **Step 9: Commit**

```bash
git add flutter/lib/data/rescue_request_models.dart flutter/lib/data/rescue_service.dart flutter/lib/data/rescue_web.dart flutter/lib/data/rescue_web_stub.dart flutter/lib/data/rescue_web_web.dart flutter/lib/data/map_bridge.dart flutter/test/rescue_request_models_test.dart flutter/test/rescue_service_test.dart
git commit -m "feat(flutter): shared rescue models and platform rescue services"
```
