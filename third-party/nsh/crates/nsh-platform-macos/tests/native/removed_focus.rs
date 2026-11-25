//! A view with the keyboard focus leaves the tree (an app replaces the
//! panel holding a focused field or Tab stop): the focus goes to the
//! surface's root, as when the view hides or is blurred, not to the window,
//! where no responder handles the root's keys and actions. A text selected
//! on the page afterwards is copied by Copy. The removed view hears no blur.
//! Read from a real `AppView` in a window.
//!
//! `NSH_REMOVED_FOCUS_CHECK_ONLY=1` runs this check alone.

use std::{
    sync::{
        Mutex,
        atomic::{AtomicU8, Ordering},
    },
    time::{Duration, Instant},
};

use nsh_base::input;
use nsh_core::prelude::*;
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained, sel},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSEvent, NSEventMask,
        NSEventModifierFlags, NSEventType, NSPasteboard, NSPasteboardTypeString, NSTextField,
        NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSDefaultRunLoopMode, NSPoint, NSProcessInfo, NSRect, NSSize},
};

/// The selectable text on the page.
const BODY: &str = "Selectable body text";

/// The panel's content: 0 a field, 1 a Tab stop, 2 neither.
static STEP: AtomicU8 = AtomicU8::new(0);
/// Focus and blur events, in order, as `focus field` / `blur field`.
static EVENTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn note(event: String) {
    EVENTS.lock().unwrap().push(event);
}

fn events() -> Vec<String> {
    EVENTS.lock().unwrap().clone()
}

