@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.alaarab.mutter.ui

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.view.WindowManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Chat
import androidx.compose.material.icons.automirrored.rounded.List
import androidx.compose.material.icons.automirrored.rounded.ScreenShare
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.alaarab.mutter.MutterApplication
import com.alaarab.mutter.R
import com.alaarab.mutter.VoiceService
import com.alaarab.mutter.data.*
import com.alaarab.mutter.protocol.Proto
import kotlinx.coroutines.delay

@Composable
fun MutterApp(app: MutterApplication, deepLink: Server? = null, consumed: () -> Unit = {}) {
    val settings by app.store.settings.collectAsStateWithLifecycle()
    val session by app.client.state.collectAsStateWithLifecycle()
    val servers by app.store.servers.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var page by rememberSaveable { mutableStateOf("servers") }
    var previousStatus by rememberSaveable { mutableStateOf("disconnected") }
    val savedPages = rememberSaveableStateHolder()
    var sheet by rememberSaveable { mutableStateOf<String?>(null) }

    val draftSaver =
        listSaver<Server, Any>(
            save = {
                listOf(
                    it.id,
                    it.name,
                    it.host,
                    it.port,
                    it.username,
                    it.identity,
                    it.favorite,
                    it.lastUsed,
                )
            },
            restore = { saved ->
                (app.store.servers.value.firstOrNull { it.id == saved[0] }
                        ?: Server(id = saved[0] as String))
                    .copy(
                        name = saved[1] as String,
                        host = saved[2] as String,
                        port = saved[3] as Int,
                        username = saved[4] as String,
                        identity = saved[5] as String,
                        favorite = saved[6] as Boolean,
                        lastUsed = saved[7] as Long,
                    )
            },
        )
    var draft by rememberSaveable(stateSaver = draftSaver) { mutableStateOf(Server()) }
    var user by rememberSaveable { mutableStateOf<Int?>(null) }
    var channel by rememberSaveable { mutableStateOf<Int?>(null) }
    var direct by rememberSaveable { mutableStateOf<Int?>(null) }
    var pendingServer by remember { mutableStateOf<Server?>(null) }
    val permission =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            pendingServer?.let { app.connect(it) }
            pendingServer = null
        }

    fun showUser(id: Int) {
        user = id
        sheet = "user"
        session.users[id]?.channel?.let { app.client.action(20, Proto().number(1, it)) }
    }
    fun connect(server: Server) {
        val permissions = buildList {
            if (
                context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) !=
                    PackageManager.PERMISSION_GRANTED
            )
                add(Manifest.permission.RECORD_AUDIO)
            if (
                Build.VERSION.SDK_INT >= 33 &&
                    context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
                        PackageManager.PERMISSION_GRANTED
            )
                add(Manifest.permission.POST_NOTIFICATIONS)
            if (
                Build.VERSION.SDK_INT >= 31 &&
                    context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) !=
                        PackageManager.PERMISSION_GRANTED
            )
                add(Manifest.permission.BLUETOOTH_CONNECT)
        }
        if (permissions.isEmpty()) app.connect(server)
        else {
            pendingServer = server
            permission.launch(permissions.toTypedArray())
        }
    }
    LaunchedEffect(deepLink) {
        if (deepLink != null) {
            draft = deepLink
            sheet = "server"
            consumed()
        }
    }
    LaunchedEffect(session.status) {
        if (session.connected && previousStatus != "connected" && page == "servers") page = "voice"
        previousStatus = session.status
    }
    LaunchedEffect(page, session.messages.lastOrNull()?.id) {
        if (page == "chat") app.client.markMessagesRead()
    }
    DisposableEffect(settings.keepAwake, session.connected) {
        val window = (context as? Activity)?.window
        if (settings.keepAwake && session.connected)
            window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onDispose { window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
    }
    BackHandler(sheet == null && page != "servers") { page = "servers" }
    MutterTheme(settings) {
        val p = LocalPalette.current
        Scaffold(
            containerColor = p.background,
            bottomBar = {
                if (session.connected)
                    Column(Modifier.navigationBarsPadding().background(p.surface)) {
                        VoiceControls(app, session) { sheet = "whisper" }
                        if (page != "servers")
                            NavigationBar(
                                containerColor = p.surface,
                                tonalElevation = 0.dp,
                                windowInsets = WindowInsets(0),
                            ) {
                                listOf(
                                        Triple("voice", "Voice", Icons.Rounded.GraphicEq),
                                        Triple(
                                            "channels",
                                            "Channels",
                                            Icons.AutoMirrored.Rounded.List,
                                        ),
                                        Triple("chat", "Chat", Icons.AutoMirrored.Rounded.Chat),
                                    )
                                    .forEach { (id, label, icon) ->
                                        NavigationBarItem(
                                            selected = page == id,
                                            onClick = {
                                                page = id
                                                if (id == "chat") direct = null
                                            },
                                            icon = {
                                                BadgedBox(
                                                    badge = {
                                                        if (id == "chat" && session.unread > 0)
                                                            Badge {
                                                                Text(
                                                                    session.unread
                                                                        .coerceAtMost(99)
                                                                        .toString()
                                                                )
                                                            }
                                                    }
                                                ) {
                                                    Icon(icon, label)
                                                }
                                            },
                                            label = { Text(label) },
                                        )
                                    }
                            }
                    }
            },
        ) { padding ->
            Column(
                Modifier.fillMaxSize()
                    .padding(padding)
                    .background(
                        Brush.verticalGradient(
                            listOf(p.accent.copy(alpha = .06f), Color.Transparent)
                        )
                    )
            ) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (page != "servers")
                        ActionIcon(Icons.AutoMirrored.Rounded.ArrowBack, "Servers") {
                            page = "servers"
                        }
                    else
                        Icon(
                            painterResource(R.drawable.notification_mark),
                            "Mutter",
                            tint = p.ink,
                            modifier = Modifier.padding(12.dp).size(28.dp),
                        )
                    Text(
                        if (page == "servers") "Mutter"
                        else session.server?.let { it.name.ifBlank { it.host } } ?: "Mutter",
                        style = MaterialTheme.typography.titleLarge,
                        modifier = Modifier.weight(1f),
                        maxLines = 1,
                    )
                    if (session.connected)
                        ActionIcon(Icons.Rounded.Info, "Server information") { sheet = "info" }
                    ActionIcon(Icons.Rounded.Settings, "Settings") { sheet = "settings" }
                }
                AnimatedContent(
                    page,
                    Modifier.weight(1f),
                    transitionSpec = { fadeIn(tween(180)) togetherWith fadeOut(tween(120)) },
                    label = "page",
                ) { current ->
                    savedPages.SaveableStateProvider(current) {
                        when (current) {
                            "servers" ->
                                HomeScreen(
                                    servers,
                                    session,
                                    onConnect = ::connect,
                                    onEdit = {
                                        draft = it
                                        sheet = "server"
                                    },
                                    onAdd = {
                                        draft = Server()
                                        sheet = "server"
                                    },
                                    onBrowse = { sheet = "directory" },
                                    onSession = { page = "voice" },
                                    onFavorite = {
                                        app.store.saveServer(it.copy(favorite = !it.favorite))
                                    },
                                )
                            "channels" ->
                                ChannelsScreen(
                                    session,
                                    settings.hideEmpty,
                                    onJoin = app.client::join,
                                    onUser = ::showUser,
                                    onChannel = {
                                        channel = it
                                        app.client.action(20, Proto().number(1, it))
                                        sheet = "channel"
                                    },
                                )
                            "chat" ->
                                ChatScreen(
                                    app,
                                    session,
                                    direct,
                                    onDirectClose = { direct = null },
                                    onDirect = { direct = it },
                                    onUser = ::showUser,
                                )
                            else ->
                                VoiceScreen(
                                    app,
                                    session,
                                    onUser = ::showUser,
                                    onChannels = { page = "channels" },
                                )
                        }
                    }
                }
                if (!session.connected && session.status != "disconnected") {
                    Row(
                        Modifier.fillMaxWidth().padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        Text(
                            session.status.replaceFirstChar { it.uppercase() } + "…",
                            Modifier.weight(1f),
                        )
                        TextButton(onClick = app::disconnect) { Text("Cancel") }
                    }
                }
            }
        }
        if (sheet != null)
            ModalBottomSheet(
                onDismissRequest = { sheet = null },
                sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
                containerColor = p.background,
            ) {
                when (sheet) {
                    "server" ->
                        ServerEditor(
                            draft,
                            app,
                            onSave = {
                                app.store.saveServer(it)
                                sheet = null
                            },
                            onConnect = {
                                sheet = null
                                connect(it)
                            },
                            onDelete = {
                                app.store.deleteServer(draft.id)
                                sheet = null
                            },
                        )
                    "settings" ->
                        SettingsScreen(app, settings, identities = { sheet = "identities" })
                    "identities" -> IdentitiesScreen(app)
                    "directory" ->
                        DirectoryScreen {
                            draft = it
                            sheet = "server"
                        }
                    "user" ->
                        session.users[user]?.let { selected ->
                            UserSheet(
                                app,
                                session,
                                selected,
                                message = {
                                    direct = selected.session
                                    page = "chat"
                                    sheet = null
                                },
                                dismiss = { sheet = null },
                            )
                        }
                    "channel" ->
                        session.channels[channel]?.let { selected ->
                            ChannelSheet(app, session, selected) { sheet = null }
                        }
                    "whisper" -> WhisperSheet(app, session) { sheet = null }
                    "info" -> ServerInfo(app, session)
                }
            }
        session.certificate?.let { CertificateDialog(it, app.client::answerTrust) }
        session.error?.let { error ->
            AlertDialog(
                onDismissRequest = app.client::dismissError,
                title = { Text("Mutter") },
                text = { Text(error) },
                confirmButton = { TextButton(onClick = app.client::dismissError) { Text("OK") } },
            )
        }
        session.userStats?.let { stats ->
            AlertDialog(
                onDismissRequest = app.client::dismissError,
                title = { Text("User information") },
                text = { Text(stats) },
                confirmButton = { TextButton(onClick = app.client::dismissError) { Text("Done") } },
            )
        }
    }
}

