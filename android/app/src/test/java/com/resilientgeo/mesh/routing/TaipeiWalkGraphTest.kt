package com.resilientgeo.mesh.routing

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import kotlin.math.roundToInt

/** Contract and real-data coverage tests for the shipped regional graph. */
class TaipeiWalkGraphTest {
    private val graph by lazy {
        val started = System.nanoTime()
        RoadGraph.fromPrebuilt(File("src/main/assets/routing/taipei-walk.rgmz").inputStream()).also {
            println("Taipei graph: ${it.nodeCount} nodes, ${it.edgeCount} edges, load ${(System.nanoTime()-started)/1e6} ms (JVM)")
        }
    }

    @Test fun `prebuilt graph matches manifest and spatial index matches a full scan`() {
        val manifest = JSONObject(File("src/main/assets/routing/taipei-walk.rgm.manifest.json").readText())
        assertEquals(manifest.getInt("nodes"), graph.nodeCount)
        assertEquals(manifest.getInt("edges"), graph.edgeCount)
        assertEquals(manifest.getString("graph_version"), graph.graphVersion)
        for (point in listOf(LonLat(121.517,25.047), LonLat(121.462,25.014), LonLat(121.443,25.167))) {
            val box = BBox(point.lon-.002,point.lat-.002,point.lon+.002,point.lat+.002)
            assertArrayEquals((0 until graph.edgeCount).filter { graph.edgeBBox(it).intersects(box) }.toIntArray(), graph.edgesNear(box))
        }
    }

    @Test fun `every Taipei and New Taipei district has a connected shelter and route`() {
        // This historical snapshot is test input only; production layers are downloaded and verified.
        val features = JSONObject(File("../../flutter/test/fixtures/static-features-legacy.json").readText()).getJSONArray("features")
        val districts = linkedMapOf<String, MutableList<LonLat>>()
        for (i in 0 until features.length()) {
            val f = features.getJSONObject(i)
            if (f.optString("kind") != "shelter" || f.optString("county_code") !in setOf("63000", "65000")) continue
            val coords = f.getJSONObject("geometry").getJSONArray("coordinates")
            districts.getOrPut(f.getString("town_code")) { mutableListOf() }.add(LonLat(coords.getDouble(0),coords.getDouble(1)))
        }
        assertEquals("All 12 Taipei + 29 New Taipei districts", 41, districts.size)
        val overlay = HazardOverlay.empty(graph)
        for ((district, shelters) in districts) {
            val shelter = shelters.firstOrNull { p -> graph.nearestNode(p, 100.0)?.let(graph::isInMainNetwork) == true }
            assertNotNull("No connected shelter in $district", shelter)
            val target = graph.nearestNode(shelter!!,100.0)!!
            // A start ~500 m away tests actual connected routes, not a zero-hop snap.
            val near = graph.nearestNode(LonLat(shelter.lon+.004,shelter.lat),600.0)!!
            val started = System.nanoTime()
            val result = EvacuationRouter.plan(graph,overlay,graph.node(near),shelter,
                ShelterState(ShelterState.Availability.UNKNOWN,null),"2026-09-25T00:00:00Z")
            val elapsed = (System.nanoTime()-started)/1e6
            println("District $district: ${result.status.wire}, ${result.distanceM?.roundToInt()} m, $elapsed ms")
            assertEquals(district,RouteStatus.OK,result.status)
            assertEquals(target,graph.nearestNode(result.polyline.last(),100.0))
            assertTrue("$district exceeded 2 s on JVM",elapsed < 2000)
        }
    }

    @Test fun `pedestrian directed edges forbid a reverse traversal and preserve geometry crossings`() {
        val tiny = RoadGraph.fromPrebuilt(File("src/test/resources/fixtures/routing/prebuilt-walk.rgm.gz").inputStream())
        assertNotNull(EvacuationRouter.shortestPath(tiny,0,1) { tiny.edgeLengthMeters(it) })
        assertNull(EvacuationRouter.shortestPath(tiny,1,0) { tiny.edgeLengthMeters(it) })
        assertNull(EvacuationRouter.shortestPath(tiny,0,2) { tiny.edgeLengthMeters(it) })
    }
}
