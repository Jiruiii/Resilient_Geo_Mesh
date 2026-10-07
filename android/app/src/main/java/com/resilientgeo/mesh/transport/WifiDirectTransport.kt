package com.resilientgeo.mesh.transport

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.wifi.WpsInfo
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pDevice
import android.net.wifi.p2p.WifiP2pManager
import android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceInfo
import android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceRequest
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.IOException
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * DNS-SD discovers only this app; Wi-Fi P2P forms a group and TCP carries the
 * existing signed sync envelopes. The platform may ask the user to accept a
 * connection. One group at a time; no Internet or access point is required.
 * Socket binding never changes the process-wide network used by government sync.
 */
@SuppressLint("MissingPermission")
class WifiDirectTransport(context: Context) : PeerTransport {
    private val app = context.applicationContext
    private val manager = app.getSystemService(WifiP2pManager::class.java)
        ?: throw IllegalStateException("Wi-Fi Direct unavailable")
    private val connectivity = app.getSystemService(ConnectivityManager::class.java)
    override val localIdentity = "wifi:" + UUID.randomUUID().toString().replace("-", "")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var p2pChannel: WifiP2pManager.Channel? = null
    private var receiver: BroadcastReceiver? = null
    private var service: WifiP2pDnsSdServiceInfo? = null
    private var request: WifiP2pDnsSdServiceRequest? = null
    @Volatile private var emitPeer: ((PeerAdvertisement) -> Unit)? = null
    private val messages = MutableSharedFlow<Pair<String, ByteArray>>(extraBufferCapacity = 16)
    override val receivedMessages: SharedFlow<Pair<String, ByteArray>> = messages
    private data class Peer(val address: String, val seenAt: Long)
    private val peers = ConcurrentHashMap<String, Peer>()
    private val links = ConcurrentHashMap<String, Link>()
    private val rawSockets = ConcurrentHashMap.newKeySet<Socket>()
    private val connectLock = Mutex()
    private var outboundInvitation = false
    @Volatile private var server: ServerSocket? = null
    private var serverJob: Job? = null
    private var clientJob: Job? = null
    private var groupInterface: String? = null
    private var groupPresent = false
    private var initiatedGroup = false
    @Volatile private var usedGroup = false
    @Volatile private var stopped = false
    private val discoveryStartedAt = SystemClock.elapsedRealtime()
    private val discoverySchedule = WifiDirectDiscoverySchedule(discoveryStartedAt)
    private var invitationUntil = 0L
    private var lastRawPeerCount = -1

    private fun trace(message: String) = Log.i(TAG, "discovery_ms=${SystemClock.elapsedRealtime() - discoveryStartedAt} $message")

    private class Link(val peer: String, val socket: Socket, val input: DataInputStream, val output: DataOutputStream) {
        val id = UUID.randomUUID().toString()
        val writes = Mutex()
    }

