import path from 'node:path';

import { buildAttestation } from '../../../pipeline/lib/attest.mjs';
import { signGovernmentDeviceCertificate } from '../../../pipeline/lib/government-device-certificate.mjs';
import { publishGovernmentRelease } from '../publisher/release-publisher.mjs';
import { acquireCollectorLock } from '../collector/collector-lock.mjs';

function announcementEvent(row, now) {
  const retracted = row.retracted === true;
  const issuedAt = retracted ? row.updated_at : row.updated_at;
  const location = row.location;
  return {
    schema_version: 'event-v0',
    namespace: 'official.announcement',
    event_id: row.event_id,
    event_type: 'GOVERNMENT_ANNOUNCEMENT',
    geometry: location
      ? { type: 'Point', coordinates: [location.longitude, location.latitude] }
      // event-v0 requires geometry; this private anchor is suppressed from the map unless a location was supplied.
      : { type: 'Point', coordinates: [121, 23.5] },
    severity: row.severity,
    source: 'GOVERNMENT',
    source_version: row.updated_at,
    event_version: row.event_version,
    issued_at: issuedAt,
    expires_at: retracted ? now.toISOString() : row.expires_at,
    attributes: {
      title: row.title,
      content: row.content,
      category: row.category,
      area_id: row.area_id,
      theme: 'announcement',
      has_map_location: Boolean(location),
      ...(retracted ? { publication_retracted: true, retraction_issued_at: now.toISOString() } : {}),
    },
    provenance: {
      original_source: 'government-workbench',
      received_at: now.toISOString(),
      transport_source: { kind: 'server', node_id: 'government-publisher' },
    },
  };
}

function attestationEvent(record, signingKey, now) {
  return buildAttestation({
    report: record.event,
    verdict: record.verdict,
    note: record.note ?? undefined,
    privateKey: signingKey.privateKey,
    keyId: signingKey.keyId,
    issuedAt: record.issued_at ?? now,
  });
}

function deviceRevocationEvent(record) {
  return {
    schema_version: 'event-v0',
    namespace: 'official.device-revocation',
    event_id: `device-revocation:${record.certificate_id}`,
    event_type: 'GOVERNMENT_DEVICE_REVOKED',
    geometry: { type: 'Point', coordinates: [121, 23.5] },
    severity: 'LOW',
    source: 'GOVERNMENT',
    source_version: record.revoked_at,
    event_version: 1,
    issued_at: record.revoked_at,
    expires_at: '2100-01-01T00:00:00.000Z',
    attributes: {
      certificate_id: record.certificate_id,
      device_id: record.device_id,
      revoked_at: record.revoked_at,
      area_id: 'tw.national',
      theme: 'device-revocation',
      internal_only: true,
    },
    provenance: {
      original_source: 'government-device-registry',
      received_at: record.revoked_at,
      transport_source: { kind: 'server', node_id: 'government-publisher' },
    },
  };
}

async function withPublisherLock({ lockProvider, lockPath }, callback) {
  if (lockProvider?.acquire) {
    const lease = await lockProvider.acquire();
    try {
      await lease.assertHeld();
      return await callback(lease.assertHeld);
    } finally { await lease.release(); }
  }
  const release = await acquireCollectorLock(lockPath ?? path.join('/tmp/resilientgeo', 'collector.lock'));
  try { return await callback(async () => {}); } finally { await release(); }
}

