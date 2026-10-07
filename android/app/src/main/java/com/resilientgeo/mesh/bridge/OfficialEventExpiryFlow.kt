package com.resilientgeo.mesh.bridge

import com.resilientgeo.mesh.data.EventEntity
import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.collectLatest

private const val MAX_EXPIRY_RECHECK_MILLIS = 30_000L

/**
 * Emits Room rows immediately and schedules official payload cleanup for the
 * nearest expiry. The bounded recheck also notices wall-clock adjustments and
 * prevents a wall-clock change from delaying expiry cleanup by more than 30s.
 * An unchanged snapshot is not emitted again: the Android bridge maps payloads
 * to nested platform-channel collections, whose structural comparison runs on
 * the main thread when a duplicate is sent.
 */
@OptIn(ExperimentalCoroutinesApi::class)
internal fun rowsWithOfficialExpiryPurge(
    source: Flow<List<EventEntity>>,
    now: () -> Instant = Instant::now,
    purgeExpired: suspend (Instant) -> Int,
): Flow<List<EventEntity>> = channelFlow {
    source.collectLatest { rows ->
        var observedAt = now()
        if (purgeExpired(observedAt) > 0) return@collectLatest
        send(rows)

        while (true) {
            delay(nextOfficialEventExpiryPollDelayMillis(rows, observedAt))
            observedAt = now()
            if (purgeExpired(observedAt) > 0) return@collectLatest
        }
    }
}

internal fun nextOfficialEventExpiryPollDelayMillis(
    rows: List<EventEntity>,
    now: Instant,
): Long {
    val nextExpiry = rows.asSequence()
        .filter { it.namespace.startsWith("official.") }
        .mapNotNull { event -> runCatching { Instant.parse(event.expiresAt) }.getOrNull() }
        .filter { it.isAfter(now) }
        .minOrNull()
        ?: return MAX_EXPIRY_RECHECK_MILLIS

    return Duration.between(now, nextExpiry).toMillis()
        .coerceAtLeast(1L)
        .coerceAtMost(MAX_EXPIRY_RECHECK_MILLIS)
}
