import assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateEd25519KeyPair } from '../../pipeline/lib/crypto.mjs';
import { buildGovernmentFeed } from '../../pipeline/lib/government-feed.mjs';
import { buildGovernmentFeedV2 } from '../../pipeline/lib/government-feed-v2.mjs';
import { buildApp } from '../src/app.mjs';

const keys = generateEd25519KeyPair();
const signingKeyId = 'server-api-test';
const now = new Date('2026-10-02T12:00:00Z');
const event = {
  schema_version: 'event-v0',
  event_id: 'road:api-test',
  event_type: 'ROAD_CLOSURE',
  source: 'TDX',
  source_version: 'api-test',
  severity: 'NORMAL',
  geometry: { type: 'Point', coordinates: [121.505, 25.005] },
  issued_at: now.toISOString(),
  expires_at: '2026-10-03T12:00:00Z',
  attributes: { area_id: 'tw.63000100', theme: 'road', status: 'CLOSED' },
};
const built = buildGovernmentFeed({
  privateKey: keys.privateKey,
  publicKey: keys.publicKey,
  signingKeyId,
  now,
  results: [{ id: 'tdx-road', status: 'ok', events: [event] }],
});
const feed = built.feed;
const emptyFeed = buildGovernmentFeed({
  privateKey: keys.privateKey,
  publicKey: keys.publicKey,
  signingKeyId,
  now: new Date(Date.now() - 1_000),
  results: [{ id: 'tdx-road', status: 'ok', events: [] }],
}).feed;
const governmentChunk = [...built.files.values()][0];
const builtV2 = buildGovernmentFeedV2({
  events: [event],
  revision: feed.revision,
  createdAt: now,
  expiresAt: new Date('2026-10-03T12:00:00Z'),
  signingKeyId,
  privateKey: keys.privateKey,
});
const v2ChunkEntry = builtV2.manifest.chunks[0];
const v2Chunk = builtV2.files.get(v2ChunkEntry.path);
const layerManifest = {
  schema_version: 'layer-manifest-v0',
  manifest_id: 'taiwan-shelter:manifest:1',
  dataset_id: 'resilientgeo-taiwan',
  layer_id: 'taiwan-shelter',
  namespace: 'official.shelter',
  source: 'taiwan-shelter',
  source_version: 'api-test',
  dataset_version: 1,
  created_at: now.toISOString(),
  expires_at: '2026-10-03T12:00:00Z',
  chunks: [{ sequence: 0, chunk_id: 'taiwan-shelter:chunk:1:000' }],
};
const layerChunk = { schema_version: 'layer-chunk-v0', sequence: 0, features: [] };

function makeStore({ currentFeed = feed } = {}) {
  const calls = [];
  return {
    calls,
    async readFeed() {
      calls.push('readFeed');
      if (!currentFeed) {
        const error = new Error('missing current feed');
        error.code = 'ENOENT';
        throw error;
      }
      return currentFeed;
    },
    async readGovernmentChunk(revision, source, chunk) {
      calls.push(['readGovernmentChunk', revision, source, chunk]);
      return governmentChunk;
    },
    async readLayerManifest(layerId) {
      calls.push(['readLayerManifest', layerId]);
      if (layerId !== 'taiwan-shelter') {
        const error = new Error('missing layer');
        error.code = 'ENOENT';
        throw error;
      }
      return layerManifest;
    },
    async readLayerChunk(layerId, chunk) {
      calls.push(['readLayerChunk', layerId, chunk]);
      if (layerId !== 'taiwan-shelter' || chunk !== '0.json') throw new Error('unknown chunk');
      return layerChunk;
    },
    async readV2Feed() {
      calls.push('readV2Feed');
      return builtV2.manifest;
    },
    async readV2Chunk(hash) {
      calls.push(['readV2Chunk', hash]);
      if (hash !== v2ChunkEntry.sha256.slice('sha256:'.length)) throw new Error('unknown v2 chunk');
      return v2Chunk;
    },
  };
}

function appOptions(store, sourceStates = []) {
  return {
    config: {
      signingPublicKey: keys.publicKey,
      signingKeyId,
      serverVersion: 'test-build',
    },
    releaseStore: store,
    sourceStateStore: { async list() { return sourceStates; } },
    logger: false,
  };
}

test('health stays live without a feed while readiness requires a valid signed feed', async () => {
  const missing = makeStore({ currentFeed: null });
  const app = buildApp(appOptions(missing));
  try {
    const health = await app.inject('/healthz');
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: 'ok' });
    const ready = await app.inject('/readyz');
    assert.equal(ready.statusCode, 503);

    const invalid = structuredClone(feed);
    invalid.signature = 'invalid';
    const invalidApp = buildApp(appOptions(makeStore({ currentFeed: invalid })));
    try {
      const invalidReady = await invalidApp.inject('/readyz');
      assert.equal(invalidReady.statusCode, 503);
    } finally {
      await invalidApp.close();
    }

    const emptyApp = buildApp(appOptions(makeStore({ currentFeed: emptyFeed })));
    try {
      const emptyReady = await emptyApp.inject('/readyz');
      assert.equal(emptyReady.statusCode, 200);
      assert.equal(emptyReady.json().status, 'ready');
      assert.equal(emptyReady.json().feed_revision, emptyFeed.revision);
    } finally {
      await emptyApp.close();
    }
  } finally {
    await app.close();
  }
});

