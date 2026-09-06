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

func darkened(_ svg: String) -> String {
    var out = substitute(svg, ##"fill="#F97316""##, ##"fill="#1C0A03""##)
    out = substitute(out, ##"fill="#FFC53D""##, ##"fill="#8A5410""##)
    out = substitute(out, ##"fill="#FF3F63""##, ##"fill="#5E1526""##)
    out = substitute(out, ##"fill="#FF8A2B""##, ##"fill="#73320A""##)
    out = substitute(out, ##"fill="#FFFFFF" opacity=".10""##, ##"fill="#FFFFFF" opacity=".04""##)
    out = substitute(out, ##"stroke="#2B0A06""##, ##"stroke="#FFB65C""##)
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

func write(_ image: CGImage, _ name: String) {
    let rep = NSBitmapImageRep(cgImage: image)
    guard let png = rep.representation(using: .png, properties: [:]) else {
        fail("could not encode \(name).png")
    }
    let path = "\(outDir)/\(name).png"
    try! png.write(to: URL(fileURLWithPath: path))
    print("wrote \(path) (alpha: \(rep.hasAlpha))")
}

guard let source = try? String(contentsOfFile: master, encoding: .utf8) else {
    fail("could not read \(master). Run this from the repository root: swift scripts/make-appicon.swift")
}

let base = squared(source)
let dark = rasterize(darkened(base), "dark")

write(flattened(rasterize(base, "light")), "AppIcon")
write(flattened(dark), "AppIcon-Dark")
write(desaturated(dark), "AppIcon-Tinted")
