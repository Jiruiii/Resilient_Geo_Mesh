package com.resilientgeo.mesh.routing

import com.resilientgeo.mesh.ingest.ApplyState
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/**
 * The slice of a stored, already-verified event that route planning reads.
 * [applyState] must be derived at planning time ([ApplyState.at]), never the
 * value stored at ingest, or an event that expired in someone's pocket would
 * keep closing roads.
 */
data class RouteEvent(
    val namespace: String,
    val eventId: String,
    val eventVersion: Int,
    val eventType: String,
    val severity: String,
    val applyState: ApplyState,
    val issuedAt: String?,
    val attributes: JSONObject,
    val points: List<LonLat>,
    val lines: List<List<LonLat>>,
    val polygons: List<PolygonRings>,
) {
    val identity: String get() = "$namespace/$eventId@$eventVersion"

    companion object {
        fun fromEventJson(eventJson: String, now: Instant): RouteEvent? = try {
            val event = JSONObject(eventJson)
            if (event.optString("event_type") == "SHELTER_STATUS" &&
                event.optString("source") == "FIRE_AGENCY"
            ) {
                null
            } else {
                val namespace = event.getString("namespace")
                val geometry = event.optJSONObject("geometry")
                val points = mutableListOf<LonLat>()
                val lines = mutableListOf<List<LonLat>>()
                val polygons = mutableListOf<PolygonRings>()
                if (geometry != null) collectGeometry(geometry, points, lines, polygons)
                RouteEvent(
                    namespace = namespace,
                    eventId = event.getString("event_id"),
                    eventVersion = event.optInt("event_version", 1),
                    eventType = event.optString("event_type"),
                    severity = event.optString("severity"),
                    applyState = ApplyState.at(namespace, event.optString("expires_at", null), now),
                    issuedAt = event.optString("issued_at", null),
                    attributes = event.optJSONObject("attributes") ?: JSONObject(),
                    points = points,
                    lines = lines,
                    polygons = polygons,
                )
            }
        } catch (_: Exception) {
            null
        }

        private fun collectGeometry(
            geometry: JSONObject,
            points: MutableList<LonLat>,
            lines: MutableList<List<LonLat>>,
            polygons: MutableList<PolygonRings>,
        ) {
            when (geometry.optString("type")) {
                "Point" -> points += point(geometry.getJSONArray("coordinates"))
                "MultiPoint" -> points += line(geometry.getJSONArray("coordinates"))
                "LineString" -> lines += line(geometry.getJSONArray("coordinates"))
                "MultiLineString" -> geometry.getJSONArray("coordinates").forEachArray { lines += line(it) }
                "Polygon" -> polygons += polygon(geometry.getJSONArray("coordinates"))
                "MultiPolygon" -> geometry.getJSONArray("coordinates").forEachArray { polygons += polygon(it) }
                "GeometryCollection" -> {
                    val children = geometry.getJSONArray("geometries")
                    for (i in 0 until children.length()) collectGeometry(children.getJSONObject(i), points, lines, polygons)
                }
            }
        }

        private fun point(coordinates: JSONArray) = LonLat(coordinates.getDouble(0), coordinates.getDouble(1))

        private fun line(coordinates: JSONArray): List<LonLat> =
            (0 until coordinates.length()).map { point(coordinates.getJSONArray(it)) }

        private fun polygon(coordinates: JSONArray): PolygonRings =
            PolygonRings((0 until coordinates.length()).map { line(coordinates.getJSONArray(it)) })

        private inline fun JSONArray.forEachArray(action: (JSONArray) -> Unit) {
            for (i in 0 until length()) action(getJSONArray(i))
        }
    }
}
