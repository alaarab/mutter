package com.alaarab.mutter

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.mutableStateOf
import com.alaarab.mutter.data.Server
import com.alaarab.mutter.ui.MutterApp

class MainActivity : ComponentActivity() {
    private val deepLink = mutableStateOf<Server?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        acceptIntent(intent)
        setContent {
            MutterApp(application as MutterApplication, deepLink.value) { deepLink.value = null }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        acceptIntent(intent)
    }

    private fun acceptIntent(intent: Intent) {
        val uri = intent.data ?: return
        if (uri.scheme != "mumble" || uri.host.isNullOrBlank()) return
        val user = uri.userInfo.orEmpty().substringBefore(':')
        deepLink.value =
            Server(
                name = uri.host.orEmpty(),
                host = uri.host.orEmpty(),
                port = if (uri.port in 1..65535) uri.port else 64738,
                username = user,
            )
    }
}
