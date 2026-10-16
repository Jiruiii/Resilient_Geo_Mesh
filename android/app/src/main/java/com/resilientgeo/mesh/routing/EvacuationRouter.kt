package com.resilientgeo.mesh.routing

import com.resilientgeo.mesh.ingest.ApplyState
import java.time.Instant
import java.util.PriorityQueue

/** Wire statuses of the `calculateEvacuationRoute` contract. */
enum class RouteStatus(val wire: String) {
    OK("ok"),
    NO_ROUTE("no_route"),
    GRAPH_UNAVAILABLE("graph_unavailable"),
    INVALID_INPUT("invalid_input"),
}

data class RouteResult(
    val status: RouteStatus,
    val polyline: List<LonLat>,
    val distanceM: Double?,
    val durationS: Double?,
    val graphVersion: String?,
    val eventSnapshotAt: String,
    val warnings: List<RouteWarning>,
    val blockedEventIds: List<String>,
) {
    companion object {
        fun failure(status: RouteStatus, snapshotAt: String, graphVersion: String? = null, warnings: List<RouteWarning> = emptyList(), blocked: List<String> = emptyList()) =
            RouteResult(status, emptyList(), null, null, graphVersion, snapshotAt, warnings, blocked)
    }
}

/** What the latest official SHELTER_STATUS near a shelter says, if anything. */
data class ShelterState(val availability: Availability, val event: RouteEvent?) {
    enum class Availability { OPEN, UNKNOWN, CLOSED, FULL }

    companion object {
        /** Status events are matched to a shelter point by position; static and status data share no id. */
        const val MATCH_RADIUS_M = 100.0

        fun resolve(destination: LonLat, events: List<RouteEvent>): ShelterState {
            val match = events
                .filter { it.eventType == "SHELTER_STATUS" && it.applyState == ApplyState.CURRENT && covers(it, destination) }
                .maxWithOrNull(compareBy<RouteEvent>({ it.issuedAt.toInstantOrMin() }, { it.eventId }))
                ?: return ShelterState(Availability.UNKNOWN, null)
            val availability = when (match.attributes.optString("status")) {
                "FULL" -> Availability.FULL
                "OPEN" -> {
                    val available = match.attributes.opt("available")
                    if (available is Number && available.toDouble() <= 0.0) Availability.FULL else Availability.OPEN
                }
                else -> Availability.CLOSED
            }
            return ShelterState(availability, match)
        }

        private fun covers(event: RouteEvent, destination: LonLat): Boolean =
            event.points.any { GeoMath.haversineMeters(it, destination) <= MATCH_RADIUS_M } ||
                event.polygons.any {
                    GeoMath.pointInPolygon(destination, it) ||
                        GeoMath.haversineMeters(GeoMath.centroid(it), destination) <= MATCH_RADIUS_M
                }

        private fun String?.toInstantOrMin(): Instant =
            this?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: Instant.MIN
    }
}

/**
 * Walking route from an origin to one shelter over [RoadGraph] + [HazardOverlay].
 *
 * Edge cost is length x penalty; blocked edges are skipped; reported distance
 * is the real length. Ties are resolved by node id through the priority
 * queue's ordering, so the same inputs always give the same route.
 */
object EvacuationRouter {
    /** Reused under the route service mutex; stamps avoid clearing region-sized arrays per shelter. */
    class SearchWorkspace(nodes: Int) {
        internal val distance = DoubleArray(nodes)
        internal val previous = IntArray(nodes)
        internal val visited = IntArray(nodes)
        internal val settled = IntArray(nodes)
        internal var generation = 0
        internal fun begin(): Int {
            if (generation == Int.MAX_VALUE) { visited.fill(0); settled.fill(0); generation = 0 }
            return ++generation
        }
    }
    /** Conservative walking speed for a disaster (crowds, debris, carrying things). */
    const val WALKING_SPEED_M_PER_S = 1.0

    /** Leaving a blocking hazard you already stand in is allowed, just strongly discouraged. */
    const val EXIT_HAZARD_PENALTY = 10.0

