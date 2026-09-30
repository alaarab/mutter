package com.alaarab.mutter.sharing

import org.junit.Assert.*
import org.junit.Test

class ScreenSharePolicyTest {
    @Test
    fun watchRequestsAllowABurstThenOnePerTwoSeconds() {
        var now = 0L
        val limiter = WatchLimiter(clock = { now })
        repeat(4) { assertTrue(limiter.allow(7)) }
        assertFalse(limiter.allow(7))
        assertTrue("another viewer has its own allowance", limiter.allow(8))
        now += 1999
        assertFalse(limiter.allow(7))
        now += 1
        assertTrue(limiter.allow(7))
        assertFalse(limiter.allow(7))
    }

    @Test
    fun forgettingDepartedViewersRestoresTheirAllowance() {
        val now = 0L
        val limiter = WatchLimiter(clock = { now })
        repeat(4) { limiter.allow(7) }
        assertFalse(limiter.allow(7))
        limiter.forgetAllExcept(setOf(8))
        assertTrue(limiter.allow(7))
    }

    @Test
    fun phoneScreensAreCappedAtTheLongestEdgeWithEvenSides() {
        assertEquals(576 to 1280, ScreenSharer.captureSize(1080, 2400))
        assertEquals(1280 to 576, ScreenSharer.captureSize(2400, 1080))
        assertEquals(720 to 1280, ScreenSharer.captureSize(1440, 2560))
        assertEquals(640 to 360, ScreenSharer.captureSize(640, 360))
        assertEquals(1280 to 590, ScreenSharer.captureSize(1600, 739))
    }
}
