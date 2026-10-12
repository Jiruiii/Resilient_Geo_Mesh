package com.resilientgeo.mesh.trust

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.bouncycastle.util.encoders.Base64
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import java.time.Instant

class GovernmentDeviceCertificateTest {

    private fun sharedFixture(): JSONObject {
        val filename = "pipeline/fixtures/government-device-warning.json"
        val fixtureFile = generateSequence(File(System.getProperty("user.dir") ?: ".")) { it.parentFile }
            .map { File(it, filename) }
            .firstOrNull { it.isFile }
            ?: error("Shared government device fixture not found from ${System.getProperty("user.dir")}")
        return JSONObject(fixtureFile.readText())
    }

    private data class SigningKey(
        val privateKey: Ed25519PrivateKeyParameters,
        val publicKeyBase64: String,
        val keyId: String,
    )

    private fun key(): SigningKey {
        val privateKey = Ed25519PrivateKeyParameters(SecureRandom())
        val spki = "302a300506032b6570032100".chunked(2).map { it.toInt(16).toByte() }.toByteArray() + privateKey.generatePublicKey().encoded
        val encoded = Base64.toBase64String(spki)
        return SigningKey(privateKey, encoded, DeviceKeys.keyIdFromSpkiBase64(encoded))
    }

    private fun sign(value: JSONObject, privateKey: Ed25519PrivateKeyParameters): String {
        val message = Canonical.canonicalize(value).toByteArray(StandardCharsets.UTF_8)
        val signer = Ed25519Signer()
        signer.init(true, privateKey)
        signer.update(message, 0, message.size)
        return Base64.toBase64String(signer.generateSignature())
    }

    private fun warning(
        issuer: SigningKey,
        device: SigningKey,
        certificateExpiresAt: String = "2026-10-08T12:00:00Z",
        eventIssuedAt: String = "2026-10-02T12:00:00Z",
        includeCertificate: Boolean = true,
        permission: String = "official.announcement.publish",
    ): JSONObject {
        val unsignedCertificate = JSONObject()
            .put("schema_version", "government-device-certificate-v1")
            .put("certificate_id", "gov-cert:11111111-1111-4111-8111-111111111111")
            .put("device_id", "gov-device:22222222-2222-4222-8222-222222222222")
            .put("subject_id", "33333333-3333-4333-8333-333333333333")
            .put("signing_key_id", device.keyId)
            .put("signer_public_key", device.publicKeyBase64)
            .put("agency", "測試機關")
            .put("permissions", org.json.JSONArray().put(permission))
            .put("issued_at", "2026-10-01T12:00:00Z")
            .put("expires_at", certificateExpiresAt)
            .put("issuer_key_id", "government-test-2026")
            .put("signature_algorithm", "Ed25519")
        val certificate = JSONObject(unsignedCertificate.toString())
            .put("signature", sign(unsignedCertificate, issuer.privateKey))

        val attributes = JSONObject()
            .put("area_id", "tw.national")
            .put("title", "測試警告")
            .put("content", "內容完整性測試")
        if (includeCertificate) attributes.put("government_device_certificate", certificate)

        val event = JSONObject()
            .put("schema_version", "event-v0")
            .put("namespace", "official.announcement")
            .put("event_id", "announcement:device:11111111-1111-4111-8111-111111111111")
            .put("event_type", "GOVERNMENT_ANNOUNCEMENT")
            .put("geometry", JSONObject().put("type", "GeometryCollection").put("geometries", org.json.JSONArray()))
            .put("severity", "HIGH")
            .put("source", "GOVERNMENT")
            .put("source_version", "device-test")
            .put("event_version", 1)
            .put("issued_at", eventIssuedAt)
            .put("expires_at", "2026-11-01T12:00:00Z")
            .put("attributes", attributes)
            .put("signing_key_id", device.keyId)
            .put("signer_public_key", device.publicKeyBase64)
            .put("provenance", JSONObject()
                .put("original_source", "government-device")
                .put("received_at", eventIssuedAt)
                .put("transport_source", JSONObject().put("kind", "android_mesh")))

        event.put("payload_hash", Canonical.sha256Canonical(EventVerifier.eventPayload(event)))
        event.put("signature_algorithm", "Ed25519")
        event.put("signature", sign(EventVerifier.eventSignatureInput(event), device.privateKey))
        return event
    }

    private fun verifier(issuer: SigningKey) = TrustedKeyStore(mapOf("government-test-2026" to issuer.publicKeyBase64))

