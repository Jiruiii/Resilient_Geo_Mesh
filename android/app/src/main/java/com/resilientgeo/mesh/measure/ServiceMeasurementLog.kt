package com.resilientgeo.mesh.measure

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import com.resilientgeo.mesh.emergency.AutoPeerSyncEngine
import java.io.File
import java.time.Instant
import java.time.LocalDate

/**
 * Optional CSV log of the real Emergency Mode service, for the lock-screen,
 * Doze and battery tests in docs/finals-field-test-plan.md. Those tests run
 * unplugged for hours, so logcat is not enough. Only debuggable builds can
 * turn it on; release builds never write the file.
 */
class ServiceMeasurementLog(context: Context, private val directoryOverride: File? = null) {
    private val app = context.applicationContext
    private val preferences = app.getSharedPreferences("measurement_log", Context.MODE_PRIVATE)

    val available: Boolean get() = (app.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
    var enabled: Boolean
        get() = available && preferences.getBoolean("enabled", false)
        set(value) {
            require(available || !value) { "Measurement log is only available in debug builds" }
            preferences.edit().putBoolean("enabled", value).apply()
        }

    fun directory(): File? = directoryOverride ?: app.getExternalFilesDir("measurements")

    fun outcome(transport: String, outcome: AutoPeerSyncEngine.SyncOutcome, stats: AutoPeerSyncEngine.Stats) =
        write("outcome", transport, outcome.succeeded, outcome.failureCode, null, stats)

    fun sample(kind: String, activeTransports: List<String>, peers: Int?, stats: AutoPeerSyncEngine.Stats?) =
        write(kind, activeTransports.joinToString("+"), null, null, peers, stats)

    private fun write(
        kind: String,
        transport: String,
        success: Boolean?,
        failureCode: String?,
        peers: Int?,
        stats: AutoPeerSyncEngine.Stats?,
    ) {
        if (!enabled) return
        val dir = directory() ?: return
        val power = app.getSystemService(PowerManager::class.java)
        val battery = app.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val plugged = (battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
        val model = Build.MODEL.replace(Regex("[^A-Za-z0-9_-]"), "_")
        MeasurementCsv.append(File(dir, "service-${LocalDate.now()}-$model.csv"), HEADER, listOf(
            Instant.now(), kind, transport, success, failureCode, peers, stats?.activeSessions,
            stats?.peersSynced, stats?.chunksApplied,
            if (level >= 0 && scale > 0) level * 100 / scale else null, plugged,
            if (power.isInteractive) "on" else "off", power.isDeviceIdleMode, power.isPowerSaveMode,
        ))
    }

    companion object {
        /** Battery and Doze state are sampled this often while the service runs. */
        const val SAMPLE_INTERVAL_MILLIS = 5 * 60_000L
        val HEADER = listOf(
            "wall_clock", "kind", "transport", "success", "failure_code", "peers", "active_sessions",
            "sync_completions", "chunks_applied", "battery_pct", "plugged", "screen", "device_idle", "power_save",
        )
    }
}
