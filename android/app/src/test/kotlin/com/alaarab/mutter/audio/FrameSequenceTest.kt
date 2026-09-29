package com.alaarab.mutter.audio

import org.junit.Assert.*
import org.junit.Test

class FrameSequenceTest {
    @Test
    fun duplicateAndOlderFramesAreDroppedWhileTalking() {
        val sequence = FrameSequence()
        assertTrue(sequence.accept(10, now = 0))
        assertTrue(sequence.accept(12, now = 20))
        assertFalse(sequence.accept(12, now = 40))
        assertFalse(sequence.accept(11, now = 60))
        assertTrue(sequence.accept(14, now = 80))
    }

    @Test
    fun endOfSpeechAllowsTheSenderToRestartItsCounter() {
        val sequence = FrameSequence()
        assertTrue(sequence.accept(5000, now = 0))
        sequence.end()
        assertTrue(sequence.accept(0, now = 20))
        assertTrue(sequence.accept(2, now = 40))
    }

    @Test
    fun aPauseAllowsTheSenderToRestartItsCounter() {
        val sequence = FrameSequence()
        assertTrue(sequence.accept(100, now = 0))
        assertFalse(sequence.accept(90, now = 150))
        assertTrue(sequence.accept(90, now = 400))
    }

    @Test
    fun aFrameFarBehindIsTreatedAsARestart() {
        val sequence = FrameSequence()
        assertTrue(sequence.accept(5000, now = 0))
        assertFalse(sequence.accept(4960, now = 20))
        assertTrue(sequence.accept(3, now = 40))
        assertTrue(sequence.accept(5, now = 60))
    }
}
