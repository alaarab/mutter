package com.alaarab.mutter.audio

import com.alaarab.mutter.audio.JitterBuffer.Action
import org.junit.Assert.*
import org.junit.Test

/** Positions in these tests are samples at 48 kHz; frames are Mumble 10 ms units. */
data class Arrival(var at: Int, val frame: Long, val units: Int, val terminator: Boolean = false)

class Run {
    val steps = mutableListOf<JitterBuffer.Step>()
    var statistics = JitterBuffer.Statistics()
    val playedAt = mutableMapOf<Long, Int>()
    var firstPlayAt: Int? = null

    val plays
        get() = steps.filter { it.action == Action.PLAY }

    val conceals
        get() = steps.filter { it.action == Action.CONCEAL }
}

/**
 * Plays arrivals through a jitter buffer in 10 ms render ticks, checking on every step that the
 * gain never jumps and only changes over a full ramp. Successive runs continue where the last
 * one stopped.
 */
class Player {
    val buffer = JitterBuffer()
    private var time = 0
    private var buffered = 0
    private var gain = 0f

    fun run(
        arrivals: List<Arrival>,
        until: Int,
        quiet: Boolean = false,
        stalled: IntRange = IntRange.EMPTY,
        label: String,
    ): Run {
        val run = Run()
        val pending = ArrayDeque(arrivals.filter { it.at >= time && it.at < until }.sortedBy { it.at })
        while (time < until) {
            while (pending.isNotEmpty() && pending.first().at <= time) {
                val arrival = pending.removeFirst()
                buffer.insert(
                    arrival.frame,
                    arrival.units * 480,
                    if (arrival.units == 0) byteArrayOf()
                    else byteArrayOf(arrival.units.toByte(), arrival.frame.toByte()),
                    isTerminator = arrival.terminator,
                )
            }
            if (time !in stalled) {
                while (buffered < 480) {
                    val step = buffer.next(quiet)
                    if (step == null) {
                        assertEquals("$label: went silent at gain $gain at $time", 0f, gain)
                        buffer.idle(480 - buffered)
                        buffered = 480
                        break
                    }
                    assertEquals("$label: gain jumped at $time", gain, step.gainFrom)
                    if (step.gainFrom != step.gainTo) {
                        assertTrue(
                            "$label: ${step.samples}-sample ramp at $time",
                            step.samples >= JitterBuffer.RAMP_SAMPLES,
                        )
                    }
                    gain = step.gainTo
                    run.steps.add(step.copy())
                    if (step.action == Action.PLAY) {
                        run.playedAt[step.frame] = time + buffered
                        if (run.firstPlayAt == null) run.firstPlayAt = time + buffered
                    }
                    buffered += step.samples
                }
                buffered -= 480
            }
            time += 480
        }
        run.statistics = buffer.takeStatistics()
        return run
    }
}

fun stream(
    frames: IntProgression,
    units: Int,
    terminateLast: Boolean = true,
    delay: (Int) -> Int = { 240 },
): List<Arrival> {
    val all = frames.toList()
    return all.map { frame ->
        Arrival(frame * 480 + delay(frame), frame.toLong(), units, terminateLast && frame == all.last())
    }
}

// After a steady second, packets are held back and released together every 100 ms, the way Wi-Fi
// power saving delivers them.
fun bursts(frame: Int): Int =
    if (frame < 100) 240 else (frame * 480 / 4800 + 1) * 4800 - frame * 480 + 240

val bursty = stream(0 until 3000 step 2, 2, delay = ::bursts)

class JitterBufferTest {
    @Test
    fun steady20MillisecondPacketsPlayWithoutConcealment() {
        val run = Player().run(stream(0 until 600 step 2, 2), 48 * 7000, label = "steady 20 ms")
        assertEquals(300, run.plays.size)
        assertEquals(1, run.conceals.size)
        val fade = run.conceals[0]
        assertTrue("ends with one fade-out", fade.gainTo == 0f && run.steps.last() == fade)
        assertEquals(0, run.statistics.underruns)
        assertEquals(48 * 60, run.statistics.targetSamples)
        assertTrue("started ${run.firstPlayAt} samples in", run.firstPlayAt!! - 240 <= 48 * 60)
        assertTrue(run.steps.first().resetsDecoder && run.steps.first().gainFrom == 0f)
    }

    @Test
    fun sixtyMillisecondPacketsRaiseTheFloorToTwoPackets() {
        val run = Player().run(stream(0 until 600 step 6, 6), 48 * 7000, label = "60 ms")
        assertEquals(100, run.plays.size)
        assertEquals(1, run.conceals.size)
        assertEquals(0, run.statistics.underruns)
        assertEquals(48 * 120, run.statistics.targetSamples)
    }

