package com.alaarab.mutter.ui

import androidx.compose.foundation.*
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
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
    val transmitting by app.audio.transmitting.collectAsStateWithLifecycle()
    val profile = user.withLocalSpeech(state.me, transmitting)
    val now = sessionTime()
    val p = LocalPalette.current
    LazyColumn(
        Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(start = 24.dp, end = 24.dp, bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Column(
                Modifier.fillMaxWidth()
                    .clip(MaterialTheme.shapes.large)
                    .background(
                        Brush.verticalGradient(listOf(p.accent.copy(alpha = .12f), p.surface))
                    )
                    .border(1.dp, p["separator"].copy(alpha = .6f), MaterialTheme.shapes.large)
                    .padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                UserAvatar(profile, now, 80)
                Text(
                    user.name,
                    style = MaterialTheme.typography.headlineMedium,
                    textAlign = TextAlign.Center,
                )
                Hint(
                    "${state.channels[user.channel]?.name ?: "Channel"}${if (isSelf) " · You" else ""}"
                )
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    StatusPill(
                        userStatus(profile, now),
                        if (userStatus(profile, now) == "Speaking") p.speaking else p.muted,
                    )
                    if (user.registered >= 0)
                        StatusPill("Registered", p.accent, Icons.Rounded.VerifiedUser)
                    if (user.priority) StatusPill("Priority speaker", p.accent, Icons.Rounded.Star)
                }
            }
        }
        if (user.comment.isNotBlank())
            item {
                SectionLabel("About")
                AppCard(Modifier.fillMaxWidth()) { RichMessage(user.comment) }
            }
        if (!isSelf) {
            item {
                Button(message, Modifier.fillMaxWidth()) {
                    Icon(Icons.Rounded.Forum, null)
                    Spacer(Modifier.width(8.dp))
                    Text("Direct message")
                }
            }
            item {
                SectionLabel("Your mix")
                AppCard(Modifier.fillMaxWidth()) {
                    ToggleRow(
                        "Mute locally",
                        user.localMute,
                        { app.client.localUser(user.session, mute = it) },
                    )
                    Text("Their volume · ${(user.volume * 100).toInt()}%")
                    AppSlider(
                        user.volume,
                        { app.client.localUser(user.session, volume = it) },
                        valueRange = 0f..1f,
                    )
                    Hint("These controls only change what you hear.")
                }
            }
        }
        item {
            AppCard(Modifier.fillMaxWidth()) {
                SettingsLink(
                    Icons.Rounded.Info,
                    "User information",
                    "Connection and client details",
                ) {
                    app.client.action(22, Proto().number(1, user.session).bool(2, false))
                }
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
                AppCard(Modifier.fillMaxWidth()) {
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
