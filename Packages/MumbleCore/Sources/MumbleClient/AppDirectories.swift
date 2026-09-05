import Foundation

public enum AppDirectories {
    public static var support: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Mutter", isDirectory: true)
    }
}
