package com.resilientgeo.mesh.data

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.resilientgeo.mesh.report.CrowdChunkCodec
import com.resilientgeo.mesh.report.CrowdReportFactory
import com.resilientgeo.mesh.report.CrowdReportInput
import com.resilientgeo.mesh.trust.DeviceSigningKey
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.Instant

/**
 * Covers the two additions `AutoPeerSyncEngine` needs beyond the two-device
 * Peer Sync milestone: a HELLO that enumerates every dataset this node
 * holds (not one hardcoded pair), and a cache that can actually hand a
 * chunk's bytes back out to serve a REQUEST — the milestone demo never
 * needed this because Node B always served straight from `assets/`, never
 * from what it had itself received.
 *
 * Runs against a real device/emulator with an isolated in-memory Room and a
 * temporary cache directory, so it never writes into the installed app's data.
 */
@RunWith(AndroidJUnit4::class)
class AutoSyncRepositoryInstrumentedTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private lateinit var db: AppDatabase
    private lateinit var cache: File
    private lateinit var repository: MeshRepository

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).build()
        cache = File.createTempFile("auto-sync-test-", "", context.cacheDir).apply {
            delete()
            mkdirs()
        }
        repository = MeshRepository(context, db, cache)
    }

    @After
    fun tearDown() {
        db.close()
        cache.deleteRecursively()
    }

    // Historical official.* demo fixtures are rejected by today's source
    // allowlist, so exercise the supported signed crowd-report path instead.
    private fun freshSignedChunk(): JSONObject {
        val key = DeviceSigningKey.loadOrCreate(object : DeviceSigningKey.Storage {
            override fun read(): ByteArray? = null
            override fun write(seed: ByteArray) {}
        })
        val event = CrowdReportFactory.create(
            CrowdReportInput("FLOOD", "isolated auto-sync test", 121.5761, 25.0795, "MAP_PICK"), key, Instant.now(),
        )
        return CrowdChunkCodec.build(event, key)
    }

    @Test
    fun allLocalPeerSummariesDeclaresTheKnownDatasetEvenWithNothingHeldForIt() {
        // A brand-new node has never ingested anything for some other
        // dataset it might still be asked about — this only pins the
        // well-known demo dataset/namespace, which every node declares
        // regardless of inventory (see MeshRepository.KNOWN_DATASETS).
        val summary = runBlocking { repository.allLocalPeerSummaries("node-under-test") }
        val datasets = summary.getJSONArray("datasets")
        val demo = (0 until datasets.length())
            .map { datasets.getJSONObject(it) }
            .first { it.getString("dataset_id") == "resilientgeo-demo" && it.getString("namespace") == "official" }
        assertTrue(demo.has("manifest_id"))
        assertTrue(demo.has("chunks"))
    }

    @Test
    fun ingestedChunkBecomesServableAndAppearsInTheFullSummary() {
        val chunk = freshSignedChunk()
        val chunkId = chunk.getString("chunk_id")

        val result = runBlocking { repository.ingestChunk(chunk) }
        assertTrue("expected the freshly signed chunk to verify: $result", result is ChunkIngestResult.Applied)

        // AutoPeerSyncEngine.serveRequest reads exactly this, to answer a
        // peer's REQUEST for a chunk this node has already verified.
        val cached = runBlocking { repository.cachedChunkJson(CrowdChunkCodec.DATASET_ID, CrowdChunkCodec.NAMESPACE, chunkId) }
        assertNotNull("expected $chunkId to be servable after ingest", cached)
        assertEquals(chunk.getString("chunk_hash"), cached!!.getString("chunk_hash"))

        val summary = runBlocking { repository.allLocalPeerSummaries("node-under-test") }
        val datasets = summary.getJSONArray("datasets")
        val crowd = (0 until datasets.length())
            .map { datasets.getJSONObject(it) }
            .first { it.getString("dataset_id") == CrowdChunkCodec.DATASET_ID && it.getString("namespace") == CrowdChunkCodec.NAMESPACE }
        val chunkIds = (0 until crowd.getJSONArray("chunks").length())
            .map { crowd.getJSONArray("chunks").getJSONObject(it).getString("chunk_id") }
        assertTrue("expected $chunkId in $chunkIds", chunkIds.contains(chunkId))
    }

    @Test
    fun aChunkNeverIngestedIsNotServable() {
        val cached = runBlocking {
            repository.cachedChunkJson("resilientgeo-demo", "official", "resilientgeo-demo:chunk:does-not-exist")
        }
        assertNull(cached)
    }
}
