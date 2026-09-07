package com.alaarab.mutter.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
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
        contentPadding = PaddingValues(start = 24.dp, end = 24.dp, bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item { Heading("Find your people", "Discover a community or a nearby server.") }
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
                Text(error!!)
                TextButton({ retry++ }) { Text("Try again") }
            }
        if (tab == "local" && local.isEmpty())
            item { Hint("Looking for Mumble servers on this network…") }
        items(
            (if (tab == "public") directory else local).filter {
                "${it.name} ${it.host}".contains(query, true)
            },
            key = { it.id },
        ) { server ->
            AppCard(Modifier.fillMaxWidth(), { select(server) }) {
                Text(server.name, style = MaterialTheme.typography.titleMedium)
                Hint("${server.host}:${server.port}")
            }
        }
    }
}
