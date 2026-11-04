package com.resilientgeo.mesh.bridge

import com.resilientgeo.mesh.data.EventBridgeRow
import java.time.Instant
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.transform

/**
 * Minimum spacing between event snapshots sent to Flutter. Mesh sync writes
 * one chunk at a time and every Room write re-emits the whole table; without
 * this, a burst of chunks becomes a burst of full-list channel messages and
 * full-screen Flutter rebuilds. The newest snapshot is always delivered.
 */
internal const val BRIDGE_EVENT_MIN_INTERVAL_MILLIS = 250L

/**
 * Leading-edge throttle that keeps the latest value: the first snapshot is
 * sent immediately, then at most one per [intervalMillis], and the last
 * snapshot of a burst is never dropped.
 */
internal fun <T> Flow<T>.throttleLatest(intervalMillis: Long): Flow<T> =
    conflate().transform { value ->
        emit(value)
        delay(intervalMillis)
    }

/**
 * Reuses parsed payloads across Room emissions so an unchanged event is not
 * JSON-parsed again when another event arrives. A payload is reused only
 * while its stored JSON text is identical; `apply_state` is recomputed for
 * every row because it depends on the clock. Not thread-safe: one instance
 * per event observation, used from a single collector.
 */
internal class BridgeEventMessageCache(
    private val parse: (EventBridgeRow) -> Map<String, Any?> = EventPayloadMapper::payloadMap,
) {
    private class Entry(val payloadJson: String?, val payload: Map<String, Any?>)

    private var entries = HashMap<Pair<String, String>, Entry>()

    fun toMessages(rows: List<EventBridgeRow>, now: Instant): List<Map<String, Any?>> {
        val next = HashMap<Pair<String, String>, Entry>(rows.size * 2)
        val messages = rows.map { row ->
            val key = row.namespace to row.eventId
            val entry = entries[key]?.takeIf { it.payloadJson == row.bridgePayloadJson }
                ?: Entry(row.bridgePayloadJson, parse(row))
            next[key] = entry
            EventPayloadMapper.withApplyState(entry.payload, row, now)
        }
        entries = next
        return messages
    }
}
