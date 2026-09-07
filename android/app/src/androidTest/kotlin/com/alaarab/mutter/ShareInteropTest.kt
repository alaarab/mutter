package com.alaarab.mutter

import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.alaarab.mutter.data.Server
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.webrtc.VideoSink

class ShareInteropTest {
    @get:Rule val ui = createAndroidComposeRule<MainActivity>()

    @Test
    fun receivesRealVideoFramesFromTheDesktopClient() {
        val port =
            InstrumentationRegistry.getArguments().getString("mumbleSharePort")?.toIntOrNull()
        assumeTrue("Run using node android/test-share.mjs", port != null)
        val app = ui.activity.application as MutterApplication
        InstrumentationRegistry.getInstrumentation()
            .uiAutomation
            .grantRuntimePermission("com.alaarab.mutter", "android.permission.RECORD_AUDIO")
        val frames = AtomicInteger()
        val width = AtomicInteger()
        val sink = VideoSink { frame ->
            frames.incrementAndGet()
            width.set(frame.rotatedWidth)
        }
        try {
            ui.runOnIdle {
                app.connect(
                    Server(
                        id = "android-share-test",
                        name = "Screen test",
                        host = "10.0.2.2",
                        port = port!!,
                        username = "AndroidViewer",
                    )
                )
            }
            ui.waitUntil(15000) { app.client.state.value.certificate != null }
            ui.runOnIdle { app.client.answerTrust(true) }
            ui.waitUntil(15000) { app.client.state.value.connected }
            ui.waitUntil(15000) { app.shares.shares.value.isNotEmpty() }
            ui.runOnIdle { app.shares.watch(app.shares.shares.value.first()) }
            ui.waitUntil(20000) { app.shares.video.value != null }
            app.shares.video.value!!.addSink(sink)
            ui.waitUntil(25000) { frames.get() >= 5 }
            assertEquals(640, width.get())
            assertTrue(app.client.state.value.connected)
        } finally {
            app.shares.video.value?.removeSink(sink)
            ui.runOnIdle { app.disconnect() }
        }
    }
}
