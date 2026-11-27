//! A click on an `Input`'s text or its padding is a press of the input when
//! it listens, after the focus the click gives it (a combobox opens its
//! list), and of no view around it; a drag that selects is no press, and an
//! input that does not listen leaves the press to no one, as on the other
//! platforms. Read from a real `AppView` in a window.
//!
//! `NSH_INPUT_PRESS_CHECK_ONLY=1` runs this check alone.

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use nsh_base::input;
use nsh_core::prelude::*;
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSEvent, NSEventMask,
        NSEventModifierFlags, NSEventType, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSDefaultRunLoopMode, NSPoint, NSProcessInfo, NSRect, NSSize},
};

/// Focus and press events, in order, as `focus field` / `press field`.
static EVENTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn note(event: &str) {
    EVENTS.lock().unwrap().push(event.into());
}

fn events() -> Vec<String> {
    EVENTS.lock().unwrap().clone()
}

#[component]
fn Page() -> impl IntoElement {
    view().size_full().p(px(16.0)).child(
        view()
            .test_id("row")
            .p(px(8.0))
            .gap(px(8.0))
            .on_press(|| note("press row"))
            .child(
                input()
                    .test_id("field")
                    .default_value("Hello")
                    .w(px(240.0))
                    .h(px(32.0))
                    .p(px(6.0))
                    .on_focus(|| note("focus field"))
                    .on_press(|| note("press field")),
            )
            .child(
                input()
                    .test_id("area")
                    .multiline(true)
                    .default_value("Line 1")
                    .w(px(240.0))
                    .h(px(56.0))
                    .p(px(6.0))
                    .on_focus(|| note("focus area"))
                    .on_press(|| note("press area")),
            )
            .child(
                input()
                    .test_id("quiet")
                    .default_value("Quiet")
                    .w(px(240.0))
                    .h(px(32.0))
                    .p(px(6.0))
                    .on_focus(|| note("focus quiet")),
            ),
    )
}

fn find(view: &NSView, id: &str) -> Option<Retained<NSView>> {
    if view
        .accessibilityIdentifier()
        .is_some_and(|v| v.to_string() == id)
    {
        return Some(view.retain());
    }
    view.subviews().iter().find_map(|v| find(&v, id))
}

fn mouse_event(kind: NSEventType, point: NSPoint, window: isize, ts: f64) -> Retained<NSEvent> {
    NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        kind,
        point,
        NSEventModifierFlags::empty(),
        ts,
        window,
        None,
        0,
        1,
        1.0,
    )
    .unwrap()
}

fn pump(app: &NSApplication, ms: u64) {
    let deadline = Instant::now() + Duration::from_millis(ms);
    // SAFETY: AppKit's immutable default run-loop mode.
    let mode = unsafe { NSDefaultRunLoopMode };
    while Instant::now() < deadline {
        if let Some(e) = app.nextEventMatchingMask_untilDate_inMode_dequeue(
            NSEventMask::Any,
            Some(&NSDate::dateWithTimeIntervalSinceNow(0.002)),
            mode,
            true,
        ) {
            app.sendEvent(&e);
        }
        app.updateWindows();
    }
}

/// Runs the loop until `done`, failing with `what` after a few seconds.
fn until(app: &NSApplication, what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "{what}: {:?}", events());
        pump(app, 10);
    }
}

