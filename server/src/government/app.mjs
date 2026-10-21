import Fastify from 'fastify';

import { createGovernmentAuthService, GovernmentAuthError } from './auth-service.mjs';
import { createGovernmentWorkbenchService } from './workbench-service.mjs';

const SESSION_COOKIE = 'government_session';
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

function cookieValue(header, name) {
  if (typeof header !== 'string') return null;
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(item.slice(separator + 1).trim()); } catch { return null; }
  }
  return null;
}

function requestToken(request) {
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return { value: authorization.slice('Bearer '.length), cookie: false };
  }
  const cookie = cookieValue(request.headers.cookie, SESSION_COOKIE);
  return cookie ? { value: cookie, cookie: true } : null;
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (typeof origin !== 'string') return null;
  try {
    const parsed = new URL(origin);
    const host = request.headers.host;
    if (!host || parsed.host.toLowerCase() !== host.toLowerCase() || !['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed;
  } catch { return null; }
}

function writeCookie(reply, value, origin) {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/api/v1/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ];
  if (origin?.protocol === 'https:') attributes.push('Secure');
  reply.header('set-cookie', attributes.join('; '));
}

function clearCookie(reply, request) {
  const attributes = [`${SESSION_COOKIE}=`, 'Path=/api/v1/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (request.headers['x-forwarded-proto'] === 'https' || sameOrigin(request)?.protocol === 'https:') attributes.push('Secure');
  reply.header('set-cookie', attributes.join('; '));
}

function requireSameOrigin(request) {
  if (!sameOrigin(request)) throw new GovernmentAuthError('origin_forbidden', 403);
}

async function authenticated(request, authService) {
  const credential = requestToken(request);
  if (!credential) throw new GovernmentAuthError('session_invalid', 401);
  const session = await authService.resolveSession(credential.value);
  request.governmentSession = { ...session, token: credential.value, cookie: credential.cookie };
  return session.user;
}

function requireRoles(user, roles) {
  if (!roles.includes(user.role)) throw new GovernmentAuthError('role_forbidden', 403);
}

async function requireGovernment(request, authService) {
  const user = await authenticated(request, authService);
  requireRoles(user, ['GOVERNMENT', 'SYSTEM_ADMIN']);
  return user;
}

async function requireSystemAdmin(request, authService) {
  const user = await authenticated(request, authService);
  requireRoles(user, ['SYSTEM_ADMIN']);
  return user;
}

async function requireMutation(request, authService) {
  const user = await requireGovernment(request, authService);
  if (request.governmentSession.cookie) {
    requireSameOrigin(request);
    if (!await authService.verifyCsrf(request.governmentSession.token, request.headers['x-csrf-token'])) {
      throw new GovernmentAuthError('csrf_invalid', 403);
    }
  }
  return user;
}

export function buildGovernmentApp({ store, config = {}, logger = false, now } = {}) {
  if (!store) throw new TypeError('government store is required');
  const app = Fastify({ logger, bodyLimit: 64 * 1024, requestTimeout: 10_000, trustProxy: true });
  const auth = createGovernmentAuthService({ store, now });
  const workbench = createGovernmentWorkbenchService({ store, now, config });

  app.get('/api/v1/healthz', async (_request, reply) => {
    try {
      if (typeof store.health === 'function') await store.health();
      return { status: 'ok', announcement_scope_schema: 'affected_area_ids-v1' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  app.post('/api/v1/auth/sessions', async (request, reply) => {
    const origin = request.headers.origin ? sameOrigin(request) : null;
    if (request.headers.origin && !origin) throw new GovernmentAuthError('origin_forbidden', 403);
    const body = request.body ?? {};
    const session = await auth.createSession({ account: body.account, password: body.password, userAgent: request.headers['user-agent'] });
    if (origin) {
      writeCookie(reply, session.accessToken, origin);
      return reply.code(200).send({ user: session.user, csrf_token: session.csrfToken, expires_at: session.expiresAt });
    }
    return reply.code(200).send({ user: session.user, access_token: session.accessToken, expires_at: session.expiresAt });
  });

  app.get('/api/v1/auth/me', async (request, reply) => {
    const user = await authenticated(request, auth);
    if (request.governmentSession.cookie) {
      const csrfToken = await auth.rotateCsrfToken(request.governmentSession.token);
      return reply.send({ user, csrf_token: csrfToken });
    }
    return reply.send({ user });
  });

  app.delete('/api/v1/auth/sessions/current', async (request, reply) => {
    const user = await requireMutation(request, auth);
    await auth.revokeSession(request.governmentSession.token);
    await store.addAudit({ actorId: user.id, action: 'SESSION_REVOKED', subjectId: user.id, details: {},
      createdAt: (now?.() ?? new Date()).toISOString() });
    if (request.governmentSession.cookie) clearCookie(reply, request);
    return reply.code(204).send();
  });

  app.post('/api/v1/government/users', async (request, reply) => {
    const user = await requireMutation(request, auth);
    requireRoles(user, ['SYSTEM_ADMIN']);
    const body = request.body ?? {};
    const created = await auth.createUser({ actorId: user.id, account: body.account,
      displayName: body.display_name, agency: body.agency, password: body.password });
    return reply.code(201).send(created);
  });

  app.patch('/api/v1/government/users/:userId', async (request) => {
    const actor = await requireMutation(request, auth);
    requireRoles(actor, ['SYSTEM_ADMIN']);
    const disabled = request.body?.status === 'DISABLED';
    if (!disabled && request.body?.status !== 'ACTIVE') throw new GovernmentAuthError('user_status_invalid', 400);
    const user = await auth.setUserDisabled({ actorId: actor.id, userId: request.params.userId, disabled });
    return { user };
  });

  app.get('/api/v1/government/users', async (request) => {
    await requireSystemAdmin(request, auth);
    return { users: await store.listUsers() };
  });

  app.post('/api/v1/crowd-reports', async (request, reply) => {
    const result = await workbench.uploadCrowdReport(request.body);
    return reply.code(result.duplicate ? 200 : 202).send(result);
  });

  app.post('/api/v1/government/devices', async (request, reply) => {
    const user = await requireMutation(request, auth);
    const body = request.body ?? {};
    const result = await workbench.enrollGovernmentDevice({ user,
      signingKeyId: body.signing_key_id, signerPublicKey: body.signer_public_key });
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });

  app.get('/api/v1/government/devices/current', async (request) => {
    const user = await requireGovernment(request, auth);
    return workbench.currentGovernmentDevice(user);
  });

  app.post('/api/v1/government/devices/current/renew', async (request) => {
    const user = await requireMutation(request, auth);
    return workbench.renewGovernmentDevice({ user });
  });

  app.get('/api/v1/government/devices', async (request) => {
    await requireSystemAdmin(request, auth);
    return { devices: await workbench.listGovernmentDevices() };
  });

  app.delete('/api/v1/government/devices/:deviceId', async (request) => {
    const actor = await requireMutation(request, auth);
    requireRoles(actor, ['SYSTEM_ADMIN']);
    return workbench.revokeGovernmentDevice({ deviceId: request.params.deviceId, actorId: actor.id });
  });

  app.post('/api/v1/government/warnings', async (request, reply) => {
    const actor = await requireMutation(request, auth);
    const result = await workbench.uploadGovernmentWarning({ actor, event: request.body });
    return reply.code(result.duplicate ? 200 : 202).send(result);
  });

  app.get('/api/v1/government/reports', async (request) => {
    await requireGovernment(request, auth);
    return { reports: await workbench.listReports(request.query?.status ?? 'PENDING') };
  });

  app.post('/api/v1/government/reports/:eventId/attestations', async (request, reply) => {
    const actor = await requireMutation(request, auth);
    const body = request.body ?? {};
    const result = await workbench.attestReport({ actorId: actor.id, eventId: request.params.eventId,
      payloadHash: body.payload_hash, verdict: body.verdict, note: body.note });
    return reply.code(202).send(result);
  });

  app.get('/api/v1/government/announcements', async (request) => {
    await requireGovernment(request, auth);
    return { announcements: await workbench.listAnnouncements() };
  });

  app.post('/api/v1/government/announcements', async (request, reply) => {
    const actor = await requireMutation(request, auth);
    const result = await workbench.createAnnouncement({ actorId: actor.id, input: request.body });
    return reply.code(202).send(result);
  });

  app.put('/api/v1/government/announcements/:eventId', async (request) => {
    const actor = await requireMutation(request, auth);
    return workbench.reviseAnnouncement({ actorId: actor.id, eventId: request.params.eventId, input: request.body });
  });

  app.delete('/api/v1/government/announcements/:eventId', async (request) => {
    const actor = await requireMutation(request, auth);
    return workbench.retractAnnouncement({ actorId: actor.id, eventId: request.params.eventId });
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found' }));
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof GovernmentAuthError) return reply.code(error.statusCode).send({ error: error.code });
    if (error?.validation) return reply.code(400).send({ error: 'invalid_request' });
    requestLog(app, error);
    return reply.code(500).send({ error: 'internal_error' });
  });
  return app;
}

function requestLog(app, error) {
  app.log.error({ code: error?.code ?? 'GOVERNMENT_API_ERROR' }, 'government API request failed');
}
