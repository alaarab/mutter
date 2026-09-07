import AppKit

let side = 1024
let master = "docs/brand/icon.svg"
let outDir = "Mutter/Resources/Assets.xcassets/AppIcon.appiconset"

let fullRect = CGRect(x: 0, y: 0, width: side, height: side)
let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("make-appicon: \(message)\n".utf8))
    exit(1)
}

func substitute(_ svg: String, _ token: String, _ replacement: String) -> String {
    guard svg.contains(token) else {
        fail("\(master) no longer contains \(token). The mark changed shape; update this script to match rather than shipping a stale icon.")
    }
    return svg.replacingOccurrences(of: token, with: replacement)
}

func squared(_ svg: String) -> String {
    let rim = ##"<rect x="1.5" y="1.5" width="509" height="509" rx="112.5" fill="none" stroke="url(#rim-v2)" stroke-width="3"/>"##
    var out = substitute(svg, ##"<rect width="512" height="512" rx="114"/>"##,
                              ##"<rect width="512" height="512"/>"##)
    out = substitute(out, rim, "")
    return out
}

func rasterize(_ svg: String, _ label: String) -> CGImage {
    let dir = URL(fileURLWithPath: NSTemporaryDirectory())
    let svgURL = dir.appendingPathComponent("mutter-icon-\(label).svg")
    let pngURL = dir.appendingPathComponent("mutter-icon-\(label).png")
    try! svg.write(to: svgURL, atomically: true, encoding: .utf8)

    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    task.arguments = ["resvg", "--width", "\(side)", "--height", "\(side)",
                      svgURL.path, pngURL.path]
    do {
        try task.run()
    } catch {
        fail("could not launch resvg. Install it with: brew install resvg")
    }
    task.waitUntilExit()
    guard task.terminationStatus == 0 else {
        fail("resvg failed on the \(label) variant (exit \(task.terminationStatus)). Install it with: brew install resvg")
    }

    guard let data = NSData(contentsOf: pngURL),
          let source = CGImageSourceCreateWithData(data, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        fail("resvg produced no readable PNG for the \(label) variant")
    }
    try? FileManager.default.removeItem(at: svgURL)
    try? FileManager.default.removeItem(at: pngURL)
    return image
}

func opaqueContext() -> CGContext {
    CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0,
              space: sRGB, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
}

func flattened(_ image: CGImage) -> CGImage {
    let ctx = opaqueContext()
    ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
    ctx.fill(fullRect)
    ctx.draw(image, in: fullRect)
    return ctx.makeImage()!
}

func desaturated(_ image: CGImage) -> CGImage {
    let gray = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0,
                         space: CGColorSpaceCreateDeviceGray(),
                         bitmapInfo: CGImageAlphaInfo.none.rawValue)!
    gray.draw(image, in: fullRect)
    let luminance = gray.makeImage()!

    let ctx = opaqueContext()
    ctx.draw(luminance, in: fullRect)
    return ctx.makeImage()!
}

func write(_ image: CGImage, to path: String) {
    let rep = NSBitmapImageRep(cgImage: image)
    guard let png = rep.representation(using: .png, properties: [:]) else {
        fail("could not encode \(path)")
    }
    try! png.write(to: URL(fileURLWithPath: path))
    print("wrote \(path) (alpha: \(rep.hasAlpha))")
}

guard let source = try? String(contentsOfFile: master, encoding: .utf8) else {
    fail("could not read \(master). Run this from the repository root: swift scripts/make-appicon.swift")
}

let base = squared(source)
// The graphite master is designed for both appearances; do not recolor its palette here.
let icon = flattened(rasterize(base, "ios"))
write(icon, to: "\(outDir)/AppIcon.png")
write(icon, to: "\(outDir)/AppIcon-Dark.png")
write(desaturated(icon), to: "\(outDir)/AppIcon-Tinted.png")

let desktop = rasterize(source, "desktop")
write(desktop, to: "desktop/build/icon.png")
let small = CGContext(data: nil, width: 256, height: 256, bitsPerComponent: 8, bytesPerRow: 0,
                      space: sRGB, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
small.interpolationQuality = .high
small.draw(desktop, in: CGRect(x: 0, y: 0, width: 256, height: 256))
write(small.makeImage()!, to: "desktop/build/icon-256.png")
try source.write(toFile: "web/app/icon.svg", atomically: true, encoding: .utf8)

guard let pathRange = source.range(of: #"<path\s[^>]+/>"#, options: .regularExpression) else {
    fail("the master needs a path for the in-app mark")
}
let markPath = String(source[pathRange]).replacingOccurrences(of: #"stroke="[^"]+""#, with: #"stroke="currentColor""#, options: .regularExpression)
let mark = #"<svg viewBox="0 0 512 512" aria-hidden="true">"# + markPath + "</svg>"
let encoded = try JSONSerialization.data(withJSONObject: mark, options: [.fragmentsAllowed, .withoutEscapingSlashes])
let module = "// Generated from docs/brand/icon.svg by scripts/make-appicon.swift.\nexport const MARK = " + String(decoding: encoded, as: UTF8.self) + ";\n"
try module.write(toFile: "web/app/brand.js", atomically: true, encoding: .utf8)
