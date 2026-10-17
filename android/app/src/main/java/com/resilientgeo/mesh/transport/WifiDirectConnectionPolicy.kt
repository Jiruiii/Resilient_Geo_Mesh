package com.resilientgeo.mesh.transport

internal object WifiDirectConnectionPolicy {
    fun shouldInitiate(localIdentity: String, peerIdentity: String, peerIsGroupOwner: Boolean): Boolean =
        peerIsGroupOwner || localIdentity < peerIdentity
}