    /**
     * Shelters must sit next to the network. Every Neihu shelter is within
     * ~50 m of a walkable node, while shelters just outside the Neihu snapshot
     * (e.g. 中山區 across the Keelung River) are 180-300 m from its edge; with
     * the 300 m origin limit their routes would end at the edge and look short.
     */
    const val DESTINATION_SNAP_LIMIT_METERS = 100.0

    fun plan(
        graph: RoadGraph,
        overlay: HazardOverlay,
        origin: LonLat,
        destination: LonLat,
        shelter: ShelterState,
        snapshotAt: String,
        workspace: SearchWorkspace? = null,
    ): RouteResult {
        val version = graph.graphVersion
        fun noRoute(vararg warnings: RouteWarning, blocked: List<String> = emptyList()) =
            RouteResult.failure(RouteStatus.NO_ROUTE, snapshotAt, version, warnings.toList() + overlay.warnings, blocked)

        when (shelter.availability) {
            ShelterState.Availability.CLOSED -> return noRoute(
                RouteWarning("SHELTER_CLOSED", shelter.event?.eventId, "官方狀態顯示此避難所目前未開設"),
            )
            ShelterState.Availability.FULL -> return noRoute(
                RouteWarning("SHELTER_FULL", shelter.event?.eventId, "官方狀態顯示此避難所已額滿"),
            )
            else -> Unit
        }
        overlay.blockingAreaContaining(destination)?.let { hazard ->
            return noRoute(RouteWarning("SHELTER_IN_HAZARD", hazard.eventId, "此避難所位於危險區域內，已排除"))
        }
        val originNode = graph.nearestNode(origin)
            ?: return noRoute(RouteWarning("ORIGIN_OFF_GRAPH", null, "起點距離離線步行路網超過 300 公尺（涵蓋${graph.coverageName}），無法規劃路線"))
        val targetNode = graph.nearestNode(destination, DESTINATION_SNAP_LIMIT_METERS)
            ?: return noRoute(RouteWarning("DESTINATION_OFF_GRAPH", null, "避難所距離離線步行路網超過 100 公尺（涵蓋${graph.coverageName}），無法規劃路線"))

        val warnings = mutableListOf<RouteWarning>()
        var effective = overlay
        val originHazards = overlay.blockingAreas.filter { (_, polygon) -> GeoMath.pointInPolygon(origin, polygon) }
        if (originHazards.isNotEmpty()) {
            // Otherwise nobody standing in a flood zone could ever get a route out of it.
            effective = overlay.releasing(originHazards.map { it.first.identity }.toSet(), EXIT_HAZARD_PENALTY)
            warnings += RouteWarning("ORIGIN_IN_HAZARD", originHazards.first().first.eventId, "你位於危險區域內，請盡快離開")
        }
        if (shelter.availability == ShelterState.Availability.UNKNOWN) {
            warnings += RouteWarning("SHELTER_STATUS_UNKNOWN", null, "沒有此避難所的官方開設狀態，請現場確認")
        }

        // No unweighted second search is needed when there are no closures.
        val search = workspace ?: SearchWorkspace(graph.nodeCount)
        val baseline = if (effective.hasBlockedEdges) shortestPath(graph, originNode, targetNode, useHeuristic = true, workspace = search) { graph.edgeLengthMeters(it) } else null
        val avoided = baseline.orEmpty()
            .flatMap { edge -> effective.effects(edge).filter { it.kind == EdgeEffect.Kind.BLOCK && effective.isBlocked(edge) } }
            .map { it.event.eventId }
            .distinct()
            .sorted()
        val path = shortestPath(graph, originNode, targetNode, useHeuristic = true, workspace = search) { edge ->
            if (effective.isBlocked(edge)) Double.POSITIVE_INFINITY else graph.edgeLengthMeters(edge) * effective.penalty(edge)
        } ?: return noRoute(
            RouteWarning("NO_PASSABLE_PATH", null, "所有路徑都被封鎖，請聯絡 119 或前往附近較高樓層"),
            blocked = avoided,
        )

        val polyline = mutableListOf(graph.node(originNode))
        var current = originNode
        for (edge in path) {
            current = graph.otherEnd(edge, current)
            polyline += graph.node(current)
        }
        if (polyline.size == 1) {
            polyline += graph.node(originNode)
            warnings += RouteWarning("DESTINATION_NEARBY", null, "避難所就在附近")
        }
        warnings += routeWarnings(path, effective)
        val distance = path.sumOf { graph.edgeLengthMeters(it) }
        return RouteResult(
            status = RouteStatus.OK,
            polyline = polyline,
            distanceM = distance,
            durationS = distance / WALKING_SPEED_M_PER_S,
            graphVersion = version,
            eventSnapshotAt = snapshotAt,
            warnings = warnings + overlay.warnings,
            blockedEventIds = avoided,
        )
    }

