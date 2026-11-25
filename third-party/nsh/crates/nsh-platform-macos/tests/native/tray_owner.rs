//! The menu bar has one tray item. It goes with the app that set it: when
//! another app has taken it over, the first app removing its own tray leaves
//! the item to the one that has it now.

use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use nsh_core::{
    element::desktop::{set_tray, tray},
    prelude::*,
};
use nsh_platform_macos as platform;
use platform::{
    objc2::{MainThreadMarker, MainThreadOnly},
    objc2_app_kit::{NSApplication, NSBackingStoreType, NSWindow, NSWindowStyleMask},
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize},
};

/// Whether each app has its tray set.
static FIRST: AtomicBool = AtomicBool::new(false);
static SECOND: AtomicBool = AtomicBool::new(false);

/// Follows `want`, setting or removing this app's tray when it changes.
fn follow(want: &'static AtomicBool, tooltip: &'static str) {
    let shown = std::cell::Cell::new(false);
    set_interval(Duration::from_millis(5), move || {
        let now = want.load(Ordering::SeqCst);
        if now != shown.replace(now) {
            set_tray(now.then(|| tray().tooltip(tooltip)));
        }
    });
}

#[component]
fn First() -> impl IntoElement {
    follow(&FIRST, "First");
    view().flex_1()
}

#[component]
fn Second() -> impl IntoElement {
    follow(&SECOND, "Second");
    view().flex_1()
}

/// The status items in the menu bar: each one is a window of its own. A
/// removed item's window stays in the application's list, hidden. AppKit has
/// no public way to list them, so they are found by their window class's
/// name, which is a heuristic that may need to follow a future macOS.
fn status_items(mtm: MainThreadMarker) -> usize {
    NSApplication::sharedApplication(mtm)
        .windows()
        .iter()
        .filter(|window| {
            window.isVisible()
                && window
                    .class()
                    .name()
                    .to_string_lossy()
                    .contains("StatusBar")
        })
        .count()
}

/// Runs the main run loop until `done` holds, for at most 5 s.
fn until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "{what} never happened");
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.01));
    }
}

fn pump(seconds: f64) {
    NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(seconds));
}

/// Runs after `window_press::run`, which launched the application.
// `AppOptions` is non-exhaustive: its fields are set after `default()`.
#[allow(clippy::field_reassign_with_default)]
pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    // SAFETY: The window is created on the process main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(700.0, 300.0), NSSize::new(300.0, 200.0)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe {
        window.setReleasedWhenClosed(false);
    }
    let mut options = platform::AppOptions::default();
    options.size = (300, 200);
    let first = platform::AppView::new(mtm, options.clone());
    let second = platform::AppView::new(mtm, options);
    window.setContentView(Some(&first.view()));
    first.view().addSubview(&second.view());
    first.load(platform::App::Rust(platform::Root::of::<First>()));
    second.load(platform::App::Rust(platform::Root::of::<Second>()));
    window.makeKeyAndOrderFront(None);
    let before = status_items(mtm);

    FIRST.store(true, Ordering::SeqCst);
    until("the first app's tray", || status_items(mtm) == before + 1);

    // The second app takes the item over.
    SECOND.store(true, Ordering::SeqCst);
    pump(0.3);
    assert_eq!(
        status_items(mtm),
        before + 1,
        "the second tray is one more item"
    );

    // The first app's removal is not the second's.
    FIRST.store(false, Ordering::SeqCst);
    pump(0.5);
    assert_eq!(
        status_items(mtm),
        before + 1,
        "an app removing its tray removed the tray another app had taken over"
    );

    SECOND.store(false, Ordering::SeqCst);
    until("the second app's removal", || status_items(mtm) == before);
    println!("tray owner: an app's tray is removed only by the app that has it");
    first.stop();
    second.stop();
    window.close();
}
