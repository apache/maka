//! Inputs in a subtree hidden with `display: none` (#1440): the core lays
//! the subtree's views out at a zero frame, and the input's editor, hosted
//! in a pad that does not clip, must not keep drawing at its last frame.
//! Each kind of editor is checked (a field, a secure field, a text view):
//! with text in it, it is shown, hidden while it stays mounted, and shown
//! again, read from the native `NSView` hierarchy of a real `AppView`.

use std::{
    cell::RefCell,
    rc::Rc,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use nsh_base::input;
use nsh_core::prelude::*;
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSScrollView, NSTextField, NSView,
        NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize, NSString},
};

/// Whether the first tab, the one with the inputs, is hidden.
static HIDE: AtomicBool = AtomicBool::new(false);

/// The inputs, by test id: a field, a secure field and a text view.
const INPUTS: [&str; 3] = ["line", "secure", "area"];

/// Two tabs that stay mounted, one shown at a time, in a scroll view's
/// content as a tab view puts them.
#[component]
fn Tabs() -> impl IntoElement {
    let hide = signal(HIDE.load(Ordering::SeqCst));
    set_interval(Duration::from_millis(5), move || {
        let now = HIDE.load(Ordering::SeqCst);
        if hide.get_untracked() != now {
            hide.set(now);
        }
    });
    let field = |id: &'static str| {
        input()
            .test_id(id)
            .default_value("Typed text")
            .w(px(200.0))
            .h(px(40.0))
            .p(px(4.0))
    };
    scroll().size_full().child(
        view()
            .child(
                view()
                    .test_id("first")
                    .style_when(move || hide.get(), |s| s.hidden())
                    .gap(px(8.0))
                    .child(field("line"))
                    .child(field("secure").masked(true))
                    .child(field("area").multiline(true).h(px(80.0))),
            )
            .child(
                view()
                    .test_id("second")
                    .style_when(move || !hide.get(), |s| s.hidden())
                    .child(text("Second tab")),
            ),
    )
}

/// The view whose accessibility identifier is `id`.
fn find(view: &NSView, id: &str) -> Option<Retained<NSView>> {
    if view
        .accessibilityIdentifier()
        .is_some_and(|value| value.to_string() == id)
    {
        return Some(view.retain());
    }
    view.subviews().iter().find_map(|child| find(&child, id))
}

/// The editor in an input's view: its text view's scroll view, or its
/// field (a text view's placeholder is a field too, hidden while it has
/// text).
fn editor(view: &NSView) -> Option<Retained<NSView>> {
    fn first(view: &NSView, is: &dyn Fn(&NSView) -> bool) -> Option<Retained<NSView>> {
        view.subviews().iter().find_map(|child| {
            if is(&child) {
                Some(child.clone())
            } else {
                first(&child, is)
            }
        })
    }
    first(view, &|v| v.downcast_ref::<NSScrollView>().is_some())
        .or_else(|| first(view, &|v| v.downcast_ref::<NSTextField>().is_some()))
}

/// Whether the editor of input `id` draws anywhere: it is in the window,
/// not hidden, and has an area.
fn visible(root: &NSView, id: &str) -> bool {
    find(root, id)
        .and_then(|input| editor(&input))
        .is_some_and(|editor| {
            let size = editor.frame().size;
            !editor.isHiddenOrHasHiddenAncestor()
                && editor.window().is_some()
                && size.width > 0.0
                && size.height > 0.0
        })
}

/// Whether the editor of input `id` draws in the input's view: it is
/// visible, and the view has an area that holds it.
fn drawn(root: &NSView, id: &str) -> bool {
    let Some(input) = find(root, id) else {
        return false;
    };
    let Some(editor) = editor(&input) else {
        return false;
    };
    let rect = editor.convertRect_toView(editor.bounds(), Some(&input));
    let frame = input.bounds();
    visible(root, id)
        && frame.size.width > 0.0
        && frame.size.height > 0.0
        // A field reaches past the box by its cell's padding.
        && rect.origin.x >= -4.0
        && rect.origin.x + rect.size.width <= frame.size.width + 4.0
}

/// Runs the main run loop until `done` holds, for at most five seconds.
fn until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "{what} never happened");
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
    }
}

/// Runs the main run loop for `seconds`.
fn settle(seconds: f64) {
    NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(seconds));
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().expect("the checks run on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.finishLaunching();
    HIDE.store(false, Ordering::SeqCst);
    // SAFETY: The window is created on the process main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(200.0, 200.0), NSSize::new(360.0, 280.0)),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Closable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(&NSString::from_str("NSH hidden input regression"));
    let options = platform::AppOptions {
        size: (360, 280),
        ..Default::default()
    };
    let surface: Rc<platform::AppView> = platform::AppView::new(mtm, options);
    window.setContentView(Some(&surface.view()));
    surface.load(platform::App::Rust(platform::Root::of::<Tabs>()));
    window.orderFront(None);
    let root = surface.view();
    let failures = RefCell::new(Vec::new());

    until("the inputs showing", || {
        INPUTS.iter().all(|id| drawn(&root, id))
    });
    HIDE.store(true, Ordering::SeqCst);
    until("the second tab showing", || {
        find(&root, "second").is_some_and(|v| v.frame().size.width > 0.0)
    });
    // Frames after the one that hid the tab must not show it again.
    settle(0.2);
    for id in INPUTS {
        if visible(&root, id) {
            failures
                .borrow_mut()
                .push(format!("input `{id}` drew in its hidden tab"));
        }
    }
    HIDE.store(false, Ordering::SeqCst);
    until("the inputs showing again", || {
        INPUTS.iter().all(|id| drawn(&root, id))
    });

    surface.stop();
    window.close();
    let failures = failures.into_inner();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    println!(
        "input_hidden: {} inputs hidden and shown again",
        INPUTS.len()
    );
}
