package com.alaarab.mutter.ui

import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import com.alaarab.mutter.MutterApplication
import com.alaarab.mutter.data.*
import com.alaarab.mutter.protocol.Proto

@Composable
fun UserSheet(
    app: MutterApplication,
    state: SessionState,
    user: User,
    message: () -> Unit,
    dismiss: () -> Unit,
) {
    var moderation by remember { mutableStateOf<String?>(null) }
    var reason by rememberSaveable { mutableStateOf("") }
    var move by remember { mutableStateOf(false) }
    val isSelf = user.session == state.me
    LazyColumn(
        Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(start = 24.dp, end = 24.dp, bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Avatar(user.name, size = 64)
            Heading(user.name, state.channels[user.channel]?.name ?: "Channel")
            if (user.registered >= 0) Hint("Registered user")
        }
        if (user.comment.isNotBlank()) item { RichMessage(user.comment) }
        if (!isSelf) {
            item {
                Button(message, Modifier.fillMaxWidth()) {
                    Icon(Icons.Rounded.Forum, null)
                    Spacer(Modifier.width(8.dp))
                    Text("Direct message")
                }
            }
            item {
                ToggleRow(
                    "Mute locally",
                    user.localMute,
                    { app.client.localUser(user.session, mute = it) },
                )
                Text("Their volume · ${(user.volume * 100).toInt()}%")
                Slider(
                    user.volume,
                    { app.client.localUser(user.session, volume = it) },
                    valueRange = 0f..1f,
                )
            }
        }
        item {
            OutlinedButton({
                app.client.action(22, Proto().number(1, user.session).bool(2, false))
            }) {
                Text("User information")
            }
        }
        if (isSelf && user.registered < 0 && state.can(0x80000))
            item {
                Button({ app.client.action(9, Proto().number(1, user.session).number(4, 0)) }) {
                    Text("Register my identity")
                }
            }
        if (state.can(0x10, user.channel) && !isSelf)
            item {
                SectionLabel("Moderation")
                ToggleRow(
                    "Server mute",
                    user.mute,
                    { app.client.action(9, Proto().number(1, user.session).bool(6, it)) },
                )
                ToggleRow(
                    "Server deafen",
                    user.deaf,
                    { app.client.action(9, Proto().number(1, user.session).bool(7, it)) },
                )
                ToggleRow(
                    "Priority speaker",
                    user.priority,
                    { app.client.action(9, Proto().number(1, user.session).bool(18, it)) },
                )
            }
        if (!isSelf && state.can(0x20, user.channel))
            item { OutlinedButton({ move = !move }) { Text("Move to channel") } }
        if (move)
            items(state.channels.values.sortedBy { it.name }) { channel ->
                TextButton({
                    app.client.action(9, Proto().number(1, user.session).number(5, channel.id))
                    dismiss()
                }) {
                    Text(channel.name)
                }
            }
        if (!isSelf && state.can(0x10000))
            item {
                TextButton({ moderation = "Kick" }) {
                    Text("Kick user", color = LocalPalette.current.danger)
                }
            }
        if (!isSelf && state.can(0x20000))
            item {
                TextButton({ moderation = "Ban" }) {
                    Text("Ban user", color = LocalPalette.current.danger)
                }
            }
    }
    moderation?.let { action ->
        AlertDialog(
            onDismissRequest = { moderation = null },
            title = { Text("$action ${user.name}?") },
            text = { OutlinedTextField(reason, { reason = it }, label = { Text("Reason") }) },
            confirmButton = {
                TextButton({
                    app.client.action(
                        8,
                        Proto().number(1, user.session).text(3, reason).bool(4, action == "Ban"),
                    )
                    moderation = null
                    dismiss()
                }) {
                    Text(action)
                }
            },
            dismissButton = { TextButton({ moderation = null }) { Text("Cancel") } },
        )
    }
}

