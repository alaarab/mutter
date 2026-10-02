package com.alaarab.mutter

import android.Manifest
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.pm.PackageManager
import android.view.accessibility.AccessibilityNodeInfo
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.test.filters.SdkSuppress
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

@SdkSuppress(minSdkVersion = 37)
class LocalNetworkPermissionTest {
    @get:Rule val ui = createAndroidComposeRule<MainActivity>()

    @Test
    fun discoveryExplainsMissingPermissionAndRequestsIt() {
        val app = ui.activity.application as MutterApplication
        // Run on a fresh install, or revoke Nearby devices before launching instrumentation.
        assumeTrue(app.checkSelfPermission(Manifest.permission.ACCESS_LOCAL_NETWORK) == PackageManager.PERMISSION_DENIED)
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        automation.serviceInfo = automation.serviceInfo.apply {
            flags = flags or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
        }
        fun allowButton(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
            if (node == null) return null
            // Google and AOSP images use different permission-controller package names.
            if (node.viewIdResourceName?.substringAfterLast('/') in
                setOf("permission_allow_button", "permission_allow_foreground_only_button")
            ) return node
            for (index in 0 until node.childCount) {
                allowButton(node.getChild(index))?.let { return it }
            }
            return null
        }
        ui.onNodeWithContentDescription("Public servers").performClick()
        ui.onNodeWithText("Local network").performClick()
        ui.onNodeWithText("Allow local network").performScrollTo().performClick()
        var allow: AccessibilityNodeInfo? = null
        try {
            ui.waitUntil(10000) {
                allow = allowButton(automation.rootInActiveWindow)
                allow != null
            }
        } catch (failure: ComposeTimeoutException) {
            throw AssertionError(describeActiveWindow(), failure)
        }
        assertTrue(allow!!.performAction(AccessibilityNodeInfo.ACTION_CLICK))
        ui.waitUntil(10000) {
            app.checkSelfPermission(Manifest.permission.ACCESS_LOCAL_NETWORK) == PackageManager.PERMISSION_GRANTED
        }
        ui.onNodeWithText("Allow local network").assertDoesNotExist()
        ui.onNodeWithText("Listening nearby").assertExists()
    }
}
