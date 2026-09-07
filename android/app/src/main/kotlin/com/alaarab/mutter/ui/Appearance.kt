package com.alaarab.mutter.ui

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import com.alaarab.mutter.data.Settings

@Composable
fun ThemePicker(settings: Settings, choose: (String) -> Unit) {
    val catalog = LocalCatalog.current
    val p = LocalPalette.current
    val dark =
        when (settings.appearance) {
            "dark" -> true
            "light" -> false
            else -> isSystemInDarkTheme()
        }
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val columns =
            (maxWidth.value / (100 * LocalDensity.current.fontScale)).toInt().coerceIn(1, 3)
        Column(Modifier.selectableGroup(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            catalog.themes.chunked(columns).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    row.forEach { theme ->
                        val selected = settings.theme == theme.id
                        Column(
                            Modifier.weight(1f)
                                .clip(MaterialTheme.shapes.medium)
                                .selectable(
                                    selected,
                                    role = Role.RadioButton,
                                    onClick = { choose(theme.id) },
                                )
                                .semantics {
                                    contentDescription =
                                        "${theme.title} theme, ${theme.description}"
                                }
                                .padding(2.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Box(
                                Modifier.fillMaxWidth()
                                    .aspectRatio(1.12f)
                                    .clip(MaterialTheme.shapes.small)
                                    .border(
                                        if (selected) 2.dp else 1.dp,
                                        if (selected) p.accent else p["separator"],
                                        MaterialTheme.shapes.small,
                                    )
                            ) {
                                ThemeMiniature(
                                    if (dark) theme.dark else theme.light,
                                    Modifier.fillMaxSize().padding(4.dp),
                                )
                                if (selected)
                                    Box(
                                        Modifier.align(Alignment.TopEnd)
                                            .padding(7.dp)
                                            .size(20.dp)
                                            .background(p.accent, MaterialTheme.shapes.extraSmall),
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        Icon(
                                            Icons.Rounded.Check,
                                            "Selected",
                                            tint = p["onAccent"],
                                            modifier = Modifier.size(14.dp),
                                        )
                                    }
                            }
                            Text(
                                theme.title,
                                style = MaterialTheme.typography.labelMedium,
                                color = if (selected) p.ink else p.muted,
                                modifier = Modifier.padding(start = 3.dp, bottom = 5.dp),
                            )
                        }
                    }
                    repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
    }
}

@Composable
private fun ThemeMiniature(p: Palette, modifier: Modifier) {
    Canvas(modifier.clip(MaterialTheme.shapes.extraSmall).background(p.background)) {
        val w = size.width
        val h = size.height
        fun block(
            x: Float,
            y: Float,
            width: Float,
            height: Float,
            color: Color,
            radius: Float = .035f,
        ) {
            drawRoundRect(
                color,
                Offset(w * x, h * y),
                Size(w * width, h * height),
                CornerRadius(w * radius),
            )
        }
        block(.08f, .09f, .13f, .055f, p.accent)
        block(.27f, .09f, .38f, .055f, p.ink.copy(alpha = .8f))
        block(.08f, .23f, .84f, .28f, p.surface)
        block(.14f, .29f, .16f, .15f, p["avatar0"])
        block(.37f, .3f, .37f, .04f, p.ink.copy(alpha = .7f))
        block(.37f, .4f, .22f, .03f, p.muted)
        block(.08f, .55f, .84f, .16f, p.elevated)
        block(.15f, .615f, .47f, .03f, p.body)
        block(.08f, .79f, .84f, .13f, p.accent)
        block(.33f, .84f, .34f, .025f, p["onAccent"])
    }
}
