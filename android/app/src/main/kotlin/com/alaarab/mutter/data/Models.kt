package com.alaarab.mutter.data

import java.util.UUID

data class Server(
    val id: String = UUID.randomUUID().toString(),
    val name: String = "",
    val host: String = "",
    val port: Int = 64738,
    val username: String = "",
    val password: String = "",
    val tokens: List<String> = emptyList(),
    val fingerprint: String = "",
    val identity: String = "default",
    val favorite: Boolean = false,
    val lastUsed: Long = 0,
)

data class Settings(
    val theme: String = "carbon",
    val appearance: String = "system",
    val voiceMode: String = "ptt",
    val bitrate: Int = 40000,
    val threshold: Float = .035f,
    val noiseSuppression: Boolean = true,
    val echoCancellation: Boolean = true,
    val autoGain: Boolean = true,
    val speaker: Boolean = false,
    val hideEmpty: Boolean = false,
    val keepAwake: Boolean = false,
    val stun: String = "stun:stun.l.google.com:19302",
    val turn: String = "",
    val turnUser: String = "",
    val turnPassword: String = "",
    val defaultUsername: String = "",
)

data class Channel(
    val id: Int,
    val parent: Int = -1,
    val name: String = "",
    val description: String = "",
    val position: Int = 0,
    val temporary: Boolean = false,
    val permissions: Long? = null,
    val maxUsers: Int = 0,
)

data class User(
    val session: Int,
    val name: String = "",
    val channel: Int = 0,
    val registered: Int = -1,
    val selfMute: Boolean = false,
    val selfDeaf: Boolean = false,
    val mute: Boolean = false,
    val deaf: Boolean = false,
    val suppress: Boolean = false,
    val priority: Boolean = false,
    val comment: String = "",
    val hash: String = "",
    val talkingUntil: Long = 0,
    val localMute: Boolean = false,
    val volume: Float = 1f,
    val listening: Set<Int> = emptySet(),
)

data class ChatMessage(
    val id: String = UUID.randomUUID().toString(),
    val sender: Int? = null,
    val name: String,
    val html: String,
    val channel: Int? = null,
    val direct: Int? = null,
    val own: Boolean = false,
    val time: Long = System.currentTimeMillis(),
)

data class CertificatePrompt(
    val fingerprint: String,
    val previous: String,
    val subject: String,
    val issuer: String,
    val validUntil: String,
)

data class IdentityInfo(val id: String, val name: String, val fingerprint: String)

data class SessionState(
    val status: String = "disconnected",
    val server: Server? = null,
    val me: Int? = null,
    val channels: Map<Int, Channel> = emptyMap(),
    val users: Map<Int, User> = emptyMap(),
    val messages: List<ChatMessage> = emptyList(),
    val permissions: Long = 0,
    val version: String = "",
    val welcome: String = "",
    val udp: Boolean = false,
    val ping: Long = 0,
    val error: String? = null,
    val certificate: CertificatePrompt? = null,
    val maxImage: Int = 131072,
    val maxText: Int = 5000,
    val userStats: String? = null,
    val registeredUsers: Map<Int, String> = emptyMap(),
    val log: List<String> = emptyList(),
    val reconnectAttempt: Int = 0,
    val unread: Int = 0,
) {
    val connected
        get() = status == "connected"

    val self
        get() = users[me]

    val channel
        get() = channels[self?.channel ?: 0]

    fun can(permission: Long, channel: Int? = null): Boolean {
        val value = if (channel == null) permissions else channels[channel]?.permissions ?: 0L
        return value and 1L != 0L || value and permission != 0L
    }
}
