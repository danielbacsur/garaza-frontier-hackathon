// Turns a recording into heatmap overlay frames: one transparent PNG per GIF frame. While the workflow
// plays, the heat shows where the cursor moved lately, older spots fading out, with a tail behind the
// pointer and a ripple where each click lands; over the held end it all dies out. The heat of the whole
// workflow goes to <rec-dir>/summary.png, for a still.
//
//   render <rec-dir> <out-json> --width 960 --fps 12 --speed 1.5 --hold 2.5
//          --start 0 --end <video seconds> --title "…" --app "…" --by "…" --gif /heatmaps/x.gif
//
// Reads cursor.jsonl and meta.json from the recording, writes <rec-dir>/overlay/%05d.png and
// <rec-dir>/summary.png, and the
// recording's manifest (title, stats, GIF path) to <out-json> for the dashboard.

import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

// MARK: Arguments

var positional: [String] = []
var options: [String: String] = [:]
do {
  var args = CommandLine.arguments.dropFirst().makeIterator()
  while let arg = args.next() {
    if arg.hasPrefix("--") { options[String(arg.dropFirst(2))] = args.next() ?? "" } else { positional.append(arg) }
  }
}
guard positional.count == 2 else {
  print("usage: render <rec-dir> <out-json> [--width --fps --speed --hold --start --end --title --app --by --gif]")
  exit(64)
}
let dir = URL(fileURLWithPath: positional[0])
let manifestURL = URL(fileURLWithPath: positional[1])
func number(_ key: String, _ fallback: Double) -> Double { options[key].flatMap(Double.init) ?? fallback }

let outW = Int(number("width", 960))
let fps = number("fps", 12)
let speed = number("speed", 1.5)
let hold = number("hold", 2.5)

struct Meta: Decodable {
  struct Screen: Decodable { let width: Double; let height: Double }
  let videoStart: Double
  let screen: Screen
  let recordedAt: String
  /// Driven by drive.mjs: the screen has no cursor of its own, so the overlay draws one.
  let driven: Bool?
}
let meta = try JSONDecoder().decode(Meta.self, from: Data(contentsOf: dir.appendingPathComponent("meta.json")))
let screenW = meta.screen.width, screenH = meta.screen.height
let outH = Int((Double(outW) * screenH / screenW / 2).rounded()) * 2

let start = number("start", 0)
let end = number("end", .infinity)

// MARK: Samples

/// A cursor sample in video seconds (from the trimmed start) and the unit square, top left origin.
struct Sample { let t: Double; let u: Double; let v: Double; let down: Bool; let x: Double; let y: Double }

/// Seconds the screen shows the pointer after the log has it: capture latency, give or take a frame.
/// Only the tail at full speed shows it.
let lag = number("lag", 0.02)

struct Raw: Decodable { let t: Double; let x: Double; let y: Double; let b: Int }
let lines = try String(contentsOf: dir.appendingPathComponent("cursor.jsonl"), encoding: .utf8).split(separator: "\n")
let decoder = JSONDecoder()
let samples: [Sample] = lines.compactMap { line in
  guard let raw = try? decoder.decode(Raw.self, from: Data(line.utf8)) else { return nil }
  let t = raw.t - meta.videoStart - start + lag
  guard t >= 0, t <= end - start else { return nil }
  return Sample(t: t, u: raw.x / screenW, v: 1 - raw.y / screenH, down: raw.b == 1, x: raw.x, y: raw.y)
}
guard let last = samples.last else {
  print("No cursor samples inside the trimmed range.")
  exit(1)
}
let duration = min(end - start, last.t)

/// A click is the moment the button goes down.
let clicks: [Sample] = zip([nil] + samples.map(Optional.some), samples).compactMap { prev, cur in
  cur.down && !(prev?.down ?? false) ? cur : nil
}

// MARK: Heat

/// The heat is accumulated on a grid a third of the output's size and scaled up smoothly when drawn:
/// all of it for the finished heatmap, and a copy that cools off for the moving one.
let gw = outW / 3, gh = outH / 3
var heat = [Float](repeating: 0, count: gw * gh)
var recent = [Float](repeating: 0, count: gw * gh)

/// Seconds of video for a spot in the moving heatmap to cool to half.
let halfLife = number("half-life", 2.5)
/// The heat that reads as hottest in the moving heatmap: about a click and a short pause. Fixed, so a
/// cooling spot fades away instead of being stretched back up to red.
let scale = Float(number("scale", 1.5))

