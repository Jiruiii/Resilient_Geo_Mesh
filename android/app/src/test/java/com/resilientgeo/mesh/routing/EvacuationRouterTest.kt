package com.resilientgeo.mesh.routing

import com.resilientgeo.mesh.routing.RoutingTestSupport.event
import com.resilientgeo.mesh.routing.RoutingTestSupport.grid
import com.resilientgeo.mesh.routing.RoutingTestSupport.p
import com.resilientgeo.mesh.routing.RoutingTestSupport.point
import com.resilientgeo.mesh.routing.RoutingTestSupport.roadStatus
import com.resilientgeo.mesh.routing.RoutingTestSupport.square
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EvacuationRouterTest {
    private val graph = grid()
    private val shortest = GeoMath.haversineMeters(p(0, 0), p(1, 0)) + GeoMath.haversineMeters(p(1, 0), p(2, 0))
    private val detour = GeoMath.haversineMeters(p(0, 0), p(0, 1)) + GeoMath.haversineMeters(p(0, 1), p(1, 1)) +
        GeoMath.haversineMeters(p(1, 1), p(2, 1)) + GeoMath.haversineMeters(p(2, 1), p(2, 0))

    private fun plan(
        vararg events: RouteEvent,
        origin: LonLat = p(0, 0),
        destination: LonLat = p(2, 0),
        kind: RouteDestinationKind = RouteDestinationKind.SHELTER,
    ): RouteResult = EvacuationRouter.plan(
        graph = graph,
        overlay = HazardOverlay.fromEvents(events.toList(), graph),
        origin = origin,
        destination = destination,
        shelter = if (kind == RouteDestinationKind.SHELTER) ShelterState.resolve(destination, events.toList()) else null,
        snapshotAt = "2026-09-24T00:00:00Z",
        destinationKind = kind,
    )

    @Test
    fun `with no events the route is the shortest path`() {
        val route = plan()
        assertEquals(RouteStatus.OK, route.status)
        assertEquals(listOf(p(0, 0), p(1, 0), p(2, 0)), route.polyline)
        assertEquals(shortest, route.distanceM!!, 1e-6)
        assertEquals(route.distanceM!! / EvacuationRouter.WALKING_SPEED_M_PER_S, route.durationS!!, 1e-9)
        assertEquals("tiny-grid-v1", route.graphVersion)
        assertTrue(route.blockedEventIds.isEmpty())
    }

    @Test
    fun `a CLOSED road forces the detour and says which closure was avoided`() {
        val closure = roadStatus(100L, "CLOSED")
        val route = plan(closure)
        assertEquals(RouteStatus.OK, route.status)
        assertEquals(listOf(p(0, 0), p(0, 1), p(1, 1), p(2, 1), p(2, 0)), route.polyline)
        assertEquals(detour, route.distanceM!!, 1e-6)
        assertEquals(listOf(closure.eventId), route.blockedEventIds)
    }

    @Test
    fun `a PARTIAL penalty is enough for the detour to win, and distance stays real`() {
        val route = plan(roadStatus(100L, "PARTIAL"))
        assertEquals(listOf(p(0, 0), p(0, 1), p(1, 1), p(2, 1), p(2, 0)), route.polyline)
        assertEquals(detour, route.distanceM!!, 1e-6)
        assertTrue(route.blockedEventIds.isEmpty())
    }

    @Test
    fun `an unverified report is warned about but does not divert a clearly shorter route`() {
        val report = event("report:abcd1234:1", "CROWD_REPORT", point(p(1, 0)), namespace = "crowd.reports")
        val route = plan(report)
        assertEquals(listOf(p(0, 0), p(1, 0), p(2, 0)), route.polyline)
        val warning = route.warnings.single { it.code == "UNVERIFIED_CROWD_REPORT" }
        assertEquals(report.eventId, warning.eventId)
    }

    @Test
    fun `everything blocked returns no_route, not an empty ok`() {
        val route = plan(roadStatus(100L, "CLOSED"), roadStatus(202L, "CLOSED"))
        assertEquals(RouteStatus.NO_ROUTE, route.status)
        assertTrue(route.polyline.isEmpty())
        assertEquals(null, route.distanceM)
        assertTrue(route.warnings.any { it.code == "NO_PASSABLE_PATH" })
        assertEquals(listOf("road:w100-test"), route.blockedEventIds)
    }

    @Test
    fun `starting inside a flood zone still gets a way out, flagged`() {
        val flood = event("flood:origin", "FLOOD_WARNING", square(p(0, 0), 0.0003), namespace = "official.cwa", severity = "CRITICAL")
        val route = plan(flood)
        assertEquals(RouteStatus.OK, route.status)
        assertEquals(flood.eventId, route.warnings.first().eventId)
        assertEquals("ORIGIN_IN_HAZARD", route.warnings.first().code)
        assertTrue(route.blockedEventIds.isEmpty())
    }

    @Test
    fun `a flood elsewhere is routed around`() {
        val flood = event("flood:middle", "FLOOD_WARNING", square(p(1, 0), 0.0002), namespace = "official.cwa", severity = "CRITICAL")
        val route = plan(flood)
        assertEquals(listOf(p(0, 0), p(0, 1), p(1, 1), p(2, 1), p(2, 0)), route.polyline)
        assertEquals(listOf("flood:middle"), route.blockedEventIds)
    }

    @Test
    fun `closed, full or flooded shelters are excluded with a reason`() {
        fun status(status: String, available: Int?) = event(
            "shelter:s1",
            "SHELTER_STATUS",
            square(p(2, 0), 0.0002),
            namespace = "official.fire",
            attributes = JSONObject().put("status", status).put("available", available ?: JSONObject.NULL),
        )
        assertEquals("SHELTER_CLOSED", plan(status("STANDBY", 50)).warnings.first().code)
        assertEquals("SHELTER_FULL", plan(status("OPEN", 0)).warnings.first().code)
        assertEquals("SHELTER_FULL", plan(status("FULL", null)).warnings.first().code)
        assertEquals(RouteStatus.OK, plan(status("OPEN", 50)).status)
        val unknown = plan()
        assertTrue(unknown.warnings.any { it.code == "SHELTER_STATUS_UNKNOWN" })
        val flooded = plan(event("flood:s", "FLOOD_WARNING", square(p(2, 0), 0.0002), namespace = "official.cwa", severity = "CRITICAL"))
        assertEquals(RouteStatus.NO_ROUTE, flooded.status)
        assertEquals("SHELTER_IN_HAZARD", flooded.warnings.first().code)
    }

    @Test
    fun `an expired shelter status does not decide availability`() {
        val stale = event(
            "shelter:s1",
            "SHELTER_STATUS",
            point(p(2, 0)),
            namespace = "official.fire",
            attributes = JSONObject().put("status", "STANDBY"),
            expiresAt = "2026-09-24T00:30:00Z",
        )
        assertEquals(RouteStatus.OK, plan(stale).status)
    }

    @Test
    fun `off-network origin or shelter is no_route with a reason`() {
        assertEquals("ORIGIN_OFF_GRAPH", plan(origin = LonLat(121.52, 25.0)).warnings.first().code)
        assertEquals("DESTINATION_OFF_GRAPH", plan(destination = LonLat(121.52, 25.0)).warnings.first().code)
    }

    @Test
    fun `a shelter too far from the network is off-graph even within the origin limit`() {
        // ~150 m east of node 2: fine as an origin (300 m), too far for a shelter (100 m).
        val farShelter = LonLat(121.50366, 25.000)
        assertEquals("DESTINATION_OFF_GRAPH", plan(destination = farShelter).warnings.first().code)
        assertEquals(RouteStatus.OK, plan(origin = farShelter, destination = p(0, 0)).status)
    }

    @Test
    fun `a shelter at the origin node still yields a drawable two-point route`() {
        val route = plan(destination = LonLat(121.50001, 25.00001))
        assertEquals(RouteStatus.OK, route.status)
        assertEquals(2, route.polyline.size)
        assertEquals(0.0, route.distanceM!!, 0.0)
    }

    @Test
    fun `medical and supply destinations ignore shelter status and say so plainly`() {
        val fullShelterNearby = event(
            "shelter:s1",
            "SHELTER_STATUS",
            square(p(2, 0), 0.0002),
            namespace = "official.fire",
            attributes = JSONObject().put("status", "FULL"),
        )
        for (kind in listOf(RouteDestinationKind.MEDICAL, RouteDestinationKind.SUPPLY)) {
            val route = plan(fullShelterNearby, kind = kind)
            assertEquals(RouteStatus.OK, route.status)
            assertEquals(listOf(p(0, 0), p(1, 0), p(2, 0)), route.polyline)
            assertTrue(route.warnings.none { it.code.startsWith("SHELTER_") })
        }
    }

    @Test
    fun `a flooded walking destination is excluded without calling it a shelter`() {
        val flood = event("flood:s", "FLOOD_WARNING", square(p(2, 0), 0.0002), namespace = "official.cwa", severity = "CRITICAL")
        val route = plan(flood, kind = RouteDestinationKind.MEDICAL)
        assertEquals(RouteStatus.NO_ROUTE, route.status)
        assertEquals("DESTINATION_IN_HAZARD", route.warnings.first().code)
        assertEquals("此地點位於危險區域內，已排除", route.warnings.first().message)
    }

    @Test
    fun `walking destination messages name the destination, not a shelter`() {
        val offGraph = plan(destination = LonLat(121.52, 25.0), kind = RouteDestinationKind.SUPPLY)
        assertEquals("DESTINATION_OFF_GRAPH", offGraph.warnings.first().code)
        assertTrue(offGraph.warnings.first().message.startsWith("目的地距離離線步行路網超過 100 公尺"))
        val nearby = plan(destination = LonLat(121.50001, 25.00001), kind = RouteDestinationKind.MEDICAL)
        assertEquals("目的地就在附近", nearby.warnings.single { it.code == "DESTINATION_NEARBY" }.message)
        assertTrue(plan(destination = LonLat(121.52, 25.0)).warnings.first().message.startsWith("避難所距離"))
    }

    @Test
    fun `the same inputs give the same route every time`() {
        val events = arrayOf(roadStatus(101L, "PARTIAL"), event("report:x:1", "CROWD_REPORT", point(p(1, 1)), namespace = "crowd.reports"))
        val first = plan(*events, destination = p(2, 2))
        repeat(100) { assertEquals(first, plan(*events, destination = p(2, 2))) }
    }
}
