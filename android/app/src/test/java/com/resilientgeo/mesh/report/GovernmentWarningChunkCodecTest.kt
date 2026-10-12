package com.resilientgeo.mesh.report

import com.resilientgeo.mesh.protocol.ChunkVerifier
import com.resilientgeo.mesh.trust.Canonical
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class GovernmentWarningChunkCodecTest {
    private val keys = governmentWarningTestKeys()
    private val issuedAt = Instant.parse("2026-10-12T00:00:00Z")

    private fun event(id: String = "announcement:device:chunk-1", content: String = "請留意官方資訊") =
        GovernmentWarningFactory.create(
            GovernmentWarningInput("颱風警戒", content, "WEATHER", "HIGH", issuedAt.plusSeconds(86400)),
            keys.device,
            keys.certificate,
            issuedAt,
            id,
        )

    @Test
    fun `builds a signed one event chunk that verifies through ChunkVerifier`() {
        val event = event()
        val chunk = GovernmentWarningChunkCodec.build(event, keys.device)
        val result = ChunkVerifier.verify(chunk, keys.trustStore, issuedAt)
        assertTrue("$result", result is ChunkVerifier.Result.Valid)
        assertEquals("government-device-announcements", chunk.getString("dataset_id"))
        assertEquals(event.getString("payload_hash"), chunk.getString("manifest_hash"))
        assertEquals(event.getString("event_id"), (result as ChunkVerifier.Result.Valid).events.single().getString("event_id"))
    }

    @Test
    fun `rejects tampered event data and invalid chunk signature`() {
        val tampered = GovernmentWarningChunkCodec.build(event(), keys.device)
        tampered.getJSONArray("events").getJSONObject(0).getJSONObject("attributes").put("content", "遭到竄改")
        assertTrue(ChunkVerifier.verify(tampered, keys.trustStore, issuedAt) is ChunkVerifier.Result.Invalid)

        val badSignature = GovernmentWarningChunkCodec.build(event(), keys.device).put("signature", "AAAA")
        val result = ChunkVerifier.verify(badSignature, keys.trustStore, issuedAt)
        assertEquals("chunk_signature_invalid", (result as ChunkVerifier.Result.Invalid).reason)
    }

    @Test
    fun `duplicate event ids are idempotent only for the same signed payload`() {
        val original = event()
        val identical = event()
        val changed = event(content = "同一事件識別碼不可換成不同內容")
        assertEquals(GovernmentWarningChunkCodec.ReplayDecision.IDENTICAL,
            GovernmentWarningChunkCodec.classifyReplay(original, identical))
        assertEquals(GovernmentWarningChunkCodec.ReplayDecision.CONFLICT,
            GovernmentWarningChunkCodec.classifyReplay(original, changed))
        assertEquals(Canonical.canonicalize(original), Canonical.canonicalize(identical))
    }
}
