//! The keys extend a selectable view's selection, as `NSTextView`'s
//! standard bindings do: after a click in the area, Shift+Right by a
//! character, Option+Shift+Right to a word's end, Command+Shift+Right to
//! the line's end, Shift+Down to the next, shorter text's end, and
//! Command+Shift+Down to the end of the texts, which the scroll view around
//! the area scrolls to.
//! Shift+Home goes back to the start: nothing is selected then.
//!
//! ```sh
//! NSH_SELECTION_KEYS_CHECK_ONLY=1 cargo test -p nsh-platform-macos --test native -- --ignored
//! ```

use std::{
    sync::{
        Mutex,
        atomic::{AtomicU32, Ordering},
    },
    time::{Duration, Instant},
};

use nsh_core::prelude::*;
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, rc::Retained},
    objc2_app_kit::{
        NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSEvent,
        NSEventModifierFlags, NSEventType, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSProcessInfo, NSRect, NSRunLoop, NSSize, NSString},
};

/// The scroll view's content offset (`f32` bits), as its `on_scroll` last
/// told.
static OFFSET: AtomicU32 = AtomicU32::new(0);
/// The selected text, as the area's `on_text_selection_change` last told.
static SELECTED: Mutex<String> = Mutex::new(String::new());

/// The window's content size.
const SIZE: (f64, f64) = (400.0, 300.0);
/// The area's padding.
const PAD: f64 = 24.0;
/// A text's height.
const LINE: f64 = 20.0;

#[component]
fn Page() -> impl IntoElement {
    let fillers = (1..=30).map(|i| text(format!("Filler line {i}")).h(px(LINE as f32)));
    view().flex_1().child(
        scroll()
            .h(px(SIZE.1 as f32))
            .on_scroll(|e: &ScrollEvent| OFFSET.store(e.offset.y.0.to_bits(), Ordering::SeqCst))
            .child(
                view()
                    .selectable(true)
                    .p(px(PAD as f32))
                    .on_text_selection_change(|e: &TextSelectionEvent| {
                        *SELECTED.lock().unwrap() = e.text.clone();
                    })
                    .child(text("alpha beta gamma").h(px(LINE as f32)))
                    .child(text("second").h(px(LINE as f32)))
                    .children(fillers)
                    .child(text("LAST").h(px(LINE as f32))),
            ),
    )
}

fn pump(ms: u64) {
    let deadline = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < deadline {
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
    }
}

/// A left mouse event at `(x, y)` from the content's top left (AppKit's
/// window coordinates are y up).
fn mouse(window: &NSWindow, kind: NSEventType, (x, y): (f64, f64)) -> Retained<NSEvent> {
    NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        kind,
        NSPoint::new(x, SIZE.1 - y),
        NSEventModifierFlags::empty(),
        NSProcessInfo::processInfo().systemUptime(),
        window.windowNumber(),
        None,
        0,
        1,
        1.0,
    )
    .unwrap()
}

/// A key down of virtual key `code` with `flags`; `function` is the
/// character AppKit gives the key (`NS…FunctionKey`).
fn key(
    window: &NSWindow,
    code: u16,
    function: char,
    flags: NSEventModifierFlags,
) -> Retained<NSEvent> {
    let characters = NSString::from_str(&function.to_string());
    NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
        NSEventType::KeyDown,
        NSPoint::new(0.0, 0.0),
        flags | NSEventModifierFlags::Function | NSEventModifierFlags::NumericPad,
        NSProcessInfo::processInfo().systemUptime(),
        window.windowNumber(),
        None,
        &characters,
        &characters,
        false,
        code,
    )
    .unwrap()
}

const HOME: (u16, char) = (115, '\u{F729}');
const RIGHT: (u16, char) = (124, '\u{F703}');
const DOWN: (u16, char) = (125, '\u{F701}');

pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    app.finishLaunching();
    let frame = NSRect::new(NSPoint::new(800.0, 200.0), NSSize::new(SIZE.0, SIZE.1));
    // SAFETY: The window is created on the process main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            frame,
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe {
        window.setReleasedWhenClosed(false);
    }
    window.setTitle(&NSString::from_str("NSH selection keys"));
    let surface = platform::AppView::new(
        mtm,
        platform::AppOptions {
            size: (SIZE.0 as i32, SIZE.1 as i32),
            ..Default::default()
        },
    );
    window.setContentView(Some(&surface.view()));
    surface.load(platform::App::Rust(platform::Root::of::<Page>()));
    window.makeKeyAndOrderFront(None);
    pump(500);

    // A click before the first text's first character puts the anchor.
    let at = (PAD + 1.0, PAD + LINE / 2.0);
    window.sendEvent(&mouse(&window, NSEventType::LeftMouseDown, at));
    pump(16);
    window.sendEvent(&mouse(&window, NSEventType::LeftMouseUp, at));
    pump(100);

    let selected = || SELECTED.lock().unwrap().clone();
    let press = |(code, function): (u16, char), flags: NSEventModifierFlags| {
        window.sendEvent(&key(&window, code, function, flags));
        pump(60);
    };
    let shift = NSEventModifierFlags::Shift;
    let mut steps = Vec::new();
    for _ in 0..3 {
        press(RIGHT, shift);
    }
    steps.push(("Shift+Right x3", selected(), "alp".to_string()));
    press(RIGHT, shift | NSEventModifierFlags::Option);
    steps.push(("Option+Shift+Right", selected(), "alpha".to_string()));
    press(RIGHT, shift | NSEventModifierFlags::Command);
    steps.push((
        "Command+Shift+Right",
        selected(),
        "alpha beta gamma".to_string(),
    ));
    press(DOWN, shift);
    steps.push((
        "Shift+Down",
        selected(),
        "alpha beta gamma\nsecond".to_string(),
    ));
    // The texts far below are listed once the reveal brings them near: a
    // second press goes on to the last one, as Command+A would select it.
    for _ in 0..2 {
        press(DOWN, shift | NSEventModifierFlags::Command);
        // The reveal animates.
        pump(400);
    }
    let to_end = selected();
    let offset = f32::from_bits(OFFSET.load(Ordering::SeqCst));
    press(HOME, shift);
    let back = selected();
    window.close();

    for (keys, got, want) in steps {
        assert_eq!(got, want, "after {keys}");
    }
    assert!(
        to_end.starts_with("alpha beta gamma\n") && to_end.ends_with("Filler line 30\nLAST"),
        "Command+Shift+Down did not select to the end: {to_end:?}"
    );
    assert!(
        offset > 0.0,
        "the scroll view did not reveal the selection's new end (offset {offset})"
    );
    assert_eq!(back, "", "Shift+Home did not go back to the anchor");
}
