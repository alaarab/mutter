package com.alaarab.mutter.audio

class FrameSequence(
    private val restartAfterSilenceMillis: Long = 200,
    private val restartWhenBehindBy: Long = 50,
) {
    private var lastFrame = -1L
    private var lastAcceptedAt = 0L

    fun accept(frame: Long, now: Long): Boolean {
        val quietSinceLastFrame = lastFrame >= 0 && now - lastAcceptedAt > restartAfterSilenceMillis
        val farBehindLastFrame = frame < lastFrame - restartWhenBehindBy
        if (quietSinceLastFrame || farBehindLastFrame) lastFrame = -1
        if (frame <= lastFrame) return false
        lastFrame = frame
        lastAcceptedAt = now
        return true
    }

    fun end() {
        lastFrame = -1
    }
}
