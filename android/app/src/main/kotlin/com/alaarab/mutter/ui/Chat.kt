package com.alaarab.mutter.ui

import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
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
    var draft by rememberSaveable(direct) { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var processing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val messages =
        state.messages.filter {
            if (direct != null) it.direct == direct
            else it.direct == null && (it.channel == null || it.channel == state.self?.channel)
        }
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
    Column(Modifier.fillMaxSize().imePadding()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    if (direct != null) state.users[direct]?.name ?: "Direct message"
                    else state.channel?.name ?: "Chat",
                    style = MaterialTheme.typography.headlineSmall,
                )
                Hint(if (direct != null) "Only you and them" else "Channel conversation")
            }
            if (direct != null)
                ActionIcon(Icons.Rounded.Close, "Return to channel chat", action = onDirectClose)
        }
        val conversations = state.messages.mapNotNull { it.direct }.distinct()
        if (conversations.isNotEmpty())
            Row(
                Modifier.fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                FilterChip(direct == null, onDirectClose, label = { Text("Channel") })
                conversations.forEach { user ->
                    FilterChip(
                        direct == user,
                        { onDirect(user) },
                        label = {
                            Text(
                                state.users[user]?.name
                                    ?: state.messages.firstOrNull { it.sender == user }?.name
                                    ?: "Direct message"
                            )
                        },
                    )
                }
            }
        if (messages.isEmpty())
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Hint("A good conversation starts with hello.")
            }
        else
            LazyColumn(
                Modifier.weight(1f).fillMaxWidth(),
                state = list,
                contentPadding = PaddingValues(20.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                items(messages, key = { it.id }) { message ->
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Box(
                            Modifier.clickable(enabled = message.sender != null) {
                                message.sender?.let(onUser)
                            }
                        ) {
                            Avatar(message.name, size = 36)
                        }
                        Column(
                            Modifier.weight(1f),
                            verticalArrangement = Arrangement.spacedBy(5.dp),
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                Text(
                                    message.name,
                                    fontWeight = FontWeight.Bold,
                                    style = MaterialTheme.typography.bodyMedium,
                                    color =
                                        if (message.own) LocalPalette.current.accent
                                        else LocalPalette.current.ink,
                                )
                                Hint(
                                    remember(message.time) {
                                        SimpleDateFormat("HH:mm", Locale.getDefault())
                                            .format(Date(message.time))
                                    }
                                )
                            }
                            SelectionContainer { Column { RichMessage(message.html) } }
                        }
                    }
                }
            }
        error?.let {
            Text(
                it,
                color = LocalPalette.current.danger,
                modifier = Modifier.padding(horizontal = 20.dp),
            )
        }
        Row(
            Modifier.fillMaxWidth().padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(
                onClick = { photo.launch("image/*") },
                enabled = !processing && state.connected,
            ) {
                Icon(Icons.Rounded.AddPhotoAlternate, "Attach photo")
            }
            OutlinedTextField(
                draft,
                { draft = it },
                Modifier.weight(1f),
                placeholder = { Text("Say something…") },
                maxLines = 5,
            )
            IconButton(
                onClick = {
                    val text = draft.trim()
                    val html = android.text.TextUtils.htmlEncode(text).replace("\n", "<br>")
                    if (state.maxText > 0 && html.toByteArray().size > state.maxText)
                        error = "This message is longer than the server allows."
                    else if (app.client.sendText(html, direct = direct)) {
                        draft = ""
                        error = null
                    }
                },
                enabled = draft.isNotBlank() && state.connected,
            ) {
                Icon(
                    Icons.AutoMirrored.Rounded.Send,
                    "Send message",
                    tint = LocalPalette.current.accent,
                )
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
