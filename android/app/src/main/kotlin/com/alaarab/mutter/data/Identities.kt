package com.alaarab.mutter.data

import java.io.ByteArrayOutputStream
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.X509Certificate
import java.util.UUID
import javax.net.ssl.KeyManagerFactory

class Identities(private val store: AppStore) {
    @Synchronized
    fun keyManagers(id: String): Array<javax.net.ssl.KeyManager> {
        if (store.identity(id) == null) {
            require(id == "default") {
                "The selected certificate is missing. Choose an identity in server settings."
            }
            create("Mutter", "default")
        }
        val keys =
            KeyStore.getInstance("PKCS12").apply {
                load(store.identity(id)!!.inputStream(), charArrayOf())
            }
        return KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
            .apply { init(keys, charArrayOf()) }
            .keyManagers
    }

    @Synchronized
    fun create(name: String, id: String = UUID.randomUUID().toString()) {
        val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        val cert = identityCertificate(pair, name)
        val keys =
            KeyStore.getInstance("PKCS12").apply {
                load(null, null)
                setKeyEntry("mutter", pair.private, charArrayOf(), arrayOf(cert))
            }
        save(id, name, keys, cert)
    }

    @Synchronized
    fun import(bytes: ByteArray, password: CharArray, name: String) {
        require(bytes.size <= 2 * 1024 * 1024) { "Certificate file is too large" }
        val original = KeyStore.getInstance("PKCS12").apply { load(bytes.inputStream(), password) }
        val alias =
            original.aliases().toList().firstOrNull { original.isKeyEntry(it) }
                ?: error("No private key found in this certificate")
        val cert = original.getCertificate(alias) as X509Certificate
        val keys =
            KeyStore.getInstance("PKCS12").apply {
                load(null, null)
                setKeyEntry(
                    "mutter",
                    original.getKey(alias, password),
                    charArrayOf(),
                    original.getCertificateChain(alias),
                )
            }
        save(UUID.randomUUID().toString(), name, keys, cert)
    }

    private fun save(id: String, name: String, keys: KeyStore, cert: X509Certificate) {
        val output = ByteArrayOutputStream()
        keys.store(output, charArrayOf())
        store.addIdentity(IdentityInfo(id, name, fingerprint(cert)), output.toByteArray())
    }

    companion object {
        fun fingerprint(cert: X509Certificate) =
            MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString(":") {
                "%02X".format(it)
            }
    }
}
