package com.alaarab.mutter.audio

import kotlin.math.max
import kotlin.math.min

/**
 * Decides, one playout step at a time, what a speaker's stream should play next. It knows nothing
 * about Opus, clocks or audio hardware, allocates nothing after construction and is deterministic,
 * so the playout thread can drive it under a lock and tests can replay network conditions exactly.
 *
 * Positions are Mumble frame numbers (10 ms units) and delays are 48 kHz samples. The delay adapts
 * like the web client's JitterPolicy, and every change in output gain is a ramp, so starts, stops,
 * losses and skips never step. This is the iOS JitterBuffer without the FEC step: Android's
 * MediaCodec Opus decoder can't decode in-band FEC, so every gap is concealed.
 */
class JitterBuffer(slotCount: Int = 64, val maximumPayloadBytes: Int = 1500) {
    enum class Action {
        /** Decode the packet in [Step.slot]. */
        PLAY,
        /** Continue the waveform without a packet. */
        CONCEAL,
    }

    /** The gain ramps from [gainFrom] to [gainTo] over the first [RAMP_SAMPLES] of the step. */
    data class Step(
        var action: Action = Action.CONCEAL,
        var slot: Int = -1,
        var frame: Long = 0,
        var samples: Int = 0,
        var gainFrom: Float = 0f,
        var gainTo: Float = 0f,
        var resetsDecoder: Boolean = false,
    )

    data class Statistics(
        var underruns: Int = 0,
        var concealedFrames: Int = 0,
        var late: Int = 0,
        var duplicates: Int = 0,
        var reordered: Int = 0,
        var trims: Int = 0,
        var drops: Int = 0,
        var stretches: Int = 0,
        var targetSamples: Int = 0,
        var lowestBufferedSamples: Int? = null,
    ) {
        val hasEvents: Boolean
            get() =
                underruns + concealedFrames + late + duplicates + reordered + trims + drops +
                    stretches > 0
    }

    /**
     * The web client's adaptive delay: grow quickly when playback runs dry or nearly so, shrink
     * slowly after a calm stretch, and double the calm needed whenever a shrink is followed by
     * another grow.
     */
    class DelayPolicy(minimum: Int, maximum: Int) {
        var minimum = minimum
            private set

        var maximum = max(maximum, minimum)
            private set

        var target = minimum
            private set

        private var calmWindows = 0
        private var requiredCalmWindows = BASE_CALM_WINDOWS
        private var shrankLast = false

        fun setMinimum(newMinimum: Int) {
            minimum = newMinimum
            maximum = max(maximum, newMinimum)
            target = min(maximum, max(target, newMinimum))
        }

        /** Returns the samples added to the target. */
        fun grow(): Int {
            if (shrankLast) requiredCalmWindows = min(MAXIMUM_CALM_WINDOWS, requiredCalmWindows * 2)
            shrankLast = false
            calmWindows = 0
            val previous = target
            target = min(maximum, target + GROW_SAMPLES)
            return target - previous
        }

        /**
         * Called once per second of playout with the lowest level the buffer reached, or [NONE].
         * Returns the change in target.
         */
        fun observe(lowWater: Int, cushion: Int): Int {
            if (lowWater != NONE && lowWater < DANGER_SAMPLES) return grow()
            calmWindows += 1
            if (
                calmWindows < requiredCalmWindows ||
                    target <= minimum ||
                    lowWater == NONE ||
                    lowWater < SHRINK_SAMPLES + cushion
            )
                return 0
            if (shrankLast) requiredCalmWindows = max(BASE_CALM_WINDOWS, requiredCalmWindows / 2)
            val previous = target
            target = max(minimum, target - SHRINK_SAMPLES)
            calmWindows = 0
            shrankLast = true
            return target - previous
        }

        companion object {
            const val GROW_SAMPLES = 48 * 20
            const val SHRINK_SAMPLES = 48 * 10
            const val DANGER_SAMPLES = 48 * 10
            const val BASE_CALM_WINDOWS = 15
            const val MAXIMUM_CALM_WINDOWS = 240
        }
    }

    private enum class State {
        IDLE,
        BUFFERING,
        PLAYING,
    }

    private val slotFrames = LongArray(slotCount)
    private val slotUnits = IntArray(slotCount)
    private val slotLengths = IntArray(slotCount)
    private val slotTerminators = BooleanArray(slotCount)
    private val slotUsed = BooleanArray(slotCount)
    private val payloads = ByteArray(slotCount * maximumPayloadBytes)
    private val step = Step()