    @Test
    fun wifiBurstsGrowTheDelayUntilPlaybackStopsRunningDry() {
        val player = Player()
        var run = player.run(bursty, 48 * 10_000, label = "bursts")
        assertTrue("did not adapt ${run.statistics}", run.statistics.underruns > 0)
        assertTrue(run.statistics.targetSamples > 48 * 60)
        assertTrue(run.statistics.targetSamples <= JitterBuffer.CEILING_SAMPLES)
        run = player.run(bursty, 48 * 31_000, label = "bursts settled")
        assertEquals("still running dry ${run.statistics}", 0, run.statistics.underruns)
        assertEquals(0, run.statistics.concealedFrames)
        assertEquals(2998L, run.plays.last().frame)
    }

    @Test
    fun aGrownDelayIsRealisedByStretchingQuietAudio() {
        val run = Player().run(bursty, 48 * 31_000, quiet = true, label = "stretch")
        assertTrue("${run.statistics}", run.statistics.stretches > 0)
        assertEquals(2998L, run.plays.last().frame)
    }

    @Test
    fun aSingleLostPacketIsConcealedAtFullGain() {
        val run =
            Player().run(
                stream(0 until 200 step 2, 2).filter { it.frame != 40L },
                48 * 3000,
                label = "one lost",
            )
        assertEquals(99, run.plays.size)
        assertEquals(2, run.statistics.concealedFrames)
        val gap = run.conceals.first()
        assertTrue("$gap", gap.frame == 40L && gap.samples == 960 && gap.gainTo == 1f)
        assertEquals(0, run.statistics.underruns)
    }

    @Test
    fun twoLostPacketsStayAtFullGainAndThreeFadeOut() {
        var run =
            Player().run(
                stream(0 until 200 step 2, 2).filter { it.frame != 40L && it.frame != 42L },
                48 * 3000,
                label = "two lost",
            )
        assertEquals(4, run.statistics.concealedFrames)
        assertTrue(run.conceals.take(2).all { it.gainTo == 1f })

        run =
            Player().run(
                stream(0 until 200 step 2, 2).filter { it.frame !in 40L..44L },
                48 * 3000,
                label = "three lost",
            )
        // At most 40 ms at full gain, then a fade to silence before the next packet ramps back in.
        val gap = run.steps.dropWhile { it.frame < 40 }.takeWhile { it.action == Action.CONCEAL }
        val full = gap.takeWhile { it.gainTo == 1f }
        assertTrue("$gap", full.sumOf { it.samples } <= JitterBuffer.FULL_GAIN_CONCEAL_SAMPLES)
        assertEquals(0f, gap[full.size].gainTo)
        val resumed = run.plays.first { it.frame == 46L }
        assertTrue("$resumed", resumed.gainFrom == 0f && resumed.gainTo == 1f)
    }

    @Test
    fun aLossBeforeANetworkStallConcealsThenWaits() {
        val run =
            Player().run(
                stream(0 until 200 step 2, 2) { if (it >= 42) 240 + 48 * 70 else 240 }
                    .filter { it.frame != 40L },
                48 * 3000,
                label = "lost then late",
            )
        assertEquals("${run.statistics}", 1, run.statistics.underruns)
        assertEquals(0, run.statistics.late)
        assertEquals(99, run.plays.size)
    }

    @Test
    fun aReorderedPairPlaysInOrder() {
        val swapped = stream(0 until 200 step 2, 2).map { it.copy() }
        swapped[20].at = swapped[21].at + 10
        val run = Player().run(swapped, 48 * 3000, label = "reordered")
        val order = run.plays.map { it.frame }
        assertEquals(1, run.statistics.reordered)
        assertEquals(order.sorted(), order)
        assertEquals(100, order.size)
        assertEquals(0, run.statistics.concealedFrames)
    }

    @Test
    fun duplicatesPlayOnceAndLateCopiesAreDropped() {
        val packets = stream(0 until 200 step 2, 2).toMutableList()
        packets.add(Arrival(packets[20].at + 5, 40, 2))
        packets.add(Arrival(packets[40].at, 30, 2))
        val run = Player().run(packets, 48 * 3000, label = "duplicates")
        assertEquals(100, run.plays.size)
        assertEquals(1, run.statistics.duplicates)
        assertEquals(1, run.statistics.late)
    }

