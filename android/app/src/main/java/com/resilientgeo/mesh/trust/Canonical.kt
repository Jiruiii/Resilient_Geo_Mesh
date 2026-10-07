package com.resilientgeo.mesh.trust

import org.json.JSONArray
import org.json.JSONObject
import java.math.BigDecimal
import java.nio.charset.StandardCharsets

/**
 * Kotlin port of `pipeline/lib/canonical.mjs`'s `canonicalize()`.
 *
 * Must byte-for-byte match the Node canonicalizer: objects sorted by the
 * UTF-8 byte order of their keys, arrays keep source order, no insignificant
 * whitespace. `signEvent`/`verifyEvent` on the server hash and sign exactly
 * this string, so any divergence here breaks every signature check.
 *
 * Number formatting mirrors JS's `JSON.stringify`, which prints the shortest
 * decimal that round-trips (and drops `.0` for integral values, e.g. 24.0 ->
 * "24"). This port handles every value produced by this project's event
 * fixtures (small integers and short-decimal coordinates); it is not a
 * general ECMA-262 Number::toString implementation and does not attempt
 * scientific notation for extreme magnitudes.
 */
object Canonical {

    private const val FORM_FEED_CODE = 0x0C

    fun canonicalize(value: Any?): String {
        val out = StringBuilder()
        append(out, value)
        return out.toString()
    }

    private fun append(out: StringBuilder, value: Any?) {
        when (value) {
            null, JSONObject.NULL -> out.append("null")
            is String -> encodeString(out, value)
            is Boolean -> out.append(if (value) "true" else "false")
            is Int -> out.append(value)
            is Long -> out.append(value)
            is Double -> out.append(encodeNumber(value))
            is Float -> out.append(encodeNumber(value.toDouble()))
            // org.json's real implementation (used at runtime and by these
            // unit tests) parses JSON decimal literals as BigDecimal, not
            // Double — confirmed by actually running these tests, which
            // failed with "unsupported canonical JSON value: BigDecimal"
            // until this branch was added. JSON/JS has no arbitrary-precision
            // decimal type, so converting to Double here matches what the
            // Node signer/verifier does when it parses the same JSON text.
            is java.math.BigDecimal -> out.append(encodeNumber(value.toDouble()))
            is java.math.BigInteger -> out.append(value.toString())
            is JSONArray -> appendArray(out, value)
            is JSONObject -> appendObject(out, value)
            is List<*> -> appendArray(out, JSONArray(value))
            is Map<*, *> -> appendObject(out, JSONObject(value))
            else -> throw IllegalArgumentException("unsupported canonical JSON value: ${value::class}")
        }
    }

    private fun appendArray(out: StringBuilder, array: JSONArray) {
        out.append('[')
        for (i in 0 until array.length()) {
            if (i > 0) out.append(',')
            append(out, array.get(i))
        }
        out.append(']')
    }

    private fun appendObject(out: StringBuilder, obj: JSONObject) {
        val keys = obj.keys().asSequence().toMutableList()
        keys.sortWith(::compareUtf8)
        out.append('{')
        keys.forEachIndexed { index, key ->
            if (index > 0) out.append(',')
            encodeString(out, key)
            out.append(':')
            append(out, obj.get(key))
        }
        out.append('}')
    }

    /**
     * Matches `Buffer.from(a,'utf8').compare(Buffer.from(b,'utf8'))`: unsigned
     * byte-wise order. UTF-8 byte order equals code point order, which equals
     * UTF-16 unit order except where a surrogate is involved, so only that
     * rare case pays for the byte conversion.
     */
    internal fun compareUtf8(a: String, b: String): Int {
        val len = minOf(a.length, b.length)
        for (i in 0 until len) {
            val ca = a[i]
            val cb = b[i]
            if (ca != cb) {
                if (ca.isSurrogate() || cb.isSurrogate()) return compareUtf8Bytes(a, b)
                return ca.code - cb.code
            }
        }
        return a.length - b.length
    }

    private fun compareUtf8Bytes(a: String, b: String): Int {
        val ba = a.toByteArray(StandardCharsets.UTF_8)
        val bb = b.toByteArray(StandardCharsets.UTF_8)
        val len = minOf(ba.size, bb.size)
        for (i in 0 until len) {
            val diff = (ba[i].toInt() and 0xFF) - (bb[i].toInt() and 0xFF)
            if (diff != 0) return diff
        }
        return ba.size - bb.size
    }

    /** Matches JSON.stringify's string escaping (control chars only; Unicode passes through raw). */
    private fun encodeString(sb: StringBuilder, value: String) {
        sb.append('"')
        for (ch in value) {
            when {
                ch == '"' -> sb.append("\\\"")
                ch == '\\' -> sb.append("\\\\")
                ch == '\b' -> sb.append("\\b")
                ch.code == FORM_FEED_CODE -> sb.append("\\f")
                ch == '\n' -> sb.append("\\n")
                ch == '\r' -> sb.append("\\r")
                ch == '\t' -> sb.append("\\t")
                ch.code < 0x20 -> sb.append("\\u").append(ch.code.toString(16).padStart(4, '0'))
                else -> sb.append(ch)
            }
        }
        sb.append('"')
    }

    private fun encodeNumber(value: Double): String {
        if (value.isNaN() || value.isInfinite()) {
            throw IllegalArgumentException("canonical JSON cannot contain non-finite numbers")
        }
        if (value == 0.0) return "0"
        val negative = value < 0
        val abs = Math.abs(value)
        val text = if (abs == Math.floor(abs) && abs < 1e21) {
            BigDecimal(abs).toBigInteger().toString()
        } else {
            abs.toString()
        }
        return if (negative) "-$text" else text
    }

    fun sha256Bytes(bytes: ByteArray): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(bytes)
        return formatSha256(digest)
    }

    fun sha256Canonical(value: Any?): String {
        return sha256Bytes(canonicalize(value).toByteArray(StandardCharsets.UTF_8))
    }

    /** Hashes a canonical JSON array without materializing the complete array string. */
    fun sha256CanonicalArray(values: Sequence<Any?>): String {
        val hasher = CanonicalArrayHasher()
        values.forEach(hasher::update)
        return hasher.finish()
    }

    internal fun formatSha256(digest: ByteArray): String =
        "sha256:" + digest.joinToString("") { "%02x".format(it) }
}

/** Incremental canonical JSON array hashing for signed packages with many records. */
class CanonicalArrayHasher {
    private val digest = java.security.MessageDigest.getInstance("SHA-256")
    private var first = true
    private var finished = false

    init {
        digest.update('['.code.toByte())
    }

    fun update(value: Any?) {
        check(!finished) { "canonical array hash is already finished" }
        if (!first) digest.update(','.code.toByte())
        digest.update(Canonical.canonicalize(value).toByteArray(StandardCharsets.UTF_8))
        first = false
    }

    fun finish(): String {
        check(!finished) { "canonical array hash is already finished" }
        finished = true
        digest.update(']'.code.toByte())
        return Canonical.formatSha256(digest.digest())
    }
}
