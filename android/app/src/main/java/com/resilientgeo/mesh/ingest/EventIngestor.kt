package com.resilientgeo.mesh.ingest

import com.resilientgeo.mesh.trust.EventVerifier
import com.resilientgeo.mesh.trust.TrustedKeyStore
import com.resilientgeo.mesh.trust.VerificationResult
import org.json.JSONObject
import java.time.Instant

/**
 * Kotlin port of `ingestEvent()` from `pipeline/lib/contract.mjs` — the
 * apply rules module B is responsible for on Android:
 *
 *  1. Reject anything that fails verification (schema/trust/integrity/signature).
 *  2. A newer `event_version` for the same (namespace, event_id) replaces the stored one.
 *  3. An older or equal version is rejected outright — the store is left untouched.
 *  4. `official.*` and `crowd.*` (or any other) namespaces never overwrite each other,
 *     because identity is (namespace, event_id), not event_id alone.
 *  5. An expired event's payload is removed by local retention; its version floor
 *     remains so an older peer copy cannot make it active again.
 */
object EventIngestor {

    fun ingest(store: EventStore, event: JSONObject, trustStore: TrustedKeyStore, now: Instant = Instant.now()): IngestResult {
        val verification = EventVerifier.verify(event, trustStore, now)
        if (verification is VerificationResult.Invalid) {
            return IngestResult.RejectedVerification(verification.stage, verification.errors)
        }
        val namespace = event.getString("namespace")
        val eventId = event.getString("event_id")
        val eventVersion = event.getInt("event_version")
        val existing = store.find(namespace, eventId)
        val versionFloor = maxOf(existing?.eventVersion ?: Int.MIN_VALUE, store.versionFloor(namespace, eventId) ?: Int.MIN_VALUE)

        if (existing == null && eventVersion <= versionFloor) {
            return if (eventVersion < versionFloor) {
                IngestResult.RejectedVersionRollback(versionFloor, eventVersion)
            } else {
                IngestResult.RejectedSameVersionConflict(versionFloor, eventVersion)
            }
        }

        if (existing == null) {
            val state = ApplyState.at(namespace, event.getString("expires_at"), now)
            store.save(toStoredEvent(event, namespace, eventId, eventVersion, state))
            val separateNamespace = store.findUnderOtherNamespace(eventId, namespace) != null
            return IngestResult.Inserted(separateNamespace, state)
        }

        if (eventVersion > existing.eventVersion) {
            val state = ApplyState.at(namespace, event.getString("expires_at"), now)
            store.save(toStoredEvent(event, namespace, eventId, eventVersion, state))
            return IngestResult.Updated(existing.eventVersion, eventVersion, state)
        }

        if (eventVersion < versionFloor) {
            return IngestResult.RejectedVersionRollback(versionFloor, eventVersion)
        }

        return IngestResult.RejectedSameVersionConflict(versionFloor, eventVersion)
    }

    private fun toStoredEvent(event: JSONObject, namespace: String, eventId: String, eventVersion: Int, state: ApplyState) = StoredEvent(
        namespace = namespace,
        eventId = eventId,
        eventVersion = eventVersion,
        eventType = event.getString("event_type"),
        severity = event.getString("severity"),
        expiresAt = event.getString("expires_at"),
        applyState = state,
        eventJson = event.toString(),
    )
}
