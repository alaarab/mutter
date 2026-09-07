package com.alaarab.mutter.ui

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.List
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import com.alaarab.mutter.data.*

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
                    shape = MaterialTheme.shapes.medium,
                )
            }
        if (servers.isEmpty())
            item {
                EmptyState(
                    Icons.Rounded.Forum,
                    "A little closer, wherever you are.",
                    "Add your Mumble server or find a community in the directory.",
                )
            }
        if (servers.isNotEmpty()) item { SectionLabel("Your servers") }
        if (servers.isNotEmpty() && servers.none { "${it.name} ${it.host}".contains(query, true) })
            item {
                EmptyState(
                    Icons.Rounded.SearchOff,
                    "No servers found",
                    "Try another name or address.",
                )
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
                        if (server.favorite) LocalPalette.current.accent
                        else LocalPalette.current.muted,
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
    Button(onAdd, modifier.heightIn(min = 52.dp)) {
        Icon(Icons.Rounded.Add, null)
        Spacer(Modifier.width(6.dp))
        Text("Add server")
    }
    OutlinedButton(onBrowse, modifier.heightIn(min = 52.dp)) {
        Icon(Icons.Rounded.Public, null)
        Spacer(Modifier.width(6.dp))
        Text("Discover")
    }
}
