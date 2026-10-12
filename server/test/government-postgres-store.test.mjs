import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPostgresGovernmentStore } from '../src/government/postgres-store.mjs';

test('government schema migrations are serialized in one advisory-locked transaction', async () => {
  const statements = [];
  let released = false;
  const client = {
    async query(statement) {
      statements.push(statement);
      return { rowCount: 0, rows: [] };
    },
    release() { released = true; },
  };
  const pool = {
    async query() { return { rowCount: 0, rows: [] }; },
    async connect() { return client; },
  };

  await createPostgresGovernmentStore(pool).migrate();

  assert.equal(statements[0], 'BEGIN');
  assert.match(statements[1], /pg_advisory_xact_lock/u);
  assert.ok(statements.some((statement) => statement.includes('CREATE TABLE IF NOT EXISTS government_users')));
  assert.ok(statements.some((statement) => statement.includes('RENAME COLUMN email TO account')));
  assert.ok(statements.some((statement) => statement.includes('DROP TABLE IF EXISTS government_invitations')));
  assert.ok(statements.some((statement) => statement.includes('CREATE TABLE IF NOT EXISTS government_devices')));
  assert.ok(statements.some((statement) => statement.includes('CREATE TABLE IF NOT EXISTS government_device_certificates')));
  assert.ok(statements.some((statement) => statement.includes('CREATE TABLE IF NOT EXISTS government_warnings')));
  assert.ok(statements.some((statement) => statement.includes("'DEVICE_CERTIFICATE'")));
  assert.equal(statements.at(-1), 'COMMIT');
  assert.equal(released, true);
});

test('failed government schema migration rolls back and releases its client', async () => {
  const statements = [];
  let released = false;
  const client = {
    async query(statement) {
      statements.push(statement);
      if (statement.startsWith('CREATE TABLE IF NOT EXISTS')) throw new Error('migration failed');
      return { rowCount: 0, rows: [] };
    },
    release() { released = true; },
  };
  const pool = {
    async query() { return { rowCount: 0, rows: [] }; },
    async connect() { return client; },
  };

  await assert.rejects(createPostgresGovernmentStore(pool).migrate(), /migration failed/u);
  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.equal(released, true);
});

