package com.alaarab.mutter.sharing

import java.util.Random
import org.junit.Assert.*
import org.junit.Test

class SignalCodecTest {
    @Test
    fun fragmentedCompressedMessagesReassembleOutOfOrder() {
        val codec = SignalCodec()
        val bytes = ByteArray(50000).also { Random(7).nextBytes(it) }
        val fragments = codec.encode(bytes)
        assertTrue(fragments.size > 1)
        var result: ByteArray? = null
        fragments.reversed().forEach { piece -> result = codec.receive(42, piece) ?: result }
        assertArrayEquals(bytes, result)
        val compressible = "sdp connection ".repeat(4000).toByteArray()
        var inflated: ByteArray? = null
        codec.encode(compressible).forEach { inflated = codec.receive(42, it) ?: inflated }
        assertArrayEquals(compressible, inflated)
    }

    @Test
    fun senderAndFragmentMetadataCannotBeMixed() {
        val codec = SignalCodec()
        val fragments = codec.encode(ByteArray(4000).also { Random(1).nextBytes(it) })
        assertNull(codec.receive(1, fragments[0]))
        assertNull(codec.receive(2, fragments[1]))
        val inconsistent = fragments[1].copyOf().apply { this[3] = 1 }
        assertNull(codec.receive(1, inconsistent))
        assertNull(codec.receive(1, byteArrayOf(1, 0, 1, 0, 0)))
    }
}
