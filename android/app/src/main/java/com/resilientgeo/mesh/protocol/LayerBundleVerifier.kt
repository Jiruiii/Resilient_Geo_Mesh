package com.resilientgeo.mesh.protocol

import com.resilientgeo.mesh.trust.Canonical
import com.resilientgeo.mesh.trust.Ed25519Verifier
import com.resilientgeo.mesh.trust.FeatureVerifier
import com.resilientgeo.mesh.trust.TrustedKeyStore
import org.json.JSONArray
import org.json.JSONObject

/** Verifies a layer manifest and all of its signed chunks as one package. */
object LayerBundleVerifier {

    private val REQUIRED_FIELDS = listOf(
        "schema_version", "manifest_id", "dataset_id", "layer_id", "namespace", "source",
        "source_version", "dataset_version", "created_at", "expires_at", "chunking",
        "total_feature_count", "total_size_bytes", "bbox", "content_hash", "chunks",
        "manifest_hash", "signature_algorithm", "signing_key_id", "signature",
    )

    fun verify(
        manifest: JSONObject,
        chunks: List<JSONObject>,
        trustStore: TrustedKeyStore,
    ): LayerVerificationResult = verifyChunks(manifest, chunks.asSequence(), chunks.size, trustStore)

    /** Parses and verifies one downloaded chunk at a time to bound peak Android heap use. */
    fun verifyJson(
        manifest: JSONObject,
        chunks: List<String>,
        trustStore: TrustedKeyStore,
    ): LayerVerificationResult = verifyChunks(
        manifest,
        chunks.asSequence().map(::JSONObject),
        chunks.size,
        trustStore,
    )

    /** Verifies a package without retaining every parsed feature in memory. */
    fun verifyJsonChunks(
        manifest: JSONObject,
        chunks: List<String>,
        trustStore: TrustedKeyStore,
        onVerifiedChunk: (List<JSONObject>) -> Unit,
    ): LayerVerificationResult = verifyChunks(
        manifest,
        chunks.asSequence().map(::JSONObject),
        chunks.size,
        trustStore,
        onVerifiedChunk,
    )

