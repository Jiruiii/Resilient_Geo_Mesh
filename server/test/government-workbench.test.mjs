import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCrowdReport } from '../../pipeline/lib/crowd-report.mjs';
import { generateEd25519KeyPair } from '../../pipeline/lib/crypto.mjs';
import { hashGovernmentPassword } from '../src/government/auth-service.mjs';
import { buildGovernmentApp } from '../src/government/app.mjs';

const now = new Date('2026-10-12T00:00:00Z');

async function memoryStore() {
  const users = new Map();
  const sessions = new Map();
  const reports = new Map();
  const announcements = new Map();
  const outbox = [];
  const audits = [];
  for (const [id, role] of [['government-user', 'GOVERNMENT'], ['system-admin', 'SYSTEM_ADMIN']]) {
    users.set(id, { id, account: id, displayName: id, agency: '試辦機關', role, status: 'ACTIVE',
      passwordHash: await hashGovernmentPassword('A-strong-passphrase-123') });
  }
  return {
    users, sessions, reports, announcements, outbox, audits,
    async findUserForLogin(account) { return [...users.values()].find((row) => row.account === account) ?? null; },
    async createGovernmentUser(input) {
      if ([...users.values()].some((row) => row.account === input.account)) {
        const error = new Error('duplicate account'); error.code = '23505'; throw error;
      }
      const user = { ...input, createdAt: now.toISOString(), updatedAt: now.toISOString() };
      users.set(user.id, user);
      return user;
    },
    async listUsers() { return [...users.values()].map(({ passwordHash, ...user }) => ({
      id: user.id, account: user.account, display_name: user.displayName, agency: user.agency, role: user.role,
      status: user.status, created_at: now.toISOString(), updated_at: now.toISOString(),
    })); },
    async createSession(session) { sessions.set(session.tokenHash, session); },
    async findSession(tokenHash, at) {
      const session = sessions.get(tokenHash);
      const user = session && users.get(session.userId);
      if (!session || session.revokedAt || Date.parse(session.expiresAt) <= at.getTime() || user?.status !== 'ACTIVE') return null;
      return { session, user };
    },
    async updateSessionCsrf(id, hash) { for (const session of sessions.values()) if (session.id === id) session.csrfHash = hash; },
    async revokeSession(hash, at) { const session = sessions.get(hash); if (session) session.revokedAt = at.toISOString(); },
    async disableUser(id, disabled, at) {
      const user = users.get(id);
      if (!user) return null;
      user.status = disabled ? 'DISABLED' : 'ACTIVE';
      if (disabled) for (const session of sessions.values()) if (session.userId === id) session.revokedAt = at.toISOString();
      return user;
    },
    async addAudit(entry) { audits.push(entry); },
    async saveCrowdReport(event) {
      const existing = reports.get(event.event_id);
      if (existing && existing.payload_hash !== event.payload_hash) {
        const error = new Error('id conflict'); error.code = 'REPORT_ID_CONFLICT'; throw error;
      }
      reports.set(event.event_id, existing ?? { event, payload_hash: event.payload_hash, status: 'PENDING' });
      return { duplicate: Boolean(existing) };
    },
    async listCrowdReports() { return [...reports.values()].map((row) => ({ event: row.event, payload_hash: row.payload_hash, status: row.status })); },
    async queueAttestation(input) {
      const row = reports.get(input.eventId);
      if (!row) return { error: 'report_not_found' };
      if (row.payload_hash !== input.payloadHash) return { error: 'payload_hash_mismatch' };
      if (Date.parse(row.event.expires_at) <= input.now.getTime()) return { error: 'report_expired' };
      const version = (row.version ?? 0) + 1;
      row.verdict = input.verdict; row.version = version;
      outbox.push({ aggregateType: 'ATTESTATION', aggregateId: input.eventId, version, payload: input });
      audits.push({ action: 'REPORT_ATTESTATION_QUEUED' });
      return { queued: true, version };
    },
    async createAnnouncement(input) {
      const row = { event_id: input.eventId, event_version: 1, ...input.announcement, retracted: false };
      announcements.set(input.eventId, row);
      outbox.push({ aggregateType: 'ANNOUNCEMENT', aggregateId: input.eventId, version: 1 });
      audits.push({ action: 'ANNOUNCEMENT_CREATED' });
      return row;
    },
    async reviseAnnouncement(input) {
      const row = announcements.get(input.eventId);
      if (!row) return { error: 'announcement_not_found' };
      if (row.retracted) return { error: 'announcement_retracted' };
      row.event_version += 1; Object.assign(row, input.announcement);
      outbox.push({ aggregateType: 'ANNOUNCEMENT', aggregateId: input.eventId, version: row.event_version });
      audits.push({ action: 'ANNOUNCEMENT_REVISED' });
      return { event_id: input.eventId, event_version: row.event_version };
    },
    async retractAnnouncement(input) {
      const row = announcements.get(input.eventId);
      if (!row) return { error: 'announcement_not_found' };
      if (row.retracted) return { event_id: input.eventId, event_version: row.event_version, already_retracted: true };
      row.retracted = true; row.event_version += 1;
      outbox.push({ aggregateType: 'ANNOUNCEMENT', aggregateId: input.eventId, version: row.event_version });
      audits.push({ action: 'ANNOUNCEMENT_RETRACTED' });
      return { event_id: input.eventId, event_version: row.event_version };
    },
    async listAnnouncements() { return [...announcements.values()]; },
  };
}

