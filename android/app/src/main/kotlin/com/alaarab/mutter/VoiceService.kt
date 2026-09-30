package com.alaarab.mutter

import android.Manifest
import android.app.*
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.alaarab.mutter.data.SessionState
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

class VoiceService : Service() {
    private val app
        get() = application as MutterApplication

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var wakeLock: PowerManager.WakeLock? = null
    private var media: MediaSession? = null
    private var startedAudio = false
    private var servedGeneration: Long? = null
    private var foregroundIncludesScreenCapture = false
    private val messageHandler: (com.alaarab.mutter.data.ChatMessage) -> Unit = { message ->
        showMessageNotification(message)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val notifications = getSystemService(NotificationManager::class.java)
        notifications.createNotificationChannel(
            NotificationChannel("voice", "Voice connection", NotificationManager.IMPORTANCE_LOW)
        )
        notifications.createNotificationChannel(
            NotificationChannel("messages", "Chat messages", NotificationManager.IMPORTANCE_DEFAULT)
        )
        startCallForeground()
        wakeLock =
            getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "mutter:voice")
                .apply { acquire(12 * 60 * 60 * 1000L) }
        media =
            MediaSession(this, "Mutter").apply {
                setCallback(
                    object : MediaSession.Callback() {
                        override fun onPlay() {
                            app.client.mute(false)
                            app.audio.reclaimFocus()
                        }

                        override fun onPause() {
                            app.client.mute(true)
                        }

                        override fun onStop() {
                            app.disconnect()
                        }
                    }
                )
                isActive = true
            }
        app.client.onMessage = messageHandler
        scope.launch {
            app.client.state
                .map { listOf(it.status, it.channel?.name, it.self?.selfMute, it.self?.selfDeaf) }
                .combine(app.sharer.sharing) { summary, share -> summary + listOf(share) }
                .distinctUntilChanged()
                .collect {
                    val state = app.client.state.value
                    if (state.status == "disconnected") {
                        stopSelf()
                        return@collect
                    }
                    servedGeneration = app.client.generation
                    if (state.connected && !startedAudio) {
                        startedAudio = true
                        app.audio.start()
                    }
                    if (!state.connected && startedAudio) {
                        startedAudio = false
                        app.audio.stop()
                        app.shares.reset()
                    }
                    if (foregroundIncludesScreenCapture && app.sharer.sharing.value == null)
                        startCallForeground(includeScreenCapture = false)
                    notifications.notify(1, notification(state))
                    media?.setPlaybackState(
                        PlaybackState.Builder()
                            .setActions(
                                PlaybackState.ACTION_PLAY or
                                    PlaybackState.ACTION_PAUSE or
                                    PlaybackState.ACTION_STOP
                            )
                            .setState(
                                if (state.self?.selfMute == true) PlaybackState.STATE_PAUSED
                                else PlaybackState.STATE_PLAYING,
                                PlaybackState.PLAYBACK_POSITION_UNKNOWN,
                                1f,
                            )
                            .build()
                    )
                }
        }
    }

    private fun showMessageNotification(message: com.alaarab.mutter.data.ChatMessage) {
        if (message.own || message.direct == null) return
        val text =
            android.text.Html.fromHtml(
                    message.html.take(MESSAGE_PREVIEW_SOURCE_CHARACTERS),
                    android.text.Html.FROM_HTML_MODE_COMPACT,
                )
                .toString()
        val notice =
            NotificationCompat.Builder(this, "messages")
                .setSmallIcon(R.drawable.notification_mark)
                .setContentTitle(message.name)
                .setContentText(text.take(200))
                .setContentIntent(openApp())
                .setAutoCancel(true)
                .build()
        getSystemService(NotificationManager::class.java)
            .notify(100 + message.sender.hashCode(), notice)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            null -> startCallForeground()
            "microphone" -> {
                if (app.client.state.value.connected) {
                    startCallForeground()
                    app.audio.restart()
                }
            }
            "mute" -> {
                val unmuting = app.client.state.value.self?.selfMute == true
                app.client.mute(!unmuting)
                if (unmuting) app.audio.reclaimFocus()
            }
            "deafen" -> app.client.deafen(app.client.state.value.self?.selfDeaf != true)
            "disconnect" -> app.disconnect()
            SHARE_SCREEN_ACTION -> startScreenShare(intent)
            STOP_SCREEN_SHARE_ACTION -> app.sharer.stop()
        }
        return START_NOT_STICKY
    }

    private fun startScreenShare(intent: Intent) {
        val permission =
            if (Build.VERSION.SDK_INT >= 33)
                intent.getParcelableExtra(SCREEN_PERMISSION_EXTRA, Intent::class.java)
            else @Suppress("DEPRECATION") intent.getParcelableExtra(SCREEN_PERMISSION_EXTRA)
        if (permission == null || !app.client.state.value.connected) return
        startCallForeground(includeScreenCapture = true)
        if (!app.sharer.startProjection(permission)) startCallForeground(includeScreenCapture = false)
    }

    private fun startCallForeground(includeScreenCapture: Boolean = app.sharer.isSharing) {
        val microphone =
            checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
        val microphoneType =
            if (microphone && Build.VERSION.SDK_INT >= 30)
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            else 0
        val screenCaptureType =
            if (includeScreenCapture) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION else 0
        ServiceCompat.startForeground(
            this,
            1,
            notification(app.client.state.value),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK or microphoneType or screenCaptureType,
        )
        foregroundIncludesScreenCapture = includeScreenCapture
    }

    private fun openApp() =
        PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    private fun action(name: String) =
        PendingIntent.getService(
            this,
            name.hashCode(),
            Intent(this, VoiceService::class.java).setAction(name),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    private fun notification(state: SessionState): Notification =
        NotificationCompat.Builder(this, "voice")
            .setSmallIcon(R.drawable.notification_mark)
            .setContentTitle(state.channel?.name ?: "Mutter")
            .setContentText(
                if (state.connected) state.server?.name?.ifBlank { state.server.host }
                else state.status.replaceFirstChar { it.uppercase() }
            )
            .setContentIntent(openApp())
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .addAction(0, if (state.self?.selfMute == true) "Unmute" else "Mute", action("mute"))
            .addAction(
                0,
                if (state.self?.selfDeaf == true) "Undeafen" else "Deafen",
                action("deafen"),
            )
            .apply {
                if (app.sharer.sharing.value != null)
                    addAction(0, "Stop sharing", action(STOP_SCREEN_SHARE_ACTION))
            }
            .addAction(0, "Disconnect", action("disconnect"))
            .build()

    override fun onDestroy() {
        scope.cancel()
        if (app.client.onMessage === messageHandler) app.client.onMessage = {}
        val served = servedGeneration
        if (served != null && served == app.client.generation) {
            app.sharer.stop()
            app.audio.stop()
            app.client.disconnect(onlyGeneration = served)
            app.shares.reset()
        }
        wakeLock?.let { if (it.isHeld) it.release() }
        media?.release()
        super.onDestroy()
    }

    companion object {
        private const val MESSAGE_PREVIEW_SOURCE_CHARACTERS = 65536
        const val SHARE_SCREEN_ACTION = "share-screen"
        const val STOP_SCREEN_SHARE_ACTION = "stop-screen-share"
        const val SCREEN_PERMISSION_EXTRA = "screen-permission"
    }
}
