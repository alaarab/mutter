package com.alaarab.mutter

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.alaarab.mutter.data.Server
import com.alaarab.mutter.protocol.VoicePacket
import com.alaarab.mutter.sharing.SignalCodec
import com.alaarab.mutter.ui.ThemeCatalog
import java.util.concurrent.CopyOnWriteArrayList
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test

class AppIntegrationTest {
    @get:Rule val ui = createAndroidComposeRule<MainActivity>()
    private val app
        get() = ui.activity.application as MutterApplication

    private val host
        get() = InstrumentationRegistry.getArguments().getString("mumbleHost") ?: "10.0.2.2"

    @Before
    fun setup() {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        for (permission in
            buildList {
                add("android.permission.RECORD_AUDIO")
                if (android.os.Build.VERSION.SDK_INT >= 33)
                    add("android.permission.POST_NOTIFICATIONS")
                if (android.os.Build.VERSION.SDK_INT >= 31)
                    add("android.permission.BLUETOOTH_CONNECT")
            }) {
            automation.grantRuntimePermission("com.alaarab.mutter", permission)
        }
        ui.runOnIdle { app.disconnect() }
    }

    @After
    fun cleanup() {
        ui.runOnIdle { app.disconnect() }
        app.client.onVoice = app.audio::receive
    }

    private fun connect(port: Int, name: String, consent: Boolean = true) {
        val server =
            Server(
                id = "android-test-$port",
                name = "Android review",
                host = host,
                port = port,
                username = name,
            )
        ui.runOnIdle { app.connect(server) }
        ui.waitUntil(15000) { app.client.state.value.certificate != null }
        assertFalse(app.client.state.value.connected)
        ui.onNodeWithText("Trust this server?").assertIsDisplayed()
        ui.runOnIdle { app.client.answerTrust(consent) }
        ui.waitUntil(15000) {
            app.client.state.value.connected || app.client.state.value.status == "disconnected"
        }
        if (consent)
            assertTrue(app.client.state.value.log.toString(), app.client.state.value.connected)
    }

    @Test
    fun malformedShareMessagesCannotCrashOrReplaceAnotherSession() {
        connect(64742, "ShareSecurity")
        val sender = app.client.state.value.me!!
        val codec = SignalCodec()
        fun deliver(from: Int, json: String) {
            for (packet in codec.encode(json.toByteArray())) {
                ui.runOnIdle { app.shares.receive(from, "mutter/rtc", packet) }
            }
        }
        deliver(sender + 1000, """{"t":"announce","id":"forged"}""")
        ui.runOnIdle { assertTrue(app.shares.shares.value.isEmpty()) }
        repeat(300) { index ->
            deliver(sender, """{"t":"announce","id":"share-$index"}""")
        }
        ui.runOnIdle {
            assertEquals(256, app.shares.shares.value.size)
            app.shares.watch(app.shares.shares.value.last())
        }
        deliver(sender, """{"t":"ice","id":"share-255","c":[null,1,"bad",{}, {"candidate":"candidate:1"}]}""")
        deliver(sender + 1000, """{"t":"stop","id":"share-255"}""")
        deliver(sender, """{"t":"stop","id":"previous-share"}""")
        ui.runOnIdle {
            assertEquals("share-255", app.shares.watching.value?.id)
            assertTrue(app.client.state.value.connected)
        }
        deliver(sender, """{"t":"stop","id":"share-255"}""")
        ui.runOnIdle { assertNull(app.shares.watching.value) }
    }

