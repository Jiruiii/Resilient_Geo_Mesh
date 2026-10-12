package com.resilientgeo.mesh.report

import com.resilientgeo.mesh.trust.DeviceSigningKey
import com.resilientgeo.mesh.trust.TrustedKeyStore
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.time.Instant

internal data class GovernmentWarningTestKeys(
    val issuer: DeviceSigningKey,
    val device: DeviceSigningKey,
    val certificate: JSONObject,
    val trustStore: TrustedKeyStore,
)

internal fun governmentWarningTestKeys(): GovernmentWarningTestKeys {
    fun key(label: String) = DeviceSigningKey.fromSeed(
        MessageDigest.getInstance("SHA-256").digest(label.toByteArray(Charsets.UTF_8)),
    )
    val issuer = key("government-warning-test-issuer")
    val device = key("government-warning-test-device")
    val issued = Instant.parse("2026-10-12T00:00:00Z")
    val unsigned = JSONObject()
        .put("schema_version", "government-device-certificate-v1")
        .put("certificate_id", "gov-cert:warning-test")
        .put("device_id", "gov-device:warning-test")
        .put("subject_id", "government-user:warning-test")
        .put("signing_key_id", device.keyId())
        .put("signer_public_key", device.publicKeySpkiBase64())
        .put("agency", "測試機關")
        .put("permissions", JSONArray().put("official.announcement.publish"))
        .put("issued_at", issued.toString())
        .put("expires_at", issued.plusSeconds(7 * 24 * 60 * 60L).toString())
        .put("issuer_key_id", "government-warning-test-issuer")
        .put("signature_algorithm", "Ed25519")
    val certificate = JSONObject(unsigned.toString())
        .put("signature", issuer.signCanonical(com.resilientgeo.mesh.trust.Canonical.canonicalize(unsigned)))
    return GovernmentWarningTestKeys(
        issuer = issuer,
        device = device,
        certificate = certificate,
        trustStore = TrustedKeyStore(mapOf(issuer.keyId() to issuer.publicKeySpkiBase64(),
            "government-warning-test-issuer" to issuer.publicKeySpkiBase64())),
    )
}