async function login(app, id = 'government-user') {
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/sessions', payload: {
    account: id, password: 'A-strong-passphrase-123',
  } });
  assert.equal(response.statusCode, 200);
  return response.json().access_token;
}

test('only a system administrator can create government accounts directly', async () => {
  const store = await memoryStore();
  const app = buildGovernmentApp({ store, now: () => now });
  try {
    const governmentToken = await login(app);
    const body = { account: 'new-staff', display_name: '新進人員', agency: '試辦機關', password: 'initial-password' };
    const forbidden = await app.inject({ method: 'POST', url: '/api/v1/government/users',
      headers: { authorization: `Bearer ${governmentToken}` }, payload: body });
    assert.equal(forbidden.statusCode, 403);

    const adminToken = await login(app, 'system-admin');
    const rejectedPassword = await app.inject({ method: 'POST', url: '/api/v1/government/users',
      headers: { authorization: `Bearer ${adminToken}` }, payload: { ...body, password: 'short' } });
    assert.equal(rejectedPassword.statusCode, 400);
    assert.equal(rejectedPassword.json().error, 'invalid_password');
    const created = await app.inject({ method: 'POST', url: '/api/v1/government/users',
      headers: { authorization: `Bearer ${adminToken}` }, payload: body });
    assert.equal(created.statusCode, 201);
    assert.deepEqual(created.json().user, {
      id: created.json().user.id, account: 'new-staff', display_name: '新進人員', agency: '試辦機關',
      role: 'GOVERNMENT', status: 'ACTIVE',
    });
    const loginCreated = await app.inject({ method: 'POST', url: '/api/v1/auth/sessions',
      payload: { account: 'NEW-STAFF', password: 'initial-password' } });
    assert.equal(loginCreated.statusCode, 200);
    assert.equal(loginCreated.json().user.account, 'new-staff');
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/government/invitations',
      headers: { authorization: `Bearer ${adminToken}` }, payload: { account: 'ignored', agency: '試辦機關' } })).statusCode, 404);
  } finally { await app.close(); }
});

test('verified device reports upload idempotently but remain explicitly unverified', async () => {
  const store = await memoryStore();
  const app = buildGovernmentApp({ store, now: () => now });
  const device = generateEd25519KeyPair();
  const event = buildCrowdReport({ category: 'FLOOD', description: '積水', lon: 121.5, lat: 25.0,
    locationSource: 'MAP_PICK', privateKey: device.privateKey, publicKey: device.publicKey, issuedAt: now });
  try {
    const first = await app.inject({ method: 'POST', url: '/api/v1/crowd-reports', payload: event });
    assert.equal(first.statusCode, 202);
    assert.equal(first.json().verification_status, 'UNVERIFIED');
    assert.equal(first.json().review_status, 'PENDING');
    const second = await app.inject({ method: 'POST', url: '/api/v1/crowd-reports', payload: event });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().duplicate, true);

    const modified = buildCrowdReport({ category: 'FLOOD', description: '不同內容', lon: 121.5, lat: 25.0,
      locationSource: 'MAP_PICK', privateKey: device.privateKey, publicKey: device.publicKey,
      issuedAt: now, reportUuid: event.event_id.slice(event.event_id.lastIndexOf(':') + 1) });
    const conflict = await app.inject({ method: 'POST', url: '/api/v1/crowd-reports', payload: modified });
    assert.equal(conflict.statusCode, 409);

    const token = await login(app);
    const pending = await app.inject({ method: 'GET', url: '/api/v1/government/reports?status=PENDING',
      headers: { authorization: `Bearer ${token}` } });
    assert.equal(pending.statusCode, 200);
    assert.equal(pending.json().reports.length, 1);

    const badHash = await app.inject({ method: 'POST', url: `/api/v1/government/reports/${encodeURIComponent(event.event_id)}/attestations`,
      headers: { authorization: `Bearer ${token}` }, payload: { payload_hash: 'sha256:' + '0'.repeat(64), verdict: 'CONFIRMED' } });
    assert.equal(badHash.statusCode, 409);
    const queued = await app.inject({ method: 'POST', url: `/api/v1/government/reports/${encodeURIComponent(event.event_id)}/attestations`,
      headers: { authorization: `Bearer ${token}` }, payload: { payload_hash: event.payload_hash, verdict: 'REFUTED' } });
    assert.equal(queued.statusCode, 202);
    assert.equal(queued.json().publication_status, 'QUEUED');
  } finally { await app.close(); }
});

