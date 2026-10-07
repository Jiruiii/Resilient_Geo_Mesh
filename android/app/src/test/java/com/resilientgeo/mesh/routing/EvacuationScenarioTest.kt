package com.resilientgeo.mesh.routing

import com.resilientgeo.mesh.protocol.ChunkVerifier
import com.resilientgeo.mesh.trust.TestFixtures
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.Instant

/**
 * Replays data/fixtures/neihu/evacuation-scenario.json the way a phone would:
 * signed chunks arrive, pass ChunkVerifier, their events join the snapshot, and
 * the recommendation (lowest Android route distance, as Flutter ranks it)
 * changes. See pipeline/tools/generate-evacuation-scenario.mjs.
 */
class EvacuationScenarioTest {
    private val now = Instant.parse("2026-09-26T09:00:00Z")
    private val scenario = JSONObject(File("../../data/fixtures/neihu/evacuation-scenario.json").readText())
    private val origin = scenario.getJSONObject("origin").let { LonLat(it.getDouble("lon"), it.getDouble("lat")) }
    private val graph = RoutingTestSupport.realGraph()

    /** Small route fixture: production shelter data is downloaded and cached by MeshRepository. */
    private val shelters = mapOf(
        "西湖國小" to ("shelter:5582" to LonLat(121.5657, 25.0838)),
        "西湖國中" to ("shelter:5593" to LonLat(121.5657, 25.0858)),
    )

    private fun chunkEvents(name: String): List<String> {
        val text = checkNotNull(javaClass.classLoader?.getResourceAsStream("fixtures/evacuation-scenario/$name")) {
            "missing fixtures/evacuation-scenario/$name"
        }.bufferedReader().use { it.readText() }
        val verified = ChunkVerifier.verify(JSONObject(text), TestFixtures.trustedKeyStore(), now)
        assertTrue("$name must verify against the bundled trust store: $verified", verified is ChunkVerifier.Result.Valid)
        return (verified as ChunkVerifier.Result.Valid).events.map { it.toString() }
    }

    private suspend fun routes(events: List<String>): Map<String, RouteResult> {
        val service = EvacuationRouteService({ graph }, { events }, { now })
        return shelters.mapValues { (_, shelter) -> service.calculate(RouteRequest(origin, shelter.first, shelter.second, "walk")) }
            .also { results ->
                println(results.entries.joinToString { (name, r) -> "$name=${r.status.wire}/${r.distanceM?.toInt()}/${r.warnings.firstOrNull()?.code}" })
            }
    }

    private fun recommended(results: Map<String, RouteResult>): String =
        results.filterValues { it.status == RouteStatus.OK }
            .minWithOrNull(compareBy({ it.value.distanceM!! }, { it.key }))!!.key

    @Test
    fun `mesh events reroute and then redirect the evacuation`() = runTest {
        val closure = chunkEvents("step2-road-closed.json")
        val shelterFull = chunkEvents("step3-shelter-full.json")
        val closureId = JSONObject(closure.single()).getString("event_id")

        assertTrue(shelters.keys.containsAll(listOf("西湖國小", "西湖國中")))
        assertEquals("shelter:5582", shelters.getValue("西湖國小").first)

        val step1 = routes(emptyList())
        assertEquals("西湖國小", recommended(step1))
        val baseline = step1.getValue("西湖國小")
        assertTrue(baseline.distanceM!! in 300.0..450.0)

        val step2 = routes(closure)
        assertEquals("西湖國小", recommended(step2))
        val rerouted = step2.getValue("西湖國小")
        assertTrue("detour should be longer", rerouted.distanceM!! > baseline.distanceM!! + 50)
        assertEquals(listOf(closureId), rerouted.blockedEventIds)
        assertTrue(rerouted.polyline != baseline.polyline)

        val step3 = routes(closure + shelterFull)
        assertEquals(RouteStatus.NO_ROUTE, step3.getValue("西湖國小").status)
        assertEquals("SHELTER_FULL", step3.getValue("西湖國小").warnings.first().code)
        assertEquals("西湖國中", recommended(step3))
    }
}
