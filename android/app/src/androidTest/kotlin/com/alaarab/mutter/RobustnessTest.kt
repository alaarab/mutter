package com.alaarab.mutter

import android.app.NotificationManager
import android.os.Build
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.Lifecycle
import androidx.test.platform.app.InstrumentationRegistry
import com.alaarab.mutter.data.Server
import com.alaarab.mutter.protocol.Proto
import com.alaarab.mutter.protocol.VoicePacket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test

class RobustnessTest {
    @get:Rule val ui = createAndroidComposeRule<MainActivity>()
    private val app
        get() = ui.activity.application as MutterApplication

    private val host
        get() = InstrumentationRegistry.getArguments().getString("mumbleHost") ?: "10.0.2.2"

    private val name = "Review-${UUID.randomUUID().toString().take(8)}"
    private val server
        get() = Server(id = name, name = name, host = host, port = 64740, username = name)

    @Before
    fun setup() {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        automation.grantRuntimePermission("com.alaarab.mutter", "android.permission.RECORD_AUDIO")
        if (Build.VERSION.SDK_INT >= 33)
            automation.grantRuntimePermission(
                "com.alaarab.mutter",
                "android.permission.POST_NOTIFICATIONS",
            )
        if (Build.VERSION.SDK_INT >= 31)
            automation.grantRuntimePermission(
                "com.alaarab.mutter",
                "android.permission.BLUETOOTH_CONNECT",
            )
        ui.runOnIdle { app.disconnect() }
    }

    @After
    fun cleanup() {
        ui.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        ui.runOnIdle {
            app.disconnect()
            app.client.mute(false)
            app.store.deleteServer(name)
        }
        app.client.onVoice = app.audio::receive
        control("udp", blocked = false)
    }

    private fun control(action: String, blocked: Boolean = false): JSONObject {
        Socket(host, 64744).use { socket ->
            socket.soTimeout = 5000
            val command =
                JSONObject().put("action", action).put("name", name).put("blocked", blocked)
            socket.getOutputStream().write((command.toString() + "\n").toByteArray())
            val result = JSONObject(socket.getInputStream().bufferedReader().readLine())
            assertTrue(result.toString(), result.getBoolean("ok"))
            return result
        }
    }

    private fun begin(target: Server = server) {
        ui.runOnIdle { app.connect(target) }
        ui.waitUntil(15000) { app.client.state.value.certificate != null }
    }

    private fun connect() {
        begin()
        ui.runOnIdle { app.client.answerTrust(true) }
        ui.waitUntil(15000) { app.client.state.value.connected }
    }

    private fun loopback(): List<VoicePacket> {
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
        return received.toList()
    }

    @Test
    fun microphoneCaptureHonorsPushToTalkMuteAndRelease() {
        ui.runOnIdle { app.store.saveSettings(app.store.settings.value.copy(voiceMode = "ptt")) }
        connect()
        ui.onNodeWithTag("talkButton").performTouchInput { down(center) }
        ui.waitUntil(10000) { control("stats").getInt("voicePackets") >= 3 }
        assertTrue(app.audio.transmitting.value)
        ui.onNodeWithTag("talkButton").performTouchInput { up() }
        ui.waitUntil(5000) { !app.audio.transmitting.value }
        Thread.sleep(300)
        val released = control("stats").getInt("voicePackets")
        Thread.sleep(400)
        assertEquals(released, control("stats").getInt("voicePackets"))
        ui.runOnIdle { app.client.mute(true) }
        ui.onNodeWithTag("talkButton").performTouchInput { down(center) }
        Thread.sleep(500)
        assertFalse(app.audio.transmitting.value)
        assertEquals(released, control("stats").getInt("voicePackets"))
        ui.onNodeWithTag("talkButton").performTouchInput { up() }
    }

    @Test
    fun droppedConnectionsReconnectWithoutUnmuting() {
        connect()
        ui.runOnIdle { app.client.deafen(true) }
        repeat(2) {
            val previous = app.client.state.value.me
            control("drop")
            ui.waitUntil(10000) { app.client.state.value.status == "reconnecting" }
            assertEquals(1, app.client.state.value.reconnectAttempt)
            ui.waitUntil(15000) {
                app.client.state.value.connected && app.client.state.value.me != previous
            }
            assertNull(app.client.state.value.certificate)
            assertTrue(app.client.state.value.self?.selfMute == true)
            assertTrue(app.client.state.value.self?.selfDeaf == true)
        }
        assertEquals(3, control("stats").getInt("authentications"))
        ui.runOnIdle { app.client.mute(false) }
        assertTrue(loopback().isNotEmpty())
    }

