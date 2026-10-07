package com.resilientgeo.mesh

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.resilientgeo.mesh.bridge.FlutterMapBridge
import com.resilientgeo.mesh.bridge.OfflineMapAssetBridge
import com.resilientgeo.mesh.bridge.SharedPreferencesEmergencyModeState
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import com.resilientgeo.mesh.online.GovernmentSyncManager
import com.resilientgeo.mesh.transport.MeshTransportSettings

/**
 * Flutter map launcher.
 *
 * Android-owned Room, trust verification, TTL/version handling, Emergency
 * Mode, BLE, and transport activities remain in their existing classes. The
 * bridge is registered here, while the native transport activities remain
 * developer harnesses rather than end-user map-screen content.
 */
class MainActivity : FlutterFragmentActivity() {

    private var mapBridge: FlutterMapBridge? = null
    private var offlineMapAssetBridge: OfflineMapAssetBridge? = null
    private var governmentCheck: Job? = null

    override fun onResume() {
        super.onResume()
        governmentCheck?.cancel()
        governmentCheck = lifecycleScope.launch {
            while (true) {
                GovernmentSyncManager.get(applicationContext).sync(automatic = true)
                delay(5 * 60_000L)
            }
        }
    }

    override fun onPause() {
        governmentCheck?.cancel()
        governmentCheck = null
        super.onPause()
    }

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { /* EmergencyModeService already started either way. */ }

    /** Serialize permission dialogs; the service picks up newly granted BLE access. */
    private val blePermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) {
        if (emergencyModeEnabled()) requestNotificationPermissionIfNeeded()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        // USB performance harness: show this app while a test phone is locked.
        // Opt-in only, unavailable in non-debuggable builds; keyguard remains locked.
        if ((applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0 &&
            intent.getBooleanExtra("performance_over_keyguard", false) &&
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1
        ) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        mapBridge?.close()
        mapBridge = FlutterMapBridge(
            applicationContext,
            flutterEngine.dartExecutor.binaryMessenger,
            onEmergencyModeChanged = ::onEmergencyModeChanged,
        )
        offlineMapAssetBridge?.close()
        offlineMapAssetBridge = OfflineMapAssetBridge(
            applicationContext,
            flutterEngine.dartExecutor.binaryMessenger,
        )
    }

    override fun onDestroy() {
        mapBridge?.close()
        mapBridge = null
        offlineMapAssetBridge?.close()
        offlineMapAssetBridge = null
        super.onDestroy()
    }

    private fun onEmergencyModeChanged(enabled: Boolean) {
        if (!enabled) return

        if (!requestBlePermissionsIfNeeded()) requestNotificationPermissionIfNeeded()
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS,
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun requestBlePermissionsIfNeeded(): Boolean {
        val settings = MeshTransportSettings(applicationContext)
        val permissions = if (settings.mode == MeshTransportSettings.WIFI_DIRECT) {
            settings.wifiPermissions()
        } else if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        } else listOf(
            Manifest.permission.BLUETOOTH_SCAN,
            Manifest.permission.BLUETOOTH_ADVERTISE,
            Manifest.permission.BLUETOOTH_CONNECT,
        )
        val needed = permissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (needed.isNotEmpty()) blePermissionLauncher.launch(needed.toTypedArray())
        return needed.isNotEmpty()
    }

    private fun emergencyModeEnabled(): Boolean =
        SharedPreferencesEmergencyModeState(applicationContext).isEnabled
}
