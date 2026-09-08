package com.alaarab.mutter.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.alaarab.mutter.MutterApplication
import com.alaarab.mutter.data.*

@Composable
fun ServerEditor(
    server: Server,
    app: MutterApplication,
    onSave: (Server) -> Unit,
    onConnect: (Server) -> Unit,
    onDelete: () -> Unit,
    onDismiss: () -> Unit,
) {
    var name by rememberSaveable(server.id) { mutableStateOf(server.name) }
    var host by rememberSaveable(server.id) { mutableStateOf(server.host) }
    var port by rememberSaveable(server.id) { mutableStateOf(server.port.toString()) }
    var username by rememberSaveable(server.id) { mutableStateOf(server.username) }
    var password by remember(server.id) { mutableStateOf(server.password) }
    var tokens by remember(server.id) { mutableStateOf(server.tokens.joinToString(", ")) }
    var identity by rememberSaveable(server.id) { mutableStateOf(server.identity) }
    var error by remember { mutableStateOf<String?>(null) }
    var deleting by remember { mutableStateOf(false) }
    val servers by app.store.servers.collectAsStateWithLifecycle()
    val identities by app.store.identities.collectAsStateWithLifecycle()
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    fun submit(action: (Server) -> Unit) {
        focus.clearFocus()
        keyboard?.hide()
        val parsed = port.toIntOrNull()
        if (
            host.isBlank() ||
                username.isBlank() ||
                parsed == null ||
                parsed !in 1..65535 ||
                host.contains(Regex("[\\s/]"))
        ) {
            error = "Enter a host name, a port from 1–65535, and your username."
            return
        }
        action(
            server.copy(
                name = name.trim(),
                host = host.trim(),
                port = parsed,
                username = username.trim(),
                password = password,
                tokens = tokens.split(',').map { it.trim() }.filter { it.isNotEmpty() },
                identity = identity,
            )
        )
    }
    Column(Modifier.fillMaxWidth()) {
        SheetHeader(
            if (servers.any { it.id == server.id }) "Edit server" else "Add server",
            actionLabel = "Save",
            cancel = onDismiss,
        ) {
            submit(onSave)
        }
        LazyColumn(
            Modifier.fillMaxWidth().weight(1f, fill = false).imePadding(),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { SectionLabel("Server") }
            item {
                AppCard(Modifier.fillMaxWidth()) {
                    FormField(name, { name = it }, "Name")
                    SectionDivider()
                    FormField(host, { host = it }, "Address", keyboardType = KeyboardType.Uri)
                    SectionDivider()
                    FormField(port, { port = it }, "Port", keyboardType = KeyboardType.Number)
                }
            }
            item { SectionLabel("You") }
            item {
                AppCard(Modifier.fillMaxWidth()) {
                    FormField(username, { username = it }, "Username")
                    SectionDivider()
                    FormField(password, { password = it }, "Password (optional)", secret = true)
                    SectionDivider()
                    Text("Certificate", style = MaterialTheme.typography.bodyLarge)
                    ChoiceRow(
                        listOf("default" to "Default") +
                            identities.filter { it.id != "default" }.map { it.id to it.name },
                        identity,
                    ) {
                        identity = it
                    }
                }
                Hint(
                    "A certificate lets servers recognise you across sessions. Manage them in Settings."
                )
            }
            item { SectionLabel("Access") }
            item {
                AppCard(Modifier.fillMaxWidth()) {
                    FormField(tokens, { tokens = it }, "Access tokens (comma separated)")
                }
                Hint("Tokens unlock channels that are restricted by the server admin.")
            }
            error?.let { item { Text(it, color = LocalPalette.current.danger) } }
            item {
                TextButton({ submit(onConnect) }, Modifier.fillMaxWidth()) {
                    Text("Save & connect")
                }
            }
            if (servers.any { it.id == server.id })
                item {
                    TextButton({ deleting = true }) {
                        Text("Delete server", color = LocalPalette.current.danger)
                    }
                }
        }
    }
    if (deleting)
        AlertDialog(
            onDismissRequest = { deleting = false },
            title = { Text("Delete this saved server?") },
            text = { Text(server.name.ifBlank { server.host }) },
            confirmButton = { TextButton(onDelete) { Text("Delete") } },
            dismissButton = { TextButton({ deleting = false }) { Text("Cancel") } },
        )
}
