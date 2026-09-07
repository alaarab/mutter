@file:OptIn(
    androidx.compose.material3.ExperimentalMaterial3Api::class,
    androidx.compose.foundation.layout.ExperimentalLayoutApi::class,
)

package com.alaarab.mutter.ui

import android.Manifest
import android.app.Activity
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
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CornerSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Chat
import androidx.compose.material.icons.automirrored.rounded.List
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.alaarab.mutter.MutterApplication
import com.alaarab.mutter.R
import com.alaarab.mutter.data.*
import com.alaarab.mutter.protocol.Proto

@Composable
fun MutterApp(app: MutterApplication, deepLink: Server? = null, consumed: () -> Unit = {}) {
    val settings by app.store.settings.collectAsStateWithLifecycle()
    val session by app.client.state.collectAsStateWithLifecycle()
    val servers by app.store.servers.collectAsStateWithLifecycle()
    val transmitting by app.audio.transmitting.collectAsStateWithLifecycle()
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
        if (session.status == "disconnected" && previousStatus != "disconnected") {
            page = "servers"
            if (sheet in listOf("user", "channel", "whisper", "info")) sheet = null
        }
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
        val motion = LocalCatalog.current
        val keyboardVisible = WindowInsets.isImeVisible
        val compactChat =
            page == "chat" && keyboardVisible && LocalConfiguration.current.screenHeightDp < 500
        Scaffold(
            modifier = Modifier.imePadding(),
            containerColor = p.background,
            bottomBar = {
                if (session.connected && !keyboardVisible)
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
                                                            Badge(
                                                                containerColor = p.accent,
                                                                contentColor = p["onAccent"],
                                                            ) {
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
                                            label = {
                                                Text(
                                                    label,
                                                    style = MaterialTheme.typography.labelMedium,
                                                )
                                            },
                                            colors =
                                                NavigationBarItemDefaults.colors(
                                                    selectedIconColor = p.accent,
                                                    selectedTextColor = p.ink,
                                                    indicatorColor = p.accent.copy(alpha = .12f),
                                                    unselectedIconColor = p.muted,
                                                    unselectedTextColor = p.muted,
                                                ),
                                        )
                                    }
                            }
                    }
            },
        ) { padding ->
            Column(
                Modifier.fillMaxSize()
                    .padding(padding)
                    .consumeWindowInsets(padding)
                    .background(
                        Brush.verticalGradient(
                            listOf(p.accent.copy(alpha = .06f), Color.Transparent)
                        )
                    )
            ) {
                if (!compactChat)
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
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (session.connected)
                            ActionIcon(Icons.Rounded.Info, "Server information") { sheet = "info" }
                        ActionIcon(Icons.Rounded.Settings, "Settings") { sheet = "settings" }
                    }
                AnimatedContent(
                    page,
                    Modifier.weight(1f),
                    transitionSpec = {
                        (fadeIn(tween(motion.panel)) +
                            androidx.compose.animation.slideInVertically(
                                tween(motion.panel, easing = motion.easing)
                            ) {
                                it / 40
                            }) togetherWith fadeOut(tween(motion.fast))
                    },
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
                                    transmitting,
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
                tonalElevation = 0.dp,
                shape =
                    MaterialTheme.shapes.extraLarge.copy(
                        bottomStart = CornerSize(0.dp),
                        bottomEnd = CornerSize(0.dp),
                    ),
                dragHandle = { BottomSheetDefaults.DragHandle(color = p.muted.copy(alpha = .45f)) },
            ) {
                SheetSystemBars()
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
                    "settings" -> SettingsScreen(app, settings)
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
