import { randomUUID } from 'node:crypto';

import { verifyEvent, validateEventShape } from '../../../pipeline/lib/contract.mjs';
import { isDeviceKeyId } from '../../../pipeline/lib/device-key.mjs';
import { CROWD_TTL_MS, crowdReportErrors } from '../../../pipeline/lib/crowd-report.mjs';
import { GovernmentAuthError } from './auth-service.mjs';

const ANNOUNCEMENT_CATEGORIES = new Set(['SAFETY', 'WEATHER', 'ROAD', 'SHELTER', 'OTHER']);
const SEVERITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'UNKNOWN']);
const NATIONWIDE_AREA_ID = 'tw.national';
const HASH_RE = /^sha256:[0-9a-f]{64}$/u;
const MAX_ANNOUNCEMENT_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

function fail(code, statusCode = 400) {
  return new GovernmentAuthError(code, statusCode);
}

function validateAnnouncement(input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('announcement_invalid');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const content = typeof input.content === 'string' ? input.content.trim() : '';
  const category = input.category;
  const severity = input.severity;
  if (!title || [...title].length > 120) throw fail('announcement_title_invalid');
  if (!content || [...content].length > 8000) throw fail('announcement_content_invalid');
  if (!ANNOUNCEMENT_CATEGORIES.has(category)) throw fail('announcement_category_invalid');
  if (!SEVERITIES.has(severity)) throw fail('announcement_severity_invalid');
  const expiresAt = typeof input.expires_at === 'string' ? new Date(input.expires_at) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime() ||
      expiresAt.getTime() > now.getTime() + MAX_ANNOUNCEMENT_LIFETIME_MS) {
    throw fail('announcement_expiry_invalid');
  }
  const hasLon = input.longitude !== undefined && input.longitude !== null;
  const hasLat = input.latitude !== undefined && input.latitude !== null;
  if (hasLon !== hasLat) throw fail('announcement_location_invalid');
  let location = null;
  if (hasLon) {
    const longitude = Number(input.longitude);
    const latitude = Number(input.latitude);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || longitude < 116.5 || longitude > 122.5 ||
        latitude < 20.5 || latitude > 26.8) throw fail('announcement_location_invalid');
    location = { longitude: Number(longitude.toFixed(6)), latitude: Number(latitude.toFixed(6)) };
  }
  return {
    title, content, category, severity, area_id: NATIONWIDE_AREA_ID,
    expires_at: expiresAt.toISOString(), location,
  };
}

export function createGovernmentWorkbenchService({ store, now = () => new Date() } = {}) {
  if (!store) throw new TypeError('government store is required');
  return Object.freeze({
    async uploadCrowdReport(event) {
      const receivedAt = now();
      if (validateEventShape(event).length > 0 || event.namespace !== 'crowd.reports' ||
          event.event_type !== 'CROWD_REPORT' || event.event_version !== 1 || event.source !== 'CROWD' ||
          event.source_version !== 'crowd-report-v0' || event.attributes?.area_id !== 'crowd' ||
          event.attributes?.theme !== 'report' || !isDeviceKeyId(event.signing_key_id) ||
          typeof event.event_id !== 'string' || !event.event_id.startsWith('report:')) {
        throw fail('crowd_report_invalid');
      }
      const check = verifyEvent(event, null, { now: receivedAt });
      if (!check.valid) throw fail(`crowd_report_${check.stage}_invalid`);
      if (check.expired || Date.parse(event.expires_at) <= receivedAt.getTime()) throw fail('crowd_report_expired');
      const issuedAt = Date.parse(event.issued_at);
      const expiresAt = Date.parse(event.expires_at);
      if (issuedAt > receivedAt.getTime() + 5 * 60_000 || expiresAt - issuedAt > CROWD_TTL_MS) {
        throw fail('crowd_report_time_invalid');
      }
      const coordinates = event.geometry?.type === 'Point' ? event.geometry.coordinates : null;
      const reportErrors = crowdReportErrors({
        category: event.attributes.category,
        description: event.attributes.description,
        locationSource: event.attributes.location_source,
        locationHint: event.attributes.location_hint,
        lon: coordinates?.[0],
        lat: coordinates?.[1],
      });
      if (reportErrors.length > 0) throw fail('crowd_report_invalid');
      let result;
      try {
        result = await store.saveCrowdReport(event, receivedAt);
      } catch (error) {
        if (error.code === 'REPORT_ID_CONFLICT') throw fail('crowd_report_id_conflict', 409);
        throw error;
      }
      if (!result.duplicate) {
        await store.addAudit({ actorId: null, action: 'CROWD_REPORT_RECEIVED', subjectId: event.event_id,
          details: { payload_hash: event.payload_hash, signing_key_id: event.signing_key_id }, createdAt: receivedAt.toISOString() });
      }
      return { event_id: event.event_id, payload_hash: event.payload_hash, verification_status: 'UNVERIFIED',
        review_status: 'PENDING', duplicate: result.duplicate };
    },

    async listReports(status = 'PENDING') {
      if (!['PENDING', 'CONFIRMED', 'REFUTED'].includes(status)) throw fail('report_status_invalid');
      return store.listCrowdReports({ status, now: now() });
    },

    async attestReport({ actorId, eventId, payloadHash, verdict, note }) {
      if (typeof eventId !== 'string' || eventId.length > 160) throw fail('report_id_invalid');
      if (!HASH_RE.test(payloadHash ?? '')) throw fail('payload_hash_invalid');
      if (!['CONFIRMED', 'REFUTED'].includes(verdict)) throw fail('attestation_verdict_invalid');
      if (note !== undefined && (typeof note !== 'string' || [...note].length > 160)) throw fail('attestation_note_invalid');
      const result = await store.queueAttestation({ actorId, eventId, payloadHash, verdict, note: note?.trim() || null, now: now() });
      if (result.error === 'report_not_found') throw fail('report_not_found', 404);
      if (result.error === 'payload_hash_mismatch') throw fail('payload_hash_mismatch', 409);
      if (result.error === 'report_expired') throw fail('report_expired', 409);
      return { event_id: eventId, verdict, publication_status: 'QUEUED', decision_version: result.version };
    },

    async createAnnouncement({ actorId, input }) {
      const createdAt = now();
      const announcement = validateAnnouncement(input, createdAt);
      const eventId = `announcement:${randomUUID()}`;
      const saved = await store.createAnnouncement({ eventId, announcement, actorId, now: createdAt });
      return { event_id: saved.event_id, event_version: saved.event_version, publication_status: 'QUEUED' };
    },

    async reviseAnnouncement({ actorId, eventId, input }) {
      const saved = await store.reviseAnnouncement({ eventId, announcement: validateAnnouncement(input, now()), actorId, now: now() });
      if (saved.error === 'announcement_not_found') throw fail('announcement_not_found', 404);
      if (saved.error === 'announcement_retracted') throw fail('announcement_retracted', 409);
      return { ...saved, publication_status: 'QUEUED' };
    },

    async retractAnnouncement({ actorId, eventId }) {
      const saved = await store.retractAnnouncement({ eventId, actorId, now: now() });
      if (saved.error === 'announcement_not_found') throw fail('announcement_not_found', 404);
      return { ...saved, publication_status: saved.already_retracted ? 'ALREADY_RETRACTED' : 'QUEUED' };
    },

    async listAnnouncements() { return store.listAnnouncements(); },
  });
}
