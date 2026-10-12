import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize } from '../../../pipeline/lib/canonical.mjs';

const migrationRoot = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

function userFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    account: row.account,
    displayName: row.display_name,
    agency: row.agency,
    role: row.role,
    status: row.status,
    passwordHash: row.password_hash,
  };
}

function outboxFromRow(row) {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    payload: row.payload,
    attempts: row.attempts,
  };
}

async function transaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function revokeDeviceInTransaction(client, { deviceId, actorId = null, now }) {
  const deviceResult = await client.query('SELECT device_id,status FROM government_devices WHERE device_id = $1 FOR UPDATE', [deviceId]);
  const device = deviceResult.rows[0];
  if (!device) return { error: 'device_not_found' };
  if (device.status === 'REVOKED') return { device_id: deviceId, already_revoked: true };

  await client.query(`UPDATE government_devices SET status = 'REVOKED', revoked_at = $2, updated_at = $2
    WHERE device_id = $1`, [deviceId, now]);
  const certificates = await client.query(`SELECT certificate_id FROM government_device_certificates
    WHERE device_id = $1 AND revoked_at IS NULL FOR UPDATE`, [deviceId]);
  await client.query(`UPDATE government_device_certificates SET revoked_at = $2
    WHERE device_id = $1 AND revoked_at IS NULL`, [deviceId, now]);
  for (const row of certificates.rows) {
    const payload = { certificate_id: row.certificate_id, device_id: deviceId, revoked_at: now.toISOString() };
    await client.query(`INSERT INTO government_outbox
      (id, aggregate_type, aggregate_id, aggregate_version, payload, created_at)
      VALUES ($1,'DEVICE_REVOCATION',$2,1,$3::jsonb,$4) ON CONFLICT (aggregate_type,aggregate_id,aggregate_version) DO NOTHING`,
    [randomUUID(), row.certificate_id, JSON.stringify(payload), now]);
  }
  await client.query(`INSERT INTO government_audit_log (actor_id,action,subject_id,details,created_at)
    VALUES ($1,'GOVERNMENT_DEVICE_REVOKED',$2,$3::jsonb,$4)`,
  [actorId, deviceId, JSON.stringify({ certificate_count: certificates.rowCount }), now]);
  return { device_id: deviceId, already_revoked: false };
}

async function revokeUserDevicesInTransaction(client, userId, now) {
  const rows = await client.query(`SELECT device_id FROM government_devices
    WHERE user_id = $1 AND status <> 'REVOKED' ORDER BY created_at FOR UPDATE`, [userId]);
  for (const row of rows.rows) await revokeDeviceInTransaction(client, { deviceId: row.device_id, now });
}

