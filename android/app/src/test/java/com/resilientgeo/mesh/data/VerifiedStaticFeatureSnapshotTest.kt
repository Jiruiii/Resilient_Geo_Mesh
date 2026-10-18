package com.resilientgeo.mesh.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VerifiedStaticFeatureSnapshotTest {

    @Test
    fun `combines features and chooses newest government layer timestamp`() {
        val result = combineVerifiedStaticLayers(
            listOf(
                StaticLayerFeatureSnapshot(
                    layerId = "taiwan-shelter",
                    features = listOf(mapOf("id" to "shelter:1")),
                    createdAt = "2026-09-03T02:00:32Z",
                ),
                StaticLayerFeatureSnapshot(
                    layerId = "taiwan-medical",
                    features = listOf(mapOf("id" to "medical:1")),
                    createdAt = "2026-09-03T03:00:00Z",
                ),
                StaticLayerFeatureSnapshot(
                    layerId = "taiwan-medical-directory",
                    features = emptyList(),
                    createdAt = "invalid-timestamp",
                ),
                StaticLayerFeatureSnapshot(
                    layerId = "osm-road",
                    features = emptyList(),
                    createdAt = "2026-09-04T00:00:00Z",
                ),
            ),
        )

        assertEquals(listOf("shelter:1", "medical:1"), result.features.map { it["id"] })
        assertEquals("2026-09-03T03:00:00Z", result.snapshotAt)
    }

    @Test
    fun `reports no timestamp when government manifests have no valid time`() {
        val result = combineVerifiedStaticLayers(
            listOf(
                StaticLayerFeatureSnapshot(
                    layerId = "taiwan-shelter",
                    features = emptyList(),
                    createdAt = "invalid",
                ),
            ),
        )

        assertNull(result.snapshotAt)
    }
}
