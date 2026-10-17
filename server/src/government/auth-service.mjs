import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const MIN_GOVERNMENT_PASSWORD_LENGTH = 12;

export class GovernmentAuthError extends Error {
  constructor(code, statusCode, message = code) {
    super(message);
    this.name = 'GovernmentAuthError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function normalizeGovernmentAccount(value) {
  if (typeof value !== 'string') return null;
  const account = value.trim().toLowerCase();
  if (!account || [...account].length > 120 || /[\u0000-\u001f\u007f]/u.test(account)) return null;
  return account;
}

export function governmentTokenHash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function validateGovernmentPassword(password) {
  if (typeof password !== 'string' || [...password].length < MIN_GOVERNMENT_PASSWORD_LENGTH) {
    throw new GovernmentAuthError('invalid_password', 400);
  }
}

export async function hashGovernmentPassword(password) {
  validateGovernmentPassword(password);
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$8$1$${salt.toString('base64url')}$${Buffer.from(key).toString('base64url')}`;
}

async function passwordMatches(password, encoded) {
  if (typeof password !== 'string' || typeof encoded !== 'string') return false;
  const match = /^scrypt\$32768\$8\$1\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/u.exec(encoded);
  if (!match) return false;
  const expected = Buffer.from(match[2], 'base64url');
  const actual = Buffer.from(await scrypt(password, Buffer.from(match[1], 'base64url'), expected.length,
    { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function publicUser(user) {
  return Object.freeze({
    id: user.id,
    account: user.account,
    display_name: user.displayName ?? user.display_name,
    agency: user.agency,
    role: user.role,
    status: user.status,
  });
}

function token() { return randomBytes(32).toString('base64url'); }

function invalid(code, status = 400, message = code) {
  return new GovernmentAuthError(code, status, message);
}

export function createGovernmentAuthService({ store, now = () => new Date(), sessionTtlMs = SESSION_TTL_MS } = {}) {
  if (!store) throw new TypeError('government store is required');

  async function audit(actorId, action, subjectId, details = {}) {
    await store.addAudit({ actorId, action, subjectId, details, createdAt: now().toISOString() });
  }

  return Object.freeze({
    async createUser({ actorId, account: rawAccount, displayName, agency, password }) {
      const account = normalizeGovernmentAccount(rawAccount);
      if (!account) throw invalid('invalid_account');
      if (typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 120) {
        throw invalid('invalid_display_name');
      }
      if (typeof agency !== 'string' || !agency.trim() || agency.trim().length > 120) throw invalid('invalid_agency');
      validateGovernmentPassword(password);
      const createdAt = now().toISOString();
      const user = {
        id: randomUUID(), account, displayName: displayName.trim(), agency: agency.trim(), role: 'GOVERNMENT',
        status: 'ACTIVE', passwordHash: await hashGovernmentPassword(password), createdAt, updatedAt: createdAt,
      };
      try {
        await store.createGovernmentUser(user);
      } catch (error) {
        if (error.code === '23505' || error.code === 'ACCOUNT_EXISTS') throw invalid('account_exists', 409);
        throw error;
      }
      await audit(actorId, 'USER_CREATED', user.id, { account, role: user.role });
      return { user: publicUser(user) };
    },

    async createSession({ account: rawAccount, password, userAgent = null }) {
      const account = normalizeGovernmentAccount(rawAccount);
      const record = account ? await store.findUserForLogin(account) : null;
      // Run scrypt even for an unknown account to reduce account enumeration by timing.
      const fallbackHash = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const matches = await passwordMatches(password, record?.passwordHash ?? fallbackHash);
      if (!record || record.status !== 'ACTIVE' || !matches) throw invalid('credentials_invalid', 401);

      const accessToken = token();
      const csrfToken = token();
      const createdAt = now();
      await store.createSession({
        id: randomUUID(), tokenHash: governmentTokenHash(accessToken), csrfHash: governmentTokenHash(csrfToken),
        userId: record.id, createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + sessionTtlMs).toISOString(),
        userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 512) : null,
      });
      await audit(record.id, 'SESSION_CREATED', record.id, {});
      return { accessToken, csrfToken, user: publicUser(record), expiresAt: new Date(createdAt.getTime() + sessionTtlMs).toISOString() };
    },

    async resolveSession(accessToken) {
      if (typeof accessToken !== 'string' || accessToken.length < 40 || accessToken.length > 128) {
        throw invalid('session_invalid', 401);
      }
      const result = await store.findSession(governmentTokenHash(accessToken), now());
      if (!result || result.user.status !== 'ACTIVE') throw invalid('session_invalid', 401);
      return { id: result.session.id, user: publicUser(result.user), csrfHash: result.session.csrfHash };
    },

    async rotateCsrfToken(accessToken) {
      const session = await this.resolveSession(accessToken);
      const csrfToken = token();
      await store.updateSessionCsrf(session.id, governmentTokenHash(csrfToken));
      return csrfToken;
    },

    async verifyCsrf(accessToken, csrfToken) {
      if (typeof csrfToken !== 'string' || csrfToken.length < 40 || csrfToken.length > 128) return false;
      const session = await this.resolveSession(accessToken);
      return timingSafeEqual(Buffer.from(session.csrfHash, 'hex'), Buffer.from(governmentTokenHash(csrfToken), 'hex'));
    },

    async revokeSession(accessToken) {
      if (typeof accessToken !== 'string' || accessToken.length < 40 || accessToken.length > 128) return;
      await store.revokeSession(governmentTokenHash(accessToken), now());
    },

    async setUserDisabled({ actorId, userId, disabled }) {
      const user = await store.disableUser(userId, Boolean(disabled), now());
      if (user?.error === 'last_system_admin') throw invalid('last_system_admin', 409);
      if (!user) throw invalid('user_not_found', 404);
      await audit(actorId, disabled ? 'USER_DISABLED' : 'USER_ENABLED', userId, {});
      return publicUser(user);
    },
  });
}