test('government account storage uses the account column and case-insensitive lookup', async () => {
  const statements = [];
  const createdAt = new Date('2026-10-12T00:00:00Z');
  const row = {
    id: 'user-1', account: 'staff-01', display_name: '值班人員', agency: '試辦機關', role: 'GOVERNMENT',
    status: 'ACTIVE', password_hash: 'scrypt-hash', created_at: createdAt, updated_at: createdAt,
  };
  const pool = {
    async query(statement, values = []) {
      statements.push({ statement, values });
      if (statement.startsWith('INSERT INTO government_users')) return { rowCount: 1, rows: [row] };
      if (statement.startsWith('SELECT * FROM government_users')) return { rowCount: 1, rows: [row] };
      return { rowCount: 0, rows: [] };
    },
    async connect() { throw new Error('not used'); },
  };
  const store = createPostgresGovernmentStore(pool);
  const user = await store.createGovernmentUser({
    id: row.id, account: row.account, displayName: row.display_name, agency: row.agency, role: row.role,
    status: row.status, passwordHash: row.password_hash, createdAt, updatedAt: createdAt,
  });
  const found = await store.findUserForLogin('staff-01');

  assert.equal(user.account, 'staff-01');
  assert.equal(found.account, 'staff-01');
  assert.match(statements[0].statement, /\(id, account, display_name/u);
  assert.match(statements[1].statement, /lower\(account\) = \$1/u);
});

test('government device enrollment writes a certificate request to the outbox in the same transaction', async () => {
  const statements = [];
  const device = { device_id: 'gov-device:device-1', user_id: 'user-1', signing_key_id: 'device:1234',
    signer_public_key: 'cHVibGlj', subject_id: 'subject-1', agency: '試辦機關', status: 'PENDING_CERTIFICATE' };
  const client = {
    async query(statement, values = []) {
      statements.push({ statement, values });
      if (statement.startsWith('INSERT INTO government_devices')) return { rowCount: 1, rows: [device] };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const pool = { async query() { return { rowCount: 0, rows: [] }; }, async connect() { return client; } };
  const request = { certificate_id: 'gov-cert:cert-1', device_id: device.device_id, subject_id: 'subject-1',
    signing_key_id: device.signing_key_id, signer_public_key: device.signer_public_key, agency: device.agency,
    issued_at: '2026-10-12T00:00:00Z', issuer_key_id: 'government-feed-2026' };

  const result = await createPostgresGovernmentStore(pool).enrollGovernmentDevice({
    deviceId: device.device_id, userId: device.user_id, signingKeyId: device.signing_key_id,
    signerPublicKey: device.signer_public_key, subjectId: device.subject_id, agency: device.agency,
    certificateRequest: request, now: new Date('2026-10-12T00:00:00Z'),
  });

  assert.equal(result.device_id, device.device_id);
  assert.equal(result.status, 'PENDING_CERTIFICATE');
  assert.equal(statements[0].statement, 'BEGIN');
  assert.ok(statements.some(({ statement, values }) => statement.includes("'DEVICE_CERTIFICATE'")
    && JSON.parse(values[2]).certificate_id === request.certificate_id));
  assert.equal(statements.at(-1).statement, 'COMMIT');
});

test('government warning store returns exact retries as duplicates and rejects a changed payload hash', async () => {
  let storedHash = 'sha256:' + 'a'.repeat(64);
  const makePool = () => {
    const client = {
      async query(statement) {
        if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') return { rowCount: 0, rows: [] };
        if (statement.startsWith('INSERT INTO government_warnings')) return { rowCount: 0, rows: [] };
        if (statement.startsWith('SELECT payload_hash FROM government_warnings')) return { rowCount: 1, rows: [{ payload_hash: storedHash }] };
        return { rowCount: 1, rows: [] };
      },
      release() {},
    };
    return { async query() { return { rowCount: 0, rows: [] }; }, async connect() { return client; } };
  };
  const store = createPostgresGovernmentStore(makePool());
  const input = { deviceId: 'gov-device:device-1', certificateId: 'gov-cert:cert-1', actorId: 'user-1',
    now: new Date('2026-10-12T00:00:00Z'), event: { event_id: 'announcement:1', event_version: 1,
      payload_hash: 'sha256:' + 'a'.repeat(64), expires_at: '2026-10-13T00:00:00Z' } };

  assert.deepEqual(await store.saveGovernmentWarning(input), { duplicate: true });
  storedHash = 'sha256:' + 'b'.repeat(64);
  await assert.rejects(store.saveGovernmentWarning(input), (error) => error.code === 'GOVERNMENT_WARNING_ID_CONFLICT');
});

test('government publisher store returns active warnings and revoked certificate metadata', async () => {
  const issuedAt = new Date('2026-10-12T00:00:00Z');
  const event = { event_id: 'warning:1' };
  const statements = [];
  const pool = {
    async query(statement, values = []) {
      statements.push({ statement, values });
      if (statement.includes('FROM government_warnings')) return { rowCount: 1, rows: [{ event_json: event }] };
      if (statement.includes('FROM government_device_certificates')) return { rowCount: 1, rows: [
        { certificate_id: 'certificate:1', device_id: 'device:1', revoked_at: issuedAt },
      ] };
      return { rowCount: 0, rows: [] };
    },
    async connect() { throw new Error('not used'); },
  };
  const store = createPostgresGovernmentStore(pool);
  assert.deepEqual(await store.currentGovernmentWarnings({ now: issuedAt }), [event]);
  assert.deepEqual(await store.currentGovernmentRevocations(), [{ certificate_id: 'certificate:1',
    device_id: 'device:1', revoked_at: issuedAt.toISOString() }]);
  assert.match(statements[0].statement, /expires_at > \$1/u);
  assert.match(statements[1].statement, /revoked_at IS NOT NULL/u);
});

test('publishing a device warning marks its source row published in the outbox transaction', async () => {
  const statements = [];
  const client = {
    async query(statement, values = []) { statements.push({ statement, values }); return { rowCount: 1, rows: [] }; },
    release() {},
  };
  const pool = { async query() { return { rowCount: 0, rows: [] }; }, async connect() { return client; } };
  const now = new Date('2026-10-12T00:00:00Z');
  await createPostgresGovernmentStore(pool).markOutboxPublished([{ id: 'outbox-1', aggregateType: 'DEVICE_WARNING',
    aggregateId: 'warning:1', aggregateVersion: 1, payload: { payload_hash: 'sha256:abc' } }], now);
  assert.equal(statements[0].statement, 'BEGIN');
  assert.ok(statements.some(({ statement, values }) => statement.includes("UPDATE government_warnings SET publication_status = 'PUBLISHED'")
    && values[0] === 'warning:1' && values[1] === 'sha256:abc'));
  assert.equal(statements.at(-1).statement, 'COMMIT');
});
