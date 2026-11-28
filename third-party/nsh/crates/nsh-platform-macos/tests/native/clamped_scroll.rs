//! A list whose rows above the viewport change size in the same commit as
//! a `scroll_to_index` clamped to its start rests at the start: the view's
//! bounds origin ends at 0, with no blank band above the first row
//! (#3235). The core sends an anchoring `ScrollBy` and the `ScrollTo(0)`
//! together, and the view may report between the two. The window is
//! ordered in without activating the app.
use std::{
    sync::atomic::{AtomicU32, Ordering},
    time::{Duration, Instant},
};

use nsh_core::prelude::*;
use nsh_platform_macos as platform;
use platform::{
    objc2::{
        MainThreadMarker, MainThreadOnly, Message,
        rc::{Retained, autoreleasepool},
    },
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize, NSString},
};

/// What the test asks of the app: 0 nothing yet, 1 taller rows with a
/// row kept near the bottom, 2 shorter rows with a scroll clamped to the
/// start.
static STEP: AtomicU32 = AtomicU32::new(0);

#[component]
fn List() -> impl IntoElement {
    let list = element_ref();
    let tall = signal(false);
    let done = signal(0u32);
    set_interval(Duration::from_millis(5), move || {
        let step = STEP.load(Ordering::SeqCst);
        if step == done.get_untracked() {
            return;
        }
        done.set(step);
        // The rows' new heights and the scroll go out in one commit.
        match step {
            1 => {
                tall.set(true);
                list.scroll_to_index(7, Percentage(1.0), px(0.0), false);
            }
            2 => {
                tall.set(false);
                list.scroll_to_index(1, Percentage(1.0), px(-36.0), false);
            }
            _ => {}
        }
    });
    view().flex_1().child(
        virtual_list(300, move |at| {
            text(move || format!("Row {}", at.index()))
                .h(move || px(if tall.get() { 62.0 } else { 48.0 }))
        })
        .estimated_item_size(px(48.0))
        .test_id("list")
        .flex_1()
        .element_ref(&list),
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

/// The list's offset as AppKit holds it once the view rests: its
/// container's bounds origin.
fn offset(list: &NSView) -> Option<f64> {
    list.subviews()
        .iter()
        .find(|v| v.class().name().to_str() != Ok("NshScrollOverlay"))
        .map(|c| c.bounds().origin.y)
}

fn pump(ms: u64) {
    let end = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < end {
        autoreleasepool(|_| {
            NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
        });
    }
}

/// Runs the main run loop until `done` holds, for at most 5 s.
fn until(what: &str, mut done: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(5);
    while !autoreleasepool(|_| done()) {
        assert!(Instant::now() < end, "{what}");
        pump(5);
    }
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    NSApplication::sharedApplication(mtm).finishLaunching();
    STEP.store(0, Ordering::SeqCst);
    // SAFETY: The window is created on the process main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(760.0, 260.0), NSSize::new(320.0, 300.0)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe {
        window.setReleasedWhenClosed(false);
    }
    window.setTitle(&NSString::from_str("NSH clamped scroll to index"));
    let app = platform::AppView::new(
        mtm,
        platform::AppOptions {
            size: (320, 300),
            ..Default::default()
        },
    );
    window.setContentView(Some(&app.view()));
    app.load(platform::App::Rust(platform::Root::of::<List>()));
    window.orderFrontRegardless();
    let root = app.view();
    until("the list's mount", || find(&root, "list").is_some());
    pump(300);
    STEP.store(1, Ordering::SeqCst);
    // Row 7's bottom (8 × 62) at the viewport's end.
    until("the list rests away from the start", || {
        find(&root, "list")
            .and_then(|l| offset(&l))
            .is_some_and(|y| y > 100.0)
    });
    pump(1500);
    let before = find(&root, "list").and_then(|l| offset(&l)).unwrap();
    STEP.store(2, Ordering::SeqCst);
    // Past the bounds commit's rest wait: AppKit's bounds hold the offset.
    pump(2500);
    let after = autoreleasepool(|_| find(&root, "list").and_then(|l| offset(&l)).unwrap());
    assert!(
        after.abs() < 0.5,
        "a scroll_to_index clamped to the start left the list at {after} (from {before}), \
         not at its start"
    );
    println!(
        "clamped_scroll: a scroll_to_index clamped to the start rests at the start \
         (from {before})"
    );
    app.stop();
    window.close();
}
