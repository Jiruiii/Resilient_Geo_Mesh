package com.resilientgeo.mesh.routing

import com.resilientgeo.mesh.trust.TestFixtures
import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.Instant
import kotlin.math.round

class EvacuationRouteServiceTest {
    private val now = Instant.parse("2026-09-24T01:00:00Z")
    private val shelter = LonLat(121.5908, 25.0609) // shelter:5427 潭美國小

    private fun service(
        events: List<String> = emptyList(),
        loader: () -> RoadGraph = RoutingTestSupport::grid,
    ) = EvacuationRouteService(loader, { events }, { now })

    private fun request(origin: LonLat, destination: LonLat = RoutingTestSupport.p(2, 0), mode: String = "walk") =
        RouteRequest(origin, "shelter:test", destination, mode)

    @Test
    fun `disaster selection rejects incompatible shelters and marks unknown ones`() = runTest {
        val point = RoutingTestSupport.p(2, 0)
        val catalog = ShelterDisasterCatalog(mapOf("shelter:test" to ShelterDisasterCatalog.Entry(point, setOf("震災"))))
        var graphLoads = 0
        val service = EvacuationRouteService({ graphLoads++; RoutingTestSupport.grid() }, { emptyList() }, { now }, { catalog })
        val base = request(RoutingTestSupport.p(0, 0))
        val mismatch = service.calculate(base.copy(disasterType = "flood"))
        assertEquals(RouteStatus.NO_ROUTE, mismatch.status)
        assertEquals("SHELTER_DISASTER_MISMATCH", mismatch.warnings.single().code)
        assertEquals(0, graphLoads)
        assertEquals(RouteStatus.OK, service.calculate(base.copy(disasterType = "earthquake")).status)
        val unknown = service.calculate(base.copy(destinationId = "shelter:unknown", disasterType = "flood"))
        assertEquals(RouteStatus.OK, unknown.status)
        assertTrue(unknown.warnings.any { it.code == "SHELTER_DISASTER_UNKNOWN" })
        assertEquals(RouteStatus.INVALID_INPUT, service.calculate(base.copy(disasterType = "invented")).status)
        assertEquals(RouteStatus.INVALID_INPUT, service.calculate(base.copy(destination = RoutingTestSupport.p(0, 2), disasterType = "earthquake")).status)
    }

    @Test
    fun `walking destinations skip the shelter disaster catalog`() = runTest {
        val point = RoutingTestSupport.p(2, 0)
        val catalog = ShelterDisasterCatalog(mapOf("shelter:test" to ShelterDisasterCatalog.Entry(point, setOf("震災"))))
        var catalogLoads = 0
        val service = EvacuationRouteService(RoutingTestSupport::grid, { emptyList() }, { now }, { catalogLoads++; catalog })
        for (kind in listOf(RouteDestinationKind.MEDICAL, RouteDestinationKind.SUPPLY)) {
            val result = service.calculate(
                request(RoutingTestSupport.p(0, 0)).copy(destinationKind = kind, disasterType = "flood"),
            )
            assertEquals(RouteStatus.OK, result.status)
            assertTrue(result.warnings.none { it.code.startsWith("SHELTER_") })
        }
        assertEquals(0, catalogLoads)
    }

    @Test
    fun `invalid input is a status, not an exception`() = runTest {
        assertEquals(RouteStatus.INVALID_INPUT, service().calculate(request(LonLat(Double.NaN, 25.0))).status)
        assertEquals(RouteStatus.INVALID_INPUT, service().calculate(request(RoutingTestSupport.p(0, 0), mode = "drive")).status)
        assertEquals(
            RouteStatus.INVALID_INPUT,
            service().calculate(RouteRequest(RoutingTestSupport.p(0, 0), " ", RoutingTestSupport.p(2, 0), "walk")).status,
        )
    }

    @Test
    fun `a missing graph asset is graph_unavailable`() = runTest {
        val result = service(loader = { error("asset missing") }).calculate(request(RoutingTestSupport.p(0, 0)))
        assertEquals(RouteStatus.GRAPH_UNAVAILABLE, result.status)
        assertTrue(result.polyline.isEmpty())
    }

    @Test
    fun `snapshot time is the newest issue time of events still in force`() = runTest {
        val events = listOf(
            eventJson("road:w100-a", "2026-09-23T10:00:00Z", "2099-01-01T00:00:00Z"),
            eventJson("road:w100-b", "2026-09-23T12:00:00Z", "2099-01-01T00:00:00Z"),
            eventJson("road:w100-old", "2026-09-23T23:00:00Z", "2026-09-24T00:00:00Z"),
        )
        val result = service(events).calculate(request(RoutingTestSupport.p(0, 0)))
        assertEquals("2026-09-23T12:00:00Z", result.eventSnapshotAt)
        assertEquals("2026-09-24T01:00:00Z", service().calculate(request(RoutingTestSupport.p(0, 0))).eventSnapshotAt)
    }

