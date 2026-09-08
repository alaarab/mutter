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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.alaarab.mutter.MutterApplication
import com.alaarab.mutter.data.*
import com.alaarab.mutter.protocol.Proto

@Composable
fun ServerInfo(app: MutterApplication, state: SessionState) {
    val settings by app.store.settings.collectAsStateWithLifecycle()
    var disconnect by remember { mutableStateOf(false) }
    var showLog by rememberSaveable { mutableStateOf(false) }
    var registered by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<Int?>(null) }
    var name by rememberSaveable { mutableStateOf("") }
    var removing by remember { mutableStateOf<Int?>(null) }
    LazyColumn(
        Modifier.fillMaxWidth().testTag("serverDetails"),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (state.welcome.isNotBlank())
            item {
                SectionLabel("Welcome")
                AppCard(Modifier.fillMaxWidth()) { RichMessage(state.welcome) }
            }
        item {
            SectionLabel("Server")
            AppCard(Modifier.fillMaxWidth()) {
                DetailRow("Address", "${state.server?.host}:${state.server?.port}")
                SectionDivider()
                DetailRow("Version", state.version)
                SectionDivider()
                DetailRow("People online", state.users.size.toString())
                SectionDivider()
                DetailRow("Channels", state.channels.size.toString())
            }
        }
        item {
            SectionLabel("Connection")
            AppCard(Modifier.fillMaxWidth()) {
                DetailRow("Voice transport", if (state.udp) "UDP (encrypted)" else "TCP tunnel")
                SectionDivider()
                DetailRow("Ping", "${state.ping} ms")
                SectionDivider()
                DetailRow("Codec", "Opus ${settings.bitrate / 1000} kbit/s · 20 ms")
            }
        }
        item {
            SectionLabel("You")
            AppCard(Modifier.fillMaxWidth()) {
                DetailRow("Connected as", state.self?.name.orEmpty())
                SectionDivider()
                DetailRow("Registered", if ((state.self?.registered ?: -1) >= 0) "Yes" else "No")
            }
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
        item {
            AppCard(Modifier.fillMaxWidth()) {
                TextButton({ disconnect = true }, Modifier.fillMaxWidth()) {
                    Icon(Icons.Rounded.CallEnd, null, tint = LocalPalette.current.danger)
                    Spacer(Modifier.width(8.dp))
                    Text("Disconnect", color = LocalPalette.current.danger)
                }
            }
        }
    }
    if (disconnect)
        AlertDialog(
            onDismissRequest = { disconnect = false },
            title = { Text("Disconnect from this server?") },
            confirmButton = { TextButton(app::disconnect) { Text("Disconnect") } },
            dismissButton = { TextButton({ disconnect = false }) { Text("Cancel") } },
        )
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
