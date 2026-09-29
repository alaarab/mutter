package com.alaarab.mutter.ui

fun sampleSizeFor(width: Int, height: Int, longestSide: Int): Int {
    var sampleSize = 1
    while (maxOf(width, height) / sampleSize > longestSide) sampleSize *= 2
    return sampleSize
}
