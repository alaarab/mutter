package com.alaarab.mutter.protocol

import javax.crypto.Cipher
import javax.crypto.spec.SecretKeySpec

class CryptState {
    private var encryptor: Cipher? = null
    private var decryptor: Cipher? = null
    var encryptIV = ByteArray(16)
        private set

    var decryptIV = ByteArray(16)
        private set

    private val history = IntArray(256) { -1 }
    var good = 0L
        private set

    var late = 0L
        private set

    var lost = 0L
        private set

    val valid
        get() = encryptor != null

    @android.annotation.SuppressLint("GetInstance")
    @Synchronized
    fun setKey(key: ByteArray, clientNonce: ByteArray, serverNonce: ByteArray) {
        require(key.size == 16 && clientNonce.size == 16 && serverNonce.size == 16)
        encryptor =
            Cipher.getInstance("AES/ECB/NoPadding").apply {
                init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"))
            }
        decryptor =
            Cipher.getInstance("AES/ECB/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"))
            }
        encryptIV = clientNonce.copyOf()
        decryptIV = serverNonce.copyOf()
        history.fill(-1)
        good = 0
        late = 0
        lost = 0
    }

    @Synchronized
    fun resync(nonce: ByteArray) {
        require(nonce.size == 16)
        decryptIV = nonce.copyOf()
        history.fill(-1)
    }

    @Synchronized
    fun encrypt(plain: ByteArray): ByteArray {
        check(valid)
        increment(encryptIV, 0)
        val (ciphertext, tag) = seal(plain, encryptIV)
        return byteArrayOf(encryptIV[0], tag[0], tag[1], tag[2]) + ciphertext
    }

    @Synchronized
    fun decrypt(packet: ByteArray): ByteArray? {
        if (!valid || packet.size < 4) return null
        val saved = decryptIV.copyOf()
        val iv = decryptIV
        val next = packet[0].u()
        val current = iv[0].u()
        var restore = false
        var lostDelta = 0L
        if ((current + 1) and 255 == next) {
            iv[0] = next.toByte()
            if (next < current) increment(iv, 1)
        } else {
            var diff = next - current
            if (diff > 128) diff -= 256 else if (diff < -128) diff += 256
            when {
                diff in -29..-1 -> {
                    restore = true
                    lostDelta = -1
                    iv[0] = next.toByte()
                    if (next > current) decrement(iv, 1)
                }
                diff > 0 -> {
                    lostDelta = diff - 1L
                    iv[0] = next.toByte()
                    if (next < current) increment(iv, 1)
                }
                else -> return null
            }
        }
        if (history[iv[0].u()] == iv[1].u()) {
            decryptIV = saved
            return null
        }
        val result = open(packet.copyOfRange(4, packet.size), iv)
        var mismatch = 0
        if (result != null)
            for (i in 0..2) mismatch = mismatch or (result.second[i].u() xor packet[i + 1].u())
        if (result == null || mismatch != 0) {
            decryptIV = saved
            return null
        }
        history[iv[0].u()] = iv[1].u()
        if (restore) {
            decryptIV = saved
            late++
        }
        good++
        lost = (lost + lostDelta).coerceAtLeast(0)
        return result.first
    }

    @Synchronized
    fun seal(plain: ByteArray, nonce: ByteArray): Pair<ByteArray, ByteArray> {
        var delta = encryptor!!.doFinal(nonce)
        var checksum = ByteArray(16)
        val out = ByteArray(plain.size)
        var offset = 0
        while (plain.size - offset > 16) {
            val block = plain.copyOfRange(offset, offset + 16)
            val flip = plain.size - offset <= 32 && block.take(15).all { it == 0.toByte() }
            delta = double(delta)
            val masked = xor(delta, block)
            if (flip) masked[0] = (masked[0].u() xor 1).toByte()
            xor(delta, encryptor!!.doFinal(masked)).copyInto(out, offset)
            checksum = xor(checksum, block)
            if (flip) checksum[0] = (checksum[0].u() xor 1).toByte()
            offset += 16
        }
        val remaining = plain.size - offset
        delta = double(delta)
        val length =
            ByteArray(16).apply {
                this[14] = ((remaining * 8) ushr 8).toByte()
                this[15] = (remaining * 8).toByte()
            }
        val pad = encryptor!!.doFinal(xor(length, delta))
        val tail = pad.copyOf()
        plain.copyInto(tail, 0, offset)
        checksum = xor(checksum, tail)
        xor(pad, tail).copyInto(out, offset, 0, remaining)
        return out to encryptor!!.doFinal(xor(xor(delta, double(delta)), checksum))
    }

    private fun open(encrypted: ByteArray, nonce: ByteArray): Pair<ByteArray, ByteArray>? {
        var delta = encryptor!!.doFinal(nonce)
        var checksum = ByteArray(16)
        val out = ByteArray(encrypted.size)
        var offset = 0
        while (encrypted.size - offset > 16) {
            delta = double(delta)
            val block =
                xor(
                    delta,
                    decryptor!!.doFinal(xor(delta, encrypted.copyOfRange(offset, offset + 16))),
                )
            block.copyInto(out, offset)
            checksum = xor(checksum, block)
            offset += 16
        }
        val remaining = encrypted.size - offset
        delta = double(delta)
        val length =
            ByteArray(16).apply {
                this[14] = ((remaining * 8) ushr 8).toByte()
                this[15] = (remaining * 8).toByte()
            }
        val pad = encryptor!!.doFinal(xor(length, delta))
        val tail = ByteArray(16)
        encrypted.copyInto(tail, 0, offset)
        val plain = xor(tail, pad)
        if ((0..14).all { plain[it] == delta[it] }) return null
        checksum = xor(checksum, plain)
        plain.copyInto(out, offset, 0, remaining)
        return out to encryptor!!.doFinal(xor(xor(delta, double(delta)), checksum))
    }

    private fun xor(a: ByteArray, b: ByteArray) =
        ByteArray(16) { (a[it].u() xor b[it].u()).toByte() }

    private fun double(a: ByteArray) =
        ByteArray(16) { i ->
            ((a[i].u() shl 1) xor if (i < 15) a[i + 1].u() ushr 7 else (a[0].u() ushr 7) * 0x87)
                .toByte()
        }

    private fun increment(iv: ByteArray, start: Int) {
        for (i in start..15) {
            iv[i] = (iv[i].u() + 1).toByte()
            if (iv[i].u() != 0) break
        }
    }

    private fun decrement(iv: ByteArray, start: Int) {
        for (i in start..15) {
            val before = iv[i].u()
            iv[i] = (before - 1).toByte()
            if (before != 0) break
        }
    }

    private fun Byte.u() = toInt() and 255
}
