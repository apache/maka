//! Tab and Shift+Tab pass over a disabled input and one with
//! `focusable: false`, as they pass over such views, read from the
//! window's first responder in a real `AppView`: a field, a secure field
//! and a text view, one whose pad is lifted above a scaled view
//! (`place_pad`), and one disabled while it is mounted and enabled again.
//! A readonly input is no stop either, as before and as in the headless
//! driver (its stops are editable inputs).
//!
//! `NSH_INPUT_TAB_STOPS_CHECK_ONLY=1` runs this check alone.
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use nsh_base::input;
use nsh_core::prelude::*;
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, Message, msg_send, rc::Retained, sel},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSTextField, NSView, NSWindow,
        NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize},
};

/// Whether the `toggle` input is disabled.
static TOGGLE_DISABLED: AtomicBool = AtomicBool::new(true);

/// The single-line inputs Tab may reach or must pass over, in order.
const FIELDS: [&str; 6] = [
    "first",
    "disabled",
    "unfocusable",
    "readonly",
    "lifted",
    "toggle",
];

#[component]
fn Page() -> impl IntoElement {
    let toggle_disabled = signal(true);
    set_interval(Duration::from_millis(5), move || {
        let now = TOGGLE_DISABLED.load(Ordering::SeqCst);
        if toggle_disabled.get_untracked() != now {
            toggle_disabled.set(now);
        }
    });
    let field = |id| input().test_id(id).w(px(200.0)).h(px(28.0)).p(px(6.0));
    view()
        .size_full()
        .p(px(12.0))
        .gap(px(6.0))
        .child(field("first"))
        .child(field("disabled").disabled(true))
        .child(field("unfocusable").masked(true).focusable(false))
        .child(field("area").multiline(true).h(px(44.0)).disabled(true))
        .child(field("readonly").readonly(true))
        .child(
            view()
                .w(px(220.0))
                .h(px(32.0))
                .origin_top_left()
                .scale(1.05)
                .child(field("lifted").disabled(true)),
        )
        .child(field("toggle").disabled(move || toggle_disabled.get()))
        .child(field("last"))
}

fn find(view: &NSView, matches: &dyn Fn(&NSView) -> bool) -> Option<Retained<NSView>> {
    if matches(view) {
        return Some(view.retain());
    }
    view.subviews()
        .iter()
        .find_map(|child| find(&child, matches))
}

/// The field of the input whose test id is `id`.
fn field(root: &NSView, id: &str) -> Option<Retained<NSTextField>> {
    let input = find(root, &|v| {
        v.accessibilityIdentifier()
            .is_some_and(|s| s.to_string() == id)
    })?;
    find(&input, &|v| {
        v.downcast_ref::<NSTextField>().is_some() && !v.isHiddenOrHasHiddenAncestor()
    })?
    .downcast::<NSTextField>()
    .ok()
}

/// The test id of the input whose field edits now (its field editor is the
/// first responder).
fn focused(window: &NSWindow, root: &NSView) -> Option<&'static str> {
    let responder = window.firstResponder()?;
    FIELDS.into_iter().chain(["last"]).find(|id| {
        field(root, id)
            .and_then(|f| f.currentEditor())
            .is_some_and(|editor| {
                std::ptr::eq(
                    &*editor as *const _ as *const (),
                    &*responder as *const _ as *const (),
                )
            })
    })
}

/// Tab (or Shift+Tab) in the field editor, as AppKit sends it.
fn tab(window: &NSWindow, backward: bool) {
    let responder = window.firstResponder().expect("a field edits");
    let command = if backward {
        sel!(insertBacktab:)
    } else {
        sel!(insertTab:)
    };
    // SAFETY: the first responder is the field editor, an NSTextView.
    unsafe {
        let _: () = msg_send![&*responder, doCommandBySelector: command];
    }
}

fn until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "{what} never happened");
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
    }
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().expect("the checks run on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.finishLaunching();
    // SAFETY: a plain titled window, released by its owner.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(100.0, 100.0), NSSize::new(320.0, 240.0)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: the retained window owns its lifetime after close.
    unsafe { window.setReleasedWhenClosed(false) };
    let view = platform::AppView::new(
        mtm,
        platform::AppOptions {
            size: (320, 240),
            ..Default::default()
        },
    );
    let root = view.view();
    window.setContentView(Some(&root));
    view.load(platform::App::Rust(platform::Root::of::<Page>()));
    window.makeKeyAndOrderFront(None);
    until("the inputs mount", || field(&root, "last").is_some());

    let first = field(&root, "first").unwrap();
    assert!(window.makeFirstResponder(Some(&first)));
    until("the first field edits", || {
        focused(&window, &root) == Some("first")
    });
    let step = |backward: bool, to: &str| {
        tab(&window, backward);
        until(&format!("Tab reaches {to}"), || {
            focused(&window, &root) == Some(to)
        });
    };
    // Past the disabled, unfocusable, lifted and readonly ones.
    step(false, "last");
    step(true, "first");
    // Enabled while mounted, it is a stop again.
    TOGGLE_DISABLED.store(false, Ordering::SeqCst);
    NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.3));
    step(false, "toggle");
    step(false, "last");
    step(true, "toggle");
    step(true, "first");
    window.close();
    println!("input tab stops: ok");
}
