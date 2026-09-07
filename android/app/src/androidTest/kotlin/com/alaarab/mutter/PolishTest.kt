package com.alaarab.mutter

import android.graphics.Bitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.alaarab.mutter.data.Server
import com.alaarab.mutter.data.Settings
import com.alaarab.mutter.ui.ThemeCatalog
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test

class PolishTest {
    @get:Rule val ui = createAndroidComposeRule<MainActivity>()
    private val app
        get() = ui.activity.application as MutterApplication

    private lateinit var original: Settings
    private val arguments
        get() = InstrumentationRegistry.getArguments()

    @Before
    fun setup() {
        original = app.store.settings.value
        ui.runOnIdle {
            app.disconnect()
            app.store.saveSettings(
                original.copy(theme = "plum", appearance = "dark", voiceMode = "ptt")
            )
        }
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        automation.grantRuntimePermission("com.alaarab.mutter", "android.permission.RECORD_AUDIO")
        if (android.os.Build.VERSION.SDK_INT >= 33)
            automation.grantRuntimePermission(
                "com.alaarab.mutter",
                "android.permission.POST_NOTIFICATIONS",
            )
        if (android.os.Build.VERSION.SDK_INT >= 31)
            automation.grantRuntimePermission(
                "com.alaarab.mutter",
                "android.permission.BLUETOOTH_CONNECT",
            )
    }

    @After
    fun cleanup() {
        ui.runOnIdle {
            app.disconnect()
            app.client.mute(false)
            app.store.deleteServer("visual-review")
            app.store.saveSettings(original)
        }
    }

    private fun scrollTo(matcher: SemanticsMatcher): SemanticsNodeInteraction {
        ui.onAllNodes(hasScrollToNodeAction()).onLast().performScrollToNode(matcher)
        return ui.onAllNodes(matcher).onLast()
    }

    private fun pressBack() {
        ui.waitForIdle()
        InstrumentationRegistry.getInstrumentation()
            .sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
        ui.waitForIdle()
    }

    private fun capture(name: String) {
        if (arguments.getString("polishScreenshots") != "true") return
        ui.waitForIdle()
        Thread.sleep(350)
        val image = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        assertNotNull(image)
        val folder =
            app.getExternalFilesDir(null)!!.resolve(
                "polish-${arguments.getString("polishSize") ?: "phone"}"
            )
        folder.mkdirs()
        folder.resolve("$name.png").outputStream().use {
            image.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        image.recycle()
    }

    @Test
    fun settingsNavigationAndAppearanceSurviveRecreation() {
        ui.onNodeWithContentDescription("Settings").performClick()
        capture("settings-dark")
        scrollTo(hasText("Voice & audio")).performClick()
        capture("audio-dark")
        scrollTo(hasText("Voice activity")).performClick()
        scrollTo(hasText("Voice activation threshold")).assertIsDisplayed()
        assertEquals("vad", app.store.settings.value.voiceMode)
        ui.activityRule.scenario.recreate()
        scrollTo(hasText("Voice activation threshold")).assertIsDisplayed()
        pressBack()
        ui.waitUntil(5000) {
            ui.onAllNodesWithText("Make it yours").fetchSemanticsNodes().isNotEmpty()
        }
        scrollTo(hasText("Make it yours")).assertIsDisplayed()
        scrollTo(hasText("Certificates")).performClick()
        scrollTo(hasText("Your identity")).assertIsDisplayed()
        capture("certificates-dark")
        ui.onNodeWithContentDescription("Back to settings").performClick()
        scrollTo(hasText("Screen viewer")).performClick()
        scrollTo(hasText("TURN server (optional)") and hasSetTextAction())
            .performTextReplacement("turn:relay.example:3478")
        ui.onNodeWithContentDescription("Back to settings").performClick()
        scrollTo(hasText("Make it yours")).assertIsDisplayed()
        assertEquals("turn:relay.example:3478", app.store.settings.value.turn)
        scrollTo(hasText("Light")).performClick()
        scrollTo(hasText("Mint")).performClick()
        assertEquals("mint", app.store.settings.value.theme)
        assertEquals("light", app.store.settings.value.appearance)
        scrollTo(hasText("Make it yours")).assertIsDisplayed()
        capture("settings-light")
        ui.activityRule.scenario.recreate()
        scrollTo(hasText("Make it yours")).assertIsDisplayed()
        assertEquals("mint", app.store.settings.value.theme)
    }

    @Test
    fun populatedScreensKeepActionsAccessibleAcrossThemes() {
        ui.runOnIdle {
            app.connect(
                Server(
                    id = "visual-review",
                    name = "Good company",
                    host = arguments.getString("mumbleHost") ?: "10.0.2.2",
                    port = 64746,
                    username = "Casey",
                )
            )
        }
        ui.waitUntil(15000) { app.client.state.value.certificate != null }
        ui.runOnIdle { app.client.answerTrust(true) }
        ui.waitUntil(15000) {
            app.client.state.value.connected &&
                app.client.state.value.users.size == 6 &&
                app.client.state.value.messages.size >= 3
        }
        val catalog =
            ThemeCatalog(app.assets.open("themes.json").bufferedReader().use { it.readText() })
        for (mode in listOf("dark", "light")) {
            scrollTo(hasText("The living room")).assertIsDisplayed()
            for (theme in catalog.themes) {
                ui.runOnIdle {
                    app.store.saveSettings(
                        app.store.settings.value.copy(theme = theme.id, appearance = mode)
                    )
                }
                ui.onNodeWithTag("talkButton").assertIsDisplayed()
                capture("voice-${theme.id}-$mode")
            }
            ui.runOnIdle { app.store.saveSettings(app.store.settings.value.copy(theme = "plum")) }
            scrollTo(hasText("Casey")).assertIsDisplayed()
            ui.onNodeWithTag("talkButton").performTouchInput { down(center) }
            ui.waitUntil(10000) { app.audio.transmitting.value }
            ui.onNodeWithText("Speaking").assertIsDisplayed()
            capture("voice-speaking-$mode")
            ui.onNodeWithTag("talkButton").performTouchInput { up() }
            ui.waitUntil(5000) { !app.audio.transmitting.value }
            ui.onNodeWithText("Channels", useUnmergedTree = true).performClick()
            scrollTo(hasText("Lounge", substring = false)).assertIsDisplayed()
            capture("channels-$mode")
            ui.onNodeWithText("Chat", useUnmergedTree = true).performClick()
            ui.onNodeWithText("Say something…")
                .performTextInput("Wouldn’t miss it. Good to hear your voices.")
            ui.onNode(hasSetTextAction()).performImeAction()
            ui.waitUntil(5000) { app.client.state.value.messages.any { it.own } }
            capture("chat-keyboard-$mode")
            ui.dismissKeyboard()
            capture("chat-$mode")
            ui.onNodeWithText("Voice", useUnmergedTree = true).performClick()
            scrollTo(hasText("Alex Morgan")).performClick()
            scrollTo(hasText("Registered")).assertIsDisplayed()
            capture("profile-$mode")
            scrollTo(hasText("Mute locally")).performClick()
            ui.waitUntil(5000) { app.client.state.value.users[100]?.localMute == (mode == "dark") }
            pressBack()
            ui.onNodeWithContentDescription("Whisper targets").performClick()
            scrollTo(hasText("Alex Morgan")).performClick()
            scrollTo(hasText("Hold to whisper")).assertIsDisplayed()
            capture("whisper-$mode")
            pressBack()
            ui.onNodeWithContentDescription("Server information").performClick()
            capture("server-$mode")
            pressBack()
        }
    }
}
