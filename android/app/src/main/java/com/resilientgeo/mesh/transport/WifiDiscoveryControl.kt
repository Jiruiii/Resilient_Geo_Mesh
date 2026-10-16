package com.resilientgeo.mesh.transport

import java.util.concurrent.atomic.AtomicLong

/** In-process UI request only; never starts a stopped service or bypasses negotiation. */
object WifiDiscoveryControl {
    val requests = AtomicLong(0)
    @Volatile var resting = false
}
