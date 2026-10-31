package com.resilientgeo.mesh.measure

import org.json.JSONObject

/**
 * Payload tiers for the measurement harness, drawn from the bundled Taiwan
 * NCDR chunks (`assets/events/taiwan/ncdr-hazard-events`). Chunks are taken
 * smallest first by their manifest `size_bytes` (the compact payload size)
 * until the tier's target is reached, so a tier holds the same chunks on
 * every phone with the same build. CSV rows record the bytes actually sent.
 */
enum class MeasurementPayload(val label: String, private val targetBytes: Long) {
    ONE("1 片", 0),
    KB50("約 50 KB", 50_000),
    MB1("約 1 MB", 1_000_000),
    MB10("約 10 MB", 10_000_000),
    ALL("全部（約 39 MB）", Long.MAX_VALUE);

    /** BLE moves about 4 KB/s, so anything above 1 MB would take hours per trial. */
    val bleAllowed: Boolean get() = targetBytes <= 1_000_000

    fun chunkIds(manifest: JSONObject): List<String> {
        val chunks = manifest.getJSONArray("chunks")
        val ordered = (0 until chunks.length()).map { chunks.getJSONObject(it) }
            .sortedWith(compareBy({ it.getLong("size_bytes") }, { it.getString("chunk_id") }))
        val selected = mutableListOf<String>()
        var bytes = 0L
        for (chunk in ordered) {
            if (if (this == ONE) selected.isNotEmpty() else bytes >= targetBytes) break
            selected += chunk.getString("chunk_id")
            bytes += chunk.getLong("size_bytes")
        }
        return selected
    }

    companion object {
        const val ASSET_DIR = "events/taiwan/ncdr-hazard-events"

        fun assetPath(chunkId: String) = "$ASSET_DIR/chunks/${chunkId.replace(':', '_')}.json"
    }
}
