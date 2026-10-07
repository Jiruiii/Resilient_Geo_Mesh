package com.resilientgeo.mesh.data

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * Remembers that one exact static layer package already passed
 * [com.resilientgeo.mesh.protocol.LayerBundleVerifier], so the nationwide
 * shelter layer (5,907 features, one Ed25519 check each) is not re-verified on
 * every launch.
 *
 * The cache key is a SHA-256 over the trust store text, the manifest bytes and
 * every chunk's bytes, in order. Any change to what would be verified - a new
 * data version, a different chunk, a rotated key - misses the cache and the
 * layer is verified in full again, so a bad package still fails closed. The
 * cache lives in app-private storage, next to the Room database it stands
 * beside in the trust model.
 */
class VerifiedLayerCache(private val directory: File) {

    /** Returns whether the exact signed bytes were validated in an earlier run. */
    fun matchesVerified(layerId: String, key: String): Boolean =
        runCatching { verifiedMarker(layerId).readText() == key }.getOrDefault(false)

    /** Stores only the content key for very large layers whose parsed records are streamed. */
    fun markVerified(layerId: String, key: String) {
        directory.mkdirs()
        val target = verifiedMarker(layerId)
        val temporary = Files.createTempFile(directory.toPath(), "${target.name}-", ".tmp").toFile()
        try {
            temporary.writeText(key)
            Files.move(
                temporary.toPath(),
                target.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
        } finally {
            temporary.delete()
        }
    }

    fun read(layerId: String, key: String): List<JSONObject>? {
        val file = fileFor(layerId)
        if (!file.isFile) return null
        return try {
            val root = JSONObject(file.readText())
            if (root.optString("cache_key") != key) return null
            val features = root.getJSONArray("features")
            (0 until features.length()).map { features.getJSONObject(it) }
        } catch (_: Exception) {
            // A truncated or corrupted cache is only a miss; the caller re-verifies.
            null
        }
    }

    fun write(layerId: String, key: String, features: List<JSONObject>) {
        directory.mkdirs()
        val root = JSONObject()
            .put("cache_key", key)
            .put("features", JSONArray().apply { features.forEach { put(it) } })
        val target = fileFor(layerId)
        val temp = File(directory, "${target.name}.tmp")
        temp.writeText(root.toString())
        if (!temp.renameTo(target)) {
            target.delete()
            if (!temp.renameTo(target)) temp.delete()
        }
    }

    private fun fileFor(layerId: String): File =
        File(directory, layerId.map { if (it.isLetterOrDigit() || it == '-') it else '_' }.joinToString("") + ".json")

    private fun verifiedMarker(layerId: String): File =
        File(directory, layerId.map { if (it.isLetterOrDigit() || it == '-') it else '_' }.joinToString("") + ".verified")

    companion object {
        fun key(trustStoreText: String, manifestText: String, chunkTexts: List<String>): String {
            val digest = java.security.MessageDigest.getInstance("SHA-256")
            for (part in listOf(trustStoreText, manifestText) + chunkTexts) {
                val bytes = part.toByteArray(StandardCharsets.UTF_8)
                // Length-prefix each part so boundaries between them cannot shift.
                digest.update(bytes.size.toString().toByteArray(StandardCharsets.UTF_8))
                digest.update(0)
                digest.update(bytes)
            }
            return "sha256:" + digest.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
