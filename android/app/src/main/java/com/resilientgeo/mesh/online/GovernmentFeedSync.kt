package com.resilientgeo.mesh.online

import com.resilientgeo.mesh.trust.Canonical
import com.resilientgeo.mesh.trust.TrustedKeyStore
import org.json.JSONObject
import java.net.URI
import java.net.HttpURLConnection
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.io.IOException
import kotlinx.coroutines.delay

data class FeedCursor(val revision: Long = 0, val hash: String = "")
data class FeedSyncResult(val cursor: FeedCursor, val downloaded: Int, val feed: JSONObject)

/** Stateless transport: callers persist cursor only when the whole release applied. */
class GovernmentFeedSync(
    private val trust: TrustedKeyStore,
    private val fetch: suspend (String) -> JSONObject,
    private val cached: suspend (String, String, String) -> JSONObject?,
    private val ingest: suspend (JSONObject) -> Boolean,
    private val now: () -> Instant = { Instant.now() },
    private val includeArea: (String) -> Boolean = { true },
) {
    suspend fun sync(baseUrl: String, cursor: FeedCursor, allowLocal: Boolean = false): FeedSyncResult {
        val base = validateBase(baseUrl, allowLocal)
        val feed = fetchWithRetry(base.resolve("feed.json").toString())
        GovernmentFeedVerifier.verify(feed, trust, now())
        val revision = feed.getLong("revision")
        val hash = Canonical.sha256Canonical(feed)
        require(revision >= cursor.revision && (revision != cursor.revision || cursor.hash.isEmpty() || hash == cursor.hash)) {
            "Government feed rollback or conflicting revision"
        }
        var downloaded = 0
        val datasets = feed.getJSONArray("datasets")
        for (i in 0 until datasets.length()) {
            val dataset = datasets.getJSONObject(i)
            // Official alerts in the App come from NCDR only. Do not fetch
            // or ingest other signed government datasets.
            if (dataset.optString("source_id") != "ncdr") continue
            val manifest = dataset.getJSONObject("manifest")
            val entries = manifest.getJSONArray("chunks")
            val paths = dataset.getJSONArray("chunk_paths")
            for (j in 0 until entries.length()) {
                val entry = entries.getJSONObject(j)
                if (!includeArea(entry.getString("area_id"))) continue
                val existing = cached(manifest.getString("dataset_id"), manifest.getString("namespace"), entry.getString("chunk_id"))
                val chunk = if (existing?.optString("chunk_hash") == entry.getString("chunk_hash")) existing
                    else fetchWithRetry(base.resolve(paths.getString(j)).toString()).also { downloaded++ }
                GovernmentFeedVerifier.verifyChunk(chunk, manifest, j, trust)
                require(ingest(chunk)) { "Government chunk could not be stored" }
            }
        }
        return FeedSyncResult(FeedCursor(revision, hash), downloaded, feed)
    }

    private suspend fun fetchWithRetry(url: String): JSONObject {
        repeat(3) { attempt ->
            try { return fetch(url) }
            catch (error: IOException) {
                if (attempt == 2) throw error
                delay((attempt + 1) * 1000L)
            }
        }
        error("Unreachable retry state")
    }

    companion object {
        fun validateBase(url: String, allowLocal: Boolean = false): URI {
            val uri = URI(url.trim().let { if (it.endsWith('/')) it else "$it/" })
            require(uri.host != null && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null) { "Invalid feed address" }
            require(uri.scheme == "https" || allowLocal && uri.scheme == "http" && uri.host in setOf("127.0.0.1", "localhost")) {
                "Government feed requires HTTPS"
            }
            return uri
        }
        fun download(url: String): JSONObject {
            val connection = URI(url).toURL().openConnection() as HttpURLConnection
            connection.connectTimeout = 15000
            connection.readTimeout = 20000
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Cache-Control", "no-cache")
            try {
                val status = connection.responseCode
                if (status == 429 || status in 500..599) throw IOException("Government server temporarily unavailable")
                require(status == 200) { "Government server HTTP $status" }
                require(connection.contentLengthLong <= MAX_BYTES) { "Government response too large" }
                val output = ByteArrayOutputStream()
                connection.inputStream.use { input ->
                    val buffer = ByteArray(8192)
                    while (true) {
                        val size = input.read(buffer)
                        if (size < 0) break
                        require(output.size() + size <= MAX_BYTES) { "Government response too large" }
                        output.write(buffer, 0, size)
                    }
                }
                return JSONObject(output.toString("UTF-8"))
            } finally { connection.disconnect() }
        }
        private const val MAX_BYTES = 8 * 1024 * 1024
    }
}
