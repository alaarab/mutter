package com.alaarab.mutter.ui

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import com.alaarab.mutter.data.Settings

@Composable
fun ThemeRow(
    options: List<ThemeOption>,
    columns: Int,
    settings: Settings,
    choose: (String) -> Unit,
) {
    val p = LocalPalette.current
    val dark =
        when (settings.appearance) {
            "dark" -> true
            "light" -> false
            else -> isSystemInDarkTheme()
        }
    Row(
        Modifier.fillMaxWidth()
            .background(p.surface)
            .padding(horizontal = 16.dp, vertical = 5.dp)
            .selectableGroup(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        options.forEach { theme ->
            val selected = settings.theme == theme.id
            Column(
                Modifier.weight(1f)
                    .clip(MaterialTheme.shapes.small)
                    .background(p.background)
                    .border(
                        if (selected) 2.dp else 1.dp,
                        if (selected) p.accent else p["separator"],
                        MaterialTheme.shapes.small,
                    )
                    .selectable(
                        selected,
                        role = Role.RadioButton,
                        onClick = { choose(theme.id) },
                    )
                    .semantics {
                        contentDescription = "${theme.title} theme, ${theme.description}"
                    }
                    .padding(5.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                ThemeMiniature(
                    if (dark) theme.dark else theme.light,
                    Modifier.fillMaxWidth().height(44.dp),
                )
                Text(
                    theme.title,
                    style = MaterialTheme.typography.labelSmall,
                    color = if (selected) p.ink else p.body,
                    modifier = Modifier.padding(horizontal = 3.dp, vertical = 2.dp),
                )
            }
        }
        repeat(columns - options.size) { Spacer(Modifier.weight(1f)) }
    }
}

@Composable
private fun ThemeMiniature(p: Palette, modifier: Modifier) {
    Canvas(modifier.clip(MaterialTheme.shapes.extraSmall).background(p.background)) {
        val w = size.width
        val h = size.height
        drawRect(p.elevated, size = Size(9.dp.toPx(), h))
        drawRect(p.surface, topLeft = Offset(10.dp.toPx(), 0f), size = Size(20.dp.toPx(), h))
        val left = 36.dp.toPx()
        fun line(y: Float, width: Float, color: Color) {
            drawRoundRect(
                color,
                Offset(left, y.dp.toPx()),
                Size(width.coerceAtLeast(0f), 3.dp.toPx()),
                CornerRadius(2.dp.toPx()),
            )
        }
        line(6f, 18.dp.toPx(), p.accent)
        line(13f, w - left - 6.dp.toPx(), p["separator"])
        line(20f, minOf(25.dp.toPx(), w - left - 6.dp.toPx()), p["separator"])
    }
}
