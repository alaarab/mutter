package com.alaarab.mutter.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.alaarab.mutter.data.User
import kotlinx.coroutines.delay

@Composable
fun AppCard(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    highlighted: Boolean = false,
    content: @Composable ColumnScope.() -> Unit,
) {
    val p = LocalPalette.current
    val motion = LocalCatalog.current
    val border by
        animateColorAsState(
            if (highlighted) p.accent.copy(alpha = .45f) else p["separator"].copy(alpha = .65f),
            tween(motion.standard, easing = motion.easing),
            label = "card border",
        )
    Column(
        modifier
            .clip(MaterialTheme.shapes.large)
            .background(Brush.linearGradient(listOf(p["surfaceHighlight"], p.surface)))
            .border(1.dp, border, MaterialTheme.shapes.large)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        content = content,
    )
}

@Composable
fun Heading(
    title: String,
    subtitle: String? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Text(
                title,
                style = MaterialTheme.typography.headlineLarge,
                modifier = Modifier.semantics { heading() },
            )
            if (subtitle != null)
                Text(
                    subtitle,
                    color = LocalPalette.current.muted,
                    style = MaterialTheme.typography.bodyMedium,
                )
        }
        actions()
    }
}

@Composable
fun ActionIcon(
    icon: ImageVector,
    description: String,
    tint: Color = LocalPalette.current.body,
    action: () -> Unit,
) {
    IconButton(onClick = action) {
        Icon(icon, description, tint = tint, modifier = Modifier.size(22.dp))
    }
}

@Composable
fun IconWell(icon: ImageVector, tint: Color = LocalPalette.current.accent, size: Int = 40) {
    Box(
        Modifier.size(size.dp).background(tint.copy(alpha = .1f), MaterialTheme.shapes.small),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, tint = tint, modifier = Modifier.size((size * .5f).dp))
    }
}

@Composable
fun SettingsLink(icon: ImageVector, title: String, subtitle: String, action: () -> Unit) {
    val p = LocalPalette.current
    Row(
        Modifier.fillMaxWidth()
            .clip(MaterialTheme.shapes.medium)
            .clickable(onClick = action)
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        IconWell(icon)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            Hint(subtitle)
        }
        Icon(Icons.Rounded.ChevronRight, null, tint = p.muted, modifier = Modifier.size(18.dp))
    }
}

@Composable
fun SectionDivider() {
    HorizontalDivider(color = LocalPalette.current["separator"].copy(alpha = .6f))
}

@Composable
fun Avatar(name: String, talking: Boolean = false, size: Int = 42) {
    val p = LocalPalette.current
    val motion = LocalCatalog.current
    val index =
        remember(name) {
            name
                .toByteArray(Charsets.UTF_8)
                .fold(5381u) { hash, byte -> hash * 33u + byte.toUByte().toUInt() }
                .rem(6u)
        }
    val initials =
        remember(name) {
            val words = name.trim().split(Regex("\\s+")).filter { it.isNotBlank() }
            if (words.size > 1) "${words.first().first()}${words.last().first()}".uppercase()
            else words.firstOrNull()?.take(2)?.uppercase().orEmpty()
        }
    val ring by
        animateColorAsState(
            if (talking) p.speaking else Color.Transparent,
            tween(motion.standard),
            label = "speaking ring",
        )
    Box(
        Modifier.size(size.dp)
            .clip(MaterialTheme.shapes.medium)
            .background(p["avatar$index"])
            .border(2.dp, ring, MaterialTheme.shapes.medium),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            initials,
            color = p["onAvatar"],
            fontWeight = FontWeight.Bold,
            fontSize = (size * .31).sp,
        )
    }
}

fun User.withLocalSpeech(me: Int?, transmitting: Boolean) =
    if (session == me && transmitting) copy(talkingUntil = Long.MAX_VALUE) else this

fun peopleLabel(count: Int) = if (count == 1) "1 person" else "$count people"

fun userStatus(user: User, now: Long): String =
    when {
        user.deaf || user.selfDeaf -> "Deafened"
        user.localMute -> "Muted for you"
        user.mute -> "Server muted"
        user.suppress -> "Suppressed"
        user.selfMute -> "Muted"
        user.talkingUntil > now -> "Speaking"
        else -> "Listening"
    }

@Composable
fun sessionTime(): Long {
    val now by
        produceState(System.currentTimeMillis()) {
            while (true) {
                delay(100)
                value = System.currentTimeMillis()
            }
        }
    return now
}

