package com.resilientgeo.mesh.transport

import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class NearbyReceiveQueueTest {
    @Test fun burstsBeyondTheOldCountLimitAreBufferedWithinTheByteBudget() {
        val queue = NearbyReceiveQueue(maxQueuedBytes = 1_000)
        repeat(20) { assertTrue(queue.offer("peer", ByteArray(50))) }
        assertFalse("the budget still bounds memory", queue.offer("peer", ByteArray(1)))
    }

    @Test fun consumedMessagesReleaseTheirBytesInOrder() = runTest {
        val queue = NearbyReceiveQueue(maxQueuedBytes = 100)
        assertTrue(queue.offer("a", ByteArray(60)))
        assertFalse(queue.offer("b", ByteArray(60)))
        val seen = mutableListOf<Pair<String, Int>>()
        val consumer = launch { queue.forEach { (peer, bytes) -> seen += peer to bytes.size } }
        testScheduler.runCurrent()
        assertTrue(queue.offer("b", ByteArray(60)))
        testScheduler.runCurrent()
        queue.close()
        consumer.join()
        assertEquals(listOf("a" to 60, "b" to 60), seen)
    }
}
