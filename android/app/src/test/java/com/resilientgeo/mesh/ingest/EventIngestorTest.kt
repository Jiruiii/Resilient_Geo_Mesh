package com.resilientgeo.mesh.ingest

import com.resilientgeo.mesh.trust.TestFixtures
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/**
 * Replays the same six-event sequence (insert, expired-insert, insert,
 * separate-namespace insert, version update, rollback attempt) that
 * `scratch-generate-android-fixture.mjs` ran through the Node
 * `ingestEvent()` when generating these fixtures — see the printed log in
 * that script's output. The apply-rule outcomes here must match exactly.
 */
class EventIngestorTest {

    private val trustStore = TestFixtures.trustedKeyStore()
    private val now = Instant.parse("2026-09-04T12:00:00Z")

    @Test
    fun `replays the fixture sequence with the same outcomes as the Node generator`() {
        val store = InMemoryEventStore()

        val roadV1 = TestFixtures.event("official.tdx", "road:dahu-01", 1)
        val shelter = TestFixtures.event("official.fire", "shelter:wende-01", 1)
        val rain = TestFixtures.event("official.cwa", "flood:neihu-0901-001", 1)
        val crowd = TestFixtures.event("crowd.reports", "road:dahu-01", 1)
        val roadV2 = TestFixtures.event("official.tdx", "road:dahu-01", 2)

        val insertRoad = EventIngestor.ingest(store, roadV1, trustStore, now)
        assertTrue(insertRoad is IngestResult.Inserted)
        assertEquals(ApplyState.CURRENT, (insertRoad as IngestResult.Inserted).state)

        val insertShelter = EventIngestor.ingest(store, shelter, trustStore, now)
        assertTrue(insertShelter is IngestResult.Inserted)
        assertEquals(ApplyState.EXPIRED, (insertShelter as IngestResult.Inserted).state)

        val insertRain = EventIngestor.ingest(store, rain, trustStore, now)
        assertTrue(insertRain is IngestResult.Inserted)
        assertEquals(ApplyState.CURRENT, (insertRain as IngestResult.Inserted).state)

        val insertCrowd = EventIngestor.ingest(store, crowd, trustStore, now)
        assertTrue(insertCrowd is IngestResult.Inserted)
        val crowdInserted = insertCrowd as IngestResult.Inserted
        assertEquals(ApplyState.UNVERIFIED, crowdInserted.state)
        assertTrue("crowd report shares event_id with official.tdx/road:dahu-01 but must land in its own namespace", crowdInserted.insertedIntoSeparateNamespace)

        val update = EventIngestor.ingest(store, roadV2, trustStore, now)
        assertTrue(update is IngestResult.Updated)
        assertEquals(1, (update as IngestResult.Updated).fromVersion)
        assertEquals(2, update.toVersion)

        val rollback = EventIngestor.ingest(store, roadV1, trustStore, now)
        assertTrue(rollback is IngestResult.RejectedVersionRollback)
        assertEquals(2, (rollback as IngestResult.RejectedVersionRollback).storedVersion)
        assertEquals(1, rollback.incomingVersion)

        // The store must still hold the newer version — a rollback must not mutate it.
        val stored = store.find("official.tdx", "road:dahu-01")
        assertEquals(2, stored?.eventVersion)

        // official.* and crowd.* namespaces coexist under the same event_id.
        assertEquals(2, store.all().count { it.eventId == "road:dahu-01" })
    }

    @Test
    fun `rejects same-version replays without touching the store`() {
        val store = InMemoryEventStore()
        val roadV1 = TestFixtures.event("official.tdx", "road:dahu-01", 1)
        EventIngestor.ingest(store, roadV1, trustStore, now)

        val replay = EventIngestor.ingest(store, roadV1, trustStore, now)
        assertTrue(replay is IngestResult.RejectedSameVersionConflict)
    }

    @Test
    fun `version floors reject older peer replays and allow a higher signed version`() {
        val store = InMemoryEventStore()
        store.rememberVersion("official.tdx", "road:dahu-01", 2)

        val replay = EventIngestor.ingest(
            store,
            TestFixtures.event("official.tdx", "road:dahu-01", 1),
            trustStore,
            now,
        )

        assertTrue(replay is IngestResult.RejectedVersionRollback)
        assertEquals(2, (replay as IngestResult.RejectedVersionRollback).storedVersion)
        assertTrue("an older replay must not recreate an event payload", store.all().isEmpty())

        val lowerFloorStore = InMemoryEventStore()
        lowerFloorStore.rememberVersion("official.tdx", "road:dahu-01", 1)
        val newer = EventIngestor.ingest(
            lowerFloorStore,
            TestFixtures.event("official.tdx", "road:dahu-01", 2),
            trustStore,
            now,
        )
        assertTrue(newer is IngestResult.Inserted)
        assertEquals(2, lowerFloorStore.find("official.tdx", "road:dahu-01")?.eventVersion)
    }

    @Test
    fun `a tampered event is rejected before it ever reaches the store`() {
        val store = InMemoryEventStore()
        val tampered = org.json.JSONObject(TestFixtures.event("official.cwa", "flood:neihu-0901-001", 1).toString())
        tampered.getJSONObject("attributes").put("rainfall_mm_per_hour", 999)

        val result = EventIngestor.ingest(store, tampered, trustStore, now)
        assertTrue(result is IngestResult.RejectedVerification)
        assertEquals(0, store.all().size)
    }
}
