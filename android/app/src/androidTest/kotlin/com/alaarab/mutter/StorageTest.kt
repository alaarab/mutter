package com.alaarab.mutter

import android.content.ContextWrapper
import androidx.test.platform.app.InstrumentationRegistry
import com.alaarab.mutter.data.AppStore
import com.alaarab.mutter.data.Identities
import com.alaarab.mutter.data.IdentityInfo
import com.alaarab.mutter.data.Server
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.KeyStore
import java.util.UUID
import javax.net.ssl.X509KeyManager
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

class StorageTest {
    private val target = InstrumentationRegistry.getInstrumentation().targetContext
    private val directory =
        File(target.cacheDir, "storage-test-${UUID.randomUUID()}").apply { mkdirs() }
    private val context =
        object : ContextWrapper(target) {
            override fun getFilesDir() = directory
        }

    @After
    fun cleanup() {
        directory.deleteRecursively()
    }

    @Test
    fun encryptedCredentialsRoundTripAndTamperingIsRejected() {
        val store = AppStore(context)
        val server =
            Server(
                host = "private-test.invalid",
                username = "private-user",
                password = "private-password",
                tokens = listOf("private-token"),
            )
        store.saveServer(server)
        assertEquals(server, AppStore(context).servers.value.single())
        val file = File(directory, "settings.enc")
        val encrypted = file.readBytes()
        for (secret in
            listOf(
                server.host,
                server.username,
                server.password,
                server.tokens.single(),
            )) assertFalse(encrypted.toString(Charsets.ISO_8859_1).contains(secret))
        encrypted[encrypted.lastIndex] = (encrypted.last().toInt() xor 1).toByte()
        file.writeBytes(encrypted)
        assertTrue(
            "Corruption silently reset the saved data",
            runCatching { AppStore(context) }.isFailure,
        )
        assertArrayEquals(encrypted, file.readBytes())
    }

    @Test
    fun failedWritesPreservePublishedStateAndSavedIdentity() {
        val store = AppStore(context)
        val server = Server(host = "example.invalid", username = "Test")
        val identity = IdentityInfo("saved", "Saved", "fingerprint")
        val identityBytes = byteArrayOf(1, 2, 3)
        store.saveServer(server)
        store.addIdentity(identity, identityBytes)
        val settings = store.settings.value
        val file = File(directory, "settings.enc")
        val original = file.readBytes()
        val obstruction = File(directory, "settings.enc.new")
        assertTrue(obstruction.mkdir())
        assertTrue(runCatching { store.saveSettings(settings.copy(theme = "plum")) }.isFailure)
        assertTrue(runCatching { store.saveServer(server.copy(name = "Unsaved")) }.isFailure)
        assertTrue(runCatching { store.deleteServer(server.id) }.isFailure)
        assertTrue(runCatching { store.deleteIdentity(identity.id) }.isFailure)
        assertEquals(settings, store.settings.value)
        assertEquals(listOf(server), store.servers.value)
        assertEquals(listOf(identity), store.identities.value)
        assertArrayEquals(identityBytes, store.identity(identity.id))
        assertArrayEquals(original, file.readBytes())
        assertTrue(obstruction.delete())
        val reopened = AppStore(context)
        assertEquals(settings, reopened.settings.value)
        assertEquals(listOf(server), reopened.servers.value)
        assertEquals(listOf(identity), reopened.identities.value)
        assertArrayEquals(identityBytes, reopened.identity(identity.id))
    }

    @Test
    fun passwordProtectedIdentityImportsAndRetainsItsKey() {
        val store = AppStore(context)
        val identities = Identities(store)
        identities.create("Review, Android", "source")
        val original =
            KeyStore.getInstance("PKCS12").apply {
                load(store.identity("source")!!.inputStream(), charArrayOf())
            }
        val password = "test-import-password".toCharArray()
        val portable =
            KeyStore.getInstance("PKCS12").apply {
                load(null, null)
                setKeyEntry(
                    "portable",
                    original.getKey("mutter", charArrayOf()),
                    password,
                    original.getCertificateChain("mutter"),
                )
            }
        val bytes = ByteArrayOutputStream().also { portable.store(it, password) }.toByteArray()
        assertTrue(
            runCatching { identities.import(bytes, "wrong".toCharArray(), "Wrong") }.isFailure
        )
        assertEquals(1, store.identities.value.size)
        identities.import(bytes, password, "Imported")
        val imported = store.identities.value.single { it.name == "Imported" }
        assertEquals(
            store.identities.value.single { it.id == "source" }.fingerprint,
            imported.fingerprint,
        )
        val manager =
            Identities(AppStore(context))
                .keyManagers(imported.id)
                .filterIsInstance<X509KeyManager>()
                .first()
        val alias = manager.getClientAliases("RSA", null).first()
        assertArrayEquals(
            original.getKey("mutter", charArrayOf()).encoded,
            manager.getPrivateKey(alias).encoded,
        )
    }

    @Test
    fun identityInUseCannotBeDeletedOrSilentlyReplaced() {
        val store = AppStore(context)
        val identities = Identities(store)
        identities.create("Review", "selected")
        val server = Server(host = "example.invalid", username = "Review", identity = "selected")
        store.saveServer(server)
        assertTrue(runCatching { store.deleteIdentity("selected") }.isFailure)
        assertNotNull(store.identity("selected"))
        store.deleteServer(server.id)
        store.deleteIdentity("selected")
        assertTrue(runCatching { identities.keyManagers("selected") }.isFailure)
        assertNull(store.identity("selected"))
    }
}
