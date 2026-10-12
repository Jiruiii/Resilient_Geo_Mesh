import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  deriveRescueUrgency,
  rescueEventErrors,
  rescueEventIdPrefix,
  rescueFieldErrors,
  rescueTransitionErrors,
} from '../lib/rescue-contract.mjs';

const KEY_ID = `device:${'a'.repeat(32)}`;
const triage = (overrides = {}) => ({
  immobile: 'NO',
  breathing_difficulty: 'NO',
  severe_bleeding: 'NO',
  conscious: 'YES',
  ...overrides,
});
const input = (overrides = {}) => ({
  requestType: 'TRAPPED',
  subject: 'OTHERS',
  peopleCount: 2,
  triage: triage(),
  description: '一樓樓梯間',
  lon: 121.588123,
  lat: 25.069876,
  locationSource: 'CURRENT_LOCATION',
  ...overrides,
});

function event(overrides = {}, attributeOverrides = {}) {
  return {
    schema_version: 'event-v0',
    namespace: 'crowd.rescue',
    event_id: `${rescueEventIdPrefix(KEY_ID)}00000000-0000-4000-8000-000000000001`,
    event_type: 'RESCUE_REQUEST',
    geometry: { type: 'Point', coordinates: [121.588123, 25.069876] },
    severity: 'HIGH',
    source: 'CROWD',
    source_version: 'rescue-request-v0',
    event_version: 1,
    issued_at: '2026-10-12T03:00:00Z',
    expires_at: '2026-10-12T09:00:00Z',
    attributes: {
      request_type: 'TRAPPED',
      status: 'ACTIVE',
      subject: 'OTHERS',
      people_count: 2,
      triage: triage(),
      description: '一樓樓梯間',
      location_source: 'CURRENT_LOCATION',
      first_issued_at: '2026-10-12T03:00:00Z',
      area_id: 'crowd',
      theme: 'rescue',
      ...attributeOverrides,
    },
    signing_key_id: KEY_ID,
    ...overrides,
  };
}

test('urgency follows the approved table and ignores people count', () => {
  assert.equal(deriveRescueUrgency('TRAPPED_DEBRIS', triage()), 'CRITICAL');
  assert.equal(deriveRescueUrgency('FIRST_AID_NEEDED', triage({ breathing_difficulty: 'YES' })), 'CRITICAL');
  assert.equal(deriveRescueUrgency('FIRST_AID_NEEDED', triage({ severe_bleeding: 'YES' })), 'CRITICAL');
  assert.equal(deriveRescueUrgency('OTHER_RESCUE', triage({ conscious: 'NO' })), 'CRITICAL');
  assert.equal(deriveRescueUrgency('TRAPPED', triage()), 'HIGH');
  assert.equal(deriveRescueUrgency('IMMOBILE', triage()), 'HIGH');
  assert.equal(deriveRescueUrgency('FIRST_AID_NEEDED', triage({ immobile: 'YES' })), 'HIGH');
  assert.equal(deriveRescueUrgency('FIRST_AID_NEEDED', triage()), 'MEDIUM');
  assert.equal(deriveRescueUrgency('OTHER_RESCUE', triage({ conscious: 'UNKNOWN', breathing_difficulty: 'UNKNOWN' })), 'MEDIUM');
});

