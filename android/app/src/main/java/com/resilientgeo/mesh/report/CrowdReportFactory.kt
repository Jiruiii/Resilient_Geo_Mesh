package com.resilientgeo.mesh.report

import com.resilientgeo.mesh.trust.Canonical
import com.resilientgeo.mesh.trust.CrowdCommon
import com.resilientgeo.mesh.trust.CrowdLocationHint
import com.resilientgeo.mesh.trust.DeviceSigningKey
import com.resilientgeo.mesh.trust.EventVerifier
import org.json.JSONArray
import org.json.JSONObject
import java.time.Duration
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.UUID

/** Form fields Flutter sends to `submitCrowdReport`; nothing else crosses the bridge. */
data class CrowdReportInput(
    val category: String,
    val description: String,
    val lon: Double,
    val lat: Double,
    val locationSource: String,
    val locationHint: CrowdLocationHint? = null,
)

/**
 * Pure function from form fields + time + device key to a signed event-v0.
 * Kotlin port of `buildCrowdReport()` in `pipeline/lib/crowd-report.mjs`;
 * `CrowdReportFactoryTest` rebuilds the shared fixture report byte for byte.
 */
object CrowdReportFactory {
    const val NAMESPACE = "crowd.reports"
    const val EVENT_TYPE = "CROWD_REPORT"
    const val SOURCE = "CROWD"
    const val SOURCE_VERSION = "crowd-report-v0"
    val TTL: Duration = Duration.ofHours(6)
    const val DESCRIPTION_MAX_CODE_POINTS = 160
    const val HINT_TEXT_MAX_CODE_POINTS = CrowdCommon.HINT_TEXT_MAX_CODE_POINTS

    /** Wire category -> severity; same table as CROWD_CATEGORY_SEVERITY in crowd-report.mjs. */
    val CATEGORY_SEVERITY: Map<String, String> = linkedMapOf(
        "ROAD_BLOCKAGE" to "MEDIUM",
        "FLOOD" to "HIGH",
        "FIRE_SMOKE" to "HIGH",
        "TRAPPED_INJURED" to "CRITICAL",
        "OTHER" to "LOW",
    )
    val LOCATION_SOURCES = CrowdCommon.LOCATION_SOURCES
    val HINT_KINDS = CrowdCommon.HINT_KINDS
    val HINT_PRECISIONS = CrowdCommon.HINT_PRECISIONS

    /** [minLon, minLat, maxLon, maxLat]: Taiwan incl. Penghu, Kinmen, Matsu and Pratas. */
    val TAIWAN_BOUNDS = CrowdCommon.TAIWAN_BOUNDS

    fun validate(input: CrowdReportInput): List<String> {
        val errors = mutableListOf<String>()
        input.locationHint?.let { errors += CrowdCommon.hintErrors(it) }
        if (input.category !in CATEGORY_SEVERITY) errors += "category is not a known crowd report category"
        if (input.locationSource !in LOCATION_SOURCES) errors += "location.source is invalid"
        val description = input.description.trim()
        if (description.codePointCount(0, description.length) > DESCRIPTION_MAX_CODE_POINTS) {
            errors += "description exceeds $DESCRIPTION_MAX_CODE_POINTS characters"
        }
        errors += CrowdCommon.coordinateErrors(input.lon, input.lat)
        return errors
    }

    fun create(
        input: CrowdReportInput,
        key: DeviceSigningKey,
        issuedAt: Instant,
        reportUuid: UUID = UUID.randomUUID(),
    ): JSONObject {
        val errors = validate(input)
        require(errors.isEmpty()) { errors.joinToString("; ") }
        val keyId = key.keyId()
        val issued = issuedAt.truncatedTo(ChronoUnit.SECONDS)
        val attributes = JSONObject()
            .put("category", input.category)
            .put("description", input.description.trim())
            .put("location_source", input.locationSource)
            .put("area_id", "crowd")
            .put("theme", "report")
        input.locationHint?.let { hint ->
            attributes.put(
                "location_hint",
                JSONObject()
                    .put("method", hint.method)
                    .put("query", hint.query)
                    .put("label", hint.label)
                    .put("kind", hint.kind)
                    .put("precision", hint.precision),
            )
        }
        val event = JSONObject()
            .put("schema_version", "event-v0")
            .put("namespace", NAMESPACE)
            .put("event_id", "report:${keyId.takeLast(8)}:${reportUuid.toString().lowercase()}")
            .put("event_type", EVENT_TYPE)
            .put(
                "geometry",
                JSONObject()
                    .put("type", "Point")
                    .put("coordinates", JSONArray().put(CrowdCommon.roundCoordinate(input.lon)).put(CrowdCommon.roundCoordinate(input.lat))),
            )
            .put("severity", CATEGORY_SEVERITY.getValue(input.category))
            .put("source", SOURCE)
            .put("source_version", SOURCE_VERSION)
            .put("event_version", 1)
            .put("issued_at", issued.toString())
            .put("expires_at", issued.plus(TTL).toString())
            .put("attributes", attributes)
            .put("signing_key_id", keyId)
            .put("signer_public_key", key.publicKeySpkiBase64())
            .put(
                "provenance",
                JSONObject()
                    .put("original_source", "crowd-app")
                    .put("received_at", issued.toString())
                    .put("transport_source", JSONObject().put("kind", "local_report")),
            )
        return signEvent(event, key)
    }

    /** Kotlin counterpart of `signEvent()` in contract.mjs, for device keys only. */
    fun signEvent(event: JSONObject, key: DeviceSigningKey): JSONObject {
        event.put("payload_hash", Canonical.sha256Canonical(EventVerifier.eventPayload(event)))
        event.put("signature_algorithm", "Ed25519")
        event.put("signature", key.signCanonical(Canonical.canonicalize(EventVerifier.eventSignatureInput(event))))
        return event
    }

    /** Matches JS `Number(value.toFixed(6))` for the coordinates this factory accepts. */
    internal fun roundCoordinate(value: Double): Double = CrowdCommon.roundCoordinate(value)
}
