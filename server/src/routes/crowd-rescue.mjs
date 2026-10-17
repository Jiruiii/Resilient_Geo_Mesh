import { verifyCrowdChunk } from '../../../pipeline/lib/crowd-report.mjs';
import { isDeviceKeyId } from '../../../pipeline/lib/device-key.mjs';
import { RESCUE_DATASET_ID, RESCUE_NAMESPACE, rescueTransitionErrors } from '../../../pipeline/lib/rescue-contract.mjs';
import { createRateLimiter } from '../rate-limit.mjs';

const BODY_LIMIT = 8192;
const MAX_BBOX_SPAN = 0.05;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const WRITE_LIMIT_PER_KEY = { limit: 3, windowMs: 60_000 };
const WRITE_LIMIT_PER_IP = { limit: 20, windowMs: 10 * 60_000 };
const READ_LIMIT_PER_IP = { limit: 120, windowMs: 10 * 60_000 };

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejected(reply, status, reason) {
  return reply.code(status).send({ error: 'rejected', reason });
}

function limited(reply, retryAfterMs) {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  reply.header('retry-after', String(seconds));
  return reply.code(429).send({ error: 'rate_limited', retry_after_seconds: seconds });
}

function parseBbox(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(',');
  if (parts.length !== 4) return null;
  const values = parts.map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [minLon, minLat, maxLon, maxLat] = values;
  if (minLon >= maxLon || minLat >= maxLat) return null;
  if (maxLon - minLon > MAX_BBOX_SPAN || maxLat - minLat > MAX_BBOX_SPAN) return null;
  return values;
}

/** A single-event crowd-rescue chunk, before any cryptographic check. */
function looksLikeRescueChunk(chunk) {
  return isObject(chunk)
    && chunk.dataset_id === RESCUE_DATASET_ID
    && chunk.namespace === RESCUE_NAMESPACE
    && Array.isArray(chunk.events) && chunk.events.length === 1 && isObject(chunk.events[0])
    && chunk.events[0].namespace === RESCUE_NAMESPACE
    && isDeviceKeyId(chunk.signing_key_id);
}

/**
 * Rescue requests from browsers and online Android devices. The unit is the
 * crowd-rescue chunk the reporting device signed, so phones that download it
 * can relay it over the mesh unchanged. The server only verifies, stores and
 * returns those chunks; it never signs them and never logs their description
 * or coordinates.
 */
export function registerCrowdRescueRoutes(app, {
  rescueStore,
  rescueOptions: { now = () => new Date(), rateLimiter = createRateLimiter(), listCacheMs = 15_000 } = {},
}) {
  let cachedList = null;
  let cachedAt = 0;

  async function listRecords({ fresh = false } = {}) {
    const at = now().getTime();
    if (!fresh && cachedList && at - cachedAt < listCacheMs) return cachedList;
    cachedList = await rescueStore.list();
    cachedAt = at;
    return cachedList;
  }

  app.post('/v1/crowd/rescue-events', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const ipHit = rateLimiter.hit(`write-ip:${request.ip}`, WRITE_LIMIT_PER_IP.limit, WRITE_LIMIT_PER_IP.windowMs);
    if (!ipHit.allowed) return limited(reply, ipHit.retryAfterMs);

    const chunk = request.body;
    if (!looksLikeRescueChunk(chunk)) return rejected(reply, 400, 'not_rescue_event');
    const [event] = chunk.events;

    const at = now();
    const verification = verifyCrowdChunk(chunk, { now: at });
    if (!verification.valid) {
      // Prefer the event's own reason (e.g. payload_hash_mismatch) over the
      // generic chunk_contains_invalid_event.
      return rejected(reply, 400, verification.eventResults?.[0]?.errors?.[0] ?? verification.errors[0]);
    }
    if (!verification.current) return rejected(reply, 400, 'expired');
    if (Date.parse(event.issued_at) - at.getTime() > FUTURE_SKEW_MS) return rejected(reply, 400, 'issued_in_future');

    const existing = await rescueStore.get(event.event_id);
    if (existing && existing.record.event.payload_hash === event.payload_hash) {
      // An idempotent replay of an already-stored version costs nothing —
      // a client retrying after a dropped response must not be penalized.
      return reply.code(200).send({ result: 'already_accepted', event_id: event.event_id, event_version: existing.record.event.event_version });
    }

    const keyHit = rateLimiter.hit(`write-key:${chunk.signing_key_id}`, WRITE_LIMIT_PER_KEY.limit, WRITE_LIMIT_PER_KEY.windowMs);
    if (!keyHit.allowed) return limited(reply, keyHit.retryAfterMs);

    if (existing) {
      const stored = existing.record.event;
      if (event.event_version < stored.event_version) return rejected(reply, 409, 'version_rollback');
      if (event.event_version === stored.event_version) return rejected(reply, 409, 'same_version_conflict');
      const transitionErrors = rescueTransitionErrors(stored, event);
      if (transitionErrors.length > 0) return rejected(reply, 409, transitionErrors[0]);
    } else if (event.attributes.status === 'ACTIVE') {
      const records = await listRecords({ fresh: true });
      const otherActive = records.some(({ event: other }) => other.signing_key_id === event.signing_key_id
        && other.event_id !== event.event_id
        && other.attributes?.status === 'ACTIVE'
        && Date.parse(other.expires_at) > at.getTime());
      if (otherActive) return rejected(reply, 409, 'rescue_active_exists');
    }

    try {
      await rescueStore.put(
        { event, chunk, stored_at: at.toISOString() },
        existing ? { ifMatch: existing.etag } : { ifNoneMatch: '*' },
      );
    } catch (error) {
      if (error.status === 412) return rejected(reply, 409, 'concurrent_update');
      throw error;
    }
    cachedList = null;
    return reply.code(201).send({ result: 'accepted', event_id: event.event_id, event_version: event.event_version });
  });

  app.get('/v1/crowd/rescue-events', async (request, reply) => {
    const ipHit = rateLimiter.hit(`read-ip:${request.ip}`, READ_LIMIT_PER_IP.limit, READ_LIMIT_PER_IP.windowMs);
    if (!ipHit.allowed) return limited(reply, ipHit.retryAfterMs);
    const bbox = parseBbox(request.query?.bbox);
    if (!bbox) return reply.code(400).send({ error: 'invalid_bbox' });
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const at = now();
    // Chunks go out exactly as uploaded: their chunk_hash covers the event,
    // provenance included, so nothing here may rewrite them.
    const chunks = (await listRecords())
      .filter(({ event }) => event.attributes?.status === 'ACTIVE' && Date.parse(event.expires_at) > at.getTime())
      .filter(({ event }) => {
        const [lon, lat] = event.geometry.coordinates;
        return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
      })
      .map(({ chunk }) => chunk);
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    return reply.code(200).send({ schema_version: 'rescue-feed-v0', generated_at: at.toISOString(), chunks });
  });
}
