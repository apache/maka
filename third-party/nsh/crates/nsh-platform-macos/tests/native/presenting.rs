//! A module's main-thread function finds the views of the surface that ran
//! it (`native_view`, `presenting_view`): an element's own view by its
//! ref's node, inside the surface's root view and the size it was laid out
//! at; the root view by `ROOT_ID`; the root as the view to present from
//! when the surface is a window's content (no app window of its own). No
//! node's view is found for a node no view carries, and nothing outside
//! such a function. The window is ordered in without activating the app.
//! Needs a desktop session.

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use nsh_core::{NodeId, ROOT_ID, prelude::*};
use nsh_platform_macos::{
    self as platform,
    objc2::{
        MainThreadMarker, MainThreadOnly,
        rc::{Retained, autoreleasepool},
    },
    objc2_app_kit::{NSApplication, NSBackingStoreType, NSWindow, NSWindowStyleMask},
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize, NSString},
};

/// What the main-thread function found.
#[derive(Debug, Clone, PartialEq)]
struct Seen {
    /// The anchor's view: its size, whether it is in a window and inside
    /// the root view.
    anchor: Option<(f64, f64, bool, bool)>,
    /// Whether the presenting view is the root view.
    presenting_is_root: bool,
    /// Whether a node no view carries found a view.
    stray: bool,
}

static SEEN: Mutex<Option<Seen>> = Mutex::new(None);

/// A node no view carries.
const STRAY: NodeId = u32::MAX - 1;

#[component]
fn Anchored() -> impl IntoElement {
    let anchor = element_ref();
    spawn(async move {
        // Laid out and mounted: two frames on.
        next_frame().await;
        next_frame().await;
        let node = anchor.node().expect("the anchor is rendered");
        let _ = run_on_main_thread(move || {
            let mtm = MainThreadMarker::new().expect("the main thread");
            let root = platform::native_view(mtm, ROOT_ID).expect("the root view");
            let anchor = platform::native_view(mtm, node).map(|view| {
                let size = view.frame().size;
                (
                    size.width,
                    size.height,
                    view.window().is_some(),
                    view.isDescendantOf(&root),
                )
            });
            let presenting_is_root = platform::presenting_view(mtm)
                .is_some_and(|view| Retained::as_ptr(&view) == Retained::as_ptr(&root));
            let stray = platform::native_view(mtm, STRAY).is_some();
            *SEEN.lock().unwrap() = Some(Seen {
                anchor,
                presenting_is_root,
                stray,
            });
        })
        .await;
    });
    view().size_full().items_center().justify_center().child(
        view()
            .w(px(120.0))
            .h(px(40.0))
            .element_ref(&anchor)
            .child(text("Anchor")),
    )
}

fn pump(ms: u64) {
    let end = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < end {
        autoreleasepool(|_| {
            NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
        });
    }
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    NSApplication::sharedApplication(mtm).finishLaunching();
    *SEEN.lock().unwrap() = None;
    // Outside a module's main-thread function: no surface is current.
    assert!(platform::native_view(mtm, ROOT_ID).is_none());
    assert!(platform::presenting_view(mtm).is_none());
    // SAFETY: The window is created on the process main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(120.0, 120.0), NSSize::new(360.0, 240.0)),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Closable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(&NSString::from_str("NSH presenting views"));
    let options = platform::AppOptions {
        size: (360, 240),
        ..Default::default()
    };
    let surface = platform::AppView::new(mtm, options);
    window.setContentView(Some(&surface.view()));
    window.orderFrontRegardless();
    surface.load(platform::App::Rust(platform::Root::of::<Anchored>()));

    let end = Instant::now() + Duration::from_secs(5);
    let seen = loop {
        if let Some(seen) = SEEN.lock().unwrap().clone() {
            break seen;
        }
        assert!(Instant::now() < end, "the main-thread function never ran");
        pump(10);
    };
    surface.stop();
    window.close();
    // The function ran in a nested scope: no surface is current after it.
    assert!(platform::native_view(mtm, ROOT_ID).is_none());

    println!("presenting: {seen:?}");
    assert_eq!(
        seen,
        Seen {
            anchor: Some((120.0, 40.0, true, true)),
            presenting_is_root: true,
            stray: false,
        }
    );
}
