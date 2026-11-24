//! A scroll view the core deletes while its refresh spinner turns stops
//! turning and is freed: its frame callback, which holds the view and
//! keeps the display link running, ends with it. Checked for a list
//! deleted alone and for one deleted with its parent in the same batch.
//! The window is ordered in without activating the app.
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use nsh_core::prelude::*;
use nsh_platform_macos as platform;
use objc2_quartz_core::CALayer;
use platform::{
    objc2::{
        MainThreadMarker, MainThreadOnly, Message,
        rc::{Retained, Weak, autoreleasepool},
    },
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize, NSString},
};

/// The test clears it for the app to unmount both lists.
static SHOW: AtomicBool = AtomicBool::new(true);

/// A list that refreshes from the start, with the platform's spinner.
fn refreshing_list(id: &'static str) -> impl IntoElement {
    scroll()
        .test_id(id)
        .h(px(160.0))
        .on_refresh(|_: &()| {})
        .refreshing(true)
        .child(
            view().children((0..20).map(|i| text(format!("Row {i}")).h(px(40.0)).into_element())),
        )
}

#[component]
fn Lists() -> impl IntoElement {
    let show = signal(true);
    set_interval(Duration::from_millis(5), move || {
        show.set(SHOW.load(Ordering::SeqCst))
    });
    view()
        .flex_1()
        .gap(px(8.0))
        // Deleted alone: the root of its batch's deletion.
        .child(when(move || show.get(), || refreshing_list("alone")))
        // Deleted with its parent: it stays in the parent, which leaves
        // the window.
        .child(when(
            move || show.get(),
            || view().test_id("page").child(refreshing_list("inside")),
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

/// Whether `list` shows its refresh spinner: a visible layer of eight
/// spokes in the overlay above its content.
fn spinner_shows(list: &NSView) -> bool {
    list.subviews().iter().any(|v| {
        v.class().name().to_str() == Ok("NshScrollOverlay")
            && v.layer().is_some_and(|layer| {
                // SAFETY: a getter, on the main thread.
                let sublayers = unsafe { layer.sublayers() };
                sublayers.is_some_and(|layers| {
                    layers.iter().any(|l: Retained<CALayer>| {
                        // SAFETY: as above.
                        let spokes = unsafe { l.sublayers() };
                        !l.isHidden() && spokes.is_some_and(|s| s.count() == 8)
                    })
                })
            })
    })
}

/// Runs the main run loop until `done` holds, for at most 5 s.
fn until(what: &str, mut done: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(5);
    while !autoreleasepool(|_| done()) {
        assert!(Instant::now() < end, "{what}");
        autoreleasepool(|_| {
            NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
        });
    }
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    NSApplication::sharedApplication(mtm).finishLaunching();
    SHOW.store(true, Ordering::SeqCst);
    // SAFETY: The window is created on the process main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(760.0, 260.0), NSSize::new(360.0, 360.0)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe {
        window.setReleasedWhenClosed(false);
    }
    window.setTitle(&NSString::from_str("NSH deleted refreshing scroll"));
    let app = platform::AppView::new(
        mtm,
        platform::AppOptions {
            size: (360, 360),
            ..Default::default()
        },
    );
    window.setContentView(Some(&app.view()));
    app.load(platform::App::Rust(platform::Root::of::<Lists>()));
    // In front, but neither key nor active: the user's app keeps the focus.
    window.orderFrontRegardless();
    let root = app.view();
    until("the lists' mount", || {
        find(&root, "alone").is_some() && find(&root, "inside").is_some()
    });
    until("both refresh spinners show", || {
        ["alone", "inside"]
            .iter()
            .all(|id| find(&root, id).is_some_and(|v| spinner_shows(&v)))
    });
    // Only weak references from here: the test keeps neither alive.
    let lists: Vec<(&str, Weak<NSView>)> = autoreleasepool(|_| {
        ["alone", "inside"]
            .into_iter()
            .map(|id| (id, Weak::from_retained(&find(&root, id).unwrap())))
            .collect()
    });
    SHOW.store(false, Ordering::SeqCst);
    until("the lists' deletion", || {
        find(&root, "alone").is_none() && find(&root, "inside").is_none()
    });
    for (id, list) in &lists {
        until(
            &format!(
                "the {id} list, deleted while refreshing, is never freed: its spinner's frame \
                 callback still holds it"
            ),
            || list.load().is_none(),
        );
    }
    println!("deleted_scroll: a list deleted while refreshing stops ticking and is freed");
    app.stop();
    window.close();
}
