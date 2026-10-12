package com.resilientgeo.mesh.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.resilientgeo.mesh.report.CrowdChunkCodec
import com.resilientgeo.mesh.report.RescueAction
import com.resilientgeo.mesh.trust.RescueContract
import com.resilientgeo.mesh.trust.RescueRequestInput
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device check of the rescue path: Keystore-wrapped key, Room, chunk cache,
 * one-ACTIVE rule and lifecycle. Clears Room rows for crowd.rescue first so
 * repeated runs stay independent of the one-ACTIVE limit.
 */
@RunWith(AndroidJUnit4::class)
class RescueRequestRepositoryInstrumentedTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val repository = MeshRepository(context)
    private val db = AppDatabase.get(context)

    private fun input(description: String = "instrumented rescue") = RescueRequestInput(
        requestType = "TRAPPED_DEBRIS",
        subject = "SELF",
        peopleCount = 1,
        triage = mapOf("immobile" to "YES", "breathing_difficulty" to "NO", "severe_bleeding" to "NO", "conscious" to "YES"),
        description = description,
        lon = 121.5761,
        lat = 25.0795,
        locationSource = "CURRENT_LOCATION",
    )

    @Before
    fun clearRescueRows() {
        db.eventDao().forNamespaceSync(RescueContract.NAMESPACE).forEach {
            db.eventDao().deleteSync(it.namespace, it.eventId)
        }
    }

    @Test
    fun createsOneActiveRequestAndAdvertisesItForRelay() {
        val saved = runBlocking { repository.createRescueRequest(input()) }
        assertTrue("expected Saved, got $saved", saved is RescueResult.Saved)
        saved as RescueResult.Saved
        val event = JSONObject(saved.event.eventJson)
        assertEquals("CRITICAL", event.getString("severity"))
        assertEquals("UNVERIFIED", saved.event.applyState)

        val second = runBlocking { repository.createRescueRequest(input("second")) }
        assertTrue("expected Conflict, got $second", second is RescueResult.Conflict)

        val chunkId = CrowdChunkCodec.chunkIdFor(saved.event.eventId, RescueContract.NAMESPACE)
        assertNotNull(runBlocking { repository.cachedChunkJson(RescueContract.DATASET_ID, RescueContract.NAMESPACE, chunkId) })
        assertEquals(listOf(saved.event.eventId), runBlocking { repository.ownRescueRequests() }.map { it.eventId })
    }

    @Test
    fun revisionsRespectCooldownAndEndTheLifecycle() {
        val saved = runBlocking { repository.createRescueRequest(input()) } as RescueResult.Saved
        val tooSoon = runBlocking { repository.reviseRescueRequest(saved.event.eventId, RescueAction.RESOLVE, null) }
        assertTrue("expected RateLimited, got $tooSoon", tooSoon is RescueResult.RateLimited)
        Thread.sleep(31_000)
        val resolved = runBlocking { repository.reviseRescueRequest(saved.event.eventId, RescueAction.RESOLVE, null) }
        assertTrue("expected Saved, got $resolved", resolved is RescueResult.Saved)
        resolved as RescueResult.Saved
        assertEquals(2, resolved.event.eventVersion)
        assertEquals("RESOLVED", JSONObject(resolved.event.eventJson).getJSONObject("attributes").getString("status"))
        // The resolve just signed a version, so wait out the cooldown once more.
        Thread.sleep(31_000)
        val fresh = runBlocking { repository.createRescueRequest(input("after resolve")) }
        assertTrue("a resolved request no longer blocks a new one: $fresh", fresh is RescueResult.Saved)
    }
}
