package com.resilientgeo.mesh.emergency

import com.resilientgeo.mesh.data.ChunkIngestResult
import com.resilientgeo.mesh.protocol.ChunkRef
import com.resilientgeo.mesh.protocol.DatasetSummary
import com.resilientgeo.mesh.protocol.DiffResult
import com.resilientgeo.mesh.protocol.PeerSummary
import com.resilientgeo.mesh.protocol.PeerSync
import com.resilientgeo.mesh.protocol.RequestMessage
import com.resilientgeo.mesh.transport.Connection
import com.resilientgeo.mesh.transport.PeerTransport
import com.resilientgeo.mesh.transport.PeerAdvertisement
import com.resilientgeo.mesh.transport.TransferResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * Runs HELLO -> DIFF -> REQUEST -> TRANSFER automatically with every peer
 * [PeerTransport.discover] finds, with no human choosing roles.
 *
 * `PeerSyncMilestoneActivity` needs a person to tap "Node A" / "Node B"
 * because *it* imposes a fixed requester/server split for demo clarity —
 * that split is not a property of the protocol itself. `PeerSync.computeDiff`
 * and `PeerSync.buildRequest` are pure functions of two summaries: whoever
 * receives a HELLO can compute its own diff against it, and whoever receives
 * a REQUEST can serve whatever it actually holds. Two strangers meeting need
 * no negotiation over who does which — both connect to each other (matching
 * `BleGattTransport`'s "every device is both central and peripheral"
 * design), both send their own HELLO, and both independently run the
 * requester half for what they're missing and the server half for what
 * they're asked. Symmetry is what removes the negotiation problem, not a
 * protocol added to solve it.
 *
 * What this class *does* solve, because the wire protocol doesn't: when to
 * connect, how many peers to talk to at once, how long to stay connected to
 * one before giving another a turn, and when to give up and retry. See
 * [onPeerSeen] for the per-peer state machine.
 *
 * Known v0 limitation, inherited from [BleGattTransport]/`serveChunk`'s own
 * documented boundary: there is no persisted partial-chunk state, so a
 * TRANSFER interrupted by a real disconnect (the contact window closing) is
 * not resumed mid-session — it simply restarts from byte 0 the next time
 * these two peers meet and sync again. Cross-contact byte-level resume only
 * exists today for a transfer kept alive on one still-open connection.
 */