@Composable
private fun HomeScreen(
    servers: List<Server>,
    state: SessionState,
    onConnect: (Server) -> Unit,
    onEdit: (Server) -> Unit,
    onAdd: () -> Unit,
    onBrowse: () -> Unit,
    onSession: () -> Unit,
    onFavorite: (Server) -> Unit,
) {
    var query by rememberSaveable { mutableStateOf("") }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item { Heading("Your people.\nYour place.", "Drop in. Say something.") }
        if (state.connected)
            item {
                AppCard(Modifier.fillMaxWidth(), onSession) {
                    Text(
                        "CONNECTED",
                        color = LocalPalette.current.speaking,
                        style = MaterialTheme.typography.labelMedium,
                    )
                    Text(
                        state.channel?.name ?: "Voice",
                        style = MaterialTheme.typography.titleLarge,
                    )
                    Hint("Return to your conversation")
                }
            }
        item {
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                if (maxWidth < 340.dp || LocalDensity.current.fontScale > 1.2f) {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        ServerActionButtons(Modifier.fillMaxWidth(), onAdd, onBrowse)
                    }
                } else {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        ServerActionButtons(Modifier.weight(1f), onAdd, onBrowse)
                    }
                }
            }
        }
        if (servers.isNotEmpty())
            item {
                OutlinedTextField(
                    query,
                    { query = it },
                    Modifier.fillMaxWidth(),
                    placeholder = { Text("Find a server") },
                    leadingIcon = { Icon(Icons.Rounded.Search, null) },
                    singleLine = true,
                    shape = RoundedCornerShape(16.dp),
                )
            }
        if (servers.isEmpty())
            item {
                AppCard(Modifier.fillMaxWidth()) {
                    Icon(
                        Icons.Rounded.Forum,
                        null,
                        tint = LocalPalette.current.accent,
                        modifier = Modifier.size(36.dp),
                    )
                    Text(
                        "A little closer, wherever you are.",
                        style = MaterialTheme.typography.titleLarge,
                    )
                    Text(
                        "Add your Mumble server or find a community in the directory.",
                        color = LocalPalette.current.body,
                    )
                }
            }
        items(
            servers
                .filter { "${it.name} ${it.host}".contains(query, true) }
                .sortedWith(
                    compareByDescending<Server> { it.favorite }.thenByDescending { it.lastUsed }
                ),
            key = { it.id },
        ) { server ->
            AppCard(Modifier.fillMaxWidth(), { onConnect(server) }) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Avatar(server.name.ifBlank { server.host }, size = 48)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(
                            server.name.ifBlank { server.host },
                            style = MaterialTheme.typography.titleMedium,
                        )
                        Hint("${server.host}:${server.port}")
                    }
                    ActionIcon(
                        if (server.favorite) Icons.Rounded.Star else Icons.Rounded.StarBorder,
                        "Favorite ${server.name}",
                    ) {
                        onFavorite(server)
                    }
                    ActionIcon(Icons.Rounded.MoreVert, "Edit ${server.name}") { onEdit(server) }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Hint(server.username)
                    ServerLatency(server)
                }
            }
        }
    }
}

