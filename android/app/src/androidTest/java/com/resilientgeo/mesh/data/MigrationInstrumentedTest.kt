package com.resilientgeo.mesh.data

import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Exercises the real v1 -> v3 upgrade path against a v1 database file.
 *
 * The other instrumented tests use `inMemoryDatabaseBuilder`, which always
 * creates the schema from scratch and therefore never runs a migration at
 * all — so a wrong `CREATE TABLE` in [AppDatabase.MIGRATION_1_2] would pass
 * every test and then crash on the first phone that upgraded rather than
 * reinstalled ("Migration didn't properly handle ...").
 *
 * The assertion that matters is not just "it opened": it is that the events
 * already on the device are still there afterwards. `system.md`'s phase-1
 * acceptance criterion is that data survives with no network, and a
 * destructive fallback migration would have silently traded that away for
 * a one-line fix.
 */
@RunWith(AndroidJUnit4::class)
class MigrationInstrumentedTest {

    private val dbName = "migration-test.db"
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    /** Exactly the `events` table as Room generated it at version 1. */
    private val v1EventsTable = """
        CREATE TABLE IF NOT EXISTS `events` (
            `namespace` TEXT NOT NULL, `eventId` TEXT NOT NULL,
            `eventVersion` INTEGER NOT NULL, `eventType` TEXT NOT NULL,
            `severity` TEXT NOT NULL, `expiresAt` TEXT NOT NULL,
            `applyState` TEXT NOT NULL, `eventJson` TEXT NOT NULL,
            `storedAtEpochMillis` INTEGER NOT NULL,
            PRIMARY KEY(`namespace`, `eventId`)
        )
    """.trimIndent()

    @Before
    fun setUp() {
        context.deleteDatabase(dbName)
    }

    @After
    fun tearDown() {
        context.deleteDatabase(dbName)
    }

    private fun createV1DatabaseHoldingOneEvent() {
        val path = context.getDatabasePath(dbName)
        path.parentFile?.mkdirs()
        val db = SQLiteDatabase.openOrCreateDatabase(path, null)
        db.execSQL(v1EventsTable)
        db.execSQL(
            "INSERT INTO events VALUES " +
                "('official.tdx','road:dahu-01',2,'ROAD_CLOSED','HIGH'," +
                "'2099-01-01T00:00:00Z','CURRENT','{\"event_id\":\"road:dahu-01\"}',1756000000000)",
        )
        db.version = 1
        db.close()
    }

    private fun openLatest(): AppDatabase =
        Room.databaseBuilder(context, AppDatabase::class.java, dbName)
            .addMigrations(AppDatabase.MIGRATION_1_2, AppDatabase.MIGRATION_2_3)
            .build()

    @Test
    fun upgradingFromV1KeepsExistingEvents() {
        createV1DatabaseHoldingOneEvent()

        val db = openLatest()
        try {
            val events = db.eventDao().allSync()
            assertEquals(1, events.size)
            assertEquals("official.tdx", events.single().namespace)
            assertEquals("road:dahu-01", events.single().eventId)
            assertEquals(2, events.single().eventVersion)
        } finally {
            db.close()
        }
    }

    @Test
    fun upgradingFromV1AddsAUsableChunkInventory() {
        createV1DatabaseHoldingOneEvent()

        val db = openLatest()
        try {
            // Room validates the migrated schema against what it expects for
            // v3 when the database is first opened, so simply getting here
            // proves the hand-written CREATE TABLE matches. Writing and
            // reading a row proves it is actually usable.
            assertEquals(0, db.chunkDao().countSync())
            db.chunkDao().upsertSync(
                ChunkEntity(
                    datasetId = "resilientgeo-demo",
                    namespace = "official",
                    chunkId = "resilientgeo-demo:chunk:136:dahu:shelter:000",
                    manifestId = "resilientgeo-demo:manifest:136",
                    datasetVersion = 136,
                    chunkHash = "sha256:abc",
                    sizeBytes = 1147,
                    priority = "CRITICAL",
                    receivedAtEpochMillis = 1_756_000_000_000L,
                ),
            )
            assertEquals(1, db.chunkDao().countSync())
        } finally {
            db.close()
        }
    }

    @Test
    fun aFreshInstallStillCreatesBothTables() {
        // No v1 file at all — the normal install path must not depend on the
        // migration having run.
        val db = openLatest()
        try {
            assertEquals(0, db.eventDao().allSync().size)
            assertEquals(0, db.chunkDao().countSync())
        } finally {
            db.close()
        }
    }
}
