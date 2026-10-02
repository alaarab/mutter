package com.alaarab.mutter.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.unit.DpSize

@Composable
internal fun windowSizeDp(): DpSize {
    val size = LocalWindowInfo.current.containerSize
    return with(LocalDensity.current) { DpSize(size.width.toDp(), size.height.toDp()) }
}
