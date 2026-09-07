package com.alaarab.mutter.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.alaarab.mutter.MutterApplication
import com.alaarab.mutter.data.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

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
                    Modifier.width(104.dp),
                    label = { Text("Port") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                )
            }
        }
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

@Composable
fun SettingsScreen(app: MutterApplication, settings: Settings, identities: () -> Unit) {
    val catalog = LocalCatalog.current
    val dark =
        when (settings.appearance) {
            "dark" -> true
            "light" -> false
            else -> isSystemInDarkTheme()
        }
    val clipboard = LocalClipboardManager.current
    fun save(value: Settings) {
        app.store.saveSettings(value)
    }
    LazyColumn(
        Modifier.fillMaxWidth().imePadding(),
        contentPadding = PaddingValues(start = 24.dp, end = 24.dp, bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item { Heading("Make it yours", "Voice, appearance, and the little things.") }
        item {
            SectionLabel("Appearance")
            ChoiceRow(
                listOf("system" to "System", "light" to "Light", "dark" to "Dark"),
                settings.appearance,
            ) {
                save(settings.copy(appearance = it))
            }
        }
        items((catalog.themes.size + 1) / 2) { index ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                catalog.themes.drop(index * 2).take(2).forEach { option ->
                    val p = if (dark) option.dark else option.light
                    Column(
                        Modifier.weight(1f)
                            .border(
                                if (settings.theme == option.id) 2.dp else 1.dp,
                                if (settings.theme == option.id) p.accent
                                else p.muted.copy(alpha = .3f),
                                RoundedCornerShape(16.dp),
                            )
                            .background(p.background, RoundedCornerShape(16.dp))
                            .clickable { save(settings.copy(theme = option.id)) }
                            .padding(14.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                            listOf(p.accent, p.surface, p.elevated, p.whisper).forEach { color ->
                                Box(
                                    Modifier.size(16.dp).background(color, RoundedCornerShape(5.dp))
                                )
                            }
                        }
                        Text(
                            option.title,
                            color = p.ink,
                            style = MaterialTheme.typography.titleMedium,
                        )
                        Text(
                            if (settings.theme == option.id) "Selected" else option.description,
                            color = p.muted,
                            style = MaterialTheme.typography.bodySmall,
                            maxLines = 2,
                        )
                    }
                }
                if (index * 2 + 1 == catalog.themes.size) Spacer(Modifier.weight(1f))
            }
        }
        item {
            SectionLabel("Voice mode")
            ChoiceRow(
                listOf(
                    "ptt" to "Push to talk",
                    "vad" to "Voice activity",
                    "continuous" to "Open mic",
                ),
                settings.voiceMode,
            ) {
                save(settings.copy(voiceMode = it))
            }
        }
        if (settings.voiceMode == "vad")
            item {
                Text("Voice activation threshold")
                Slider(
                    settings.threshold,
                    { save(settings.copy(threshold = it)) },
                    valueRange = 0.005f..0.15f,
                )
                Hint("Raise this if background sound opens the microphone.")
            }
        item {
            SectionLabel("Audio quality")
            ChoiceRow(
                listOf(16000, 24000, 40000, 64000, 96000).map { it.toString() to "${it / 1000}k" },
                settings.bitrate.toString(),
            ) {
                save(settings.copy(bitrate = it.toInt()))
            }
        }
        item {
            ToggleRow(
                "Speakerphone",
                settings.speaker,
                {
                    save(settings.copy(speaker = it))
                    app.audio.route()
                },
                "Headsets take priority when speakerphone is off.",
            )
        }
        item {
            ToggleRow(
                "Echo cancellation",
                settings.echoCancellation,
                {
                    save(settings.copy(echoCancellation = it))
                    if (app.client.state.value.connected) app.audio.restart()
                },
            )
        }
        item {
            ToggleRow(
                "Noise suppression",
                settings.noiseSuppression,
                {
                    save(settings.copy(noiseSuppression = it))
                    if (app.client.state.value.connected) app.audio.restart()
                },
            )
        }
        item {
            ToggleRow(
                "Automatic gain",
                settings.autoGain,
                {
                    save(settings.copy(autoGain = it))
                    if (app.client.state.value.connected) app.audio.restart()
                },
            )
        }
        item {
            SectionLabel("Comfort")
            ToggleRow(
                "Hide empty channels",
                settings.hideEmpty,
                { save(settings.copy(hideEmpty = it)) },
            )
            ToggleRow(
                "Keep screen awake in a call",
                settings.keepAwake,
                { save(settings.copy(keepAwake = it)) },
            )
        }
        item {
            SectionLabel("Identity")
            OutlinedButton(identities, Modifier.fillMaxWidth()) {
                Icon(Icons.Rounded.Fingerprint, null)
                Spacer(Modifier.width(8.dp))
                Text("Manage certificates")
            }
        }
        item {
            SectionLabel("Screen viewer")
            OutlinedTextField(
                settings.stun,
                { save(settings.copy(stun = it)) },
                Modifier.fillMaxWidth(),
                label = { Text("STUN server") },
                singleLine = true,
            )
        }
        item {
            OutlinedTextField(
                settings.turn,
                { save(settings.copy(turn = it)) },
                Modifier.fillMaxWidth(),
                label = { Text("TURN server (optional)") },
                singleLine = true,
            )
        }
        item {
            OutlinedTextField(
                settings.turnUser,
                { save(settings.copy(turnUser = it)) },
                Modifier.fillMaxWidth(),
                label = { Text("TURN username") },
                singleLine = true,
            )
        }
        item {
            OutlinedTextField(
                settings.turnPassword,
                { save(settings.copy(turnPassword = it)) },
                Modifier.fillMaxWidth(),
                label = { Text("TURN password") },
                visualTransformation = PasswordVisualTransformation(),
                singleLine = true,
            )
        }
        item {
            SectionLabel("Diagnostics")
            OutlinedButton({
                clipboard.setText(AnnotatedString(app.client.state.value.log.joinToString("\n")))
            }) {
                Text("Copy connection log")
            }
            Hint("Mutter for Android · 0.1.0")
        }
    }
}

