import {
  CROWD_LOCATION_SOURCES,
  coordinateErrors,
  locationHintErrors,
} from './crowd-common.mjs';

/**
 * Rescue requests (docs/data-contract-v0.md「求救事件」). Kotlin mirror:
 * `report/RescueContract.kt`; Web mirror: `flutter/web/rescue_outbox.js`.
 * Error codes are part of the contract and must match across all three.
 */

export const RESCUE_NAMESPACE = 'crowd.rescue';
export const RESCUE_EVENT_TYPE = 'RESCUE_REQUEST';
export const RESCUE_SOURCE = 'CROWD';
export const RESCUE_SOURCE_VERSION = 'rescue-request-v0';
export const RESCUE_DATASET_ID = 'crowd-rescue';
export const RESCUE_MANIFEST_ID = 'crowd-rescue:none';
export const RESCUE_TTL_MS = 6 * 60 * 60 * 1000;
export const RESCUE_MAX_LIFETIME_MS = 72 * 60 * 60 * 1000;
export const RESCUE_MAX_EVENT_VERSION = 200;
export const RESCUE_PEOPLE_MAX = 50;
export const RESCUE_DESCRIPTION_MAX_CODE_POINTS = 160;

export const RESCUE_REQUEST_TYPES = Object.freeze(['FIRST_AID_NEEDED', 'IMMOBILE', 'TRAPPED', 'TRAPPED_DEBRIS', 'OTHER_RESCUE']);
export const RESCUE_STATUSES = Object.freeze(['ACTIVE', 'RESOLVED', 'CANCELLED']);
export const RESCUE_SUBJECTS = Object.freeze(['SELF', 'OTHERS']);
export const RESCUE_TRIAGE_FIELDS = Object.freeze(['immobile', 'breathing_difficulty', 'severe_bleeding', 'conscious']);
export const RESCUE_TRIAGE_ANSWERS = Object.freeze(['YES', 'NO', 'UNKNOWN']);

const ATTRIBUTE_KEYS = new Set([
  'request_type', 'status', 'subject', 'people_count', 'triage', 'description',
  'location_source', 'location_hint', 'first_issued_at', 'area_id', 'theme',
]);
const EVENT_ID_RE = /^rescue:([0-9a-f]{32}):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function deriveRescueUrgency(requestType, triage) {
  if (requestType === 'TRAPPED_DEBRIS') return 'CRITICAL';
  if (triage?.breathing_difficulty === 'YES' || triage?.severe_bleeding === 'YES' || triage?.conscious === 'NO') {
    return 'CRITICAL';
  }
  if (requestType === 'TRAPPED' || requestType === 'IMMOBILE' || triage?.immobile === 'YES') return 'HIGH';
  return 'MEDIUM';
}

export function rescueEventIdPrefix(signingKeyId) {
  return `rescue:${signingKeyId.slice('device:'.length)}:`;
}

export function isRescueTerminal(status) {
  return status === 'RESOLVED' || status === 'CANCELLED';
}

function triageValid(triage, subject) {
  if (triage === null || typeof triage !== 'object' || Array.isArray(triage)) return false;
  const keys = Object.keys(triage);
  if (keys.length !== RESCUE_TRIAGE_FIELDS.length || !RESCUE_TRIAGE_FIELDS.every((field) => keys.includes(field))) {
    return false;
  }
  if (!RESCUE_TRIAGE_FIELDS.every((field) => RESCUE_TRIAGE_ANSWERS.includes(triage[field]))) return false;
  return subject !== 'SELF' || triage.conscious === 'YES';
}

/**
 * Form-level checks shared by the builders and the event validator. Returns
 * at most one code per field, in a fixed order, so every implementation
 * reports the same first error.
 */
