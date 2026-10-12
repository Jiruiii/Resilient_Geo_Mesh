import { randomUUID } from 'node:crypto';

import { chunkPayloadBytes, chunkSignatureInput, sha256Bytes } from './canonical.mjs';
import { signCanonical, verifyCanonical } from './crypto.mjs';
import { signEvent, validateChunkShape, validateEventShape, verifyEvent } from './contract.mjs';
import {
  deviceKeyIdForPublicKey,
  isCrowdNamespace,
  isDeviceKeyId,
  publicKeySpkiBase64,
  resolveDeviceKey,
} from './device-key.mjs';
import { bboxOfEvents } from './geo.mjs';
import {
  CROWD_HINT_KINDS,
  CROWD_HINT_PRECISIONS,
  CROWD_HINT_TEXT_MAX_CODE_POINTS,
  CROWD_LOCATION_SOURCES,
  TAIWAN_REPORT_BOUNDS,
  coordinateErrors,
  isoSeconds,
  locationHintErrors,
  roundCoordinate,
} from './crowd-common.mjs';
import { RESCUE_DATASET_ID, RESCUE_MANIFEST_ID, RESCUE_NAMESPACE } from './rescue-contract.mjs';

export {
  CROWD_HINT_KINDS,
  CROWD_HINT_PRECISIONS,
  CROWD_HINT_TEXT_MAX_CODE_POINTS,
  CROWD_LOCATION_SOURCES,
  TAIWAN_REPORT_BOUNDS,
};

/**
 * Crowd report events and their one-report-per-chunk mesh envelope.
 *
 * The Android side (`report/CrowdReportFactory.kt`, `report/CrowdChunkCodec.kt`)
 * must produce and accept exactly what this module does; the shared fixture
 * `fixtures/crowd-reports-v0.json` pins both.
 */

export const CROWD_NAMESPACE = 'crowd.reports';
export const CROWD_DATASET_ID = 'crowd-reports';
export const CROWD_MANIFEST_ID = 'crowd:none';
export const CROWD_EVENT_TYPE = 'CROWD_REPORT';
export const CROWD_SOURCE = 'CROWD';
export const CROWD_SOURCE_VERSION = 'crowd-report-v0';
export const CROWD_TTL_MS = 6 * 60 * 60 * 1000;
export const CROWD_DESCRIPTION_MAX_CODE_POINTS = 160;
export const CROWD_CHUNK_MAX_BYTES = 4096;

/** Wire categories shared with the Flutter form (`crowd_report_models.dart`). */
export const CROWD_CATEGORY_SEVERITY = Object.freeze({
  ROAD_BLOCKAGE: 'MEDIUM',
  FLOOD: 'HIGH',
  FIRE_SMOKE: 'HIGH',
  TRAPPED_INJURED: 'CRITICAL',
  OTHER: 'LOW',
});
export function crowdReportErrors({ category, description = '', lon, lat, locationSource, locationHint }) {
  const errors = locationHintErrors(locationHint);
  if (!(category in CROWD_CATEGORY_SEVERITY)) errors.push('category is not a known crowd report category');
  if (!CROWD_LOCATION_SOURCES.includes(locationSource)) errors.push('location.source is invalid');
  if (typeof description !== 'string') {
    errors.push('description must be a string');
  } else if ([...description.trim()].length > CROWD_DESCRIPTION_MAX_CODE_POINTS) {
    errors.push(`description exceeds ${CROWD_DESCRIPTION_MAX_CODE_POINTS} characters`);
  }
  errors.push(...coordinateErrors(lon, lat));
  return errors;
}

/** Builds and device-signs one crowd report. Mirrors `CrowdReportFactory.create`. */
export function buildCrowdReport({
  category,
  description = '',
  lon,
  lat,
  locationSource,
  locationHint,
  issuedAt = new Date(),
  reportUuid = randomUUID(),
  privateKey,
  publicKey,
  nodeId,
}) {
  const errors = crowdReportErrors({ category, description, lon, lat, locationSource, locationHint });
  if (errors.length > 0) throw new RangeError(errors.join('; '));
  const keyId = deviceKeyIdForPublicKey(publicKey);
  const issued = new Date(issuedAt);
  const attributes = {
    category,
    description: description.trim(),
    location_source: locationSource,
    area_id: 'crowd',
    theme: 'report',
  };
  if (locationHint) {
    attributes.location_hint = {
      method: locationHint.method,
      query: locationHint.query,
      label: locationHint.label,
      kind: locationHint.kind,
      precision: locationHint.precision,
    };
  }
  const event = {
    schema_version: 'event-v0',
    namespace: CROWD_NAMESPACE,
    event_id: `report:${keyId.slice(-8)}:${reportUuid.toLowerCase()}`,
    event_type: CROWD_EVENT_TYPE,
    geometry: { type: 'Point', coordinates: [roundCoordinate(lon), roundCoordinate(lat)] },
    severity: CROWD_CATEGORY_SEVERITY[category],
    source: CROWD_SOURCE,
    source_version: CROWD_SOURCE_VERSION,
    event_version: 1,
    issued_at: isoSeconds(issued),
    expires_at: isoSeconds(new Date(issued.getTime() + CROWD_TTL_MS)),
    attributes,
    signing_key_id: keyId,
    signer_public_key: publicKeySpkiBase64(publicKey),
    provenance: {
      original_source: 'crowd-app',
      received_at: isoSeconds(issued),
      transport_source: nodeId ? { kind: 'local_report', node_id: nodeId } : { kind: 'local_report' },
    },
  };
  return signEvent(event, privateKey);
}

