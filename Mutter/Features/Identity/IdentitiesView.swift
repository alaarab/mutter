import SwiftUI
import UniformTypeIdentifiers
import MumbleClient

struct IdentitiesView: View {
    @Environment(AppModel.self) private var model

    @State private var showCreate = false
    @State private var showImporter = false
    @State private var pendingImport: Data?
    @State private var importPassword = ""
    @State private var showImportPassword = false
    @State private var errorText: String?

    var body: some View {
        @Bindable var settings = model.settings
        List {
            Section {
                Text("A certificate is how Mumble servers recognise you between sessions and let you register a username. Mutter creates one on your device; the private key never leaves the keychain.")
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
            }

            if model.identities.isEmpty {
                Section {
                    Button { showCreate = true } label: { Label("Create a certificate", systemImage: "plus") }
                }
            } else {
                Section {
                    ForEach(model.identities) { identity in
                        Button {
                            settings.defaultIdentityID = identity.id
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: identity.isImported ? "doc.badge.arrow.up" : "person.badge.key.fill")
                                    .frame(width: 32, height: 32)
                                    .foregroundStyle(Theme.accent)
                                    .background(Theme.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(identity.name).font(.display(17)).foregroundStyle(Theme.ink)
                                    Text(identity.commonName).font(.caption).foregroundStyle(Theme.muted)
                                    Text(String(identity.sha1Fingerprint.prefix(20)) + "…")
                                        .font(.system(.caption2, design: .monospaced))
                                        .foregroundStyle(Theme.muted)
                                    if let exp = identity.notAfter {
                                        Text("Expires \(exp.formatted(date: .abbreviated, time: .omitted))")
                                            .font(.caption2)
                                            .foregroundStyle(exp < Date() ? Theme.danger : Theme.muted)
                                    }
                                }
                                Spacer()
                                if settings.defaultIdentityID == identity.id {
                                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.accent)
                                }
                            }
                        }
                        .swipeActions {
                            Button(role: .destructive) {
                                IdentityStore.shared.delete(identity)
                                if settings.defaultIdentityID == identity.id { settings.defaultIdentityID = nil }
                                model.reloadIdentities()
                            } label: { Label("Delete", systemImage: "trash") }
                        }
                    }
                } header: { SectionLabel(text: "Your certificates") } footer: {
                    Text("Tap one to make it the default for new servers.")
                }
            }

            if let errorText {
                Section { Text(errorText).foregroundStyle(Theme.danger).font(.footnote) }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle("Certificates")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { showCreate = true } label: { Label("Create new", systemImage: "plus") }
                    Button { showImporter = true } label: { Label("Import .p12 / .pfx", systemImage: "square.and.arrow.down") }
                } label: { Image(systemName: "plus") }
            }
        }
        .sheet(isPresented: $showCreate) { CreateIdentitySheet() }
        .fileImporter(isPresented: $showImporter, allowedContentTypes: [.pkcs12, .data], allowsMultipleSelection: false) { result in
            switch result {
            case .success(let urls):
                guard let url = urls.first else { return }
                let accessed = url.startAccessingSecurityScopedResource()
                defer { if accessed { url.stopAccessingSecurityScopedResource() } }
                if let data = try? Data(contentsOf: url) {
                    pendingImport = data
                    importPassword = ""
                    showImportPassword = true
                } else {
                    errorText = "Couldn't read that file."
                }
            case .failure(let error):
                errorText = error.localizedDescription
            }
        }
        .alert("Certificate password", isPresented: $showImportPassword) {
            SecureField("Password", text: $importPassword)
            Button("Import") { runImport() }
            Button("Cancel", role: .cancel) { pendingImport = nil }
        } message: {
            Text("Enter the password the .p12 file was exported with.")
        }
    }

    private func runImport() {
        guard let data = pendingImport else { return }
        do {
            let identity = try IdentityStore.shared.importPKCS12(data, password: importPassword, name: "Imported \(Date().formatted(date: .abbreviated, time: .omitted))")
            if model.settings.defaultIdentityID == nil { model.settings.defaultIdentityID = identity.id }
            model.reloadIdentities()
            errorText = nil
        } catch {
            errorText = error.localizedDescription
        }
        pendingImport = nil
    }
}

struct CreateIdentitySheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var email = ""
    @State private var working = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Your name", text: $name)
                    TextField("Email (optional)", text: $email)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } footer: {
                    Text("The name is what servers show for this certificate. Generation takes a couple of seconds.")
                }
                if let errorText { Section { Text(errorText).foregroundStyle(Theme.danger) } }
            }
            .navigationTitle("New certificate")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(working) }
                ToolbarItem(placement: .confirmationAction) {
                    if working {
                        ProgressView()
                    } else {
                        Button("Create") { create() }.disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            .onAppear { if name.isEmpty { name = model.settings.defaultUsername } }
        }
        .presentationDetents([.medium])
        .interactiveDismissDisabled(working)
    }

    private func create() {
        working = true
        let cn = name.trimmingCharacters(in: .whitespaces)
        let mail = email.trimmingCharacters(in: .whitespaces)
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { try IdentityStore.shared.create(name: cn, commonName: cn, email: mail.isEmpty ? nil : mail) }
            DispatchQueue.main.async {
                working = false
                switch result {
                case .success(let identity):
                    if model.settings.defaultIdentityID == nil { model.settings.defaultIdentityID = identity.id }
                    model.reloadIdentities()
                    dismiss()
                case .failure(let error):
                    errorText = error.localizedDescription
                }
            }
        }
    }
}
