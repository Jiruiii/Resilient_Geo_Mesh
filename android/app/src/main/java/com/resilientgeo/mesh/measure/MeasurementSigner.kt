package com.resilientgeo.mesh.measure

import com.resilientgeo.mesh.protocol.ChunkVerifier
import com.resilientgeo.mesh.trust.Canonical
import com.resilientgeo.mesh.trust.DeviceSigningKey
import com.resilientgeo.mesh.trust.EventVerifier
import org.json.JSONObject
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * Re-signs bundled Taiwan chunks as measurement-only data. The event bodies
 * and geometry are kept, so payload sizes stay realistic, but the namespace,
 * dataset and key change: only the measurement harness's isolated
 * repository trusts [KEY_ID], so these chunks can never enter a normal
 * database or be accepted by a phone outside a measurement run.
 */
class MeasurementSigner(private val key: DeviceSigningKey) {
    /** Trust store for the measurement repository: this key and nothing else. */
    val trustedKeysJson: String = JSONObject().put(KEY_ID, key.publicKeySpkiBase64()).toString()

    fun resign(source: JSONObject, now: Instant): JSONObject {
        val issued = now.truncatedTo(ChronoUnit.SECONDS)
        val events = source.getJSONArray("events")
        for (i in 0 until events.length()) {
            val event = events.getJSONObject(i)
            event.remove("signer_public_key")
            event.put("namespace", NAMESPACE)
                .put("source", "EXERCISE_ONLY")
                .put("issued_at", issued.toString())
                .put("expires_at", issued.plus(1, ChronoUnit.DAYS).toString())
                .put("signing_key_id", KEY_ID)
            event.put("payload_hash", Canonical.sha256Canonical(EventVerifier.eventPayload(event)))
            event.put("signature", key.signCanonical(Canonical.canonicalize(EventVerifier.eventSignatureInput(event))))
        }
        val chunk = JSONObject(source.toString())
            .put("events", events)
            .put("chunk_id", source.getString("chunk_id").replace(source.getString("dataset_id"), DATASET_ID))
            .put("dataset_id", DATASET_ID)
            .put("manifest_id", "$DATASET_ID:manifest:$DATASET_VERSION")
            .put("manifest_hash", Canonical.sha256Canonical("$DATASET_ID:manifest:$DATASET_VERSION"))
            .put("namespace", NAMESPACE)
            .put("dataset_version", DATASET_VERSION)
            .put("created_at", issued.toString())
            .put("signing_key_id", KEY_ID)
        chunk.remove("signature")
        val content = ChunkVerifier.chunkContent(chunk)
        chunk.put("byte_length", Canonical.canonicalize(content).toByteArray(Charsets.UTF_8).size)
            .put("chunk_hash", Canonical.sha256Canonical(content))
        return chunk.put("signature", key.signCanonical(Canonical.canonicalize(ChunkVerifier.chunkSignatureInput(chunk))))
    }

    companion object {
        const val KEY_ID = "measurement-local-v1"
        const val NAMESPACE = "measure.exercise"
        const val DATASET_ID = "measure-taiwan"
        private const val DATASET_VERSION = 1

        /**
         * Every phone derives the same key from a public label, so two phones
         * can measure offline without exchanging keys first. Anyone can derive
         * it too, which is why nothing outside the measurement repository
         * trusts it.
         */
        fun shared() = MeasurementSigner(DeviceSigningKey.fromSeed(
            java.security.MessageDigest.getInstance("SHA-256").digest("resilientgeo-measurement-only-v1".toByteArray()),
        ))
    }
}
