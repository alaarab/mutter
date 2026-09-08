package com.alaarab.mutter.ui

import android.content.ClipData
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.activity.findViewTreeOnBackPressedDispatcherOwner
import androidx.compose.animation.*
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CornerSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.alaarab.mutter.MutterApplication
import com.alaarab.mutter.data.Settings
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(app: MutterApplication, settings: Settings, dismiss: () -> Unit) {
    var page by rememberSaveable { mutableStateOf("main") }
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    fun navigate(destination: String) {
        focus.clearFocus()
        keyboard?.hide()
        page = destination
    }
    val columns =
        ((LocalConfiguration.current.screenWidthDp - 64) / (100 * LocalDensity.current.fontScale))
            .toInt()
            .coerceIn(1, 3)
    val themeRows = LocalCatalog.current.themes.chunked(columns)
    val palette = LocalPalette.current
    val pages = rememberSaveableStateHolder()
    val motion = LocalCatalog.current
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var copied by remember { mutableStateOf(false) }
    fun save(value: Settings) {
        app.store.saveSettings(value)
    }
    val backOwner = LocalView.current.findViewTreeOnBackPressedDispatcherOwner()
    if (backOwner != null)
        CompositionLocalProvider(LocalOnBackPressedDispatcherOwner provides backOwner) {
            BackHandler(page != "main") { navigate("main") }
        }
    AnimatedContent(
        page,
        transitionSpec = {
            (fadeIn(tween(motion.panel)) +
                slideInHorizontally(tween(motion.panel, easing = motion.easing)) {
                    if (targetState == "main") -it / 12 else it / 12
                }) togetherWith fadeOut(tween(motion.fast))
        },
        label = "settings page",
    ) { current ->
        pages.SaveableStateProvider(current) {
            Column(Modifier.fillMaxWidth()) {
                SheetHeader(
                    when (current) {
                        "voice" -> "Voice & audio"
                        "identities" -> "Certificates"
                        "viewer" -> "Screen share"
                        else -> "Settings"
                    },
                    back = if (current != "main") ({ navigate("main") }) else null,
                    dismiss = dismiss,
                )
                if (current == "identities") IdentitiesScreen(app)
                else
                    LazyColumn(
                        Modifier.fillMaxWidth().imePadding(),
                        contentPadding =
                            PaddingValues(start = 16.dp, end = 16.dp, top = 24.dp, bottom = 32.dp),
                        verticalArrangement = Arrangement.spacedBy(0.dp),
                    ) {
                        when (current) {
                            "main" -> {

                                item {
                                    AppCard(Modifier.fillMaxWidth()) {
                                        SettingsLink(
                                            Icons.Rounded.GraphicEq,
                                            "Voice & audio",
                                            "${voiceModeLabel(settings.voiceMode)} · ${settings.bitrate / 1000}\u00a0kbit/s",
                                        ) {
                                            navigate("voice")
                                        }
                                        SectionDivider()
                                        SettingsLink(
                                            Icons.Rounded.Fingerprint,
                                            "Certificates",
                                            "Your identity on every server",
                                        ) {
                                            navigate("identities")
                                        }
                                    }
                                }
                                item { SectionLabel("Identity") }
                                item {
                                    AppCard(Modifier.fillMaxWidth()) {
                                        FormField(
                                            settings.defaultUsername,
                                            { save(settings.copy(defaultUsername = it)) },
                                            "Default username",
                                        )
                                    }
                                    Hint("Used for quick connect and new servers.")
                                }
                                item { SectionLabel("Appearance") }
                                item {
                                    Column(
                                        Modifier.fillMaxWidth()
                                            .background(
                                                palette.surface,
                                                MaterialTheme.shapes.extraLarge.copy(
                                                    bottomStart = CornerSize(0.dp),
                                                    bottomEnd = CornerSize(0.dp),
                                                ),
                                            )
                                            .padding(horizontal = 16.dp, vertical = 12.dp)
                                    ) {
                                        ChoiceRow(
                                            listOf(
                                                "system" to "Match system",
                                                "light" to "Light",
                                                "dark" to "Dark",
                                            ),
                                            settings.appearance,
                                        ) {
                                            save(settings.copy(appearance = it))
                                        }
                                        Spacer(Modifier.height(12.dp))
                                        SectionDivider()
                                    }
                                }
                                items(themeRows.size) { index ->
                                    ThemeRow(themeRows[index], columns, settings) {
                                        save(settings.copy(theme = it))
                                    }
                                }
                                item {
                                    Column(
                                        Modifier.fillMaxWidth()
                                            .background(
                                                palette.surface,
                                                MaterialTheme.shapes.extraLarge.copy(
                                                    topStart = CornerSize(0.dp),
                                                    topEnd = CornerSize(0.dp),
                                                ),
                                            )
                                            .padding(16.dp)
                                    ) {
                                        Hint(
                                            LocalCatalog.current.themes
                                                .firstOrNull { it.id == settings.theme }
                                                ?.description
                                                .orEmpty()
                                        )
                                    }
                                    Hint("Themes recolor the whole app.")
                                }
                                item { SectionLabel("Behaviour") }
                                item {
                                    AppCard(Modifier.fillMaxWidth()) {
                                        ToggleRow(
                                            "Hide empty channels",
                                            settings.hideEmpty,
                                            { save(settings.copy(hideEmpty = it)) },
                                        )
                                        SectionDivider()
                                        ToggleRow(
                                            "Keep screen awake while connected",
                                            settings.keepAwake,
                                            { save(settings.copy(keepAwake = it)) },
                                        )
                                    }
                                }
                                item { SectionLabel("Screen share") }
                                item {
                                    AppCard(Modifier.fillMaxWidth()) {
                                        FormField(
                                            settings.turn,
                                            { save(settings.copy(turn = it)) },
                                            "TURN server",
                                            keyboardType = KeyboardType.Uri,
                                        )
                                        SectionDivider()
                                        FormField(
                                            settings.turnUser,
                                            { save(settings.copy(turnUser = it)) },
                                            "TURN username",
                                        )
                                        SectionDivider()
                                        FormField(
                                            settings.turnPassword,
                                            { save(settings.copy(turnPassword = it)) },
                                            "TURN password",
                                            secret = true,
                                        )
                                    }
                                    Hint(
                                        "Only needed if watching a share fails on a strict network."
                                    )
                                }
                                item {
                                    AppCard(Modifier.fillMaxWidth()) {
                                        SettingsLink(
                                            Icons.Rounded.DesktopWindows,
                                            "Screen viewer",
                                            "Advanced connection settings",
                                        ) {
                                            navigate("viewer")
                                        }
                                    }
                                }
                                item {
                                    TextButton({
                                        scope.launch {
                                            clipboard.setClipEntry(
                                                ClipEntry(
                                                    ClipData.newPlainText(
                                                        "Mutter connection log",
                                                        app.client.state.value.log.joinToString(
                                                            "\n"
                                                        ),
                                                    )
                                                )
                                            )
                                            copied = true
                                        }
                                    }) {
                                        Icon(
                                            if (copied) Icons.Rounded.Check
                                            else Icons.Rounded.ContentCopy,
                                            null,
                                            Modifier.size(16.dp),
                                        )
                                        Spacer(Modifier.width(8.dp))
                                        Text(
                                            if (copied) "Connection log copied"
                                            else "Copy connection log"
                                        )
                                    }
                                    Hint("Mutter · Android · 0.1.0")
                                }
                            }
                            "voice" -> {

                                item { SectionLabel("How you talk") }
                                item {
                                    AppCard(Modifier.fillMaxWidth()) {
                                        listOf("ptt", "vad", "continuous").forEachIndexed {
                                            index,
                                            mode ->
                                            if (index > 0) SectionDivider()
                                            VoiceModeRow(mode, settings.voiceMode == mode) {
                                                save(settings.copy(voiceMode = mode))
                                            }
                                        }
                                    }
                                }
                                if (settings.voiceMode == "vad")
                                    item {
                                        AppCard(Modifier.fillMaxWidth()) {
                                            Text(
                                                "Voice activation threshold",
                                                style = MaterialTheme.typography.titleSmall,
                                            )
                                            AppSlider(
                                                settings.threshold,
                                                { save(settings.copy(threshold = it)) },
                                                valueRange = 0.005f..0.15f,
                                            )
                                            Hint(
                                                "Raise this if background sound opens the microphone."
                                            )
                                        }
                                    }
                                item { SectionLabel("Noise & echo") }
                                item {
                                    AppCard(Modifier.fillMaxWidth()) {
                                        ToggleRow(
                                            "Echo cancellation",
                                            settings.echoCancellation,
                                            {
                                                save(settings.copy(echoCancellation = it))
                                                if (app.client.state.value.connected)
                                                    app.audio.restart()
                                            },
                                        )
                                        SectionDivider()
                                        ToggleRow(
                                            "Noise suppression",
                                            settings.noiseSuppression,
                                            {
                                                save(settings.copy(noiseSuppression = it))
                                                if (app.client.state.value.connected)
                                                    app.audio.restart()
                                            },
                                        )
                                        SectionDivider()
                                        ToggleRow(
                                            "Automatic gain",
                                            settings.autoGain,
                                            {
                                                save(settings.copy(autoGain = it))
                                                if (app.client.state.value.connected)
                                                    app.audio.restart()
                                            },
                                        )
                                    }
                                }
                                item { SectionLabel("Quality") }
                                item {
                                    ChoiceRow(
                                        listOf(16000, 24000, 40000, 64000, 96000).map {
                                            it.toString() to "${it / 1000}k"
                                        },
                                        settings.bitrate.toString(),
                                    ) {
                                        save(settings.copy(bitrate = it.toInt()))
                                    }
                                    Hint("Higher quality uses more bandwidth.")
                                }
                                item { SectionLabel("Output") }
                                item {
                                    AppCard(Modifier.fillMaxWidth()) {
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
                                }
                            }
                            "viewer" -> {
                                item {
                                    AppCard(Modifier.fillMaxWidth()) {
                                        IconWell(Icons.Rounded.DesktopWindows)
                                        Text(
                                            "A better connection",
                                            style = MaterialTheme.typography.titleMedium,
                                        )
                                        Hint(
                                            "The default STUN server works on most networks. Add a TURN relay if your network needs one."
                                        )
                                    }
                                }
                                item { SectionLabel("Connection") }
                                item {
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
                            }
                        }
                    }
            }
        }
    }
}

private fun voiceModeLabel(mode: String) =
    when (mode) {
        "vad" -> "Voice activity"
        "continuous" -> "Continuous"
        else -> "Push to talk"
    }

@Composable
private fun VoiceModeRow(mode: String, selected: Boolean, choose: () -> Unit) {
    Row(
        Modifier.fillMaxWidth()
            .selectable(
                selected,
                role = Role.RadioButton,
                onClick = choose,
            )
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        IconWell(
            when (mode) {
                "vad" -> Icons.Rounded.GraphicEq
                "continuous" -> Icons.Rounded.Mic
                else -> Icons.Rounded.TouchApp
            }
        )
        Column(Modifier.weight(1f)) {
            Text(voiceModeLabel(mode), style = MaterialTheme.typography.bodyLarge)
            Hint(
                when (mode) {
                    "vad" -> "Talk naturally; your voice opens the mic."
                    "continuous" -> "Keep your microphone open."
                    else -> "Hold the talk button when you’re ready."
                }
            )
        }
        RadioButton(selected, null)
    }
}