class AutoPeerSyncEngine(
    private val transport: PeerTransport,
    /** This node's own id, for logging only — the HELLO's `node_id` comes from [localSummaryProvider]. */
    private val localNodeId: String,
    /** Builds this node's full HELLO (all datasets held), typically `MeshRepository.allLocalPeerSummaries`. */
    private val localSummaryProvider: suspend () -> JSONObject,
    /** Looks up a cached chunk-v0 payload to serve a REQUEST, or null if this node doesn't have it. */
    private val chunkProvider: suspend (datasetId: String, namespace: String, chunkId: String) -> JSONObject?,
    /** Verifies and applies a received chunk-v0 payload, typically `MeshRepository.ingestChunk`. */
    private val chunkIngestor: suspend (JSONObject) -> ChunkIngestResult,
    private val scope: CoroutineScope,
    private val onLog: (String) -> Unit = {},
    private val maxConcurrentSessions: Int = MAX_CONCURRENT_SESSIONS,
    private val connectTimeoutMillis: Long = CONNECT_TIMEOUT_MS,
    private val helloTimeoutMillis: Long = HELLO_TIMEOUT_MS,
    private val requestedChunkTimeoutMillis: Long = REQUESTED_CHUNK_TIMEOUT_MS,
    private val receptiveWindowMillis: Long = RECEPTIVE_WINDOW_MS,
    private val syncCooldownMillis: Long = SYNC_COOLDOWN_MS,
    private val failureCooldownMillis: Long = FAILURE_COOLDOWN_MS,
    private val clock: () -> Long = System::currentTimeMillis,
    private val onSyncOutcome: (SyncOutcome) -> Unit = {},
) {
    private enum class Phase {
        DISCOVERED, CONNECTING, EXCHANGING, SYNCED, FAILED;

        fun isBusy() = this == CONNECTING || this == EXCHANGING
    }

    /**
     * Per-peer negotiation state. One instance is reused across repeated
     * encounters with the same peer (survives cooldown) so [retryNotBeforeMillis]
     * and the HELLO sequence number keep meaning across attempts.
     *
     * [recordHello]/[takeUnconsumedHello] track "has a HELLO arrived since I
     * last acted on one" with a plain counter rather than a timestamp or a
     * one-shot `CompletableDeferred` — a peer's HELLO can legitimately arrive
     * before this side's own [onPeerSeen] ever fires for them (both sides
     * discover and connect independently), so a deferred reset at the start
     * of each attempt would race with, and could discard, a HELLO that
     * arrived just before the reset.
     */
    private class PeerSession(val peerId: String) {
        @Volatile var connectionAddress: String? = null
        @Volatile var phase: Phase = Phase.DISCOVERED
        @Volatile var connection: Connection? = null
        @Volatile var retryNotBeforeMillis: Long = 0L
        @Volatile var lastSeenAtMillis: Long = 0L

        @Volatile private var latestRemoteSummary: RemoteHello? = null
        @Volatile var requestsDoneSessionId: String? = null
        private val remoteSummarySeq = AtomicLong(0)
        @Volatile private var helloConsumedSeq: Long = 0L

        fun recordHello(summary: RemoteHello) {
            latestRemoteSummary = summary
            remoteSummarySeq.incrementAndGet()
        }

        /** Returns the latest HELLO if it hasn't already been acted on this round, else null. */
        fun takeUnconsumedHello(): RemoteHello? {
            val seq = remoteSummarySeq.get()
            if (seq <= helloConsumedSeq) return null
            helloConsumedSeq = seq
            return latestRemoteSummary
        }

        val pendingChunks = ConcurrentHashMap<ChunkKey, CompletableDeferred<Boolean>>()

        /** One serial sender per session; serving must never block the receive collector. */
        val bufferedRequests = Channel<JSONObject>(64)
        val outgoingRequests = AtomicInteger(0)
        @Volatile var servingFailed = false
    }

    data class Stats(val peersSynced: Int, val chunksApplied: Int, val activeSessions: Int)
    data class SyncOutcome(val succeeded: Boolean, val failureCode: String? = null)
    private data class RemoteHello(val summary: PeerSummary, val sessionId: String?)
    private data class ChunkKey(val datasetId: String, val namespace: String, val chunkId: String, val chunkHash: String)

    private val sessions = ConcurrentHashMap<String, PeerSession>()
    private data class Sighting(val identity: String?, val seenAtMillis: Long)
    private val sightings = ConcurrentHashMap<String, Sighting>()
    private val semaphore = Semaphore(maxConcurrentSessions)
    private var runningScope: CoroutineScope? = null

    private val peersSyncedCounter = AtomicInteger(0)
    private val chunksAppliedCounter = AtomicInteger(0)

    fun start() {
        if (runningScope != null) return
        val workers = CoroutineScope(scope.coroutineContext + SupervisorJob(scope.coroutineContext[Job]))
        runningScope = workers
        onLog("AutoPeerSyncEngine starting as $localNodeId")
        workers.launch(start = CoroutineStart.UNDISPATCHED) {
            transport.receivedMessages.collect { (peerId, bytes) ->
                try {
                    handleIncoming(peerId, bytes)
                } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    onLog("error handling message from $peerId: ${error.message}")
                }
            }
        }
        workers.launch {
            transport.discover().catch { error ->
                onLog("discovery failed: ${error.message}")
                onSyncOutcome(SyncOutcome(false, "discovery_failed"))
            }.collect { advertisement -> onPeerSeen(advertisement) }
        }
    }

    /** Cancels all engine work; session finally blocks close their client connections. */
    fun stop() {
        runningScope?.cancel()
        runningScope = null
        sessions.clear()
        sightings.clear()
    }

    fun stats(): Stats = Stats(
        peersSynced = peersSyncedCounter.get(),
        chunksApplied = chunksAppliedCounter.get(),
        activeSessions = sessions.values.count { it.phase.isBusy() },
    )

    /**
     * How many peers have had an advertisement seen within [staleAfterMillis].
     * `EmergencyModeService`'s notification wants this to show "N peers
     * nearby" — it can't collect `transport.discover()` a second time to get
     * it independently, because [PeerTransport.discover] is a per-collection
     * side-effecting flow (advertising/scanning restart on every collection,
     * see `BleGattTransport`'s own doc comment), so this engine — the flow's
     * one and only collector — is the only place that count can come from.
     */
    fun visiblePeerCount(staleAfterMillis: Long): Int {
        val now = clock()
        sightings.entries.removeIf { now - it.value.seenAtMillis > staleAfterMillis }
        return sightings.entries.map { it.value.identity ?: it.key }.distinct().size
    }

    private fun onPeerSeen(advertisement: PeerAdvertisement) {
        val workers = runningScope ?: return
        if (advertisement.transportIdentity == transport.localIdentity && transport.localIdentity != null) return
        val previousSighting = sightings[advertisement.peerId]
        sightings[advertisement.peerId] = Sighting(
            advertisement.transportIdentity ?: previousSighting?.identity, clock(),
        )
        // Active scans may report the primary advertisement before its scan response.
        // Wait for the identity so the inbound central address and advertised address
        // cannot create separate sessions for the same device.
        if (transport.localIdentity != null && advertisement.transportIdentity == null) {
            if (previousSighting == null) onLog("mesh advertisement seen without transport identity; waiting for scan response (update both phones to the same build)")
            return
        }
        val peerId = advertisement.transportIdentity ?: advertisement.peerId
        val session = sessions.computeIfAbsent(peerId) { PeerSession(it) }
        session.connectionAddress = advertisement.peerId
        session.lastSeenAtMillis = clock()
        val started = synchronized(session) {
            if (!shouldAttemptSync(clock(), session.retryNotBeforeMillis, session.phase.isBusy())) return@synchronized false
            session.phase = Phase.CONNECTING
            true
        }
        if (!started) return

        if (!semaphore.tryAcquire()) {
            // At capacity — this peer stays DISCOVERED and will be retried
            // the next time its advertisement is (re)seen, which BLE does
            // every few hundred ms while it's still nearby.
            session.phase = Phase.DISCOVERED
            return
        }
        workers.launch {
            runSession(session)
        }.invokeOnCompletion {
            // Also releases the slot when stop() cancels a queued coroutine
            // before its body ever starts.
            semaphore.release()
        }
    }

    private suspend fun runSession(session: PeerSession): Unit = coroutineScope {
        val peerId = session.peerId
        // Every encounter has a fresh diff. A timed-out request from a previous
        // encounter may no longer be advertised and must not poison this one.
        session.pendingChunks.clear()
        session.servingFailed = false
        var servingJob: Job? = null
        try {
            val conn = withTimeoutOrNull(connectTimeoutMillis) { transport.connect(session.connectionAddress ?: peerId) }
            if (conn == null) {
                onLog("connect timeout/failed for $peerId")
                fail(session, "connection_failed")
                return@coroutineScope
            }
            session.connection = conn
            session.phase = Phase.EXCHANGING
            onLog("connected to $peerId")
            servingJob = launch {
                for (request in session.bufferedRequests) {
                    try {
                        if (!serveRequest(conn, request)) session.servingFailed = true
                    } catch (error: Exception) {
                        if (error is CancellationException) throw error
                        session.servingFailed = true
                        onLog("serving $peerId failed: ${error.message}")
                    } finally {
                        session.outgoingRequests.decrementAndGet()
                    }
                }
            }

            val localSummaryJson = localSummaryProvider()
            val sessionId = UUID.randomUUID().toString()
            if (!sendEnvelope(conn, JSONObject().put("type", "HELLO").put("summary", localSummaryJson)
                    .put("session_id", sessionId))) {
                fail(session, "send_failed")
                return@coroutineScope
            }

            val remoteSummary = withTimeoutOrNull(helloTimeoutMillis) {
                var summary = session.takeUnconsumedHello()
                while (summary == null) {
                    delay(HELLO_POLL_INTERVAL_MS)
                    summary = session.takeUnconsumedHello()
                }
                summary
            }
            if (remoteSummary == null) {
                onLog("no HELLO from $peerId within timeout")
                fail(session, "hello_timeout")
                return@coroutineScope
            }

            val localSummary = PeerSummary.fromJson(localSummaryJson)
            val requests = buildRequestsForMissingData(localSummary, remoteSummary.summary)
            for (request in requests) {
                for (chunk in request.chunks) {
                    session.pendingChunks[ChunkKey(request.datasetId, request.namespace, chunk.chunkId, chunk.chunkHash)] = CompletableDeferred()
                }
                if (sendEnvelope(conn, JSONObject().put("type", "REQUEST").put("request", request.toEnvelopeJson()))) {
                    onLog("sent REQUEST to $peerId for ${request.chunks.map { it.chunkId }}")
                } else {
                    fail(session, "send_failed")
                    return@coroutineScope
                }
            }
            if (requests.isEmpty()) onLog("nothing to request from $peerId, already in sync")
            // A peer with no missing data must still serve ALL of our requests.
            // Sending a large REQUEST may itself take longer than the legacy
            // receptive window. Bind the end marker to this HELLO so a late
            // marker from a previous encounter cannot close a new session.
            if (remoteSummary.sessionId != null && !sendEnvelope(conn,
                    JSONObject().put("type", "REQUESTS_DONE").put("session_id", sessionId))) {
                fail(session, "send_failed")
                return@coroutineScope
            }

            // Modern peers explicitly finish their request list. Keep the
            // original grace window only as compatibility for older HELLOs.
            val completed = coroutineScope {
                val pending = session.pendingChunks.values.toList()
                val allRequestedDone = async {
                    if (pending.isEmpty()) true
                    else withTimeoutOrNull(maxOf(requestedChunkTimeoutMillis,
                        (requests.sumOf { it.maxTotalBytes } * 1000 / 1024 + requestedChunkTimeoutMillis).coerceAtMost(300_000L))) {
                        pending.awaitAll().all { it }
                    } ?: false
                }
                val allServed = async {
                    if (remoteSummary.sessionId == null) delay(receptiveWindowMillis)
                    withTimeoutOrNull(300_000L) {
                        while ((remoteSummary.sessionId != null &&
                                session.requestsDoneSessionId != remoteSummary.sessionId) ||
                            session.outgoingRequests.get() > 0) delay(100)
                        !session.servingFailed
                    } ?: false
                }
                val received = allRequestedDone.await()
                val served = allServed.await()
                received && served
            }

            if (!completed) {
                onLog("sync with $peerId incomplete: a requested chunk timed out or was rejected")
                fail(session, "transfer_incomplete")
                return@coroutineScope
            }

            session.phase = Phase.SYNCED
            session.retryNotBeforeMillis = clock() + syncCooldownMillis
            peersSyncedCounter.incrementAndGet()
            onSyncOutcome(SyncOutcome(true))
            onLog("sync with $peerId complete")
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            onLog("session with $peerId failed: ${e.message}")
            fail(session, "session_failed")
        } finally {
            withContext(NonCancellable) { servingJob?.cancelAndJoin() }
            while (session.bufferedRequests.tryReceive().isSuccess) session.outgoingRequests.decrementAndGet()
            session.pendingChunks.clear()
            val conn = session.connection
            session.connection = null
            if (conn != null) {
                withContext(NonCancellable) { runCatching { transport.close(conn) } }
            }
        }
    }

    private fun fail(session: PeerSession, code: String) {
        session.phase = Phase.FAILED
        session.retryNotBeforeMillis = clock() + failureCooldownMillis
        onSyncOutcome(SyncOutcome(false, code))
    }

    /**
     * `PeerSync.computeDiff` requires both sides to already carry an entry
     * for the dataset — a reasonable contract for a pure module that must
     * stay byte-identical to `pipeline/lib/peer-sync.mjs`. But this node has
     * no advance knowledge of every dataset a stranger might carry, and
     * `MeshRepository.allLocalPeerSummaries` only ever declares datasets
     * this node has *something* for — so "no local entry" here legitimately
     * means "I don't have this at all", not a bug worth pushing into the
     * shared pure module. Handled one layer up instead: synthesize exactly
     * what `computeDiff` would compute for a local dataset with an empty
     * chunk list.
     */
    private fun diffAgainstLocal(local: PeerSummary, remote: PeerSummary, remoteDataset: DatasetSummary) =
        if (local.datasets.none { it.datasetId == remoteDataset.datasetId && it.namespace == remoteDataset.namespace }) {
            DiffResult(
                datasetId = remoteDataset.datasetId,
                namespace = remoteDataset.namespace,
                manifestId = remoteDataset.manifestId,
                missingChunks = remoteDataset.chunks.map { ChunkRef(it.chunkId, it.chunkHash, it.sizeBytes, it.priority) },
                staleChunks = emptyList(),
                supersededManifestId = null,
            )
        } else {
            PeerSync.computeDiff(local, remote, remoteDataset.datasetId, remoteDataset.namespace)
        }

    private fun buildRequestsForMissingData(local: PeerSummary, remote: PeerSummary): List<RequestMessage> =
        remote.datasets.mapNotNull { remoteDataset ->
            // Conflicting manifests are a failed negotiation, not an empty diff.
            val diff = diffAgainstLocal(local, remote, remoteDataset)
            if (diff.missingChunks.isEmpty() && diff.staleChunks.isEmpty()) null else PeerSync.buildRequest(diff)
        }

    private suspend fun handleIncoming(peerId: String, bytes: ByteArray) {
        val envelope = try {
            JSONObject(String(bytes, StandardCharsets.UTF_8))
        } catch (e: Exception) {
            onLog("received non-JSON payload from $peerId (${bytes.size} bytes), ignoring")
            return
        }
        val identity = envelope.optString("sender_transport_id").takeIf { it.matches(Regex("ble:[0-9a-f]{16}")) }
        val session = sessions.computeIfAbsent(identity ?: peerId) { PeerSession(it) }
        when (envelope.optString("type")) {
            "HELLO" -> session.recordHello(RemoteHello(
                PeerSummary.fromJson(envelope.getJSONObject("summary")),
                envelope.optString("session_id").takeIf { it.isNotEmpty() },
            ))
            "REQUESTS_DONE" -> session.requestsDoneSessionId = envelope.optString("session_id").takeIf { it.isNotEmpty() }
            "REQUEST" -> handleRequest(session, envelope.getJSONObject("request"))
            "TRANSFER" -> handleTransfer(session, envelope.getJSONObject("chunk"))
            else -> onLog("unknown envelope type from $peerId: ${envelope.optString("type")}")
        }
    }

    private fun handleRequest(session: PeerSession, requestJson: JSONObject) {
        session.outgoingRequests.incrementAndGet()
        if (!session.bufferedRequests.trySend(requestJson).isSuccess) {
            session.outgoingRequests.decrementAndGet()
            session.servingFailed = true
        }
    }

    private suspend fun serveRequest(conn: Connection, requestJson: JSONObject): Boolean {
        var complete = true
        val datasetId = requestJson.getString("dataset_id")
        val namespace = requestJson.getString("namespace")
        val chunksRequested = requestJson.getJSONArray("chunks")
        for (i in 0 until chunksRequested.length()) {
            val chunkId = chunksRequested.getJSONObject(i).getString("chunk_id")
            val chunkJson = chunkProvider(datasetId, namespace, chunkId)
            if (chunkJson == null) {
                onLog("asked for $chunkId but it's not in the local cache, skipping")
                complete = false
                continue
            }
            val payload = withSenderIdentity(JSONObject().put("type", "TRANSFER").put("chunk", chunkJson))
                .toString().toByteArray(StandardCharsets.UTF_8)
            when (val result = transport.send(conn, payload)) {
                is TransferResult.Success -> onLog("sent TRANSFER for $chunkId, ${result.bytesTransferred} bytes")
                is TransferResult.Interrupted -> {
                    complete = false
                    onLog("TRANSFER for $chunkId interrupted at ${result.bytesTransferred} bytes")
                }
                is TransferResult.Failed -> {
                    complete = false
                    onLog("TRANSFER for $chunkId failed: ${result.reason}")
                }
            }
        }
        return complete
    }

    private suspend fun handleTransfer(session: PeerSession, chunkJson: JSONObject) {
        val chunkId = chunkJson.optString("chunk_id")
        val result = chunkIngestor(chunkJson)
        when (result) {
            is ChunkIngestResult.Applied -> {
                chunksAppliedCounter.incrementAndGet()
                onLog("applied TRANSFER for $chunkId, ${result.eventResults.size} event(s)")
            }
            is ChunkIngestResult.Rejected -> onLog("rejected TRANSFER for $chunkId: ${result.reason}")
        }
        val key = ChunkKey(chunkJson.optString("dataset_id"), chunkJson.optString("namespace"),
            chunkId, chunkJson.optString("chunk_hash"))
        session.pendingChunks[key]?.complete(result is ChunkIngestResult.Applied)
    }

    private suspend fun sendEnvelope(conn: Connection, envelope: JSONObject): Boolean =
        when (val result = transport.send(conn, withSenderIdentity(envelope).toString().toByteArray(StandardCharsets.UTF_8))) {
            is TransferResult.Success -> true
            else -> {
                onLog("send FAILED for envelope type=${envelope.optString("type")}: $result")
                false
            }
        }

    private fun withSenderIdentity(envelope: JSONObject): JSONObject = envelope.apply {
        transport.localIdentity?.let { put("sender_transport_id", it) }
    }

    private fun RequestMessage.toEnvelopeJson(): JSONObject {
        val chunksArray = JSONArray()
        for (c in chunks) {
            chunksArray.put(
                JSONObject()
                    .put("chunk_id", c.chunkId)
                    .put("chunk_hash", c.chunkHash)
                    .put("priority", c.priority.name)
                    .put("offset_bytes", c.offsetBytes)
                    .put("max_bytes", c.maxBytes),
            )
        }
        return JSONObject()
            .put("dataset_id", datasetId)
            .put("namespace", namespace)
            .put("manifest_id", manifestId)
            .put("chunks", chunksArray)
            .put("resume", resume)
            .put("max_total_bytes", maxTotalBytes)
            .apply { supersededManifestId?.let { put("superseded_manifest_id", it) } }
    }

    companion object {
        private const val MAX_CONCURRENT_SESSIONS = 2
        // Includes connect (15s), service discovery (10s), CCCD (5s) and MTU (5s).
        private const val CONNECT_TIMEOUT_MS = 40_000L
        private const val HELLO_TIMEOUT_MS = 300_000L
        private const val HELLO_POLL_INTERVAL_MS = 200L
        private const val REQUESTED_CHUNK_TIMEOUT_MS = 20_000L
        private const val RECEPTIVE_WINDOW_MS = 6_000L

        /** A peer we just finished syncing with isn't retried until this much later. */
        private const val SYNC_COOLDOWN_MS = 60_000L

        /** Shorter than [SYNC_COOLDOWN_MS]: a failed attempt (unreachable peer, timeout) is worth retrying sooner. */
        private const val FAILURE_COOLDOWN_MS = 15_000L

        /**
         * Decides whether a (re)discovered peer is worth attempting now. Pure
         * and side-effect-free on purpose, and a companion function rather
         * than an instance method so it's unit-testable without constructing
         * an engine — this is the one piece of "when do we act" policy worth
         * exercising directly, without any coroutines, transports, or timing.
         */
        internal fun shouldAttemptSync(now: Long, retryNotBeforeMillis: Long, sessionBusy: Boolean): Boolean =
            !sessionBusy && now >= retryNotBeforeMillis
    }
}
