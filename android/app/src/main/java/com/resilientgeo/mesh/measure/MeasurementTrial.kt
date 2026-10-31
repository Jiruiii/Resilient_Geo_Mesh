package com.resilientgeo.mesh.measure

import com.resilientgeo.mesh.emergency.AutoPeerSyncEngine.Trace

/**
 * Turns one trial's engine traces into the timing columns of a CSV row.
 * Times are milliseconds since the trial started. A failed session does not
 * end the trial: the engine retries after its cooldown, and the trial keeps
 * counting attempts until a session succeeds or the caller times it out.
 */
class MeasurementTrial(private val startedAt: Long) {
    data class Result(
        val succeeded: Boolean,
        val failureReason: String?,
        val attempts: Int,
        val discoverMillis: Long?,
        val connectMillis: Long?,
        val helloMillis: Long?,
        val requestMillis: Long?,
        val firstChunkMillis: Long?,
        val lastChunkMillis: Long?,
        val completeMillis: Long?,
        val elapsedMillis: Long,
        val requestedChunks: Int,
        val requestedBytes: Long,
        val appliedChunks: Int,
        val receivedBytes: Long,
        val rejectedChunks: Int,
        val rssiMin: Int?,
        val rssiMedian: Int?,
        val rssiMax: Int?,
    ) {
        /** Received message bytes over the time from REQUEST to the last applied chunk. */
        val bytesPerSecond: Long?
            get() {
                val from = requestMillis ?: return null
                val to = lastChunkMillis ?: return null
                if (receivedBytes == 0L) return null
                return receivedBytes * 1000 / maxOf(1L, to - from)
            }
    }

    private var seen: Long? = null
    private var connected: Long? = null
    private var hello: Long? = null
    private var requested: Long? = null
    private var firstChunk: Long? = null
    private var lastChunk: Long? = null
    private var completed: Long? = null
    private var requestedChunks = 0
    private var requestedBytes = 0L
    private var appliedChunks = 0
    private var receivedBytes = 0L
    private var rejectedChunks = 0
    private var attempts = 0
    private var lastFailure: String? = null
    private val rssi = mutableListOf<Int>()

    val done: Boolean get() = completed != null
    val chunksApplied: Int get() = appliedChunks
    val bytesReceived: Long get() = receivedBytes

    /** Returns true when this trace completed the trial. */
    fun on(trace: Trace, now: Long): Boolean {
        if (done) return false
        val at = now - startedAt
        when (trace) {
            is Trace.PeerSeen -> {
                if (seen == null) seen = at
                trace.rssi?.let { if (rssi.size < MAX_RSSI_SAMPLES) rssi += it }
            }
            is Trace.Connecting -> attempts++
            is Trace.Connected -> if (connected == null) connected = at
            is Trace.HelloReceived -> if (hello == null) hello = at
            is Trace.Requested -> {
                requested = at
                requestedChunks = trace.chunks
                requestedBytes = trace.bytes
            }
            is Trace.ChunkApplied -> {
                if (firstChunk == null) firstChunk = at
                lastChunk = at
                appliedChunks++
                receivedBytes += trace.messageBytes
            }
            is Trace.ChunkRejected -> rejectedChunks++
            is Trace.SessionEnded -> if (trace.succeeded) completed = at else lastFailure = trace.failureCode
        }
        return done
    }

    /** [stopReason] explains a trial that ended without success, such as `timeout` or `stopped`. */
    fun result(now: Long, stopReason: String? = null): Result {
        val sorted = rssi.sorted()
        return Result(
            succeeded = done,
            failureReason = if (done) null else listOfNotNull(stopReason, lastFailure).joinToString("/").ifEmpty { null },
            attempts = attempts,
            discoverMillis = seen,
            connectMillis = connected,
            helloMillis = hello,
            requestMillis = requested,
            firstChunkMillis = firstChunk,
            lastChunkMillis = lastChunk,
            completeMillis = completed,
            elapsedMillis = completed ?: (now - startedAt),
            requestedChunks = requestedChunks,
            requestedBytes = requestedBytes,
            appliedChunks = appliedChunks,
            receivedBytes = receivedBytes,
            rejectedChunks = rejectedChunks,
            rssiMin = sorted.firstOrNull(),
            rssiMedian = MeasurementStats.percentile(sorted.map(Int::toLong), 0.50)?.toInt(),
            rssiMax = sorted.lastOrNull(),
        )
    }

    private companion object {
        // BLE reports a sighting every few hundred ms; a long trial needs no more.
        const val MAX_RSSI_SAMPLES = 2_000
    }
}