    @Test
    fun lostUdpFallsBackToTcpAndRecovers() {
        connect()
        ui.waitUntil(15000) { app.client.state.value.udp }
        loopback()
        assertEquals("udp", control("stats").getString("voiceTransport"))
        try {
            control("udp", blocked = true)
            ui.waitUntil(22000) { !app.client.state.value.udp }
            assertTrue(app.client.state.value.connected)
            loopback()
            assertEquals("tcp", control("stats").getString("voiceTransport"))
        } finally {
            control("udp", blocked = false)
        }
        ui.waitUntil(15000) { app.client.state.value.udp }
        loopback()
        assertEquals("udp", control("stats").getString("voiceTransport"))
    }

    @Test
    fun changedCertificateStopsBeforeAuthentication() {
        val previous = List(32) { "00" }.joinToString(":")
        begin(server.copy(fingerprint = previous, password = "must-not-be-sent"))
        ui.onNodeWithText("Server certificate changed").assertIsDisplayed()
        assertEquals(previous, app.client.state.value.certificate?.previous)
        assertEquals(0, control("stats").getInt("authentications"))
        ui.runOnIdle { app.client.answerTrust(false) }
        ui.waitUntil(5000) { app.client.state.value.status == "disconnected" }
        assertEquals(0, control("stats").getInt("authentications"))
        assertEquals(previous, app.store.servers.value.first { it.id == name }.fingerprint)
    }

    @Test
    fun wrongPasswordShowsRejectionWithoutRetrying() {
        begin(server.copy(port = 64745, password = "wrong"))
        ui.runOnIdle { app.client.answerTrust(true) }
        ui.waitUntil(5000) { app.client.state.value.status == "disconnected" }
        ui.onNodeWithText("Wrong server password").assertIsDisplayed()
        Thread.sleep(2500)
        assertEquals(1, control("stats").getInt("authentications"))
        assertNull(app.client.state.value.me)
    }

    @Test
    fun channelChangesRoundTripAndPermissionsAreQueried() {
        connect()
        ui.runOnIdle { app.client.action(7, Proto().number(2, 0).text(3, name)) }
        ui.waitUntil(5000) { app.client.state.value.channels.values.any { it.name == name } }
        val id = app.client.state.value.channels.values.first { it.name == name }.id
        ui.runOnIdle { app.client.join(id) }
        ui.waitUntil(5000) {
            app.client.state.value.self?.channel == id &&
                app.client.state.value.channels[id]?.permissions != null
        }
        assertTrue(app.client.state.value.can(0x40L, id))
        ui.runOnIdle { app.client.action(7, Proto().number(1, id).text(3, "$name-renamed")) }
        ui.waitUntil(5000) { app.client.state.value.channels[id]?.name == "$name-renamed" }
        ui.runOnIdle { app.client.join(0) }
        ui.waitUntil(5000) { app.client.state.value.self?.channel == 0 }
        ui.runOnIdle { app.client.action(6, Proto().number(1, id)) }
        ui.waitUntil(5000) { id !in app.client.state.value.channels }
    }

    @Test
    fun notificationControlsWorkWithActivityInBackground() {
        connect()
        val currentApp = app
        val manager = app.getSystemService(NotificationManager::class.java)
        ui.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        fun press(title: String) {
            ui.waitUntil(5000) {
                manager.activeNotifications.any { notice ->
                    notice.id == 1 &&
                        notice.notification.actions?.any { it.title.toString() == title } == true
                }
            }
            manager.activeNotifications
                .first { it.id == 1 }
                .notification
                .actions
                .first { it.title.toString() == title }
                .actionIntent
                .send()
        }
        press("Mute")
        ui.waitUntil(5000) { currentApp.client.state.value.self?.selfMute == true }
        press("Deafen")
        ui.waitUntil(5000) { currentApp.client.state.value.self?.selfDeaf == true }
        press("Disconnect")
        ui.waitUntil(5000) { currentApp.client.state.value.status == "disconnected" }
        ui.waitUntil(5000) { manager.activeNotifications.none { it.id == 1 } }
    }
}
