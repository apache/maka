//! A navigator the app takes away whole lets go of its views: its stack
//! and its pages are freed with the rest of the deleted subtree, at rest
//! after a push and in the middle of one. Navigation keeps per-stack and
//! per-page state; the pages of a deleted stack are deleted with it and
//! never detached from it, so only the deletion itself can drop that
//! state.
use std::{
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

use nsh_base::{nav_page, nav_stack};
use nsh_core::prelude::*;
use nsh_platform_macos::{
    self as platform,
    objc2::{
        MainThreadMarker, MainThreadOnly, Message,
        rc::{Retained, Weak, autoreleasepool},
    },
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize},
};

/// 0: no navigator; 1: the navigator with its first page; 2: a second
/// page pushed.
static STEP: AtomicUsize = AtomicUsize::new(0);

/// The views the check follows, by test id.
const FOLLOWED: [&str; 4] = ["navigator-host", "navigator", "home-page", "detail-page"];

#[component]
fn Navigator() -> impl IntoElement {
    let step = signal(STEP.load(Ordering::SeqCst));
    set_interval(Duration::from_millis(5), move || {
        step.set(STEP.load(Ordering::SeqCst))
    });
    view().flex_1().child(when(
        move || step.get() >= 1,
        move || {
            view().test_id("navigator-host").flex_1().child(
                nav_stack()
                    .test_id("navigator")
                    .flex_1()
                    .child(
                        nav_page()
                            .key("home")
                            .test_id("home-page")
                            .child(text("Home")),
                    )
                    .child(when(
                        move || step.get() >= 2,
                        || {
                            nav_page()
                                .key("detail")
                                .test_id("detail-page")
                                .child(text("Detail"))
                        },
                    )),
            )
        },
    ))
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

/// Runs the main run loop for `seconds`, draining what it autoreleases.
fn pump(seconds: f64) {
    autoreleasepool(|_| {
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(seconds));
    });
}

fn until(what: &str, mut done: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(5);
    while !autoreleasepool(|_| done()) {
        assert!(Instant::now() < end, "{what}");
        pump(0.001);
    }
}

/// Weak references to the followed views, all of which must be mounted.
fn follow(app: &platform::AppView) -> Vec<(&'static str, Weak<NSView>)> {
    autoreleasepool(|_| {
        let root = app.view();
        FOLLOWED
            .iter()
            .map(|id| {
                let view = find(&root, id).unwrap_or_else(|| panic!("{id} is mounted"));
                (*id, Weak::from_retained(&view))
            })
            .collect()
    })
}

/// Takes the navigator away and waits for its views to be freed.
fn unmount_and_expect_freed(
    app: &platform::AppView,
    followed: &[(&str, Weak<NSView>)],
    case: &str,
) {
    STEP.store(0, Ordering::SeqCst);
    until(&format!("{case}: the navigator left the window"), || {
        find(&app.view(), "navigator-host").is_none()
    });
    // The mounter frees deleted views over the frames after the batch.
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        let alive: Vec<&str> = followed
            .iter()
            .filter(|(_, weak)| autoreleasepool(|_| weak.load().is_some()))
            .map(|(id, _)| *id)
            .collect();
        if alive.is_empty() {
            return;
        }
        if Instant::now() >= end {
            // The host is held by nothing of navigation's: when it is not
            // freed either, the check cannot tell (something else holds
            // deleted views).
            assert!(
                !alive.contains(&"navigator-host"),
                "{case}: the deleted subtree's root is never freed (still alive: {alive:?})"
            );
            panic!("{case}: the platform still holds the deleted navigator's views: {alive:?}");
        }
        pump(0.01);
    }
}

/// Shows the navigator, pushes its second page, and waits `settle` after
/// the push before following its views; `moving`: the push must still be
/// under way then (the page not yet at rest: shifted or faded in part).
fn mount_and_push(
    app: &platform::AppView,
    settle: f64,
    moving: bool,
) -> Vec<(&'static str, Weak<NSView>)> {
    STEP.store(1, Ordering::SeqCst);
    until("the navigator mounted", || {
        find(&app.view(), "home-page").is_some()
    });
    // A push slides only over a stack laid out wider than nothing.
    pump(0.2);
    STEP.store(2, Ordering::SeqCst);
    until("the second page pushed", || {
        find(&app.view(), "detail-page").is_some()
    });
    pump(settle);
    if moving {
        let shown = autoreleasepool(|_| {
            let page = find(&app.view(), "detail-page").expect("the second page");
            (page.frame().origin.x, page.alphaValue())
        });
        assert!(
            shown.0 > 0.5 || shown.1 < 0.99,
            "the push is still under way when the navigator is taken away (x, alpha): {shown:?}"
        );
    }
    follow(app)
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    NSApplication::sharedApplication(mtm).finishLaunching();
    STEP.store(0, Ordering::SeqCst);
    // SAFETY: created on the main thread and retained until after close.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(100.0, 100.0), NSSize::new(320.0, 240.0)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: the window is closed and released by this function.
    unsafe { window.setReleasedWhenClosed(false) };
    let app = platform::AppView::new(
        mtm,
        platform::AppOptions {
            size: (320, 240),
            ..Default::default()
        },
    );
    window.setContentView(Some(&app.view()));
    app.load(platform::App::Rust(platform::Root::of::<Navigator>()));
    window.orderFront(None);
    pump(0.2);

    // At rest: the push has ended (a slide is 300 ms, a fade 200 ms).
    let followed = mount_and_push(&app, 0.8, false);
    unmount_and_expect_freed(&app, &followed, "after a push");

    // In the middle of the push: its transition holds the stack and both
    // pages until it is let go with them.
    let followed = mount_and_push(&app, 0.03, true);
    unmount_and_expect_freed(&app, &followed, "during a push");

    app.stop();
    window.close();
    println!("navigation_unmount: a deleted navigator's stack and pages are freed");
}
