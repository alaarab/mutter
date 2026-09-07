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
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import com.alaarab.mutter.data.*

@Composable
fun ChannelsScreen(
    state: SessionState,
    hideEmpty: Boolean,
    transmitting: Boolean,
    onJoin: (Int) -> Unit,
    onUser: (Int) -> Unit,
    onChannel: (Int) -> Unit,
) {
    val now = sessionTime()
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
                shape = MaterialTheme.shapes.medium,
            )
        }
        if (ordered.isEmpty())
            item {
                EmptyState(
                    Icons.Rounded.SearchOff,
                    "No channels found",
                    "Try another channel or person’s name.",
                )
            }
        items(ordered, key = { it.first.id }) { (channel, depth) ->
            AppCard(
                Modifier.fillMaxWidth().padding(start = minOf(depth * 10, 24).dp),
                highlighted = state.self?.channel == channel.id,
            ) {
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
                    Column(
                        Modifier.weight(1f).heightIn(min = 48.dp).clickable { onJoin(channel.id) },
                        verticalArrangement = Arrangement.Center,
                    ) {
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
                        .map { it.withLocalSpeech(state.me, transmitting) }
                        .sortedBy { it.name }
                        .forEach { user ->
                            Row(
                                Modifier.fillMaxWidth()
                                    .clip(MaterialTheme.shapes.small)
                                    .clickable { onUser(user.session) }
                                    .heightIn(min = 48.dp)
                                    .padding(horizontal = 6.dp, vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                UserAvatar(user, now, 32)
                                Spacer(Modifier.width(10.dp))
                                Text(
                                    user.name,
                                    Modifier.weight(1f),
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                                if (userStatus(user, now) == "Speaking")
                                    Icon(
                                        Icons.Rounded.GraphicEq,
                                        "Speaking",
                                        tint = LocalPalette.current.speaking,
                                        modifier = Modifier.size(18.dp),
                                    )
                                else if (user.session == state.me) Hint("You")
                            }
                        }
            }
        }
    }
}
