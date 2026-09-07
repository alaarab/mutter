package com.alaarab.mutter.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
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
    val identities by app.store.identities.collectAsStateWithLifecycle()
    fun submit(action: (Server) -> Unit) {
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
    LazyColumn(
        Modifier.fillMaxWidth().imePadding(),
        contentPadding = PaddingValues(start = 24.dp, end = 24.dp, bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Heading(
                if (server.host.isEmpty()) "Add a server" else "Server details",
                "A familiar place to drop in.",
            )
        }
        item { SectionLabel("Connection") }
        item {
            OutlinedTextField(
                name,
                { name = it },
                Modifier.fillMaxWidth(),
                label = { Text("Name") },
                singleLine = true,
            )
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    host,
                    { host = it },
                    Modifier.weight(1f),
                    label = { Text("Host") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                )
                OutlinedTextField(
                    port,
                    { port = it },
                    Modifier.width(maxOf(104f, 88f * LocalDensity.current.fontScale).dp),
                    label = { Text("Port") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                )
            }
        }
        item { SectionLabel("Your identity") }
        item {
            OutlinedTextField(
                username,
                { username = it },
                Modifier.fillMaxWidth(),
                label = { Text("Username") },
                singleLine = true,
            )
        }
        item {
            OutlinedTextField(
                password,
                { password = it },
                Modifier.fillMaxWidth(),
                label = { Text("Password (optional)") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
            )
        }
        item {
            OutlinedTextField(
                tokens,
                { tokens = it },
                Modifier.fillMaxWidth(),
                label = { Text("Access tokens (comma separated)") },
            )
        }
        item {
            SectionLabel("Certificate identity")
            ChoiceRow(
                (listOf("default" to "Default") +
                    identities.filter { it.id != "default" }.map { it.id to it.name }),
                identity,
            ) {
                identity = it
            }
            Hint("Your identity is stored securely on this device.")
        }
        error?.let { item { Text(it, color = LocalPalette.current.danger) } }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton({ submit(onSave) }, Modifier.weight(1f)) { Text("Save") }
                Button({ submit(onConnect) }, Modifier.weight(1f)) { Text("Connect") }
            }
        }
        if (app.store.servers.value.any { it.id == server.id })
            item {
                TextButton({ deleting = true }) {
                    Text("Delete server", color = LocalPalette.current.danger)
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
