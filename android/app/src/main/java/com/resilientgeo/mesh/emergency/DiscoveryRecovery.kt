package com.resilientgeo.mesh.emergency

/** Drives radio recovery without repeatedly restarting a healthy scan. */
class DiscoveryRecovery(private val retryMillis: Long = 30_000L) {
    enum class Action { NONE, STOP, RESTART }

    private var nextAttemptMillis = 0L

    fun nextAction(now: Long, ready: Boolean, active: Boolean, hasTransport: Boolean): Action {
        if (!ready) {
            // A later Bluetooth/permission/location enable is a new opportunity.
            nextAttemptMillis = 0L
            return if (hasTransport) Action.STOP else Action.NONE
        }
        if (active || now < nextAttemptMillis) return Action.NONE
        // Android limits scan restarts. Failures retry with a bounded cadence.
        nextAttemptMillis = now + retryMillis
        return Action.RESTART
    }
}
