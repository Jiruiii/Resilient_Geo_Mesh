package com.resilientgeo.mesh.online

import com.resilientgeo.mesh.trust.Canonical
import com.resilientgeo.mesh.trust.Ed25519Verifier
import com.resilientgeo.mesh.trust.TrustedKeyStore
import com.resilientgeo.mesh.trust.EventVerifier
import com.resilientgeo.mesh.trust.VerificationResult
import com.resilientgeo.mesh.protocol.ChunkVerifier
import org.json.JSONObject
import java.time.Instant

/** Online metadata cannot introduce new trust keys or arbitrary download URLs. */
object GovernmentFeedVerifier {
    const val KEY_ID = "government-feed-2026"
    private const val SERVER_KEY_ID = "central-server-2026"
    private val ALLOWED_KEY_IDS = setOf(KEY_ID, SERVER_KEY_ID)

    fun verify(feed: JSONObject, trust: TrustedKeyStore, now: Instant = Instant.now()) {
        require(feed.getString("schema_version") == "government-feed-v1") { "Unsupported government feed" }
        val signingKeyId = feed.getString("signing_key_id")
        require(signingKeyId in ALLOWED_KEY_IDS) { "Government feed signing key is not allowed" }
        signature(feed, trust, signingKeyId)
        require(feed.getLong("revision") in 1..Int.MAX_VALUE.toLong()) { "Invalid feed revision" }
        val created = Instant.parse(feed.getString("created_at"))
        val expires = Instant.parse(feed.getString("expires_at"))
        require(created <= now.plusSeconds(300) && expires > now && expires > created &&
            expires <= created.plusSeconds(86400)) { "Feed expired or clock incorrect" }
        val datasets = feed.getJSONArray("datasets")
        require(datasets.length() <= 6) { "Too many government datasets" }
        val ids = mutableSetOf<String>()
        var total = 0
        var totalBytes = 0L
        for (i in 0 until datasets.length()) {
            val dataset = datasets.getJSONObject(i)
            val source = dataset.getString("source_id")
            require(source.isNotBlank()) { "Government feed source is empty" }
            require(ids.add(source)) { "Duplicate source" }
            // The App consumes only NCDR alerts. The feed envelope is signed,
            // so other source metadata can be safely ignored here.
            if (source != "ncdr") continue
            val manifest = dataset.getJSONObject("manifest")
            signature(manifest, trust, signingKeyId)
            val hashInput = copyWithout(manifest, "signature", "manifest_hash")
            require(Canonical.sha256Canonical(hashInput) == manifest.getString("manifest_hash")) { "Manifest hash mismatch" }
            require(manifest.getString("schema_version") == "manifest-v0" &&
                manifest.getString("dataset_id") == "government-$source" &&
                manifest.getString("namespace") == "official.live.$source" &&
                manifest.getString("signing_key_id") == signingKeyId &&
                manifest.getLong("dataset_version") in 1..feed.getLong("revision")) { "Manifest binding mismatch" }
            val chunks = manifest.getJSONArray("chunks")
            val paths = dataset.getJSONArray("chunk_paths")
            require(chunks.length() == paths.length() && chunks.length() > 0)
            total += chunks.length()
            totalBytes += manifest.getLong("total_size_bytes")
            require(totalBytes in 1..24L * 1024 * 1024) { "Government release too large for relay cache" }
            require(total <= 4096) { "Too many chunks" }
            for (j in 0 until paths.length()) {
                require(paths.getString(j) == "releases/${manifest.getLong("dataset_version")}/$source/$j.json") { "Unsafe download path" }
            }
        }
    }

    fun verifyChunk(chunk: JSONObject, manifest: JSONObject, index: Int, trust: TrustedKeyStore) {
        val expected = manifest.getJSONArray("chunks").getJSONObject(index)
        val signingKeyId = manifest.getString("signing_key_id")
        require(signingKeyId in ALLOWED_KEY_IDS) { "Government chunk signing key is not allowed" }
        for (field in listOf("dataset_id", "namespace", "dataset_version", "manifest_id", "manifest_hash")) {
            require(chunk.get(field) == manifest.get(field)) { "Chunk manifest binding mismatch" }
        }
        for (field in listOf("chunk_id", "chunk_hash", "sequence", "event_count", "area_id", "theme", "priority")) {
            require(chunk.get(field) == expected.get(field)) { "Chunk index mismatch" }
        }
        require(chunk.getLong("byte_length") == expected.getLong("size_bytes"))
        require(chunk.getString("signing_key_id") == signingKeyId)
        require(ChunkVerifier.verify(chunk, trust) is ChunkVerifier.Result.Valid) { "Invalid chunk signature" }
        val events = chunk.getJSONArray("events")
        require(events.length() == expected.getInt("event_count"))
        val eventIds = expected.getJSONArray("event_ids")
        require(eventIds.length() == events.length())
        for (i in 0 until events.length()) {
            val event = events.getJSONObject(i)
            require(event.getString("namespace") == manifest.getString("namespace") &&
                event.getString("signing_key_id") == signingKeyId && event.getString("event_id") == eventIds.getString(i))
            require(EventVerifier.verify(event, trust) is VerificationResult.Valid) { "Invalid government event" }
        }
    }

    private fun signature(value: JSONObject, trust: TrustedKeyStore, signingKeyId: String) {
        require(value.getString("signing_key_id") == signingKeyId && value.getString("signature_algorithm") == "Ed25519")
        val key = requireNotNull(trust.publicKeyFor(signingKeyId)) { "Government publisher key not trusted" }
        require(Ed25519Verifier.verify(Canonical.canonicalize(copyWithout(value, "signature")),
            value.getString("signature"), key)) { "Government signature invalid" }
    }
    private fun copyWithout(value: JSONObject, vararg names: String): JSONObject =
        JSONObject(value.toString()).apply { names.forEach { remove(it) } }
}
