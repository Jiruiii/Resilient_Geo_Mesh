package com.resilientgeo.mesh.data

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.resilientgeo.mesh.report.CrowdReportInput
import com.resilientgeo.mesh.report.CrowdReportFactory
import com.resilientgeo.mesh.report.CrowdChunkCodec
import com.resilientgeo.mesh.trust.DeviceSigningKey
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.Instant

/** Isolated Room and cache: fault injection never touches the user's stored events. */
@RunWith(AndroidJUnit4::class)
class RepositoryConsistencyInstrumentedTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private lateinit var db: AppDatabase
    private lateinit var cache: File
    private lateinit var repository: MeshRepository

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).build()
        cache = File.createTempFile("repository-test-", "", context.cacheDir).apply {
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
    // allowlist, so sign one fresh crowd chunk and reuse it within the test.
    private val signedChunk: String by lazy {
        val key = DeviceSigningKey.loadOrCreate(object : DeviceSigningKey.Storage {
            override fun read(): ByteArray? = null
            override fun write(seed: ByteArray) {}
        })
        val event = CrowdReportFactory.create(
            CrowdReportInput("ROAD_BLOCKAGE", "isolated consistency test", 121.5761, 25.0795, "MAP_PICK"), key, Instant.now(),
        )
        CrowdChunkCodec.build(event, key).toString()
    }

    private fun chunk() = JSONObject(signedChunk)

    private fun held(): List<String> = runBlocking {
        val datasets = repository.allLocalPeerSummaries("consistency-test").getJSONArray("datasets")
        (0 until datasets.length()).flatMap { index ->
            val chunks = datasets.getJSONObject(index).getJSONArray("chunks")
            (0 until chunks.length()).map { chunks.getJSONObject(it).getString("chunk_id") }
        }
    }

    @Test
    fun missingAndTruncatedBytesAreRemovedFromHello() = runBlocking {
        val fixture = chunk()
        repository.ingestChunk(fixture)
        assertTrue(held().contains(fixture.getString("chunk_id")))
        cache.listFiles()!!.single { it.extension == "json" }.delete()
        assertFalse(held().contains(fixture.getString("chunk_id")))
        repository.ingestChunk(fixture)
        cache.listFiles()!!.single { it.extension == "json" }.writeText("{")
        assertFalse(held().contains(fixture.getString("chunk_id")))
    }

    @Test
    fun anUnknownIdentityCannotDeleteAnotherChunksCache() = runBlocking {
        val fixture = chunk()
        repository.ingestChunk(fixture)
        val id = fixture.getString("chunk_id")
        assertNull(repository.cachedChunkJson(CrowdChunkCodec.DATASET_ID, CrowdChunkCodec.NAMESPACE, id.replace(':', '_')))
        assertNotNull(repository.cachedChunkJson(CrowdChunkCodec.DATASET_ID, CrowdChunkCodec.NAMESPACE, id))
        assertTrue(held().contains(id))
    }

    @Test
    fun legacyCacheNamesMigrateWithoutLosingRelayBytes() = runBlocking {
        val fixture = chunk()
        repository.ingestChunk(fixture)
        val legacyName = listOf(fixture.getString("dataset_id"), fixture.getString("namespace"), fixture.getString("chunk_id"))
            .joinToString("__") { part -> part.map { if (it.isLetterOrDigit() || it == '-' || it == '.') it else '_' }.joinToString("") } + ".json"
        assertTrue(cache.listFiles()!!.single().renameTo(File(cache, legacyName)))
        assertNotNull(repository.cachedChunkJson(CrowdChunkCodec.DATASET_ID, CrowdChunkCodec.NAMESPACE, fixture.getString("chunk_id")))
        assertFalse(File(cache, legacyName).exists())
        assertTrue(held().contains(fixture.getString("chunk_id")))
    }

    @Test
    fun evictionRemovesInventoryButPreservesVerifiedEvents() = runBlocking {
        val tinyCache = MeshRepository(context, db, cache, cacheCapBytes = 0)
        assertTrue(tinyCache.ingestChunk(chunk()) is ChunkIngestResult.Applied)
        assertEquals(0, db.chunkDao().countSync())
        assertTrue(db.eventDao().allSync().isNotEmpty())
        assertTrue(held().isEmpty())
    }

    @Test
    fun failedInventoryWriteRollsBackEventsAndCache() = runBlocking {
        db.openHelper.writableDatabase.execSQL("""
            CREATE TRIGGER fail_chunk_insert BEFORE INSERT ON chunks
            BEGIN SELECT RAISE(ABORT, 'injected write failure'); END
        """.trimIndent())
        val created = repository.createCrowdReport(CrowdReportInput("FLOOD", "isolated fault test", 121.5761, 25.0795, "CURRENT_LOCATION"))
        assertTrue("expected storage failure: $created", created is CrowdReportResult.StorageUnavailable)
        assertTrue(db.eventDao().allSync().isEmpty())
        assertEquals(0, db.chunkDao().countSync())
        assertTrue(cache.listFiles()!!.isEmpty())
    }

    @Test
    fun simultaneousReceivesAcrossRepositoriesProduceOneCompleteServableChunk() = runBlocking {
        val other = MeshRepository(context, db, cache)
        coroutineScope {
            (0 until 12).map { index -> async {
                (if (index % 2 == 0) repository else other).ingestChunk(chunk())
            } }.awaitAll().forEach { assertTrue(it is ChunkIngestResult.Applied) }
        }
        assertEquals(1, db.chunkDao().countSync())
        val fixture = chunk()
        assertNotNull(repository.cachedChunkJson(fixture.getString("dataset_id"), fixture.getString("namespace"), fixture.getString("chunk_id")))
        assertEquals(1, cache.listFiles()!!.size)
    }

    @Test
    fun simultaneousOldAndNewVersionsCannotRollBackTheStoredEvent() = runBlocking {
        val key = DeviceSigningKey.loadOrCreate(object : DeviceSigningKey.Storage {
            override fun read(): ByteArray? = null
            override fun write(seed: ByteArray) {}
        })
        val original = CrowdReportFactory.create(CrowdReportInput("FLOOD", "isolated version test", 121.5761, 25.0795, "CURRENT_LOCATION"), key, Instant.now())
        val newer = CrowdReportFactory.signEvent(JSONObject(original.toString()).put("event_version", 2), key)
        val oldChunk = CrowdChunkCodec.build(original, key)
        val newChunk = CrowdChunkCodec.build(newer, key)
        val other = MeshRepository(context, db, cache)
        coroutineScope {
            (0 until 20).map { index -> async {
                val selected = if (index % 2 == 0) oldChunk else newChunk
                (if (index % 3 == 0) repository else other).ingestChunk(JSONObject(selected.toString()))
            } }.awaitAll().forEach { assertTrue("unexpected result: $it", it is ChunkIngestResult.Applied ||
                (it is ChunkIngestResult.Rejected && it.reason == "event_version_rollback")) }
        }
        assertEquals(2, db.eventDao().allSync().single().eventVersion)
        val cached = repository.cachedChunkJson(CrowdChunkCodec.DATASET_ID, CrowdChunkCodec.NAMESPACE, oldChunk.getString("chunk_id"))!!
        assertEquals(2, cached.getJSONArray("events").getJSONObject(0).getInt("event_version"))
    }
}
