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
