package com.resilientgeo.mesh.transport

import org.junit.Assert.*
import org.junit.Test
import java.io.*
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class WifiDirectFramingTest {
    @Test fun streamsMultipleFramesAndKeepaliveAcrossRealSockets() {
        val server = ServerSocket(0)
        val pool = Executors.newSingleThreadExecutor()
        val payload = ByteArray(1024 * 1024) { (it % 251).toByte() }
        val identity = "wifi:" + "a".repeat(32)
        try {
            val remote = pool.submit<Boolean> {
                server.accept().use { socket ->
                    socket.soTimeout = 5000
                    val input = DataInputStream(socket.getInputStream())
                    assertEquals(identity, WifiDirectFraming.readIdentity(input))
                    assertEquals(0, WifiDirectFraming.read(input).size)
                    assertArrayEquals(payload, WifiDirectFraming.read(input))
                    assertArrayEquals("second".toByteArray(), WifiDirectFraming.read(input))
                    WifiDirectFraming.write(DataOutputStream(socket.getOutputStream()), "reply".toByteArray())
                    true
                }
            }
            Socket("127.0.0.1", server.localPort).use { socket ->
                socket.soTimeout = 5000
                val output = DataOutputStream(socket.getOutputStream())
                WifiDirectFraming.writeIdentity(output, identity)
                WifiDirectFraming.write(output, ByteArray(0))
                WifiDirectFraming.write(output, payload)
                WifiDirectFraming.write(output, "second".toByteArray())
                assertArrayEquals("reply".toByteArray(), WifiDirectFraming.read(DataInputStream(socket.getInputStream())))
            }
            assertTrue(remote.get(10, TimeUnit.SECONDS))
        } finally { server.close(); pool.shutdownNow() }
    }

    @Test fun rejectsNegativeAndOversizedLengthBeforeReadingPayload() {
        for (length in listOf(-1, WifiDirectFraming.MAX_MESSAGE_BYTES + 1, Int.MAX_VALUE)) {
            val bytes = ByteArrayOutputStream().apply { DataOutputStream(this).writeInt(length) }.toByteArray()
            assertThrows(IOException::class.java) { WifiDirectFraming.read(DataInputStream(bytes.inputStream())) }
        }
    }

    @Test fun truncatedMessageIsNeverDelivered() {
        val bytes = ByteArrayOutputStream().apply {
            DataOutputStream(this).apply { writeInt(10); write(byteArrayOf(1, 2)) }
        }.toByteArray()
        assertThrows(EOFException::class.java) { WifiDirectFraming.read(DataInputStream(bytes.inputStream())) }
    }

    @Test fun rejectsUnknownProtocolAndInvalidIdentities() {
        assertFalse(WifiDirectFraming.validIdentity("ble:" + "a".repeat(16)))
        assertFalse(WifiDirectFraming.validIdentity("wifi:" + "z".repeat(32)))
        assertThrows(IOException::class.java) {
            WifiDirectFraming.readIdentity(DataInputStream(ByteArray(8).inputStream()))
        }
        val bytes = ByteArrayOutputStream().apply {
            DataOutputStream(this).apply { writeInt(0x52474d31); writeShort(65535) }
        }.toByteArray()
        assertThrows(IOException::class.java) { WifiDirectFraming.readIdentity(DataInputStream(bytes.inputStream())) }
    }
}
