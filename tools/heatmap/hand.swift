// A person's hand on this Mac's real mouse and keyboard, for performing a workflow while record.sh
// records it: the same motion as human.mjs (a slight curve, minimum-jerk speed, an overshoot on long
// reaches, a resting drift), posted as system events. Needs Accessibility permission.
//
//   hand <script>      one command per line; "-" reads them from stdin
//
// Commands, in screen points from the top left (as screenshots show them):
//   move X Y             glide to a point
//   click X Y            glide there, settle, click
//   dclick X Y           glide there, double-click
//   rest MS              hold still (with drift) for a while
//   type TEXT            type the rest of the line, a key at a time
//   key COMBO            press a key, e.g. return, tab, esc, down, cmd+l, cmd+v, shift+tab
//   scroll DY            scroll by DY lines at the pointer (negative is down)
//   # …                  a comment

import AppKit
import Foundation

setvbuf(stdout, nil, _IONBF, 0)

func rand(_ lo: Double, _ hi: Double) -> Double { Double.random(in: lo...hi) }
func sleep(ms: Double) { usleep(useconds_t(max(0, ms) * 1000)) }
func now() -> Double { Date().timeIntervalSince1970 }

var position: CGPoint { CGEvent(source: nil)?.location ?? .zero }

// Every event says which modifiers are down; left to the system, a ⌘ from a shortcut sticks to the
// keys typed after it.
func post(_ type: CGEventType, _ p: CGPoint, clicks: Int64 = 1) {
  let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left)!
  event.flags = []
  event.setIntegerValueField(.mouseEventClickState, value: clicks)
  event.post(tap: .cghidEventTap)
}

/// Minimum-jerk easing: how a hand's speed rises and falls over one reach.
func ease(_ t: Double) -> Double { t * t * t * (10 - 15 * t + 6 * t * t) }

func glide(to target: CGPoint, ms: Double) {
  let from = position
  let d = hypot(target.x - from.x, target.y - from.y)
  let bend = rand(0.06, 0.18) * d * (Bool.random() ? -1 : 1)
  let control = CGPoint(
    x: (from.x + target.x) / 2 - (target.y - from.y) / max(d, 1) * bend,
    y: (from.y + target.y) / 2 + (target.x - from.x) / max(d, 1) * bend
  )
  let start = now()
  while true {
    let t = min(1, (now() - start) * 1000 / ms)
    let s = ease(t)
    let p = CGPoint(
      x: (1 - s) * (1 - s) * from.x + 2 * (1 - s) * s * control.x + s * s * target.x,
      y: (1 - s) * (1 - s) * from.y + 2 * (1 - s) * s * control.y + s * s * target.y
    )
    post(.mouseMoved, p)
    if t >= 1 { break }
    sleep(ms: 8)
  }
}

/// Longer reaches take longer (Fitts), and the long ones overshoot a touch and correct.
func move(to target: CGPoint) {
  let from = position
  let d = hypot(target.x - from.x, target.y - from.y)
  guard d >= 2 else { return }
  let ms = (180 + 110 * log2(1 + d / 24)) * rand(0.85, 1.2)
  if d > 280 {
    let over = rand(0.025, 0.05)
    glide(to: CGPoint(x: target.x + (target.x - from.x) * over, y: target.y + (target.y - from.y) * over), ms: ms)
    glide(to: target, ms: rand(110, 190))
  } else {
    glide(to: target, ms: ms)
  }
}

/// Hold still, with the slight drift of a hand that isn't moving.
func rest(ms: Double) {
  let origin = position
  let start = now()
  while (now() - start) * 1000 < ms {
    let e = (now() - start) * 1000
    post(.mouseMoved, CGPoint(x: origin.x + sin(e / 420) * 0.8, y: origin.y + cos(e / 530) * 0.6))
    sleep(ms: 40)
  }
  post(.mouseMoved, origin)
}

func click(at target: CGPoint, count: Int = 1) {
  move(to: target)
  rest(ms: rand(120, 300))
  for n in 1...count {
    post(.leftMouseDown, target, clicks: Int64(n))
    sleep(ms: rand(70, 110))
    post(.leftMouseUp, target, clicks: Int64(n))
    if n < count { sleep(ms: rand(60, 90)) }
  }
  rest(ms: rand(250, 550))
}

/// Virtual key codes for the keys a workflow needs (US layout).
let keys: [String: CGKeyCode] = [
  "return": 36, "tab": 48, "space": 49, "delete": 51, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
  "a": 0, "c": 8, "l": 37, "n": 45, "t": 17, "v": 9, "w": 13, "z": 6,
]

func press(_ combo: String) {
  let parts = combo.lowercased().split(separator: "+").map(String.init)
  var flags: CGEventFlags = []
  for mod in parts.dropLast() {
    switch mod {
    case "cmd": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "alt", "opt": flags.insert(.maskAlternate)
    case "ctrl": flags.insert(.maskControl)
    default: break
    }
  }
  guard let code = keys[parts.last!] else {
    print("unknown key \(combo)")
    return
  }
  for down in [true, false] {
    let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)!
    event.flags = down ? flags : []
    event.post(tap: .cghidEventTap)
    sleep(ms: down ? rand(40, 70) : 0)
  }
  sleep(ms: rand(120, 220))
}

func type(_ text: String) {
  for ch in text {
    var units = Array(String(ch).utf16)
    for down in [true, false] {
      let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)!
      event.flags = []
      event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
      event.post(tap: .cghidEventTap)
    }
    sleep(ms: rand(45, 120))
  }
}

func scroll(_ lines: Int32) {
  // A wheel turns a notch at a time.
  for _ in 0..<abs(lines) {
    let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: lines > 0 ? 1 : -1, wheel2: 0, wheel3: 0)!
    event.flags = []
    event.post(tap: .cghidEventTap)
    sleep(ms: rand(25, 45))
  }
  rest(ms: rand(200, 400))
}

func run(_ line: String) {
  let trimmed = line.trimmingCharacters(in: .whitespaces)
  guard !trimmed.isEmpty, !trimmed.hasPrefix("#") else { return }
  let parts = trimmed.split(separator: " ", maxSplits: 1).map(String.init)
  let args = parts.count > 1 ? parts[1] : ""
  let numbers = args.split(separator: " ").compactMap { Double($0) }
  switch parts[0] {
  case "move": move(to: CGPoint(x: numbers[0], y: numbers[1]))
  case "click": click(at: CGPoint(x: numbers[0], y: numbers[1]))
  case "dclick": click(at: CGPoint(x: numbers[0], y: numbers[1]), count: 2)
  case "rest": rest(ms: numbers[0])
  case "type": type(args)
  case "key": press(args)
  case "scroll": scroll(Int32(numbers[0]))
  default: print("unknown command: \(trimmed)")
  }
}

guard CommandLine.arguments.count == 2 else {
  print("usage: hand <script | ->")
  exit(64)
}
let source = CommandLine.arguments[1] == "-"
  ? AnyIterator { readLine() }
  : AnyIterator((try! String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)).split(separator: "\n").map(String.init).makeIterator())
for line in source { run(line) }
