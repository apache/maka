//! A zoomable scroll view (`maximumZoomScale` above `minimumZoomScale`) in
//! a real `AppView`: `zoomTo` zooms around the point asked for, eased or at
//! once; content smaller than the viewport is centered (`centerContent`);
//! it scrolls both ways while zoomed (`scrollTo`, mouse wheels); Control +
//! wheel zooms around the pointer, within the limits; `onScroll` reports
//! the zoom and the zoomed content size with the offset; and the zoomed
//! children are where they show: AppKit converts a child's (and an input's)
//! frame to where it is drawn, and a click presses what is drawn under it.
//! `NSH_ZOOM_PINCH_CHECK_ONLY=1` runs just the pinch routing check, which
//! sends events directly to the root and needs no display-link frames.

use std::{
    sync::{
        Mutex,
        atomic::{AtomicU32, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use nsh_base::input;
use nsh_core::prelude::*;
use nsh_platform_macos::{
    self as platform,
    objc2::{
        DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send,
        rc::Retained,
    },
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSEvent, NSEventMask,
        NSEventModifierFlags, NSEventPhase, NSEventType, NSScreen, NSView, NSWindow,
        NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSDefaultRunLoopMode, NSPoint, NSRect, NSSize, NSString},
};
use objc2_core_graphics::{CGEvent, CGEventFlags, CGScrollEventUnit};

/// What the app does next (set by the test, run by the app): see [`Map`].
static STEP: AtomicU32 = AtomicU32::new(0);
/// Presses of the button far into the content.
static PRESSES: AtomicUsize = AtomicUsize::new(0);
/// An `onScroll` event: offset, content size, zoom.
type Scrolled = ((f32, f32), (f32, f32), f32);
/// The `onScroll` events so far.
static SCROLLS: Mutex<Vec<Scrolled>> = Mutex::new(Vec::new());
/// Pinch phases observed by the view around the map.
static PINCHES: Mutex<Vec<PinchPhase>> = Mutex::new(Vec::new());

const VIEWPORT: (f64, f64) = (400.0, 300.0);

define_class!(
    /// AppKit has no public constructor for a magnify event.
    #[unsafe(super(NSEvent))]
    #[thread_kind = MainThreadOnly]
    #[name = "NshTestMagnifyEvent"]
    #[ivars = (NSPoint, NSEventPhase, f64)]
    struct MagnifyEvent;

    impl MagnifyEvent {
        #[unsafe(method(type))]
        fn event_type(&self) -> NSEventType {
            NSEventType::Magnify
        }
        #[unsafe(method(locationInWindow))]
        fn location(&self) -> NSPoint {
            self.ivars().0
        }
        #[unsafe(method(phase))]
        fn phase(&self) -> NSEventPhase {
            self.ivars().1
        }
        #[unsafe(method(magnification))]
        fn magnification(&self) -> f64 {
            self.ivars().2
        }
        #[unsafe(method(modifierFlags))]
        fn modifiers(&self) -> NSEventModifierFlags {
            NSEventModifierFlags::empty()
        }
        #[unsafe(method(timestamp))]
        fn timestamp(&self) -> f64 {
            0.0
        }
    }
);

#[component]
fn PinchParent() -> impl IntoElement {
    view()
        .size_full()
        .on_pinch(|e: &PinchEvent| PINCHES.lock().unwrap().push(e.phase))
        .child(map())
}

fn pinch(window: &NSWindow, root: &NSView) {
    // AppView exposes the host container; its child is the input root.
    let responder = root.subviews().firstObject().unwrap();
    for (phase, delta) in [
        (NSEventPhase::Began, 0.0),
        (NSEventPhase::Changed, 0.5),
        (NSEventPhase::Ended, 0.0),
    ] {
        let event = MagnifyEvent::alloc(MainThreadMarker::from(window)).set_ivars((
            to_window(window, 20.0, 20.0),
            phase,
            delta,
        ));
        // SAFETY: NSEvent initializes the allocated test subclass.
        let event: Retained<MagnifyEvent> = unsafe { msg_send![super(event), init] };
        responder.magnifyWithEvent(&event);
    }
    until("the ancestor observing the pinch", || {
        PINCHES.lock().unwrap().len() == 3
    });
    assert_eq!(
        *PINCHES.lock().unwrap(),
        [PinchPhase::Start, PinchPhase::Move, PinchPhase::End],
        "onPinch observes the gesture while the nearer scroll view zooms"
    );
    expect_rect(
        shown(window, &find(root, "far").unwrap()),
        740.0,
        590.0,
        60.0,
        60.0,
        "the scroll view pinched to 1.5 under an onPinch ancestor",
    );
    println!("zoom: an onPinch ancestor observes without taking the scroll view's pinch");
}

/// An 800 × 600 map zoomable from 0.25 to 2, with a button at (500, 400)
/// and an input at (100, 100).
#[component]
fn Map() -> impl IntoElement {
    let map = element_ref();
    set_interval(Duration::from_millis(5), move || {
        match STEP.swap(0, Ordering::SeqCst) {
            1 => map.zoom_to(0.25, None, false),
            2 => map.zoom_to(2.0, Some(point(px(520.0), px(420.0))), false),
            3 => map.zoom_to(1.0, None, true),
            4 => map.scroll_to(point(px(300.0), px(200.0)), false),
            _ => {}
        }
    });
    scroll()
        .element_ref(&map)
        .test_id("map")
        .size_full()
        .zoom_range(0.25, 2.0)
        .bounces_zoom(false)
        .center_content(true)
        .on_scroll(|e: &ScrollEvent| {
            let size = e.content_size;
            SCROLLS.lock().unwrap().push((
                (e.offset.x.0, e.offset.y.0),
                (size.width.0, size.height.0),
                e.zoom_scale,
            ));
        })
        .child(
            view()
                .relative()
                .w(px(800.0))
                .h(px(600.0))
                .child(
                    view()
                        .absolute()
                        .left(px(500.0))
                        .top(px(400.0))
                        .w(px(40.0))
                        .h(px(40.0))
                        .test_id("far")
                        .bg(rgb(0xeecc88))
                        .on_press(|| {
                            PRESSES.fetch_add(1, Ordering::SeqCst);
                        }),
                )
                .child(
                    input()
                        .absolute()
                        .left(px(100.0))
                        .top(px(100.0))
                        .w(px(200.0))
                        .h(px(30.0))
                        .test_id("field")
                        .default_value("Typed text"),
                ),
        )
}

/// The view whose accessibility identifier is `id`.
fn find(view: &NSView, id: &str) -> Option<Retained<NSView>> {
    if view
        .accessibilityIdentifier()
        .is_some_and(|value| value.to_string() == id)
    {
        return Some(view.retain());
    }
    view.subviews().iter().find_map(|child| find(&child, id))
}

/// Handles the app's events and runs its run loop for `ms`.
fn pump(ms: u64) {
    let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
    let deadline = Instant::now() + Duration::from_millis(ms);
    // SAFETY: AppKit's immutable default run-loop mode.
    let mode = unsafe { NSDefaultRunLoopMode };
    while Instant::now() < deadline {
        if let Some(e) = app.nextEventMatchingMask_untilDate_inMode_dequeue(
            NSEventMask::Any,
            Some(&NSDate::dateWithTimeIntervalSinceNow(0.005)),
            mode,
            true,
        ) {
            app.sendEvent(&e);
        }
        app.updateWindows();
    }
}

/// Runs the app until `done` holds, for at most five seconds.
fn until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "{what} never happened");
        pump(10);
    }
}

