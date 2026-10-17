import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { signEvent, verifyEvent } from '../lib/contract.mjs';
import { signCanonical } from '../lib/crypto.mjs';
import { deviceKeyIdForPublicKey, publicKeySpkiBase64 } from '../lib/device-key.mjs';

const sharedDeviceFixture = JSON.parse(await readFile(
  new URL('../fixtures/government-device-warning.json', import.meta.url), 'utf8',
));

const ISSUED_AT = '2026-10-01T12:00:00.000Z';
const RECEIVED_AFTER_CERT_EXPIRY = '2026-10-09T12:00:00.000Z';
const CENTRAL_KEY_ID = 'government-feed-2026';
const PUBLISH_PERMISSION = 'official.announcement.publish';

const central = generateKeyPairSync('ed25519');
const device = generateKeyPairSync('ed25519');
const deviceKeyId = deviceKeyIdForPublicKey(device.publicKey);

function certificate(overrides = {}) {
  const unsigned = {
    schema_version: 'government-device-certificate-v1',
    certificate_id: 'gov-cert:11111111-1111-4111-8111-111111111111',
    device_id: 'gov-device:22222222-2222-4222-8222-222222222222',
    subject_id: '33333333-3333-4333-8333-333333333333',
    signing_key_id: deviceKeyId,
    signer_public_key: publicKeySpkiBase64(device.publicKey),
    agency: '測試機關',
    permissions: [PUBLISH_PERMISSION],
    issued_at: ISSUED_AT,
    expires_at: '2026-10-08T12:00:00.000Z',
    issuer_key_id: CENTRAL_KEY_ID,
    signature_algorithm: 'Ed25519',
    ...overrides,
  };
  return { ...unsigned, signature: signCanonical(unsigned, central.privateKey) };
}

function warning(cert, overrides = {}, signingPrivateKey = device.privateKey) {
  return signEvent({
    schema_version: 'event-v0',
    namespace: 'official.announcement',
    event_id: 'announcement:device:11111111-1111-4111-8111-111111111111',
    event_type: 'GOVERNMENT_ANNOUNCEMENT',
    geometry: { type: 'GeometryCollection', geometries: [] },
    severity: 'HIGH',
    source: 'GOVERNMENT',
    source_version: 'device-test',
    event_version: 1,
    issued_at: '2026-10-02T12:00:00.000Z',
    expires_at: '2026-11-01T12:00:00.000Z',
    attributes: {
      area_id: 'tw.national',
      title: '測試警告',
      content: '測試內容',
      government_device_certificate: cert,
    },
    signing_key_id: deviceKeyId,
    signer_public_key: publicKeySpkiBase64(device.publicKey),
    provenance: {
      original_source: 'government-device',
      received_at: '2026-10-02T12:00:00.000Z',
      transport_source: { kind: 'android_mesh' },
    },
    ...overrides,
  }, signingPrivateKey);
}

const trustedOptions = {
  trustedKeyIds: [CENTRAL_KEY_ID],
  trustedKeys: { [CENTRAL_KEY_ID]: central.publicKey },
  now: '2026-10-03T12:00:00.000Z',
};

test('Node verifies the shared cross-platform government-device warning fixture', () => {
  const issuerPublicKey = createPublicKey({
    key: Buffer.from(sharedDeviceFixture.issuer_public_key_spki_base64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  const result = verifyEvent(sharedDeviceFixture.event, issuerPublicKey, {
    trustedKeyIds: [sharedDeviceFixture.issuer_key_id],
    trustedKeys: { [sharedDeviceFixture.issuer_key_id]: issuerPublicKey },
    now: sharedDeviceFixture.now,
    revokedAtByCertificateId: {
      [sharedDeviceFixture.certificate.certificate_id]: sharedDeviceFixture.revocation_event.attributes.revoked_at,
    },
  });

  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.current, true);
});

test('a central certificate authorizes its matching device key to sign official warnings', () => {
  const result = verifyEvent(warning(certificate()), central.publicKey, trustedOptions);

  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.current, true);
});

test('a warning signed during certificate validity remains valid after certificate expiry', () => {
  const result = verifyEvent(warning(certificate()), central.publicKey, {
    ...trustedOptions,
    now: RECEIVED_AFTER_CERT_EXPIRY,
  });

  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.current, true);
});