#[component]
fn Page() -> impl IntoElement {
    let step = signal(STEP.load(Ordering::SeqCst));
    set_interval(Duration::from_millis(5), move || {
        let now = STEP.load(Ordering::SeqCst);
        if step.get_untracked() != now {
            step.set(now);
        }
    });
    view()
        .size_full()
        .p(px(24.0))
        .gap(px(12.0))
        .child(
            view()
                .test_id("body")
                .selectable(true)
                .child(text(BODY).text_color(rgb(0x111111))),
        )
        .child(when(
            move || step.get() == 0,
            || {
                view().test_id("field-panel").child(
                    input()
                        .test_id("field")
                        .w(px(240.0))
                        .h(px(32.0))
                        .p(px(6.0))
                        .on_focus(|| note("focus field".into()))
                        .on_blur(|| note("blur field".into())),
                )
            },
        ))
        .child(when(
            move || step.get() == 1,
            || {
                view().test_id("stop-panel").child(
                    view()
                        .test_id("stop")
                        .focusable(true)
                        .w(px(120.0))
                        .h(px(32.0))
                        .on_focus(|| note("focus stop".into()))
                        .on_blur(|| note("blur stop".into()))
                        .child(text("Stop")),
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

fn field(root: &NSView) -> Option<Retained<NSTextField>> {
    fn first(view: &NSView) -> Option<Retained<NSTextField>> {
        view.subviews()
            .iter()
            .find_map(|child| match child.downcast_ref::<NSTextField>() {
                Some(field) if !field.isHiddenOrHasHiddenAncestor() => Some(field.retain()),
                _ => first(&child),
            })
    }
    first(&*find(root, "field")?)
}

fn pump(app: &NSApplication, ms: u64) {
    let deadline = Instant::now() + Duration::from_millis(ms);
    // SAFETY: AppKit's immutable default run-loop mode.
    let mode = unsafe { NSDefaultRunLoopMode };
    while Instant::now() < deadline {
        if let Some(e) = app.nextEventMatchingMask_untilDate_inMode_dequeue(
            NSEventMask::Any,
            Some(&NSDate::dateWithTimeIntervalSinceNow(0.002)),
            mode,
            true,
        ) {
            app.sendEvent(&e);
        }
        app.updateWindows();
    }
}

/// Runs the loop until `done`, failing with `what` after a few seconds.
fn until(app: &NSApplication, what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "{what}");
        pump(app, 10);
    }
}

fn mouse_event(kind: NSEventType, point: NSPoint, window: &NSWindow, ts: f64) -> Retained<NSEvent> {
    NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        kind,
        point,
        NSEventModifierFlags::empty(),
        ts,
        window.windowNumber(),
        None,
        0,
        1,
        1.0,
    )
    .unwrap()
}

/// Drags across `view` from its left edge to past its right edge, as the
/// user selects its text.
fn drag_across(app: &NSApplication, window: &NSWindow, view: &NSView) {
    let bounds = view.bounds();
    let y = bounds.size.height / 2.0;
    let start = view.convertPoint_toView(NSPoint::new(1.0, y), None);
    let end = view.convertPoint_toView(NSPoint::new(bounds.size.width + 20.0, y), None);
    let ts = NSProcessInfo::processInfo().systemUptime();
    window.sendEvent(&mouse_event(NSEventType::LeftMouseDown, start, window, ts));
    let steps = 8;
    for step in 1..=steps {
        let t = f64::from(step) / f64::from(steps);
        let p = NSPoint::new(start.x + (end.x - start.x) * t, start.y);
        window.sendEvent(&mouse_event(
            NSEventType::LeftMouseDragged,
            p,
            window,
            ts + 0.005 * f64::from(step),
        ));
    }
    window.sendEvent(&mouse_event(
        NSEventType::LeftMouseUp,
        end,
        window,
        ts + 0.05,
    ));
    pump(app, 80);
}

/// Whether the surface's root view, the one in the `AppView`'s container
/// holding the page, is the window's first responder.
fn root_focused(window: &NSWindow, container: &NSView) -> bool {
    let body = find(container, "body").expect("the page's body");
    let root = container
        .subviews()
        .iter()
        .find(|v| body.isDescendantOf(v))
        .expect("the root holding the page");
    window
        .firstResponder()
        .and_then(|r| r.downcast::<NSView>().ok())
        .is_some_and(|r| *r == *root)
}

/// The responder chain's Copy, as the Edit menu sends it: what it put on
/// the pasteboard, or `None` when no responder handles it. The pasteboard
/// is the developer's own: its text is put back after the copy is read.
fn copy(window: &NSWindow) -> Option<String> {
    let pasteboard = NSPasteboard::generalPasteboard();
    // SAFETY: an immutable AppKit pasteboard type constant.
    let kind = unsafe { NSPasteboardTypeString };
    let saved = pasteboard.stringForType(kind);
    pasteboard.clearContents();
    let handled = window.firstResponder().is_some_and(|r| {
        // SAFETY: `copy:` takes a sender, which may be nil.
        unsafe { r.tryToPerform_with(sel!(copy:), None) }
    });
    let copied = pasteboard.stringForType(kind).map(|s| s.to_string());
    pasteboard.clearContents();
    if let Some(saved) = saved {
        pasteboard.setString_forType(&saved, kind);
    }
    handled.then_some(copied).flatten()
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    let app = NSApplication::sharedApplication(mtm);
    app.finishLaunching();
    // SAFETY: window creation and ownership on the main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(200.0, 200.0), NSSize::new(400.0, 200.0)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: retained here through close.
    unsafe { window.setReleasedWhenClosed(false) };
    let surface = platform::AppView::new(
        mtm,
        platform::AppOptions {
            size: (400, 200),
            ..Default::default()
        },
    );
    let root = surface.view();
    window.setContentView(Some(&root));
    STEP.store(0, Ordering::SeqCst);
    EVENTS.lock().unwrap().clear();
    surface.load(platform::App::Rust(platform::Root::of::<Page>()));
    window.makeKeyAndOrderFront(None);
    app.activate();
    until(&app, "the field did not mount", || field(&root).is_some());

    // A focused field's panel is replaced.
    let field = field(&root).unwrap();
    assert!(window.makeFirstResponder(Some(&field)));
    until(&app, "no focus field", || events() == ["focus field"]);
    STEP.store(1, Ordering::SeqCst);
    until(&app, "the field's panel was not replaced", || {
        find(&root, "field").is_none() && find(&root, "stop").is_some()
    });
    pump(&app, 50);
    assert!(
        root_focused(&window, &root),
        "the focus of a removed field went to {:?}, not the root",
        window.firstResponder()
    );
    assert_eq!(events(), ["focus field"], "a removed field heard its blur");

    // The text the user selects on the page is copied.
    drag_across(&app, &window, &find(&root, "body").unwrap());
    assert_eq!(
        copy(&window).as_deref(),
        Some(BODY),
        "Copy did not copy the page's selection after the field was removed"
    );

    // A focused Tab stop's panel is removed.
    let stop = find(&root, "stop").unwrap();
    assert!(window.makeFirstResponder(Some(&stop)));
    until(&app, "no focus stop", || {
        events() == ["focus field", "focus stop"]
    });
    STEP.store(2, Ordering::SeqCst);
    until(&app, "the stop's panel was not removed", || {
        find(&root, "stop").is_none()
    });
    pump(&app, 50);
    assert!(
        root_focused(&window, &root),
        "the focus of a removed Tab stop went to {:?}, not the root",
        window.firstResponder()
    );
    assert_eq!(
        events(),
        ["focus field", "focus stop"],
        "a removed Tab stop heard its blur"
    );

    surface.stop();
    window.close();
    println!("removed_focus: a removed field's and Tab stop's focus went to the root");
}
