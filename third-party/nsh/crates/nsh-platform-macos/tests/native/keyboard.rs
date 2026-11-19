//! The raw keys of focused custom views on AppKit: the logical and
//! physical (`code`) values of `NSEvent`s, the capture rules mounted on the
//! focused view and its ancestors, and Tab's existing traversal.
//!
//! The app mounts two focusable pads; the first hears `on_key_down` and
//! `on_key_up`, and their enclosing view hears the `KeyDown` the engine
//! bubbles to it. The checks send real `NSEvent`s to the window (as
//! `synth` does) and read what the listeners reported. They run against a
//! real `AppView` and `NSWindow`, not only the converters, so the dispatch
//! path, the mounted props and the focus are covered.

use std::{
    sync::{
        Mutex,
        atomic::{AtomicU8, Ordering},
    },
    time::{Duration, Instant},
};

use nsh_core::{KeyCapture, KeyEvent, keymap::Keystroke, platform::Os, prelude::*};
use nsh_platform_macos as platform;
use platform::{
    objc2::{MainThreadMarker, MainThreadOnly, Message, msg_send, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSBackingStoreType, NSEvent, NSEventModifierFlags, NSEventType, NSView,
        NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize, NSString},
};

/// What the app reported, in order.
static EVENTS: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// The capture policy the app mounts: 0 none, 1 all.
static CAPTURE: AtomicU8 = AtomicU8::new(0);
/// The pad the app's interval focuses next: 1 the first, 2 the second.
static FOCUS: AtomicU8 = AtomicU8::new(0);

fn record(where_: &str, event: &KeyEvent) {
    let prefix = match where_ {
        "outer" => "outer down",
        "portal-a" => "portal-a down",
        "portal-b" => "portal-b down",
        "up" => "up",
        _ => "down",
    };
    EVENTS.lock().unwrap().push(format!(
        "{prefix} key={} code={} shift={} ctrl={} alt={} cmd={} repeat={} prevented={}",
        event.key,
        event.code,
        event.modifiers.shift,
        event.modifiers.ctrl,
        event.modifiers.alt,
        event.modifiers.cmd,
        event.repeat,
        event.default_prevented,
    ));
}

fn record_focus(where_: &str) {
    EVENTS.lock().unwrap().push(format!("{where_} focus"));
}

/// Two focusable pads: the first hears the raw keys, their enclosing view
/// hears the `KeyDown`s the engine bubbles, and either can capture them.
#[component]
fn Pads() -> impl IntoElement {
    let first = element_ref();
    let second = element_ref();
    let policy = signal(KeyCapture::None);
    let named = Keystroke::parse("shift+a", Os::MacOs).expect("shift+a");
    set_interval(Duration::from_millis(5), move || {
        let next = match CAPTURE.load(Ordering::SeqCst) {
            1 => KeyCapture::All,
            2 => KeyCapture::keys([named]),
            _ => KeyCapture::None,
        };
        if policy.get_untracked() != next {
            policy.set(next);
        }
        match FOCUS.swap(0, Ordering::SeqCst) {
            1 => first.focus(),
            2 => second.focus(),
            _ => {}
        }
    });
    view()
        .test_id("outer")
        .flex_1()
        .p(px(8.0))
        .gap(px(8.0))
        .capture_keys(move || policy.get())
        .on_key_down(move |event: &KeyEvent| record("outer", event))
        .child(
            view()
                .test_id("first")
                .h(px(60.0))
                .w_full()
                .focusable(true)
                .element_ref(&first)
                .on_focus(move |_: &()| record_focus("first"))
                .on_key_down(move |event: &KeyEvent| record("down", event))
                .on_key_up(move |event: &KeyEvent| record("up", event)),
        )
        .child(
            view()
                .test_id("second")
                .h(px(60.0))
                .w_full()
                .focusable(true)
                .element_ref(&second)
                .on_focus(move |_: &()| record_focus("second")),
        )
}

/// One overlay's content: a focusable child with no listener, and the stop
/// a Tab would reach.
fn portal_content(child: &'static str, second: &'static str) -> impl IntoElement {
    overlay().child(
        view()
            .w(px(320.0))
            .h(px(120.0))
            .p(px(8.0))
            .gap(px(8.0))
            .child(view().test_id(child).h(px(40.0)).w_full().focusable(true))
            .child(view().test_id(second).h(px(40.0)).w_full().focusable(true)),
    )
}