@Composable
private fun ServerActionButtons(modifier: Modifier, onAdd: () -> Unit, onBrowse: () -> Unit) {
    Button(onAdd, modifier) {
        Icon(Icons.Rounded.Add, null)
        Spacer(Modifier.width(6.dp))
        Text("Add server")
    }
    OutlinedButton(onBrowse, modifier) {
        Icon(Icons.Rounded.Public, null)
        Spacer(Modifier.width(6.dp))
        Text("Discover")
    }
}

@Composable
private fun VoiceScreen(
    app: MutterApplication,
    state: SessionState,
    onUser: (Int) -> Unit,
    onChannels: () -> Unit,
) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(100)
            now = System.currentTimeMillis()
        }
    }
    val shares by app.shares.shares.collectAsStateWithLifecycle()
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            Heading(
                state.channel?.name ?: "Voice",
                "${state.users.values.count { it.channel == state.self?.channel }} people · ${if (state.udp) "UDP" else "TCP"} · ${state.ping} ms",
            ) {
                ActionIcon(Icons.Rounded.SwapHoriz, "Change channel", action = onChannels)
            }
        }
        val users =
            state.users.values
                .filter { it.channel == state.self?.channel }
                .sortedBy { it.name.lowercase() }
        items(users.chunked(2)) { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                row.forEach { user ->
                    AppCard(Modifier.weight(1f), { onUser(user.session) }) {
                        Avatar(user.name, user.talkingUntil > now, 58)
                        Text(user.name, style = MaterialTheme.typography.titleMedium, maxLines = 1)
                        Hint(
                            when {
                                user.selfDeaf || user.deaf -> "Deafened"
                                user.mute || user.selfMute -> "Muted"
                                user.talkingUntil > now -> "Speaking"
                                user.session == state.me -> "You"
                                else -> "Listening"
                            }
                        )
                    }
                }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
        if (shares.isNotEmpty()) item { SectionLabel("Shared screens") }
        items(shares, key = { "${it.sender}:${it.id}" }) { share ->
            AppCard(Modifier.fillMaxWidth(), { app.shares.watch(share) }) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        Icons.AutoMirrored.Rounded.ScreenShare,
                        null,
                        tint = LocalPalette.current.whisper,
                    )
                    Spacer(Modifier.width(12.dp))
                    Text(share.title, Modifier.weight(1f))
                    Text("Watch", color = LocalPalette.current.whisper)
                }
            }
        }
    }
    ShareDialog(app)
}

