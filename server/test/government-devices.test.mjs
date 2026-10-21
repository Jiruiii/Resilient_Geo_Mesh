import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { signEvent } from '../../pipeline/lib/contract.mjs';
import { generateEd25519KeyPair } from '../../pipeline/lib/crypto.mjs';
import { deviceKeyIdForPublicKey, publicKeySpkiBase64 } from '../../pipeline/lib/device-key.mjs';
import { verifyGovernmentDeviceCertificate } from '../../pipeline/lib/government-device-certificate.mjs';
import { hashGovernmentPassword } from '../src/government/auth-service.mjs';
import { buildGovernmentApp } from '../src/government/app.mjs';
import { publishGovernmentOutboxBatch } from '../src/government/publisher-worker.mjs';

const now = new Date('2026-10-12T00:00:00.000Z');
const issuer = generateEd25519KeyPair();
const issuerKeyId = 'government-feed-2026';

async function memoryStore() {
  const users = new Map();
  const sessions = new Map();
  const devices = new Map();
  const certificates = new Map();
  const warnings = new Map();
  const outbox = [];
  const audits = [];
  for (const [id, role] of [['government-user', 'GOVERNMENT'], ['system-admin', 'SYSTEM_ADMIN']]) {
    users.set(id, { id, account: id, displayName: id, agency: '試辦機關', role, status: 'ACTIVE',
      passwordHash: await hashGovernmentPassword('A-strong-passphrase-123') });
  }

  function queue(item) {
    outbox.push({ id: randomUUID(), attempts: 1, status: 'PENDING', ...item });
  }

  return {
    users, sessions, devices, certificates, warnings, outbox, audits,
    async findUserForLogin(account) { return [...users.values()].find((row) => row.account === account) ?? null; },
    async createSession(session) { sessions.set(session.tokenHash, session); },
    async findSession(hash, at) {
      const session = sessions.get(hash);
      const user = session && users.get(session.userId);
      if (!session || session.revokedAt || Date.parse(session.expiresAt) <= at.getTime() || user?.status !== 'ACTIVE') return null;
      return { session, user };
    },
    async updateSessionCsrf(id, hash) { for (const session of sessions.values()) if (session.id === id) session.csrfHash = hash; },
    async revokeSession(hash, at) { const session = sessions.get(hash); if (session) session.revokedAt = at.toISOString(); },
    async addAudit(entry) { audits.push(entry); },
    async disableUser(userId, disabled, at) {
      const user = users.get(userId);
      if (!user) return null;
      user.status = disabled ? 'DISABLED' : 'ACTIVE';
      if (disabled) {
        for (const session of sessions.values()) if (session.userId === userId) session.revokedAt = at.toISOString();
        for (const device of devices.values()) {
          if (device.user_id === userId && device.status !== 'REVOKED') await this.revokeGovernmentDevice({ deviceId: device.device_id, actorId: null, now: at });
        }
      }
      return user;
    },
    async enrollGovernmentDevice(input) {
      const existing = [...devices.values()].find((row) => row.user_id === input.userId && row.signing_key_id === input.signingKeyId);
      if (existing) return { device_id: existing.device_id, status: existing.status, duplicate: true };
      const device = {
        device_id: input.deviceId,
        user_id: input.userId,
        signing_key_id: input.signingKeyId,
        signer_public_key: input.signerPublicKey,
        subject_id: input.subjectId,
        agency: input.agency,
        status: 'PENDING_CERTIFICATE',
        certificate_version: 1,
        certificate: null,
        revoked_at: null,
      };
      devices.set(device.device_id, device);
      queue({ aggregateType: 'DEVICE_CERTIFICATE', aggregateId: device.device_id, aggregateVersion: 1, payload: input.certificateRequest });
      audits.push({ action: 'GOVERNMENT_DEVICE_ENROLLED', subjectId: device.device_id });
      return { device_id: device.device_id, status: device.status, duplicate: false };
    },
    async currentGovernmentDevice(userId) {
      const device = [...devices.values()].find((row) => row.user_id === userId && row.status !== 'REVOKED');
      return device ? structuredClone(device) : null;
    },
    async queueGovernmentDeviceCertificate(input) {
      const device = devices.get(input.deviceId);
      if (!device || device.user_id !== input.userId) return { error: 'device_not_found' };
      if (device.status === 'REVOKED') return { error: 'device_revoked' };
      const version = device.certificate_version + 1;
      device.certificate_version = version;
      device.status = 'PENDING_CERTIFICATE';
      device.certificate = null;
      queue({ aggregateType: 'DEVICE_CERTIFICATE', aggregateId: device.device_id, aggregateVersion: version, payload: input.certificateRequest });
      audits.push({ action: 'GOVERNMENT_DEVICE_CERTIFICATE_RENEWAL_QUEUED', subjectId: device.device_id });
      return { device_id: device.device_id, status: device.status, certificate_version: version };
    },
    async saveGovernmentDeviceCertificate({ deviceId, certificate }) {
      const device = devices.get(deviceId);
      if (!device || device.status === 'REVOKED') throw new Error('device is not active');
      certificates.set(certificate.certificate_id, { device_id: deviceId, certificate: structuredClone(certificate), revoked_at: null });
      device.certificate = structuredClone(certificate);
      device.status = 'ACTIVE';
      audits.push({ action: 'GOVERNMENT_DEVICE_CERTIFICATE_ISSUED', subjectId: certificate.certificate_id });
    },
    async findGovernmentDeviceCertificate(certificateId, deviceId) {
      const row = certificates.get(certificateId);
      return row?.device_id === deviceId ? structuredClone(row) : null;
    },
    async governmentDeviceForUser({ userId, deviceId }) {
      const row = devices.get(deviceId);
      if (!row || row.user_id !== userId) return null;
      return { device_id: row.device_id, user_id: row.user_id, subject_id: row.subject_id,
        signing_key_id: row.signing_key_id, signer_public_key: row.signer_public_key,
        status: row.status, revoked_at: row.revoked_at };
    },
    async listGovernmentDevices() {
      return [...devices.values()].map(({ user_id, ...device }) => ({ ...structuredClone(device), user_id }));
    },
    async revokeGovernmentDevice({ deviceId, actorId, now: revokedAt }) {
      const device = devices.get(deviceId);
      if (!device) return { error: 'device_not_found' };
      if (device.status === 'REVOKED') return { device_id: deviceId, already_revoked: true };
      device.status = 'REVOKED';
      device.revoked_at = revokedAt.toISOString();
      for (const row of certificates.values()) {
        if (row.device_id !== deviceId || row.revoked_at) continue;
        row.revoked_at = revokedAt.toISOString();
        queue({ aggregateType: 'DEVICE_REVOCATION', aggregateId: row.certificate.certificate_id,
          aggregateVersion: 1, payload: { certificate_id: row.certificate.certificate_id, device_id: deviceId, revoked_at: revokedAt.toISOString() } });
      }
      audits.push({ actorId, action: 'GOVERNMENT_DEVICE_REVOKED', subjectId: deviceId });
      return { device_id: deviceId, already_revoked: false };
    },
    async saveGovernmentWarning({ deviceId, certificateId, event, actorId, now: receivedAt }) {
      const existing = warnings.get(event.event_id);
      if (existing && existing.payload_hash !== event.payload_hash) {
        const error = new Error('warning event id has different content'); error.code = 'GOVERNMENT_WARNING_ID_CONFLICT'; throw error;
      }
      if (existing) return { duplicate: true };
      warnings.set(event.event_id, { device_id: deviceId, certificate_id: certificateId,
        payload_hash: event.payload_hash, event: structuredClone(event), uploaded_at: receivedAt.toISOString() });
      queue({ aggregateType: 'DEVICE_WARNING', aggregateId: event.event_id, aggregateVersion: event.event_version,
        payload: { event_id: event.event_id } });
      audits.push({ actorId, action: 'GOVERNMENT_WARNING_RECEIVED', subjectId: event.event_id });
      return { duplicate: false };
    },
    async claimOutbox() {
      const selected = outbox.filter((item) => item.status === 'PENDING');
      for (const item of selected) item.status = 'PROCESSING';
      return structuredClone(selected);
    },
    async currentAnnouncementEvents() { return []; },
    async currentAttestations() { return []; },
    async markOutboxPublished(items) { for (const item of items) { const row = outbox.find((entry) => entry.id === item.id); if (row) row.status = 'PUBLISHED'; } },
    async retryOutbox(items, code) { for (const item of items) { const row = outbox.find((entry) => entry.id === item.id); if (row) { row.status = 'FAILED'; row.last_error = code; } } },
    async markOutboxRejected(items, code) { for (const item of items) { const row = outbox.find((entry) => entry.id === item.id); if (row) { row.status = 'REJECTED'; row.last_error = code; } } },
  };
}

