package com.resilientgeo.mesh.transport

import kotlin.random.Random

/** Monotonic retries with jitter so simultaneously started peers do not keep
 * restarting their service queries at the same fixed interval. Pause only for
 * actual group negotiation, not merely while waiting to be discovered remotely.
 */
internal class WifiDirectDiscoverySchedule(
    startedAt: Long,
    private val adaptive: Boolean = false,
    private val jitter: (Long, Long) -> Long = { min, max -> Random.nextLong(min, max) },
) {
    enum class Action { SEARCH, REST }
    private var lastActivityAt = startedAt
    private var resting = false
    private var boosted = false
    private var scanRunning = false
    private var nextAt = startedAt + jitter(100, 2500)
    private var searchDeadline = Long.MAX_VALUE

    fun next(now: Long, paused: Boolean): Action? {
        if (paused || now < nextAt) return null
        val idle = now - lastActivityAt
        if (adaptive && idle >= 60000 && scanRunning && !boosted) {
            resting = true
            scanRunning = false
            nextAt = now + jitter(if (idle < 180000) 30000 else 60000, if (idle < 180000) 45000 else 90000)
            return Action.REST
        }
        resting = false
        boosted = false
        // Match the paired jitter probe: first refresh after 6s, subsequent
        // refreshes 7–13s apart. No explicit stop/listen transition is needed.
        nextAt = now + if (adaptive && idle >= 60000) 12000 else
            if (searchDeadline == Long.MAX_VALUE) 6000 else jitter(7000, 13000)
        scanRunning = true
        searchDeadline = nextAt
        return Action.SEARCH
    }

    fun peerSeen(now: Long) { lastActivityAt = now }

    fun searchNow(now: Long) {
        lastActivityAt = now
        boosted = true
        nextAt = now
    }

    fun searchStopped(now: Long) {
        if (resting || !scanRunning) return
        scanRunning = false
        nextAt = now + jitter(700, 1800)
    }

    fun searchStarted() {
        // Native restart can broadcast STOPPED then STARTED for the same call.
        // Restore the original deadline; duplicate STARTED must not extend it.
        if (!resting && searchDeadline != Long.MAX_VALUE) {
            scanRunning = true
            nextAt = searchDeadline
        }
    }

    fun failed(now: Long) {
        scanRunning = false
        resting = false
        searchDeadline = Long.MAX_VALUE
        nextAt = now + jitter(2000, 4000)
    }
}
