import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { signEvent, verifyEvent } from '../../pipeline/lib/contract.mjs';
import { buildCrowdReport } from '../../pipeline/lib/crowd-report.mjs';
import { generateEd25519KeyPair } from '../../pipeline/lib/crypto.mjs';
import { signGovernmentDeviceCertificate } from '../../pipeline/lib/government-device-certificate.mjs';
import { deviceKeyIdForPublicKey, publicKeySpkiBase64 } from '../../pipeline/lib/device-key.mjs';
import { publishGovernmentOutboxBatch } from '../src/government/publisher-worker.mjs';

const now = new Date('2026-10-12T00:00:00Z');

function fakeStore({ failRead = false, deviceReport = null, governmentWarning = null, revocations = [] } = {}) {
  const items = [{ id: 'outbox-1', aggregateType: 'ANNOUNCEMENT', aggregateId: 'announcement:1', aggregateVersion: 1,
    payload: { operation: 'PUBLISH' }, attempts: 1 }];
  const state = { published: [], retries: [], rejected: [], items,
    announcement: { event_id: 'announcement:1', event_version: 1, title: '道路管制', content: '請改道。',
      category: 'ROAD', severity: 'HIGH', area_id: 'tw.63000', expires_at: '2026-11-01T00:00:00Z',
      location: null, retracted: false, updated_at: now.toISOString() },
    attestations: deviceReport ? [{ event: deviceReport, payload_hash: deviceReport.payload_hash,
      verdict: 'REFUTED', note: '現場查無此狀況', issued_at: now.toISOString(), version: 1 }] : [],
    governmentWarnings: governmentWarning ? [governmentWarning] : [], revocations };
  return {
    state,
    async claimOutbox() { return state.items; },
    async currentAnnouncementEvents() {
      if (failRead) { const error = new Error('db unavailable'); error.code = 'DATABASE_UNAVAILABLE'; throw error; }
      return [structuredClone(state.announcement)];
    },
    async currentAttestations() { return state.attestations; },
    async currentGovernmentWarnings() { return state.governmentWarnings; },
    async currentGovernmentRevocations() { return state.revocations; },
    async markOutboxPublished(entries) { state.published.push(...entries); },
    async retryOutbox(entries, code) { state.retries.push({ entries, code }); },
    async markOutboxRejected(entries, code) { state.rejected.push({ entries, code }); },
  };
}

function deviceWarning(issuer) {
  const device = generateEd25519KeyPair();
  const signerPublicKey = publicKeySpkiBase64(device.publicKey);
  const certificate = signGovernmentDeviceCertificate({ certificate_id: 'certificate:mesh-warning',
    device_id: 'device:mesh-warning', subject_id: 'government-user:1',
    signing_key_id: deviceKeyIdForPublicKey(device.publicKey), signer_public_key: signerPublicKey,
    agency: '測試機關', issued_at: new Date(now.getTime() - 60_000).toISOString(), issuer_key_id: 'government-feed-2026' },
  issuer.privateKey);
  return signEvent({ schema_version: 'event-v0', namespace: 'official.announcement', event_id: 'warning:mesh:worker',
    event_type: 'GOVERNMENT_DEVICE_WARNING', geometry: { type: 'Point', coordinates: [121.5, 25] },
    severity: 'HIGH', source: 'GOVERNMENT', source_version: 'government-device-warning-v1', event_version: 1,
    issued_at: now.toISOString(), expires_at: new Date(now.getTime() + 6 * 60 * 60_000).toISOString(),
    attributes: { title: '道路警戒', content: '前方封閉', category: 'ROAD', area_id: 'tw.national',
      theme: 'announcement', has_map_location: true, government_device_certificate: certificate },
    signing_key_id: deviceKeyIdForPublicKey(device.publicKey), signer_public_key: signerPublicKey,
    provenance: { original_source: 'government-device', received_at: now.toISOString(),
      transport_source: { kind: 'android_mesh' } },
  }, device.privateKey);
}

