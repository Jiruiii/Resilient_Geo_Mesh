package com.resilientgeo.mesh.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class StaticLayerBundleCacheTest {

    @Test
    fun `stores large bundles as separate raw chunk files and reads them byte for byte`() {
        val root = Files.createTempDirectory("static-layer-cache-test").toFile()
        try {
            val cache = StaticLayerBundleCache(root)
            val bundle = StaticLayerBundleCache.Bundle(
                manifest = """{"layer_id":"taiwan-medical-directory","chunks":[{},{}]}""",
                chunks = listOf("""{"sequence":0}""", """{"sequence":1}"""),
            )

            cache.write("taiwan-medical-directory", bundle)

            val stored = File(root, "taiwan-medical-directory.bundle")
            assertTrue("manifest should be written independently", File(stored, "manifest.json").isFile)
            assertEquals(bundle.chunks[0], File(stored, "chunks/0.json").readText())
            assertEquals(bundle.chunks[1], File(stored, "chunks/1.json").readText())
            assertEquals(bundle, cache.read("taiwan-medical-directory"))
        } finally {
            root.deleteRecursively()
        }
    }
}
