package com.alaarab.mutter.sharing

class WatchLimiter(
    private val burst: Double = 4.0,
    private val ratePerSecond: Double = 0.5,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private class Bucket(var tokens: Double, var refilledAt: Long)

    private val buckets = mutableMapOf<Int, Bucket>()

    fun allow(viewer: Int): Boolean {
        val now = clock()
        val bucket = buckets.getOrPut(viewer) { Bucket(burst, now) }
        val elapsedSeconds = (now - bucket.refilledAt).coerceAtLeast(0) / 1000.0
        bucket.tokens = minOf(burst, bucket.tokens + elapsedSeconds * ratePerSecond)
        bucket.refilledAt = now
        if (bucket.tokens < 1) return false
        bucket.tokens -= 1
        return true
    }

    fun forgetAllExcept(present: Set<Int>) {
        buckets.keys.retainAll(present)
    }

    fun clear() {
        buckets.clear()
    }
}