@Composable
fun ChannelSheet(
    app: MutterApplication,
    state: SessionState,
    channel: Channel,
    dismiss: () -> Unit,
) {
    var name by rememberSaveable(channel.id) { mutableStateOf(channel.name) }
    var childName by rememberSaveable(channel.id) { mutableStateOf("") }
    var temporary by rememberSaveable { mutableStateOf(true) }
    var deleting by remember { mutableStateOf(false) }
    LazyColumn(
        Modifier.fillMaxWidth().imePadding(),
        contentPadding = PaddingValues(start = 24.dp, end = 24.dp, bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Heading(channel.name, "${state.users.values.count { it.channel == channel.id }} people")
        }
        if (channel.description.isNotBlank()) item { RichMessage(channel.description) }
        item {
            Button(
                {
                    app.client.join(channel.id)
                    dismiss()
                },
                Modifier.fillMaxWidth(),
            ) {
                Text(if (state.self?.channel == channel.id) "You’re here" else "Join channel")
            }
        }
        item {
            ToggleRow(
                "Listen without joining",
                channel.id in state.self?.listening.orEmpty(),
                { app.client.listen(channel.id, it) },
            )
        }
        if (state.can(1, channel.id))
            item {
                SectionLabel("Edit channel")
                OutlinedTextField(
                    name,
                    { name = it },
                    Modifier.fillMaxWidth(),
                    label = { Text("Channel name") },
                )
                TextButton(
                    {
                        app.client.action(7, Proto().number(1, channel.id).text(3, name.trim()))
                        dismiss()
                    },
                    enabled = name.isNotBlank(),
                ) {
                    Text("Save name")
                }
            }
        if (state.can(0x40, channel.id) || state.can(0x400, channel.id))
            item {
                SectionLabel("Create a subchannel")
                OutlinedTextField(
                    childName,
                    { childName = it },
                    Modifier.fillMaxWidth(),
                    label = { Text("New channel name") },
                )
                ToggleRow("Temporary channel", temporary, { temporary = it })
                Button(
                    {
                        app.client.action(
                            7,
                            Proto()
                                .number(2, channel.id)
                                .text(3, childName.trim())
                                .bool(8, temporary),
                        )
                        childName = ""
                    },
                    enabled =
                        childName.isNotBlank() &&
                            state.can(if (temporary) 0x400 else 0x40, channel.id),
                ) {
                    Text("Create channel")
                }
            }
        if (channel.id != 0 && state.can(1, channel.id))
            item {
                TextButton({ deleting = true }) {
                    Text("Delete channel", color = LocalPalette.current.danger)
                }
            }
    }
    if (deleting)
        AlertDialog(
            onDismissRequest = { deleting = false },
            title = { Text("Delete ${channel.name}?") },
            text = { Text("People in this channel will be moved by the server.") },
            confirmButton = {
                TextButton({
                    app.client.action(6, Proto().number(1, channel.id))
                    dismiss()
                }) {
                    Text("Delete")
                }
            },
            dismissButton = { TextButton({ deleting = false }) { Text("Cancel") } },
        )
}

