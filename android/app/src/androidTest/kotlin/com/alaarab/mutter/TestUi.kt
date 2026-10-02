package com.alaarab.mutter

import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.compose.ui.test.junit4.AndroidComposeTestRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.platform.app.InstrumentationRegistry

fun describeActiveWindow(): String {
    fun describe(node: AccessibilityNodeInfo?): String {
        if (node == null) return "No active window"
        return "${node.viewIdResourceName}: ${node.text}\n" +
            (0 until node.childCount).joinToString("\n") { describe(node.getChild(it)) }
    }
    return describe(InstrumentationRegistry.getInstrumentation().uiAutomation.rootInActiveWindow)
}

fun grantLocalNetworkPermission() {
    if (android.os.Build.VERSION.SDK_INT >= 37) {
        InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(
            "com.alaarab.mutter", android.Manifest.permission.ACCESS_LOCAL_NETWORK,
        )
    }
}

fun MutterApplication.forgetTestServers(host: String) {
    store.servers.value
        .filter { it.host == host && it.port in 64740..64746 }
        .forEach { store.deleteServer(it.id) }
}

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