    override fun discover(): Flow<PeerAdvertisement> = callbackFlow {
        check(p2pChannel == null && !stopped) { "Wi-Fi Direct discovery already started or stopped" }
        emitPeer = { trySend(it) }
        val ch = manager.initialize(app, Looper.getMainLooper()) {
            close(IOException("Wi-Fi Direct channel disconnected"))
        }
        p2pChannel = ch
        val listener = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (stopped) return
                if (intent?.action == WifiP2pManager.WIFI_P2P_DISCOVERY_CHANGED_ACTION) {
                    val state = intent.getIntExtra(WifiP2pManager.EXTRA_DISCOVERY_STATE, -1)
                    trace("platform discovery state=$state")
                    if (state == WifiP2pManager.WIFI_P2P_DISCOVERY_STOPPED)
                        discoverySchedule.searchStopped(SystemClock.elapsedRealtime())
                    else if (state == WifiP2pManager.WIFI_P2P_DISCOVERY_STARTED)
                        discoverySchedule.searchStarted()
                } else if (intent?.action == WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION) {
                    manager.requestPeers(ch) { devices ->
                        if (stopped) return@requestPeers
                        if (devices.deviceList.size != lastRawPeerCount) {
                            lastRawPeerCount = devices.deviceList.size
                            trace("raw peers=$lastRawPeerCount")
                        }
                        invitationUntil = if (devices.deviceList.any { it.status == WifiP2pDevice.INVITED })
                            SystemClock.elapsedRealtime() + 90_000 else 0L
                    }
                } else if (intent?.action == WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION &&
                    intent.getIntExtra(WifiP2pManager.EXTRA_WIFI_STATE, 0) != WifiP2pManager.WIFI_P2P_STATE_ENABLED) {
                    close(IOException("Wi-Fi Direct disabled"))
                } else refreshGroup()
            }
        }
        receiver = listener
        ContextCompat.registerReceiver(app, listener, IntentFilter().apply {
            addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION)
            addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION)
            addAction(WifiP2pManager.WIFI_P2P_DISCOVERY_CHANGED_ACTION)
            addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION)
        }, ContextCompat.RECEIVER_EXPORTED)
        manager.setDnsSdResponseListeners(ch, { _, _, _ -> }, { domain, record, device ->
            val identity = record["id"]
            if (!stopped && domain.equals("$INSTANCE.$TYPE.local.", ignoreCase = true) &&
                record["v"] == "1" && identity != null && WifiDirectFraming.validIdentity(identity) && identity != localIdentity) {
                peers[identity] = Peer(device.deviceAddress, SystemClock.elapsedRealtime())
                trace("service found peer=$identity")
                advertise(identity)
            }
        })
        try {
            service = WifiP2pDnsSdServiceInfo.newInstance(INSTANCE, TYPE, mapOf("v" to "1", "id" to localIdentity))
            action { manager.addLocalService(ch, service, it) }
            request = WifiP2pDnsSdServiceRequest.newInstance(INSTANCE, TYPE)
            action { manager.addServiceRequest(ch, request, it) }
            trace("service registered identity=$localIdentity")
        } catch (error: Exception) {
            teardown()
            throw error
        }
        val refresh = scope.launch {
            var nextRefresh = 0L
            while (isActive) {
                val now = SystemClock.elapsedRealtime()
                val recent = peers.filterValues { now - it.seenAt < 25_000 }
                if (now >= nextRefresh) {
                    refreshGroup()
                    links.keys.forEach(::advertise)
                    recent.keys.forEach(::advertise)
                    nextRefresh = now + 3_000
                }
                // Receiving a TXT record proves only that we saw the peer.
                // The other side may still need to find us before it invites us.
                // Keep discovery retries alive during that passive wait.
                val paused = groupPresent || outboundInvitation || now < invitationUntil
                discoverySchedule.next(now, paused)?.let { step ->
                    try {
                        action { manager.discoverServices(ch, it) }
                        trace("discovery step=$step accepted")
                    } catch (error: Exception) {
                        if (error is CancellationException) throw error
                        discoverySchedule.failed(SystemClock.elapsedRealtime())
                        Log.w(TAG, "discovery step=$step failed: ${error.message}")
                    }
                }
                delay(250)
            }
        }
        awaitClose { refresh.cancel(); teardown() }
    }.flowOn(Dispatchers.Main.immediate)

    private fun advertise(identity: String) {
        emitPeer?.invoke(PeerAdvertisement(identity, null, System.currentTimeMillis(), identity))
    }

    override suspend fun connect(peerId: String): Connection {
        links[peerId]?.let { return Connection(peerId, it.id) }
        // Android negotiates a single P2P group, so serialize invitations. Only
        // the lexically smaller identity initiates to avoid simultaneous invites.
        return connectLock.withLock {
            try {
                withContext(Dispatchers.Main.immediate) {
                    val ch = p2pChannel ?: throw IOException("Discovery not running")
                    if (!groupPresent && localIdentity < peerId) {
                        val peer = peers[peerId] ?: throw IOException("Peer is no longer available")
                        val config = WifiP2pConfig().apply {
                            deviceAddress = peer.address
                            wps.setup = WpsInfo.PBC
                        }
                        initiatedGroup = true
                        outboundInvitation = true
                        Log.i(TAG, "inviting peer=$peerId")
                        // Some Samsung stacks emit DEVICE_LOST when discovery is
                        // stopped and then reject connect for that same peer.
                        // Let connect stop radio discovery; suppress our periodic
                        // discoverServices calls while negotiation is in progress.
                        action { manager.connect(ch, config, it) }
                    }
                }
                withTimeoutOrNull(85_000) {
                    while (true) {
                        links[peerId]?.let { return@withTimeoutOrNull Connection(peerId, it.id) }
                        check(!stopped) { "Wi-Fi Direct stopped" }
                        delay(200)
                    }
                    @Suppress("UNREACHABLE_CODE") error("unreachable")
                } ?: throw IOException("Wi-Fi Direct connection timed out")
            } catch (error: Exception) {
                withContext(NonCancellable + Dispatchers.Main.immediate) {
                    if (!groupPresent && initiatedGroup) p2pChannel?.let { manager.cancelConnect(it, null) }
                }
                throw error
            } finally {
                withContext(NonCancellable + Dispatchers.Main.immediate) { outboundInvitation = false }
            }
        }
    }

    private fun refreshGroup() {
        val ch = p2pChannel ?: return
        runCatching {
            manager.requestConnectionInfo(ch) { info ->
                if (stopped) return@requestConnectionInfo
                if (!info.groupFormed) {
                    if (groupPresent) clearSockets()
                    groupPresent = false
                    return@requestConnectionInfo
                }
                groupPresent = true
                manager.requestGroupInfo(ch) { group ->
                    if (stopped || group == null) return@requestGroupInfo
                    if (peers.values.any { peer -> group.owner?.deviceAddress == peer.address ||
                            group.clientList.any { it.deviceAddress == peer.address } }) usedGroup = true
                    val name = group.`interface` ?: return@requestGroupInfo
                    if (groupInterface != null && groupInterface != name) clearSockets()
                    groupInterface = name
                    if (info.isGroupOwner) startServer(name)
                    else info.groupOwnerAddress?.let { startClient(name, it) }
                }
            }
        }.onFailure { Log.w(TAG, "group query: ${it.message}") }
    }

    private fun localAddress(name: String): InetAddress =
        NetworkInterface.getByName(name)?.inetAddresses?.toList()?.firstOrNull { it is Inet4Address && !it.isLoopbackAddress }
            ?: throw IOException("P2P interface has no IPv4 address: $name")

    private fun startServer(name: String) {
        if (serverJob?.isActive == true) return
        serverJob = scope.launch(Dispatchers.IO) {
            val listener = ServerSocket()
            server = listener
            try {
                listener.reuseAddress = true
                listener.bind(InetSocketAddress(localAddress(name), PORT))
                Log.i(TAG, "listening on $name ${listener.localSocketAddress}")
                while (isActive) {
                    val socket = listener.accept()
                    if (rawSockets.size >= 4) { socket.close(); continue }
                    rawSockets.add(socket)
                    launch { attach(socket) }
                }
            } catch (error: Exception) {
                if (isActive) Log.w(TAG, "server: ${error.message}")
            } finally {
                runCatching { listener.close() }
                if (server === listener) server = null
            }
        }
    }

    private fun startClient(name: String, owner: InetAddress) {
        if (clientJob?.isActive == true || links.isNotEmpty()) return
        clientJob = scope.launch(Dispatchers.IO) {
            val socket = Socket()
            rawSockets.add(socket)
            try {
                // Prefer an exact P2P Network; some Android versions do not expose
                // it to ConnectivityManager, so also bind the P2P source address.
                val network = connectivity?.allNetworks?.firstOrNull {
                    connectivity.getLinkProperties(it)?.interfaceName == name
                }
                network?.bindSocket(socket)
                socket.bind(InetSocketAddress(localAddress(name), 0))
                Log.i(TAG, "connecting via $name network=$network to ${owner.hostAddress}:$PORT")
                socket.connect(InetSocketAddress(owner, PORT), 8_000)
                attach(socket)
            } catch (error: Exception) {
                if (isActive) Log.w(TAG, "client: ${error.message}")
            } finally {
                rawSockets.remove(socket)
                runCatching { socket.close() }
            }
        }
    }

    private suspend fun attach(socket: Socket) = coroutineScope {
        var link: Link? = null
        try {
            socket.tcpNoDelay = true
            socket.soTimeout = 10_000
            val input = DataInputStream(socket.getInputStream().buffered())
            val output = DataOutputStream(socket.getOutputStream().buffered())
            WifiDirectFraming.writeIdentity(output, localIdentity)
            val identity = WifiDirectFraming.readIdentity(input)
            if (identity == localIdentity) throw IOException("Loopback identity")
            val next = Link(identity, socket, input, output)
            if (links.putIfAbsent(identity, next) != null) throw IOException("Duplicate peer socket")
            link = next
            usedGroup = true
            socket.soTimeout = 30_000
            advertise(identity)
            Log.i(TAG, "socket ready peer=$identity")
            val keepalive = launch {
                while (isActive) {
                    delay(5_000)
                    writeFrame(next, ByteArray(0))
                    advertise(identity)
                }
            }
            try {
                while (isActive) {
                    val bytes = WifiDirectFraming.read(input)
                    if (bytes.isNotEmpty()) messages.emit(identity to bytes)
                }
            } finally { keepalive.cancel() }
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            Log.w(TAG, "socket ended: ${error.message}")
        } finally {
            link?.let { links.remove(it.peer, it) }
            rawSockets.remove(socket)
            runCatching { socket.close() }
        }
    }

    private suspend fun writeFrame(link: Link, bytes: ByteArray) = link.writes.withLock {
        // Socket writes have no SO_TIMEOUT. A separate watchdog closes stalled
        // writes so cancellation/stop can never strand an IO worker indefinitely.
        coroutineScope {
            val deadline = launch(Dispatchers.Default) { delay(30_000); runCatching { link.socket.close() } }
            try { withContext(Dispatchers.IO) { WifiDirectFraming.write(link.output, bytes) } }
            finally { deadline.cancel() }
        }
    }

    override suspend fun send(connection: Connection, payload: ByteArray): TransferResult {
        if (payload.size > WifiDirectFraming.MAX_MESSAGE_BYTES) return TransferResult.Failed("Message too large")
        val link = links[connection.peerId]?.takeIf { it.id == connection.connectionId }
            ?: return TransferResult.Failed("Connection closed")
        val start = SystemClock.elapsedRealtime()
        return try {
            writeFrame(link, payload)
            TransferResult.Success(payload.size.toLong(), SystemClock.elapsedRealtime() - start)
        } catch (error: Exception) {
            runCatching { link.socket.close() }
            if (error is CancellationException) throw error
            TransferResult.Failed(error.message ?: "Socket write failed")
        }
    }

    override suspend fun resume(connection: Connection, payload: ByteArray, offsetBytes: Long): TransferResult =
        if (offsetBytes == 0L) send(connection, payload)
        else TransferResult.Failed("Wi-Fi Direct retries complete messages; partial-frame resume is unsupported")

    // Release a logical sync session. Keep the duplex socket available to the
    // other peer until group loss/teardown; local completion is not remote ACK.
    override suspend fun close(connection: Connection) = Unit

    private suspend fun action(call: (WifiP2pManager.ActionListener) -> Unit): Unit = withTimeoutOrNull(10_000) {
        suspendCancellableCoroutine<Unit> { continuation ->
            call(object : WifiP2pManager.ActionListener {
                override fun onSuccess() { if (continuation.isActive) continuation.resume(Unit) }
                override fun onFailure(reason: Int) {
                    if (continuation.isActive) continuation.resumeWithException(IOException("Wi-Fi Direct action failed: $reason"))
                }
            })
        }
    } ?: throw IOException("Wi-Fi Direct action timed out")

    private fun clearSockets() {
        serverJob?.cancel(); serverJob = null
        clientJob?.cancel(); clientJob = null
        runCatching { server?.close() }; server = null
        rawSockets.forEach { runCatching { it.close() } }
        rawSockets.clear()
        links.clear()
        groupInterface = null
    }

    fun teardown() {
        if (stopped) return
        stopped = true
        emitPeer = null
        clearSockets()
        scope.cancel()
        receiver?.let { runCatching { app.unregisterReceiver(it) } }
        receiver = null
        val ch = p2pChannel
        p2pChannel = null
        if (ch != null) {
            runCatching { manager.stopPeerDiscovery(ch, null) }
            runCatching { request?.let { manager.removeServiceRequest(ch, it, null) } }
            runCatching { service?.let { manager.removeLocalService(ch, it, null) } }
            // Remove only a group used by this transport, not an unrelated one.
            if (initiatedGroup || usedGroup) {
                runCatching { manager.cancelConnect(ch, null) }
                runCatching { manager.removeGroup(ch, null) }
            }
            ch.close()
        }
    }

    companion object {
        private const val TAG = "ResilientGeoWifi"
        private const val INSTANCE = "resilientgeo"
        private const val TYPE = "_rgmesh._tcp"
        private const val PORT = 8988
    }
}
