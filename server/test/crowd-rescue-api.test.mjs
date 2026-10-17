import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { signEvent } from '../../pipeline/lib/contract.mjs';
import { buildCrowdChunk } from '../../pipeline/lib/crowd-report.mjs';
import { buildRescueRequest, buildRescueRevision } from '../../pipeline/lib/rescue-request.mjs';
import { buildApp } from '../src/app.mjs';
import { createRateLimiter } from '../src/rate-limit.mjs';
import { createFileRescueStore } from '../src/storage/crowd-rescue-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = JSON.parse(await readFile(path.join(ROOT, 'fixtures/rescue-requests-v0.json'), 'utf8'));
const NOW = new Date('2026-10-12T04:00:00Z');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function keys(label) {
  const seed = Buffer.alloc(32);
  Buffer.from(label, 'utf8').copy(seed);
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

const releaseStore = { async readFeed() { throw Object.assign(new Error('none'), { code: 'ENOENT' }); } };
const eventCase = (name) => fixture.event_cases.find((entry) => entry.name === name).event;
const v1 = eventCase('valid_v1');
const v2 = eventCase('valid_v2_update');
const device = keys(fixture.seeds.device);
/** What clients actually upload: the event wrapped in a chunk signed by its own device key. */
const chunkOf = (event, signer = device) => buildCrowdChunk(event, signer.privateKey);

async function withApp(run, { clock = () => NOW } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rescue-api-'));
  const app = buildApp({
    releaseStore,
    rescueStore: createFileRescueStore({ root }),
    rescueOptions: { now: clock, rateLimiter: createRateLimiter({ now: () => clock().getTime() }), listCacheMs: 0 },
  });
  try {
    await run(app);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

const post = (app, body, headers = {}) => app.inject({
  method: 'POST',
  url: '/v1/crowd/rescue-events',
  headers: { 'content-type': 'application/json', ...headers },
  payload: typeof body === 'string' ? body : JSON.stringify(body),
});

test('accepts a new request once, then treats a replay as idempotent', async () => {
  await withApp(async (app) => {
    const first = await post(app, chunkOf(v1));
    assert.equal(first.statusCode, 201);
    assert.deepEqual(first.json(), { result: 'accepted', event_id: v1.event_id, event_version: 1 });
    const replay = await post(app, chunkOf(v1));
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().result, 'already_accepted');
    assert.equal((await post(app, chunkOf(v2))).statusCode, 201);
    const rollback = await post(app, chunkOf(v1));
    assert.equal(rollback.statusCode, 409);
    assert.equal(rollback.json().reason, 'version_rollback');
  });
});

test('rejects anything that is not a valid crowd.rescue chunk', async () => {
  await withApp(async (app) => {
    assert.equal((await post(app, v1)).json().reason, 'not_rescue_event'); // a bare event is not accepted
    assert.equal((await post(app, chunkOf(eventCase('official_namespace')))).json().reason, 'not_rescue_event');
    const response = await post(app, chunkOf(eventCase('tampered')));
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().reason, 'payload_hash_mismatch');
    assert.equal((await post(app, chunkOf(eventCase('severity_mismatch')))).json().reason, 'rescue_severity_mismatch');
    const relayTampered = fixture.chunk_cases.find((entry) => entry.name === 'relay_tampered').chunk;
    assert.equal((await post(app, relayTampered)).json().reason, 'chunk_hash_mismatch');
    assert.doesNotMatch(response.body, /樓梯|121\.58|25\.06/u);
  });
});

test('enforces payload size, future issue time and one ACTIVE request per key', async () => {
  await withApp(async (app) => {
    const oversized = await post(app, JSON.stringify({ ...chunkOf(v1), padding: 'x'.repeat(9000) }));
    assert.equal(oversized.statusCode, 413);
    assert.equal(oversized.json().error, 'payload_too_large');

    const future = buildRescueRequest({
      ...fixture.inputs.create,
      issuedAt: new Date('2026-10-12T04:06:00Z'),
      requestUuid: '00000000-0000-4000-8000-0000000000f1',
      ...device,
    });
    assert.equal((await post(app, chunkOf(future))).json().reason, 'issued_in_future');

    assert.equal((await post(app, chunkOf(v1))).statusCode, 201);
    const second = buildRescueRequest({
      ...fixture.inputs.create,
      issuedAt: new Date('2026-10-12T03:30:00Z'),
      requestUuid: '00000000-0000-4000-8000-0000000000f2',
      ...device,
    });
    const conflict = await post(app, chunkOf(second));
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().reason, 'rescue_active_exists');
  });
});

