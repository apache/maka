//! A trackpad gesture past a scroll view's edge stretches the view AppKit's
//! `.automatic` elasticity would: a vertical scroll view whose content fits
//! hands the stretch to the vertical scroll view around it (an editor as
//! tall as its document inside a list), a standalone one whose content fits
//! still stretches, and a horizontal one stretches only while its content
//! overflows. Each check pulls past the start with the fingers down and
//! reads which scroll container is moved off its rest position, from the
//! native `NSView` hierarchy of a real `AppView`, before the fingers lift.
//! The window is ordered in without activating the app, and the events go
//! to the window directly, so the check takes the focus from no one.

use std::time::{Duration, Instant};

use nsh_core::prelude::*;
use nsh_platform_macos as platform;
use objc2_core_graphics::{CGEvent, CGEventField, CGScrollEventUnit};
use platform::{
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSEvent,
        NSScreen, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSProcessInfo, NSRect, NSRunLoop, NSSize, NSString},
};

/// The window's content size.
const SIZE: (f64, f64) = (360.0, 300.0);
/// Where the gestures land, in the window's content (from its top left):
/// over the inner scroll view, which sits at the top of the outer one.
const AT: (f64, f64) = (180.0, 60.0);

fn rows(n: usize) -> impl IntoElement {
    view().children((0..n).map(|i| text(format!("Row {i}")).h(px(40.0)).into_element()))
}

/// An inner vertical scroll view whose content fits, at the top of an
/// outer one whose content overflows.
#[component]
fn Nested() -> impl IntoElement {
    scroll().test_id("outer").flex_1().child(
        view()
            .child(scroll().test_id("inner").h(px(120.0)).child(rows(2)))
            .child(rows(40)),
    )
}

/// The same, with an outer scroll view that does not bounce: nothing
/// stretches.
#[component]
fn NestedRigid() -> impl IntoElement {
    scroll().test_id("outer").bounces(false).flex_1().child(
        view()
            .child(scroll().test_id("inner").h(px(120.0)).child(rows(2)))
            .child(rows(40)),
    )
}

/// A standalone vertical scroll view whose content fits.
#[component]
fn ShortVertical() -> impl IntoElement {
    scroll().test_id("inner").flex_1().child(rows(2))
}

fn cells(n: usize) -> impl IntoElement {
    view()
        .flex_row()
        .children((0..n).map(|i| text(format!("Cell {i}")).w(px(80.0)).into_element()))
}

/// A standalone horizontal scroll view whose content fits.
#[component]
fn ShortHorizontal() -> impl IntoElement {
    scroll()
        .test_id("inner")
        .horizontal()
        .flex_1()
        .child(cells(2))
}

/// A standalone horizontal scroll view whose content overflows.
#[component]
fn WideHorizontal() -> impl IntoElement {
    scroll()
        .test_id("inner")
        .horizontal()
        .flex_1()
        .child(cells(20))
}

fn pump(ms: u64) {
    let deadline = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < deadline {
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
    }
}

/// A trackpad scroll moving the content by `(dx, dy)` points (positive:
/// left / up) in gesture `phase` (`CGScrollPhase`), stamped `at` seconds,
/// over the content point `AT`.
fn wheel(window: &NSWindow, dx: i32, dy: i32, phase: i64, at: f64) -> Retained<NSEvent> {
    let event =
        CGEvent::new_scroll_wheel_event2(None, CGScrollEventUnit::Pixel, 2, -dy, -dx, 0).unwrap();
    // A window-less event's `locationInWindow` is its screen point (y up
    // from the primary display's bottom): place it at the window point.
    let main_height = NSScreen::screens(MainThreadMarker::from(window))
        .firstObject()
        .map_or(0.0, |s| s.frame().size.height);
    let content_height = window.contentView().unwrap().frame().size.height;
    CGEvent::set_location(
        Some(&event),
        objc2_core_foundation::CGPoint::new(AT.0, main_height - (content_height - AT.1)),
    );
    CGEvent::set_integer_value_field(
        Some(&event),
        CGEventField::ScrollWheelEventScrollPhase,
        phase,
    );
    CGEvent::set_timestamp(Some(&event), (at * 1e9) as u64);
    NSEvent::eventWithCGEvent(&event).unwrap()
}

/// The view under `view` whose accessibility identifier is `id`.
fn find(view: &NSView, id: &str) -> Option<Retained<NSView>> {
    if view
        .accessibilityIdentifier()
        .is_some_and(|s| s.to_string() == id)
    {
        return Some(view.retain());
    }
    view.subviews().iter().find_map(|child| find(&child, id))
}

