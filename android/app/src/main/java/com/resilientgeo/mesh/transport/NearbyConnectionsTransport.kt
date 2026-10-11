package com.resilientgeo.mesh.transport

import android.content.Context
import android.os.SystemClock
import android.util.Log
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.*
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.tasks.await
import java.io.IOException
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

/** Offline GMS transport. All SDK callbacks/state run on main; ingest stays in the sync engine. */
class NearbyConnectionsTransport(context: Context, private val onReady: () -> Unit = {}) : PeerTransport {
    override val localIdentity = "nearby:" + UUID.randomUUID().toString().replace("-", "")
    private val client = Nearby.getConnectionsClient(context.applicationContext)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val messages = MutableSharedFlow<Pair<String, ByteArray>>()
    override val receivedMessages: SharedFlow<Pair<String, ByteArray>> = messages
    private val inbox = Channel<Pair<String, ByteArray>>(8)
    private data class Peer(val identity: String, var visible: Boolean = true)
    private data class Link(val connection: Connection, val writes: Mutex = Mutex())
    private data class Sending(val endpoint: String, val result: CompletableDeferred<Unit>)
    private val peers = mutableMapOf<String, Peer>()
    private val links = mutableMapOf<String, Link>()
    private val connecting = mutableMapOf<String, CompletableDeferred<Connection>>()
    private val transfers = mutableMapOf<Long, Sending>()
    private val receivers = mutableMapOf<String, NearbyFraming.Receiver>()
    private val nextMessage = AtomicLong()
    private var emitPeer: ((PeerAdvertisement) -> Unit)? = null
    private var stopped = false

    init { scope.launch { for (message in inbox) messages.emit(message) } }

    private fun advertise(endpoint: String) {
        val peer = peers[endpoint] ?: return
        emitPeer?.invoke(PeerAdvertisement(endpoint, null, System.currentTimeMillis(), peer.identity))
    }

    private val payloads = object : PayloadCallback() {
        override fun onPayloadReceived(endpointId: String, payload: Payload) {
            if (stopped || endpointId !in links) return
            try {
                val bytes = payload.asBytes() ?: throw IOException("Expected Nearby BYTES frame")
                val complete = receivers.getOrPut(endpointId) { NearbyFraming.Receiver() }
                    .accept(bytes, SystemClock.elapsedRealtime()) ?: return
                val identity = peers[endpointId]?.identity ?: throw IOException("Unknown Nearby peer")
                if (!inbox.trySend(identity to complete).isSuccess) throw IOException("Nearby receive queue full")
            } catch (error: Exception) {
                Log.w(TAG, "Rejected payload: ${error.message}")
                client.cancelPayload(payload.id)
                disconnect(endpointId, error)
            }
        }

        override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {
            val sending = transfers[update.payloadId] ?: return
            if (sending.endpoint != endpointId) return
            when (update.status) {
                PayloadTransferUpdate.Status.SUCCESS -> sending.result.complete(Unit)
                PayloadTransferUpdate.Status.FAILURE, PayloadTransferUpdate.Status.CANCELED ->
                    sending.result.completeExceptionally(IOException("Nearby payload status=${update.status}"))
            }
        }
    }

