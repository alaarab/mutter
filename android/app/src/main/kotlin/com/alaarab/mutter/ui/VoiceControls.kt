@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.alaarab.mutter.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.alaarab.mutter.MutterApplication
import com.alaarab.mutter.VoiceService
import com.alaarab.mutter.data.*

@Composable
fun VoiceControls(app: MutterApplication, state: SessionState, whisper: () -> Unit) {
    val p = LocalPalette.current
    val context = LocalContext.current
    var microphoneGranted by remember {
        mutableStateOf(
            context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
        )
    }
    fun refreshMicrophone() {
        val granted =
            context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
        if (granted && !microphoneGranted && state.connected)
            context.startService(Intent(context, VoiceService::class.java).setAction("microphone"))
        microphoneGranted = granted
    }
    val microphone =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
            refreshMicrophone()
        }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { refreshMicrophone() }
    val level by app.audio.level.collectAsStateWithLifecycle()
    val talking by app.audio.transmitting.collectAsStateWithLifecycle()
    val settings by app.store.settings.collectAsStateWithLifecycle()
    val motion = LocalCatalog.current
    val haptic = LocalHapticFeedback.current
    val muted = state.self?.let { it.selfMute || it.mute || it.suppress } == true
    val label =
        when {
            !microphoneGranted -> "Microphone off"
            talking -> "Talking"
            muted -> "Muted"
            settings.voiceMode == "ptt" -> "Hold to talk"
            settings.voiceMode == "vad" -> "Voice activity"
            else -> "Open mic"
        }
    val background by
        animateColorAsState(
            if (talking) p.speaking else if (muted || !microphoneGranted) p.elevated else p.accent,
            tween(motion.fast),
            label = "microphone state",
        )
    val foreground =
        if (talking) p["onStatus"] else if (muted || !microphoneGranted) p.ink else p["onAccent"]
    val talk: @Composable (Modifier) -> Unit = { modifier ->
        Box(
            modifier
                .heightIn(min = 52.dp)
                .clip(MaterialTheme.shapes.medium)
                .background(background)
                .semantics {
                    contentDescription =
                        if (microphoneGranted) "Push to talk" else "Enable microphone"
                    stateDescription = label
                    role = Role.Button
                    onClick("Toggle talking") {
                        if (microphoneGranted) app.audio.held = !app.audio.held
                        else microphone.launch(Manifest.permission.RECORD_AUDIO)
                        true
                    }
                }
                .testTag("talkButton")
                .pointerInput(microphoneGranted) {
                    detectTapGestures(
                        onPress = {
                            if (!microphoneGranted) {
                                microphone.launch(Manifest.permission.RECORD_AUDIO)
                                return@detectTapGestures
                            }
                            haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                            app.audio.held = true
                            try {
                                tryAwaitRelease()
                            } finally {
                                app.audio.held = false
                            }
                        }
                    )
                }
                .padding(horizontal = 12.dp, vertical = 10.dp),
            contentAlignment = Alignment.Center,
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Icon(
                    if (talking) Icons.Rounded.GraphicEq
                    else if (muted || !microphoneGranted) Icons.Rounded.MicOff
                    else Icons.Rounded.Mic,
                    null,
                    tint = foreground,
                    modifier = Modifier.size(20.dp),
                )
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(label, color = foreground, style = MaterialTheme.typography.labelLarge)
                    LinearProgressIndicator(
                        progress = { (level * 6).coerceIn(0f, 1f) },
                        modifier = Modifier.width(76.dp).height(2.dp),
                        color = foreground,
                        trackColor = Color.Transparent,
                        drawStopIndicator = {},
                    )
                }
            }
        }
    }
    val controls: @Composable RowScope.() -> Unit = {
        VoiceToggle(
            if (state.self?.selfMute == true) Icons.Rounded.MicOff else Icons.Rounded.Mic,
            "Toggle mute",
            state.self?.selfMute == true,
        ) {
            app.client.mute(state.self?.selfMute != true)
        }
        VoiceToggle(
            if (state.self?.selfDeaf == true) Icons.Rounded.HeadsetOff
            else Icons.Rounded.Headphones,
            "Toggle deafen",
            state.self?.selfDeaf == true,
        ) {
            app.client.deafen(state.self?.selfDeaf != true)
        }
        ActionIcon(Icons.Rounded.RecordVoiceOver, "Whisper targets", p.whisper, whisper)
        ActionIcon(Icons.Rounded.CallEnd, "Disconnect", p.danger, app::disconnect)
    }
    Column(Modifier.fillMaxWidth()) {
        SectionDivider()
        BoxWithConstraints(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
            if (maxWidth >= 480.dp) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    talk(Modifier.weight(1f))
                    controls()
                }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    talk(Modifier.fillMaxWidth())
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceEvenly,
                        verticalAlignment = Alignment.CenterVertically,
                        content = controls,
                    )
                }
            }
        }
    }
    DisposableEffect(Unit) {
        onDispose {
            app.audio.held = false
            app.audio.whisperHeld = false
        }
    }
}

@Composable
private fun VoiceToggle(
    icon: ImageVector,
    label: String,
    checked: Boolean,
    action: () -> Unit,
) {
    val p = LocalPalette.current
    IconToggleButton(
        checked,
        { action() },
        colors =
            IconButtonDefaults.iconToggleButtonColors(
                containerColor = p.elevated,
                contentColor = p.body,
                checkedContainerColor = p.danger.copy(alpha = .12f),
                checkedContentColor = p.danger,
            ),
    ) {
        Icon(icon, label, Modifier.size(22.dp))
    }
}
