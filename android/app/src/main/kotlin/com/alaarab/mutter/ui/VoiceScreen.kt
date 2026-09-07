package com.alaarab.mutter.ui

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ScreenShare
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.alaarab.mutter.MutterApplication
import com.alaarab.mutter.data.*

@Composable
fun VoiceScreen(
    app: MutterApplication,
    state: SessionState,
    onUser: (Int) -> Unit,
    onChannels: () -> Unit,
) {
    val now = sessionTime()
    val p = LocalPalette.current
    val transmitting by app.audio.transmitting.collectAsStateWithLifecycle()
    val shares by app.shares.shares.collectAsStateWithLifecycle()
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val compact = maxHeight < 280.dp
        val columns =
            if (compact) 1
            else (maxWidth.value / (175 * LocalDensity.current.fontScale)).toInt().coerceIn(1, 4)
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = PaddingValues(20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item {
                Heading(
                    state.channel?.name ?: "Voice",
                    "${peopleLabel(state.users.values.count { it.channel == state.self?.channel })} here.",
                ) {
                    ActionIcon(Icons.Rounded.SwapHoriz, "Change channel", action = onChannels)
                }
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (state.connected) StatusPill("Connected", p.speaking, Icons.Rounded.Lock)
                    else
                        StatusPill(
                            state.status.replaceFirstChar { it.uppercase() },
                            p["warn"],
                            Icons.Rounded.Sync,
                        )
                    StatusPill("${state.ping} ms", p.muted, Icons.Rounded.SignalCellularAlt)
                }
            }
            val users =
                state.users.values
                    .filter { it.channel == state.self?.channel }
                    .map { it.withLocalSpeech(state.me, transmitting) }
                    .sortedBy { it.name.lowercase() }
            items(
                users.chunked(columns),
                key = { row -> row.joinToString { it.session.toString() } },
            ) { row ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    row.forEach { user ->
                        val status = userStatus(user, now)
                        AppCard(
                            Modifier.weight(1f),
                            { onUser(user.session) },
                            highlighted = status == "Speaking",
                        ) {
                            if (compact)
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                                ) {
                                    UserAvatar(user, now, 42)
                                    UserCaption(user, status, Modifier.weight(1f), maxLines = 1)
                                    if (user.session == state.me) StatusPill("You", p.muted)
                                }
                            else {
                                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
                                    UserAvatar(user, now, 58)
                                    Spacer(Modifier.weight(1f))
                                    if (user.session == state.me) StatusPill("You", p.muted)
                                }
                                UserCaption(user, status)
                            }
                        }
                    }
                    repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
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
    }
    ShareDialog(app)
}

@Composable
private fun UserCaption(
    user: User,
    status: String,
    modifier: Modifier = Modifier,
    maxLines: Int = 2,
) {
    val p = LocalPalette.current
    Column(modifier, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
            user.name,
            style = MaterialTheme.typography.titleMedium,
            maxLines = maxLines,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            status,
            color = if (status == "Speaking") p.speaking else p.muted,
            style = MaterialTheme.typography.bodySmall,
        )
    }
}
