import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

import { generateEd25519KeyPair } from '../lib/crypto.mjs';
import { buildGovernmentFeed } from '../lib/government-feed.mjs';

const staticScript = await readFile(new URL('../../flutter/web/nlsc_static_layers.js', import.meta.url), 'utf8');
const feedScript = await readFile(
  new URL('../../flutter/web/nlsc_government_feed.js', import.meta.url),
).catch(() => '');
const now = new Date('2026-10-04T00:00:00.000Z');

function buildRelease({ retracted = false, events = true, severity = 'HIGH' } = {}) {
  const keys = generateEd25519KeyPair();
  const event = {
    schema_version: 'event-v0',
    namespace: 'official.live.ncdr',
    event_id: 'ncdr:web-test',
    event_type: 'NCDR_HAZARD',
    severity,
    source: 'NCDR',
    source_version: now.toISOString(),
    event_version: 1,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 86_400_000).toISOString(),
    geometry: { type: 'Point', coordinates: [121.5, 25.0] },
    attributes: {
      area_id: 'tw.63000100',
      theme: 'hazard',
      publication_retracted: retracted,
    },
    provenance: {
      original_source: 'ncdr',
      received_at: now.toISOString(),
      transport_source: { kind: 'server', node_id: 'test' },
    },
  };
  const output = buildGovernmentFeed({
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    signingKeyId: 'central-server-2026',
    now,
    results: [{ id: 'ncdr', status: 'ok', events: events ? [event] : [] }],
  });
  return { keys, output };
}

function buildCwaRelease() {
  const keys = generateEd25519KeyPair();
  const cwaSourceIds = ['cwa-earthquake', 'cwa-warning', 'cwa-typhoon'];
  const results = cwaSourceIds.map((id) => ({
    id,
    status: 'ok',
    events: [{
      schema_version: 'event-v0',
      namespace: 'official.cwa',
      event_id: `${id}:web-test`,
      event_type: 'CWA_WARNING',
      severity: 'HIGH',
      source: 'CWA',
      source_version: now.toISOString(),
      event_version: 1,
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 86_400_000).toISOString(),
      geometry: { type: 'Point', coordinates: [121.5, 25.0] },
      attributes: {
        area_id: 'tw.63000100',
        theme: id,
        map_visible: false,
      },
      provenance: {
        original_source: id,
        received_at: now.toISOString(),
        transport_source: { kind: 'server', node_id: 'test' },
      },
    }],
  }));
  const output = buildGovernmentFeed({
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    signingKeyId: 'central-server-2026',
    now,
    results,
  });
  return { keys, output, cwaSourceIds };
}

function browserContext(publicKey, responses = {}, { indexedDB, now = Date.now(), timers = [] } = {}) {
  const encoded = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const currentNow = () => (typeof now === 'function' ? now() : now);
  class BrowserDate extends Date {
    constructor(...args) {
      super(...(args.length === 0 ? [currentNow()] : args));
    }

    static now() { return currentNow(); }
  }
  Object.setPrototypeOf(BrowserDate, Date);
  const context = vm.createContext({
    crypto: webcrypto,
    TextEncoder,
    URL,
    Date: BrowserDate,
    Uint8Array,
    Array,
    Object,
    JSON,
    Math,
    setTimeout: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timers.length;
    },
    clearTimeout: () => {},
    Error,
    TypeError,
    RangeError,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    globalThis: undefined,
    location: { origin: 'https://map.example.test' },
    indexedDB,
    fetch: async (input) => {
      const pathname = new URL(String(input), 'https://map.example.test').pathname;
      if (pathname === '/assets/assets/data/trusted-keys.json') {
        return {
          ok: true,
          json: async () => ({ 'central-server-2026': encoded }),
        };
      }
      if (!Object.hasOwn(responses, pathname)) return { ok: false, text: async () => '' };
      const value = responses[pathname];
      return {
        ok: true,
        text: async () => JSON.stringify(value),
      };
    },
  });
  vm.runInContext('globalThis = globalThis ?? this', context);
  vm.runInContext(staticScript, context);
  vm.runInContext(feedScript, context);
  return context;
}

