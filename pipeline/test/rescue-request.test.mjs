import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

import { ingestEvent, signEvent, verifyEvent } from '../lib/contract.mjs';
import { buildCrowdChunk, buildCrowdReport, verifyCrowdChunk } from '../lib/crowd-report.mjs';
import { buildRescueRequest, buildRescueRevision } from '../lib/rescue-request.mjs';
import { rescueEventErrors } from '../lib/rescue-contract.mjs';

const NOW = '2026-10-12T04:00:00Z';
const device = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const triage = { immobile: 'YES', breathing_difficulty: 'NO', severe_bleeding: 'UNKNOWN', conscious: 'YES' };

function create(overrides = {}) {
  return buildRescueRequest({
    requestType: 'TRAPPED_DEBRIS',
    subject: 'SELF',
    peopleCount: 2,
    triage,
    description: '  一樓樓梯間，敲牆有回應  ',
    lon: 121.5881234,
    lat: 25.0698764,
    locationSource: 'CURRENT_LOCATION',
    issuedAt: new Date('2026-10-12T03:00:00.900Z'),
    requestUuid: '00000000-0000-4000-8000-0000000000AA',
    privateKey: device.privateKey,
    publicKey: device.publicKey,
    ...overrides,
  });
}

const revise = (previous, action, issuedAt, changes, keys = device) => buildRescueRevision(previous, {
  action, changes, issuedAt: new Date(issuedAt), privateKey: keys.privateKey, publicKey: keys.publicKey,
});

test('v1 is signed, bound to the device and passes the contract', () => {
  const event = create();
  assert.equal(event.namespace, 'crowd.rescue');
  assert.equal(event.event_type, 'RESCUE_REQUEST');
  assert.equal(event.event_id, `rescue:${event.signing_key_id.slice(7)}:00000000-0000-4000-8000-0000000000aa`);
  assert.equal(event.severity, 'CRITICAL');
  assert.equal(event.issued_at, '2026-10-12T03:00:00Z');
  assert.equal(event.expires_at, '2026-10-12T09:00:00Z');
  assert.deepEqual(event.geometry.coordinates, [121.588123, 25.069876]);
  assert.equal(event.attributes.description, '一樓樓梯間，敲牆有回應');
  assert.equal(event.attributes.first_issued_at, '2026-10-12T03:00:00Z');
  assert.equal(event.attributes.status, 'ACTIVE');
  assert.equal(event.provenance.transport_source.kind, 'local_report');
  assert.deepEqual(rescueEventErrors(event), []);
  assert.equal(verifyEvent(event, null, { now: NOW }).valid, true);
});

test('SELF requests are always recorded as conscious', () => {
  const event = create({ triage: { ...triage, conscious: 'UNKNOWN' } });
  assert.equal(event.attributes.triage.conscious, 'YES');
});

test('builder refuses invalid input instead of signing it', () => {
  assert.throws(() => create({ requestType: 'TRAPPED_INJURED' }), /rescue_field_invalid:request_type/);
  assert.throws(() => create({ peopleCount: 0 }), /rescue_field_invalid:people_count/);
  assert.throws(() => create({ lon: 139.69, lat: 35.68 }), /rescue_geometry_invalid/);
});

test('UPDATE keeps expiry, re-derives urgency and bumps the version', () => {
  const v1 = create({ requestType: 'FIRST_AID_NEEDED', triage: { ...triage, immobile: 'NO' } });
  assert.equal(v1.severity, 'MEDIUM');
  const v2 = revise(v1, 'UPDATE', '2026-10-12T03:10:00Z', { triage: { ...triage, severe_bleeding: 'YES' }, peopleCount: 3 });
  assert.equal(v2.event_version, 2);
  assert.equal(v2.event_id, v1.event_id);
  assert.equal(v2.severity, 'CRITICAL');
  assert.equal(v2.attributes.people_count, 3);
  assert.equal(v2.expires_at, v1.expires_at);
  assert.equal(v2.attributes.first_issued_at, v1.attributes.first_issued_at);
  assert.equal(verifyEvent(v2, null, { now: NOW }).valid, true);
});

test('EXTEND moves expiry forward but never past 72 hours', () => {
  const v1 = create();
  const v2 = revise(v1, 'EXTEND', '2026-10-12T08:30:00Z');
  assert.equal(v2.expires_at, '2026-10-12T14:30:00Z');
  let latest = v2;
  for (const issued of ['2026-10-12T14:00:00Z', '2026-10-12T19:50:00Z', '2026-10-13T01:40:00Z',
    '2026-10-13T07:30:00Z', '2026-10-13T13:20:00Z', '2026-10-13T19:10:00Z', '2026-10-14T01:00:00Z',
    '2026-10-14T06:50:00Z', '2026-10-14T12:40:00Z', '2026-10-14T18:30:00Z']) {
    latest = revise(latest, 'EXTEND', issued);
  }
  assert.equal(latest.expires_at, '2026-10-15T00:30:00Z');
  // The next extension is capped at first_issued_at + 72h …
  latest = revise(latest, 'EXTEND', '2026-10-15T00:00:00Z');
  assert.equal(latest.expires_at, '2026-10-15T03:00:00Z');
  // … and once at the cap there is nothing left to extend.
  assert.throws(() => revise(latest, 'EXTEND', '2026-10-15T02:00:00Z'), /rescue_extend_not_later/);
});

