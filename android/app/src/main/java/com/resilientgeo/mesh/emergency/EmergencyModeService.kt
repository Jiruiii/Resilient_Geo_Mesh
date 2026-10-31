package com.resilientgeo.mesh.emergency

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.bluetooth.BluetoothManager
import android.content.Intent
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import com.resilientgeo.mesh.data.MeshRepository
import com.resilientgeo.mesh.measure.ServiceMeasurementLog
import com.resilientgeo.mesh.transport.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import org.json.JSONArray

/** Nearby -> Wi-Fi Direct, with a persistent BLE rendezvous path in automatic mode. */
class EmergencyModeService : Service() {
    private data class InventoryChunk(
        val datasetId: String,
        val namespace: String,
        val chunkId: String,
        val chunkHash: String,
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val syncScope = CoroutineScope(scope.coroutineContext + Dispatchers.Default)
    private val settings by lazy { MeshTransportSettings(applicationContext) }
    private val status by lazy { SyncStatusStore(applicationContext) }
    private val repository by lazy { MeshRepository(applicationContext) }
    private val nodeId by lazy { NodeIdentity(applicationContext).nodeId }
    private val measurementLog by lazy { ServiceMeasurementLog(applicationContext) }
    private var lastMeasurementSampleAt = 0L
    private val policy = AutomaticTransportPolicy()
    private class Lane(val mode: String, val radio: PeerTransport, val engine: AutoPeerSyncEngine) {
        var discovery = true
    }
    private val lanes = mutableMapOf<String, Lane>()
    private val retryAfter = mutableMapOf<String, Long>()
    private var startedAt = 0L
    private var completed = 0
    private var chunks = 0
    @Volatile private var allowBle = true

    override fun onCreate() {
        super.onCreate()
        startedAt = SystemClock.elapsedRealtime()
        status.started()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Emergency Mode", NotificationManager.IMPORTANCE_LOW),
        )
        startForeground(NOTIFICATION, notification())
        logMeasurement { measurementLog.sample("start", emptyList(), null, null) }
        scope.launch {
            while (isActive) {
                maintain()
                publish()
                sampleMeasurement()
                delay(5_000)
            }
        }
        scope.launch {
            var previousInventory: Set<InventoryChunk>? = null
            repository.observePeerInventory()
                .map { rows ->
                    rows.map { row ->
                        InventoryChunk(row.datasetId, row.namespace, row.chunkId, row.chunkHash)
                    }.toSet()
                }
                .distinctUntilChanged()
                .collect { inventory ->
                    val previous = previousInventory
                    previousInventory = inventory
                    val addedGovernmentAnnouncement = previous?.let { oldInventory ->
                        inventory.any {
                            it !in oldInventory &&
                                it.namespace == GOVERNMENT_ANNOUNCEMENT_NAMESPACE &&
                                it.datasetId in GOVERNMENT_ANNOUNCEMENT_DATASETS
                        }
                    } == true
                    if (addedGovernmentAnnouncement) {
                        lanes.values.forEach { it.engine.requestSyncSoon() }
                    }
                }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int) = START_STICKY
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onDestroy() {
        lanes.keys.toList().forEach(::stopLane)
        val stopped = stats()
        logMeasurement { measurementLog.sample("stop", emptyList(), null, stopped) }
        status.stopped()
        scope.cancel()
        super.onDestroy()
    }

    private fun maintain() {
        val now = SystemClock.elapsedRealtime()
        if (settings.mode != MeshTransportSettings.AUTO) {
            val mode = settings.mode
            lanes.keys.filter { it != mode }.toList().forEach(::stopLane)
            maintainLane(mode, settings.ready(mode), now)
            allowBle = true
            return
        }
        val current = policy.active?.let { lanes[it] }
        val selected = policy.select(now, settings.nearbyReady(), settings.wifiReady(),
            current?.engine?.stats()?.activeSessions?.let { it > 0 } == true,
            current?.engine?.visiblePeerCount(30_000) ?: 0)
        lanes.keys.filter { it != MeshTransportSettings.BLE && it != selected }.toList().forEach(::stopLane)
        selected?.let { maintainLane(it, true, now) }
        // Keep BLE discoverable across fast-radio transitions, including on peers without GMS.
        allowBle = selected == null || now - startedAt >= 20_000
        maintainLane(MeshTransportSettings.BLE, settings.bleReady(), now)
    }

    private fun maintainLane(mode: String, ready: Boolean, now: Long) {
        val lane = lanes[mode]
        if (!ready) { stopLane(mode); retryAfter.remove(mode); return }
        if (lane?.discovery == true) return
        if (now < (retryAfter[mode] ?: 0L)) return
        stopLane(mode)
        retryAfter[mode] = now + 30_000
        startLane(mode)
    }

    private fun startLane(mode: String) {
        var radio: PeerTransport? = null
        try {
            val transport: PeerTransport = when (mode) {
                MeshTransportSettings.NEARBY -> NearbyConnectionsTransport(applicationContext) {
                    scope.launch {
                        lanes[mode]?.takeIf { it.radio === radio }?.let { it.discovery = true; publish() }
                    }
                }
                MeshTransportSettings.WIFI_DIRECT -> WifiDirectTransport(applicationContext)
                else -> BleGattTransport(applicationContext, getSystemService(BluetoothManager::class.java).adapter!!)
            }
            radio = transport
            val engine = AutoPeerSyncEngine(
                transport = transport,
                localNodeId = nodeId,
                localSummaryProvider = {
                    repository.allLocalPeerSummaries(nodeId).apply {
                        getJSONObject("capabilities").apply {
                            val capability = when (mode) {
                                MeshTransportSettings.NEARBY -> "NEARBY_CONNECTIONS"
                                MeshTransportSettings.WIFI_DIRECT -> "WIFI_DIRECT"
                                else -> "BLE_GATT"
                            }
                            put("discovery_transports", JSONArray().put(if (mode == MeshTransportSettings.BLE) "BLE" else capability))
                            put("transfer_transports", JSONArray().put(capability))
                            put("supports_resume", false)
                            put("max_peer_count", if (mode == MeshTransportSettings.BLE) 2 else 1)
                        }
                    }
                },
                chunkProvider = { dataset, namespace, id -> repository.cachedChunkJson(dataset, namespace, id) },
                chunkIngestor = { repository.ingestChunk(it) },
                scope = syncScope,
                maxConcurrentSessions = if (mode == MeshTransportSettings.BLE) 2 else 1,
                connectTimeoutMillis = if (mode == MeshTransportSettings.WIFI_DIRECT) 90_000 else 40_000,
                failureCooldownMillis = if (mode == MeshTransportSettings.BLE) 15_000 else 3_000,
                mayInitiate = { mode != MeshTransportSettings.BLE || allowBle },
                onLog = { Log.i(TAG, "[$mode] $it") },
                onSyncOutcome = { outcome -> scope.launch {
                    val current = lanes[mode]
                    if (current?.radio === transport) {
                        if (outcome.failureCode == "discovery_failed") current.discovery = false
                        if (settings.mode == MeshTransportSettings.AUTO && policy.active == mode)
                            policy.outcome(outcome.succeeded, outcome.failureCode)
                        status.record(outcome, mode)
                        val totals = stats()
                        logMeasurement { measurementLog.outcome(mode, outcome, totals) }
                        publish()
                    }
                } },
            )
            lanes[mode] = Lane(mode, transport, engine).apply {
                discovery = mode != MeshTransportSettings.NEARBY
            }
            engine.start()
            Log.i(TAG, "Started $mode")
        } catch (error: Exception) {
            if (mode in lanes) stopLane(mode) else radio?.let(::teardown)
            if (policy.active == mode) policy.outcome(false, "discovery_failed")
            status.record(AutoPeerSyncEngine.SyncOutcome(false, "discovery_failed"), mode)
            Log.e(TAG, "Could not start $mode", error)
        }
    }

    private fun stopLane(mode: String) {
        val lane = lanes.remove(mode) ?: return
        lane.engine.stop()
        lane.engine.stats().let { completed += it.peersSynced; chunks += it.chunksApplied }
        teardown(lane.radio)
    }

    private fun teardown(radio: PeerTransport) {
        runCatching {
            when (radio) {
                is NearbyConnectionsTransport -> radio.teardown()
                is WifiDirectTransport -> radio.teardown()
                is BleGattTransport -> radio.teardown()
            }
        }.onFailure { Log.w(TAG, "Transport teardown failed", it) }
    }

    private fun stats(): AutoPeerSyncEngine.Stats {
        val all = lanes.values.map { it.engine.stats() }
        return AutoPeerSyncEngine.Stats(completed + all.sumOf { it.peersSynced },
            chunks + all.sumOf { it.chunksApplied }, all.sumOf { it.activeSessions })
    }

    private fun publish() {
        val active = lanes.values.filter { it.discovery }.map { it.mode }
        val peers = lanes.values.sumOf { it.engine.visiblePeerCount(30_000) }
        val stats = stats()
        status.transports(active, if (settings.mode == MeshTransportSettings.AUTO) policy.reason else null)
        status.heartbeat(active.isNotEmpty(), peers, stats)
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION, notification())
        Log.i(TAG, "HEARTBEAT transports=$active peers=$peers active_sessions=${stats.activeSessions} chunks_applied=${stats.chunksApplied}")
    }

