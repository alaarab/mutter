@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.alaarab.mutter.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import androidx.core.content.ContextCompat
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ScreenShare
import androidx.compose.material.icons.automirrored.rounded.StopScreenShare
import androidx.compose.material.icons.automirrored.rounded.VolumeOff
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.alaarab.mutter.MutterApplication
import com.alaarab.mutter.VoiceService
import com.alaarab.mutter.data.*

@Composable
fun VoiceControls(
    app: MutterApplication,
    state: SessionState,
    whisper: () -> Unit,
    settings: () -> Unit,
) {
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
    val screenCaptureConsent =
        rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            result ->
            val permission = result.data
            if (result.resultCode == android.app.Activity.RESULT_OK && permission != null)
                ContextCompat.startForegroundService(
                    context,
                    Intent(context, VoiceService::class.java)
                        .setAction(VoiceService.SHARE_SCREEN_ACTION)
                        .putExtra(VoiceService.SCREEN_PERMISSION_EXTRA, permission),
                )
        }
    val ownShare by app.sharer.sharing.collectAsStateWithLifecycle()
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { refreshMicrophone() }
    val level by app.audio.level.collectAsStateWithLifecycle()
    val talking by app.audio.transmitting.collectAsStateWithLifecycle()
    val paused by app.audio.pausedByAnotherApp.collectAsStateWithLifecycle()
    val preferences by app.store.settings.collectAsStateWithLifecycle()
    val motion = LocalCatalog.current
    val haptic = LocalHapticFeedback.current
    val muted = state.self?.let { it.selfMute || it.mute || it.suppress } == true
    var menu by remember { mutableStateOf(false) }
    var output by remember { mutableStateOf(false) }
    val label =
        when {
            !microphoneGranted -> "Enable microphone"
            talking -> "Talking"
            preferences.voiceMode == "ptt" -> "Hold to talk"
            preferences.voiceMode == "vad" -> "Listening for your voice"
            else -> "Always transmitting"
        }
    val background by
        animateColorAsState(
            if (talking) p.speaking else p.elevated,
            tween(motion.fast),
            label = "microphone state",
        )
    val compact =
        windowSizeDp().let { it.height < 500.dp && it.width >= 500.dp }
    val controls: @Composable (Modifier) -> Unit = { modifier ->
        Row(
            modifier,
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Column(
                Modifier.weight(1f).padding(end = 6.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Icon(Icons.Rounded.Tag, null, Modifier.size(13.dp), tint = p.accent)
                    Text(
                        state.channel?.name ?: "—",
                        style =
                            MaterialTheme.typography.bodyMedium.copy(
                                fontWeight = FontWeight.Medium
                            ),
                        maxLines = 1,
                        overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                    )
                }
                Text(
                    when {
                        paused -> "Paused by another app · Tap to resume"
                        state.self?.selfDeaf == true -> "Deafened"
                        muted -> "Muted"
                        talking -> "Transmitting"
                        preferences.voiceMode == "ptt" -> "Hold the button to talk"
                        else -> label
                    },
                    modifier =
                        if (paused)
                            Modifier.testTag("resumeAudio").clickable(
                                onClickLabel = "Resume audio"
                            ) {
                                app.audio.reclaimFocus()
                            }
                        else Modifier,
                    style = MaterialTheme.typography.labelSmall,
                    color =
                        when {
                            paused -> p.danger
                            talking -> p.speaking
                            else -> p.muted
                        },
                    maxLines = 1,
                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                )
            }
            RoundControl(
                if (state.self?.selfMute == true) Icons.Rounded.MicOff else Icons.Rounded.Mic,
                "Toggle mute",
                if (state.self?.selfMute == true) p.danger else p.ink,
                state.self?.selfMute == true,
            ) {
                val unmuting = state.self?.selfMute == true
                app.client.mute(!unmuting)
                if (unmuting) app.audio.reclaimFocus()
            }
            RoundControl(
                if (state.self?.selfDeaf == true) Icons.AutoMirrored.Rounded.VolumeOff
                else Icons.AutoMirrored.Rounded.VolumeUp,
                "Toggle deafen",
                if (state.self?.selfDeaf == true) p.danger else p.ink,
                state.self?.selfDeaf == true,
            ) {
                app.client.deafen(state.self?.selfDeaf != true)
            }
            Box {
                RoundControl(
                    if (preferences.speaker) Icons.Rounded.SpeakerPhone
                    else Icons.Rounded.Headphones,
                    "Audio output",
                ) {
                    output = true
                }
                DropdownMenu(output, { output = false }) {
                    listOf(false to "Automatic / headset", true to "Speaker").forEach {
                        (speaker, title) ->
                        DropdownMenuItem(
                            text = { Text(title) },
                            leadingIcon = {
                                if (speaker == preferences.speaker) Icon(Icons.Rounded.Check, null)
                            },
                            onClick = {
                                app.store.saveSettings(preferences.copy(speaker = speaker))
                                app.audio.route()
                                output = false
                            },
                        )
                    }
                }
            }
            Box {
                RoundControl(Icons.Rounded.MoreHoriz, "Call options") { menu = true }
                DropdownMenu(menu, { menu = false }) {
                    listOf(
                            "ptt" to "Push to talk",
                            "vad" to "Voice activity",
                            "continuous" to "Continuous",
                        )
                        .forEach { (mode, title) ->
                            DropdownMenuItem(
                                text = { Text(title) },
                                leadingIcon = {
                                    if (mode == preferences.voiceMode)
                                        Icon(Icons.Rounded.Check, null)
                                },
                                onClick = {
                                    app.audio.held = false
                                    app.store.saveSettings(preferences.copy(voiceMode = mode))
                                    menu = false
                                },
                            )
                        }
                    HorizontalDivider()
                    DropdownMenuItem(
                        text = { Text(if (ownShare == null) "Share screen" else "Stop sharing") },
                        leadingIcon = {
                            Icon(
                                if (ownShare == null) Icons.AutoMirrored.Rounded.ScreenShare
                                else Icons.AutoMirrored.Rounded.StopScreenShare,
                                null,
                            )
                        },
                        modifier = Modifier.testTag("shareScreen"),
                        onClick = {
                            menu = false
                            if (ownShare != null) app.sharer.stop()
                            else
                                screenCaptureConsent.launch(
                                    context
                                        .getSystemService(MediaProjectionManager::class.java)
                                        .createScreenCaptureIntent()
                                )
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Whisper or shout…") },
                        leadingIcon = { Icon(Icons.Rounded.RecordVoiceOver, null) },
                        onClick = {
                            menu = false
                            whisper()
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Settings") },
                        leadingIcon = { Icon(Icons.Rounded.Settings, null) },
                        onClick = {
                            menu = false
                            settings()
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Disconnect", color = p.danger) },
                        leadingIcon = { Icon(Icons.Rounded.CallEnd, null, tint = p.danger) },
                        onClick = {
                            menu = false
                            app.disconnect()
                        },
                    )
                }
            }
        }
    }
    val transmit: @Composable (Modifier) -> Unit = { modifier ->
        if (preferences.voiceMode == "ptt" || !microphoneGranted) {
            Box(
                modifier
                    .heightIn(min = 48.dp)
                    .clip(RoundedCornerShape(14.dp))
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
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                contentAlignment = Alignment.Center,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Icon(
                        if (talking) Icons.Rounded.GraphicEq else Icons.Rounded.TouchApp,
                        null,
                        Modifier.size(18.dp),
                        tint = if (talking) p["onStatus"] else p.ink,
                    )
                    Text(
                        label,
                        color = if (talking) p["onStatus"] else p.ink,
                        style = MaterialTheme.typography.labelLarge,
                    )
                }
            }
        } else if (preferences.voiceMode == "vad") {
            LinearProgressIndicator(
                progress = { (level * 6).coerceIn(0f, 1f) },
                modifier = modifier.height(6.dp),
                color = if (talking) p.speaking else p.muted.copy(alpha = .6f),
                trackColor = p["separator"],
                drawStopIndicator = {},
            )
        }
    }
    if (compact) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            controls(Modifier.weight(1f))
            if (preferences.voiceMode == "ptt" || !microphoneGranted)
                transmit(Modifier.width(210.dp))
            else if (preferences.voiceMode == "vad") transmit(Modifier.width(80.dp))
        }
    } else {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            controls(Modifier.fillMaxWidth())
            transmit(Modifier.fillMaxWidth())
        }
    }
    DisposableEffect(Unit) {
        onDispose {
            app.audio.held = false
            app.audio.whisperHeld = false
        }
    }
}