/// Two sibling overlays, each portaled to the root while its logical
/// parent is the container below. Only the focused portal's logical
/// ancestor hears and captures its keys; the other portal's rules do not.
#[component]
fn Portals() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view()
                .test_id("portal-a")
                .h(px(40.0))
                .w_full()
                .capture_keys(KeyCapture::keys([
                    Keystroke::parse("x", Os::MacOs).expect("x")
                ]))
                .on_key_down(move |event: &KeyEvent| record("portal-a", event))
                .child(portal_content("portal-child", "portal-second")),
        )
        .child(
            view()
                .test_id("portal-b")
                .h(px(40.0))
                .w_full()
                .capture_keys(KeyCapture::keys([
                    Keystroke::parse("tab", Os::MacOs).expect("tab")
                ]))
                .on_key_down(move |event: &KeyEvent| record("portal-b", event))
                .child(portal_content("portal-b-child", "portal-b-second")),
        )
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
        pump(5);
    }
}

/// Whether `view` is `window`'s first responder.
fn has_focus(window: &NSWindow, view: &NSView) -> bool {
    window
        .firstResponder()
        .and_then(|responder| {
            responder
                .downcast_ref::<NSView>()
                .map(|focused| std::ptr::eq(focused, view))
        })
        .unwrap_or(false)
}

/// The view under `view` whose `testID` is `id`.
fn view_with_id(view: &NSView, id: &str) -> Option<Retained<NSView>> {
    if view
        .accessibilityIdentifier()
        .is_some_and(|value| value.to_string() == id)
    {
        return Some(view.retain());
    }
    view.subviews()
        .iter()
        .find_map(|child| view_with_id(&child, id))
}

/// A key event: `characters` is what the key types, `ignoring` its key
/// without the modifiers (AppKit's two strings).
fn event(
    window: &NSWindow,
    kind: NSEventType,
    characters: &str,
    ignoring: &str,
    code: u16,
    flags: NSEventModifierFlags,
    repeat: bool,
) -> Retained<NSEvent> {
    let characters = NSString::from_str(characters);
    let ignoring = NSString::from_str(ignoring);
    NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
        kind,
        NSPoint::new(0.0, 0.0),
        flags,
        platform::objc2_foundation::NSProcessInfo::processInfo().systemUptime(),
        window.windowNumber(),
        None,
        &characters,
        &ignoring,
        repeat,
        code,
    )
    .expect("a key event")
}

/// Sends `event` to `window`'s first responder and lets the engine report
/// what it heard.
fn send(window: &NSWindow, event: &NSEvent) {
    window.sendEvent(event);
    pump(60);
}

/// Sends a modifier key's transition: AppKit's `flagsChanged` of `code`.
/// A window that does not route such an event still hands it to the view,
/// which deduplicates the two arrivals.
fn send_flags(window: &NSWindow, first: &NSView, code: u16, flags: NSEventModifierFlags) {
    let event = event(
        window,
        NSEventType::FlagsChanged,
        "",
        "",
        code,
        flags,
        false,
    );
    window.sendEvent(&event);
    // A window that does not route `flagsChanged` to its first responder
    // still hands it to the view; the second arrival is deduplicated.
    // SAFETY: `flagsChanged:` is the responder method, on the main thread,
    // with a valid event.
    let _: () = unsafe { msg_send![first, flagsChanged: &*event] };
    pump(60);
}

/// Whether `recorded` has happened.
fn happened(recorded: &str) -> bool {
    EVENTS.lock().unwrap().iter().any(|e| e == recorded)
}

/// Whether a record starts with `prefix` (a wait that does not spell out
/// every field, as `record` always appends them).
fn recorded(prefix: &str) -> bool {
    EVENTS.lock().unwrap().iter().any(|e| e.starts_with(prefix))
}

