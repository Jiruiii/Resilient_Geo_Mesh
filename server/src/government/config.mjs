import path from 'node:path';

function requiredUrl(env, name, protocols) {
  const raw = env[name];
  if (typeof raw !== 'string' || !raw) throw new TypeError(`${name} is required`);
  let parsed;
  try { parsed = new URL(raw); } catch { throw new TypeError(`${name} must be a valid URL`); }
  if (!protocols.includes(parsed.protocol)) throw new TypeError(`${name} uses an unsupported protocol`);
  return raw;
}

function absolutePath(env, name, fallback) {
  const value = env[name] ?? fallback;
  if (!path.isAbsolute(value)) throw new TypeError(`${name} must be an absolute path`);
  return path.normalize(value);
}

function port(env, fallback) {
  const value = Number(env.PORT ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new TypeError('PORT must be 1..65535');
  return value;
}

function databaseSsl(env) {
  switch (env.DATABASE_SSL ?? 'disable') {
    case 'disable': return false;
    case 'require': return { rejectUnauthorized: false };
    case 'verify-full': return { rejectUnauthorized: true };
    default: throw new TypeError('DATABASE_SSL must be disable, require or verify-full');
  }
}

export function loadGovernmentApiConfig(env = process.env) {
  return Object.freeze({
    host: env.HOST ?? '0.0.0.0',
    port: port(env, 8788),
    databaseUrl: requiredUrl(env, 'DATABASE_URL', ['postgres:', 'postgresql:']),
    databaseSsl: databaseSsl(env),
  });
}

export function loadGovernmentPublisherConfig(env = process.env) {
  const privateKeyPath = env.SIGNING_PRIVATE_KEY_PATH;
  if (!privateKeyPath && !env.SIGNING_PRIVATE_KEY_PEM) throw new TypeError('SIGNING_PRIVATE_KEY_PATH or SIGNING_PRIVATE_KEY_PEM is required');
  const publicKeyPath = env.SIGNING_PUBLIC_KEY_PATH;
  if (!publicKeyPath && !env.SIGNING_PUBLIC_KEY_PEM) throw new TypeError('SIGNING_PUBLIC_KEY_PATH or SIGNING_PUBLIC_KEY_PEM is required');
  const signingKeyId = env.SIGNING_KEY_ID;
  if (typeof signingKeyId !== 'string' || !/^[a-z][a-z0-9-]+$/u.test(signingKeyId)) throw new TypeError('SIGNING_KEY_ID is invalid');
  const pollMs = Number(env.PUBLISH_POLL_MS ?? 5000);
  if (!Number.isSafeInteger(pollMs) || pollMs < 1000 || pollMs > 60_000) throw new TypeError('PUBLISH_POLL_MS must be 1000..60000');
  const endpoint = env.AZURE_STORAGE_BLOB_ENDPOINT ? new URL(env.AZURE_STORAGE_BLOB_ENDPOINT) : null;
  if (endpoint && endpoint.protocol !== 'https:') throw new TypeError('AZURE_STORAGE_BLOB_ENDPOINT must be HTTPS');
  return Object.freeze({
    databaseUrl: requiredUrl(env, 'DATABASE_URL', ['postgres:', 'postgresql:']),
    databaseSsl: databaseSsl(env),
    publicReleaseRoot: absolutePath(env, 'PUBLIC_RELEASE_ROOT'),
    privateDataRoot: absolutePath(env, 'PRIVATE_DATA_ROOT', '/var/lib/resilientgeo-private'),
    signingPrivateKeyPath: privateKeyPath ? absolutePath(env, 'SIGNING_PRIVATE_KEY_PATH') : null,
    signingPublicKeyPath: publicKeyPath ? absolutePath(env, 'SIGNING_PUBLIC_KEY_PATH') : null,
    signingPrivateKeyPem: env.SIGNING_PRIVATE_KEY_PEM ?? null,
    signingPublicKeyPem: env.SIGNING_PUBLIC_KEY_PEM ?? null,
    signingKeyId,
    publishPollMs: pollMs,
    azureStorageBlobEndpoint: endpoint?.toString().replace(/\/$/u, '') ?? null,
    azureControlContainer: env.AZURE_CONTROL_CONTAINER ?? 'resilientgeo-control',
    azureReleasePointerBlob: env.AZURE_RELEASE_POINTER_BLOB ?? 'current/release-pointer.json',
    azureCollectorLockBlob: env.AZURE_COLLECTOR_LOCK_BLOB ?? 'locks/collector.lock',
  });
}

export async function createGovernmentPool(config, { PoolClass } = {}) {
  const Pool = PoolClass ?? (await import('pg')).Pool;
  return new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'resilientgeo-government-workbench',
  });
}