    @Test
    fun `new events change the route between two calls`() = runTest {
        val events = mutableListOf<String>()
        val service = EvacuationRouteService(RoutingTestSupport::grid, { events.toList() }, { now })
        val before = service.calculate(request(RoutingTestSupport.p(0, 0)))
        events += eventJson("road:w100-closed", "2026-09-24T00:00:00Z", "2099-01-01T00:00:00Z")
        val after = service.calculate(request(RoutingTestSupport.p(0, 0)))
        assertEquals(3, before.polyline.size)
        assertEquals(5, after.polyline.size)
        assertEquals(listOf("road:w100-closed"), after.blockedEventIds)
    }

    @Test
    fun `an unchanged stored closure stops blocking after expiry`() = runTest {
        var clock = now
        val events = mutableListOf<String>()
        val service = EvacuationRouteService(RoutingTestSupport::grid, { events.toList() }, { clock })
        val request = request(RoutingTestSupport.p(0, 0))
        val original = service.calculate(request)
        events += eventJson("road:w100-expiring", now.toString(), now.plusSeconds(5).toString())
        val detour = service.calculate(request)
        assertEquals(5, detour.polyline.size)
        assertEquals(listOf("road:w100-expiring"), detour.blockedEventIds)
        clock = now.plusSeconds(5)
        val expired = service.calculate(request)
        assertEquals(original.polyline, expired.polyline)
        assertTrue(expired.blockedEventIds.isEmpty())
        events.clear()
        val removed = service.calculate(request)
        assertEquals(original.polyline, removed.polyline)
        assertEquals(original.warnings, removed.warnings)
    }

    /**
     * One origin per Neihu living area, with no events and with the bundled
     * signed demo events (whose CRITICAL flood polygon covers most of central
     * Neihu). Results are pinned in a golden file so a later change cannot
     * silently reroute people. Regenerate deliberately with
     * `ROUTING_UPDATE_GOLDEN=1 ./gradlew :app:testDebugUnitTest --tests '*EvacuationRouteServiceTest*'`.
     */
    @Test
    fun `real Neihu network matches the golden routes`() = runTest {
        val graph = RoutingTestSupport.realGraph()
        val demoEvents = TestFixtures.signedEvents().let { array -> (0 until array.length()).map { array.getJSONObject(it).toString() } }
        val origins = linkedMapOf(
            "xihu" to LonLat(121.5673, 25.0819),
            "neihu" to LonLat(121.5880, 25.0830),
            "wende" to LonLat(121.5850, 25.0785),
            "dahu" to LonLat(121.6025, 25.0838),
            "donghu" to LonLat(121.6160, 25.0694),
        )
        val actual = JSONObject()
        for ((scenario, events) in linkedMapOf("no_events" to emptyList(), "demo_events" to demoEvents)) {
            val service = EvacuationRouteService({ graph }, { events }, { now })
            val results = JSONObject()
            for ((area, origin) in origins) {
                val request = RouteRequest(origin, "shelter:5427", shelter, "walk")
                service.calculate(request) // warm-up: overlay cache and JIT
                val started = System.nanoTime()
                val result = service.calculate(request)
                val elapsedMs = (System.nanoTime() - started) / 1_000_000
                println("$scenario $area -> shelter:5427: ${result.status.wire} ${result.distanceM?.let { round(it) }} m in $elapsedMs ms (JVM)")
                assertTrue("$area took $elapsedMs ms", elapsedMs < 2_000)
                if (scenario == "no_events") assertEquals(area, RouteStatus.OK, result.status)
                assertEquals(result.status == RouteStatus.OK, result.polyline.size >= 2)
                results.put(
                    area,
                    JSONObject()
                        .put("status", result.status.wire)
                        .put("distance_m", result.distanceM?.let { round(it * 10) / 10 } ?: JSONObject.NULL)
                        .put("points", result.polyline.size)
                        .put("warnings", JSONArray(result.warnings.map { it.code }))
                        .put("blocked_event_ids", JSONArray(result.blockedEventIds)),
                )
            }
            actual.put(scenario, results)
        }
        val golden = File("src/test/resources/fixtures/routing/neihu-golden.json")
        if (System.getenv("ROUTING_UPDATE_GOLDEN") == "1" || !golden.exists()) {
            golden.parentFile.mkdirs()
            golden.writeText(actual.toString(2) + "\n")
        }
        assertEquals(JSONObject(golden.readText()).toString(2), actual.toString(2))
    }

    private fun eventJson(eventId: String, issuedAt: String, expiresAt: String) = JSONObject()
        .put("namespace", "official.tdx")
        .put("event_id", eventId)
        .put("event_version", 1)
        .put("event_type", "ROAD_STATUS")
        .put("severity", "HIGH")
        .put("issued_at", issuedAt)
        .put("expires_at", expiresAt)
        .put("geometry", RoutingTestSupport.line(RoutingTestSupport.p(0, 0), RoutingTestSupport.p(1, 0)))
        .put("attributes", JSONObject().put("status", "CLOSED"))
        .toString()
}
