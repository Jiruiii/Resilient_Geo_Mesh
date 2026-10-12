package com.resilientgeo.mesh.trust

import org.json.JSONObject
import java.time.Duration

data class RescueRequestInput(
    val requestType: String,
    val subject: String,
    val peopleCount: Int,
    val triage: Map<String, String>,
    val description: String,
    val lon: Double,
    val lat: Double,
    val locationSource: String,
    val locationHint: CrowdLocationHint? = null,
)

/**
 * Kotlin port of `pipeline/lib/rescue-contract.mjs`. Error codes and their
 * order are part of the contract; `RescueContractTest` replays the shared
 * fixture against this object.
 */
object RescueContract {
    const val NAMESPACE = "crowd.rescue"
    const val EVENT_TYPE = "RESCUE_REQUEST"
    const val SOURCE = "CROWD"
    const val SOURCE_VERSION = "rescue-request-v0"
    const val DATASET_ID = "crowd-rescue"
    const val MANIFEST_ID = "crowd-rescue:none"
    val TTL: Duration = Duration.ofHours(6)
    val MAX_LIFETIME: Duration = Duration.ofHours(72)
    const val MAX_EVENT_VERSION = 200
    const val PEOPLE_MAX = 50
    const val DESCRIPTION_MAX_CODE_POINTS = 160

    val REQUEST_TYPES = listOf("FIRST_AID_NEEDED", "IMMOBILE", "TRAPPED", "TRAPPED_DEBRIS", "OTHER_RESCUE")
    val STATUSES = listOf("ACTIVE", "RESOLVED", "CANCELLED")
    val SUBJECTS = listOf("SELF", "OTHERS")
    val TRIAGE_FIELDS = listOf("immobile", "breathing_difficulty", "severe_bleeding", "conscious")
    val TRIAGE_ANSWERS = setOf("YES", "NO", "UNKNOWN")

