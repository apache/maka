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
    objc2::{AnyThread, MainThreadMarker, MainThreadOnly, Message, msg_send, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSTextField, NSTextInputClient,
        NSTextView, NSView, NSWindow, NSWindowStyleMask,
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
        .child(field("incomplete").multiline(true))
        .child(field("limited").max_length(3u32))
        .child(field("limited_area").multiline(true).max_length(3u32))
        .child(field("accepted").max_length(3u32))
        .child(field("accepted_area").multiline(true).max_length(3u32))
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
fn compose(window: &NSWindow, root: &NSView, id: &str, marked: &NSString) {
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
    mark(window, marked);
}

/// Composes `marked` in the focused input as an input method does, in place
/// of what it composed before.
fn mark(window: &NSWindow, marked: &NSString) {
    let responder = window.firstResponder().expect("a first responder");
    // SAFETY: NSTextInputClient's method, on the text view that edits (the
    // field editor of a field), on the main thread.
    let _: () = unsafe {
        msg_send![
            &*responder,
            setMarkedText: marked,
            selectedRange: NSRange::new(marked.length(), 0),
            replacementRange: NSRange::new(isize::MAX as usize, 0)
        ]
    };
}

/// Commits `text` in the focused input as an input method does
/// (`insertText:replacementRange:`, in place of what it marked) and returns
/// the editor's text.
fn commit(window: &NSWindow, text: &str) -> String {
    let responder = window.firstResponder().expect("a first responder");
    // SAFETY: NSTextInputClient's method, on the text view that edits, on
    // the main thread.
    let _: () = unsafe {
        msg_send![
            &*responder,
            insertText: &*NSString::from_str(text),
            replacementRange: NSRange::new(isize::MAX as usize, 0)
        ]
    };
    editor_text(window)
}

/// The editor with the keyboard focus.
fn editor(window: &NSWindow) -> Retained<NSTextView> {
    let responder = window.firstResponder().expect("a first responder");
    responder
        .downcast::<NSTextView>()
        .unwrap_or_else(|_| panic!("a text view"))
}

/// The text of the editor with the keyboard focus.
fn editor_text(window: &NSWindow) -> String {
    editor(window).string().to_string()
}

/// How many times `name` reported `event`.
fn reported(name: &str, event: &str) -> usize {
    let event = format!("{name} {event}");
    EVENTS
        .lock()
        .unwrap()
        .iter()
        .filter(|e| **e == event)
        .count()
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

/// Composes pinyin past the room `maxLength` (3) leaves in empty input
/// `name`: the composition stays whole while it is composed (no pinyin
/// becomes text), as in a browser.
fn compose_nihao(window: &NSWindow, root: &NSView, name: &str) {
    for (i, pinyin) in ["n", "ni", "nih", "niha", "nihao"].iter().enumerate() {
        if i == 0 {
            compose(window, root, name, &NSString::from_str(pinyin));
        } else {
            mark(window, &NSString::from_str(pinyin));
        }
        assert_eq!(editor_text(window), *pinyin, "{name} composing {pinyin}");
    }
    until(&format!("{name}'s composition"), || {
        reported(name, "composition true nihao") == 1
    });
}

/// Checks that `name` committed `text` once, with the composition ended
/// after it (its `ends`th end), and never committed pinyin.
fn assert_clipped_commit(window: &NSWindow, name: &str, text: &str, ends: usize) {
    until(&format!("{name}'s commit of {text}"), || {
        reported(name, &format!("change {text}")) == 1
            && reported(name, "composition false ") == ends
    });
    assert!(
        !editor(window).hasMarkedText(),
        "{name}: no composition is left after {text}"
    );
    let events = EVENTS.lock().unwrap().clone();
    let at = |e: &str| events.iter().rposition(|x| x == e);
    assert!(
        at(&format!("{name} change {text}")) < at(&format!("{name} composition false ")),
        "{name}: {text} is reported before the composition's end: {events:?}"
    );
    assert!(
        !events
            .iter()
            .filter_map(|e| e.strip_prefix(&format!("{name} change ")))
            .any(|text| text.chars().any(|c| c.is_ascii_lowercase())),
        "{name}: no pinyin is committed: {events:?}"
    );
}

/// `maxLength` (3) of input `name` limits what an input method commits, not
/// what it composes: what the pinyin turns into is clipped when committed,
/// as a browser does.
fn commits_past_max_length(window: &NSWindow, root: &NSView, name: &str) {
    compose_nihao(window, root, name);
    assert_eq!(commit(window, "你好"), "你好", "{name}: the commit fits");
    assert_clipped_commit(window, name, "你好", 1);
    mark(window, &NSString::from_str("ma"));
    assert_eq!(
        editor_text(window),
        "你好ma",
        "{name}: a composition past the room"
    );
    assert_eq!(
        commit(window, "妈妈"),
        "你好妈",
        "{name}: the commit is clipped"
    );
    assert_clipped_commit(window, name, "你好妈", 2);
}

/// A composition past the room `maxLength` (3) leaves in input `name` that
/// is accepted as it is (`unmarkText`, as a return during a composition
/// does), not committed: what it leaves is clipped as a commit is.
fn accepts_past_max_length(window: &NSWindow, root: &NSView, name: &str) {
    compose_nihao(window, root, name);
    editor(window).unmarkText();
    assert_eq!(
        editor_text(window),
        "nih",
        "{name}: the accepted text is clipped"
    );
    until(&format!("{name}'s accepted text"), || {
        reported(name, "change nih") == 1 && reported(name, "composition false ") == 1
    });
    assert!(
        !editor(window).hasMarkedText(),
        "{name}: no composition is left"
    );
}

/// Checks composition reporting and commit through real native editors.
// `AppOptions` is non-exhaustive: its fields are set after `default()`.
#[allow(clippy::field_reassign_with_default)]
pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    NSApplication::sharedApplication(mtm).finishLaunching();
    // SAFETY: The window is created on the process main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(700.0, 100.0), NSSize::new(400.0, 420.0)),
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
    options.size = (400, 420);
    let surface = platform::AppView::new(mtm, options);
    window.setContentView(Some(&surface.view()));
    surface.load(platform::App::Rust(platform::Root::of::<Fields>()));
    window.makeKeyAndOrderFront(None);
    let root = surface.view();
    until("the inputs' mount", || {
        view_with_id(&root, "area").is_some()
    });

    // The app blurs a single line while it composes.
    compose(&window, &root, "line", &NSString::from_str("にほん"));
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
    compose(&window, &root, "area", &NSString::from_str("かな"));
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

    // A transient, incomplete UTF-16 composition is reported lossily without
    // replacing AppKit's native text or crashing in NSString's UTF-8 conversion.
    let mut units = [0x306b, 0xd800, 0x307b];
    // SAFETY: The initialized buffer contains units.len() UTF-16 units.
    let incomplete = unsafe {
        NSString::initWithCharacters_length(
            NSString::alloc(),
            std::ptr::NonNull::new(units.as_mut_ptr()).unwrap(),
            units.len(),
        )
    };
    compose(&window, &root, "incomplete", &incomplete);
    until("the incomplete composition", || {
        EVENTS
            .lock()
            .unwrap()
            .contains(&"incomplete composition true に�ほ".to_owned())
    });
    let responder = window.firstResponder().unwrap();
    let editor = responder.downcast_ref::<NSTextView>().unwrap();
    assert_eq!(editor.string().characterAtIndex(1), 0xd800);
    window.makeFirstResponder(Some(&field));
    assert_committed("incomplete", "に�ほ");

    // `maxLength` limits what is committed, not what an input method
    // composes, in a single line and in a multiline input.
    commits_past_max_length(&window, &root, "limited");
    commits_past_max_length(&window, &root, "limited_area");
    accepts_past_max_length(&window, &root, "accepted");
    accepts_past_max_length(&window, &root, "accepted_area");

    println!("ime: a composition is committed and reported when its input loses the focus");
    surface.stop();
    window.close();
}
