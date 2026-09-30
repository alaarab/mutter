package com.alaarab.mutter.sharing

import com.alaarab.mutter.protocol.MumbleConnection
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

class SignalChannel(private val client: MumbleConnection, private val scope: CoroutineScope) {
    private class QueuedFragment(
        val receivers: List<Int>,
        val data: ByteArray,
        val messageNumber: Long,
        val replaces: String?,
    )

    private val codec = SignalCodec()
    private val queue = ArrayDeque<QueuedFragment>()
    private val listeners = mutableListOf<(Int, JSONObject) -> Unit>()
    private var nextMessageNumber = 0L
    private var pump: Job? = null

    fun listen(listener: (Int, JSONObject) -> Unit) {
        listeners.add(listener)
    }

    fun receive(sender: Int, dataId: String, bytes: ByteArray) {
        if (dataId != DATA_ID || sender !in client.state.value.users) return
        val payload = codec.receive(sender, bytes) ?: return
        val message =
            runCatching { JSONObject(payload.toString(Charsets.UTF_8)) }.getOrNull() ?: return
        val id = message.optString("id")
        if (id.isBlank() || id.length > MAXIMUM_ID_LENGTH || message.optString("t").isBlank())
            return
        scope.launch { listeners.forEach { listener -> listener(sender, message) } }
    }

    fun send(receivers: List<Int>, message: JSONObject, replaces: String? = null) {
        val online = receivers.filter { it in client.state.value.users }
        if (online.isEmpty()) return
        val fragments =
            runCatching { codec.encode(message.toString().toByteArray()) }.getOrNull() ?: return
        scope.launch {
            val messageNumber = nextMessageNumber++
            if (replaces != null) queue.removeAll { it.replaces == replaces }
            fragments.forEach { queue.addLast(QueuedFragment(online, it, messageNumber, replaces)) }
            trimQueue()
            if (pump?.isActive != true) pump = scope.launch { drain() }
        }
    }

    fun clear() {
        pump?.cancel()
        pump = null
        queue.clear()
    }

    private fun trimQueue() {
        while (queue.size > MAXIMUM_QUEUED_FRAGMENTS) {
            val oldest = queue.first().messageNumber
            queue.removeAll { it.messageNumber == oldest }
        }
    }

    private suspend fun drain() {
        while (queue.isNotEmpty()) {
            val fragment = queue.removeFirst()
            client.sendPlugin(fragment.receivers, fragment.data)
            delay(FRAGMENT_SPACING_MILLISECONDS)
        }
    }

    companion object {
        const val DATA_ID = "mutter/rtc"
        const val MAXIMUM_ID_LENGTH = 256
        const val MAXIMUM_QUEUED_FRAGMENTS = 60
        const val FRAGMENT_SPACING_MILLISECONDS = 350L
    }
}
