package com.resilientgeo.mesh.report

import com.resilientgeo.mesh.protocol.ChunkVerifier
import com.resilientgeo.mesh.trust.Canonical
import com.resilientgeo.mesh.trust.DeviceKeys
import com.resilientgeo.mesh.trust.DeviceSigningKey
import com.resilientgeo.mesh.trust.Ed25519Verifier
import com.resilientgeo.mesh.trust.EventVerifier
import com.resilientgeo.mesh.trust.EventShapeValidator
import com.resilientgeo.mesh.trust.TrustedKeyStore
import com.resilientgeo.mesh.trust.VerificationResult
import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.time.Instant

/** A single device-signed official warning chunk that relays unchanged over BLE. */
object GovernmentWarningChunkCodec {
    const val DATASET_ID = "government-device-announcements"
    const val NAMESPACE = GovernmentWarningFactory.NAMESPACE
    const val MANIFEST_ID = "government-device-announcements:none"
    const val DATASET_VERSION = 1
    const val MAX_PAYLOAD_BYTES = 65_536

    enum class ReplayDecision { NEW, IDENTICAL, CONFLICT }

    fun chunkIdFor(eventId: String) = "government-device-announcement:$eventId"

    fun classifyReplay(existing: JSONObject?, incoming: JSONObject): ReplayDecision {
        if (existing == null) return ReplayDecision.NEW
        if (existing.optString("event_id") != incoming.optString("event_id") ||
            existing.optString("namespace") != incoming.optString("namespace")
        ) return ReplayDecision.CONFLICT
        return if (existing.optInt("event_version", -1) == incoming.optInt("event_version", -2) &&
            existing.optString("payload_hash") == incoming.optString("payload_hash") &&
            existing.optString("signature") == incoming.optString("signature")
        ) ReplayDecision.IDENTICAL else ReplayDecision.CONFLICT
    }

    fun build(event: JSONObject, key: DeviceSigningKey): JSONObject {
        require(GovernmentWarningFactory.validateEvent(event).isEmpty()) { "government warning event is invalid" }
        require(event.optString("signing_key_id") == key.keyId() &&
            event.optString("signer_public_key") == key.publicKeySpkiBase64()
        ) { "only the signing device can wrap its government warning" }
        val bbox = bboxFor(event)
        val chunk = JSONObject()
            .put("schema_version", "chunk-v0")
            .put("chunk_id", chunkIdFor(event.getString("event_id")))
            .put("manifest_id", MANIFEST_ID)
            .put("manifest_hash", event.getString("payload_hash"))
            .put("dataset_id", DATASET_ID)
            .put("namespace", NAMESPACE)
            .put("dataset_version", DATASET_VERSION)
            .put("sequence", 0)
            .put("priority", priorityFor(event.getString("severity")))
            .put("area_id", GovernmentWarningFactory.AREA_ID)
            .put("theme", GovernmentWarningFactory.THEME)
            .put("bbox", bbox)
            .put("created_at", event.getString("issued_at"))
            .put("content_type", "application/json")
            .put("content_encoding", "identity")
            .put("event_count", 1)
            .put("events", JSONArray().put(JSONObject(event.toString())))
            .put("signature_algorithm", "Ed25519")
            .put("signing_key_id", key.keyId())
        val payload = Canonical.canonicalize(ChunkVerifier.chunkContent(chunk)).toByteArray(StandardCharsets.UTF_8)
        require(payload.size <= MAX_PAYLOAD_BYTES) { "government warning chunk is too large" }
        chunk.put("byte_length", payload.size)
        chunk.put("chunk_hash", Canonical.sha256Bytes(payload))
        chunk.put("signature", key.signCanonical(Canonical.canonicalize(ChunkVerifier.chunkSignatureInput(chunk))))
        return chunk
    }

    fun verify(
        chunk: JSONObject,
        trustStore: TrustedKeyStore,
        now: Instant,
        revokedAtByCertificateId: Map<String, Instant> = emptyMap(),
    ): ChunkVerifier.Result = try {
        verifyOrThrow(chunk, trustStore, now, revokedAtByCertificateId)
    } catch (_: Exception) {
        ChunkVerifier.Result.Invalid("government_warning_chunk_shape_invalid")
    }

