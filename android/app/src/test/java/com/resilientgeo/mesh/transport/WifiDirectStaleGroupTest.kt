package com.resilientgeo.mesh.transport

import org.junit.Assert.*
import org.junit.Test

class WifiDirectStaleGroupTest {
    private val stale = WifiDirectStaleGroup(limitMillis = 20_000)

    @Test fun groupWithoutIpv4IsRemovedOnceAfterTheLimit() {
        assertFalse(stale.observe(0, groupFormed = true, hasIpv4 = false, hasLinks = false))
        assertFalse(stale.observe(19_999, groupFormed = true, hasIpv4 = false, hasLinks = false))
        assertTrue(stale.observe(20_000, groupFormed = true, hasIpv4 = false, hasLinks = false))
        // The removal is asynchronous; the next query may still report the group.
        assertFalse(stale.observe(23_000, groupFormed = true, hasIpv4 = false, hasLinks = false))
        assertTrue(stale.observe(43_000, groupFormed = true, hasIpv4 = false, hasLinks = false))
    }

    @Test fun lateDhcpLeaseKeepsTheGroup() {
        stale.observe(0, groupFormed = true, hasIpv4 = false, hasLinks = false)
        assertFalse(stale.observe(15_000, groupFormed = true, hasIpv4 = true, hasLinks = false))
        // A later loss of the address starts a new wait instead of reusing the old one.
        assertFalse(stale.observe(30_000, groupFormed = true, hasIpv4 = false, hasLinks = false))
        assertFalse(stale.observe(49_999, groupFormed = true, hasIpv4 = false, hasLinks = false))
        assertTrue(stale.observe(50_000, groupFormed = true, hasIpv4 = false, hasLinks = false))
    }

    @Test fun groupCarryingASocketOrNoGroupIsNeverRemoved() {
        assertFalse(stale.observe(0, groupFormed = true, hasIpv4 = false, hasLinks = true))
        assertFalse(stale.observe(60_000, groupFormed = true, hasIpv4 = false, hasLinks = true))
        assertFalse(stale.observe(0, groupFormed = false, hasIpv4 = false, hasLinks = false))
        assertFalse(stale.observe(60_000, groupFormed = false, hasIpv4 = false, hasLinks = false))
    }
}
