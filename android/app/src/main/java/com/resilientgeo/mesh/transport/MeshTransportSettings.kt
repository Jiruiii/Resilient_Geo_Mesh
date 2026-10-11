package com.resilientgeo.mesh.transport

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.wifi.WifiManager
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import android.bluetooth.BluetoothManager
import com.google.android.gms.common.GoogleApiAvailabilityLight
import com.google.android.gms.common.ConnectionResult

class MeshTransportSettings(private val context: Context) {
    private val preferences = context.getSharedPreferences("emergency_mode", Context.MODE_PRIVATE)
    var mode: String
        // Old manual choices migrate to automatic; explicit diagnostic overrides use a new key.
        get() = preferences.getString("transport_v2", AUTO) ?: AUTO
        set(value) {
            require(value in MODES)
            preferences.edit().putString("transport_v2", value).apply()
        }

    fun blePermissions() = if (Build.VERSION.SDK_INT >= 31) listOf(
        Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT,
    ) else listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
    fun nearbyPermissions() = (blePermissions() + wifiPermissions() +
        if (Build.VERSION.SDK_INT <= 31) listOf(Manifest.permission.ACCESS_FINE_LOCATION) else emptyList()).distinct()
    fun requiredPermissions() = when (mode) {
        BLE -> blePermissions()
        WIFI_DIRECT -> wifiPermissions()
        else -> nearbyPermissions()
    }
    private fun granted(permissions: List<String>) = permissions.all {
        ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
    }
    fun bleGranted() = granted(blePermissions())
    fun bluetoothEnabled() = runCatching { context.getSystemService(BluetoothManager::class.java)?.adapter?.isEnabled == true }.getOrDefault(false)
    fun bleReady() = bleGranted() && bluetoothEnabled() && (Build.VERSION.SDK_INT >= 31 || locationEnabled())
    fun nearbyAvailable() = runCatching {
        GoogleApiAvailabilityLight.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
    }.getOrDefault(false)
    fun nearbyGranted() = granted(nearbyPermissions())
    fun nearbyReady() = nearbyAvailable() && nearbyGranted() && bluetoothEnabled() && wifiEnabled() &&
        (Build.VERSION.SDK_INT >= 32 || locationEnabled())
    fun ready(mode: String) = when (mode) { NEARBY -> nearbyReady(); WIFI_DIRECT -> wifiReady(); BLE -> bleReady(); else -> false }

    fun wifiAvailable() = context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_DIRECT)
    fun wifiEnabled() = context.applicationContext.getSystemService(WifiManager::class.java)?.isWifiEnabled == true
    fun locationEnabled() = context.getSystemService(LocationManager::class.java)?.let {
        LocationManagerCompat.isLocationEnabled(it)
    } == true
    fun wifiPermissions() = if (Build.VERSION.SDK_INT >= 37) listOf(Manifest.permission.NEARBY_WIFI_DEVICES, "android.permission.ACCESS_LOCAL_NETWORK")
        else if (Build.VERSION.SDK_INT >= 33) listOf(Manifest.permission.NEARBY_WIFI_DEVICES)
        else listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
    fun wifiGranted() = wifiPermissions().all {
        ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
    }
    fun wifiReady() = wifiAvailable() && wifiEnabled() && wifiGranted() && locationEnabled()

    companion object {
        const val AUTO = "auto"
        const val NEARBY = "nearby"
        const val BLE = "ble"
        const val WIFI_DIRECT = "wifi_direct"
        val MODES = listOf(AUTO, NEARBY, WIFI_DIRECT, BLE)
    }
}