    private var state = State.IDLE
    private var position = 0L
    private var newestFrame = -1L
    private var gain = 0f
    private var packetUnits = 2
    private var lossRunSamples = 0
    private var isDry = false
    private var waitedSamples = 0
    private var endPending = false
    private var restartPending = false
    private var resetDecoderOnStart = true
    private var hasPlayed = false
    private var stretchDebt = 0
    private var lateInWindow = false
    private var playedInWindow = 0
    private var windowLow = NONE
    private var recentLow = NONE
    private var lowest = NONE
    private val policy = DelayPolicy(FLOOR_SAMPLES, CEILING_SAMPLES)
    private var statistics = Statistics()

    val targetSamples: Int
        get() = policy.target

    val packetSamples: Int
        get() = packetUnits * UNIT_SAMPLES

    val isIdle: Boolean
        get() = state == State.IDLE || (state == State.BUFFERING && earliestSlot() < 0)

    val bufferedSamples: Int
        get() = (newestEnd() - position).toInt() * UNIT_SAMPLES

    private val minimumTarget: Int
        get() = max(FLOOR_SAMPLES, 2 * packetSamples)

    private val fullGainLimit: Int
        get() = max(FULL_GAIN_CONCEAL_SAMPLES, packetSamples)

    // Network side

    fun insert(
        frame: Long,
        samples: Int,
        payload: ByteArray,
        length: Int = payload.size,
        isTerminator: Boolean = false,
    ) {
        if (frame < 0 || length > maximumPayloadBytes || (length == 0 && !isTerminator)) return
        val units = if (length == 0) 0 else max(1, (samples + UNIT_SAMPLES - 1) / UNIT_SAMPLES)
        if (units > 0 && units != packetUnits) {
            packetUnits = units
            policy.setMinimum(minimumTarget)
        }

        when (state) {
            State.IDLE -> {
                // A straggler from the stream that just ended must not start a new one.
                if (
                    hasPlayed &&
                        frame < position &&
                        position - frame <= LATE_TOLERANCE_UNITS &&
                        waitedSamples < RESTART_AFTER_SAMPLES
                ) {
                    statistics.late += 1
                    return
                }
                begin(frame)
            }
            State.BUFFERING,
            State.PLAYING ->
                if (state == State.BUFFERING && !hasPlayed && frame < position) {
                    if (position - frame <= LATE_TOLERANCE_UNITS) position = frame else restart(frame)
                } else if (frame < position) {
                    if (position - frame <= LATE_TOLERANCE_UNITS) {
                        statistics.late += 1
                        lateInWindow = true
                        return
                    }
                    restart(frame)
                } else if (frame > newestEnd() + LATE_TOLERANCE_UNITS) {
                    restart(frame)
                }
        }

        if (slotAt(frame) >= 0) {
            statistics.duplicates += 1
            return
        }
        if (state == State.BUFFERING && earliestSlot() < 0) waitedSamples = 0
        if (newestFrame >= 0 && frame < newestFrame) statistics.reordered += 1
        newestFrame = if (newestFrame < 0) frame else max(newestFrame, frame)

        var index = slotUsed.indexOfFirst { !it }
        if (index < 0) {
            // Only reachable when far more than the ceiling is queued; the oldest packet is the one to lose.
            index = earliestSlot()
            statistics.trims += 1
        }
        slotFrames[index] = frame
        slotUnits[index] = units
        slotLengths[index] = length
        slotTerminators[index] = isTerminator
        slotUsed[index] = true
        payload.copyInto(payloads, index * maximumPayloadBytes, 0, length)
    }

    /** Copies the payload of [slot] into [output] and returns its length. */
    fun copyPayload(slot: Int, output: ByteArray): Int {
        val length = slotLengths[slot]
        val start = slot * maximumPayloadBytes
        payloads.copyInto(output, 0, start, start + length)
        return length
    }

    fun takeStatistics(): Statistics {
        val taken = statistics
        taken.targetSamples = policy.target
        taken.lowestBufferedSamples = if (lowest == NONE) null else lowest
        statistics = Statistics()
        lowest = NONE
        return taken
    }

    // Playout side

    /** Time passed in which this stream produced nothing. */
    fun idle(samples: Int) {
        if (state == State.PLAYING) return
        waitedSamples = min(waitedSamples + samples, SECOND_SAMPLES)
        if (state == State.BUFFERING && earliestSlot() < 0 && waitedSamples >= SECOND_SAMPLES) {
            becomeIdle()
        }
    }

