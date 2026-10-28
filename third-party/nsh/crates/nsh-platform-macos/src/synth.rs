//! Input as a user's hands give it, made in process: mouse and trackpad
//! events posted to the app as the system posts them, keys, and pictures
//! of the window. The agent of `nsh test --target macos` acts with them
//! ([`crate::agent`]).

use std::rc::Rc;

use objc2::{MainThreadMarker, rc::Retained};
use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType, NSWindow};
use objc2_core_foundation::CGFloat;
use objc2_foundation::{NSPoint, NSString};

use crate::surface::Surface;

/// A point of the content view (points from its top left) in window
/// coordinates (from its bottom left).
pub(crate) fn to_window(window: &NSWindow, x: f64, y: f64) -> NSPoint {
    let height = window.contentView().map_or(0.0, |v| v.frame().size.height);
    NSPoint::new(x as CGFloat, height - y as CGFloat)
}

pub(crate) fn mouse(window: &NSWindow, kind: NSEventType, x: f64, y: f64, clicks: isize) {
    mouse_with(window, kind, x, y, clicks, NSEventModifierFlags::empty());
}

/// A mouse event of `window` at `(x, y)` (content points).
pub(crate) fn mouse_event(
    window: &NSWindow,
    kind: NSEventType,
    x: f64,
    y: f64,
    clicks: isize,
    mods: NSEventModifierFlags,
) -> Option<Retained<NSEvent>> {
    NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        kind,
        to_window(window, x, y),
        mods,
        timestamp(),
        window.windowNumber(),
        None,
        0,
        clicks,
        if clicks > 0 { 1.0 } else { 0.0 },
    )
}

pub(crate) fn mouse_with(
    window: &NSWindow,
    kind: NSEventType,
    x: f64,
    y: f64,
    clicks: isize,
    mods: NSEventModifierFlags,
) {
    if let Some(event) = mouse_event(window, kind, x, y, clicks, mods) {
        // Through the event queue, as real clicks come: the event becomes
        // `NSApp.currentEvent` while it is handled (responders look at it).
        // The run loop handles it before the next step's timer.
        objc2_app_kit::NSApplication::sharedApplication(MainThreadMarker::from(window))
            .postEvent_atStart(&event, false);
    }
}

/// Seconds since the system started, as event timestamps are.
pub(crate) fn timestamp() -> f64 {
    objc2_foundation::NSProcessInfo::processInfo().systemUptime()
}

/// A scroll of `(dx, dy)`: points of a trackpad gesture in `phase` (a
/// `CGScrollPhase`), or lines of a mouse wheel (`None`), in a
/// `CGMomentumScrollPhase` (`0`: none), stamped `at` (seconds since the
/// system started).
#[allow(clippy::too_many_arguments)]
pub(crate) fn wheel_with(
    window: &NSWindow,
    x: f64,
    y: f64,
    dx: i32,
    dy: i32,
    phase: Option<i64>,
    momentum: i64,
    at: f64,
) {
    use objc2_core_graphics::{CGEvent, CGEventField, CGScrollEventUnit};
    // Content follows the fingers (or the wheel), so a positive `dy`
    // (content up) is a negative delta.
    let unit = match phase {
        Some(_) => CGScrollEventUnit::Pixel,
        None => CGScrollEventUnit::Line,
    };
    let Some(event) = CGEvent::new_scroll_wheel_event2(None, unit, 2, -dy, -dx, 0) else {
        return;
    };
    // A window-less event's `locationInWindow` is its screen point, which
    // `sendEvent:` takes as a window point: place it so that they match.
    let p = to_window(window, x, y);
    let main_height = objc2_app_kit::NSScreen::screens(MainThreadMarker::from(window))
        .firstObject()
        .map_or(0.0, |s| s.frame().size.height);
    CGEvent::set_location(
        Some(&event),
        objc2_core_foundation::CGPoint::new(p.x, main_height - p.y),
    );
    if let Some(phase) = phase {
        CGEvent::set_integer_value_field(
            Some(&event),
            CGEventField::ScrollWheelEventScrollPhase,
            phase,
        );
    }
    if momentum != 0 {
        CGEvent::set_integer_value_field(
            Some(&event),
            CGEventField::ScrollWheelEventMomentumPhase,
            momentum,
        );
    }
    // Nanoseconds, as `NSEvent.timestamp` reads it.
    CGEvent::set_timestamp(Some(&event), (at * 1e9) as u64);
    let Some(ns) = NSEvent::eventWithCGEvent(&event) else {
        return;
    };
    if momentum == 0 {
        crate::view::scripted(&ns, || window.sendEvent(&ns));
        return;
    }
    // The window drops synthesized momentum events (the system's go to
    // the view that took the gesture): hand them to the view under the
    // pointer, as AppKit would.
    let view = window.contentView().and_then(|content| {
        let local = content.convertPoint_fromView(ns.locationInWindow(), None);
        // SAFETY: a superview's point, as hitTest: takes.
        let outer = unsafe { content.superview() };
        let p = outer.map_or(local, |o| {
            o.convertPoint_fromView(ns.locationInWindow(), None)
        });
        content.hitTest(p)
    });
    if let Some(view) = view {
        crate::view::scripted(&ns, || view.scrollWheel(&ns));
    }
}