    private fun routeWarnings(path: List<Int>, overlay: HazardOverlay): List<RouteWarning> {
        val seen = linkedMapOf<String, RouteWarning>()
        for (edge in path) {
            for (effect in overlay.effects(edge)) {
                val warning = when (effect.kind) {
                    EdgeEffect.Kind.UNVERIFIED -> RouteWarning(
                        "UNVERIFIED_CROWD_REPORT",
                        effect.event.eventId,
                        "路線經過未驗證回報路段，請現場確認",
                    )
                    EdgeEffect.Kind.PENALTY -> if (effect.event.eventType == "ROAD_STATUS") {
                        RouteWarning("PARTIAL_ROAD_CLOSURE", effect.event.eventId, "路線經過部分封閉路段")
                    } else {
                        RouteWarning("HAZARD_AREA_ON_ROUTE", effect.event.eventId, "路線經過高風險區域")
                    }
                    EdgeEffect.Kind.BLOCK -> null
                } ?: continue
                seen.putIfAbsent("${warning.code}|${warning.eventId}", warning)
            }
        }
        return seen.values.toList()
    }

    /**
     * Edge ids from [source] to [target] in travel order, or null when
     * unreachable. [weight] returning +Infinity removes an edge.
     */
    fun shortestPath(graph: RoadGraph, source: Int, target: Int, useHeuristic: Boolean = false,
                     workspace: SearchWorkspace = SearchWorkspace(graph.nodeCount), weight: (Int) -> Double): List<Int>? {
        require(workspace.distance.size == graph.nodeCount)
        val generation = workspace.begin()
        val distance = workspace.distance
        val previousEdge = workspace.previous
        val visited = workspace.visited
        val settled = workspace.settled
        val queue = PriorityQueue<QueueEntry>()
        val goal = graph.node(target)
        // Safe for the route engine: every permitted cost is >= physical length.
        // Custom callers retain Dijkstra unless they explicitly opt in.
        fun estimate(node: Int) = if (useHeuristic) GeoMath.haversineMeters(graph.node(node), goal) * 0.999999 else 0.0
        distance[source] = 0.0
        visited[source] = generation
        queue += QueueEntry(estimate(source), source)
        while (queue.isNotEmpty()) {
            val (_, node) = queue.poll()!!
            if (settled[node] == generation) continue
            settled[node] = generation
            if (node == target) break
            val cost = distance[node]
            for (index in graph.adjacencyRange(node)) {
                val edge = graph.adjacencyEdge(index)
                if (!graph.canWalkFrom(edge, node)) continue
                val w = weight(edge)
                if (w.isInfinite()) continue
                val next = graph.otherEnd(edge, node)
                val candidate = cost + w
                if (visited[next] != generation || candidate < distance[next]) {
                    visited[next] = generation
                    distance[next] = candidate
                    previousEdge[next] = edge
                    queue += QueueEntry(candidate + estimate(next), next)
                }
            }
        }
        if (settled[target] != generation) return null
        val edges = ArrayList<Int>()
        var node = target
        while (node != source) {
            val edge = previousEdge[node]
            edges += edge
            node = graph.otherEnd(edge, node)
        }
        edges.reverse()
        return edges
    }

    private data class QueueEntry(val cost: Double, val node: Int) : Comparable<QueueEntry> {
        override fun compareTo(other: QueueEntry): Int {
            val byCost = cost.compareTo(other.cost)
            return if (byCost != 0) byCost else node.compareTo(other.node)
        }
    }
}
