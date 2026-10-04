package com.resilientgeo.mesh.transport

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.net.wifi.p2p.WifiP2pManager
import android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceInfo
import android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceRequest
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collect
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.Executor
import kotlin.coroutines.resume
import kotlin.random.Random

/** Opt-in paired-device diagnostic; does not connect, ingest, or modify app data.
 * Run detached on-device when probe_offline=true: ADB disconnects temporarily.
 * The current saved network is temporarily disabled and restored in finally.
 * Global autojoin stays unchanged, preserving the real STA/P2P scan contention.
 * Mobile data must already be off.
 */
@SuppressLint("MissingPermission")
@RunWith(AndroidJUnit4::class)
class WifiDiscoveryProbeTest {
    @Test fun measureDiscovery() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        val mode = args.getString("discovery_probe")
        assumeTrue("Opt-in only", mode in setOf("legacy", "steady", "listen", "jitter", "transport"))
        assumeTrue("Probe uses Android 13 test APIs", android.os.Build.VERSION.SDK_INT >= 33)
        val context = instrumentation.targetContext
        val manager = context.getSystemService(WifiP2pManager::class.java)
        val wifi = context.getSystemService(WifiManager::class.java)
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        val power = context.getSystemService(PowerManager::class.java)
        val output = File(context.filesDir, "wifi-discovery-probe-${args.getString("probe_run", "latest")}.log")
        output.writeText("")
        val duration = args.getString("probe_seconds", "45")!!.toLong().coerceIn(10, 150) * 1000
        val startAt = args.getString("probe_start_epoch_ms")?.toLong()
        val offline = args.getString("probe_offline") == "true"
        var previousAutojoin: Boolean? = null
        var disabledNetwork: Int? = null
        var channel: WifiP2pManager.Channel? = null
        var receiver: BroadcastReceiver? = null
        var service: WifiP2pDnsSdServiceInfo? = null
        var request: WifiP2pDnsSdServiceRequest? = null
        var transport: WifiDirectTransport? = null
        var started = SystemClock.elapsedRealtime()
        var awakeStarted = SystemClock.uptimeMillis()
        var found = false
        fun record(message: String) {
            val line = "${SystemClock.elapsedRealtime() - started}ms epoch_ms=${System.currentTimeMillis()} $message"
            synchronized(output) { output.appendText(line + "\n") }
            Log.i("WifiDiscoveryProbe", line)
        }
        suspend fun action(name: String, invoke: (WifiP2pManager.ActionListener) -> Unit) {
            withTimeout(10000) {
                suspendCancellableCoroutine { continuation ->
                    invoke(object : WifiP2pManager.ActionListener {
                        override fun onSuccess() {
                            record("$name accepted")
                            if (continuation.isActive) continuation.resume(Unit)
                        }
                        override fun onFailure(reason: Int) {
                            record("$name failed=$reason")
                            if (continuation.isActive) continuation.resume(Unit)
                        }
                    })
                }
            }
        }
        try {
            if (offline) {
                instrumentation.uiAutomation.adoptShellPermissionIdentity("android.permission.NETWORK_SETTINGS")
                try {
                    if (args.getString("probe_global_autojoin_off") == "true") {
                        previousAutojoin = withTimeout(5000) {
                            suspendCancellableCoroutine { continuation ->
                                wifi.queryAutojoinGlobal(Executor { it.run() }) { enabled ->
                                    if (continuation.isActive) continuation.resume(enabled)
                                }
                            }
                        }
                        wifi.allowAutojoinGlobal(false)
                        assertTrue("Privileged test disconnect failed", wifi.disconnect())
                    } else {
                        val networkId = wifi.connectionInfo.networkId
                        assertTrue("Test must start connected to its control AP", networkId >= 0)
                        disabledNetwork = networkId
                        assertTrue("Could not temporarily disable control AP", wifi.disableNetwork(networkId))
                    }
                } finally { instrumentation.uiAutomation.dropShellPermissionIdentity() }
                delay(3000)
                assertFalse("Cellular/route to AP is still available", connectivity.allNetworks.any {
                    val caps = connectivity.getNetworkCapabilities(it)
                    caps != null && (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ||
                        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) &&
                        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                })
                record("OFFLINE_CONFIRMED wifi=${wifi.isWifiEnabled} global_autojoin_changed=${previousAutojoin != null}")
            }
            startAt?.let {
                assertTrue("Start epoch is stale; check shell arithmetic and both phone clocks",
                    System.currentTimeMillis() - it < 10000)
                delay((it - System.currentTimeMillis()).coerceAtLeast(0))
            }
            withContext(Dispatchers.Main.immediate) {
                started = SystemClock.elapsedRealtime()
                awakeStarted = SystemClock.uptimeMillis()
                record("START mode=$mode interactive=${power.isInteractive} lateness_ms=${startAt?.let { System.currentTimeMillis() - it } ?: 0}")
                assertTrue("Latency comparison requires an awake screen; wake both phones before running", power.isInteractive)
                fun checkTiming() {
                    val elapsed = SystemClock.elapsedRealtime() - started
                    val asleep = elapsed - (SystemClock.uptimeMillis() - awakeStarted)
                    record("TIMING elapsed_ms=$elapsed asleep_ms=$asleep interactive=${power.isInteractive}")
                    assertTrue("CPU slept during latency comparison; result is not comparable", asleep < 1000)
                    assertTrue("Test timer was delayed; result is not comparable", elapsed < duration + 10000)
                }
                if (mode == "transport") {
                    val radio = WifiDirectTransport(context)
                    transport = radio
                    val collector = launch {
                        radio.discover().collect {
                            if (!found) record("FIRST_SERVICE")
                            found = true
                        }
                    }
                    try { delay(duration); record("END found=$found"); checkTiming() }
                    finally { collector.cancelAndJoin() }
                    return@withContext
                }
                val ch = manager.initialize(context, Looper.getMainLooper(), null)
                channel = ch
                val listener = object : BroadcastReceiver() {
                    override fun onReceive(context: Context?, intent: Intent?) {
                        when (intent?.action) {
                            WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION -> manager.requestPeers(ch) {
                                record("raw_peers=${it.deviceList.size}")
                            }
                            WifiP2pManager.WIFI_P2P_DISCOVERY_CHANGED_ACTION -> record("discovery_state=" +
                                intent.getIntExtra(WifiP2pManager.EXTRA_DISCOVERY_STATE, -1))
                        }
                    }
                }
                receiver = listener
                ContextCompat.registerReceiver(context, listener, IntentFilter().apply {
                    addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION)
                    addAction(WifiP2pManager.WIFI_P2P_DISCOVERY_CHANGED_ACTION)
                }, ContextCompat.RECEIVER_EXPORTED)
                val identity = "wifi:" + UUID.randomUUID().toString().replace("-", "")
                manager.setDnsSdResponseListeners(ch, { _, _, _ -> }, { domain, txt, _ ->
                    if (domain.equals("resilientgeo._rgmesh._tcp.local.", true) && txt["v"] == "1" &&
                        txt["id"] != identity && txt["id"]?.startsWith("wifi:") == true) {
                        if (!found) record("FIRST_SERVICE")
                        found = true
                    }
                })
                service = WifiP2pDnsSdServiceInfo.newInstance("resilientgeo", "_rgmesh._tcp", mapOf("v" to "1", "id" to identity))
                action("addLocal") { manager.addLocalService(ch, service, it) }
                request = WifiP2pDnsSdServiceRequest.newInstance("resilientgeo", "_rgmesh._tcp")
                action("addRequest") { manager.addServiceRequest(ch, request, it) }
                if (mode != "legacy") delay(Random.nextLong(100, 2500))
                action("discoverServices") { manager.discoverServices(ch, it) }
                var next = SystemClock.elapsedRealtime() + if (mode == "legacy") 12000 else 6000
                var listening = false
                while (SystemClock.elapsedRealtime() - started < duration) {
                    delay(200)
                    if (SystemClock.elapsedRealtime() < next) continue
                    when (mode) {
                        "legacy" -> {
                            action("discoverServices") { manager.discoverServices(ch, it) }
                            next = SystemClock.elapsedRealtime() + 15000
                        }
                        "jitter" -> {
                            action("discoverServices") { manager.discoverServices(ch, it) }
                            next = SystemClock.elapsedRealtime() + Random.nextLong(7000, 13000)
                        }
                        "listen" -> {
                            if (!found) {
                                if (!listening) action("startListening") { manager.startListening(ch, it) }
                                else action("discoverServices") { manager.discoverServices(ch, it) }
                                listening = !listening
                            }
                            next = SystemClock.elapsedRealtime() + Random.nextLong(3500, 6500)
                        }
                    }
                }
                record("END found=$found")
                checkTiming()
            }
        } finally {
            withContext(NonCancellable + Dispatchers.Main.immediate) {
                transport?.teardown()
                channel?.let { ch ->
                    if (mode == "listen") runCatching { manager.stopListening(ch, null) }
                    runCatching { manager.stopPeerDiscovery(ch, null) }
                    service?.let { manager.removeLocalService(ch, it, null) }
                    request?.let { manager.removeServiceRequest(ch, it, null) }
                    ch.close()
                }
                receiver?.let { runCatching { context.unregisterReceiver(it) } }
                previousAutojoin?.let {
                    instrumentation.uiAutomation.adoptShellPermissionIdentity("android.permission.NETWORK_SETTINGS")
                    try { wifi.allowAutojoinGlobal(it); wifi.reconnect() }
                    finally { instrumentation.uiAutomation.dropShellPermissionIdentity() }
                }
                disabledNetwork?.let {
                    instrumentation.uiAutomation.adoptShellPermissionIdentity("android.permission.NETWORK_SETTINGS")
                    try { assertTrue("Could not restore control AP", wifi.enableNetwork(it, true)) }
                    finally { instrumentation.uiAutomation.dropShellPermissionIdentity() }
                }
                record("RESTORED")
            }
        }
        assertTrue("No service discovered; see ${output.name}", found)
    }
}
