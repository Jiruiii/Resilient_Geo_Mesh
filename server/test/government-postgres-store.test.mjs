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
