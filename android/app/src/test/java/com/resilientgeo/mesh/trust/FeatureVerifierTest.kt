package com.resilientgeo.mesh.trust

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class FeatureVerifierTest {

    @Test
    fun `rejects an unsigned feature before trust or storage`() {
        val result = FeatureVerifier.verify(
            JSONObject("""{"schema_version":"feature-v0"}"""),
            TrustedKeyStore(emptyMap()),
        )

        assertEquals(FeatureVerificationResult.Stage.SCHEMA, result.stage)
        assertEquals(false, result.valid)
    }

    @Test
    fun `accepts only geometry-less medical search entries at schema validation`() {
        val directory = JSONObject(
            """{"schema_version":"feature-v0","namespace":"official.medical","dataset_id":"resilientgeo-taiwan-medical-directory","layer_id":"taiwan-medical-directory","feature_id":"medical-directory:h001","feature_type":"MEDICAL_DIRECTORY_ENTRY","geometry":null,"properties":{"name":"未定位診所","geometry_status":"unresolved","point_feature_id":null},"source":"mohw-medical-master","source_version":"snapshot","issued_at":"2026-10-04T00:00:00Z","expires_at":"2026-11-03T00:00:00Z","signature_algorithm":"Ed25519","signing_key_id":"server-medical-source","provenance":{"original_source":"https://data.gov.tw/dataset/15393","received_at":"2026-10-04T00:00:00Z","transport_source":{"kind":"server"}},"payload_hash":"sha256:${"a".repeat(64)}","signature":"AAAA"}""",
        )
        val result = FeatureVerifier.verify(directory, TrustedKeyStore(emptyMap()))
        assertEquals(FeatureVerificationResult.Stage.TRUST, result.stage)
        assertEquals(false, result.valid)

        val invalidPoint = JSONObject(directory.toString())
            .put("layer_id", "medical")
            .put("feature_type", "HOSPITAL")
        val invalidResult = FeatureVerifier.verify(invalidPoint, TrustedKeyStore(emptyMap()))
        assertEquals(FeatureVerificationResult.Stage.SCHEMA, invalidResult.stage)
        assertEquals(true, invalidResult.errors.any { it.contains("geometry") })
    }
}
