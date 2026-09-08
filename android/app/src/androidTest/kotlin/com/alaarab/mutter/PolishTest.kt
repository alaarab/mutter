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
                original.copy(
                    theme = "plum",
                    appearance = "dark",
                    voiceMode = "ptt",
                    defaultUsername = "Casey",
                )
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
        return ui.onAllNodes(matcher).onLast().performScrollTo()
    }

    private fun pressBack() {
        ui.waitForIdle()
        InstrumentationRegistry.getInstrumentation()
            .sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
        ui.waitForIdle()
    }

    private fun expandSheet() {
        val handle = ui.onNodeWithTag("sheetHandle", useUnmergedTree = true)
        val top = handle.fetchSemanticsNode().boundsInRoot.top
        handle.performTouchInput { swipe(center, center.copy(y = -top + 80f), 400) }
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
        capture("home-dark")
        ui.onNodeWithContentDescription("Settings").performClick()
        capture("settings-dark")
        scrollTo(hasContentDescription("Default username")).performTextReplacement("Casey Review")
        ui.onNodeWithContentDescription("Default username").performImeAction()

        scrollTo(hasText("Voice & audio")).performClick()
        capture("audio-dark")
        scrollTo(hasText("Voice activity")).performClick()
        scrollTo(hasText("Voice activation threshold")).assertIsDisplayed()
        assertEquals("vad", app.store.settings.value.voiceMode)
        ui.activityRule.scenario.recreate()
        scrollTo(hasText("Voice activation threshold")).assertIsDisplayed()
        pressBack()
        ui.waitUntil(5000) {
            ui.onAllNodesWithText("Settings").fetchSemanticsNodes().isNotEmpty()
        }
        ui.onNodeWithText("Settings").assertIsDisplayed()
        scrollTo(hasText("Certificates")).performClick()
        scrollTo(hasText("Certificates make you recognizable to servers.")).assertIsDisplayed()
        capture("certificates-dark")
        ui.onNodeWithContentDescription("Back to settings").performClick()
        scrollTo(hasText("Screen viewer")).performClick()
        scrollTo(hasText("TURN server (optional)") and hasSetTextAction())
            .performTextReplacement("turn:relay.example:3478")
        ui.onNodeWithContentDescription("Back to settings").performClick()
        ui.waitUntil(5000) { ui.onNodeWithText("Settings").isDisplayed() }
        assertEquals("turn:relay.example:3478", app.store.settings.value.turn)
        capture("settings-return-dark")
        scrollTo(hasText("Light")).performClick()
        capture("settings-after-light")
        ui.waitUntil(5000) { app.store.settings.value.appearance == "light" }
        scrollTo(hasText("Mint")).performClick()
        assertEquals("mint", app.store.settings.value.theme)
        assertEquals("light", app.store.settings.value.appearance)
        ui.onNodeWithText("Settings").assertIsDisplayed()
        scrollTo(hasText("Voice & audio"))
        capture("settings-light")
        ui.activityRule.scenario.recreate()
        ui.onNodeWithText("Settings").assertIsDisplayed()
        assertEquals("mint", app.store.settings.value.theme)
        assertEquals(
            "Casey Review",
            com.alaarab.mutter.data.AppStore(app).settings.value.defaultUsername,
        )
        ui.onNodeWithText("Done").performClick()
        ui.runOnIdle {
            app.store.saveSettings(
                app.store.settings.value.copy(theme = "plum", appearance = "light")
            )
        }
        capture("home-light")
    }

    private fun connectFixture() {
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
    }

    @Test
    fun channelTreeSearchAndCallMenusFollowPhoneNavigation() {
        connectFixture()
        ui.onNodeWithTag("tab-channels").assertIsSelected()
        ui.onNodeWithText("Voice").assertDoesNotExist()
        ui.onNodeWithContentDescription("Collapse The living room").performClick()
        ui.onNodeWithText("Alex Morgan").assertDoesNotExist()
        ui.onNodeWithContentDescription("Expand The living room").performClick()
        ui.onNodeWithText("Find a channel or person").performTextInput("Jordan")
        ui.onNodeWithText("Jordan Lee").assertIsDisplayed()
        ui.onNodeWithText("Alex Morgan").assertDoesNotExist()
        ui.onNodeWithContentDescription("Clear search").performClick()
        ui.dismissKeyboard()
        ui.onNodeWithContentDescription("Audio output").performClick()
        ui.onNodeWithText("Speaker").performClick()
        ui.waitUntil(5000) { app.store.settings.value.speaker }
        ui.onNodeWithContentDescription("Call options").performClick()
        ui.onNodeWithText("Voice activity").performClick()
        ui.waitUntil(5000) { app.store.settings.value.voiceMode == "vad" }
        ui.onNodeWithTag("talkButton").assertDoesNotExist()
        ui.onNodeWithContentDescription("Call options").performClick()
        ui.onNodeWithText("Push to talk").performClick()
        ui.onNodeWithTag("talkButton").assertIsDisplayed()
        ui.onNodeWithContentDescription("Back to servers").performClick()
        ui.onNodeWithTag("sessionNavigation").assertDoesNotExist()
        scrollTo(hasText("Connected · tap to return")).performClick()
        ui.onNodeWithTag("tab-channels").assertIsSelected()
        assertTrue(app.client.state.value.connected)
    }

    @Test
    fun populatedScreensKeepActionsAccessibleAcrossThemes() {
        connectFixture()
        val catalog =
            ThemeCatalog(app.assets.open("themes.json").bufferedReader().use { it.readText() })
        ui.onNodeWithText("Voice").assertDoesNotExist()
        ui.onNodeWithTag("sessionNavigation").assertIsDisplayed()
        ui.onNodeWithContentDescription("Audio output").assertIsDisplayed()
        ui.onNodeWithContentDescription("Call options").assertIsDisplayed()
        for (mode in listOf("dark", "light")) {
            scrollTo(hasText("Alex Morgan")).assertIsDisplayed()
            for (theme in catalog.themes) {
                ui.runOnIdle {
                    app.store.saveSettings(
                        app.store.settings.value.copy(theme = theme.id, appearance = mode)
                    )
                }
                ui.onNodeWithTag("talkButton").assertIsDisplayed()
                capture("channels-${theme.id}-$mode")
            }
            ui.runOnIdle { app.store.saveSettings(app.store.settings.value.copy(theme = "plum")) }
            scrollTo(hasText("Casey")).assertIsDisplayed()
            ui.onNodeWithTag("talkButton").performTouchInput { down(center) }
            ui.waitUntil(10000) { app.audio.transmitting.value }
            ui.onAllNodesWithText("Speaking").onFirst().assertIsDisplayed()
            capture("channels-speaking-$mode")
            ui.onNodeWithTag("talkButton").performTouchInput { up() }
            ui.waitUntil(5000) { !app.audio.transmitting.value }
            ui.onNodeWithTag("tab-channels").performClick()
            scrollTo(hasText("Lounge", substring = false)).assertIsDisplayed()
            capture("channels-$mode")
            ui.onNodeWithTag("tab-chat").performClick()
            ui.onNodeWithText("Message")
                .performTextInput("Wouldn’t miss it. Good to hear your voices.")
            ui.onNode(hasSetTextAction()).performImeAction()
            ui.waitUntil(5000) { app.client.state.value.messages.any { it.own } }
            capture("chat-keyboard-$mode")
            ui.dismissKeyboard()
            capture("chat-$mode")
            ui.onNodeWithTag("tab-channels").performClick()
            scrollTo(hasText("Alex Morgan")).performClick()
            scrollTo(hasText("Registered")).assertIsDisplayed()
            capture("profile-$mode")
            expandSheet()
            scrollTo(hasText("Mute for me")).performClick()
            ui.waitUntil(5000) { app.client.state.value.users[100]?.localMute == (mode == "dark") }
            ui.onNodeWithText("Done").performClick()
            ui.onNodeWithContentDescription("Call options").performClick()
            ui.onNodeWithText("Whisper or shout…").performClick()
            expandSheet()
            scrollTo(hasText("Alex Morgan")).performClick()
            scrollTo(hasText("Hold to whisper")).assertIsDisplayed()
            capture("whisper-$mode")
            ui.onNodeWithText("Done").performClick()
            ui.onNodeWithTag("tab-info").performClick()
            scrollTo(hasText("Voice transport")).assertIsDisplayed()
            ui.onNodeWithTag("serverDetails").performScrollToIndex(0)
            capture("server-$mode")
            ui.onNodeWithTag("tab-channels").performClick()
            ui.onNodeWithContentDescription("Call options").performClick()
            ui.onNodeWithText("Settings").performClick()
            capture("settings-session-$mode")
            ui.onNodeWithText("Done").performClick()
        }
    }
}
