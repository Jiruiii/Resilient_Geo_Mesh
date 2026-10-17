package com.resilientgeo.mesh.trust

import java.math.BigDecimal
import java.math.RoundingMode

/** A location hint from the offline address search; not an authoritative address. */
data class CrowdLocationHint(
    val method: String,
    val query: String,
    val label: String,
    val kind: String,
    val precision: String,
)

/**
 * Kotlin port of `pipeline/lib/crowd-common.mjs`, shared by crowd reports and
 * rescue requests. Error strings match the JS module verbatim.
 */
object CrowdCommon {
    val LOCATION_SOURCES = setOf("CURRENT_LOCATION", "MAP_PICK")
    val HINT_KINDS = setOf("COUNTY", "DISTRICT", "VILLAGE", "ROAD", "FACILITY")
    val HINT_PRECISIONS = setOf("AREA", "ROAD", "POINT")
    const val HINT_TEXT_MAX_CODE_POINTS = 80

    /** [minLon, minLat, maxLon, maxLat]: Taiwan incl. Penghu, Kinmen, Matsu and Pratas. */
    val TAIWAN_BOUNDS = doubleArrayOf(116.5, 20.5, 122.5, 26.8)

    /** Matches JS `Number(value.toFixed(6))` for the coordinates the factories accept. */
    fun roundCoordinate(value: Double): Double = BigDecimal(value).setScale(6, RoundingMode.HALF_UP).toDouble()

    fun hintErrors(hint: CrowdLocationHint): List<String> {
        val errors = mutableListOf<String>()
        if (hint.method != "ADDRESS") errors += "location_hint.method must be ADDRESS"
        if (hint.kind !in HINT_KINDS) errors += "location_hint.kind is invalid"
        if (hint.precision !in HINT_PRECISIONS) errors += "location_hint.precision is invalid"
        for ((field, value) in listOf("query" to hint.query, "label" to hint.label)) {
            if (value.codePointCount(0, value.length) > HINT_TEXT_MAX_CODE_POINTS) {
                errors += "location_hint.$field must be a string of at most $HINT_TEXT_MAX_CODE_POINTS characters"
            }
        }
        return errors
    }

    fun coordinateErrors(lon: Double, lat: Double): List<String> {
        if (!lon.isFinite() || !lat.isFinite()) return listOf("location must be finite numbers")
        if (lon < TAIWAN_BOUNDS[0] || lon > TAIWAN_BOUNDS[2] || lat < TAIWAN_BOUNDS[1] || lat > TAIWAN_BOUNDS[3]) {
            return listOf("location is outside the supported area")
        }
        return emptyList()
    }
}
