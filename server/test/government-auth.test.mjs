import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createGovernmentAuthService } from '../src/government/auth-service.mjs';

function memoryStore() {
  const users = new Map();
  const sessions = new Map();
  const audits = [];
  return {
    users, sessions, audits,
    async findUserForLogin(account) { return [...users.values()].find((user) => user.account === account) ?? null; },
    async createGovernmentUser(user) {
      if ([...users.values()].some((existing) => existing.account === user.account)) {
        const error = new Error('account already exists');
        error.code = '23505';
        throw error;
      }
      users.set(user.id, user);
      return user;
    },
    async createSession(session) { sessions.set(session.tokenHash, session); },
    async findSession(tokenHash, now) {
      const session = sessions.get(tokenHash);
      const user = session && users.get(session.userId);
      if (!session || session.revokedAt || Date.parse(session.expiresAt) <= now.getTime() || user?.status !== 'ACTIVE') return null;
      return { session, user };
    },
    async updateSessionCsrf(sessionId, csrfHash) {
      const session = [...sessions.values()].find((item) => item.id === sessionId);
      if (session) session.csrfHash = csrfHash;
    },
    async revokeSession(tokenHash, now) {
      const session = sessions.get(tokenHash);
      if (session) session.revokedAt = now.toISOString();
    },
    async disableUser(userId, disabled, now) {
      const user = users.get(userId);
      if (!user) return null;
      user.status = disabled ? 'DISABLED' : 'ACTIVE';
      user.updatedAt = now.toISOString();
      if (disabled) for (const session of sessions.values()) if (session.userId === userId) session.revokedAt = now.toISOString();
      return user;
    },
    async addAudit(entry) { audits.push(entry); },
  };
}

test('system administrators create non-email government accounts with long passwords', async () => {
  const store = memoryStore();
  const service = createGovernmentAuthService({ store, now: () => new Date('2026-10-12T00:00:00Z') });
  const longPassword = '長'.repeat(300);
  const created = await service.createUser({
    actorId: 'admin-1', account: '  值班-甲  ', displayName: '值班人員', agency: '試辦機關', password: longPassword,
  });

  assert.deepEqual(created.user, {
    id: created.user.id,
    account: '值班-甲',
    display_name: '值班人員',
    agency: '試辦機關',
    role: 'GOVERNMENT',
    status: 'ACTIVE',
  });
  assert.equal(store.audits.at(-1).action, 'USER_CREATED');
  assert.equal(store.audits.at(-1).details.account, '值班-甲');

  const session = await service.createSession({ account: '值班-甲', password: longPassword });
  assert.equal(session.user.account, '值班-甲');
  await assert.rejects(service.createSession({ account: '值班-甲', password: 'wrong' }),
    (error) => error.code === 'credentials_invalid');
});

test('government account and agency are required, and duplicate accounts are rejected', async () => {
  const store = memoryStore();
  const service = createGovernmentAuthService({ store });
  await assert.rejects(service.createUser({ actorId: 'admin', account: ' ', displayName: '值班人員', agency: '機關', password: 'p' }),
    (error) => error.code === 'invalid_account');
  await assert.rejects(service.createUser({ actorId: 'admin', account: 'staff', displayName: ' ', agency: '機關', password: 'p' }),
    (error) => error.code === 'invalid_display_name');
  await assert.rejects(service.createUser({ actorId: 'admin', account: 'staff', displayName: '值班人員', agency: ' ', password: 'p' }),
    (error) => error.code === 'invalid_agency');
  await assert.rejects(service.createUser({ actorId: 'admin', account: 'staff', displayName: '值班人員', agency: '機關', password: '' }),
    (error) => error.code === 'invalid_password');
  await service.createUser({ actorId: 'admin', account: 'Staff', displayName: '值班人員', agency: '機關', password: 'p'.repeat(12) });
  await assert.rejects(service.createUser({ actorId: 'admin', account: ' staff ', displayName: '另一位', agency: '機關', password: 'p'.repeat(12) }),
    (error) => error.code === 'account_exists');
});

test('government passwords need 12 characters but have no character-composition restriction', async () => {
  const store = memoryStore();
  const service = createGovernmentAuthService({ store });
  await assert.rejects(service.createUser({
    actorId: 'admin', account: 'short', displayName: '值班人員', agency: '機關', password: '!'.repeat(11),
  }), (error) => error.code === 'invalid_password');

  const password = '!'.repeat(12);
  const created = await service.createUser({
    actorId: 'admin', account: 'symbols-only', displayName: '值班人員', agency: '機關', password,
  });
  const session = await service.createSession({ account: 'symbols-only', password });
  assert.equal(session.user.id, created.user.id);
});

test('sessions authenticate, rotate CSRF tokens, and become unusable after account suspension', async () => {
  const store = memoryStore();
  const service = createGovernmentAuthService({ store, now: () => new Date('2026-10-12T00:00:00Z') });
  const created = await service.createUser({ actorId: 'admin', account: 'STAFF-01', displayName: '政府人員', agency: '試辦機關', password: 'A-strong-passphrase-123' });

  await assert.rejects(service.createSession({ account: 'staff-01', password: 'wrong-password' }),
    (error) => error.code === 'credentials_invalid');
  const session = await service.createSession({ account: ' staff-01 ', password: 'A-strong-passphrase-123' });
  assert.ok(session.accessToken);
  assert.ok(session.csrfToken);
  assert.equal(session.user.id, created.user.id);
  assert.equal((await service.resolveSession(session.accessToken)).user.id, session.user.id);
  const rotated = await service.rotateCsrfToken(session.accessToken);
  assert.notEqual(rotated, session.csrfToken);
  await service.setUserDisabled({ actorId: 'admin', userId: session.user.id, disabled: true });
  await assert.rejects(service.resolveSession(session.accessToken), (error) => error.code === 'session_invalid');
  assert.ok(store.audits.some((entry) => entry.action === 'USER_DISABLED'));
});
