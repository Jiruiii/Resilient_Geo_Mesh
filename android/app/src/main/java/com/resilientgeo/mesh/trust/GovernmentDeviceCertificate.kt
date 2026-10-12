package com.resilientgeo.mesh.trust

import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.json.JSONObject
import java.time.Duration
import java.time.Instant

/** Verifies centrally signed, seven-day authorization for an Android device key. */
object GovernmentDeviceCertificate {
    const val SCHEMA_VERSION = "government-device-certificate-v1"
    const val WARNING_PERMISSION = "official.announcement.publish"
    private val VALIDITY = Duration.ofDays(7)

    data class Result(
        val valid: Boolean,
        val errors: List<String>,
        val signerPublicKey: Ed25519PublicKeyParameters? = null,
    )

    fun verify(certificate: JSONObject, trustStore: TrustedKeyStore, at: Instant): Result {
        val errors = mutableListOf<String>()
        val required = listOf(
            "schema_version", "certificate_id", "device_id", "subject_id",
            "signing_key_id", "signer_public_key", "agency", "permissions",
            "issued_at", "expires_at", "issuer_key_id", "signature_algorithm", "signature",
        )
        for (field in required) {
            if (!certificate.has(field)) errors.add("missing required field: $field")
        }
        if (errors.isNotEmpty()) return Result(false, errors)
        if (certificate.optString("schema_version") != SCHEMA_VERSION) {
            errors.add("certificate schema_version is invalid")
        }
        for (field in listOf("certificate_id", "device_id", "subject_id", "agency", "issuer_key_id")) {
            val value = certificate.opt(field)
            if (value !is String || value.isBlank()) errors.add("$field must be a non-empty string")
        }

        val signingKeyId = certificate.optString("signing_key_id", "")
        val signerSpki = certificate.opt("signer_public_key") as? String
        val signerPublicKey = signerSpki?.let {
            try { Ed25519Verifier.parsePublicKeySpkiBase64(it) } catch (_: Exception) { null }
        }
        if (signerPublicKey == null) {
            errors.add("signer_public_key is not an Ed25519 SPKI key")
        } else if (DeviceKeys.keyIdFromSpkiBase64(signerSpki!!) != signingKeyId) {
            errors.add("signing_key_id does not match signer_public_key fingerprint")
        }

        val permissions = certificate.opt("permissions") as? org.json.JSONArray
        if (permissions == null) {
            errors.add("permissions must be an array")
        } else if ((0 until permissions.length()).none { permissions.optString(it) == WARNING_PERMISSION }) {
            errors.add("certificate lacks official announcement publish permission")
        }

        val issuedAt = EventShapeValidator.parseTimeOrNull(certificate.opt("issued_at") as? String)
        val expiresAt = EventShapeValidator.parseTimeOrNull(certificate.opt("expires_at") as? String)
        if (issuedAt == null) errors.add("issued_at must be an RFC 3339 timestamp")
        if (expiresAt == null) errors.add("expires_at must be an RFC 3339 timestamp")
        if (issuedAt != null && expiresAt != null && Duration.between(issuedAt, expiresAt) != VALIDITY) {
            errors.add("government device certificate validity must be exactly seven days")
        }
        if (certificate.optString("signature_algorithm") != "Ed25519") {
            errors.add("signature_algorithm must be Ed25519")
        }
        val signature = certificate.optString("signature", "")
        if (signature.length < 4) errors.add("signature must be base64")

        val issuerKeyId = certificate.optString("issuer_key_id", "")
        val issuerPublicKey = trustStore.publicKeyFor(issuerKeyId)
        if (issuerPublicKey == null) errors.add("certificate issuer is not trusted")
        if (errors.isNotEmpty()) return Result(false, errors)

        val unsigned = JSONObject(certificate.toString()).apply { remove("signature") }
        if (!Ed25519Verifier.verify(Canonical.canonicalize(unsigned), signature, issuerPublicKey!!)) {
            return Result(false, listOf("certificate_signature_invalid"))
        }
        if (issuedAt == null || expiresAt == null || at.isBefore(issuedAt) || !at.isBefore(expiresAt)) {
            return Result(false, listOf("certificate is not valid at the requested time"))
        }
        return Result(true, emptyList(), signerPublicKey)
    }
}
