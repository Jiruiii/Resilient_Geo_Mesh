package com.resilientgeo.mesh.online

import com.resilientgeo.mesh.trust.TrustedKeyStore
import com.resilientgeo.mesh.trust.Canonical
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.nio.charset.StandardCharsets
import java.security.KeyPairGenerator
import java.security.Signature
import java.util.Base64

class GovernmentFeedSyncTest {
    private fun resource(name: String) = javaClass.classLoader!!.getResource(name)!!.readText()
    private val trust = TrustedKeyStore.fromJson(resource("trust/trusted-keys.json"))
    private fun feed() = JSONObject(resource("government/feed.json"))
    private fun chunk() = JSONObject(resource("government/chunk.json"))
    private val fixtureTime = Instant.parse("2026-09-27T12:00:00Z")

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
