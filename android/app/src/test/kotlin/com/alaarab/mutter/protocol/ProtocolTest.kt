package com.alaarab.mutter.protocol

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import org.junit.Assert.*
import org.junit.Test

class ProtocolTest {
    @Test
    fun protobufPreservesRepeatedPackedAndUnknownFields() {
        val message =
            Proto()
                .number(1, Long.MAX_VALUE)
                .text(2, "Mutter · مرحبًا")
                .number(3, 4)
                .number(3, 7)
                .bytes(4, byteArrayOf(1, 2, 0xac.toByte(), 2))
                .message(5, Proto().bool(1, true))
                .number(800, -1)
                .build()
        val fields = Proto.parse(message)
        assertEquals(Long.MAX_VALUE, fields.long(1))
        assertEquals("Mutter · مرحبًا", fields.text(2))
        assertEquals(listOf(4, 7), fields.numbers(3))
        assertEquals(listOf(1, 2, 300), fields.numbers(4))
        assertTrue(fields.messages(5).single().bool(1))
        assertEquals(-1L, fields.long(800))
    }

    @Test
    fun malformedProtobufIsRejected() {
        for (bytes in
            listOf(
                byteArrayOf(0),
                byteArrayOf(10, 5, 1),
                ByteArray(11) { 0xff.toByte() },
                byteArrayOf(15),
            )) {
            assertThrows(IllegalArgumentException::class.java) { Proto.parse(bytes) }
        }
    }

    @Test
    fun mumbleVarintsCoverEveryPrefix() {
        for (value in
            listOf(
                0L,
                127,
                128,
                16383,
                16384,
                2097151,
                2097152,
                268435455,
                268435456,
                0xffffffffL,
                0x100000000L,
                Long.MAX_VALUE,
                -1,
                -2,
                -4,
                -5,
                Long.MIN_VALUE,
            )) {
            val encoded = mumbleVarint(value)
            assertEquals("value $value", value, Cursor(encoded).mumbleVarint())
        }
    }

    @Test
    fun truncatedVoiceDoesNotEscapeDecoder() {
        for (bytes in
            listOf(
                byteArrayOf(),
                byteArrayOf(0x80.toByte()),
                byteArrayOf(0x80.toByte(), 1, 1, 127),
                byteArrayOf(0, 10, 127),
            )) {
            assertNull(VoiceWire.decode(bytes, false))
            assertNull(VoiceWire.decode(bytes, true))
        }
    }

    @Test
    fun audioPacketsMatchBothServerFormats() {
        val opus = byteArrayOf(0xf8.toByte(), 0xff.toByte(), 0xfe.toByte())
        val legacy = VoiceWire.audio(opus, 600, true, 1, false)
        val incoming =
            byteArrayOf(legacy[0]) + mumbleVarint(42) + legacy.copyOfRange(1, legacy.size)
        val decoded = VoiceWire.decode(incoming, false)!!
        assertEquals(42, decoded.session)
        assertEquals(600L, decoded.frame)
        assertTrue(decoded.end)
        assertArrayEquals(opus, decoded.opus)
        val modern =
            byteArrayOf(0) +
                Proto().number(3, 42).number(4, 600).bytes(5, opus).bool(16, true).build()
        assertArrayEquals(opus, VoiceWire.decode(modern, true)!!.opus)
    }

    @Test
    fun controlFramingHandlesSplitReadsAndRejectsOversize() {
        val output = ByteArrayOutputStream()
        DataOutputStream(output).writeFrame(26, byteArrayOf(1, 2, 3))
        val input =
            object : ByteArrayInputStream(output.toByteArray()) {
                override fun read(b: ByteArray, off: Int, len: Int) =
                    super.read(b, off, minOf(len, 1))
            }
        val frame = DataInputStream(input).readFrame()
        assertEquals(26, frame.type)
        assertArrayEquals(byteArrayOf(1, 2, 3), frame.payload)
        assertThrows(IllegalArgumentException::class.java) {
            DataInputStream(byteArrayOf(0, 1, 127, -1, -1, -1).inputStream()).readFrame()
        }
    }
}
