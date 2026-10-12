import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ingestEvent, verifyEvent } from '../lib/contract.mjs';
import { verifyCrowdChunk } from '../lib/crowd-report.mjs';
import { buildRescueRequest, buildRescueRevision } from '../lib/rescue-request.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = JSON.parse(readFileSync(path.join(ROOT, 'fixtures/rescue-requests-v0.json'), 'utf8'));
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function keyPairFromSeed(label) {
  const seed = Buffer.alloc(32);
  Buffer.from(label, 'utf8').copy(seed);
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

for (const testCase of fixture.event_cases) {
  test(`rescue event case ${testCase.name}`, () => {
    const result = verifyEvent(testCase.event, null, { now: fixture.now });
    assert.equal(result.valid, testCase.expect.valid, JSON.stringify(result));
    if (!testCase.expect.valid) {
      assert.equal(result.stage, testCase.expect.stage);
      if (testCase.expect.error) assert.equal(result.errors[0], testCase.expect.error);
    }
  });
}

for (const testCase of fixture.transition_cases) {
  test(`rescue transition case ${testCase.name}`, () => {
    const store = new Map();
    assert.notEqual(ingestEvent(store, testCase.stored, null, { now: fixture.now }).result, 'rejected');
    const result = ingestEvent(store, testCase.incoming, null, { now: fixture.now });
    assert.equal(result.result, testCase.expect.result, JSON.stringify(result));
    if (testCase.expect.reason) assert.equal(result.reason, testCase.expect.reason);
  });
}

for (const testCase of fixture.chunk_cases) {
  test(`rescue chunk case ${testCase.name}`, () => {
    const result = verifyCrowdChunk(testCase.chunk, { now: fixture.now });
    assert.equal(result.valid, testCase.expect.valid, JSON.stringify(result));
    if (!testCase.expect.valid) assert.equal(result.errors[0], testCase.expect.error);
  });
}

test('the builders reproduce the fixture timeline byte for byte', () => {
  const keys = keyPairFromSeed(fixture.seeds.device);
  const create = fixture.inputs.create;
  let latest = buildRescueRequest({ ...create, issuedAt: new Date(create.issuedAt), ...keys });
  assert.deepEqual(latest, fixture.event_cases.find((entry) => entry.name === 'valid_v1').event);
  const names = ['valid_v2_update', 'valid_v3_extend', 'valid_v4_resolved'];
  fixture.inputs.revisions.forEach((revision, index) => {
    latest = buildRescueRevision(latest, { ...revision, issuedAt: new Date(revision.issuedAt), ...keys });
    assert.deepEqual(latest, fixture.event_cases.find((entry) => entry.name === names[index]).event);
  });
});

test('rescue-requests-v0.json is byte-identical to the Android test copy', () => {
  assert.equal(
    readFileSync(path.join(ROOT, 'fixtures/rescue-requests-v0.json'), 'utf8'),
    readFileSync(path.join(ROOT, 'android/app/src/test/resources/fixtures/rescue-requests-v0.json'), 'utf8'),
  );
});
