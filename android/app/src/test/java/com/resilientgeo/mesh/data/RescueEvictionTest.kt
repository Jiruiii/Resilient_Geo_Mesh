package com.resilientgeo.mesh.data

import org.junit.Assert.assertEquals
import org.junit.Test

class RescueEvictionTest {
    private fun candidate(id: String, status: String, severity: String, at: Long) = RescueCandidate(id, status, severity, at)

    @Test
    fun `terminal requests go first, then the least urgent and oldest`() {
        val candidates = listOf(
            candidate("critical-old", "ACTIVE", "CRITICAL", 1),
            candidate("medium-new", "ACTIVE", "MEDIUM", 5),
            candidate("resolved", "RESOLVED", "CRITICAL", 9),
            candidate("medium-old", "ACTIVE", "MEDIUM", 2),
            candidate("high", "ACTIVE", "HIGH", 3),
        )
        assertEquals(
            listOf("resolved", "medium-old", "medium-new"),
            rescueEvictionOrder(candidates, keep = 2).map { it.chunkId },
        )
    }

    @Test
    fun `nothing is evicted under the cap`() {
        assertEquals(emptyList<RescueCandidate>(), rescueEvictionOrder(listOf(candidate("a", "ACTIVE", "MEDIUM", 1)), keep = 300))
    }
}