pub(crate) fn type_text(surface: &Rc<Surface>, window: &NSWindow, text: &str) {
    for c in text.chars() {
        let s = c.to_string();
        key_event(surface, window, &s, 0, NSEventModifierFlags::empty());
    }
}

/// One modifier's flag.
pub(crate) fn modifier(name: &str) -> Option<NSEventModifierFlags> {
    Some(match name {
        "cmd" => NSEventModifierFlags::Command,
        "shift" => NSEventModifierFlags::Shift,
        "alt" => NSEventModifierFlags::Option,
        "ctrl" => NSEventModifierFlags::Control,
        _ => return None,
    })
}

pub(crate) fn key(surface: &Rc<Surface>, window: &NSWindow, name: &str) {
    let mut flags = NSEventModifierFlags::empty();
    let mut name = name;
    // `cmd++` is Command and `+`.
    while let Some((m, rest)) = name.split_once('+').filter(|(_, r)| !r.is_empty()) {
        let Some(flag) = modifier(m) else { break };
        flags |= flag;
        name = rest;
    }
    // (characters, virtual key code)
    let (chars, code): (String, u16) = match name {
        "Return" => ("\r".into(), 36),
        "Escape" => ("\u{1b}".into(), 53),
        // Shift+Tab types a backtab, which is what field editors read.
        "Tab" if flags.contains(NSEventModifierFlags::Shift) => ("\u{19}".into(), 48),
        "Tab" => ("\t".into(), 48),
        "BackSpace" => ("\u{7f}".into(), 51),
        "space" => (" ".into(), 49),
        "Up" => ("\u{f700}".into(), 126),
        "Down" => ("\u{f701}".into(), 125),
        "Left" => ("\u{f702}".into(), 123),
        "Right" => ("\u{f703}".into(), 124),
        "Page_Up" => ("\u{f72c}".into(), 116),
        "Page_Down" => ("\u{f72d}".into(), 121),
        "Home" => ("\u{f729}".into(), 115),
        "End" => ("\u{f72b}".into(), 119),
        "Delete" => ("\u{f728}".into(), 117),
        // F1 to F12 (`F5`).
        f if f.len() > 1
            && f.starts_with('F')
            && let Some(n) = f[1..].parse::<u16>().ok().filter(|n| (1..=12).contains(n)) =>
        {
            const CODES: [u16; 12] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111];
            let c = char::from_u32(0xf703 + u32::from(n)).unwrap_or('\0');
            (c.to_string(), CODES[usize::from(n - 1)])
        }
        // Shift types the shifted character, which menus' key
        // equivalents match (`cmd+shift+z` is Redo's `Z`). A character's
        // key is the US layout's, as a real event's would be.
        other => {
            let mut chars = other.chars();
            let code = match (chars.next(), chars.next()) {
                (Some(c), None) => crate::input::us_key_code(c).unwrap_or(0),
                _ => 0,
            };
            if flags.contains(NSEventModifierFlags::Shift) {
                (other.to_uppercase(), code)
            } else {
                (other.into(), code)
            }
        }
    };
    key_event(surface, window, &chars, code, flags);
}