@Composable
private fun VoiceControls(app: MutterApplication, state: SessionState, whisper: () -> Unit) {
    val p = LocalPalette.current
    val context = LocalContext.current
    var microphoneGranted by remember {
        mutableStateOf(
            context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
        )
    }
    fun refreshMicrophone() {
        val granted =
            context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
        if (granted && !microphoneGranted && state.connected)
            context.startService(Intent(context, VoiceService::class.java).setAction("microphone"))
        microphoneGranted = granted
    }
    val microphone =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
            refreshMicrophone()
        }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { refreshMicrophone() }
    val level by app.audio.level.collectAsStateWithLifecycle()
    val talking by app.audio.transmitting.collectAsStateWithLifecycle()
    val settings by app.store.settings.collectAsStateWithLifecycle()
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        ActionIcon(
            if (state.self?.selfMute == true) Icons.Rounded.MicOff else Icons.Rounded.Mic,
            "Toggle mute",
            if (state.self?.selfMute == true) p.danger else p.body,
        ) {
            app.client.mute(state.self?.selfMute != true)
        }
        ActionIcon(
            if (state.self?.selfDeaf == true) Icons.Rounded.HeadsetOff
            else Icons.Rounded.Headphones,
            "Toggle deafen",
            if (state.self?.selfDeaf == true) p.danger else p.body,
        ) {
            app.client.deafen(state.self?.selfDeaf != true)
        }
        Box(
            Modifier.weight(1f)
                .height(52.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(if (talking) p.speaking else p.elevated)
                .semantics {
                    contentDescription =
                        if (microphoneGranted) "Push to talk" else "Enable microphone"
                    role = Role.Button
                    onClick("Toggle talking") {
                        if (microphoneGranted) app.audio.held = !app.audio.held
                        else microphone.launch(Manifest.permission.RECORD_AUDIO)
                        true
                    }
                }
                .testTag("talkButton")
                .pointerInput(microphoneGranted) {
                    detectTapGestures(
                        onPress = {
                            if (!microphoneGranted) {
                                microphone.launch(Manifest.permission.RECORD_AUDIO)
                                return@detectTapGestures
                            }
                            app.audio.held = true
                            try {
                                tryAwaitRelease()
                            } finally {
                                app.audio.held = false
                            }
                        }
                    )
                },
            contentAlignment = Alignment.Center,
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    if (!microphoneGranted) "Microphone off"
                    else if (talking) "Talking"
                    else if (state.self?.selfMute == true) "Muted"
                    else if (settings.voiceMode == "ptt") "Hold to talk"
                    else "${if (settings.voiceMode == "vad") "Voice activity" else "Open mic"}",
                    color = if (talking) p["onStatus"] else p.ink,
                    style = MaterialTheme.typography.labelLarge,
                )
                LinearProgressIndicator(
                    progress = { (level * 6).coerceIn(0f, 1f) },
                    modifier = Modifier.width(80.dp).height(2.dp).padding(top = 1.dp),
                    color = if (talking) p["onStatus"] else p.accent,
                    trackColor = Color.Transparent,
                )
            }
        }
        ActionIcon(Icons.Rounded.RecordVoiceOver, "Whisper targets", p.whisper, whisper)
        ActionIcon(Icons.Rounded.CallEnd, "Disconnect", p.danger, app::disconnect)
    }
    DisposableEffect(Unit) {
        onDispose {
            app.audio.held = false
            app.audio.whisperHeld = false
        }
    }
}

