package com.resilientgeo.mesh.data

import android.content.Context
import com.resilientgeo.mesh.ingest.ApplyState
import com.resilientgeo.mesh.ingest.EventIngestor
import com.resilientgeo.mesh.ingest.IngestResult
import com.resilientgeo.mesh.protocol.ChunkVerifier
import com.resilientgeo.mesh.protocol.LayerBundleVerifier
import com.resilientgeo.mesh.report.CrowdChunkCodec
import com.resilientgeo.mesh.report.CrowdReportFactory
import com.resilientgeo.mesh.report.CrowdReportInput
import com.resilientgeo.mesh.trust.DeviceSigningKey
import com.resilientgeo.mesh.trust.KeystoreWrappedStorage
import com.resilientgeo.mesh.trust.TrustedKeyStore
import com.resilientgeo.mesh.trust.EventVerifier
import com.resilientgeo.mesh.trust.VerificationResult
import com.resilientgeo.mesh.trust.Canonical
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.concurrent.Callable
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Wires the trust adapter and apply rules to Room. This is the only class
 * that knows both "how to verify an event" and "where events are stored" —
 * everything else talks to [com.resilientgeo.mesh.ingest.EventStore] or a
 * plain [org.json.JSONObject].
 */
class MeshRepository(
    context: Context,
    private val db: AppDatabase = AppDatabase.get(context.applicationContext),
    private val cacheDirectory: File = File(context.applicationContext.filesDir, "chunk-cache"),
    private val cacheCapBytes: Long = CHUNK_CACHE_CAP_BYTES,
) {
    private val appContext = context.applicationContext
    private val store = RoomEventStore(db.eventDao())
    private val chunkDao = db.chunkDao()
    @Volatile private var unsupportedOfficialEventsPurged = false

    /**
     * Raw bytes of every verified chunk this node holds, keyed by
     * (datasetId, namespace, chunkId) — separate from [ChunkEntity], which
     * deliberately only records metadata (see its doc comment). Automatic
     * relaying needs both: a node must be able to describe what it has
     * (ChunkEntity) *and* actually hand the bytes to the next peer that asks
     * (this cache) — without it, a relay can advertise a chunk in HELLO but
     * has nothing to send when REQUESTed for it.
     */
    private val chunkCacheDir: File by lazy {
        cacheDirectory.apply { mkdirs() }
    }

    private val trustStoreText: String by lazy {
        appContext.assets.open(TRUSTED_KEYS_ASSET).bufferedReader().use { it.readText() }
    }

    private val trustStore: TrustedKeyStore by lazy { TrustedKeyStore.fromJson(trustStoreText) }

    private val verifiedLayerCache: VerifiedLayerCache by lazy {
        VerifiedLayerCache(File(appContext.noBackupFilesDir, "verified-layers"))
    }

    fun observeEvents(): Flow<List<EventEntity>> = db.eventDao().observeAll()
        .map { events -> events.filterNot(::isUnsupportedOfficialEventEntity) }

    /**
     * Loads optional nationwide static layers only after manifest, chunk and
     * feature verification. First launch downloads the signed layer; later
     * offline launches use its private cached copy. There is no APK-bundled
     * shelter fallback, which could leave Android showing an older dataset
     * while medical data is unavailable.
     */
    suspend fun verifiedStaticFeatures(serverBaseUrl: String? = null): List<Map<String, Any?>> = withContext(Dispatchers.IO) {
        val features = STATIC_LAYER_IDS.flatMap { layerId -> loadStaticLayer(layerId, serverBaseUrl) }
        val medicalPoints = features.filter { it["kind"] == "medical" && it["id"] is String }
            .associateBy { it["id"] as String }
        features.forEach { feature ->
            if (feature["kind"] != "medical-directory") return@forEach
            val pointId = feature["point_feature_id"] as? String
            @Suppress("UNCHECKED_CAST")
            (feature as MutableMap<String, Any?>)["geometry"] = pointId?.let { medicalPoints[it]?.get("geometry") }
        }
        features
    }

    suspend fun verifiedShelterDisasterCatalog(serverBaseUrl: String? = null): com.resilientgeo.mesh.routing.ShelterDisasterCatalog =
        withContext(Dispatchers.IO) {
            com.resilientgeo.mesh.routing.ShelterDisasterCatalog.fromFeatures(loadStaticLayer("taiwan-shelter", serverBaseUrl))
        }

    private fun loadStaticLayer(layerId: String, serverBaseUrl: String? = null): List<Map<String, Any?>> {
        val bundleCache = StaticLayerBundleCache(File(appContext.filesDir, "static-layer-bundles"))
        fun verifiedMessages(bundle: StaticLayerBundleCache.Bundle, isDownloaded: Boolean): List<Map<String, Any?>>? {
            try {
                val manifest = JSONObject(bundle.manifest)
                if (isDownloaded) {
                    require(DateTimeFormatter.ISO_INSTANT.parse(
                        manifest.getString("expires_at"), Instant::from,
                    ).isAfter(Instant.now())) { "static layer $layerId is expired" }
                }
                val cacheKey = VerifiedLayerCache.key(trustStoreText, bundle.manifest, bundle.chunks)
                memoizedLayers[layerId]?.takeIf { it.first == cacheKey }?.let { return it.second }

                val messages = if (layerId == MEDICAL_DIRECTORY_LAYER_ID || layerId == "taiwan-medical") {
                    if (verifiedLayerCache.matchesVerified(layerId, cacheKey)) {
                        staticMessagesFromChunks(bundle.chunks)
                    } else {
                        val streamedMessages = ArrayList<Map<String, Any?>>(manifest.optInt("total_feature_count", 0))
                        val verification = LayerBundleVerifier.verifyJsonChunks(
                            manifest,
                            bundle.chunks,
                            trustStore,
                        ) { chunkFeatures ->
                            chunkFeatures.forEach { streamedMessages += it.toMapFeatureMessage() }
                        }
                        require(verification.valid) {
                            "static layer $layerId verification failed: ${verification.errors.joinToString("; ")}"
                        }
                        try {
                            verifiedLayerCache.markVerified(layerId, cacheKey)
                        } catch (error: Exception) {
                            android.util.Log.w("MeshRepository", "Could not persist the verification marker for $layerId", error)
                        }
                        streamedMessages
                    }
                } else {
                    val features = verifiedLayerCache.read(layerId, cacheKey) ?: run {
                        val verified = LayerBundleVerifier.verifyJson(manifest, bundle.chunks, trustStore)
                        require(verified.valid) {
                            "static layer $layerId verification failed: ${verified.errors.joinToString("; ")}"
                        }
                        runCatching { verifiedLayerCache.write(layerId, cacheKey, verified.features) }
                        verified.features
                    }
                    features.map { it.toMapFeatureMessage() }
                }

                if (isDownloaded) {
                    try {
                        bundleCache.write(layerId, bundle)
                    } catch (error: Exception) {
                        android.util.Log.w("MeshRepository", "Could not cache verified static layer $layerId", error)
                    }
                }
                memoizedLayers[layerId] = cacheKey to messages
                return messages
            } catch (error: Exception) {
                if (error is java.util.concurrent.CancellationException) throw error
                android.util.Log.w("MeshRepository", "Static layer $layerId candidate rejected", error)
                return null
            }
        }

        val cachedManifest = bundleCache.readManifest(layerId)
        val remoteManifest = serverBaseUrl
            ?.takeIf { it.isNotBlank() && layerId in SERVER_STATIC_LAYER_IDS }
            ?.let { base ->
                try {
                    val uri = com.resilientgeo.mesh.online.GovernmentFeedSync.validateBase(
                        base,
                        appContext.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0,
                    )
                    downloadStaticJson(
                        uri.resolve("v1/layers/$layerId/manifest.json").toString(),
                        connectTimeoutMs = 3_000,
                        readTimeoutMs = 3_000,
                    ).also {
                        require(JSONObject(it).optString("layer_id") == layerId) { "static layer manifest identity mismatch" }
                    }
                } catch (error: Exception) {
                    if (error is java.util.concurrent.CancellationException) throw error
                    android.util.Log.w("MeshRepository", "Static layer $layerId manifest unavailable; using cache", error)
                    null
                }
            }
        val sameRelease = remoteManifest == null || cachedManifest != null && runCatching {
            JSONObject(remoteManifest).getString("manifest_hash") == JSONObject(cachedManifest).getString("manifest_hash")
        }.getOrDefault(false)

        fun cachedMessages(): List<Map<String, Any?>>? =
            bundleCache.read(layerId)?.let { verifiedMessages(it, false) }

        // An unchanged or unreachable release needs only the already verified
        // private bundle. Never load a duplicate nationwide chunk set first.
        if (sameRelease) cachedMessages()?.let { return it }
        if (remoteManifest != null) {
            try {
                val downloaded = fetchStaticLayerBundle(serverBaseUrl!!, layerId, remoteManifest)
                verifiedMessages(downloaded, true)?.let { return it }
            } catch (error: Exception) {
                if (error is java.util.concurrent.CancellationException) throw error
                android.util.Log.w("MeshRepository", "Static layer $layerId download failed; using cache", error)
            }
        }
        if (!sameRelease) cachedMessages()?.let { return it }
        return emptyList()
    }

    private fun staticMessagesFromChunks(chunkTexts: List<String>): List<Map<String, Any?>> {
        val output = ArrayList<Map<String, Any?>>()
        for (chunkText in chunkTexts) {
            val features = JSONObject(chunkText).getJSONArray("features")
            for (index in 0 until features.length()) {
                output += features.getJSONObject(index).toMapFeatureMessage()
            }
        }
        return output
    }

    private fun fetchStaticLayerBundle(baseUrl: String, layerId: String, manifestText: String): StaticLayerBundleCache.Bundle {
        val allowLocal = appContext.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0
        val base = com.resilientgeo.mesh.online.GovernmentFeedSync.validateBase(baseUrl, allowLocal)
        require(layerId in SERVER_STATIC_LAYER_IDS) { "static layer is not available from this server" }
        val route = "v1/layers/$layerId/"
        val manifest = JSONObject(manifestText)
        require(manifest.optString("layer_id") == layerId) { "static layer manifest identity mismatch" }
        val entries = manifest.getJSONArray("chunks")
        require(entries.length() in 1..MAX_STATIC_LAYER_CHUNKS) { "static layer chunk count is invalid" }
        val chunks = (0 until entries.length()).map { index ->
            require(entries.getJSONObject(index).optInt("sequence", -1) == index) {
                "static layer chunk sequence is invalid"
            }
            downloadStaticJson(base.resolve("${route}chunks/$index.json").toString())
        }
        return StaticLayerBundleCache.Bundle(manifestText, chunks)
    }

    private fun downloadStaticJson(
        url: String,
        connectTimeoutMs: Int = 15_000,
        readTimeoutMs: Int = 30_000,
    ): String {
        val connection = java.net.URI(url).toURL().openConnection() as java.net.HttpURLConnection
        connection.connectTimeout = connectTimeoutMs
        connection.readTimeout = readTimeoutMs
        connection.instanceFollowRedirects = false
        connection.setRequestProperty("Accept", "application/json")
        connection.setRequestProperty("Cache-Control", "no-cache")
        try {
            require(connection.responseCode == 200) {
                "static layer server returned HTTP ${connection.responseCode}"
            }
            require(connection.contentLengthLong <= MAX_STATIC_JSON_BYTES) {
                "static layer response is too large"
            }
            val output = java.io.ByteArrayOutputStream()
            connection.inputStream.use { input ->
                val buffer = ByteArray(8192)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    require(output.size() + count <= MAX_STATIC_JSON_BYTES) {
                        "static layer response is too large"
                    }
                    output.write(buffer, 0, count)
                }
            }
            return output.toString("UTF-8")
        } finally {
            connection.disconnect()
        }
    }

    private fun JSONObject.toMapFeatureMessage(): Map<String, Any?> {
        val properties = optJSONObject("properties")
        val output = linkedMapOf<String, Any?>(
            "id" to optString("feature_id"),
            "kind" to staticFeatureKind(optString("layer_id"), optString("feature_type")),
            "geometry" to get("geometry").toMessageValue(),
            "source" to optString("source"),
        )
        for (field in listOf("name", "address", "phone", "departments", "capacity", "disaster_types", "administrative_area", "facility_type", "area_id", "county_code", "town_code", "village_code", "coverage", "coordinate_source", "osm_id", "geometry_status", "point_feature_id", "coordinate_failure_reason")) {
            if (properties?.has(field) == true) output[field] = properties.get(field).toMessageValue()
        }
        return output
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

    /**
     * Ingests the bundled test-area event batch (real Ed25519 signatures,
     * generated by `scratch-generate-android-fixture.mjs` from the same
     * `pipeline/lib` module A owns) as if it had just arrived over the
     * network. In phase 1 this is the only data source; phase 3 will feed
     * this same path from Peer Sync instead.
     */
    suspend fun ingestBundledFixture(): List<IngestResult> = withContext(Dispatchers.IO) {
        val json = appContext.assets.open(FIXTURE_ASSET).bufferedReader().use { it.readText() }
        val events = JSONObject(json).getJSONArray("events")
        val now = Instant.now()
        inventoryLock.withLock {
            db.runInTransaction(Callable {
                (0 until events.length()).map { index -> events.getJSONObject(index) }
                    .filterNot(::isUnsupportedOfficialEventJson)
                    .map { event -> EventIngestor.ingest(store, event, trustStore, now) }
            })
        }
    }

    /**
     * TRANSFER entry point for Peer Sync (docs/jia-task-sequence.md item 7,
     * the "3a milestone"): verifies a `chunk-v0` payload received over
     * `BleGattTransport` — chunk_hash + chunk-level Ed25519 signature via
     * [ChunkVerifier], then each individual event via the same
     * [EventIngestor] path [ingestBundledFixture] already uses — and only
     * then writes to Room. A chunk that fails verification never reaches
     * [EventIngestor]/Room at all.
     */
    suspend fun ingestChunk(chunk: JSONObject): ChunkIngestResult = withContext(Dispatchers.IO) {
        val now = Instant.now()
        when (val verified = ChunkVerifier.verify(chunk, trustStore, now)) {
            is ChunkVerifier.Result.Invalid -> ChunkIngestResult.Rejected(verified.reason)
            is ChunkVerifier.Result.Valid -> {
                for (event in verified.events) {
                    val result = EventVerifier.verify(event, trustStore, now)
                    if (result is VerificationResult.Invalid) {
                        return@withContext ChunkIngestResult.Rejected("event verification failed: ${result.errors}")
                    }
                }
                if (verified.events.any(::isUnsupportedOfficialEventJson)) {
                    return@withContext ChunkIngestResult.Rejected("unsupported_official_event_source")
                }
                inventoryLock.withLock {
                    if (chunk.optString("dataset_id") == CrowdChunkCodec.DATASET_ID) {
                        val incoming = verified.events.single()
                        val stored = store.find(incoming.getString("namespace"), incoming.getString("event_id"))
                        if (stored != null && stored.eventVersion > incoming.getInt("event_version")) {
                            return@withLock ChunkIngestResult.Rejected("event_version_rollback")
                        }
                        if (stored != null && stored.eventVersion == incoming.getInt("event_version") &&
                            JSONObject(stored.eventJson).getString("payload_hash") != incoming.getString("payload_hash")) {
                            return@withLock ChunkIngestResult.Rejected("same_version_conflict")
                        }
                    }
                    val results = commitChunk(chunk, now) {
                        verified.events.map { event ->
                            EventIngestor.ingest(store, event, trustStore, now)
                        }
                    }
                    if (chunk.optString("dataset_id") == CrowdChunkCodec.DATASET_ID) pruneCrowdInventory(now)
                    ChunkIngestResult.Applied(results)
                }
            }
        }
    }

    /**
     * Build this node's `peer-summary-v0` HELLO payload from what is
     * actually in Room, rather than from a hand-written fixture.
     *
     * This is what makes the mesh able to sustain itself: a node that
     * received a chunk can now tell the *next* peer it has it, so a third
     * device can pull from a relay instead of only from the original
     * source. `dataset_version` / `manifest_id` are taken from the newest
     * chunk held for the dataset, matching the DTN supersession rule in
     * `PeerSync.computeDiff` (a node advertises the newest manifest it has
     * actually seen).
     *
     * Returns a summary with an empty chunk list when this node holds
     * nothing for the dataset — that is a legitimate HELLO ("I have
     * nothing, send me everything"), not an error.
     */
    suspend fun localPeerSummary(
        nodeId: String,
        datasetId: String,
        namespace: String,
        fallbackManifestId: String,
        fallbackDatasetVersion: Int,
    ): JSONObject = withContext(Dispatchers.IO) {
        purgeUnsupportedOfficialEventData()
        inventoryLock.withLock {
            reconcileInventory()
            val dataset = buildDatasetJson(datasetId, namespace, fallbackManifestId, fallbackDatasetVersion)
            peerSummaryEnvelope(nodeId, JSONArray().put(dataset))
        }
    }

    /**
     * Same HELLO shape as [localPeerSummary], but covering every dataset this
     * node actually holds anything for, rather than one hardcoded pair.
     *
     * This is what makes automatic sync (`AutoPeerSyncEngine`) able to relay
     * more than the single demo dataset: [localPeerSummary] was built for the
     * two-device Peer Sync milestone, where the dataset/namespace pair to
     * describe was chosen on screen by a human. Automatic sync has no such
     * moment and no advance knowledge of what a stranger might be carrying,
     * so it needs a HELLO that enumerates this node's *entire* inventory —
     * plus [KNOWN_DATASETS], so a brand-new node with zero chunks still
     * advertises "I have nothing for this dataset" rather than omitting it
     * (an omitted dataset and "I have zero chunks of it" are not the same
     * claim: only the latter tells a peer there is something to send).
     */
    suspend fun allLocalPeerSummaries(nodeId: String): JSONObject = withContext(Dispatchers.IO) {
        purgeUnsupportedOfficialEventData()
        inventoryLock.withLock {
            reconcileInventory()
            // Expired crowd reports must not be advertised for relay.
            pruneCrowdInventory(Instant.now())
            val heldPairs = chunkDao.allSync().map { it.datasetId to it.namespace }.distinct()
            val seen = mutableSetOf<Pair<String, String>>()
            val datasets = JSONArray()

            for (known in KNOWN_DATASETS) {
                datasets.put(buildDatasetJson(known.datasetId, known.namespace, known.fallbackManifestId, known.fallbackDatasetVersion))
                seen += known.datasetId to known.namespace
            }
            for ((datasetId, namespace) in heldPairs) {
                if (!seen.add(datasetId to namespace)) continue
                // No fallback needed here: `held` for a pair reached only via
                // heldPairs is guaranteed non-empty, so buildDatasetJson always
                // finds a `newest` chunk and never falls back.
                datasets.put(buildDatasetJson(datasetId, namespace, fallbackManifestId = "unknown", fallbackDatasetVersion = 0))
            }

            peerSummaryEnvelope(nodeId, datasets)
        }
    }

    private fun buildDatasetJson(
        datasetId: String,
        namespace: String,
        fallbackManifestId: String,
        fallbackDatasetVersion: Int,
    ): JSONObject {
        val held = chunkDao.forDatasetSync(datasetId, namespace)
        val newest = held.maxByOrNull { it.datasetVersion }

        val chunks = JSONArray()
        held.filter { newest == null || it.datasetVersion == newest.datasetVersion }
            .forEach { entity ->
                chunks.put(
                    JSONObject()
                        .put("chunk_id", entity.chunkId)
                        .put("chunk_hash", entity.chunkHash)
                        .put("size_bytes", entity.sizeBytes)
                        .put("priority", entity.priority)
                        .put("state", "available"),
                )
            }

        return JSONObject()
            .put("dataset_id", datasetId)
            .put("namespace", namespace)
            .put("manifest_id", newest?.manifestId ?: fallbackManifestId)
            .put("dataset_version", newest?.datasetVersion ?: fallbackDatasetVersion)
            .put("chunks", chunks)
    }

    // Every field `schemas/peer-summary-v0.schema.json` marks required. The
    // hand-written summaries this replaced carried only
    // schema_version/node_id/datasets, so the HELLO actually going over the
    // air did not conform to the schema the project publishes as its module
    // interface — and nothing noticed, because the parser only reads
    // node_id and datasets.
    private fun peerSummaryEnvelope(nodeId: String, datasets: JSONArray): JSONObject {
        val now = Instant.now()
        return JSONObject()
            .put("schema_version", "peer-summary-v0")
            .put("protocol_version", "0")
            .put("node_id", nodeId)
            .put("generated_at", DateTimeFormatter.ISO_INSTANT.format(now.truncatedTo(ChronoUnit.SECONDS)))
            .put("capabilities", capabilities())
            .put("datasets", datasets)
    }

    /**
     * Bytes of a chunk this node has already verified and cached, for
     * serving a peer's REQUEST. Returns null both when this node never held
     * the chunk and when it aged out of [CHUNK_CACHE_CAP_BYTES] — either way
     * the caller's correct response is "I don't have it", never a crash.
     */
    suspend fun cachedChunkJson(datasetId: String, namespace: String, chunkId: String): JSONObject? =
        withContext(Dispatchers.IO) {
            purgeUnsupportedOfficialEventData()
            inventoryLock.withLock {
                val file = chunkCacheFile(datasetId, namespace, chunkId)
                val chunk = runCatching {
                    JSONObject(file.readText()).takeIf {
                        it.getString("dataset_id") == datasetId && it.getString("namespace") == namespace &&
                            it.getString("chunk_id") == chunkId &&
                            ChunkVerifier.verify(it, trustStore) is ChunkVerifier.Result.Valid
                    }
                }.getOrNull()
                if (chunk == null) {
                    chunkDao.deleteSync(datasetId, namespace, chunkId)
                    deleteCachedFile(file)
                }
                chunk
            }
        }

    /** Publish complete bytes first; the Room transaction makes events and inventory visible together. */
    private fun <T> commitChunk(chunk: JSONObject, now: Instant, applyEvents: () -> T): T {
        val file = chunkCacheFile(
            datasetId = chunk.getString("dataset_id"),
            namespace = chunk.getString("namespace"),
            chunkId = chunk.getString("chunk_id"),
        )
        val previous = file.takeIf { it.isFile }?.readBytes()
        val priorSize = cacheByteCounts.getOrPut(chunkCacheDir.absolutePath) { cacheBytesOnDisk() }
        writeAtomically(file, chunk.toString().toByteArray(Charsets.UTF_8))
        val result = try {
            db.runInTransaction(Callable {
                val applied = applyEvents()
                chunkDao.upsertSync(chunk.toChunkEntity(now))
                applied
            })
        } catch (error: Exception) {
            if (previous == null) file.delete() else writeAtomically(file, previous)
            throw error
        }
        cacheByteCounts[chunkCacheDir.absolutePath] = priorSize - (previous?.size ?: 0) + file.length()
        evictChunkCacheIfOverCap()
        return result
    }

    private fun writeAtomically(file: File, bytes: ByteArray) {
        val temporary = File.createTempFile("chunk-", ".tmp", chunkCacheDir)
        try {
            temporary.outputStream().use { output ->
                output.write(bytes)
                output.fd.sync()
            }
            Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally {
            temporary.delete()
        }
    }

    /** Recover inventory entries whose bytes were lost during a crash or external cleanup. */
    private fun reconcileInventory() {
        chunkDao.allSync().forEach { entity ->
            val file = chunkCacheFile(entity.datasetId, entity.namespace, entity.chunkId)
            val valid = runCatching {
                val chunk = JSONObject(file.readText())
                chunk.getString("chunk_hash") == entity.chunkHash &&
                    chunk.getString("chunk_id") == entity.chunkId &&
                    chunk.getString("dataset_id") == entity.datasetId &&
                    chunk.getString("namespace") == entity.namespace
            }.getOrDefault(false)
            if (!valid) dropChunk(entity)
        }
        cacheByteCounts[chunkCacheDir.absolutePath] = cacheBytesOnDisk()
    }

    private fun cacheBytesOnDisk(): Long = chunkCacheDir.listFiles()
        ?.filter { it.extension == "json" }?.sumOf { it.length() } ?: 0

    private fun deleteCachedFile(file: File) {
        val size = file.length()
        if (file.delete()) cacheByteCounts.computeIfPresent(chunkCacheDir.absolutePath) { _, count ->
            (count - size).coerceAtLeast(0)
        }
    }

    private fun chunkCacheFile(datasetId: String, namespace: String, chunkId: String): File {
        // Replacing punctuation with '_' aliases distinct identities. A request
        // for an unknown identity must never read or delete another chunk's bytes.
        val digest = Canonical.sha256Canonical(listOf(datasetId, namespace, chunkId)).removePrefix("sha256:")
        val file = File(chunkCacheDir, "chunk-$digest.json")
        val legacy = File(chunkCacheDir, safeCacheFileName(datasetId, namespace, chunkId))
        if (!file.exists() && legacy.isFile) {
            val matches = runCatching {
                val chunk = JSONObject(legacy.readText())
                chunk.getString("dataset_id") == datasetId && chunk.getString("namespace") == namespace &&
                    chunk.getString("chunk_id") == chunkId
            }.getOrDefault(false)
            if (matches) Files.move(legacy.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE)
        }
        return file
    }

    /** chunk_id values contain ':' (e.g. "resilientgeo-demo:chunk:136:dahu:shelter:000"), not filesystem-safe on every target. */
    private fun safeCacheFileName(datasetId: String, namespace: String, chunkId: String): String =
        listOf(datasetId, namespace, chunkId).joinToString(separator = "__") { part ->
            part.map { c -> if (c.isLetterOrDigit() || c == '-' || c == '.') c else '_' }.joinToString("")
        } + ".json"

    /**
     * Oldest-first eviction once the cache exceeds [CHUNK_CACHE_CAP_BYTES].
     * The Neihu-scale dataset ADR-001 measured tops out around 46.6 KB for
     * its single largest chunk with 183 chunks total — comfortably under this
     * cap, so it is headroom rather than a real constraint at v0 scale, kept
     * as an explicit number so it doesn't grow unbounded at a larger scale.
     */
    private fun evictChunkCacheIfOverCap() {
        // Re-reading and parsing the entire inventory for every ~4 KB write
        // made a nationwide HTTP import quadratic. All cache writers share the
        // inventory lock and size counter; HELLO still reconciles actual bytes.
        if ((cacheByteCounts[chunkCacheDir.absolutePath] ?: cacheBytesOnDisk()) <= cacheCapBytes) return
        reconcileInventory()
        val files = chunkCacheDir.listFiles()?.filter { it.extension == "json" }?.sortedBy { it.lastModified() } ?: return
        var total = files.sumOf { it.length() }
        var index = 0
        val inventory = chunkDao.allSync()
        while (total > cacheCapBytes && index < files.size) {
            total -= files[index].length()
            inventory.filter { chunkCacheFile(it.datasetId, it.namespace, it.chunkId) == files[index] }
                .forEach { chunkDao.deleteSync(it.datasetId, it.namespace, it.chunkId) }
            deleteCachedFile(files[index])
            index++
        }
    }

    /**
     * What this node can actually do, per ADR-001: BLE for discovery and BLE
     * GATT for transfer, with byte-level resume proven on real devices. The
     * two Wi-Fi-based transports the schema also allows were rejected and
     * their implementations removed, so advertising them would be a lie a
     * peer could act on.
     */
    private fun capabilities(): JSONObject = JSONObject()
        .put("discovery_transports", JSONArray().put("BLE"))
        .put("transfer_transports", JSONArray().put("BLE_GATT"))
        .put("max_peer_count", MAX_PEER_COUNT)
        .put("supports_resume", true)
        .put("max_chunk_bytes", MAX_CHUNK_BYTES)

    /**
     * Creates, signs and stores a report from this device.
     *
     * Flutter only supplies form fields; the event is assembled and signed
     * here with the device key, then goes through exactly the same
     * [EventIngestor] verification as a report received from a peer, with no
     * DAO shortcut. The report is also wrapped in its own crowd chunk and
     * cached, so the next HELLO advertises it for relay.
     */
    suspend fun createCrowdReport(input: CrowdReportInput): CrowdReportResult = withContext(Dispatchers.IO) {
        val errors = CrowdReportFactory.validate(input)
        if (errors.isNotEmpty()) return@withContext CrowdReportResult.Invalid(errors)
        val key = try {
            deviceSigningKey(appContext)
        } catch (error: Exception) {
            return@withContext CrowdReportResult.SigningUnavailable(error.message ?: error.javaClass.simpleName)
        }
        inventoryLock.withLock {
            val now = Instant.now()
            if (activeReportCount(key.keyId(), now) >= MAX_OWN_ACTIVE_CROWD_REPORTS) {
                return@withLock CrowdReportResult.Invalid(
                    listOf("this device already has $MAX_OWN_ACTIVE_CROWD_REPORTS active reports"),
                )
            }
            val event = CrowdReportFactory.create(input, key, now)
            try {
                val chunk = CrowdChunkCodec.build(event, key)
                when (val result = commitChunk(chunk, now) { EventIngestor.ingest(store, event, trustStore, now) }) {
                    is IngestResult.Inserted -> {
                        CrowdReportResult.Created(event.getString("event_id"), result.state)
                    }
                    else -> CrowdReportResult.StorageUnavailable("report was not stored: $result")
                }
            } catch (error: Exception) {
                CrowdReportResult.StorageUnavailable(error.message ?: error.javaClass.simpleName)
            }
        }
    }

    /**
     * Every crowd report this node holds, own and relayed, as full signed
     * events. Debug-only upstream path (see debug/CrowdDebugReceiver): the
     * file is pulled over adb and handed to `pipeline/cli.mjs attest`.
     */
    suspend fun exportCrowdReports(): JSONObject = withContext(Dispatchers.IO) {
        val events = JSONArray()
        db.eventDao().forNamespaceSync(CrowdReportFactory.NAMESPACE)
            .forEach { events.put(JSONObject(it.eventJson)) }
        JSONObject()
            .put("schema_version", "event-batch-v0")
            .put("dataset_id", CrowdChunkCodec.DATASET_ID)
            .put("exported_at", DateTimeFormatter.ISO_INSTANT.format(Instant.now().truncatedTo(ChronoUnit.SECONDS)))
            .put("events", events)
    }

    /** Every stored event, for route planning (it re-derives apply state itself). */
    suspend fun allEventsSnapshot(): List<EventEntity> = withContext(Dispatchers.IO) {
        purgeUnsupportedOfficialEventData()
        purgeExpiredOfficialEvents(Instant.now())
        db.eventDao().allSync().filterNot(::isUnsupportedOfficialEventEntity)
    }

    /** Remove old non-NCDR official events and relay chunks from existing installs. */
    suspend fun purgeUnsupportedOfficialEventData(): Int = withContext(Dispatchers.IO) {
        inventoryLock.withLock {
            if (unsupportedOfficialEventsPurged) return@withLock 0

            val unsupportedEvents = db.eventDao().allSync().filter(::isUnsupportedOfficialEventEntity)
            val unsupportedChunks = chunkDao.allSync().filter { entity ->
                isUnsupportedOfficialNamespace(entity.namespace) ||
                    runCatching {
                        val chunk = JSONObject(chunkCacheFile(entity.datasetId, entity.namespace, entity.chunkId).readText())
                        val events = chunk.optJSONArray("events") ?: JSONArray()
                        (0 until events.length()).any { index ->
                            isUnsupportedOfficialEventJson(events.getJSONObject(index))
                        }
                    }.getOrDefault(false)
            }
            db.runInTransaction {
                unsupportedEvents.forEach { db.eventDao().deleteSync(it.namespace, it.eventId) }
                unsupportedChunks.forEach(::dropChunk)
            }
            unsupportedOfficialEventsPurged = true
            unsupportedEvents.size
        }
    }

    private fun isUnsupportedOfficialEventEntity(event: EventEntity): Boolean =
        event.namespace.startsWith("official.") &&
            runCatching {
                val payload = JSONObject(event.eventJson)
                event.namespace != payload.optString("namespace") || isUnsupportedOfficialEventJson(payload)
            }.getOrDefault(true)

    private fun isUnsupportedOfficialEventJson(event: JSONObject): Boolean {
        val namespace = event.optString("namespace")
        if (!namespace.startsWith("official.")) return false
        val isNcdrNamespace = namespace == "official.ncdr" ||
            namespace.startsWith("official.ncdr.") ||
            namespace == "official.live.ncdr" ||
            namespace.startsWith("official.live.ncdr.")
        return !isNcdrNamespace || !event.optString("source").equals("NCDR", ignoreCase = true)
    }

    private fun isUnsupportedOfficialNamespace(namespace: String): Boolean =
        namespace.startsWith("official.") &&
            namespace != "official.ncdr" && !namespace.startsWith("official.ncdr.") &&
            namespace != "official.live.ncdr" && !namespace.startsWith("official.live.ncdr.")

    /** Drop expired official payloads while preserving the signed version floor against peer replay. */
    fun purgeExpiredOfficialEvents(now: Instant = Instant.now()): Int {
        val expired = db.eventDao().allSync().filter { event ->
            event.namespace.startsWith("official.") &&
                ApplyState.at(event.namespace, event.expiresAt, now) == ApplyState.EXPIRED
        }
        if (expired.isEmpty()) return 0
        inventoryLock.withLock {
            db.runInTransaction {
                expired.forEach { event ->
                    store.rememberVersion(event.namespace, event.eventId, event.eventVersion)
                    db.eventDao().deleteSync(event.namespace, event.eventId)
                }
                // Chunks can contain expired signed payload bytes. Remove the
                // official relay inventory too; peers will fetch a current release.
                chunkDao.officialSync().forEach(::dropChunk)
            }
        }
        return expired.size
    }

    private fun activeReportCount(signingKeyId: String, now: Instant): Int =
        db.eventDao().forNamespaceSync(CrowdReportFactory.NAMESPACE).count { entity ->
            ApplyState.at(entity.namespace, entity.expiresAt, now) != ApplyState.EXPIRED &&
                JSONObject(entity.eventJson).optString("signing_key_id") == signingKeyId
        }

    /**
     * Bounded storage for relayed crowd reports: expired reports leave the
     * relay inventory first (their event rows stay, shown as EXPIRED), then the
     * oldest reports from other devices are dropped entirely until at most
     * [MAX_OTHER_CROWD_REPORTS] remain. This node's own reports never count
     * against, or get evicted by, that cap.
     */
    private fun pruneCrowdInventory(now: Instant) {
        val ownKeyId = runCatching { deviceSigningKey(appContext).keyId() }.getOrNull()
        val live = mutableListOf<Pair<ChunkEntity, String?>>()
        for (chunk in chunkDao.forDatasetSync(CrowdChunkCodec.DATASET_ID, CrowdChunkCodec.NAMESPACE)) {
            val eventId = CrowdChunkCodec.eventIdFor(chunk.chunkId)
            val event = eventId?.let { db.eventDao().findSync(chunk.namespace, it) }
            if (event == null || ApplyState.at(event.namespace, event.expiresAt, now) == ApplyState.EXPIRED) {
                dropChunk(chunk)
                continue
            }
            live += chunk to JSONObject(event.eventJson).optString("signing_key_id")
        }
        val others = live.filter { (_, signer) -> signer != ownKeyId }.sortedBy { it.first.receivedAtEpochMillis }
        others.take((others.size - MAX_OTHER_CROWD_REPORTS).coerceAtLeast(0)).forEach { (chunk, _) ->
            dropChunk(chunk)
            CrowdChunkCodec.eventIdFor(chunk.chunkId)?.let { db.eventDao().deleteSync(chunk.namespace, it) }
        }
    }

    private fun dropChunk(chunk: ChunkEntity) {
        chunkDao.deleteSync(chunk.datasetId, chunk.namespace, chunk.chunkId)
        deleteCachedFile(chunkCacheFile(chunk.datasetId, chunk.namespace, chunk.chunkId))
    }

    /** How many verified chunks this node currently holds — for status UI/logs. */
    suspend fun heldChunkCount(): Int = withContext(Dispatchers.IO) { chunkDao.countSync() }

    private fun JSONObject.toChunkEntity(now: Instant) = ChunkEntity(
        datasetId = getString("dataset_id"),
        namespace = getString("namespace"),
        chunkId = getString("chunk_id"),
        manifestId = getString("manifest_id"),
        datasetVersion = getInt("dataset_version"),
        chunkHash = getString("chunk_hash"),
        // byte_length is the signed, authoritative size; falling back to the
        // serialized length would let two nodes disagree on size_bytes for
        // the same chunk and see a phantom diff.
        sizeBytes = optLong("byte_length", toString().toByteArray(Charsets.UTF_8).size.toLong()),
        priority = getString("priority"),
        receivedAtEpochMillis = now.toEpochMilli(),
    )

    companion object {
        // Shared by every repository instance (bridge, service and debug harness).
        private val inventoryLock = ReentrantLock()
        /** Reports this device may have active at once; bounds what it can push onto neighbours. */
        const val MAX_OWN_ACTIVE_CROWD_REPORTS = 20

        /** Reports from other devices this node keeps and relays. */
        const val MAX_OTHER_CROWD_REPORTS = 200

        @Volatile
        private var sharedDeviceKey: DeviceSigningKey? = null

        /** Verified static layers already converted for the bridge, per process. */
        private val memoizedLayers = java.util.concurrent.ConcurrentHashMap<String, Pair<String, List<Map<String, Any?>>>>()

        /** One key per process: several MeshRepository instances must never race to create two. */
        private fun deviceSigningKey(context: Context): DeviceSigningKey =
            sharedDeviceKey ?: synchronized(this) {
                sharedDeviceKey ?: DeviceSigningKey.loadOrCreate(KeystoreWrappedStorage(context))
                    .also { sharedDeviceKey = it }
            }

        /** Schema caps this at 5; ADR-001's contact windows make 4 the practical limit. */
        private const val MAX_PEER_COUNT = 4

        /**
         * Largest chunk this node will accept. The Neihu scale dataset's
         * biggest chunk is 46.6 KB (ADR-001), so 1 MiB is headroom rather
         * than a real constraint — it exists to bound what a peer can ask
         * this node to buffer.
         */
        private const val MAX_CHUNK_BYTES = 1048576

        /** Total on-disk size [evictChunkCacheIfOverCap] will keep the chunk-bytes cache under. */
        // The nationwide government feed currently uses about 11 MB. Keep a
        // complete release relayable, plus room for crowdsourced/older chunks.
        private const val CHUNK_CACHE_CAP_BYTES = 32L * 1024 * 1024
        private val cacheByteCounts = java.util.concurrent.ConcurrentHashMap<String, Long>()

        /**
         * Datasets [allLocalPeerSummaries] always declares even with zero
         * chunks held, so a fresh node's HELLO says "I have nothing for
         * this" instead of omitting it — matching the identity the Peer
         * Sync milestone demo hardcoded (`PeerSyncMilestoneActivity`).
         */
        private val KNOWN_DATASETS = listOf(
            KnownDataset(
                datasetId = "resilientgeo-demo",
                namespace = "official",
                fallbackManifestId = "resilientgeo-demo:manifest:136",
                fallbackDatasetVersion = 136,
            ),
            // Crowd reports: one device-signed chunk per report, no manifest
            // (docs/peer-sync-v0.md). Declared even when empty so a fresh
            // node asks its neighbours for their reports.
            KnownDataset(
                datasetId = CrowdChunkCodec.DATASET_ID,
                namespace = CrowdChunkCodec.NAMESPACE,
                fallbackManifestId = CrowdChunkCodec.MANIFEST_ID,
                fallbackDatasetVersion = CrowdChunkCodec.DATASET_VERSION,
            ),
        )

        private const val FIXTURE_ASSET = "fixtures/signed-events.json"
        private const val TRUSTED_KEYS_ASSET = "trust/trusted-keys.json"
        private val STATIC_LAYER_IDS = listOf("taiwan-shelter", "taiwan-medical", "taiwan-medical-directory", "osm-poi", "osm-road")
        private val SERVER_STATIC_LAYER_IDS = setOf("taiwan-shelter", "taiwan-medical", "taiwan-medical-directory")
        private const val MEDICAL_DIRECTORY_LAYER_ID = "taiwan-medical-directory"
        private const val MAX_STATIC_JSON_BYTES = 16 * 1024 * 1024
        private const val MAX_STATIC_LAYER_CHUNKS = 512
    }
}

private data class KnownDataset(
    val datasetId: String,
    val namespace: String,
    val fallbackManifestId: String,
    val fallbackDatasetVersion: Int,
)

sealed class CrowdReportResult {
    data class Created(val eventId: String, val applyState: ApplyState) : CrowdReportResult()
    data class Invalid(val errors: List<String>) : CrowdReportResult()
    data class SigningUnavailable(val message: String) : CrowdReportResult()
    data class StorageUnavailable(val message: String) : CrowdReportResult()
}

sealed class ChunkIngestResult {
    data class Applied(val eventResults: List<IngestResult>) : ChunkIngestResult()
    data class Rejected(val reason: String) : ChunkIngestResult()
}
