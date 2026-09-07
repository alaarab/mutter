package com.alaarab.mutter.ui

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.text.Html
import android.text.style.StyleSpan
import android.text.style.URLSpan
import android.util.Base64
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable
fun AppCard(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val p = LocalPalette.current
    Column(
        modifier
            .clip(RoundedCornerShape(20.dp))
            .background(Brush.linearGradient(listOf(p["surfaceHighlight"], p.surface)))
            .border(1.dp, p.ink.copy(alpha = .07f), RoundedCornerShape(20.dp))
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
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
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.headlineLarge)
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
    IconButton(onClick = action) { Icon(icon, description, tint = tint) }
}

@Composable
fun Avatar(name: String, talking: Boolean = false, size: Int = 42) {
    val p = LocalPalette.current
    val hash = name.fold(0) { value, char -> value * 31 + char.code }
    val index = (hash.toLong().let { kotlin.math.abs(it) } % 6).toInt()
    Box(
        Modifier.size(size.dp)
            .clip(RoundedCornerShape((size / 3).dp))
            .background(p["avatar$index"])
            .border(
                if (talking) 2.dp else 0.dp,
                if (talking) p.speaking else Color.Transparent,
                RoundedCornerShape((size / 3).dp),
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            name.trim().take(2).uppercase(),
            color = p["onAvatar"],
            fontWeight = FontWeight.Bold,
            fontSize = (size * .33).sp,
        )
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
        modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
    )
}

@Composable
fun ChoiceRow(choices: List<Pair<String, String>>, selected: String, choose: (String) -> Unit) {
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        choices.forEach { (id, label) ->
            FilterChip(selected == id, { choose(id) }, label = { Text(label) })
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
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyMedium)
            subtitle?.let { Hint(it) }
        }
        Switch(checked, onChange)
    }
}

@Composable
fun RichMessage(html: String) {
    val p = LocalPalette.current
    val context = LocalContext.current
    val annotated =
        remember(html, p.accent) {
            val text =
                Html.fromHtml(
                    html.replace(Regex("<img\\b[^>]*>", RegexOption.IGNORE_CASE), ""),
                    Html.FROM_HTML_MODE_COMPACT,
                )
            buildAnnotatedString {
                append(text.toString().trimEnd())
                text.getSpans(0, text.length, StyleSpan::class.java).forEach { span ->
                    if (span.style and android.graphics.Typeface.BOLD != 0)
                        addStyle(
                            SpanStyle(fontWeight = FontWeight.Bold),
                            text.getSpanStart(span).coerceAtMost(length),
                            text.getSpanEnd(span).coerceAtMost(length),
                        )
                }
                text.getSpans(0, text.length, URLSpan::class.java).forEach { span ->
                    val uri = Uri.parse(span.url)
                    if (uri.scheme in listOf("https", "http", "mumble")) {
                        addLink(
                            LinkAnnotation.Url(
                                span.url,
                                TextLinkStyles(style = SpanStyle(color = p.accent)),
                            ),
                            text.getSpanStart(span).coerceAtMost(length),
                            text.getSpanEnd(span).coerceAtMost(length),
                        )
                    }
                }
            }
        }
    if (annotated.isNotBlank())
        Text(annotated, color = p.body, style = MaterialTheme.typography.bodyMedium)
    val images =
        remember(html) {
            Regex("<img\\b[^>]*src=[\"']([^\"']+)[\"'][^>]*>", RegexOption.IGNORE_CASE)
                .findAll(html)
                .map { it.groupValues[1] }
                .take(8)
                .toList()
        }
    images.forEach { src ->
        if (src.startsWith("data:image/") && src.length < 3 * 1024 * 1024) {
            val bitmap by
                produceState<Bitmap?>(null, src) {
                    value =
                        withContext(Dispatchers.IO) {
                            runCatching {
                                val bytes = Base64.decode(src.substringAfter(','), Base64.DEFAULT)
                                val bounds =
                                    BitmapFactory.Options().apply { inJustDecodeBounds = true }
                                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                                val options =
                                    BitmapFactory.Options().apply {
                                        inSampleSize =
                                            (maxOf(bounds.outWidth, bounds.outHeight) / 1280)
                                                .coerceAtLeast(1)
                                    }
                                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
                            }
                                .getOrNull()
                        }
                }
            bitmap?.let {
                Image(
                    it.asImageBitmap(),
                    "Shared image",
                    Modifier.fillMaxWidth().heightIn(max = 260.dp).clip(RoundedCornerShape(12.dp)),
                )
            }
        } else if (Uri.parse(src).scheme in listOf("http", "https")) {
            TextButton(
                onClick = {
                    runCatching {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(src)))
                    }
                }
            ) {
                Text("Open shared image")
            }
        }
    }
}
