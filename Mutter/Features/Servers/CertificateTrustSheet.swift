import SwiftUI
import MumbleClient

struct CertificateTrustSheet: View {
    let prompt: TrustPrompt

    private var info: ServerCertificateInfo {
        switch prompt.question {
        case .firstContact(let i): return i
        case .changed(_, let i): return i
        }
    }

    private var isChange: Bool {
        if case .changed = prompt.question { return true }
        return false
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(alignment: .top, spacing: 14) {
                        ZStack {
                            Circle().fill((isChange ? Theme.danger : Theme.accent).opacity(0.14))
                            Image(systemName: isChange ? "exclamationmark.shield.fill" : "checkmark.shield")
                                .font(.system(size: 24, weight: .medium))
                                .foregroundStyle(isChange ? Theme.danger : Theme.accent)
                        }
                        .frame(width: 48, height: 48)
                        VStack(alignment: .leading, spacing: 6) {
                            Text(isChange ? "Certificate changed" : "New server certificate")
                                .font(.display(24, weight: .medium))
                                .foregroundStyle(Theme.ink)
                                .fixedSize(horizontal: false, vertical: true)
                            Text(isChange
                                 ? "This server's certificate is different from the one you trusted before. Only continue if the admin told you it changed."
                                 : "This server uses a certificate Mutter hasn't seen before. That's normal for a first connection; check the fingerprint with the admin if you're unsure.")
                                .font(.subheadline)
                                .foregroundStyle(Theme.body)
                        }
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        HStack(alignment: .top, spacing: 24) {
                            VStack(alignment: .leading, spacing: 4) {
                                SectionLabel(text: "Issued to")
                                Text(info.subjectSummary).font(.body).foregroundStyle(Theme.ink).lineLimit(2)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            if let exp = info.notValidAfter {
                                VStack(alignment: .leading, spacing: 4) {
                                    SectionLabel(text: "Expires")
                                    Text(exp.formatted(date: .abbreviated, time: .omitted))
                                        .foregroundStyle(exp < Date() ? Theme.danger : Theme.ink)
                                }
                                .fixedSize()
                            }
                        }
                        SectionLabel(text: "SHA-256 fingerprint")
                        Text(info.wrappedFingerprint)
                            .font(.system(size: 12.5, design: .monospaced))
                            .lineSpacing(3)
                            .foregroundStyle(Theme.body)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .card()
                }
                .padding()
            }
            .background(Theme.background)
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) {
                HStack(spacing: 12) {
                    Button(role: .cancel) { prompt.respond(false) } label: {
                        Text("Cancel").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    Button { prompt.respond(true) } label: {
                        Text(isChange ? "Trust anyway" : "Trust & connect").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(isChange ? Theme.danger : Theme.accent)
                }
                .padding()
                .background(Theme.background)
            }
        }
        .presentationDetents([.medium, .large])
    }
}

extension ServerCertificateInfo {
    /// Hex in groups of four, eight groups per line, so it wraps instead of overflowing.
    var wrappedFingerprint: String {
        let hex = sha256Fingerprint.map { String(format: "%02X", $0) }.joined()
        var groups: [String] = []
        var idx = hex.startIndex
        while idx < hex.endIndex {
            let end = hex.index(idx, offsetBy: 4, limitedBy: hex.endIndex) ?? hex.endIndex
            groups.append(String(hex[idx..<end]))
            idx = end
        }
        return stride(from: 0, to: groups.count, by: 8)
            .map { groups[$0..<min($0 + 8, groups.count)].joined(separator: " ") }
            .joined(separator: "\n")
    }
}
