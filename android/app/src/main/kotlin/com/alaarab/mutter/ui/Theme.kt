package com.alaarab.mutter.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import com.alaarab.mutter.data.Settings
import org.json.JSONObject

class Palette(val colors: Map<String, Color>) {
    operator fun get(name: String) = colors.getValue(name)

    val background
        get() = this["bg"]

    val surface
        get() = this["surface"]

    val elevated
        get() = this["elevated"]

    val ink
        get() = this["ink"]

    val body
        get() = this["body"]

    val muted
        get() = this["muted"]

    val accent
        get() = this["accent"]

    val speaking
        get() = this["speaking"]

    val danger
        get() = this["danger"]

    val whisper
        get() = this["whisper"]
}

data class ThemeOption(
    val id: String,
    val title: String,
    val description: String,
    val light: Palette,
    val dark: Palette,
)

class ThemeCatalog(source: String) {
    private val json = JSONObject(source)
    val duration = json.getJSONObject("motion").getInt("theme")
    val themes: List<ThemeOption> =
        json.getJSONObject("themes").let { themes ->
            themes
                .keys()
                .asSequence()
                .map { id ->
                    val theme = themes.getJSONObject(id)
                    fun palette(mode: String): Palette {
                        val colors = theme.getJSONObject(mode)
                        return Palette(
                            colors.keys().asSequence().associateWith {
                                Color(android.graphics.Color.parseColor(colors.getString(it)))
                            }
                        )
                    }
                    ThemeOption(
                        id,
                        theme.getString("title"),
                        theme.getString("description"),
                        palette("light"),
                        palette("dark"),
                    )
                }
                .toList()
        }
}

val LocalPalette = staticCompositionLocalOf<Palette> { error("MutterTheme is missing") }
val LocalCatalog = staticCompositionLocalOf<ThemeCatalog> { error("Theme catalog is missing") }

@Composable
fun MutterTheme(settings: Settings, content: @Composable () -> Unit) {
    val context = LocalContext.current
    val catalog = remember {
        ThemeCatalog(context.assets.open("themes.json").bufferedReader().use { it.readText() })
    }
    val dark =
        when (settings.appearance) {
            "dark" -> true
            "light" -> false
            else -> isSystemInDarkTheme()
        }
    SideEffect {
        (context as? android.app.Activity)?.window?.let { window ->
            WindowCompat.getInsetsController(window, window.decorView).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
        }
    }
    val selected =
        catalog.themes.find { it.id == settings.theme }
            ?: catalog.themes.first { it.id == "carbon" }
    val target = if (dark) selected.dark else selected.light
    val colors =
        target.colors.mapValues { (_, value) ->
            animateColorAsState(value, tween(catalog.duration), label = "theme").value
        }
    val p = Palette(colors)
    val body = remember {
        FontFamily(
            Font("PlusJakartaSans-Regular.ttf", context.assets, FontWeight.Normal),
            Font("PlusJakartaSans-SemiBold.ttf", context.assets, FontWeight.SemiBold),
            Font("PlusJakartaSans-Bold.ttf", context.assets, FontWeight.Bold),
        )
    }
    val heading = remember {
        FontFamily(
            Font("BricolageDisplay-SemiBold.ttf", context.assets, FontWeight.SemiBold),
            Font("BricolageDisplay-Bold.ttf", context.assets, FontWeight.Bold),
            Font("BricolageDisplay-ExtraBold.ttf", context.assets, FontWeight.ExtraBold),
        )
    }
    val base = if (dark) darkColorScheme() else lightColorScheme()
    val scheme =
        base.copy(
            primary = p.accent,
            onPrimary = p["onAccent"],
            primaryContainer = p.elevated,
            onPrimaryContainer = p.ink,
            secondary = p.whisper,
            onSecondary = p["onStatus"],
            secondaryContainer = p.elevated,
            onSecondaryContainer = p.ink,
            background = p.background,
            onBackground = p.ink,
            surface = p.surface,
            onSurface = p.ink,
            surfaceVariant = p.elevated,
            onSurfaceVariant = p.body,
            surfaceContainer = p.surface,
            surfaceContainerHigh = p.elevated,
            surfaceContainerHighest = p.elevated,
            surfaceContainerLow = p.surface,
            surfaceContainerLowest = p.background,
            outline = p.muted,
            outlineVariant = p.ink.copy(alpha = .12f),
            error = p.danger,
            onError = p["onStatus"],
        )
    val typography =
        Typography(
            displaySmall =
                TextStyle(
                    fontFamily = heading,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 36.sp,
                    lineHeight = 42.sp,
                ),
            headlineLarge =
                TextStyle(
                    fontFamily = heading,
                    fontWeight = FontWeight.Bold,
                    fontSize = 30.sp,
                    lineHeight = 36.sp,
                ),
            headlineSmall =
                TextStyle(
                    fontFamily = heading,
                    fontWeight = FontWeight.Bold,
                    fontSize = 24.sp,
                    lineHeight = 30.sp,
                ),
            titleLarge =
                TextStyle(
                    fontFamily = heading,
                    fontWeight = FontWeight.Bold,
                    fontSize = 22.sp,
                    lineHeight = 28.sp,
                ),
            titleMedium =
                TextStyle(
                    fontFamily = body,
                    fontWeight = FontWeight.Bold,
                    fontSize = 16.sp,
                    lineHeight = 23.sp,
                ),
            bodyLarge = TextStyle(fontFamily = body, fontSize = 16.sp, lineHeight = 24.sp),
            bodyMedium = TextStyle(fontFamily = body, fontSize = 14.sp, lineHeight = 21.sp),
            bodySmall = TextStyle(fontFamily = body, fontSize = 12.sp, lineHeight = 18.sp),
            labelLarge =
                TextStyle(fontFamily = body, fontWeight = FontWeight.Bold, fontSize = 14.sp),
            labelMedium =
                TextStyle(fontFamily = body, fontWeight = FontWeight.SemiBold, fontSize = 12.sp),
        )
    CompositionLocalProvider(LocalPalette provides p, LocalCatalog provides catalog) {
        MaterialTheme(colorScheme = scheme, typography = typography, content = content)
    }
}
