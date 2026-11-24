//! A window of the app's own is laid out at its own size only, never once
//! at the main window's (#2764). Its root reaches the platform as a modal
//! first, and the batch's `OpenWindow` command claims it after: sized and
//! reported as a surface modal in between, it was laid out once at the
//! main window's size before its window's size came. Two windows of
//! different sizes, neither the main window's, record every size their
//! content is laid out at. Needs a desktop session.

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use nsh_core::{
    element::desktop::{open_window, window},
    geometry::{Bounds, Points},
    prelude::*,
};
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly},
    objc2_app_kit::{NSApplication, NSBackingStoreType, NSEventMask, NSWindow, NSWindowStyleMask},
    objc2_foundation::{NSDate, NSDefaultRunLoopMode, NSPoint, NSRect, NSSize, NSString},
};

/// The sizes each window's content was laid out at: (window, width, height).
static LAYOUTS: Mutex<Vec<(&'static str, f32, f32)>> = Mutex::new(Vec::new());

/// The main window's size, which no other window's content may take.
const MAIN: (f32, f32) = (900.0, 700.0);

/// The windows the app opens: id and size.
const WINDOWS: [(&str, f32, f32); 2] = [("small", 400.0, 300.0), ("tall", 260.0, 520.0)];

fn content(name: &'static str) -> impl IntoElement {
    view()
        .flex_1()
        .on_layout(move |b: &Bounds<Points>| {
            LAYOUTS
                .lock()
                .unwrap()
                .push((name, b.size.width.0, b.size.height.0));
        })
        .child(text(name))
}

/// Opens the windows once the main window is up, as the issue's app does.
#[component]
fn Opener() -> impl IntoElement {
    request_animation_frame(|_| {
        for (name, w, h) in WINDOWS {
            open_window(
                window()
                    .id(name)
                    .title(name)
                    .default_size(size(px(w), px(h)))
                    .content(move || content(name)),
            );
        }
    });
    view().size_full().child(text("main"))
}

fn pump(ms: u64) {
    let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
    let deadline = Instant::now() + Duration::from_millis(ms);
    // SAFETY: AppKit's immutable default run-loop mode.
    let mode = unsafe { NSDefaultRunLoopMode };
    while Instant::now() < deadline {
        if let Some(event) = app.nextEventMatchingMask_untilDate_inMode_dequeue(
            NSEventMask::Any,
            Some(&NSDate::dateWithTimeIntervalSinceNow(0.005)),
            mode,
            true,
        ) {
            app.sendEvent(&event);
        }
        app.updateWindows();
    }
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().expect("the checks run on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.finishLaunching();
    LAYOUTS.lock().unwrap().clear();
    // SAFETY: The window is created on the process main thread.
    let main = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(
                NSPoint::new(100.0, 100.0),
                NSSize::new(MAIN.0 as _, MAIN.1 as _),
            ),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Closable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe { main.setReleasedWhenClosed(false) };
    main.setTitle(&NSString::from_str("NSH window layout"));
    let options = platform::AppOptions {
        size: (MAIN.0 as _, MAIN.1 as _),
        ..Default::default()
    };
    let surface = platform::AppView::new(mtm, options);
    main.setContentView(Some(&surface.view()));
    main.orderFrontRegardless();
    surface.load(platform::App::Rust(platform::Root::of::<Opener>()));

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let seen = LAYOUTS.lock().unwrap().clone();
        if WINDOWS
            .iter()
            .all(|(n, ..)| seen.iter().any(|(s, ..)| s == n))
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the windows never laid out: {seen:?}"
        );
        pump(10);
    }
    // The frames after: a stale size would come within a few.
    pump(300);
    surface.stop();
    main.close();

    let seen = LAYOUTS.lock().unwrap().clone();
    println!("window_layout: {seen:?}");
    for (name, w, h) in WINDOWS {
        let sizes: Vec<(f32, f32)> = seen
            .iter()
            .filter(|(n, ..)| *n == name)
            .map(|&(_, w, h)| (w, h))
            .collect();
        assert!(
            sizes.iter().all(|&s| s == (w, h)),
            "window {name} must be laid out at {w}x{h} only, got {sizes:?}"
        );
    }
}
