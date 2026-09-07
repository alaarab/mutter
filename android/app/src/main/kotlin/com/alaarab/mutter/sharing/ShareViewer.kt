package com.alaarab.mutter.sharing

import android.content.Context
import com.alaarab.mutter.data.AppStore
import com.alaarab.mutter.protocol.MumbleConnection
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.*

data class ActiveShare(val id: String, val sender: Int, val title: String)

class ShareViewer(
    context: Context,
    private val store: AppStore,
    private val client: MumbleConnection,
) {
    val shares = MutableStateFlow<List<ActiveShare>>(emptyList())
    val watching = MutableStateFlow<ActiveShare?>(null)
    val video = MutableStateFlow<VideoTrack?>(null)
    val status = MutableStateFlow("Connecting…")
    val egl: EglBase by lazy { EglBase.create() }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val factory: PeerConnectionFactory by lazy {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context)
                .createInitializationOptions()
        )
        PeerConnectionFactory.builder()
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
            .createPeerConnectionFactory()
    }
    private val codec = SignalCodec()
    private var peer: PeerConnection? = null
    private var ready = false
    private val pendingIce = mutableListOf<IceCandidate>()
    private val outgoing = kotlinx.coroutines.channels.Channel<Pair<Int, ByteArray>>(256)

    init {
        scope.launch {
            for ((receiver, payload) in outgoing) {
                client.sendPlugin(listOf(receiver), payload)
                delay(350)
            }
        }
        scope.launch {
            client.state.collect { state ->
                if (!state.connected) return@collect
                shares.update { list -> list.filter { it.sender in state.users } }
                if (watching.value?.sender?.let { it !in state.users } == true) stop()
            }
        }
    }

    fun receive(sender: Int, dataId: String, bytes: ByteArray) {
        if (dataId != "mutter/rtc") return
        val payload = codec.receive(sender, bytes) ?: return
        val message =
            runCatching { JSONObject(payload.toString(Charsets.UTF_8)) }.getOrNull() ?: return
        scope.launch {
            val id = message.optString("id")
            when (message.optString("t")) {
                "announce" ->
                    if (id.isNotBlank() && sender in client.state.value.users) {
                        val share =
                            ActiveShare(
                                id,
                                sender,
                                message.optString(
                                    "title",
                                    client.state.value.users[sender]?.name ?: "Screen",
                                ),
                            )
                        shares.update {
                            it.filterNot { old -> old.id == id && old.sender == sender } + share
                        }
                    }
                "stop" -> {
                    shares.update {
                        it.filterNot { share -> share.id == id && share.sender == sender }
                    }
                    if (watching.value?.let { it.id == id && it.sender == sender } == true) stop()
                }
                "offer" ->
                    if (watching.value?.let { it.id == id && it.sender == sender } == true)
                        accept(message.optString("sdp"))
                "ice" ->
                    if (watching.value?.let { it.id == id && it.sender == sender } == true) {
                        val candidates = message.optJSONArray("c") ?: JSONArray()
                        repeat(candidates.length()) { index ->
                            val c = candidates.getJSONObject(index)
                            val candidate =
                                IceCandidate(
                                    c.optString("sdpMid"),
                                    c.optInt("sdpMLineIndex"),
                                    c.optString("candidate"),
                                )
                            if (ready) peer?.addIceCandidate(candidate)
                            else if (pendingIce.size < 256) pendingIce.add(candidate)
                        }
                    }
            }
        }
    }

    fun watch(share: ActiveShare) {
        stop()
        watching.value = share
        status.value = "Connecting…"
        send("watch")
    }

    fun stop() {
        send("leave")
        peer?.close()
        peer?.dispose()
        peer = null
        ready = false
        pendingIce.clear()
        video.value = null
        watching.value = null
    }

    fun reset() {
        stop()
        shares.value = emptyList()
        while (outgoing.tryReceive().isSuccess) {}
    }

    private fun send(type: String, fields: JSONObject = JSONObject()) {
        val share = watching.value ?: return
        val data = fields.put("t", type).put("id", share.id).toString().toByteArray()
        for (fragment in codec.encode(data)) outgoing.trySend(share.sender to fragment)
    }

    private fun accept(sdp: String) {
        peer?.close()
        peer?.dispose()
        ready = false
        val settings = store.settings.value
        val servers = mutableListOf<PeerConnection.IceServer>()
        if (settings.stun.isNotBlank())
            servers.add(PeerConnection.IceServer.builder(settings.stun).createIceServer())
        if (settings.turn.isNotBlank())
            servers.add(
                PeerConnection.IceServer.builder(settings.turn)
                    .setUsername(settings.turnUser)
                    .setPassword(settings.turnPassword)
                    .createIceServer()
            )
        val observer =
            object : PeerConnection.Observer {
                override fun onSignalingChange(state: PeerConnection.SignalingState) {}

                override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
                    status.value = state.name.lowercase().replaceFirstChar { it.uppercase() }
                }

                override fun onIceConnectionReceivingChange(receiving: Boolean) {}

                override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}

                override fun onIceCandidate(candidate: IceCandidate) {
                    scope.launch {
                        send(
                            "ice",
                            JSONObject()
                                .put(
                                    "c",
                                    JSONArray()
                                        .put(
                                            JSONObject()
                                                .put("candidate", candidate.sdp)
                                                .put("sdpMid", candidate.sdpMid)
                                                .put("sdpMLineIndex", candidate.sdpMLineIndex)
                                        ),
                                ),
                        )
                    }
                }

                override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}

                override fun onAddStream(stream: MediaStream) {
                    stream.videoTracks.firstOrNull()?.let { video.value = it }
                    stream.audioTracks.forEach { it.setEnabled(false) }
                }

                override fun onRemoveStream(stream: MediaStream) {}

                override fun onDataChannel(channel: DataChannel) {}

                override fun onRenegotiationNeeded() {}

                override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {
                    (receiver.track() as? VideoTrack)?.let { video.value = it }
                    (receiver.track() as? AudioTrack)?.setEnabled(false)
                }
            }
        val connection =
            factory.createPeerConnection(
                PeerConnection.RTCConfiguration(servers).apply {
                    sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                },
                observer,
            ) ?: return run { status.value = "Could not start the viewer" }
        peer = connection
        connection.setRemoteDescription(
            sdpObserver(
                onSet = {
                    if (peer !== connection) return@sdpObserver
                    ready = true
                    pendingIce.forEach(connection::addIceCandidate)
                    pendingIce.clear()
                    connection.createAnswer(
                        sdpObserver(
                            onCreate = { answer ->
                                if (peer !== connection) return@sdpObserver
                                connection.setLocalDescription(
                                    sdpObserver(
                                        onSet = {
                                            scope.launch {
                                                if (peer === connection)
                                                    send(
                                                        "answer",
                                                        JSONObject().put("sdp", answer.description),
                                                    )
                                            }
                                        }
                                    ),
                                    answer,
                                )
                            }
                        ),
                        MediaConstraints(),
                    )
                }
            ),
            SessionDescription(SessionDescription.Type.OFFER, sdp),
        )
    }

    private fun sdpObserver(onSet: () -> Unit = {}, onCreate: (SessionDescription) -> Unit = {}) =
        object : SdpObserver {
            override fun onCreateSuccess(sdp: SessionDescription) {
                scope.launch { onCreate(sdp) }
            }

            override fun onSetSuccess() {
                scope.launch { onSet() }
            }

            override fun onCreateFailure(error: String) {
                status.value = error
            }

            override fun onSetFailure(error: String) {
                status.value = error
            }
        }
}
