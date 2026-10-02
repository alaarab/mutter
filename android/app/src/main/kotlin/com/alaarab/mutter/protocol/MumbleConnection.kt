package com.alaarab.mutter.protocol

import com.alaarab.mutter.data.*
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.security.KeyStore
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import javax.net.ssl.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

class MumbleConnection(private val store: AppStore, private val identities: Identities) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutableState = MutableStateFlow(SessionState())
    val state = mutableState.asStateFlow()
    @Volatile private var active: Link? = null
    private val stateLock = Any()
    private var connectionJob: Job? = null
    @Volatile private var trust: CompletableDeferred<Boolean>? = null
    @Volatile private var desiredDeaf = store.settings.value.selfDeaf
    @Volatile private var desiredMute = store.settings.value.selfMute || desiredDeaf
    @Volatile private var whisperTarget: ByteArray? = null
    private val lastVoiceAt = ConcurrentHashMap<Int, Long>()
    @Volatile
    var generation = 0L
        private set
    var onVoice: (VoicePacket) -> Unit = {}
    var onPlugin: (Int, String, ByteArray) -> Unit = { _, _, _ -> }
    var onMessage: (ChatMessage) -> Unit = {}

    fun connect(server: Server) {
        synchronized(stateLock) {
            stopConnection()
            whisperTarget = null
            generation++
            mutableState.value = SessionState(status = "connecting", server = server)
            connectionJob = scope.launch { keepConnected(server) }
        }
    }

    private suspend fun keepConnected(server: Server) = coroutineScope {
        var synced = false
        var attempt = 0
        while (isActive) {
            val link = Link()
            synchronized(stateLock) {
                if (!isActive) return@coroutineScope
                active = link
            }
            try {
                open(link, store.servers.value.find { it.id == server.id } ?: server)
                synced = true
                attempt = 0
            } catch (accepted: CertificateAccepted) {
                link.close()
                if (!isActive || active !== link) return@coroutineScope
                continue
            } catch (error: Exception) {
                if (!isActive || active !== link) return@coroutineScope
                if (link.synced) {
                    synced = true
                    attempt = 0
                }
                note(error.message ?: "Connection closed")
                if (!synced || attempt >= 6 || error is UntrustedCertificate) {
                    stopAfterFailure(link, error.message)
                    return@coroutineScope
                }
            } catch (exhausted: OutOfMemoryError) {
                if (active !== link) return@coroutineScope
                stopAfterFailure(link, "The server sent more data than Mutter can hold.")
                return@coroutineScope
            } finally {
                link.close()
            }
            if (!isActive) break
            attempt++
            publish(link) {
                it.copy(
                    status = "reconnecting",
                    reconnectAttempt = attempt,
                    udp = false,
                    certificate = null,
                )
            }
            delay((1000L shl attempt).coerceAtMost(30000))
        }
    }

    private fun stopAfterFailure(link: Link, message: String?) {
        synchronized(stateLock) {
            if (active !== link) return
            link.close()
            active = null
            mutableState.update {
                it.copy(status = "disconnected", error = message, certificate = null, udp = false)
            }
        }
    }

    fun disconnect(onlyGeneration: Long? = null) {
        synchronized(stateLock) {
            if (onlyGeneration != null && onlyGeneration != generation) return
            stopConnection()
            mutableState.update { it.copy(status = "disconnected", udp = false, certificate = null) }
        }
    }

    private fun stopConnection() {
        connectionJob?.cancel()
        connectionJob = null
        trust?.cancel()
        trust = null
        val link = active
        active = null
        link?.close()
        lastVoiceAt.clear()
    }

    private fun publish(link: Link, transform: (SessionState) -> SessionState) {
        synchronized(stateLock) { if (active === link) mutableState.update(transform) }
    }

    private fun updateRoster(link: Link, transform: (SessionState) -> SessionState) {
        synchronized(stateLock) {
            if (active !== link) return
            if (link.synced) {
                mutableState.update(transform)
            } else {
                link.roster = transform(link.roster)
            }
        }
    }

    private fun CoroutineScope.ensureCurrent(link: Link) {
        ensureActive()
        if (active !== link) throw CancellationException("The connection was replaced")
    }

    fun answerTrust(accepted: Boolean) {
        trust?.complete(accepted)
    }

    fun dismissError() {
        mutableState.update { it.copy(error = null, userStats = null) }
    }

    fun localUser(session: Int, volume: Float? = null, mute: Boolean? = null) {
        mutableState.update { s ->
            s.copy(
                users =
                    s.users.mapValues { (id, user) ->
                        if (id == session)
                            user.copy(
                                volume = volume ?: user.volume,
                                localMute = mute ?: user.localMute,
                            )
                        else user
                    }
            )
        }
    }

    fun action(type: Int, message: Proto): Boolean {
        val link = active ?: return false
        if (!state.value.connected) return false
        scope.launch { runCatching { link.send(type, message.build()) }.onFailure { link.close() } }
        return true
    }

    fun join(channel: Int) {
        state.value.me?.let { action(9, Proto().number(1, it).number(5, channel)) }
        action(20, Proto().number(1, channel))
    }

    fun mute(muted: Boolean) {
        desiredMute = muted
        if (!muted) desiredDeaf = false
        updateSelfFlags()
        rememberSelfFlags()
        state.value.me?.let {
            action(9, Proto().number(1, it).bool(9, desiredMute).bool(10, desiredDeaf))
        }
    }

    fun deafen(deaf: Boolean) {
        desiredDeaf = deaf
        if (deaf) desiredMute = true
        updateSelfFlags()
        rememberSelfFlags()
        state.value.me?.let {
            action(9, Proto().number(1, it).bool(9, desiredMute).bool(10, desiredDeaf))
        }
    }

    private fun rememberSelfFlags() {
        scope.launch {
            runCatching {
                store.updateSettings { it.copy(selfMute = desiredMute, selfDeaf = desiredDeaf) }
            }
        }
    }

    private fun updateSelfFlags() {
        mutableState.update { state ->
            state.self?.let { user ->
                state.copy(
                    users =
                        state.users +
                            (user.session to
                                user.copy(selfMute = desiredMute, selfDeaf = desiredDeaf))
                )
            } ?: state
        }
    }

    fun markMessagesRead() {
        mutableState.update { it.copy(unread = 0) }
    }

    fun listen(channel: Int, enabled: Boolean) {
        state.value.me?.let {
            action(9, Proto().number(1, it).number(if (enabled) 21 else 22, channel))
        }
    }

    fun whisper(users: Set<Int>, channel: Int? = null, children: Boolean = false) {
        val target = Proto()
        users.forEach { target.number(1, it) }
        channel?.let { target.number(2, it).bool(4, children) }
        val registration =
            Proto().number(1, 1).apply {
                if (users.isNotEmpty() || channel != null) message(2, target)
            }
        whisperTarget = registration.build()
        action(19, registration)
    }

    fun sendText(
        html: String,
        channel: Int? = null,
        direct: Int? = null,
        tree: Boolean = false,
    ): Boolean {
        val current = state.value
        val message = Proto().text(5, html)
        if (direct != null) message.number(2, direct)
        else message.number(if (tree) 4 else 3, channel ?: current.self?.channel ?: 0)
        if (!action(11, message)) return false
        addMessage(
            ChatMessage(
                sender = current.me,
                name = current.self?.name ?: "Me",
                html = html,
                channel = if (direct == null) channel ?: current.self?.channel ?: 0 else null,
                direct = direct,
                own = true,
            )
        )
        return true
    }

    fun sendPlugin(receivers: List<Int>, data: ByteArray) {
        if (receivers.isEmpty()) return
        action(
            26,
            Proto()
                .apply { receivers.forEach { number(2, it) } }
                .bytes(3, data)
                .text(4, "mutter/rtc"),
        )
    }

    fun sendAudio(opus: ByteArray, end: Boolean = false, target: Int = 0) {
        val link = active ?: return
        val self = state.value.self ?: return
        if (
            !state.value.connected ||
                (!end && (self.selfMute || self.selfDeaf || self.mute || self.suppress))
        )
            return
        val packet = VoiceWire.audio(opus, link.sequence.getAndAdd(2), end, target, link.modern)
        if (state.value.udp && link.crypt.valid) {
            if (runCatching { link.sendUdp(packet) }.isSuccess) return
            publish(link) { it.copy(udp = false) }
        }
        runCatching { link.send(1, packet) }.onFailure { link.close() }
    }

    fun note(message: String) {
        mutableState.update { it.copy(log = (it.log + message.take(1000)).takeLast(300)) }
    }

    @android.annotation.SuppressLint("CustomX509TrustManager")
    private suspend fun open(link: Link, server: Server) = coroutineScope {
        publish(link) {
            it.copy(
                status = if (it.reconnectAttempt > 0) "reconnecting" else "connecting",
                certificate = null,
            )
        }
        lastVoiceAt.clear()
        val presented =
            object : X509TrustManager {
                override fun getAcceptedIssuers() = emptyArray<X509Certificate>()

                override fun checkClientTrusted(chain: Array<X509Certificate>, type: String) = Unit

                override fun checkServerTrusted(chain: Array<X509Certificate>, type: String) {
                    require(chain.isNotEmpty())
                    link.chain = chain
                    link.authType = type
                }
            }
        val keyManagers = identities.keyManagers(server.identity)
        ensureCurrent(link)
        val ssl =
            SSLContext.getInstance("TLS").apply {
                init(keyManagers, arrayOf(presented), SecureRandom())
            }
        val raw = Socket()
        link.attach(raw)
        raw.connect(InetSocketAddress(server.host, server.port), 10000)
        raw.tcpNoDelay = true
        raw.soTimeout = 15000
        val socket =
            ssl.socketFactory.createSocket(raw, server.host, server.port, true) as SSLSocket
        link.attach(socket)
        socket.enabledProtocols =
            socket.supportedProtocols.filter { it == "TLSv1.3" || it == "TLSv1.2" }.toTypedArray()
        socket.startHandshake()
        ensureCurrent(link)
        val chain = link.chain ?: error("Server did not provide a certificate")
        val cert = chain[0]
        val fingerprint = Identities.fingerprint(cert)
        val knownFingerprints = trustedFingerprints(server, store.servers.value)
        val trustedByAuthority =
            isTrustedByAuthority(chain, link.authType.orEmpty(), server.host, socket.session)
        when (certificateDecision(fingerprint, trustedByAuthority, knownFingerprints)) {
            CertificateDecision.Pinned,
            CertificateDecision.TrustedByAuthority ->
                if (fingerprint != server.fingerprint) store.trustFingerprint(server, fingerprint)
            CertificateDecision.FirstContact,
            CertificateDecision.Changed -> {
                link.close()
                val answer = CompletableDeferred<Boolean>()
                trust = answer
                publish(link) {
                    it.copy(
                        status = "certificate",
                        certificate =
                            CertificatePrompt(
                                fingerprint,
                                knownFingerprints.firstOrNull().orEmpty(),
                                cert.subjectX500Principal.name,
                                cert.issuerX500Principal.name,
                                cert.notAfter.toString(),
                            ),
                    )
                }
                val accepted =
                    try {
                        withTimeout(120000) { answer.await() }
                    } finally {
                        if (trust === answer) trust = null
                    }
                if (!accepted) throw UntrustedCertificate()
                ensureCurrent(link)
                store.trustFingerprint(server, fingerprint)
                throw CertificateAccepted()
            }
        }
        ensureCurrent(link)
        publish(link) { it.copy(status = "authenticating", certificate = null) }
        socket.soTimeout = 20000
        link.output = DataOutputStream(socket.outputStream)
        val input = DataInputStream(socket.inputStream)
        link.send(
            0,
            Proto()
                .number(1, 0x10500)
                .text(2, "Mutter Android")
                .text(3, "Android")
                .text(4, android.os.Build.VERSION.RELEASE)
                .number(5, (1L shl 48) or (5L shl 32))
                .build(),
        )
        link.send(
            2,
            Proto()
                .text(1, server.username)
                .apply {
                    if (server.password.isNotEmpty()) text(2, server.password)
                    server.tokens.forEach { text(3, it) }
                }
                .bool(5, true)
                .number(6, 0)
                .build(),
        )
        val serverAddress = raw.inetAddress
        val udp = DatagramSocket().apply { soTimeout = 1000 }
        link.attach(udp, InetSocketAddress(serverAddress, server.port))
        val receiver =
            launch(Dispatchers.IO) {
                val buffer = ByteArray(MAX_DATAGRAM + 1)
                while (isActive && active === link && !udp.isClosed) {
                    try {
                        val packet = DatagramPacket(buffer, buffer.size)
                        udp.receive(packet)
                        if (!fromServer(packet, serverAddress, server.port)) continue
                        val plain = link.crypt.decrypt(buffer.copyOf(packet.length)) ?: continue
                        link.lastUdp = System.currentTimeMillis()
                        if (VoiceWire.isPing(plain, link.modern))
                            publish(link) { it.copy(udp = true) }
                        else voice(link, plain)
                    } catch (_: java.net.SocketTimeoutException) {} catch (error: Exception) {
                        if (udp.isClosed || active !== link) break
                        publish(link) { it.copy(udp = false) }
                        delay(1000)
                    }
                }
            }
        val ping =
            launch(Dispatchers.IO) {
                while (isActive && active === link) {
                    delay(5000)
                    runCatching {
                        val now = System.currentTimeMillis()
                        link.send(
                            3,
                            Proto()
                                .number(1, now * 1000)
                                .number(2, link.crypt.good)
                                .number(3, link.crypt.late)
                                .number(4, link.crypt.lost)
                                .build(),
                        )
                        if (link.crypt.valid) {
                            val pinged =
                                runCatching {
                                        link.sendUdp(VoiceWire.ping(now * 1000, link.modern))
                                    }
                                    .isSuccess
                            if (!pinged || now - link.lastUdp > 10000)
                                publish(link) { it.copy(udp = false) }
                            if (
                                link.lastUdp > 0 &&
                                    now - link.lastUdp > 15000 &&
                                    now - link.lastResync > 15000
                            ) {
                                link.lastResync = now
                                link.send(15, byteArrayOf())
                            }
                        }
                    }
                        .onFailure { link.close() }
                }
            }
        val speech =
            launch(Dispatchers.Default) {
                while (isActive && active === link) {
                    delay(100)
                    expireSpeech(link, System.currentTimeMillis() - SPEECH_TIMEOUT_MILLIS)
                }
            }
        try {
            while (isActive && active === link) {
                val frame = input.readFrame()
                if (active !== link) break
                if (frame.type == 1) voice(link, frame.payload)
                else receive(link, frame.type, Proto.parse(frame.payload))
            }
        } finally {
            receiver.cancel()
            ping.cancel()
            speech.cancel()
            link.close()
        }
    }

    private fun isTrustedByAuthority(
        chain: Array<X509Certificate>,
        authType: String,
        host: String,
        session: SSLSession,
    ): Boolean =
        runCatching {
                val platform =
                    TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
                        .apply { init(null as KeyStore?) }
                        .trustManagers
                        .filterIsInstance<X509TrustManager>()
                        .first()
                android.net.http.X509TrustManagerExtensions(platform)
                    .checkServerTrusted(chain, authType, host)
                HttpsURLConnection.getDefaultHostnameVerifier().verify(host, session)
            }
            .getOrDefault(false)

    private fun fromServer(packet: DatagramPacket, address: InetAddress, port: Int) =
        packet.address == address && packet.port == port && packet.length <= MAX_DATAGRAM

    private fun voice(link: Link, data: ByteArray) {
        if (!link.synced || active !== link) return
        val packet = VoiceWire.decode(data, link.modern) ?: return
        if (packet.session !in state.value.users) return
        if (packet.end) {
            lastVoiceAt.remove(packet.session)
            setSpeaking(link, setOf(packet.session), speaking = false)
        } else if (lastVoiceAt.put(packet.session, System.currentTimeMillis()) == null) {
            setSpeaking(link, setOf(packet.session), speaking = true)
        }
        onVoice(packet)
    }

    private fun expireSpeech(link: Link, cutoff: Long) {
        val quiet = lastVoiceAt.filter { it.value < cutoff }
        if (quiet.isEmpty()) return
        quiet.forEach { (session, time) -> lastVoiceAt.remove(session, time) }
        setSpeaking(link, quiet.keys, speaking = false)
    }

    private fun setSpeaking(link: Link, sessions: Set<Int>, speaking: Boolean) {
        val talkingUntil = if (speaking) SPEAKING else 0L
        publish(link) { current ->
            val changed =
                sessions
                    .mapNotNull { current.users[it] }
                    .filter { it.talkingUntil != talkingUntil }
                    .associate { it.session to it.copy(talkingUntil = talkingUntil) }
            if (changed.isEmpty()) current else current.copy(users = current.users + changed)
        }
    }

    private fun addMessage(message: ChatMessage) {
        mutableState.update {
            it.copy(
                messages = SessionLimits.messagesWith(it.messages, message),
                unread = it.unread + if (!message.own && message.sender != null) 1 else 0,
            )
        }
        onMessage(message)
    }

    private fun receive(link: Link, type: Int, f: Fields) {
        when (type) {
            0 -> {
                link.modern =
                    if (f.long(5) != 0L) f.long(5) >= ((1L shl 48) or (5L shl 32))
                    else f.long(1) >= 0x10500
                mutableState.update { it.copy(version = f.text(2)) }
            }
            3 ->
                if (f.has(1))
                    mutableState.update {
                        it.copy(
                            ping =
                                (System.currentTimeMillis() - f.long(1) / 1000).coerceIn(0, 60000)
                        )
                    }
            4 -> error(f.text(2, "The server rejected the connection").take(2000))
            5 -> {
                val session = f.int(1)
                val freshRoster = link.roster
                publish(link) {
                    link.synced = true
                    val user = freshRoster.users[session]
                    it.copy(
                        status = "connected",
                        me = session,
                        channels = freshRoster.channels,
                        permissions = f.long(4),
                        welcome = SessionLimits.messageHtml(f.text(3)),
                        reconnectAttempt = 0,
                        error = null,
                        users =
                            if (user == null) freshRoster.users
                            else
                                freshRoster.users +
                                    (session to
                                        user.copy(selfMute = desiredMute, selfDeaf = desiredDeaf)),
                    )
                }
                link.roster = SessionState()
                if (desiredMute || desiredDeaf)
                    link.send(
                        9,
                        Proto()
                            .number(1, session)
                            .bool(9, desiredMute)
                            .bool(10, desiredDeaf)
                            .build(),
                    )
                state.value.server?.let { server ->
                    store.servers.value
                        .find { it.id == server.id }
                        ?.let { store.saveServer(it.copy(lastUsed = System.currentTimeMillis())) }
                }
                if (f.text(3).isNotBlank())
                    addMessage(
                        ChatMessage(name = "Server", html = SessionLimits.messageHtml(f.text(3)))
                    )
                whisperTarget?.let { link.send(19, it) }
                link.send(20, Proto().number(1, 0).build())
            }
            6 -> updateRoster(link) { it.copy(channels = it.channels - f.int(1)) }
            7 ->
                updateRoster(link) { s ->
                    if (f.int(1) !in s.channels && s.channels.size >= SessionLimits.CHANNELS)
                        return@updateRoster s
                    val old = s.channels[f.int(1)] ?: Channel(f.int(1))
                    s.copy(
                        channels =
                            s.channels +
                                (old.id to
                                    old.copy(
                                        parent = f.int(2, old.parent),
                                        name = SessionLimits.name(f.text(3, old.name)),
                                        description =
                                            SessionLimits.profileText(f.text(5, old.description)),
                                        temporary = if (f.has(8)) f.bool(8) else old.temporary,
                                        position = f.int(9, old.position),
                                        maxUsers = f.int(11, old.maxUsers),
                                    ))
                    )
                }
            8 -> {
                if (link.synced && f.int(1) == state.value.me)
                    throw UntrustedCertificate(
                        f.text(3, "You were removed from the server").take(2000)
                    )
                lastVoiceAt.remove(f.int(1))
                updateRoster(link) { it.copy(users = it.users - f.int(1)) }
            }
            9 ->
                updateRoster(link) { s ->
                    if (f.int(1) !in s.users && s.users.size >= SessionLimits.USERS)
                        return@updateRoster s
                    val old = s.users[f.int(1)] ?: User(f.int(1))
                    fun boolean(field: Int, previous: Boolean) =
                        if (f.has(field)) f.bool(field) else previous
                    s.copy(
                        users =
                            s.users +
                                (old.session to
                                    old.copy(
                                        name = SessionLimits.name(f.text(3, old.name)),
                                        registered = f.int(4, old.registered),
                                        channel = f.int(5, old.channel),
                                        mute = boolean(6, old.mute),
                                        deaf = boolean(7, old.deaf),
                                        suppress = boolean(8, old.suppress),
                                        selfMute = boolean(9, old.selfMute),
                                        selfDeaf = boolean(10, old.selfDeaf),
                                        comment = SessionLimits.profileText(f.text(14, old.comment)),
                                        hash = f.text(15, old.hash),
                                        priority = boolean(18, old.priority),
                                        listening =
                                            old.listening + f.numbers(21) - f.numbers(22).toSet(),
                                    ))
                    )
                }
            11 -> {
                val actor = f.int(1)
                val recipients = f.numbers(2)
                val direct = if (recipients.isNotEmpty()) actor else null
                addMessage(
                    ChatMessage(
                        sender = actor,
                        name = state.value.users[actor]?.name ?: "Server",
                        html = SessionLimits.messageHtml(f.text(5)),
                        channel = f.numbers(3).firstOrNull() ?: f.numbers(4).firstOrNull(),
                        direct = direct,
                    )
                )
            }
            12 ->
                mutableState.update {
                    it.copy(
                        error =
                            f.text(4).take(2000).ifBlank {
                                "The server denied this action (reason ${f.int(5)})."
                            }
                    )
                }
            15 ->
                when {
                    f.has(1) && f.has(2) && f.has(3) ->
                        link.crypt.setKey(f.bytes(1), f.bytes(2), f.bytes(3))
                    f.has(3) -> link.crypt.resync(f.bytes(3))
                    else ->
                        if (link.crypt.valid)
                            link.send(15, Proto().bytes(2, link.crypt.encryptIV).build())
                }
            18 ->
                mutableState.update {
                    it.copy(
                        registeredUsers =
                            f.messages(1).associate { user -> user.int(1) to user.text(2) }
                    )
                }
            20 ->
                mutableState.update { s ->
                    val channels =
                        if (f.bool(3)) s.channels.mapValues { it.value.copy(permissions = null) }
                        else s.channels
                    val channel = channels[f.int(1)]
                    s.copy(
                        permissions = if (f.int(1) == 0 && f.has(2)) f.long(2) else s.permissions,
                        channels =
                            if (channel != null && f.has(2))
                                channels + (channel.id to channel.copy(permissions = f.long(2)))
                            else channels,
                    )
                }
            22 ->
                mutableState.update {
                    it.copy(
                        userStats =
                            "${it.users[f.int(1)]?.name ?: "User"}\n${f.messages(12).firstOrNull()?.text(2).orEmpty()}\nConnected: ${f.long(16)} seconds\nIdle: ${f.long(17)} seconds\nStrong certificate: ${f.bool(18)}\nOpus: ${f.bool(19)}"
                    )
                }
            24 ->
                mutableState.update {
                    it.copy(maxText = f.int(4, it.maxText), maxImage = f.int(5, it.maxImage))
                }
            26 -> if (link.synced) onPlugin(f.int(1), f.text(4), f.bytes(3))
        }
    }

    private class UntrustedCertificate(message: String = "Server certificate was not trusted") :
        Exception(message)

    private class CertificateAccepted : Exception("The certificate was accepted; connecting again")

    private class Link {
        var roster = SessionState()
        @Volatile
        var closed = false
            private set

        @Volatile private var raw: Socket? = null
        @Volatile private var socket: SSLSocket? = null
        @Volatile var output: DataOutputStream? = null
        @Volatile private var udp: DatagramSocket? = null
        @Volatile private var udpTarget: InetSocketAddress? = null
        @Volatile var chain: Array<X509Certificate>? = null
        @Volatile var authType: String? = null
        @Volatile var modern = true
        @Volatile var synced = false
        @Volatile var lastUdp = 0L
        var lastResync = 0L
        val sequence = AtomicLong()
        val crypt = CryptState()

        @Synchronized
        fun send(type: Int, data: ByteArray) {
            (output ?: error("Connection is closed")).writeFrame(type, data)
        }

        fun attach(raw: Socket) {
            this.raw = raw
            if (closed) close()
        }

        fun attach(socket: SSLSocket) {
            this.socket = socket
            if (closed) close()
        }

        fun attach(udp: DatagramSocket, target: InetSocketAddress) {
            udpTarget = target
            this.udp = udp
            if (closed) close()
        }

        fun sendUdp(data: ByteArray) {
            val socket = udp ?: return
            val encrypted = crypt.encrypt(data)
            socket.send(DatagramPacket(encrypted, encrypted.size, udpTarget))
        }

        fun close() {
            closed = true
            runCatching { raw?.close() }
            runCatching { socket?.close() }
            runCatching { udp?.close() }
            output = null
        }
    }

    companion object {
        const val SPEAKING = Long.MAX_VALUE
        private const val SPEECH_TIMEOUT_MILLIS = 300L
        private const val MAX_DATAGRAM = 2048
    }
}
