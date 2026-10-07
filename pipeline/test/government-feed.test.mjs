import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateEd25519KeyPair } from '../lib/crypto.mjs';
import { buildGovernmentFeed, readPreviousEvents, verifyFeed } from '../lib/government-feed.mjs';
import { verifyBundle } from '../lib/contract.mjs';
import { normalizeNcdrFeed } from '../sources/ncdr.mjs';
import { comparePublishedState } from '../lib/government-state.mjs';
const keys = generateEd25519KeyPair();
const now = new Date('2026-09-27T12:00:00Z');
function event(status = 'CLOSED') {
  return { ...JSON.parse(readFileSync('fixtures/events-batch-1.json')).events[0],
    expires_at: '2026-09-28T12:00:00Z', attributes: { area_id: 'tw.63000100', theme: 'road', status } };
}
function ncdrEvent(relevance, eventId) {
  const value = event();
  value.event_id = eventId;
  value.event_type = 'NCDR_HAZARD';
  value.attributes = { ...value.attributes, theme: 'hazard', operational_relevance: relevance };
  return value;
}
function build(results, extra = {}) { return buildGovernmentFeed({ ...keys, now, results, ...extra }); }
async function restore(output) { return readPreviousEvents(output.feed, async name => output.files.get(name), keys.publicKey); }

test('public NCDR feed excludes BACKGROUND events while retaining operational events', () => {
  const output = build([{
    id: 'ncdr',
    status: 'ok',
    events: [
      ncdrEvent('BACKGROUND', 'ncdr:background'),
      ncdrEvent('HIGH_IMPACT', 'ncdr:high-impact'),
    ],
  }]);

  const publishedEvents = [...output.files.values()].flatMap((chunk) => chunk.events);
  assert.deepEqual(publishedEvents.map((value) => value.event_id), ['ncdr:high-impact']);
  assert.equal(output.feed.sources[0].event_count, 1);
});

test('public NCDR rebuild removes BACKGROUND events from the previous public ledger', () => {
  const first = build([{ id: 'ncdr', status: 'ok', events: [ncdrEvent('HIGH_IMPACT', 'ncdr:active')] }]);
  const second = build([{ id: 'ncdr', status: 'unavailable' }], {
    previous: first.feed,
    previousEvents: {
      ncdr: [
        ncdrEvent('BACKGROUND', 'ncdr:background'),
        ncdrEvent('HIGH_IMPACT', 'ncdr:active'),
      ],
    },
  });

  const publishedEvents = [...second.files.values()].flatMap((chunk) => chunk.events);
  assert.deepEqual(publishedEvents.map((value) => value.event_id), ['ncdr:active']);
});

test('publisher rejects conflicting revisions and detects rollback before upload', async () => {
  const first = build([{ id: 'tdx-road', status: 'ok', events: [event()] }]);
  const conflict = build([{ id: 'tdx-road', status: 'ok', events: [event('OPEN')] }]);
  assert.throws(() => comparePublishedState(first.feed, conflict.feed, keys.publicKey), /Conflicting/);
  const next = build([{ id: 'tdx-road', status: 'ok', events: [event('OPEN')] }],
    { previous: first.feed, previousEvents: await restore(first) });
  assert.equal(comparePublishedState(first.feed, next.feed, keys.publicKey), -1);
  assert.equal(comparePublishedState(next.feed, first.feed, keys.publicKey), 1);
  assert.equal(comparePublishedState(first.feed, structuredClone(first.feed), keys.publicKey), 0);
});
test('government release verifies every layer and excludes credential-bearing provenance', () => {
  const input = event(); input.provenance.original_source = 'https://api.example/?apikey=secret';
  const output = build([{ id: 'tdx-road', status: 'ok', events: [input] }]);
  verifyFeed(output.feed, keys.publicKey);
  const bundle = { manifest: output.feed.datasets[0].manifest, chunks: [...output.files.values()] };
  assert.equal(verifyBundle(bundle, keys.publicKey, { trustedKeyIds: ['government-feed-2026'] }).valid, true);
  assert.equal(JSON.stringify([...output.files.values()]).includes('apikey=secret'), false);
});

