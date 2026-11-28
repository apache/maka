//! A mode the app asks for (`WindowRef::set_mode`) resizes the window
//! outside the batch that carried the request, so the resize waits for
//! the layout at the new size as AppKit's own resizes do (#3494). In the
//! batch, which holds the mounter, `Surface::await_layout` cannot wait:
//! leaving full screen, AppKit's shrink animation then showed the full
//! screen content. A window of the app's own also resized while its
//! watch was borrowed from the surface's windows, where the wait is
//! skipped too. Full screen needs an unlocked desktop session, so this
//! checks the same path with a zoom: the moment a window of the app's own
//! is zoomed, its content already fills it.
//!
//! An animation runs all along, so the layout the engine sends after a
//! batch waits for the display link's next frame: only a resize that
//! waited for it has applied it by then.

use std::{
    cell::RefCell,
    rc::Rc,
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

use nsh_core::{
    desktop::WindowMode,
    element::desktop::{WindowRef, open_window, window},
    geometry::{Points, Size},
    prelude::*,
};
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize},
};

/// 1 opens the window, 2 maximizes it, 3 closes it.
static STEP: AtomicUsize = AtomicUsize::new(0);

/// The main window's content: steps through [`STEP`].
#[component]
fn Steps() -> impl IntoElement {
    let opened: Rc<RefCell<Option<WindowRef>>> = Rc::default();
    let done = Rc::new(RefCell::new(0));
    set_interval(Duration::from_millis(5), move || {
        let step = STEP.load(Ordering::SeqCst);
        if *done.borrow() >= step {
            return;
        }
        *done.borrow_mut() = step;
        match step {
            1 => {
                *opened.borrow_mut() = open_window(
                    window()
                        .id("mode")
                        .title("Mode")
                        .default_size(Size::new(Points(320.0), Points(240.0)))
                        .content(content),
                );
            }
            2 => {
                if let Some(w) = &*opened.borrow() {
                    w.set_mode(WindowMode::Maximized);
                }
            }
            3 => {
                if let Some(w) = opened.borrow_mut().take() {
                    w.close();
                }
            }
            _ => {}
        }
    });
    view().test_id("main-content").flex_1()
}

/// The window's content: a view filling it, an animation running all
/// along.
fn content() -> impl IntoElement {
    let fade = animated_value(0.0);
    set_timeout(Duration::ZERO, move || {
        fade.timing(1.0, 600_000.0, Easing::EASE);
    });
    view()
        .size_full()
        .child(view().test_id("mode-ready").h(px(4.0)).bind_opacity(&fade))
        .child(view().test_id("mode-fill").flex_1())
}

fn find_in(view: &NSView, id: &str) -> Option<Retained<NSView>> {
    if view
        .accessibilityIdentifier()
        .is_some_and(|i| i.to_string() == id)
    {
        return Some(view.retain());
    }
    view.subviews().iter().find_map(|v| find_in(&v, id))
}

/// The window showing view `id`, and the view.
fn find(mtm: MainThreadMarker, id: &str) -> Option<(Retained<NSWindow>, Retained<NSView>)> {
    NSApplication::sharedApplication(mtm)
        .windows()
        .iter()
        .filter(|w| w.isVisible())
        .find_map(|w| Some((w.clone(), find_in(&*w.contentView()?, id)?)))
}

/// Runs the main run loop until `done` holds, for at most 5 s.
fn until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "{what} never happened");
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.001));
    }
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().expect("the main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.finishLaunching();
    STEP.store(0, Ordering::SeqCst);
    // SAFETY: created on the main thread.
    let main = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(100.0, 100.0), NSSize::new(200.0, 150.0)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: kept until after it closes.
    unsafe { main.setReleasedWhenClosed(false) };
    let surface = platform::AppView::new(
        mtm,
        platform::AppOptions {
            size: (200, 150),
            ..Default::default()
        },
    );
    main.setContentView(Some(&surface.view()));
    surface.load(platform::App::Rust(platform::Root::of::<Steps>()));
    main.orderFront(None);
    until("the main window's content", || {
        find(mtm, "main-content").is_some()
    });

    STEP.store(1, Ordering::SeqCst);
    until("the window's content", || find(mtm, "mode-ready").is_some());
    let (window, fill) = find(mtm, "mode-fill").expect("the filling view");
    assert!(!window.isZoomed(), "the window opens unzoomed");
    let before = window.contentView().expect("content").frame().size;

    STEP.store(2, Ordering::SeqCst);
    until("the zoom", || window.isZoomed());
    let content = window.contentView().expect("content").frame().size;
    let laid_out = fill.frame().size;
    assert!(
        content.width > before.width,
        "the window grew: {before:?} to {content:?}"
    );
    assert_eq!(
        laid_out.width, content.width,
        "the content was laid out at the zoomed size when the zoom ended \
         (the resize waited for the layout)"
    );

    STEP.store(3, Ordering::SeqCst);
    until("the window's close", || find(mtm, "mode-fill").is_none());
    surface.stop();
    main.close();
    println!("window mode layout: ok");
}
