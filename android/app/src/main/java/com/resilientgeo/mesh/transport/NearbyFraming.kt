package com.resilientgeo.mesh.transport

import java.io.IOException
import java.nio.ByteBuffer

/** BYTES payloads are bounded; HELLO inventories can be much larger than 32 KiB. */
object NearbyFraming {
    const val MAX_MESSAGE_BYTES = 4 * 1024 * 1024
    const val PART_BYTES = 24 * 1024
    private const val MAGIC = 0x52474e31 // RGN1
    private const val HEADER_BYTES = 20

    fun encode(id: Long, message: ByteArray): List<ByteArray> {
        require(message.size in 1..MAX_MESSAGE_BYTES)
        return (message.indices step PART_BYTES).map { offset ->
            val length = minOf(PART_BYTES, message.size - offset)
            ByteBuffer.allocate(HEADER_BYTES + length).putInt(MAGIC).putLong(id)
                .putInt(message.size).putInt(offset).put(message, offset, length).array()
        }
    }

    /** One ordered message per endpoint, with strict bounds and no partial delivery. */
    class Receiver {
        private var id: Long? = null
        private var bytes: ByteArray? = null
        private var nextOffset = 0
        private var lastPartAt = 0L

        @Synchronized fun accept(frame: ByteArray, now: Long): ByteArray? {
            try {
                if (frame.size !in (HEADER_BYTES + 1)..(HEADER_BYTES + PART_BYTES)) throw IOException("Invalid Nearby frame size")
                val input = ByteBuffer.wrap(frame)
                if (input.int != MAGIC) throw IOException("Unknown Nearby protocol")
                val incomingId = input.long
                val total = input.int
                val offset = input.int
                val length = input.remaining()
                if (total !in 1..MAX_MESSAGE_BYTES || offset < 0 || offset > total - length)
                    throw IOException("Invalid Nearby message bounds")
                if (offset == 0) {
                    id = incomingId
                    bytes = ByteArray(total)
                    nextOffset = 0
                } else if (now - lastPartAt > 30_000) throw IOException("Nearby partial message expired")
                val target = bytes ?: throw IOException("Missing Nearby message start")
                if (incomingId != id || target.size != total || offset != nextOffset)
                    throw IOException("Out-of-order Nearby message")
                input.get(target, offset, length)
                nextOffset += length
                lastPartAt = now
                if (nextOffset != total) return null
                clear()
                return target
            } catch (error: Exception) {
                clear()
                throw error
            }
        }

        @Synchronized fun clear() { bytes = null; id = null; nextOffset = 0 }
    }
}
