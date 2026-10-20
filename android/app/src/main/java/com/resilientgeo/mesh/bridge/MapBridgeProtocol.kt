package com.resilientgeo.mesh.bridge

import com.resilientgeo.mesh.data.EventEntity
import com.resilientgeo.mesh.data.EventBridgeRow
import com.resilientgeo.mesh.data.VerifiedStaticFeatureSnapshot
import com.resilientgeo.mesh.ingest.IngestResult
import com.resilientgeo.mesh.report.GovernmentWarningInput
import com.resilientgeo.mesh.report.CrowdReportInput
import com.resilientgeo.mesh.report.RescueAction
import com.resilientgeo.mesh.routing.LonLat
import com.resilientgeo.mesh.routing.RouteRequest
import com.resilientgeo.mesh.routing.RouteResult
import com.resilientgeo.mesh.trust.CrowdLocationHint
import com.resilientgeo.mesh.trust.RescueRequestInput
import kotlin.math.round
import java.time.Instant
import java.util.UUID
import org.json.JSONObject

/** StandardMessageCodec-safe replies for the approved map MethodChannel contract. */
object MapBridgeProtocol {

    data class GovernmentWarningRequest(val input: GovernmentWarningInput, val eventId: String)

    fun governmentWarningRequest(arguments: Any?): GovernmentWarningRequest? {
        val map = arguments as? Map<*, *> ?: return null
        val title = map["title"] as? String ?: return null
        val content = map["content"] as? String ?: return null
        val category = map["category"] as? String ?: return null
        val severity = map["severity"] as? String ?: return null
        val expiryText = map["expires_at"] as? String ?: return null
        val expiresAt = runCatching { Instant.parse(expiryText) }.getOrNull() ?: return null
        val hasLongitude = map["longitude"] != null
        val hasLatitude = map["latitude"] != null
        if (hasLongitude != hasLatitude) return null
        val location = if (!hasLongitude) null else {
            val longitude = (map["longitude"] as? Number)?.toDouble() ?: return null
            val latitude = (map["latitude"] as? Number)?.toDouble() ?: return null
            GovernmentWarningInput.Location(longitude, latitude)
        }
        val eventId = map["event_id"] as? String ?: "announcement:device:${UUID.randomUUID()}"
        return GovernmentWarningRequest(
            GovernmentWarningInput(title, content, category, severity, expiresAt, location),
            eventId,
        )
    }

    fun governmentDeviceKeyReply(state: JSONObject): Map<String, Any?> = mapOf(
        "signing_key_id" to state.getString("signing_key_id"),
        "signer_public_key" to state.getString("signer_public_key"),
    )

    fun governmentDeviceAuthorizationReply(state: JSONObject): Map<String, Any?> = mapOf(
        "status" to state.getString("status"),
        "signing_key_id" to state.getString("signing_key_id"),
        "signer_public_key" to state.getString("signer_public_key"),
        "certificate_json" to state.opt("certificate_json").takeUnless { it === JSONObject.NULL },
        "certificate_expires_at" to state.opt("certificate_expires_at").takeUnless { it === JSONObject.NULL },
    )

    fun governmentWarningCreated(eventId: String, payloadHash: String, eventJson: String, duplicate: Boolean) = mapOf(
        "event_id" to eventId,
        "payload_hash" to payloadHash,
        "event_json" to eventJson,
        "apply_state" to "CURRENT",
        "upload_state" to "PENDING",
        "duplicate" to duplicate,
    )

    fun eventSnapshot(events: List<EventEntity>): List<Map<String, Any?>> =
        events.map { EventPayloadMapper.toMessage(it) }

    fun bridgeEventSnapshot(events: List<EventBridgeRow>): List<Map<String, Any?>> =
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

    fun initialBridgeState(
        events: List<EventBridgeRow>,
        emergencyModeEnabled: Boolean,
        staticFeatures: List<Map<String, Any?>> = emptyList(),
    ): Map<String, Any?> = mapOf(
        "events" to bridgeEventSnapshot(events),
        "emergency_mode_enabled" to emergencyModeEnabled,
        "static_features" to staticFeatures,
    )

    fun staticFeaturesResult(snapshot: VerifiedStaticFeatureSnapshot): Map<String, Any?> =
        mapOf(
            "static_features" to snapshot.features,
            "snapshot_at" to snapshot.snapshotAt,
        )

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
            is Map<*, *> -> CrowdLocationHint(
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

    /** `submitRescueRequest` / `reviseRescueRequest` form, or null when it does not have the contract's shape. */
    fun rescueRequestInput(arguments: Any?): RescueRequestInput? {
        val map = arguments as? Map<*, *> ?: return null
        val location = map["location"] as? Map<*, *> ?: return null
        val triage = (map["triage"] as? Map<*, *>)?.entries?.associate { (key, value) ->
            (key as? String ?: return null) to (value as? String ?: return null)
        } ?: return null
        val description = when (val value = map["description"]) {
            null -> ""
            is String -> value
            else -> return null
        }
        val hint = when (val value = map["location_hint"]) {
            null -> null
            is Map<*, *> -> CrowdLocationHint(
                method = value["method"] as? String ?: return null,
                query = value["query"] as? String ?: return null,
                label = value["label"] as? String ?: return null,
                kind = value["kind"] as? String ?: return null,
                precision = value["precision"] as? String ?: return null,
            )
            else -> return null
        }
        return RescueRequestInput(
            requestType = map["request_type"] as? String ?: return null,
            subject = map["subject"] as? String ?: return null,
            peopleCount = (map["people_count"] as? Int) ?: (map["people_count"] as? Long)?.toInt() ?: return null,
            triage = triage,
            description = description,
            lon = (location["lon"] as? Number)?.toDouble() ?: return null,
            lat = (location["lat"] as? Number)?.toDouble() ?: return null,
            locationSource = location["source"] as? String ?: return null,
            locationHint = hint,
        )
    }

    fun rescueAction(value: Any?): RescueAction? = RescueAction.entries.firstOrNull { it.name == value }

    fun rescueSaved(entity: EventEntity, serverState: String = "NOT_UPLOADED", serverReason: String? = null): Map<String, Any?> = mapOf(
        "request" to EventPayloadMapper.toMessage(entity),
        "delivery_state" to "PENDING",
        "server_state" to serverState,
        "server_reason" to serverReason,
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
