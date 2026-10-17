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
import com.resilientgeo.mesh.bridge.GovernmentSessionKeyStore
import com.resilientgeo.mesh.bridge.SharedPreferencesEmergencyModeState
import com.resilientgeo.mesh.bridge.SirenBridge
import com.resilientgeo.mesh.trust.GovernmentDeviceKeyStore
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import com.resilientgeo.mesh.online.GovernmentSyncJob
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
    private var sirenBridge: SirenBridge? = null
    private var governmentCheck: Job? = null
    private var governmentAuthChannel: MethodChannel? = null
    private val governmentSessionStore by lazy { GovernmentSessionKeyStore(applicationContext) }
    private val governmentDeviceKeyStore by lazy { GovernmentDeviceKeyStore(applicationContext) }

    override fun onResume() {
        super.onResume()
        GovernmentSyncJob.schedulePendingUpload(applicationContext)
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
            governmentDeviceKeyStore = governmentDeviceKeyStore,
            onEmergencyModeChanged = ::onEmergencyModeChanged,
        )
        offlineMapAssetBridge?.close()
        offlineMapAssetBridge = OfflineMapAssetBridge(
            applicationContext,
            flutterEngine.dartExecutor.binaryMessenger,
        )
        sirenBridge?.close()
        sirenBridge = SirenBridge(
            applicationContext,
            flutterEngine.dartExecutor.binaryMessenger,
            requestNotificationPermission = ::requestNotificationPermissionIfNeeded,
        )
        governmentAuthChannel?.setMethodCallHandler(null)
        governmentAuthChannel = MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "com.resilientgeo.mesh/government-auth",
        ).also { channel ->
            channel.setMethodCallHandler { call, result ->
                try {
                    when (call.method) {
                        "readSessionToken" -> result.success(governmentSessionStore.read())
                        "writeSessionToken" -> {
                            val token = (call.arguments as? Map<*, *>)?.get("token") as? String
                            if (token == null) result.error("invalid_input", "session token is required", null)
                            else {
                                governmentSessionStore.write(token)
                                GovernmentSyncJob.schedulePendingUpload(applicationContext)
                                result.success(null)
                            }
                        }
                        "clearSessionToken" -> { governmentSessionStore.clear(); result.success(null) }
                        else -> result.notImplemented()
                    }
                } catch (_: Exception) {
                    result.error("secure_storage_unavailable", "Government session storage is unavailable", null)
                }
            }
        }
    }

    override fun onDestroy() {
        mapBridge?.close()
        mapBridge = null
        offlineMapAssetBridge?.close()
        offlineMapAssetBridge = null
        sirenBridge?.close()
        sirenBridge = null
        governmentAuthChannel?.setMethodCallHandler(null)
        governmentAuthChannel = null
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
        val permissions = settings.requiredPermissions()
        val needed = permissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (needed.isNotEmpty()) blePermissionLauncher.launch(needed.toTypedArray())
        return needed.isNotEmpty()
    }

    private fun emergencyModeEnabled(): Boolean =
        SharedPreferencesEmergencyModeState(applicationContext).isEnabled
}
