package com.resilientgeo.mesh.report

import com.resilientgeo.mesh.trust.CrowdCommon
import com.resilientgeo.mesh.trust.CrowdLocationHint
import com.resilientgeo.mesh.trust.DeviceSigningKey
import com.resilientgeo.mesh.trust.RescueContract
import com.resilientgeo.mesh.trust.RescueRequestInput
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.UUID

enum class RescueAction { UPDATE, EXTEND, RESOLVE, CANCEL }

/**
 * Kotlin port of `buildRescueRequest()` / `buildRescueRevision()` in
 * `pipeline/lib/rescue-request.mjs`; `RescueRequestFactoryTest` rebuilds the
 * shared fixture timeline byte for byte.
 */
object RescueRequestFactory {

    fun create(input: RescueRequestInput, key: DeviceSigningKey, issuedAt: Instant, requestUuid: UUID = UUID.randomUUID()): JSONObject {
        val issued = issuedAt.truncatedTo(ChronoUnit.SECONDS)
        return assembleAndSign(
            input = input,
            eventId = RescueContract.eventIdPrefix(key.keyId()) + requestUuid.toString().lowercase(),
            version = 1,
            issued = issued,
            expires = issued.plus(RescueContract.TTL),
            status = "ACTIVE",
            firstIssuedAt = issued.toString(),
            key = key,
        )
    }

    fun revise(previous: JSONObject, action: RescueAction, changes: RescueRequestInput?, key: DeviceSigningKey, issuedAt: Instant): JSONObject {
        require(key.keyId() == previous.getString("signing_key_id")) { "rescue_revision_wrong_device" }
        val previousAttributes = previous.getJSONObject("attributes")
        require(!RescueContract.isTerminal(previousAttributes.getString("status"))) { "rescue_revision_terminal" }
        val issued = issuedAt.truncatedTo(ChronoUnit.SECONDS)
        val previousExpires = Instant.parse(previous.getString("expires_at"))
        require(issued.isBefore(previousExpires)) { "rescue_revision_expired" }
        val firstIssuedAt = previousAttributes.getString("first_issued_at")
        val expires = if (action == RescueAction.EXTEND) {
            val cap = Instant.parse(firstIssuedAt).plus(RescueContract.MAX_LIFETIME)
            val extended = minOf(issued.plus(RescueContract.TTL), cap)
            require(extended.isAfter(previousExpires)) { "rescue_extend_not_later" }
            extended
        } else {
            previousExpires
        }
        val input = if (action == RescueAction.UPDATE) requireNotNull(changes) { "rescue_action_invalid" } else inputFromEvent(previous)
        val status = when (action) {
            RescueAction.RESOLVE -> "RESOLVED"
            RescueAction.CANCEL -> "CANCELLED"
            else -> "ACTIVE"
        }
        return assembleAndSign(
            input = input,
            eventId = previous.getString("event_id"),
            version = previous.getInt("event_version") + 1,
            issued = issued,
            expires = expires,
            status = status,
            firstIssuedAt = firstIssuedAt,
            key = key,
        )
    }

    fun inputFromEvent(event: JSONObject): RescueRequestInput {
        val attributes = event.getJSONObject("attributes")
        val triage = attributes.getJSONObject("triage")
        val coordinates = event.getJSONObject("geometry").getJSONArray("coordinates")
        val hint = attributes.optJSONObject("location_hint")
        return RescueRequestInput(
            requestType = attributes.getString("request_type"),
            subject = attributes.getString("subject"),
            peopleCount = attributes.getInt("people_count"),
            triage = triage.keys().asSequence().associateWith { triage.getString(it) },
            description = attributes.getString("description"),
            lon = coordinates.getDouble(0),
            lat = coordinates.getDouble(1),
            locationSource = attributes.getString("location_source"),
            locationHint = hint?.let {
                CrowdLocationHint(it.getString("method"), it.getString("query"), it.getString("label"), it.getString("kind"), it.getString("precision"))
            },
        )
    }

    private fun normalizedTriage(subject: String, triage: Map<String, String>): Map<String, String> = linkedMapOf(
        "immobile" to triage["immobile"].orEmpty(),
        "breathing_difficulty" to triage["breathing_difficulty"].orEmpty(),
        "severe_bleeding" to triage["severe_bleeding"].orEmpty(),
        "conscious" to if (subject == "SELF") "YES" else triage["conscious"].orEmpty(),
    )

    private fun assembleAndSign(
        input: RescueRequestInput,
        eventId: String,
        version: Int,
        issued: Instant,
        expires: Instant,
        status: String,
        firstIssuedAt: String,
        key: DeviceSigningKey,
    ): JSONObject {
        val normalized = input.copy(triage = normalizedTriage(input.subject, input.triage))
        val errors = RescueContract.fieldErrors(normalized)
        require(errors.isEmpty()) { errors.joinToString("; ") }
        val triage = JSONObject()
        normalized.triage.forEach { (field, answer) -> triage.put(field, answer) }
        val attributes = JSONObject()
            .put("request_type", normalized.requestType)
            .put("status", status)
            .put("subject", normalized.subject)
            .put("people_count", normalized.peopleCount)
            .put("triage", triage)
            .put("description", normalized.description.trim())
            .put("location_source", normalized.locationSource)
            .put("first_issued_at", firstIssuedAt)
            .put("area_id", "crowd")
            .put("theme", "rescue")
        normalized.locationHint?.let { hint ->
            attributes.put(
                "location_hint",
                JSONObject().put("method", hint.method).put("query", hint.query).put("label", hint.label)
                    .put("kind", hint.kind).put("precision", hint.precision),
            )
        }
        val event = JSONObject()
            .put("schema_version", "event-v0")
            .put("namespace", RescueContract.NAMESPACE)
            .put("event_id", eventId)
            .put("event_type", RescueContract.EVENT_TYPE)
            .put(
                "geometry",
                JSONObject().put("type", "Point").put(
                    "coordinates",
                    JSONArray().put(CrowdCommon.roundCoordinate(normalized.lon)).put(CrowdCommon.roundCoordinate(normalized.lat)),
                ),
            )
            .put("severity", RescueContract.deriveUrgency(normalized.requestType, normalized.triage))
            .put("source", RescueContract.SOURCE)
            .put("source_version", RescueContract.SOURCE_VERSION)
            .put("event_version", version)
            .put("issued_at", issued.toString())
            .put("expires_at", expires.toString())
            .put("attributes", attributes)
            .put("signing_key_id", key.keyId())
            .put("signer_public_key", key.publicKeySpkiBase64())
            .put(
                "provenance",
                JSONObject()
                    .put("original_source", "crowd-app")
                    .put("received_at", issued.toString())
                    .put("transport_source", JSONObject().put("kind", "local_report")),
            )
        return CrowdReportFactory.signEvent(event, key)
    }
}
