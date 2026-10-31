package com.resilientgeo.mesh.measure

import com.resilientgeo.mesh.emergency.AutoPeerSyncEngine.Trace
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class MeasurementTrialTest {
    @Test fun `a successful trial records relative timing, bytes and rssi`() {
        val trial = MeasurementTrial(startedAt = 1_000)
        trial.on(Trace.PeerSeen("p", -60), 1_500)
        trial.on(Trace.PeerSeen("p", -70), 1_600)
        trial.on(Trace.PeerSeen("p", -50), 1_700)
        trial.on(Trace.Connecting("p"), 1_800)
        trial.on(Trace.Connected("p"), 2_000)
        trial.on(Trace.HelloReceived("p"), 2_100)
        trial.on(Trace.Requested("p", 2, 8_000), 2_200)
        trial.on(Trace.ChunkApplied("p", "c1", 4_000), 2_700)
        trial.on(Trace.ChunkApplied("p", "c2", 4_000), 3_200)
        assertFalse(trial.done)
        assertTrue(trial.on(Trace.SessionEnded("p", true, null), 3_300))

        val result = trial.result(now = 9_999)
        assertTrue(result.succeeded)
        assertNull(result.failureReason)
        assertEquals(500L, result.discoverMillis)
        assertEquals(1_000L, result.connectMillis)
        assertEquals(1_200L, result.requestMillis)
        assertEquals(1_700L, result.firstChunkMillis)
        assertEquals(2_300L, result.completeMillis)
        assertEquals(2_300L, result.elapsedMillis)
        assertEquals(2, result.appliedChunks)
        assertEquals(8_000L, result.receivedBytes)
        assertEquals(8_000L, result.bytesPerSecond)
        assertEquals(1, result.attempts)
        assertEquals(listOf(-70, -60, -50), listOf(result.rssiMin, result.rssiMedian, result.rssiMax))
    }

    @Test fun `failed sessions are retried and a timeout keeps the last failure code`() {
        val trial = MeasurementTrial(startedAt = 0)
        trial.on(Trace.Connecting("p"), 10)
        trial.on(Trace.SessionEnded("p", false, "connection_failed"), 20)
        trial.on(Trace.Connecting("p"), 30)
        trial.on(Trace.SessionEnded("p", false, "hello_timeout"), 40)
        val result = trial.result(now = 180_000, stopReason = "timeout")
        assertFalse(result.succeeded)
        assertEquals(2, result.attempts)
        assertEquals("timeout/hello_timeout", result.failureReason)
        assertEquals(180_000L, result.elapsedMillis)
        assertNull(result.bytesPerSecond)
    }

    @Test fun `an already synced peer completes with no chunks`() {
        val trial = MeasurementTrial(startedAt = 0)
        trial.on(Trace.Requested("p", 0, 0), 5)
        trial.on(Trace.SessionEnded("p", true, null), 9)
        val result = trial.result(now = 10)
        assertTrue(result.succeeded)
        assertEquals(0, result.appliedChunks)
        assertNull(result.bytesPerSecond)
    }

    @Test fun `stats use nearest rank and only successful trials`() {
        fun done(ms: Long) = MeasurementTrial(0).apply { on(Trace.SessionEnded("p", true, null), ms) }.result(ms)
        val failed = MeasurementTrial(0).result(5_000, "timeout")
        val stats = MeasurementStats.of(listOf(done(100), done(300), done(200), failed))
        assertEquals(4, stats.trials)
        assertEquals(3, stats.successes)
        assertEquals(200L, stats.completeP50Millis)
        assertEquals(300L, stats.completeP95Millis)
        assertNull(MeasurementStats.percentile(emptyList(), 0.5))
    }

    @Test fun `csv escapes and writes the header once`() {
        assertEquals("a,\"b,c\",\"say \"\"hi\"\"\",", MeasurementCsv.row(listOf("a", "b,c", "say \"hi\"", null)))
        val file = File(Files.createTempDirectory("measure").toFile(), "nested/out.csv")
        MeasurementCsv.append(file, listOf("x", "環境"), listOf(1, "走廊"))
        MeasurementCsv.append(file, listOf("x", "環境"), listOf(2, "隔牆"))
        assertEquals("﻿x,環境\n1,走廊\n2,隔牆\n", file.readText(Charsets.UTF_8))
    }
}
