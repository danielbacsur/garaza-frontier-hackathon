// Records one workflow for a heatmap: the main display as a video, and the cursor and its clicks as
// a log beside it. Stop with Ctrl+C.
//
//   record <out-dir>
//
// Writes <out-dir>/screen.mov, <out-dir>/cursor.jsonl (one sample per line: wall-clock seconds,
// position in screen points from the bottom left, whether a button is down) and <out-dir>/meta.json
// (the screen's size and the wall-clock time of the video's first frame, to line the two up).
//
// The cursor is polled rather than tapped, so it needs no Accessibility permission; the terminal
// needs Screen Recording permission for ffmpeg to see the screen.

import AppKit
import Foundation

setvbuf(stdout, nil, _IONBF, 0)
signal(SIGPIPE, SIG_IGN)

guard CommandLine.arguments.count == 2 else {
  print("usage: record <out-dir>")
  exit(64)
}

let out = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

guard let screen = NSScreen.screens.first else {
  print("No display found.")
  exit(1)
}
let size = screen.frame.size
let fps = 30

// The video. ffmpeg reports how much it has written on stdout; the earliest "now minus written"
// is when its first frame was taken, since it can only ever lag behind the screen.
let ffmpeg = Process()
ffmpeg.executableURL = URL(fileURLWithPath: "/usr/bin/env")
ffmpeg.arguments = [
  "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
  "-f", "avfoundation", "-capture_cursor", "1", "-framerate", "\(fps)", "-pixel_format", "nv12",
  "-i", "Capture screen 0:none",
  "-c:v", "h264_videotoolbox", "-b:v", "16M",
  "-progress", "pipe:1", "-nostats",
  out.appendingPathComponent("screen.mov").path,
]
let input = Pipe()
let progress = Pipe()
ffmpeg.standardInput = input
ffmpeg.standardOutput = progress

let lock = NSLock()
var videoStart = Double.infinity
var announced = false

progress.fileHandleForReading.readabilityHandler = { handle in
  let now = Date().timeIntervalSince1970
  guard let text = String(data: handle.availableData, encoding: .utf8) else { return }
  for line in text.split(separator: "\n") where line.hasPrefix("out_time_us=") {
    guard let us = Double(line.dropFirst("out_time_us=".count)), us > 0 else { continue }
    lock.lock()
    videoStart = min(videoStart, now - us / 1_000_000)
    let first = !announced
    announced = true
    lock.unlock()
    if first { print("● Recording. Do the workflow, then press Ctrl+C here.") }
  }
}

try ffmpeg.run()
print("Starting the screen capture…")

// The cursor, 120 times a second.
FileManager.default.createFile(atPath: out.appendingPathComponent("cursor.jsonl").path, contents: nil)
let log = try FileHandle(forWritingTo: out.appendingPathComponent("cursor.jsonl"))
let sampler = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "cursor"))
sampler.schedule(deadline: .now(), repeating: .nanoseconds(1_000_000_000 / 120))
sampler.setEventHandler {
  let p = NSEvent.mouseLocation
  let down = NSEvent.pressedMouseButtons & 1
  let line = String(format: "{\"t\":%.4f,\"x\":%.1f,\"y\":%.1f,\"b\":%d}\n", Date().timeIntervalSince1970, p.x, p.y, down)
  log.write(line.data(using: .utf8)!)
}
sampler.resume()

func finish() {
  sampler.cancel()
  try? log.close()
  // Ctrl+C reaches ffmpeg too and it finishes the file itself; "q" covers any other stop.
  try? input.fileHandleForWriting.write(contentsOf: "q".data(using: .utf8)!)
  ffmpeg.waitUntilExit()

  lock.lock()
  let start = videoStart
  lock.unlock()
  guard start.isFinite else {
    print("\nffmpeg never recorded a frame. Give the terminal Screen Recording permission and try again.")
    exit(1)
  }

  let meta: [String: Any] = [
    "videoStart": start,
    "fps": fps,
    "screen": ["width": size.width, "height": size.height, "scale": screen.backingScaleFactor],
    "recordedAt": ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: start)),
  ]
  let data = try! JSONSerialization.data(withJSONObject: meta, options: [.prettyPrinted, .sortedKeys])
  try! data.write(to: out.appendingPathComponent("meta.json"))
  print("\nSaved to \(out.path)")
  exit(0)
}

signal(SIGINT, SIG_IGN)
let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
interrupt.setEventHandler { finish() }
interrupt.resume()

ffmpeg.terminationHandler = { process in
  // ffmpeg stopped on its own (an error, or permission denied): stop too.
  DispatchQueue.main.async { if process.terminationStatus != 0 { finish() } }
}

dispatchMain()
