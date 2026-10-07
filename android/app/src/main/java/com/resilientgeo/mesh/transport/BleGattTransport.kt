package com.resilientgeo.mesh.transport

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.ParcelUuid
import android.util.Log
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.security.SecureRandom

/**
 * ADR-001's third bulk-transfer candidate — plain BLE GATT, and the one
 * that was adopted, after both Nearby Connections (Google Play services
 * INTERNAL_ERROR) and native Wi-Fi Direct (raw P2P sockets: confirmed TCP
 * connect timeout to a correctly bound, listening ServerSocket despite
 * working ICMP — looks like an Android per-app default-network routing
 * issue, not fixable quickly) hit real platform-level blockers on the
 * Stage 0 test devices, independent of application code.
 *
 * Those original spikes were removed; the measurement history lives in
 * docs/adr/ADR-001-transport-layer.md. A new optional WifiDirectTransport
 * was added on 2026-10-04; BLE remains the default transport.
 *
 * Unlike those two, this reuses [BleDiscovery]'s already-proven-reliable
 * advertise/scan pair (see C_BLEbroadcast.md) and layers real data transfer
 * on top via a custom GATT service: one WRITE characteristic (central ->
 * peripheral chunk stream) and one NOTIFY characteristic (peripheral -> ack).
 * Every device runs BOTH roles simultaneously — its own GATT server
 * (peripheral, receives inbound data from whoever connects to it) and, once
 * [discover] finds a peer's advertisement, a GATT client connection to that
 * peer (central, so it can send). Real event/chunk payloads for this
 * project are KB-scale, not the 1/10MB ADR-001 originally stress-tested
 * Nearby/Wi-Fi Direct against — BLE's lower throughput is not expected to
 * be a problem for the actual application, only for that stress-test number.
 *
 * Wire framing: every WRITE (first and continuation alike) is prefixed with
 * a 1-byte message sequence number; the first write of a message additionally
 * carries a 4-byte big-endian length header right after that byte, then as
 * much payload as fits in one negotiated-MTU write; later writes for the same
 * message are [seq byte][pure continuation bytes] until the declared length
 * is reached, then the peripheral NOTIFYs a 1-byte ack back. GATT writes must
 * be issued one at a time — the stack does not support overlapping
 * writeCharacteristic() calls — so throughput is bounded by round-trip
 * latency per chunk, not just MTU.
 *
 * The sequence byte exists because the receiver has no other way to tell
 * "this write starts a new message" apart from "this write continues the one
 * I'm already accumulating" — see [handleIncomingChunk]'s doc comment for the
 * real-device corruption this fixes.
 */
