package com.resilientgeo.mesh.data

import android.bluetooth.BluetoothManager
import android.net.ConnectivityManager
import android.content.Context
import android.util.Log
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.resilientgeo.mesh.online.GovernmentFeedSync
import com.resilientgeo.mesh.online.FeedCursor
import com.resilientgeo.mesh.protocol.ChunkVerifier
import com.resilientgeo.mesh.report.GovernmentWarningChunkCodec
import com.resilientgeo.mesh.report.GovernmentWarningInput
import com.resilientgeo.mesh.trust.Canonical
import com.resilientgeo.mesh.trust.DeviceSigningKey
import com.resilientgeo.mesh.trust.EventVerifier
import com.resilientgeo.mesh.trust.GovernmentDeviceKeyStore
import com.resilientgeo.mesh.trust.TrustedKeyStore
import com.resilientgeo.mesh.emergency.AutoPeerSyncEngine
import com.resilientgeo.mesh.transport.BleGattTransport
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

/** Explicit two-phone validation. Isolated Room/cache, no production preferences changed. */
@RunWith(AndroidJUnit4::class)
class GovernmentPeerInstrumentedTest {
    @Test fun publicHttpsReleaseVerifiesAndRepeatDoesNotDownloadChunks(): Unit = runBlocking {
        val url = InstrumentationRegistry.getArguments().getString("government_url")
        assumeTrue("Opt-in public HTTPS validation", url?.startsWith("https://") == true)
        val context: Context = ApplicationProvider.getApplicationContext()
        val db = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).build()
        val cache = File.createTempFile("government-https-", "", context.cacheDir).apply { delete(); mkdirs() }
        try {
            val repository = MeshRepository(context, db, cache)
            val trust = TrustedKeyStore.fromJson(context.assets.open("trust/trusted-keys.json").bufferedReader().use { it.readText() })
            var fetched = 0
            val sync = GovernmentFeedSync(trust, { request -> withContext(Dispatchers.IO) {
                val json = GovernmentFeedSync.download(request)
                fetched++
                if (fetched == 1 || fetched % 50 == 0) Log.i("GovernmentPeerTest", "PUBLIC_HTTPS_PROGRESS requests=$fetched")
                json
            } },
                { dataset, namespace, id -> repository.cachedChunkJson(dataset, namespace, id) },
                { repository.ingestChunk(it) is ChunkIngestResult.Applied }, includeArea = { area ->
                    area.startsWith("tw.630") || area.startsWith("tw.650") || area in setOf("tw", "tw.unknown")
                }, revokedAtByCertificateId = { repository.governmentDeviceRevocations() })
            val first = sync.sync(requireNotNull(url), FeedCursor())
            assertTrue("Expected real government chunks", first.downloaded > 0)
            assertEquals(first.downloaded, db.chunkDao().countSync())
            assertTrue(repository.allEventsSnapshot().isNotEmpty())
            val repeat = sync.sync(url, first.cursor)
            assertEquals(0, repeat.downloaded)
            assertEquals(first.cursor, repeat.cursor)
            Log.i("GovernmentPeerTest", "PUBLIC_HTTPS_OK revision=${first.cursor.revision} chunks=${first.downloaded} events=${repository.allEventsSnapshot().size}")
        } finally { db.close(); cache.deleteRecursively() }
    }
    @Test fun signedHttpDownloadThenOfflineBleRelay(): Unit = runBlocking {
        val role = InstrumentationRegistry.getArguments().getString("government_peer")
        assumeTrue("Opt-in paired-device government test", role in listOf("source", "receiver"))
        val context: Context = ApplicationProvider.getApplicationContext()
        val db = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).build()
        val cache = File.createTempFile("government-peer-", "", context.cacheDir).apply { delete(); mkdirs() }
        val keyRoot = File(context.cacheDir, "government-peer-device-key-${UUID.randomUUID()}").apply { mkdirs() }
        val deviceKeyStore = GovernmentDeviceKeyStore(
            context,
            directoryName = "device-$role",
            keyAlias = "resilientgeo-gov-peer-${role}-${UUID.randomUUID()}",
            storageRoot = keyRoot,
        )
        val start = File(context.cacheDir, "government-test-start")
        start.delete()
        val issuer = hardwareTestIssuer()
        val trustJson = org.json.JSONObject(context.assets.open("trust/trusted-keys.json").bufferedReader().use { it.readText() })
            .put(HARDWARE_ISSUER_KEY_ID, issuer.publicKeySpkiBase64())
        val trust = TrustedKeyStore.fromJson(trustJson.toString())
        val repository = MeshRepository(context, db, cache, governmentDeviceKeyStore = deviceKeyStore,
            trustedKeyStoreOverride = trust)
        val radio = BleGattTransport(context, context.getSystemService(BluetoothManager::class.java).adapter)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        var engine: AutoPeerSyncEngine? = null
        try {
            if (role == "source") {
                val devicePublicKey = repository.governmentDevicePublicKey()
                val certificate = issueHardwareCertificate(devicePublicKey, issuer, Instant.now())
                repository.storeGovernmentDeviceCertificate(certificate)
                val sync = GovernmentFeedSync(trust, { withContext(Dispatchers.IO) { GovernmentFeedSync.download(it) } },
                    { dataset, namespace, id -> repository.cachedChunkJson(dataset, namespace, id) },
                    { repository.ingestChunk(it) is ChunkIngestResult.Applied },
                    revokedAtByCertificateId = { repository.governmentDeviceRevocations() })
                val first = sync.sync("http://127.0.0.1:8787/", FeedCursor(), true)
                assertEquals("Hardware feed must contain one real government chunk", 1, first.downloaded)
                assertEquals(1, db.chunkDao().countSync())
                val repeat = sync.sync("http://127.0.0.1:8787/", first.cursor, true)
                assertEquals("Same release must not re-download chunks", 0, repeat.downloaded)
                Log.i("GovernmentPeerTest", "SOURCE_HTTP_READY revision=${first.cursor.revision}")
            } else assertEquals(0, db.chunkDao().countSync())
            val nodeId = "government-hardware-$role"
            val advertised = repository.allLocalPeerSummaries(nodeId).getJSONArray("datasets")
            val advertisedIds = (0 until advertised.length()).map { advertised.getJSONObject(it).getString("dataset_id") }
            assertTrue("The device-warning dataset must be advertised even while empty",
                GovernmentWarningChunkCodec.DATASET_ID in advertisedIds)
            assertTrue("The revocation feed dataset must be advertised even while empty",
                "government-government-device-revocations" in advertisedIds)
            Log.i("GovernmentPeerTest", "BARRIER_READY role=$role")
            withTimeout(120000) { while (!start.exists()) delay(250) }
            val connectivity = context.getSystemService(ConnectivityManager::class.java)
            withTimeout(30000) { while (connectivity.activeNetwork != null) delay(250) }
            Log.i("GovernmentPeerTest", "NO_INTERNET_CONFIRMED role=$role")
            val expectedEventId = "announcement:device:offline-mesh-hardware-test"
            if (role == "source") {
                val result = repository.createGovernmentWarning(
                    GovernmentWarningInput(
                        title = "離線 mesh 政府警告",
                        content = "這則警告由已授權政府手機在無網路時簽署。",
                        category = "SAFETY",
                        severity = "HIGH",
                        expiresAt = Instant.now().plusSeconds(60 * 60),
                    ),
                    expectedEventId,
                )
                assertTrue("Source must locally sign an offline government warning: $result",
                    result is GovernmentWarningResult.Created)
                assertEquals(expectedEventId, repository.pendingGovernmentWarningUploads().single().eventId)
                assertNotNull(repository.cachedChunkJson(
                    GovernmentWarningChunkCodec.DATASET_ID,
                    GovernmentWarningChunkCodec.NAMESPACE,
                    GovernmentWarningChunkCodec.chunkIdFor(expectedEventId),
                ))
                Log.i("GovernmentPeerTest", "OFFLINE_GOVERNMENT_WARNING_CREATED event_id=$expectedEventId")
            }
            engine = AutoPeerSyncEngine(transport = radio, localNodeId = nodeId,
                localSummaryProvider = { repository.allLocalPeerSummaries(nodeId) },
                chunkProvider = { dataset, namespace, id -> repository.cachedChunkJson(dataset, namespace, id) },
                chunkIngestor = { repository.ingestChunk(it) }, scope = scope,
                receptiveWindowMillis = 5000, syncCooldownMillis = 10000, failureCooldownMillis = 3000,
                onLog = { Log.i("GovernmentPeerTest", "[$role] $it") })
            engine.start()
            withTimeout(150000) {
                while (repository.allEventsSnapshot().none { it.eventId == expectedEventId } ||
                    engine.stats().peersSynced < 1) delay(250)
            }
            val receivedWarning = repository.allEventsSnapshot().singleOrNull { it.eventId == expectedEventId }
            assertNotNull("A peer must receive the signed government warning over BLE", receivedWarning)
            val receivedEvent = org.json.JSONObject(requireNotNull(receivedWarning).eventJson)
            assertEquals("GOVERNMENT", receivedEvent.getString("source"))
            assertTrue(receivedEvent.getString("signing_key_id").startsWith("device:"))
            assertEquals("official.announcement", receivedEvent.getString("namespace"))
            assertNotNull(repository.cachedChunkJson(
                GovernmentWarningChunkCodec.DATASET_ID,
                GovernmentWarningChunkCodec.NAMESPACE,
                GovernmentWarningChunkCodec.chunkIdFor(expectedEventId),
            ))
            if (role == "receiver") assertTrue(engine.stats().chunksApplied > 0)
            Log.i("GovernmentPeerTest", "OFFLINE_RELAY_OK role=$role ${engine.stats()}")
        } finally {
            engine?.stop(); scope.cancel(); radio.teardown(); db.close(); cache.deleteRecursively(); keyRoot.deleteRecursively(); start.delete()
        }
    }

    @Test fun signedRevocationIsDurableHiddenFromEventsAndStillRelayable(): Unit = runBlocking {
        val context: Context = ApplicationProvider.getApplicationContext()
        val db = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).build()
        val cache = File.createTempFile("government-revocation-", "", context.cacheDir).apply { delete(); mkdirs() }
        val issuer = hardwareTestIssuer()
        val trust = TrustedKeyStore(mapOf(HARDWARE_ISSUER_KEY_ID to issuer.publicKeySpkiBase64()))
        val repository = MeshRepository(context, db, cache, trustedKeyStoreOverride = trust)
        val revokedAt = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.SECONDS)
        val certificateId = "gov-cert:hardware-revocation-test"
        val event = signedRevocationEvent(issuer, certificateId, revokedAt)
        val chunk = signedRevocationChunk(issuer, event, revokedAt)
        try {
            assertTrue(repository.ingestChunk(chunk) is ChunkIngestResult.Applied)
            assertEquals(revokedAt, repository.governmentDeviceRevocations()[certificateId])
            assertTrue("Internal revocation must not appear in map or notification events",
                repository.allEventsSnapshot().isEmpty())
            assertTrue("Flow event lists must also hide internal revocations", repository.observeEvents().first().isEmpty())
            val held = repository.allLocalPeerSummaries("revocation-relay-test").getJSONArray("datasets")
            val summary = (0 until held.length()).map { held.getJSONObject(it) }
                .single { it.optString("dataset_id") == chunk.getString("dataset_id") }
            assertEquals(1, summary.getJSONArray("chunks").length())
            assertNotNull(repository.cachedChunkJson(
                chunk.getString("dataset_id"), chunk.getString("namespace"), chunk.getString("chunk_id")))
        } finally {
            db.close()
            cache.deleteRecursively()
        }
    }

    private fun hardwareTestIssuer(): DeviceSigningKey {
        val seed = MessageDigest.getInstance("SHA-256").digest("government-peer-hardware-test-issuer".toByteArray())
        return DeviceSigningKey.loadOrCreate(object : DeviceSigningKey.Storage {
            override fun read(): ByteArray = seed
            override fun write(seed: ByteArray) = Unit
        })
    }

    private fun issueHardwareCertificate(deviceKey: org.json.JSONObject, issuer: DeviceSigningKey, now: Instant): org.json.JSONObject {
        val issuedAt = now.truncatedTo(java.time.temporal.ChronoUnit.SECONDS)
        val unsigned = org.json.JSONObject()
            .put("schema_version", "government-device-certificate-v1")
            .put("certificate_id", "gov-cert:${UUID.randomUUID()}")
            .put("device_id", "gov-device:${UUID.randomUUID()}")
            .put("subject_id", "government-user:${UUID.randomUUID()}")
            .put("signing_key_id", deviceKey.getString("signing_key_id"))
            .put("signer_public_key", deviceKey.getString("signer_public_key"))
            .put("agency", "硬體測試機關")
            .put("permissions", org.json.JSONArray().put("official.announcement.publish"))
            .put("issued_at", issuedAt.toString())
            .put("expires_at", issuedAt.plusSeconds(7 * 24 * 60 * 60L).toString())
            .put("issuer_key_id", HARDWARE_ISSUER_KEY_ID)
            .put("signature_algorithm", "Ed25519")
        return org.json.JSONObject(unsigned.toString())
            .put("signature", issuer.signCanonical(Canonical.canonicalize(unsigned)))
    }

    private fun signedRevocationEvent(issuer: DeviceSigningKey, certificateId: String, revokedAt: Instant): org.json.JSONObject {
        val event = org.json.JSONObject()
            .put("schema_version", "event-v0")
            .put("namespace", "official.device-revocation")
            .put("event_id", "device-revocation:$certificateId")
            .put("event_type", "GOVERNMENT_DEVICE_REVOKED")
            .put("geometry", org.json.JSONObject().put("type", "Point")
                .put("coordinates", org.json.JSONArray().put(121).put(23.5)))
            .put("severity", "LOW")
            .put("source", "GOVERNMENT")
            .put("source_version", revokedAt.toString())
            .put("event_version", 1)
            .put("issued_at", revokedAt.toString())
            .put("expires_at", "2100-01-01T00:00:00Z")
            .put("attributes", org.json.JSONObject()
                .put("certificate_id", certificateId)
                .put("device_id", "gov-device:hardware-revocation-test")
                .put("revoked_at", revokedAt.toString())
                .put("area_id", "tw.national")
                .put("theme", "device-revocation")
                .put("internal_only", true))
            .put("signing_key_id", HARDWARE_ISSUER_KEY_ID)
            .put("provenance", org.json.JSONObject()
                .put("original_source", "government-device-registry")
                .put("received_at", revokedAt.toString())
                .put("transport_source", org.json.JSONObject().put("kind", "server").put("node_id", "test")))
        event.put("payload_hash", Canonical.sha256Canonical(EventVerifier.eventPayload(event)))
            .put("signature_algorithm", "Ed25519")
            .put("signature", issuer.signCanonical(Canonical.canonicalize(EventVerifier.eventSignatureInput(event))))
        return event
    }

    private fun signedRevocationChunk(issuer: DeviceSigningKey, event: org.json.JSONObject, createdAt: Instant): org.json.JSONObject {
        val datasetId = "government-government-device-revocations"
        val chunk = org.json.JSONObject()
            .put("schema_version", "chunk-v0")
            .put("chunk_id", "$datasetId:chunk:1:tw:device-revocation:000")
            .put("manifest_id", "$datasetId:manifest:1")
            .put("manifest_hash", "sha256:revocation-test-manifest")
            .put("dataset_id", datasetId)
            .put("namespace", "official.device-revocation")
            .put("dataset_version", 1)
            .put("sequence", 0)
            .put("priority", "NORMAL")
            .put("area_id", "tw.national")
            .put("theme", "device-revocation")
            .put("bbox", org.json.JSONArray().put(121).put(23.5).put(121).put(23.5))
            .put("created_at", createdAt.toString())
            .put("content_type", "application/json")
            .put("content_encoding", "identity")
            .put("event_count", 1)
            .put("events", org.json.JSONArray().put(event))
            .put("signature_algorithm", "Ed25519")
            .put("signing_key_id", HARDWARE_ISSUER_KEY_ID)
        val payload = Canonical.canonicalize(ChunkVerifier.chunkContent(chunk)).toByteArray(Charsets.UTF_8)
        chunk.put("byte_length", payload.size).put("chunk_hash", Canonical.sha256Bytes(payload))
        chunk.put("signature", issuer.signCanonical(Canonical.canonicalize(ChunkVerifier.chunkSignatureInput(chunk))))
        return chunk
    }

    private companion object {
        const val HARDWARE_ISSUER_KEY_ID = "government-peer-hardware-test-issuer"
    }
}
