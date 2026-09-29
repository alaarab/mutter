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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private const val INLINE_PARSE_CHARACTERS = 4000
private const val LONGEST_IMAGE_SIDE = 1280
private val imageTag = Regex("<img\\b[^<>]*>", RegexOption.IGNORE_CASE)
private val imageSource =
    Regex("<img\\b[^<>]*?\\bsrc=[\"']([^\"'<>]+)[\"'][^<>]*>", RegexOption.IGNORE_CASE)

private fun annotatedMessage(html: String, color: Color): AnnotatedString {
    val text = Html.fromHtml(html.replace(imageTag, ""), Html.FROM_HTML_MODE_COMPACT)
    return buildAnnotatedString {
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
                        TextLinkStyles(
                            style = SpanStyle(color = color, textDecoration = TextDecoration.Underline)
                        ),
                    ),
                    text.getSpanStart(span).coerceAtMost(length),
                    text.getSpanEnd(span).coerceAtMost(length),
                )
            }
        }
    }
}

private fun decodeSharedImage(source: String): Bitmap? =
    runCatching {
            val bytes = Base64.decode(source.substringAfter(','), Base64.DEFAULT)
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return@runCatching null
            val options =
                BitmapFactory.Options().apply {
                    inSampleSize =
                        sampleSizeFor(bounds.outWidth, bounds.outHeight, LONGEST_IMAGE_SIDE)
                }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        }
        .getOrNull()

@Composable
fun RichMessage(
    html: String,
    color: Color = LocalPalette.current.body,
) {
    val context = LocalContext.current
    val parsedInline =
        remember(html, color) {
            if (html.length <= INLINE_PARSE_CHARACTERS) annotatedMessage(html, color) else null
        }
    val parsedInBackground by
        produceState<AnnotatedString?>(null, html, color) {
            value = null
            if (parsedInline == null)
                value = withContext(Dispatchers.Default) { annotatedMessage(html, color) }
        }
    val annotated = parsedInline ?: parsedInBackground
    if (annotated != null && annotated.isNotBlank())
        Text(annotated, color = color, style = MaterialTheme.typography.bodyLarge)
    val images =
        remember(html) { imageSource.findAll(html).map { it.groupValues[1] }.take(8).toList() }
    images.forEach { src ->
        if (src.startsWith("data:image/") && src.length < 3 * 1024 * 1024) {
            val bitmap by
                produceState<Bitmap?>(null, src) {
                    value = withContext(Dispatchers.IO) { decodeSharedImage(src) }
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
