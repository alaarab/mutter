package com.alaarab.mutter.data

import org.junit.Assert.*
import org.junit.Test

class CertificatePinsTest {
    private val favorite =
        Server(
            host = "voice.example.org",
            port = 64738,
            username = "Ala",
            fingerprint = "AA",
            favorite = true,
            lastUsed = 10,
        )

    @Test
    fun certificatesAreComparedWithThePins() {
        assertEquals(CertificateDecision.Pinned, certificateDecision("AA", listOf("BB", "AA")))
        assertEquals(CertificateDecision.FirstContact, certificateDecision("AA", emptyList()))
        assertEquals(CertificateDecision.Changed, certificateDecision("CC", listOf("AA")))
    }

    @Test
    fun aNewEntryForAPinnedHostInheritsItsPin() {
        val fromDirectory = Server(host = "Voice.Example.org ", port = 64738, username = "Ala")
        assertEquals(listOf("AA"), trustedFingerprints(fromDirectory, listOf(favorite)))
    }

    @Test
    fun anotherPortIsAnotherServer() {
        val otherPort = Server(host = "voice.example.org", port = 64739, username = "Ala")
        assertEquals(emptyList<String>(), trustedFingerprints(otherPort, listOf(favorite)))
    }

    @Test
    fun theEntryOwnPinComesFirstThenTheMostRecentlyUsed() {
        val older = favorite.copy(id = "older", fingerprint = "BB", lastUsed = 1)
        val own = favorite.copy(id = "own", fingerprint = "CC", lastUsed = 0)
        assertEquals(
            listOf("CC", "AA", "BB"),
            trustedFingerprints(own, listOf(older, favorite, own)),
        )
    }

    @Test
    fun trustingACertificateUpdatesEveryEntryForThatEndpoint() {
        val copy = favorite.copy(id = "copy", fingerprint = "")
        val unrelated = Server(host = "other.example.org", username = "Ala", fingerprint = "ZZ")
        val updated = withTrustedFingerprint(listOf(favorite, copy, unrelated), copy, "NEW")
        assertEquals(listOf("NEW", "NEW", "ZZ"), updated.map { it.fingerprint })
    }
}
