package com.alaarab.mutter

import android.content.Context
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.alaarab.mutter.data.Server
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.webrtc.CapturerObserver
import org.webrtc.JavaI420Buffer
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer
import org.webrtc.VideoFrame

class PhoneShareInteropTest {
    @get:Rule val ui = createAndroidComposeRule<MainActivity>()

    private class MovingBarsCapturer : VideoCapturer {
        private var observer: CapturerObserver? = null
        private var timer: ScheduledExecutorService? = null
        private var frameNumber = 0

        override fun initialize(
            helper: SurfaceTextureHelper,
            context: Context,
            capturerObserver: CapturerObserver,
        ) {
            observer = capturerObserver
        }

        override fun startCapture(width: Int, height: Int, framesPerSecond: Int) {
            observer?.onCapturerStarted(true)
            timer =
                Executors.newSingleThreadScheduledExecutor().apply {
                    scheduleWithFixedDelay(
                        { deliverFrame(width, height) },
                        0,
                        1000L / framesPerSecond,
                        TimeUnit.MILLISECONDS,
                    )
                }
        }

        private fun deliverFrame(width: Int, height: Int) {
            val buffer = JavaI420Buffer.allocate(width, height)
            val barPosition = (frameNumber++ * 8) % width
            val luma = buffer.dataY
            for (row in 0 until height) {
                for (column in 0 until width) {
                    val bright = column in barPosition until barPosition + 40
                    luma.put(row * buffer.strideY + column, (if (bright) 235 else 40).toByte())
                }
            }
            for (index in 0 until buffer.dataU.capacity()) buffer.dataU.put(index, 128.toByte())
            for (index in 0 until buffer.dataV.capacity()) buffer.dataV.put(index, 128.toByte())
            val frame = VideoFrame(buffer, 0, System.nanoTime())
            observer?.onFrameCaptured(frame)
            frame.release()
        }

        override fun stopCapture() {
            timer?.shutdownNow()
            timer = null
            observer?.onCapturerStopped()
        }

        override fun changeCaptureFormat(width: Int, height: Int, framesPerSecond: Int) {}

        override fun dispose() {
            stopCapture()
        }

        override fun isScreencast() = true
    }

    @Test
    fun theDesktopClientWatchesAnAndroidScreenShare() {
        val port =
            InstrumentationRegistry.getArguments().getString("mumblePhoneSharePort")?.toIntOrNull()
        assumeTrue("Run using node android/test-phone-share.mjs", port != null)
        grantLocalNetworkPermission()
        val app = ui.activity.application as MutterApplication
        InstrumentationRegistry.getInstrumentation()
            .uiAutomation
            .grantRuntimePermission("com.alaarab.mutter", "android.permission.RECORD_AUDIO")
        try {
            ui.runOnIdle {
                app.forgetTestServers("10.0.2.2")
                app.connect(
                    Server(
                        id = "android-phone-share-test",
                        name = "Phone share test",
                        host = "10.0.2.2",
                        port = port!!,
                        username = "AndroidSharer",
                    )
                )
            }
            ui.waitUntil(15000) { app.client.state.value.certificate != null }
            ui.runOnIdle { app.client.answerTrust(true) }
            ui.waitUntil(15000) { app.client.state.value.connected }
            ui.runOnIdle {
                assertTrue(app.sharer.start(MovingBarsCapturer(), 640, 360, 15, "Phone screen"))
            }
            ui.waitUntil(60000) { (app.sharer.sharing.value?.viewers ?: 0) >= 1 }
            ui.waitUntil(60000) { app.sharer.sharing.value?.viewers == 0 }
            assertTrue(app.client.state.value.connected)
        } finally {
            ui.runOnIdle {
                app.sharer.stop()
                app.disconnect()
            }
        }
    }
}