/// Presses `view` at `(x, y)` (its coordinates) and drags to `to_x` before
/// the release (no drag when `to_x` is `x`). The release (and the drag) are
/// queued as the press goes down: a hosted editor's `mouseDown:` tracks the
/// mouse in a loop of its own until they come.
fn press(window: &NSWindow, view: &NSView, x: f64, y: f64, to_x: f64) {
    let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
    let start = view.convertPoint_toView(NSPoint::new(x, y), None);
    let end = view.convertPoint_toView(NSPoint::new(to_x, y), None);
    let number = window.windowNumber();
    let ts = NSProcessInfo::processInfo().systemUptime();
    if to_x != x {
        dispatch2::DispatchQueue::main()
            .after(Duration::from_millis(20).try_into().unwrap(), move || {
                let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
                let ts = NSProcessInfo::processInfo().systemUptime();
                app.postEvent_atStart(
                    &mouse_event(NSEventType::LeftMouseDragged, end, number, ts),
                    false,
                );
            })
            .unwrap();
    }
    dispatch2::DispatchQueue::main()
        .after(Duration::from_millis(45).try_into().unwrap(), move || {
            let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
            let ts = NSProcessInfo::processInfo().systemUptime();
            app.postEvent_atStart(
                &mouse_event(NSEventType::LeftMouseUp, end, number, ts),
                false,
            );
        })
        .unwrap();
    window.sendEvent(&mouse_event(NSEventType::LeftMouseDown, start, number, ts));
    pump(&app, 150);
}

/// Presses as [`press`] does and checks the events it brought.
fn check(
    app: &NSApplication,
    window: &NSWindow,
    view: &NSView,
    at: (f64, f64, f64),
    want: &[&str],
    what: &str,
) {
    EVENTS.lock().unwrap().clear();
    press(window, view, at.0, at.1, at.2);
    if let Some(last) = want.last() {
        until(app, what, || events().iter().any(|e| e == last));
    }
    pump(app, 100);
    assert_eq!(events(), want, "{what}");
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    let app = NSApplication::sharedApplication(mtm);
    app.finishLaunching();
    // SAFETY: window creation and ownership on the main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(240.0, 220.0), NSSize::new(400.0, 260.0)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: retained here through close.
    unsafe { window.setReleasedWhenClosed(false) };
    let surface = platform::AppView::new(
        mtm,
        platform::AppOptions {
            size: (400, 260),
            ..Default::default()
        },
    );
    let root = surface.view();
    window.setContentView(Some(&root));
    EVENTS.lock().unwrap().clear();
    surface.load(platform::App::Rust(platform::Root::of::<Page>()));
    window.makeKeyAndOrderFront(None);
    app.activate();
    until(&app, "the inputs did not mount", || {
        find(&root, "quiet").is_some_and(|v| v.frame().size.width > 0.0)
    });
    let row = find(&root, "row").unwrap();
    let field = find(&root, "field").unwrap();
    let area = find(&root, "area").unwrap();
    let quiet = find(&root, "quiet").unwrap();

    // The row beside its inputs takes its own press.
    check(
        &app,
        &window,
        &row,
        (320.0, 20.0, 320.0),
        &["press row"],
        "a click beside the inputs",
    );
    // On the text: the focus, then the press, and the row hears none.
    check(
        &app,
        &window,
        &field,
        (16.0, 16.0, 16.0),
        &["focus field", "press field"],
        "a click on an input's text",
    );
    // On the padding of the focused input.
    check(
        &app,
        &window,
        &field,
        (2.0, 16.0, 2.0),
        &["press field"],
        "a click on an input's padding",
    );
    // A drag that selects is no press.
    check(
        &app,
        &window,
        &field,
        (8.0, 16.0, 120.0),
        &[],
        "a drag across an input's text",
    );
    // A multiline input.
    check(
        &app,
        &window,
        &area,
        (16.0, 16.0, 16.0),
        &["focus area", "press area"],
        "a click on a multiline input's text",
    );
    // An input that does not listen leaves the press to no one.
    check(
        &app,
        &window,
        &quiet,
        (16.0, 16.0, 16.0),
        &["focus quiet"],
        "a click on an input that does not listen",
    );
    check(
        &app,
        &window,
        &quiet,
        (2.0, 16.0, 2.0),
        &[],
        "a click on the padding of an input that does not listen",
    );

    surface.stop();
    window.close();
    println!("input_press: an input's text and padding press the input alone, after its focus");
}
