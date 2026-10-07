package com.resilientgeo.mesh.data

/** Converts signed layer identities into the stable feature kinds consumed by Flutter. */
internal fun staticFeatureKind(layerId: String, featureType: String): String = when {
    layerId in setOf("shelter", "taiwan-shelter") || featureType == "SHELTER" -> "shelter"
    layerId == "taiwan-medical-directory" || featureType == "MEDICAL_DIRECTORY_ENTRY" -> "medical-directory"
    layerId in setOf("medical", "taiwan-medical") || featureType in setOf("HOSPITAL", "CLINIC", "MEDICAL_FACILITY") -> "medical"
    layerId == "osm-road" -> "road"
    else -> "poi"
}
