import { verifyCanonical } from './crypto.mjs';
import {
  chunkPayloadBytes,
  chunkSignatureInput,
  eventPayload,
  eventSignatureInput,
  manifestHashInput,
  manifestSignatureInput,
  sha256Canonical,
  sha256Bytes,
} from './canonical.mjs';
import { signCanonical } from './crypto.mjs';
import { bboxOfEvents } from './geo.mjs';
import { deviceKeyIdFromSpkiBase64, isCrowdNamespace, isDeviceKeyId, resolveDeviceKey } from './device-key.mjs';
import { RESCUE_NAMESPACE, rescueEventErrors, rescueTransitionErrors } from './rescue-contract.mjs';
import { verifyGovernmentDeviceCertificate } from './government-device-certificate.mjs';

const EVENT_REQUIRED = [
  'schema_version',
  'namespace',
  'event_id',
  'event_type',
  'geometry',
  'severity',
  'source',
  'source_version',
  'event_version',
  'issued_at',
  'expires_at',
  'attributes',
  'payload_hash',
  'signature',
  'signature_algorithm',
  'signing_key_id',
  'provenance',
];
const SEVERITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'UNKNOWN']);
const PRIORITIES = new Set(['CRITICAL', 'HIGH', 'NORMAL', 'LOW']);
const SHA256_RE = /^sha256:[0-9a-f]{64}$/i;
const AREA_ID_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const THEME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function bboxErrors(bbox, field) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return [`${field} must be [minLon, minLat, maxLon, maxLat]`];
  }
  if (bbox[0] > bbox[2] || bbox[1] > bbox[3]) return [`${field} min corner must not exceed max corner`];
  return [];
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseTime(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be an RFC 3339 timestamp`);
  }
  return new Date(value);
}

function validBase64(value) {
  if (typeof value !== 'string' || value.length < 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }
  try {
    return Buffer.from(value, 'base64').length > 0;
  } catch {
    return false;
  }
}

export function validateEventShape(event) {
  if (!isObject(event)) return ['event must be an object'];
  const errors = [];
  for (const field of EVENT_REQUIRED) {
    if (!(field in event)) errors.push(`missing required field: ${field}`);
  }
  if (event.schema_version !== 'event-v0') errors.push('schema_version must be event-v0');
  for (const field of ['namespace', 'event_id', 'event_type', 'source', 'source_version', 'signing_key_id']) {
    if (typeof event[field] !== 'string' || event[field].length === 0) {
      errors.push(`${field} must be a non-empty string`);
    }
  }
  if (!SEVERITIES.has(event.severity)) errors.push('severity is not a v0 value');
  if (!Number.isInteger(event.event_version) || event.event_version < 1) {
    errors.push('event_version must be a positive integer');
  }
  let issuedAt;
  let expiresAt;
  try {
    issuedAt = parseTime(event.issued_at, 'issued_at');
  } catch (error) {
    errors.push(error.message);
  }
  try {
    expiresAt = parseTime(event.expires_at, 'expires_at');
  } catch (error) {
    errors.push(error.message);
  }
  if (issuedAt && expiresAt && expiresAt < issuedAt) {
    errors.push('expires_at must not precede issued_at');
  }
  if (!isObject(event.geometry) || typeof event.geometry.type !== 'string') {
    errors.push('geometry must be a GeoJSON geometry object');
  } else if (event.geometry.type !== 'GeometryCollection' && !Array.isArray(event.geometry.coordinates)) {
    errors.push('geometry.coordinates must be an array');
  } else if (event.geometry.type === 'GeometryCollection' && !Array.isArray(event.geometry.geometries)) {
    errors.push('geometry.geometries must be an array');
  }
  if (!isObject(event.attributes)) errors.push('attributes must be an object');
  if (typeof event.payload_hash !== 'string' || !SHA256_RE.test(event.payload_hash)) {
    errors.push('payload_hash must match sha256:<64 hex characters>');
  }
  if (!validBase64(event.signature)) errors.push('signature must be base64');
  if (event.signature_algorithm !== 'Ed25519') errors.push('signature_algorithm must be Ed25519');
  if ('signer_public_key' in event && !validBase64(event.signer_public_key)) {
    errors.push('signer_public_key must be base64');
  } else if (isDeviceKeyId(event.signing_key_id) && !('signer_public_key' in event)) {
    errors.push('signer_public_key is required for device-signed events');
  }
  if (!isObject(event.provenance)) {
    errors.push('provenance must be an object');
  } else {
    if (typeof event.provenance.original_source !== 'string' || !event.provenance.original_source) {
      errors.push('provenance.original_source must be a non-empty string');
    }
    try {
      parseTime(event.provenance.received_at, 'provenance.received_at');
    } catch (error) {
      errors.push(error.message);
    }
    if (!isObject(event.provenance.transport_source) || !event.provenance.transport_source.kind) {
      errors.push('provenance.transport_source.kind is required');
    }
  }
  return errors;
}

export function signEvent(event, privateKey) {
  const payloadHash = sha256Canonical(eventPayload(event));
  const signed = {
    ...event,
    payload_hash: payloadHash,
    signature_algorithm: 'Ed25519',
  };
  return {
    ...signed,
    signature: signCanonical(eventSignatureInput(signed), privateKey),
  };
}

function trustedKey(event, trustedKeyIds) {
  return !trustedKeyIds || trustedKeyIds.length === 0 || trustedKeyIds.includes(event.signing_key_id);
}

export function verifyEvent(event, publicKey, options = {}) {
  const errors = validateEventShape(event);
  if (errors.length > 0) return { valid: false, stage: 'schema', errors, current: false };
  // Device keys remain self-certifying only for crowd.*. Government warnings
  // use a separate path rooted in a centrally signed, time-limited certificate.
  let verificationKey = publicKey;
  if (isDeviceKeyId(event.signing_key_id)) {
    if (event.namespace.startsWith('crowd.')) {
      const device = resolveDeviceKey(event);
      if (!device.key) return { valid: false, stage: 'trust', errors: [device.error], current: false };
      verificationKey = device.key;
    } else if (event.namespace === 'official.announcement' && event.source === 'GOVERNMENT') {
      const certificate = event.attributes?.government_device_certificate;
      if (!certificate) {
        return { valid: false, stage: 'trust', errors: ['government device certificate is required'], current: false };
      }
      if (certificate.signing_key_id !== event.signing_key_id
        || certificate.signer_public_key !== event.signer_public_key) {
        return { valid: false, stage: 'trust', errors: ['event signing key does not match government device certificate'], current: false };
      }
      if (deviceKeyIdFromSpkiBase64(event.signer_public_key) !== event.signing_key_id) {
        return { valid: false, stage: 'trust', errors: ['signing_key_id does not match signer_public_key fingerprint'], current: false };
      }
      const certificateResult = verifyGovernmentDeviceCertificate(certificate, publicKey, {
        ...options,
        at: event.issued_at,
      });
      if (!certificateResult.valid) {
        return { valid: false, stage: 'trust', errors: certificateResult.errors, current: false };
      }
      const revokedAt = options.revokedAtByCertificateId instanceof Map
        ? options.revokedAtByCertificateId.get(certificate.certificate_id)
        : options.revokedAtByCertificateId?.[certificate.certificate_id];
      if (revokedAt && Date.parse(event.issued_at) >= Date.parse(revokedAt)) {
        return { valid: false, stage: 'trust', errors: ['government device certificate was revoked at event issue time'], current: false };
      }
      verificationKey = certificateResult.signerPublicKey;
    } else {
      return { valid: false, stage: 'trust', errors: ['device keys may only sign crowd.* or certified official.announcement events'], current: false };
    }
  } else if (!trustedKey(event, options.trustedKeyIds)) {
    return { valid: false, stage: 'trust', errors: ['signing_key_id is not trusted'], current: false };
  }
  const expectedHash = sha256Canonical(eventPayload(event));
  if (expectedHash !== event.payload_hash) {
    return {
      valid: false,
      stage: 'integrity',
      errors: ['payload_hash_mismatch'],
      expectedHash,
      current: false,
    };
  }
  if (!verificationKey || !verifyCanonical(eventSignatureInput(event), event.signature, verificationKey)) {
    return { valid: false, stage: 'signature', errors: ['signature_invalid'], current: false };
  }
  if (event.namespace === RESCUE_NAMESPACE) {
    const contractErrors = rescueEventErrors(event);
    if (contractErrors.length > 0) return { valid: false, stage: 'contract', errors: contractErrors, current: false };
  }
  const now = options.now ? new Date(options.now) : new Date();
  const expired = now >= parseTime(event.expires_at, 'expires_at');
  return { valid: true, expired, current: !expired, errors: [] };
}

function validateManifestShape(manifest) {
  const errors = [];
  if (!isObject(manifest)) return ['manifest must be an object'];
  for (const field of ['schema_version', 'manifest_id', 'dataset_id', 'namespace', 'source', 'source_version', 'created_at', 'expires_at', 'manifest_hash', 'signature', 'signature_algorithm', 'signing_key_id']) {
    if (!(field in manifest)) errors.push(`missing required field: ${field}`);
  }
  if (manifest.schema_version !== 'manifest-v0') errors.push('schema_version must be manifest-v0');
  if (!Number.isInteger(manifest.dataset_version) || manifest.dataset_version < 1) errors.push('dataset_version must be positive');
  if (!Number.isInteger(manifest.total_event_count) || manifest.total_event_count < 0) errors.push('total_event_count must be non-negative');
  if (!Number.isInteger(manifest.total_size_bytes) || manifest.total_size_bytes < 1) errors.push('total_size_bytes must be positive');
  try { parseTime(manifest.created_at, 'created_at'); } catch (error) { errors.push(error.message); }
  try { parseTime(manifest.expires_at, 'expires_at'); } catch (error) { errors.push(error.message); }
  if (!isObject(manifest.chunking)) errors.push('chunking must be an object');
  if (!Array.isArray(manifest.chunks) || manifest.chunks.length === 0) errors.push('chunks must be a non-empty array');
  if (typeof manifest.manifest_hash !== 'string' || !SHA256_RE.test(manifest.manifest_hash)) errors.push('manifest_hash is invalid');
  if (!validBase64(manifest.signature)) errors.push('manifest signature is invalid');
  if (manifest.signature_algorithm !== 'Ed25519') errors.push('manifest signature_algorithm must be Ed25519');
  return errors;
}

export function verifyManifest(manifest, publicKey, options = {}) {
  const errors = validateManifestShape(manifest);
  if (errors.length > 0) return { valid: false, stage: 'schema', errors };
  if (!trustedKey(manifest, options.trustedKeyIds)) return { valid: false, stage: 'trust', errors: ['signing_key_id is not trusted'] };
  const expectedHash = sha256Canonical(manifestHashInput(manifest));
  if (expectedHash !== manifest.manifest_hash) return { valid: false, stage: 'integrity', errors: ['manifest_hash_mismatch'], expectedHash };
  if (!publicKey || !verifyCanonical(manifestSignatureInput(manifest), manifest.signature, publicKey)) {
    return { valid: false, stage: 'signature', errors: ['manifest_signature_invalid'] };
  }
  const now = options.now ? new Date(options.now) : new Date();
  const expired = now >= parseTime(manifest.expires_at, 'expires_at');
  return { valid: true, expired, current: !expired, errors: [] };
}

export function validateChunkShape(chunk) {
  const errors = [];
  if (!isObject(chunk)) return ['chunk must be an object'];
  for (const field of ['schema_version', 'chunk_id', 'manifest_id', 'manifest_hash', 'dataset_id', 'namespace', 'created_at', 'area_id', 'theme', 'bbox', 'content_type', 'content_encoding', 'chunk_hash', 'events', 'signature', 'signature_algorithm', 'signing_key_id']) {
    if (!(field in chunk)) errors.push(`missing required field: ${field}`);
  }
  if (chunk.schema_version !== 'chunk-v0') errors.push('schema_version must be chunk-v0');
  if (typeof chunk.area_id !== 'string' || !AREA_ID_RE.test(chunk.area_id)) errors.push('area_id is invalid');
  if (typeof chunk.theme !== 'string' || !THEME_RE.test(chunk.theme)) errors.push('theme is invalid');
  errors.push(...bboxErrors(chunk.bbox, 'bbox'));
  if (!Number.isInteger(chunk.dataset_version) || chunk.dataset_version < 1) errors.push('dataset_version must be positive');
  if (!Number.isInteger(chunk.sequence) || chunk.sequence < 0) errors.push('sequence must be non-negative');
  if (!PRIORITIES.has(chunk.priority)) errors.push('priority is invalid');
  try { parseTime(chunk.created_at, 'created_at'); } catch (error) { errors.push(error.message); }
  if (chunk.content_type !== 'application/json') errors.push('content_type must be application/json');
  if (!['identity', 'gzip'].includes(chunk.content_encoding)) errors.push('content_encoding is invalid');
  if (!Number.isInteger(chunk.event_count) || chunk.event_count < 1) errors.push('event_count must be positive');
  if (!Number.isInteger(chunk.byte_length) || chunk.byte_length < 1) errors.push('byte_length must be positive');
  if (!SHA256_RE.test(chunk.manifest_hash)) errors.push('manifest_hash is invalid');
  if (!SHA256_RE.test(chunk.chunk_hash)) errors.push('chunk_hash is invalid');
  if (!Array.isArray(chunk.events) || chunk.events.length === 0) errors.push('events must be non-empty');
  if (!validBase64(chunk.signature)) errors.push('chunk signature is invalid');
  if (chunk.signature_algorithm !== 'Ed25519') errors.push('chunk signature_algorithm must be Ed25519');
  return errors;
}

export function verifyChunk(chunk, manifest, publicKey, options = {}) {
  const errors = validateChunkShape(chunk);
  if (errors.length > 0) return { valid: false, stage: 'schema', errors };
  if (!manifest || chunk.manifest_id !== manifest.manifest_id || chunk.manifest_hash !== manifest.manifest_hash) {
    return { valid: false, stage: 'binding', errors: ['chunk_manifest_binding_invalid'] };
  }
  const expectedEntry = manifest.chunks.find((entry) => entry.chunk_id === chunk.chunk_id);
  if (!expectedEntry) return { valid: false, stage: 'manifest', errors: ['chunk_not_in_manifest'] };
  if (expectedEntry.chunk_hash !== chunk.chunk_hash || expectedEntry.size_bytes !== chunk.byte_length || expectedEntry.event_count !== chunk.event_count) {
    return { valid: false, stage: 'manifest', errors: ['chunk_metadata_mismatch'] };
  }
  if (!trustedKey(chunk, options.trustedKeyIds)) return { valid: false, stage: 'trust', errors: ['chunk signing_key_id is not trusted'] };
  let expectedBbox;
  try {
    expectedBbox = bboxOfEvents(chunk.events);
  } catch {
    return { valid: false, stage: 'integrity', errors: ['chunk_bbox_uncomputable'] };
  }
  if (expectedBbox.length !== chunk.bbox.length || expectedBbox.some((value, index) => value !== chunk.bbox[index])) {
    return { valid: false, stage: 'integrity', errors: ['chunk_bbox_mismatch'], expectedBbox };
  }
  const payloadBytes = chunkPayloadBytes(chunk);
  const expectedHash = sha256Bytes(payloadBytes);
  if (expectedHash !== chunk.chunk_hash) return { valid: false, stage: 'integrity', errors: ['chunk_hash_mismatch'], expectedHash };
  if (payloadBytes.length !== chunk.byte_length) return { valid: false, stage: 'integrity', errors: ['chunk_byte_length_mismatch'], expectedByteLength: payloadBytes.length };
  if (!publicKey || !verifyCanonical(chunkSignatureInput(chunk), chunk.signature, publicKey)) return { valid: false, stage: 'signature', errors: ['chunk_signature_invalid'] };

  const eventResults = chunk.events.map((event) => verifyEvent(event, publicKey, options));
  const invalidEvent = eventResults.find((result) => !result.valid);
  if (invalidEvent) return { valid: false, stage: 'event', errors: ['chunk_contains_invalid_event'], eventResults };
  if (chunk.events.length !== chunk.event_count) return { valid: false, stage: 'completeness', errors: ['event_count_mismatch'], eventResults };
  return { valid: true, current: eventResults.every((result) => result.current), eventResults, errors: [] };
}

export function verifyBundle(bundle, publicKey, options = {}) {
  const manifestResult = verifyManifest(bundle.manifest, publicKey, options);
  if (!manifestResult.valid) return { valid: false, manifest: manifestResult, chunks: [] };
  const expectedIds = new Set(bundle.manifest.chunks.map((chunk) => chunk.chunk_id));
  const actualIds = new Set(bundle.chunks.map((chunk) => chunk.chunk_id));
  const missing = [...expectedIds].filter((id) => !actualIds.has(id));
  if (missing.length > 0) return { valid: false, manifest: manifestResult, chunks: [], errors: ['missing_chunks'], missing };
  const chunkResults = bundle.chunks.map((chunk) => verifyChunk(chunk, bundle.manifest, publicKey, options));
  return {
    valid: chunkResults.every((result) => result.valid),
    manifest: manifestResult,
    chunks: chunkResults,
    errors: chunkResults.filter((result) => !result.valid),
  };
}

export function eventState(event, now = new Date()) {
  const expired = now >= parseTime(event.expires_at, 'expires_at');
  if (expired) return 'expired';
  if (event.namespace === 'official.device-revocation' || event.attributes?.internal_only === true) return 'internal';
  if (event.namespace.startsWith('crowd.')) return 'unverified';
  return 'current';
}

export function ingestEvent(store, event, publicKey, options = {}) {
  const verification = verifyEvent(event, publicKey, options);
  const key = [event?.namespace, event?.event_id];
  if (!verification.valid) return { key, result: 'rejected', reason: verification.errors[0], verification };
  const identity = `${event.namespace}\u0000${event.event_id}`;
  const current = store.get(identity);
  if (!current) {
    const sameEventOtherNamespace = [...store.values()].some((stored) => stored.event_id === event.event_id && stored.namespace !== event.namespace);
    store.set(identity, event);
    return {
      key,
      result: sameEventOtherNamespace ? 'inserted_separate_namespace' : 'inserted',
      state: eventState(event, options.now ? new Date(options.now) : new Date()),
      verification,
    };
  }
  if (event.event_version > current.event_version) {
    const transitionErrors = event.namespace === RESCUE_NAMESPACE
      ? rescueTransitionErrors(current, event)
      : isCrowdNamespace(event.namespace) && current.signing_key_id !== event.signing_key_id
        ? ['signer_mismatch']
        : [];
    if (transitionErrors.length > 0) {
      return {
        key,
        result: 'rejected',
        stored_version_before: current.event_version,
        incoming_version: event.event_version,
        reason: transitionErrors[0],
        verification,
      };
    }
    store.set(identity, event);
    return {
      key,
      result: 'updated',
      stored_version_before: current.event_version,
      incoming_version: event.event_version,
      stored_version_after: event.event_version,
      state: eventState(event, options.now ? new Date(options.now) : new Date()),
      verification,
    };
  }
  if (event.event_version < current.event_version) {
    return {
      key,
      result: 'rejected',
      stored_version_before: current.event_version,
      incoming_version: event.event_version,
      reason: 'version_rollback',
      verification,
    };
  }
  return {
    key,
    result: 'rejected',
    stored_version_before: current.event_version,
    incoming_version: event.event_version,
    reason: 'same_version_conflict',
    verification,
  };
}
