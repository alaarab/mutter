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
import androidx.compose.ui.unit.dp
import com.alaarab.mutter.MutterApplication
import com.alaarab.mutter.data.*
import com.alaarab.mutter.protocol.Proto

@Composable
fun ServerInfo(app: MutterApplication, state: SessionState) {
    var showLog by rememberSaveable { mutableStateOf(false) }
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
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(20.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    ServerMetric(state.users.size.toString(), "People")
                    ServerMetric(state.channels.size.toString(), "Channels")
                    ServerMetric("${state.ping} ms", "Latency")
                }
                SectionDivider()
                StatusPill(
                    if (state.udp) "Encrypted UDP voice" else "TLS voice tunnel",
                    LocalPalette.current.speaking,
                    Icons.Rounded.Lock,
                )
            }
        }
        if (state.welcome.isNotBlank())
            item {
                SectionLabel("Welcome")
                AppCard(Modifier.fillMaxWidth()) { RichMessage(state.welcome) }
            }
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
            TextButton({ showLog = !showLog }) {
                Icon(if (showLog) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore, null)
                Spacer(Modifier.width(8.dp))
                Text("Connection log")
            }
            if (showLog)
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

@Composable
private fun ServerMetric(value: String, label: String) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(value, style = MaterialTheme.typography.titleLarge)
        Hint(label)
    }
}
