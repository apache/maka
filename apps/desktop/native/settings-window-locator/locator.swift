// settings-window-locator — where is the System Settings window?
//
// Electron exposes no API for another application's window geometry, and
// this is the one thing the drag-to-grant card needs that it cannot get
// itself. Hence ~90 lines of Swift and a process spawn.
//
// TWO deliberate choices, both of which the reference implementations get
// wrong or do differently:
//
// 1. CGWindowListCopyWindowInfo, never the Accessibility API. AX would
//    require this app to already be a trusted Accessibility client, which
//    is precisely the permission the card exists to request — a
//    chicken-and-egg. Window *images* need Screen Recording; the window
//    *metadata* read here (bounds, owner pid, layer) needs no TCC grant
//    at all. That is what makes the locator usable before any grant.
//
// 2. Coordinates come back in CoreGraphics space — origin at the top-left
//    of the primary display, y growing downward — and are NOT converted
//    to AppKit's bottom-left space. Electron's `setBounds` is top-left
//    origin, so CG is already the right space. Converting to AppKit (as
//    Alma does, with a comment claiming that is what setBounds wants)
//    puts the card in the right place only when the Settings window
//    happens to be vertically centred, and off by twice the displacement
//    otherwise.
//
// Output is a single line of JSON on stdout. Every failure is a JSON
// object with ok:false, never a crash and never a non-zero exit for an
// expected condition, so the caller can treat parse-failure as "no idea"
// and fall back.

import AppKit
import CoreGraphics
import Foundation

// System Settings kept the System Preferences bundle id across the Ventura
// rename, so one identifier covers both.
let settingsBundleID = "com.apple.systempreferences"

func emit(_ json: String) {
    print(json)
}

func fail(_ reason: String) -> Never {
    emit("{\"ok\":false,\"reason\":\"\(reason)\"}")
    exit(0)
}

// The pid comes from the bundle identifier rather than from
// kCGWindowOwnerName: the owner name is a process name that has already
// changed once (System Preferences -> System Settings) and is a poor
// thing to match on.
guard let app = NSRunningApplication
    .runningApplications(withBundleIdentifier: settingsBundleID)
    .first
else {
    fail("not_running")
}
let pid = app.processIdentifier

guard let windows = CGWindowListCopyWindowInfo(
    [.optionOnScreenOnly, .excludeDesktopElements],
    kCGNullWindowID
) as? [[String: Any]] else {
    fail("window_list_failed")
}

// layer 0 excludes panels, sheets and the shadow/toolbar helper windows
// that share the pid; the size floor drops the small transient ones that
// still report layer 0 while a sheet is animating.
var best: CGRect?
for info in windows {
    guard let owner = info[kCGWindowOwnerPID as String] as? pid_t, owner == pid,
          let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
          let bounds = info[kCGWindowBounds as String] as? [String: CGFloat]
    else { continue }

    let frame = CGRect(
        x: bounds["X"] ?? 0,
        y: bounds["Y"] ?? 0,
        width: bounds["Width"] ?? 0,
        height: bounds["Height"] ?? 0
    )
    guard frame.width > 320, frame.height > 240 else { continue }
    if let current = best, current.width * current.height >= frame.width * frame.height {
        continue
    }
    best = frame
}

guard let frame = best else { fail("no_settings_window") }

// `%.0f` — these feed Electron's setBounds, which takes integers anyway.
emit("""
{"ok":true,"x":\(String(format: "%.0f", frame.minX)),\
"y":\(String(format: "%.0f", frame.minY)),\
"width":\(String(format: "%.0f", frame.width)),\
"height":\(String(format: "%.0f", frame.height))}
""")