    private val ATTRIBUTE_KEYS = setOf(
        "request_type", "status", "subject", "people_count", "triage", "description",
        "location_source", "location_hint", "first_issued_at", "area_id", "theme",
    )
    private val EVENT_ID_RE =
        Regex("^rescue:([0-9a-f]{32}):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

    fun deriveUrgency(requestType: String?, triage: Map<String, Any?>): String = when {
        requestType == "TRAPPED_DEBRIS" -> "CRITICAL"
        triage["breathing_difficulty"] == "YES" || triage["severe_bleeding"] == "YES" || triage["conscious"] == "NO" -> "CRITICAL"
        requestType == "TRAPPED" || requestType == "IMMOBILE" || triage["immobile"] == "YES" -> "HIGH"
        else -> "MEDIUM"
    }

    fun eventIdPrefix(signingKeyId: String): String = "rescue:${signingKeyId.removePrefix(DeviceKeys.PREFIX)}:"

    fun isTerminal(status: String?): Boolean = status == "RESOLVED" || status == "CANCELLED"

    private fun triageValid(triage: Map<String, Any?>, subject: String?): Boolean {
        if (triage.keys != TRIAGE_FIELDS.toSet()) return false
        if (!TRIAGE_FIELDS.all { triage[it] is String && triage[it] in TRIAGE_ANSWERS }) return false
        return subject != "SELF" || triage["conscious"] == "YES"
    }

    private fun codePoints(value: String): Int = value.codePointCount(0, value.length)

    fun fieldErrors(input: RescueRequestInput): List<String> = fieldErrors(
        requestType = input.requestType,
        subject = input.subject,
        peopleCount = input.peopleCount,
        triage = input.triage,
        description = input.description,
        lon = input.lon,
        lat = input.lat,
        locationSource = input.locationSource,
        hintValid = input.locationHint?.let { CrowdCommon.hintErrors(it).isEmpty() } ?: true,
    )

    private fun fieldErrors(
        requestType: String?,
        subject: String?,
        peopleCount: Int?,
        triage: Map<String, Any?>?,
        description: String?,
        lon: Double,
        lat: Double,
        locationSource: String?,
        hintValid: Boolean,
    ): List<String> {
        val errors = mutableListOf<String>()
        if (requestType !in REQUEST_TYPES) errors += "rescue_field_invalid:request_type"
        if (subject !in SUBJECTS) errors += "rescue_field_invalid:subject"
        if (peopleCount == null || peopleCount < 1 || peopleCount > PEOPLE_MAX) errors += "rescue_field_invalid:people_count"
        if (triage == null || !triageValid(triage, subject)) errors += "rescue_field_invalid:triage"
        if (description == null || codePoints(description.trim()) > DESCRIPTION_MAX_CODE_POINTS) {
            errors += "rescue_field_invalid:description"
        }
        if (locationSource !in CrowdCommon.LOCATION_SOURCES) errors += "rescue_field_invalid:location_source"
        if (!hintValid) errors += "rescue_field_invalid:location_hint"
        if (CrowdCommon.coordinateErrors(lon, lat).isNotEmpty()) errors += "rescue_geometry_invalid"
        return errors
    }

    /** Stateless rules; assumes EventShapeValidator already passed. Returns at most one code. */
    fun eventErrors(event: JSONObject): List<String> {
        val attributes = event.optJSONObject("attributes") ?: JSONObject()
        if (event.optString("namespace") != NAMESPACE || event.optString("event_type") != EVENT_TYPE ||
            event.optString("source") != SOURCE || event.optString("source_version") != SOURCE_VERSION ||
            attributes.opt("area_id") != "crowd" || attributes.opt("theme") != "rescue"
        ) {
            return listOf("rescue_identity_invalid")
        }
        val match = EVENT_ID_RE.matchEntire(event.optString("event_id"))
        if (match == null || DeviceKeys.PREFIX + match.groupValues[1] != event.optString("signing_key_id")) {
            return listOf("rescue_event_id_unbound")
        }
        val geometry = event.optJSONObject("geometry")
        val coordinates = geometry?.optJSONArray("coordinates")
        if (geometry?.optString("type") != "Point" || coordinates == null || coordinates.length() != 2) {
            return listOf("rescue_geometry_invalid")
        }
        if (attributes.keys().asSequence().any { it !in ATTRIBUTE_KEYS }) return listOf("rescue_attributes_unknown")

        val triageJson = attributes.opt("triage") as? JSONObject
        val triage = triageJson?.let { json -> json.keys().asSequence().associateWith { json.get(it) } }
        val hint = attributes.opt("location_hint")
        val hintValid = when (hint) {
            null -> true
            is JSONObject -> {
                val fields = listOf("method", "query", "label", "kind", "precision")
                fields.all { hint.opt(it) is String } && CrowdCommon.hintErrors(
                    CrowdLocationHint(
                        hint.getString("method"), hint.getString("query"), hint.getString("label"),
                        hint.getString("kind"), hint.getString("precision"),
                    ),
                ).isEmpty()
            }
            else -> false
        }
        val people = when (val value = attributes.opt("people_count")) {
            is Int -> value
            is Long -> value.takeIf { it in Int.MIN_VALUE..Int.MAX_VALUE }?.toInt()
            else -> null
        }
        val fieldErrors = fieldErrors(
            requestType = attributes.opt("request_type") as? String,
            subject = attributes.opt("subject") as? String,
            peopleCount = people,
            triage = triage,
            description = attributes.opt("description") as? String,
            lon = (coordinates.opt(0) as? Number)?.toDouble() ?: Double.NaN,
            lat = (coordinates.opt(1) as? Number)?.toDouble() ?: Double.NaN,
            locationSource = attributes.opt("location_source") as? String,
            hintValid = hintValid,
        )
        if (fieldErrors.isNotEmpty()) return listOf(fieldErrors.first())
        if (attributes.opt("status") !in STATUSES) return listOf("rescue_field_invalid:status")
        if (event.optString("severity") != deriveUrgency(attributes.optString("request_type"), triage!!)) {
            return listOf("rescue_severity_mismatch")
        }
        val version = event.optInt("event_version")
        if (version > MAX_EVENT_VERSION) return listOf("rescue_version_too_high")
        val issued = EventShapeValidator.parseTimeOrNull(event.optString("issued_at"))
        val expires = EventShapeValidator.parseTimeOrNull(event.optString("expires_at"))
        val first = EventShapeValidator.parseTimeOrNull(attributes.opt("first_issued_at") as? String)
        if (issued == null || expires == null || first == null || first.isAfter(issued) || !expires.isAfter(issued) ||
            (version == 1 && first != issued)
        ) {
            return listOf("rescue_time_invalid")
        }
        if (Duration.between(issued, expires) > TTL) return listOf("rescue_ttl_too_long")
        if (expires.isAfter(first.plus(MAX_LIFETIME))) return listOf("rescue_lifetime_exceeded")
        return emptyList()
    }

    fun transitionErrors(stored: JSONObject, incoming: JSONObject): List<String> {
        if (stored.optString("signing_key_id") != incoming.optString("signing_key_id")) return listOf("signer_mismatch")
        val storedAttributes = stored.optJSONObject("attributes")
        val incomingAttributes = incoming.optJSONObject("attributes")
        if (isTerminal(storedAttributes?.optString("status"))) return listOf("rescue_terminal")
        if (isTerminal(incomingAttributes?.optString("status")) &&
            incoming.optString("expires_at") != stored.optString("expires_at")
        ) {
            return listOf("rescue_terminal_expiry_changed")
        }
        if (incomingAttributes?.optString("first_issued_at") != storedAttributes?.optString("first_issued_at")) {
            return listOf("rescue_first_issued_changed")
        }
        return emptyList()
    }
}