/// A round Gaussian brush that falls all the way to zero at its rim. Cut off square, or above zero, the
/// curve that lifts faint heat would lift its edge into view.
func kernel(sigma: Double) -> (radius: Int, weights: [Float]) {
  let r = Int((sigma * 4).rounded(.up))
  let rim = exp(-Double(r * r) / (2 * sigma * sigma))
  var w = [Float]()
  for dy in -r...r {
    for dx in -r...r {
      let g = exp(-Double(dx * dx + dy * dy) / (2 * sigma * sigma))
      w.append(Float(max(0, g - rim) / (1 - rim)))
    }
  }
  return (r, w)
}
/// Movement spreads a little wider than a click, so clicks read as the hot cores along the paths.
let moveKernel = kernel(sigma: Double(gw) / 64)
let clickKernel = kernel(sigma: Double(gw) / 90)

func splat(_ s: Sample, _ k: (radius: Int, weights: [Float]), _ amount: Float) {
  let cx = Int(s.u * Double(gw)), cy = Int(s.v * Double(gh))
  let r = k.radius, side = 2 * r + 1
  for dy in -r...r {
    let y = cy + dy
    guard y >= 0, y < gh else { continue }
    for dx in -r...r {
      let x = cx + dx
      guard x >= 0, x < gw else { continue }
      let add = amount * k.weights[(dy + r) * side + (dx + r)]
      heat[y * gw + x] += add
      recent[y * gw + x] += add
    }
  }
}

/// Heat comes from moving, not from resting: every this many points the pointer travels add one unit,
/// the same however fast it went.
let travelPerUnit = number("travel", 150)
/// Units a click counts as.
let clickWeight: Float = 1.2

/// PostHog's ramp: transparent blue at the faintest, through cyan, green and yellow, to red.
let stops: [(Float, (Float, Float, Float, Float))] = [
  (0.00, (59, 91, 219, 0.00)),
  (0.10, (59, 91, 219, 0.30)),
  (0.30, (34, 184, 207, 0.45)),
  (0.50, (64, 192, 87, 0.55)),
  (0.72, (250, 176, 5, 0.66)),
  (1.00, (240, 62, 62, 0.76)),
]
let ramp: [(UInt8, UInt8, UInt8, UInt8)] = (0..<256).map { i in
  let x = Float(i) / 255
  let j = stops.lastIndex { $0.0 <= x }!
  let a = stops[j], b = stops[min(j + 1, stops.count - 1)]
  let f = b.0 > a.0 ? (x - a.0) / (b.0 - a.0) : 0
  let mix = { (p: Float, q: Float) in p + (q - p) * f }
  let alpha = mix(a.1.3, b.1.3)
  // Premultiplied, as the bitmap context expects.
  return (
    UInt8(mix(a.1.0, b.1.0) * alpha), UInt8(mix(a.1.1, b.1.1) * alpha),
    UInt8(mix(a.1.2, b.1.2) * alpha), UInt8(alpha * 255)
  )
}

let space = CGColorSpace(name: CGColorSpace.sRGB)!
let premultiplied = CGImageAlphaInfo.premultipliedLast.rawValue

/// Where a grid's values sit on the ramp, from 0 to 1, against a peak. A curve under 1 lifts the faint
/// trails so the whole path shows, not only the hot spots. It rises steeply from zero, so its first
/// sliver is cut off: edges then fade out instead of ending in a rim.
func levels(_ grid: [Float], peak: Float, curve: Float) -> [Float] {
  grid.map { $0 > 0 ? max(0, (min(1, pow($0 / peak, curve)) - 0.08) / 0.92) : 0 }
}

let steps = Float(number("steps", 0))

/// Levels as an image at the output's size, smoothly upsampled from the grid.
func heatImage(_ levels: [Float]) -> CGImage {
  var pixels = [UInt8](repeating: 0, count: outW * outH * 4)
  let sx = Float(gw) / Float(outW), sy = Float(gh) / Float(outH)
  for y in 0..<outH {
    let gy = max(0, min(Float(gh - 1), (Float(y) + 0.5) * sy - 0.5))
    let y0 = Int(gy), y1 = min(y0 + 1, gh - 1), fy = gy - Float(y0)
    for x in 0..<outW {
      let gx = max(0, min(Float(gw - 1), (Float(x) + 0.5) * sx - 0.5))
      let x0 = Int(gx), x1 = min(x0 + 1, gw - 1), fx = gx - Float(x0)
      let top = levels[y0 * gw + x0] * (1 - fx) + levels[y0 * gw + x1] * fx
      let bottom = levels[y1 * gw + x0] * (1 - fx) + levels[y1 * gw + x1] * fx
      let level = top * (1 - fy) + bottom * fy
      guard level > 0 else { continue }
      // --steps draws it in steps rather than smoothly, for a smaller GIF: as heat cools, a pixel then
      // changes only now and again instead of in every frame.
      let c = ramp[Int((steps > 0 ? (level * steps).rounded() / steps : level) * 255)]
      let i = (y * outW + x) * 4
      pixels[i] = c.0; pixels[i + 1] = c.1; pixels[i + 2] = c.2; pixels[i + 3] = c.3
    }
  }
  let provider = CGDataProvider(data: Data(pixels) as CFData)!
  return CGImage(
    width: outW, height: outH, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: outW * 4, space: space,
    bitmapInfo: CGBitmapInfo(rawValue: premultiplied), provider: provider, decode: nil,
    shouldInterpolate: true, intent: .defaultIntent
  )!
}

