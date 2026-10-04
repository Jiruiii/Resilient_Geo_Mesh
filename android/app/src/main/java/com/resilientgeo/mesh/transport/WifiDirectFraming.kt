package com.resilientgeo.mesh.transport

import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.IOException

/** Bounded frames on an ordered TCP stream. A zero-length frame is a keepalive. */
object WifiDirectFraming {
    const val MAX_MESSAGE_BYTES = 4 * 1024 * 1024
    private const val MAGIC = 0x52474d31 // RGM1
    private val identityPattern = Regex("wifi:[0-9a-f]{32}")

    fun validIdentity(identity: String) = identityPattern.matches(identity)

    fun writeIdentity(output: DataOutputStream, identity: String) {
        require(validIdentity(identity))
        output.writeInt(MAGIC)
        output.writeUTF(identity)
        output.flush()
    }

    fun readIdentity(input: DataInputStream): String {
        if (input.readInt() != MAGIC) throw IOException("Unknown Wi-Fi Direct protocol")
        // Read the UTF length ourselves so an unknown peer cannot allocate an arbitrary identity.
        val size = input.readUnsignedShort()
        if (size != 37) throw IOException("Invalid peer identity length")
        val bytes = ByteArray(size)
        input.readFully(bytes)
        return String(bytes, Charsets.US_ASCII).also {
            if (!validIdentity(it)) throw IOException("Invalid peer identity")
        }
    }

    fun write(output: DataOutputStream, bytes: ByteArray) {
        require(bytes.size <= MAX_MESSAGE_BYTES) { "Message exceeds Wi-Fi Direct frame limit" }
        output.writeInt(bytes.size)
        output.write(bytes)
        output.flush()
    }

    fun read(input: DataInputStream): ByteArray {
        val size = input.readInt()
        if (size !in 0..MAX_MESSAGE_BYTES) throw IOException("Invalid Wi-Fi Direct frame length: $size")
        return ByteArray(size).also(input::readFully)
    }
}
