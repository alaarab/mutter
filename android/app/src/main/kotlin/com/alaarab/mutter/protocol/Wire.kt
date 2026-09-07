package com.alaarab.mutter.protocol

import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

class Proto {
    private val out = ByteArrayOutputStream()

    fun number(field: Int, value: Long) = apply {
        varint((field.toLong() shl 3))
        varint(value)
    }

    fun number(field: Int, value: Int) = number(field, value.toLong())

    fun bool(field: Int, value: Boolean) = number(field, if (value) 1 else 0)

    fun bytes(field: Int, value: ByteArray) = apply {
        varint((field.toLong() shl 3) or 2)
        varint(value.size.toLong())
        out.write(value)
    }

    fun text(field: Int, value: String) = bytes(field, value.toByteArray(Charsets.UTF_8))

    fun message(field: Int, value: Proto) = bytes(field, value.build())

    fun build(): ByteArray = out.toByteArray()

    private fun varint(value: Long) {
        var n = value
        while (n and -128L != 0L) {
            out.write((n.toInt() and 127) or 128)
            n = n ushr 7
        }
        out.write(n.toInt())
    }

    companion object {
        fun parse(bytes: ByteArray): Fields {
            require(bytes.size <= MAX_FRAME) { "Message exceeds the size limit" }
            val input = Cursor(bytes)
            val fields = mutableMapOf<Int, MutableList<Any>>()
            while (input.remaining > 0) {
                val tag = input.protobufVarint()
                val field = (tag ushr 3).toInt()
                require(field in 1..536870911) { "Invalid protobuf field" }
                val value: Any =
                    when ((tag and 7).toInt()) {
                        0 -> input.protobufVarint()
                        1 -> ByteBuffer.wrap(input.take(8)).order(ByteOrder.LITTLE_ENDIAN).long
                        2 -> {
                            val size = input.protobufVarint()
                            require(size in 0..input.remaining.toLong())
                            input.take(size.toInt())
                        }
                        5 ->
                            ByteBuffer.wrap(input.take(4))
                                .order(ByteOrder.LITTLE_ENDIAN)
                                .int
                                .toLong()
                        else -> throw IllegalArgumentException("Unsupported protobuf wire type")
                    }
                fields.getOrPut(field) { mutableListOf() }.add(value)
            }
            return Fields(fields)
        }
    }
}

class Fields(private val values: Map<Int, List<Any>>) {
    fun has(field: Int) = values.containsKey(field)

    fun long(field: Int, default: Long = 0) = (values[field]?.lastOrNull() as? Long) ?: default

    fun int(field: Int, default: Int = 0) = long(field, default.toLong()).toInt()

    fun bool(field: Int) = long(field) != 0L

    fun bytes(field: Int) = (values[field]?.lastOrNull() as? ByteArray) ?: byteArrayOf()

    fun text(field: Int, default: String = "") =
        if (has(field)) bytes(field).toString(Charsets.UTF_8) else default

    fun messages(field: Int) =
        values[field].orEmpty().filterIsInstance<ByteArray>().map(Proto::parse)

    fun numbers(field: Int): List<Int> =
        values[field].orEmpty().flatMap {
            when (it) {
                is Long -> listOf(it.toInt())
                is ByteArray -> {
                    val input = Cursor(it)
                    buildList { while (input.remaining > 0) add(input.protobufVarint().toInt()) }
                }
                else -> emptyList()
            }
        }
}

class Cursor(private val bytes: ByteArray) {
    var offset = 0
        private set

    val remaining
        get() = bytes.size - offset

    fun byte(): Int {
        require(remaining > 0) { "Truncated packet" }
        return bytes[offset++].toInt() and 255
    }

    fun take(count: Int): ByteArray {
        require(count in 0..remaining) { "Truncated packet" }
        return bytes.copyOfRange(offset, offset + count).also { offset += count }
    }

    fun protobufVarint(): Long {
        var value = 0L
        for (shift in 0..63 step 7) {
            val part = byte()
            require(shift != 63 || part < 2) { "Varint overflow" }
            value = value or ((part and 127).toLong() shl shift)
            if (part and 128 == 0) return value
        }
        error("Varint overflow")
    }