    /** Doze can stretch the 5 s loop; gaps between samples in the CSV are part of the measurement. */
    private fun sampleMeasurement() {
        val now = SystemClock.elapsedRealtime()
        if (now - lastMeasurementSampleAt < ServiceMeasurementLog.SAMPLE_INTERVAL_MILLIS) return
        lastMeasurementSampleAt = now
        val active = lanes.values.filter { it.discovery }.map { it.mode }
        val peers = lanes.values.sumOf { it.engine.visiblePeerCount(30_000) }
        val totals = stats()
        logMeasurement { measurementLog.sample("sample", active, peers, totals) }
    }

    /** The log is off unless a debug build enabled it; file I/O stays off the main thread. */
    private fun logMeasurement(write: () -> Unit) {
        if (!measurementLog.enabled) return
        CoroutineScope(Dispatchers.IO).launch {
            runCatching(write).onFailure { Log.w(TAG, "Measurement log write failed", it) }
        }
    }

    private fun notification(): Notification {
        val active = lanes.values.filter { it.discovery }.map { label(it.mode) }
        return NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("Emergency Mode · " + if (settings.mode == MeshTransportSettings.AUTO) "自動交換" else label(settings.mode))
            .setContentText(if (active.isEmpty()) "等待可用傳輸方式／權限" else "${active.joinToString(" + ")} · 已接收 ${stats().chunksApplied} 分片")
            .setSmallIcon(android.R.drawable.ic_dialog_info).setOngoing(true).build()
    }

    private fun label(mode: String) = when (mode) {
        MeshTransportSettings.NEARBY -> "Nearby"
        MeshTransportSettings.WIFI_DIRECT -> "Wi-Fi Direct"
        else -> "BLE"
    }

    companion object {
        private const val TAG = "ResilientGeoEmergency"
        private const val CHANNEL = "emergency_mode"
        private const val NOTIFICATION = 1
        private const val GOVERNMENT_ANNOUNCEMENT_NAMESPACE = "official.announcement"
        private val GOVERNMENT_ANNOUNCEMENT_DATASETS = setOf(
            "government-government-announcements",
            "government-government-device-announcements",
            "government-device-announcements",
        )
    }
}
