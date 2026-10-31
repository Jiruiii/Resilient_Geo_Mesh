package com.resilientgeo.mesh.data

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.resilientgeo.mesh.emergency.AutoPeerSyncEngine
import com.resilientgeo.mesh.measure.MeasurementPayload
import com.resilientgeo.mesh.measure.MeasurementSigner
import com.resilientgeo.mesh.measure.ServiceMeasurementLog
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.Instant

/** The measurement payload goes through the real repository, and only under the measurement key. */
@RunWith(AndroidJUnit4::class)
class MeasurementPayloadInstrumentedTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    @Test fun reSignedTierIngestsIntoIsolatedRepositoryAndNotProductionTrust(): Unit = runBlocking {
        val signer = MeasurementSigner.shared()
        val manifest = JSONObject(context.assets.open("${MeasurementPayload.ASSET_DIR}/manifest.json").bufferedReader().use { it.readText() })
        val ids = MeasurementPayload.KB50.chunkIds(manifest)
        val dir = File.createTempFile("measure-", "", context.cacheDir).apply { delete(); mkdirs() }
        // Same file-backed database the harness uses for large tiers.
        val db = Room.databaseBuilder(context, AppDatabase::class.java, File(dir, "measure.db").absolutePath).build()
        val productionDb = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).build()
        try {
            val repo = MeshRepository(context, db, File(dir, "chunks"), cacheCapBytes = Long.MAX_VALUE,
                trustedKeysJson = signer.trustedKeysJson)
            val production = MeshRepository(context, productionDb, File(dir, "production"))
            val now = Instant.now()
            for (id in ids) {
                val source = context.assets.open(MeasurementPayload.assetPath(id)).bufferedReader().use { it.readText() }
                val chunk = signer.resign(JSONObject(source), now)
                assertTrue(production.ingestChunk(JSONObject(chunk.toString())) is ChunkIngestResult.Rejected)
                val result = repo.ingestChunk(chunk)
                assertTrue("$id: $result", result is ChunkIngestResult.Applied)
                assertNotNull(repo.cachedChunkJson(MeasurementSigner.DATASET_ID, MeasurementSigner.NAMESPACE, chunk.getString("chunk_id")))
            }
            val datasets = repo.allLocalPeerSummaries("measure-node").getJSONArray("datasets")
            val measurement = (0 until datasets.length()).map { datasets.getJSONObject(it) }
                .single { it.getString("dataset_id") == MeasurementSigner.DATASET_ID }
            assertEquals(ids.size, measurement.getJSONArray("chunks").length())
            assertEquals(0, production.heldChunkCount())
        } finally {
            db.close(); productionDb.close(); dir.deleteRecursively()
        }
    }

    @Test fun serviceLogWritesOnlyWhenEnabled() {
        // A temp directory keeps test rows out of real measurement files on the phone.
        val dir = File.createTempFile("measure-log-", "", context.cacheDir).apply { delete(); mkdirs() }
        val log = ServiceMeasurementLog(context, dir)
        val previous = log.enabled
        val stats = AutoPeerSyncEngine.Stats(peersSynced = 1, chunksApplied = 2, activeSessions = 0)
        try {
            assertTrue("debug builds offer the log", log.available)
            log.enabled = false
            log.outcome("ble", AutoPeerSyncEngine.SyncOutcome(true), stats)
            assertEquals(0, dir.listFiles()!!.size)

            log.enabled = true
            log.outcome("ble", AutoPeerSyncEngine.SyncOutcome(false, "hello_timeout"), stats)
            log.sample("sample", listOf("ble", "nearby"), 1, stats)
            val lines = dir.listFiles()!!.single().readLines()
            assertEquals("﻿" + ServiceMeasurementLog.HEADER.joinToString(","), lines[0])
            assertTrue(lines[1], lines[1].contains(",outcome,ble,false,hello_timeout,,0,1,2,"))
            assertTrue(lines[2], lines[2].contains(",sample,ble+nearby,,,1,0,1,2,"))
        } finally {
            log.enabled = previous
            dir.deleteRecursively()
        }
    }
}