// MARK: Frames

let overlay = dir.appendingPathComponent("overlay")
try? FileManager.default.removeItem(at: overlay)
try FileManager.default.createDirectory(at: overlay, withIntermediateDirectories: true)

let accent = CGColor(srgbRed: 112 / 255, green: 112 / 255, blue: 1, alpha: 1)
let rippleLife = 0.7
let drawCursor = meta.driven ?? false

/// The macOS arrow, tip at the origin, y down, in points; scaled with the screen like everything else.
let arrow: [CGPoint] = [(0, 0), (0, 16.5), (3.9, 12.8), (6.6, 19.2), (9.3, 18.1), (6.7, 11.9), (12, 11.9)]
  .map { CGPoint(x: $0.0, y: $0.1) }
let arrowScale = Double(outW) / screenW * 1.25

/// The index of the last sample at or before video time t.
func index(at t: Double) -> Int? {
  var lo = 0, hi = samples.count - 1, found: Int? = nil
  while lo <= hi {
    let mid = (lo + hi) / 2
    if samples[mid].t <= t { found = mid; lo = mid + 1 } else { hi = mid - 1 }
  }
  return found
}

/// Where the pointer is at video time t, between the samples either side of it.
func pointer(at t: Double) -> CGPoint? {
  guard let i = index(at: t) else { return nil }
  let a = samples[i], b = samples[min(i + 1, samples.count - 1)]
  let f = b.t > a.t ? min(1, (t - a.t) / (b.t - a.t)) : 0
  return CGPoint(x: (a.u + (b.u - a.u) * f) * Double(outW), y: (1 - (a.v + (b.v - a.v) * f)) * Double(outH))
}

/// Seconds of video the tail behind the pointer reaches back.
let tailLife = number("tail", 0.9)

/// The pointer's path over the last tailLife seconds, oldest first, in output pixels (CG's origin).
func tail(at t: Double) -> [(p: CGPoint, age: Double)] {
  guard let head = pointer(at: t), let last = index(at: t) else { return [] }
  var points: [(p: CGPoint, age: Double)] = [(head, 0)]
  var i = last
  while i >= 0, t - samples[i].t < tailLife {
    let s = samples[i]
    let p = CGPoint(x: s.u * Double(outW), y: (1 - s.v) * Double(outH))
    // A point every pixel and a half is plenty for a smooth stroke.
    if hypot(p.x - points.last!.p.x, p.y - points.last!.p.y) >= 1.5 { points.append((p, (t - s.t) / tailLife)) }
    i -= 1
  }
  return points.reversed()
}

/// Strokes the tail as short segments, each as wide and opaque as its age allows, so it tapers to nothing.
func stroke(_ points: [(p: CGPoint, age: Double)], in ctx: CGContext, color: CGColor, width: Double, alpha: Double) {
  // Butt ends: overlapping round ones would bead where the translucent segments meet.
  ctx.setLineCap(.butt)
  for (a, b) in zip(points, points.dropFirst()) {
    let fresh = 1 - (a.age + b.age) / 2
    ctx.setStrokeColor(color.copy(alpha: alpha * fresh * fresh)!)
    ctx.setLineWidth(width * (0.25 + 0.75 * fresh))
    ctx.move(to: a.p)
    ctx.addLine(to: b.p)
    ctx.strokePath()
  }
}

let frames = Int(((duration / speed) + hold) * fps)
var next = 0
var nextClick = 0
let cooling = Float(pow(0.5, speed / fps / halfLife))

