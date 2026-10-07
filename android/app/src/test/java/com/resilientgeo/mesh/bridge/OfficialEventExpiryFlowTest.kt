package com.resilientgeo.mesh.bridge

import com.resilientgeo.mesh.data.EventEntity
import java.time.Instant
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class OfficialEventExpiryFlowTest {

    @Test
    fun `unchanged rows are not re-emitted at the expiry recheck cadence`() = runTest {
        val startedAt = Instant.parse("2026-10-04T12:00:00Z")
        var now = startedAt
        val event = EventEntity(
            namespace = "official.ncdr",
            eventId = "ncdr:future-alert",
            eventVersion = 1,
            eventType = "NCDR_HAZARD",
            severity = "HIGH",
            expiresAt = startedAt.plusSeconds(300).toString(),
            applyState = "CURRENT",
            eventJson = """{"event_id":"ncdr:future-alert"}""",
            storedAtEpochMillis = startedAt.toEpochMilli(),
        )
        val rows = MutableStateFlow(listOf(event))
        val purgedAt = mutableListOf<Instant>()
        val observedRows = mutableListOf<List<EventEntity>>()

        val observation = backgroundScope.launch {
            rowsWithOfficialExpiryPurge(
                source = rows,
                now = { now },
                purgeExpired = { instant ->
                    purgedAt += instant
                    0
                },
            ).collect { observedRows += it }
        }

        runCurrent()
        now = startedAt.plusSeconds(30)
        advanceTimeBy(30_000)
        runCurrent()
        now = startedAt.plusSeconds(60)
        advanceTimeBy(30_000)
        runCurrent()

        assertEquals(listOf(listOf(event)), observedRows)
        assertEquals(3, purgedAt.size)
        observation.cancel()
    }

    @Test
    fun `official event payload is purged at expiry and the empty update is emitted`() = runTest {
        val startedAt = Instant.parse("2026-10-04T12:00:00Z")
        val expiresAt = startedAt.plusSeconds(1)
        var now = startedAt
        val event = EventEntity(
            namespace = "official.ncdr",
            eventId = "ncdr:expiring-alert",
            eventVersion = 4,
            eventType = "NCDR_HAZARD",
            severity = "HIGH",
            expiresAt = expiresAt.toString(),
            applyState = "CURRENT",
            eventJson = """{"event_id":"ncdr:expiring-alert"}""",
            storedAtEpochMillis = startedAt.toEpochMilli(),
        )
        val rows = MutableStateFlow(listOf(event))
        val purgedAt = mutableListOf<Instant>()
        val observedRows = mutableListOf<List<EventEntity>>()

        val observation = backgroundScope.launch {
            rowsWithOfficialExpiryPurge(
                source = rows,
                now = { now },
                purgeExpired = { instant ->
                    purgedAt += instant
                    val expired = rows.value.filter {
                        it.namespace.startsWith("official.") &&
                            Instant.parse(it.expiresAt) <= instant
                    }
                    if (expired.isNotEmpty()) rows.value = rows.value - expired.toSet()
                    expired.size
                },
            ).collect { observedRows += it }
        }

        runCurrent()
        assertEquals(listOf(listOf(event)), observedRows)
        assertEquals(startedAt, purgedAt.last())

        now = expiresAt.minusMillis(1)
        advanceTimeBy(999)
        runCurrent()
        assertEquals(listOf(event), rows.value)

        now = expiresAt
        advanceTimeBy(1)
        runCurrent()

        assertTrue(rows.value.isEmpty())
        assertEquals(listOf(listOf(event), emptyList<EventEntity>()), observedRows)
        assertEquals(expiresAt, purgedAt.last())
        observation.cancel()
    }
}
