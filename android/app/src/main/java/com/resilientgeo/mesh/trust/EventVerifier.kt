package com.resilientgeo.mesh.trust

import org.json.JSONObject
import java.time.Instant

/**
 * Kotlin port of `verifyEvent()` from `pipeline/lib/contract.mjs`.
 *
 * Stage order matches the Node verifier exactly (schema -> trust ->
 * integrity -> signature) so error reporting stays comparable across the
 * two implementations. `trustStore` bundled on-device *is* the trust
 * policy here: there is no separate server-side `trustedKeyIds` allowlist
 * because the app never receives keys it shouldn't trust in the first
 * place (see `TrustedKeyStore`).
 */
object EventVerifier {

    private val PAYLOAD_FIELDS = listOf(
        "namespace", "event_id", "event_type", "geometry", "severity",
        "source", "source_version", "event_version", "issued_at",
        "expires_at", "attributes",
    )

    /** The subset of fields covered by `payload_hash` — mirrors `eventPayload()` in canonical.mjs. */
    fun eventPayload(event: JSONObject): JSONObject {
        val payload = JSONObject()
        for (field in PAYLOAD_FIELDS) {
            if (event.has(field)) payload.put(field, event.get(field))
        }
        return payload
    }

    /** What the Ed25519 signature actually covers — mirrors `eventSignatureInput()` in canonical.mjs. */
    fun eventSignatureInput(event: JSONObject): JSONObject {
        val input = eventPayload(event)
        input.put("payload_hash", event.get("payload_hash"))
        return input
    }

    fun verify(
        event: JSONObject,
        trustStore: TrustedKeyStore,
        now: Instant = Instant.now(),
        revokedAtByCertificateId: Map<String, Instant> = emptyMap(),
    ): VerificationResult {
        val shapeErrors = EventShapeValidator.validate(event)
        if (shapeErrors.isNotEmpty()) {
            return VerificationResult.Invalid(VerificationResult.Stage.SCHEMA, shapeErrors)
        }

        // Device keys remain self-certifying only for crowd.*. Official
        // announcements require a central certificate bound to the same key.
        val signingKeyId = event.getString("signing_key_id")
        val publicKey = if (DeviceKeys.isDeviceKeyId(signingKeyId)) {
            when {
                DeviceKeys.isCrowdNamespace(event.getString("namespace")) -> {
                    when (val device = DeviceKeys.resolve(event)) {
                        is DeviceKeys.Resolution.Resolved -> device.publicKey
                        is DeviceKeys.Resolution.Rejected ->
                            return VerificationResult.Invalid(VerificationResult.Stage.TRUST, listOf(device.error))
                    }
                }
                event.getString("namespace") == "official.announcement"
                    && event.getString("source") == "GOVERNMENT" -> {
                    val certificate = event.optJSONObject("attributes")
                        ?.optJSONObject("government_device_certificate")
                        ?: return VerificationResult.Invalid(
                            VerificationResult.Stage.TRUST,
                            listOf("government device certificate is required"),
                        )
                    if (certificate.optString("signing_key_id") != signingKeyId
                        || certificate.optString("signer_public_key") != event.optString("signer_public_key")) {
                        return VerificationResult.Invalid(
                            VerificationResult.Stage.TRUST,
                            listOf("event signing key does not match government device certificate"),
                        )
                    }
                    val issuedAt = EventShapeValidator.parseTimeOrNull(event.getString("issued_at"))
                        ?: return VerificationResult.Invalid(
                            VerificationResult.Stage.SCHEMA,
                            listOf("issued_at must be an RFC 3339 timestamp"),
                        )
                    val certificateResult = GovernmentDeviceCertificate.verify(certificate, trustStore, issuedAt)
                    if (!certificateResult.valid) {
                        return VerificationResult.Invalid(VerificationResult.Stage.TRUST, certificateResult.errors)
                    }
                    val certificateId = certificate.optString("certificate_id")
                    val revokedAt = revokedAtByCertificateId[certificateId]
                    if (revokedAt != null && !issuedAt.isBefore(revokedAt)) {
                        return VerificationResult.Invalid(
                            VerificationResult.Stage.TRUST,
                            listOf("government device certificate was revoked before or at event issue time"),
                        )
                    }
                    certificateResult.signerPublicKey
                        ?: return VerificationResult.Invalid(
                            VerificationResult.Stage.TRUST,
                            listOf("certificate signer key is unavailable"),
                        )
                }
                else -> return VerificationResult.Invalid(
                    VerificationResult.Stage.TRUST,
                    listOf("device keys may only sign crowd.* or certified official.announcement events"),
                )
            }
        } else {
            trustStore.publicKeyFor(signingKeyId)
                ?: return VerificationResult.Invalid(VerificationResult.Stage.TRUST, listOf("signing_key_id is not trusted"))
        }

        val expectedHash = Canonical.sha256Canonical(eventPayload(event))
        if (expectedHash != event.getString("payload_hash")) {
            return VerificationResult.Invalid(VerificationResult.Stage.INTEGRITY, listOf("payload_hash_mismatch"))
        }

        val canonicalSignatureInput = Canonical.canonicalize(eventSignatureInput(event))
        val signatureValid = Ed25519Verifier.verify(canonicalSignatureInput, event.getString("signature"), publicKey)
        if (!signatureValid) {
            return VerificationResult.Invalid(VerificationResult.Stage.SIGNATURE, listOf("signature_invalid"))
        }

        val expiresAt = EventShapeValidator.parseTimeOrNull(event.getString("expires_at"))
            ?: return VerificationResult.Invalid(VerificationResult.Stage.SCHEMA, listOf("expires_at must be an RFC 3339 timestamp"))
        val expired = !now.isBefore(expiresAt)
        return VerificationResult.Valid(expired)
    }
}
