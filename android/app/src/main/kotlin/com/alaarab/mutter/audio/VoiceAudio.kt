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
import java.util.concurrent.PriorityBlockingQueue
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
    @Volatile var held = false
    @Volatile var whisperHeld = false
    @Volatile var focusAvailable = true
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
            .setOnAudioFocusChangeListener { change ->
                focusAvailable = change == AudioManager.AUDIOFOCUS_GAIN
                if (!focusAvailable) {
                    held = false
                    whisperHeld = false
                }
            }
            .build()

    fun start() {
        if (job != null) return
        manager.mode = AudioManager.MODE_IN_COMMUNICATION
        focusAvailable = manager.requestAudioFocus(focus) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
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
                    if (open) {
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
                        drain(codec) { packet ->
                            client.sendAudio(packet, target = if (whisperHeld) 1 else 0)
                        }
                    } else if (talking) {
                        encoder?.let { drain(it) { packet -> client.sendAudio(packet) } }
                        client.sendAudio(byteArrayOf(), end = true)
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
        held = false
        whisperHeld = false
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
        val state = client.state.value
        if (state.self?.selfDeaf == true || state.self?.deaf == true || !focusAvailable) return
        val user = state.users[packet.session] ?: return
        if (user.localMute || packet.opus.isEmpty()) return
        streams.computeIfAbsent(packet.session) { Playback(it) }.offer(packet)
    }

    private inner class Playback(private val session: Int) {
        private val queue = PriorityBlockingQueue<VoicePacket>(16, compareBy { it.frame })
        private val worker = scope.launch {
            var codec: MediaCodec? = null
            var track: AudioTrack? = null
            try {
                codec =
                    MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS).apply {
                        configure(
                            MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, 48000, 1)
                                .apply {
                                    val header =
                                        ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN)
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
                            maxOf(
                                AudioTrack.getMinBufferSize(
                                    48000,
                                    AudioFormat.CHANNEL_OUT_MONO,
                                    AudioFormat.ENCODING_PCM_16BIT,
                                ),
                                11520,
                            )
                        )
                        .setTransferMode(AudioTrack.MODE_STREAM)
                        .build()
                track.play()
                delay(40)
                var last = -1L
                var idle = 0
                fun playPending() {
                    drain(codec) { pcm ->
                        val current = client.state.value
                        val user = current.users[session]
                        val volume =
                            if (
                                user?.localMute == true ||
                                    current.self?.selfDeaf == true ||
                                    current.self?.deaf == true ||
                                    !focusAvailable
                            )
                                0f
                            else user?.volume ?: 0f
                        track.setVolume(volume.coerceIn(0f, 1f))
                        track.write(pcm, 0, pcm.size, AudioTrack.WRITE_BLOCKING)
                    }
                }
                while (isActive) {
                    playPending()
                    val packet = queue.poll()
                    if (packet == null) {
                        delay(10)
                        if (++idle > 3000) break
                        continue
                    }
                    idle = 0
                    if (packet.frame <= last) continue
                    last = packet.frame
                    val index = codec.dequeueInputBuffer(10000)
                    if (index < 0) continue
                    codec.getInputBuffer(index)!!.put(packet.opus)
                    codec.queueInputBuffer(index, 0, packet.opus.size, packet.frame * 10000, 0)
                    playPending()
                }
            } catch (error: Exception) {
                if (isActive) client.note("Playback: ${error.message}")
            } finally {
                runCatching { track?.stop() }
                track?.release()
                runCatching { codec?.stop() }
                codec?.release()
                streams.remove(session, this@Playback)
            }
        }

        fun offer(packet: VoicePacket) {
            if (queue.size > 25) queue.clear()
            queue.offer(packet)
        }

        fun close() {
            worker.cancel()
            queue.clear()
        }
    }

    companion object {
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
