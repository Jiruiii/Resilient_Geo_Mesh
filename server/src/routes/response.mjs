import { sha256Bytes } from '../../../pipeline/lib/canonical.mjs';

const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function lastModifiedDate(value) {
  const date = value ? new Date(value) : new Date(0);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

export function notFound(reply) {
  return reply.code(404).send({ error: 'not_found' });
}

export function sendPublicJson(request, reply, value, {
  lastModified,
  maxAge = 30,
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    return reply.code(413).send({ error: 'response_too_large' });
  }
  const etag = `"${sha256Bytes(Buffer.from(serialized, 'utf8')).slice(7)}"`;
  reply.header('etag', etag);
  reply.header('last-modified', lastModifiedDate(lastModified).toUTCString());
  reply.header('cache-control', `public, max-age=${maxAge}, must-revalidate`);
  reply.header('x-content-type-options', 'nosniff');
  if (request.headers['if-none-match'] === etag) return reply.code(304).send();
  return reply.type('application/json').send(value);
}

export function publicKeyFromConfig(config = {}) {
  return config.signingPublicKey ?? config.publicKey;
}

export { DEFAULT_MAX_RESPONSE_BYTES };
