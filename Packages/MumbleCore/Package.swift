// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MumbleCore",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        // Pure Swift: wire codec, messages, voice packets, OCB2 crypto. Portable, fully unit tested.
        .library(name: "MumbleProtocol", targets: ["MumbleProtocol"]),
        // Apple platforms only: Network.framework transport, session model, identity, discovery.
        .library(name: "MumbleClient", targets: ["MumbleClient"]),
    ],
    targets: [
        .target(
            name: "MumbleProtocol",
            path: "Sources/MumbleProtocol"
        ),
        .target(
            name: "MumbleClient",
            dependencies: ["MumbleProtocol"],
            path: "Sources/MumbleClient"
        ),
        .testTarget(
            name: "MumbleProtocolTests",
            dependencies: ["MumbleProtocol"],
            path: "Tests/MumbleProtocolTests"
        ),
    ]
)