@Composable
private fun ChannelsScreen(
    state: SessionState,
    hideEmpty: Boolean,
    onJoin: (Int) -> Unit,
    onUser: (Int) -> Unit,
    onChannel: (Int) -> Unit,
) {
    var query by rememberSaveable { mutableStateOf("") }
    var collapsed by rememberSaveable { mutableStateOf(emptyList<Int>()) }
    val ordered =
        remember(state.channels, state.users, query, collapsed, hideEmpty) {
            val result = mutableListOf<Pair<Channel, Int>>()
            val seen = mutableSetOf<Int>()
            fun visit(channel: Channel, depth: Int) {
                if (!seen.add(channel.id) || depth > 32) return
                val users = state.users.values.filter { it.channel == channel.id }
                val matches =
                    query.isBlank() ||
                        channel.name.contains(query, true) ||
                        users.any { it.name.contains(query, true) }
                if (matches && (!hideEmpty || users.isNotEmpty() || channel.id == 0))
                    result.add(channel to depth)
                if (channel.id !in collapsed || query.isNotBlank())
                    state.channels.values
                        .filter { it.parent == channel.id && it.id != channel.id }
                        .sortedWith(compareBy<Channel> { it.position }.thenBy { it.name })
                        .forEach { visit(it, depth + 1) }
            }
            state.channels[0]?.let { visit(it, 0) }
            result
        }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(20.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { Heading("Channels", "Find your conversation") }
        item {
            OutlinedTextField(
                query,
                { query = it },
                Modifier.fillMaxWidth(),
                placeholder = { Text("Search channels and people") },
                leadingIcon = { Icon(Icons.Rounded.Search, null) },
                singleLine = true,
                shape = RoundedCornerShape(16.dp),
            )
        }
        items(ordered, key = { it.first.id }) { (channel, depth) ->
            AppCard(Modifier.fillMaxWidth().padding(start = minOf(depth * 10, 30).dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    ActionIcon(
                        if (channel.id in collapsed) Icons.Rounded.ChevronRight
                        else Icons.Rounded.ExpandMore,
                        "Expand ${channel.name}",
                    ) {
                        collapsed =
                            if (channel.id in collapsed) collapsed - channel.id
                            else collapsed + channel.id
                    }
                    Column(Modifier.weight(1f).clickable { onJoin(channel.id) }) {
                        Text(
                            channel.name,
                            style = MaterialTheme.typography.titleMedium,
                            color =
                                if (state.self?.channel == channel.id) LocalPalette.current.accent
                                else LocalPalette.current.ink,
                        )
                        Hint(
                            "${state.users.values.count { it.channel == channel.id }} people${if (state.self?.channel == channel.id) " · You’re here" else " · Tap to join"}"
                        )
                    }
                    ActionIcon(Icons.Rounded.MoreVert, "Channel options for ${channel.name}") {
                        onChannel(channel.id)
                    }
                }
                if (channel.id !in collapsed)
                    state.users.values
                        .filter { it.channel == channel.id }
                        .sortedBy { it.name }
                        .forEach { user ->
                            Row(
                                Modifier.fillMaxWidth()
                                    .clip(RoundedCornerShape(12.dp))
                                    .clickable { onUser(user.session) }
                                    .padding(6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Avatar(
                                    user.name,
                                    user.talkingUntil > System.currentTimeMillis(),
                                    30,
                                )
                                Spacer(Modifier.width(10.dp))
                                Text(
                                    user.name,
                                    Modifier.weight(1f),
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                                if (user.selfMute || user.mute)
                                    Icon(
                                        Icons.Rounded.MicOff,
                                        "Muted",
                                        tint = LocalPalette.current.muted,
                                        modifier = Modifier.size(16.dp),
                                    )
                            }
                        }
            }
        }
    }
}
