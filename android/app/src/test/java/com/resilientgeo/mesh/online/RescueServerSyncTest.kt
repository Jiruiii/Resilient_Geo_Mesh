package com.resilientgeo.mesh.online

import com.resilientgeo.mesh.trust.RescueFixtures
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.IOException

class RescueServerSyncTest {
    private class MemoryStates : RescueUploadStates {
        val map = mutableMapOf<String, RescueUploadState>()
        override fun get(eventId: String) = map[eventId]
        override fun put(eventId: String, state: RescueUploadState) { map[eventId] = state }
    }

    private class FakeHttp(private val respond: (String) -> RescueHttpResponse) : RescueHttp {
        val posts = mutableListOf<Pair<String, String>>()
        val gets = mutableListOf<String>()
        override suspend fun post(url: String, json: String): RescueHttpResponse { posts += url to json; return respond(url) }
        override suspend fun get(url: String): RescueHttpResponse { gets += url; return respond(url) }
    }

    private val chunk = RescueFixtures.cases("chunk_cases").first().getJSONObject("chunk")
    private val eventId = chunk.getJSONArray("events").getJSONObject(0).getString("event_id")

    @Test
    fun `accepted uploads are remembered per version and not repeated`() = runBlocking {
        val states = MemoryStates()
        val http = FakeHttp { RescueHttpResponse(201, """{"result":"accepted"}""") }
        val sync = RescueServerSync(http, states)
        sync.upload("https://map.example.test/", listOf(chunk))
        sync.upload("https://map.example.test/", listOf(chunk))
        assertEquals(1, http.posts.size)
        assertEquals("https://map.example.test/v1/crowd/rescue-events", http.posts.single().first)
        assertEquals(chunk.getString("chunk_id"), JSONObject(http.posts.single().second).getString("chunk_id"))
        assertEquals(RescueUploadState(1, "ACCEPTED", null), states.get(eventId))
    }

    @Test
    fun `rejections keep the reason and transient failures stay waiting`() = runBlocking {
        val rejected = MemoryStates()
        RescueServerSync(FakeHttp { RescueHttpResponse(409, """{"error":"rejected","reason":"rescue_active_exists"}""") }, rejected)
            .upload("https://map.example.test/", listOf(chunk))
        assertEquals(RescueUploadState(1, "REJECTED", "rescue_active_exists"), rejected.get(eventId))

        val limited = MemoryStates()
        RescueServerSync(FakeHttp { RescueHttpResponse(429, "{}") }, limited).upload("https://map.example.test/", listOf(chunk))
        assertEquals("rate_limited", limited.get(eventId)!!.reason)

        val offline = MemoryStates()
        RescueServerSync(FakeHttp { throw IOException("offline") }, offline).upload("https://map.example.test/", listOf(chunk))
        assertEquals(RescueUploadState(1, "WAITING_UPLOAD", "network_unavailable"), offline.get(eventId))
    }

    @Test
    fun `download ingests only crowd-rescue chunks and counts what was stored`() = runBlocking {
        val body = JSONObject().put("chunks", JSONArray().put(chunk).put(JSONObject().put("dataset_id", "crowd-reports")))
        val http = FakeHttp { RescueHttpResponse(200, body.toString()) }
        val ingested = mutableListOf<String>()
        val count = RescueServerSync(http, MemoryStates()).download(
            "https://map.example.test/",
            listOf(121.57, 25.05, 121.6, 25.08),
        ) { ingested += it.getString("chunk_id"); true }
        assertEquals(1, count)
        assertEquals(listOf(chunk.getString("chunk_id")), ingested)
        assertEquals("https://map.example.test/v1/crowd/rescue-events?bbox=121.57%2C25.05%2C121.6%2C25.08", http.gets.single())
    }
}
