package com.resilientgeo.mesh.emergency

import org.junit.Assert.*
import org.junit.Test

class AutomaticTransportPolicyTest {
    @Test fun missingGmsSkipsNearbyAndMissingWifiLeavesBleFallback() {
        val p = AutomaticTransportPolicy()
        assertEquals("wifi_direct", p.select(0, false, true, false, 0))
        assertNull(p.select(1, false, false, false, 0))
        assertEquals("wifi_direct_unavailable", p.reason)
    }

    @Test fun startupFailureFallsBackAndRetriesAfterCooldown() {
        val p = AutomaticTransportPolicy()
        assertEquals("nearby", p.select(0, true, true, false, 0))
        p.outcome(false, "discovery_failed")
        assertEquals("wifi_direct", p.select(1, true, true, false, 0))
        p.outcome(false, "connection_failed")
        assertNull(p.select(2, true, true, false, 0))
        assertNull(p.select(120_000, true, true, false, 0))
        assertEquals("nearby", p.select(120_001, true, true, false, 0))
    }

    @Test fun searchTimeoutDoesNotInterruptAnActiveTransfer() {
        val p = AutomaticTransportPolicy()
        p.select(0, true, true, false, 0)
        assertEquals("nearby", p.select(30_001, true, true, true, 1))
        assertEquals("wifi_direct", p.select(40_000, true, true, false, 0))
        assertEquals("nearby_no_peer", p.reason)
    }

    @Test fun successfulLinkStaysAndAnIdleLostPeerAllowsFallback() {
        val p = AutomaticTransportPolicy()
        p.select(0, true, true, false, 0)
        p.outcome(true, null)
        assertEquals("nearby", p.select(200_000, true, true, false, 1))
        assertEquals("wifi_direct", p.select(200_001, true, true, false, 0))
        p.outcome(true, null)
        assertNull(p.reason)
    }

    @Test fun badSignaturesAreNotTreatedAsTransportFailures() {
        val p = AutomaticTransportPolicy()
        p.select(0, true, true, false, 0)
        p.outcome(false, "transfer_incomplete")
        assertEquals("nearby", p.select(1, true, true, false, 1))
        assertNull(p.reason)
    }
}
