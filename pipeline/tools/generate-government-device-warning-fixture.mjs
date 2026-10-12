#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

import { buildGovernmentFeed } from '../lib/government-feed.mjs';
import { signEvent } from '../lib/contract.mjs';
import { deviceKeyIdForPublicKey, publicKeySpkiBase64 } from '../lib/device-key.mjs';
import { signGovernmentDeviceCertificate } from '../lib/government-device-certificate.mjs';

// Deterministic test-only seeds. Never use these keys outside checked-in fixtures.
function keyFromLabel(label) {
  const seed = createHash('sha256').update(label).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8',
  });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

const issuer = keyFromLabel('shared-government-device-warning-fixture-issuer');
const device = keyFromLabel('shared-government-device-warning-fixture-device');
const issuerKeyId = 'central-server-2026';
const certificate = signGovernmentDeviceCertificate({
  certificate_id: 'gov-cert:fixture-0001',
  device_id: 'gov-device:fixture-0001',
  subject_id: 'government-user:fixture-0001',
  signing_key_id: deviceKeyIdForPublicKey(device.publicKey),
  signer_public_key: publicKeySpkiBase64(device.publicKey),
  agency: '測試機關',
  issued_at: '2026-10-01T00:00:00.000Z',
  issuer_key_id: issuerKeyId,
}, issuer.privateKey);

const warning = signEvent({
  schema_version: 'event-v0',
  namespace: 'official.announcement',
  event_id: 'announcement:device:fixture-0001',
  event_type: 'GOVERNMENT_ANNOUNCEMENT',
  geometry: { type: 'Point', coordinates: [121.5, 25.0] },
  severity: 'HIGH',
  source: 'GOVERNMENT',
  source_version: 'fixture-1',
  event_version: 1,
  issued_at: '2026-10-05T00:00:00.000Z',
  expires_at: '2026-11-07T00:00:00.000Z',
  attributes: {
    title: '離線政府警告測試',
    content: '這是跨平台簽章驗證測試資料。',
    category: 'SAFETY',
    area_id: 'tw.national',
    theme: 'announcement',
    has_map_location: true,
    government_device_certificate: certificate,
  },
  signing_key_id: certificate.signing_key_id,
  signer_public_key: certificate.signer_public_key,
  provenance: {
    original_source: 'government-device',
    received_at: '2026-10-05T00:00:00.000Z',
    transport_source: { kind: 'android_mesh' },
  },
}, device.privateKey);

const revocation = signEvent({
  schema_version: 'event-v0',
  namespace: 'official.device-revocation',
  event_id: `device-revocation:${certificate.certificate_id}`,
  event_type: 'GOVERNMENT_DEVICE_REVOKED',
  geometry: { type: 'Point', coordinates: [121, 23.5] },
  severity: 'LOW',
  source: 'GOVERNMENT',
  source_version: '2026-10-06T00:00:00.000Z',
  event_version: 1,
  issued_at: '2026-10-06T00:00:00.000Z',
  expires_at: '2100-01-01T00:00:00.000Z',
  attributes: {
    certificate_id: certificate.certificate_id,
    device_id: certificate.device_id,
    revoked_at: '2026-10-06T00:00:00.000Z',
    area_id: 'tw.national',
    theme: 'device-revocation',
    internal_only: true,
  },
  provenance: {
    original_source: 'government-device-registry',
    received_at: '2026-10-06T00:00:00.000Z',
    transport_source: { kind: 'server', node_id: 'government-fixture' },
  },
}, issuer.privateKey);

const now = new Date('2026-10-07T00:00:00.000Z');
const output = buildGovernmentFeed({
  privateKey: issuer.privateKey,
  publicKey: issuer.publicKey,
  signingKeyId: issuerKeyId,
  now,
  results: [
    { id: 'government-announcements', namespace: 'official.announcement', status: 'ok', events: [warning] },
    { id: 'government-device-revocations', namespace: 'official.device-revocation', status: 'ok', events: [revocation] },
  ],
});
const documents = output.feed.datasets.flatMap((dataset) => dataset.chunk_paths.map((path) => ({
  path,
  chunk: output.files.get(path),
})));
const fixture = {
  schema_version: 'government-device-warning-fixture-v1',
  now: now.toISOString(),
  issuer_key_id: issuerKeyId,
  issuer_public_key_spki_base64: publicKeySpkiBase64(issuer.publicKey),
  certificate,
  event: warning,
  revocation_event: revocation,
  release: { feed: output.feed, documents },
};

const target = new URL('../fixtures/government-device-warning.json', import.meta.url);
await mkdir(new URL('../fixtures/', import.meta.url), { recursive: true });
await writeFile(target, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`Wrote shared device-warning fixture to ${target.pathname}`);
