package com.alaarab.mutter

import android.media.MediaCodec
import android.media.MediaFormat
import com.alaarab.mutter.audio.VoiceAudio
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.sin
import kotlin.math.sqrt
import org.junit.Assert.*
import org.junit.Test

class AudioCodecTest {
    @Test
    fun platformOpusEncodesAndDecodesRealPcm() {
        val encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS)
        val decoder = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS)
        val packets = mutableListOf<ByteArray>()
        val decoded = mutableListOf<Short>()
        try {
            encoder.configure(
                MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, 48000, 1).apply {
                    setInteger(MediaFormat.KEY_BIT_RATE, 40000)
                },
                null,
                null,
                MediaCodec.CONFIGURE_FLAG_ENCODE,
            )
            encoder.start()
            repeat(50) { frame ->
                val index = encoder.dequeueInputBuffer(50000)
                assertTrue(index >= 0)
                val input =
                    encoder.getInputBuffer(index)!!.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
                repeat(960) { sample ->
                    input.put(
                        (sin(2 * Math.PI * 440 * (frame * 960 + sample) / 48000) * 12000)
                            .toInt()
                            .toShort()
                    )
                }
                encoder.queueInputBuffer(index, 0, 1920, frame * 20000L, 0)
                Thread.sleep(5)
                VoiceAudio.drain(encoder) { packets.add(it) }
            }
            Thread.sleep(100)
            VoiceAudio.drain(encoder) { packets.add(it) }
            assertTrue("No encoded Opus packets", packets.size > 20)
            val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, 48000, 1)
            val header =
                ByteBuffer.allocate(19)
                    .order(ByteOrder.LITTLE_ENDIAN)
                    .put("OpusHead".toByteArray())
                    .put(1)
                    .put(1)
                    .putShort(0)
                    .putInt(48000)
                    .putShort(0)
                    .put(0)
            format.setByteBuffer("csd-0", ByteBuffer.wrap(header.array()))
            for (key in listOf("csd-1", "csd-2")) format.setByteBuffer(
                key,
                ByteBuffer.allocate(8).order(ByteOrder.nativeOrder()).putLong(0).apply { flip() },
            )
            decoder.configure(format, null, null, 0)
            decoder.start()
            packets.forEachIndexed { frame, packet ->
                val index = decoder.dequeueInputBuffer(50000)
                assertTrue(index >= 0)
                decoder.getInputBuffer(index)!!.put(packet)
                decoder.queueInputBuffer(index, 0, packet.size, frame * 20000L, 0)
                Thread.sleep(5)
                VoiceAudio.drain(decoder) { bytes ->
                    val samples =
                        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
                    while (samples.hasRemaining()) decoded.add(samples.get())
                }
            }
            assertTrue("No decoded audio", decoded.size > 20000)
            val rms =
                sqrt(
                    decoded.sumOf {
                        val value = it.toDouble() / 32768
                        value * value
                    } / decoded.size
                )
            assertTrue("Decoded signal is silent", rms > .1)
        } finally {
            runCatching { encoder.stop() }
            encoder.release()
            runCatching { decoder.stop() }
            decoder.release()
        }
    }
}
