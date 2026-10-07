package com.resilientgeo.mesh.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class VerifiedLayerCacheTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val features = listOf(
        JSONObject().put("feature_id", "shelter:1").put("properties", JSONObject().put("address", JSONObject.NULL)),
        JSONObject().put("feature_id", "shelter:2"),
    )

    @Test
    fun `a stored layer is returned only for the exact same key`() {
        val cache = VerifiedLayerCache(folder.root)
        val key = VerifiedLayerCache.key("trust", "manifest", listOf("c1", "c2"))
        cache.write("shelter", key, features)

        val hit = cache.read("shelter", key)!!
        assertEquals(listOf("shelter:1", "shelter:2"), hit.map { it.getString("feature_id") })
        // JSON null survives, so an unknown address stays "no data" rather than disappearing.
        assertEquals(JSONObject.NULL, hit.first().getJSONObject("properties").get("address"))
        assertNull(cache.read("shelter", VerifiedLayerCache.key("trust", "manifest", listOf("c1", "c2-changed"))))
        assertNull(cache.read("medical", key))
    }

    @Test
    fun `any change to trust store, manifest or chunks changes the key`() {
        val base = VerifiedLayerCache.key("trust", "manifest", listOf("c1", "c2"))
        assertNotEquals(base, VerifiedLayerCache.key("trust2", "manifest", listOf("c1", "c2")))
        assertNotEquals(base, VerifiedLayerCache.key("trust", "manifest2", listOf("c1", "c2")))
        assertNotEquals(base, VerifiedLayerCache.key("trust", "manifest", listOf("c2", "c1")))
        assertNotEquals(base, VerifiedLayerCache.key("trust", "manifest", listOf("c1")))
        // Moving bytes across a boundary must not collide.
        assertNotEquals(VerifiedLayerCache.key("ab", "c", emptyList()), VerifiedLayerCache.key("a", "bc", emptyList()))
    }

    @Test
    fun `a corrupted cache file is a miss, not a crash`() {
        val cache = VerifiedLayerCache(folder.root)
        val key = VerifiedLayerCache.key("trust", "manifest", emptyList())
        cache.write("shelter", key, features)
        folder.root.listFiles()!!.single().writeText("{\"cache_key\":\"$key\",\"features\":[")
        assertNull(cache.read("shelter", key))
    }

    @Test
    fun `verified bundle marker only matches the exact content key`() {
        val cache = VerifiedLayerCache(folder.root)
        val exactKey = "sha256:0123456789abcdef"

        assertFalse(cache.matchesVerified("taiwan-medical-directory", exactKey))
        cache.markVerified("taiwan-medical-directory", exactKey)

        assertTrue(cache.matchesVerified("taiwan-medical-directory", exactKey))
        assertFalse(cache.matchesVerified("taiwan-medical-directory", "$exactKey-different"))
    }
}
