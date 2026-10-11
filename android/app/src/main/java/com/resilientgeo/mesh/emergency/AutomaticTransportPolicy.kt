package com.resilientgeo.mesh.emergency

/** Pure policy: one fast radio at a time; BLE stays discoverable across transitions. */
class AutomaticTransportPolicy {
    private val retryAfter = mutableMapOf<String, Long>()
    private var attemptedAt = 0L
    var active: String? = null
        private set
    var reason: String? = null
        private set
    private var succeeded = false
    private var failed = false

    fun outcome(success: Boolean, code: String?) {
        if (success) { succeeded = true; failed = false; reason = null }
        else if (code in setOf("discovery_failed", "connection_failed", "hello_timeout", "send_failed", "session_failed")) {
            failed = true
            reason = "${active}_${code}"
        }
    }

    fun select(now: Long, nearbyReady: Boolean, wifiReady: Boolean, busy: Boolean, peers: Int): String? {
        val ready = mapOf("nearby" to nearbyReady, "wifi_direct" to wifiReady)
        val current = active
        if (current != null) {
            val expired = now - attemptedAt >= if (current == "nearby") 30_000 else 100_000
            if (ready[current] == true && (busy || (!failed && (!expired || (succeeded && peers > 0))))) return current
            reason = when {
                ready[current] != true -> "${current}_unavailable"
                failed -> reason
                else -> "${current}_no_peer"
            }
            retryAfter[current] = now + 120_000
            active = null
        }
        val selected = listOf("nearby", "wifi_direct").firstOrNull {
            ready[it] == true && now >= (retryAfter[it] ?: 0L)
        }
        if (selected != null) {
            active = selected
            attemptedAt = now
            succeeded = false
            failed = false
        } else if (reason == null) reason = "fast_transport_unavailable"
        return active
    }
}
