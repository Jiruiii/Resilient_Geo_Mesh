package com.resilientgeo.mesh.online

import android.content.Context
import android.content.pm.ApplicationInfo
import com.resilientgeo.mesh.bridge.GovernmentSessionKeyStore
import com.resilientgeo.mesh.data.MeshRepository
import com.resilientgeo.mesh.data.ChunkIngestResult
import com.resilientgeo.mesh.trust.TrustedKeyStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.time.Instant

/** One mutex for UI, foreground checks and JobScheduler. Offline failures leave Room intact. */
class GovernmentSyncManager private constructor(context: Context) {
    private val context = context.applicationContext
    private val prefs = this.context.getSharedPreferences("government-sync", Context.MODE_PRIVATE)
    private val mutex = Mutex()
    @Volatile private var syncing = false
    private val debug = this.context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0

    init {
        if (!prefs.contains("url")) {
            val defaultUrl = if (debug) DEBUG_EMULATOR_URL else runCatching {
                JSONObject(this.context.assets.open("trust/government-service.json").bufferedReader().use { it.readText() })
                    .getString("base_url")
            }.getOrDefault("")
            if (defaultUrl.isNotBlank()) configure(defaultUrl, true)
        }
    }

    fun configure(url: String, enabled: Boolean, area: String = prefs.getString("area", "all").orEmpty()) {
        require(area in setOf("taipei", "all"))
        val normalized = if (url.isBlank()) "" else GovernmentFeedSync.validateBase(url, debug).toString()
        val previous = prefs.getString("url", "").orEmpty()
        val editor = prefs.edit().putString("url", normalized).putBoolean("enabled", enabled).putString("area", area)
        if (debug && previous.isNotBlank() && previous != normalized) {
            // A development server has its own revision sequence. The Room
            // cache remains available offline while this server is verified.
            editor.remove("revision").remove("hash").remove("success")
                .remove("downloaded").remove("sources").remove("error")
        }
        editor.commit()
        GovernmentSyncJob.schedule(context, enabled && normalized.isNotBlank())
    }

    fun configureWarningUploadBaseUrl(url: String) {
        val normalized = GovernmentFeedSync.validateBase(url, debug).toString()
        check(prefs.edit().putString("warning_upload_api_base_url", normalized).commit()) {
            "Could not save government warning upload URL"
        }
        GovernmentSyncJob.schedulePendingUpload(context)
    }

    fun message(): Map<String, Any?> {
        val sources = runCatching { JSONArray(prefs.getString("sources", "[]")) }.getOrElse { JSONArray() }
        return mapOf("url" to prefs.getString("url", ""), "enabled" to prefs.getBoolean("enabled", true),
            "syncing" to syncing, "area" to prefs.getString("area", "all"), "last_attempt" to prefs.getString("attempt", null),
            "last_success" to prefs.getString("success", null), "error" to prefs.getString("error", null),
            "last_revocation_sync_at" to prefs.getString("revocation_sync_at", null),
            "revision" to prefs.getLong("revision", 0), "downloaded" to prefs.getInt("downloaded", 0),
            "sources" to (0 until sources.length()).map { i ->
                val source = sources.getJSONObject(i)
                mapOf("id" to source.optString("id"), "status" to source.optString("status"),
                    "last_success_at" to source.optString("last_success_at").takeIf { it != "null" && it.isNotBlank() },
                    "event_count" to source.optInt("event_count"), "unresolved_count" to source.optInt("unresolved_count"))
            }.filter { it["id"] == "ncdr" })
    }
    suspend fun sync(automatic: Boolean = false): Map<String, Any?> = withContext(Dispatchers.IO) {
        mutex.withLock {
            val url = prefs.getString("url", "").orEmpty()
            if (url.isBlank() || automatic && !prefs.getBoolean("enabled", true)) return@withLock message()
            // Concurrent background and foreground triggers share this minimum interval.
            val lastAttempt = prefs.getLong("attempt_millis", 0)
            if (automatic && System.currentTimeMillis() - lastAttempt < 5 * 60_000) return@withLock message()
            syncing = true
            prefs.edit().putString("attempt", Instant.now().toString()).putLong("attempt_millis", System.currentTimeMillis()).commit()
            try {
                try {
                    val repository = MeshRepository(context)
                    repository.purgeUnsupportedOfficialEventData()
                    val trust = TrustedKeyStore.fromJson(context.assets.open("trust/trusted-keys.json").bufferedReader().use { it.readText() })
                    val downloadAll = prefs.getString("area", "all") == "all"
                    val sync = GovernmentFeedSync(trust, { GovernmentFeedSync.download(it) },
                        { dataset, namespace, id -> repository.cachedChunkJson(dataset, namespace, id) },
                        { chunk -> repository.ingestChunk(chunk) is ChunkIngestResult.Applied }, includeArea = { area ->
                            downloadAll || area.startsWith("tw.630") || area.startsWith("tw.650") ||
                                area in setOf("tw", "tw.unknown")
                        }, revokedAtByCertificateId = { repository.governmentDeviceRevocations() },
                        onVerifiedGovernmentWarning = { event ->
                            repository.markGovernmentWarningPublished(event.getString("event_id"), event.getString("payload_hash"))
                        })
                    val result = sync.sync(url, FeedCursor(prefs.getLong("revision", 0), prefs.getString("hash", "").orEmpty()), debug)
                    val successAt = Instant.now().toString()
                    check(prefs.edit().putLong("revision", result.cursor.revision).putString("hash", result.cursor.hash)
                        .putString("success", successAt).putString("revocation_sync_at", successAt).remove("error")
                        .putInt("downloaded", result.downloaded).putString("sources", result.feed.getJSONArray("sources").toString()).commit())
                } catch (error: Exception) {
                    if (error is kotlinx.coroutines.CancellationException) throw error
                    // Do not expose arbitrary URLs or raw server bodies in the product.
                    prefs.edit().putString("error", if (error is IllegalArgumentException)
                        "資料驗證未通過或網址設定不正確；保留上次資料。" else "暫時無法取得更新；離線資料與附近轉傳仍可使用。").commit()
                }
                // Independent of the feed outcome above: a rescue chunk should still
                // reach the server even when the government feed itself failed.
                runCatching {
                    val repository = MeshRepository(context)
                    RescueServerSync(UrlConnectionRescueHttp, SharedPreferencesRescueUploadStates(context))
                        .upload(url, repository.ownRescueChunks())
                }
            } finally { syncing = false }
            message()
        }
    }