    @Test
    fun `accepts the shared Node Web and Android warning fixture and applies its revocation time`() {
        val fixture = sharedFixture()
        val event = fixture.getJSONObject("event")
        val certificate = fixture.getJSONObject("certificate")
        val issuerKeyId = fixture.getString("issuer_key_id")
        val trustStore = TrustedKeyStore(mapOf(
            issuerKeyId to fixture.getString("issuer_public_key_spki_base64"),
        ))
        val receivedAt = Instant.parse(fixture.getString("now"))

        val valid = EventVerifier.verify(event, trustStore, receivedAt)
        val revokedAt = Instant.parse(
            fixture.getJSONObject("revocation_event").getJSONObject("attributes")
                .getString("revoked_at"),
        )
        val validBeforeRevocation = EventVerifier.verify(
            event,
            trustStore,
            receivedAt,
            mapOf(certificate.getString("certificate_id") to revokedAt),
        )
        val issuedAfterRevocation = JSONObject(event.toString())
            .put("issued_at", revokedAt.toString())
        val revoked = EventVerifier.verify(
            issuedAfterRevocation,
            trustStore,
            receivedAt,
            mapOf(certificate.getString("certificate_id") to revokedAt),
        )

        assertTrue("$valid", valid is VerificationResult.Valid)
        assertTrue("$validBeforeRevocation", validBeforeRevocation is VerificationResult.Valid)
        assertTrue("$revoked", revoked is VerificationResult.Invalid)
    }

    @Test
    fun `accepts a warning signed during certificate validity after certificate expiry`() {
        val issuer = key()
        val device = key()
        val result = EventVerifier.verify(
            warning(issuer, device),
            verifier(issuer),
            Instant.parse("2026-10-09T12:00:00Z"),
        )

        assertTrue("${result}", result is VerificationResult.Valid)
        assertFalse((result as VerificationResult.Valid).expired)
    }

    @Test
    fun `rejects a warning issued at or after a cached certificate revocation`() {
        val issuer = key()
        val device = key()
        val event = warning(issuer, device)
        val certificateId = event.getJSONObject("attributes")
            .getJSONObject("government_device_certificate").getString("certificate_id")
        val issuedAt = Instant.parse(event.getString("issued_at"))
        val beforeRevocation = EventVerifier.verify(
            event, verifier(issuer), Instant.parse("2026-10-03T00:00:00Z"),
            mapOf(certificateId to issuedAt.plusSeconds(1)),
        )
        val atRevocation = EventVerifier.verify(
            event, verifier(issuer), Instant.parse("2026-10-03T00:00:00Z"),
            mapOf(certificateId to issuedAt),
        )
        assertTrue("$beforeRevocation", beforeRevocation is VerificationResult.Valid)
        assertTrue(atRevocation is VerificationResult.Invalid)
    }

    @Test
    fun `rejects an uncertified device key for an official announcement`() {
        val issuer = key()
        val device = key()
        val result = EventVerifier.verify(warning(issuer, device, includeCertificate = false), verifier(issuer))

        assertTrue(result is VerificationResult.Invalid)
        assertEquals(VerificationResult.Stage.TRUST, (result as VerificationResult.Invalid).stage)
    }

    @Test
    fun `rejects a certificate that expired before warning issue time`() {
        val issuer = key()
        val device = key()
        val result = EventVerifier.verify(
            warning(issuer, device, eventIssuedAt = "2026-10-09T12:00:00Z"),
            verifier(issuer),
            Instant.parse("2026-10-10T12:00:00Z"),
        )

        assertTrue(result is VerificationResult.Invalid)
        assertEquals(VerificationResult.Stage.TRUST, (result as VerificationResult.Invalid).stage)
    }

    @Test
    fun `rejects a warning whose signing key does not match its certificate`() {
        val issuer = key()
        val device = key()
        val otherDevice = key()
        val event = warning(issuer, device)
        event.put("signing_key_id", otherDevice.keyId)
        event.put("signer_public_key", otherDevice.publicKeyBase64)
        event.put("payload_hash", Canonical.sha256Canonical(EventVerifier.eventPayload(event)))
        event.put("signature", sign(EventVerifier.eventSignatureInput(event), otherDevice.privateKey))

        val result = EventVerifier.verify(event, verifier(issuer))
        assertTrue(result is VerificationResult.Invalid)
        assertEquals(VerificationResult.Stage.TRUST, (result as VerificationResult.Invalid).stage)
    }
}
