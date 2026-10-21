import { randomUUID } from 'node:crypto';

import { verifyEvent, validateEventShape } from '../../../pipeline/lib/contract.mjs';
import { canonicalize } from '../../../pipeline/lib/canonical.mjs';
import { deviceKeyIdFromSpkiBase64, isDeviceKeyId, parseDevicePublicKey } from '../../../pipeline/lib/device-key.mjs';
import { CROWD_TTL_MS, crowdReportErrors } from '../../../pipeline/lib/crowd-report.mjs';
import { GovernmentAuthError } from './auth-service.mjs';

const ANNOUNCEMENT_CATEGORIES = new Set(['SAFETY', 'WEATHER', 'ROAD', 'SHELTER', 'SUPPLY_STATION', 'OTHER']);
const LOCATION_REQUIRED_ANNOUNCEMENT_CATEGORIES = new Set(['ROAD', 'SHELTER', 'SUPPLY_STATION']);
const SEVERITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'UNKNOWN']);
const NATIONWIDE_AREA_ID = 'tw.national';
const HASH_RE = /^sha256:[0-9a-f]{64}$/u;
const MAX_ANNOUNCEMENT_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_ISSUE_MS = 5 * 60 * 1000;

function fail(code, statusCode = 400) {
  return new GovernmentAuthError(code, statusCode);
}

function validateAnnouncement(input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('announcement_invalid');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const content = typeof input.content === 'string' ? input.content.trim() : '';
  const category = input.category;
  const severity =
    category === 'SUPPLY_STATION' &&
    (input.severity === undefined || input.severity === null)
      ? 'LOW'
      : input.severity;
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
  if (LOCATION_REQUIRED_ANNOUNCEMENT_CATEGORIES.has(category) && location === null) {
    throw fail('announcement_location_invalid');
  }
  return {
    title, content, category, severity, area_id: NATIONWIDE_AREA_ID,
    expires_at: expiresAt.toISOString(), location,
  };
}

function newDeviceCertificateRequest({ user, deviceId, subjectId, signingKeyId, signerPublicKey, now, issuerKeyId }) {
  return {
    certificate_id: `gov-cert:${randomUUID()}`,
    device_id: deviceId,
    subject_id: subjectId,
    signing_key_id: signingKeyId,
    signer_public_key: signerPublicKey,
    agency: user.agency,
    issued_at: now.toISOString(),
    issuer_key_id: issuerKeyId,
  };
}

function validateGovernmentWarning(event, now) {
  if (validateEventShape(event).length > 0 || event.namespace !== 'official.announcement'
    || event.event_type !== 'GOVERNMENT_ANNOUNCEMENT' || event.source !== 'GOVERNMENT' || event.event_version !== 1) {
    throw fail('government_warning_invalid');
  }
  const attributes = event.attributes;
  const title = typeof attributes.title === 'string' ? attributes.title.trim() : '';
  const content = typeof attributes.content === 'string' ? attributes.content.trim() : '';
  if (!title || [...title].length > 120) throw fail('announcement_title_invalid');
  if (!content || [...content].length > 8000) throw fail('announcement_content_invalid');
  if (!ANNOUNCEMENT_CATEGORIES.has(attributes.category)) throw fail('announcement_category_invalid');
  if (!SEVERITIES.has(event.severity)) throw fail('announcement_severity_invalid');
  if (attributes.area_id !== NATIONWIDE_AREA_ID || attributes.theme !== 'announcement') throw fail('government_warning_scope_invalid');

  const issuedAt = new Date(event.issued_at);
  const expiresAt = new Date(event.expires_at);
  if (Number.isNaN(issuedAt.getTime()) || Number.isNaN(expiresAt.getTime())
    || issuedAt.getTime() > now.getTime() + MAX_FUTURE_ISSUE_MS
    || expiresAt.getTime() <= now.getTime()
    || expiresAt.getTime() <= issuedAt.getTime()
    || expiresAt.getTime() - issuedAt.getTime() > MAX_ANNOUNCEMENT_LIFETIME_MS) {
    throw fail('government_warning_time_invalid');
  }

  if (event.geometry.type === 'Point') {
    const coordinates = event.geometry.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2
      || !Number.isFinite(coordinates[0]) || !Number.isFinite(coordinates[1])
      || coordinates[0] < 116.5 || coordinates[0] > 122.5 || coordinates[1] < 20.5 || coordinates[1] > 26.8
      || attributes.has_map_location !== true) throw fail('announcement_location_invalid');
  } else if (event.geometry.type === 'GeometryCollection') {
    if (event.geometry.geometries.length !== 0 || attributes.has_map_location !== false) {
      throw fail('announcement_location_invalid');
    }
  } else {
    throw fail('announcement_location_invalid');
  }
  if (LOCATION_REQUIRED_ANNOUNCEMENT_CATEGORIES.has(attributes.category) && event.geometry.type !== 'Point') {
    throw fail('announcement_location_invalid');
  }
}

