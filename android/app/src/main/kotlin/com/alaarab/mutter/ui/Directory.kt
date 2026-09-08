package com.alaarab.mutter.ui

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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.alaarab.mutter.data.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

@Composable
fun ServerLatency(server: Server) {
    val probe by
        produceState<Probe?>(null, server.host, server.port) {
            while (isActive) {
                value = Discovery.probe(server)
                delay(30000)
            }
        }
    Hint(probe?.let { "${it.users}/${it.capacity} · ${it.ping} ms" } ?: "")
}

@Composable
fun DirectoryScreen(select: (Server) -> Unit) {
    val context = LocalContext.current
    var tab by rememberSaveable { mutableStateOf("public") }
    var query by rememberSaveable { mutableStateOf("") }
    var directory by remember { mutableStateOf<List<Server>>(emptyList()) }
    var local by remember { mutableStateOf<List<Server>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var retry by remember { mutableIntStateOf(0) }
    LaunchedEffect(retry) {
        loading = true
        try {
            directory = Discovery.directory()
            error = null
        } catch (failure: Exception) {
            error = failure.message
        } finally {
            loading = false
        }
    }
    LaunchedEffect(Unit) {
        Discovery.local(context).collect { server ->
            local = local.filterNot { it.id == server.id } + server
        }
    }
    LazyColumn(
        Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            ChoiceRow(listOf("public" to "Public directory", "local" to "Local network"), tab) {
                tab = it
            }
        }
        item {
            OutlinedTextField(
                query,
                { query = it },
                Modifier.fillMaxWidth(),
                placeholder = { Text("Search servers") },
                leadingIcon = { Icon(Icons.Rounded.Search, null) },
                singleLine = true,
            )
        }
        if (tab == "public" && loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
        if (tab == "public" && error != null)
            item {
                AppCard(Modifier.fillMaxWidth()) {
                    IconWell(Icons.Rounded.CloudOff, LocalPalette.current.muted)
                    Text(
                        "Couldn’t load the directory",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Hint("Check your connection and try again.")
                    TextButton({ retry++ }) { Text("Try again") }
                }
            }
        if (tab == "local" && local.isEmpty())
            item {
                EmptyState(
                    Icons.Rounded.Wifi,
                    "Listening nearby",
                    "Looking for Mumble servers on this network…",
                )
            }
        val filtered =
            (if (tab == "public") directory else local).filter {
                "${it.name} ${it.host}".contains(query, true)
            }
        if (query.isNotBlank() && filtered.isEmpty() && !(tab == "public" && loading))
            item {
                EmptyState(
                    Icons.Rounded.SearchOff,
                    "No servers found",
                    "Try another name or address.",
                )
            }
        items(
            filtered,
            key = { it.id },
        ) { server ->
            AppCard(Modifier.fillMaxWidth(), { select(server) }) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    IconWell(if (tab == "local") Icons.Rounded.Wifi else Icons.Rounded.Public)
                    Column(Modifier.weight(1f)) {
                        Text(server.name, style = MaterialTheme.typography.titleMedium)
                        Hint("${server.host}:${server.port}")
                    }
                    Icon(
                        Icons.Rounded.ChevronRight,
                        null,
                        tint = LocalPalette.current.muted,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
        }
    }
}
