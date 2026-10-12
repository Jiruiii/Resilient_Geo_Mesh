import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateEd25519KeyPair } from '../lib/crypto.mjs';
import { buildGovernmentFeed, readPreviousEvents, verifyFeed } from '../lib/government-feed.mjs';
import { eventState, signEvent, verifyBundle, verifyEvent } from '../lib/contract.mjs';
import { signGovernmentDeviceCertificate } from '../lib/government-device-certificate.mjs';
import { deviceKeyIdForPublicKey, publicKeySpkiBase64 } from '../lib/device-key.mjs';
import { eventPayload } from '../lib/canonical.mjs';
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
function cwaEvent(eventId) {
  const value = event();
  value.event_id = eventId;
  value.event_type = 'EARTHQUAKE_INTENSITY';
  value.source = 'CWA';
  value.attributes = { ...value.attributes, theme: 'earthquake', operational_relevance: 'BACKGROUND' };
  return value;
}
function governmentDeviceWarning({ namespace = 'official.announcement', certificateIssuer = keys,
  issuerKeyId = 'government-feed-2026', eventId = 'warning:mesh:1' } = {}) {
  const device = generateEd25519KeyPair();
  const signerPublicKey = publicKeySpkiBase64(device.publicKey);
  const certificate = signGovernmentDeviceCertificate({
    certificate_id: 'certificate:mesh:1', device_id: 'device:mesh:1', subject_id: 'user:government:1',
    signing_key_id: deviceKeyIdForPublicKey(device.publicKey), signer_public_key: signerPublicKey,
    agency: '測試機關', issued_at: new Date(now.getTime() - 60_000).toISOString(), issuer_key_id: issuerKeyId,
  }, certificateIssuer.privateKey);
  return signEvent({
    schema_version: 'event-v0', namespace, event_id: eventId, event_type: 'GOVERNMENT_DEVICE_WARNING',
    geometry: { type: 'Point', coordinates: [121.5, 25] }, severity: 'HIGH', source: 'GOVERNMENT',
    source_version: 'government-device-warning-v1', event_version: 1,
    issued_at: new Date(now.getTime() - 30_000).toISOString(),
    expires_at: new Date(now.getTime() + 6 * 60 * 60_000).toISOString(),
    attributes: { title: '道路警戒', content: '前方道路封閉', category: 'ROAD', area_id: 'tw.national',
      theme: 'announcement', has_map_location: true, government_device_certificate: certificate },
    signing_key_id: deviceKeyIdForPublicKey(device.publicKey), signer_public_key: signerPublicKey,
    provenance: { original_source: 'government-device', received_at: now.toISOString(),
      transport_source: { kind: 'server', node_id: 'government-api' } },
  }, device.privateKey);
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

test('NCDR background filtering does not remove CWA official events', () => {
  const output = build([{
    id: 'cwa-warning',
    status: 'ok',
    events: [cwaEvent('cwa:warning:rain')],
  }]);

  const publishedEvents = [...output.files.values()].flatMap((chunk) => chunk.events);
  assert.deepEqual(publishedEvents.map((value) => value.event_id), ['cwa:warning:rain']);
  assert.equal(publishedEvents[0].source, 'CWA');
  assert.equal(publishedEvents[0].namespace, 'official.live.cwa-warning');
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

test('government feed preserves a valid device warning event and its signature in the central bundle', () => {
  const warning = governmentDeviceWarning();
  const output = build([{ id: 'government-announcements', namespace: 'official.announcement', status: 'ok', events: [warning] }]);
  const published = [...output.files.values()].flatMap((chunk) => chunk.events)[0];
  assert.deepEqual(eventPayload(published), eventPayload(warning));
  for (const field of ['payload_hash', 'signature', 'signature_algorithm', 'signing_key_id', 'signer_public_key']) {
    assert.equal(published[field], warning[field]);
  }
  assert.equal(published.provenance.transport_source.node_id, 'government-collector');
  assert.equal(verifyEvent(published, keys.publicKey, { trustedKeyIds: ['government-feed-2026'], now }).valid, true);
});

test('government feed rejects tampered device warnings instead of re-signing them', () => {
  const warning = governmentDeviceWarning();
  warning.attributes.content = '已被竄改';
  assert.throws(() => build([{ id: 'government-announcements', namespace: 'official.announcement', status: 'ok', events: [warning] }]),
    /Invalid device-signed government warning/);
});

test('government feed rejects device warnings in unsupported namespaces', () => {
  const warning = governmentDeviceWarning({ namespace: 'official.device-revocation' });
  assert.throws(() => build([{ id: 'government-announcements', namespace: 'official.announcement', status: 'ok', events: [warning] }]),
    /Invalid device-signed government warning/);
});

test('government feed rejects device certificates signed by an unknown issuer', () => {
  const unknownIssuer = generateEd25519KeyPair();
  const warning = governmentDeviceWarning({ certificateIssuer: unknownIssuer, issuerKeyId: 'untrusted-issuer' });
  assert.throws(() => build([{ id: 'government-announcements', namespace: 'official.announcement', status: 'ok', events: [warning] }]),
    /Invalid device-signed government warning/);
});

test('government device revocation metadata is classified as internal rather than a public notice', () => {
  assert.equal(eventState({ namespace: 'official.device-revocation', expires_at: '2026-10-13T00:00:00Z',
    attributes: { internal_only: true } }, now), 'internal');
});

test('central revision of a device warning gets a higher version and central signature', async () => {
  const warning = governmentDeviceWarning();
  const first = build([{ id: 'government-announcements', namespace: 'official.announcement', status: 'ok', events: [warning] }]);
  const previousEvents = await restore(first);
  const revision = { ...warning, attributes: { ...warning.attributes, content: '請改走替代道路' } };
  for (const field of ['payload_hash', 'signature', 'signature_algorithm', 'signer_public_key']) delete revision[field];
  revision.signing_key_id = 'government-feed-2026';
  const second = build([{ id: 'government-announcements', namespace: 'official.announcement', status: 'ok', events: [revision] }],
    { previous: first.feed, previousEvents, now: new Date(now.getTime() + 60_000) });
  const updated = [...second.files.values()].flatMap((chunk) => chunk.events)[0];
  assert.equal(updated.event_version, 2);
  assert.equal(updated.attributes.content, '請改走替代道路');
  assert.notEqual(updated.signature, warning.signature);
  assert.equal(verifyEvent(updated, keys.publicKey, { trustedKeyIds: ['government-feed-2026'], now }).valid, true);
});

test('central withdrawal of a device warning publishes a higher centrally signed version', async () => {
  const warning = governmentDeviceWarning();
  const first = build([{ id: 'government-announcements', namespace: 'official.announcement', status: 'ok', events: [warning] }]);
  const withdrawnAt = new Date(now.getTime() + 60_000);
  const withdrawn = build([{ id: 'government-announcements', namespace: 'official.announcement', status: 'ok', events: [],
    cancelledEventIds: [warning.event_id] }], { previous: first.feed, previousEvents: await restore(first), now: withdrawnAt });
  const event = [...withdrawn.files.values()].flatMap((chunk) => chunk.events)[0];
  assert.equal(event.event_version, 2);
  assert.equal(event.attributes.publication_retracted, true);
  assert.equal(event.signing_key_id, 'government-feed-2026');
  assert.equal(verifyEvent(event, keys.publicKey, { trustedKeyIds: ['government-feed-2026'], now: withdrawnAt }).valid, true);
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