test('field validation rejects what no form may send', () => {
  assert.deepEqual(rescueFieldErrors(input()), []);
  assert.deepEqual(rescueFieldErrors(input({ requestType: 'TRAPPED_INJURED' })), ['rescue_field_invalid:request_type']);
  assert.deepEqual(rescueFieldErrors(input({ subject: 'ME' })), ['rescue_field_invalid:subject']);
  assert.deepEqual(rescueFieldErrors(input({ peopleCount: 0 })), ['rescue_field_invalid:people_count']);
  assert.deepEqual(rescueFieldErrors(input({ peopleCount: 51 })), ['rescue_field_invalid:people_count']);
  assert.deepEqual(rescueFieldErrors(input({ peopleCount: 1.5 })), ['rescue_field_invalid:people_count']);
  assert.deepEqual(rescueFieldErrors(input({ triage: triage({ immobile: 'MAYBE' }) })), ['rescue_field_invalid:triage']);
  assert.deepEqual(rescueFieldErrors(input({ subject: 'SELF', triage: triage({ conscious: 'NO' }) })), ['rescue_field_invalid:triage']);
  assert.deepEqual(rescueFieldErrors(input({ description: '字'.repeat(161) })), ['rescue_field_invalid:description']);
  assert.deepEqual(rescueFieldErrors(input({ description: `  ${'字'.repeat(160)}  ` })), []);
  assert.deepEqual(rescueFieldErrors(input({ lon: 139.69, lat: 35.68 })), ['rescue_geometry_invalid']);
  assert.deepEqual(rescueFieldErrors(input({ locationSource: 'GPS' })), ['rescue_field_invalid:location_source']);
  assert.deepEqual(
    rescueFieldErrors(input({ locationHint: { method: 'ADDRESS', query: 'x', label: 'x', kind: 'STREET', precision: 'ROAD' } })),
    ['rescue_field_invalid:location_hint'],
  );
});

test('a well-formed v1 has no contract errors', () => {
  assert.deepEqual(rescueEventErrors(event()), []);
});

test('event-level rules', () => {
  assert.deepEqual(rescueEventErrors(event({ source: 'OTHER' })), ['rescue_identity_invalid']);
  assert.deepEqual(rescueEventErrors(event({}, { theme: 'report' })), ['rescue_identity_invalid']);
  assert.deepEqual(
    rescueEventErrors(event({ event_id: `rescue:${'b'.repeat(32)}:00000000-0000-4000-8000-000000000001` })),
    ['rescue_event_id_unbound'],
  );
  assert.deepEqual(rescueEventErrors(event({ geometry: { type: 'LineString', coordinates: [[121, 25], [121.1, 25]] } })), ['rescue_geometry_invalid']);
  assert.deepEqual(rescueEventErrors(event({}, { phone: '0912000000' })), ['rescue_attributes_unknown']);
  assert.deepEqual(rescueEventErrors(event({}, { status: 'EXPIRED' })), ['rescue_field_invalid:status']);
  assert.deepEqual(rescueEventErrors(event({ severity: 'CRITICAL' })), ['rescue_severity_mismatch']);
  assert.deepEqual(rescueEventErrors(event({ event_version: 201 })), ['rescue_version_too_high']);
  assert.deepEqual(rescueEventErrors(event({}, { first_issued_at: '2026-10-12T02:00:00Z' })), ['rescue_time_invalid']);
  assert.deepEqual(rescueEventErrors(event({ expires_at: '2026-10-12T09:00:01Z' })), ['rescue_ttl_too_long']);
  assert.deepEqual(
    rescueEventErrors(event(
      { event_version: 2, issued_at: '2026-10-15T00:30:00Z', expires_at: '2026-10-15T06:00:00Z' },
      { first_issued_at: '2026-10-12T03:00:00Z' },
    )),
    ['rescue_lifetime_exceeded'],
  );
});

test('transition rules', () => {
  const v1 = event();
  const v2 = event({ event_version: 2, issued_at: '2026-10-12T03:10:00Z' });
  assert.deepEqual(rescueTransitionErrors(v1, v2), []);
  assert.deepEqual(rescueTransitionErrors(v1, { ...v2, signing_key_id: `device:${'c'.repeat(32)}` }), ['signer_mismatch']);
  const resolved = event({ event_version: 2, issued_at: '2026-10-12T03:10:00Z' }, { status: 'RESOLVED' });
  assert.deepEqual(rescueTransitionErrors(resolved, event({ event_version: 3, issued_at: '2026-10-12T03:20:00Z' })), ['rescue_terminal']);
  const shortened = event({ event_version: 2, issued_at: '2026-10-12T03:10:00Z', expires_at: '2026-10-12T04:00:00Z' }, { status: 'CANCELLED' });
  assert.deepEqual(rescueTransitionErrors(v1, shortened), ['rescue_terminal_expiry_changed']);
  const moved = event({ event_version: 2, issued_at: '2026-10-12T03:10:00Z' }, { first_issued_at: '2026-10-12T02:59:00Z' });
  assert.deepEqual(rescueTransitionErrors(v1, moved), ['rescue_first_issued_changed']);
});