class BleGattTransport(
    private val context: Context,
    private val adapter: BluetoothAdapter,
) : PeerTransport {

    private val identityBytes = ByteArray(8).also { SecureRandom().nextBytes(it) }
    override val localIdentity: String = "ble:" + identityBytes.joinToString("") { "%02x".format(it) }

    companion object {
        private const val TAG = "ResilientGeoBleGatt"
        val SERVICE_UUID: UUID = BleDiscovery.SERVICE_UUID
        val DATA_CHARACTERISTIC_UUID: UUID = UUID.fromString("8f6a1c01-0000-4000-8000-00805f9b34fb")
        val ACK_CHARACTERISTIC_UUID: UUID = UUID.fromString("8f6a1c02-0000-4000-8000-00805f9b34fb")

        // Out-of-band control signaling (docs/jia-task-sequence.md item 8,
        // cross-contact resume) — deliberately separate from
        // DATA_CHARACTERISTIC. A control write is delivered to the peer
        // whole, in one shot, with no relation to whatever DATA_CHARACTERISTIC
        // message is (or isn't) currently in flight. That independence is
        // the entire point: reproduced on a real device where a sender,
        // after abandoning a still-incomplete DATA transfer, tried to
        // announce that fact over the SAME DATA_CHARACTERISTIC — the
        // receiver's handleIncomingChunk() has no notion of "message
        // boundary" beyond a running byte count against the length header
        // from the FIRST write of whatever's currently accumulating, so it
        // silently appended the new message's bytes onto the old,
        // still-incomplete one instead of recognizing a fresh message. The
        // sender's write itself succeeded; the receiver just never reached
        // enough bytes to ack anything, so the sender's ack wait timed out
        // 30s later with no error on either side pointing at the real
        // cause. A dedicated characteristic sidesteps this entirely: it never
        // touches incomingMessages' accumulation state.
        val CONTROL_CHARACTERISTIC_UUID: UUID = UUID.fromString("8f6a1c03-0000-4000-8000-00805f9b34fb")
        private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        private const val DESIRED_MTU = 247
        private const val HEADER_BYTES = 4
        private const val SEQ_BYTES = 1
        private const val WRITE_TIMEOUT_MS = 10_000L
        private const val ACK_TIMEOUT_MS = 30_000L
    }

    private val bluetoothManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
    private val advertiser get() = adapter.bluetoothLeAdvertiser
    private val scanner get() = adapter.bluetoothLeScanner

    private data class CentralLink(
        val gatt: BluetoothGatt,
        val dataCharacteristic: BluetoothGattCharacteristic,
        val ackCharacteristic: BluetoothGattCharacteristic,
        val controlCharacteristic: BluetoothGattCharacteristic,
        val mtuPayloadSize: Int,
        val pending: PendingOperations,
    )

    private val centralLinks = ConcurrentHashMap<String, CentralLink>()

    // Callbacks belong to a GATT instance, including late callbacks after a
    // timeout. They must never acknowledge a different peer or retry's send.
    private class PendingOperations {
        @Volatile var writeAck: CompletableDeferred<Boolean>? = null
        @Volatile var ackNotify: CompletableDeferred<Unit>? = null
        @Volatile var controlWriteAck: CompletableDeferred<Boolean>? = null
    }

    @Volatile
    var interruptRequested = false

    // --- GATT server (peripheral): receives inbound data regardless of
    // which peer connects to us as central. ---

    private var gattServer: BluetoothGattServer? = null

    // Keyed by (peer address, sequence number) rather than just peer address
    // — see [handleIncomingChunk]'s doc comment for why a single slot per
    // peer isn't enough once a message can be interrupted and resumed after
    // other messages have already flowed on the same connection.
    private data class IncomingMessageKey(val peerAddress: String, val seq: Int)
    private val incomingMessages = ConcurrentHashMap<IncomingMessageKey, IncomingMessage>()
    private val subscribedDevices = ConcurrentHashMap<String, BluetoothDevice>()

    /**
     * Every fully-received message, as (peerId, payload bytes). Stage 0's
     * spike only ever cared whether a transfer completed, so the received
     * bytes were discarded right after acking (see [handleIncomingChunk]) —
     * fine for measuring throughput, useless for running an actual
     * HELLO/DIFF/REQUEST/TRANSFER protocol on top, which needs to read what
     * was sent. `extraBufferCapacity` + DROP_OLDEST: a slow/absent
     * collector should not block the GATT callback thread from acking.
     */
    private val _receivedMessages = MutableSharedFlow<Pair<String, ByteArray>>(
        extraBufferCapacity = 32,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    override val receivedMessages: SharedFlow<Pair<String, ByteArray>> get() = _receivedMessages

    /** Every control message, delivered whole in a single GATT write — see [CONTROL_CHARACTERISTIC_UUID]. */
    private val _controlMessages = MutableSharedFlow<Pair<String, ByteArray>>(
        extraBufferCapacity = 32,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val controlMessages: SharedFlow<Pair<String, ByteArray>> get() = _controlMessages

    private class IncomingMessage {
        var expectedLength: Int = -1
        val buffer = ByteArrayOutputStream()
    }

    private val gattServerCallback = object : BluetoothGattServerCallback() {
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            Log.i(TAG, "server: onConnectionStateChange device=${device.address} status=$status newState=$newState")
            if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                incomingMessages.keys.removeIf { it.peerAddress == device.address }
                subscribedDevices.remove(device.address)
            }
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray,
        ) {
            if (characteristic.uuid == DATA_CHARACTERISTIC_UUID) {
                handleIncomingChunk(device, value)
            } else if (characteristic.uuid == CONTROL_CHARACTERISTIC_UUID) {
                Log.i(TAG, "server: received control message (${value.size} bytes) from ${device.address}")
                _controlMessages.tryEmit(device.address to value)
            }
            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
            }
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray,
        ) {
            if (descriptor.uuid == CCCD_UUID) {
                if (value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)) {
                    subscribedDevices[device.address] = device
                    Log.i(TAG, "server: ${device.address} subscribed to ACK notifications")
                } else {
                    subscribedDevices.remove(device.address)
                }
            }
            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
            }
        }
    }

    /**
     * Real-device bug this fixes: when critical-first REQUEST batches were
     * layered on top of cross-contact resume (4 chunks requested at once,
     * one deliberately interrupted mid-transfer), the sender's next chunk in
     * the batch started a brand-new message on the SAME connection before
     * the interrupted one had been resumed. The old code kept exactly one
     * `IncomingMessage` per peer address and only knew a message was "done"
     * by comparing accumulated byte count against the length header parsed
     * from the very first write it ever saw for that peer — it had no way to
     * tell "this write starts a new message" apart from "this write
     * continues the one I'm mid-accumulating". The next chunk's header +
     * payload bytes got silently appended onto the still-incomplete previous
     * chunk's buffer, byte count eventually crossed the (wrong) expected
     * length, and a corrupt spliced payload got emitted and ack'd as if it
     * were the interrupted chunk — which also sent a premature ack back to
     * the sender for a message it hadn't finished writing yet, cascading
     * into the *next* chunk's ack timing out too.
     *
     * The fix: every write now carries a 1-byte sequence number (see the
     * class doc comment), and incoming messages are tracked per
     * (peer address, seq) instead of per peer address alone. A chunk that
     * gets interrupted and resumed later — even after other unrelated
     * messages have completed on the same connection in between — keeps its
     * own slot under its own seq, so a resume's headerless continuation
     * bytes always find their way back to the right partial buffer instead
     * of whatever the receiver happened to be accumulating most recently.
     *
     * Known limitation kept out of scope for v0: a slot for a seq that is
     * interrupted and never resumed lingers in [incomingMessages] until
     * disconnect (or, in principle, until the 1-byte seq counter wraps back
     * around to it 256 messages later). Fine for this project's short-lived
     * opportunistic-contact connections; would need an idle-slot eviction
     * timer for a transport meant to stay connected indefinitely.
     */
    private fun handleIncomingChunk(device: BluetoothDevice, value: ByteArray) {
        if (value.isEmpty()) return
        val seq = value[0].toInt() and 0xFF
        val key = IncomingMessageKey(device.address, seq)
        val message = incomingMessages.getOrPut(key) { IncomingMessage() }

        val payloadChunk = if (message.expectedLength < 0) {
            val header = ByteBuffer.wrap(value, SEQ_BYTES, HEADER_BYTES).order(ByteOrder.BIG_ENDIAN)
            message.expectedLength = header.int
            value.copyOfRange(SEQ_BYTES + HEADER_BYTES, value.size)
        } else {
            value.copyOfRange(SEQ_BYTES, value.size)
        }
        message.buffer.write(payloadChunk)

        if (message.buffer.size() >= message.expectedLength) {
            Log.i(TAG, "server: received full message seq=$seq (${message.buffer.size()} bytes) from ${device.address}")
            incomingMessages.remove(key)
            _receivedMessages.tryEmit(device.address to message.buffer.toByteArray())
            sendAck(device)
        }
    }

    private fun sendAck(device: BluetoothDevice) {
        val server = gattServer ?: return
        val ackChar = server.getService(SERVICE_UUID)?.getCharacteristic(ACK_CHARACTERISTIC_UUID) ?: return
        if (!subscribedDevices.containsKey(device.address)) {
            Log.e(TAG, "server: ${device.address} never subscribed to ACK notifications; can't ack")
            return
        }
        val ackValue = byteArrayOf(1)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            server.notifyCharacteristicChanged(device, ackChar, false, ackValue)
        } else {
            @Suppress("DEPRECATION")
            run {
                ackChar.value = ackValue
                server.notifyCharacteristicChanged(device, ackChar, false)
            }
        }
    }

    private fun ensureGattServerStarted() {
        if (gattServer != null) return
        val server = bluetoothManager.openGattServer(context, gattServerCallback)
        val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        val dataChar = BluetoothGattCharacteristic(
            DATA_CHARACTERISTIC_UUID,
            BluetoothGattCharacteristic.PROPERTY_WRITE,
            BluetoothGattCharacteristic.PERMISSION_WRITE,
        )
        val ackChar = BluetoothGattCharacteristic(
            ACK_CHARACTERISTIC_UUID,
            BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_READ,
        )
        ackChar.addDescriptor(
            BluetoothGattDescriptor(CCCD_UUID, BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE),
        )
        val controlChar = BluetoothGattCharacteristic(
            CONTROL_CHARACTERISTIC_UUID,
            BluetoothGattCharacteristic.PROPERTY_WRITE,
            BluetoothGattCharacteristic.PERMISSION_WRITE,
        )
        service.addCharacteristic(dataChar)
        service.addCharacteristic(ackChar)
        service.addCharacteristic(controlChar)
        server.addService(service)
        gattServer = server
    }

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
            Log.i(TAG, "advertise started ok")
        }

        override fun onStartFailure(errorCode: Int) {
            Log.e(TAG, "advertise failed to start, errorCode=$errorCode")
            onAdvertisingFailure?.invoke(errorCode)
        }
    }

    fun startAdvertising() {
        ensureGattServerStarted()
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setConnectable(true)
            .build()
        val data = AdvertiseData.Builder()
            // 3-byte flags + 2-byte AD header + 16-byte UUID + 8-byte identity
            // = 29 bytes. Identity is present in the primary packet, so sync
            // does not depend on receiving/merging an active scan response.
            .addServiceData(ParcelUuid(SERVICE_UUID), identityBytes)
            .setIncludeDeviceName(false)
            .build()
        // Keep the UUID list in the scan response for older discovery harnesses.
        val response = AdvertiseData.Builder()
            .addServiceUuid(ParcelUuid(SERVICE_UUID))
            .build()
        advertiser?.startAdvertising(settings, data, response, advertiseCallback)
            ?: Log.e(TAG, "no BLE advertiser available on this device")
    }

    fun stopAdvertising() {
        advertiser?.stopAdvertising(advertiseCallback)
    }

    // --- discovery (central-side scanning, identical filtering to BleDiscovery) ---

    private var onPeerFound: ((PeerAdvertisement) -> Unit)? = null
    private var scanCallback: ScanCallback? = null
    private var onAdvertisingFailure: ((Int) -> Unit)? = null

    override fun discover(): Flow<PeerAdvertisement> = callbackFlow {
        if (advertiser == null || scanner == null) throw IllegalStateException("BLE advertise/scan unavailable")
        onAdvertisingFailure = { close(IllegalStateException("BLE advertise failed: $it")) }
        onPeerFound = { advertisement -> trySend(advertisement) }
        startAdvertising()

        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val record = result.scanRecord ?: return
                val serviceData = record.getServiceData(ParcelUuid(SERVICE_UUID))
                // Do not trust hardware offload to filter every result. Real
                // devices delivered unrelated advertisements with a null data
                // pattern, inflating the nearby Mesh count to dozens of nodes.
                if (serviceData == null && record.serviceUuids?.contains(ParcelUuid(SERVICE_UUID)) != true) return
                val identity = serviceData
                    ?.takeIf { it.size == 8 }
                    ?.let { bytes -> "ble:" + bytes.joinToString("") { "%02x".format(it) } }
                onPeerFound?.invoke(
                    PeerAdvertisement(
                        peerId = result.device.address,
                        rssi = result.rssi,
                        discoveredAtMillis = System.currentTimeMillis(),
                        transportIdentity = identity,
                    ),
                )
            }

            override fun onScanFailed(errorCode: Int) {
                Log.e(TAG, "scan failed to start, errorCode=$errorCode")
                close(IllegalStateException("BLE scan failed: $errorCode"))
            }
        }
        scanCallback = callback
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        // Filters are ORed: match self-contained new advertisements as well as
        // the UUID-list advertisements sent by previous versions.
        val filters = listOf(
            ScanFilter.Builder().setServiceData(ParcelUuid(SERVICE_UUID), byteArrayOf()).build(),
            ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build(),
        )
        scanner?.startScan(filters, settings, callback)
            ?: Log.e(TAG, "no BLE scanner available on this device")

        awaitClose {
            onAdvertisingFailure = null
            onPeerFound = null
            // Bluetooth may have been disabled or permission revoked while
            // scanning. Cleanup must still release the remaining resources.
            runCatching { scanner?.stopScan(callback) }
            scanCallback = null
            runCatching { stopAdvertising() }
        }
    }

    // --- connect (central role: connectGatt to a discovered peer) ---

    // Guards against two overlapping connect() calls for the same peer (a
    // double-tap in a caller's UI, or a retry racing the original attempt)
    // firing two concurrent device.connectGatt()s. Reproduced on a real
    // device: two connect() calls ~30ms apart both issued connectGatt(),
    // neither the 15s local timeout NOR the underlying native connection
    // ever resolved on schedule — the real onConnectionStateChange(status=147)
    // only arrived ~30s later, well after both callers had already given up.
    // A single mutex (not per-peer) matches this class's existing
    // single-flight assumption for sends (see sendMutex).
    private val connectMutex = Mutex()

    override suspend fun connect(peerId: String): Connection {
        centralLinks[peerId]?.let { return Connection(peerId = peerId, connectionId = peerId) }
        return connectMutex.withLock { connectLocked(peerId) }
    }

    private suspend fun connectLocked(peerId: String): Connection {
        centralLinks[peerId]?.let { return Connection(peerId = peerId, connectionId = peerId) }

        val device = adapter.getRemoteDevice(peerId)
        val connected = CompletableDeferred<Boolean>()
        val servicesDiscovered = CompletableDeferred<Boolean>()
        // Some devices fire an unsolicited onMtuChanged (a system-initiated
        // MTU exchange right at connect time, before we ever call
        // requestMtu()) — confirmed on a Pixel 7 via logcat: onConfigureMTU
        // arrives ~4ms after onConnectionStateChange, well before
        // discoverServices() even runs. A plain CompletableDeferred created
        // up front would be completed by that stray event, so the later
        // withTimeoutOrNull { mtuDeferred.await() } (meant to wait for OUR
        // requestMtu() call) returns immediately with the stale value —
        // control then reaches writeCharacteristic() while our real
        // requestMtu() is still in flight at the GATT stack level (only one
        // outstanding op is allowed), and the write is rejected outright.
        // Indirected through a ref that's only populated right before we
        // issue requestMtu() so any earlier, unsolicited event is dropped.
        val mtuDeferredRef = java.util.concurrent.atomic.AtomicReference<CompletableDeferred<Int>?>(null)
        val descriptorWriteDeferred = CompletableDeferred<Boolean>()
        val pending = PendingOperations()

        val callback = object : BluetoothGattCallback() {
            override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
                Log.i(TAG, "client: onConnectionStateChange peer=$peerId status=$status newState=$newState")
                when (newState) {
                    BluetoothProfile.STATE_CONNECTED -> connected.complete(status == BluetoothGatt.GATT_SUCCESS)
                    BluetoothProfile.STATE_DISCONNECTED -> {
                        connected.complete(false)
                        servicesDiscovered.complete(false)
                        descriptorWriteDeferred.complete(false)
                        // A late callback from a failed attempt must not remove
                        // the replacement connection established by a retry.
                        centralLinks[peerId]?.takeIf { it.gatt === gatt }?.let { centralLinks.remove(peerId, it) }
                        gatt.close()
                    }
                }
            }

            override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                servicesDiscovered.complete(status == BluetoothGatt.GATT_SUCCESS)
            }

            override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
                mtuDeferredRef.get()?.complete(if (status == BluetoothGatt.GATT_SUCCESS) mtu else 23)
            }

            override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
                descriptorWriteDeferred.complete(status == BluetoothGatt.GATT_SUCCESS)
            }

            override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
                val ok = status == BluetoothGatt.GATT_SUCCESS
                if (characteristic.uuid == CONTROL_CHARACTERISTIC_UUID) {
                    pending.controlWriteAck?.complete(ok)
                } else {
                    pending.writeAck?.complete(ok)
                }
            }

            override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
                if (characteristic.uuid == ACK_CHARACTERISTIC_UUID) pending.ackNotify?.complete(Unit)
            }

            @Suppress("DEPRECATION")
            override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
                if (characteristic.uuid == ACK_CHARACTERISTIC_UUID) pending.ackNotify?.complete(Unit)
            }
        }

        val gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
        var retained = false
        try {
            val connectedOk = withTimeoutOrNull(15_000) { connected.await() } ?: false
            if (!connectedOk) throw IllegalStateException("GATT connect failed/timed out for $peerId")

            check(gatt.discoverServices()) { "service discovery could not start for $peerId" }
            val discoveredOk = withTimeoutOrNull(10_000) { servicesDiscovered.await() } ?: false
            if (!discoveredOk) throw IllegalStateException("service discovery failed for $peerId")

            val service = gatt.getService(SERVICE_UUID)
                ?: throw IllegalStateException("peer $peerId doesn't expose our GATT service")
            val dataChar = service.getCharacteristic(DATA_CHARACTERISTIC_UUID)
                ?: throw IllegalStateException("peer $peerId missing data characteristic")
            val ackChar = service.getCharacteristic(ACK_CHARACTERISTIC_UUID)
                ?: throw IllegalStateException("peer $peerId missing ack characteristic")
            val controlChar = service.getCharacteristic(CONTROL_CHARACTERISTIC_UUID)
                ?: throw IllegalStateException("peer $peerId missing control characteristic")

            check(gatt.setCharacteristicNotification(ackChar, true)) { "ACK notifications unavailable for $peerId" }
            val cccd = ackChar.getDescriptor(CCCD_UUID)
                ?: throw IllegalStateException("peer $peerId missing ACK subscription descriptor")
            val subscriptionQueued = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                gatt.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == BluetoothGatt.GATT_SUCCESS
            } else {
                @Suppress("DEPRECATION")
                run {
                    cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    gatt.writeDescriptor(cccd)
                }
            }
            check(subscriptionQueued) { "ACK subscription could not start for $peerId" }
            check(withTimeoutOrNull(5_000) { descriptorWriteDeferred.await() } == true) {
                "ACK subscription failed/timed out for $peerId"
            }

            val mtuDeferred = CompletableDeferred<Int>()
            mtuDeferredRef.set(mtuDeferred)
            val negotiatedMtu = if (gatt.requestMtu(DESIRED_MTU)) {
                withTimeoutOrNull(5_000) { mtuDeferred.await() }
                    ?: throw IllegalStateException("MTU negotiation timed out for $peerId")
            } else 23

            centralLinks[peerId] = CentralLink(
                gatt = gatt,
                dataCharacteristic = dataChar,
                ackCharacteristic = ackChar,
                controlCharacteristic = controlChar,
                // BLE's ATT spec caps a single attribute value at 512 bytes
                // regardless of negotiated ATT_MTU (which can go up to 517) —
                // a negotiated MTU of 517 gives (517-3)=514 bytes of "room" that
                // writeCharacteristic() then rejects with "value should not be
                // longer than max length of an attribute value". Confirmed by
                // hitting that exact exception on a real device before adding
                // this cap.
                mtuPayloadSize = (negotiatedMtu - 3).coerceIn(20, 512),
                pending = pending,
            )
            Log.i(TAG, "connected to $peerId, mtuPayloadSize=${negotiatedMtu - 3}")

            retained = true
            return Connection(peerId = peerId, connectionId = peerId)
        } finally {
            // connect() can be cancelled by the engine before CentralLink is
            // published. close(Connection) cannot reach that GATT instance.
            if (!retained) {
                try { gatt.disconnect() } finally { gatt.close() }
            }
        }
    }

    // Serialize complete messages so HELLO/REQUEST/TRANSFER never replace
    // another send's ACK waiter or overlap Android GATT write operations.
    private val sendMutex = Mutex()

    // Outbound sequence numbering, per connection. `send()` (a brand-new
    // message) always allocates the next seq; `resume()` reuses whatever seq
    // was allocated for the interrupted attempt it's continuing, so the
    // receiver's [handleIncomingChunk] can match the continuation bytes back
    // to the right in-progress buffer regardless of what else has been sent
    // on this connection in between. Single-flight (matches sendMutex): only
    // the most recent interruption per connection is remembered — fine for
    // this project's REQUEST-then-TRANSFER flow, where only one chunk in a
    // batch is ever deliberately interrupted, but NOT safe if two different
    // messages on the same connection could both be mid-interruption at
    // once (the second would clobber the first's recorded seq here).
    //
    // Reproduced live on a real device: the success-path cleanup used to
    // unconditionally clear this map entry, so a LATER unrelated chunk in
    // the same critical-first batch completing successfully wiped out an
    // EARLIER chunk's still-pending interruption record before it was ever
    // resumed — the resume then fell back to a fresh seq, which the receiver
    // correctly treated as a brand-new headerless message (no length header
    // to parse, since resume() sends continuation bytes only) and never
    // completed, timing out 30s later. Fixed by only clearing the record
    // when the seq that just succeeded is the one currently recorded — see
    // the `interruptedSeqByConnection[...] == seq` check below.
    private val nextSeqByConnection = ConcurrentHashMap<String, Int>()
    private val interruptedSeqByConnection = ConcurrentHashMap<String, Int>()

    private fun allocateSeq(connectionId: String): Int =
        nextSeqByConnection.compute(connectionId) { _, previous -> ((previous ?: -1) + 1) and 0xFF }!!

    override suspend fun send(connection: Connection, payload: ByteArray): TransferResult =
        sendMutex.withLock { transfer(connection, payload, offsetBytes = 0L) }

    override suspend fun resume(connection: Connection, payload: ByteArray, offsetBytes: Long): TransferResult =
        sendMutex.withLock { transfer(connection, payload, offsetBytes) }

    // Independent of sendMutex/DATA_CHARACTERISTIC on purpose — see
    // CONTROL_CHARACTERISTIC_UUID's doc comment. Not part of PeerTransport:
    // this is a BleGattTransport-specific escape hatch for small,
    // out-of-band signaling (e.g. "I abandoned an in-progress TRANSFER at
    // byte N"), not a general-purpose second data channel — no framing,
    // no ack-notify, must fit in one GATT write.
    private val controlMutex = Mutex()

    suspend fun sendControl(connection: Connection, payload: ByteArray): TransferResult = controlMutex.withLock {
        val link = centralLinks[connection.connectionId]
            ?: return@withLock TransferResult.Failed("no active GATT link for ${connection.connectionId}; call connect() again")
        if (payload.size > link.mtuPayloadSize) {
            return@withLock TransferResult.Failed(
                "control payload ${payload.size} bytes exceeds mtuPayloadSize=${link.mtuPayloadSize}; " +
                    "control messages must fit in a single GATT write",
            )
        }

        val writeDeferred = CompletableDeferred<Boolean>()
        link.pending.controlWriteAck = writeDeferred
        val queued = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            link.gatt.writeCharacteristic(
                link.controlCharacteristic,
                payload,
                BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT,
            ) == BluetoothGatt.GATT_SUCCESS
        } else {
            @Suppress("DEPRECATION")
            run {
                link.controlCharacteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                link.controlCharacteristic.value = payload
                link.gatt.writeCharacteristic(link.controlCharacteristic)
            }
        }
        if (!queued) {
            link.pending.controlWriteAck = null
            return@withLock TransferResult.Failed("writeCharacteristic() failed to queue control payload")
        }
        val ok = withTimeoutOrNull(WRITE_TIMEOUT_MS) { writeDeferred.await() } ?: false
        link.pending.controlWriteAck = null
        if (!ok) {
            TransferResult.Failed("control write failed/timed out")
        } else {
            TransferResult.Success(bytesTransferred = payload.size.toLong(), durationMillis = 0)
        }
    }

    private suspend fun transfer(connection: Connection, payload: ByteArray, offsetBytes: Long): TransferResult {
        val link = centralLinks[connection.connectionId]
            ?: return TransferResult.Failed("no active GATT link for ${connection.connectionId}; call connect() again")

        val remaining = if (offsetBytes in 1 until payload.size.toLong()) {
            payload.copyOfRange(offsetBytes.toInt(), payload.size)
        } else {
            payload
        }

        val startedAt = System.currentTimeMillis()
        var sent = 0
        val chunkSize = link.mtuPayloadSize
        var offset = 0
        // The length header is a property of the MESSAGE (so the receiver's
        // handleIncomingChunk knows the total expectedLength once, from the
        // very first write it ever sees for this peer), not of this
        // particular transfer() *call* — it must be sent only when starting
        // a message from scratch (offsetBytes == 0), carrying the message's
        // full original size, never on a resume.
        //
        // This was wrong before: `first` was reset to true on every call,
        // so resume() also prepended a header — one holding remaining.size
        // (bytes left to send), not payload.size (the original total). The
        // receiver's IncomingMessage only parses a header on the very first
        // write it accumulates for a peer (expectedLength < 0) and treats
        // everything after as raw continuation bytes — so on resume those 4
        // header bytes silently became 4 bogus payload bytes spliced into
        // the middle of the reassembled message. Reproduced on a real
        // device: a resumed TRANSFER completed "successfully" per both
        // sides' logs, but the receiver's chunk_hash didn't match — the
        // very check this class's own Stage 0 spike history never actually
        // performed (it only asserted resume() returned Success, never
        // compared reassembled bytes against the original).
        var needsHeader = offsetBytes == 0L

        // A resume reuses the seq of the interrupted attempt it's continuing
        // so the receiver's [handleIncomingChunk] appends to the right
        // partial buffer instead of starting a new one — see the doc comment
        // on [interruptedSeqByConnection]. A fresh send() always gets a new
        // seq. If resume() is called with no recorded interruption for this
        // connection (shouldn't happen in this project's flow, but not worth
        // crashing over), fall back to a fresh seq and log it: the receiver
        // will then correctly treat it as a new message, which is only
        // right if the resume is effectively starting over too.
        val seq = if (needsHeader) {
            allocateSeq(connection.connectionId)
        } else {
            interruptedSeqByConnection[connection.connectionId] ?: allocateSeq(connection.connectionId).also {
                Log.w(TAG, "resume() for ${connection.connectionId} had no recorded interrupted seq; allocated fresh seq=$it")
            }
        }

        val ackDeferred = CompletableDeferred<Unit>()
        link.pending.ackNotify = ackDeferred

        while (offset < remaining.size) {
            if (interruptRequested) {
                interruptRequested = false
                link.pending.ackNotify = null
                interruptedSeqByConnection[connection.connectionId] = seq
                return TransferResult.Interrupted(bytesTransferred = sent.toLong(), reason = "simulated interrupt")
            }

            val payloadRoom = chunkSize - SEQ_BYTES - (if (needsHeader) HEADER_BYTES else 0)
            val len = minOf(payloadRoom, remaining.size - offset)
            val chunk = if (needsHeader) {
                val header = ByteBuffer.allocate(HEADER_BYTES).order(ByteOrder.BIG_ENDIAN).putInt(payload.size).array()
                byteArrayOf(seq.toByte()) + header + remaining.copyOfRange(offset, offset + len)
            } else {
                byteArrayOf(seq.toByte()) + remaining.copyOfRange(offset, offset + len)
            }
            needsHeader = false

            val writeDeferred = CompletableDeferred<Boolean>()
            link.pending.writeAck = writeDeferred
            if (!writeCharacteristicChunk(link, chunk)) {
                link.pending.ackNotify = null
                return TransferResult.Failed("writeCharacteristic() failed to queue at offset $offset")
            }
            val writeOk = withTimeoutOrNull(WRITE_TIMEOUT_MS) { writeDeferred.await() } ?: false
            if (!writeOk) {
                link.pending.ackNotify = null
                return TransferResult.Failed("GATT write failed/timed out at offset $offset")
            }

            offset += len
            sent += len
        }

        val acked = withTimeoutOrNull(ACK_TIMEOUT_MS) { ackDeferred.await() }
        link.pending.ackNotify = null
        return if (acked == null) {
            TransferResult.Failed("ack timeout after sending $sent bytes")
        } else {
            // Reproduced live on a real device: this used to unconditionally
            // remove(connectionId), so an unrelated LATER message completing
            // successfully on the same connection (e.g. the next chunk in a
            // critical-first batch) wiped the EARLIER interrupted message's
            // recorded seq before it ever got resumed. The guard below only
            // clears the record when it's this exact message's own seq —
            // i.e. this Success is the resume actually completing — so a
            // still-pending interruption for a different seq survives other
            // sends on the same connection.
            if (interruptedSeqByConnection[connection.connectionId] == seq) {
                interruptedSeqByConnection.remove(connection.connectionId)
            }
            TransferResult.Success(bytesTransferred = sent.toLong(), durationMillis = System.currentTimeMillis() - startedAt)
        }
    }

    private fun writeCharacteristicChunk(link: CentralLink, chunk: ByteArray): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            link.gatt.writeCharacteristic(
                link.dataCharacteristic,
                chunk,
                BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT,
            ) == BluetoothGatt.GATT_SUCCESS
        } else {
            @Suppress("DEPRECATION")
            run {
                link.dataCharacteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                link.dataCharacteristic.value = chunk
                link.gatt.writeCharacteristic(link.dataCharacteristic)
            }
        }
    }

    override suspend fun close(connection: Connection) {
        centralLinks.remove(connection.connectionId)?.let {
            try { it.gatt.disconnect() } finally { it.gatt.close() }
        }
        nextSeqByConnection.remove(connection.connectionId)
        interruptedSeqByConnection.remove(connection.connectionId)
    }

    /** Stops advertising/scanning/server and releases GATT resources. Not part of PeerTransport — call from the owning Activity's onDestroy(). */
    fun teardown() {
        runCatching { stopAdvertising() }
        runCatching { scanCallback?.let { scanner?.stopScan(it) } }
        scanCallback = null
        runCatching { gattServer?.close() }
        gattServer = null
        centralLinks.values.forEach {
            runCatching { it.gatt.disconnect() }
            runCatching { it.gatt.close() }
        }
        centralLinks.clear()
        nextSeqByConnection.clear()
        interruptedSeqByConnection.clear()
        incomingMessages.clear()
        subscribedDevices.clear()
    }
}
