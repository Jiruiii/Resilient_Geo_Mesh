package com.resilientgeo.mesh.transport

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.nio.ByteBuffer

class NearbyFramingTest {
    @Test fun largeInventoriesAreReassembledWithoutEarlyDelivery() {
        val message = ByteArray(1024 * 1024) { (it % 251).toByte() }
        val frames = NearbyFraming.encode(12, message)
        val receiver = NearbyFraming.Receiver()
        frames.dropLast(1).forEach { assertNull(receiver.accept(it, 100)) }
        assertArrayEquals(message, receiver.accept(frames.last(), 101))
        assertTrue(frames.all { it.size < 32 * 1024 })
    }

    @Test fun truncationOutOfOrderAndOversizeNeverProduceAMessage() {
        val frames = NearbyFraming.encode(1, ByteArray(50_000))
        val receiver = NearbyFraming.Receiver()
        assertThrows(IOException::class.java) { receiver.accept(frames[1], 0) }
        assertNull(receiver.accept(frames[0], 1))
        assertThrows(IOException::class.java) { receiver.accept(frames[2], 2) }
        val malicious = frames[0].clone()
        ByteBuffer.wrap(malicious).putInt(12, Int.MAX_VALUE)
        assertThrows(IOException::class.java) { receiver.accept(malicious, 3) }
        assertThrows(IOException::class.java) { receiver.accept(byteArrayOf(1), 4) }
    }

    @Test fun expiredOrDisconnectedTransfersMustRestartFromZero() {
        val message = ByteArray(50_000) { 42 }
        val frames = NearbyFraming.encode(2, message)
        val receiver = NearbyFraming.Receiver()
        receiver.accept(frames[0], 0)
        assertThrows(IOException::class.java) { receiver.accept(frames[1], 30_001) }
        receiver.accept(frames[0], 40_000)
        receiver.clear()
        assertThrows(IOException::class.java) { receiver.accept(frames[1], 40_001) }
        var result: ByteArray? = null
        frames.forEach { result = receiver.accept(it, 50_000) }
        assertArrayEquals(message, result)
    }

    @Test fun interleavedPeersCannotCorruptEachOther() {
        val a = NearbyFraming.Receiver()
        val b = NearbyFraming.Receiver()
        val dataA = ByteArray(30_000) { 3 }
        val dataB = ByteArray(30_000) { 7 }
        val framesA = NearbyFraming.encode(1, dataA)
        val framesB = NearbyFraming.encode(1, dataB)
        a.accept(framesA[0], 0); b.accept(framesB[0], 0)
        assertArrayEquals(dataB, b.accept(framesB[1], 1))
        assertArrayEquals(dataA, a.accept(framesA[1], 1))
    }
}
