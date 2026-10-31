package com.resilientgeo.mesh.transport

import android.net.wifi.p2p.WifiP2pManager
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

    @Test fun onlyLostServiceRequestsTriggerReregistration() {
        // 10-31: after the framework's idle shutdown every search failed with 3.
        assertTrue(WifiDirectConnectionPolicy.mustReregister(WifiP2pManager.NO_SERVICE_REQUESTS))
        assertFalse(WifiDirectConnectionPolicy.mustReregister(WifiP2pManager.BUSY))
        assertFalse(WifiDirectConnectionPolicy.mustReregister(WifiP2pManager.ERROR))
        assertFalse(WifiDirectConnectionPolicy.mustReregister(WifiP2pManager.P2P_UNSUPPORTED))
    }
}
