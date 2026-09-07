package com.alaarab.mutter.protocol

import org.junit.Assert.*
import org.junit.Test

class CryptStateTest {
    private fun hex(value: String) = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    private val key = ByteArray(16) { it.toByte() }

    @Test
    fun upstreamOcbKnownAnswers() {
        val crypt = CryptState().apply { setKey(key, key, key) }
        assertArrayEquals(
            hex("BF3108130773AD5EC70EC69E7875A7B0"),
            crypt.seal(byteArrayOf(), key).second,
        )
        val (ciphertext, tag) = crypt.seal(ByteArray(40) { it.toByte() }, key)
        assertArrayEquals(
            hex("F75D6BC8B4DC8D66B836A2B08B32A6369F1CD3C5228D79FD6C267F5F6AA7B231C7DFB9D59951AE9C"),
            ciphertext,
        )
        assertArrayEquals(hex("9DB0CDF880F73E3E10D4EB3217766688"), tag)
    }

    private fun pair(): Pair<CryptState, CryptState> {
        val other = key.reversedArray()
        return CryptState().apply { setKey(key, key, other) } to
            CryptState().apply { setKey(key, other, key) }
    }

    @Test
    fun roundTripsAllTailsAndNonceWraps() {
        val (sender, receiver) = pair()
        repeat(1024) { index ->
            val plain = ByteArray(1 + index % 100) { (it % 253 + 1).toByte() }
            assertArrayEquals(plain, receiver.decrypt(sender.encrypt(plain)))
        }
        assertEquals(1024L, receiver.good)
    }

    @Test
    fun badTagsAndReplaysDoNotAdvanceTheNonce() {
        val (sender, receiver) = pair()
        val packet = sender.encrypt("voice packet".toByteArray())
        val tampered = packet.copyOf().apply { this[1] = (this[1].toInt() xor 1).toByte() }
        assertNull(receiver.decrypt(tampered))
        assertEquals(0L, receiver.good)
        assertArrayEquals("voice packet".toByteArray(), receiver.decrypt(packet))
        assertNull(receiver.decrypt(packet))
    }

    @Test
    fun reorderedPacketsRecoverWithoutAllowingReplay() {
        val (sender, receiver) = pair()
        val packets = (0..8).map { sender.encrypt(byteArrayOf(it.toByte())) }
        assertArrayEquals(byteArrayOf(0), receiver.decrypt(packets[0]))
        assertArrayEquals(byteArrayOf(3), receiver.decrypt(packets[3]))
        assertArrayEquals(byteArrayOf(2), receiver.decrypt(packets[2]))
        assertArrayEquals(byteArrayOf(1), receiver.decrypt(packets[1]))
        assertNull(receiver.decrypt(packets[2]))
        assertArrayEquals(byteArrayOf(4), receiver.decrypt(packets[4]))
        assertEquals(2L, receiver.late)
        assertEquals(0L, receiver.lost)
    }

    @Test
    fun invalidKeySizesAreRejected() {
        assertThrows(IllegalArgumentException::class.java) {
            CryptState().setKey(byteArrayOf(1), key, key)
        }
    }
}
