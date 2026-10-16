package com.resilientgeo.mesh.transport

import org.junit.Assert.*
import org.junit.Test

class WifiDirectConnectionPolicyTest {
    private val low = "wifi:" + "0".repeat(32)
    private val high = "wifi:" + "f".repeat(32)

    @Test fun freshPeersElectExactlyOneInitiator() {
        assertTrue(WifiDirectConnectionPolicy.shouldInitiate(low, high, false))
        assertFalse(WifiDirectConnectionPolicy.shouldInitiate(high, low, false))
    }

    @Test fun eitherIdentityCanJoinAnExistingGroup() {
        assertTrue(WifiDirectConnectionPolicy.shouldInitiate(low, high, true))
        assertTrue(WifiDirectConnectionPolicy.shouldInitiate(high, low, true))
    }

    @Test fun passivePeerCanStartWhenDiscoveryRevealsAnOwner() {
        assertFalse(WifiDirectConnectionPolicy.shouldInitiate(high, low, false))
        assertTrue(WifiDirectConnectionPolicy.shouldInitiate(high, low, true))
    }
}
