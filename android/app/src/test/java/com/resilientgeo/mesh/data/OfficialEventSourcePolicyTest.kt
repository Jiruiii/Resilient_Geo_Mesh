package com.resilientgeo.mesh.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OfficialEventSourcePolicyTest {

    @Test
    fun `keeps all CWA feed namespaces and direct CWA namespace`() {
        val cwaNamespaces = listOf(
            "official.cwa",
            "official.live.cwa-earthquake",
            "official.live.cwa-warning",
            "official.live.cwa-typhoon",
        )

        cwaNamespaces.forEach { namespace ->
            assertTrue(namespace, supportsOfficialEvent(namespace, "CWA"))
            assertTrue(namespace, supportsOfficialNamespace(namespace))
        }
    }

    @Test
    fun `supports NCDR and all three CWA government feed datasets`() {
        listOf("ncdr", "cwa-earthquake", "cwa-warning", "cwa-typhoon", "government-announcements", "government-attestations")
            .forEach { assertTrue(it, supportsOfficialFeedDataset(it)) }
        assertFalse(supportsOfficialFeedDataset("tdx-road"))
        assertEquals("official.announcement", officialFeedNamespace("government-announcements"))
        assertEquals("official.verified", officialFeedNamespace("government-attestations"))
    }

    @Test
    fun `supports signed government announcements and verification events only from their source`() {
        assertTrue(supportsOfficialNamespace("official.announcement"))
        assertTrue(supportsOfficialEvent("official.announcement", "GOVERNMENT"))
        assertTrue(supportsOfficialNamespace("official.verified"))
        assertTrue(supportsOfficialEvent("official.verified", "GOV_ATTEST"))
        assertFalse(supportsOfficialEvent("official.announcement", "CROWD"))
        assertFalse(supportsOfficialEvent("official.verified", "CROWD"))
    }

    @Test
    fun `keeps NCDR and rejects unsupported or mismatched official sources`() {
        assertTrue(supportsOfficialEvent("official.live.ncdr", "NCDR"))
        assertFalse(supportsOfficialEvent("official.live.cwa-warning", "NCDR"))
        assertFalse(supportsOfficialEvent("official.live.ncdr", "CWA"))
        assertFalse(supportsOfficialEvent("official.live.tdx-road", "NCDR"))
        assertFalse(supportsOfficialNamespace("official.live.tdx-road"))
    }
}
