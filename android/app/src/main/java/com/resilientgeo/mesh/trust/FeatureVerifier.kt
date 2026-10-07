package com.resilientgeo.mesh.trust

import org.json.JSONObject

/** Verification result for a signed `feature-v0` record. */
data class FeatureVerificationResult(
    val valid: Boolean,
    val stage: Stage,
    val errors: List<String> = emptyList(),
) {
    enum class Stage { SCHEMA, TRUST, INTEGRITY, SIGNATURE }
}

/**
 * Verifies the feature contract emitted by `pipeline/lib/feature-contract.mjs`.
 * Static layers use the same trust store as events; a feature is never exposed
 * to the map bridge until its payload hash and Ed25519 signature pass.
 */
object FeatureVerifier {

    private val SHA256_RE = Regex("^sha256:[0-9a-fA-F]{64}$")
    private val BASE64_RE = Regex("^[A-Za-z0-9+/]+={0,2}$")

    private val PAYLOAD_FIELDS = listOf(
        "namespace", "dataset_id", "layer_id", "feature_id", "feature_type",
        "geometry", "properties", "source", "source_version", "issued_at", "expires_at",
    )

    private val REQUIRED_FIELDS = listOf(
        "schema_version", "namespace", "dataset_id", "layer_id", "feature_id",
        "feature_type", "geometry", "properties", "source", "source_version",
        "issued_at", "expires_at", "signature_algorithm", "signing_key_id",
        "provenance", "payload_hash", "signature",
    )

    fun featurePayload(feature: JSONObject): JSONObject {
        val payload = JSONObject()
        for (field in PAYLOAD_FIELDS) if (feature.has(field)) payload.put(field, feature.get(field))
        return payload
    }

    fun verify(feature: JSONObject, trustStore: TrustedKeyStore): FeatureVerificationResult {
        val shapeErrors = validateShape(feature)
        if (shapeErrors.isNotEmpty()) return FeatureVerificationResult(false, FeatureVerificationResult.Stage.SCHEMA, shapeErrors)

        val signingKeyId = feature.getString("signing_key_id")
        val publicKey = trustStore.publicKeyFor(signingKeyId)
            ?: return FeatureVerificationResult(false, FeatureVerificationResult.Stage.TRUST, listOf("signing_key_id is not trusted"))

        val expectedHash = Canonical.sha256Canonical(featurePayload(feature))
        if (expectedHash != feature.getString("payload_hash")) {
            return FeatureVerificationResult(false, FeatureVerificationResult.Stage.INTEGRITY, listOf("payload_hash_mismatch"))
        }

        val signatureInput = featurePayload(feature).apply {
            put("payload_hash", feature.getString("payload_hash"))
        }
        if (!Ed25519Verifier.verify(Canonical.canonicalize(signatureInput), feature.getString("signature"), publicKey)) {
            return FeatureVerificationResult(false, FeatureVerificationResult.Stage.SIGNATURE, listOf("signature_invalid"))
        }
        return FeatureVerificationResult(true, FeatureVerificationResult.Stage.SIGNATURE)
    }

    private fun validateShape(feature: JSONObject): List<String> {
        val errors = mutableListOf<String>()
        for (field in REQUIRED_FIELDS) if (!feature.has(field)) errors += "missing required field: $field"
        if (feature.optString("schema_version") != "feature-v0") errors += "schema_version must be feature-v0"
        for (field in listOf("namespace", "dataset_id", "layer_id", "feature_id", "feature_type", "source", "source_version", "signing_key_id")) {
            val value = feature.opt(field)
            if (value !is String || value.isEmpty()) errors += "$field must be a non-empty string"
        }
        val directoryEntry = feature.optString("layer_id") == "taiwan-medical-directory" &&
            feature.optString("feature_type") == "MEDICAL_DIRECTORY_ENTRY"
        val properties = feature.optJSONObject("properties")
        if (directoryEntry) {
            if (!feature.isNull("geometry")) errors += "medical directory geometry must be null"
            val status = properties?.optString("geometry_status")
            val hasPointFeatureId = properties?.has("point_feature_id") == true
            val pointFeatureId = if (hasPointFeatureId) properties?.opt("point_feature_id") else null
            if (!hasPointFeatureId) errors += "medical directory point_feature_id is required"
            if (status !in setOf("located", "unresolved", "excluded")) {
                errors += "medical directory geometry_status is invalid"
            } else if (status == "located" && (pointFeatureId !is String || pointFeatureId.isEmpty())) {
                errors += "located medical directory entries require point_feature_id"
            } else if (status != "located" && pointFeatureId != null && pointFeatureId != org.json.JSONObject.NULL) {
                errors += "unlocated medical directory entries cannot have point_feature_id"
            }
        } else if (feature.opt("geometry") !is JSONObject) {
            errors += "geometry must be an object"
        }
        if (properties == null) errors += "properties must be an object"
        if (feature.optString("signature_algorithm") != "Ed25519") errors += "signature_algorithm must be Ed25519"
        if (feature.opt("provenance") !is JSONObject) errors += "provenance must be an object"
        val hash = feature.optString("payload_hash", "")
        if (!SHA256_RE.matches(hash)) errors += "payload_hash is invalid"
        val signature = feature.optString("signature", "")
        if (signature.length < 4 || !BASE64_RE.matches(signature)) errors += "signature is invalid"
        return errors
    }
}
