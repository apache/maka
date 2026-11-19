//! A fade keeps the modal's AppKit material and backdrop in the window
//! until its last frame, even when the core deletes the modal's subtree.
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use nsh_core::{GlassEffect, ModalAnimation, element::modal, prelude::*};
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize},
};
static OPEN: AtomicBool = AtomicBool::new(true);
#[component]
fn Dialog() -> impl IntoElement {
    let open = signal(true);
    set_interval(Duration::from_millis(5), move || {
        open.set(OPEN.load(Ordering::SeqCst))
    });
    view().flex_1().child(when(
        move || open.get(),
        || {
            modal()
                .test_id("fading-modal")
                .animation(ModalAnimation::Fade)
                .child(
                    view()
                        .test_id("material")
                        .focusable(true)
                        .w(px(200.0))
                        .h(px(100.0))
                        .glass_effect(GlassEffect::Regular)
                        .child(text("Glass stays alive")),
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
fn until(what: &str, mut done: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < end, "{what}");
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.001));
    }
}
pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    NSApplication::sharedApplication(mtm).finishLaunching();
    OPEN.store(true, Ordering::SeqCst);
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
    unsafe { window.setReleasedWhenClosed(false) };
    let app = platform::AppView::new(
        mtm,
        platform::AppOptions {
            size: (320, 240),
            ..Default::default()
        },
    );
    window.setContentView(Some(&app.view()));
    app.load(platform::App::Rust(platform::Root::of::<Dialog>()));
    window.orderFront(None);
    until("modal mounted", || find(&app.view(), "material").is_some());
    NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.5));
    let modal = find(&app.view(), "fading-modal").unwrap();
    let material = find(&modal, "material").unwrap();
    let children = material.subviews();
    assert!(material.acceptsFirstResponder(), "open dialog is focusable");
    assert!(!children.is_empty(), "native material exists");
    let closing = Instant::now();
    OPEN.store(false, Ordering::SeqCst);
    until("fade started", || {
        modal.window().is_none() || modal.layer().unwrap().opacity() < 1.0
    });
    assert!(
        modal.window().is_some(),
        "closing must not replace the live material with a bitmap (observed after {:?})",
        closing.elapsed()
    );
    assert!(
        modal.layer().unwrap().opacity() > 0.0,
        "observed an intermediate frame"
    );
    assert!(
        !material.acceptsFirstResponder(),
        "a closing dialog must leave keyboard navigation"
    );
    assert_eq!(
        material.subviews(),
        children,
        "material survives subtree deletion"
    );
    // A new dialog can open before the previous fade has finished.
    OPEN.store(true, Ordering::SeqCst);
    until("replacement modal mounted", || {
        find(&app.view(), "fading-modal").is_some_and(|v| v != modal)
    });
    let replacement = find(&app.view(), "fading-modal").unwrap();
    until("modal detached after fade", || modal.window().is_none());
    assert!(
        replacement.window().is_some(),
        "the old fade must not remove the new modal"
    );
    OPEN.store(false, Ordering::SeqCst);
    until("replacement detached", || replacement.window().is_none());
    assert!(find(&app.view(), "fading-modal").is_none());
    app.stop();
    window.close();
    println!("modal_fade: live material survives until fade ends");
}
