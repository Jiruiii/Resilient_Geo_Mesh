package com.resilientgeo.mesh.report

import com.resilientgeo.mesh.trust.Canonical
import com.resilientgeo.mesh.trust.CrowdFixtures
import com.resilientgeo.mesh.trust.CrowdLocationHint
import com.resilientgeo.mesh.trust.EventVerifier
import com.resilientgeo.mesh.trust.TrustedKeyStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.util.UUID

class CrowdReportFactoryTest {
    private val key = CrowdFixtures.deviceKey("crowd-fixture-device-a")
    private val issued = Instant.parse("2026-09-24T00:30:00Z")

    private fun input(
        category: String = "ROAD_BLOCKAGE",
        description: String = "成功路二段落石，單線通行",
        lon: Double = 121.590304,
        lat: Double = 25.083506,
        source: String = "MAP_PICK",
        hint: CrowdLocationHint? =
            CrowdLocationHint("ADDRESS", "內湖區成功路", "成功路", "ROAD", "ROAD"),
    ) = CrowdReportInput(category, description, lon, lat, source, hint)

    @Test
    fun `rebuilds the JS fixture report byte for byte`() {
        val event = CrowdReportFactory.create(input(), key, issued, UUID.fromString("00000000-0000-4000-8000-000000000001"))
        val expected = CrowdFixtures.eventCase("valid_report").getJSONObject("event")
        assertEquals(Canonical.canonicalize(expected), Canonical.canonicalize(event))
    }

    @Test
    fun `created report passes EventVerifier with the contract fields`() {
        val event = CrowdReportFactory.create(input(), key, issued)
        assertTrue(EventVerifier.verify(event, TrustedKeyStore(emptyMap()), issued).isValid)
        assertEquals("crowd.reports", event.getString("namespace"))
        assertTrue(event.getString("event_id").matches(Regex("^report:${key.keyId().takeLast(8)}:[0-9a-f-]{36}$")))
        assertEquals("2026-09-24T06:30:00Z", event.getString("expires_at"))
        assertEquals("local_report", event.getJSONObject("provenance").getJSONObject("transport_source").getString("kind"))
        assertEquals(key.publicKeySpkiBase64(), event.getString("signer_public_key"))
    }

    @Test
    fun `issued_at is truncated to whole seconds`() {
        val event = CrowdReportFactory.create(input(), key, Instant.parse("2026-09-24T00:30:00.987Z"))
        assertEquals("2026-09-24T00:30:00Z", event.getString("issued_at"))
    }

    @Test
    fun `validation rejects what the Flutter form would never send`() {
        assertTrue(CrowdReportFactory.validate(input()).isEmpty())
        assertTrue(CrowdReportFactory.validate(input(hint = null, description = "")).isEmpty())
        assertFalse(CrowdReportFactory.validate(input(category = "ROAD_BLOCKED")).isEmpty())
        assertFalse(CrowdReportFactory.validate(input(source = "GPS")).isEmpty())
        assertFalse(CrowdReportFactory.validate(input(lon = 139.69, lat = 35.68)).isEmpty())
        assertFalse(CrowdReportFactory.validate(input(lon = Double.NaN)).isEmpty())
        assertFalse(
            CrowdReportFactory.validate(
                input(hint = CrowdLocationHint("ADDRESS", "x", "x", "STREET", "ROAD")),
            ).isEmpty(),
        )
    }

    @Test
    fun `description limit counts code points after trimming`() {
        val limit = "字".repeat(160)
        assertTrue(CrowdReportFactory.validate(input(description = "  $limit  ")).isEmpty())
        assertFalse(CrowdReportFactory.validate(input(description = limit + "字")).isEmpty())
        // 160 astral-plane characters are 320 UTF-16 units but still 160 characters.
        assertTrue(CrowdReportFactory.validate(input(description = "🌊".repeat(160))).isEmpty())
    }

    @Test(expected = IllegalArgumentException::class)
    fun `create refuses invalid input instead of signing it`() {
        CrowdReportFactory.create(input(category = "NOPE"), key, issued)
    }
}
