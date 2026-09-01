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
                    HStack(spacing: 12) {
                        Image(systemName: isChange ? "exclamationmark.shield.fill" : "checkmark.shield")
                            .font(.system(size: 34))
                            .foregroundStyle(isChange ? Theme.danger : Theme.coral)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(isChange ? "Certificate changed" : "New server certificate")
                                .font(.displayTitle)
                                .foregroundStyle(Theme.ink)
                            Text(isChange
                                 ? "This server's certificate is different from the one you trusted before. Only continue if the admin told you it changed."
                                 : "This server uses a certificate Mutter hasn't seen before. That's normal for a first connection; check the fingerprint with the admin if you're unsure.")
                                .font(.subheadline)
                                .foregroundStyle(Theme.body)
                        }
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        SectionLabel(text: "Issued to")
                        Text(info.subjectSummary).font(.body).foregroundStyle(Theme.ink)
                        if let exp = info.notValidAfter {
                            SectionLabel(text: "Expires")
                            Text(exp.formatted(date: .long, time: .omitted))
                                .foregroundStyle(exp < Date() ? Theme.danger : Theme.ink)
                        }
                        SectionLabel(text: "SHA-256 fingerprint")
                        Text(info.fingerprintDisplay)
                            .font(.system(.footnote, design: .monospaced))
                            .foregroundStyle(Theme.body)
                            .textSelection(.enabled)
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
                    .tint(isChange ? Theme.danger : Theme.coral)
                }
                .padding()
                .background(Theme.background)
            }
        }
        .presentationDetents([.large])
    }
}
