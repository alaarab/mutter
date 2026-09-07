package com.alaarab.mutter

import android.Manifest
import android.content.pm.PackageManager
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.Lifecycle
import androidx.test.platform.app.InstrumentationRegistry
import com.alaarab.mutter.data.Server
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

class DeniedPermissionsTest {
    @get:Rule val ui = createAndroidComposeRule<MainActivity>()

    @Test
    fun deniedMicrophoneAndNotificationsStillAllowConnectionAndChat() {
        assumeTrue(
            InstrumentationRegistry.getArguments().getString("mumbleDeniedPermissions") == "true"
        )
        val app = ui.activity.application as MutterApplication
        assertEquals(
            PackageManager.PERMISSION_DENIED,
            app.checkSelfPermission(Manifest.permission.RECORD_AUDIO),
        )
        val host = InstrumentationRegistry.getArguments().getString("mumbleHost") ?: "10.0.2.2"
        try {
            ui.runOnIdle {
                app.connect(
                    Server(
                        id = "denied-permissions-test",
                        host = host,
                        port = 64740,
                        username = "DeniedPermissions",
                    )
                )
            }
            ui.waitUntil(15000) { app.client.state.value.certificate != null }
            ui.runOnIdle { app.client.answerTrust(true) }
            ui.waitUntil(15000) { app.client.state.value.connected }
            ui.onNodeWithText("Microphone off").assertIsDisplayed()
            ui.onNodeWithText("Chat", useUnmergedTree = true).performClick()
            ui.onNodeWithText("Say something…")
                .performTextInput("Chat without microphone permission")
            ui.onNodeWithContentDescription("Send message").performClick()
            ui.waitUntil(5000) {
                app.client.state.value.messages.any {
                    it.html == "Chat without microphone permission"
                }
            }
            assertFalse(app.audio.transmitting.value)
            assertTrue(app.client.state.value.connected)
            val session = app.client.state.value.me
            ui.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
            InstrumentationRegistry.getInstrumentation()
                .uiAutomation
                .grantRuntimePermission(
                    "com.alaarab.mutter",
                    Manifest.permission.RECORD_AUDIO,
                )
            ui.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
            ui.onNodeWithText("Microphone off").assertDoesNotExist()
            ui.onNodeWithTag("talkButton").performTouchInput { down(center) }
            ui.waitUntil(10000) { app.audio.transmitting.value }
            ui.onNodeWithTag("talkButton").performTouchInput { up() }
            ui.waitUntil(5000) { !app.audio.transmitting.value }
            assertEquals(session, app.client.state.value.me)
        } finally {
            ui.runOnIdle {
                app.disconnect()
                app.store.deleteServer("denied-permissions-test")
            }
        }
    }
}