/// How far the scroll view `id` shows its content off its rest position:
/// the translation of its (or its container's) layer's `sublayerTransform`,
/// or its bounds origin once committed.
fn displacement(root: &NSView, id: &str) -> f64 {
    let Some(view) = find(root, id) else {
        panic!("no view `{id}`");
    };
    let own = |v: &NSView| {
        let b = v.bounds().origin;
        let t = v
            .layer()
            .map(|l| l.sublayerTransform())
            .map_or((0.0, 0.0), |t| (t.m41, t.m42));
        b.x.abs().max(b.y.abs()).max(t.0.abs()).max(t.1.abs())
    };
    view.subviews()
        .iter()
        .map(|c| own(&c))
        .fold(own(&view), f64::max)
}

/// Pulls past the start of the views in `app` (rightward when
/// `horizontal`, downward otherwise) with the fingers down, and returns how
/// far each view in `ids` is stretched before they lift.
fn check(app: fn() -> platform::Root, name: &str, horizontal: bool, ids: &[&str]) -> Vec<f64> {
    let mtm = MainThreadMarker::new().unwrap();
    let frame = NSRect::new(NSPoint::new(700.0, 300.0), NSSize::new(SIZE.0, SIZE.1));
    // SAFETY: The window is created on the process main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            frame,
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(&NSString::from_str("NSH nested bounce"));
    let surface = platform::AppView::new(
        mtm,
        platform::AppOptions {
            size: (SIZE.0 as i32, SIZE.1 as i32),
            ..Default::default()
        },
    );
    window.setContentView(Some(&surface.view()));
    surface.load(platform::App::Rust(app()));
    window.orderFrontRegardless();
    pump(1200);
    let root = surface.view();

    // Stamped as the system stamps events: seconds since it started.
    let mut t = NSProcessInfo::processInfo().systemUptime();
    let send = |e: Retained<NSEvent>| {
        window.sendEvent(&e);
        pump(16);
    };
    // Content follows the fingers: past the start is a negative move.
    let (dx, dy) = if horizontal { (-20, 0) } else { (0, -20) };
    send(wheel(&window, 0, 0, 1, t));
    for _ in 0..6 {
        t += 0.016;
        send(wheel(&window, dx, dy, 2, t));
    }
    pump(50);
    let stretched: Vec<f64> = ids.iter().map(|id| displacement(&root, id)).collect();
    t += 0.016;
    send(wheel(&window, 0, 0, 4, t));
    pump(600);
    println!("nested bounce {name}: {ids:?} stretched {stretched:?}");
    surface.stop();
    window.close();
    stretched
}

/// A stretch that shows, not rounding.
const MOVED: f64 = 1.0;

pub(super) fn run() {
    let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    app.finishLaunching();
    let mut failures = Vec::new();

    let s = check(
        platform::Root::of::<Nested>,
        "nested",
        false,
        &["inner", "outer"],
    );
    if s[0] > MOVED || s[1] <= MOVED {
        failures.push(format!(
            "a fitting inner vertical scroll view must hand the stretch to the outer one: inner {}, outer {}",
            s[0], s[1]
        ));
    }
    let s = check(
        platform::Root::of::<NestedRigid>,
        "nested rigid",
        false,
        &["inner", "outer"],
    );
    if s[0] > MOVED || s[1] > MOVED {
        failures.push(format!(
            "under an outer scroll view that does not bounce nothing stretches: inner {}, outer {}",
            s[0], s[1]
        ));
    }
    let s = check(
        platform::Root::of::<ShortVertical>,
        "short vertical",
        false,
        &["inner"],
    );
    if s[0] <= MOVED {
        failures.push(format!(
            "a standalone vertical scroll view whose content fits must still stretch: {}",
            s[0]
        ));
    }
    let s = check(
        platform::Root::of::<ShortHorizontal>,
        "short horizontal",
        true,
        &["inner"],
    );
    if s[0] > MOVED {
        failures.push(format!(
            "a horizontal scroll view whose content fits must not stretch: {}",
            s[0]
        ));
    }
    let s = check(
        platform::Root::of::<WideHorizontal>,
        "wide horizontal",
        true,
        &["inner"],
    );
    if s[0] <= MOVED {
        failures.push(format!(
            "a horizontal scroll view whose content overflows must stretch: {}",
            s[0]
        ));
    }

    assert!(failures.is_empty(), "{}", failures.join("\n"));
    println!("nested bounce: ok");
}
