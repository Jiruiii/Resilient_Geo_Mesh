package com.resilientgeo.mesh.protocol

import com.resilientgeo.mesh.report.CrowdChunkCodec
import com.resilientgeo.mesh.report.GovernmentWarningChunkCodec
import com.resilientgeo.mesh.trust.Canonical
import com.resilientgeo.mesh.trust.Ed25519Verifier
import com.resilientgeo.mesh.trust.TrustedKeyStore
import org.json.JSONObject
import java.time.Instant

/**
 * Verifies a `chunk-v0` TRANSFER payload (see `schemas/chunk-v0.schema.json`)
 * before any of its events are handed to [com.resilientgeo.mesh.ingest.EventIngestor].
 *
 * Kotlin port of `chunkContent()`/`chunkPayloadBytes()`/`chunkSignatureInput()`
 * from `pipeline/lib/canonical.mjs` — must byte-for-byte match so a chunk
 * signed by `pipeline/lib/bundle.mjs` verifies here unmodified. This is a
 * second, independent layer on top of each individual event's own Ed25519
 * signature (still checked by [com.resilientgeo.mesh.trust.EventVerifier]
 * per event): the chunk-level hash/signature only proves the chunk wasn't
 * tampered with or truncated in transit, it doesn't replace per-event trust.
 */
object ChunkVerifier {

    sealed class Result {
        data class Valid(val events: List<JSONObject>) : Result()
        data class Invalid(val reason: String) : Result()
    }

    /** Fields covered by `chunk_hash` — mirrors `chunkContent()` in canonical.mjs. */
    private val CHUNK_HASH_FIELDS = listOf(
        "dataset_id", "namespace", "dataset_version", "sequence", "priority",
        "area_id", "theme", "bbox", "content_type", "content_encoding", "events",
    )

    fun verify(
        chunk: JSONObject,
        trustStore: TrustedKeyStore,
        now: Instant = Instant.now(),
        revokedAtByCertificateId: Map<String, Instant> = emptyMap(),
    ): Result {
        // Crowd reports travel one per chunk, signed by the reporting device
        // rather than by a bundled official key; see CrowdChunkCodec.
        if (chunk.optString("dataset_id") in CrowdChunkCodec.DATASET_IDS) {
            return CrowdChunkCodec.verify(chunk, trustStore, now)
        }
        if (chunk.optString("dataset_id") == GovernmentWarningChunkCodec.DATASET_ID) {
            return GovernmentWarningChunkCodec.verify(chunk, trustStore, now, revokedAtByCertificateId)
        }
        val expectedHash = Canonical.sha256Canonical(chunkContent(chunk))
        val actualHash = chunk.optString("chunk_hash", "")
        if (expectedHash != actualHash) {
            return Result.Invalid("chunk_hash_mismatch: expected=$expectedHash actual=$actualHash")
        }

        val signingKeyId = chunk.optString("signing_key_id", "")
        val publicKey = trustStore.publicKeyFor(signingKeyId)
            ?: return Result.Invalid("signing_key_id '$signingKeyId' is not trusted")

        val canonicalSignatureInput = Canonical.canonicalize(chunkSignatureInput(chunk))
        val signature = chunk.optString("signature", "")
        if (!Ed25519Verifier.verify(canonicalSignatureInput, signature, publicKey)) {
            return Result.Invalid("chunk_signature_invalid")
        }

        val eventsJson = chunk.getJSONArray("events")
        val events = (0 until eventsJson.length()).map { eventsJson.getJSONObject(it) }
        return Result.Valid(events)
    }

    internal fun chunkContent(chunk: JSONObject): JSONObject {
        val content = JSONObject()
        for (field in CHUNK_HASH_FIELDS) content.put(field, chunk.get(field))
        return content
    }

    /** Everything except `signature` itself — mirrors `chunkSignatureInput()` in canonical.mjs. */
    internal fun chunkSignatureInput(chunk: JSONObject): JSONObject {
        val copy = JSONObject(chunk.toString())
        copy.remove("signature")
        return copy
    }
}
