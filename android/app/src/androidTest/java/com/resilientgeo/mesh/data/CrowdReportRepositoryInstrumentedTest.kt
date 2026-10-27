package com.resilientgeo.mesh.data

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.resilientgeo.mesh.ingest.ApplyState
import com.resilientgeo.mesh.report.CrowdChunkCodec
import com.resilientgeo.mesh.report.CrowdReportFactory
import com.resilientgeo.mesh.report.CrowdReportInput
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * On-device check of the local report path: Android Keystore-wrapped device
 * key, Room, and the chunk cache. The JVM tests cover the pure pieces.
 *
 * Reports go into an isolated in-memory Room and a temporary cache, so the
 * installed app never shows or relays them and repeated runs stay independent
 * of the MeshRepository.MAX_OWN_ACTIVE_CROWD_REPORTS limit.
 */
@RunWith(AndroidJUnit4::class)
class CrowdReportRepositoryInstrumentedTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private lateinit var db: AppDatabase
    private lateinit var cache: File
    private lateinit var repository: MeshRepository

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).build()
        cache = File.createTempFile("crowd-report-test-", "", context.cacheDir).apply {
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

    private fun input(description: String = "instrumented test report") =
        CrowdReportInput("FLOOD", description, 121.5761, 25.0795, "CURRENT_LOCATION")

    @Test
    fun aSubmittedReportIsStoredAsUnverifiedAndAdvertisedForRelay() {
        val created = runBlocking { repository.createCrowdReport(input()) }
        assertTrue("expected Created, got $created", created is CrowdReportResult.Created)
        created as CrowdReportResult.Created
        assertEquals(ApplyState.UNVERIFIED, created.applyState)

        val stored = runBlocking { repository.observeEvents().first() }
            .single { it.namespace == CrowdReportFactory.NAMESPACE && it.eventId == created.eventId }
        assertEquals(ApplyState.UNVERIFIED.name, stored.applyState)
        val event = JSONObject(stored.eventJson)
        assertTrue(event.getString("signing_key_id").startsWith("device:"))

        val summary = runBlocking { repository.allLocalPeerSummaries("node-under-test") }
        val datasets = summary.getJSONArray("datasets")
        val crowd = (0 until datasets.length()).map { datasets.getJSONObject(it) }
            .single { it.getString("dataset_id") == CrowdChunkCodec.DATASET_ID }
        val chunks = crowd.getJSONArray("chunks")
        val chunkId = CrowdChunkCodec.chunkIdFor(created.eventId)
        assertTrue((0 until chunks.length()).any { chunks.getJSONObject(it).getString("chunk_id") == chunkId })
        assertNotNull(runBlocking { repository.cachedChunkJson(CrowdChunkCodec.DATASET_ID, CrowdChunkCodec.NAMESPACE, chunkId) })
    }

    @Test
    fun theDeviceKeySurvivesANewRepositoryInstance() {
        val first = runBlocking { repository.createCrowdReport(input("first")) } as CrowdReportResult.Created
        val second = runBlocking { MeshRepository(context, db, cache).createCrowdReport(input("second")) } as CrowdReportResult.Created
        fun keyOf(eventId: String) = runBlocking { repository.observeEvents().first() }
            .single { it.eventId == eventId }
            .let { JSONObject(it.eventJson).getString("signing_key_id") }
        assertEquals(keyOf(first.eventId), keyOf(second.eventId))
    }

    @Test
    fun invalidInputIsRejectedWithoutSigning() {
        val result = runBlocking { repository.createCrowdReport(input("字".repeat(161))) }
        assertTrue(result is CrowdReportResult.Invalid)
    }

    @Test
    fun exportContainsFullSignedReports() {
        val created = runBlocking { repository.createCrowdReport(input("export me")) } as CrowdReportResult.Created
        val batch = runBlocking { repository.exportCrowdReports() }
        val events = batch.getJSONArray("events")
        val exported = (0 until events.length()).map { events.getJSONObject(it) }
            .single { it.getString("event_id") == created.eventId }
        assertTrue(exported.has("signature"))
        assertTrue(exported.has("signer_public_key"))
    }
}
