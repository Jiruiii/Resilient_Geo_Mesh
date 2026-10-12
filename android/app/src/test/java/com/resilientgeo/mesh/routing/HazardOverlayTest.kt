package com.resilientgeo.mesh.routing

import com.resilientgeo.mesh.routing.RoutingTestSupport.event
import com.resilientgeo.mesh.routing.RoutingTestSupport.grid
import com.resilientgeo.mesh.routing.RoutingTestSupport.p
import com.resilientgeo.mesh.routing.RoutingTestSupport.point
import com.resilientgeo.mesh.routing.RoutingTestSupport.roadStatus
import com.resilientgeo.mesh.routing.RoutingTestSupport.square
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HazardOverlayTest {
    private val graph = grid()
    private val row0 = graph.edgesForWay(100L).toList()

    private fun overlay(vararg events: RouteEvent) = HazardOverlay.fromEvents(events.toList(), graph)

    @Test
    fun `CLOSED road blocks every edge of its way`() {
        val result = overlay(roadStatus(100L, "CLOSED"))
        row0.forEach { assertTrue(result.isBlocked(it)) }
        assertFalse(result.isBlocked(graph.edgesForWay(101L).first()))
    }

    @Test
    fun `PARTIAL road triples the cost`() {
        val result = overlay(roadStatus(100L, "PARTIAL"))
        row0.forEach {
            assertFalse(result.isBlocked(it))
            assertEquals(3.0, result.penalty(it), 0.0)
        }
    }

    @Test
    fun `OPEN road status changes nothing`() {
        val result = overlay(roadStatus(100L, "OPEN"))
        row0.forEach { assertEquals(1.0, result.penalty(it), 0.0) }
        assertTrue(result.warnings.isEmpty())
    }

    @Test
    fun `CRITICAL flood polygon blocks intersecting edges`() {
        val result = overlay(event("flood:1", "FLOOD_WARNING", square(p(1, 0), 0.0002), namespace = "official.cwa", severity = "CRITICAL"))
        row0.forEach { assertTrue(result.isBlocked(it)) }
        assertTrue(result.isBlocked(graph.edgesForWay(201L).first()))
        assertFalse(result.isBlocked(graph.edgesForWay(101L).first()))
        assertEquals("flood:1", result.blockingAreaContaining(p(1, 0))?.eventId)
    }

    @Test
    fun `HIGH landslide polygon multiplies cost by five`() {
        val result = overlay(event("landslide:1", "LANDSLIDE_RISK", square(p(1, 0), 0.0002), namespace = "official.ncdr", severity = "HIGH"))
        row0.forEach {
            assertFalse(result.isBlocked(it))
            assertEquals(5.0, result.penalty(it), 0.0)
        }
        assertNull(result.blockingAreaContaining(p(1, 0)))
    }

    @Test
    fun `area events outside the hazard allowlist are ignored`() {
        // County-sized NCDR heat warnings and shelter/medical polygons must not close streets.
        val result = overlay(
            event("heat:1", "HEAT_WARNING", square(p(1, 1), 0.01), namespace = "official.ncdr", severity = "CRITICAL"),
            event("shelter:1", "SHELTER_STATUS", square(p(1, 1), 0.01), namespace = "official.fire", severity = "CRITICAL"),
        )
        (0 until graph.edgeCount).forEach { assertFalse(result.isBlocked(it)) }
    }

    @Test
    fun `an unverified crowd report only doubles cost, never blocks`() {
        val result = overlay(
            event(
                "report:abcd1234:1",
                "CROWD_REPORT",
                point(p(1, 0)),
                namespace = "crowd.reports",
                severity = "CRITICAL",
                attributes = JSONObject().put("category", "ROAD_BLOCKAGE"),
            ),
        )
        row0.forEach {
            assertFalse(result.isBlocked(it))
            assertEquals(2.0, result.penalty(it), 0.0)
            assertEquals(EdgeEffect.Kind.UNVERIFIED, result.effects(it).single().kind)
        }
        assertEquals(2.0, result.penalty(graph.edgesForWay(201L).first()), 0.0)
        assertEquals(1.0, result.penalty(graph.edgesForWay(102L).first()), 0.0)
    }

    @Test
    fun `rescue requests never weight the route`() {
        // Same setup as the crowd report penalty test above, but a rescue point.
        val result = overlay(
            event(
                "rescue:abcd1234:1",
                "RESCUE_REQUEST",
                point(p(1, 0)),
                namespace = "crowd.rescue",
                severity = "CRITICAL",
                attributes = JSONObject().put("request_type", "TRAPPED_DEBRIS"),
            ),
        )
        row0.forEach {
            assertFalse(result.isBlocked(it))
            assertEquals(1.0, result.penalty(it), 0.0)
            assertTrue(result.effects(it).isEmpty())
        }
    }

    @Test
    fun `a crowd event claiming CLOSED is still only a penalty`() {
        val result = overlay(
            event("road:w100-crowd", "ROAD_STATUS", RoutingTestSupport.line(p(0, 0), p(2, 0)), namespace = "crowd.road", attributes = JSONObject().put("status", "CLOSED")),
        )
        row0.forEach { assertFalse(result.isBlocked(it)) }
    }

    @Test
    fun `expired events are ignored and counted in a warning`() {
        val result = overlay(roadStatus(100L, "CLOSED", expiresAt = "2026-09-24T00:30:00Z"))
        row0.forEach { assertFalse(result.isBlocked(it)) }
        assertEquals("EXPIRED_EVENTS_IGNORED", result.warnings.single().code)
        assertTrue(result.warnings.single().message.contains("1 筆"))
    }

    @Test
    fun `a road status that matches no way is a warning, not an error`() {
        val unmatched = event("road:dahu-01", "ROAD_STATUS", RoutingTestSupport.line(p(0, 0), p(1, 0)), attributes = JSONObject().put("status", "CLOSED"))
        val result = overlay(unmatched, roadStatus(999_999L, "CLOSED"))
        assertEquals(listOf("ROAD_STATUS_UNMATCHED", "ROAD_STATUS_UNMATCHED"), result.warnings.map { it.code })
        (0 until graph.edgeCount).forEach { assertFalse(result.isBlocked(it)) }
    }

    @Test
    fun `way ids parse from both id formats`() {
        assertEquals(23766392L, HazardOverlay.wayIdOf("w23766392-chenggong-rd"))
        assertEquals(23241824L, HazardOverlay.wayIdOf("road:w23241824-way23241824"))
        assertEquals(42L, HazardOverlay.wayIdOf("road:w42"))
        assertNull(HazardOverlay.wayIdOf("road:dahu-01"))
        assertNull(HazardOverlay.wayIdOf("road:awful-w12"))
    }

    @Test
    fun `blocked wins and penalties take the maximum, not the product`() {
        val result = overlay(
            roadStatus(100L, "PARTIAL"),
            event("landslide:1", "LANDSLIDE_RISK", square(p(1, 0), 0.0002), namespace = "official.ncdr", severity = "HIGH"),
            event("report:x:1", "CROWD_REPORT", point(p(1, 0)), namespace = "crowd.reports"),
        )
        row0.forEach { assertEquals(5.0, result.penalty(it), 0.0) }
        val closed = overlay(roadStatus(100L, "CLOSED"), roadStatus(100L, "PARTIAL").copy(eventId = "road:w100-partial"))
        row0.forEach { assertTrue(closed.isBlocked(it)) }
    }
}
