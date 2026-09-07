package com.alaarab.mutter.ui

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.alaarab.mutter.MutterApplication
import com.alaarab.mutter.data.*
import com.alaarab.mutter.protocol.Proto

@Composable
fun ChannelSheet(
    app: MutterApplication,
    state: SessionState,
    channel: Channel,
    dismiss: () -> Unit,
) {
    var name by rememberSaveable(channel.id) { mutableStateOf(channel.name) }
    var childName by rememberSaveable(channel.id) { mutableStateOf("") }
    var temporary by rememberSaveable { mutableStateOf(true) }
    var deleting by remember { mutableStateOf(false) }
    LazyColumn(
        Modifier.fillMaxWidth().imePadding(),
        contentPadding = PaddingValues(start = 24.dp, end = 24.dp, bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            IconWell(Icons.Rounded.Tag, size = 48)
            Spacer(Modifier.height(12.dp))
            Heading(channel.name, "${state.users.values.count { it.channel == channel.id }} people")
        }
        if (channel.description.isNotBlank())
            item { AppCard(Modifier.fillMaxWidth()) { RichMessage(channel.description) } }
        item {
            Button(
                {
                    app.client.join(channel.id)
                    dismiss()
                },
                Modifier.fillMaxWidth(),
            ) {
                Text(if (state.self?.channel == channel.id) "You’re here" else "Join channel")
            }
        }
        item {
            AppCard(Modifier.fillMaxWidth()) {
                ToggleRow(
                    "Listen without joining",
                    channel.id in state.self?.listening.orEmpty(),
                    { app.client.listen(channel.id, it) },
                    "Hear this channel alongside your current conversation.",
                )
            }
        }
        if (state.can(1, channel.id))
            item {
                SectionLabel("Edit channel")
                OutlinedTextField(
                    name,
                    { name = it },
                    Modifier.fillMaxWidth(),
                    label = { Text("Channel name") },
                )
                TextButton(
                    {
                        app.client.action(7, Proto().number(1, channel.id).text(3, name.trim()))
                        dismiss()
                    },
                    enabled = name.isNotBlank(),
                ) {
                    Text("Save name")
                }
            }
        if (state.can(0x40, channel.id) || state.can(0x400, channel.id))
            item {
                SectionLabel("Create a subchannel")
                OutlinedTextField(
                    childName,
                    { childName = it },
                    Modifier.fillMaxWidth(),
                    label = { Text("New channel name") },
                )
                ToggleRow("Temporary channel", temporary, { temporary = it })
                Button(
                    {
                        app.client.action(
                            7,
                            Proto()
                                .number(2, channel.id)
                                .text(3, childName.trim())
                                .bool(8, temporary),
                        )
                        childName = ""
                    },
                    enabled =
                        childName.isNotBlank() &&
                            state.can(if (temporary) 0x400 else 0x40, channel.id),
                ) {
                    Text("Create channel")
                }
            }
        if (channel.id != 0 && state.can(1, channel.id))
            item {
                TextButton({ deleting = true }) {
                    Text("Delete channel", color = LocalPalette.current.danger)
                }
            }
    }
    if (deleting)
        AlertDialog(
            onDismissRequest = { deleting = false },
            title = { Text("Delete ${channel.name}?") },
            text = { Text("People in this channel will be moved by the server.") },
            confirmButton = {
                TextButton({
                    app.client.action(6, Proto().number(1, channel.id))
                    dismiss()
                }) {
                    Text("Delete")
                }
            },
            dismissButton = { TextButton({ deleting = false }) { Text("Cancel") } },
        )
}