    fun mumbleVarint(depth: Int = 0): Long {
        require(depth < 2) { "Invalid negative varint" }
        val first = byte()
        return when {
            first and 128 == 0 -> first.toLong()
            first and 192 == 128 -> ((first and 63).toLong() shl 8) or byte().toLong()
            first and 224 == 192 ->
                ((first and 31).toLong() shl 16) or (byte().toLong() shl 8) or byte().toLong()
            first and 240 == 224 ->
                ((first and 15).toLong() shl 24) or
                    (byte().toLong() shl 16) or
                    (byte().toLong() shl 8) or
                    byte().toLong()
            first and 252 == 240 -> readBig(4)
            first and 252 == 244 -> readBig(8)
            first and 252 == 248 -> mumbleVarint(depth + 1).inv()
            else -> (first and 3).toLong().inv()
        }
    }

    private fun readBig(count: Int): Long {
        var value = 0L
        repeat(count) { value = (value shl 8) or byte().toLong() }
        return value
    }
}

fun mumbleVarint(value: Long): ByteArray {
    val out = ByteArrayOutputStream()
    when {
        value < 0 -> {
            if (value.inv() <= 3) out.write(0xfc or value.inv().toInt())
            else {
                out.write(0xf8)
                out.write(mumbleVarint(value.inv()))
            }
        }
        value < 0x80 -> out.write(value.toInt())
        value < 0x4000 -> {
            out.write((value ushr 8).toInt() or 0x80)
            out.write(value.toInt())
        }
        value < 0x200000 -> {
            out.write((value ushr 16).toInt() or 0xc0)
            out.write((value ushr 8).toInt())
            out.write(value.toInt())
        }
        value < 0x10000000 -> {
            out.write((value ushr 24).toInt() or 0xe0)
            for (shift in 16 downTo 0 step 8) out.write((value ushr shift).toInt())
        }
        else -> {
            val count = if (value <= 0xffffffffL) 4 else 8
            out.write(if (count == 4) 0xf0 else 0xf4)
            for (shift in (count - 1) * 8 downTo 0 step 8) out.write((value ushr shift).toInt())
        }
    }
    return out.toByteArray()
}

const val MAX_FRAME = 8 * 1024 * 1024

data class Frame(val type: Int, val payload: ByteArray)

fun DataInputStream.readFrame(): Frame {
    val type = readUnsignedShort()
    val count = readInt()
    require(count in 0..MAX_FRAME) { "Invalid control frame length" }
    return Frame(type, ByteArray(count).also(::readFully))
}

fun DataOutputStream.writeFrame(type: Int, payload: ByteArray) {
    require(type in 0..65535 && payload.size <= MAX_FRAME)
    writeShort(type)
    writeInt(payload.size)
    write(payload)
    flush()
}

data class VoicePacket(val session: Int, val frame: Long, val opus: ByteArray, val end: Boolean)

object VoiceWire {
    fun audio(
        opus: ByteArray,
        sequence: Long,
        end: Boolean,
        target: Int,
        modern: Boolean,
    ): ByteArray =
        if (modern)
            byteArrayOf(0) +
                Proto().number(1, target).number(4, sequence).bytes(5, opus).bool(16, end).build()
        else
            byteArrayOf((0x80 or target).toByte()) +
                mumbleVarint(sequence) +
                mumbleVarint(opus.size.toLong() or if (end) 0x2000 else 0) +
                opus

    fun decode(data: ByteArray, modern: Boolean): VoicePacket? = runCatching {
        val input = Cursor(data)
        val type = input.byte()
        if (modern) {
            if (type != 0) return null
            val fields = Proto.parse(input.take(input.remaining))
            VoicePacket(fields.int(3), fields.long(4), fields.bytes(5), fields.bool(16))
        } else {
            if (type ushr 5 != 4) return null
            val session = input.mumbleVarint().toInt()
            val frame = input.mumbleVarint()
            val size = input.mumbleVarint().toInt()
            VoicePacket(session, frame, input.take(size and 0x1fff), size and 0x2000 != 0)
        }
    }
        .getOrNull()

    fun ping(time: Long, modern: Boolean) =
        if (modern) byteArrayOf(1) + Proto().number(1, time).build()
        else byteArrayOf(0x20) + mumbleVarint(time)

    fun isPing(data: ByteArray, modern: Boolean) =
        data.isNotEmpty() && (data[0].toInt() and 255) == if (modern) 1 else 0x20
}
