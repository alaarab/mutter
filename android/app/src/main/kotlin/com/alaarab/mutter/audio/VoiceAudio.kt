package com.alaarab.mutter.audio

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.*
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import com.alaarab.mutter.data.AppStore
import com.alaarab.mutter.protocol.MumbleConnection
import com.alaarab.mutter.protocol.VoicePacket
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.sqrt
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow

class VoiceAudio(
    private val context: Context,
    private val store: AppStore,
    private val client: MumbleConnection,
) {
    val level = MutableStateFlow(0f)
    val transmitting = MutableStateFlow(false)
    val pausedByAnotherApp = MutableStateFlow(false)

    @Volatile
    var held = false
        set(value) {
            field = value
            if (value) reclaimFocus()
        }

    @Volatile
    var whisperHeld = false
        set(value) {
            field = value
            if (value) reclaimFocus()
        }

    @Volatile var focusAvailable = true
    @Volatile private var started = false
    private var job: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val streams = ConcurrentHashMap<Int, Playback>()
    private val manager = context.getSystemService(AudioManager::class.java)
    private var recorder: AudioRecord? = null
    private val deviceCallback =
        object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(devices: Array<out AudioDeviceInfo>) {
                route()
            }

            override fun onAudioDevicesRemoved(devices: Array<out AudioDeviceInfo>) {
                route()
            }
        }
    private val focus =
        AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(attributes())
            .setAcceptsDelayedFocusGain(true)
            .setWillPauseWhenDucked(false)
            .setOnAudioFocusChangeListener(
                { change -> focusChanged(change) },
                android.os.Handler(android.os.Looper.getMainLooper()),
            )
            .build()

    private fun focusChanged(change: Int) {
        when (change) {
            AudioManager.AUDIOFOCUS_GAIN,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> focusAvailable = true
            else -> {
                focusAvailable = false
                held = false
                whisperHeld = false
            }
        }
        pausedByAnotherApp.value = started && !focusAvailable
    }

    private fun requestFocus() {
        val result = manager.requestAudioFocus(focus)
        focusAvailable = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        pausedByAnotherApp.value = started && !focusAvailable
    }

    fun reclaimFocus() {
        if (started && !focusAvailable) requestFocus()
    }

    fun start() {
        if (job != null) return
        started = true
        manager.mode = AudioManager.MODE_IN_COMMUNICATION
        requestFocus()
        manager.registerAudioDeviceCallback(
            deviceCallback,
            android.os.Handler(android.os.Looper.getMainLooper()),
        )
        route()
        if (
            context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) !=
                PackageManager.PERMISSION_GRANTED
        )
            return
        job = scope.launch {
            var encoder: MediaCodec? = null
            var input: AudioRecord? = null
            val effects = mutableListOf<android.media.audiofx.AudioEffect>()
            try {
                val minimum =
                    AudioRecord.getMinBufferSize(
                        48000,
                        AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_16BIT,
                    )
                val record =
                    AudioRecord.Builder()
                        .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
                        .setAudioFormat(
                            AudioFormat.Builder()
                                .setSampleRate(48000)
                                .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                                .build()
                        )
                        .setBufferSizeInBytes(maxOf(minimum, 960 * 8))
                        .build()
                input = record
                require(record.state == AudioRecord.STATE_INITIALIZED) {
                    "Microphone could not start"
                }
                recorder = record
                if (AcousticEchoCanceler.isAvailable())
                    AcousticEchoCanceler.create(record.audioSessionId)?.let {
                        it.enabled = store.settings.value.echoCancellation
                        effects.add(it)
                    }
                if (NoiseSuppressor.isAvailable())
                    NoiseSuppressor.create(record.audioSessionId)?.let {
                        it.enabled = store.settings.value.noiseSuppression
                        effects.add(it)
                    }
                if (AutomaticGainControl.isAvailable())
                    AutomaticGainControl.create(record.audioSessionId)?.let {
                        it.enabled = store.settings.value.autoGain
                        effects.add(it)
                    }
                record.startRecording()
                val pcm = ShortArray(960)
                var talking = false
                var spurtTarget = 0
                var hangover = 0L
                var timestamp = 0L
                var bitrate = -1
                while (isActive) {
                    val count = record.read(pcm, 0, pcm.size, AudioRecord.READ_BLOCKING)
                    if (count < 0) error("Microphone read failed ($count)")
                    if (count == 0) continue
                    val settings = store.settings.value
                    if (bitrate != settings.bitrate) {
                        encoder?.stop()
                        encoder?.release()
                        encoder =
                            MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS).apply {
                                configure(
                                    MediaFormat.createAudioFormat(
                                            MediaFormat.MIMETYPE_AUDIO_OPUS,
                                            48000,
                                            1,
                                        )
                                        .apply {
                                            setInteger(MediaFormat.KEY_BIT_RATE, settings.bitrate)
                                            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 1920)
                                        },
                                    null,
                                    null,
                                    MediaCodec.CONFIGURE_FLAG_ENCODE,
                                )
                                start()
                            }
                        bitrate = settings.bitrate
                    }
                    var sum = 0.0
                    for (index in 0 until count) {
                        val value = pcm[index].toDouble() / 32768
                        sum += value * value
                    }
                    val rms = sqrt(sum / count).toFloat()
                    level.value = rms.coerceIn(0f, 1f)
                    val now = System.currentTimeMillis()
                    if (rms > settings.threshold) hangover = now + 250
                    val self = client.state.value.self
                    val allowed =
                        focusAvailable &&
                            self != null &&
                            !self.selfMute &&
                            !self.selfDeaf &&
                            !self.mute &&
                            !self.suppress
                    val open =
                        allowed &&
                            (whisperHeld ||
                                held ||
                                settings.voiceMode == "continuous" ||
                                (settings.voiceMode == "vad" && now < hangover))
                    val target = if (whisperHeld) 1 else 0
                    if (open && talking && target != spurtTarget) {
                        encoder?.let { finished ->
                            drain(finished) { packet ->
                                client.sendAudio(packet, target = spurtTarget)
                            }
                        }
                        client.sendAudio(byteArrayOf(), end = true, target = spurtTarget)
                        talking = false
                    }
                    if (open) {
                        spurtTarget = target
                        val codec = encoder!!
                        val index = codec.dequeueInputBuffer(10000)
                        if (index >= 0) {
                            codec
                                .getInputBuffer(index)!!
                                .order(ByteOrder.LITTLE_ENDIAN)
                                .asShortBuffer()
                                .put(pcm, 0, count)
                            codec.queueInputBuffer(index, 0, count * 2, timestamp, 0)
                            timestamp += count * 1000000L / 48000
                        }
                        drain(codec) { packet -> client.sendAudio(packet, target = spurtTarget) }
                    } else if (talking) {
                        encoder?.let {
                            drain(it) { packet -> client.sendAudio(packet, target = spurtTarget) }
                        }
                        client.sendAudio(byteArrayOf(), end = true, target = spurtTarget)
                    }
                    transmitting.value = open
                    talking = open
                }
            } catch (error: Exception) {
                if (isActive) client.note("Audio: ${error.message}")
            } finally {
                runCatching { input?.stop() }
                input?.release()
                if (recorder === input) recorder = null
                effects.forEach { it.release() }
                runCatching { encoder?.stop() }
                encoder?.release()
                level.value = 0f
                transmitting.value = false
            }
        }
    }

    fun stop() {
        started = false
        held = false
        whisperHeld = false
        pausedByAnotherApp.value = false
        job?.cancel()
        job = null
        runCatching { recorder?.stop() }
        streams.values.forEach { it.close() }
        streams.clear()
        manager.unregisterAudioDeviceCallback(deviceCallback)
        manager.abandonAudioFocusRequest(focus)
        if (Build.VERSION.SDK_INT >= 31) manager.clearCommunicationDevice()
        else {
            @Suppress("DEPRECATION") manager.stopBluetoothSco()
        }
        manager.mode = AudioManager.MODE_NORMAL
    }

    fun restart() {
        stop()
        start()
    }

    fun route() {
        runCatching { applyRoute() }.onFailure { client.note("Audio route: ${it.message}") }
    }

    @Suppress("DEPRECATION")
    private fun applyRoute() {
        val speaker = store.settings.value.speaker
        if (Build.VERSION.SDK_INT >= 31) {
            val devices = manager.availableCommunicationDevices
            val device =
                if (speaker) devices.find { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                else
                    devices.firstOrNull {
                        it.type in
                            setOf(
                                AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
                                AudioDeviceInfo.TYPE_BLE_HEADSET,
                                AudioDeviceInfo.TYPE_WIRED_HEADSET,
                                AudioDeviceInfo.TYPE_USB_HEADSET,
                            )
                    } ?: devices.find { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
            device?.let { manager.setCommunicationDevice(it) }
        } else {
            manager.isSpeakerphoneOn = speaker
            if (
                !speaker &&
                    manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any {
                        it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                    }
            ) {
                manager.startBluetoothSco()
                manager.isBluetoothScoOn = true
            } else {
                manager.stopBluetoothSco()
                manager.isBluetoothScoOn = false
            }
        }
    }

    fun receive(packet: VoicePacket) {
        if (packet.opus.isEmpty()) {
            if (packet.end) streams[packet.session]?.offer(packet)
            return
        }
        val state = client.state.value
        if (state.self?.selfDeaf == true || state.self?.deaf == true || !focusAvailable) return
        val user = state.users[packet.session] ?: return
        if (user.localMute) return
        val playback = streams.computeIfAbsent(packet.session) { Playback(it) }
        if (!playback.offer(packet)) {
            // The stream just shut down after a long silence; start a fresh one.
            streams.remove(packet.session, playback)
            streams.computeIfAbsent(packet.session) { Playback(it) }.offer(packet)
        }
    }

    /**
     * One speaker: a jitter buffer and a writer thread at audio priority. Blocking 10 ms writes
     * to the AudioTrack pace the thread, so playout runs on the hardware clock rather than on
     * packet arrival.
     */
    private inner class Playback(private val session: Int) {
        private val decoder = OpusDecoder()
        private val playout = Playout(session, decoder)
        @Volatile private var running = true

        init {
            Thread({ run() }, "Mutter playout $session").apply {
                isDaemon = true
                start()
            }
        }

        private fun run() {
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO)
            var track: AudioTrack? = null
            try {
                decoder.start()
                track =
                    AudioTrack.Builder()
                        .setAudioAttributes(attributes())
                        .setAudioFormat(
                            AudioFormat.Builder()
                                .setSampleRate(48000)
                                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                                .build()
                        )
                        .setBufferSizeInBytes(
                            // The jitter buffer absorbs network delay; this only has to cover
                            // scheduling, and every byte of it is added latency.
                            maxOf(
                                AudioTrack.getMinBufferSize(
                                    48000,
                                    AudioFormat.CHANNEL_OUT_MONO,
                                    AudioFormat.ENCODING_PCM_16BIT,
                                ),
                                TRACK_BUFFER_BYTES,
                            )
                        )
                        .setTransferMode(AudioTrack.MODE_STREAM)
                        .build()
                track.play()
                val frame = FloatArray(FRAME_SAMPLES)
                val out = ShortArray(FRAME_SAMPLES)
                var volume = -1f
                var idleFrames = 0
                var framesSinceReport = 0
                while (running) {
                    val written = playout.render(frame, FRAME_SAMPLES)
                    idleFrames = if (written == 0 && playout.isIdle) idleFrames + 1 else 0
                    if (idleFrames > IDLE_FRAMES_BEFORE_CLOSE) break
                    val wanted = volume()
                    if (wanted != volume) {
                        // AudioTrack ramps volume changes itself.
                        track.setVolume(wanted)
                        volume = wanted
                    }
                    for (index in 0 until FRAME_SAMPLES) {
                        out[index] = (frame[index].coerceIn(-1f, 1f) * 32767).toInt().toShort()
                    }
                    val result = track.write(out, 0, FRAME_SAMPLES, AudioTrack.WRITE_BLOCKING)
                    if (result < 0) error("AudioTrack write failed ($result)")
                    if (++framesSinceReport >= 100) {
                        framesSinceReport = 0
                        playout
                            .diagnosticsSummary(android.os.SystemClock.elapsedRealtime())
                            ?.let { client.note(it) }
                    }
                }
            } catch (error: Exception) {
                if (running) client.note("Playback: ${error.message}")
            } finally {
                running = false
                runCatching { track?.stop() }
                track?.release()
                decoder.release()
                streams.remove(session, this@Playback)
            }
        }

        private fun volume(): Float {
            val current = client.state.value
            val user = current.users[session]
            val silent =
                user?.localMute == true ||
                    current.self?.selfDeaf == true ||
                    current.self?.deaf == true ||
                    !focusAvailable
            return if (silent) 0f else (user?.volume ?: 0f).coerceIn(0f, 1f)
        }

        /** Returns false once the stream has shut down. */
        fun offer(packet: VoicePacket): Boolean {
            if (!running) return false
            playout.push(packet.frame, packet.opus, packet.end)
            return true
        }

        fun close() {
            running = false
        }
    }

    /**
     * MediaCodec's Opus decoder used one packet at a time. It has no loss concealment or FEC
     * entry point, which is why Playout conceals by itself.
     */
    private class OpusDecoder : Playout.Decoder {
        private var codec: MediaCodec? = null
        private val info = MediaCodec.BufferInfo()
        private val shorts = ShortArray(Playout.MAXIMUM_FRAME_SAMPLES)
        private var timestamp = 0L

        fun start() {
            codec =
                MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS).apply {
                    configure(
                        MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, 48000, 1)
                            .apply {
                                val header = ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN)
                                header
                                    .put("OpusHead".toByteArray())
                                    .put(1)
                                    .put(1)
                                    .putShort(0)
                                    .putInt(48000)
                                    .putShort(0)
                                    .put(0)
                                setByteBuffer("csd-0", ByteBuffer.wrap(header.array()))
                                setByteBuffer(
                                    "csd-1",
                                    ByteBuffer.allocate(8)
                                        .order(ByteOrder.nativeOrder())
                                        .putLong(0)
                                        .apply { flip() },
                                )
                                setByteBuffer(
                                    "csd-2",
                                    ByteBuffer.allocate(8)
                                        .order(ByteOrder.nativeOrder())
                                        .putLong(80000000)
                                        .apply { flip() },
                                )
                            },
                        null,
                        null,
                        0,
                    )
                    start()
                }
        }

        // The decoder is never flushed between utterances: a flush makes the Android decoder
        // discard the 80 ms seek pre-roll, and the gain ramp already hides any leftover state.
        override fun decode(packet: ByteArray, length: Int, output: FloatArray): Int {
            val codec = codec ?: return -1
            val input = codec.dequeueInputBuffer(DECODE_WAIT_MICROS)
            if (input < 0) return -1
            codec.getInputBuffer(input)!!.apply {
                clear()
                put(packet, 0, length)
            }
            codec.queueInputBuffer(input, 0, length, timestamp, 0)
            timestamp += 10000
            var count = 0
            var attempts = 0
            while (count < output.size) {
                val index =
                    codec.dequeueOutputBuffer(info, if (count == 0) DECODE_WAIT_MICROS else 0)
                if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) continue
                if (index < 0) {
                    if (count == 0 && ++attempts < 4) continue
                    break
                }
                if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
                    val samples = minOf(info.size / 2, output.size - count, shorts.size)
                    codec.getOutputBuffer(index)!!.apply {
                        position(info.offset)
                        limit(info.offset + info.size)
                        order(ByteOrder.nativeOrder()).asShortBuffer().get(shorts, 0, samples)
                    }
                    for (sample in 0 until samples) output[count + sample] = shorts[sample] / 32768f
                    count += samples
                }
                codec.releaseOutputBuffer(index, false)
            }
            return if (count == 0) -1 else count
        }

        fun release() {
            runCatching { codec?.stop() }
            codec?.release()
            codec = null
        }
    }

    companion object {
        private const val FRAME_SAMPLES = 480
        private const val TRACK_BUFFER_BYTES = 48 * 40 * 2
        private const val IDLE_FRAMES_BEFORE_CLOSE = 3000
        private const val DECODE_WAIT_MICROS = 5000L

        private fun attributes() =
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build()

        fun drain(codec: MediaCodec, output: (ByteArray) -> Unit) {
            val info = MediaCodec.BufferInfo()
            while (true) {
                val index = codec.dequeueOutputBuffer(info, 0)
                if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) continue
                if (index < 0) break
                if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
                    val data = ByteArray(info.size)
                    codec.getOutputBuffer(index)!!.apply {
                        position(info.offset)
                        limit(info.offset + info.size)
                        get(data)
                    }
                    output(data)
                }
                codec.releaseOutputBuffer(index, false)
            }
        }
    }
}