    private fun verifyOrThrow(
        chunk: JSONObject,
        trustStore: TrustedKeyStore,
        now: Instant,
        revokedAtByCertificateId: Map<String, Instant>,
    ): ChunkVerifier.Result {
        if (!shapeValid(chunk)) return invalid("government_warning_chunk_shape_invalid")
        val events = chunk.optJSONArray("events") ?: return invalid("government_warning_chunk_shape_invalid")
        if (events.length() != 1) return invalid("government_warning_chunk_must_hold_one_event")
        val event = events.getJSONObject(0)
        if (GovernmentWarningFactory.validateEvent(event).isNotEmpty() || EventShapeValidator.validate(event).isNotEmpty()) {
            return invalid("government_warning_event_shape_invalid")
        }
        if (chunk.optString("dataset_id") != DATASET_ID || chunk.optString("namespace") != NAMESPACE ||
            chunk.optString("chunk_id") != chunkIdFor(event.optString("event_id")) ||
            chunk.optString("manifest_id") != MANIFEST_ID || chunk.optInt("dataset_version", -1) != DATASET_VERSION ||
            chunk.optString("manifest_hash") != event.optString("payload_hash") ||
            chunk.optString("area_id") != GovernmentWarningFactory.AREA_ID ||
            chunk.optString("theme") != GovernmentWarningFactory.THEME ||
            chunk.optString("signing_key_id") != event.optString("signing_key_id") ||
            chunk.optString("namespace") != event.optString("namespace")
        ) return invalid("government_warning_chunk_binding_invalid")
        if (!bboxMatches(chunk.optJSONArray("bbox"), event)) return invalid("chunk_bbox_mismatch")
        val payload = Canonical.canonicalize(ChunkVerifier.chunkContent(chunk)).toByteArray(StandardCharsets.UTF_8)
        if (payload.size > MAX_PAYLOAD_BYTES) return invalid("government_warning_chunk_too_large")
        if (Canonical.sha256Bytes(payload) != chunk.optString("chunk_hash")) return invalid("chunk_hash_mismatch")
        if (payload.size != chunk.optInt("byte_length", -1)) return invalid("chunk_byte_length_mismatch")
        val signerPublicKey = runCatching {
            Ed25519Verifier.parsePublicKeySpkiBase64(event.getString("signer_public_key"))
        }.getOrNull() ?: return invalid("signer_public_key is not an Ed25519 SPKI key")
        if (!DeviceKeys.isDeviceKeyId(chunk.optString("signing_key_id")) ||
            DeviceKeys.keyIdFromSpkiBase64(event.optString("signer_public_key")) != chunk.optString("signing_key_id")
        ) return invalid("government_warning_chunk_signer_mismatch")
        if (!Ed25519Verifier.verify(Canonical.canonicalize(ChunkVerifier.chunkSignatureInput(chunk)),
                chunk.optString("signature"), signerPublicKey)
        ) return invalid("chunk_signature_invalid")
        if (EventVerifier.verify(event, trustStore, now, revokedAtByCertificateId) is VerificationResult.Invalid) {
            return invalid("chunk_contains_invalid_event")
        }
        return ChunkVerifier.Result.Valid(listOf(event))
    }

    private fun bboxFor(event: JSONObject): JSONArray {
        val geometry = event.getJSONObject("geometry")
        val coordinates = if (geometry.optString("type") == "Point") geometry.getJSONArray("coordinates")
            else JSONArray().put(121.0).put(23.5)
        val lon = roundCoordinate(coordinates.getDouble(0))
        val lat = roundCoordinate(coordinates.getDouble(1))
        return JSONArray().put(lon).put(lat).put(lon).put(lat)
    }

    private fun bboxMatches(bbox: JSONArray?, event: JSONObject): Boolean {
        if (bbox == null || bbox.length() != 4) return false
        val expected = bboxFor(event)
        return (0 until 4).all { index -> bbox.optDouble(index, Double.NaN) == expected.optDouble(index) }
    }

    private fun priorityFor(severity: String) = if (severity in setOf("CRITICAL", "HIGH")) "HIGH" else "NORMAL"
    private fun roundCoordinate(value: Double) = kotlin.math.round(value * 1_000_000.0) / 1_000_000.0
    private fun invalid(reason: String) = ChunkVerifier.Result.Invalid(reason)

    private val requiredStrings = listOf(
        "schema_version", "chunk_id", "manifest_id", "manifest_hash", "dataset_id", "namespace",
        "priority", "area_id", "theme", "created_at", "content_type", "content_encoding", "chunk_hash",
        "signature", "signature_algorithm", "signing_key_id",
    )

    private fun shapeValid(chunk: JSONObject): Boolean = requiredStrings.all { chunk.opt(it) is String } &&
        chunk.optString("schema_version") == "chunk-v0" && chunk.optString("signature_algorithm") == "Ed25519" &&
        chunk.optString("content_type") == "application/json" && chunk.optString("content_encoding") == "identity" &&
        chunk.opt("events") is JSONArray && chunk.opt("bbox") is JSONArray &&
        chunk.opt("byte_length") is Number && chunk.opt("event_count") is Number &&
        chunk.optInt("event_count", -1) == 1
}
