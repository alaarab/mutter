package com.alaarab.mutter.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.DialogWindowProvider
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
    private val motion = json.getJSONObject("motion")
    val duration = motion.getInt("theme")
    val fast = motion.getInt("fast")
    val standard = motion.getInt("standard")
    val panel = motion.getInt("panel")
    val easing =
        motion.getJSONArray("ease").let {
            CubicBezierEasing(
                it.getDouble(0).toFloat(),
                it.getDouble(1).toFloat(),
                it.getDouble(2).toFloat(),
                it.getDouble(3).toFloat(),
            )
        }
    val shapes =
        json.getJSONObject("radii").let {
            Shapes(
                extraSmall = RoundedCornerShape(it.getInt("small").dp),
                small = RoundedCornerShape(it.getInt("medium").dp),
                medium = RoundedCornerShape(it.getInt("large").dp),
                large = RoundedCornerShape(it.getInt("tile").dp),
                extraLarge = RoundedCornerShape((it.getInt("tile") + it.getInt("small")).dp),
            )
        }
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
            animateColorAsState(
                    value,
                    tween(catalog.duration, easing = catalog.easing),
                    label = "theme",
                )
                .value
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
    val inverse = if (dark) selected.light else selected.dark
    val base = if (dark) darkColorScheme() else lightColorScheme()
    val scheme =
        base.copy(
            primary = p.accent,
            onPrimary = p["onAccent"],
            primaryContainer = p.elevated,
            onPrimaryContainer = p.ink,
            secondary = p.accent,
            onSecondary = p["onAccent"],
            secondaryContainer = p.elevated,
            onSecondaryContainer = p.ink,
            tertiary = p.whisper,
            onTertiary = p["onStatus"],
            tertiaryContainer = p.whisper.copy(alpha = .12f).compositeOver(p.surface),
            onTertiaryContainer = p.whisper,
            inverseSurface = inverse.surface,
            inverseOnSurface = inverse.ink,
            inversePrimary = inverse.accent,
            surfaceTint = p.accent,
            surfaceBright = p.elevated,
            surfaceDim = p["sunken"],
            scrim = selected.dark["sunken"],
            primaryFixed = selected.light.accent,
            primaryFixedDim = selected.light.accent,
            onPrimaryFixed = selected.light["onAccent"],
            onPrimaryFixedVariant = selected.light["onAccent"],
            secondaryFixed = selected.light.accent,
            secondaryFixedDim = selected.light.accent,
            onSecondaryFixed = selected.light["onAccent"],
            onSecondaryFixedVariant = selected.light["onAccent"],
            tertiaryFixed = selected.light.whisper,
            tertiaryFixedDim = selected.light.whisper,
            onTertiaryFixed = selected.light["onStatus"],
            onTertiaryFixedVariant = selected.light["onStatus"],
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
            errorContainer = p.danger.copy(alpha = .12f).compositeOver(p.surface),
            onErrorContainer = p.danger,
        )
    fun headingStyle(size: Int, height: Int, weight: FontWeight = FontWeight.Bold) =
        TextStyle(
            fontFamily = heading,
            fontWeight = weight,
            fontSize = size.sp,
            lineHeight = height.sp,
        )
    fun bodyStyle(size: Int, height: Int, weight: FontWeight = FontWeight.Normal) =
        TextStyle(
            fontFamily = body,
            fontWeight = weight,
            fontSize = size.sp,
            lineHeight = height.sp,
        )
    val typography =
        Typography(
            displayLarge = headingStyle(52, 60, FontWeight.ExtraBold),
            displayMedium = headingStyle(44, 52, FontWeight.ExtraBold),
            displaySmall = headingStyle(36, 42, FontWeight.ExtraBold),
            headlineLarge = headingStyle(30, 36),
            headlineMedium = headingStyle(26, 32),
            headlineSmall = headingStyle(24, 30),
            titleLarge = headingStyle(22, 28),
            titleMedium = bodyStyle(16, 23, FontWeight.Bold),
            titleSmall = bodyStyle(14, 20, FontWeight.Bold),
            bodyLarge = bodyStyle(16, 24),
            bodyMedium = bodyStyle(14, 21),
            bodySmall = bodyStyle(12, 18),
            labelLarge = bodyStyle(14, 20, FontWeight.Bold),
            labelMedium = bodyStyle(12, 18, FontWeight.SemiBold),
            labelSmall = bodyStyle(11, 16, FontWeight.SemiBold),
        )
    CompositionLocalProvider(LocalPalette provides p, LocalCatalog provides catalog) {
        MaterialTheme(
            colorScheme = scheme,
            typography = typography,
            shapes = catalog.shapes,
            content = content,
        )
    }
}

@Composable
fun SheetSystemBars() {
    val view = LocalView.current
    val light = LocalPalette.current.background.luminance() > .5f
    SideEffect {
        (view.parent as? DialogWindowProvider)?.window?.let { window ->
            WindowCompat.getInsetsController(window, window.decorView).apply {
                isAppearanceLightStatusBars = light
                isAppearanceLightNavigationBars = light
            }
        }
    }
}

@Composable
fun ambientBrush(): Brush {
    val p = LocalPalette.current
    return Brush.linearGradient(
        listOf(p.accent.copy(alpha = .08f), Color.Transparent, p["secondary"].copy(alpha = .04f))
    )
}