    private fun verifyChunks(
        manifest: JSONObject,
        chunks: Sequence<JSONObject>,
        chunkCount: Int,
        trustStore: TrustedKeyStore,
        onVerifiedChunk: ((List<JSONObject>) -> Unit)? = null,
    ): LayerVerificationResult {
        val shapeErrors = validateManifest(manifest)
        if (shapeErrors.isNotEmpty()) return LayerVerificationResult(false, LayerVerificationResult.Stage.SCHEMA, shapeErrors)

        val signingKeyId = manifest.getString("signing_key_id")
        val publicKey = trustStore.publicKeyFor(signingKeyId)
            ?: return LayerVerificationResult(false, LayerVerificationResult.Stage.TRUST, listOf("manifest signing_key_id is not trusted"))
        val hashInput = JSONObject(manifest.toString()).apply {
            remove("manifest_hash")
            remove("signature")
        }
        if (Canonical.sha256Canonical(hashInput) != manifest.getString("manifest_hash")) {
            return LayerVerificationResult(false, LayerVerificationResult.Stage.INTEGRITY, listOf("manifest_hash_mismatch"))
        }
        val signatureInput = JSONObject(manifest.toString()).apply { remove("signature") }
        if (!Ed25519Verifier.verify(Canonical.canonicalize(signatureInput), manifest.getString("signature"), publicKey)) {
            return LayerVerificationResult(false, LayerVerificationResult.Stage.SIGNATURE, listOf("manifest_signature_invalid"))
        }

        val manifestChunks = manifest.getJSONArray("chunks")
        if (chunkCount != manifestChunks.length()) {
            return LayerVerificationResult(false, LayerVerificationResult.Stage.INTEGRITY, listOf("chunk_count_mismatch"))
        }
        val allFeatures: MutableList<JSONObject>? = if (onVerifiedChunk == null) mutableListOf() else null
        val contentHasher = com.resilientgeo.mesh.trust.CanonicalArrayHasher()
        var featureCount = 0
        for (chunk in chunks) {
            if (chunk.optString("manifest_id") != manifest.getString("manifest_id")
                || chunk.optString("manifest_hash") != manifest.getString("manifest_hash")) {
                return LayerVerificationResult(false, LayerVerificationResult.Stage.INTEGRITY, listOf("chunk_binding_invalid"))
            }
            val expected = (0 until manifestChunks.length())
                .map { manifestChunks.getJSONObject(it) }
                .firstOrNull { it.optString("chunk_id") == chunk.optString("chunk_id") }
                ?: return LayerVerificationResult(false, LayerVerificationResult.Stage.INTEGRITY, listOf("chunk_not_in_manifest"))
            val verified = LayerChunkVerifier.verify(chunk, trustStore)
            if (!verified.valid) return verified
            val actualIds = verified.features.map { it.optString("feature_id") }
            val expectedFeatureIds = expected.optJSONArray("feature_ids")
                ?: return LayerVerificationResult(false, LayerVerificationResult.Stage.SCHEMA, listOf("feature_ids_missing"))
            val expectedIds = (0 until expectedFeatureIds.length())
                .map { expectedFeatureIds.getString(it) }
            if (actualIds != expectedIds) {
                return LayerVerificationResult(false, LayerVerificationResult.Stage.INTEGRITY, listOf("feature_ids_mismatch"))
            }
            for (feature in verified.features) {
                contentHasher.update(FeatureVerifier.featurePayload(feature))
                featureCount += 1
            }
            if (onVerifiedChunk == null) allFeatures?.addAll(verified.features)
            else onVerifiedChunk(verified.features)
        }

        if (featureCount != manifest.getInt("total_feature_count")) {
            return LayerVerificationResult(false, LayerVerificationResult.Stage.INTEGRITY, listOf("total_feature_count_mismatch"))
        }
        if (contentHasher.finish() != manifest.getString("content_hash")) {
            return LayerVerificationResult(false, LayerVerificationResult.Stage.INTEGRITY, listOf("manifest_content_hash_mismatch"))
        }
        return LayerVerificationResult(
            true,
            LayerVerificationResult.Stage.SIGNATURE,
            features = allFeatures ?: emptyList(),
        )
    }

    private fun validateManifest(manifest: JSONObject): List<String> {
        val errors = mutableListOf<String>()
        for (field in REQUIRED_FIELDS) if (!manifest.has(field)) errors += "missing manifest field: $field"
        if (manifest.optString("schema_version") != "layer-manifest-v0") errors += "schema_version must be layer-manifest-v0"
        for (field in listOf("manifest_id", "dataset_id", "layer_id", "namespace", "source", "source_version", "created_at", "expires_at", "content_hash", "manifest_hash", "signature_algorithm", "signing_key_id")) {
            if (manifest.opt(field) !is String || manifest.optString(field).isEmpty()) errors += "$field must be a non-empty string"
        }
        if (manifest.opt("chunks") !is JSONArray || manifest.optJSONArray("chunks")?.length() == 0) errors += "chunks are required"
        if (manifest.opt("chunking") !is JSONObject) errors += "chunking must be an object"
        if (manifest.opt("total_feature_count") !is Number || manifest.optInt("total_feature_count", -1) < 1) errors += "total_feature_count must be positive"
        if (manifest.opt("total_size_bytes") !is Number || manifest.optLong("total_size_bytes", -1) < 0) errors += "total_size_bytes must be non-negative"
        if (!Regex("^sha256:[0-9a-fA-F]{64}$").matches(manifest.optString("content_hash", ""))) errors += "content_hash is invalid"
        if (!Regex("^sha256:[0-9a-fA-F]{64}$").matches(manifest.optString("manifest_hash", ""))) errors += "manifest_hash is invalid"
        val signature = manifest.optString("signature", "")
        if (signature.length < 4 || !Regex("^[A-Za-z0-9+/]+={0,2}$").matches(signature)) errors += "signature is invalid"
        return errors
    }
}
