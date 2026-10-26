package com.resilientgeo.mesh.routing

import android.content.Context
import com.resilientgeo.mesh.ingest.ApplyState
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.Instant
import java.time.temporal.ChronoUnit

/** What the walker is heading to; only shelters carry opening status and disaster eligibility. */
enum class RouteDestinationKind(val wire: String) {
    SHELTER("shelter"),
    MEDICAL("medical"),
    SUPPLY("supply"),
    ;

    companion object {
        fun fromWire(value: String): RouteDestinationKind? = entries.firstOrNull { it.wire == value }
    }
}

data class RouteRequest(
    val origin: LonLat,
    val destinationId: String,
    val destination: LonLat,
    val mode: String,
    val disasterType: String? = null,
    val destinationKind: RouteDestinationKind = RouteDestinationKind.SHELTER,
)

/**
 * Answers `calculateEvacuationRoute` entirely offline: the bundled walk graph,
 * the verified events already in Room, and nothing else. No routing API is
 * ever called.
 *
 * The graph is loaded once; the hazard overlay is rebuilt only when the event
 * snapshot changes, because Flutter asks for multiple shelters in a row when
 * it recommends the nearest reachable one.
 */
class EvacuationRouteService(
    private val graphLoader: () -> RoadGraph,
    private val eventJsonProvider: suspend () -> List<String>,
    private val clock: () -> Instant = Instant::now,
    private val shelterCatalogProvider: suspend () -> ShelterDisasterCatalog = { ShelterDisasterCatalog(emptyMap()) },
) {
    private val mutex = Mutex()
    private var graph: RoadGraph? = null
    private var workspace: EvacuationRouter.SearchWorkspace? = null
    private var cachedOverlay: Pair<String, HazardOverlay>? = null
    private var shelterCatalog: ShelterDisasterCatalog? = null

    suspend fun calculate(request: RouteRequest): RouteResult = mutex.withLock {
        val now = clock()
        val events = eventJsonProvider().mapNotNull { RouteEvent.fromEventJson(it, now) }
        val snapshotAt = snapshotTime(events, now)
        if (!request.origin.isValid || !request.destination.isValid ||
            request.destinationId.isBlank() || request.mode != "walk" ||
            (request.disasterType != null && request.disasterType !in ShelterDisasterCatalog.labels)
        ) {
            return@withLock RouteResult.failure(RouteStatus.INVALID_INPUT, snapshotAt)
        }
        val toShelter = request.destinationKind == RouteDestinationKind.SHELTER
        val eligibilityWarning = request.disasterType?.takeIf { toShelter }?.let { type ->
            val catalog = shelterCatalog ?: shelterCatalogProvider().also { shelterCatalog = it }
            catalog.warning(request.destinationId, request.destination, type)
        }
        if (eligibilityWarning?.code == "SHELTER_LOCATION_MISMATCH") {
            return@withLock RouteResult.failure(RouteStatus.INVALID_INPUT, snapshotAt, warnings = listOf(eligibilityWarning))
        }
        if (eligibilityWarning?.code == "SHELTER_DISASTER_MISMATCH") {
            return@withLock RouteResult.failure(RouteStatus.NO_ROUTE, snapshotAt, warnings = listOf(eligibilityWarning))
        }
        val loaded = graph ?: try {
            graphLoader().also { graph = it }
        } catch (_: Exception) {
            return@withLock RouteResult.failure(RouteStatus.GRAPH_UNAVAILABLE, snapshotAt)
        }
        val fingerprint = events.map { "${it.identity}:${it.applyState}" }.sorted().joinToString("|")
        val overlay = cachedOverlay?.takeIf { it.first == fingerprint }?.second
            ?: run {
                // The nationwide-sized arrays take ~10 MB per overlay. Drop the
                // obsolete cache before allocating a replacement, under the
                // same mutex, so repeated event updates don't retain both.
                cachedOverlay = null
                HazardOverlay.fromEvents(events, loaded).also { cachedOverlay = fingerprint to it }
            }
        val route = EvacuationRouter.plan(
            graph = loaded,
            overlay = overlay,
            origin = request.origin,
            destination = request.destination,
            shelter = if (toShelter) ShelterState.resolve(request.destination, events) else null,
            snapshotAt = snapshotAt,
            workspace = workspace ?: EvacuationRouter.SearchWorkspace(loaded.nodeCount).also { workspace = it },
            destinationKind = request.destinationKind,
        )
        if (eligibilityWarning == null) route else route.copy(warnings = route.warnings + eligibilityWarning)
    }

    companion object {
        // Android automatically unpacks and renames .gz assets during merge.
        // .rgmz preserves our compressed bytes and the runtime asset name.
        const val GRAPH_ASSET = "routing/taipei-walk.rgmz"

        fun assetGraphLoader(context: Context): () -> RoadGraph = {
            RoadGraph.fromPrebuilt(context.applicationContext.assets.open(GRAPH_ASSET))
        }

        /** Newest issue time among events still in force; the planning time if there are none. */
        internal fun snapshotTime(events: List<RouteEvent>, now: Instant): String {
            val newest = events
                .filter { it.applyState != ApplyState.EXPIRED }
                .mapNotNull { event -> event.issuedAt?.let { runCatching { Instant.parse(it) }.getOrNull() } }
                .filter { !it.isAfter(now) }
                .maxOrNull()
                ?: now
            return newest.truncatedTo(ChronoUnit.SECONDS).toString()
        }
    }
}
