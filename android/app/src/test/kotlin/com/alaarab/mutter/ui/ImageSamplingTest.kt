package com.alaarab.mutter.ui

import org.junit.Assert.*
import org.junit.Test

class ImageSamplingTest {
    @Test
    fun decodedImagesNeverExceedTheTargetSize() {
        for ((width, height) in
            listOf(1 to 1, 1280 to 720, 1281 to 1, 2559 to 1440, 4000 to 3000, 30000 to 30000, 1 to 100000)) {
            val sampleSize = sampleSizeFor(width, height, 1280)
            assertEquals(0, sampleSize and (sampleSize - 1))
            assertTrue("$width x $height", maxOf(width, height) / sampleSize <= 1280)
        }
    }

    @Test
    fun smallImagesAreNotDownsampled() {
        assertEquals(1, sampleSizeFor(1280, 1280, 1280))
        assertEquals(2, sampleSizeFor(2559, 100, 1280))
    }
}