@Composable
fun UserAvatar(user: User, now: Long, size: Int = 42) {
    val p = LocalPalette.current
    val status = userStatus(user, now)
    val icon =
        when {
            user.deaf || user.selfDeaf -> Icons.Rounded.HeadsetOff
            user.localMute || user.mute || user.selfMute || user.suppress -> Icons.Rounded.MicOff
            user.priority -> Icons.Rounded.Star
            else -> null
        }
    Box(Modifier.semantics { contentDescription = status }) {
        Avatar(user.name, status == "Speaking", size)
        if (icon != null)
            Box(
                Modifier.align(Alignment.BottomEnd)
                    .offset(4.dp, 4.dp)
                    .size(if (size < 40) 18.dp else 24.dp)
                    .background(p.elevated, MaterialTheme.shapes.extraSmall)
                    .border(2.dp, p.surface, MaterialTheme.shapes.extraSmall),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    icon,
                    null,
                    modifier = Modifier.size(if (size < 40) 11.dp else 14.dp),
                    tint = if (user.priority && status == "Listening") p.accent else p.muted,
                )
            }
    }
}

@Composable
fun StatusPill(text: String, tint: Color = LocalPalette.current.accent, icon: ImageVector? = null) {
    Row(
        Modifier.background(tint.copy(alpha = .1f), MaterialTheme.shapes.extraSmall)
            .padding(horizontal = 9.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        if (icon != null) Icon(icon, null, tint = tint, modifier = Modifier.size(13.dp))
        Text(text, color = tint, style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
fun Hint(text: String) {
    Text(text, color = LocalPalette.current.muted, style = MaterialTheme.typography.bodySmall)
}

@Composable
fun SectionLabel(text: String) {
    Text(
        text.uppercase(),
        color = LocalPalette.current.muted,
        style = MaterialTheme.typography.labelMedium,
        letterSpacing = 1.sp,
        modifier = Modifier.padding(top = 12.dp, bottom = 4.dp).semantics { heading() },
    )
}

@Composable
fun ChoiceRow(choices: List<Pair<String, String>>, selected: String, choose: (String) -> Unit) {
    val p = LocalPalette.current
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val minimumWidth =
            ((maxWidth - 8.dp - 4.dp * (choices.size - 1)) / choices.size.coerceAtLeast(1))
                .coerceAtLeast(0.dp)
        Row(
            Modifier.fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .selectableGroup()
                .background(p["sunken"], MaterialTheme.shapes.medium)
                .padding(4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            choices.forEach { (id, label) ->
                Box(
                    Modifier.widthIn(min = minimumWidth)
                        .clip(MaterialTheme.shapes.small)
                        .background(if (selected == id) p.elevated else Color.Transparent)
                        .selectable(selected == id, role = Role.Tab, onClick = { choose(id) })
                        .heightIn(min = 44.dp)
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        label,
                        color = if (selected == id) p.ink else p.muted,
                        style = MaterialTheme.typography.labelLarge,
                    )
                }
            }
        }
    }
}

@Composable
fun ToggleRow(
    title: String,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
    subtitle: String? = null,
) {
    Row(
        Modifier.fillMaxWidth()
            .heightIn(min = 56.dp)
            .toggleable(checked, role = Role.Switch, onValueChange = onChange),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(
            Modifier.weight(1f).padding(end = 12.dp),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text(title, style = MaterialTheme.typography.bodyMedium)
            subtitle?.let { Hint(it) }
        }
        Switch(checked, null)
    }
}

@Composable
fun EmptyState(icon: ImageVector, title: String, subtitle: String, modifier: Modifier = Modifier) {
    Column(
        modifier.fillMaxWidth().padding(vertical = 28.dp, horizontal = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        IconWell(icon, size = 56)
        Text(
            title,
            style = MaterialTheme.typography.titleLarge,
            textAlign = TextAlign.Center,
        )
        Text(
            subtitle,
            style = MaterialTheme.typography.bodyMedium,
            color = LocalPalette.current.muted,
            textAlign = TextAlign.Center,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppSlider(
    value: Float,
    onValueChange: (Float) -> Unit,
    valueRange: ClosedFloatingPointRange<Float>,
) {
    val p = LocalPalette.current
    Slider(
        value,
        onValueChange,
        valueRange = valueRange,
        thumb = {
            Box(
                Modifier.size(24.dp)
                    .background(p.accent, CircleShape)
                    .border(3.dp, p.elevated, CircleShape)
            )
        },
        track = {
            SliderDefaults.Track(
                it,
                Modifier.height(6.dp),
                thumbTrackGapSize = 0.dp,
                drawStopIndicator = null,
            )
        },
    )
}
