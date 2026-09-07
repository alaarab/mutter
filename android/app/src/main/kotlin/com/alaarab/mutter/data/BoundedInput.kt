package com.alaarab.mutter.data

import java.io.ByteArrayOutputStream
import java.io.InputStream

fun InputStream.readBounded(limit: Int): ByteArray {
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    while (true) {
        val count = read(buffer, 0, minOf(buffer.size, limit - output.size() + 1))
        if (count < 0) return output.toByteArray()
        require(output.size() + count <= limit) { "The file is too large." }
        if (count == 0) continue
        output.write(buffer, 0, count)
    }
}