test('publisher worker sends announcements through the signed central feed without a map point', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'government-publisher-'));
  const key = generateEd25519KeyPair();
  const store = fakeStore();
  try {
    const result = await publishGovernmentOutboxBatch({ store, releaseRoot: root,
      signingKey: { ...key, keyId: 'government-feed-2026' }, now,
      lockPath: path.join(root, 'private', 'collector.lock') });
    assert.equal(result.published, true);
    assert.equal(store.state.published.length, 1);
    async function publishedEvent() {
      const feed = JSON.parse(await readFile(path.join(root, 'current', 'feed.json'), 'utf8'));
      const dataset = feed.datasets.find((item) => item.source_id === 'government-announcements');
      assert.equal(dataset.manifest.namespace, 'official.announcement');
      return { feed, event: JSON.parse(await readFile(path.join(root, dataset.chunk_paths[0]), 'utf8')).events[0] };
    }
    let current = await publishedEvent();
    assert.equal(current.event.attributes.has_map_location, false);
    assert.equal(current.event.attributes.title, '道路管制');
    assert.equal(verifyEvent(current.event, key.publicKey, { trustedKeyIds: ['government-feed-2026'], now }).valid, true);

    const revisedAt = new Date(now.getTime() + 60_000);
    store.state.items = [{ id: 'outbox-2', aggregateType: 'ANNOUNCEMENT', aggregateId: 'announcement:1', aggregateVersion: 2,
      payload: { operation: 'REVISE' }, attempts: 1 }];
    store.state.announcement = { ...store.state.announcement, event_version: 2, content: '請依現場指示改道。', updated_at: revisedAt.toISOString() };
    await publishGovernmentOutboxBatch({ store, releaseRoot: root, signingKey: { ...key, keyId: 'government-feed-2026' },
      now: revisedAt, lockPath: path.join(root, 'private', 'collector.lock') });
    current = await publishedEvent();
    assert.equal(current.event.event_version, 2);
    assert.equal(current.event.attributes.content, '請依現場指示改道。');

    const retractedAt = new Date(now.getTime() + 120_000);
    store.state.items = [{ id: 'outbox-3', aggregateType: 'ANNOUNCEMENT', aggregateId: 'announcement:1', aggregateVersion: 3,
      payload: { operation: 'RETRACT' }, attempts: 1 }];
    store.state.announcement = { ...store.state.announcement, event_version: 3, retracted: true, updated_at: retractedAt.toISOString() };
    await publishGovernmentOutboxBatch({ store, releaseRoot: root, signingKey: { ...key, keyId: 'government-feed-2026' },
      now: retractedAt, lockPath: path.join(root, 'private', 'collector.lock') });
    current = await publishedEvent();
    assert.equal(current.event.event_version, 3);
    assert.equal(current.event.attributes.publication_retracted, true);
    assert.equal(current.feed.event_versions['official.announcement/announcement:1'].version, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('publisher emits a signed official.verified REFUTED event bound to the original report hash', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'government-attestation-'));
  const key = generateEd25519KeyPair();
  const device = generateEd25519KeyPair();
  const report = buildCrowdReport({ category: 'FLOOD', description: '積水', lon: 121.5, lat: 25,
    locationSource: 'MAP_PICK', privateKey: device.privateKey, publicKey: device.publicKey, issuedAt: now });
  const store = fakeStore({ deviceReport: report });
  store.state.items = [{ id: 'attestation-1', aggregateType: 'ATTESTATION', aggregateId: report.event_id,
    aggregateVersion: 1, payload: { verdict: 'REFUTED' }, attempts: 1 }];
  try {
    await publishGovernmentOutboxBatch({ store, releaseRoot: root,
      signingKey: { ...key, keyId: 'government-feed-2026' }, now,
      lockPath: path.join(root, 'private', 'collector.lock') });
    const feed = JSON.parse(await readFile(path.join(root, 'current', 'feed.json'), 'utf8'));
    const dataset = feed.datasets.find((item) => item.source_id === 'government-attestations');
    assert.equal(dataset.manifest.namespace, 'official.verified');
    const attestation = JSON.parse(await readFile(path.join(root, dataset.chunk_paths[0]), 'utf8')).events[0];
    assert.equal(attestation.attributes.target_payload_hash, report.payload_hash);
    assert.equal(attestation.attributes.verdict, 'REFUTED');
    assert.equal(attestation.event_version, 1);
    assert.equal(verifyEvent(attestation, key.publicKey, { trustedKeyIds: ['government-feed-2026'], now }).valid, true);

    const reviewedAt = new Date(now.getTime() + 60_000);
    store.state.items = [{ id: 'attestation-2', aggregateType: 'ATTESTATION', aggregateId: report.event_id,
      aggregateVersion: 2, payload: { verdict: 'CONFIRMED' }, attempts: 1 }];
    store.state.attestations = [{ event: report, payload_hash: report.payload_hash,
      verdict: 'CONFIRMED', note: '已由現場人員確認', issued_at: reviewedAt.toISOString(), version: 2 }];
    await publishGovernmentOutboxBatch({ store, releaseRoot: root,
      signingKey: { ...key, keyId: 'government-feed-2026' }, now: reviewedAt,
      lockPath: path.join(root, 'private', 'collector.lock') });
    const revisedFeed = JSON.parse(await readFile(path.join(root, 'current', 'feed.json'), 'utf8'));
    const revisedDataset = revisedFeed.datasets.find((item) => item.source_id === 'government-attestations');
    const revisedAttestation = JSON.parse(await readFile(path.join(root, revisedDataset.chunk_paths[0]), 'utf8')).events[0];
    assert.equal(revisedAttestation.event_version, 2);
    assert.equal(revisedAttestation.attributes.verdict, 'CONFIRMED');
    assert.equal(revisedFeed.event_versions[`official.verified/attest:${report.event_id}`].version, 2);
    assert.equal(verifyEvent(revisedAttestation, key.publicKey, { trustedKeyIds: ['government-feed-2026'], now: reviewedAt }).valid, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('publisher preserves the device warning signature and publishes revocations in a separate internal source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'government-device-warning-'));
  const key = generateEd25519KeyPair();
  const warning = deviceWarning(key);
  const store = fakeStore({ governmentWarning: warning, revocations: [{ certificate_id: 'certificate:revoked',
    device_id: 'device:revoked', revoked_at: now.toISOString() }] });
  store.state.items = [
    { id: 'warning-outbox', aggregateType: 'DEVICE_WARNING', aggregateId: warning.event_id,
      aggregateVersion: 1, payload: { event_id: warning.event_id, payload_hash: warning.payload_hash }, attempts: 1 },
    { id: 'revocation-outbox', aggregateType: 'DEVICE_REVOCATION', aggregateId: 'certificate:revoked',
      aggregateVersion: 1, payload: { certificate_id: 'certificate:revoked', device_id: 'device:revoked',
        revoked_at: now.toISOString() }, attempts: 1 },
  ];
  try {
    const result = await publishGovernmentOutboxBatch({ store, releaseRoot: root,
      signingKey: { ...key, keyId: 'government-feed-2026' }, now,
      lockPath: path.join(root, 'private', 'collector.lock') });
    assert.equal(result.published, true);
    const feed = JSON.parse(await readFile(path.join(root, 'current', 'feed.json'), 'utf8'));
    const warningDataset = feed.datasets.find((item) => item.source_id === 'government-announcements');
    const warningChunks = await Promise.all(warningDataset.chunk_paths.map(async (chunkPath) =>
      JSON.parse(await readFile(path.join(root, chunkPath), 'utf8'))));
    const publishedWarning = warningChunks.flatMap((chunk) => chunk.events).find((event) => event.event_id === warning.event_id);
    assert.equal(publishedWarning.signature, warning.signature);
    assert.equal(publishedWarning.payload_hash, warning.payload_hash);
    assert.equal(verifyEvent(publishedWarning, key.publicKey, { trustedKeyIds: ['government-feed-2026'], now }).valid, true);

    const revocationDataset = feed.datasets.find((item) => item.source_id === 'government-device-revocations');
    assert.equal(revocationDataset.manifest.namespace, 'official.device-revocation');
    const revocation = JSON.parse(await readFile(path.join(root, revocationDataset.chunk_paths[0]), 'utf8')).events[0];
    assert.equal(revocation.event_type, 'GOVERNMENT_DEVICE_REVOKED');
    assert.deepEqual(revocation.attributes, { certificate_id: 'certificate:revoked', device_id: 'device:revoked',
      revoked_at: now.toISOString(), area_id: 'tw.national', theme: 'device-revocation', internal_only: true });
    assert.equal(verifyEvent(revocation, key.publicKey, { trustedKeyIds: ['government-feed-2026'], now }).valid, true);
    const publicStatuses = JSON.parse(await readFile(path.join(root, 'current', 'source-status.json'), 'utf8'));
    assert.equal(publicStatuses.some((status) => status.source_id === 'government-device-revocations'), false);
    assert.equal(store.state.published.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('publisher worker retries database or signing failures without marking outbox published', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'government-publisher-fail-'));
  const store = fakeStore({ failRead: true });
  try {
    const result = await publishGovernmentOutboxBatch({ store, releaseRoot: root,
      signingKey: { ...generateEd25519KeyPair(), keyId: 'government-feed-2026' }, now,
      lockPath: path.join(root, 'private', 'collector.lock') });
    assert.equal(result.published, false);
    assert.equal(result.reason, 'retry_scheduled');
    assert.equal(store.state.published.length, 0);
    assert.equal(store.state.retries[0].code, 'DATABASE_UNAVAILABLE');
  } finally { await rm(root, { recursive: true, force: true }); }
});

