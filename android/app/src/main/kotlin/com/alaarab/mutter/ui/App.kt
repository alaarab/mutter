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
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.alaarab.mutter.MutterApplication
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
            draft = deepLink.copy(username = deepLink.username.ifBlank { settings.defaultUsername })
            sheet = "server"
            consumed()
        }
    }
    LaunchedEffect(session.status) {
        if (session.connected && previousStatus != "connected" && page == "servers")
            page = "channels"
        if (session.status == "disconnected" && previousStatus != "disconnected") {
            page = "servers"
            if (sheet in listOf("user", "channel", "whisper")) sheet = null
        }
        previousStatus = session.status
    }
    LaunchedEffect(page, session.messages.lastOrNull()?.id) {
        if (page == "voice") page = "channels"
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
        val density = LocalDensity.current
        val availableHeight =
            LocalConfiguration.current.screenHeightDp -
                with(density) { WindowInsets.ime.getBottom(this).toDp().value }
        val compactKeyboard = keyboardVisible && availableHeight < 440 * density.fontScale
        val compactContent = keyboardVisible && LocalConfiguration.current.screenHeightDp < 500
        Scaffold(
            modifier = Modifier.imePadding(),
            containerColor = p.background,
            bottomBar = {
                if (session.connected && page != "servers" && !compactKeyboard)
                    Column(
                        Modifier.navigationBarsPadding()
                            .background(
                                Brush.linearGradient(listOf(p["surfaceHighlight"], p.surface))
                            )
                    ) {
                        SectionDivider()
                        VoiceControls(
                            app,
                            session,
                            whisper = { sheet = "whisper" },
                            settings = { sheet = "settings" },
                        )
                        SessionNavigation(page, session.unread) {
                            page = it
                        }
                    }
            },
        ) { padding ->
            Column(
                Modifier.fillMaxSize()
                    .padding(padding)
                    .consumeWindowInsets(padding)
                    .background(
                        if (page in listOf("servers", "info")) ambientBrush()
                        else SolidColor(p.background)
                    )
            ) {
                if (!compactContent) {
                    if (page == "servers")
                        HomeToolbar(
                            settings = { sheet = "settings" },
                            browse = { sheet = "directory" },
                            add = {
                                draft = Server(username = settings.defaultUsername)
                                sheet = "server"
                            },
                        )
                    else SessionHeader(session) { page = "servers" }
                }
                if (page != "servers") ShareBanner(app)

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
                            "info" -> ServerInfo(app, session)
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
                                        draft = Server(username = settings.defaultUsername)
                                        sheet = "server"
                                    },
                                    onBrowse = { sheet = "directory" },
                                    onSession = { page = "channels" },
                                    onFavorite = {
                                        app.store.saveServer(it.copy(favorite = !it.favorite))
                                    },
                                )
                            "channels" ->
                                ChannelsScreen(
                                    session,
                                    settings.hideEmpty,
                                    transmitting,
                                    onHideEmpty = {
                                        app.store.saveSettings(
                                            settings.copy(hideEmpty = !settings.hideEmpty)
                                        )
                                    },
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
                sheetState =
                    rememberModalBottomSheetState(
                        skipPartiallyExpanded = sheet !in listOf("user", "channel", "whisper")
                    ),
                containerColor = p.background,
                tonalElevation = 0.dp,
                shape =
                    MaterialTheme.shapes.extraLarge.copy(
                        bottomStart = CornerSize(0.dp),
                        bottomEnd = CornerSize(0.dp),
                    ),
                dragHandle = {
                    if (
                        !(WindowInsets.isImeVisible &&
                            LocalConfiguration.current.screenHeightDp < 500)
                    )
                        BottomSheetDefaults.DragHandle(
                            modifier = Modifier.testTag("sheetHandle"),
                            color = p.muted.copy(alpha = .45f),
                        )
                },
            ) {
                SheetSystemBars()
                Column(Modifier.fillMaxWidth().background(ambientBrush())) {
                    if (sheet !in listOf("settings", "server"))
                        SheetHeader(
                            when (sheet) {
                                "directory" -> "Public servers"
                                "channel" -> "Channel"
                                "whisper" -> "Whisper or shout"
                                else -> ""
                            }
                        ) {
                            sheet = null
                        }
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
                                onDismiss = { sheet = null },
                            )
                        "settings" -> SettingsScreen(app, settings) { sheet = null }
                        "directory" ->
                            DirectoryScreen {
                                draft =
                                    it.copy(
                                        username = it.username.ifBlank { settings.defaultUsername }
                                    )
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
                    }
                }
            }
        ShareDialog(app)
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
