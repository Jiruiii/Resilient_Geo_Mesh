package com.resilientgeo.mesh.data

import java.time.OffsetDateTime

/** One static layer after its manifest and features have been verified. */
internal data class StaticLayerFeatureSnapshot(
    val layerId: String,
    val features: List<Map<String, Any?>>,
    val createdAt: String?,
)

/** The verified static features passed from Android to Flutter. */
data class VerifiedStaticFeatureSnapshot(
    val features: List<Map<String, Any?>>,
    val snapshotAt: String?,
)

/** Combines verified layers and chooses the newest signed government manifest time. */
internal fun combineVerifiedStaticLayers(
    layers: List<StaticLayerFeatureSnapshot>,
): VerifiedStaticFeatureSnapshot {
    val timestampedLayers = setOf(
        "taiwan-shelter",
        "taiwan-medical",
        "taiwan-medical-directory",
    )
    val snapshotAt = layers.asSequence()
        .filter { it.layerId in timestampedLayers }
        .mapNotNull { layer ->
            val createdAt = layer.createdAt ?: return@mapNotNull null
            val instant = runCatching { OffsetDateTime.parse(createdAt).toInstant() }
                .getOrNull()
                ?: return@mapNotNull null
            instant to createdAt
        }
        .maxByOrNull { it.first }
        ?.second

    return VerifiedStaticFeatureSnapshot(
        features = layers.flatMap { it.features },
        snapshotAt = snapshotAt,
    )
}
