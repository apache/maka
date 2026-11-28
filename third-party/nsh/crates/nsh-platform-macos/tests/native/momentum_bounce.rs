//! Momentum a trackpad flick leaves running carries a list past the edge
//! it runs into and springs back, as `NSScrollView`'s does: the content
//! shows past the top, comes back to it, and `onMomentumEnd` and
//! `onScrollEnd` come once, as it comes back, while the system's momentum
//! events still come. Pulled past the top with the fingers and let go, the
//! content springs back from rest on the same spring, with `onScrollEnd`
//! alone. A list that does not bounce stops at the top and ends with the
//! system's momentum (the control). The window is ordered in
//! without activating the app, and the events go to the surface's view
//! directly, so the check takes the focus from no one. The display's frames
//! run the bounce: the screen must be unlocked.
use std::{
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

use nsh_core::prelude::*;
use nsh_platform_macos as platform;
use objc2_core_foundation::CGPoint;
use objc2_core_graphics::{CGEvent, CGEventField, CGScrollEventUnit};
use platform::{
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSEvent,
        NSScreen, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSProcessInfo, NSRect, NSRunLoop, NSSize, NSString},
};

/// The list's `on_momentum_end` calls.
static MOMENTUM_ENDS: AtomicUsize = AtomicUsize::new(0);
/// Its `on_scroll_end` calls.
static SCROLL_ENDS: AtomicUsize = AtomicUsize::new(0);

/// Where the events land, in the window's content (AppKit's, y up).
const AT: (f64, f64) = (200.0, 120.0);

fn list(bounces: bool) -> impl IntoElement {
    scroll()
        .test_id("list")
        .flex_1()
        .bounces(bounces)
        .on_momentum_end(|_: &Point<Points>| {
            MOMENTUM_ENDS.fetch_add(1, Ordering::SeqCst);
        })
        .on_scroll_end(|_: &Point<Points>| {
            SCROLL_ENDS.fetch_add(1, Ordering::SeqCst);
        })
        .child(
            view()
                .test_id("content")
                .children((0..200).map(|i| text(format!("Row {i}")).h(px(40.0)).into_element())),
        )
}

#[component]
fn Bouncing() -> impl IntoElement {
    list(true)
}

#[component]
fn Rigid() -> impl IntoElement {
    list(false)
}

fn pump(ms: u64) {
    let deadline = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < deadline {
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.002));
    }
}