async function login(app, account = 'government-user') {
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/sessions', payload: {
    account, password: 'A-strong-passphrase-123',
  } });
  assert.equal(response.statusCode, 200);
  return response.json().access_token;
}

async function setup() {
  const store = await memoryStore();
  const app = buildGovernmentApp({
    store,
    config: { trustedKeyIds: [issuerKeyId], trustedKeys: { [issuerKeyId]: issuer.publicKey }, signingKeyId: issuerKeyId },
    now: () => now,
  });
  return { app, store };
}

async function enroll(app, token, deviceKey = generateEd25519KeyPair()) {
  const publicKey = publicKeySpkiBase64(deviceKey.publicKey);
  const response = await app.inject({ method: 'POST', url: '/api/v1/government/devices',
    headers: { authorization: `Bearer ${token}` },
    payload: { signing_key_id: deviceKeyIdForPublicKey(deviceKey.publicKey), signer_public_key: publicKey } });
  return { response, deviceKey };
}

async function issueCertificate(app, store, token, deviceKey) {
  const { response } = await enroll(app, token, deviceKey);
  assert.equal(response.statusCode, 201);
  const root = await mkdtemp(path.join(os.tmpdir(), 'government-device-certificate-'));
  try {
    const published = await publishGovernmentOutboxBatch({ store, releaseRoot: root,
      signingKey: { ...issuer, keyId: issuerKeyId }, now, lockPath: path.join(root, 'publisher.lock') });
    assert.equal(published.published, true);
  } finally { await rm(root, { recursive: true, force: true }); }
  const state = await app.inject({ method: 'GET', url: '/api/v1/government/devices/current',
    headers: { authorization: `Bearer ${token}` } });
  return { device: state.json(), certificate: state.json().certificate, deviceKey };
}

