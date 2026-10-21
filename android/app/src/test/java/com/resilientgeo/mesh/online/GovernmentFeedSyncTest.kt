package com.resilientgeo.mesh.online

import com.resilientgeo.mesh.trust.TrustedKeyStore
import com.resilientgeo.mesh.trust.Canonical
import com.resilientgeo.mesh.protocol.ChunkVerifier
import com.resilientgeo.mesh.report.GovernmentWarningFactory
import com.resilientgeo.mesh.report.GovernmentWarningInput
import com.resilientgeo.mesh.report.governmentWarningTestKeys
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.nio.charset.StandardCharsets
import java.security.KeyPairGenerator
import java.security.Signature
import java.util.Base64
import java.time.temporal.ChronoUnit

class GovernmentFeedSyncTest {
    private fun resource(name: String) = javaClass.classLoader!!.getResource(name)!!.readText()
    private val trust = JSONObject(resource("trust/trusted-keys.json")).let { keys ->
        // The fixture uses a deterministic test-only private key while keeping
        // the production-allowed key ID expected by GovernmentFeedVerifier.
        keys.put("central-server-2026", keys.getString("cwa-fixture-test-2026"))
        TrustedKeyStore.fromJson(keys.toString())
    }
    private fun feed() = JSONObject(resource("government/feed.json"))
    private fun chunk() = JSONObject(resource("government/chunk.json"))
    private val fixtureTime = Instant.parse("2026-09-27T12:00:00Z")

    @Test fun revocationDatasetsAreProcessedBeforeWarningDatasets() {
        val sources = listOf("government-announcements", "government-device-revocations", "cwa-warning")
        assertEquals(
            listOf("government-device-revocations", "government-announcements", "cwa-warning"),
            GovernmentFeedSync.orderSourcesForIngestion(sources),
        )
    }

    @Test fun nationwideAnnouncementsAndRevocationsIgnoreTheLocalMapAreaFilter() {
        assertTrue(GovernmentFeedSync.includesArea("government-announcements", "tw.national") { false })
        assertTrue(GovernmentFeedSync.includesArea("government-device-revocations", "tw.national") { false })
        assertFalse(GovernmentFeedSync.includesArea("cwa-warning", "tw.63000") { false })
    }

    @Test fun certifiedDeviceWarningIsAcceptedAndRevocationUsesIssueTime() {
        val deviceKeys = governmentWarningTestKeys()
        val issuedAt = Instant.parse("2026-10-12T12:00:00Z")
        val warning = GovernmentWarningFactory.create(
            GovernmentWarningInput(
                title = "Offline alert",
                content = "Signed by an enrolled government device.",
                category = "SAFETY",
                severity = "HIGH",
                expiresAt = issuedAt.plus(1, ChronoUnit.DAYS),
                affectedAreaIds = listOf("tw.national"),
            ),
            deviceKeys.device,
            deviceKeys.certificate,
            issuedAt,
            "announcement:device:feed-test",
        )
        val centralPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
        val centralKeyId = "central-server-2026"
        val trust = TrustedKeyStore(mapOf(
            deviceKeys.certificate.getString("issuer_key_id") to deviceKeys.issuer.publicKeySpkiBase64(),
            centralKeyId to Base64.getEncoder().encodeToString(centralPair.public.encoded),
        ))
        val (chunk, manifest) = centralSignedWarningChunk(warning, centralPair.private, centralKeyId)
        val certificateId = deviceKeys.certificate.getString("certificate_id")

        GovernmentFeedVerifier.verifyChunk(chunk, manifest, 0, trust, issuedAt)
        assertThrows(IllegalArgumentException::class.java) {
            GovernmentFeedVerifier.verifyChunk(chunk, manifest, 0, trust, issuedAt,
                mapOf(certificateId to issuedAt.minusSeconds(1)))
        }
        // A warning created before a cached revocation remains valid and relayable.
        GovernmentFeedVerifier.verifyChunk(chunk, manifest, 0, trust, issuedAt,
            mapOf(certificateId to issuedAt.plusSeconds(1)))
    }