function memoryIndexedDB() {
  const databases = new Map();
  return {
    snapshot(name, storeName, key) {
      return structuredClone(databases.get(name)?.stores?.get(storeName)?.get(key));
    },
    open(name) {
      const request = {};
      queueMicrotask(() => {
        let database = databases.get(name);
        const isNew = database === undefined;
        if (isNew) {
          const stores = new Map();
          database = {
            stores,
            createObjectStore(storeName) {
              stores.set(storeName, new Map());
            },
            transaction(storeName) {
              const store = stores.get(storeName);
              const transaction = {};
              transaction.objectStore = () => ({
                get(key) {
                  const result = { result: store.get(key) };
                  queueMicrotask(() => result.onsuccess?.());
                  return result;
                },
                put(value, key) {
                  store.set(key, structuredClone(value));
                  queueMicrotask(() => transaction.oncomplete?.());
                },
                delete(key) {
                  store.delete(key);
                  queueMicrotask(() => transaction.oncomplete?.());
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

function browserVerifier(publicKey) {
  const context = browserContext(publicKey);
  const verify = context.ResilientGeoGovernmentFeed?.verifyGovernmentFeedRelease;
  assert.equal(typeof verify, 'function', 'Web must install the signed government-feed verifier');
  return verify;
}

function chunkDocuments(output) {
  return output.feed.datasets.flatMap((dataset) => dataset.chunk_paths.map((path) => ({
    path,
    chunk: output.files.get(path),
  })));
}

test('browser verifies the Server-signed release and returns active alerts', async () => {
  const { keys, output } = buildRelease();
  const verify = browserVerifier(keys.publicKey);

  const release = await verify(output.feed, chunkDocuments(output), { now });

  assert.equal(release.revision, 1);
  assert.equal(release.events.length, 1);
  assert.equal(release.events[0].event_id, 'ncdr:web-test');
});

test('browser accepts MEDIUM severity from the signed event-v0 contract', async () => {
  const { keys, output } = buildRelease({ severity: 'MEDIUM' });
  const release = await browserVerifier(keys.publicKey)(output.feed, chunkDocuments(output), { now });

  assert.equal(release.events.length, 1);
  assert.equal(release.events[0].severity, 'MEDIUM');
});

test('browser accepts UNKNOWN severity from the signed event-v0 contract', async () => {
  const { keys, output } = buildRelease({ severity: 'UNKNOWN' });
  const release = await browserVerifier(keys.publicKey)(output.feed, chunkDocuments(output), { now });

  assert.equal(release.events.length, 1);
  assert.equal(release.events[0].severity, 'UNKNOWN');
});

test('browser rejects NORMAL severity because it is outside the signed event-v0 contract', async () => {
  const { keys, output } = buildRelease({ severity: 'NORMAL' });
  const verify = browserVerifier(keys.publicKey);

  await assert.rejects(verify(output.feed, chunkDocuments(output), { now }), /告警事件欄位不符/u);
});

test('browser loader downloads and verifies the same-origin signed Server feed', async () => {
  const { keys, output } = buildRelease();
  const firstChunk = output.feed.datasets[0].chunk_paths[0];
  const responses = {
    '/feed.json': output.feed,
    [`/${firstChunk}`]: output.files.get(firstChunk),
  };
  const context = browserContext(keys.publicKey, responses, { now: now.getTime() });

  const result = JSON.parse(await context.loadNLSCGovernmentFeed());

  assert.equal(result.revision, 1);
  assert.equal(result.stale, false);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].event_id, 'ncdr:web-test');
});

test('browser verifies and caches all three CWA official event feeds', async () => {
  const { keys, output, cwaSourceIds } = buildCwaRelease();
  const responses = { '/feed.json': output.feed };
  for (const dataset of output.feed.datasets) {
    for (const path of dataset.chunk_paths) responses[`/${path}`] = output.files.get(path);
  }
  const storage = memoryIndexedDB();
  const onlineContext = browserContext(keys.publicKey, responses, {
    indexedDB: storage,
    now: now.getTime(),
  });

  const online = JSON.parse(await onlineContext.loadNLSCGovernmentFeed());

  assert.equal(online.events.length, 3);
  assert.deepEqual(online.events.map((event) => event.namespace),
    cwaSourceIds.map((sourceId) => `official.live.${sourceId}`));
  assert.equal(online.events.every((event) => event.source === 'CWA'), true);

  const offlineContext = browserContext(keys.publicKey, {}, {
    indexedDB: storage,
    now: now.getTime(),
  });
  const offline = JSON.parse(await offlineContext.loadNLSCGovernmentFeed());
  assert.equal(offline.stale, true);
  assert.equal(offline.events.length, 3);
});

test('a zero-alert Server update replaces cached alerts and stays empty offline', async () => {
  const { keys, output: first } = buildRelease();
  const priorEvents = [...first.files.values()].flatMap((chunk) => chunk.events);
  const zero = buildGovernmentFeed({
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    signingKeyId: 'central-server-2026',
    previous: first.feed,
    previousEvents: { ncdr: priorEvents },
    now: new Date('2026-10-06T00:00:00.000Z'),
    results: [{ id: 'ncdr', status: 'ok', events: [] }],
  });
  const storage = memoryIndexedDB();
  const firstPath = first.feed.datasets[0].chunk_paths[0];
  const firstContext = browserContext(keys.publicKey, {
    '/feed.json': first.feed,
    [`/${firstPath}`]: first.files.get(firstPath),
  }, { indexedDB: storage, now: now.getTime() });
  assert.equal(JSON.parse(await firstContext.loadNLSCGovernmentFeed()).events.length, 1);

  const zeroContext = browserContext(keys.publicKey, { '/feed.json': zero.feed }, {
    indexedDB: storage,
    now: Date.parse('2026-10-06T00:00:00.000Z'),
  });
  const onlineEmpty = JSON.parse(await zeroContext.loadNLSCGovernmentFeed());
  assert.equal(onlineEmpty.revision, 2);
  assert.equal(onlineEmpty.stale, false);
  assert.equal(onlineEmpty.events.length, 0);

  const offlineContext = browserContext(keys.publicKey, {}, {
    indexedDB: storage,
    now: Date.parse('2026-10-06T00:00:00.000Z'),
  });
  const offline = JSON.parse(await offlineContext.loadNLSCGovernmentFeed());
  assert.equal(offline.revision, 2);
  assert.equal(offline.stale, true);
  assert.equal(offline.events.length, 0);
});

test('an expired alert is removed from IndexedDB while the page remains open', async () => {
  const { keys, output } = buildRelease();
  const path = output.feed.datasets[0].chunk_paths[0];
  const storage = memoryIndexedDB();
  const timers = [];
  let currentNow = now.getTime();
  const context = browserContext(keys.publicKey, {
    '/feed.json': output.feed,
    [`/${path}`]: output.files.get(path),
  }, { indexedDB: storage, now: () => currentNow, timers });

  const result = JSON.parse(await context.loadNLSCGovernmentFeed());
  assert.equal(result.events.length, 1);
  assert.equal(timers.length, 1);
  assert.equal(storage.snapshot('resilientgeo-government-feed-v1', 'releases', 'current').events.length, 1);

  currentNow = Date.parse('2026-10-05T00:00:01.000Z');
  timers[0].callback();
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline &&
      storage.snapshot('resilientgeo-government-feed-v1', 'releases', 'current')?.events?.length !== 0) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const cached = storage.snapshot('resilientgeo-government-feed-v1', 'releases', 'current');
  assert.equal(cached.events.length, 0);
  assert.ok(cached.feed.event_versions['official.live.ncdr/ncdr:web-test']);
});

test('browser accepts a signed zero-alert feed and returns no active alerts', async () => {
  const { keys, output } = buildRelease({ events: false });
  const verify = browserVerifier(keys.publicKey);

  const release = await verify(output.feed, chunkDocuments(output), { now });

  assert.equal(output.feed.datasets.length, 0);
  assert.equal(release.events.length, 0);
});

test('browser excludes a signed alert retraction from the active list', async () => {
  const { keys, output } = buildRelease({ retracted: true });
  const verify = browserVerifier(keys.publicKey);

  const release = await verify(output.feed, chunkDocuments(output), { now });

  assert.equal(release.events.length, 0);
});

test('browser rejects a changed alert payload inside a signed chunk', async () => {
  const { keys, output } = buildRelease();
  const documents = chunkDocuments(output);
  documents[0].chunk.events[0].attributes.theme = 'changed';
  const verify = browserVerifier(keys.publicKey);

  await assert.rejects(() => verify(output.feed, documents, { now }), /簽章|雜湊/u);
});
