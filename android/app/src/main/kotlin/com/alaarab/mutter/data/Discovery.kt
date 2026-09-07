package com.alaarab.mutter.data

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Xml
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.net.URL
import java.nio.ByteBuffer
import java.security.SecureRandom
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.withContext
import org.xmlpull.v1.XmlPullParser

data class Probe(val users: Int, val capacity: Int, val ping: Long)

object Discovery {
    suspend fun directory(): List<Server> =
        withContext(Dispatchers.IO) {
            val connection =
                URL("https://publist.mumble.info/v1/list").openConnection().apply {
                    connectTimeout = 10000
                    readTimeout = 10000
                }
            val bytes = connection.getInputStream().use { it.readBounded(4 * 1024 * 1024) }
            require(bytes.size <= 4 * 1024 * 1024) { "Server directory is too large" }
            val parser = Xml.newPullParser()
            parser.setInput(bytes.inputStream(), "UTF-8")
            val list = mutableListOf<Server>()
            while (parser.eventType != XmlPullParser.END_DOCUMENT && list.size < 20000) {
                if (parser.eventType == XmlPullParser.START_TAG && parser.name == "server") {
                    val host = parser.getAttributeValue(null, "ip") ?: ""
                    val port = parser.getAttributeValue(null, "port")?.toIntOrNull() ?: 64738
                    if (host.isNotBlank() && port in 1..65535)
                        list.add(
                            Server(
                                name = parser.getAttributeValue(null, "name") ?: host,
                                host = host,
                                port = port,
                            )
                        )
                }
                parser.next()
            }
            list.sortedBy { it.name.lowercase() }
        }

    suspend fun probe(server: Server): Probe? =
        withContext(Dispatchers.IO) {
            runCatching {
                DatagramSocket().use { socket ->
                    socket.connect(InetSocketAddress(server.host, server.port))
                    socket.soTimeout = 2500
                    val nonce = ByteArray(8).also { SecureRandom().nextBytes(it) }
                    val request = ByteArray(4) + nonce
                    val start = System.nanoTime()
                    socket.send(DatagramPacket(request, request.size))
                    val response = DatagramPacket(ByteArray(64), 64)
                    socket.receive(response)
                    require(
                        response.length >= 24 &&
                            response.data.copyOfRange(4, 12).contentEquals(nonce)
                    )
                    val data = ByteBuffer.wrap(response.data)
                    Probe(data.getInt(12), data.getInt(16), (System.nanoTime() - start) / 1000000)
                }
            }
                .getOrNull()
        }

    @Suppress("DEPRECATION")
    fun local(context: Context) =
        callbackFlow<Server> {
            val manager = context.getSystemService(NsdManager::class.java)
            val listener =
                object : NsdManager.DiscoveryListener {
                    override fun onDiscoveryStarted(type: String) {}

                    override fun onDiscoveryStopped(type: String) {}

                    override fun onStartDiscoveryFailed(type: String, error: Int) {
                        close()
                    }

                    override fun onStopDiscoveryFailed(type: String, error: Int) {}

                    override fun onServiceLost(info: NsdServiceInfo) {}

                    override fun onServiceFound(info: NsdServiceInfo) {
                        manager.resolveService(
                            info,
                            object : NsdManager.ResolveListener {
                                override fun onResolveFailed(service: NsdServiceInfo, error: Int) {}

                                override fun onServiceResolved(service: NsdServiceInfo) {
                                    service.host?.hostAddress?.let { host ->
                                        trySend(
                                            Server(
                                                id = "$host:${service.port}",
                                                name = service.serviceName,
                                                host = host,
                                                port = service.port,
                                            )
                                        )
                                    }
                                }
                            },
                        )
                    }
                }
            manager.discoverServices("_mumble._tcp.", NsdManager.PROTOCOL_DNS_SD, listener)
            awaitClose { runCatching { manager.stopServiceDiscovery(listener) } }
        }
}
