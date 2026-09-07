package com.alaarab.mutter

import android.app.Application
import android.content.Intent
import androidx.core.content.ContextCompat
import com.alaarab.mutter.audio.VoiceAudio
import com.alaarab.mutter.data.*
import com.alaarab.mutter.protocol.MumbleConnection
import com.alaarab.mutter.sharing.ShareViewer

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

    override fun onCreate() {
        super.onCreate()
        store = AppStore(this)
        identities = Identities(store)
        client = MumbleConnection(store, identities)
        audio = VoiceAudio(this, store, client)
        shares = ShareViewer(this, store, client)
        client.onVoice = audio::receive
        client.onPlugin = shares::receive
    }

    fun connect(server: Server) {
        store.saveServer(server)
        client.connect(server)
        ContextCompat.startForegroundService(this, Intent(this, VoiceService::class.java))
    }

    fun disconnect() {
        client.disconnect()
        audio.stop()
        shares.reset()
        stopService(Intent(this, VoiceService::class.java))
    }
}
