package com.alaarab.mutter.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.alaarab.mutter.MutterApplication
import com.alaarab.mutter.data.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

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
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item { Hint("Certificates make you recognizable to servers.") }
        items(identities.size) { index ->
            val identity = identities[index]
            AppCard(Modifier.fillMaxWidth()) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    IconWell(Icons.Rounded.Fingerprint)
                    Column(Modifier.weight(1f)) {
                        Text(identity.name, style = MaterialTheme.typography.titleMedium)
                        Hint(
                            if (identity.id == "default") "Default identity"
                            else "Personal identity"
                        )
                    }
                }
                SectionDivider()
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
        item { SectionLabel("Create an identity") }
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
