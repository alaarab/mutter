package com.alaarab.mutter.data

import java.math.BigInteger
import java.security.KeyPair
import java.security.SecureRandom
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.Date
import org.bouncycastle.asn1.ASN1Integer
import org.bouncycastle.asn1.DERBitString
import org.bouncycastle.asn1.DERNull
import org.bouncycastle.asn1.DERSequence
import org.bouncycastle.asn1.pkcs.PKCSObjectIdentifiers
import org.bouncycastle.asn1.x500.X500NameBuilder
import org.bouncycastle.asn1.x500.style.BCStyle
import org.bouncycastle.asn1.x509.AlgorithmIdentifier
import org.bouncycastle.asn1.x509.SubjectPublicKeyInfo
import org.bouncycastle.asn1.x509.Time
import org.bouncycastle.asn1.x509.V3TBSCertificateGenerator

// Only ASN.1 encoding needs BC. Signing and certificate parsing use the platform,
// avoiding the PKIX dependency and its unrelated EST networking/trust managers.
internal fun identityCertificate(pair: KeyPair, name: String): X509Certificate {
    val subject = X500NameBuilder(BCStyle.INSTANCE).addRDN(BCStyle.CN, name).build()
    val algorithm = AlgorithmIdentifier(PKCSObjectIdentifiers.sha256WithRSAEncryption, DERNull.INSTANCE)
    val now = System.currentTimeMillis()
    val tbs = V3TBSCertificateGenerator().apply {
        setSerialNumber(ASN1Integer(BigInteger(128, SecureRandom()).setBit(0)))
        setIssuer(subject)
        setSubject(subject)
        setStartDate(Time(Date(now - 86_400_000)))
        setEndDate(Time(Date(now + 20L * 365 * 86_400_000)))
        setSignature(algorithm)
        setSubjectPublicKeyInfo(SubjectPublicKeyInfo.getInstance(pair.public.encoded))
    }.generateTBSCertificate()
    val signature = Signature.getInstance("SHA256withRSA").run {
        initSign(pair.private)
        update(tbs.encoded)
        sign()
    }
    val encoded = DERSequence(arrayOf(tbs, algorithm, DERBitString(signature))).encoded
    return CertificateFactory.getInstance("X.509")
        .generateCertificate(encoded.inputStream()) as X509Certificate
}
