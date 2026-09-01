import SwiftUI
import PhotosUI
import UIKit

/// Mumble images travel inline as `<img src="data:image/...;base64,...">` inside the text
/// message, capped by the server's `image_message_length`. This shrinks a photo until it fits.
enum ImageMessageEncoder {
    /// Mumble's default when the server doesn't say otherwise.
    static let defaultLimit = 131_072

    static func html(for image: UIImage, limit: Int) -> String? {
        let cap = limit > 0 ? limit : defaultLimit
        var maxDimension: CGFloat = 1280
        while maxDimension >= 240 {
            let scaled = resized(image, maxDimension: maxDimension)
            var quality: CGFloat = 0.85
            while quality >= 0.3 {
                if let data = scaled.jpegData(compressionQuality: quality) {
                    let html = "<img src=\"data:image/jpeg;base64,\(data.base64EncodedString())\" />"
                    if html.utf8.count <= cap { return html }
                }
                quality -= 0.15
            }
            maxDimension = (maxDimension / 1.5).rounded()
        }
        return nil
    }

    private static func resized(_ image: UIImage, maxDimension: CGFloat) -> UIImage {
        let size = image.size
        let longest = max(size.width, size.height)
        guard longest > maxDimension, longest > 0 else { return image }
        let scale = maxDimension / longest
        let target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
    }
}

struct AttachImageButton: View {
    @Binding var selection: PhotosPickerItem?
    var busy: Bool

    var body: some View {
        PhotosPicker(selection: $selection, matching: .images, photoLibrary: .shared()) {
            ZStack {
                if busy {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "photo")
                        .font(.system(size: 18, weight: .medium))
                }
            }
            .frame(width: 34, height: 34)
            .foregroundStyle(Theme.coral)
            .background(Theme.coral.opacity(0.12), in: Circle())
        }
        .disabled(busy)
        .accessibilityLabel("Attach a photo")
    }
}
