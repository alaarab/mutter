import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(FoundationXML)
import FoundationXML
#endif

/// An entry from the public server directory (https://publist.mumble.info).
public struct PublicServer: Identifiable, Hashable, Codable, Sendable {
    public var id: String { "\(host):\(port)" }
    public var name: String
    public var host: String
    public var port: UInt16
    public var country: String
    public var countryCode: String
    public var continentCode: String
    public var region: String
    public var url: String?

    public var endpoint: ServerEndpoint { ServerEndpoint(host: host, port: port) }
}

public enum PublicServerListError: Error, LocalizedError {
    case badResponse
    public var errorDescription: String? { "The public server list could not be loaded." }
}

/// Fetches and parses the public server directory.
public final class PublicServerList: NSObject, XMLParserDelegate {
    public static let url = URL(string: "https://publist.mumble.info/v1/list")!

    private var servers: [PublicServer] = []

    public static func fetch(session: URLSession = .shared) async throws -> [PublicServer] {
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        request.setValue("Mutter/0.1 (iOS)", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw PublicServerListError.badResponse
        }
        return try parse(data)
    }

    public static func parse(_ data: Data) throws -> [PublicServer] {
        let list = PublicServerList()
        let parser = XMLParser(data: data)
        parser.delegate = list
        guard parser.parse() else { throw PublicServerListError.badResponse }
        return list.servers.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    public func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName qName: String?, attributes: [String: String] = [:]) {
        guard elementName == "server" else { return }
        guard let host = attributes["ip"], !host.isEmpty else { return }
        let port = UInt16(attributes["port"] ?? "") ?? 64738
        servers.append(PublicServer(
            name: attributes["name"] ?? host,
            host: host,
            port: port,
            country: attributes["country"] ?? "",
            countryCode: attributes["countrycode"] ?? "",
            continentCode: attributes["continentcode"] ?? "",
            region: attributes["region"] ?? "",
            url: attributes["url"]
        ))
    }
}
