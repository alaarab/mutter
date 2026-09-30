package com.alaarab.mutter.sharing

import com.alaarab.mutter.data.AppStore
import com.alaarab.mutter.protocol.MumbleConnection
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import org.json.JSONObject
import org.webrtc.*

data class ActiveShare(val id: String, val sender: Int, val title: String)

class ShareViewer(
    private val runtime: WebRtcRuntime,
    private val store: AppStore,
    private val client: MumbleConnection,
    private val signals: SignalChannel,
) {
    val shares = MutableStateFlow<List<ActiveShare>>(emptyList())
    val watching = MutableStateFlow<ActiveShare?>(null)
    val video = MutableStateFlow<VideoTrack?>(null)
    val status = MutableStateFlow("Connecting…")
    val egl: EglBase
        get() = runtime.egl

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var peer: PeerConnection? = null
    private var ready = false
    private val pendingIce = mutableListOf<IceCandidate>()

    init {
        signals.listen(::handle)
        scope.launch {
            client.state.collect { state ->
                if (!state.connected) return@collect
                shares.update { list -> list.filter { it.sender in state.users } }
                if (watching.value?.sender?.let { it !in state.users } == true) stop()
            }
        }
    }

    private fun handle(sender: Int, message: JSONObject) {
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
                            ).take(512),
                        )
                    shares.update {
                        val others = it.filterNot { old -> old.id == id && old.sender == sender }
                        if (others.size < 256) others + share else it
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
                if (watching.value?.let { it.id == id && it.sender == sender } == true)
                    readIceCandidates(message).forEach { candidate ->
                        if (ready) peer?.addIceCandidate(candidate)
                        else if (pendingIce.size < MAXIMUM_CANDIDATES) pendingIce.add(candidate)
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
        signals.clear()
    }

    private fun send(type: String, fields: JSONObject = JSONObject()) {
        val share = watching.value ?: return
        signals.send(
            listOf(share.sender),
            fields.put("t", type).put("id", share.id),
            if (type == "answer") "answer:${share.sender}:${share.id}" else null,
        )
    }

    private fun accept(sdp: String) {
        peer?.close()
        peer?.dispose()
        ready = false
        val observer =
            object : PeerConnection.Observer {
                override fun onSignalingChange(state: PeerConnection.SignalingState) {}

                override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
                    status.value = state.name.lowercase().replaceFirstChar { it.uppercase() }
                }

                override fun onIceConnectionReceivingChange(receiving: Boolean) {}

                override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}

                override fun onIceCandidate(candidate: IceCandidate) {
                    scope.launch { send("ice", JSONObject().put("c", candidateList(candidate))) }
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
            runtime.factory.createPeerConnection(
                runtime.configuration(store.settings.value),
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
