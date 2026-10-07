package com.resilientgeo.mesh.data

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.time.Instant
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class OfficialEventExpiryInstrumentedTest {

    @Test
    fun expiredOfficialPayloadIsRemovedAndItsVersionFloorRemains() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val database = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        try {
            val now = Instant.parse("2026-10-04T12:00:00Z")
            database.eventDao().upsertSync(
                EventEntity(
                    namespace = "official.ncdr",
                    eventId = "ncdr:expired",
                    eventVersion = 7,
                    eventType = "NCDR_HAZARD",
                    severity = "HIGH",
                    expiresAt = now.toString(),
                    applyState = "CURRENT",
                    eventJson = """{"event_id":"ncdr:expired"}""",
                    storedAtEpochMillis = now.toEpochMilli(),
                ),
            )
            database.eventDao().upsertSync(
                EventEntity(
                    namespace = "crowd.reports",
                    eventId = "crowd:expired",
                    eventVersion = 2,
                    eventType = "LOCAL_HAZARD_REPORT",
                    severity = "MEDIUM",
                    expiresAt = now.toString(),
                    applyState = "CURRENT",
                    eventJson = """{"event_id":"crowd:expired"}""",
                    storedAtEpochMillis = now.toEpochMilli(),
                ),
            )

            val removed = MeshRepository(context, database).purgeExpiredOfficialEvents(now)

            assertEquals(1, removed)
            assertNull(database.eventDao().findSync("official.ncdr", "ncdr:expired"))
            assertEquals(7, database.eventDao().versionFloorSync("official.ncdr", "ncdr:expired"))
            assertNotNull(database.eventDao().findSync("crowd.reports", "crowd:expired"))
        } finally {
            database.close()
        }
    }
}