test('report API rejects invalid device signatures, malformed crowd payloads and expired reports', async () => {
  const app = buildGovernmentApp({ store: await memoryStore(), now: () => now });
  const device = generateEd25519KeyPair();
  const valid = buildCrowdReport({ category: 'FLOOD', description: '積水', lon: 121.5, lat: 25.0,
    locationSource: 'MAP_PICK', privateKey: device.privateKey, publicKey: device.publicKey, issuedAt: now });
  try {
    const invalidSignature = { ...valid, signature: Buffer.alloc(64, 1).toString('base64') };
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/crowd-reports', payload: invalidSignature });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error, 'crowd_report_signature_invalid');

    const expired = buildCrowdReport({ category: 'FLOOD', description: '積水', lon: 121.5, lat: 25.0,
      locationSource: 'MAP_PICK', privateKey: device.privateKey, publicKey: device.publicKey,
      issuedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000) });
    const tooOld = await app.inject({ method: 'POST', url: '/api/v1/crowd-reports', payload: expired });
    assert.equal(tooOld.statusCode, 400);
    assert.equal(tooOld.json().error, 'crowd_report_expired');
  } finally { await app.close(); }
});

test('announcement creation, revision and retraction queue incrementing signed feed versions', async () => {
  const store = await memoryStore();
  const app = buildGovernmentApp({ store, now: () => now });
  try {
    const token = await login(app);
    const headers = { authorization: `Bearer ${token}` };
    const announcement = { title: '道路管制', content: '請改道通行。', category: 'ROAD', severity: 'HIGH',
      area_id: 'tw.63000', expires_at: '2026-11-01T00:00:00Z' };
    const created = await app.inject({ method: 'POST', url: '/api/v1/government/announcements', headers, payload: announcement });
    assert.equal(created.statusCode, 202);
    assert.equal((await store.listAnnouncements())[0].area_id, 'tw.national');
    const eventId = created.json().event_id;
    const revised = await app.inject({ method: 'PUT', url: `/api/v1/government/announcements/${encodeURIComponent(eventId)}`,
      headers, payload: { ...announcement, content: '管制解除前請依現場指示改道。' } });
    assert.equal(revised.json().event_version, 2);
    const retracted = await app.inject({ method: 'DELETE', url: `/api/v1/government/announcements/${encodeURIComponent(eventId)}`, headers });
    assert.equal(retracted.json().event_version, 3);
    assert.deepEqual(store.outbox.filter((row) => row.aggregateType === 'ANNOUNCEMENT').map((row) => row.version), [1, 2, 3]);
    assert.ok(store.audits.some((entry) => entry.action === 'ANNOUNCEMENT_RETRACTED'));
  } finally { await app.close(); }
});

test('browser mutations require same-origin cookies and a matching CSRF token', async () => {
  const app = buildGovernmentApp({ store: await memoryStore(), now: () => now });
  const headers = { origin: 'http://localhost', host: 'localhost' };
  try {
    const loginResponse = await app.inject({ method: 'POST', url: '/api/v1/auth/sessions', headers,
      payload: { account: 'government-user', password: 'A-strong-passphrase-123' } });
    assert.equal(loginResponse.statusCode, 200);
    const cookie = loginResponse.headers['set-cookie'].split(';')[0];
    const csrf = loginResponse.json().csrf_token;
    const payload = { title: '防災提醒', content: '請留意官方訊息。', category: 'SAFETY', severity: 'MEDIUM',
      area_id: 'tw.63000', expires_at: '2026-11-01T00:00:00Z' };
    const denied = await app.inject({ method: 'POST', url: '/api/v1/government/announcements', headers: { ...headers, cookie }, payload });
    assert.equal(denied.statusCode, 403);
    const accepted = await app.inject({ method: 'POST', url: '/api/v1/government/announcements',
      headers: { ...headers, cookie, 'x-csrf-token': csrf }, payload });
    assert.equal(accepted.statusCode, 202);
  } finally { await app.close(); }
});

