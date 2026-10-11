package com.resilientgeo.mesh.data

import android.bluetooth.BluetoothManager
import android.content.Context
import android.util.Log
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.resilientgeo.mesh.emergency.AutoPeerSyncEngine
import com.resilientgeo.mesh.transport.BleGattTransport
import com.resilientgeo.mesh.transport.NearbyConnectionsTransport
import com.resilientgeo.mesh.transport.WifiDirectTransport
import com.resilientgeo.mesh.transport.PeerTransport
import com.resilientgeo.mesh.transport.MeshTransportSettings
import com.resilientgeo.mesh.transport.OfflineWifiTestNetwork
import com.resilientgeo.mesh.report.CrowdChunkCodec
import com.resilientgeo.mesh.report.CrowdReportFactory
import com.resilientgeo.mesh.report.CrowdReportInput
import com.resilientgeo.mesh.trust.DeviceSigningKey
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.Instant

/** Run on two devices concurrently with -e peer_seed flood / road. Uses isolated data. */
@RunWith(AndroidJUnit4::class)
class RealPeerSyncInstrumentedTest {
    @Test
    fun twoDevicesExchangeMissingChunksAndASecondEncounterRequestsNothing() = runBlocking {
        val seed = InstrumentationRegistry.getArguments().getString("peer_seed")
        assumeTrue("Opt-in paired-device test", seed in listOf("flood", "road", "shelter"))
        val context: Context = ApplicationProvider.getApplicationContext()
        val wifi = InstrumentationRegistry.getArguments().getString("peer_transport") == "wifi_direct"
        val nearby = InstrumentationRegistry.getArguments().getString("peer_transport") == "nearby"
        val adapter = context.getSystemService(BluetoothManager::class.java).adapter
        if (nearby) assertTrue("Nearby must be ready", MeshTransportSettings(context).nearbyReady())
        else if (wifi) assertTrue("Wi-Fi Direct permissions, Wi-Fi and Location must be enabled", MeshTransportSettings(context).wifiReady())
        else assertTrue("Bluetooth must be enabled", adapter.isEnabled)
        val db = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).build()
        val cache = File.createTempFile("peer-test-", "", context.cacheDir).apply { delete(); mkdirs() }
        val repository = MeshRepository(context, db, cache)
        var scope: CoroutineScope? = null
        var transport: PeerTransport? = null
        suspend fun teardown() = withContext(Dispatchers.Main.immediate) {
            when (val radio = transport) {
                is BleGattTransport -> radio.teardown()
                is WifiDirectTransport -> radio.teardown()
                is NearbyConnectionsTransport -> radio.teardown()
                else -> Unit
            }
        }
        val logs = java.util.concurrent.CopyOnWriteArrayList<String>()
        val offline = if ((wifi || nearby) && InstrumentationRegistry.getArguments().getString("peer_offline") == "true")
            OfflineWifiTestNetwork(context) else null
        try {
            offline?.disconnect()
            if (offline != null) Log.i("RealPeerSyncTest", "[$seed] OFFLINE_CONFIRMED")
            // Historical official.* demo fixtures are intentionally rejected by
            // today's source allowlist. Exercise the real, currently supported
            // signed crowd-report path with fresh TTLs and an ephemeral key.
            val key = DeviceSigningKey.loadOrCreate(object : DeviceSigningKey.Storage {
                override fun read(): ByteArray? = null
                override fun write(seed: ByteArray) = Unit
            })
            val event = CrowdReportFactory.create(CrowdReportInput(
                if (seed == "road") "ROAD_BLOCKAGE" else "FLOOD",
                "Isolated Nearby hardware test: $seed", 121.5761, 25.0795, "MAP_PICK",
            ), key, Instant.now())
            val fixture = CrowdChunkCodec.build(event, key)
            val seeded = repository.ingestChunk(fixture)
            assertTrue("Cannot seed signed hardware test data: $seeded", seeded is ChunkIngestResult.Applied)
            Log.i("RealPeerSyncTest", "[$seed] SIGNED_SEED_OK category=${event.getJSONObject("attributes").getString("category")}")
            fun newEngine(): AutoPeerSyncEngine {
                val radio: PeerTransport = if (nearby) NearbyConnectionsTransport(context)
                    else if (wifi) WifiDirectTransport(context) else BleGattTransport(context, adapter)
                val work = CoroutineScope(SupervisorJob() + Dispatchers.Default)
                transport = radio
                scope = work
                return AutoPeerSyncEngine(
                    transport = radio,
                    localNodeId = "hardware-test-$seed",
                    localSummaryProvider = { repository.allLocalPeerSummaries("hardware-test-$seed") },
                    chunkProvider = { dataset, namespace, id -> repository.cachedChunkJson(dataset, namespace, id) },
                    chunkIngestor = { repository.ingestChunk(it) },
                    scope = work,
                    connectTimeoutMillis = if (wifi) 90_000 else 40_000,
                    onLog = { logs.add(it); Log.i("RealPeerSyncTest", "[$seed] $it") },
                    receptiveWindowMillis = 5000,
                    syncCooldownMillis = 10000,
                    failureCooldownMillis = 3000,
                )
            }
            var engine = newEngine()
            engine.start()
            withTimeout(150000) {
                while (db.chunkDao().countSync() < 2 || engine.stats().peersSynced < 1) {
                    offline?.assertDisconnected()
                    delay(250)
                }
            }
            offline?.assertDisconnected()
            assertEquals(2, db.chunkDao().countSync())
            assertTrue(engine.stats().chunksApplied > 0)
            assertEquals("Unrelated devices must not count as Mesh peers", 1, engine.visiblePeerCount(30_000))
            Log.i("RealPeerSyncTest", "[$seed] FIRST_EXCHANGE_OK ${engine.stats()}")
            engine.stop()
            scope!!.cancel()
            teardown()
            delay(5000)
            logs.clear()
            engine = newEngine()
            engine.start()
            withTimeout(if (wifi) 150000 else 90000) {
                while (engine.stats().peersSynced < 1) {
                    offline?.assertDisconnected()
                    delay(250)
                }
            }
            offline?.assertDisconnected()
            assertEquals(0, engine.stats().chunksApplied)
            assertTrue(logs.any { it.contains("already in sync") })
            Log.i("RealPeerSyncTest", "[$seed] SECOND_ENCOUNTER_OK ${engine.stats()}")
            engine.stop()
        } finally {
            try {
                scope?.cancel()
                teardown()
                db.close()
                cache.deleteRecursively()
            } finally { offline?.close() }
        }
    }
}
