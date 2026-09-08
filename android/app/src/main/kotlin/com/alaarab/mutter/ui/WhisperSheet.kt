package com.alaarab.mutter.ui

import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import com.alaarab.mutter.MutterApplication
import com.alaarab.mutter.data.*

@Composable
fun WhisperSheet(app: MutterApplication, state: SessionState, dismiss: () -> Unit) {
    val now = sessionTime()
    var held by remember { mutableStateOf(false) }
    var selected by rememberSaveable { mutableStateOf(emptyList<Int>()) }
    var channel by rememberSaveable { mutableStateOf<Int?>(null) }
    var children by rememberSaveable { mutableStateOf(false) }
    var targetMode by rememberSaveable { mutableStateOf("people") }
    LaunchedEffect(selected, channel, children, targetMode) {
        held = false
        app.audio.whisperHeld = false
        app.client.whisper(
            if (targetMode == "people") selected.toSet() else emptySet(),
            if (targetMode == "channel") channel else null,
            children,
        )
    }
    DisposableEffect(Unit) { onDispose { app.audio.whisperHeld = false } }
    LazyColumn(
        Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            Hint("Choose who hears you.")
        }
        item {
            ChoiceRow(listOf("people" to "People", "channel" to "Channel"), targetMode) {
                targetMode = it
            }
        }
        if (targetMode == "people")
            items(state.users.values.filter { it.session != state.me }.sortedBy { it.name }) { user
                ->
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    UserAvatar(user, now)
                    ToggleRow(
                        user.name,
                        user.session in selected,
                        { selected = if (it) selected + user.session else selected - user.session },
                    )
                }
            }
        else {
            items(state.channels.values.sortedBy { it.name }) { item ->
                Row(
                    Modifier.fillMaxWidth().clickable { channel = item.id },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(channel == item.id, { channel = item.id })
                    Text(item.name)
                }
            }
            item { ToggleRow("Include subchannels", children, { children = it }) }
        }
        item {
            val enabled = if (targetMode == "people") selected.isNotEmpty() else channel != null
            Box(
                Modifier.fillMaxWidth()
                    .height(64.dp)
                    .background(
                        if (enabled) LocalPalette.current.whisper
                        else LocalPalette.current.elevated,
                        MaterialTheme.shapes.medium,
                    )
                    .semantics {
                        role = Role.Button
                        contentDescription = "Hold to whisper"
                        stateDescription =
                            if (held) "Whispering" else if (enabled) "Ready" else "Choose a target"
                        if (!enabled) disabled()
                        onClick("Toggle whispering") {
                            if (enabled) {
                                held = !held
                                app.audio.whisperHeld = held
                            }
                            enabled
                        }
                    }
                    .pointerInput(enabled) {
                        if (enabled)
                            detectTapGestures(
                                onPress = {
                                    held = true
                                    app.audio.whisperHeld = true
                                    try {
                                        tryAwaitRelease()
                                    } finally {
                                        held = false
                                        app.audio.whisperHeld = false
                                    }
                                }
                            )
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    if (held) "Whispering" else "Hold to whisper",
                    color =
                        if (enabled) LocalPalette.current["onStatus"]
                        else LocalPalette.current.muted,
                    style = MaterialTheme.typography.labelLarge,
                )
            }
        }
    }
}
