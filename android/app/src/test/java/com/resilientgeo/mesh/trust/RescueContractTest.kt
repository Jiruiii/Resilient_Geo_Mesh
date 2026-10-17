package com.resilientgeo.mesh.trust

import com.resilientgeo.mesh.ingest.EventIngestor
import com.resilientgeo.mesh.ingest.InMemoryEventStore
import com.resilientgeo.mesh.ingest.IngestResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RescueContractTest {
    private val trust = TrustedKeyStore(emptyMap())

    private fun triage(
        immobile: String = "NO",
        breathing: String = "NO",
        bleeding: String = "NO",
        conscious: String = "YES",
    ) = mapOf("immobile" to immobile, "breathing_difficulty" to breathing, "severe_bleeding" to bleeding, "conscious" to conscious)

    private fun input(
        requestType: String = "TRAPPED",
        subject: String = "OTHERS",
        peopleCount: Int = 2,
        triage: Map<String, String> = triage(),
        description: String = "一樓樓梯間",
        lon: Double = 121.588123,
        lat: Double = 25.069876,
        source: String = "CURRENT_LOCATION",
        hint: CrowdLocationHint? = null,
    ) = RescueRequestInput(requestType, subject, peopleCount, triage, description, lon, lat, source, hint)

    @Test
    fun `urgency follows the approved table and ignores people count`() {
        assertEquals("CRITICAL", RescueContract.deriveUrgency("TRAPPED_DEBRIS", triage()))
        assertEquals("CRITICAL", RescueContract.deriveUrgency("FIRST_AID_NEEDED", triage(breathing = "YES")))
        assertEquals("CRITICAL", RescueContract.deriveUrgency("FIRST_AID_NEEDED", triage(bleeding = "YES")))
        assertEquals("CRITICAL", RescueContract.deriveUrgency("OTHER_RESCUE", triage(conscious = "NO")))
        assertEquals("HIGH", RescueContract.deriveUrgency("TRAPPED", triage()))
        assertEquals("HIGH", RescueContract.deriveUrgency("IMMOBILE", triage()))
        assertEquals("HIGH", RescueContract.deriveUrgency("FIRST_AID_NEEDED", triage(immobile = "YES")))
        assertEquals("MEDIUM", RescueContract.deriveUrgency("FIRST_AID_NEEDED", triage()))
        assertEquals("MEDIUM", RescueContract.deriveUrgency("OTHER_RESCUE", triage(conscious = "UNKNOWN", breathing = "UNKNOWN")))
    }

    @Test
    fun `field validation reports the same first code as JS`() {
        assertEquals(emptyList<String>(), RescueContract.fieldErrors(input()))
        assertEquals(listOf("rescue_field_invalid:request_type"), RescueContract.fieldErrors(input(requestType = "TRAPPED_INJURED")))
        assertEquals(listOf("rescue_field_invalid:subject"), RescueContract.fieldErrors(input(subject = "ME")))
        assertEquals(listOf("rescue_field_invalid:people_count"), RescueContract.fieldErrors(input(peopleCount = 0)))
        assertEquals(listOf("rescue_field_invalid:people_count"), RescueContract.fieldErrors(input(peopleCount = 51)))
        assertEquals(listOf("rescue_field_invalid:triage"), RescueContract.fieldErrors(input(triage = triage(immobile = "MAYBE"))))
        assertEquals(listOf("rescue_field_invalid:triage"), RescueContract.fieldErrors(input(subject = "SELF", triage = triage(conscious = "NO"))))
        assertEquals(listOf("rescue_field_invalid:description"), RescueContract.fieldErrors(input(description = "字".repeat(161))))
        assertEquals(emptyList<String>(), RescueContract.fieldErrors(input(description = "  ${"字".repeat(160)}  ")))
        assertEquals(listOf("rescue_geometry_invalid"), RescueContract.fieldErrors(input(lon = 139.69, lat = 35.68)))
        assertEquals(listOf("rescue_field_invalid:location_source"), RescueContract.fieldErrors(input(source = "GPS")))
        assertEquals(
            listOf("rescue_field_invalid:location_hint"),
            RescueContract.fieldErrors(input(hint = CrowdLocationHint("ADDRESS", "x", "x", "STREET", "ROAD"))),
        )
    }

    @Test
    fun `every fixture event case verifies the same way as JS`() {
        for (case in RescueFixtures.cases("event_cases")) {
            val name = case.getString("name")
            val expect = case.getJSONObject("expect")
            val result = EventVerifier.verify(case.getJSONObject("event"), trust, RescueFixtures.now)
            assertEquals(name, expect.getBoolean("valid"), result.isValid)
            if (!expect.getBoolean("valid")) {
                result as VerificationResult.Invalid
                assertEquals(name, expect.getString("stage").uppercase(), result.stage.name)
                if (expect.has("error")) assertEquals(name, expect.getString("error"), result.errors.first())
            }
        }
    }

    @Test
    fun `every fixture transition case ingests the same way as JS`() {
        for (case in RescueFixtures.cases("transition_cases")) {
            val name = case.getString("name")
            val store = InMemoryEventStore()
            val first = EventIngestor.ingest(store, case.getJSONObject("stored"), trust, RescueFixtures.now)
            assertTrue(name, first is IngestResult.Inserted)
            val result = EventIngestor.ingest(store, case.getJSONObject("incoming"), trust, RescueFixtures.now)
            val expect = case.getJSONObject("expect")
            when (expect.getString("result")) {
                "updated" -> assertTrue("$name: $result", result is IngestResult.Updated)
                "rejected" -> {
                    val reason = when (result) {
                        is IngestResult.RejectedVersionRollback -> "version_rollback"
                        is IngestResult.RejectedSameVersionConflict -> "same_version_conflict"
                        is IngestResult.RejectedTransition -> result.reason
                        else -> "not rejected: $result"
                    }
                    assertEquals(name, expect.getString("reason"), reason)
                }
            }
        }
    }
}