pub(crate) fn key_event(
    surface: &Rc<Surface>,
    window: &NSWindow,
    chars: &str,
    code: u16,
    flags: NSEventModifierFlags,
) {
    let s = NSString::from_str(chars);
    for kind in [NSEventType::KeyDown, NSEventType::KeyUp] {
        let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
            kind,
            NSPoint::new(0.0, 0.0),
            flags,
            timestamp(),
            window.windowNumber(),
            None,
            &s,
            &s,
            false,
            code,
        );
        let Some(event) = event else { continue };
        // Key equivalents (menus) and key monitors (`nsh/keymap`) are the
        // application's, which hands the key to its key window.
        if window.isKeyWindow() || flags.contains(NSEventModifierFlags::Command) {
            objc2_app_kit::NSApplication::sharedApplication(MainThreadMarker::from(window))
                .sendEvent(&event);
        } else if kind == NSEventType::KeyDown && crate::keymap::fires(surface, &event) {
            // The app's key monitor never sees a window's own events: it
            // gets the key first, as it would in the key window (the test
            // window often is not one, its app left in the background).
        } else {
            window.sendEvent(&event);
        }
    }
}

/// Renders the window's content into a PNG (in process: no Screen
/// Recording permission, and it works while the screen is locked).
pub(crate) fn shot(window: &NSWindow) -> Result<Vec<u8>, String> {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRepPropertyKey};
    use objc2_foundation::NSDictionary;
    let view = window.contentView().ok_or("the window has no content")?;
    if let Some(layer) = view.layer() {
        crate::surface::quiet(|| order_by_z(&layer));
    }
    let bounds = view.bounds();
    let rep = view
        .bitmapImageRepForCachingDisplayInRect(bounds)
        .ok_or("cannot make a bitmap of the window")?;
    view.cacheDisplayInRect_toBitmapImageRep(bounds, &rep);
    let properties = NSDictionary::<NSBitmapImageRepPropertyKey, objc2::runtime::AnyObject>::new();
    // SAFETY: an empty property dictionary is valid for PNG.
    let data =
        unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties) };
    Ok(data.ok_or("cannot encode the picture")?.to_vec())
}

/// Orders the sublayers of `layer` and its sublayers by their `zPosition`
/// (keeping their order where it is equal), as Core Animation composites
/// them: `cacheDisplayInRect:` draws sublayers in their order and ignores
/// `zPosition`, so a decoration added before a layer it is above (a
/// border's stroke before a gradient) would look covered in the shot. The
/// window looks the same either way.
pub(crate) fn order_by_z(layer: &objc2_quartz_core::CALayer) {
    // SAFETY: the main thread reads the layer tree, which nothing else
    // changes meanwhile.
    let Some(sublayers) = (unsafe { layer.sublayers() }) else {
        return;
    };
    let layers: Vec<Retained<objc2_quartz_core::CALayer>> = sublayers.to_vec();
    let sorted = layers
        .windows(2)
        .all(|w| w[0].zPosition() <= w[1].zPosition());
    if !sorted {
        let mut by_z = layers.clone();
        by_z.sort_by(|a, b| a.zPosition().total_cmp(&b.zPosition()));
        for (i, l) in by_z.iter().enumerate() {
            layer.insertSublayer_atIndex(l, i as u32);
        }
    }
    for l in &layers {
        order_by_z(l);
    }
}
