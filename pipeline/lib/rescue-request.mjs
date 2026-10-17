import { randomUUID } from 'node:crypto';

import { signEvent } from './contract.mjs';
import { isoSeconds, roundCoordinate } from './crowd-common.mjs';
import { deviceKeyIdForPublicKey, publicKeySpkiBase64 } from './device-key.mjs';
import {
  RESCUE_EVENT_TYPE,
  RESCUE_MAX_LIFETIME_MS,
  RESCUE_NAMESPACE,
  RESCUE_SOURCE,
  RESCUE_SOURCE_VERSION,
  RESCUE_TTL_MS,
  deriveRescueUrgency,
  isRescueTerminal,
  rescueEventIdPrefix,
  rescueFieldErrors,
} from './rescue-contract.mjs';

/**
 * Builds and device-signs rescue requests. Mirrors `RescueRequestFactory`
 * (Android) and `rescue_outbox.js` (Web); `fixtures/rescue-requests-v0.json`
 * pins all three.
 */

export const RESCUE_ACTIONS = Object.freeze(['UPDATE', 'EXTEND', 'RESOLVE', 'CANCEL']);

function normalizedTriage(subject, triage) {
  return {
    immobile: triage.immobile,
    breathing_difficulty: triage.breathing_difficulty,
    severe_bleeding: triage.severe_bleeding,
    conscious: subject === 'SELF' ? 'YES' : triage.conscious,
  };
}

function attributesFor(input, status, firstIssuedAt) {
  const attributes = {
    request_type: input.requestType,
    status,
    subject: input.subject,
    people_count: input.peopleCount,
    triage: normalizedTriage(input.subject, input.triage),
    description: input.description.trim(),
    location_source: input.locationSource,
    first_issued_at: firstIssuedAt,
    area_id: 'crowd',
    theme: 'rescue',
  };
  if (input.locationHint) {
    const hint = input.locationHint;
    attributes.location_hint = {
      method: hint.method, query: hint.query, label: hint.label, kind: hint.kind, precision: hint.precision,
    };
  }
  return attributes;
}

function assembleAndSign({ input, eventId, version, issued, expires, status, firstIssuedAt, privateKey, publicKey, nodeId }) {
  const errors = rescueFieldErrors({ ...input, triage: normalizedTriage(input.subject ?? '', input.triage ?? {}) });
  if (errors.length > 0) throw new RangeError(errors.join('; '));
  const attributes = attributesFor(input, status, firstIssuedAt);
  const event = {
    schema_version: 'event-v0',
    namespace: RESCUE_NAMESPACE,
    event_id: eventId,
    event_type: RESCUE_EVENT_TYPE,
    geometry: { type: 'Point', coordinates: [roundCoordinate(input.lon), roundCoordinate(input.lat)] },
    severity: deriveRescueUrgency(attributes.request_type, attributes.triage),
    source: RESCUE_SOURCE,
    source_version: RESCUE_SOURCE_VERSION,
    event_version: version,
    issued_at: issued,
    expires_at: expires,
    attributes,
    signing_key_id: deviceKeyIdForPublicKey(publicKey),
    signer_public_key: publicKeySpkiBase64(publicKey),
    provenance: {
      original_source: 'crowd-app',
      received_at: issued,
      transport_source: nodeId ? { kind: 'local_report', node_id: nodeId } : { kind: 'local_report' },
    },
  };
  return signEvent(event, privateKey);
}

export function buildRescueRequest({
  requestType, subject, peopleCount, triage, description = '', lon, lat, locationSource, locationHint,
  issuedAt = new Date(), requestUuid = randomUUID(), privateKey, publicKey, nodeId,
}) {
  const issuedDate = new Date(issuedAt);
  const issued = isoSeconds(issuedDate);
  const keyId = deviceKeyIdForPublicKey(publicKey);
  return assembleAndSign({
    input: { requestType, subject, peopleCount, triage, description, lon, lat, locationSource, locationHint },
    eventId: `${rescueEventIdPrefix(keyId)}${requestUuid.toLowerCase()}`,
    version: 1,
    issued,
    expires: isoSeconds(new Date(Date.parse(issued) + RESCUE_TTL_MS)),
    status: 'ACTIVE',
    firstIssuedAt: issued,
    privateKey,
    publicKey,
    nodeId,
  });
}

export function rescueInputFromEvent(event) {
  const attributes = event.attributes;
  return {
    requestType: attributes.request_type,
    subject: attributes.subject,
    peopleCount: attributes.people_count,
    triage: { ...attributes.triage },
    description: attributes.description,
    lon: event.geometry.coordinates[0],
    lat: event.geometry.coordinates[1],
    locationSource: attributes.location_source,
    locationHint: attributes.location_hint ? { ...attributes.location_hint } : undefined,
  };
}

export function buildRescueRevision(previous, {
  action, changes = {}, issuedAt = new Date(), privateKey, publicKey, nodeId,
}) {
  if (!RESCUE_ACTIONS.includes(action)) throw new RangeError('rescue_action_invalid');
  if (deviceKeyIdForPublicKey(publicKey) !== previous.signing_key_id) throw new RangeError('rescue_revision_wrong_device');
  if (isRescueTerminal(previous.attributes.status)) throw new RangeError('rescue_revision_terminal');
  const issued = isoSeconds(new Date(issuedAt));
  const issuedMs = Date.parse(issued);
  const previousExpires = Date.parse(previous.expires_at);
  if (issuedMs >= previousExpires) throw new RangeError('rescue_revision_expired');

  const base = rescueInputFromEvent(previous);
  const input = action === 'UPDATE' ? { ...base, ...changes } : base;
  const firstIssuedAt = previous.attributes.first_issued_at;
  let expires = previous.expires_at;
  if (action === 'EXTEND') {
    const extended = Math.min(issuedMs + RESCUE_TTL_MS, Date.parse(firstIssuedAt) + RESCUE_MAX_LIFETIME_MS);
    if (extended <= previousExpires) throw new RangeError('rescue_extend_not_later');
    expires = isoSeconds(new Date(extended));
  }
  const status = action === 'RESOLVE' ? 'RESOLVED' : action === 'CANCEL' ? 'CANCELLED' : 'ACTIVE';
  return assembleAndSign({
    input,
    eventId: previous.event_id,
    version: previous.event_version + 1,
    issued,
    expires,
    status,
    firstIssuedAt,
    privateKey,
    publicKey,
    nodeId,
  });
}
