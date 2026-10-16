import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publishDrill, drillBundle, DRILL_KEY_ID } from '../lib/drill.mjs';
import { verifyEvent, verifyChunk } from '../lib/contract.mjs';
import { createDrillServer } from '../drill-server.mjs';

const input = { id: 'exercise:a', type: 'SHELTER_STATUS', status: 'OPEN', name: '演練避難所 A', area: 'neihu.xihu', lon: 121.599, lat: 25.060, ttl_minutes: 60 };
const now = new Date('2026-10-06T00:00:00Z');
const keys = generateKeyPairSync('ed25519');
test('exercise publisher signs valid events/chunks, increments versions and never emits a production namespace', () => {
  const first = publishDrill({ version: 0, events: [] }, input, keys.privateKey, now);
  const next = publishDrill(first, { ...input, status: 'FULL' }, keys.privateKey, now);
  assert.equal(next.version, 2); assert.equal(next.events.length, 1);
  const event = next.events[0];
  assert.equal(event.event_version, 2); assert.equal(event.attributes.available, 0);
  assert.equal(event.namespace, 'drill.exercise'); assert.equal(event.attributes.exercise, true);
  const options = { now, trustedKeyIds: [DRILL_KEY_ID] };
  assert.equal(verifyEvent(event, keys.publicKey, options).valid, true);
  const bundle = drillBundle(next, keys.privateKey, keys.publicKey);
  assert.ok(bundle.chunks.length > 0);
  for (const chunk of bundle.chunks) assert.deepEqual(verifyChunk(chunk, bundle.manifest, keys.publicKey, options).errors, []);
  assert.equal(verifyEvent(event, keys.publicKey, { now, trustedKeyIds: ['official-v1'] }).valid, false);
  assert.equal(verifyEvent({ ...event, attributes: { ...event.attributes, available: 100 } }, keys.publicKey, options).valid, false);
});
test('unknown supply inventory remains null; invalid data and type changes cannot publish', () => {
  const supply = { ...input, id: 'supply:one', type: 'SUPPLY_STATUS', status: 'AVAILABLE', items: ['飲水'] };
  const state = publishDrill({ version: 0, events: [] }, supply, keys.privateKey, now);
  assert.equal(state.events[0].attributes.quantity, null);
  for (const invalid of [{ quantity: -1 }, { ttl_minutes: 0 }, { lat: NaN }, { area: 'bad area' }, { status: 'FALSE' }]) {
    assert.throws(() => publishDrill(state, { ...supply, ...invalid }, keys.privateKey, now));
  }
  assert.throws(() => publishDrill(state, { ...input, id: supply.id }, keys.privateKey, now));
});
test('local console rejects cross-origin publishing, serializes updates, persists key and keeps private key inaccessible', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mesh-drill-'));
  let server = await createDrillServer({ directory, port: 0 });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  let base = `http://127.0.0.1:${server.address().port}`;
  const post = (payload, origin = base) => fetch(`${base}/api/events`, { method: 'POST', headers: { Origin: origin, 'X-Drill-Console': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal((await post(input, 'https://untrusted.example')).status, 403);
  const results = await Promise.all(Array.from({ length: 3 }, () => post(input)));
  assert.deepEqual(results.map(r => r.status), [201, 201, 201]);
  const bundle = await (await fetch(`${base}/api/bundle`)).json();
  assert.equal(bundle.version, 3); assert.equal(bundle.chunks[0].events[0].event_version, 3);
  const publicKey = createPublicKey({ key: Buffer.from(bundle.trusted_keys[DRILL_KEY_ID], 'base64'), type: 'spki', format: 'der' });
  assert.equal(verifyChunk(bundle.chunks[0], bundle.manifest, publicKey, { trustedKeyIds: [DRILL_KEY_ID] }).valid, true);
  assert.equal((await fetch(`${base}/private-key.pem`)).status, 404);
  assert.equal((await post({ ...input, name: 'x'.repeat(17000) })).status, 413);
  await new Promise(resolve => server.close(resolve));
  server = await createDrillServer({ directory, port: 0 }); base = `http://127.0.0.1:${server.address().port}`;
  const recovered = await (await fetch(`${base}/api/bundle`)).json();
  assert.deepEqual(recovered.trusted_keys, bundle.trusted_keys); assert.equal(recovered.version, 3);
});
