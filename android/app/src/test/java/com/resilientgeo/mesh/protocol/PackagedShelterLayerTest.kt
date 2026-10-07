package com.resilientgeo.mesh.protocol

import org.junit.Assert.assertFalse
import org.junit.Test
import java.io.File

class PackagedShelterLayerTest {

    @Test
    fun `APK does not include the legacy nationwide shelter package`() {
        val root = File("src/main/assets/static/taiwan/shelter")

        assertFalse("Static shelter data must be downloaded and cached, not shipped in the APK", root.exists())
    }
}