    private fun centralSignedWarningChunk(
        event: JSONObject,
        privateKey: java.security.PrivateKey,
        centralKeyId: String,
    ): Pair<JSONObject, JSONObject> {
        val datasetId = "government-government-announcements"
        val manifestId = "$datasetId:manifest:1"
        val manifestHash = "sha256:test-manifest"
        val chunkId = "$datasetId:chunk:1:tw:announcement:000"
        val bbox = org.json.JSONArray().put(121).put(23.5).put(121).put(23.5)
        val chunk = JSONObject()
            .put("schema_version", "chunk-v0")
            .put("chunk_id", chunkId)
            .put("manifest_id", manifestId)
            .put("manifest_hash", manifestHash)
            .put("dataset_id", datasetId)
            .put("namespace", "official.announcement")
            .put("dataset_version", 1)
            .put("sequence", 0)
            .put("priority", "HIGH")
            .put("area_id", "tw.national")
            .put("theme", "announcement")
            .put("bbox", bbox)
            .put("created_at", event.getString("issued_at"))
            .put("content_type", "application/json")
            .put("content_encoding", "identity")
            .put("event_count", 1)
            .put("events", org.json.JSONArray().put(event))
            .put("signature_algorithm", "Ed25519")
            .put("signing_key_id", centralKeyId)
        val chunkBytes = Canonical.canonicalize(ChunkVerifier.chunkContent(chunk)).toByteArray(StandardCharsets.UTF_8)
        chunk.put("byte_length", chunkBytes.size)
            .put("chunk_hash", Canonical.sha256Bytes(chunkBytes))
        val signer = Signature.getInstance("Ed25519")
        signer.initSign(privateKey)
        signer.update(Canonical.canonicalize(ChunkVerifier.chunkSignatureInput(chunk)).toByteArray(StandardCharsets.UTF_8))
        chunk.put("signature", Base64.getEncoder().encodeToString(signer.sign()))

        val expectedChunk = JSONObject()
            .put("chunk_id", chunkId)
            .put("sequence", 0)
            .put("chunk_hash", chunk.getString("chunk_hash"))
            .put("size_bytes", chunk.getInt("byte_length"))
            .put("event_count", 1)
            .put("priority", "HIGH")
            .put("area_id", "tw.national")
            .put("theme", "announcement")
            .put("event_ids", org.json.JSONArray().put(event.getString("event_id")))
        val manifest = JSONObject()
            .put("schema_version", "manifest-v0")
            .put("manifest_id", manifestId)
            .put("manifest_hash", manifestHash)
            .put("dataset_id", datasetId)
            .put("namespace", "official.announcement")
            .put("dataset_version", 1)
            .put("signing_key_id", centralKeyId)
            .put("chunks", org.json.JSONArray().put(expectedChunk))
        return chunk to manifest
    }

    @Test fun transientNetworkFailuresRetryWithoutDuplicatingIngest() = runTest {
        var attempts = 0
        var applied = 0
        val sync = GovernmentFeedSync(trust, { url ->
            attempts++
            if (attempts <= 2) throw java.net.SocketTimeoutException("Temporary outage")
            if (url.endsWith("feed.json")) feed() else chunk()
        }, { _, _, _ -> null }, { applied++; true }, { fixtureTime })
        assertEquals(1, sync.sync("https://example.com/", FeedCursor()).downloaded)
        assertEquals(4, attempts)
        assertEquals(1, applied)
    }

    @Test fun cwaOfficialDatasetIsVerifiedDownloadedAndIngested() = runTest {
        var ingestedSource: String? = null
        val sync = GovernmentFeedSync(trust, { url ->
            if (url.endsWith("feed.json")) feed() else chunk()
        }, { _, _, _ -> null }, { value ->
            ingestedSource = value.getJSONArray("events").getJSONObject(0).getString("source")
            true
        }, { fixtureTime })

        val result = sync.sync("https://example.com/", FeedCursor())

        assertEquals("cwa-warning", result.feed.getJSONArray("datasets")
            .getJSONObject(0).getString("source_id"))
        assertEquals(1, result.downloaded)
        assertEquals("CWA", ingestedSource)
    }

    @Test fun exhaustedNetworkRetriesAndInvalidDataDoNotProduceCursor() = runTest {
        var attempts = 0
        val unavailable = GovernmentFeedSync(trust, { attempts++; throw java.io.IOException("Offline") },
            { _, _, _ -> null }, { fail("Offline data ingested"); false }, { fixtureTime })
        try { unavailable.sync("https://example.com/", FeedCursor()); fail("Offline sync marked successful") }
        catch (_: java.io.IOException) { assertEquals(3, attempts) }
        attempts = 0
        val invalid = GovernmentFeedSync(trust, { attempts++; feed().put("revision", 2) },
            { _, _, _ -> null }, { fail("Invalid data ingested"); false }, { fixtureTime })
        try { invalid.sync("https://example.com/", FeedCursor()); fail("Invalid feed accepted") }
        catch (_: IllegalArgumentException) { assertEquals(1, attempts) }
    }

    @Test fun excludedAreaDoesNotDownloadOrWriteChunks() = runTest {
        var fetched = 0
        val sync = GovernmentFeedSync(trust, { fetched++; feed() }, { _, _, _ -> null },
            { fail("Excluded chunk ingested"); false }, { fixtureTime }, { false })
        val result = sync.sync("https://example.com/", FeedCursor())
        assertEquals(1, fetched)
        assertEquals(0, result.downloaded)
    }

