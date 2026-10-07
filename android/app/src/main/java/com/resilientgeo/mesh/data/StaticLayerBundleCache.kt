package com.resilientgeo.mesh.data

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/** Atomic private copy of the last static layer package; callers still verify every cache miss. */
class StaticLayerBundleCache(private val directory: File) {
    data class Bundle(val manifest: String, val chunks: List<String>)

    fun read(layerId: String): Bundle? = runCatching {
        requireValidLayerId(layerId)
        val primary = readDirectory(bundleDirectory(layerId))
        if (primary != null) return@runCatching primary
        val backup = readDirectory(backupDirectory(layerId))
        if (backup != null) return@runCatching backup

        // Read the previous single-JSON cache format so updates keep the last
        // verified package available when they cross this storage migration.
        val legacy = File(directory, "$layerId.json")
        if (!legacy.isFile) return@runCatching null
        val root = JSONObject(legacy.readText())
        val chunks = root.getJSONArray("chunks")
        Bundle(
            manifest = root.getJSONObject("manifest").toString(),
            chunks = (0 until chunks.length()).map { chunks.getJSONObject(it).toString() },
        )
    }.getOrNull()

    fun write(layerId: String, bundle: Bundle) {
        requireValidLayerId(layerId)
        directory.mkdirs()

        val temporary = Files.createTempDirectory(directory.toPath(), "$layerId.tmp-").toFile()
        val chunkDirectory = File(temporary, "chunks")
        check(chunkDirectory.mkdirs()) { "could not create static layer chunk cache" }
        try {
            File(temporary, "manifest.json").writeText(bundle.manifest)
            bundle.chunks.forEachIndexed { index, chunk ->
                File(chunkDirectory, "$index.json").writeText(chunk)
            }

            val destination = bundleDirectory(layerId)
            val backup = backupDirectory(layerId)
            if (backup.exists()) check(backup.deleteRecursively()) { "could not clear previous static layer backup" }
            if (destination.exists()) move(destination, backup)
            try {
                move(temporary, destination)
            } catch (error: Exception) {
                if (backup.exists() && !destination.exists()) move(backup, destination)
                throw error
            }
            if (backup.exists()) check(backup.deleteRecursively()) { "could not remove replaced static layer backup" }
            // Remove a legacy file only after the new package is committed.
            File(directory, "$layerId.json").delete()
        } finally {
            if (temporary.exists()) temporary.deleteRecursively()
        }
    }

    private fun readDirectory(root: File): Bundle? = runCatching {
        if (!root.isDirectory) return@runCatching null
        val manifest = File(root, "manifest.json").readText()
        val chunkCount = JSONObject(manifest).getJSONArray("chunks").length()
        require(chunkCount > 0)
        val chunkDirectory = File(root, "chunks")
        val chunks = (0 until chunkCount).map { index ->
            File(chunkDirectory, "$index.json").readText()
        }
        Bundle(manifest, chunks)
    }.getOrNull()

    private fun bundleDirectory(layerId: String) = File(directory, "$layerId.bundle")

    private fun backupDirectory(layerId: String) = File(directory, "$layerId.backup")

    private fun move(source: File, destination: File) {
        Files.move(
            source.toPath(),
            destination.toPath(),
            StandardCopyOption.ATOMIC_MOVE,
        )
    }

    private fun requireValidLayerId(layerId: String) {
        require(layerId.matches(Regex("^[a-z][a-z0-9-]+$")))
    }
}