/// The last `onScroll` event.
fn last() -> Scrolled {
    *SCROLLS.lock().unwrap().last().expect("an onScroll event")
}

/// Waits for an `onScroll` at zoom `zoom`.
fn zoomed_to(zoom: f32) -> Scrolled {
    until(&format!("a zoom to {zoom}"), || {
        SCROLLS
            .lock()
            .unwrap()
            .last()
            .is_some_and(|e| (e.2 - zoom).abs() < 1e-3)
    });
    // The offset that goes with it comes in the same frame.
    pump(50);
    last()
}

fn near(a: f64, b: f64, what: &str) {
    assert!((a - b).abs() < 0.6, "{what}: {a} is not {b}");
}

/// Where `view` is drawn in the window's content (points from its top
/// left), by AppKit's conversion.
fn shown(window: &NSWindow, view: &NSView) -> NSRect {
    let content = window.contentView().unwrap();
    let r = view.convertRect_toView(view.bounds(), Some(&content));
    if content.isFlipped() {
        r
    } else {
        let h = content.frame().size.height;
        NSRect::new(
            NSPoint::new(r.origin.x, h - r.origin.y - r.size.height),
            r.size,
        )
    }
}

fn expect_rect(r: NSRect, x: f64, y: f64, w: f64, h: f64, what: &str) {
    near(r.origin.x, x, &format!("{what} x"));
    near(r.origin.y, y, &format!("{what} y"));
    near(r.size.width, w, &format!("{what} width"));
    near(r.size.height, h, &format!("{what} height"));
}