@Composable
fun CertificateDialog(prompt: CertificatePrompt, answer: (Boolean) -> Unit) {
    AlertDialog(
        onDismissRequest = { answer(false) },
        icon = {
            Icon(
                Icons.Rounded.Security,
                null,
                tint =
                    if (prompt.previous.isNotEmpty()) LocalPalette.current.danger
                    else LocalPalette.current.accent,
            )
        },
        title = {
            Text(
                if (prompt.previous.isEmpty()) "Trust this server?"
                else "Server certificate changed"
            )
        },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(
                    if (prompt.previous.isEmpty())
                        "Confirm this fingerprint with your server administrator before connecting."
                    else
                        "This is a different certificate from the one you trusted. Confirm the change with your server administrator."
                )
                Hint(prompt.subject)
                Text(prompt.fingerprint, style = MaterialTheme.typography.bodySmall)
                Hint("Valid until ${prompt.validUntil}")
                if (prompt.previous.isNotEmpty()) {
                    Hint("Previously trusted")
                    Text(prompt.previous, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = { TextButton({ answer(true) }) { Text("Trust and connect") } },
        dismissButton = { TextButton({ answer(false) }) { Text("Cancel") } },
    )
}

@Composable
fun IdentitiesScreen(app: MutterApplication) {
    val identities by app.store.identities.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var name by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val picker =
        rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri != null)
                scope.launch {
                    busy = true
                    try {
                        withContext(Dispatchers.IO) {
                            val bytes =
                                context.contentResolver.openInputStream(uri)?.use {
                                    it.readBounded(2 * 1024 * 1024)
                                } ?: error("Cannot read certificate")
                            app.identities.import(
                                bytes,
                                password.toCharArray(),
                                name.ifBlank { "Imported identity" },
                            )
                        }
                        password = ""
                    } catch (failure: Exception) {
                        error = failure.message ?: "Cannot import this certificate"
                    } finally {
                        busy = false
                    }
                }
        }
    LazyColumn(
        Modifier.fillMaxWidth().imePadding(),
        contentPadding = PaddingValues(start = 24.dp, end = 24.dp, bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item { Heading("Your identity", "Certificates make you recognizable to servers.") }
        items(identities.size) { index ->
            val identity = identities[index]
            AppCard(Modifier.fillMaxWidth()) {
                Text(identity.name, style = MaterialTheme.typography.titleMedium)
                Hint(identity.fingerprint)
                if (identity.id != "default")
                    TextButton({
                        runCatching { app.store.deleteIdentity(identity.id) }
                            .onFailure { error = it.message }
                    }) {
                        Text("Remove identity")
                    }
            }
        }
        item {
            OutlinedTextField(
                name,
                { name = it },
                Modifier.fillMaxWidth(),
                label = { Text("Identity name") },
                singleLine = true,
            )
        }
        item {
            Button(
                {
                    scope.launch {
                        busy = true
                        try {
                            withContext(Dispatchers.IO) {
                                app.identities.create(name.ifBlank { "Mutter" })
                            }
                        } catch (failure: Exception) {
                            error = failure.message
                        } finally {
                            busy = false
                        }
                    }
                },
                enabled = !busy,
            ) {
                Text("Create certificate")
            }
        }
        item {
            SectionLabel("Import .p12")
            OutlinedTextField(
                password,
                { password = it },
                Modifier.fillMaxWidth(),
                label = { Text("Certificate password") },
                visualTransformation = PasswordVisualTransformation(),
            )
            OutlinedButton(
                { picker.launch(arrayOf("application/x-pkcs12", "application/octet-stream")) },
                enabled = !busy,
            ) {
                Text("Choose certificate file")
            }
        }
        error?.let { item { Text(it, color = LocalPalette.current.danger) } }
        if (busy) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
    }
}
