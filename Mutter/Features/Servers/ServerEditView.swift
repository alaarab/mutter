import SwiftUI
import MumbleClient

struct ServerEditView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    private let original: SavedServer?
    @State private var name: String
    @State private var host: String
    @State private var port: String
    @State private var username: String
    @State private var password: String = ""
    @State private var tokens: String
    @State private var identityID: UUID?
    @State private var isFavorite: Bool
    @State private var accentIndex: Int
    @State private var connectAfterSave = false

    init(server: SavedServer?, prefillHost: String? = nil, prefillPort: UInt16? = nil, prefillName: String? = nil) {
        original = server
        _name = State(initialValue: server?.name ?? prefillName ?? "")
        _host = State(initialValue: server?.host ?? prefillHost ?? "")
        _port = State(initialValue: String(server?.port ?? prefillPort ?? 64738))
        _username = State(initialValue: server?.username ?? "")
        _tokens = State(initialValue: server?.tokens.joined(separator: ", ") ?? "")
        _identityID = State(initialValue: server?.identityID)
        _isFavorite = State(initialValue: server?.isFavorite ?? true)
        _accentIndex = State(initialValue: server?.accentIndex ?? Int.random(in: 0..<8))
    }

    private var isValid: Bool {
        !host.trimmingCharacters(in: .whitespaces).isEmpty && UInt16(port) != nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                    TextField("Address", text: $host)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    TextField("Port", text: $port)
                        .keyboardType(.numberPad)
                } header: { SectionLabel(text: "Server") }

                Section {
                    TextField("Username", text: $username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Password (optional)", text: $password)
                    Picker("Certificate", selection: $identityID) {
                        Text("Default").tag(UUID?.none)
                        ForEach(model.identities) { identity in
                            Text(identity.name).tag(UUID?.some(identity.id))
                        }
                    }
                } header: { SectionLabel(text: "You") } footer: {
                    Text("A certificate lets servers recognise you across sessions. Manage them in Settings.")
                }

                Section {
                    TextField("Access tokens, comma separated", text: $tokens)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: { SectionLabel(text: "Access") } footer: {
                    Text("Tokens unlock channels that are restricted by the server admin.")
                }

                Section {
                    Toggle("Favourite", isOn: $isFavorite)
                    HStack {
                        Text("Colour")
                        Spacer()
                        ForEach(0..<Theme.palette.count, id: \.self) { index in
                            Circle()
                                .fill(Theme.color(index: index))
                                .frame(width: 22, height: 22)
                                .overlay(Circle().strokeBorder(Theme.ink, lineWidth: accentIndex == index ? 2 : 0))
                                .onTapGesture { accentIndex = index }
                        }
                    }
                }

                if original != nil {
                    Section {
                        Button(role: .destructive) {
                            if let original { model.servers.remove(original) }
                            dismiss()
                        } label: { Text("Remove server") }
                    }
                }
            }
            .themedList()
            .navigationTitle(original == nil ? "Add server" : "Edit server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Menu {
                        Button("Save") { save(connect: false) }
                        Button("Save & connect") { save(connect: true) }
                    } label: {
                        Text("Save").bold()
                    } primaryAction: {
                        save(connect: false)
                    }
                    .disabled(!isValid)
                }
            }
            .onAppear {
                if let original { password = model.servers.password(for: original) ?? "" }
                if username.isEmpty { username = model.settings.defaultUsername }
            }
        }
    }

    private func save(connect: Bool) {
        var server = original ?? SavedServer(name: "", host: "", username: "")
        server.name = name.trimmingCharacters(in: .whitespaces)
        server.host = host.trimmingCharacters(in: .whitespaces)
        server.port = UInt16(port) ?? 64738
        server.username = username.trimmingCharacters(in: .whitespaces)
        server.tokens = tokens.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        server.identityID = identityID
        server.isFavorite = isFavorite
        server.accentIndex = accentIndex
        if let original, original.host != server.host || original.port != server.port {
            server.certificateFingerprint = nil
        }
        model.servers.upsert(server)
        model.servers.setPassword(password, for: server)
        dismiss()
        if connect { model.connect(server) }
    }
}
