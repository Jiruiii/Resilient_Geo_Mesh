package com.resilientgeo.mesh.transport

import android.content.Context
import android.util.Log
import com.resilientgeo.mesh.bridge.AndroidEmergencyModeServiceCommand
import com.resilientgeo.mesh.bridge.SharedPreferencesEmergencyModeState
import com.resilientgeo.mesh.emergency.SyncStatusStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Single-phone opt-in regression for the historical INTERNAL_ERROR at startup. */
@RunWith(AndroidJUnit4::class)
class NearbyStartupInstrumentedTest {
    @Test fun automaticServiceFallsBackWhenNoNearbyPeerIsFound(): Unit = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("auto_smoke") == "true")
        val context: Context = ApplicationProvider.getApplicationContext()
        val settings = MeshTransportSettings(context)
        val state = SharedPreferencesEmergencyModeState(context)
        assertTrue("Stop Emergency Mode before the smoke test", !state.isEnabled)
        assertTrue("Nearby, Wi-Fi Direct and BLE must be ready", settings.nearbyReady() && settings.wifiReady() && settings.bleReady())
        val preferences = context.getSharedPreferences("emergency_mode", Context.MODE_PRIVATE)
        val previousMode = preferences.getString("transport_v2", null)
        val command = AndroidEmergencyModeServiceCommand(context)
        val status = SyncStatusStore(context)
        suspend fun waitFor(mode: String, timeout: Long): Map<String, Any?> = withTimeout(timeout) {
            while (true) {
                val snapshot = status.message()
                val active = snapshot["active_transports"] as? List<*> ?: emptyList<Any>()
                if (mode in active && MeshTransportSettings.BLE in active) return@withTimeout snapshot
                delay(250)
            }
            @Suppress("UNREACHABLE_CODE") error("unreachable")
        }
        try {
            settings.mode = MeshTransportSettings.AUTO
            state.isEnabled = true
            withContext(Dispatchers.Main.immediate) { command.start() }
            val initial = waitFor(MeshTransportSettings.NEARBY, 25_000)
            assertTrue("Run this no-peer test with only one phone", initial["nearby_peers"] == 0)
            val fallback = waitFor(MeshTransportSettings.WIFI_DIRECT, 45_000)
            assertTrue("Expected no-peer fallback", fallback["fallback_reason"] == "nearby_no_peer")
            Log.i("NearbyStartupTest", "AUTO_FALLBACK_OK active=${fallback["active_transports"]} reason=${fallback["fallback_reason"]}")
        } finally {
            withContext(Dispatchers.Main.immediate) { command.stop() }
            state.isEnabled = false
            preferences.edit().apply {
                if (previousMode == null) remove("transport_v2") else putString("transport_v2", previousMode)
            }.commit()
            withTimeout(10_000) {
                while (status.message()["service_running"] == true) delay(100)
            }
        }
    }

    @Test fun advertisingAndDiscoveryStartOnDevice(): Unit = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("nearby_smoke") == "true")
        val context: Context = ApplicationProvider.getApplicationContext()
        assertTrue("Enable Bluetooth/Wi-Fi and grant nearby/local-network permissions", MeshTransportSettings(context).nearbyReady())
        withContext(Dispatchers.Main.immediate) {
            val ready = CompletableDeferred<Unit>()
            val transport = NearbyConnectionsTransport(context) { ready.complete(Unit) }
            val discovery = launch { transport.discover().collect { } }
            try {
                withTimeout(25_000) { ready.await() }
                Log.i("NearbyStartupTest", "NEARBY_STARTUP_OK model=${android.os.Build.MODEL} api=${android.os.Build.VERSION.SDK_INT}")
            } finally {
                discovery.cancelAndJoin()
                transport.teardown()
            }
        }
    }
}