test('rate limits writes per key', async () => {
  await withApp(async (app) => {
    let latest = v1;
    assert.equal((await post(app, chunkOf(latest))).statusCode, 201);
    for (const minute of ['05', '06']) {
      latest = buildRescueRevision(latest, { action: 'UPDATE', changes: {}, issuedAt: new Date(`2026-10-12T03:${minute}:00Z`), ...device });
      assert.equal((await post(app, chunkOf(latest))).statusCode, 201);
    }
    latest = buildRescueRevision(latest, { action: 'UPDATE', changes: {}, issuedAt: new Date('2026-10-12T03:07:00Z'), ...device });
    const limited = await post(app, chunkOf(latest));
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error, 'rate_limited');
    assert.ok(Number(limited.headers['retry-after']) > 0);
  });
});

test('GET returns the stored chunks of ACTIVE, unexpired requests inside a small bbox', async () => {
  await withApp(async (app) => {
    await post(app, chunkOf(v1));
    const ok = await app.inject({ method: 'GET', url: '/v1/crowd/rescue-events?bbox=121.57,25.05,121.6,25.08' });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['cache-control'], 'no-store');
    const [chunk] = ok.json().chunks;
    assert.deepEqual(chunk, chunkOf(v1));

    const outside = await app.inject({ method: 'GET', url: '/v1/crowd/rescue-events?bbox=121.0,25.0,121.04,25.04' });
    assert.deepEqual(outside.json().chunks, []);

    for (const bbox of ['', '121,25,121.2,25.1', 'a,b,c,d', '121.6,25.0,121.57,25.04']) {
      const bad = await app.inject({ method: 'GET', url: `/v1/crowd/rescue-events?bbox=${bbox}` });
      assert.equal(bad.statusCode, 400, bbox);
      assert.equal(bad.json().error, 'invalid_bbox');
    }
  });
});

test('a forged official namespace is refused even with a valid device signature', async () => {
  await withApp(async (app) => {
    const forged = signEvent({ ...v1, namespace: 'official.ncdr' }, device.privateKey);
    assert.equal((await post(app, chunkOf(forged))).json().reason, 'not_rescue_event');
    const disguised = { ...chunkOf(v1), dataset_id: 'crowd-reports' };
    assert.equal((await post(app, disguised)).json().reason, 'not_rescue_event');
  });
});

// v3 (issued 08:30) and v4 (issued 09:00) would be "issued_in_future" at
// 04:00, so this test advances the server clock as the timeline advances.
test('GET hides resolved requests', async () => {
  let clock = NOW;
  await withApp(async (app) => {
    await post(app, chunkOf(v1));
    await post(app, chunkOf(v2));
    clock = new Date('2026-10-12T08:31:00Z');
    assert.equal((await post(app, chunkOf(eventCase('valid_v3_extend')))).statusCode, 201);
    clock = new Date('2026-10-12T09:01:00Z');
    assert.equal((await post(app, chunkOf(eventCase('valid_v4_resolved')))).statusCode, 201);
    const after = await app.inject({ method: 'GET', url: '/v1/crowd/rescue-events?bbox=121.57,25.05,121.6,25.08' });
    assert.deepEqual(after.json().chunks, []);
  }, { clock: () => clock });
});