test('RESOLVE and CANCEL keep expiry and end the lifecycle', () => {
  const v1 = create();
  const resolved = revise(v1, 'RESOLVE', '2026-10-12T05:00:00Z');
  assert.equal(resolved.attributes.status, 'RESOLVED');
  assert.equal(resolved.expires_at, v1.expires_at);
  assert.throws(() => revise(resolved, 'UPDATE', '2026-10-12T05:10:00Z'), /rescue_revision_terminal/);
  const cancelled = revise(v1, 'CANCEL', '2026-10-12T05:00:00Z');
  assert.equal(cancelled.attributes.status, 'CANCELLED');
});

test('only the original device may revise, and only before expiry', () => {
  const v1 = create();
  assert.throws(() => revise(v1, 'RESOLVE', '2026-10-12T05:00:00Z', {}, other), /rescue_revision_wrong_device/);
  assert.throws(() => revise(v1, 'UPDATE', '2026-10-12T09:00:00Z'), /rescue_revision_expired/);
  assert.throws(() => revise(v1, 'DELETE', '2026-10-12T05:00:00Z'), /rescue_action_invalid/);
});

test('verifyEvent reports contract errors only after the signature checks out', () => {
  const forged = signEvent({ ...create(), severity: 'LOW' }, device.privateKey);
  const result = verifyEvent(forged, null, { now: NOW });
  assert.equal(result.valid, false);
  assert.equal(result.stage, 'contract');
  assert.deepEqual(result.errors, ['rescue_severity_mismatch']);
});

test('ingest applies signer and lifecycle rules', () => {
  const store = new Map();
  const v1 = create();
  assert.equal(ingestEvent(store, v1, null, { now: NOW }).result, 'inserted');
  const resolved = revise(v1, 'RESOLVE', '2026-10-12T03:30:00Z');
  assert.equal(ingestEvent(store, resolved, null, { now: NOW }).result, 'updated');
  const reopened = signEvent({
    ...resolved,
    event_version: 3,
    issued_at: '2026-10-12T03:40:00Z',
    attributes: { ...resolved.attributes, status: 'ACTIVE' },
  }, device.privateKey);
  assert.equal(ingestEvent(store, reopened, null, { now: NOW }).reason, 'rescue_terminal');
});

test('a crowd report cannot be overwritten by another device', () => {
  const store = new Map();
  const report = buildCrowdReport({
    category: 'FLOOD', description: '', lon: 121.5, lat: 25.0, locationSource: 'MAP_PICK',
    issuedAt: new Date('2026-10-12T03:00:00Z'), privateKey: device.privateKey, publicKey: device.publicKey,
  });
  ingestEvent(store, report, null, { now: NOW });
  const hijack = buildCrowdReport({
    category: 'OTHER', description: '', lon: 121.5, lat: 25.0, locationSource: 'MAP_PICK',
    issuedAt: new Date('2026-10-12T03:05:00Z'), privateKey: other.privateKey, publicKey: other.publicKey,
  });
  const forged = signEvent({ ...hijack, event_id: report.event_id, event_version: 2 }, other.privateKey);
  assert.equal(ingestEvent(store, forged, null, { now: NOW }).reason, 'signer_mismatch');
});

test('rescue chunks use their own dataset and keep relay rules', () => {
  const v1 = create();
  const chunk = buildCrowdChunk(v1, device.privateKey);
  assert.equal(chunk.dataset_id, 'crowd-rescue');
  assert.equal(chunk.chunk_id, `crowd-rescue:${v1.event_id}`);
  assert.equal(chunk.manifest_id, 'crowd-rescue:none');
  assert.equal(chunk.theme, 'rescue');
  assert.equal(chunk.priority, 'HIGH');
  assert.equal(verifyCrowdChunk(structuredClone(chunk), { now: NOW }).valid, true);

  const tampered = structuredClone(chunk);
  tampered.events[0].attributes.status = 'CANCELLED';
  assert.equal(verifyCrowdChunk(tampered, { now: NOW }).errors[0], 'chunk_hash_mismatch');

  const smuggled = { ...structuredClone(chunk), dataset_id: 'crowd-reports' };
  assert.equal(verifyCrowdChunk(smuggled, { now: NOW }).errors[0], 'not_a_crowd_chunk');
});

test('the worst-case legitimate rescue request fits the crowd chunk cap', () => {
  const event = create({
    description: '測'.repeat(160),
    locationHint: { method: 'ADDRESS', query: '測'.repeat(80), label: '測'.repeat(80), kind: 'FACILITY', precision: 'POINT' },
  });
  const chunk = buildCrowdChunk(event, device.privateKey);
  assert.ok(chunk.byte_length <= 4096, `${chunk.byte_length} bytes`);
});
