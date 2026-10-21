package com.resilientgeo.mesh.data

import com.resilientgeo.mesh.ingest.ApplyState
import com.resilientgeo.mesh.ingest.StoredEvent
import org.json.JSONObject

/** Shared between [RoomEventStore] (writing/reading the DB) and the UI layer (reading for display). */
fun EventEntity.toStoredEvent(): StoredEvent = StoredEvent(
    namespace = namespace,
    eventId = eventId,
    eventVersion = eventVersion,
    eventType = eventType,
    severity = severity,
    expiresAt = expiresAt,
    applyState = ApplyState.valueOf(applyState),
    eventJson = eventJson,
)

fun StoredEvent.toEntity(): EventEntity = EventEntity(
    namespace = namespace,
    eventId = eventId,
    eventVersion = eventVersion,
    eventType = eventType,
    severity = severity,
    expiresAt = expiresAt,
    applyState = applyState.name,
    eventJson = eventJson,
    bridgePayloadJson = compactBridgePayload(JSONObject(eventJson)),
    storedAtEpochMillis = System.currentTimeMillis(),
    ncdrCategoryCode = runCatching {
        val event = JSONObject(eventJson)
        if (isNcdrNamespace(event.optString("namespace")) || event.optString("source").equals("NCDR", true)) {
            ncdrCategoryCode(event)
        } else null
    }.getOrNull(),
)

internal fun compactBridgePayload(event: JSONObject): String? {
    if (!(isNcdrNamespace(event.optString("namespace")) || event.optString("source").equals("NCDR", true))) return null
    val attributes = event.optJSONObject("attributes") ?: return null
    if (!attributes.has("source_record")) return null
    attributes.remove("source_record")
    return event.toString()
}
