package com.alaarab.mutter.sharing

import java.io.ByteArrayOutputStream
import java.util.zip.Deflater
import java.util.zip.Inflater

class SignalCodec {
    private data class Partial(
        val count: Int,
        val flags: Int,
        val time: Long,
        val pieces: MutableMap<Int, ByteArray> = mutableMapOf(),
    )

    private val pending = mutableMapOf<Pair<Int, Int>, Partial>()
    private var nextId = 0

    @Synchronized
    fun encode(bytes: ByteArray): List<ByteArray> {
        require(bytes.size <= 4 * 1024 * 1024)
        val deflater = Deflater(Deflater.DEFAULT_COMPRESSION, true)
        val output = ByteArrayOutputStream()
        try {
            deflater.setInput(bytes)
            deflater.finish()
            val buffer = ByteArray(4096)
            while (!deflater.finished()) {
                val n = deflater.deflate(buffer)
                output.write(buffer, 0, n)
            }
        } finally {
            deflater.end()
        }
        val compressed = output.toByteArray()
        val smaller = compressed.size < bytes.size
        val payload = if (smaller) compressed else bytes
        val count = ((payload.size + 989) / 990).coerceAtLeast(1)
        require(count <= 255)
        val id = nextId++ and 255
        return (0 until count).map { index ->
            byteArrayOf(1, id.toByte(), index.toByte(), count.toByte(), if (smaller) 1 else 0) +
                payload.copyOfRange(index * 990, minOf(payload.size, (index + 1) * 990))
        }
    }

    @Synchronized
    fun receive(sender: Int, bytes: ByteArray): ByteArray? {
        if (bytes.size !in 5..1000 || bytes[0] != 1.toByte()) return null
        val now = System.currentTimeMillis()
        pending.entries.removeAll { now - it.value.time > 10000 }
        val id = bytes[1].toInt() and 255
        val index = bytes[2].toInt() and 255
        val count = bytes[3].toInt() and 255
        val flags = bytes[4].toInt() and 255
        if (count == 0 || index >= count || flags !in 0..1) return null
        val key = sender to id
        if (pending.size >= 128 && key !in pending) return null
        val partial = pending.getOrPut(key) { Partial(count, flags, now) }
        if (partial.count != count || partial.flags != flags) {
            pending.remove(key)
            return null
        }
        partial.pieces.putIfAbsent(index, bytes.copyOfRange(5, bytes.size))
        if (partial.pieces.size != count) return null
        pending.remove(key)
        val payload =
            ByteArrayOutputStream()
                .apply { repeat(count) { write(partial.pieces.getValue(it)) } }
                .toByteArray()
        if (flags == 0) return payload
        val inflater = Inflater(true)
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        return try {
            inflater.setInput(payload)
            while (!inflater.finished()) {
                val size = inflater.inflate(buffer)
                if (size == 0 || out.size() + size > 4 * 1024 * 1024) return null
                out.write(buffer, 0, size)
            }
            out.toByteArray()
        } catch (_: Exception) {
            null
        } finally {
            inflater.end()
        }
    }
}