for k in 0..<frames {
  // The clock runs on past the end of the recording, so the held end lets the heat and the tail die out.
  let clock = Double(k) / fps * speed
  let t = min(clock, duration)

  if k > 0 { for i in 0..<recent.count { recent[i] *= cooling } }

  // Add what the cursor did since the last frame: the way each sample moved on from the one before, and
  // every click.
  while next < samples.count, samples[next].t <= t {
    if next > 0 {
      let a = samples[next - 1], s = samples[next]
      splat(s, moveKernel, Float(hypot(s.x - a.x, s.y - a.y) / travelPerUnit))
    }
    next += 1
  }
  while nextClick < clicks.count, clicks[nextClick].t <= t {
    splat(clicks[nextClick], clickKernel, clickWeight)
    nextClick += 1
  }

  let ctx = CGContext(
    data: nil, width: outW, height: outH, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: premultiplied
  )!
  ctx.interpolationQuality = .high
  // Drawn almost linearly, so it stays calm and a cooling spot simply fades.
  ctx.draw(heatImage(levels(recent, peak: scale, curve: 0.9)), in: CGRect(x: 0, y: 0, width: outW, height: outH))

  // The tail: a white halo under the accent so it reads on light and dark screens alike.
  let points = tail(at: clock)
  stroke(points, in: ctx, color: CGColor(gray: 1, alpha: 1), width: 3.5, alpha: 0.6)
  stroke(points, in: ctx, color: accent, width: 1.75, alpha: 1)

  // Ripples: a ring that widens and fades where each recent click landed (CG's origin is bottom left).
  for c in clicks where c.t <= t && t - c.t < rippleLife {
    let age = (t - c.t) / rippleLife
    let center = CGPoint(x: c.u * Double(outW), y: (1 - c.v) * Double(outH))
    let radius = 5 + age * 22
    let rect = CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
    ctx.setAlpha(1 - age)
    ctx.setLineWidth(3.5)
    ctx.setStrokeColor(CGColor(gray: 1, alpha: 0.9))
    ctx.strokeEllipse(in: rect)
    ctx.setLineWidth(2)
    ctx.setStrokeColor(accent)
    ctx.strokeEllipse(in: rect)
    ctx.setAlpha(1)
  }

  if drawCursor, let tip = pointer(at: t) {
    let path = CGMutablePath()
    path.addLines(between: arrow.map { CGPoint(x: tip.x + $0.x * arrowScale, y: tip.y - $0.y * arrowScale) })
    path.closeSubpath()
    ctx.setShadow(offset: CGSize(width: 0, height: -1), blur: 2, color: CGColor(gray: 0, alpha: 0.35))
    ctx.addPath(path)
    ctx.setFillColor(CGColor(gray: 1, alpha: 1))
    ctx.setStrokeColor(CGColor(gray: 1, alpha: 1))
    ctx.setLineWidth(2.4)
    ctx.setLineJoin(.round)
    ctx.drawPath(using: .fillStroke)
    ctx.setShadow(offset: .zero, blur: 0)
    ctx.addPath(path)
    ctx.setFillColor(CGColor(gray: 0, alpha: 1))
    ctx.fillPath()
  }

  let url = overlay.appendingPathComponent(String(format: "%05d.png", k))
  let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
  CGImageDestinationFinalize(dest)
  if k % 60 == 0 { print("\rframes \(k)/\(frames)", terminator: "") }
}
print("\rframes \(frames)/\(frames)")

// The whole workflow's heat, lifting faint heat so every path shows.
do {
  let whole = levels(heat, peak: max(heat.max() ?? 0, 1.5), curve: 0.55)
  let dest = CGImageDestinationCreateWithURL(
    dir.appendingPathComponent("summary.png") as CFURL, UTType.png.identifier as CFString, 1, nil
  )!
  CGImageDestinationAddImage(dest, heatImage(whole), nil)
  CGImageDestinationFinalize(dest)
}

// MARK: Manifest

let travel = zip(samples, samples.dropFirst()).reduce(0.0) { sum, pair in
  sum + hypot(pair.1.x - pair.0.x, pair.1.y - pair.0.y)
}
let hottest = heat.max() ?? 1
let coverage = Double(heat.filter { $0 > hottest * 0.02 }.count) / Double(heat.count)
let slug = manifestURL.deletingPathExtension().lastPathComponent

let manifest: [String: Any] = [
  "slug": slug,
  "title": options["title"] ?? slug,
  "app": options["app"] ?? "",
  "recordedBy": options["by"] ?? "",
  "recordedAt": meta.recordedAt,
  "durationSec": (duration * 10).rounded() / 10,
  "clicks": clicks.count,
  "travel": travel.rounded(),
  "coverage": (coverage * 1000).rounded() / 1000,
  "width": outW,
  "height": outH,
  "gif": options["gif"] ?? "/heatmaps/\(slug).gif",
  "poster": options["poster"] ?? "/heatmaps/\(slug).png",
]
try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys]).write(to: manifestURL)
print("\(clicks.count) clicks over \(Int(duration))s, \(Int(travel)) pt travelled")