    @Test
    fun aNetworkStallIsSkippedInSilence() {
        // 500 ms of nothing, then everything at once: fade out, wait, skip the backlog, fade back in.
        val stalled =
            stream(0 until 600 step 2, 2) { frame ->
                if (frame in 100 until 150) (150 - frame) * 480 + 240 else 240
            }
        val run = Player().run(stalled, 48 * 7000, label = "stall")
        assertEquals("${run.statistics}", 1, run.statistics.underruns)
        assertEquals(1, run.statistics.trims)
        assertTrue(run.statistics.concealedFrames <= 5)
        val behind = run.playedAt.getValue(598) - (598 * 480 + 240)
        assertTrue("still $behind samples behind", behind <= run.statistics.targetSamples + 960)
    }

    @Test
    fun aRenderStallIsSkippedInSilence() {
        val run =
            Player().run(
                stream(0 until 600 step 2, 2),
                48 * 7000,
                stalled = 48 * 1000 until 48 * 1600,
                label = "render stall",
            )
        assertEquals("${run.statistics}", 1, run.statistics.trims)
        assertEquals(0, run.statistics.underruns)
    }

    @Test
    fun aTerminatorEndsCleanlyAndARestartedCountStartsFresh() {
        val player = Player()
        val talk =
            stream(0 until 40 step 2, 2) +
                stream(0 until 40 step 2, 2).map { it.copy(at = it.at + 48 * 1500) }
        val run = player.run(talk, 48 * 3000, label = "terminator")
        assertEquals(40, run.plays.size)
        assertEquals(2, run.steps.count { it.resetsDecoder })
        assertEquals(0, run.statistics.underruns)
        assertEquals(0, run.statistics.late)
        assertEquals(2, run.conceals.size)
        assertTrue(run.conceals.all { it.gainTo == 0f && it.samples == 480 })
        assertTrue(player.buffer.isIdle)
    }

    @Test
    fun anEmptyTerminatorEndsTheStream() {
        val player = Player()
        val talk = stream(0 until 40 step 2, 2, terminateLast = false) + Arrival(48 * 400, 40, 0, true)
        val run = player.run(talk, 48 * 1000, label = "empty terminator")
        assertEquals(20, run.plays.size)
        assertEquals(0, run.statistics.underruns)
        assertEquals(1, run.conceals.size)
        assertTrue(player.buffer.isIdle)
    }

    @Test
    fun aSecondWithNothingBufferedResets() {
        val player = Player()
        val talk = stream(0 until 40 step 2, 2, terminateLast = false)
        player.run(talk, 48 * 2000, label = "unterminated")
        assertTrue(player.buffer.isIdle)
        // A sender that restarted its count far back is a new stream, not late packets.
        val run =
            player.run(
                stream(0 until 40 step 2, 2).map { it.copy(at = it.at + 48 * 2000) },
                48 * 3000,
                label = "after reset",
            )
        assertEquals(20, run.plays.size)
        assertEquals(0, run.statistics.late)
        assertTrue(run.plays.first().resetsDecoder)
    }

    @Test
    fun aCalmNetworkShrinksTheDelayThroughQuietAudio() {
        val player = Player()
        player.run(bursty, 48 * 10_000, label = "grow")
        val grown = player.buffer.targetSamples
        val run =
            player.run(
                stream(1000 until 26_000 step 2, 2),
                48 * 260_000,
                quiet = true,
                label = "shrink",
            )
        assertTrue(
            "$grown -> ${player.buffer.targetSamples}, ${run.statistics}",
            player.buffer.targetSamples < grown,
        )
        assertTrue(run.statistics.drops > 0)
        assertEquals(0, run.statistics.underruns)
        val last = run.plays.last().frame
        val lag = run.playedAt.getValue(last) - (last.toInt() * 480 + 240)
        assertTrue("still $lag samples behind", lag <= player.buffer.targetSamples + 960)
    }

    @Test
    fun theDelayPolicyBacksOffWhenItOscillates() {
        val policy = JitterBuffer.DelayPolicy(48 * 60, 48 * 200)
        policy.grow()
        repeat(14) { assertEquals(0, policy.observe(48 * 100, 960)) }
        assertEquals(-480, policy.observe(48 * 100, 960))
        // A grow right after a shrink doubles the calm needed before the next shrink.
        policy.grow()
        repeat(29) { assertEquals(0, policy.observe(48 * 100, 960)) }
        assertEquals(-480, policy.observe(48 * 100, 960))
        assertEquals(48 * 80, policy.target)
    }
}
