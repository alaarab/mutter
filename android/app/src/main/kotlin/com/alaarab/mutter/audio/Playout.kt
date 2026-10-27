package com.alaarab.mutter.audio

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * One speaker's playout. Packets go into a [JitterBuffer] from the network thread; the playout
 * thread pulls decisions from it and decodes in playout order, so concealment happens exactly
 * when audio is due.
 *
 * MediaCodec can't run Opus packet loss concealment, so gaps are filled the way the web client
 * does: the last packet's audio is replayed, alternately reversed so each join is continuous, and
 * decays while the buffer's gain rules fade it out. The packet after a gap is crossfaded in.
 */
class Playout(private val session: Int, private val decoder: Decoder) {
    fun interface Decoder {
        /** Decodes [length] bytes of [packet] into [output] and returns the samples written, or -1. */
        fun decode(packet: ByteArray, length: Int, output: FloatArray): Int
    }

    private val jitter = JitterBuffer()

    // Owned by the playout thread.
    private val payload = ByteArray(jitter.maximumPayloadBytes)
    private val pcm = FloatArray(MAXIMUM_FRAME_SAMPLES)
    private var pcmRead = 0
    private var pcmCount = 0
    private val last = FloatArray(MAXIMUM_FRAME_SAMPLES)
    private var lastCount = 0
    private val fill = FloatArray(JitterBuffer.RAMP_SAMPLES)
    private var concealing = false
    private var concealIndex = 0
    private var concealReversed = true
    private var concealedSamples = 0
    private var lastWasQuiet = false
    private var pendingStatistics = JitterBuffer.Statistics()
    private var lastReportAt = Long.MIN_VALUE

    val isIdle: Boolean
        get() = synchronized(jitter) { jitter.isIdle }

    fun push(frame: Long, opus: ByteArray, isTerminator: Boolean) {
        val samples = if (opus.isEmpty()) 0 else opusSamples(opus) ?: return
        synchronized(jitter) {
            jitter.insert(frame, samples, opus, opus.size, isTerminator)
        }
    }

    /** Writes [frames] samples into [out] and returns how many came from the stream; the rest are silence. */
    fun render(out: FloatArray, frames: Int): Int {
        var written = 0
        while (written < frames) {
            if (pcmRead == pcmCount && !decodeNextStep()) break
            val count = min(frames - written, pcmCount - pcmRead)
            pcm.copyInto(out, written, pcmRead, pcmRead + count)
            pcmRead += count
            written += count
        }
        if (written < frames) {
            out.fill(0f, written, frames)
            synchronized(jitter) { jitter.idle(frames - written) }
        }
        return written
    }

    /** Takes the next decision from the jitter buffer and decodes it into [pcm] with its gain ramp applied. */
    private fun decodeNextStep(): Boolean {
        pcmRead = 0
        pcmCount = 0
        val action: JitterBuffer.Action
        val samples: Int
        val gainFrom: Float
        val gainTo: Float
        val resets: Boolean
        var length = 0
        synchronized(jitter) {
            val step = jitter.next(lastWasQuiet) ?: return false
            action = step.action
            samples = min(step.samples, pcm.size)
            gainFrom = step.gainFrom
            gainTo = step.gainTo
            resets = step.resetsDecoder
            if (action == JitterBuffer.Action.PLAY) length = jitter.copyPayload(step.slot, payload)
        }
        // A new utterance must not conceal with, or crossfade from, the previous one's audio.
        if (resets) {
            lastCount = 0
            concealing = false
        }

        if (action == JitterBuffer.Action.PLAY) {
            var decoded = decoder.decode(payload, length, pcm)
            // Keep time even if a packet is corrupt or short; the silence is ramped like everything else.
            if (decoded < 0) decoded = 0
            decoded = min(decoded, samples)
            pcm.fill(0f, decoded, samples)
            var energy = 0f
            for (index in 0 until decoded) energy += pcm[index] * pcm[index]
            lastWasQuiet = decoded > 0 && sqrt(energy / decoded) < QUIET_RMS
            // Resuming from silence the gain ramp already fades in; crossfading as well would be too steep.
            if (concealing && gainFrom > 0f) {
                val overlap = min(fill.size, samples)
                conceal(fill, overlap)
                for (index in 0 until overlap) {
                    val mix = RAMP[index]
                    pcm[index] = fill[index] * (1 - mix) + pcm[index] * mix
                }
            }
            concealing = false
            pcm.copyInto(last, 0, 0, samples)
            lastCount = samples
        } else {
            if (!concealing) {
                concealing = true
                concealIndex = 0
                concealReversed = true
                concealedSamples = 0
            }
            conceal(pcm, samples)
        }

        val delta = gainTo - gainFrom
        val rampLength = if (delta == 0f) 0 else min(samples, RAMP.size)
        for (index in 0 until rampLength) pcm[index] *= gainFrom + delta * RAMP[index]
        if (gainTo != 1f) for (index in rampLength until samples) pcm[index] *= gainTo
        pcmCount = samples
        return true
    }

