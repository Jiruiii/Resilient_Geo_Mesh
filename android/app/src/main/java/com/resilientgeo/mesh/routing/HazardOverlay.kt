package com.resilientgeo.mesh.routing

import com.resilientgeo.mesh.ingest.ApplyState
import com.resilientgeo.mesh.trust.RescueContract

/** How one event changes one edge. */
data class EdgeEffect(val event: RouteEvent, val kind: Kind, val factor: Double) {
    enum class Kind { BLOCK, PENALTY, UNVERIFIED }
}

/** Display data shown next to a route; codes are stable, messages are for people. */
data class RouteWarning(val code: String, val eventId: String?, val message: String)

/**
 * Per-edge block/penalty state derived from verified events, computed without
 * touching the graph itself so a new event only rebuilds this overlay.
 *
 * Rules (docs/superpowers/plans/2026-09-24-evacuation-routing.md Task 2):
 *
 * | Event                                   | State      | Effect on edges                       |
 * |-----------------------------------------|------------|---------------------------------------|
 * | ROAD_STATUS CLOSED                      | CURRENT    | every edge of the OSM way is blocked  |
 * | ROAD_STATUS PARTIAL                     | CURRENT    | penalty x3                            |
 * | [AREA_HAZARD_TYPES] polygon, CRITICAL   | CURRENT    | intersecting edges blocked            |
 * | [AREA_HAZARD_TYPES] polygon, HIGH       | CURRENT    | intersecting edges penalty x5         |
 * | any crowd.*                             | UNVERIFIED | nearby edges penalty x2, never blocks |
 * | crowd.rescue                            | —          | ignored (people needing help, not a hazard) |
 * | any of the above                        | EXPIRED    | ignored, counted in a warning         |
 *
 * Area hazards are an allowlist rather than "any CRITICAL polygon": the
 * bundled nationwide NCDR feed carries county-sized heat and water-supply
 * polygons, and SHELTER_STATUS/MEDICAL events are polygons too, none of which
 * make a street unwalkable. Blocked beats penalty; penalties take the
 * maximum, not the product, so overlapping events cannot explode weights.
 */