function warningEvent(certificate, deviceKey, overrides = {}) {
  const issuedAt = '2026-10-12T00:00:00.000Z';
  return signEvent({
    schema_version: 'event-v0', namespace: 'official.announcement',
    event_id: `announcement:${randomUUID()}`, event_type: 'GOVERNMENT_ANNOUNCEMENT',
    geometry: { type: 'GeometryCollection', geometries: [] }, severity: 'HIGH', source: 'GOVERNMENT',
    source_version: issuedAt, event_version: 1, issued_at: issuedAt, expires_at: '2026-10-20T00:00:00.000Z',
    attributes: { title: '颱風警戒', content: '請留意官方資訊', category: 'WEATHER', area_id: 'tw.national',
      theme: 'announcement', has_map_location: false, government_device_certificate: certificate },
    signing_key_id: deviceKeyIdForPublicKey(deviceKey.publicKey),
    signer_public_key: publicKeySpkiBase64(deviceKey.publicKey),
    provenance: { original_source: 'government-device', received_at: issuedAt,
      transport_source: { kind: 'android_mesh' } },
    ...overrides,
  }, deviceKey.privateKey);
}

test('government staff can enroll a matching Ed25519 device key; system administrators cannot enroll', async () => {
  const { app } = await setup();
  try {
    const governmentToken = await login(app);
    const { response, deviceKey } = await enroll(app, governmentToken);
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().status, 'PENDING_CERTIFICATE');

    const mismatch = await app.inject({ method: 'POST', url: '/api/v1/government/devices',
      headers: { authorization: `Bearer ${governmentToken}` },
      payload: { signing_key_id: 'device:00000000000000000000000000000000',
        signer_public_key: publicKeySpkiBase64(deviceKey.publicKey) } });
    assert.equal(mismatch.statusCode, 400);

    const adminToken = await login(app, 'system-admin');
    const forbidden = await app.inject({ method: 'POST', url: '/api/v1/government/devices',
      headers: { authorization: `Bearer ${adminToken}` }, payload: {
        signing_key_id: deviceKeyIdForPublicKey(deviceKey.publicKey), signer_public_key: publicKeySpkiBase64(deviceKey.publicKey),
      } });
    assert.equal(forbidden.statusCode, 403);
  } finally { await app.close(); }
});

