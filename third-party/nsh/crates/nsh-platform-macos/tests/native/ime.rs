//! An input method's composition (marked text, set through
//! `NSTextInputClient` as an input method sets it) when its input loses the
//! keyboard focus: the composed text stays, committed, and the app hears it
//! (`onChangeText`) before the composition ends, as a browser's blur
//! commits a composition. For a single line (the window's field editor) the
//! app blurs, and for a multiline input (a text view) whose focus the window
//! gives to another field.

use std::{
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use nsh_core::{element::input, prelude::*};
use nsh_platform_macos as platform;
use platform::{
    objc2::{MainThreadMarker, MainThreadOnly, Message, msg_send, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSBackingStoreType, NSTextField, NSTextView, NSView, NSWindow,
        NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRange, NSRect, NSRunLoop, NSSize, NSString},
};

/// What the inputs reported, in order.
static EVENTS: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// The test sets it for the app to blur the single line.
static BLUR: AtomicBool = AtomicBool::new(false);

fn record(event: String) {
    EVENTS.lock().unwrap().push(event);
}

/// A single line and a multiline input that tell their changes and
/// compositions.
#[component]
fn Fields() -> impl IntoElement {
    let line = element_ref();
    set_interval(Duration::from_millis(10), move || {
        if BLUR.swap(false, Ordering::SeqCst) {
            line.blur();
        }
    });
    let field = |name: &'static str| {
        input()
            .test_id(name)
            .w(px(300.0))
            .h(px(40.0))
            .on_change(move |text: &str| record(format!("{name} change {text}")))
            .on_composition_change(move |c: &Composition| {
                record(format!("{name} composition {} {}", c.composing, c.text));
            })
    };
    view()
        .flex_1()
        .p(px(16.0))
        .gap(px(8.0))
        .child(field("line").element_ref(&line))
        .child(field("area").multiline(true))
}

fn pump(ms: u64) {
    let deadline = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < deadline {
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
    }
}

/// Runs the main run loop until `done` holds, for at most 5 s.
fn until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(
            Instant::now() < deadline,
            "{what} never happened: {:?}",
            EVENTS.lock().unwrap()
        );
        pump(10);
    }
}

/// The view with identifier `id` under `view`.
fn view_with_id(view: &NSView, id: &str) -> Option<Retained<NSView>> {
    if view
        .accessibilityIdentifier()
        .is_some_and(|i| i.to_string() == id)
    {
        return Some(view.retain());
    }
    view.subviews().iter().find_map(|c| view_with_id(&c, id))
}

/// The first view under `view` (itself included) that `matches`.
fn find(view: &NSView, matches: &dyn Fn(&NSView) -> bool) -> Option<Retained<NSView>> {
    if matches(view) {
        return Some(view.retain());
    }
    view.subviews().iter().find_map(|c| find(&c, matches))
}

/// Gives input `id` the keyboard focus and composes `text` in it as an
/// input method does (`setMarkedText:selectedRange:replacementRange:` on
/// the text view that edits).
fn compose(window: &NSWindow, root: &NSView, id: &str, text: &str) {
    let input = view_with_id(root, id).unwrap_or_else(|| panic!("no input {id}"));
    // A multiline input's text view (its placeholder is a label, a text
    // field), else a single line's field.
    let editor = find(&input, &|v| v.downcast_ref::<NSTextView>().is_some())
        .or_else(|| find(&input, &|v| v.downcast_ref::<NSTextField>().is_some()))
        .expect("the input's editor");
    assert!(
        window.makeFirstResponder(Some(&editor)),
        "{id} takes the focus"
    );
    pump(50);
    let responder = window.firstResponder().expect("a first responder");
    let marked = NSString::from_str(text);
    let length = marked.length();
    // SAFETY: NSTextInputClient's method, on the text view that edits (the
    // field editor of a field), on the main thread.
    let _: () = unsafe {
        msg_send![
            &*responder,
            setMarkedText: &*marked,
            selectedRange: NSRange::new(length, 0),
            replacementRange: NSRange::new(isize::MAX as usize, 0)
        ]
    };
}

/// Checks that `name` reported `text` composed, then committed before the
/// composition's end.
fn assert_committed(name: &str, text: &str) {
    let change = format!("{name} change {text}");
    let end = format!("{name} composition false ");
    until(&format!("{name}'s composition end"), || {
        EVENTS.lock().unwrap().contains(&end)
    });
    let events = EVENTS.lock().unwrap().clone();
    let at = |e: &str| events.iter().position(|x| x == e);
    let started = at(&format!("{name} composition true {text}"));
    assert!(started.is_some(), "{name} composed {text}: {events:?}");
    assert!(
        at(&change).is_some_and(|c| c > started.unwrap() && c < at(&end).unwrap()),
        "{name}: the committed text comes after the composition and before its end: {events:?}"
    );
}

/// Runs after `window_press::run`, which launched the application.
// `AppOptions` is non-exhaustive: its fields are set after `default()`.
#[allow(clippy::field_reassign_with_default)]
pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    // SAFETY: The window is created on the process main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(700.0, 300.0), NSSize::new(400.0, 200.0)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe {
        window.setReleasedWhenClosed(false);
    }
    let mut options = platform::AppOptions::default();
    options.size = (400, 200);
    let surface = platform::AppView::new(mtm, options);
    window.setContentView(Some(&surface.view()));
    surface.load(platform::App::Rust(platform::Root::of::<Fields>()));
    window.makeKeyAndOrderFront(None);
    let root = surface.view();
    until("the inputs' mount", || {
        view_with_id(&root, "area").is_some()
    });

    // The app blurs a single line while it composes.
    compose(&window, &root, "line", "にほん");
    until("the line's composition", || {
        EVENTS
            .lock()
            .unwrap()
            .contains(&"line composition true にほん".to_owned())
    });
    BLUR.store(true, Ordering::SeqCst);
    assert_committed("line", "にほん");

    // The window gives the focus from a multiline input that composes to
    // another field.
    compose(&window, &root, "area", "かな");
    until("the area's composition", || {
        EVENTS
            .lock()
            .unwrap()
            .contains(&"area composition true かな".to_owned())
    });
    let line = view_with_id(&root, "line").expect("the line");
    let field = find(&line, &|v| v.downcast_ref::<NSTextField>().is_some()).expect("its field");
    window.makeFirstResponder(Some(&field));
    assert_committed("area", "かな");

    println!("ime: a composition is committed and reported when its input loses the focus");
    surface.stop();
    window.close();
}