    /** Continues the last packet's audio, mirrored on every pass, with a decaying envelope. */
    private fun conceal(output: FloatArray, count: Int) {
        if (lastCount == 0) {
            output.fill(0f, 0, count)
            return
        }
        for (index in 0 until count) {
            val source = if (concealReversed) last[lastCount - 1 - concealIndex] else last[concealIndex]
            val envelope =
                max(CONCEAL_FLOOR, 1 - (1 - CONCEAL_FLOOR) * concealedSamples / CONCEAL_DECAY_SAMPLES)
            output[index] = source * envelope
            concealedSamples += 1
            if (++concealIndex == lastCount) {
                concealIndex = 0
                concealReversed = !concealReversed
            }
        }
    }

    /**
     * Called from the playout thread about once a second. Returns a log line when something went
     * wrong, at most once per [REPORT_INTERVAL_MILLIS], carrying counts over in between.
     */
    fun diagnosticsSummary(nowMillis: Long): String? {
        val latest = synchronized(jitter) { jitter.takeStatistics() }
        val pending = pendingStatistics
        pending.underruns += latest.underruns
        pending.concealedFrames += latest.concealedFrames
        pending.late += latest.late
        pending.duplicates += latest.duplicates
        pending.reordered += latest.reordered
        pending.trims += latest.trims
        pending.drops += latest.drops
        pending.stretches += latest.stretches
        pending.targetSamples = latest.targetSamples
        latest.lowestBufferedSamples?.let { low ->
            pending.lowestBufferedSamples = min(pending.lowestBufferedSamples ?: low, low)
        }
        if (
            !pending.hasEvents ||
                (lastReportAt != Long.MIN_VALUE &&
                    nowMillis - lastReportAt < REPORT_INTERVAL_MILLIS)
        )
            return null
        lastReportAt = nowMillis
        pendingStatistics = JitterBuffer.Statistics()
        val parts =
            listOf(
                    "underruns" to pending.underruns,
                    "concealed 10ms" to pending.concealedFrames,
                    "late" to pending.late,
                    "dup" to pending.duplicates,
                    "reordered" to pending.reordered,
                    "trims" to pending.trims,
                    "quiet drops" to pending.drops,
                    "stretches" to pending.stretches,
                )
                .filter { it.second > 0 }
                .map { "${it.first} ${it.second}" }
                .toMutableList()
        parts.add("target ${pending.targetSamples / 48} ms")
        pending.lowestBufferedSamples?.let { parts.add("low ${it / 48} ms") }
        return "Playout session $session: " + parts.joinToString(", ")
    }

    companion object {
        const val MAXIMUM_FRAME_SAMPLES = 5760
        const val REPORT_INTERVAL_MILLIS = 5000L
        // About -46 dBFS: background hiss after noise suppression, where a dropped or stretched frame is inaudible.
        private const val QUIET_RMS = 0.005f
        // The web client's concealment: decay to 40% over the full-gain period, then the buffer fades it out.
        private const val CONCEAL_FLOOR = 0.4f
        private const val CONCEAL_DECAY_SAMPLES = JitterBuffer.FULL_GAIN_CONCEAL_SAMPLES.toFloat()

        /** A 10 ms raised-cosine ramp from just above 0 to 1. */
        val RAMP =
            FloatArray(JitterBuffer.RAMP_SAMPLES) { index ->
                val phase = (index + 1).toFloat() / JitterBuffer.RAMP_SAMPLES
                (0.5 - 0.5 * cos(PI * phase)).toFloat()
            }

        /** Samples at 48 kHz in an Opus packet, from its TOC byte (RFC 6716 section 3.1), or null if invalid. */
        fun opusSamples(packet: ByteArray): Int? {
            if (packet.isEmpty()) return null
            val toc = packet[0].toInt() and 0xff
            val config = toc shr 3
            // Frame length in 1/8 ms at 48 kHz: SILK 10/20/40/60, hybrid 10/20, CELT 2.5/5/10/20.
            val eighths =
                when {
                    config < 12 -> intArrayOf(80, 160, 320, 480)[config % 4]
                    config < 16 -> intArrayOf(80, 160)[config % 2]
                    else -> intArrayOf(20, 40, 80, 160)[config % 4]
                }
            val frames =
                when (toc and 3) {
                    0 -> 1
                    1,
                    2 -> 2
                    else -> if (packet.size < 2) return null else packet[1].toInt() and 0x3f
                }
            val samples = frames * eighths * 6
            return if (frames == 0 || samples > MAXIMUM_FRAME_SAMPLES) null else samples
        }
    }
}