    /**
     * The next thing to play, or null while idle or buffering. [quiet] says whether the last
     * decoded audio was near silence, the only time the delay is changed mid-stream. The returned
     * step is reused by the next call.
     */
    fun next(quiet: Boolean): Step? {
        while (true) {
            when (state) {
                State.IDLE -> return null
                State.BUFFERING -> {
                    val earliest = earliestSlot()
                    if (earliest < 0) return null
                    if (slotFrames[earliest] > position + packetUnits) {
                        position = slotFrames[earliest]
                    }
                    val terminated = hasTerminator()
                    val buffered = bufferedSamples
                    if (
                        buffered < policy.target &&
                            !terminated &&
                            waitedSamples < 2 * policy.target
                    )
                        return null
                    // A burst after a stall would otherwise play late for good. A finished utterance plays whole.
                    if (
                        !terminated &&
                            buffered > policy.target + max(packetSamples, START_SLACK_SAMPLES)
                    )
                        skipToTarget()
                    state = State.PLAYING
                    hasPlayed = true
                    stretchDebt = 0
                    lossRunSamples = 0
                    isDry = false
                }
                State.PLAYING -> {
                    if (restartPending) {
                        if (gain > 0) return fadeOut()
                        restartPending = false
                        resetDecoderOnStart = true
                        hasPlayed = false
                        state = State.BUFFERING
                        waitedSamples = 0
                        continue
                    }
                    if (bufferedSamples > SKIP_ABOVE_SAMPLES) {
                        if (gain > 0) return fadeOut()
                        skipToTarget()
                    }
                    if (endPending) {
                        if (slotAt(position) >= 0) {
                            endPending = false
                        } else if (gain > 0) {
                            return fadeOut()
                        } else {
                            becomeIdle()
                            return null
                        }
                    }

                    val index = slotAt(position)
                    if (index >= 0) {
                        val units = slotUnits[index]
                        if (units == 0) {
                            slotUsed[index] = false
                            endPending = slotTerminators[index]
                            continue
                        }
                        if (quiet && gain > 0 && stretchDebt > 0) {
                            stretchDebt -= UNIT_SAMPLES
                            statistics.stretches += 1
                            return makeStep(Action.CONCEAL, -1, UNIT_SAMPLES, gain)
                        }
                        if (quiet && canDrop(index)) {
                            slotUsed[index] = false
                            position += units
                            val dropped = units * UNIT_SAMPLES
                            if (recentLow != NONE) recentLow -= dropped
                            if (windowLow != NONE) windowLow -= dropped
                            statistics.drops += 1
                            continue
                        }
                        slotUsed[index] = false
                        val step = makeStep(Action.PLAY, index, units * UNIT_SAMPLES, 1f)
                        position += units
                        endPending = slotTerminators[index]
                        lossRunSamples = 0
                        isDry = false
                        noteBufferedLevel()
                        return step
                    }

                    val later = earliestSlot()
                    if (later >= 0) {
                        // A packet is missing but later ones are here: conceal the gap a packet at a time.
                        val gap = (slotFrames[later] - position).toInt()
                        val units = min(packetUnits, gap)
                        statistics.concealedFrames += units
                        val step = conceal(units * UNIT_SAMPLES)
                        position += units
                        return step
                    }

                    // Nothing has arrived: hold the position and conceal, so a packet that is merely late still plays.
                    if (!isDry) {
                        isDry = true
                        statistics.underruns += 1
                        policy.grow()
                    }
                    if (gain == 0f) {
                        state = State.BUFFERING
                        waitedSamples = 0
                        return null
                    }
                    statistics.concealedFrames += 1
                    return conceal(UNIT_SAMPLES)
                }
            }
        }
    }

    // Helpers

    private fun newestEnd(): Long {
        var end = position
        for (index in slotUsed.indices) {
            if (slotUsed[index]) end = max(end, slotFrames[index] + slotUnits[index])
        }
        return end
    }

    private fun slotAt(frame: Long): Int {
        for (index in slotUsed.indices) {
            if (slotUsed[index] && slotFrames[index] == frame) return index
        }
        return -1
    }

    private fun hasTerminator(): Boolean {
        for (index in slotUsed.indices) {
            if (slotUsed[index] && slotTerminators[index]) return true
        }
        return false
    }

    private fun earliestSlot(): Int {
        var earliest = -1
        for (index in slotUsed.indices) {
            if (slotUsed[index] && (earliest < 0 || slotFrames[index] < slotFrames[earliest])) {
                earliest = index
            }
        }
        return earliest
    }

    private fun makeStep(action: Action, slot: Int, samples: Int, gainTo: Float): Step {
        step.action = action
        step.slot = slot
        step.frame = position
        step.samples = samples
        step.gainFrom = gain
        step.gainTo = gainTo
        step.resetsDecoder = resetDecoderOnStart
        resetDecoderOnStart = false
        gain = gainTo
        notePlayed(samples)
        return step
    }

    private fun conceal(samples: Int): Step {
        lossRunSamples += samples
        return makeStep(
            Action.CONCEAL,
            -1,
            samples,
            if (lossRunSamples <= fullGainLimit) gain else 0f,
        )
    }