#[allow(clippy::field_reassign_with_default)]
pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    // SAFETY: The window is created on the process main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(900.0, 400.0), NSSize::new(480.0, 300.0)),
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
    options.size = (480, 300);
    let surface = platform::AppView::new(mtm, options);
    window.setContentView(Some(&surface.view()));
    surface.load(platform::App::Rust(platform::Root::of::<Pads>()));
    window.makeKeyAndOrderFront(None);
    let root = surface.view();
    until("the pads' mount", || view_with_id(&root, "first").is_some());
    let first = view_with_id(&root, "first").expect("the first pad");
    let second = view_with_id(&root, "second").expect("the second pad");
    // The app focuses the first pad through its ref, as Tab or `focus()`
    // does; the key events then reach it as the window's first responder.
    FOCUS.store(1, Ordering::SeqCst);
    until("the first pad's focus", || has_focus(&window, &first));

    // A plain key: its logical key, its physical code, and the engine's
    // bubble of the press to the enclosing view (once).
    send(
        &window,
        &event(
            &window,
            NSEventType::KeyDown,
            "a",
            "a",
            0,
            NSEventModifierFlags::empty(),
            false,
        ),
    );
    send(
        &window,
        &event(
            &window,
            NSEventType::KeyUp,
            "a",
            "a",
            0,
            NSEventModifierFlags::empty(),
            false,
        ),
    );
    until("the plain key", || recorded("up key=a "));
    let plain = "down key=a code=KeyA shift=false ctrl=false alt=false cmd=false repeat=false prevented=false";
    assert!(
        happened(plain),
        "the plain press: {:?}",
        EVENTS.lock().unwrap()
    );
    assert!(
        happened(
            "up key=a code=KeyA shift=false ctrl=false alt=false cmd=false repeat=false prevented=false"
        ),
        "the release names the same key: {:?}",
        EVENTS.lock().unwrap()
    );
    assert_eq!(
        EVENTS
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.starts_with("outer down key=a "))
            .count(),
        1,
        "the engine bubbles the press to the enclosing view once: {:?}",
        EVENTS.lock().unwrap()
    );

    // Shift keeps the reported case (the logical key is what the source
    // says), while the shortcut vocabulary lowers it for matching.
    send(
        &window,
        &event(
            &window,
            NSEventType::KeyDown,
            "A",
            "a",
            0,
            NSEventModifierFlags::Shift,
            false,
        ),
    );
    until("Shift+A", || {
        happened(
            "down key=A code=KeyA shift=true ctrl=false alt=false cmd=false repeat=false prevented=false",
        )
    });

    // Option types a layout character; the logical key keeps it, and the
    // press has no text preview (as Control and Command combinations
    // have none).
    send(
        &window,
        &event(
            &window,
            NSEventType::KeyDown,
            "å",
            "a",
            0,
            NSEventModifierFlags::Option,
            false,
        ),
    );
    until("Option+A", || {
        happened(
            "down key=å code=KeyA shift=false ctrl=false alt=true cmd=false repeat=false prevented=false",
        )
    });

    // Named keys follow AppKit's virtual key codes, not their characters.
    send(
        &window,
        &event(
            &window,
            NSEventType::KeyDown,
            "\r",
            "\r",
            36,
            NSEventModifierFlags::empty(),
            false,
        ),
    );
    send(
        &window,
        &event(
            &window,
            NSEventType::KeyDown,
            "\u{f702}",
            "\u{f702}",
            123,
            NSEventModifierFlags::empty(),
            false,
        ),
    );
    send(
        &window,
        &event(
            &window,
            NSEventType::KeyDown,
            "\u{f708}",
            "\u{f708}",
            96,
            NSEventModifierFlags::Function,
            false,
        ),
    );
    // The keypad's keys keep their own codes: the enter and decimal point
    // are not the main keyboard's, and a keypad digit is Numpad1 even
    // though the logical key is `1`.
    send(
        &window,
        &event(
            &window,
            NSEventType::KeyDown,
            "1",
            "1",
            83,
            NSEventModifierFlags::empty(),
            false,
        ),
    );
    send(
        &window,
        &event(
            &window,
            NSEventType::KeyDown,
            "\r",
            "\r",
            76,
            NSEventModifierFlags::empty(),
            false,
        ),
    );
    send(
        &window,
        &event(
            &window,
            NSEventType::KeyDown,
            ".",
            ".",
            65,
            NSEventModifierFlags::empty(),
            false,
        ),
    );
    until("the named keys", || {
        happened(
            "down key=Enter code=Enter shift=false ctrl=false alt=false cmd=false repeat=false prevented=false",
        ) && happened(
            "down key=ArrowLeft code=ArrowLeft shift=false ctrl=false alt=false cmd=false repeat=false prevented=false",
        ) && happened(
            "down key=F5 code=F5 shift=false ctrl=false alt=false cmd=false repeat=false prevented=false",
        ) && happened(
            "down key=1 code=Numpad1 shift=false ctrl=false alt=false cmd=false repeat=false prevented=false",
        ) && happened(
            "down key=Enter code=NumpadEnter shift=false ctrl=false alt=false cmd=false repeat=false prevented=false",
        ) && happened(
            "down key=. code=NumpadDecimal shift=false ctrl=false alt=false cmd=false repeat=false prevented=false",
        )
    });

    // A virtual key code with no DOM code is `""`: the code is never
    // derived from the character the event types.
    send(
        &window,
        &event(
            &window,
            NSEventType::KeyDown,
            "z",
            "z",
            0xFFFF,
            NSEventModifierFlags::empty(),
            false,
        ),
    );
    until("the unknown key code", || {
        happened(
            "down key=z code= shift=false ctrl=false alt=false cmd=false repeat=false prevented=false",
        )
    });

    // AppKit marks auto-repeats itself.
    send(
        &window,
        &event(
            &window,
            NSEventType::KeyDown,
            "f",
            "f",
            3,
            NSEventModifierFlags::empty(),
            true,
        ),
    );
    until("the repeat", || {
        happened(
            "down key=f code=KeyF shift=false ctrl=false alt=false cmd=false repeat=true prevented=false",
        )
    });

    // Modifier keys are `flagsChanged`: each transition is a named
    // KeyDown/KeyUp, and releasing one Shift keeps the other held.
    send_flags(&window, &first, 56, NSEventModifierFlags::Shift);
    until("Shift down", || {
        happened(
            "down key=Shift code=ShiftLeft shift=true ctrl=false alt=false cmd=false repeat=false prevented=false",
        )
    });
    send_flags(&window, &first, 60, NSEventModifierFlags::Shift);
    send_flags(&window, &first, 56, NSEventModifierFlags::Shift);
    send_flags(&window, &first, 60, NSEventModifierFlags::empty());
    until("Shift up", || {
        happened(
            "up key=Shift code=ShiftLeft shift=true ctrl=false alt=false cmd=false repeat=false prevented=false",
        ) && happened(
            "up key=Shift code=ShiftRight shift=false ctrl=false alt=false cmd=false repeat=false prevented=false",
        )
    });

    // The Control keys report their sides too.
    send_flags(&window, &first, 59, NSEventModifierFlags::Control);
    send_flags(&window, &first, 62, NSEventModifierFlags::Control);
    send_flags(&window, &first, 59, NSEventModifierFlags::Control);
    send_flags(&window, &first, 62, NSEventModifierFlags::empty());
    until("Control sides", || {
        happened(
            "down key=Control code=ControlLeft shift=false ctrl=true alt=false cmd=false repeat=false prevented=false",
        ) && happened(
            "down key=Control code=ControlRight shift=false ctrl=true alt=false cmd=false repeat=false prevented=false",
        ) && happened(
            "up key=Control code=ControlLeft shift=false ctrl=true alt=false cmd=false repeat=false prevented=false",
        ) && happened(
            "up key=Control code=ControlRight shift=false ctrl=false alt=false cmd=false repeat=false prevented=false",
        )
    });

    // A release whose press was never tracked (the app lost the focus, or
    // the press happened in another app) follows its cleared flag: it is a
    // KeyUp, never a KeyDown that reports the modifier as off.
    send_flags(&window, &first, 61, NSEventModifierFlags::empty());
    until("the untracked Option release", || {
        happened(
            "up key=Alt code=AltRight shift=false ctrl=false alt=false cmd=false repeat=false prevented=false",
        )
    });
    assert!(
        !recorded("down key=Alt "),
        "no invented press for an untracked release: {:?}",
        EVENTS.lock().unwrap()
    );

    // A mounted capture on the focused view's ancestor takes Tab before
    // the platform's traversal runs: the focus stays where it is.
    CAPTURE.store(1, Ordering::SeqCst);
    pump(120);
    send(
        &window,
        &event(
            &window,
            NSEventType::KeyDown,
            "\t",
            "\t",
            48,
            NSEventModifierFlags::empty(),
            false,
        ),
    );
    until("the captured Tab", || {
        happened(
            "down key=Tab code=Tab shift=false ctrl=false alt=false cmd=false repeat=false prevented=true",
        )
    });
    assert!(has_focus(&window, &first), "a captured Tab is no traversal");

    // Without the capture, Tab is AppKit's key view loop: the focus moves
    // to the next focusable pad, as it did before raw keys existed.
    CAPTURE.store(0, Ordering::SeqCst);
    pump(120);
    send(
        &window,
        &event(
            &window,
            NSEventType::KeyDown,
            "\t",
            "\t",
            48,
            NSEventModifierFlags::empty(),
            false,
        ),
    );
    until("the second pad's focus", || happened("second focus"));
    assert!(
        has_focus(&window, &second),
        "an uncaptured Tab moves the focus"
    );

    // The mounted policy applies to a key it names, by the canonical
    // shortcut vocabulary (`Keystroke`), not by the reported case.
    CAPTURE.store(2, Ordering::SeqCst);
    FOCUS.store(1, Ordering::SeqCst);
    pump(120);
    send(
        &window,
        &event(
            &window,
            NSEventType::KeyDown,
            "A",
            "a",
            0,
            NSEventModifierFlags::Shift,
            false,
        ),
    );
    until("the named capture", || {
        happened(
            "down key=A code=KeyA shift=true ctrl=false alt=false cmd=false repeat=false prevented=true",
        )
    });

    // Overlays are moved to a root view's host natively while their logical
    // parent stays the view that contains them: interest and capture follow
    // `ViewProps::key_parent`, not the native host, and a sibling portal's
    // rules stay out of the focused portal's ancestry.
    surface.load(platform::App::Rust(platform::Root::of::<Portals>()));
    until("the portals' mount", || {
        view_with_id(&root, "portal-child").is_some()
            && view_with_id(&root, "portal-b-child").is_some()
    });
    // A few batches for the portaled view's props (the routing override).
    pump(150);
    let child = view_with_id(&root, "portal-child").expect("the portal child");
    assert!(
        window.makeFirstResponder(Some(&*child)),
        "the focusable child in the overlay takes the focus"
    );
    pump(30);
    send(
        &window,
        &event(
            &window,
            NSEventType::KeyDown,
            "x",
            "x",
            7,
            NSEventModifierFlags::empty(),
            false,
        ),
    );
    until("the portal's logical ancestor", || {
        recorded("portal-a down key=x ")
    });
    let portal = EVENTS
        .lock()
        .unwrap()
        .iter()
        .find(|e| e.starts_with("portal-a down key=x "))
        .cloned();
    assert!(
        portal.is_some_and(|line| line.ends_with("prevented=true")),
        "the logical ancestor's capture applies: {:?}",
        EVENTS.lock().unwrap()
    );
    // Tab is not in the focused portal's ancestry's rule (the sibling's
    // rule names it), so it is reported uncaptured and runs its default.
    send(
        &window,
        &event(
            &window,
            NSEventType::KeyDown,
            "\t",
            "\t",
            48,
            NSEventModifierFlags::empty(),
            false,
        ),
    );
    until("the uncaptured portal Tab", || {
        recorded("portal-a down key=Tab ")
    });
    let portal_tab = EVENTS
        .lock()
        .unwrap()
        .iter()
        .find(|e| e.starts_with("portal-a down key=Tab "))
        .cloned();
    assert!(
        portal_tab.is_some_and(|line| line.ends_with("prevented=false")),
        "the sibling portal's Tab rule does not capture: {:?}",
        EVENTS.lock().unwrap()
    );
    assert!(
        !recorded("portal-b down"),
        "the unrelated sibling portal neither hears nor captures: {:?}",
        EVENTS.lock().unwrap()
    );

    println!(
        "keyboard: AppKit maps keys, reports them once at the focused view, captures before Tab and menus do, and follows a portaled overlay's logical ancestors"
    );
    surface.stop();
    window.close();
}
