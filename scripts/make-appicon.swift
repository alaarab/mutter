// Renders the Mutter app icon (1024x1024) into the asset catalog.
// The monogram is set in the app's own display face (Bricolage Display ExtraBold),
// so the icon and the UI speak with the same voice.
// Run: swift scripts/make-appicon.swift
import AppKit
import CoreText

let size: CGFloat = 1024
let fontDir = "Mutter/Resources/Fonts"
let outDir = "Mutter/Resources/Assets.xcassets/AppIcon.appiconset"

// Register the bundled face so the script can set type in it without installing it.
let fontURL = URL(fileURLWithPath: "\(fontDir)/BricolageDisplay-ExtraBold.ttf")
CTFontManagerRegisterFontsForURL(fontURL as CFURL, .process, nil)

func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
}

func render(_ name: String, tinted: Bool) {
    let ctx = CGContext(data: nil, width: Int(size), height: Int(size),
                        bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!

    if tinted {
        ctx.setFillColor(rgb(0x1A1A1A))
        ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))
    } else {
        // A near-black ground, tinted toward the accent rather than neutral grey, so the
        // lit keycap reads as an object sitting on a surface.
        let bg = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                            colors: [rgb(0x1B2740), rgb(0x0E1626), rgb(0x060A12)] as CFArray,
                            locations: [0, 0.55, 1])!
        ctx.drawLinearGradient(bg, start: CGPoint(x: size * 0.15, y: size * 0.98),
                               end: CGPoint(x: size * 0.85, y: size * 0.04),
                               options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        // The glow the cap throws onto the surface behind it.
        let glow = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                              colors: [rgb(0x3D9BFF, 0.34), rgb(0x3D9BFF, 0.0)] as CFArray,
                              locations: [0, 1])!
        ctx.drawRadialGradient(glow, startCenter: CGPoint(x: size * 0.5, y: size * 0.52), startRadius: 0,
                               endCenter: CGPoint(x: size * 0.5, y: size * 0.52), endRadius: size * 0.62,
                               options: [])
    }

    // A push-to-talk keycap: the one gesture this app is built around, drawn as something
    // you want to press. The shell sits below the top face, so the cap has real thickness.
    let cap = CGRect(x: size * 0.185, y: size * 0.175, width: size * 0.63, height: size * 0.60)
    let radius = size * 0.175
    let shell = CGPath(roundedRect: cap, cornerWidth: radius, cornerHeight: radius, transform: nil)

    ctx.saveGState()
    if !tinted { ctx.setShadow(offset: CGSize(width: 0, height: -22), blur: 52, color: rgb(0x02060F, 0.55)) }
    ctx.addPath(shell)
    ctx.setFillColor(tinted ? rgb(0xB0B0B0) : rgb(0x123A73))
    ctx.fillPath()
    ctx.restoreGState()

    // Top face, lifted off the shell — the gap along the bottom edge is the cap's height.
    let face = cap.insetBy(dx: size * 0.030, dy: size * 0.030).offsetBy(dx: 0, dy: size * 0.042)
    let faceRadius = radius - size * 0.026
    ctx.saveGState()
    ctx.addPath(CGPath(roundedRect: face, cornerWidth: faceRadius, cornerHeight: faceRadius, transform: nil))
    ctx.clip()
    if tinted {
        ctx.setFillColor(rgb(0xFFFFFF))
        ctx.fill(face)
    } else {
        let top = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                             colors: [rgb(0x63B6FF), rgb(0x2F7BE8), rgb(0x2361C4)] as CFArray,
                             locations: [0, 0.55, 1])!
        ctx.drawLinearGradient(top, start: CGPoint(x: face.midX, y: face.maxY),
                               end: CGPoint(x: face.midX, y: face.minY),
                               options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    }
    ctx.restoreGState()

    // The monogram, knocked out of the cap so the shell reads through it.
    let font = CTFontCreateWithName("BricolageDisplay-ExtraBold" as CFString, 430, nil)
    let glyph = CTFontGetGlyphWithName(font, "M" as CFString)
    guard let letter = CTFontCreatePathForGlyph(font, glyph, nil) else { return }
    let bounds = letter.boundingBoxOfPath
    // Optically centred on the glyph's ink, on the face it actually sits on.
    var place = CGAffineTransform(translationX: face.midX - bounds.width / 2 - bounds.minX,
                                  y: face.midY - bounds.height / 2 - bounds.minY)
    let centred = letter.copy(using: &place)!

    ctx.saveGState()
    ctx.addPath(centred)
    ctx.setFillColor(tinted ? rgb(0x1A1A1A) : rgb(0xF7FBFF))
    ctx.fillPath()
    ctx.restoreGState()

    let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
    try! rep.representation(using: .png, properties: [:])!
        .write(to: URL(fileURLWithPath: "\(outDir)/\(name).png"))
    print("wrote \(outDir)/\(name).png")

}

render("AppIcon", tinted: false)
render("AppIcon-Dark", tinted: false)
render("AppIcon-Tinted", tinted: true)
