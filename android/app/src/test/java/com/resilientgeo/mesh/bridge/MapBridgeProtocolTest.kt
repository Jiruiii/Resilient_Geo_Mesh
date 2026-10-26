package com.resilientgeo.mesh.bridge

import com.resilientgeo.mesh.data.EventEntity
import com.resilientgeo.mesh.data.VerifiedStaticFeatureSnapshot
import com.resilientgeo.mesh.ingest.ApplyState
import com.resilientgeo.mesh.ingest.IngestResult
import com.resilientgeo.mesh.routing.LonLat
import com.resilientgeo.mesh.routing.RouteDestinationKind
import com.resilientgeo.mesh.routing.RouteResult
import com.resilientgeo.mesh.routing.RouteStatus
import com.resilientgeo.mesh.routing.RouteWarning
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MapBridgeProtocolTest {

    @Test
    fun `initial state reply carries mapped Room events and emergency state`() {
        val reply = MapBridgeProtocol.initialState(
            events = listOf(eventEntity()),
            emergencyModeEnabled = true,
        )

        assertEquals(true, reply["emergency_mode_enabled"])
        val events = reply["events"] as List<*>
        assertEquals(1, events.size)
        val event = events.single() as Map<*, *>
        assertEquals("official.tdx", event["namespace"])
        assertEquals("EXPIRED", event["apply_state"])
        assertEquals("ROAD_STATUS", event["event_type"])
    }

    @Test
    fun `event snapshot reply carries the complete mapped Room event`() {
        val reply = MapBridgeProtocol.eventSnapshot(listOf(eventEntity()))

        assertEquals(1, reply.size)
        assertEquals("official.tdx", reply.single()["namespace"])
        assertEquals("EXPIRED", reply.single()["apply_state"])
        assertEquals("OPEN", (reply.single()["attributes"] as Map<*, *>)["status"])
    }

    @Test
    fun `fixture reply reports processed inserted updated and rejected outcomes`() {
        val reply = MapBridgeProtocol.fixtureLoadSummary(
            listOf(
                IngestResult.Inserted(insertedIntoSeparateNamespace = false, state = ApplyState.CURRENT),
                IngestResult.Updated(fromVersion = 1, toVersion = 2, state = ApplyState.CURRENT),
                IngestResult.RejectedSameVersionConflict(
                    storedVersion = 2,
                    incomingVersion = 2,
                ),
            ),
        )

        assertEquals(3, reply["processed"])
        assertEquals(1, reply["inserted"])
        assertEquals(1, reply["updated"])
        assertEquals(1, reply["rejected"])
    }

    @Test
    fun `static features reply carries the verified list and snapshot time`() {
        val feature = mapOf<String, Any?>("id" to "shelter:5582", "kind" to "shelter", "address" to null)
        assertEquals(
            mapOf("static_features" to listOf(feature), "snapshot_at" to "2026-09-03T02:00:32Z"),
            MapBridgeProtocol.staticFeaturesResult(
                VerifiedStaticFeatureSnapshot(listOf(feature), "2026-09-03T02:00:32Z"),
            ),
        )
        val initial = MapBridgeProtocol.initialState(events = emptyList(), emergencyModeEnabled = false)
        assertEquals(emptyList<Any>(), initial["static_features"])
    }

    @Test
    fun `emergency reply exposes the enabled boolean`() {
        val reply = MapBridgeProtocol.emergencyModeResult(enabled = false)

        assertTrue(reply.containsKey("enabled"))
        assertEquals(false, reply["enabled"])
    }

    // The exact map Flutter's CrowdReportDraft.toChannelArguments() sends.
    private fun reportArguments(): MutableMap<String, Any?> = mutableMapOf(
        "category" to "ROAD_BLOCKAGE",
        "location" to mapOf("lon" to 121.590304, "lat" to 25.083506, "source" to "CURRENT_LOCATION"),
        "location_hint" to mapOf(
            "method" to "ADDRESS",
            "query" to "內湖區成功路",
            "label" to "成功路",
            "kind" to "ROAD",
            "precision" to "ROAD",
        ),
        "description" to "道路有落石，請注意通行安全",
    )

    @Test
    fun `crowd report arguments parse into form input only`() {
        val input = MapBridgeProtocol.crowdReportInput(reportArguments())!!
        assertEquals("ROAD_BLOCKAGE", input.category)
        assertEquals(121.590304, input.lon, 0.0)
        assertEquals("CURRENT_LOCATION", input.locationSource)
        assertEquals("ROAD", input.locationHint!!.kind)
        assertEquals("", MapBridgeProtocol.crowdReportInput(reportArguments().apply { remove("description"); remove("location_hint") })!!.description)
        // Integer coordinates from the codec are accepted as numbers.
        assertEquals(121.0, MapBridgeProtocol.crowdReportInput(reportArguments().apply { put("location", mapOf("lon" to 121, "lat" to 25, "source" to "MAP_PICK")) })!!.lon, 0.0)
    }

    @Test
    fun `malformed crowd report arguments are rejected before reaching the repository`() {
        assertNull(MapBridgeProtocol.crowdReportInput(null))
        assertNull(MapBridgeProtocol.crowdReportInput(reportArguments().apply { remove("category") }))
        assertNull(MapBridgeProtocol.crowdReportInput(reportArguments().apply { put("location", mapOf("lon" to "121", "lat" to 25.0, "source" to "MAP_PICK")) }))
        assertNull(MapBridgeProtocol.crowdReportInput(reportArguments().apply { put("description", 42) }))
        assertNull(MapBridgeProtocol.crowdReportInput(reportArguments().apply { put("location_hint", mapOf("method" to "ADDRESS")) }))
    }

    @Test
    fun `government warning request parses nationwide content expiry and optional point`() {
        val request = MapBridgeProtocol.governmentWarningRequest(mapOf(
            "event_id" to "announcement:device:test-1",
            "title" to "颱風警戒",
            "content" to "請留意官方資訊",
            "category" to "WEATHER",
            "severity" to "HIGH",
            "expires_at" to "2026-10-13T00:00:00Z",
            "affected_area_ids" to listOf("tw.63000050"),
            "longitude" to 121.5,
            "latitude" to 25.0,
        ))!!
        assertEquals("announcement:device:test-1", request.eventId)
        assertEquals("WEATHER", request.input.category)
        assertEquals(listOf("tw.63000050"), request.input.affectedAreaIds)
        assertEquals(121.5, request.input.location!!.longitude, 0.0)
        assertNull(MapBridgeProtocol.governmentWarningRequest(mapOf(
            "title" to "標題", "content" to "內容", "category" to "OTHER", "severity" to "LOW",
            "expires_at" to "2026-10-13T00:00:00Z", "affected_area_ids" to listOf("tw.63000", 42),
        )))
        assertNull(MapBridgeProtocol.governmentWarningRequest(mapOf(
            "title" to "標題", "content" to "內容", "category" to "OTHER", "severity" to "LOW",
            "expires_at" to "not-an-instant", "longitude" to 121.5,
        )))
    }

    @Test
    fun `government device bridge replies preserve certificate and upload identity fields`() {
        val auth = MapBridgeProtocol.governmentDeviceAuthorizationReply(org.json.JSONObject()
            .put("status", "AUTHORIZED")
            .put("signing_key_id", "device:key")
            .put("signer_public_key", "public")
            .put("certificate_json", "{\"signature\":\"signed\"}")
            .put("certificate_expires_at", "2026-10-19T00:00:00Z"))
        assertEquals("AUTHORIZED", auth["status"])
        assertEquals("{\"signature\":\"signed\"}", auth["certificate_json"])
        assertEquals(mapOf("event_id" to "announcement:1", "payload_hash" to "sha256:abc",
            "event_json" to "{}", "apply_state" to "CURRENT", "upload_state" to "PENDING", "duplicate" to false),
            MapBridgeProtocol.governmentWarningCreated("announcement:1", "sha256:abc", "{}", false))
    }

    @Test
    fun `crowd report reply carries exactly what Flutter accepts as success`() {
        val reply = MapBridgeProtocol.crowdReportCreated("report:abcd1234:uuid", "UNVERIFIED", "{\"signature\":\"signed\"}")
        assertEquals(mapOf("event_id" to "report:abcd1234:uuid", "apply_state" to "UNVERIFIED",
            "delivery_state" to "PENDING", "event_json" to "{\"signature\":\"signed\"}"), reply)
    }

    @Test
    fun `route request parses the contract and rejects malformed maps`() {
        val request = MapBridgeProtocol.routeRequest(
            mapOf(
                "origin" to mapOf("lon" to 121.590304, "lat" to 25.083506),
                "destination" to mapOf("id" to "shelter:5427", "lon" to 121.5908, "lat" to 25.0609),
                "mode" to "walk",
            ),
        )!!
        assertEquals(LonLat(121.590304, 25.083506), request.origin)
        assertEquals("shelter:5427", request.destinationId)
        assertEquals("walk", request.mode)
        assertNull(request.disasterType)
        val selected = mapOf("origin" to mapOf("lon" to 121.5, "lat" to 25.0), "destination" to mapOf("id" to "shelter:test", "lon" to 121.5, "lat" to 25.0), "disaster_type" to "flood")
        assertEquals("flood", MapBridgeProtocol.routeRequest(selected)!!.disasterType)
        assertNull(MapBridgeProtocol.routeRequest(selected + ("disaster_type" to 123)))
        assertNull(MapBridgeProtocol.routeRequest(mapOf("origin" to mapOf("lon" to 1.0))))
    }

    @Test
    fun `route request destination kind defaults to shelter and rejects unknown kinds`() {
        fun withKind(kind: Any?) = mapOf(
            "origin" to mapOf("lon" to 121.5, "lat" to 25.0),
            "destination" to buildMap<String, Any> {
                put("id", "medical:test")
                put("lon", 121.5)
                put("lat", 25.0)
                if (kind != null) put("kind", kind)
            },
        )
        assertEquals(RouteDestinationKind.SHELTER, MapBridgeProtocol.routeRequest(withKind(null))!!.destinationKind)
        assertEquals(RouteDestinationKind.SHELTER, MapBridgeProtocol.routeRequest(withKind("shelter"))!!.destinationKind)
        assertEquals(RouteDestinationKind.MEDICAL, MapBridgeProtocol.routeRequest(withKind("medical"))!!.destinationKind)
        assertEquals(RouteDestinationKind.SUPPLY, MapBridgeProtocol.routeRequest(withKind("supply"))!!.destinationKind)
        assertNull(MapBridgeProtocol.routeRequest(withKind("hospital")))
        assertNull(MapBridgeProtocol.routeRequest(withKind(1)))
    }

    @Test
    fun `route reply uses lon-lat pairs and the contract field names`() {
        val reply = MapBridgeProtocol.routeResult(
            RouteResult(
                status = RouteStatus.OK,
                polyline = listOf(LonLat(121.5, 25.0), LonLat(121.501, 25.0)),
                distanceM = 100.84,
                durationS = 100.84,
                graphVersion = "g1",
                eventSnapshotAt = "2026-09-24T00:00:00Z",
                warnings = listOf(RouteWarning("UNVERIFIED_CROWD_REPORT", "report:x", "路線經過未驗證回報路段，請現場確認")),
                blockedEventIds = listOf("road:w1-x"),
            ),
        )
        assertEquals("ok", reply["status"])
        assertEquals(listOf(listOf(121.5, 25.0), listOf(121.501, 25.0)), reply["polyline"])
        assertEquals(100.8, reply["distance_m"])
        assertEquals(101.0, reply["duration_s"])
        assertEquals("g1", reply["graph_version"])
        assertEquals(listOf(mapOf("code" to "UNVERIFIED_CROWD_REPORT", "event_id" to "report:x", "message" to "路線經過未驗證回報路段，請現場確認")), reply["warnings"])
        assertEquals(listOf("road:w1-x"), reply["blocked_event_ids"])

        val failure = MapBridgeProtocol.routeResult(RouteResult.failure(RouteStatus.NO_ROUTE, "2026-09-24T00:00:00Z"))
        assertEquals("no_route", failure["status"])
        assertEquals(emptyList<Any>(), failure["polyline"])
        assertNull(failure["distance_m"])
    }

    @Test
    fun `rescue request arguments are parsed into the contract input`() {
        val input = MapBridgeProtocol.rescueRequestInput(
            mapOf(
                "request_type" to "TRAPPED_DEBRIS",
                "subject" to "SELF",
                "people_count" to 2,
                "triage" to mapOf("immobile" to "YES", "breathing_difficulty" to "NO", "severe_bleeding" to "UNKNOWN", "conscious" to "YES"),
                "description" to "一樓樓梯間",
                "location" to mapOf("lon" to 121.5, "lat" to 25.0, "source" to "CURRENT_LOCATION"),
            ),
        )
        assertEquals("TRAPPED_DEBRIS", input!!.requestType)
        assertEquals(2, input.peopleCount)
        assertEquals("UNKNOWN", input.triage["severe_bleeding"])
        assertEquals(null, input.locationHint)
    }

    @Test
    fun `malformed rescue arguments are refused before reaching the repository`() {
        assertEquals(null, MapBridgeProtocol.rescueRequestInput(mapOf("request_type" to "TRAPPED")))
        assertEquals(null, MapBridgeProtocol.rescueRequestInput(mapOf(
            "request_type" to "TRAPPED", "subject" to "SELF", "people_count" to "2",
            "triage" to emptyMap<String, String>(), "description" to "",
            "location" to mapOf("lon" to 121.5, "lat" to 25.0, "source" to "MAP_PICK"),
        )))
    }

    @Test
    fun `rescue action parsing accepts only the four actions`() {
        assertEquals(com.resilientgeo.mesh.report.RescueAction.EXTEND, MapBridgeProtocol.rescueAction("EXTEND"))
        assertEquals(null, MapBridgeProtocol.rescueAction("DELETE"))
    }

    private fun eventEntity() = EventEntity(
        namespace = "official.tdx",
        eventId = "road:dahu-01",
        eventVersion = 2,
        eventType = "ROAD_STATUS",
        severity = "HIGH",
        expiresAt = "2026-09-01T07:00:00Z",
        applyState = "EXPIRED",
        eventJson = """
            {
              "namespace": "official.tdx",
              "event_id": "road:dahu-01",
              "event_version": 2,
              "event_type": "ROAD_STATUS",
              "severity": "HIGH",
              "geometry": {"type": "LineString", "coordinates": [[121.5993, 25.0825], [121.6053, 25.085]]},
              "attributes": {"status": "OPEN"}
            }
        """.trimIndent(),
        storedAtEpochMillis = 1_725_168_000_000,
    )
}