export function rescueFieldErrors({
  requestType, subject, peopleCount, triage, description, lon, lat, locationSource, locationHint,
}) {
  const errors = [];
  if (!RESCUE_REQUEST_TYPES.includes(requestType)) errors.push('rescue_field_invalid:request_type');
  if (!RESCUE_SUBJECTS.includes(subject)) errors.push('rescue_field_invalid:subject');
  if (!Number.isInteger(peopleCount) || peopleCount < 1 || peopleCount > RESCUE_PEOPLE_MAX) {
    errors.push('rescue_field_invalid:people_count');
  }
  if (!triageValid(triage, subject)) errors.push('rescue_field_invalid:triage');
  if (typeof description !== 'string' || [...description.trim()].length > RESCUE_DESCRIPTION_MAX_CODE_POINTS) {
    errors.push('rescue_field_invalid:description');
  }
  if (!CROWD_LOCATION_SOURCES.includes(locationSource)) errors.push('rescue_field_invalid:location_source');
  if (locationHintErrors(locationHint).length > 0) errors.push('rescue_field_invalid:location_hint');
  if (coordinateErrors(lon, lat).length > 0) errors.push('rescue_geometry_invalid');
  return errors;
}

function time(value) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Stateless rules for one crowd.rescue event. Assumes validateEventShape()
 * already passed. Returns the first failing code only.
 */
export function rescueEventErrors(event) {
  const attributes = event.attributes ?? {};
  if (event.namespace !== RESCUE_NAMESPACE || event.event_type !== RESCUE_EVENT_TYPE
    || event.source !== RESCUE_SOURCE || event.source_version !== RESCUE_SOURCE_VERSION
    || attributes.area_id !== 'crowd' || attributes.theme !== 'rescue') {
    return ['rescue_identity_invalid'];
  }
  const match = EVENT_ID_RE.exec(event.event_id);
  if (!match || `device:${match[1]}` !== event.signing_key_id) return ['rescue_event_id_unbound'];
  const geometry = event.geometry;
  if (geometry?.type !== 'Point' || !Array.isArray(geometry.coordinates) || geometry.coordinates.length !== 2) {
    return ['rescue_geometry_invalid'];
  }
  if (Object.keys(attributes).some((key) => !ATTRIBUTE_KEYS.has(key))) return ['rescue_attributes_unknown'];
  const fieldErrors = rescueFieldErrors({
    requestType: attributes.request_type,
    subject: attributes.subject,
    peopleCount: attributes.people_count,
    triage: attributes.triage,
    description: attributes.description,
    lon: geometry.coordinates[0],
    lat: geometry.coordinates[1],
    locationSource: attributes.location_source,
    locationHint: attributes.location_hint,
  });
  if (fieldErrors.length > 0) return [fieldErrors[0]];
  if (!RESCUE_STATUSES.includes(attributes.status)) return ['rescue_field_invalid:status'];
  if (event.severity !== deriveRescueUrgency(attributes.request_type, attributes.triage)) {
    return ['rescue_severity_mismatch'];
  }
  if (event.event_version > RESCUE_MAX_EVENT_VERSION) return ['rescue_version_too_high'];
  const issued = time(event.issued_at);
  const expires = time(event.expires_at);
  const first = time(attributes.first_issued_at);
  if (issued === null || expires === null || first === null || first > issued || expires <= issued
    || (event.event_version === 1 && first !== issued)) {
    return ['rescue_time_invalid'];
  }
  if (expires - issued > RESCUE_TTL_MS) return ['rescue_ttl_too_long'];
  if (expires > first + RESCUE_MAX_LIFETIME_MS) return ['rescue_lifetime_exceeded'];
  return [];
}

/** Rules that need the stored version. `stored` and `incoming` are full events. */
export function rescueTransitionErrors(stored, incoming) {
  if (stored.signing_key_id !== incoming.signing_key_id) return ['signer_mismatch'];
  if (isRescueTerminal(stored.attributes?.status)) return ['rescue_terminal'];
  if (isRescueTerminal(incoming.attributes?.status) && incoming.expires_at !== stored.expires_at) {
    return ['rescue_terminal_expiry_changed'];
  }
  if (incoming.attributes?.first_issued_at !== stored.attributes?.first_issued_at) {
    return ['rescue_first_issued_changed'];
  }
  return [];
}