    @Test
    fun modernConnectionChatChannelsAndEncryptedVoice() {
        connect(64740, "AndroidModern")
        ui.waitUntil(15000) { app.client.state.value.udp }
        assertTrue(app.client.state.value.channels.values.any { it.name == "Lounge" })
        ui.runOnIdle { app.client.join(1) }
        ui.waitUntil(5000) { app.client.state.value.self?.channel == 1 }
        ui.onNodeWithTag("tab-channels").performClick()
        ui.onNode(
                hasText("Lounge") and hasAnyAncestor(hasTestTag("channelTree")),
                useUnmergedTree = true,
            )
            .assertExists()
        ui.onNodeWithTag("tab-chat").performClick()
        ui.onNodeWithText("Message").performTextInput("Hello from Android")
        ui.onNodeWithContentDescription("Send message").performClick()
        ui.waitUntil(5000) {
            app.client.state.value.messages.any { it.html.contains("Hello from Android") }
        }
        assertTrue(
            app.client.state.value.messages.any { it.own && it.html == "Hello from Android" }
        )
        ui.onNodeWithText("Message").performTextInput("Keep this draft")
        ui.dismissKeyboard()
        ui.onNodeWithTag("tab-channels").performClick()
        ui.onNodeWithTag("tab-chat").performClick()
        ui.onNodeWithText("Keep this draft").assertExists()
        ui.activityRule.scenario.recreate()
        ui.onNodeWithText("Keep this draft").assertExists()
        val received = CopyOnWriteArrayList<VoicePacket>()
        app.client.onVoice = { received.add(it) }
        repeat(5) {
            app.client.sendAudio(
                byteArrayOf(0xf8.toByte(), 0xff.toByte(), 0xfe.toByte()),
                target = 31,
            )
            Thread.sleep(30)
        }
        ui.waitUntil(5000) { received.isNotEmpty() }
        assertEquals(app.client.state.value.me, received.first().session)
        val currentApp = app
        ui.activityRule.scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED)
        Thread.sleep(6000)
        assertTrue("Call stopped in the background", currentApp.client.state.value.connected)
        assertTrue("UDP stopped in the background", currentApp.client.state.value.udp)
        ui.activityRule.scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
        ui.runOnIdle { app.client.mute(true) }
        ui.waitUntil(5000) { app.client.state.value.self?.selfMute == true }
        ui.runOnIdle { app.client.deafen(true) }
        ui.waitUntil(5000) { app.client.state.value.self?.selfDeaf == true }
        ui.runOnIdle { app.client.mute(false) }
        ui.waitUntil(5000) {
            app.client.state.value.self?.selfMute == false &&
                app.client.state.value.self?.selfDeaf == false
        }
    }

    @Test
    fun pinnedReconnectKeepsMuteAndDoesNotAskForTrustAgain() {
        connect(64740, "AndroidReconnect")
        ui.runOnIdle { app.client.mute(true) }
        val saved = app.store.servers.value.first { it.id == "android-test-64740" }
        assertTrue(saved.fingerprint.isNotEmpty())
        ui.runOnIdle { app.disconnect() }
        ui.runOnIdle { app.connect(saved) }
        ui.waitUntil(15000) { app.client.state.value.connected }
        assertNull(app.client.state.value.certificate)
        assertTrue(app.client.state.value.self?.selfMute == true)
        ui.runOnIdle { app.client.mute(false) }
    }

    @Test
    fun legacyAndTcpFallbackCarryVoice() {
        for (port in listOf(64741, 64742)) {
            connect(port, "Android$port")
            if (port == 64741) ui.waitUntil(15000) { app.client.state.value.udp }
            else assertFalse(app.client.state.value.udp)
            val received = CopyOnWriteArrayList<VoicePacket>()
            app.client.onVoice = { received.add(it) }
            repeat(5) {
                app.client.sendAudio(
                    byteArrayOf(0xf8.toByte(), 0xff.toByte(), 0xfe.toByte()),
                    target = 31,
                )
                Thread.sleep(30)
            }
            ui.waitUntil(5000) { received.isNotEmpty() }
            assertEquals(app.client.state.value.me, received.first().session)
            ui.runOnIdle { app.disconnect() }
        }
    }

    @Test
    fun rejectingCertificateStopsAuthentication() {
        connect(64740, "AndroidReject", consent = false)
        assertEquals("disconnected", app.client.state.value.status)
        assertNull(app.client.state.value.me)
        assertTrue(app.client.state.value.users.isEmpty())
    }

    @Test
    fun themesRemainConsistentAndPersistAcrossActivityRecreation() {
        val catalog =
            ThemeCatalog(app.assets.open("themes.json").bufferedReader().use { it.readText() })
        assertEquals(11, catalog.themes.size)
        ui.onNodeWithContentDescription("Settings").performClick()
        ui.onNodeWithText("Settings").assertIsDisplayed()
        for (mode in listOf("light", "dark")) {
            for (theme in catalog.themes) {
                ui.runOnIdle {
                    app.store.saveSettings(
                        app.store.settings.value.copy(appearance = mode, theme = theme.id)
                    )
                }
                ui.waitForIdle()
                ui.onNodeWithText("Settings").assertIsDisplayed()
                assertEquals(theme.id, app.store.settings.value.theme)
            }
        }
        ui.activityRule.scenario.recreate()
        ui.waitForIdle()
        assertEquals("mint", app.store.settings.value.theme)
        assertEquals("dark", app.store.settings.value.appearance)
        val reopened = com.alaarab.mutter.data.AppStore(app)
        assertEquals("mint", reopened.settings.value.theme)
        val bytes = app.filesDir.resolve("settings.enc").readBytes().toString(Charsets.ISO_8859_1)
        assertFalse(bytes.contains("AndroidModern"))
        assertFalse(bytes.contains("appearance"))
        ui.runOnIdle {
            app.store.saveSettings(
                app.store.settings.value.copy(theme = "carbon", appearance = "system")
            )
        }
    }
}