    /**
     * Uploads the durable Android warning outbox. A true result means the
     * network job should retry; missing or rejected credentials leave Room
     * untouched and wait for the next authenticated app session.
     */
    suspend fun flushPendingGovernmentWarnings(): Boolean = withContext(Dispatchers.IO) {
        mutex.withLock {
            val token = try {
                GovernmentSessionKeyStore(context).read()
            } catch (_: Exception) {
                return@withLock false
            }?.takeIf { it.isNotBlank() } ?: return@withLock false
            val repository = MeshRepository(context)
            val rows = repository.pendingGovernmentWarningUploads()
            if (rows.isEmpty()) return@withLock false
            val endpoint = try {
                governmentWarningUploadEndpoint()
            } catch (_: Exception) {
                return@withLock false
            }
            var retry = rows.size >= MAX_UPLOAD_BATCH
            val now = Instant.now()

            for (row in rows) {
                val event = try {
                    JSONObject(row.eventJson)
                } catch (_: Exception) {
                    retry = true
                    continue
                }
                if (event.optString("event_id") != row.eventId ||
                    event.optString("payload_hash") != row.payloadHash
                ) {
                    retry = true
                    continue
                }
                val expiresAt = runCatching { Instant.parse(event.getString("expires_at")) }.getOrNull()
                if (expiresAt == null) {
                    retry = true
                    continue
                }
                if (!expiresAt.isAfter(now)) {
                    repository.markGovernmentWarningExpired(row.eventId, row.payloadHash)
                    continue
                }

                val response = try {
                    postGovernmentWarning(endpoint, token, row.eventJson)
                } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    retry = true
                    continue
                }
                when {
                    response.statusCode in 200..299 -> {
                        val accepted = runCatching { JSONObject(response.body) }.getOrNull()
                        if (accepted == null || accepted.optString("event_id") != row.eventId ||
                            accepted.optString("payload_hash") != row.payloadHash ||
                            !repository.markGovernmentWarningUploaded(row.eventId, row.payloadHash)
                        ) {
                            retry = true
                        }
                    }
                    response.statusCode == 408 || response.statusCode == 429 || response.statusCode >= 500 -> retry = true
                    response.statusCode == 401 || response.statusCode == 403 -> return@withLock false
                    // Validation and identity conflicts are not improved by an automatic retry.
                    else -> Unit
                }
            }
            retry
        }
    }

    private fun governmentWarningUploadEndpoint(): java.net.URL {
        val configuredApiBase = prefs.getString("warning_upload_api_base_url", "").orEmpty()
        if (configuredApiBase.isNotBlank()) {
            return GovernmentFeedSync.validateBase(configuredApiBase, debug)
                .resolve("government/warnings").toURL()
        }
        val feedUrl = prefs.getString("url", "").orEmpty()
        require(feedUrl.isNotBlank()) { "Government feed URL is unavailable" }
        val feedBase = GovernmentFeedSync.validateBase(feedUrl, debug)
        val apiBase = if (debug && feedBase.scheme == "http" && feedBase.port == 8787) {
            URI("http", null, feedBase.host, 8788, "/api/v1/", null, null)
        } else {
            feedBase.resolve("/api/v1/")
        }
        return apiBase.resolve("government/warnings").toURL()
    }

    private fun postGovernmentWarning(endpoint: java.net.URL, token: String, eventJson: String): UploadResponse {
        val body = eventJson.toByteArray(Charsets.UTF_8)
        require(body.size <= MAX_WARNING_REQUEST_BYTES) { "Government warning exceeds upload limit" }
        val connection = endpoint.openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 20_000
        connection.instanceFollowRedirects = false
        connection.requestMethod = "POST"
        connection.doOutput = true
        connection.setRequestProperty("Accept", "application/json")
        connection.setRequestProperty("Content-Type", "application/json")
        connection.setRequestProperty("Authorization", "Bearer $token")
        try {
            connection.outputStream.use { output -> output.write(body) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val responseBody = stream?.use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(4096)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    require(output.size() + count <= MAX_WARNING_RESPONSE_BYTES) {
                        "Government warning response exceeds limit"
                    }
                    output.write(buffer, 0, count)
                }
                output.toString(Charsets.UTF_8.name())
            }.orEmpty()
            return UploadResponse(status, responseBody)
        } finally {
            connection.disconnect()
        }
    }

    private data class UploadResponse(val statusCode: Int, val body: String)

    companion object {
        private const val MAX_UPLOAD_BATCH = 100
        private const val MAX_WARNING_REQUEST_BYTES = 64 * 1024
        private const val MAX_WARNING_RESPONSE_BYTES = 256 * 1024
        private const val DEBUG_EMULATOR_URL = "http://10.0.2.2:8787/"
        @Volatile private var instance: GovernmentSyncManager? = null
        fun get(context: Context): GovernmentSyncManager = instance ?: synchronized(this) {
            instance ?: GovernmentSyncManager(context).also { instance = it }
        }
    }
}
