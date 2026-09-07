package com.alaarab.mutter.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.alaarab.mutter.MutterApplication
import org.webrtc.SurfaceViewRenderer

@Composable
fun ShareDialog(app: MutterApplication) {
    val watching by app.shares.watching.collectAsStateWithLifecycle()
    val track by app.shares.video.collectAsStateWithLifecycle()
    val status by app.shares.status.collectAsStateWithLifecycle()
    watching?.let { share ->
        Dialog(
            onDismissRequest = app.shares::stop,
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Surface(Modifier.fillMaxSize(), color = LocalPalette.current["media"]) {
                Column(Modifier.safeDrawingPadding()) {
                    Row(Modifier.fillMaxWidth().padding(16.dp)) {
                        Text(
                            share.title,
                            color = LocalPalette.current["onMedia"],
                            modifier = Modifier.weight(1f),
                        )
                        TextButton(app.shares::stop) { Text("Close") }
                    }
                    var renderer by remember { mutableStateOf<SurfaceViewRenderer?>(null) }
                    AndroidView(
                        factory = { context ->
                            SurfaceViewRenderer(context).apply {
                                init(app.shares.egl.eglBaseContext, null)
                                setEnableHardwareScaler(true)
                                renderer = this
                            }
                        },
                        modifier = Modifier.weight(1f).fillMaxWidth(),
                        onRelease = { view ->
                            track?.removeSink(view)
                            view.release()
                            renderer = null
                        },
                    )
                    DisposableEffect(track, renderer) {
                        renderer?.let { track?.addSink(it) }
                        onDispose { renderer?.let { track?.removeSink(it) } }
                    }
                    Text(
                        status,
                        color = LocalPalette.current["onMedia"],
                        modifier = Modifier.padding(16.dp),
                    )
                }
            }
        }
    }
}
