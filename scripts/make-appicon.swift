// Renders the Mutter app icon (1024x1024) into the asset catalog.
// The monogram is a custom M whose double arch is a headphone band and
// whose legs end in coral earcups.
// Run: swift scripts/make-appicon.swift
import AppKit

let size: CGFloat = 1024
let outDir = "Mutter/Resources/Assets.xcassets/AppIcon.appiconset"

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
        // Grayscale square; iOS overlays the user's tint.
        ctx.setFillColor(rgb(0x2A2A2A))
        ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))
    } else {
        let bg = CGGradient(colorsSpace: nil,
                            colors: [rgb(0x1C2431), rgb(0x0B0E14)] as CFArray,
                            locations: [0, 1])!
        ctx.drawLinearGradient(bg, start: CGPoint(x: size * 0.3, y: size),
                               end: CGPoint(x: size * 0.6, y: 0),
                               options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        // Soft ice-blue glow rising from below, behind the monogram.
        let glow = CGGradient(colorsSpace: nil,
                              colors: [rgb(0x5B9DD9, 0.35), rgb(0x5B9DD9, 0.0)] as CFArray,
                              locations: [0, 1])!
        ctx.drawRadialGradient(glow, startCenter: CGPoint(x: size / 2, y: size * 0.34), startRadius: 0,
                               endCenter: CGPoint(x: size / 2, y: size * 0.34), endRadius: size * 0.62,
                               options: [])
    }

    // ---- Monogram geometry (origin bottom-left, +y is up) ----
    let leftX: CGFloat = 300, rightX: CGFloat = 724, midX: CGFloat = 512
    let legBottom: CGFloat = 395     // where the band disappears into the cups
    let legTop: CGFloat = 650        // where the legs bend into the arches
    let dipY: CGFloat = 565          // center cusp of the M
    let archControl: CGFloat = 845   // controls the arch height
    let bandWidth: CGFloat = 92

    let band = CGMutablePath()
    band.move(to: CGPoint(x: leftX, y: legBottom))
    band.addLine(to: CGPoint(x: leftX, y: legTop))
    band.addQuadCurve(to: CGPoint(x: midX, y: dipY),
                      control: CGPoint(x: (leftX + midX) / 2, y: archControl))
    band.addQuadCurve(to: CGPoint(x: rightX, y: legTop),
                      control: CGPoint(x: (midX + rightX) / 2, y: archControl))
    band.addLine(to: CGPoint(x: rightX, y: legBottom))

    let cream = tinted ? rgb(0xFFFFFF) : rgb(0xEDF1F6)
    let coral = tinted ? rgb(0xBFBFBF) : rgb(0x5B9DD9)

    ctx.setStrokeColor(cream)
    ctx.setLineWidth(bandWidth)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    ctx.addPath(band)
    ctx.strokePath()

    // Earcups: coral capsules hanging from the ends of the legs.
    let cupW: CGFloat = 148, cupH: CGFloat = 186, cupCorner: CGFloat = 64
    for x in [leftX, rightX] {
        let cup = CGRect(x: x - cupW / 2, y: legBottom - cupH + 36, width: cupW, height: cupH)
        ctx.addPath(CGPath(roundedRect: cup, cornerWidth: cupCorner, cornerHeight: cupCorner, transform: nil))
        ctx.setFillColor(coral)
        ctx.fillPath()
    }

    let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
    let png = rep.representation(using: .png, properties: [:])!
    try! png.write(to: URL(fileURLWithPath: "\(outDir)/\(name).png"))
    print("wrote \(outDir)/\(name).png")
}

render("AppIcon", tinted: false)
render("AppIcon-Dark", tinted: false)
render("AppIcon-Tinted", tinted: true)
