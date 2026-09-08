package com.alaarab.mutter

import android.view.KeyEvent
import androidx.compose.ui.test.junit4.AndroidComposeTestRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.platform.app.InstrumentationRegistry

fun AndroidComposeTestRule<*, MainActivity>.dismissKeyboard() {
    fun visible() =
        ViewCompat.getRootWindowInsets(activity.window.decorView)
            ?.isVisible(WindowInsetsCompat.Type.ime()) == true
    if (runOnIdle { visible() }) {
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        waitUntil(5000) { !visible() }
    }
    waitUntil(5000) {
        onAllNodesWithTag("sessionNavigation").fetchSemanticsNodes().isNotEmpty()
    }
    waitForIdle()
}
