package com.resilientgeo.mesh.report

import com.resilientgeo.mesh.trust.EventVerifier
import com.resilientgeo.mesh.trust.VerificationResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class GovernmentWarningFactoryTest {
    private val keys = governmentWarningTestKeys()
    private val issuedAt = Instant.parse("2026-10-12T00:00:00Z")

    private fun input(
        title: String = "颱風警戒",
        content: String = "請留意官方資訊",
        category: String = "WEATHER",
        severity: String = "HIGH",
        expiresAt: Instant = issuedAt.plusSeconds(24 * 60 * 60),
        affectedAreaIds: List<String> = listOf("tw.63000050"),
        location: GovernmentWarningInput.Location? = null,
    ) = GovernmentWarningInput(title, content, category, severity, expiresAt, affectedAreaIds, location)

    @Test
    fun `creates a device signed nationwide announcement accepted by EventVerifier`() {
        val event = GovernmentWarningFactory.create(input(), keys.device, keys.certificate, issuedAt, "announcement:device:test-1")
        val result = EventVerifier.verify(event, keys.trustStore, issuedAt)
        assertTrue("$result", result is VerificationResult.Valid)
        assertEquals("official.announcement", event.getString("namespace"))
        assertEquals("GOVERNMENT_ANNOUNCEMENT", event.getString("event_type"))
        assertEquals("tw.national", event.getJSONObject("attributes").getString("area_id"))
        assertEquals("tw.63000050", event.getJSONObject("attributes").getJSONArray("affected_area_ids").getString(0))
        assertFalse(event.getJSONObject("attributes").getBoolean("has_map_location"))
        assertEquals(keys.device.keyId(), event.getString("signing_key_id"))
        val changed = org.json.JSONObject(event.toString())
        changed.getJSONObject("attributes").getJSONArray("affected_area_ids").put(0, "tw.65000")
        assertFalse(EventVerifier.verify(changed, keys.trustStore, issuedAt) is VerificationResult.Valid)
    }

    @Test
    fun `optional map location is encoded as a bounded point`() {
        val event = GovernmentWarningFactory.create(
            input(location = GovernmentWarningInput.Location(121.50123456, 25.01234567)),
            keys.device,
            keys.certificate,
            issuedAt,
            "announcement:device:test-location",
        )
        assertEquals("Point", event.getJSONObject("geometry").getString("type"))
        assertEquals(121.501235, event.getJSONObject("geometry").getJSONArray("coordinates").getDouble(0), 0.0000001)
        assertTrue(event.getJSONObject("attributes").getBoolean("has_map_location"))
    }

    @Test
    fun `supply station warning accepts its category and requires a map point`() {
        val locatedStation = input(
            title = "三重物資站",
            content = "提供飲水與乾糧",
            category = "SUPPLY_STATION",
            severity = "LOW",
            location = GovernmentWarningInput.Location(121.48, 25.06),
        )
        assertTrue(GovernmentWarningFactory.validate(locatedStation, issuedAt).isEmpty())
        assertFalse(
            GovernmentWarningFactory.validate(
                locatedStation.copy(location = null),
                issuedAt,
            ).isEmpty(),
        )

        val event = GovernmentWarningFactory.create(
            locatedStation,
            keys.device,
            keys.certificate,
            issuedAt,
            "announcement:device:supply-station",
        )
        assertEquals("SUPPLY_STATION", event.getJSONObject("attributes").getString("category"))
        assertEquals("Point", event.getJSONObject("geometry").getString("type"))
    }

    @Test
    fun `road and shelter warnings require a map point`() {
        for (category in listOf("ROAD", "SHELTER")) {
            assertFalse(
                GovernmentWarningFactory.validate(input(category = category), issuedAt).isEmpty(),
            )
            assertTrue(
                GovernmentWarningFactory.validate(
                    input(
                        category = category,
                        location = GovernmentWarningInput.Location(121.48, 25.06),
                    ),
                    issuedAt,
                ).isEmpty(),
            )
        }
    }

    @Test
    fun `rejects expiry beyond ninety days and out of bounds locations`() {
        assertFalse(GovernmentWarningFactory.validate(
            input(expiresAt = issuedAt.plusSeconds(90 * 24 * 60 * 60L + 1)), issuedAt,
        ).isEmpty())
        assertFalse(GovernmentWarningFactory.validate(
            input(location = GovernmentWarningInput.Location(139.69, 35.68)), issuedAt,
        ).isEmpty())
    }

    @Test
    fun `requires unique canonical affected areas and reserves nationwide for an explicit singleton`() {
        for (ids in listOf(emptyList(), listOf("tw.63000", "tw.63000"), listOf("tw.invalid"),
            listOf("tw.99999"), listOf("tw.national", "tw.63000"))) {
            assertFalse(GovernmentWarningFactory.validate(input(affectedAreaIds = ids), issuedAt).isEmpty())
        }
        assertTrue(GovernmentWarningFactory.validate(input(affectedAreaIds = listOf("tw.national")), issuedAt).isEmpty())
    }

    @Test
    fun `rejects signed warnings with well formed but unknown impact areas`() {
        val event = GovernmentWarningFactory.create(
            input(),
            keys.device,
            keys.certificate,
            issuedAt,
            "announcement:device:unknown-area",
        )
        event.getJSONObject("attributes").getJSONArray("affected_area_ids")
            .put(0, "tw.99999")

        assertFalse(GovernmentWarningFactory.validateEvent(event).isEmpty())
    }

    @Test
    fun `accepts a legacy signed warning that only has the nationwide area id`() {
        val event = GovernmentWarningFactory.create(
            input(),
            keys.device,
            keys.certificate,
            issuedAt,
            "announcement:device:legacy-area",
        )
        event.getJSONObject("attributes").remove("affected_area_ids")

        assertTrue(GovernmentWarningFactory.validateEvent(event).isEmpty())
    }

    @Test(expected = IllegalArgumentException::class)
    fun `does not sign warnings with a certificate for another key`() {
        val other = com.resilientgeo.mesh.trust.DeviceSigningKey.fromSeed(ByteArray(32) { (it + 1).toByte() })
        GovernmentWarningFactory.create(input(), other, keys.certificate, issuedAt, "announcement:device:wrong-key")
    }
}
