#!/usr/bin/env node
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { buildGovernmentFeed } from '../lib/government-feed.mjs';

// This deterministic key is only for JVM test fixtures. It is unrelated to
// either production signing key and must never be trusted outside tests.
const keyId = 'central-server-2026';
const fixtureKeyId = 'cwa-fixture-test-2026';
const seed = Buffer.alloc(32);
Buffer.from('government-cwa-test-fixture').copy(seed);
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
  format: 'der',
  type: 'pkcs8',
});
const publicKey = createPublicKey(privateKey);
const now = new Date('2026-09-27T00:00:00.000Z');
const event = structuredClone(JSON.parse(
  await readFile('fixtures/events-batch-1.json', 'utf8'),
).events[0]);
Object.assign(event, {
  namespace: 'official.cwa',
  event_id: 'cwa:warning:test-fixture',
  event_type: 'CWA_WARNING',
  source: 'CWA',
  source_version: 'fixture-1',
  event_version: 1,
  issued_at: now.toISOString(),
  expires_at: '2099-01-01T00:00:00.000Z',
  geometry: { type: 'Point', coordinates: [121.5, 25.0] },
  attributes: { area_id: 'tw.63000100', theme: 'weather-warning', map_visible: false },
  provenance: {
    original_source: 'cwa-warning',
    received_at: now.toISOString(),
    transport_source: { kind: 'server', node_id: 'government-fixture' },
  },
});

const output = buildGovernmentFeed({
  privateKey,
  publicKey,
  signingKeyId: keyId,
  now,
  results: [{ id: 'cwa-warning', status: 'ok', events: [event] }],
});
const directory = 'android/app/src/test/resources/government';
await mkdir(directory, { recursive: true });
const trustPath = 'android/app/src/test/resources/trust/trusted-keys.json';
const trust = JSON.parse(await readFile(trustPath, 'utf8'));
trust[fixtureKeyId] = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
await writeFile(trustPath, `${JSON.stringify(trust, null, 2)}\n`);
await writeFile(`${directory}/feed.json`, JSON.stringify(output.feed));
await writeFile(`${directory}/chunk.json`, JSON.stringify([...output.files.values()][0]));
console.log('Signed CWA test fixture generated with a test-only key.');
