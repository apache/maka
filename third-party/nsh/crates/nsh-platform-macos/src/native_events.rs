//! Input as a user's hands give it, made in process: mouse and trackpad
//! events posted to the app as the system posts them, keys, and pictures
//! of the window, shared by embedded and development hosts.

#[cfg(feature = "dev")]
use std::rc::Rc;

use objc2::{MainThreadMarker, rc::Retained};
use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType, NSWindow};
use objc2_core_foundation::CGFloat;
use objc2_foundation::NSPoint;
#[cfg(feature = "dev")]
use objc2_foundation::NSString;

#[cfg(feature = "dev")]
use crate::surface::Surface;

/// A point of the content view (points from its top left) in window
/// coordinates (from its bottom left).
pub(crate) fn to_window(window: &NSWindow, x: f64, y: f64) -> NSPoint {
    let height = window.contentView().map_or(0.0, |v| v.frame().size.height);
    NSPoint::new(x as CGFloat, height - y as CGFloat)
}

#[cfg(feature = "dev")]
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

#[cfg(feature = "dev")]
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
    flags: NSEventModifierFlags,
) {
    // A window-less event's location is a screen point. Place it so AppKit's
    // window dispatch interprets it as the content's window coordinate.
    let p = to_window(window, x, y);
    let main_height = objc2_app_kit::NSScreen::screens(MainThreadMarker::from(window))
        .firstObject()
        .map_or(0.0, |s| s.frame().size.height);
    let location = objc2_core_foundation::CGPoint::new(p.x, main_height - p.y);
    let Some(event) = wheel_event(dx, dy, phase, momentum, at, flags, location) else {
        return;
    };
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

/// Builds a Core Graphics event without touching AppKit, a window or global input.
fn wheel_event(
    dx: i32,
    dy: i32,
    phase: Option<i64>,
    momentum: i64,
    at: f64,
    flags: NSEventModifierFlags,
    location: objc2_core_foundation::CGPoint,
) -> Option<objc2_core_foundation::CFRetained<objc2_core_graphics::CGEvent>> {
    use objc2_core_graphics::{CGEvent, CGEventField, CGEventFlags, CGScrollEventUnit};
    let unit = if phase.is_some() {
        CGScrollEventUnit::Pixel
    } else {
        CGScrollEventUnit::Line
    };
    // Content follows the fingers, opposite to the native scroll delta.
    let event = CGEvent::new_scroll_wheel_event2(None, unit, 2, -dy, -dx, 0)?;
    // AppKit's device-independent modifier bits are the Core Graphics event flags.
    // Set even an empty mask: the synthetic event must not inherit physical keys.
    CGEvent::set_flags(Some(&event), CGEventFlags(flags.bits() as u64));
    CGEvent::set_location(Some(&event), location);
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
    CGEvent::set_timestamp(Some(&event), (at * 1e9) as u64);
    Some(event)
}

#[cfg(feature = "dev")]
pub(crate) fn type_text(surface: &Rc<Surface>, window: &NSWindow, text: &str) {
    for c in text.chars() {
        let s = c.to_string();
        key_event(surface, window, &s, 0, NSEventModifierFlags::empty());
    }
}

/// One modifier's flag.
#[cfg(feature = "dev")]
pub(crate) fn modifier(name: &str) -> Option<NSEventModifierFlags> {
    Some(match name {
        "cmd" => NSEventModifierFlags::Command,
        "shift" => NSEventModifierFlags::Shift,
        "alt" => NSEventModifierFlags::Option,
        "ctrl" => NSEventModifierFlags::Control,
        _ => return None,
    })
}

#[cfg(feature = "dev")]
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
        "Insert" => ("\u{f727}".into(), 114),
        "Clear" => ("\u{f739}".into(), 71),
        // F1 to F20 (`F5`).
        f if f.len() > 1
            && f.starts_with('F')
            && let Some(n) = f[1..].parse::<u16>().ok().filter(|n| (1..=20).contains(n)) =>
        {
            const CODES: [u16; 20] = [
                122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79,
                80, 90,
            ];
            let c = char::from_u32(0xf703 + u32::from(n)).unwrap_or('\0');
            (c.to_string(), CODES[usize::from(n - 1)])
        }
        // Shift types the shifted character, which menus' key
        // equivalents match (`cmd+shift+z` is Redo's `Z`). A character's
        // key is the US layout's, as a real event's would be.
        other => {
            if other.chars().count() != 1 {
                log::warn!("unsupported synthesized AppKit key: {other}");
                return;
            }
            let mut chars = other.chars();
            let code = match (chars.next(), chars.next()) {
                (Some(c), None) => {
                    crate::input::us_typing_key(c).map_or(crate::input::NO_KEY, |(code, _)| code)
                }
                _ => crate::input::NO_KEY,
            };
            if flags.contains(NSEventModifierFlags::Shift) {
                let mut one = other.chars();
                let typed = match (one.next(), one.next()) {
                    (Some(c), None) => nsh_core::keymap::shifted(c).to_string(),
                    _ => other.to_uppercase(),
                };
                (typed, code)
            } else {
                (other.into(), code)
            }
        }
    };
    key_event(surface, window, &chars, code, flags);
}

#[cfg(feature = "dev")]
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

#[cfg(test)]
mod tests {
    use objc2_core_graphics::{CGEvent, CGEventField, CGEventFlags};

    use super::*;

    #[test]
    fn wheel_conversion_preserves_modifiers_in_line_and_precise_events() {
        let modifiers = [
            NSEventModifierFlags::empty(),
            NSEventModifierFlags::Control,
            NSEventModifierFlags::Shift,
            NSEventModifierFlags::Option,
            NSEventModifierFlags::Command,
            NSEventModifierFlags::Function,
            NSEventModifierFlags::Control
                | NSEventModifierFlags::Shift
                | NSEventModifierFlags::Option
                | NSEventModifierFlags::Command,
        ];
        for phase in [None, Some(1), Some(2), Some(4)] {
            for flags in modifiers {
                let event = wheel_event(
                    2,
                    -3,
                    phase,
                    0,
                    1.0,
                    flags,
                    objc2_core_foundation::CGPoint::new(0.0, 0.0),
                )
                .expect("native scroll event");
                assert_eq!(
                    CGEvent::flags(Some(&event)),
                    CGEventFlags(flags.bits() as u64)
                );
                assert_eq!(
                    CGEvent::integer_value_field(
                        Some(&event),
                        CGEventField::ScrollWheelEventIsContinuous
                    ),
                    i64::from(phase.is_some())
                );
                assert_eq!(
                    CGEvent::integer_value_field(
                        Some(&event),
                        CGEventField::ScrollWheelEventScrollPhase
                    ),
                    phase.unwrap_or(0)
                );
            }
        }
    }

    #[test]
    fn momentum_wheel_keeps_its_modifier_mask() {
        let flags = NSEventModifierFlags::Shift | NSEventModifierFlags::Option;
        let event = wheel_event(
            1,
            0,
            Some(2),
            2,
            1.0,
            flags,
            objc2_core_foundation::CGPoint::new(0.0, 0.0),
        )
        .expect("native momentum event");
        assert_eq!(
            CGEvent::flags(Some(&event)),
            CGEventFlags(flags.bits() as u64)
        );
        assert_eq!(
            CGEvent::integer_value_field(Some(&event), CGEventField::ScrollWheelEventMomentumPhase),
            2
        );
    }
}
