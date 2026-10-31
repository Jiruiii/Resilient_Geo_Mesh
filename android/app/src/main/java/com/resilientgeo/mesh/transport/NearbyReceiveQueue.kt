package com.resilientgeo.mesh.transport

import kotlinx.coroutines.channels.Channel
import java.util.concurrent.atomic.AtomicLong

/** Buffers complete Nearby messages until the sync engine takes them, bounded by
 * bytes rather than count. Nearby acknowledges a payload on delivery, not after the
 * engine applies it, so after the Wi-Fi Direct bandwidth upgrade a sender outruns
 * chunk verification. A count of 8 overflowed there and dropped the link mid-sync
 * ("Nearby receive queue full"); a byte budget absorbs the burst. */
internal class NearbyReceiveQueue(private val maxQueuedBytes: Long = MAX_QUEUED_BYTES) {
    private val channel = Channel<Pair<String, ByteArray>>(Channel.UNLIMITED)
    private val queuedBytes = AtomicLong()

    /** Returns false when the budget would be exceeded; the caller drops the link. */
    fun offer(identity: String, message: ByteArray): Boolean {
        if (queuedBytes.addAndGet(message.size.toLong()) > maxQueuedBytes) {
            queuedBytes.addAndGet(-message.size.toLong())
            return false
        }
        if (channel.trySend(identity to message).isSuccess) return true
        queuedBytes.addAndGet(-message.size.toLong())
        return false
    }

    suspend fun forEach(action: suspend (Pair<String, ByteArray>) -> Unit) {
        for (message in channel) {
            queuedBytes.addAndGet(-message.second.size.toLong())
            action(message)
        }
    }

    fun close() { channel.close() }

    companion object {
        // Several of the largest (4 MB) messages; the 39 MB full set peaked well below.
        const val MAX_QUEUED_BYTES = 64L * 1024 * 1024
    }
}
