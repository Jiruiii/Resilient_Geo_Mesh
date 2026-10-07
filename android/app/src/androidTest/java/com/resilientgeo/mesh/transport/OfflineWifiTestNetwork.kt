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

/** Test-only AP isolation; no elevated permissions remain during the radio test. */
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
            assertTrue("Test must start on the control AP", id >= 0)
            networkToRestore = id
            assertTrue("Could not temporarily disable control AP", wifi.disableNetwork(id))
        } finally { automation.dropShellPermissionIdentity() }
        withTimeout(10000) {
            while (connectivity.allNetworks.any {
                val caps = connectivity.getNetworkCapabilities(it)
                caps != null && (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) &&
                    caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            }) delay(250)
        }
        assertTrue("Wi-Fi must remain enabled", wifi.isWifiEnabled)
    }

    override fun close() {
        networkToRestore?.let { id ->
            automation.adoptShellPermissionIdentity("android.permission.NETWORK_SETTINGS")
            try { assertTrue("Could not restore control AP", wifi.enableNetwork(id, true)) }
            finally { automation.dropShellPermissionIdentity() }
            networkToRestore = null
        }
    }
}
