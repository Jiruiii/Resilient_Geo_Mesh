import { createHash } from 'node:crypto';

import { sha256Canonical } from './canonical.mjs';
import { signCanonical, verifyCanonical } from './crypto.mjs';

const AREA_RE = /^[a-z][a-z0-9._-]{0,63}$/u;
const THEME_RE = /^[a-z][a-z0-9_-]{0,31}$/u;
const HASH_RE = /^sha256:[0-9a-f]{64}$/u;

function dateString(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${field} must be a valid date`);
  return date.toISOString();
}

function areaIdOf(event) {
  const value = event?.attributes?.area_id;
  return typeof value === 'string' && AREA_RE.test(value) ? value : 'tw.unknown';
}

function themeOf(event) {
  const candidate = event?.attributes?.theme
    ?? event?.event_type?.toLowerCase().replace(/[^a-z0-9_-]/gu, '-');
  const value = typeof candidate === 'string' ? candidate : 'unknown';
  return THEME_RE.test(value) ? value : 'unknown';
}

function shardOf(eventId) {
  return createHash('sha256').update(eventId, 'utf8').digest()[0].toString(16).padStart(2, '0');
}

function chunkCore(group, events, signingKeyId) {
  const chunkId = `g2-${sha256Canonical(group).slice('sha256:'.length, 'sha256:'.length + 24)}`;
  return {
    schema_version: 'government-feed-chunk-v2',
    chunk_id: chunkId,
    area_id: group.area_id,
    theme: group.theme,
    shard: group.shard,
    event_count: events.length,
    events,
    signing_key_id: signingKeyId,
    signature_algorithm: 'Ed25519',
  };
}

function signChunk(group, events, privateKey, signingKeyId) {
  const core = chunkCore(group, events, signingKeyId);
  const chunkHash = sha256Canonical(core);
  const signedInput = { ...core, chunk_hash: chunkHash };
  return { ...signedInput, signature: signCanonical(signedInput, privateKey) };
}

function manifestCore({ revision, createdAt, expiresAt, chunks, signingKeyId }) {
  return {
    schema_version: 'government-feed-v2',
    revision,
    created_at: createdAt,
    expires_at: expiresAt,
    signing_key_id: signingKeyId,
    signature_algorithm: 'Ed25519',
    chunks,
  };
}

export function buildGovernmentFeedV2({ events, revision, createdAt = new Date(), expiresAt,
  signingKeyId, privateKey, previousChunks = [] } = {}) {
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError('revision must be a positive integer');
  if (!privateKey) throw new TypeError('privateKey is required');
  if (typeof signingKeyId !== 'string' || !/^[a-z][a-z0-9-]+$/u.test(signingKeyId)) {
    throw new TypeError('signingKeyId is invalid');
  }
  const created = dateString(createdAt, 'createdAt');
  const expires = dateString(expiresAt, 'expiresAt');
  if (Date.parse(expires) <= Date.parse(created)) throw new RangeError('expiresAt must be later than createdAt');

  const groups = new Map();
  for (const event of events) {
    if (!event || typeof event.event_id !== 'string' || event.event_id.length === 0) {
      throw new TypeError('each event must have an event_id');
    }
    const group = {
      area_id: areaIdOf(event),
      theme: themeOf(event),
      shard: shardOf(event.event_id),
    };
    const key = `${group.area_id}\u0000${group.theme}\u0000${group.shard}`;
    if (!groups.has(key)) groups.set(key, { group, events: [] });
    groups.get(key).events.push(event);
  }

  const files = new Map();
  const manifestChunks = [];
  const previousByGroup = new Map(previousChunks.map((chunk) => [
    `${chunk.area_id}\u0000${chunk.theme}\u0000${chunk.shard}`,
    chunk,
  ]));
  let reusedChunkCount = 0;
  let rebuiltChunkCount = 0;
  for (const { group, events: groupedEvents } of [...groups.values()].sort((left, right) =>
    `${left.group.area_id}/${left.group.theme}/${left.group.shard}`
      .localeCompare(`${right.group.area_id}/${right.group.theme}/${right.group.shard}`))) {
    const sortedEvents = groupedEvents.slice().sort((left, right) => left.event_id.localeCompare(right.event_id));
    const groupKey = `${group.area_id}\u0000${group.theme}\u0000${group.shard}`;
    const previousChunk = previousByGroup.get(groupKey);
    const canReuse = previousChunk?.signing_key_id === signingKeyId
      && Array.isArray(previousChunk.events)
      && sha256Canonical(previousChunk.events) === sha256Canonical(sortedEvents);
    const chunk = canReuse ? previousChunk : signChunk(group, sortedEvents, privateKey, signingKeyId);
    if (canReuse) reusedChunkCount += 1;
    else rebuiltChunkCount += 1;
    const chunkHash = sha256Canonical(chunk);
    const hashHex = chunkHash.slice('sha256:'.length);
    const relativePath = `v2/chunks/${hashHex}.json`;
    files.set(relativePath, chunk);
    manifestChunks.push({
      chunk_id: chunk.chunk_id,
      area_id: group.area_id,
      theme: group.theme,
      shard: group.shard,
      sha256: chunkHash,
      event_count: sortedEvents.length,
      path: relativePath,
    });
  }

  const core = manifestCore({
    revision,
    createdAt: created,
    expiresAt: expires,
    chunks: manifestChunks,
    signingKeyId,
  });
  const manifestHash = sha256Canonical(core);
  const signedInput = { ...core, manifest_hash: manifestHash };
  const manifest = { ...signedInput, signature: signCanonical(signedInput, privateKey) };
  const manifestPath = `v2/manifests/${manifestHash.slice('sha256:'.length)}.json`;
  files.set(manifestPath, manifest);
  return { manifest, manifestPath, files, reusedChunkCount, rebuiltChunkCount };
}

export function verifyGovernmentChunkV2(chunk, publicKey, { trustedKeyIds } = {}) {
  if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) return { valid: false, reason: 'schema' };
  const { signature, chunk_hash: chunkHash, ...core } = chunk;
  if (chunk.schema_version !== 'government-feed-chunk-v2'
    || typeof chunk.chunk_id !== 'string'
    || !AREA_RE.test(chunk.area_id)
    || !THEME_RE.test(chunk.theme)
    || !/^[0-9a-f]{2}$/u.test(chunk.shard)
    || !Array.isArray(chunk.events)
    || chunk.event_count !== chunk.events.length
    || !HASH_RE.test(chunkHash ?? '')
    || typeof signature !== 'string'
    || chunk.signature_algorithm !== 'Ed25519') return { valid: false, reason: 'schema' };
  if (trustedKeyIds && !trustedKeyIds.includes(chunk.signing_key_id)) return { valid: false, reason: 'trust' };
  if (sha256Canonical(core) !== chunkHash) return { valid: false, reason: 'integrity' };
  if (!verifyCanonical({ ...core, chunk_hash: chunkHash }, signature, publicKey)) {
    return { valid: false, reason: 'signature' };
  }
  if (chunk.events.some((event) => !event || typeof event.event_id !== 'string'
    || shardOf(event.event_id) !== chunk.shard
    || areaIdOf(event) !== chunk.area_id
    || themeOf(event) !== chunk.theme)) return { valid: false, reason: 'group' };
  return { valid: true };
}

export function verifyGovernmentFeedV2(manifest, chunks, publicKey, { trustedKeyIds, now } = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.schema_version !== 'government-feed-v2'
    || !Number.isSafeInteger(manifest.revision) || manifest.revision < 1
    || !Array.isArray(manifest.chunks)
    || manifest.signature_algorithm !== 'Ed25519'
    || !HASH_RE.test(manifest.manifest_hash ?? '')
    || typeof manifest.signature !== 'string') return { valid: false, reason: 'schema' };
  if (trustedKeyIds && !trustedKeyIds.includes(manifest.signing_key_id)) return { valid: false, reason: 'trust' };
  const { signature, manifest_hash: manifestHash, ...signedInput } = manifest;
  const { manifest_hash: _excluded, ...core } = signedInput;
  if (sha256Canonical(core) !== manifestHash) return { valid: false, reason: 'integrity' };
  if (!verifyCanonical({ ...core, manifest_hash: manifestHash }, signature, publicKey)) {
    return { valid: false, reason: 'signature' };
  }
  const timestamp = now === undefined ? Date.now() : new Date(now).getTime();
  if (!Number.isFinite(Date.parse(manifest.created_at)) || !Number.isFinite(Date.parse(manifest.expires_at))
    || Date.parse(manifest.expires_at) <= timestamp) return { valid: false, reason: 'expired' };
  if (!Array.isArray(chunks) || chunks.length !== manifest.chunks.length) return { valid: false, reason: 'chunks' };
  const byHash = new Map(chunks.map((chunk) => [sha256Canonical(chunk), chunk]));
  for (const entry of manifest.chunks) {
    if (!entry || !HASH_RE.test(entry.sha256 ?? '') || typeof entry.path !== 'string'
      || !/^v2\/chunks\/[0-9a-f]{64}\.json$/u.test(entry.path)
      || entry.path !== `v2/chunks/${entry.sha256.slice('sha256:'.length)}.json`) {
      return { valid: false, reason: 'manifest_chunk' };
    }
    const chunk = byHash.get(entry.sha256);
    if (!chunk || chunk.chunk_id !== entry.chunk_id || chunk.area_id !== entry.area_id
      || chunk.theme !== entry.theme || chunk.shard !== entry.shard
      || chunk.event_count !== entry.event_count) return { valid: false, reason: 'chunk_binding' };
    const result = verifyGovernmentChunkV2(chunk, publicKey, { trustedKeyIds });
    if (!result.valid) return result;
  }
  return { valid: true, current: true };
}