test('publisher issues a centrally signed seven-day certificate and Android can retrieve it', async () => {
  const { app, store } = await setup();
  try {
    const token = await login(app);
    const { deviceKey } = await enroll(app, token);
    const root = await mkdtemp(path.join(os.tmpdir(), 'government-device-issue-'));
    try {
      const result = await publishGovernmentOutboxBatch({ store, releaseRoot: root,
        signingKey: { ...issuer, keyId: issuerKeyId }, now, lockPath: path.join(root, 'publisher.lock') });
      assert.equal(result.published, true);
    } finally { await rm(root, { recursive: true, force: true }); }

    const current = await app.inject({ method: 'GET', url: '/api/v1/government/devices/current',
      headers: { authorization: `Bearer ${token}` } });
    assert.equal(current.statusCode, 200);
    assert.equal(current.json().status, 'ACTIVE');
    const certificate = current.json().certificate;
    assert.equal(verifyGovernmentDeviceCertificate(certificate, issuer.publicKey, {
      trustedKeyIds: [issuerKeyId], at: now.toISOString(),
    }).valid, true);
    assert.equal(Date.parse(certificate.expires_at) - Date.parse(certificate.issued_at), 7 * 24 * 60 * 60 * 1000);
    assert.equal(certificate.signing_key_id, deviceKeyIdForPublicKey(deviceKey.publicKey));
  } finally { await app.close(); }
});

test('government staff can queue and retrieve a seven-day certificate renewal', async () => {
  const { app, store } = await setup();
  try {
    const token = await login(app);
    await issueCertificate(app, store, token, generateEd25519KeyPair());
    const renewed = await app.inject({ method: 'POST', url: '/api/v1/government/devices/current/renew',
      headers: { authorization: `Bearer ${token}` } });
    assert.equal(renewed.statusCode, 200);
    assert.equal(renewed.json().status, 'PENDING_CERTIFICATE');

    const root = await mkdtemp(path.join(os.tmpdir(), 'government-device-renew-'));
    try {
      const result = await publishGovernmentOutboxBatch({ store, releaseRoot: root,
        signingKey: { ...issuer, keyId: issuerKeyId }, now, lockPath: path.join(root, 'publisher.lock') });
      assert.equal(result.certificates_issued, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
    const current = await app.inject({ method: 'GET', url: '/api/v1/government/devices/current',
      headers: { authorization: `Bearer ${token}` } });
    assert.equal(current.json().status, 'ACTIVE');
    assert.equal(current.json().certificate.certificate_id, store.devices.values().next().value.certificate.certificate_id);
    assert.equal(Date.parse(current.json().certificate.expires_at) - Date.parse(current.json().certificate.issued_at), 7 * 24 * 60 * 60 * 1000);
  } finally { await app.close(); }
});

test('government warning upload verifies the certificate and is idempotent by event id and payload hash', async () => {
  const { app, store } = await setup();
  try {
    const token = await login(app);
    const { certificate, deviceKey } = await issueCertificate(app, store, token, generateEd25519KeyPair());
    const event = warningEvent(certificate, deviceKey);
    const headers = { authorization: `Bearer ${token}` };
    const first = await app.inject({ method: 'POST', url: '/api/v1/government/warnings', headers, payload: event });
    assert.equal(first.statusCode, 202);
    assert.equal(first.json().duplicate, false);
    const retry = await app.inject({ method: 'POST', url: '/api/v1/government/warnings', headers, payload: event });
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().duplicate, true);

    const changed = warningEvent(certificate, deviceKey, {
      event_id: event.event_id,
      attributes: { ...event.attributes, content: '同一事件編號的不同內容' },
    });
    const conflict = await app.inject({ method: 'POST', url: '/api/v1/government/warnings', headers, payload: changed });
    assert.equal(conflict.statusCode, 409);

    const invalidSignature = { ...event, signature: Buffer.alloc(64, 0x55).toString('base64') };
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/government/warnings', headers, payload: invalidSignature });
    assert.equal(invalid.statusCode, 400);
    assert.ok(store.audits.some((entry) => entry.action === 'GOVERNMENT_WARNING_RECEIVED'));
  } finally { await app.close(); }
});

test('government device supply station warnings require a map point', async () => {
  const { app, store } = await setup();
  try {
    const token = await login(app);
    const { certificate, deviceKey } = await issueCertificate(app, store, token, generateEd25519KeyPair());
    const headers = { authorization: `Bearer ${token}` };
    const base = warningEvent(certificate, deviceKey, {
      attributes: {
        ...warningEvent(certificate, deviceKey).attributes,
        category: 'SUPPLY_STATION',
      },
    });
    const missingLocation = await app.inject({
      method: 'POST', url: '/api/v1/government/warnings', headers, payload: base,
    });
    assert.equal(missingLocation.statusCode, 400);
    assert.equal(missingLocation.json().error, 'announcement_location_invalid');

    const located = warningEvent(certificate, deviceKey, {
      geometry: { type: 'Point', coordinates: [121.48, 25.06] },
      attributes: { ...base.attributes, has_map_location: true },
    });
    const accepted = await app.inject({
      method: 'POST', url: '/api/v1/government/warnings', headers, payload: located,
    });
    assert.equal(accepted.statusCode, 202);
    assert.equal(store.warnings.get(located.event_id).event.attributes.category, 'SUPPLY_STATION');
  } finally { await app.close(); }
});

test('government device road and shelter warnings require a map point', async () => {
  const { app, store } = await setup();
  try {
    const token = await login(app);
    const { certificate, deviceKey } = await issueCertificate(app, store, token, generateEd25519KeyPair());
    const headers = { authorization: `Bearer ${token}` };
    for (const category of ['ROAD', 'SHELTER']) {
      const base = warningEvent(certificate, deviceKey, {
        attributes: {
          ...warningEvent(certificate, deviceKey).attributes,
          category,
        },
      });
      const missingLocation = await app.inject({
        method: 'POST', url: '/api/v1/government/warnings', headers, payload: base,
      });
      assert.equal(missingLocation.statusCode, 400);
      assert.equal(missingLocation.json().error, 'announcement_location_invalid');

      const located = warningEvent(certificate, deviceKey, {
        geometry: { type: 'Point', coordinates: [121.48, 25.06] },
        attributes: { ...base.attributes, has_map_location: true },
      });
      const accepted = await app.inject({
        method: 'POST', url: '/api/v1/government/warnings', headers, payload: located,
      });
      assert.equal(accepted.statusCode, 202);
    }
  } finally { await app.close(); }
});

test('government warning upload rejects a device event carrying a tampered central certificate', async () => {
  const { app, store } = await setup();
  try {
    const token = await login(app);
    const { certificate, deviceKey } = await issueCertificate(app, store, token, generateEd25519KeyPair());
    const tampered = { ...certificate, agency: '偽造機關' };
    const response = await app.inject({ method: 'POST', url: '/api/v1/government/warnings',
      headers: { authorization: `Bearer ${token}` }, payload: warningEvent(tampered, deviceKey) });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'government_warning_trust_invalid');
  } finally { await app.close(); }
});