    private val lifecycle = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
            if (stopped || !validIdentity(info.endpointName) || links.size >= MAX_PEERS) {
                client.rejectConnection(endpointId)
                return
            }
            val known = peers[endpointId]
            if (known != null && known.identity != info.endpointName) {
                client.rejectConnection(endpointId)
                return
            }
            peers[endpointId] = Peer(info.endpointName)
            // Nearby endpoint names are routing hints, NOT trust. Only signed public
            // mesh data is exchanged and the repository still verifies every chunk.
            connecting.getOrPut(endpointId) { CompletableDeferred() }
            client.acceptConnection(endpointId, payloads).addOnFailureListener { disconnect(endpointId, it) }
        }

        override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {
            if (stopped) { client.disconnectFromEndpoint(endpointId); return }
            if (!result.status.isSuccess) {
                disconnect(endpointId, IOException("Nearby connection status=${result.status.statusCode}"))
                return
            }
            if (endpointId !in peers) { disconnect(endpointId, IOException("Unknown endpoint")); return }
            val connection = Connection(endpointId, UUID.randomUUID().toString())
            links[endpointId] = Link(connection)
            connecting.remove(endpointId)?.complete(connection)
            advertise(endpointId)
        }

        override fun onDisconnected(endpointId: String) {
            forgetConnection(endpointId, IOException("Nearby disconnected"))
        }
    }

    private val discovery = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
            if (stopped || info.serviceId != SERVICE_ID || !validIdentity(info.endpointName) ||
                info.endpointName == localIdentity || (endpointId !in peers && peers.size >= MAX_PEERS)) return
            if (peers[endpointId]?.identity?.let { it != info.endpointName } == true) {
                disconnect(endpointId, IOException("Nearby endpoint identity changed"))
            }
            peers[endpointId] = Peer(info.endpointName)
            advertise(endpointId)
        }
        override fun onEndpointLost(endpointId: String) {
            peers[endpointId]?.visible = false
            if (endpointId !in links && endpointId !in connecting) peers.remove(endpointId)
        }
    }

    override fun discover(): Flow<PeerAdvertisement> = callbackFlow {
        check(!stopped && emitPeer == null)
        emitPeer = { trySend(it) }
        try {
            withTimeout(15_000) {
                client.startAdvertising(localIdentity, SERVICE_ID, lifecycle,
                    AdvertisingOptions.Builder().setStrategy(Strategy.P2P_POINT_TO_POINT).build())
                    .addOnSuccessListener { if (stopped) client.stopAdvertising() }.await()
                client.startDiscovery(SERVICE_ID,
                    discovery, DiscoveryOptions.Builder().setStrategy(Strategy.P2P_POINT_TO_POINT).build())
                    .addOnSuccessListener { if (stopped) client.stopDiscovery() }.await()
            }
            Log.i(TAG, "Nearby advertising and discovery ready")
            onReady()
        } catch (error: Exception) {
            Log.e(TAG, "Nearby startup failed", error)
            teardown()
            throw error
        }
        val refresh = scope.launch {
            while (isActive) {
                peers.filter { it.value.visible || it.key in links }.keys.toList().forEach(::advertise)
                delay(3_000)
            }
        }
        awaitClose { refresh.cancel(); teardown() }
    }.flowOn(Dispatchers.Main.immediate)

    override suspend fun connect(peerId: String): Connection = withContext(Dispatchers.Main.immediate) {
        check(!stopped)
        links[peerId]?.let { return@withContext it.connection }
        val peer = peers[peerId] ?: throw IOException("Nearby peer disappeared")
        val pending = connecting.getOrPut(peerId) { CompletableDeferred() }
        try {
            withTimeout(25_000) {
                // Both engines discover. Only one side invites; the other accepts and
                // waits for the very same full-duplex connection.
                if (localIdentity < peer.identity) client.requestConnection(localIdentity, peerId, lifecycle).await()
                pending.await()
            }
        } catch (error: Exception) {
            disconnect(peerId, error)
            throw error
        }
    }

    override suspend fun send(connection: Connection, payload: ByteArray): TransferResult = withContext(Dispatchers.Main.immediate) {
        val link = links[connection.peerId]
        if (link == null || link.connection != connection) return@withContext TransferResult.Failed("Nearby link closed")
        if (payload.size !in 1..NearbyFraming.MAX_MESSAGE_BYTES) return@withContext TransferResult.Failed("Invalid Nearby message size")
        link.writes.withLock {
            val started = SystemClock.elapsedRealtime()
            try {
                withTimeout(120_000) {
                    for (frame in NearbyFraming.encode(nextMessage.incrementAndGet(), payload)) {
                        val part = Payload.fromBytes(frame)
                        val completed = CompletableDeferred<Unit>()
                        transfers[part.id] = Sending(connection.peerId, completed)
                        try {
                            client.sendPayload(connection.peerId, part).await()
                            withTimeout(30_000) { completed.await() }
                        } finally {
                            transfers.remove(part.id)
                            if (!completed.isCompleted) client.cancelPayload(part.id)
                        }
                    }
                }
                TransferResult.Success(payload.size.toLong(), SystemClock.elapsedRealtime() - started)
            } catch (error: Exception) {
                if (error is CancellationException && error !is TimeoutCancellationException) throw error
                disconnect(connection.peerId, error)
                TransferResult.Failed(error.message ?: "Nearby send failed")
            }
        }
    }

    override suspend fun resume(connection: Connection, payload: ByteArray, offsetBytes: Long): TransferResult =
        if (offsetBytes == 0L) send(connection, payload)
        else TransferResult.Failed("Nearby retries complete messages after a fresh inventory diff")

    // A finished requester must not tear down the other direction's in-flight data.
    override suspend fun close(connection: Connection) = Unit

    private fun forgetConnection(endpoint: String, error: Exception) {
        links.remove(endpoint)
        receivers.remove(endpoint)?.clear()
        connecting.remove(endpoint)?.completeExceptionally(error)
        transfers.values.filter { it.endpoint == endpoint }.forEach { it.result.completeExceptionally(error) }
        if (peers[endpoint]?.visible == false) peers.remove(endpoint)
    }

    private fun disconnect(endpoint: String, error: Exception) {
        forgetConnection(endpoint, error)
        client.disconnectFromEndpoint(endpoint)
    }

    /** Call on main, as with the platform Wi-Fi transport. */
    fun teardown() {
        if (stopped) return
        stopped = true
        emitPeer = null
        runCatching { client.stopAdvertising() }
        runCatching { client.stopDiscovery() }
        runCatching { client.stopAllEndpoints() }
        val error = IOException("Nearby stopped")
        connecting.values.forEach { it.completeExceptionally(error) }
        transfers.values.forEach { it.result.completeExceptionally(error) }
        connecting.clear(); transfers.clear(); peers.clear(); links.clear(); receivers.clear()
        inbox.close()
        scope.cancel()
    }

    companion object {
        private const val TAG = "ResilientGeoNearby"
        private const val MAX_PEERS = 16
        const val SERVICE_ID = "com.resilientgeo.mesh.nearby.v1"
        fun validIdentity(value: String) = value.matches(Regex("nearby:[0-9a-f]{32}"))
    }
}