/// A trackpad scroll of `dy` points (content up) in gesture `phase` and
/// momentum `momentum` (`CGScrollPhase` / `CGMomentumScrollPhase`; 0:
/// none), stamped now, as the system stamps its events.
fn wheel(window: &NSWindow, dy: i32, phase: i64, momentum: i64) -> Retained<NSEvent> {
    let event =
        CGEvent::new_scroll_wheel_event2(None, CGScrollEventUnit::Pixel, 2, -dy, 0, 0).unwrap();
    // A window-less event's `locationInWindow` is its screen point (y up
    // from the primary display's bottom): place it at the window point.
    let main_height = NSScreen::screens(MainThreadMarker::from(window))
        .firstObject()
        .map_or(0.0, |s| s.frame().size.height);
    CGEvent::set_location(Some(&event), CGPoint::new(AT.0, main_height - AT.1));
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
    let at = NSProcessInfo::processInfo().systemUptime();
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

/// Where `content` shows in `list` along y (points), through the layers:
/// what the frames show, the scroll's transform included.
fn shown(list: &NSView, content: &NSView) -> f64 {
    let (list, content) = (list.layer().unwrap(), content.layer().unwrap());
    content
        .convertPoint_toLayer(CGPoint::new(0.0, 0.0), Some(&list))
        .y
}

/// What a flick into the top did.
#[derive(Debug)]
struct Flick {
    /// The furthest the content showed past the top (points).
    past: f64,
    /// It came back to the top (within half a point) while the system's
    /// momentum still came.
    back: bool,
    /// `onMomentumEnd` and `onScrollEnd` calls before the system's momentum
    /// ended...
    ends_before: (usize, usize),
    /// ...and after.
    ends_after: (usize, usize),
    /// How far the fingers then pulled the content past the top...
    stretched: f64,
    /// ...and how long after they let go it came back within a point (ms).
    settled: Option<f64>,
    /// `onMomentumEnd` and `onScrollEnd` calls after they let go.
    release_ends: (usize, usize),
}

fn ends() -> (usize, usize) {
    (
        MOMENTUM_ENDS.load(Ordering::SeqCst),
        SCROLL_ENDS.load(Ordering::SeqCst),
    )
}

/// Scrolls 300 points down the list with the fingers, then flicks it back
/// up: the system's momentum after the flick runs into the top and keeps
/// coming for over a second.
fn check(app: fn() -> platform::Root, name: &str) -> Flick {
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
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(&NSString::from_str("NSH momentum bounce"));
    let options = platform::AppOptions {
        size: (420, 240),
        ..Default::default()
    };
    let surface = platform::AppView::new(mtm, options);
    window.setContentView(Some(&surface.view()));
    surface.load(platform::App::Rust(app()));
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
    let list = find(&surface.view(), "list").expect("the list");
    let content = find(&surface.view(), "content").expect("its content");
    let rest = shown(&list, &content);
    // The fingers' events go through the window, as AppKit sends them;
    // the momentum's to the view (AppKit drops synthesized momentum events
    // at the window and hands the system's to the view the gesture took).
    let send = |e: Retained<NSEvent>| {
        if e.momentumPhase().is_empty() {
            window.sendEvent(&e);
        } else {
            root.scrollWheel(&e);
        }
        pump(8);
    };

    // 300 points down with the fingers, no momentum after.
    send(wheel(&window, 0, 1, 0));
    for _ in 0..15 {
        send(wheel(&window, 20, 2, 0));
    }
    send(wheel(&window, 0, 4, 0));
    pump(300);
    // Down the content is this way along the layers' y.
    let down = shown(&list, &content) - rest;
    assert!(
        down.abs() > 250.0,
        "{name}: the fingers must scroll the list down (moved {down})"
    );
    let offset = || down.signum() * (shown(&list, &content) - rest);
    MOMENTUM_ENDS.store(0, Ordering::SeqCst);
    SCROLL_ENDS.store(0, Ordering::SeqCst);

    // The flick back up: 100 points with the fingers, then the system's
    // momentum at 40 points an event, which reaches the top on its sixth.
    send(wheel(&window, 0, 1, 0));
    for _ in 0..5 {
        send(wheel(&window, -20, 2, 0));
    }
    send(wheel(&window, 0, 4, 0));
    send(wheel(&window, -40, 0, 1));
    let (mut past, mut back) = (0f64, false);
    for _ in 0..150 {
        send(wheel(&window, -40, 0, 2));
        let at = offset();
        past = past.max(-at);
        back |= past > 1.0 && at.abs() < 0.5;
    }
    let ends_before = ends();
    send(wheel(&window, 0, 0, 3));
    pump(200);
    let ends_after = ends();

    // The fingers take the content 600 points past the top, which shows a
    // twentieth of that as NSScrollView does, hold, let go: it springs back
    // from rest.
    send(wheel(&window, 0, 1, 0));
    for _ in 0..30 {
        send(wheel(&window, -20, 2, 0));
    }
    pump(150);
    let stretched = -offset();
    let let_go = Instant::now();
    send(wheel(&window, 0, 4, 0));
    let mut settled = None;
    while let_go.elapsed() < Duration::from_millis(900) {
        pump(4);
        if settled.is_none() && -offset() <= 1.0 {
            settled = Some(let_go.elapsed().as_secs_f64() * 1000.0);
        }
    }
    let flick = Flick {
        past,
        back,
        ends_before,
        ends_after,
        stretched,
        settled,
        release_ends: (ends().0 - ends_after.0, ends().1 - ends_after.1),
    };
    println!("momentum bounce {name}: {flick:?}");
    surface.stop();
    window.close();
    flick
}

pub(super) fn run() {
    let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    app.finishLaunching();

    let bouncing = check(platform::Root::of::<Bouncing>, "bouncing");
    assert!(
        bouncing.past > 20.0,
        "momentum into the top must carry the content past it ({bouncing:?})"
    );
    assert!(
        bouncing.back,
        "the content must spring back to the top ({bouncing:?})"
    );
    assert_eq!(
        bouncing.ends_before,
        (1, 1),
        "onMomentumEnd and onScrollEnd come once, as the bounce ends, before the system's \
         momentum does ({bouncing:?})"
    );
    assert_eq!(
        bouncing.ends_after,
        (1, 1),
        "the system's momentum ending sends no more ({bouncing:?})"
    );
    // A twentieth of 600: the rubber band of iOS would show 139 here.
    assert!(
        (25.0..=35.0).contains(&bouncing.stretched),
        "the fingers stretch the content as stiffly as NSScrollView's ({bouncing:?})"
    );
    // Let go at rest, AppKit's spring falls as e^(-t / 80 ms): 30 points
    // are within a point in about 272 ms, where an ease-out of 300 ms would
    // be in about 203.
    assert!(
        bouncing
            .settled
            .is_some_and(|t| (235.0..=330.0).contains(&t)),
        "let go, the content springs back as NSScrollView's does ({bouncing:?})"
    );
    assert_eq!(
        bouncing.release_ends,
        (0, 1),
        "letting go past the top ends with onScrollEnd alone ({bouncing:?})"
    );

    let rigid = check(platform::Root::of::<Rigid>, "rigid");
    assert!(
        rigid.past < 0.5 && rigid.stretched < 0.5,
        "a list that does not bounce stops at the top ({rigid:?})"
    );
    assert_eq!(
        rigid.ends_before,
        (0, 0),
        "a list that does not bounce ends with the system's momentum ({rigid:?})"
    );
    assert_eq!(rigid.ends_after, (1, 1), "{rigid:?}");
}
