package com.alaarab.mutter.ui

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ViewQuilt
import androidx.compose.material.icons.automirrored.rounded.ScreenShare
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.QuestionAnswer
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.alaarab.mutter.MutterApplication
import com.alaarab.mutter.data.SessionState

@Composable
fun RoundControl(
    icon: ImageVector,
    label: String,
    tint: Color = LocalPalette.current.ink,
    active: Boolean = false,
    action: () -> Unit,
) {
    val p = LocalPalette.current
    Box(
        Modifier.size(48.dp)
            .clip(CircleShape)
            .clickable(onClickLabel = label, onClick = action)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier.size(42.dp)
                .background(if (active) tint.copy(alpha = .14f) else p.elevated, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, null, Modifier.size(20.dp), tint = tint)
        }
    }
}

@Composable
fun HomeToolbar(settings: () -> Unit, browse: () -> Unit, add: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RoundControl(
            Icons.Rounded.Settings,
            "Settings",
            LocalPalette.current.accent,
            action = settings,
        )
        Spacer(Modifier.weight(1f))
        RoundControl(
            Icons.Rounded.Public,
            "Public servers",
            LocalPalette.current.accent,
            action = browse,
        )
        Spacer(Modifier.width(8.dp))
        RoundControl(Icons.Rounded.Add, "Add server", LocalPalette.current.accent, action = add)
    }
}

@Composable
fun SessionHeader(state: SessionState, back: () -> Unit) {
    val p = LocalPalette.current
    Row(
        Modifier.fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .testTag("sessionHeader"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        RoundControl(Icons.Rounded.ChevronLeft, "Back to servers", action = back)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(
                state.server?.name?.ifBlank { state.server.host } ?: "Server",
                style = MaterialTheme.typography.titleLarge.copy(fontSize = 21.sp),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Box(
                    Modifier.size(8.dp)
                        .background(if (state.connected) p.speaking else p["warn"], CircleShape)
                )
                Text(
                    if (state.connected)
                        "${state.users.size} online · in ${state.channel?.name.orEmpty()}"
                    else state.status.replaceFirstChar { it.uppercase() },
                    style = MaterialTheme.typography.bodySmall,
                    color = p.muted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (state.connected)
            StatusPill(
                if (state.ping > 0) "${state.ping} ms" else "…",
                latencyColor(state.ping),
                if (state.udp) Icons.Rounded.Bolt else Icons.Rounded.Sync,
            )
    }
}

@Composable
fun latencyColor(ping: Long): Color {
    val p = LocalPalette.current
    return when {
        ping <= 0 -> p.muted
        ping < 90 -> p.speaking
        ping < 200 -> p["warn"]
        else -> p.danger
    }
}

@Composable
fun SessionNavigation(page: String, unread: Int, select: (String) -> Unit) {
    val p = LocalPalette.current
    Row(Modifier.fillMaxWidth().selectableGroup().testTag("sessionNavigation")) {
        listOf(
                Triple("channels", "Channels", Icons.AutoMirrored.Outlined.ViewQuilt),
                Triple("chat", "Chat", Icons.Outlined.QuestionAnswer),
                Triple("info", "Server", Icons.Outlined.Dns),
            )
            .forEach { (id, title, icon) ->
                val color = if (page == id) p.accent else p.muted
                Column(
                    Modifier.weight(1f)
                        .selectable(page == id, role = Role.Tab, onClick = { select(id) })
                        .testTag("tab-$id")
                        .heightIn(min = 50.dp)
                        .padding(vertical = 6.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    BadgedBox(
                        badge = {
                            if (id == "chat" && unread > 0)
                                Badge(containerColor = p.accent, contentColor = p["onAccent"]) {
                                    Text(if (unread > 99) "99+" else unread.toString())
                                }
                        }
                    ) {
                        Icon(icon, null, Modifier.size(20.dp), tint = color)
                    }
                    Text(
                        title,
                        color = color,
                        style =
                            MaterialTheme.typography.labelSmall.copy(
                                fontSize = 10.sp,
                                lineHeight = 13.sp,
                            ),
                    )
                }
            }
    }
}

@Composable
fun SheetHeader(
    title: String,
    back: (() -> Unit)? = null,
    actionLabel: String = "Done",
    cancel: (() -> Unit)? = null,
    dismiss: () -> Unit,
) {
    val actionWidth = (64 * LocalDensity.current.fontScale).coerceAtLeast(80f).dp
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(actionWidth)) {
            if (cancel != null) TextButton(cancel) { Text("Cancel", maxLines = 1) }
            else if (back != null)
                ActionIcon(Icons.Rounded.ChevronLeft, "Back to settings", action = back)
        }
        Text(
            title,
            Modifier.weight(1f),
            textAlign = TextAlign.Center,
            style = MaterialTheme.typography.titleLarge.copy(fontSize = 17.sp),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        TextButton(onClick = dismiss, modifier = Modifier.width(actionWidth)) {
            Text(actionLabel, maxLines = 1)
        }
    }
}

@Composable
fun ShareBanner(app: MutterApplication) {
    val shares by app.shares.shares.collectAsStateWithLifecycle()
    if (shares.isNotEmpty())
        Row(
            Modifier.fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            shares.forEach { share ->
                TextButton({ app.shares.watch(share) }) {
                    Icon(Icons.AutoMirrored.Rounded.ScreenShare, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Watch ${share.title}")
                }
            }
        }
}
