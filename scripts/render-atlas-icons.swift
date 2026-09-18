import AppKit
import Foundation

private let args = CommandLine.arguments
guard args.count >= 3 else {
  fputs("usage: render-atlas-icons <icons-src-dir> <icons-out-dir>\n", stderr)
  exit(1)
}

let srcDir = URL(fileURLWithPath: args[1])
let outDir = URL(fileURLWithPath: args[2])

struct Spec {
  let svg: String
  let png: String
  let size: CGFloat
}

let specs: [Spec] = [
  Spec(svg: "menubar-idle.svg", png: "menubar-idle.png", size: 36),
  Spec(svg: "menubar-active.svg", png: "menubar-active.png", size: 36),
  Spec(svg: "app-icon.svg", png: "app-icon.png", size: 1024),
]

func renderPng(from svgURL: URL, to pngURL: URL, size: CGFloat) throws {
  guard let source = NSImage(contentsOf: svgURL) else {
    throw NSError(domain: "AtlasIcons", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not load \(svgURL.path)"])
  }

  let target = NSSize(width: size, height: size)
  let rendered = NSImage(size: target)
  rendered.lockFocus()
  NSGraphicsContext.current?.imageInterpolation = .high
  source.draw(in: NSRect(origin: .zero, size: target), from: .zero, operation: .sourceOver, fraction: 1)
  rendered.unlockFocus()

  guard
    let tiff = rendered.tiffRepresentation,
    let rep = NSBitmapImageRep(data: tiff),
    let png = rep.representation(using: .png, properties: [:])
  else {
    throw NSError(domain: "AtlasIcons", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not encode \(pngURL.path)"])
  }

  try png.write(to: pngURL, options: .atomic)
}

try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

for spec in specs {
  let svgURL = srcDir.appendingPathComponent(spec.svg)
  let pngURL = outDir.appendingPathComponent(spec.png)
  try renderPng(from: svgURL, to: pngURL, size: spec.size)
}

let appSvg = srcDir.appendingPathComponent("app-icon.svg")
let appSvgOut = outDir.appendingPathComponent("app-icon.svg")
if FileManager.default.fileExists(atPath: appSvg.path) {
  if FileManager.default.fileExists(atPath: appSvgOut.path) {
    try FileManager.default.removeItem(at: appSvgOut)
  }
  try FileManager.default.copyItem(at: appSvg, to: appSvgOut)
}

for spec in specs {
  let svgURL = srcDir.appendingPathComponent(spec.svg)
  let svgOut = outDir.appendingPathComponent(spec.svg)
  if FileManager.default.fileExists(atPath: svgOut.path) {
    try FileManager.default.removeItem(at: svgOut)
  }
  try FileManager.default.copyItem(at: svgURL, to: svgOut)
}

print("Icons updated in \(outDir.path)")
