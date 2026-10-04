package com.resilientgeo.mesh.transport

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.wifi.WifiManager
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat

class MeshTransportSettings(private val context: Context) {
    private val preferences = context.getSharedPreferences("emergency_mode", Context.MODE_PRIVATE)
    var mode: String
        get() = preferences.getString("transport", BLE) ?: BLE
        set(value) {
            require(value == BLE || value == WIFI_DIRECT)
            preferences.edit().putString("transport", value).apply()
        }

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
        const val BLE = "ble"
        const val WIFI_DIRECT = "wifi_direct"
    }
}
