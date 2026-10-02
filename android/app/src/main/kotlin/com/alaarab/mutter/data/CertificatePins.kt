package com.alaarab.mutter.data

enum class CertificateDecision {
    Pinned,
    TrustedByAuthority,
    FirstContact,
    Changed,
}

fun certificateDecision(
    fingerprint: String,
    trustedByAuthority: Boolean,
    knownFingerprints: List<String>,
): CertificateDecision =
    when {
        fingerprint in knownFingerprints -> CertificateDecision.Pinned
        trustedByAuthority -> CertificateDecision.TrustedByAuthority
        knownFingerprints.isEmpty() -> CertificateDecision.FirstContact
        else -> CertificateDecision.Changed
    }

fun Server.sameEndpoint(other: Server) =
    host.trim().equals(other.host.trim(), ignoreCase = true) && port == other.port

fun trustedFingerprints(server: Server, saved: List<Server>): List<String> {
    val sameEndpoint = saved.filter { it.id != server.id && it.sameEndpoint(server) }
    return (listOf(server) + sameEndpoint.sortedByDescending { it.lastUsed })
        .map { it.fingerprint }
        .filter { it.isNotBlank() }
        .distinct()
}

fun withTrustedFingerprint(saved: List<Server>, server: Server, fingerprint: String) =
    saved.map {
        if (it.id == server.id || it.sameEndpoint(server)) it.copy(fingerprint = fingerprint) else it
    }