export function createPostgresGovernmentStore(pool) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('PostgreSQL pool is required');
  }

  return Object.freeze({
    async health() { await pool.query('SELECT 1'); },

    async migrate() {
      const files = (await readdir(migrationRoot)).filter((name) => /^\d+_[a-z0-9_-]+\.sql$/u.test(name)).sort();
      await transaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('resilientgeo-government-schema-migrations'))");
        for (const file of files) await client.query(await readFile(path.join(migrationRoot, file), 'utf8'));
      });
    },

    async createGovernmentUser(user) {
      const result = await pool.query(`INSERT INTO government_users
        (id, account, display_name, agency, role, status, password_hash, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [user.id, user.account, user.displayName, user.agency, user.role, user.status, user.passwordHash,
        user.createdAt, user.updatedAt]);
      return userFromRow(result.rows[0]);
    },

    async findUserForLogin(account) {
      const result = await pool.query('SELECT * FROM government_users WHERE lower(account) = $1', [account]);
      return userFromRow(result.rows[0]);
    },

    async createSession(session) {
      await pool.query(`INSERT INTO government_sessions
        (id, token_hash, csrf_hash, user_id, created_at, expires_at, user_agent)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [session.id, session.tokenHash, session.csrfHash, session.userId,
        session.createdAt, session.expiresAt, session.userAgent]);
    },

    async findSession(tokenHash, now) {
      const result = await pool.query(`SELECT s.id AS session_id, s.csrf_hash, u.*
        FROM government_sessions s JOIN government_users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND u.status = 'ACTIVE'`,
      [tokenHash, now]);
      const row = result.rows[0];
      return row ? { session: { id: row.session_id, csrfHash: row.csrf_hash }, user: userFromRow(row) } : null;
    },

    async updateSessionCsrf(sessionId, csrfHash) {
      await pool.query(`UPDATE government_sessions SET csrf_hash = $2, last_used_at = now()
        WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`, [sessionId, csrfHash]);
    },

    async revokeSession(tokenHash, now) {
      await pool.query(`UPDATE government_sessions SET revoked_at = $2
        WHERE token_hash = $1 AND revoked_at IS NULL`, [tokenHash, now]);
    },

    async disableUser(userId, disabled, now) {
      return transaction(pool, async (client) => {
        if (disabled) {
          const target = await client.query("SELECT role FROM government_users WHERE id = $1 FOR UPDATE", [userId]);
          if (target.rows[0]?.role === 'SYSTEM_ADMIN') {
            const active = await client.query("SELECT count(*)::int AS count FROM government_users WHERE role = 'SYSTEM_ADMIN' AND status = 'ACTIVE' AND id <> $1", [userId]);
            if (active.rows[0]?.count === 0) return { error: 'last_system_admin' };
          }
        }
        const result = await client.query(`UPDATE government_users SET status = $2, updated_at = $3
          WHERE id = $1 RETURNING *`, [userId, disabled ? 'DISABLED' : 'ACTIVE', now]);
        const user = userFromRow(result.rows[0]);
        if (user && disabled) {
          await client.query(`UPDATE government_sessions SET revoked_at = $2
            WHERE user_id = $1 AND revoked_at IS NULL`, [userId, now]);
          await revokeUserDevicesInTransaction(client, userId, now);
        }
        return user;
      });
    },

    async enrollGovernmentDevice({ deviceId, userId, signingKeyId, signerPublicKey, subjectId, agency,
      certificateRequest, now }) {
      return transaction(pool, async (client) => {
        const inserted = await client.query(`INSERT INTO government_devices
          (device_id,user_id,subject_id,signing_key_id,signer_public_key,agency,status,certificate_version,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,'PENDING_CERTIFICATE',1,$7,$7)
          ON CONFLICT (user_id,signing_key_id) DO NOTHING RETURNING device_id,status`,
        [deviceId, userId, subjectId, signingKeyId, signerPublicKey, agency, now]);
        if (inserted.rowCount === 0) {
          const existing = await client.query(`SELECT device_id,status FROM government_devices
            WHERE user_id = $1 AND signing_key_id = $2`, [userId, signingKeyId]);
          if (existing.rowCount === 0) throw new Error('device enrollment conflict could not be read');
          if (existing.rows[0].status === 'REVOKED') return { error: 'device_revoked' };
          return { device_id: existing.rows[0].device_id, status: existing.rows[0].status, duplicate: true };
        }
        await client.query(`INSERT INTO government_outbox
          (id,aggregate_type,aggregate_id,aggregate_version,payload,created_at)
          VALUES ($1,'DEVICE_CERTIFICATE',$2,1,$3::jsonb,$4)`,
        [randomUUID(), deviceId, JSON.stringify(certificateRequest), now]);
        await client.query(`INSERT INTO government_audit_log (actor_id,action,subject_id,details,created_at)
          VALUES ($1,'GOVERNMENT_DEVICE_ENROLLED',$2,$3::jsonb,$4)`,
        [userId, deviceId, JSON.stringify({ signing_key_id: signingKeyId }), now]);
        return { device_id: inserted.rows[0].device_id, status: inserted.rows[0].status, duplicate: false };
      });
    },

    async currentGovernmentDevice(userId) {
      const result = await pool.query(`SELECT d.device_id,d.user_id,d.subject_id,d.signing_key_id,d.signer_public_key,d.agency,
        d.status,d.certificate_version,d.revoked_at,c.certificate_json,c.certificate_id
        FROM government_devices d LEFT JOIN government_device_certificates c
          ON c.device_id = d.device_id AND c.certificate_version = d.certificate_version
        WHERE d.user_id = $1 ORDER BY d.created_at DESC LIMIT 1`, [userId]);
      const row = result.rows[0];
      return row ? { device_id: row.device_id, user_id: row.user_id, subject_id: row.subject_id,
        signing_key_id: row.signing_key_id, signer_public_key: row.signer_public_key, agency: row.agency,
        status: row.status, certificate_version: row.certificate_version,
        certificate: row.certificate_json ?? null, certificate_id: row.certificate_id ?? null,
        revoked_at: row.revoked_at?.toISOString() ?? null } : null;
    },

    async queueGovernmentDeviceCertificate({ userId, deviceId, certificateRequest, now }) {
      return transaction(pool, async (client) => {
        const found = await client.query(`SELECT device_id,status,certificate_version FROM government_devices
          WHERE device_id = $1 AND user_id = $2 FOR UPDATE`, [deviceId, userId]);
        const device = found.rows[0];
        if (!device) return { error: 'device_not_found' };
        if (device.status === 'REVOKED') return { error: 'device_revoked' };
        const version = device.certificate_version + 1;
        await client.query(`UPDATE government_devices SET status = 'PENDING_CERTIFICATE', certificate_version = $2, updated_at = $3
          WHERE device_id = $1`, [deviceId, version, now]);
        await client.query(`INSERT INTO government_outbox
          (id,aggregate_type,aggregate_id,aggregate_version,payload,created_at)
          VALUES ($1,'DEVICE_CERTIFICATE',$2,$3,$4::jsonb,$5)`,
        [randomUUID(), deviceId, version, JSON.stringify(certificateRequest), now]);
        await client.query(`INSERT INTO government_audit_log (actor_id,action,subject_id,details,created_at)
          VALUES ($1,'GOVERNMENT_DEVICE_CERTIFICATE_RENEWAL_QUEUED',$2,$3::jsonb,$4)`,
        [userId, deviceId, JSON.stringify({ certificate_version: version }), now]);
        return { device_id: deviceId, status: 'PENDING_CERTIFICATE', certificate_version: version };
      });
    },

    async saveGovernmentDeviceCertificate({ deviceId, certificate, certificateVersion }) {
      return transaction(pool, async (client) => {
        const deviceResult = await client.query(`SELECT status,certificate_version FROM government_devices
          WHERE device_id = $1 FOR UPDATE`, [deviceId]);
        const device = deviceResult.rows[0];
        if (!device || device.status === 'REVOKED' || device.certificate_version !== certificateVersion
          || certificate.device_id !== deviceId) throw new Error('government device certificate request is stale');
        await client.query(`INSERT INTO government_device_certificates
          (certificate_id,device_id,certificate_version,certificate_json,issued_at,expires_at)
          VALUES ($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT DO NOTHING`,
        [certificate.certificate_id, deviceId, certificateVersion, JSON.stringify(certificate), certificate.issued_at, certificate.expires_at]);
        const saved = await client.query(`SELECT certificate_id,certificate_json FROM government_device_certificates
          WHERE device_id = $1 AND certificate_version = $2`, [deviceId, certificateVersion]);
        if (saved.rowCount !== 1 || saved.rows[0].certificate_id !== certificate.certificate_id
          || canonicalize(saved.rows[0].certificate_json) !== canonicalize(certificate)) {
          throw new Error('government device certificate issuance conflict');
        }
        await client.query(`UPDATE government_devices SET status = 'ACTIVE', updated_at = $3
          WHERE device_id = $1 AND certificate_version = $2 AND status <> 'REVOKED'`,
        [deviceId, certificateVersion, new Date(certificate.issued_at)]);
        await client.query(`INSERT INTO government_audit_log (actor_id,action,subject_id,details,created_at)
          VALUES (NULL,'GOVERNMENT_DEVICE_CERTIFICATE_ISSUED',$1,$2::jsonb,$3)`,
        [certificate.certificate_id, JSON.stringify({ device_id: deviceId, certificate_version: certificateVersion }), certificate.issued_at]);
        return certificate;
      });
    },

    async governmentDeviceForUser({ userId, deviceId }) {
      const result = await pool.query(`SELECT device_id,user_id,subject_id,signing_key_id,signer_public_key,status,revoked_at
        FROM government_devices WHERE device_id = $1 AND user_id = $2`, [deviceId, userId]);
      const row = result.rows[0];
      return row ? { ...row, revoked_at: row.revoked_at?.toISOString() ?? null } : null;
    },

    async findGovernmentDeviceCertificate(certificateId, deviceId) {
      const result = await pool.query(`SELECT certificate_id,device_id,certificate_json,revoked_at
        FROM government_device_certificates WHERE certificate_id = $1 AND device_id = $2`, [certificateId, deviceId]);
      const row = result.rows[0];
      return row ? { certificate_id: row.certificate_id, device_id: row.device_id,
        certificate: row.certificate_json, revoked_at: row.revoked_at?.toISOString() ?? null } : null;
    },

    async listGovernmentDevices() {
      const result = await pool.query(`SELECT d.device_id,d.user_id,u.account,u.display_name,u.agency,d.signing_key_id,d.status,
        d.certificate_version,d.created_at,d.updated_at,d.revoked_at,c.certificate_id,c.expires_at
        FROM government_devices d JOIN government_users u ON u.id = d.user_id
        LEFT JOIN government_device_certificates c ON c.device_id = d.device_id AND c.certificate_version = d.certificate_version
        ORDER BY d.created_at DESC LIMIT 500`);
      return result.rows.map((row) => ({ device_id: row.device_id, user_id: row.user_id, account: row.account,
        display_name: row.display_name, agency: row.agency, signing_key_id: row.signing_key_id,
        status: row.status, certificate_version: row.certificate_version, certificate_id: row.certificate_id ?? null,
        certificate_expires_at: row.expires_at?.toISOString() ?? null,
        created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
        revoked_at: row.revoked_at?.toISOString() ?? null }));
    },

    async revokeGovernmentDevice({ deviceId, actorId, now }) {
      return transaction(pool, async (client) => revokeDeviceInTransaction(client, { deviceId, actorId, now }));
    },

    async saveGovernmentWarning({ deviceId, certificateId, event, actorId, now }) {
      return transaction(pool, async (client) => {
        const inserted = await client.query(`INSERT INTO government_warnings
          (event_id,payload_hash,event_json,device_id,certificate_id,uploaded_at,expires_at)
          VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        [event.event_id, event.payload_hash, JSON.stringify(event), deviceId, certificateId, now, event.expires_at]);
        if (inserted.rowCount === 0) {
          const existing = await client.query('SELECT payload_hash FROM government_warnings WHERE event_id = $1', [event.event_id]);
          if (existing.rows[0]?.payload_hash !== event.payload_hash) {
            const error = new Error('event id was uploaded with a different payload hash');
            error.code = 'GOVERNMENT_WARNING_ID_CONFLICT';
            throw error;
          }
          return { duplicate: true };
        }
        await client.query(`INSERT INTO government_outbox
          (id,aggregate_type,aggregate_id,aggregate_version,payload,created_at)
          VALUES ($1,'DEVICE_WARNING',$2,$3,$4::jsonb,$5)`,
        [randomUUID(), event.event_id, event.event_version, JSON.stringify({ event_id: event.event_id, payload_hash: event.payload_hash }), now]);
        await client.query(`INSERT INTO government_audit_log (actor_id,action,subject_id,details,created_at)
          VALUES ($1,'GOVERNMENT_WARNING_RECEIVED',$2,$3::jsonb,$4)`,
        [actorId, event.event_id, JSON.stringify({ payload_hash: event.payload_hash, device_id: deviceId,
          certificate_id: certificateId }), now]);
        return { duplicate: false };
      });
    },

    async listUsers() {
      const result = await pool.query(`SELECT id,account,display_name,agency,role,status,created_at,updated_at
        FROM government_users ORDER BY created_at ASC`);
      return result.rows.map((row) => ({ id: row.id, account: row.account, display_name: row.display_name,
        agency: row.agency, role: row.role, status: row.status,
        created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString() }));
    },

    async addAudit(entry) {
      await pool.query(`INSERT INTO government_audit_log (actor_id, action, subject_id, details, created_at)
        VALUES ($1,$2,$3,$4::jsonb,$5)`, [entry.actorId ?? null, entry.action, entry.subjectId ?? null,
        JSON.stringify(entry.details ?? {}), entry.createdAt]);
    },

    async saveCrowdReport(event, now) {
      return transaction(pool, async (client) => {
        const inserted = await client.query(`INSERT INTO crowd_reports (event_id, payload_hash, event_json, uploaded_at, expires_at)
          VALUES ($1,$2,$3::jsonb,$4,$5) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        [event.event_id, event.payload_hash, JSON.stringify(event), now, event.expires_at]);
        if (inserted.rowCount === 1) return { duplicate: false };
        const existing = await client.query('SELECT payload_hash FROM crowd_reports WHERE event_id = $1', [event.event_id]);
        if (existing.rows[0]?.payload_hash !== event.payload_hash) {
          const error = new Error('event id was already uploaded with a different payload');
          error.code = 'REPORT_ID_CONFLICT';
          throw error;
        }
        return { duplicate: true };
      });
    },

    async listCrowdReports({ status = 'PENDING', now }) {
      const result = await pool.query(`SELECT event_id, payload_hash, event_json, uploaded_at, expires_at,
        verification_status, verdict, note, decision_issued_at FROM crowd_reports
        WHERE verification_status = $1 AND expires_at > $2 ORDER BY uploaded_at ASC LIMIT 500`, [status, now]);
      return result.rows.map((row) => ({
        event_id: row.event_id, payload_hash: row.payload_hash, event: row.event_json,
        uploaded_at: row.uploaded_at.toISOString(), expires_at: row.expires_at.toISOString(),
        status: row.verification_status, verdict: row.verdict, note: row.note,
        decision_issued_at: row.decision_issued_at?.toISOString() ?? null,
      }));
    },

    async queueAttestation({ actorId, eventId, payloadHash, verdict, note, now }) {
      return transaction(pool, async (client) => {
        const found = await client.query('SELECT * FROM crowd_reports WHERE event_id = $1 FOR UPDATE', [eventId]);
        const report = found.rows[0];
        if (!report) return { error: 'report_not_found' };
        if (report.payload_hash !== payloadHash) return { error: 'payload_hash_mismatch' };
        if (report.expires_at <= now) return { error: 'report_expired' };
        const version = report.decision_version + 1;
        await client.query(`UPDATE crowd_reports SET decision_version = $2, verdict = $3, note = $4,
          decision_issued_at = $5, verification_status = 'PENDING'
          WHERE event_id = $1`, [eventId, version, verdict, note ?? null, now]);
        const payload = { event_id: eventId, payload_hash: payloadHash, verdict, note: note ?? null };
        await client.query(`INSERT INTO government_outbox
          (id, aggregate_type, aggregate_id, aggregate_version, payload, created_at)
          VALUES ($1,'ATTESTATION',$2,$3,$4::jsonb,$5)`,
        [randomUUID(), eventId, version, JSON.stringify(payload), now]);
        await client.query(`INSERT INTO government_audit_log (actor_id, action, subject_id, details, created_at)
          VALUES ($1,'REPORT_ATTESTATION_QUEUED',$2,$3::jsonb,$4)`,
        [actorId, eventId, JSON.stringify({ verdict, payload_hash: payloadHash, version }), now]);
        return { queued: true, version };
      });
    },

    async createAnnouncement({ eventId, announcement, actorId, now }) {
      return transaction(pool, async (client) => {
        const row = await client.query(`INSERT INTO government_announcements
          (event_id, event_version, announcement_json, retracted, created_by, updated_by, created_at, updated_at)
          VALUES ($1,1,$2::jsonb,false,$3,$3,$4,$4) RETURNING event_id,event_version`,
        [eventId, JSON.stringify(announcement), actorId, now]);
        await client.query(`INSERT INTO government_outbox (id, aggregate_type, aggregate_id, aggregate_version, payload, created_at)
          VALUES ($1,'ANNOUNCEMENT',$2,1,$3::jsonb,$4)`,
        [randomUUID(), eventId, JSON.stringify({ operation: 'PUBLISH' }), now]);
        await client.query(`INSERT INTO government_audit_log (actor_id, action, subject_id, details, created_at)
          VALUES ($1,'ANNOUNCEMENT_CREATED',$2,$3::jsonb,$4)`,
        [actorId, eventId, JSON.stringify({ title: announcement.title, area_id: announcement.area_id }), now]);
        return row.rows[0];
      });
    },

    async reviseAnnouncement({ eventId, announcement, actorId, now }) {
      return transaction(pool, async (client) => {
        const found = await client.query('SELECT event_version,retracted FROM government_announcements WHERE event_id = $1 FOR UPDATE', [eventId]);
        const current = found.rows[0];
        if (!current) return { error: 'announcement_not_found' };
        if (current.retracted) return { error: 'announcement_retracted' };
        const version = current.event_version + 1;
        await client.query(`UPDATE government_announcements SET event_version = $2, announcement_json = $3::jsonb,
          updated_by = $4, updated_at = $5 WHERE event_id = $1`,
        [eventId, version, JSON.stringify(announcement), actorId, now]);
        await client.query(`INSERT INTO government_outbox (id, aggregate_type, aggregate_id, aggregate_version, payload, created_at)
          VALUES ($1,'ANNOUNCEMENT',$2,$3,$4::jsonb,$5)`,
        [randomUUID(), eventId, version, JSON.stringify({ operation: 'REVISE' }), now]);
        await client.query(`INSERT INTO government_audit_log (actor_id, action, subject_id, details, created_at)
          VALUES ($1,'ANNOUNCEMENT_REVISED',$2,$3::jsonb,$4)`,
        [actorId, eventId, JSON.stringify({ version, title: announcement.title }), now]);
        return { event_id: eventId, event_version: version };
      });
    },

    async retractAnnouncement({ eventId, actorId, now }) {
      return transaction(pool, async (client) => {
        const found = await client.query('SELECT event_version,retracted FROM government_announcements WHERE event_id = $1 FOR UPDATE', [eventId]);
        const current = found.rows[0];
        if (!current) return { error: 'announcement_not_found' };
        if (current.retracted) return { event_id: eventId, event_version: current.event_version, already_retracted: true };
        const version = current.event_version + 1;
        await client.query(`UPDATE government_announcements SET event_version = $2, retracted = true, updated_by = $3, updated_at = $4
          WHERE event_id = $1`, [eventId, version, actorId, now]);
        await client.query(`INSERT INTO government_outbox (id, aggregate_type, aggregate_id, aggregate_version, payload, created_at)
          VALUES ($1,'ANNOUNCEMENT',$2,$3,'{"operation":"RETRACT"}'::jsonb,$4)`, [randomUUID(), eventId, version, now]);
        await client.query(`INSERT INTO government_audit_log (actor_id, action, subject_id, details, created_at)
          VALUES ($1,'ANNOUNCEMENT_RETRACTED',$2,$3::jsonb,$4)`, [actorId, eventId, JSON.stringify({ version }), now]);
        return { event_id: eventId, event_version: version };
      });
    },

    async listAnnouncements() {
      const result = await pool.query(`SELECT event_id,event_version,announcement_json,retracted,updated_at
        FROM government_announcements ORDER BY updated_at DESC LIMIT 500`);
      return result.rows.map((row) => ({ event_id: row.event_id, event_version: row.event_version,
        ...row.announcement_json, retracted: row.retracted, updated_at: row.updated_at.toISOString() }));
    },

    async currentAnnouncementEvents() {
      const result = await pool.query('SELECT event_id,event_version,announcement_json,retracted,updated_at FROM government_announcements');
      return result.rows.map((row) => ({
        ...row.announcement_json,
        event_id: row.event_id,
        event_version: row.event_version,
        retracted: row.retracted,
        updated_at: row.updated_at.toISOString(),
      }));
    },

    async currentAttestations() {
      const result = await pool.query(`SELECT event_id,payload_hash,event_json,verdict,note,decision_issued_at,decision_version
        FROM crowd_reports WHERE verdict IS NOT NULL AND expires_at > now() ORDER BY decision_issued_at`);
      return result.rows.map((row) => ({ event: row.event_json, payload_hash: row.payload_hash,
        verdict: row.verdict, note: row.note, issued_at: row.decision_issued_at.toISOString(), version: row.decision_version }));
    },

    async currentGovernmentWarnings({ now = new Date() } = {}) {
      const result = await pool.query(`SELECT event_json FROM government_warnings
        WHERE expires_at > $1 ORDER BY uploaded_at,event_id`, [now]);
      return result.rows.map((row) => row.event_json);
    },

    async currentGovernmentRevocations() {
      const result = await pool.query(`SELECT certificate_id,device_id,revoked_at FROM government_device_certificates
        WHERE revoked_at IS NOT NULL ORDER BY revoked_at,certificate_id`);
      return result.rows.map((row) => ({ certificate_id: row.certificate_id, device_id: row.device_id,
        revoked_at: row.revoked_at.toISOString() }));
    },

    async claimOutbox({ now, limit = 50, leaseMs = 60_000 }) {
      return transaction(pool, async (client) => {
        const rows = await client.query(`SELECT * FROM government_outbox
          WHERE ((status IN ('PENDING','FAILED') AND available_at <= $1) OR (status = 'PROCESSING' AND lease_until <= $1))
          ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT $2`, [now, limit]);
        if (rows.rowCount === 0) return [];
        const ids = rows.rows.map((row) => row.id);
        await client.query(`UPDATE government_outbox SET status = 'PROCESSING', attempts = attempts + 1,
          lease_until = $2, last_error_code = NULL WHERE id = ANY($1::uuid[])`,
        [ids, new Date(now.getTime() + leaseMs)]);
        return rows.rows.map((row) => ({ ...outboxFromRow(row), attempts: row.attempts + 1 }));
      });
    },

    async markOutboxPublished(items, now) {
      if (!items.length) return;
      await transaction(pool, async (client) => {
        for (const item of items) {
          await client.query(`UPDATE government_outbox SET status = 'PUBLISHED', published_at = $2, lease_until = NULL
            WHERE id = $1`, [item.id, now]);
          if (item.aggregateType === 'ATTESTATION') {
            await client.query(`UPDATE crowd_reports SET verification_status = $2, published_decision_version = $3
              WHERE event_id = $1 AND decision_version = $3`,
            [item.aggregateId, item.payload.verdict, item.aggregateVersion]);
          } else if (item.aggregateType === 'DEVICE_WARNING') {
            await client.query(`UPDATE government_warnings SET publication_status = 'PUBLISHED'
              WHERE event_id = $1 AND payload_hash = $2`, [item.aggregateId, item.payload.payload_hash]);
          }
        }
      });
    },

    async markOutboxRejected(items, errorCode, now) {
      if (!items.length) return;
      const safeCode = /^[A-Z][A-Z0-9_]{0,63}$/u.test(errorCode ?? '') ? errorCode : 'PUBLISH_REJECTED';
      await pool.query(`UPDATE government_outbox SET status = 'REJECTED', lease_until = NULL,
        last_error_code = $2, published_at = $3 WHERE id = ANY($1::uuid[])`,
      [items.map((item) => item.id), safeCode, now]);
      await pool.query(`INSERT INTO government_audit_log (actor_id,action,subject_id,details,created_at)
        VALUES (NULL,'OUTBOX_REJECTED',NULL,$1::jsonb,$2)`,
      [JSON.stringify({ count: items.length, code: safeCode }), now]);
    },

    async retryOutbox(items, errorCode, now) {
      const safeCode = /^[A-Z][A-Z0-9_]{0,63}$/u.test(errorCode ?? '') ? errorCode : 'PUBLISH_FAILED';
      for (const item of items) {
        const delaySeconds = Math.min(3600, 5 * (2 ** Math.min(item.attempts, 10)));
        await pool.query(`UPDATE government_outbox SET status = 'FAILED', available_at = $2,
          lease_until = NULL, last_error_code = $3 WHERE id = $1`,
        [item.id, new Date(now.getTime() + delaySeconds * 1000), safeCode]);
      }
    },

    async bootstrapSystemAdmin({ id, account, displayName, agency, passwordHash, now }) {
      return transaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('resilientgeo-government-admin-bootstrap'))");
        const existing = await client.query("SELECT id FROM government_users WHERE role = 'SYSTEM_ADMIN' LIMIT 1");
        if (existing.rowCount > 0) {
          const error = new Error('a system administrator already exists');
          error.code = 'ADMIN_ALREADY_BOOTSTRAPPED';
          throw error;
        }
        const inserted = await client.query(`INSERT INTO government_users
          (id,account,display_name,agency,role,status,password_hash,created_at,updated_at)
          VALUES ($1,$2,$3,$4,'SYSTEM_ADMIN','ACTIVE',$5,$6,$6) RETURNING *`,
        [id, account, displayName, agency, passwordHash, now]);
        await client.query(`INSERT INTO government_audit_log (actor_id,action,subject_id,details,created_at)
          VALUES ($1,'SYSTEM_ADMIN_BOOTSTRAPPED',$2,'{}'::jsonb,$3)`, [id, id, now]);
        return userFromRow(inserted.rows[0]);
      });
    },
  });
}
