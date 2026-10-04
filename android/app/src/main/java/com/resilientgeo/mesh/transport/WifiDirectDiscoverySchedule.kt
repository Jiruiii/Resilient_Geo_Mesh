package com.resilientgeo.mesh.transport

import kotlin.random.Random

/** Monotonic retries with jitter so simultaneously started peers do not keep
 * restarting their service queries at the same fixed interval. Pause only for
 * actual group negotiation, not merely while waiting to be discovered remotely.
 */
internal class WifiDirectDiscoverySchedule(
    startedAt: Long,
    private val jitter: (Long, Long) -> Long = { min, max -> Random.nextLong(min, max) },
) {
    enum class Action { SEARCH }
    private var scanRunning = false
    private var nextAt = startedAt + jitter(100, 2500)
    private var searchDeadline = Long.MAX_VALUE

    fun next(now: Long, paused: Boolean): Action? {
        if (paused || now < nextAt) return null
        // Match the paired jitter probe: first refresh after 6s, subsequent
        // refreshes 7–13s apart. No explicit stop/listen transition is needed.
        nextAt = now + if (searchDeadline == Long.MAX_VALUE) 6000 else jitter(7000, 13000)
        scanRunning = true
        searchDeadline = nextAt
        return Action.SEARCH
    }

    fun searchStopped(now: Long) {
        if (!scanRunning) return
        scanRunning = false
        nextAt = now + jitter(700, 1800)
    }

    fun searchStarted() {
        // Native restart can broadcast STOPPED then STARTED for the same call.
        // Restore the original deadline; duplicate STARTED must not extend it.
        if (searchDeadline != Long.MAX_VALUE) {
            scanRunning = true
            nextAt = searchDeadline
        }
    }

    fun failed(now: Long) {
        scanRunning = false
        searchDeadline = Long.MAX_VALUE
        nextAt = now + jitter(2000, 4000)
    }
}
