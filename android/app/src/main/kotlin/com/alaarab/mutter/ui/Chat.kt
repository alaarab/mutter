@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package com.alaarab.mutter.ui

import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.alaarab.mutter.MutterApplication
import com.alaarab.mutter.data.SessionState
import com.alaarab.mutter.data.readBounded
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun ChatScreen(
    app: MutterApplication,
    state: SessionState,
    direct: Int?,
    onDirectClose: () -> Unit,
    onDirect: (Int) -> Unit,
    onUser: (Int) -> Unit,
) {
    val p = LocalPalette.current
    val landscape = LocalConfiguration.current.screenHeightDp < 500
    val compact = WindowInsets.isImeVisible && landscape
    var draft by rememberSaveable(direct) { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var processing by remember { mutableStateOf(false) }
    fun send() {
        val text = draft.trim()
        if (text.isEmpty()) return
        val html = android.text.TextUtils.htmlEncode(text).replace("\n", "<br>")
        if (state.maxText > 0 && html.toByteArray().size > state.maxText)
            error = "This message is longer than the server allows."
        else if (app.client.sendText(html, direct = direct)) {
            draft = ""
            error = null
        }
    }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val messages = state.messages
    var destinations by remember { mutableStateOf(false) }
    val list = rememberLazyListState()
    val photo =
        rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            if (uri != null)
                scope.launch {
                    processing = true
                    try {
                        val html =
                            withContext(Dispatchers.IO) {
                                imageMessage(context, uri, state.maxImage)
                            }
                        if (!app.client.sendText(html, direct = direct))
                            error = "Connect to send a photo."
                    } catch (failure: Exception) {
                        error = failure.message ?: "Could not attach the image"
                    } finally {
                        processing = false
                    }
                }
        }
    LaunchedEffect(messages.size) {
        if (
            messages.isNotEmpty() &&
                (list.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: messages.lastIndex) >=
                    messages.lastIndex - 2
        )
            list.animateScrollToItem(messages.lastIndex)
    }
    Column(Modifier.fillMaxSize()) {
        if (messages.isEmpty())
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
                EmptyState(
                    Icons.Rounded.Forum,
                    "No messages yet",
                    "Messages sent to your channel, or directly to you, show up here.",
                    Modifier.padding(top = 40.dp),
                )
            }
        else
            LazyColumn(
                Modifier.weight(1f).fillMaxWidth(),
                state = list,
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                itemsIndexed(messages, key = { _, message -> message.id }) { _, message ->
                    if (message.sender == null && !message.own) {
                        Box(
                            Modifier.fillMaxWidth().padding(vertical = 6.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            RichMessage(message.html, p.muted)
                        }
                    } else
                        Row(
                            Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.Top,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            if (message.own) Spacer(Modifier.width(40.dp))
                            else
                                Box(
                                    Modifier.clickable(onClickLabel = "View ${message.name}") {
                                        message.sender?.let(onUser)
                                    }
                                ) {
                                    Avatar(message.name, size = 30)
                                }
                            Column(
                                Modifier.weight(1f),
                                horizontalAlignment =
                                    if (message.own) Alignment.End else Alignment.Start,
                                verticalArrangement = Arrangement.spacedBy(3.dp),
                            ) {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                                ) {
                                    if (!message.own)
                                        Text(
                                            message.name,
                                            style = MaterialTheme.typography.labelMedium,
                                            color = p.ink,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                            modifier = Modifier.weight(1f, false),
                                        )
                                    if (message.direct != null)
                                        StatusPill("DM", p.whisper, Icons.Rounded.Lock)
                                    if (
                                        message.channel != null &&
                                            message.channel != state.self?.channel
                                    )
                                        StatusPill(
                                            "#${state.channels[message.channel]?.name.orEmpty()}",
                                            p.muted,
                                        )
                                    Text(
                                        remember(message.time) {
                                            SimpleDateFormat("HH:mm", Locale.getDefault())
                                                .format(Date(message.time))
                                        },
                                        style = MaterialTheme.typography.labelSmall,
                                        color = p.muted,
                                    )
                                }
                                SelectionContainer {
                                    Column(
                                        Modifier.widthIn(max = 324.dp)
                                            .fillMaxWidth()
                                            .clip(MaterialTheme.shapes.medium)
                                            .background(if (message.own) p.accent else p.surface)
                                            .border(
                                                1.dp,
                                                if (message.own) p.accent else p["separator"],
                                                MaterialTheme.shapes.medium,
                                            )
                                            .padding(horizontal = 12.dp, vertical = 8.dp),
                                        verticalArrangement = Arrangement.spacedBy(8.dp),
                                    ) {
                                        RichMessage(
                                            message.html,
                                            if (message.own) p["onAccent"] else p.ink,
                                        )
                                    }
                                }
                            }
                            if (!message.own) Spacer(Modifier.width(40.dp))
                        }
                }
            }
        SectionDivider()
        error?.let {
            Text(
                it,
                color = p.danger,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(horizontal = 12.dp),
            )
        }
        if (processing) LinearProgressIndicator(Modifier.fillMaxWidth())
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            IconButton(
                onClick = { photo.launch("image/*") },
                enabled = !processing && state.connected,
                modifier = Modifier.size(40.dp),
            ) {
                Icon(
                    Icons.Rounded.AddPhotoAlternate,
                    "Attach photo",
                    Modifier.size(22.dp),
                    tint = p.accent,
                )
            }
            Box {
                val scopeColor = if (direct != null) p.whisper else p.accent
                Row(
                    Modifier.widthIn(max = if (compact) 84.dp else 112.dp)
                        .heightIn(min = 40.dp)
                        .clip(CircleShape)
                        .background(scopeColor.copy(alpha = .12f))
                        .clickable { destinations = true }
                        .padding(horizontal = 8.dp, vertical = 8.dp)
                        .semantics { contentDescription = "Send to" },
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Icon(
                        if (direct == null) Icons.Rounded.Tag else Icons.Rounded.Person,
                        null,
                        Modifier.size(12.dp),
                        tint = scopeColor,
                    )
                    Text(
                        if (direct != null) state.users[direct]?.name ?: "Direct message"
                        else state.channel?.name ?: "Channel",
                        Modifier.weight(1f, fill = false),
                        style = MaterialTheme.typography.labelSmall,
                        color = scopeColor,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Icon(Icons.Rounded.UnfoldMore, null, Modifier.size(10.dp), tint = scopeColor)
                }
                DropdownMenu(destinations, { destinations = false }) {
                    DropdownMenuItem(
                        text = { Text("#${state.channel?.name ?: "Channel"} (your channel)") },
                        onClick = {
                            onDirectClose()
                            destinations = false
                        },
                    )
                    state.users.values
                        .filter { it.session != state.me }
                        .sortedBy { it.name }
                        .forEach { user ->
                            DropdownMenuItem(
                                text = { Text(user.name) },
                                leadingIcon = { Icon(Icons.Rounded.Person, null) },
                                onClick = {
                                    onDirect(user.session)
                                    destinations = false
                                },
                            )
                        }
                }
            }
            BasicTextField(
                draft,
                { draft = it },
                Modifier.weight(1f)
                    .heightIn(min = 40.dp)
                    .background(
                        p["sunken"],
                        RoundedCornerShape(18.dp),
                    )
                    .padding(horizontal = 12.dp, vertical = 9.dp),
                textStyle = MaterialTheme.typography.bodyMedium.copy(color = p.ink),
                cursorBrush = SolidColor(p.accent),
                singleLine = landscape,
                maxLines = if (landscape) 1 else 5,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { send() }),
                decorationBox = { field ->
                    if (draft.isEmpty())
                        Text(
                            "Message",
                            style = MaterialTheme.typography.bodyMedium,
                            color = p.muted,
                        )
                    field()
                },
            )
            IconButton(
                onClick = ::send,
                enabled = draft.isNotBlank() && state.connected,
                modifier = Modifier.size(40.dp),
            ) {
                Box(
                    Modifier.size(34.dp)
                        .background(
                            if (draft.isNotBlank() && state.connected) p.accent else p.muted,
                            CircleShape,
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Rounded.ArrowUpward,
                        "Send message",
                        Modifier.size(18.dp),
                        tint = p["onAccent"],
                    )
                }
            }
        }
    }
}

