//! Open and save panels belong to the app that showed them: another app
//! loaded in the same view, `stop()` and the view being dropped take them
//! away. A panel left up would stay a sheet on the host's window, blocking
//! it (and the next app) until the user dismissed it.
//!
//! Read from the real AppKit windows: the open and save panels of the
//! process, found by class (a sheet is one of `NSApplication.windows`).
//! Needs a desktop session with the screen unlocked. Runs on its own:
//! `NSH_FILE_PANELS_CHECK_ONLY=1 cargo test -p nsh-platform-macos --test native -- --ignored`.

use std::{
    rc::Rc,
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

use nsh_core::{
    file_dialog::{OpenDialog, SaveDialog},
    picker::FilePickRequest,
    prelude::*,
};
use nsh_platform_macos as platform;
use platform::{
    objc2::{MainThreadMarker, MainThreadOnly, rc::Retained},
    objc2_app_kit::{NSApplication, NSBackingStoreType, NSWindow, NSWindowStyleMask},
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize, NSString},
};

/// The panel the app raises when it mounts: 1 the open panel
/// (`pick_paths`), 2 the save panel (`pick_save_path`), 3 `Picker.pickFiles`.
static KIND: AtomicUsize = AtomicUsize::new(0);

/// Raises the panel [`KIND`] says, a moment after mounting.
#[component]
fn Panel() -> impl IntoElement {
    let kind = KIND.load(Ordering::SeqCst);
    set_timeout(Duration::from_millis(20), move || {
        spawn(async move {
            match kind {
                1 => drop(pick_paths(OpenDialog::files()).await),
                2 => drop(pick_save_path(SaveDialog::new()).await),
                _ => drop(pick_files(FilePickRequest::new(false, 1)).await),
            }
        });
    });
    view().flex_1().child(text("Panel"))
}

/// An app that raises nothing.
#[component]
fn Idle() -> impl IntoElement {
    view().flex_1().child(text("Idle"))
}

/// The process's visible open and save panels (sheets included).
fn panels(mtm: MainThreadMarker) -> usize {
    NSApplication::sharedApplication(mtm)
        .windows()
        .iter()
        .filter(|w| {
            let name = w.class().name().to_string_lossy().into_owned();
            w.isVisible() && (name.contains("OpenPanel") || name.contains("SavePanel"))
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

fn new_window(mtm: MainThreadMarker) -> Retained<NSWindow> {
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
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(&NSString::from_str("NSH file panels"));
    window
}

/// Raises panel `kind` in a view, waits for it, then `end` ends the app
/// (`what` says how): the panel must be gone.
fn check(mtm: MainThreadMarker, kind: usize, what: &str, end: impl FnOnce(Rc<platform::AppView>)) {
    // A panel left by an earlier check would pass the waits below.
    assert_eq!(panels(mtm), 0, "a panel is up before {what}");
    let window = new_window(mtm);
    let surface = platform::AppView::new(mtm, platform::AppOptions::default());
    window.setContentView(Some(&surface.view()));
    window.makeKeyAndOrderFront(None);
    KIND.store(kind, Ordering::SeqCst);
    surface.load(platform::App::Rust(platform::Root::of::<Panel>()));
    until("the panel", || panels(mtm) == 1);
    end(surface);
    until(&format!("the panel gone after {what}"), || panels(mtm) == 0);
    window.close();
}

/// Runs after `window_press::run`, which launched the application.
pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    // Another app loaded in the view.
    check(mtm, 1, "another app loaded", |surface| {
        surface.load(platform::App::Rust(platform::Root::of::<Idle>()));
    });
    // The app stopped: a save panel.
    check(mtm, 2, "stop", |surface| surface.stop());
    // The view dropped, as an embedding host's: `Picker.pickFiles`'s panel.
    check(mtm, 3, "the view dropped", drop);
    println!("file panels: an app's open and save panels close with the app");
}
