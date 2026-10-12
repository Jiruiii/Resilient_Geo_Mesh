package com.resilientgeo.mesh.report

import com.resilientgeo.mesh.protocol.ChunkVerifier
import com.resilientgeo.mesh.trust.Canonical
import com.resilientgeo.mesh.trust.CrowdLocationHint
import com.resilientgeo.mesh.trust.EventVerifier
import com.resilientgeo.mesh.trust.RescueFixtures
import com.resilientgeo.mesh.trust.RescueRequestInput
import com.resilientgeo.mesh.trust.TrustedKeyStore
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.util.UUID

class RescueRequestFactoryTest {
    private val key = RescueFixtures.deviceKey()
    private val trust = TrustedKeyStore(emptyMap())

    private fun fixtureInput(): RescueRequestInput {
        val create = RescueFixtures.root.getJSONObject("inputs").getJSONObject("create")
        val triage = create.getJSONObject("triage")
        val hint = create.getJSONObject("locationHint")
        return RescueRequestInput(
            requestType = create.getString("requestType"),
            subject = create.getString("subject"),
            peopleCount = create.getInt("peopleCount"),
            triage = triage.keys().asSequence().associateWith { triage.getString(it) },
            description = create.getString("description"),
            lon = create.getDouble("lon"),
            lat = create.getDouble("lat"),
            locationSource = create.getString("locationSource"),
            locationHint = CrowdLocationHint(
                hint.getString("method"), hint.getString("query"), hint.getString("label"),
                hint.getString("kind"), hint.getString("precision"),
            ),
        )
    }

    private fun createV1(): JSONObject {
        val create = RescueFixtures.root.getJSONObject("inputs").getJSONObject("create")
        return RescueRequestFactory.create(
            fixtureInput(), key, Instant.parse(create.getString("issuedAt")), UUID.fromString(create.getString("requestUuid")),
        )
    }

    @Test
    fun `rebuilds the JS fixture timeline byte for byte`() {
        var latest = createV1()
        assertEquals(Canonical.canonicalize(RescueFixtures.eventCase("valid_v1")), Canonical.canonicalize(latest))
        val revisions = RescueFixtures.root.getJSONObject("inputs").getJSONArray("revisions")
        val names = listOf("valid_v2_update", "valid_v3_extend", "valid_v4_resolved")
        for (index in 0 until revisions.length()) {
            val revision = revisions.getJSONObject(index)
            val action = RescueAction.valueOf(revision.getString("action"))
            val changes = revision.getJSONObject("changes")
            val input = if (action == RescueAction.UPDATE) {
                RescueRequestFactory.inputFromEvent(latest).copy(
                    peopleCount = changes.getInt("peopleCount"),
                    description = changes.getString("description"),
                )
            } else {
                null
            }
            latest = RescueRequestFactory.revise(latest, action, input, key, Instant.parse(revision.getString("issuedAt")))
            assertEquals(names[index], Canonical.canonicalize(RescueFixtures.eventCase(names[index])), Canonical.canonicalize(latest))
        }
    }

    @Test
    fun `created requests pass the verifier`() {
        assertTrue(EventVerifier.verify(createV1(), trust, RescueFixtures.now).isValid)
    }

    @Test
    fun `revision rules match JS`() {
        val v1 = createV1()
        val other = RescueFixtures.otherKey()
        assertEquals(
            "rescue_revision_wrong_device",
            assertThrows(IllegalArgumentException::class.java) {
                RescueRequestFactory.revise(v1, RescueAction.RESOLVE, null, other, Instant.parse("2026-10-12T05:00:00Z"))
            }.message,
        )
        assertEquals(
            "rescue_revision_expired",
            assertThrows(IllegalArgumentException::class.java) {
                RescueRequestFactory.revise(v1, RescueAction.UPDATE, fixtureInput(), key, Instant.parse("2026-10-12T09:00:00Z"))
            }.message,
        )
        val resolved = RescueRequestFactory.revise(v1, RescueAction.RESOLVE, null, key, Instant.parse("2026-10-12T05:00:00Z"))
        assertEquals(v1.getString("expires_at"), resolved.getString("expires_at"))
        assertEquals(
            "rescue_revision_terminal",
            assertThrows(IllegalArgumentException::class.java) {
                RescueRequestFactory.revise(resolved, RescueAction.UPDATE, fixtureInput(), key, Instant.parse("2026-10-12T05:10:00Z"))
            }.message,
        )
    }

    @Test
    fun `every fixture chunk case verifies the same way as JS`() {
        for (case in RescueFixtures.cases("chunk_cases")) {
            val name = case.getString("name")
            val expect = case.getJSONObject("expect")
            val result = ChunkVerifier.verify(case.getJSONObject("chunk"), trust, RescueFixtures.now)
            if (expect.getBoolean("valid")) {
                assertTrue("$name: $result", result is ChunkVerifier.Result.Valid)
            } else {
                assertEquals(name, expect.getString("error"), (result as ChunkVerifier.Result.Invalid).reason)
            }
        }
    }

    @Test
    fun `rescue chunks are built under their own dataset`() {
        val v1 = createV1()
        val chunk = CrowdChunkCodec.build(v1, key)
        assertEquals(Canonical.canonicalize(RescueFixtures.cases("chunk_cases").first().getJSONObject("chunk")), Canonical.canonicalize(chunk))
        assertEquals("crowd-rescue", chunk.getString("dataset_id"))
        assertEquals(v1.getString("event_id"), CrowdChunkCodec.eventIdFor(chunk.getString("chunk_id")))
    }
}
