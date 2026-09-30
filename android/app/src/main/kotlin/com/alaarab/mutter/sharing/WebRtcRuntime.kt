package com.alaarab.mutter.sharing

import android.content.Context
import com.alaarab.mutter.data.Settings
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory

class WebRtcRuntime(private val context: Context) {
    val egl: EglBase by lazy { EglBase.create() }

    val factory: PeerConnectionFactory by lazy {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context)
                .createInitializationOptions()
        )
        PeerConnectionFactory.builder()
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
            .createPeerConnectionFactory()
    }

    fun configuration(settings: Settings): PeerConnection.RTCConfiguration {
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
        return PeerConnection.RTCConfiguration(servers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
        }
    }
}

const val MAXIMUM_CANDIDATES = 256
const val MAXIMUM_CANDIDATE_LENGTH = 4096

fun readIceCandidates(message: JSONObject): List<IceCandidate> {
    val candidates = message.optJSONArray("c") ?: return emptyList()
    return (0 until minOf(candidates.length(), MAXIMUM_CANDIDATES)).mapNotNull { index ->
        val entry = candidates.optJSONObject(index) ?: return@mapNotNull null
        val sdp = entry.optString("candidate")
        if (sdp.isBlank() || sdp.length > MAXIMUM_CANDIDATE_LENGTH) return@mapNotNull null
        IceCandidate(entry.optString("sdpMid"), entry.optInt("sdpMLineIndex"), sdp)
    }
}

fun candidateList(vararg candidates: IceCandidate): JSONArray =
    JSONArray().apply {
        candidates.forEach { candidate ->
            put(
                JSONObject()
                    .put("candidate", candidate.sdp)
                    .put("sdpMid", candidate.sdpMid)
                    .put("sdpMLineIndex", candidate.sdpMLineIndex)
            )
        }
    }