    @Test fun repeatSyncFetchesOnlyFeedAndMissingCacheIsRepaired() = runTest {
        val calls = mutableListOf<String>()
        var stored: JSONObject? = null
        val sync = GovernmentFeedSync(trust, { url -> calls.add(url); if (url.endsWith("feed.json")) feed() else chunk() },
            { _, _, _ -> stored }, { stored = it; true }, { fixtureTime })
        val first = sync.sync("https://example.com/", FeedCursor())
        assertEquals(1, first.downloaded)
        calls.clear()
        val second = sync.sync("https://example.com/", first.cursor)
        assertEquals(0, second.downloaded)
        assertEquals(listOf("https://example.com/feed.json"), calls)
        stored = null
        assertEquals(1, sync.sync("https://example.com/", second.cursor).downloaded)
    }
    @Test fun rollbackAndPartialStorageFailureDoNotReturnSuccessfulCursor() = runTest {
        var applied = 0
        val sync = GovernmentFeedSync(trust, { url -> if (url.endsWith("feed.json")) feed() else chunk() },
            { _, _, _ -> null }, { applied++; false }, { fixtureTime })
        try { sync.sync("https://example.com/", FeedCursor(2, "newer")); fail("Rollback accepted") }
        catch (_: IllegalArgumentException) { assertEquals(0, applied) }
        try { sync.sync("https://example.com/", FeedCursor()); fail("Failed write marked successful") }
        catch (_: IllegalArgumentException) { assertEquals(1, applied) }
        try { sync.sync("https://example.com/", FeedCursor(1, "different-hash")); fail("Conflict accepted") }
        catch (_: IllegalArgumentException) { assertEquals(1, applied) }
    }

    @Test fun signedNodeReleaseMatchesAndroidCanonicalAndManifestBindings() {
        val feed = feed()
        GovernmentFeedVerifier.verify(feed, trust, fixtureTime)
        val manifest = feed.getJSONArray("datasets").getJSONObject(0).getJSONObject("manifest")
        GovernmentFeedVerifier.verifyChunk(chunk(), manifest, 0, trust)
    }

    @Test fun centralServerKeyCanPublishAnEmptySignedFeed() {
        val keyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
        val keyId = "central-server-2026"
        val expandedTrust = JSONObject(resource("trust/trusted-keys.json"))
            .put(keyId, Base64.getEncoder().encodeToString(keyPair.public.encoded))
        val trustWithServerKey = TrustedKeyStore.fromJson(expandedTrust.toString())
        val unsigned = JSONObject()
            .put("schema_version", "government-feed-v1")
            .put("revision", 1)
            .put("created_at", "2026-09-27T12:00:00Z")
            .put("expires_at", "2026-09-28T12:00:00Z")
            .put("signing_key_id", keyId)
            .put("signature_algorithm", "Ed25519")
            .put("sources", org.json.JSONArray())
            .put("datasets", org.json.JSONArray())
            .put("event_versions", JSONObject())
        val signer = Signature.getInstance("Ed25519")
        signer.initSign(keyPair.private)
        signer.update(Canonical.canonicalize(unsigned).toByteArray(StandardCharsets.UTF_8))
        val feed = unsigned.put("signature", Base64.getEncoder().encodeToString(signer.sign()))

        GovernmentFeedVerifier.verify(feed, trustWithServerKey, fixtureTime)
    }
    @Test fun modifiedLedgerAndChunkFailClosed() {
        val feed = feed().put("revision", 2)
        assertThrows(IllegalArgumentException::class.java) { GovernmentFeedVerifier.verify(feed, trust, fixtureTime) }
        val manifest = feed().getJSONArray("datasets").getJSONObject(0).getJSONObject("manifest")
        val chunk = chunk()
        chunk.getJSONArray("events").getJSONObject(0).getJSONObject("attributes").put("status", "OPEN")
        assertThrows(IllegalArgumentException::class.java) { GovernmentFeedVerifier.verifyChunk(chunk, manifest, 0, trust) }
    }
    @Test fun expiredFeedDoesNotAuthorizeDownloads() {
        assertThrows(IllegalArgumentException::class.java) { GovernmentFeedVerifier.verify(feed(), trust, Instant.parse("2026-09-29T00:00:00Z")) }
    }
    @Test fun addressesRejectCredentialsQueriesAndUnencryptedProductionHosts() {
        for (url in listOf("http://example.com/", "https://user:pass@example.com/", "https://example.com/?apikey=secret", "https://example.com/#fragment"))
            assertThrows(IllegalArgumentException::class.java) { GovernmentFeedSync.validateBase(url) }
        assertEquals("https://example.com/data/", GovernmentFeedSync.validateBase("https://example.com/data").toString())
        assertEquals("http://127.0.0.1:8787/", GovernmentFeedSync.validateBase("http://127.0.0.1:8787", true).toString())
        assertThrows(IllegalArgumentException::class.java) { GovernmentFeedSync.validateBase("http://192.168.1.10/", true) }
    }
}