/// A point of the window's content (from its top left) in window
/// coordinates.
fn to_window(window: &NSWindow, x: f64, y: f64) -> NSPoint {
    NSPoint::new(x, window.contentView().unwrap().frame().size.height - y)
}

/// A left click at `(x, y)` of the window's content.
fn click(window: &NSWindow, x: f64, y: f64) {
    let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
    let at = to_window(window, x, y);
    let now = objc2_foundation::NSProcessInfo::processInfo().systemUptime();
    for (kind, t) in [
        (NSEventType::LeftMouseDown, now),
        (NSEventType::LeftMouseUp, now + 0.05),
    ] {
        let e = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            kind, at, NSEventModifierFlags::empty(), t, window.windowNumber(), None, 0, 1, 1.0,
        )
        .unwrap();
        app.postEvent_atStart(&e, false);
        pump(60);
    }
}

/// Mouse wheel notches at `(x, y)` of the window's content: `dx`, `dy`
/// lines moving the offset right / down (negative: the other way), with
/// Control held when `control`; handed to the window as `nsh test`'s agent
/// does.
fn wheel(window: &NSWindow, x: f64, y: f64, dx: i32, dy: i32, control: bool) {
    let mtm = MainThreadMarker::new().unwrap();
    let event = CGEvent::new_scroll_wheel_event2(None, CGScrollEventUnit::Line, 2, -dy, -dx, 0)
        .expect("a wheel event");
    // A window-less event's `locationInWindow` is its screen point (from
    // the main screen's top), which `sendEvent:` takes as a window point.
    let p = to_window(window, x, y);
    let top = NSScreen::screens(mtm)
        .firstObject()
        .map_or(0.0, |s| s.frame().size.height);
    CGEvent::set_location(
        Some(&event),
        objc2_core_foundation::CGPoint::new(p.x, top - p.y),
    );
    if control {
        CGEvent::set_flags(Some(&event), CGEventFlags::MaskControl);
    }
    let ns = NSEvent::eventWithCGEvent(&event).expect("an NSEvent");
    window.sendEvent(&ns);
    pump(30);
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    let app = NSApplication::sharedApplication(mtm);
    // SAFETY: The window is created on the process main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(
                NSPoint::new(200.0, 200.0),
                NSSize::new(VIEWPORT.0, VIEWPORT.1),
            ),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Closable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe {
        window.setReleasedWhenClosed(false);
    }
    window.setTitle(&NSString::from_str("NSH zoomable scroll view"));
    let options = platform::AppOptions {
        size: (VIEWPORT.0 as i32, VIEWPORT.1 as i32),
        ..Default::default()
    };
    let surface = platform::AppView::new(mtm, options);
    window.setContentView(Some(&surface.view()));
    surface.load(platform::App::Rust(platform::Root::of::<PinchParent>()));
    window.makeKeyAndOrderFront(None);
    app.activate();
    let root = surface.view();
    until("the map", || {
        find(&root, "far").is_some_and(|v| v.frame().size.width > 0.0)
    });
    let far = find(&root, "far").unwrap();
    let field = find(&root, "field").unwrap();
    expect_rect(
        shown(&window, &far),
        500.0,
        400.0,
        40.0,
        40.0,
        "unzoomed, out of the viewport",
    );

    pinch(&window, &root);
    if std::env::var_os("NSH_ZOOM_PINCH_CHECK_ONLY").is_some() {
        surface.stop();
        window.close();
        return;
    }

    // Zoomed out to a quarter: 200 × 150, centered in 400 × 300.
    STEP.store(1, Ordering::SeqCst);
    let (offset, content, _) = zoomed_to(0.25);
    assert_eq!(offset, (0.0, 0.0), "centered content does not scroll");
    assert_eq!(
        content,
        (200.0, 150.0),
        "onScroll's content size is the zoomed one"
    );
    expect_rect(
        shown(&window, &far),
        225.0,
        175.0,
        10.0,
        10.0,
        "the button at 0.25",
    );
    expect_rect(
        shown(&window, &field),
        125.0,
        100.0,
        50.0,
        7.5,
        "the input at 0.25",
    );

    // Twice the size, the button's middle in the viewport's.
    STEP.store(2, Ordering::SeqCst);
    let (offset, content, _) = zoomed_to(2.0);
    assert_eq!(content, (1600.0, 1200.0));
    near(offset.0 as f64, 840.0, "offset x at 2");
    near(offset.1 as f64, 690.0, "offset y at 2");
    expect_rect(
        shown(&window, &far),
        160.0,
        110.0,
        80.0,
        80.0,
        "the button at 2",
    );
    // A click presses what shows under it, and only that.
    click(&window, 200.0, 150.0);
    until("a press of the zoomed button", || {
        PRESSES.load(Ordering::SeqCst) == 1
    });
    click(&window, 100.0, 50.0);
    pump(100);
    assert_eq!(
        PRESSES.load(Ordering::SeqCst),
        1,
        "a click beside the button"
    );

    // Zoomed in, wheels move both ways.
    wheel(&window, 200.0, 150.0, 2, 3, false);
    pump(250);
    let (moved, _, zoom) = last();
    assert_eq!(zoom, 2.0);
    assert!(
        moved.0 > offset.0 + 1.0 && moved.1 > offset.1 + 1.0,
        "a wheel moves zoomed content both ways: {offset:?} to {moved:?}"
    );

    // Control + wheel zooms out around the pointer: the content point
    // under it stays.
    let (before, _, _) = last();
    let at = (100.0_f32, 100.0_f32);
    let under = ((before.0 + at.0) / 2.0, (before.1 + at.1) / 2.0);
    wheel(&window, at.0 as f64, at.1 as f64, 0, 3, true);
    pump(400);
    let (after, _, zoom) = last();
    assert!(
        zoom < 2.0 && zoom > 1.0,
        "Control + wheel zooms out: {zoom}"
    );
    near(
        ((after.0 + at.0) / zoom) as f64,
        under.0 as f64,
        "the point under the pointer, x",
    );
    near(
        ((after.1 + at.1) / zoom) as f64,
        under.1 as f64,
        "the point under the pointer, y",
    );
    // Zooming in past the limit stops there.
    for _ in 0..6 {
        wheel(&window, 200.0, 150.0, 0, -3, true);
    }
    pump(400);
    assert_eq!(last().2, 2.0, "Control + wheel stops at maximumZoomScale");

    // An eased zoomTo passes through the zooms in between.
    let seen = SCROLLS.lock().unwrap().len();
    STEP.store(3, Ordering::SeqCst);
    zoomed_to(1.0);
    let between = SCROLLS.lock().unwrap()[seen..]
        .iter()
        .filter(|e| e.2 > 1.01 && e.2 < 1.99)
        .count();
    assert!(
        between >= 2,
        "an animated zoomTo eases ({between} frames between)"
    );

    // `scrollTo` moves zoomed content along both axes.
    STEP.store(4, Ordering::SeqCst);
    until("a scrollTo both ways", || last().0 == (300.0, 200.0));
    expect_rect(
        shown(&window, &far),
        200.0,
        200.0,
        40.0,
        40.0,
        "the button at 1",
    );

    surface.stop();
    window.close();
    println!("zoom: zoomTo, centering, wheels, Control + wheel, clicks and frames checked");
}
