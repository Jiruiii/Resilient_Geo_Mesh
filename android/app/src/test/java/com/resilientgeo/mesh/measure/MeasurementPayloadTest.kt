package com.resilientgeo.mesh.measure

import com.resilientgeo.mesh.protocol.ChunkVerifier
import com.resilientgeo.mesh.trust.EventVerifier
import com.resilientgeo.mesh.trust.TrustedKeyStore
import com.resilientgeo.mesh.trust.VerificationResult
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.Instant

class MeasurementPayloadTest {
    private val assets = File("src/main/assets")
    private val manifest = JSONObject(File(assets, "${MeasurementPayload.ASSET_DIR}/manifest.json").readText())

    @Test fun `tiers select the same smallest-first chunks on every build`() {
        val counts = MeasurementPayload.entries.associateWith { it.chunkIds(manifest).size }
        assertEquals(mapOf(MeasurementPayload.ONE to 1, MeasurementPayload.KB50 to 20, MeasurementPayload.MB1 to 157,
            MeasurementPayload.MB10 to 168, MeasurementPayload.ALL to 203), counts)
        val all = MeasurementPayload.ALL.chunkIds(manifest)
        assertTrue(all.all { File(assets, MeasurementPayload.assetPath(it)).isFile })
        // Each tier extends the smaller one, so results are comparable across tiers.
        assertEquals(MeasurementPayload.KB50.chunkIds(manifest), all.take(20))
        assertTrue(MeasurementPayload.MB1.bleAllowed)
        assertFalse(MeasurementPayload.MB10.bleAllowed)
    }

    @Test fun `re-signed chunks pass the real verifiers only under the measurement key`() {
        val signer = MeasurementSigner.shared()
        val measurementTrust = TrustedKeyStore.fromJson(signer.trustedKeysJson)
        val productionTrust = TrustedKeyStore.fromJson(File(assets, "trust/trusted-keys.json").readText())
        val now = Instant.parse("2026-10-30T08:00:00Z")
        val ids = MeasurementPayload.KB50.chunkIds(manifest) + MeasurementPayload.ALL.chunkIds(manifest).last()
        val chunkIds = mutableSetOf<String>()
        for (id in ids) {
            val source = JSONObject(File(assets, MeasurementPayload.assetPath(id)).readText())
            val compactBytes = source.toString().length
            val chunk = signer.resign(source, now)
            assertTrue(chunkIds.add(chunk.getString("chunk_id")))
            assertEquals(MeasurementSigner.DATASET_ID, chunk.getString("dataset_id"))
            // Re-signing keeps the payload realistic: within 2% of the bundled compact size.
            assertEquals(compactBytes.toDouble(), chunk.toString().length.toDouble(), compactBytes * 0.02)
            val verified = ChunkVerifier.verify(chunk, measurementTrust, now)
            assertTrue("$id: $verified", verified is ChunkVerifier.Result.Valid)
            for (event in (verified as ChunkVerifier.Result.Valid).events) {
                assertEquals(MeasurementSigner.NAMESPACE, event.getString("namespace"))
                assertEquals(VerificationResult.Valid(expired = false), EventVerifier.verify(event, measurementTrust, now))
            }
            assertFalse(ChunkVerifier.verify(chunk, productionTrust, now) is ChunkVerifier.Result.Valid)
        }
    }
}
