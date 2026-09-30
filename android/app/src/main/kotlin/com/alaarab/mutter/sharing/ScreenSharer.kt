package com.alaarab.mutter.sharing

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import com.alaarab.mutter.data.AppStore
import com.alaarab.mutter.data.SessionState
import com.alaarab.mutter.protocol.MumbleConnection
import java.util.UUID
import kotlin.coroutines.resume
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer
import org.webrtc.VideoSource
import org.webrtc.VideoTrack

data class OwnScreenShare(
    val id: String,
    val title: String,
    val width: Int,
    val height: Int,
    val viewers: Int = 0,
)

class ScreenSharer(
    private val context: Context,
    private val runtime: WebRtcRuntime,
    private val store: AppStore,
    private val client: MumbleConnection,
    private val signals: SignalChannel,
) {
    val sharing = MutableStateFlow<OwnScreenShare?>(null)
    val problem = MutableStateFlow<String?>(null)

    private class ViewerConnection(val connection: PeerConnection) {
        var descriptionSent = false
        var answered = false
        var connected = false
        val gatheringComplete = CompletableDeferred<Unit>()
        val waitingCandidates = mutableListOf<IceCandidate>()
        val lateCandidates = mutableListOf<IceCandidate>()
        var trickle: Job? = null
    }

    private class Capture(
        val id: String,
        val capturer: VideoCapturer,
        val textureHelper: SurfaceTextureHelper,
        val source: VideoSource,
        val track: VideoTrack,
        val streamId: String,
    ) {
        val announced = mutableSetOf<Int>()
        val viewers = mutableMapOf<Int, ViewerConnection>()
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val watchLimiter = WatchLimiter()
    private var capture: Capture? = null

    init {
        signals.listen(::handle)
        scope.launch { client.state.collect(::followSession) }
    }

    val isSharing: Boolean
        get() = capture != null

    fun startProjection(permission: Intent): Boolean {
        val metrics = context.resources.displayMetrics
        val size = captureSize(metrics.widthPixels, metrics.heightPixels)
        val capturer =
            ScreenCapturerAndroid(
                permission,
                object : MediaProjection.Callback() {
                    override fun onStop() {
                        scope.launch { stop() }
                    }
                },
            )
        return start(capturer, size.first, size.second, PROJECTION_FRAMES_PER_SECOND, TITLE)
    }

    fun start(
        capturer: VideoCapturer,
        width: Int,
        height: Int,
        framesPerSecond: Int,
        title: String,
    ): Boolean {
        if (capture != null) return true
        if (!client.state.value.connected) {
            problem.value = "Connect to a server before sharing your screen."
            capturer.dispose()
            return false
        }
        val factory = runtime.factory
        val textureHelper =
            SurfaceTextureHelper.create("MutterScreenCapture", runtime.egl.eglBaseContext)
        val source = factory.createVideoSource(true)
        val started =
            runCatching {
                    capturer.initialize(textureHelper, context, source.capturerObserver)
                    capturer.startCapture(width, height, framesPerSecond)
                }
                .isSuccess
        if (!started) {
            problem.value = "Your screen couldn't be captured."
            capturer.dispose()
            source.dispose()
            textureHelper.dispose()
            return false
        }
        val id = UUID.randomUUID().toString().replace("-", "").take(SHARE_ID_LENGTH)
        val track = factory.createVideoTrack("screen-$id", source)
        val newCapture = Capture(id, capturer, textureHelper, source, track, "mutter-$id")
        capture = newCapture
        problem.value = null
        sharing.value = OwnScreenShare(id, title, width, height)
        announce(newCapture, channelMembers(client.state.value))
        return true
    }

    fun stop() {
        val ending = capture ?: return
        capture = null
        signals.send(ending.announced.toList(), JSONObject().put("t", "stop").put("id", ending.id))
        ending.viewers.values.forEach(::closeViewer)
        ending.viewers.clear()
        runCatching { ending.capturer.stopCapture() }
        ending.capturer.dispose()
        ending.track.dispose()
        ending.source.dispose()
        ending.textureHelper.dispose()
        watchLimiter.clear()
        sharing.value = null
    }

    private fun handle(sender: Int, message: JSONObject) {
        val current = capture ?: return
        if (message.optString("id") != current.id) return
        when (message.optString("t")) {
            "watch" -> offer(current, sender)
            "answer" -> answer(current, sender, message.optString("sdp"))
            "leave" -> {
                current.viewers.remove(sender)?.let(::closeViewer)
                publishViewers()
            }
            "ice" ->
                current.viewers[sender]?.let { viewer ->
                    readIceCandidates(message).forEach { candidate ->
                        if (viewer.answered) viewer.connection.addIceCandidate(candidate)
                        else if (viewer.waitingCandidates.size < MAXIMUM_CANDIDATES)
                            viewer.waitingCandidates.add(candidate)
                    }
                }
        }
    }

    private fun followSession(state: SessionState) {
        val current = capture ?: return
        if (!state.connected) {
            if (state.status == "disconnected") stop()
            return
        }
        watchLimiter.forgetAllExcept(state.users.keys)
        val members = channelMembers(state).toSet()
        val departed = current.announced.filter { it !in members }
        if (departed.isNotEmpty()) {
            current.announced.removeAll(departed.toSet())
            signals.send(departed, JSONObject().put("t", "stop").put("id", current.id))
        }
        current.viewers.keys.filter { it !in members }.forEach { session ->
            current.viewers.remove(session)?.let(::closeViewer)
        }
        val newcomers = members.filter { it !in current.announced }
        announce(current, newcomers)
        publishViewers()
    }

    private fun channelMembers(state: SessionState): List<Int> {
        val me = state.self ?: return emptyList()
        return state.users.values
            .filter { it.session != me.session && it.channel == me.channel }
            .map { it.session }
    }

    private fun isChannelMember(session: Int): Boolean =
        session in channelMembers(client.state.value)

    private fun announce(current: Capture, recipients: List<Int>) {
        if (recipients.isEmpty()) return
        current.announced.addAll(recipients)
        val share = sharing.value ?: return
        signals.send(
            recipients,
            JSONObject()
                .put("t", "announce")
                .put("id", current.id)
                .put("kind", "screen")
                .put("title", share.title)
                .put("w", share.width)
                .put("h", share.height)
                .put("audio", false),
        )
    }

    private fun offer(current: Capture, viewerSession: Int) {
        if (!isChannelMember(viewerSession)) return
        if (!watchLimiter.allow(viewerSession)) return
        current.announced.add(viewerSession)
        current.viewers.remove(viewerSession)?.let(::closeViewer)
        lateinit var viewer: ViewerConnection
        val connection =
            runtime.factory.createPeerConnection(
                runtime.configuration(store.settings.value),
                observer(viewerSession) { viewer },
            ) ?: return
        viewer = ViewerConnection(connection)
        current.viewers[viewerSession] = viewer
        val transceiver =
            connection.addTransceiver(
                current.track,
                RtpTransceiver.RtpTransceiverInit(
                    RtpTransceiver.RtpTransceiverDirection.SEND_ONLY,
                    listOf(current.streamId),
                ),
            )
        limitEncoding(transceiver)
        fun isCurrent() = capture === current && current.viewers[viewerSession] === viewer
        scope.launch {
            val offer = createOffer(connection)
            if (offer == null || !isCurrent()) return@launch closeIfCurrent(current, viewerSession, viewer)
            if (!setLocalDescription(connection, offer) || !isCurrent())
                return@launch closeIfCurrent(current, viewerSession, viewer)
            withTimeoutOrNull(GATHERING_DEADLINE_MILLISECONDS) { viewer.gatheringComplete.await() }
            if (!isCurrent()) return@launch
            val description = connection.localDescription?.description ?: offer.description
            viewer.descriptionSent = true
            signals.send(
                listOf(viewerSession),
                JSONObject().put("t", "offer").put("id", current.id).put("sdp", description),
                "offer:$viewerSession:${current.id}",
            )
        }
    }

    private fun closeIfCurrent(current: Capture, viewerSession: Int, viewer: ViewerConnection) {
        if (current.viewers[viewerSession] === viewer) {
            current.viewers.remove(viewerSession)
            closeViewer(viewer)
        }
    }

    private fun answer(current: Capture, viewerSession: Int, sdp: String) {
        val viewer = current.viewers[viewerSession] ?: return
        if (sdp.isBlank() || viewer.answered) return
        viewer.connection.setRemoteDescription(
            object : SdpObserver {
                override fun onSetSuccess() {
                    scope.launch {
                        if (current.viewers[viewerSession] !== viewer) return@launch
                        viewer.answered = true
                        viewer.waitingCandidates.forEach(viewer.connection::addIceCandidate)
                        viewer.waitingCandidates.clear()
                    }
                }

                override fun onSetFailure(error: String) {
                    scope.launch { problem.value = "A viewer's answer was rejected: $error" }
                }

                override fun onCreateSuccess(description: SessionDescription) {}

                override fun onCreateFailure(error: String) {}
            },
            SessionDescription(SessionDescription.Type.ANSWER, sdp),
        )
    }

    private fun limitEncoding(transceiver: RtpTransceiver) {
        runCatching {
            val sender = transceiver.sender
            val parameters = sender.parameters
            parameters.encodings.firstOrNull()?.let { encoding ->
                encoding.maxBitrateBps = MAXIMUM_BITRATE
                encoding.maxFramerate = PROJECTION_FRAMES_PER_SECOND
            }
            sender.parameters = parameters
        }
    }

    private fun observer(viewerSession: Int, viewer: () -> ViewerConnection) =
        object : PeerConnection.Observer {
            override fun onSignalingChange(state: PeerConnection.SignalingState) {}

            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {}

            override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
                scope.launch {
                    val current = capture ?: return@launch
                    val connection = viewer()
                    if (current.viewers[viewerSession] !== connection) return@launch
                    connection.connected = state == PeerConnection.PeerConnectionState.CONNECTED
                    if (
                        state == PeerConnection.PeerConnectionState.FAILED ||
                            state == PeerConnection.PeerConnectionState.CLOSED
                    ) {
                        current.viewers.remove(viewerSession)
                        closeViewer(connection)
                    }
                    publishViewers()
                }
            }

            override fun onIceConnectionReceivingChange(receiving: Boolean) {}

            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
                if (state == PeerConnection.IceGatheringState.COMPLETE)
                    scope.launch { viewer().gatheringComplete.complete(Unit) }
            }

            override fun onIceCandidate(candidate: IceCandidate) {
                scope.launch { trickle(viewerSession, viewer(), candidate) }
            }

            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}

            override fun onAddStream(stream: MediaStream) {}

            override fun onRemoveStream(stream: MediaStream) {}

            override fun onDataChannel(channel: DataChannel) {}

            override fun onRenegotiationNeeded() {}

            override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {}
        }

    private fun trickle(viewerSession: Int, viewer: ViewerConnection, candidate: IceCandidate) {
        val current = capture ?: return
        if (!viewer.descriptionSent || current.viewers[viewerSession] !== viewer) return
        viewer.lateCandidates.add(candidate)
        if (viewer.trickle?.isActive == true) return
        viewer.trickle =
            scope.launch {
                delay(TRICKLE_BATCH_MILLISECONDS)
                if (current.viewers[viewerSession] !== viewer) return@launch
                val batch = viewer.lateCandidates.toTypedArray()
                viewer.lateCandidates.clear()
                signals.send(
                    listOf(viewerSession),
                    JSONObject()
                        .put("t", "ice")
                        .put("id", current.id)
                        .put("c", candidateList(*batch)),
                )
            }
    }

    private fun closeViewer(viewer: ViewerConnection) {
        viewer.trickle?.cancel()
        viewer.connection.close()
        viewer.connection.dispose()
    }

    private fun publishViewers() {
        val current = capture ?: return
        val watching = current.viewers.values.count { it.connected }
        sharing.value = sharing.value?.copy(viewers = watching)
    }

    private suspend fun createOffer(connection: PeerConnection): SessionDescription? =
        suspendCancellableCoroutine { continuation ->
            connection.createOffer(
                object : SdpObserver {
                    override fun onCreateSuccess(description: SessionDescription) {
                        if (continuation.isActive) continuation.resume(description)
                    }

                    override fun onCreateFailure(error: String) {
                        if (continuation.isActive) continuation.resume(null)
                    }

                    override fun onSetSuccess() {}

                    override fun onSetFailure(error: String) {}
                },
                MediaConstraints(),
            )
        }

    private suspend fun setLocalDescription(
        connection: PeerConnection,
        description: SessionDescription,
    ): Boolean = suspendCancellableCoroutine { continuation ->
        connection.setLocalDescription(
            object : SdpObserver {
                override fun onSetSuccess() {
                    if (continuation.isActive) continuation.resume(true)
                }

                override fun onSetFailure(error: String) {
                    if (continuation.isActive) continuation.resume(false)
                }

                override fun onCreateSuccess(description: SessionDescription) {}

                override fun onCreateFailure(error: String) {}
            },
            description,
        )
    }

    companion object {
        const val TITLE = "Phone screen"
        const val SHARE_ID_LENGTH = 8
        const val PROJECTION_FRAMES_PER_SECOND = 30
        const val MAXIMUM_BITRATE = 2_500_000
        const val LONGEST_EDGE = 1280
        const val GATHERING_DEADLINE_MILLISECONDS = 2500L
        const val TRICKLE_BATCH_MILLISECONDS = 250L

        fun captureSize(displayWidth: Int, displayHeight: Int): Pair<Int, Int> {
            val longest = maxOf(displayWidth, displayHeight).coerceAtLeast(1)
            val scale = minOf(1.0, LONGEST_EDGE.toDouble() / longest)
            fun even(value: Double) = (value.toInt() / 2 * 2).coerceAtLeast(2)
            return even(displayWidth * scale) to even(displayHeight * scale)
        }
    }
}
