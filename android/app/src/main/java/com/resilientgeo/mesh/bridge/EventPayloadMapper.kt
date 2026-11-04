package com.resilientgeo.mesh.bridge

import com.resilientgeo.mesh.data.EventEntity
import com.resilientgeo.mesh.data.EventBridgeRow
import com.resilientgeo.mesh.data.isNcdrNamespace
import com.resilientgeo.mesh.ingest.ApplyState
import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject

/**
 * Converts a persisted event document into values accepted by Flutter's
 * StandardMessageCodec. Room owns the event JSON; this mapper only adds the
 * local apply outcome and never exposes org.json containers across the channel.
 */
object EventPayloadMapper {

    fun toMessage(event: EventBridgeRow, now: Instant = Instant.now()): Map<String, Any?> =
        withApplyState(payloadMap(event), event, now)

    /** Parses the stored payload once; the result is never mutated afterwards. */
    fun payloadMap(event: EventBridgeRow): Map<String, Any?> =
        JSONObject(event.bridgePayloadJson ?: "{}").toMessageMap()

    /** apply_state depends on the clock, so it is overlaid on every emission. */
    fun withApplyState(payload: Map<String, Any?>, event: EventBridgeRow, now: Instant): Map<String, Any?> =
        LinkedHashMap<String, Any?>(payload).apply {
            put("apply_state", ApplyState.at(event.namespace, event.expiresAt, now).name)
        }

    fun toMessage(event: EventEntity, now: Instant = Instant.now()): Map<String, Any?> {
        val payload = event.bridgePayloadJson?.let(::JSONObject) ?: JSONObject(event.eventJson).also {
            if (isNcdrNamespace(event.namespace) || it.optString("source").equals("NCDR", true)) {
                // Raw CAP records stay in Server private storage. Flutter only needs
                // the normalized signed fields and source type/code for display.
                it.optJSONObject("attributes")?.remove("source_record")
            }
        }
        return payload.toMessageMap().toMutableMap().apply {
            put("apply_state", ApplyState.at(event.namespace, event.expiresAt, now).name)
        }
    }

    private fun JSONObject.toMessageMap(): Map<String, Any?> {
        val values = LinkedHashMap<String, Any?>()
        val names = keys()
        while (names.hasNext()) {
            val name = names.next()
            values[name] = get(name).toMessageValue()
        }
        return values
    }

    private fun JSONArray.toMessageList(): List<Any?> =
        List(length()) { index -> get(index).toMessageValue() }

    private fun Any?.toMessageValue(): Any? = when (this) {
        null, JSONObject.NULL -> null
        is JSONObject -> toMessageMap()
        is JSONArray -> toMessageList()
        is String, is Boolean, is Int, is Long, is Double, is Float, is ByteArray -> this
        is Number -> toDouble()
        else -> toString()
    }
}
