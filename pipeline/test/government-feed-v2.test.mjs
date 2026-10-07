import assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateEd25519KeyPair } from '../lib/crypto.mjs';
import {
  buildGovernmentFeedV2,
  verifyGovernmentChunkV2,
  verifyGovernmentFeedV2,
} from '../lib/government-feed-v2.mjs';

const keys = generateEd25519KeyPair();
const signingKeyId = 'government-feed-test';
const now = new Date('2026-10-03T02:00:00Z');

function event(eventId, { areaId = 'tw.63000100', theme = 'flood', severity = 'HIGH' } = {}) {
  return {
    event_id: eventId,
    event_type: 'FLOOD',
    severity,
    expires_at: '2026-10-03T08:00:00Z',
    attributes: { area_id: areaId, theme },
  };
}

function build(events, previousChunks = []) {
  return buildGovernmentFeedV2({
    events,
    revision: 17,
    createdAt: now,
    expiresAt: new Date('2026-10-04T02:00:00Z'),
    signingKeyId,
    privateKey: keys.privateKey,
    previousChunks,
  });
}

test('v2 manifest signs immutable chunk hashes and each chunk verifies independently', () => {
  const output = build([
    event('flood-1'),
    event('flood-2'),
    event('fire-1', { areaId: 'tw.65000100', theme: 'fire' }),
  ]);
  const chunks = [...output.files]
    .filter(([path]) => path.startsWith('v2/chunks/'))
    .map(([, chunk]) => chunk);

  assert.equal(output.manifest.schema_version, 'government-feed-v2');
  assert.equal(output.manifest.chunks.length, 3);
  assert.equal(verifyGovernmentFeedV2(output.manifest, chunks, keys.publicKey, {
    trustedKeyIds: [signingKeyId],
    now,
  }).valid, true);
  for (const chunk of chunks) {
    assert.equal(verifyGovernmentChunkV2(chunk, keys.publicKey, {
      trustedKeyIds: [signingKeyId],
    }).valid, true);
    assert.equal(Object.hasOwn(chunk, 'manifest_hash'), false);
  }
});

test('a single event change rebuilds only its stable area and topic shard', () => {
  const originalEvents = [
    event('flood-1'),
    event('flood-2'),
    event('other-region', { areaId: 'tw.65000100', theme: 'fire' }),
  ];
  const before = build(originalEvents);
  const beforeChunks = [...before.files]
    .filter(([path]) => path.startsWith('v2/chunks/'))
    .map(([, chunk]) => chunk);
  const after = build([
    { ...originalEvents[0], severity: 'CRITICAL' },
    originalEvents[1],
    originalEvents[2],
  ], beforeChunks);
  const beforeByGroup = new Map(before.manifest.chunks.map((entry) => [`${entry.area_id}/${entry.theme}/${entry.shard}`, entry.sha256]));
  const afterByGroup = new Map(after.manifest.chunks.map((entry) => [`${entry.area_id}/${entry.theme}/${entry.shard}`, entry.sha256]));
  const changedGroups = [...beforeByGroup.keys()].filter((group) => beforeByGroup.get(group) !== afterByGroup.get(group));

  assert.equal(changedGroups.length, 1);
  assert.equal(changedGroups[0].startsWith('tw.63000100/flood/'), true);
  assert.equal([...after.files.keys()].filter((path) => path.startsWith('v2/chunks/')).length, 3);
  assert.equal(before.rebuiltChunkCount, 3);
  assert.equal(after.reusedChunkCount, 2);
  assert.equal(after.rebuiltChunkCount, 1);
});

test('manifest and chunk tampering fail verification', () => {
  const output = build([event('flood-1')]);
  const [chunk] = [...output.files]
    .filter(([path]) => path.startsWith('v2/chunks/'))
    .map(([, value]) => value);
  const alteredManifest = structuredClone(output.manifest);
  alteredManifest.chunks[0].sha256 = `sha256:${'0'.repeat(64)}`;
  const alteredChunk = structuredClone(chunk);
  alteredChunk.events[0].severity = 'CRITICAL';

  assert.equal(verifyGovernmentFeedV2(alteredManifest, [chunk], keys.publicKey, {
    trustedKeyIds: [signingKeyId],
    now,
  }).valid, false);
  assert.equal(verifyGovernmentChunkV2(alteredChunk, keys.publicKey, {
    trustedKeyIds: [signingKeyId],
  }).valid, false);
});
