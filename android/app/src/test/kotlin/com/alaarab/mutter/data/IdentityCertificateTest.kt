package com.alaarab.mutter.data

import java.io.ByteArrayOutputStream
import java.security.KeyPairGenerator
import java.security.KeyStore
import javax.net.ssl.KeyManagerFactory
import org.bouncycastle.asn1.x500.X500Name
import org.bouncycastle.asn1.x500.style.BCStyle
import org.junit.Assert.*
import org.junit.Test

class IdentityCertificateTest {
    @Test
    fun identityIsSelfSignedAndSurvivesPasswordlessPkcs12RoundTrip() {
        val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        val name = """ A, B + C = "quoted" \ #é """
        val cert = identityCertificate(pair, name)
        cert.checkValidity()
        cert.verify(pair.public)
        assertEquals(3, cert.version)
        assertTrue(cert.serialNumber.signum() > 0)
        assertEquals(cert.issuerX500Principal, cert.subjectX500Principal)
        assertEquals(name, X500Name.getInstance(cert.subjectX500Principal.encoded)
            .getRDNs(BCStyle.CN).single().first.value.toString())
        val keys = KeyStore.getInstance("PKCS12").apply {
            load(null, null)
            setKeyEntry("mutter", pair.private, charArrayOf(), arrayOf(cert))
        }
        val encoded = ByteArrayOutputStream().also { keys.store(it, charArrayOf()) }.toByteArray()
        val restored = KeyStore.getInstance("PKCS12").apply { load(encoded.inputStream(), charArrayOf()) }
        assertArrayEquals(cert.encoded, restored.getCertificate("mutter").encoded)
        assertArrayEquals(pair.private.encoded, restored.getKey("mutter", charArrayOf()).encoded)
        assertTrue(KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
            .apply { init(restored, charArrayOf()) }.keyManagers.isNotEmpty())
    }
}