    /** Concealment continues the waveform, so fading it out ends playback without a step. */
    private fun fadeOut(): Step = makeStep(Action.CONCEAL, -1, UNIT_SAMPLES, 0f)

    /**
     * Dropping a quiet packet shortens the delay only when the buffer has stayed above target for
     * the last second and the packet after it is already here.
     */
    private fun canDrop(index: Int): Boolean {
        if (gain == 0f || recentLow == NONE) return false
        val units = slotUnits[index]
        if (slotAt(slotFrames[index] + units) < 0) return false
        val low = min(recentLow, windowLow)
        return low - units * UNIT_SAMPLES >= policy.target - packetSamples
    }

    /** Only called while silent, so jumping the read position is inaudible. */
    private fun skipToTarget() {
        val targetUnits = ((policy.target + UNIT_SAMPLES - 1) / UNIT_SAMPLES).toLong()
        val end = newestEnd()
        val keepFrom = if (end > targetUnits) end - targetUnits else 0L
        var resume = -1
        for (index in slotUsed.indices) {
            if (
                slotUsed[index] &&
                    slotFrames[index] >= keepFrom &&
                    (resume < 0 || slotFrames[index] < slotFrames[resume])
            )
                resume = index
        }
        if (resume < 0) {
            for (index in slotUsed.indices) {
                if (slotUsed[index] && (resume < 0 || slotFrames[index] > slotFrames[resume])) {
                    resume = index
                }
            }
        }
        if (resume < 0 || slotFrames[resume] <= position) return
        val start = slotFrames[resume]
        for (index in slotUsed.indices) {
            if (slotUsed[index] && slotFrames[index] < start) slotUsed[index] = false
        }
        position = start
        statistics.trims += 1
    }

    private fun noteBufferedLevel() {
        val level = bufferedSamples
        windowLow = min(windowLow, level)
        lowest = min(lowest, level)
    }

    private fun notePlayed(samples: Int) {
        playedInWindow += samples
        if (playedInWindow < SECOND_SAMPLES) return
        playedInWindow -= SECOND_SAMPLES
        // Low water only means something once the buffer has actually caught up with the last increase.
        var change = 0
        if (lateInWindow) {
            change = policy.grow()
        } else if (stretchDebt == 0) {
            change = policy.observe(windowLow, packetSamples)
        }
        if (change > 0 && !isDry) stretchDebt += change
        lateInWindow = false
        recentLow = windowLow
        windowLow = NONE
    }

    private fun begin(frame: Long) {
        clearSlots()
        state = State.BUFFERING
        position = frame
        waitedSamples = 0
        resetDecoderOnStart = true
        hasPlayed = false
    }

    private fun restart(frame: Long) {
        clearSlots()
        endPending = false
        stretchDebt = 0
        position = frame
        if (state == State.PLAYING && gain > 0) {
            restartPending = true
        } else {
            state = State.BUFFERING
            waitedSamples = 0
            resetDecoderOnStart = true
            hasPlayed = false
        }
    }

    private fun becomeIdle() {
        clearSlots()
        state = State.IDLE
        waitedSamples = 0
        gain = 0f
        endPending = false
        restartPending = false
        isDry = false
        lossRunSamples = 0
        stretchDebt = 0
        windowLow = NONE
        recentLow = NONE
        playedInWindow = 0
        lateInWindow = false
    }

    private fun clearSlots() {
        slotUsed.fill(false)
        newestFrame = -1
    }

    companion object {
        const val UNIT_SAMPLES = 480
        const val RAMP_SAMPLES = 480
        const val SECOND_SAMPLES = 48_000

        // 60 ms keeps two 20 ms packets in hand, the most common Mumble packet size, and matches the web
        // client's floor. Two packets of the sender's own length are the real minimum: one playing and one
        // in flight.
        const val FLOOR_SAMPLES = 48 * 60
        // Past 200 ms conversation starts to talk over itself; occasional concealment is the better trade.
        const val CEILING_SAMPLES = 48 * 200
        // A buffer this deep while playing means the playout thread stalled while packets kept coming.
        const val SKIP_ABOVE_SAMPLES = 48 * 400
        // Extra delay tolerated when starting; the rest is shed later by dropping quiet packets.
        const val START_SLACK_SAMPLES = 48 * 100
        // Repeating the last packet sounds natural for a few tens of milliseconds; after that it buzzes, so fade out.
        const val FULL_GAIN_CONCEAL_SAMPLES = 48 * 40
        const val LATE_TOLERANCE_UNITS = 100L
        // An earlier frame number this long after the last stream ended is a sender that restarted its count.
        const val RESTART_AFTER_SAMPLES = 48 * 200

        /** No level recorded yet; larger than any real level so `min` replaces it. */
        const val NONE = Int.MAX_VALUE
    }
}
