package com.resilientgeo.mesh.bridge

import com.resilientgeo.mesh.data.EventBridgeRow
import java.time.Instant
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class BridgeEventStreamTest {

    @Test
    fun `first snapshot is immediate and a burst collapses to its latest snapshot`() = runTest {
        val source = Channel<Int>(Channel.UNLIMITED)
        val delivered = mutableListOf<Int>()
        val observation = backgroundScope.launch {
            source.receiveAsFlow().throttleLatest(250).collect { delivered += it }
        }

        source.send(0)
        runCurrent()
        assertEquals(listOf(0), delivered)

        // Twenty chunk writes inside one throttle window.
        for (index in 1..20) {
            source.send(index)
            advanceTimeBy(10)
        }
        runCurrent()
        assertEquals(listOf(0), delivered)

        advanceTimeBy(250)
        runCurrent()
        assertEquals(0, delivered.first())
        assertEquals(20, delivered.last())
        assertEquals(true, delivered.size <= 3)
        observation.cancel()
    }

    @Test
    fun `isolated update after a quiet period is not delayed`() = runTest {
        val source = Channel<Int>(Channel.UNLIMITED)
        val delivered = mutableListOf<Int>()
        val observation = backgroundScope.launch {
            source.receiveAsFlow().throttleLatest(250).collect { delivered += it }
        }
        source.send(1)
        runCurrent()
        advanceTimeBy(1_000)
        source.send(2)
        runCurrent()
        assertEquals(listOf(1, 2), delivered)
        observation.cancel()
    }

    @Test
    fun `unchanged payloads are parsed once while apply state follows the clock`() {
        var parses = 0
        val cache = BridgeEventMessageCache { row ->
            parses += 1
            EventPayloadMapper.payloadMap(row)
        }
        val expiresAt = Instant.parse("2026-11-04T08:00:00Z")
        val road = row("road:1", """{"event_id":"road:1","severity":"HIGH"}""", expiresAt)
        val flood = row("flood:1", """{"event_id":"flood:1"}""", expiresAt)

        val first = cache.toMessages(listOf(road), Instant.parse("2026-11-04T07:00:00Z"))
        val second = cache.toMessages(listOf(road, flood), Instant.parse("2026-11-04T08:00:00Z"))

        assertEquals(2, parses)
        assertEquals("CURRENT", first.single()["apply_state"])
        assertEquals("EXPIRED", second[0]["apply_state"])
        assertEquals("HIGH", second[0]["severity"])
        assertNotSame(first.single(), second[0])
        assertEquals(EventPayloadMapper.toMessage(flood, Instant.parse("2026-11-04T08:00:00Z")), second[1])
    }

    @Test
    fun `a rewritten payload with the same identity is parsed again`() {
        var parses = 0
        val cache = BridgeEventMessageCache { row ->
            parses += 1
            EventPayloadMapper.payloadMap(row)
        }
        val now = Instant.parse("2026-11-04T07:00:00Z")
        val expiresAt = now.plusSeconds(3_600)
        cache.toMessages(listOf(row("road:1", """{"severity":"LOW"}""", expiresAt)), now)
        val updated = cache.toMessages(listOf(row("road:1", """{"severity":"HIGH"}""", expiresAt)), now)

        assertEquals(2, parses)
        assertEquals("HIGH", updated.single()["severity"])
    }

    private fun row(eventId: String, payload: String, expiresAt: Instant) = EventBridgeRow(
        namespace = "official.tdx",
        eventId = eventId,
        eventVersion = 1,
        eventType = "ROAD_CLOSED",
        severity = "HIGH",
        expiresAt = expiresAt.toString(),
        applyState = "CURRENT",
        bridgePayloadJson = payload,
        ncdrCategoryCode = null,
    )
}
