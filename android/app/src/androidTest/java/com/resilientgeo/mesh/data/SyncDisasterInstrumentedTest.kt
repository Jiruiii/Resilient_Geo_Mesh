package com.resilientgeo.mesh.data

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.resilientgeo.mesh.emergency.AutoPeerSyncEngine
import com.resilientgeo.mesh.emergency.SyncStatusStore
import com.resilientgeo.mesh.routing.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class SyncDisasterInstrumentedTest {
    @Test fun cleanInstallDoesNotGuessShelterEligibilityBeforeSignedLayerDownload() = runBlocking {
        val context: Context = ApplicationProvider.getApplicationContext()
        File(context.noBackupFilesDir, "verified-layers").deleteRecursively()
        File(context.filesDir, "static-layer-bundles").deleteRecursively()
        val catalog = MeshRepository(context).verifiedShelterDisasterCatalog()
        val service = EvacuationRouteService(EvacuationRouteService.assetGraphLoader(context), { emptyList() }, shelterCatalogProvider = { catalog })
        val request = RouteRequest(LonLat(121.5910, 25.0610), "shelter:5427", LonLat(121.5908, 25.0609), "walk", "tsunami")
        val result = service.calculate(request)

        assertEquals(RouteStatus.OK, result.status)
        assertTrue(result.warnings.any { it.code == "SHELTER_DISASTER_UNKNOWN" })
        assertFalse(result.warnings.any { it.code == "SHELTER_DISASTER_MISMATCH" })
    }

    @Test fun syncHistorySurvivesStoreRecreationButStoppedServiceIsNotLive() {
        val context: Context = ApplicationProvider.getApplicationContext()
        val namespace = UUID.randomUUID().toString()
        val isolated = object : ContextWrapper(context) {
            override fun getApplicationContext(): Context = this
            override fun getSharedPreferences(name: String, mode: Int): SharedPreferences = super.getSharedPreferences("$name-$namespace", mode)
        }
        val store = SyncStatusStore(isolated)
        try {
            store.started()
            store.heartbeat(true, 2, AutoPeerSyncEngine.Stats(3, 4, 1))
            assertEquals(4, store.message()["chunks_received"])
            store.record(AutoPeerSyncEngine.SyncOutcome(false, "hello_timeout"))
            store.record(AutoPeerSyncEngine.SyncOutcome(true))
            store.stopped()
            val recreated = SyncStatusStore(isolated).message()
            assertNotNull(recreated["last_success_at"])
            assertEquals("hello_timeout", recreated["last_failure_code"])
            assertEquals(false, recreated["service_running"])
            assertEquals(0, recreated["chunks_received"])
        } finally {
            store.stopped()
            context.deleteSharedPreferences("sync_status-$namespace")
            context.deleteSharedPreferences("emergency_mode-$namespace")
        }
    }
}
