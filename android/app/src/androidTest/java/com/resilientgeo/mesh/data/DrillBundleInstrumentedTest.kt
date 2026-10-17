package com.resilientgeo.mesh.data

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.resilientgeo.mesh.trust.TrustedKeyStore
import com.resilientgeo.mesh.protocol.ChunkVerifier
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** Opt-in Node publisher → Android verifier/Room/cache contract, no radio or production DB writes. */
@RunWith(AndroidJUnit4::class)
class DrillBundleInstrumentedTest {
    @Test fun localPublisherBundleVerifiesAndCannotEnterProductionTrust(): Unit = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("drill_contract") == "true")
        val context: Context = ApplicationProvider.getApplicationContext()
        val connection = URL("http://127.0.0.1:8788/api/bundle").openConnection() as HttpURLConnection
        connection.connectTimeout = 5000; connection.readTimeout = 5000
        val bundle = try { JSONObject(connection.inputStream.bufferedReader().use { it.readText() }) } finally { connection.disconnect() }
        assertTrue(bundle.getBoolean("exercise"))
        val keys = bundle.getJSONObject("trusted_keys").toString()
        val chunks = bundle.getJSONArray("chunks")
        assertTrue("Seed the local exercise ledger before running", chunks.length() >= 2)
        val db = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).build()
        val cache = File.createTempFile("drill-contract-", "", context.cacheDir).apply { delete(); mkdirs() }
        try {
            val repo = MeshRepository(context, db, cache, trustedKeysJson = keys)
            val productionTrust = TrustedKeyStore.fromJson(context.assets.open("trust/trusted-keys.json").bufferedReader().use { it.readText() })
            for (i in 0 until chunks.length()) {
                val chunk = chunks.getJSONObject(i)
                assertTrue(ChunkVerifier.verify(chunk, productionTrust) is ChunkVerifier.Result.Invalid)
                val result = repo.ingestChunk(chunk)
                assertTrue("$result", result is ChunkIngestResult.Applied)
                assertNotNull(repo.cachedChunkJson("exercise-local", "drill.exercise", chunk.getString("chunk_id")))
            }
            val before = repo.allEventsSnapshot()
            assertTrue(before.any { it.eventType == "SUPPLY_STATUS" })
            assertTrue(before.any { it.eventType == "SHELTER_STATUS" })
            assertTrue(before.all { it.namespace == "drill.exercise" })
            for (i in 0 until chunks.length()) repo.ingestChunk(chunks.getJSONObject(i))
            assertEquals(before.size, repo.allEventsSnapshot().size)
            val tampered = JSONObject(chunks.getJSONObject(0).toString())
            tampered.getJSONArray("events").getJSONObject(0).getJSONObject("attributes").put("status", "TAMPERED")
            assertTrue(repo.ingestChunk(tampered) is ChunkIngestResult.Rejected)
            assertEquals(before.map { it.eventJson }.sorted(), repo.allEventsSnapshot().map { it.eventJson }.sorted())
            android.util.Log.i("MeshDrillContract", "PASS chunks=${chunks.length()} events=${before.size} trust-isolated tamper-rejected replay-stable")
        } finally { db.close(); cache.deleteRecursively() }
    }
}
