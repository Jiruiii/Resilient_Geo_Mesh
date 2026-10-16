package com.resilientgeo.mesh.emergency

import android.Manifest
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import androidx.core.content.ContextCompat
import com.resilientgeo.mesh.bridge.SharedPreferencesEmergencyModeState
import com.resilientgeo.mesh.transport.MeshTransportSettings
import java.time.Instant

/** History survives process death; live counters do not. No radio addresses are exposed. */
class SyncStatusStore(context: Context) {
    private val appContext = context.applicationContext
    private val preferences = appContext.getSharedPreferences("sync_status", Context.MODE_PRIVATE)
    fun started() { activeTransports = emptyList(); fallbackReason = null; telemetry.start(SystemClock.elapsedRealtime()) }
    fun stopped() { activeTransports = emptyList(); fallbackReason = null; telemetry.stop() }
    fun transports(active: List<String>, reason: String?) { activeTransports = active.toList(); fallbackReason = reason }
    fun heartbeat(discovery: Boolean, nearby: Int, stats: AutoPeerSyncEngine.Stats?) =
        telemetry.update(discovery, nearby, stats, SystemClock.elapsedRealtime())
    fun record(outcome: AutoPeerSyncEngine.SyncOutcome, transport: String? = null) {
        val at = Instant.now().toString()
        if (outcome.succeeded) preferences.edit().putString("last_success_at", at).apply()
        else preferences.edit().putString("last_failure_at", at).putString("last_failure_code", outcome.failureCode)
            .putString("last_failure_transport", transport).apply()
    }
    fun message(): Map<String, Any?> {
        val adapter = appContext.getSystemService(BluetoothManager::class.java)?.adapter
        val permissions = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) listOf(
            Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT,
        ) else listOf(Manifest.permission.ACCESS_FINE_LOCATION)
        val granted = permissions.all { ContextCompat.checkSelfPermission(appContext, it) == PackageManager.PERMISSION_GRANTED }
        val bluetoothEnabled = runCatching { adapter?.isEnabled == true }.getOrDefault(false)
        val enabled = SharedPreferencesEmergencyModeState(appContext).isEnabled
        val live = telemetry.snapshot(SystemClock.elapsedRealtime())
        val transport = MeshTransportSettings(appContext)
        val active = if (enabled && live.serviceRunning) activeTransports.filter { transport.ready(it) } else emptyList()
        val discovery = enabled && live.serviceRunning && live.discoveryActive && active.isNotEmpty()
        return mapOf(
            "transport" to transport.mode,
            "active_transports" to active,
            "fallback_reason" to if (enabled && live.serviceRunning) fallbackReason else null,
            "nearby_available" to transport.nearbyAvailable(),
            "nearby_permissions_granted" to transport.nearbyGranted(),
            "nearby_ready" to transport.nearbyReady(),
            "discovery_mode" to transport.discoveryMode,
            "discovery_resting" to (discovery && com.resilientgeo.mesh.transport.WifiDiscoveryControl.resting),
            "wifi_direct_available" to transport.wifiAvailable(),
            "wifi_enabled" to transport.wifiEnabled(),
            "wifi_permissions_granted" to transport.wifiGranted(),
            "location_enabled" to transport.locationEnabled(),
            "emergency_mode_enabled" to enabled,
            "bluetooth_available" to (adapter != null),
            "bluetooth_enabled" to bluetoothEnabled,
            "ble_permissions_granted" to granted,
            "notifications_enabled" to androidx.core.app.NotificationManagerCompat.from(appContext).areNotificationsEnabled(),
            "service_running" to live.serviceRunning,
            "discovery_active" to discovery,
            "nearby_peers" to if (discovery) live.nearbyPeers else 0,
            "active_sessions" to if (discovery) live.activeSessions else 0,
            "sync_completions" to live.syncCompletions,
            "chunks_received" to live.chunksReceived,
            "last_success_at" to preferences.getString("last_success_at", null),
            "last_failure_at" to preferences.getString("last_failure_at", null),
            "last_failure_code" to preferences.getString("last_failure_code", null),
            "last_failure_transport" to preferences.getString("last_failure_transport", null),
            "observed_at" to Instant.now().toString(),
        )
    }
    private companion object {
        val telemetry = SyncTelemetry()
        @Volatile var activeTransports: List<String> = emptyList()
        @Volatile var fallbackReason: String? = null
    }
}
