package com.resilientgeo.mesh.report

import com.resilientgeo.mesh.trust.Canonical
import com.resilientgeo.mesh.trust.DeviceSigningKey
import com.resilientgeo.mesh.trust.EventShapeValidator
import com.resilientgeo.mesh.trust.EventVerifier
import org.json.JSONArray
import org.json.JSONObject
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.Duration
import java.time.Instant
import java.time.temporal.ChronoUnit

data class GovernmentWarningInput(
    val title: String,
    val content: String,
    val category: String,
    val severity: String,
    val expiresAt: Instant,
    val location: Location? = null,
) {
    data class Location(val longitude: Double, val latitude: Double)
}

/** Creates the exact device-signed event-v0 warning that the server accepts. */
object GovernmentWarningFactory {
    const val NAMESPACE = "official.announcement"
    const val EVENT_TYPE = "GOVERNMENT_ANNOUNCEMENT"
    const val SOURCE = "GOVERNMENT"
    const val SOURCE_VERSION = "government-device-warning-v1"
    const val AREA_ID = "tw.national"
    const val THEME = "announcement"
    const val TITLE_MAX_CODE_POINTS = 120
    const val CONTENT_MAX_CODE_POINTS = 8000
    private val MAX_LIFETIME = Duration.ofDays(90)
    private val categories = setOf("SAFETY", "WEATHER", "ROAD", "SHELTER", "OTHER")
    private val severities = setOf("LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN")
    private val taiwanBounds = doubleArrayOf(116.5, 20.5, 122.5, 26.8)

    fun validate(input: GovernmentWarningInput, issuedAt: Instant = Instant.now()): List<String> {
        val errors = mutableListOf<String>()
        val title = input.title.trim()
        val content = input.content.trim()
        if (title.isEmpty() || title.codePointCount(0, title.length) > TITLE_MAX_CODE_POINTS) {
            errors += "announcement title must contain 1 to $TITLE_MAX_CODE_POINTS characters"
        }
        if (content.isEmpty() || content.codePointCount(0, content.length) > CONTENT_MAX_CODE_POINTS) {
            errors += "announcement content must contain 1 to $CONTENT_MAX_CODE_POINTS characters"
        }
        if (input.category !in categories) errors += "announcement category is invalid"
        if (input.severity !in severities) errors += "announcement severity is invalid"
        val issued = issuedAt.truncatedTo(ChronoUnit.SECONDS)
        val expiry = input.expiresAt.truncatedTo(ChronoUnit.SECONDS)
        if (!expiry.isAfter(issued) || Duration.between(issued, expiry) > MAX_LIFETIME) {
            errors += "announcement expiry must be after issue time and within ninety days"
        }
        input.location?.let { location ->
            if (!location.longitude.isFinite() || !location.latitude.isFinite() ||
                location.longitude < taiwanBounds[0] || location.longitude > taiwanBounds[2] ||
                location.latitude < taiwanBounds[1] || location.latitude > taiwanBounds[3]
            ) errors += "announcement location is outside the supported area"
        }
        return errors
    }