test('feed and chunk routes expose cache and content-safety headers without upstream calls', async () => {
  const store = makeStore();
  const app = buildApp(appOptions(store));
  try {
    const response = await app.inject('/feed.json');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assert.match(response.headers.etag, /^"/u);
    assert.equal(response.headers['last-modified'], new Date(feed.created_at).toUTCString());
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.match(response.headers['cache-control'], /public/u);

    const chunkPath = feed.datasets[0].chunk_paths[0].split('/');
    const chunk = await app.inject(`/releases/${chunkPath[1]}/${chunkPath[2]}/${chunkPath[3]}`);
    assert.equal(chunk.statusCode, 200);
    assert.deepEqual(chunk.json(), governmentChunk);
    assert.equal(store.calls.filter((call) => call[0] === 'readGovernmentChunk').length, 1);
  } finally {
    await app.close();
  }
});

test('v2 manifest and immutable chunks are available through hash-only routes', async () => {
  const store = makeStore();
  const app = buildApp(appOptions(store));
  const hash = v2ChunkEntry.sha256.slice('sha256:'.length);
  try {
    const manifest = await app.inject('/v2/feed.json');
    assert.equal(manifest.statusCode, 200);
    assert.deepEqual(manifest.json(), builtV2.manifest);
    const chunk = await app.inject(`/v2/chunks/${hash}.json`);
    assert.equal(chunk.statusCode, 200);
    assert.deepEqual(chunk.json(), v2Chunk);
    assert.equal((await app.inject(`/v2/chunks/${'g'.repeat(64)}.json`)).statusCode, 404);
    assert.equal((await app.inject('/v2/chunks/not-a-hash.json')).statusCode, 404);
  } finally {
    await app.close();
  }
});

test('layer routes enforce registry and numeric chunk allowlists', async () => {
  const store = makeStore();
  const app = buildApp(appOptions(store));
  try {
    assert.equal((await app.inject('/v1/layers/taiwan-shelter/manifest.json')).statusCode, 200);
    assert.equal((await app.inject('/v1/layers/taiwan-shelter/chunks/0.json')).statusCode, 200);
    assert.equal((await app.inject('/v1/layers/unknown/manifest.json')).statusCode, 404);
    assert.equal((await app.inject('/v1/layers/taiwan-shelter/chunks/not-a-number.json')).statusCode, 404);
    assert.equal((await app.inject('/v1/layers/taiwan-shelter/chunks/0/secret.json')).statusCode, 404);
    assert.equal((await app.inject('/v1/layers/taiwan-shelter/chunks/%2e%2e%2f0.json')).statusCode, 404);
  } finally {
    await app.close();
  }
});

test('source status and metadata expose only sanitized public fields', async () => {
  const store = makeStore();
  const app = buildApp(appOptions(store, [{
    source_id: 'taiwan-medical',
    status: 'ok',
    checked_at: now.toISOString(),
    retrieved_at: now.toISOString(),
    last_success_at: now.toISOString(),
    error_code: null,
    revision: feed.revision,
    query_count: 12,
    successful_query_count: 10,
    failed_query_count: 2,
    failed_fallback_source_count: 0,
    candidate_count: 8,
    matched_count: 5,
    unresolved_count: 3,
    rejected_coordinate_count: 1,
    coordinate_source_ids: ['nlsc-medical-coordinates', 'official-doorplate:10007'],
    unresolved_reason_counts: {
      no_coordinate_candidate: 1,
      name_address_mismatch: 2,
      multiple_candidates: 0,
      source_missing: 0,
      secret_reason: 'must not pass through',
    },
    emergency_hospital_count: 15,
    emergency_located_count: 10,
    emergency_unresolved_count: 5,
    emergency_medical_source_version: 'mohw-emergency-v1',
    emergency_medical_coverage: 'partial',
    emergency_unresolved_reason_counts: {
      no_coordinate_candidate: 3,
      name_address_mismatch: 1,
      multiple_candidates: 1,
      source_missing: 0,
      source_record: { token: 'secret' },
    },
    path: '/private/source-cache/tdx-road-events/raw.json',
    request_url: 'https://example.test/?api_key=secret',
    stack: 'secret stack trace',
  }]));
  try {
    const status = await app.inject('/v1/source-status');
    assert.equal(status.statusCode, 200);
    const source = status.json().sources[0];
    assert.deepEqual(Object.keys(source).sort(), [
      'candidate_count', 'checked_at', 'coordinate_source_ids', 'coverage', 'error_code', 'failed_fallback_source_count',
      'failed_query_count',
      'emergency_hospital_count', 'emergency_located_count', 'emergency_medical_coverage',
      'emergency_medical_source_version', 'emergency_unresolved_count', 'emergency_unresolved_reason_counts',
      'last_success_at', 'matched_count', 'query_count', 'rejected_coordinate_count', 'retrieved_at', 'successful_query_count',
      'revision', 'source_id', 'status', 'unresolved_count', 'unresolved_reason_counts',
    ].sort());
    assert.deepEqual(source.emergency_unresolved_reason_counts, {
      no_coordinate_candidate: 3,
      name_address_mismatch: 1,
      multiple_candidates: 1,
      source_missing: 0,
    });
    assert.deepEqual(source.coordinate_source_ids, ['nlsc-medical-coordinates', 'official-doorplate:10007']);
    assert.equal(JSON.stringify(status.json()).includes('secret'), false);

    const metadata = await app.inject('/v1/metadata');
    assert.equal(metadata.statusCode, 200);
    assert.equal(metadata.json().feed_revision, feed.revision);
    assert.equal(metadata.json().layers[0].layer_id, 'taiwan-shelter');
    assert.equal(JSON.stringify(metadata.json()).includes('/private'), false);
  } finally {
    await app.close();
  }
});
