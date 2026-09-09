package com.alaarab.mutter.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject

class AppStore(private val context: Context) {
    private val key: SecretKey by lazy {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("mutter-storage", null) as? SecretKey)
            ?: KeyGenerator.getInstance("AES", "AndroidKeyStore")
                .apply {
                    init(
                        KeyGenParameterSpec.Builder(
                                "mutter-storage",
                                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                            )
                            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                            .build()
                    )
                }
                .generateKey()
    }
    private var data =
        read("settings")?.let { JSONObject(it.toString(Charsets.UTF_8)) } ?: JSONObject()
    private val mutableSettings =
        MutableStateFlow(readSettings(data.optJSONObject("settings") ?: JSONObject()))
    val settings = mutableSettings.asStateFlow()
    private val mutableServers =
        MutableStateFlow(data.optJSONArray("servers").objects().map(::readServer))
    val servers = mutableServers.asStateFlow()
    private val mutableIdentities =
        MutableStateFlow(
            data.optJSONArray("identities").objects().map {
                IdentityInfo(it.getString("id"), it.getString("name"), it.getString("fingerprint"))
            }
        )
    val identities = mutableIdentities.asStateFlow()

    @Synchronized
    fun saveSettings(value: Settings) {
        persist(nextSettings = value)
    }

    @Synchronized
    fun saveServer(value: Server) {
        require(value.host.isNotBlank() && value.port in 1..65535 && value.username.isNotBlank())
        persist(nextServers = servers.value.filterNot { it.id == value.id } + value)
    }

    @Synchronized
    fun deleteServer(id: String) {
        persist(nextServers = servers.value.filterNot { it.id == id })
    }

    @Synchronized
    fun addIdentity(info: IdentityInfo, bytes: ByteArray) {
        write("identity-${info.id}", bytes)
        persist(nextIdentities = identities.value.filterNot { it.id == info.id } + info)
    }

    fun identity(id: String) = read("identity-$id")

    @Synchronized
    fun deleteIdentity(id: String) {
        require(servers.value.none { it.identity == id }) {
            "This identity is used by a saved server."
        }
        persist(nextIdentities = identities.value.filterNot { it.id == id })
        AtomicFile(File(context.filesDir, "identity-$id.enc")).delete()
    }

    private fun persist(
        nextSettings: Settings = settings.value,
        nextServers: List<Server> = servers.value,
        nextIdentities: List<IdentityInfo> = identities.value,
    ) {
        val updated = JSONObject(data.toString())
        updated.put("servers", JSONArray(nextServers.map { serverJson(it) }))
        updated.put("settings", settingsJson(nextSettings))
        updated.put(
            "identities",
            JSONArray(
                nextIdentities.map {
                    JSONObject()
                        .put("id", it.id)
                        .put("name", it.name)
                        .put("fingerprint", it.fingerprint)
                }
            ),
        )
        write("settings", updated.toString().toByteArray(Charsets.UTF_8))
        data = updated
        mutableSettings.value = nextSettings
        mutableServers.value = nextServers
        mutableIdentities.value = nextIdentities
    }

    private fun read(name: String): ByteArray? {
        val file = AtomicFile(File(context.filesDir, "$name.enc"))
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return null
        val bytes = file.readFully()
        require(bytes.size >= 29) { "Stored data is incomplete" }
        return Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            doFinal(bytes.copyOfRange(12, bytes.size))
        }
    }

    private fun write(name: String, bytes: ByteArray) {
        val cipher =
            Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
        val encrypted = cipher.iv + cipher.doFinal(bytes)
        val file = AtomicFile(File(context.filesDir, "$name.enc"))
        val output = file.startWrite()
        try {
            output.write(encrypted)
            file.finishWrite(output)
        } catch (error: Throwable) {
            file.failWrite(output)
            throw error
        }
    }

    private fun readServer(v: JSONObject) =
        Server(
            v.getString("id"),
            v.optString("name"),
            v.getString("host"),
            v.optInt("port", 64738),
            v.optString("username"),
            v.optString("password"),
            v.optJSONArray("tokens").strings(),
            v.optString("fingerprint"),
            v.optString("identity", "default"),
            v.optBoolean("favorite"),
            v.optLong("lastUsed"),
        )

    private fun serverJson(s: Server) =
        JSONObject()
            .put("id", s.id)
            .put("name", s.name)
            .put("host", s.host)
            .put("port", s.port)
            .put("username", s.username)
            .put("password", s.password)
            .put("tokens", JSONArray(s.tokens))
            .put("fingerprint", s.fingerprint)
            .put("identity", s.identity)
            .put("favorite", s.favorite)
            .put("lastUsed", s.lastUsed)

    private fun readSettings(v: JSONObject) =
        Settings(
            v.optString("theme", "carbon"),
            v.optString("appearance", "system"),
            v.optString("voiceMode", "ptt"),
            v.optInt("bitrate", 40000),
            v.optDouble("threshold", .035).toFloat(),
            v.optBoolean("noiseSuppression", true),
            v.optBoolean("echoCancellation", true),
            v.optBoolean("autoGain", true),
            v.optBoolean("speaker"),
            v.optBoolean("hideEmpty"),
            v.optBoolean("keepAwake"),
            v.optString("stun", "stun:stun.l.google.com:19302"),
            v.optString("turn"),
            v.optString("turnUser"),
            v.optString("turnPassword"),
            v.optString("defaultUsername"),
        )

    private fun settingsJson(v: Settings) =
        JSONObject()
            .put("theme", v.theme)
            .put("appearance", v.appearance)
            .put("voiceMode", v.voiceMode)
            .put("bitrate", v.bitrate)
            .put("threshold", v.threshold)
            .put("noiseSuppression", v.noiseSuppression)
            .put("echoCancellation", v.echoCancellation)
            .put("autoGain", v.autoGain)
            .put("speaker", v.speaker)
            .put("hideEmpty", v.hideEmpty)
            .put("keepAwake", v.keepAwake)
            .put("stun", v.stun)
            .put("turn", v.turn)
            .put("turnUser", v.turnUser)
            .put("turnPassword", v.turnPassword)
            .put("defaultUsername", v.defaultUsername)
}

private fun JSONArray?.objects() =
    if (this == null) emptyList() else (0 until length()).map { getJSONObject(it) }

private fun JSONArray?.strings() =
    if (this == null) emptyList() else (0 until length()).map { getString(it) }
