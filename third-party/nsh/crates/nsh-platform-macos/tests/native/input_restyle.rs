//! #3028: restyling a focused single-line input (a new placeholder, a new
//! text color as a color scheme switch brings) must not report a blur. AppKit
//! ends editing and starts it again in the same field for a new placeholder;
//! the field keeps the focus, typing still goes into it, and the blur comes
//! once the focus really leaves. Read from a real `AppView` in a window.
//!
//! `NSH_INPUT_RESTYLE_CHECK_ONLY=1` runs this check alone.

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
    objc2::{MainThreadMarker, MainThreadOnly, Message, msg_send, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSTextField, NSTextView, NSView,
        NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRange, NSRect, NSRunLoop, NSSize, NSString},
};

/// The fixture's style step: 0 first, 1 a new placeholder, 2 a new color.
static STEP: AtomicU8 = AtomicU8::new(0);
/// Focus and blur events, in order, as `focus a` / `blur a`.
static EVENTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn note(event: String) {
    EVENTS.lock().unwrap().push(event);
}

#[component]
fn Page() -> impl IntoElement {
    let step = signal(STEP.load(Ordering::SeqCst));
    let log = signal(String::new());
    set_interval(Duration::from_millis(5), move || {
        let now = STEP.load(Ordering::SeqCst);
        if step.get_untracked() != now {
            step.set(now);
        }
        let now = EVENTS.lock().unwrap().join(", ");
        if log.get_untracked() != now {
            log.set(now);
        }
    });
    let field = |id: &'static str| {
        input()
            .test_id(id)
            .w(px(240.0))
            .h(px(32.0))
            .p(px(6.0))
            .on_focus(move || note(format!("focus {id}")))
            .on_blur(move || note(format!("blur {id}")))
    };
    view()
        .size_full()
        .p(px(24.0))
        .gap(px(12.0))
        .child(
            field("a")
                .placeholder(move || {
                    if step.get() == 0 {
                        "first hint".to_owned()
                    } else {
                        "second hint".to_owned()
                    }
                })
                .text_color(move || {
                    if step.get() >= 2 {
                        AdaptiveColor::from(rgb(0x2563eb))
                    } else {
                        AdaptiveColor::from(rgb(0x111111))
                    }
                }),
        )
        .child(field("b"))
        .child(text(move || format!("events: {}", log.get())).text_color(rgb(0x111111)))
}

fn find(view: &NSView, matches: &dyn Fn(&NSView) -> bool) -> Option<Retained<NSView>> {
    if matches(view) {
        return Some(view.retain());
    }
    view.subviews()
        .iter()
        .find_map(|child| find(&child, matches))
}

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

fn settle() {
    NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.05));
}

/// Runs the loop until `done`, failing with `what` after a few seconds.
fn until(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "{what}");
        settle();
    }
}

/// With `NSH_INPUT_RESTYLE_SHOTS` set to a path prefix outside the
/// repository, writes the window's content as `<prefix>-<name>.png`.
fn shot(root: &NSView, name: &str) {
    let Some(prefix) = std::env::var_os("NSH_INPUT_RESTYLE_SHOTS") else {
        return;
    };
    use platform::{
        objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRepPropertyKey},
        objc2_foundation::NSDictionary,
    };
    let rep = root
        .bitmapImageRepForCachingDisplayInRect(root.bounds())
        .unwrap();
    root.cacheDisplayInRect_toBitmapImageRep(root.bounds(), &rep);
    let properties =
        NSDictionary::<NSBitmapImageRepPropertyKey, platform::objc2::runtime::AnyObject>::new();
    // SAFETY: an empty property dictionary is valid for PNG.
    let bytes =
        unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties) }
            .unwrap();
    std::fs::write(
        format!("{}-{name}.png", std::path::Path::new(&prefix).display()),
        bytes.to_vec(),
    )
    .unwrap();
}

fn events() -> Vec<String> {
    EVENTS.lock().unwrap().clone()
}

/// Types `text` at the end of the field's editor, as a key press inserts.
fn type_into(field: &NSTextField, text: &str) {
    let editor = field
        .currentEditor()
        .expect("the field is not being edited")
        .downcast::<NSTextView>()
        .unwrap();
    let end = editor.string().length();
    editor.setSelectedRange(NSRange::new(end, 0));
    // SAFETY: NSTextInputClient insertion on the active field editor.
    let _: () = unsafe {
        msg_send![&*editor, insertText: &*NSString::from_str(text), replacementRange: NSRange::new(isize::MAX as usize, 0)]
    };
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
    until("inputs did not mount", || field(&root, "b").is_some());
    let a = field(&root, "a").unwrap();
    let b = field(&root, "b").unwrap();

    assert!(window.makeFirstResponder(Some(&a)));
    until("no focus a", || events() == ["focus a"]);

    // The field is empty, so its placeholder shows: AppKit restarts
    // editing for a new one only then.
    let editing = |field: &NSTextField| {
        field
            .currentEditor()
            .expect("the field is not being edited")
            .downcast::<NSTextView>()
            .unwrap()
    };

    // A new placeholder, then a new text color, while `a` is edited.
    for (step, what) in [(1, "placeholder"), (2, "text color")] {
        STEP.store(step, Ordering::SeqCst);
        let hint = if step == 1 { "second hint" } else { "" };
        until(&format!("{what} not applied"), || {
            hint.is_empty()
                || a.placeholderAttributedString()
                    .is_some_and(|s| s.string().to_string() == hint)
        });
        for _ in 0..6 {
            settle();
        }
        shot(&root, &format!("step{step}"));
        assert_eq!(
            events(),
            ["focus a"],
            "a {what} change while focused reported a focus change"
        );
        assert!(
            a.currentEditor().is_some(),
            "a {what} change ended editing in a"
        );
        let range = editing(&a).selectedRange();
        println!("input_restyle: selection after the {what} change: {range:?}");
        assert_eq!(range, NSRange::new(0, 0), "a {what} change moved the caret");
    }

    // Typing still goes into `a`.
    type_into(&a, "x");
    settle();
    assert_eq!(a.stringValue().to_string(), "x");

    // The focus really leaves: `a` reports its blur, then `b` its focus.
    assert!(window.makeFirstResponder(Some(&b)));
    until("no blur a after the focus left", || {
        events() == ["focus a", "blur a", "focus b"]
    });
    for _ in 0..4 {
        settle();
    }
    shot(&root, "left");

    surface.stop();
    window.close();
}
