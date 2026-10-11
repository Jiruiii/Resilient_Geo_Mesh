package com.resilientgeo.mesh.transport

import android.annotation.SuppressLint
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertTrue
import java.io.Closeable

/** Test-only AP isolation; also supports a phone that starts without an AP. */
@SuppressLint("MissingPermission")
class OfflineWifiTestNetwork(context: Context) : Closeable {
    private val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
    private val wifi = context.getSystemService(WifiManager::class.java)
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private var networkToRestore: Int? = null

    suspend fun disconnect() {
        automation.adoptShellPermissionIdentity("android.permission.NETWORK_SETTINGS")
        try {
            val id = wifi.connectionInfo.networkId
            if (id >= 0) {
                networkToRestore = id
                assertTrue("Could not temporarily disable control AP", wifi.disableNetwork(id))
            }
        } finally { automation.dropShellPermissionIdentity() }
        withTimeout(10000) {
            while (hasInternetNetwork()) delay(250)
        }
        assertTrue("Wi-Fi must remain enabled", wifi.isWifiEnabled)
    }

    private fun hasInternetNetwork() = connectivity.allNetworks.any {
        connectivity.getNetworkCapabilities(it)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    }

    fun assertDisconnected() = assertTrue("An Internet-capable network appeared during the offline test", !hasInternetNetwork())

    override fun close() {
        networkToRestore?.let { id ->
            automation.adoptShellPermissionIdentity("android.permission.NETWORK_SETTINGS")
            try { assertTrue("Could not restore control AP", wifi.enableNetwork(id, true)) }
            finally { automation.dropShellPermissionIdentity() }
            networkToRestore = null
        }
    }
}
