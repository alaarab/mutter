package com.alaarab.mutter.audio

import kotlin.math.PI
import kotlin.math.abs
import org.junit.Assert.*
import org.junit.Test

/** Stands in for Opus: every decoded sample is a constant, so any gain step shows up as a jump. */
class ConstantDecoder : Playout.Decoder {
    var calls = 0

    override fun decode(packet: ByteArray, length: Int, output: FloatArray): Int {
        calls += 1
        val samples = Playout.opusSamples(packet)!!
        output.fill(LEVEL, 0, samples)
        return samples
    }

    companion object {
        const val LEVEL = 0.1f
    }
}

// CELT 10 and 20 ms, SILK 40 and 60 ms, one frame per packet.
private val tocs = mapOf(1 to (18 shl 3), 2 to (19 shl 3), 4 to (2 shl 3), 6 to (3 shl 3))

private fun render(playout: Playout, arrivals: List<Arrival>, until: Int): FloatArray {
    val pending = ArrayDeque(arrivals.sortedBy { it.at })
    val output = FloatArray(until)
    val block = FloatArray(480)
    var time = 0
    while (time < until) {
        while (pending.isNotEmpty() && pending.first().at <= time) {
            val arrival = pending.removeFirst()
            val opus = byteArrayOf(tocs.getValue(arrival.units).toByte(), arrival.frame.toByte())
            playout.push(arrival.frame, opus, arrival.terminator)
        }
        playout.render(block, block.size)
        block.copyInto(output, time)
        time += 480
    }
    return output
}

class PlayoutTest {
    @Test
    fun opusPacketLengthsComeFromTheTocByte() {
        assertEquals(480, Playout.opusSamples(byteArrayOf((18 shl 3).toByte())))
        assertEquals(960, Playout.opusSamples(byteArrayOf((19 shl 3).toByte())))
        assertEquals(2880, Playout.opusSamples(byteArrayOf((3 shl 3).toByte())))
        // Two 20 ms frames, then three 20 ms frames in a code 3 packet.
        assertEquals(1920, Playout.opusSamples(byteArrayOf((19 shl 3 or 1).toByte())))
        assertEquals(2880, Playout.opusSamples(byteArrayOf((19 shl 3 or 3).toByte(), 3)))
        assertNull(Playout.opusSamples(byteArrayOf((19 shl 3 or 3).toByte())))
        assertNull(Playout.opusSamples(byteArrayOf((3 shl 3 or 3).toByte(), 3)))
        assertNull(Playout.opusSamples(byteArrayOf()))
    }

    @Test
    fun concealmentKeepsTimeForEveryPacketLength() {
        for (milliseconds in listOf(10, 20, 40, 60)) {
            for (lost in 1..3) {
                val units = milliseconds / 10
                val output =
                    render(
                        Playout(1, ConstantDecoder()),
                        listOf(
                            Arrival(0, 0, units),
                            Arrival(0, ((lost + 1) * units).toLong(), units, terminator = true),
                        ),
                        48_000,
                    )
                val played = output.indexOfLast { it != 0f } + 1
                // Then the fade-out, whose last sample reaches zero.
                assertEquals(
                    "$milliseconds ms, $lost lost",
                    (lost + 2) * milliseconds * 48 + JitterBuffer.RAMP_SAMPLES - 1,
                    played,
                )
            }
        }
    }

    @Test
    fun concealmentMirrorsTheLastPacketAndDecays() {
        // A ramp-shaped packet shows the direction of each concealed pass.
        val decoder = Playout.Decoder { _, _, output ->
            for (index in 0 until 960) output[index] = (index + 1) / 9600f
            960
        }
        val output =
            render(
                Playout(1, decoder),
                listOf(
                    Arrival(0, 0, 2),
                    Arrival(0, 2, 2),
                    Arrival(0, 6, 2, terminator = true),
                ),
                48_000,
            )
        // Frame 4 is lost: its first sample continues backwards from the end of frame 2.
        val gap = 2 * 960
        assertEquals(output[gap - 1], output[gap], 1e-6f)
        assertTrue(output[gap + 959] < output[gap] * 0.7f)
    }

    @Test
    fun theOutputNeverJumps() {
        // Bursts, a stall, losses and two utterances, all at a constant level.
        val decoder = ConstantDecoder()
        val playout = Playout(7, decoder)
        val arrivals =
            stream(0 until 1000 step 2, 2) { frame ->
                    if (frame in 100 until 150) (150 - frame) * 480 + 240 else bursts(frame)
                }
                .filter { it.frame % 34 != 0L || it.frame == 0L } +
                stream(0 until 200 step 6, 6).map { it.copy(at = it.at + 48 * 12_000) }
        val output = render(playout, arrivals, 48 * 16_000)
        var largest = 0f
        for (index in 1 until output.size) {
            largest = maxOf(largest, abs(output[index] - output[index - 1]))
        }
        val allowed = ConstantDecoder.LEVEL * (PI / 2).toFloat() / JitterBuffer.RAMP_SAMPLES * 1.01f
        assertTrue("output jumped by $largest, allowed $allowed", largest <= allowed)
        assertEquals(0f, output.first())
        assertEquals(0f, output.last())
        assertTrue(playout.isIdle)

        val summary = playout.diagnosticsSummary(100_000)
        assertNotNull(summary)
        assertTrue(summary!!, summary.startsWith("Playout session 7: underruns"))
        assertTrue(summary, summary.contains("concealed 10ms"))
        assertNull(playout.diagnosticsSummary(101_000))
    }

    @Test
    fun diagnosticsStayQuietWhenNothingWentWrong() {
        val playout = Playout(1, ConstantDecoder())
        render(playout, stream(0 until 200 step 2, 2), 48 * 3000)
        assertNull(playout.diagnosticsSummary(0))
    }
}
