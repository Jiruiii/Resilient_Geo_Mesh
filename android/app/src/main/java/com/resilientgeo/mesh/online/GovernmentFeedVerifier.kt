package com.resilientgeo.mesh.online

import com.resilientgeo.mesh.data.supportsOfficialFeedDataset
import com.resilientgeo.mesh.data.officialFeedNamespace
import com.resilientgeo.mesh.data.supportsOfficialEvent
import com.resilientgeo.mesh.trust.Canonical
import com.resilientgeo.mesh.trust.Ed25519Verifier
import com.resilientgeo.mesh.trust.TrustedKeyStore
import com.resilientgeo.mesh.trust.EventVerifier
import com.resilientgeo.mesh.trust.VerificationResult
import com.resilientgeo.mesh.trust.DeviceKeys
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
        require(datasets.length() <= 8) { "Too many government datasets" }
        val ids = mutableSetOf<String>()
        var total = 0
        for (i in 0 until datasets.length()) {
            val dataset = datasets.getJSONObject(i)
            val source = dataset.getString("source_id")
            require(source.isNotBlank()) { "Government feed source is empty" }
            require(ids.add(source)) { "Duplicate source" }
            // Verify manifests for the sources the App may download. Other
            // signed source metadata can be safely ignored here.
            if (!supportsOfficialFeedDataset(source)) continue
            val manifest = dataset.getJSONObject("manifest")
            signature(manifest, trust, signingKeyId)
            val hashInput = copyWithout(manifest, "signature", "manifest_hash")
            require(Canonical.sha256Canonical(hashInput) == manifest.getString("manifest_hash")) { "Manifest hash mismatch" }
            require(manifest.getString("schema_version") == "manifest-v0" &&
                manifest.getString("dataset_id") == "government-$source" &&
                manifest.getString("namespace") == officialFeedNamespace(source) &&
                manifest.getString("signing_key_id") == signingKeyId &&
                manifest.getLong("dataset_version") in 1..feed.getLong("revision")) { "Manifest binding mismatch" }
            val chunks = manifest.getJSONArray("chunks")
            val paths = dataset.getJSONArray("chunk_paths")
            require(chunks.length() == paths.length() && chunks.length() > 0)
            total += chunks.length()
            require(total <= 4096) { "Too many chunks" }
            var manifestBytes = 0L
            val hasCategoryIndex = source == "ncdr" && chunks.getJSONObject(0).has("category_code")
            for (j in 0 until paths.length()) {
                val entry = chunks.getJSONObject(j)
                require(entry.getLong("size_bytes") > 0 && entry.getInt("event_count") > 0)
                manifestBytes += entry.getLong("size_bytes")
                if (source == "ncdr" && hasCategoryIndex) {
                    val category = entry.optString("category_code")
                    require(category.matches(Regex("^[a-z][a-z0-9_]{0,63}$"))) { "Invalid NCDR category metadata" }
                } else if (source == "ncdr") {
                    require(!entry.has("category_code")) { "Partial NCDR category index" }
                } else {
                    require(!entry.has("category_code")) { "Unexpected alert category metadata" }
                }
                require(paths.getString(j) == "releases/${manifest.getLong("dataset_version")}/$source/$j.json") { "Unsafe download path" }
            }
            require(manifestBytes == manifest.getLong("total_size_bytes")) { "Government manifest byte count mismatch" }
        }
    }

    fun verifyChunk(
        chunk: JSONObject,
        manifest: JSONObject,
        index: Int,
        trust: TrustedKeyStore,
        now: Instant = Instant.now(),
        revokedAtByCertificateId: Map<String, Instant> = emptyMap(),
    ) {
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
            val eventKeyId = event.getString("signing_key_id")
            val certifiedGovernmentDeviceEvent = event.getString("namespace") == "official.announcement" &&
                event.optString("source").equals("GOVERNMENT", ignoreCase = true) &&
                DeviceKeys.isDeviceKeyId(eventKeyId)
            require(event.getString("namespace") == manifest.getString("namespace") &&
                (eventKeyId == signingKeyId || certifiedGovernmentDeviceEvent) &&
                event.getString("event_id") == eventIds.getString(i))
            require(supportsOfficialEvent(event.getString("namespace"), event.getString("source"))) { "Unsupported official source" }
            require(EventVerifier.verify(event, trust, now, revokedAtByCertificateId) is VerificationResult.Valid) {
                "Invalid government event"
            }
            if (expected.has("category_code")) {
                val attributes = event.optJSONObject("attributes")
                require(event.optString("source").equals("NCDR", ignoreCase = true) &&
                    attributes?.optString("area_id") == expected.optString("area_id") &&
                    attributes?.optString("ncdr_category_code") == expected.optString("category_code")) {
                    "NCDR chunk category or area mismatch"
                }
            }
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