    fun create(
        input: GovernmentWarningInput,
        key: DeviceSigningKey,
        certificate: JSONObject,
        issuedAt: Instant,
        eventId: String,
    ): JSONObject {
        val errors = validate(input, issuedAt)
        require(errors.isEmpty()) { errors.joinToString("; ") }
        require(eventId.isNotBlank() && eventId.length <= 200) { "announcement event id is invalid" }

        val issued = issuedAt.truncatedTo(ChronoUnit.SECONDS)
        val expiry = input.expiresAt.truncatedTo(ChronoUnit.SECONDS)
        val publicKey = key.publicKeySpkiBase64()
        require(certificate.optString("schema_version") == "government-device-certificate-v1" &&
            certificate.optString("signing_key_id") == key.keyId() &&
            certificate.optString("signer_public_key") == publicKey
        ) { "government device certificate does not match this device key" }
        val certificateIssued = parseInstant(certificate.optString("issued_at"))
        val certificateExpires = parseInstant(certificate.optString("expires_at"))
        require(certificateIssued != null && certificateExpires != null &&
            !issued.isBefore(certificateIssued) && issued.isBefore(certificateExpires)
        ) { "government device certificate is not valid at warning issue time" }
        val permissions = certificate.optJSONArray("permissions")
        require(permissions != null && (0 until permissions.length()).any { index ->
            permissions.optString(index) == "official.announcement.publish"
        }) { "government device certificate lacks warning permission" }

        val attributes = JSONObject()
            .put("title", input.title.trim())
            .put("content", input.content.trim())
            .put("category", input.category)
            .put("area_id", AREA_ID)
            .put("theme", THEME)
            .put("has_map_location", input.location != null)
            .put("government_device_certificate", JSONObject(certificate.toString()))
        val geometry = input.location?.let { location ->
            JSONObject().put("type", "Point").put("coordinates", JSONArray()
                .put(roundCoordinate(location.longitude)).put(roundCoordinate(location.latitude)))
        } ?: JSONObject().put("type", "GeometryCollection").put("geometries", JSONArray())
        val event = JSONObject()
            .put("schema_version", "event-v0")
            .put("namespace", NAMESPACE)
            .put("event_id", eventId)
            .put("event_type", EVENT_TYPE)
            .put("geometry", geometry)
            .put("severity", input.severity)
            .put("source", SOURCE)
            .put("source_version", SOURCE_VERSION)
            .put("event_version", 1)
            .put("issued_at", issued.toString())
            .put("expires_at", expiry.toString())
            .put("attributes", attributes)
            .put("signing_key_id", key.keyId())
            .put("signer_public_key", publicKey)
            .put("provenance", JSONObject()
                .put("original_source", "government-device")
                .put("received_at", issued.toString())
                .put("transport_source", JSONObject().put("kind", "local_government_warning")))
        event.put("payload_hash", Canonical.sha256Canonical(EventVerifier.eventPayload(event)))
        event.put("signature_algorithm", "Ed25519")
        event.put("signature", key.signCanonical(Canonical.canonicalize(EventVerifier.eventSignatureInput(event))))
        require(EventShapeValidator.validate(event).isEmpty()) { "created government warning does not match event-v0" }
        return event
    }

    internal fun validateEvent(event: JSONObject): List<String> {
        val errors = mutableListOf<String>()
        if (EventShapeValidator.validate(event).isNotEmpty()) errors += "event-v0 shape is invalid"
        if (event.optString("namespace") != NAMESPACE || event.optString("event_type") != EVENT_TYPE ||
            event.optString("source") != SOURCE || event.optInt("event_version", -1) != 1
        ) errors += "government warning identity is invalid"
        val attributes = event.optJSONObject("attributes")
        if (attributes == null) return errors + "government warning attributes are invalid"
        val title = attributes.optString("title").trim()
        val content = attributes.optString("content").trim()
        if (title.isEmpty() || title.codePointCount(0, title.length) > TITLE_MAX_CODE_POINTS) errors += "announcement title is invalid"
        if (content.isEmpty() || content.codePointCount(0, content.length) > CONTENT_MAX_CODE_POINTS) errors += "announcement content is invalid"
        if (attributes.optString("category") !in categories || event.optString("severity") !in severities ||
            attributes.optString("area_id") != AREA_ID || attributes.optString("theme") != THEME
        ) errors += "government warning category or scope is invalid"
        val issued = parseInstant(event.optString("issued_at"))
        val expiry = parseInstant(event.optString("expires_at"))
        if (issued == null || expiry == null || !expiry.isAfter(issued) || Duration.between(issued, expiry) > MAX_LIFETIME) {
            errors += "government warning lifetime is invalid"
        }
        val hasLocation = attributes.optBoolean("has_map_location", false)
        val geometry = event.optJSONObject("geometry")
        if (geometry?.optString("type") == "Point") {
            val coordinates = geometry.optJSONArray("coordinates")
            if (!hasLocation || coordinates == null || coordinates.length() != 2 ||
                !coordinates.optDouble(0, Double.NaN).isFinite() || !coordinates.optDouble(1, Double.NaN).isFinite() ||
                coordinates.optDouble(0) < taiwanBounds[0] || coordinates.optDouble(0) > taiwanBounds[2] ||
                coordinates.optDouble(1) < taiwanBounds[1] || coordinates.optDouble(1) > taiwanBounds[3]
            ) errors += "government warning map point is invalid"
        } else if (geometry?.optString("type") != "GeometryCollection" || hasLocation ||
            geometry?.optJSONArray("geometries")?.length() != 0
        ) errors += "government warning location is invalid"
        return errors
    }

    private fun roundCoordinate(value: Double): Double = BigDecimal(value).setScale(6, RoundingMode.HALF_UP).toDouble()
    private fun parseInstant(value: String?): Instant? = runCatching { Instant.parse(value) }.getOrNull()
}
