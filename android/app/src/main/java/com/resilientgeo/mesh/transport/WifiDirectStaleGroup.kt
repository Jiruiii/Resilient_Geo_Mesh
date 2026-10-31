package com.resilientgeo.mesh.transport

/** Decides when to leave a group our sockets can never use. A persistent group
 * re-invoked by the other side (often left over from Nearby's bandwidth upgrade)
 * can come up without IPv4 on this device. While any group is present discovery
 * and invitations pause, so such a group otherwise blocks the lane until teardown.
 */
internal class WifiDirectStaleGroup(private val limitMillis: Long = NO_IPV4_LIMIT_MS) {
    private var noIpv4Since: Long? = null

    /** Returns true when the group should be removed; the caller removes it once. */
    fun observe(now: Long, groupFormed: Boolean, hasIpv4: Boolean, hasLinks: Boolean): Boolean {
        if (!groupFormed || hasIpv4 || hasLinks) { noIpv4Since = null; return false }
        val since = noIpv4Since ?: now.also { noIpv4Since = it }
        if (now - since < limitMillis) return false
        noIpv4Since = null
        return true
    }

    companion object {
        // DHCP on a fresh P2P group normally finishes within a few seconds.
        const val NO_IPV4_LIMIT_MS = 20_000L
    }
}
