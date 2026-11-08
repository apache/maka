/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Input as a user's hands give it, made in process: mouse and trackpad
//! events posted to the app as the system posts them, keys, and pictures
//! of the window, shared by embedded and development hosts.

#[cfg(feature = "terminal")]
use objc2::{MainThreadMarker, rc::Retained};
use objc2_app_kit::NSEventModifierFlags;
#[cfg(feature = "terminal")]
use objc2_app_kit::{NSEvent, NSEventType, NSWindow};
#[cfg(feature = "terminal")]
use objc2_core_foundation::CGFloat;
#[cfg(feature = "terminal")]
use objc2_foundation::NSPoint;

/// A point of the content view (points from its top left) in window
/// coordinates (from its bottom left).
#[cfg(feature = "terminal")]
pub(crate) fn to_window(window: &NSWindow, x: f64, y: f64) -> NSPoint {
    let height = window.contentView().map_or(0.0, |v| v.frame().size.height);
    NSPoint::new(x as CGFloat, height - y as CGFloat)
}

/// A mouse event of `window` at `(x, y)` (content points).
#[cfg(feature = "terminal")]
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

/// Seconds since the system started, as event timestamps are.
#[cfg(feature = "terminal")]
pub(crate) fn timestamp() -> f64 {
    objc2_foundation::NSProcessInfo::processInfo().systemUptime()
}

/// A scroll of `(dx, dy)`: points of a trackpad gesture in `phase` (a
/// `CGScrollPhase`), or lines of a mouse wheel (`None`), in a
/// `CGMomentumScrollPhase` (`0`: none), stamped `at` (seconds since the
/// system started).
#[cfg(feature = "terminal")]
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