/** Publish one claimed outbox batch through the central signed event-v0 feed. */
export async function publishGovernmentOutboxBatch({
  store,
  releaseRoot,
  signingKey,
  releasePointerStore,
  lockProvider,
  lockPath,
  now = new Date(),
  batchSize = 50,
} = {}) {
  if (!store) throw new TypeError('government store is required');
  if (!signingKey?.privateKey || !signingKey?.publicKey || !signingKey?.keyId) {
    throw new TypeError('central signing key is required');
  }
  try {
    return await withPublisherLock({ lockProvider, lockPath }, async (assertLockHeld) => {
      const items = await store.claimOutbox({ now, limit: batchSize });
      if (items.length === 0) return { published: false, reason: 'empty' };
      try {
        const certificateItems = items.filter((item) => item.aggregateType === 'DEVICE_CERTIFICATE');
        for (const item of certificateItems) {
          const certificate = signGovernmentDeviceCertificate(item.payload, signingKey.privateKey);
          await store.saveGovernmentDeviceCertificate({ deviceId: item.aggregateId, certificate,
            certificateVersion: item.aggregateVersion });
        }
        const releaseItems = items.filter((item) => item.aggregateType !== 'DEVICE_CERTIFICATE');
        if (releaseItems.length === 0) {
          await store.markOutboxPublished(certificateItems, now);
          return { published: true, count: certificateItems.length, certificates_issued: certificateItems.length,
            revision: null, unchanged: false };
        }
        const [announcementRows, attestationRows, governmentWarnings, revocations] = await Promise.all([
          store.currentAnnouncementEvents(),
          store.currentAttestations(),
          store.currentGovernmentWarnings({ now }),
          store.currentGovernmentRevocations(),
        ]);
        const announcements = announcementRows.map((row) => announcementEvent(row, now));
        const warningIds = new Set(governmentWarnings.map((event) => event.event_id));
        const staleWarnings = releaseItems.filter((item) => item.aggregateType === 'DEVICE_WARNING' && !warningIds.has(item.aggregateId));
        const revocationIds = new Set(revocations.map((record) => record.certificate_id));
        const staleRevocations = releaseItems.filter((item) => item.aggregateType === 'DEVICE_REVOCATION'
          && !revocationIds.has(item.aggregateId));
        const reportIds = new Set(attestationRows.map((row) => row.event.event_id));
        const staleAttestations = releaseItems.filter((item) => item.aggregateType === 'ATTESTATION' && !reportIds.has(item.aggregateId));
        const staleItems = [...staleAttestations, ...staleWarnings, ...staleRevocations];
        if (staleItems.length > 0) {
          const staleAttestationIds = new Set(staleAttestations.map((item) => item.id));
          const staleWarningIds = new Set(staleWarnings.map((item) => item.id));
          const errorCode = staleAttestationIds.size > 0 ? 'REPORT_EXPIRED'
            : staleWarningIds.size > 0 ? 'WARNING_EXPIRED' : 'REVOCATION_NOT_FOUND';
          await store.markOutboxRejected(staleItems, errorCode, now);
        }
        const attestations = attestationRows.map((row) => attestationEvent(row, signingKey, now));
        const warnings = governmentWarnings;
        const revocationEvents = revocations.map(deviceRevocationEvent);
        const staleIds = new Set(staleItems.map((item) => item.id));
        const publishableReleaseItems = releaseItems.filter((item) => !staleIds.has(item.id));
        const publishable = [...certificateItems, ...publishableReleaseItems];
        if (publishable.length === 0) return { published: false, reason: 'expired_reports' };
        await assertLockHeld();
        const publication = await publishGovernmentRelease({
          releaseRoot,
          results: [
            { id: 'government-announcements', namespace: 'official.announcement', status: 'ok', events: [...announcements, ...warnings] },
            { id: 'government-device-revocations', namespace: 'official.device-revocation', status: 'ok', events: revocationEvents },
            { id: 'government-attestations', namespace: 'official.verified', status: 'ok', events: attestations },
          ],
          signingKey: { ...signingKey, signingKeyId: signingKey.keyId },
          now,
          releasePointerStore,
        });
        await assertLockHeld();
        await store.markOutboxPublished(publishable, now);
        return { published: true, count: publishable.length, revision: publication.revision, unchanged: publication.unchanged };
      } catch (error) {
        await store.retryOutbox(items, error.code ?? 'PUBLISH_FAILED', now);
        return { published: false, reason: 'retry_scheduled', code: error.code ?? 'PUBLISH_FAILED' };
      }
    });
  } catch (error) {
    if (error.code === 'COLLECTOR_LOCK_HELD') return { published: false, reason: 'lock_held' };
    throw error;
  }
}

export { announcementEvent };
