package com.resilientgeo.mesh.bridge

import com.resilientgeo.mesh.data.EventEntity
import com.resilientgeo.mesh.ingest.IngestResult
import com.resilientgeo.mesh.report.CrowdReportInput
import com.resilientgeo.mesh.routing.LonLat
import com.resilientgeo.mesh.routing.RouteRequest
import com.resilientgeo.mesh.routing.RouteResult
import kotlin.math.round

/** StandardMessageCodec-safe replies for the approved map MethodChannel contract. */
object MapBridgeProtocol {

    fun eventSnapshot(events: List<EventEntity>): List<Map<String, Any?>> =
        events.map { EventPayloadMapper.toMessage(it) }

    fun initialState(
        events: List<EventEntity>,
        emergencyModeEnabled: Boolean,
        staticFeatures: List<Map<String, Any?>> = emptyList(),
    ): Map<String, Any?> = mapOf(
        "events" to eventSnapshot(events),
        "emergency_mode_enabled" to emergencyModeEnabled,
        "static_features" to staticFeatures,
    )

    fun staticFeaturesResult(staticFeatures: List<Map<String, Any?>>): Map<String, Any?> =
        mapOf("static_features" to staticFeatures)

    fun fixtureLoadSummary(results: List<IngestResult>): Map<String, Int> {
        val inserted = results.count { it is IngestResult.Inserted }
        val updated = results.count { it is IngestResult.Updated }
        return mapOf(
            "processed" to results.size,
            "inserted" to inserted,
            "updated" to updated,
            "rejected" to results.size - inserted - updated,
        )
    }

    fun emergencyModeResult(enabled: Boolean): Map<String, Boolean> = mapOf("enabled" to enabled)

    /**
     * `submitCrowdReport` arguments, or null when the map does not have the
     * contract's shape. Value rules (category list, 160 characters, bounds)
     * are CrowdReportFactory.validate's job, so a well-shaped but invalid
     * form still gets the specific reason back.
     */
    fun crowdReportInput(arguments: Any?): CrowdReportInput? {
        val map = arguments as? Map<*, *> ?: return null
        val category = map["category"] as? String ?: return null
        val location = map["location"] as? Map<*, *> ?: return null
        val lon = (location["lon"] as? Number)?.toDouble() ?: return null
        val lat = (location["lat"] as? Number)?.toDouble() ?: return null
        val source = location["source"] as? String ?: return null
        val description = when (val value = map["description"]) {
            null -> ""
            is String -> value
            else -> return null
        }
        val hint = when (val value = map["location_hint"]) {
            null -> null
            is Map<*, *> -> CrowdReportInput.LocationHint(
                method = value["method"] as? String ?: return null,
                query = value["query"] as? String ?: return null,
                label = value["label"] as? String ?: return null,
                kind = value["kind"] as? String ?: return null,
                precision = value["precision"] as? String ?: return null,
            )
            else -> return null
        }
        return CrowdReportInput(category, description, lon, lat, source, hint)
    }

    /** Success reply; Flutter accepts nothing but UNVERIFIED/PENDING here. */
    fun crowdReportCreated(eventId: String, applyState: String, eventJson: String): Map<String, Any?> = mapOf(
        "event_id" to eventId,
        "apply_state" to applyState,
        "delivery_state" to "PENDING",
        "event_json" to eventJson,
    )

    /** `calculateEvacuationRoute` arguments, or null when they are not the contract's shape. */
    fun routeRequest(arguments: Any?): RouteRequest? {
        val map = arguments as? Map<*, *> ?: return null
        val origin = map["origin"] as? Map<*, *> ?: return null
        val destination = map["destination"] as? Map<*, *> ?: return null
        val disasterType = when (val value = map["disaster_type"]) {
            null -> null
            is String -> value
            else -> return null
        }
        return RouteRequest(
            origin = LonLat(
                (origin["lon"] as? Number)?.toDouble() ?: return null,
                (origin["lat"] as? Number)?.toDouble() ?: return null,
            ),
            destinationId = destination["id"] as? String ?: return null,
            destination = LonLat(
                (destination["lon"] as? Number)?.toDouble() ?: return null,
                (destination["lat"] as? Number)?.toDouble() ?: return null,
            ),
            mode = map["mode"] as? String ?: "walk",
            disasterType = disasterType,
        )
    }

    fun routeResult(result: RouteResult): Map<String, Any?> = mapOf(
        "status" to result.status.wire,
        "polyline" to result.polyline.map { listOf(it.lon, it.lat) },
        "distance_m" to result.distanceM?.let { round(it * 10) / 10 },
        "duration_s" to result.durationS?.let { round(it) },
        "graph_version" to result.graphVersion,
        "event_snapshot_at" to result.eventSnapshotAt,
        "warnings" to result.warnings.map {
            mapOf("code" to it.code, "event_id" to it.eventId, "message" to it.message)
        },
        "blocked_event_ids" to result.blockedEventIds,
    )
}
