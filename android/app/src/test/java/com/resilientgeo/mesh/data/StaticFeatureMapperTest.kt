package com.resilientgeo.mesh.data

import org.junit.Assert.assertEquals
import org.junit.Test

class StaticFeatureMapperTest {
    @Test
    fun `maps published Taiwan medical feature types for Flutter`() {
        assertEquals("medical", staticFeatureKind("taiwan-medical", "MEDICAL_FACILITY"))
        assertEquals("medical-directory", staticFeatureKind("taiwan-medical-directory", "MEDICAL_DIRECTORY_ENTRY"))
        assertEquals("shelter", staticFeatureKind("taiwan-shelter", "SHELTER"))
    }
}