function priorityForSeverity(severity) {
  return severity === 'CRITICAL' || severity === 'HIGH' ? 'HIGH' : 'NORMAL';
}

export const CROWD_CHUNK_PROFILES = Object.freeze({
  [CROWD_DATASET_ID]: Object.freeze({ manifestId: CROWD_MANIFEST_ID, chunkPrefix: 'crowd:', theme: 'report' }),
  [RESCUE_DATASET_ID]: Object.freeze({ manifestId: RESCUE_MANIFEST_ID, chunkPrefix: 'crowd-rescue:', theme: 'rescue' }),
});

function datasetIdForNamespace(namespace) {
  return namespace === RESCUE_NAMESPACE ? RESCUE_DATASET_ID : CROWD_DATASET_ID;
}

function namespaceFitsDataset(datasetId, namespace) {
  if (!isCrowdNamespace(namespace)) return false;
  return datasetId === RESCUE_DATASET_ID ? namespace === RESCUE_NAMESPACE : namespace !== RESCUE_NAMESPACE;
}

/**
 * Wraps one device-signed report into a chunk-v0 signed by the same device key.
 * Relays forward the chunk unchanged, so the original reporter stays traceable.
 */
export function buildCrowdChunk(event, privateKey) {
  const datasetId = datasetIdForNamespace(event.namespace);
  const profile = CROWD_CHUNK_PROFILES[datasetId];
  const content = {
    schema_version: 'chunk-v0',
    chunk_id: `${profile.chunkPrefix}${event.event_id}`,
    manifest_id: profile.manifestId,
    manifest_hash: event.payload_hash,
    dataset_id: datasetId,
    namespace: event.namespace,
    dataset_version: 1,
    sequence: 0,
    priority: priorityForSeverity(event.severity),
    area_id: 'crowd',
    theme: profile.theme,
    bbox: bboxOfEvents([event]),
    created_at: event.issued_at,
    content_type: 'application/json',
    content_encoding: 'identity',
    event_count: 1,
    events: [event],
    signature_algorithm: 'Ed25519',
    signing_key_id: event.signing_key_id,
  };
  const payloadBytes = chunkPayloadBytes(content);
  const unsigned = { ...content, byte_length: payloadBytes.length, chunk_hash: sha256Bytes(payloadBytes) };
  return { ...unsigned, signature: signCanonical(chunkSignatureInput(unsigned), privateKey) };
}

function invalid(stage, error) {
  return { valid: false, stage, errors: [error] };
}

/** Verifies a crowd chunk without any bundled trust entry. Mirrors `CrowdChunkCodec.verify`. */
export function verifyCrowdChunk(chunk, options = {}) {
  if (validateChunkShape(chunk).length > 0) return invalid('schema', 'crowd_chunk_shape_invalid');
  const profile = CROWD_CHUNK_PROFILES[chunk?.dataset_id];
  if (!profile || !namespaceFitsDataset(chunk.dataset_id, chunk?.namespace)) {
    return invalid('binding', 'not_a_crowd_chunk');
  }
  if (!Array.isArray(chunk.events) || chunk.events.length !== 1 || chunk.event_count !== 1) {
    return invalid('binding', 'crowd_chunk_must_hold_one_event');
  }
  const [event] = chunk.events;
  if (validateEventShape(event).length > 0) return invalid('event', 'crowd_event_shape_invalid');
  if (chunk.chunk_id !== `${profile.chunkPrefix}${event.event_id}`
    || chunk.manifest_id !== profile.manifestId
    || chunk.manifest_hash !== event.payload_hash
    || chunk.dataset_version !== 1
    || chunk.namespace !== event.namespace) {
    return invalid('binding', 'crowd_chunk_binding_invalid');
  }
  const payloadBytes = chunkPayloadBytes(chunk);
  if (payloadBytes.length > CROWD_CHUNK_MAX_BYTES) return invalid('size', 'crowd_chunk_too_large');
  if (!isDeviceKeyId(chunk.signing_key_id) || chunk.signing_key_id !== event.signing_key_id) {
    return invalid('trust', 'crowd_chunk_signer_mismatch');
  }
  const device = resolveDeviceKey(event);
  if (!device.key) return invalid('trust', device.error);
  // Reports are points; the Kotlin codec recomputes only Point bboxes.
  if (event.geometry?.type !== 'Point') return invalid('integrity', 'chunk_bbox_mismatch');
  const expectedBbox = bboxOfEvents([event]);
  if (!Array.isArray(chunk.bbox) || expectedBbox.some((value, index) => value !== chunk.bbox[index])) {
    return invalid('integrity', 'chunk_bbox_mismatch');
  }
  if (sha256Bytes(payloadBytes) !== chunk.chunk_hash) return invalid('integrity', 'chunk_hash_mismatch');
  if (payloadBytes.length !== chunk.byte_length) return invalid('integrity', 'chunk_byte_length_mismatch');
  if (!verifyCanonical(chunkSignatureInput(chunk), chunk.signature, device.key)) {
    return invalid('signature', 'chunk_signature_invalid');
  }
  const eventResult = verifyEvent(event, null, options);
  if (!eventResult.valid) return { valid: false, stage: 'event', errors: ['chunk_contains_invalid_event'], eventResults: [eventResult] };
  return { valid: true, current: eventResult.current, eventResults: [eventResult], errors: [] };
}
