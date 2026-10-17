package com.resilientgeo.mesh.online

import android.content.Context
import com.resilientgeo.mesh.trust.RescueContract
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

data class RescueHttpResponse(val status: Int, val body: String)

interface RescueHttp {
    suspend fun post(url: String, json: String): RescueHttpResponse
    suspend fun get(url: String): RescueHttpResponse
}

data class RescueUploadState(val version: Int, val state: String, val reason: String?)

interface RescueUploadStates {
    fun get(eventId: String): RescueUploadState?
    fun put(eventId: String, state: RescueUploadState)
}

class SharedPreferencesRescueUploadStates(context: Context) : RescueUploadStates {
    private val prefs = context.applicationContext.getSharedPreferences("rescue-upload", Context.MODE_PRIVATE)

    override fun get(eventId: String): RescueUploadState? = prefs.getString(eventId, null)?.let {
        runCatching {
            val json = JSONObject(it)
            RescueUploadState(json.getInt("version"), json.getString("state"), json.optString("reason").takeIf { reason -> reason.isNotEmpty() })
        }.getOrNull()
    }

    override fun put(eventId: String, state: RescueUploadState) {
        prefs.edit().putString(
            eventId,
            JSONObject().put("version", state.version).put("state", state.state).put("reason", state.reason ?: "").toString(),
        ).apply()
    }
}

/**
 * Uploads this device's crowd-rescue chunks and downloads nearby ones. The
 * server relays chunks unchanged, so anything downloaded still goes through
 * the normal chunk verification before it reaches Room or the mesh.
 */
class RescueServerSync(private val http: RescueHttp, private val states: RescueUploadStates) {

    suspend fun upload(baseUrl: String, chunks: List<JSONObject>) {
        val url = endpoint(baseUrl)
        for (chunk in chunks) {
            if (chunk.optString("dataset_id") != RescueContract.DATASET_ID) continue
            val event = chunk.getJSONArray("events").getJSONObject(0)
            val eventId = event.getString("event_id")
            val version = event.getInt("event_version")
            val known = states.get(eventId)
            if (known != null && known.version == version && known.state != WAITING) continue
            val response = try {
                http.post(url, chunk.toString())
            } catch (error: IOException) {
                states.put(eventId, RescueUploadState(version, WAITING, "network_unavailable"))
                continue
            }
            states.put(eventId, stateFor(version, response))
        }
    }

    suspend fun download(baseUrl: String, bbox: List<Double>, ingest: suspend (JSONObject) -> Boolean): Int {
        require(bbox.size == 4) { "bbox must have four values" }
        val query = URLEncoder.encode(bbox.joinToString(",") { formatCoordinate(it) }, StandardCharsets.UTF_8.name())
        val response = http.get("${endpoint(baseUrl)}?bbox=$query")
        if (response.status == 404) throw IOException("server_unavailable")
        if (response.status != 200) throw IOException("rescue feed HTTP ${response.status}")
        val chunks = JSONObject(response.body).optJSONArray("chunks") ?: return 0
        var stored = 0
        for (index in 0 until chunks.length()) {
            val chunk = chunks.optJSONObject(index) ?: continue
            if (chunk.optString("dataset_id") != RescueContract.DATASET_ID) continue
            if (ingest(chunk)) stored += 1
        }
        return stored
    }

    private fun stateFor(version: Int, response: RescueHttpResponse): RescueUploadState = when (response.status) {
        200, 201 -> RescueUploadState(version, ACCEPTED, null)
        400, 409, 413 -> {
            val body = runCatching { JSONObject(response.body) }.getOrNull()
            RescueUploadState(version, REJECTED, body?.optString("reason")?.takeIf { it.isNotEmpty() } ?: body?.optString("error")?.takeIf { it.isNotEmpty() } ?: "http_${response.status}")
        }
        404 -> RescueUploadState(version, WAITING, "server_unavailable")
        429 -> RescueUploadState(version, WAITING, "rate_limited")
        else -> RescueUploadState(version, WAITING, "network_unavailable")
    }

    private fun endpoint(baseUrl: String): String {
        val base = if (baseUrl.endsWith('/')) baseUrl else "$baseUrl/"
        return "${base}v1/crowd/rescue-events"
    }

    /** Doubles print like JS (121.6, not 121.60000000000001) for the values this app produces. */
    private fun formatCoordinate(value: Double): String = java.math.BigDecimal(value).setScale(6, java.math.RoundingMode.HALF_UP).stripTrailingZeros().toPlainString()

    companion object {
        const val WAITING = "WAITING_UPLOAD"
        const val ACCEPTED = "ACCEPTED"
        const val REJECTED = "REJECTED"
    }
}

object UrlConnectionRescueHttp : RescueHttp {
    private const val MAX_BYTES = 1024 * 1024

    override suspend fun post(url: String, json: String): RescueHttpResponse = request(url) { connection ->
        connection.requestMethod = "POST"
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json")
        connection.outputStream.use { it.write(json.toByteArray(StandardCharsets.UTF_8)) }
    }

    override suspend fun get(url: String): RescueHttpResponse = request(url) { it.requestMethod = "GET" }

    private suspend fun request(url: String, configure: (HttpURLConnection) -> Unit): RescueHttpResponse = withContext(Dispatchers.IO) {
        val connection = URI(url).toURL().openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 20_000
        connection.instanceFollowRedirects = false
        connection.setRequestProperty("Accept", "application/json")
        connection.setRequestProperty("Cache-Control", "no-cache")
        try {
            configure(connection)
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val output = ByteArrayOutputStream()
            stream?.use { input ->
                val buffer = ByteArray(8192)
                while (true) {
                    val size = input.read(buffer)
                    if (size < 0) break
                    if (output.size() + size > MAX_BYTES) throw IOException("rescue response too large")
                    output.write(buffer, 0, size)
                }
            }
            RescueHttpResponse(status, output.toString(StandardCharsets.UTF_8.name()))
        } finally {
            connection.disconnect()
        }
    }
}