@Composable
fun WhisperSheet(app: MutterApplication, state: SessionState, dismiss: () -> Unit) {
    var selected by rememberSaveable { mutableStateOf(emptyList<Int>()) }
    var channel by rememberSaveable { mutableStateOf<Int?>(null) }
    var children by rememberSaveable { mutableStateOf(false) }
    var targetMode by rememberSaveable { mutableStateOf("people") }
    LaunchedEffect(selected, channel, children, targetMode) {
        app.client.whisper(
            if (targetMode == "people") selected.toSet() else emptySet(),
            if (targetMode == "channel") channel else null,
            children,
        )
    }
    DisposableEffect(Unit) { onDispose { app.audio.whisperHeld = false } }
    LazyColumn(
        Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(start = 24.dp, end = 24.dp, bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            Heading("A quieter word", "Choose who hears you.")
            ChoiceRow(listOf("people" to "People", "channel" to "Channel"), targetMode) {
                targetMode = it
            }
        }
        if (targetMode == "people")
            items(state.users.values.filter { it.session != state.me }.sortedBy { it.name }) { user
                ->
                ToggleRow(
                    user.name,
                    user.session in selected,
                    { selected = if (it) selected + user.session else selected - user.session },
                )
            }
        else {
            items(state.channels.values.sortedBy { it.name }) { item ->
                Row(
                    Modifier.fillMaxWidth().clickable { channel = item.id },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(channel == item.id, { channel = item.id })
                    Text(item.name)
                }
            }
            item { ToggleRow("Include subchannels", children, { children = it }) }
        }
        item {
            val enabled = if (targetMode == "people") selected.isNotEmpty() else channel != null
            Box(
                Modifier.fillMaxWidth()
                    .height(64.dp)
                    .background(
                        LocalPalette.current.whisper.copy(alpha = if (enabled) 1f else .3f),
                        androidx.compose.foundation.shape.RoundedCornerShape(16.dp),
                    )
                    .pointerInput(enabled) {
                        if (enabled)
                            detectTapGestures(
                                onPress = {
                                    app.audio.whisperHeld = true
                                    try {
                                        tryAwaitRelease()
                                    } finally {
                                        app.audio.whisperHeld = false
                                    }
                                }
                            )
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "Hold to whisper",
                    color = LocalPalette.current["onStatus"],
                    style = MaterialTheme.typography.labelLarge,
                )
            }
        }
    }
}

@Composable
fun ServerInfo(app: MutterApplication, state: SessionState) {
    var registered by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<Int?>(null) }
    var name by rememberSaveable { mutableStateOf("") }
    var removing by remember { mutableStateOf<Int?>(null) }
    LazyColumn(
        Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(start = 24.dp, end = 24.dp, bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Heading(state.server?.name?.ifBlank { "Server" } ?: "Server", state.version)
            Hint("${state.server?.host}:${state.server?.port}")
        }
        item {
            AppCard(Modifier.fillMaxWidth()) {
                Text("${state.users.size} people · ${state.channels.size} channels")
                Text(
                    "${state.ping} ms · ${if (state.udp) "Encrypted UDP voice" else "TLS voice tunnel"}"
                )
            }
        }
        if (state.welcome.isNotBlank()) item { RichMessage(state.welcome) }
        if (state.can(0x40000))
            item {
                OutlinedButton({
                    registered = !registered
                    if (registered) app.client.action(18, Proto())
                }) {
                    Text("Registered users")
                }
            }
        if (registered)
            items(state.registeredUsers.entries.toList(), key = { it.key }) { (id, userName) ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(userName, Modifier.weight(1f))
                    ActionIcon(Icons.Rounded.Edit, "Rename $userName") {
                        editing = id
                        name = userName
                    }
                    ActionIcon(Icons.Rounded.Delete, "Remove $userName") { removing = id }
                }
            }
        item {
            SectionLabel("Connection log")
            Text(
                state.log.takeLast(20).joinToString("\n"),
                style = MaterialTheme.typography.bodySmall,
                color = LocalPalette.current.muted,
            )
        }
    }
    editing?.let { id ->
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text("Rename registered user") },
            text = { OutlinedTextField(name, { name = it }, label = { Text("Name") }) },
            confirmButton = {
                TextButton(
                    {
                        app.client.action(
                            18,
                            Proto().message(1, Proto().number(1, id).text(2, name)),
                        )
                        editing = null
                    },
                    enabled = name.isNotBlank(),
                ) {
                    Text("Save")
                }
            },
            dismissButton = { TextButton({ editing = null }) { Text("Cancel") } },
        )
    }
    removing?.let { id ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text("Remove this registration?") },
            text = { Text(state.registeredUsers[id].orEmpty()) },
            confirmButton = {
                TextButton({
                    app.client.action(18, Proto().message(1, Proto().number(1, id)))
                    removing = null
                }) {
                    Text("Remove")
                }
            },
            dismissButton = { TextButton({ removing = null }) { Text("Cancel") } },
        )
    }
}