export function createGovernmentWorkbenchService({ store, now = () => new Date(), config = {} } = {}) {
  if (!store) throw new TypeError('government store is required');
  return Object.freeze({
    async enrollGovernmentDevice({ user, signingKeyId, signerPublicKey }) {
      if (user?.role !== 'GOVERNMENT') throw fail('role_forbidden', 403);
      if (typeof signerPublicKey !== 'string' || !parseDevicePublicKey(signerPublicKey)
        || !isDeviceKeyId(signingKeyId) || deviceKeyIdFromSpkiBase64(signerPublicKey) !== signingKeyId) {
        throw fail('government_device_key_invalid');
      }
      const enrolledAt = now();
      const deviceId = `gov-device:${randomUUID()}`;
      const subjectId = randomUUID();
      const certificateRequest = newDeviceCertificateRequest({ user, deviceId, subjectId, signingKeyId,
        signerPublicKey, now: enrolledAt, issuerKeyId: config.signingKeyId });
      const result = await store.enrollGovernmentDevice({ deviceId, userId: user.id, signingKeyId, signerPublicKey,
        subjectId, agency: user.agency, certificateRequest, now: enrolledAt });
      if (result.error === 'device_revoked') throw fail('government_device_revoked', 403);
      return result;
    },

    async currentGovernmentDevice(user) {
      if (user?.role !== 'GOVERNMENT') throw fail('role_forbidden', 403);
      const device = await store.currentGovernmentDevice(user.id);
      if (!device) return { device_id: null, status: 'NOT_ENROLLED', certificate: null };
      return {
        device_id: device.device_id,
        status: device.status,
        certificate: device.certificate ?? null,
        certificate_expires_at: device.certificate?.expires_at ?? null,
        last_revocation_sync_at: device.last_revocation_sync_at ?? null,
      };
    },

    async renewGovernmentDevice({ user }) {
      if (user?.role !== 'GOVERNMENT') throw fail('role_forbidden', 403);
      const device = await store.currentGovernmentDevice(user.id);
      if (!device) throw fail('government_device_not_found', 404);
      if (device.status === 'REVOKED') throw fail('government_device_revoked', 403);
      const requestedAt = now();
      const certificateRequest = newDeviceCertificateRequest({
        user,
        deviceId: device.device_id,
        subjectId: device.subject_id,
        signingKeyId: device.signing_key_id,
        signerPublicKey: device.signer_public_key,
        now: requestedAt,
        issuerKeyId: config.signingKeyId,
      });
      const result = await store.queueGovernmentDeviceCertificate({ userId: user.id, deviceId: device.device_id,
        certificateRequest, now: requestedAt });
      if (result.error === 'device_not_found') throw fail('government_device_not_found', 404);
      if (result.error === 'device_revoked') throw fail('government_device_revoked', 403);
      return result;
    },

    async listGovernmentDevices() { return store.listGovernmentDevices(); },

    async revokeGovernmentDevice({ deviceId, actorId }) {
      const result = await store.revokeGovernmentDevice({ deviceId, actorId, now: now() });
      if (result.error === 'device_not_found') throw fail('government_device_not_found', 404);
      return result;
    },

    async uploadGovernmentWarning({ actor, event }) {
      if (actor?.role !== 'GOVERNMENT') throw fail('role_forbidden', 403);
      const receivedAt = now();
      validateGovernmentWarning(event, receivedAt);
      const verification = verifyEvent(event, null, {
        trustedKeyIds: config.trustedKeyIds,
        trustedKeys: config.trustedKeys,
        now: receivedAt,
      });
      if (!verification.valid) throw fail(`government_warning_${verification.stage}_invalid`);
      if (verification.expired) throw fail('government_warning_expired');

      const certificate = event.attributes.government_device_certificate;
      if (!certificate || typeof certificate.device_id !== 'string' || typeof certificate.certificate_id !== 'string') {
        throw fail('government_device_certificate_invalid');
      }
      const device = await store.governmentDeviceForUser({ userId: actor.id, deviceId: certificate.device_id });
      if (!device) throw fail('government_device_not_owned', 403);
      if (device.status !== 'ACTIVE') throw fail('government_device_revoked', 403);
      if (device.signing_key_id !== event.signing_key_id) throw fail('government_device_key_mismatch', 403);
      const certificateRecord = await store.findGovernmentDeviceCertificate(certificate.certificate_id, device.device_id);
      if (!certificateRecord || canonicalize(certificateRecord.certificate) !== canonicalize(certificate)) {
        throw fail('government_device_certificate_unknown', 403);
      }
      if (certificateRecord.revoked_at && Date.parse(event.issued_at) >= Date.parse(certificateRecord.revoked_at)) {
        throw fail('government_device_certificate_revoked', 403);
      }

      let saved;
      try {
        saved = await store.saveGovernmentWarning({ deviceId: device.device_id, certificateId: certificate.certificate_id,
          event, actorId: actor.id, now: receivedAt });
      } catch (error) {
        if (error.code === 'GOVERNMENT_WARNING_ID_CONFLICT') throw fail('government_warning_id_conflict', 409);
        throw error;
      }
      return { event_id: event.event_id, payload_hash: event.payload_hash,
        publication_status: 'QUEUED', duplicate: saved.duplicate };
    },

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
