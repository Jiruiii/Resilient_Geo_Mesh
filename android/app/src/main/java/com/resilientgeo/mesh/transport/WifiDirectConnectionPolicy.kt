package com.resilientgeo.mesh.transport

import android.net.wifi.p2p.WifiP2pManager

internal object WifiDirectConnectionPolicy {
    fun shouldInitiate(localIdentity: String, peerIdentity: String, peerIsGroupOwner: Boolean): Boolean =
        peerIsGroupOwner || localIdentity < peerIdentity

    /** The framework drops a channel's local service and service requests when it
     * shuts an idle P2P interface down; discoverServices then fails with
     * NO_SERVICE_REQUESTS until both are added again. */
    fun mustReregister(failureReason: Int): Boolean =
        failureReason == WifiP2pManager.NO_SERVICE_REQUESTS
}