test('a device key without a government certificate cannot sign official events', () => {
  const event = warning(certificate());
  delete event.attributes.government_device_certificate;
  const resigned = signEvent(event, device.privateKey);
  const result = verifyEvent(resigned, central.publicKey, trustedOptions);

  assert.equal(result.valid, false);
  assert.equal(result.stage, 'trust');
});

test('an event cannot substitute a different device key than its certificate', () => {
  const otherDevice = generateKeyPairSync('ed25519');
  const event = warning(certificate(), {
    signing_key_id: deviceKeyIdForPublicKey(otherDevice.publicKey),
    signer_public_key: publicKeySpkiBase64(otherDevice.publicKey),
  }, otherDevice.privateKey);
  const result = verifyEvent(event, central.publicKey, trustedOptions);

  assert.equal(result.valid, false);
  assert.equal(result.stage, 'trust');
});

test('government certificate verification rejects modified signatures and untrusted issuers', async () => {
  const api = await import('../lib/government-device-certificate.mjs').catch(() => null);
  assert.ok(api, 'government-device-certificate module must be implemented');

  const valid = api.verifyGovernmentDeviceCertificate(certificate(), central.publicKey, {
    trustedKeyIds: [CENTRAL_KEY_ID],
    at: '2026-10-02T12:00:00.000Z',
  });
  assert.equal(valid.valid, true, JSON.stringify(valid));

  const altered = certificate();
  altered.agency = '遭竄改機關';
  assert.equal(api.verifyGovernmentDeviceCertificate(altered, central.publicKey, {
    trustedKeyIds: [CENTRAL_KEY_ID], at: '2026-10-02T12:00:00.000Z',
  }).valid, false);

  assert.equal(api.verifyGovernmentDeviceCertificate(certificate(), central.publicKey, {
    trustedKeyIds: ['different-central-key'], at: '2026-10-02T12:00:00.000Z',
  }).valid, false);
});

test('government certificate verification binds key fingerprint, permission and issue-time validity', async () => {
  const api = await import('../lib/government-device-certificate.mjs').catch(() => null);
  assert.ok(api, 'government-device-certificate module must be implemented');

  const mismatched = certificate({ signing_key_id: 'device:00000000000000000000000000000000' });
  assert.equal(api.verifyGovernmentDeviceCertificate(mismatched, central.publicKey, {
    trustedKeyIds: [CENTRAL_KEY_ID], at: '2026-10-02T12:00:00.000Z',
  }).valid, false);

  const noPermission = certificate({ permissions: ['official.announcement.read'] });
  assert.equal(api.verifyGovernmentDeviceCertificate(noPermission, central.publicKey, {
    trustedKeyIds: [CENTRAL_KEY_ID], at: '2026-10-02T12:00:00.000Z',
  }).valid, false);

  const expiredAtIssue = warning(certificate({ expires_at: '2026-10-02T11:59:59.000Z' }));
  const result = verifyEvent(expiredAtIssue, central.publicKey, trustedOptions);
  assert.equal(result.valid, false);
  assert.equal(result.stage, 'trust');
});

test('certificate issuer creates a signed seven-day certificate', async () => {
  const api = await import('../lib/government-device-certificate.mjs').catch(() => null);
  assert.ok(api, 'government-device-certificate module must be implemented');

  const issued = api.signGovernmentDeviceCertificate({
    certificate_id: 'gov-cert:44444444-4444-4444-8444-444444444444',
    device_id: 'gov-device:55555555-5555-4555-8555-555555555555',
    subject_id: '66666666-6666-4666-8666-666666666666',
    signing_key_id: deviceKeyId,
    signer_public_key: publicKeySpkiBase64(device.publicKey),
    agency: '測試機關',
    issued_at: ISSUED_AT,
    issuer_key_id: CENTRAL_KEY_ID,
  }, central.privateKey);

  assert.equal(issued.expires_at, '2026-10-08T12:00:00.000Z');
  assert.deepEqual(issued.permissions, [PUBLISH_PERMISSION]);
  assert.equal(api.verifyGovernmentDeviceCertificate(issued, central.publicKey, {
    trustedKeyIds: [CENTRAL_KEY_ID], at: '2026-10-02T12:00:00.000Z',
  }).valid, true);
});
