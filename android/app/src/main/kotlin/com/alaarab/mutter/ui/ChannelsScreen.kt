package com.alaarab.mutter.ui

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.VolumeOff
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.alaarab.mutter.data.*

private data class TreeRow(
    val channel: Channel? = null,
    val user: User? = null,
    val depth: Int = 0,
) {
    val key
        get() = channel?.let { "channel-${it.id}" } ?: "user-${user!!.session}"
}

@Composable
fun ChannelsScreen(
    state: SessionState,
    hideEmpty: Boolean,
    transmitting: Boolean,
    onHideEmpty: () -> Unit,
    onJoin: (Int) -> Unit,
    onUser: (Int) -> Unit,
    onChannel: (Int) -> Unit,
) {
    val p = LocalPalette.current
    val now = sessionTime()
    var query by rememberSaveable { mutableStateOf("") }
    var collapsed by rememberSaveable { mutableStateOf(emptyList<Int>()) }
    val rows =
        remember(state.channels, state.users, query, collapsed, hideEmpty) {
            val result = mutableListOf<TreeRow>()
            val users = state.users.values.groupBy { it.channel }
            val children = state.channels.values.filter { it.id != it.parent }.groupBy { it.parent }
            val occupied = mutableSetOf(0)
            for (user in state.users.values) {
                var id: Int? = user.channel
                val seen = mutableSetOf<Int>()
                while (id != null && seen.add(id)) {
                    occupied.add(id)
                    id = state.channels[id]?.parent
                }
            }
            if (query.isNotBlank()) {
                val search = query.trim()
                state.channels.values
                    .filter { it.name.contains(search, true) }
                    .sortedBy { it.name.lowercase() }
                    .forEach { result.add(TreeRow(channel = it)) }
                state.users.values
                    .filter { it.name.contains(search, true) }
                    .sortedBy { it.name.lowercase() }
                    .forEach { result.add(TreeRow(user = it)) }
            } else {
                val seen = mutableSetOf<Int>()
                fun visit(channel: Channel, depth: Int) {
                    if (
                        !seen.add(channel.id) ||
                            depth > 32 ||
                            (hideEmpty && channel.id !in occupied)
                    )
                        return
                    result.add(TreeRow(channel = channel, depth = depth))
                    if (channel.id !in collapsed) {
                        users[channel.id]
                            .orEmpty()
                            .sortedBy { it.name.lowercase() }
                            .forEach { result.add(TreeRow(user = it, depth = depth + 1)) }
                        children[channel.id]
                            .orEmpty()
                            .sortedWith(
                                compareBy<Channel> { it.position }.thenBy { it.name.lowercase() }
                            )
                            .forEach { visit(it, depth + 1) }
                    }
                }
                state.channels[0]?.let { visit(it, 0) }
            }
            result
        }
    val shortWindow = LocalConfiguration.current.screenHeightDp < 500
    val search: @Composable () -> Unit = {
        Row(
            Modifier.fillMaxWidth()
                .padding(horizontal = 16.dp)
                .padding(bottom = 6.dp)
                .background(p["sunken"], MaterialTheme.shapes.small)
                .padding(start = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(Icons.Rounded.Search, null, Modifier.size(18.dp), tint = p.muted)
            BasicTextField(
                query,
                { query = it },
                Modifier.weight(1f).heightIn(min = 42.dp).padding(vertical = 10.dp),
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyMedium.copy(color = p.ink),
                cursorBrush = SolidColor(p.accent),
                decorationBox = { field ->
                    if (query.isEmpty())
                        Text(
                            "Find a channel or person",
                            color = p.muted,
                            style = MaterialTheme.typography.bodyMedium,
                            maxLines = 1,
                        )
                    field()
                },
            )
            ActionIcon(
                if (query.isEmpty()) Icons.Rounded.FilterList else Icons.Rounded.Cancel,
                if (query.isNotEmpty()) "Clear search"
                else if (hideEmpty) "Show empty channels" else "Hide empty channels",
                if (hideEmpty && query.isEmpty()) p.accent else p.muted,
            ) {
                if (query.isNotEmpty()) query = "" else onHideEmpty()
            }
        }
    }
    Column(Modifier.fillMaxSize()) {
        if (!shortWindow) search()
        LazyColumn(
            Modifier.fillMaxSize().testTag("channelTree"),
            contentPadding = PaddingValues(bottom = 12.dp),
        ) {
            if (shortWindow) item(key = "search") { search() }
            if (rows.isEmpty())
                item {
                    EmptyState(
                        Icons.Rounded.Search,
                        "Nothing found",
                        "No channels or people match “${query.trim()}”.",
                    )
                }
            items(rows, key = { it.key }) { row ->
                val indent = minOf(row.depth * 18, 90).dp
                if (row.channel != null) {
                    val channel = row.channel
                    val mine = state.self?.channel == channel.id
                    val count =
                        state.users.values.count { user ->
                            var id: Int? = user.channel
                            val seen = mutableSetOf<Int>()
                            while (id != null && id != channel.id && seen.add(id)) id =
                                state.channels[id]?.parent
                            id == channel.id
                        }
                    Row(
                        Modifier.fillMaxWidth()
                            .background(if (mine) p.accent.copy(alpha = .10f) else p.background)
                            .clickable { onChannel(channel.id) }
                            .heightIn(min = 62.dp)
                            .padding(start = 8.dp + indent, end = 16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        IconButton(
                            {
                                collapsed =
                                    if (channel.id in collapsed) collapsed - channel.id
                                    else collapsed + channel.id
                            },
                            Modifier.size(40.dp),
                        ) {
                            Icon(
                                if (channel.id in collapsed) Icons.Rounded.ChevronRight
                                else Icons.Rounded.ExpandMore,
                                "${if (channel.id in collapsed) "Expand" else "Collapse"} ${channel.name}",
                                Modifier.size(16.dp),
                                tint = p.muted,
                            )
                        }
                        Icon(
                            if (channel.temporary) Icons.Rounded.Schedule else Icons.Rounded.Tag,
                            null,
                            Modifier.size(16.dp),
                            tint = if (mine) p.accent else p.muted,
                        )
                        Column(Modifier.weight(1f).padding(horizontal = 4.dp, vertical = 6.dp)) {
                            Text(
                                channel.name.ifBlank { "Root" },
                                style =
                                    MaterialTheme.typography.bodyLarge.copy(
                                        fontWeight =
                                            if (mine) FontWeight.SemiBold else FontWeight.Medium
                                    ),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            if (query.isNotBlank())
                                state.channels[channel.parent]?.let { Hint(it.name) }
                        }
                        if (channel.id in state.self?.listening.orEmpty())
                            Icon(
                                Icons.Rounded.Hearing,
                                "Listening in",
                                Modifier.size(16.dp),
                                tint = p.whisper,
                            )
                        if (count > 0 || channel.maxUsers > 0)
                            StatusPill(
                                if (channel.maxUsers > 0) "$count/${channel.maxUsers}"
                                else count.toString(),
                                p.muted,
                            )
                        if (!mine)
                            IconButton({ onJoin(channel.id) }, Modifier.size(40.dp)) {
                                Icon(
                                    Icons.Rounded.ArrowCircleRight,
                                    "Join ${channel.name}",
                                    Modifier.size(22.dp),
                                    tint = p.accent,
                                )
                            }
                    }
                } else
                    row.user?.let { original ->
                        val user = original.withLocalSpeech(state.me, transmitting)
                        val speaking = userStatus(user, now) == "Speaking"
                        Row(
                            Modifier.fillMaxWidth()
                                .clickable { onUser(user.session) }
                                .heightIn(min = 70.dp)
                                .padding(
                                    start = 28.dp + indent,
                                    end = 16.dp,
                                    top = 6.dp,
                                    bottom = 6.dp,
                                ),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            UserAvatar(user, now, 30)
                            Column(Modifier.weight(1f)) {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                                ) {
                                    Text(
                                        user.name,
                                        Modifier.weight(1f, fill = false),
                                        style =
                                            MaterialTheme.typography.bodyMedium.copy(
                                                fontWeight =
                                                    if (user.session == state.me)
                                                        FontWeight.SemiBold
                                                    else FontWeight.Normal
                                            ),
                                        color =
                                            if (user.selfMute || user.mute || user.suppress) p.muted
                                            else p.ink,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    if (user.session == state.me)
                                        Text(
                                            "you",
                                            style = MaterialTheme.typography.labelSmall,
                                            color = p.muted,
                                        )
                                    if (user.priority)
                                        Icon(
                                            Icons.Rounded.Star,
                                            "Priority speaker",
                                            Modifier.size(12.dp),
                                            tint = p["warn"],
                                        )
                                    if (user.registered >= 0)
                                        Icon(
                                            Icons.Rounded.Verified,
                                            "Registered",
                                            Modifier.size(12.dp),
                                            tint = p.muted,
                                        )
                                }
                                if (query.isNotBlank())
                                    Hint(state.channels[user.channel]?.name.orEmpty())
                                else if (speaking)
                                    Text(
                                        "Speaking",
                                        color = p.speaking,
                                        style = MaterialTheme.typography.labelSmall,
                                    )
                            }
                            if (user.localMute)
                                Icon(
                                    Icons.AutoMirrored.Rounded.VolumeOff,
                                    "Muted for you",
                                    Modifier.size(16.dp),
                                    tint = p["warn"],
                                )
                        }
                    }
            }
        }
    }
}