private fun imageMessage(context: android.content.Context, uri: Uri, maxSize: Int): String {
    require(maxSize > 0) { "This server does not allow image messages." }
    val bytes =
        context.contentResolver.openInputStream(uri)?.use { it.readBounded(20 * 1024 * 1024) }
            ?: error("Could not read image")
    require(bytes.size <= 20 * 1024 * 1024) { "Choose an image smaller than 20 MB." }
    var bitmap =
        ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(bytes))) {
            decoder,
            info,
            _ ->
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            val scale = (1280f / maxOf(info.size.width, info.size.height)).coerceAtMost(1f)
            decoder.setTargetSize(
                (info.size.width * scale).toInt().coerceAtLeast(1),
                (info.size.height * scale).toInt().coerceAtLeast(1),
            )
        }
    try {
        repeat(8) { iteration ->
            val output = ByteArrayOutputStream()
            bitmap.compress(
                Bitmap.CompressFormat.JPEG,
                (85 - iteration * 5).coerceAtLeast(50),
                output,
            )
            val html =
                "<img src=\"data:image/jpeg;base64,${Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)}\" alt=\"Photo\">"
            if (html.toByteArray().size <= maxSize) return html
            if (bitmap.width < 80 || bitmap.height < 80)
                error("The server's image limit is too small for this photo.")
            val smaller =
                Bitmap.createScaledBitmap(
                    bitmap,
                    (bitmap.width * .75f).toInt().coerceAtLeast(1),
                    (bitmap.height * .75f).toInt().coerceAtLeast(1),
                    true,
                )
            if (smaller !== bitmap) bitmap.recycle()
            bitmap = smaller
        }
        error("The photo could not fit this server's image limit.")
    } finally {
        bitmap.recycle()
    }
}
