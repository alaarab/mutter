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
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

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
                    Modifier.fillMaxWidth().heightIn(max = 260.dp).clip(MaterialTheme.shapes.small),
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