test('system administrator can revoke a device; a revoked device cannot upload warnings', async () => {
  const { app, store } = await setup();
  try {
    const governmentToken = await login(app);
    const { certificate, deviceKey, device } = await issueCertificate(app, store, governmentToken, generateEd25519KeyPair());
    const adminToken = await login(app, 'system-admin');
    const revoked = await app.inject({ method: 'DELETE', url: `/api/v1/government/devices/${encodeURIComponent(device.device_id)}`,
      headers: { authorization: `Bearer ${adminToken}` } });
    assert.equal(revoked.statusCode, 200);

    const denied = await app.inject({ method: 'POST', url: '/api/v1/government/warnings',
      headers: { authorization: `Bearer ${governmentToken}` }, payload: warningEvent(certificate, deviceKey) });
    assert.equal(denied.statusCode, 403);
    assert.ok(store.outbox.some((item) => item.aggregateType === 'DEVICE_REVOCATION'));
    assert.ok(store.audits.some((entry) => entry.action === 'GOVERNMENT_DEVICE_REVOKED'));
  } finally { await app.close(); }
});

test('disabling a government account revokes every enrolled device and queues revocation records', async () => {
  const { app, store } = await setup();
  try {
    const governmentToken = await login(app);
    const { device } = await issueCertificate(app, store, governmentToken, generateEd25519KeyPair());
    const adminToken = await login(app, 'system-admin');
    const disabled = await app.inject({ method: 'PATCH', url: '/api/v1/government/users/government-user',
      headers: { authorization: `Bearer ${adminToken}` }, payload: { status: 'DISABLED' } });
    assert.equal(disabled.statusCode, 200);
    assert.equal(store.devices.get(device.device_id).status, 'REVOKED');
    assert.ok(store.outbox.some((item) => item.aggregateType === 'DEVICE_REVOCATION'));
    const oldSession = await app.inject({ method: 'GET', url: '/api/v1/government/devices/current',
      headers: { authorization: `Bearer ${governmentToken}` } });
    assert.equal(oldSession.statusCode, 401);
  } finally { await app.close(); }
});
