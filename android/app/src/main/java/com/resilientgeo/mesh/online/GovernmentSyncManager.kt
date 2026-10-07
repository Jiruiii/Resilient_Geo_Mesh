package com.resilientgeo.mesh.online

import android.content.Context
import android.content.pm.ApplicationInfo
import com.resilientgeo.mesh.data.MeshRepository
import com.resilientgeo.mesh.data.ChunkIngestResult
import com.resilientgeo.mesh.trust.TrustedKeyStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
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
    fun message(): Map<String, Any?> {
        val sources = runCatching { JSONArray(prefs.getString("sources", "[]")) }.getOrElse { JSONArray() }
        return mapOf("url" to prefs.getString("url", ""), "enabled" to prefs.getBoolean("enabled", true),
            "syncing" to syncing, "area" to prefs.getString("area", "all"), "last_attempt" to prefs.getString("attempt", null),
            "last_success" to prefs.getString("success", null), "error" to prefs.getString("error", null),
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
                val repository = MeshRepository(context)
                repository.purgeUnsupportedOfficialEventData()
                val trust = TrustedKeyStore.fromJson(context.assets.open("trust/trusted-keys.json").bufferedReader().use { it.readText() })
                val downloadAll = prefs.getString("area", "all") == "all"
                val sync = GovernmentFeedSync(trust, { GovernmentFeedSync.download(it) },
                    { dataset, namespace, id -> repository.cachedChunkJson(dataset, namespace, id) },
                    { chunk -> repository.ingestChunk(chunk) is ChunkIngestResult.Applied }, includeArea = { area ->
                        downloadAll || area.startsWith("tw.630") || area.startsWith("tw.650") ||
                            area in setOf("tw", "tw.unknown")
                    })
                val result = sync.sync(url, FeedCursor(prefs.getLong("revision", 0), prefs.getString("hash", "").orEmpty()), debug)
                check(prefs.edit().putLong("revision", result.cursor.revision).putString("hash", result.cursor.hash)
                    .putString("success", Instant.now().toString()).remove("error")
                    .putInt("downloaded", result.downloaded).putString("sources", result.feed.getJSONArray("sources").toString()).commit())
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                // Do not expose arbitrary URLs or raw server bodies in the product.
                prefs.edit().putString("error", if (error is IllegalArgumentException)
                    "資料驗證未通過或網址設定不正確；保留上次資料。" else "暫時無法取得更新；離線資料與附近轉傳仍可使用。").commit()
            } finally { syncing = false }
            message()
        }
    }
    companion object {
        private const val DEBUG_EMULATOR_URL = "http://10.0.2.2:8787/"
        @Volatile private var instance: GovernmentSyncManager? = null
        fun get(context: Context): GovernmentSyncManager = instance ?: synchronized(this) {
            instance ?: GovernmentSyncManager(context).also { instance = it }
        }
    }
}
