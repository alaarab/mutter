package com.alaarab.mutter.ui

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CornerSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.alaarab.mutter.data.*

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun HomeScreen(
    servers: List<Server>,
    state: SessionState,
    onConnect: (Server) -> Unit,
    onEdit: (Server) -> Unit,
    onAdd: () -> Unit,
    onBrowse: () -> Unit,
    onSession: () -> Unit,
    onFavorite: (Server) -> Unit,
) {
    val p = LocalPalette.current
    var menu by remember { mutableStateOf<String?>(null) }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(0.dp),
    ) {
        item {
            Text(
                "Mutter",
                style = MaterialTheme.typography.displaySmall.copy(fontSize = 32.sp),
                modifier = Modifier.padding(top = 6.dp, bottom = 24.dp),
            )
        }
        if (state.connected)
            item {
                AppCard(Modifier.fillMaxWidth(), onSession, highlighted = true) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Icon(Icons.Rounded.GraphicEq, null, tint = p.accent)
                        Column(Modifier.weight(1f)) {
                            Text(
                                state.server?.name?.ifBlank { state.server.host } ?: "Connected",
                                style = MaterialTheme.typography.titleSmall,
                            )
                            Hint("Connected · tap to return")
                        }
                        Icon(Icons.Rounded.ChevronRight, null, tint = p.muted)
                    }
                }
            }
        if (servers.isEmpty())
            item {
                Spacer(Modifier.height(20.dp))
                EmptyState(
                    Icons.Rounded.RecordVoiceOver,
                    "No servers yet",
                    "Add a Mumble server you know, or browse the public directory.",
                )
                Row(
                    Modifier.fillMaxWidth().padding(top = 12.dp),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Button(onAdd, shape = MaterialTheme.shapes.small) {
                        Icon(Icons.Rounded.Add, null, Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Add server")
                    }
                    Spacer(Modifier.width(10.dp))
                    FilledTonalButton(onBrowse) {
                        Icon(Icons.Rounded.Public, null, Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Browse")
                    }
                }
            }
        listOf(
                "Favourites" to servers.filter { it.favorite },
                "Recent" to servers.filter { !it.favorite }.sortedByDescending { it.lastUsed },
            )
            .forEach { (title, group) ->
                if (group.isNotEmpty()) item { SectionLabel(title) }
                itemsIndexed(group, key = { _, server -> server.id }) { index, server ->
                    val shape =
                        MaterialTheme.shapes.small.copy(
                            topStart = CornerSize(if (index == 0) 12.dp else 0.dp),
                            topEnd = CornerSize(if (index == 0) 12.dp else 0.dp),
                            bottomStart = CornerSize(if (index == group.lastIndex) 12.dp else 0.dp),
                            bottomEnd = CornerSize(if (index == group.lastIndex) 12.dp else 0.dp),
                        )
                    Column(
                        Modifier.fillMaxWidth()
                            .background(p.surface, shape)
                            .combinedClickable(
                                onClick = { onConnect(server) },
                                onLongClick = { menu = server.id },
                            )
                            .padding(horizontal = 14.dp)
                    ) {
                        Row(
                            Modifier.padding(vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Avatar(server.name.ifBlank { server.host }, size = 44, rounded = true)
                            Column(
                                Modifier.weight(1f),
                                verticalArrangement = Arrangement.spacedBy(3.dp),
                            ) {
                                Text(
                                    server.name.ifBlank { server.host },
                                    style =
                                        MaterialTheme.typography.titleLarge.copy(fontSize = 18.sp),
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    "${server.host}:${server.port}${if (server.username.isBlank()) "" else " · ${server.username}"}",
                                    color = p.muted,
                                    style = MaterialTheme.typography.bodySmall,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                            Box {
                                Column(horizontalAlignment = Alignment.End) {
                                    ServerLatency(server)
                                    IconButton({ menu = server.id }, Modifier.size(32.dp)) {
                                        Icon(
                                            Icons.Rounded.MoreHoriz,
                                            "Options for ${server.name}",
                                            Modifier.size(18.dp),
                                            tint = p.muted,
                                        )
                                    }
                                }
                                DropdownMenu(menu == server.id, { menu = null }) {
                                    DropdownMenuItem(
                                        text = { Text("Edit") },
                                        onClick = {
                                            menu = null
                                            onEdit(server)
                                        },
                                    )
                                    DropdownMenuItem(
                                        text = {
                                            Text(
                                                if (server.favorite) "Unfavourite" else "Favourite"
                                            )
                                        },
                                        onClick = {
                                            menu = null
                                            onFavorite(server)
                                        },
                                    )
                                }
                            }
                        }
                        if (index < group.lastIndex) SectionDivider()
                    }
                }
            }
    }
}
