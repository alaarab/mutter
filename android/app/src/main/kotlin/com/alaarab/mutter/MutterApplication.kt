package com.alaarab.mutter

import android.app.Application
import android.content.Intent
import androidx.core.content.ContextCompat
import com.alaarab.mutter.audio.VoiceAudio
import com.alaarab.mutter.data.*
import com.alaarab.mutter.protocol.MumbleConnection
import com.alaarab.mutter.sharing.ScreenSharer
import com.alaarab.mutter.sharing.ShareViewer
import com.alaarab.mutter.sharing.SignalChannel
import com.alaarab.mutter.sharing.WebRtcRuntime
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

class MutterApplication : Application() {
    lateinit var store: AppStore
        private set

    lateinit var identities: Identities
        private set

    lateinit var client: MumbleConnection
        private set

    lateinit var audio: VoiceAudio
        private set

    lateinit var shares: ShareViewer
        private set

    lateinit var sharer: ScreenSharer
        private set

    private lateinit var signals: SignalChannel

    override fun onCreate() {
        super.onCreate()
        store = AppStore(this)
        identities = Identities(store)
        client = MumbleConnection(store, identities)
        audio = VoiceAudio(this, store, client)
        signals = SignalChannel(client, CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate))
        val webRtc = WebRtcRuntime(this)
        shares = ShareViewer(webRtc, store, client, signals)
        sharer = ScreenSharer(this, webRtc, store, client, signals)
        client.onVoice = audio::receive
        client.onPlugin = signals::receive
    }

    fun connect(server: Server) {
        store.saveServer(server)
        client.connect(server)
        ContextCompat.startForegroundService(this, Intent(this, VoiceService::class.java))
    }

    fun disconnect() {
        sharer.stop()
        client.disconnect()
        audio.stop()
        shares.reset()
        stopService(Intent(this, VoiceService::class.java))
    }
}
