//! A press stops the momentum a trackpad flick left running: once the
//! mouse goes down, the content stays where the press found it, though the
//! system's momentum events keep coming. Without a press the same events
//! move it (the control). The window is ordered in without activating the
//! app, and the events go to the surface's view directly, so the check
//! takes the focus from no one.
use std::{
    sync::atomic::{AtomicU32, AtomicUsize, Ordering},
    time::{Duration, Instant},
};

use nsh_core::prelude::*;
use nsh_platform_macos as platform;
use objc2_core_graphics::{CGEvent, CGEventField, CGScrollEventUnit};
use platform::{
    objc2::{MainThreadMarker, MainThreadOnly, rc::Retained},
    objc2_app_kit::{
        NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSEvent,
        NSEventModifierFlags, NSEventType, NSScreen, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSSize, NSString},
};

/// The list's content offset (`f32` bits), as its `on_scroll` last told.
static OFFSET: AtomicU32 = AtomicU32::new(0);
/// Its `on_momentum_end` calls.
static MOMENTUM_ENDS: AtomicUsize = AtomicUsize::new(0);

/// Where the events land, in the window's content (AppKit's, y up).
const AT: (f64, f64) = (200.0, 120.0);

#[component]
fn Long() -> impl IntoElement {
    scroll()
        .flex_1()
        .on_scroll(|e: &ScrollEvent| OFFSET.store(e.offset.y.0.to_bits(), Ordering::SeqCst))
        .on_momentum_end(|_: &Point<Points>| {
            MOMENTUM_ENDS.fetch_add(1, Ordering::SeqCst);
        })
        .child(
            view().children((0..200).map(|i| text(format!("Row {i}")).h(px(40.0)).into_element())),
        )
}

fn offset() -> f32 {
    f32::from_bits(OFFSET.load(Ordering::SeqCst))
}

fn pump(ms: u64) {
    let deadline = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < deadline {
        platform::objc2_foundation::NSRunLoop::currentRunLoop()
            .runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
    }
}

/// A trackpad scroll of `dy` points (content up) in gesture `phase` and
/// momentum `momentum` (`CGScrollPhase` / `CGMomentumScrollPhase`; 0:
/// none), stamped `at` seconds.
fn wheel(window: &NSWindow, dy: i32, phase: i64, momentum: i64, at: f64) -> Retained<NSEvent> {
    let event =
        CGEvent::new_scroll_wheel_event2(None, CGScrollEventUnit::Pixel, 2, -dy, 0, 0).unwrap();
    // A window-less event's `locationInWindow` is its screen point (y up
    // from the primary display's bottom): place it at the window point.
    let main_height = NSScreen::screens(MainThreadMarker::from(window))
        .firstObject()
        .map_or(0.0, |s| s.frame().size.height);
    CGEvent::set_location(
        Some(&event),
        objc2_core_foundation::CGPoint::new(AT.0, main_height - AT.1),
    );
    if phase != 0 {
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
    NSEvent::eventWithCGEvent(&event).unwrap()
}

fn mouse(window: &NSWindow, kind: NSEventType, at: f64) -> Retained<NSEvent> {
    NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        kind,
        NSPoint::new(AT.0, AT.1),
        NSEventModifierFlags::empty(),
        at,
        window.windowNumber(),
        None,
        1,
        1,
        0.0,
    )
    .unwrap()
}

/// Flicks the list, lets its momentum run, then (with `press`) presses
/// and sends more momentum: how far the content moved after the press.
fn check(press: bool) -> f32 {
    OFFSET.store(0f32.to_bits(), Ordering::SeqCst);
    MOMENTUM_ENDS.store(0, Ordering::SeqCst);
    let mtm = MainThreadMarker::new().unwrap();
    // SAFETY: The window is created on the process main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(800.0, 300.0), NSSize::new(420.0, 240.0)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe {
        window.setReleasedWhenClosed(false);
    }
    window.setTitle(&NSString::from_str("NSH press stops momentum"));
    let options = platform::AppOptions {
        size: (420, 240),
        ..Default::default()
    };
    let surface = platform::AppView::new(mtm, options);
    window.setContentView(Some(&surface.view()));
    surface.load(platform::App::Rust(platform::Root::of::<Long>()));
    // In front, but neither key nor active: the user's app keeps the focus.
    window.orderFrontRegardless();
    pump(1500);
    // The view AppKit hands the pointer's events to there: NSH's root,
    // whose `hitTest:` takes every mouse event inside it.
    let root: Retained<NSView> = {
        let content = window.contentView().unwrap();
        let p = NSPoint::new(AT.0, AT.1);
        // SAFETY: a superview's point, as hitTest: takes.
        let outer = unsafe { content.superview() };
        let p = outer.map_or(p, |o| o.convertPoint_fromView(p, None));
        content.hitTest(p).unwrap()
    };
    // Stamped as the system stamps events: seconds since it started.
    let mut t = platform::objc2_foundation::NSProcessInfo::processInfo().systemUptime();
    // The fingers' events go through the window, as AppKit sends them;
    // the momentum's to the view (AppKit drops synthesized momentum events
    // at the window and hands the system's to the view the gesture took).
    let send = |e: Retained<NSEvent>| {
        if e.momentumPhase().is_empty() {
            window.sendEvent(&e);
        } else {
            root.scrollWheel(&e);
        }
        pump(16);
    };
    // The fingers: began, changed, ended.
    send(wheel(&window, 0, 1, 0, t));
    for _ in 0..6 {
        t += 0.016;
        send(wheel(&window, 20, 2, 0, t));
    }
    t += 0.016;
    send(wheel(&window, 0, 4, 0, t));
    // The system's momentum: begin, then a few steps.
    t += 0.016;
    send(wheel(&window, 18, 0, 1, t));
    for _ in 0..4 {
        t += 0.016;
        send(wheel(&window, 16, 0, 2, t));
    }
    pump(100);
    let before = offset();
    assert!(
        before > 0.0,
        "the flick must scroll the list (offset {before})"
    );
    if press {
        root.mouseDown(&mouse(&window, NSEventType::LeftMouseDown, t + 0.01));
        root.mouseUp(&mouse(&window, NSEventType::LeftMouseUp, t + 0.02));
        pump(100);
    }
    let pressed_at = offset();
    // The momentum the system still sends.
    for _ in 0..8 {
        t += 0.016;
        send(wheel(&window, 12, 0, 2, t));
    }
    pump(150);
    let moved = offset() - pressed_at;
    let ends = MOMENTUM_ENDS.load(Ordering::SeqCst);
    println!("press={press} flicked={before} moved_after={moved} momentum_ends={ends}");
    if press {
        assert!(ends >= 1, "the press must end the momentum");
    }
    surface.stop();
    window.close();
    moved
}

pub(super) fn run() {
    let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    app.finishLaunching();
    let unpressed = check(false);
    assert!(
        unpressed > 1.0,
        "without a press the momentum keeps moving the list (moved {unpressed})"
    );
    let pressed = check(true);
    assert!(
        pressed.abs() < 0.5,
        "after a press the momentum must not move the list (moved {pressed})"
    );
}