test('government feed signing key metadata comes from the server publisher when provided', () => {
  const output = build([{ id: 'tdx-road', status: 'ok', events: [event()] }], {
    signingKeyId: 'server-government-2026',
  });
  assert.equal(output.feed.signing_key_id, 'server-government-2026');
  assert.equal(output.files.values().next().value.signing_key_id, 'server-government-2026');
  assert.doesNotThrow(() => verifyFeed(output.feed, keys.publicKey, {
    signingKeyId: 'server-government-2026',
  }));
});
test('unchanged events reuse immutable chunks and do not download new versions', async () => {
  const first = build([{ id: 'tdx-road', status: 'ok', events: [event()] }]);
  const second = build([{ id: 'tdx-road', status: 'ok', events: [event()] }],
    { previous: first.feed, previousEvents: await restore(first), now: new Date(now.getTime() + 300000) });
  assert.equal(second.feed.revision, 2);
  assert.deepEqual(second.feed.datasets[0], first.feed.datasets[0]);
  assert.deepEqual([...second.files.values()], [...first.files.values()]);
});
test('changed road status increases event version after a publisher restart', async () => {
  const first = build([{ id: 'tdx-road', status: 'ok', events: [event()] }]);
  const second = build([{ id: 'tdx-road', status: 'ok', events: [event('OPEN')] }],
    { previous: first.feed, previousEvents: await restore(first) });
  const updated = [...second.files.values()][0].events[0];
  assert.equal(updated.event_version, 2);
  assert.equal(updated.attributes.status, 'OPEN');
});
test('failed and empty feeds retain live events; expiry removes distribution but preserves version ledger', async () => {
  const first = build([{ id: 'tdx-road', status: 'ok', events: [event()] }]);
  const previousEvents = await restore(first);
  for (const result of [{ id: 'tdx-road', status: 'unavailable' }, { id: 'tdx-road', status: 'ok', events: [] }]) {
    const retained = build([result], { previous: first.feed, previousEvents });
    assert.equal([...retained.files.values()][0].events[0].attributes.status, 'CLOSED');
  }
  const expired = build([{ id: 'tdx-road', status: 'ok', events: [] }],
    { previous: first.feed, previousEvents, now: new Date('2026-09-29T00:00:00Z') });
  assert.equal(expired.feed.datasets.length, 0);
  const resurrected = build([{ id: 'tdx-road', status: 'ok', events: [{ ...event('OPEN'), expires_at: '2026-10-01T00:00:00Z' }] }],
    { previous: expired.feed, now: new Date('2026-09-29T00:00:00Z') });
  assert.equal([...resurrected.files.values()][0].events[0].event_version, 2);
});
test('tampered signed ledger and damaged chunks cannot bootstrap a publisher', async () => {
  const output = build([{ id: 'tdx-road', status: 'ok', events: [event()] }]);
  const altered = structuredClone(output.feed); altered.revision++;
  assert.throws(() => verifyFeed(altered, keys.publicKey));
  await assert.rejects(readPreviousEvents(output.feed, async name => {
    const chunk = structuredClone(output.files.get(name)); chunk.events[0].attributes.status = 'OPEN'; return chunk;
  }, keys.publicKey));
});
test('CAP cancellation without an info block produces a signed expiry that can travel offline', async () => {
  const snapshot = { schema_version: 'raw-snapshot-v0', source_id: 'ncdr-hazard-events',
    retrieved_at: now.toISOString(), request: { method: 'GET', url: 'https://example.com/', query: {} },
    response: { status: 200, headers: {} },
    payload: { records: [{ identifier: 'cancel-1', msgType: 'Cancel', references: 'sender,original-1,2026-09-27T00:00:00Z' }] } };
  const normalized = normalizeNcdrFeed(snapshot, { scope: 'taiwan', boundary: { type: 'Polygon', coordinates: [[[120,24],[123,24],[123,27],[120,27],[120,24]]] } });
  assert.deepEqual(normalized.cancelledEventIds, ['ncdr:original-1']);
  assert.equal(normalized.events.length, 0);
  const first = build([{ id: 'ncdr', status: 'ok', events: [{ ...event(), event_id: 'ncdr:original-1' }] }]);
  const withdrawn = build([{ id: 'ncdr', status: 'ok', ...normalized }],
    { previous: first.feed, previousEvents: await restore(first) });
  const expiry = [...withdrawn.files.values()][0].events[0];
  assert.equal(expiry.event_version, 2);
  assert.equal(expiry.expires_at, now.toISOString());
  assert.equal(expiry.attributes.publication_retracted, true);
  assert.equal(verifyBundle({ manifest: withdrawn.feed.datasets[0].manifest, chunks: [...withdrawn.files.values()] },
    keys.publicKey, { trustedKeyIds: ['government-feed-2026'] }).valid, true);
});