class HazardOverlay private constructor(
    private val blocked: BooleanArray,
    private val penalty: DoubleArray,
    private val effects: Map<Int, List<EdgeEffect>>,
    val warnings: List<RouteWarning>,
    /** CURRENT blocking area hazards, for origin/shelter-in-hazard checks. */
    val blockingAreas: List<Pair<RouteEvent, PolygonRings>>,
) {
    val hasBlockedEdges: Boolean = blocked.any { it }
    fun isBlocked(edge: Int): Boolean = blocked[edge]
    fun penalty(edge: Int): Double = penalty[edge]
    fun effects(edge: Int): List<EdgeEffect> = effects[edge].orEmpty()

    fun blockingAreaContaining(point: LonLat): RouteEvent? =
        blockingAreas.firstOrNull { (_, polygon) -> GeoMath.pointInPolygon(point, polygon) }?.first

    /** Same blocks and penalties, except edges blocked only by [releasedEvents] become passable at [factor]. */
    fun releasing(releasedEvents: Set<String>, factor: Double): HazardOverlay {
        if (releasedEvents.isEmpty()) return this
        val newBlocked = blocked.copyOf()
        val newPenalty = penalty.copyOf()
        for ((edge, edgeEffects) in effects) {
            val blocks = edgeEffects.filter { it.kind == EdgeEffect.Kind.BLOCK }
            if (blocks.isNotEmpty() && blocks.all { it.event.identity in releasedEvents }) {
                newBlocked[edge] = false
                newPenalty[edge] = maxOf(newPenalty[edge], factor)
            }
        }
        return HazardOverlay(newBlocked, newPenalty, effects, warnings, blockingAreas)
    }

    companion object {
        const val PARTIAL_ROAD_PENALTY = 3.0
        const val HIGH_AREA_PENALTY = 5.0
        const val UNVERIFIED_PENALTY = 2.0
        const val UNVERIFIED_POINT_RADIUS_M = 30.0
        const val UNVERIFIED_LINE_RADIUS_M = 15.0

        val AREA_HAZARD_TYPES = setOf("FLOOD_WARNING", "LANDSLIDE_RISK", "DEBRIS_FLOW_WARNING")

        /** Matches `w<way id>-<slug>` and `road:w<way id>-<slug>` (and a bare `w<id>`). */
        private val WAY_ID_RE = Regex("(?:^|:)w(\\d+)(?:-|$)")

        fun wayIdOf(eventId: String): Long? = WAY_ID_RE.find(eventId)?.groupValues?.get(1)?.toLongOrNull()

        fun empty(graph: RoadGraph): HazardOverlay = fromEvents(emptyList(), graph)

        fun fromEvents(events: List<RouteEvent>, graph: RoadGraph): HazardOverlay {
            val blocked = BooleanArray(graph.edgeCount)
            val penalty = DoubleArray(graph.edgeCount) { 1.0 }
            val effects = HashMap<Int, MutableList<EdgeEffect>>()
            val warnings = mutableListOf<RouteWarning>()
            val blockingAreas = mutableListOf<Pair<RouteEvent, PolygonRings>>()
            var expiredIgnored = 0

            fun apply(edge: Int, effect: EdgeEffect) {
                effects.getOrPut(edge) { mutableListOf() } += effect
                when (effect.kind) {
                    EdgeEffect.Kind.BLOCK -> blocked[edge] = true
                    else -> penalty[edge] = maxOf(penalty[edge], effect.factor)
                }
            }

            for (event in events.sortedBy { it.identity }) {
                val role = roleOf(event) ?: continue
                if (event.applyState == ApplyState.EXPIRED) {
                    expiredIgnored++
                    continue
                }
                when (role) {
                    Role.ROAD_CLOSED, Role.ROAD_PARTIAL -> {
                        val edges = wayIdOf(event.eventId)?.let(graph::edgesForWay) ?: IntArray(0)
                        if (edges.isEmpty()) {
                            warnings += RouteWarning(
                                "ROAD_STATUS_UNMATCHED",
                                event.eventId,
                                "有一筆道路狀態資訊無法對應到離線路網，未納入路線計算",
                            )
                            continue
                        }
                        val effect = if (role == Role.ROAD_CLOSED) {
                            EdgeEffect(event, EdgeEffect.Kind.BLOCK, Double.POSITIVE_INFINITY)
                        } else {
                            EdgeEffect(event, EdgeEffect.Kind.PENALTY, PARTIAL_ROAD_PENALTY)
                        }
                        edges.forEach { apply(it, effect) }
                    }
                    Role.AREA_BLOCK, Role.AREA_PENALTY -> {
                        val effect = if (role == Role.AREA_BLOCK) {
                            EdgeEffect(event, EdgeEffect.Kind.BLOCK, Double.POSITIVE_INFINITY)
                        } else {
                            EdgeEffect(event, EdgeEffect.Kind.PENALTY, HIGH_AREA_PENALTY)
                        }
                        for (polygon in event.polygons) {
                            if (role == Role.AREA_BLOCK) blockingAreas += event to polygon
                            forEdgesNear(graph, polygon.bbox) { edge ->
                                if (GeoMath.segmentIntersectsPolygon(
                                        graph.node(graph.edgeFrom(edge)),
                                        graph.node(graph.edgeTo(edge)),
                                        polygon,
                                    )
                                ) {
                                    apply(edge, effect)
                                }
                            }
                        }
                    }
                    Role.UNVERIFIED -> {
                        val effect = EdgeEffect(event, EdgeEffect.Kind.UNVERIFIED, UNVERIFIED_PENALTY)
                        unverifiedEdges(graph, event).forEach { apply(it, effect) }
                    }
                }
            }
            if (expiredIgnored > 0) {
                warnings += RouteWarning(
                    "EXPIRED_EVENTS_IGNORED",
                    null,
                    "有 $expiredIgnored 筆已過期的封路或災情資訊未納入路線計算",
                )
            }
            return HazardOverlay(blocked, penalty, effects, warnings, blockingAreas)
        }

        private enum class Role { ROAD_CLOSED, ROAD_PARTIAL, AREA_BLOCK, AREA_PENALTY, UNVERIFIED }

        private fun roleOf(event: RouteEvent): Role? = when {
            // A rescue point marks people who need help, not a hazard to route around.
            event.namespace == RescueContract.NAMESPACE -> null
            event.namespace.startsWith("crowd.") -> Role.UNVERIFIED
            event.eventType == "ROAD_STATUS" -> when (event.attributes.optString("status")) {
                "CLOSED" -> Role.ROAD_CLOSED
                "PARTIAL" -> Role.ROAD_PARTIAL
                else -> null
            }
            event.eventType in AREA_HAZARD_TYPES && event.polygons.isNotEmpty() -> when (event.severity) {
                "CRITICAL" -> Role.AREA_BLOCK
                "HIGH" -> Role.AREA_PENALTY
                else -> null
            }
            else -> null
        }

        private fun unverifiedEdges(graph: RoadGraph, event: RouteEvent): Set<Int> {
            val edges = sortedSetOf<Int>()
            for (point in event.points) {
                forEdgesNear(graph, BBox(point.lon, point.lat, point.lon, point.lat).expandedByMeters(UNVERIFIED_POINT_RADIUS_M)) { edge ->
                    val d = GeoMath.pointToSegmentMeters(point, graph.node(graph.edgeFrom(edge)), graph.node(graph.edgeTo(edge)))
                    if (d <= UNVERIFIED_POINT_RADIUS_M) edges += edge
                }
            }
            for (line in event.lines) {
                if (line.size < 2) continue
                forEdgesNear(graph, BBox.of(line).expandedByMeters(UNVERIFIED_LINE_RADIUS_M)) { edge ->
                    val a = graph.node(graph.edgeFrom(edge))
                    val b = graph.node(graph.edgeTo(edge))
                    val mid = LonLat((a.lon + b.lon) / 2, (a.lat + b.lat) / 2)
                    val near = line.zipWithNext().any { (c, d) -> GeoMath.pointToSegmentMeters(mid, c, d) <= UNVERIFIED_LINE_RADIUS_M }
                    if (near) edges += edge
                }
            }
            for (polygon in event.polygons) {
                forEdgesNear(graph, polygon.bbox) { edge ->
                    if (GeoMath.segmentIntersectsPolygon(graph.node(graph.edgeFrom(edge)), graph.node(graph.edgeTo(edge)), polygon)) {
                        edges += edge
                    }
                }
            }
            return edges
        }

        private inline fun forEdgesNear(graph: RoadGraph, box: BBox, action: (Int) -> Unit) {
            for (edge in graph.edgesNear(box)) action(edge)
        }
    }
}
