//! A hosted NSView implementing NSTextInputClient
//! must keep composition keys before app shortcuts, just as NSTextView does.
//! Marked text is set deterministically; keys use real AppKit application dispatch
//! and NSH's installed keyboard monitor. This does not exercise a system IME.

use std::{
    cell::Cell,
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use nsh_core::{keymap::When, prelude::*};
use nsh_platform_macos::{
    self as platform,
    objc2::{
        DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send,
        rc::Retained,
        runtime::{AnyObject, Sel},
    },
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSApplicationActivationPolicy, NSBackingStoreType,
        NSBitmapImageFileType, NSBitmapImageRepPropertyKey, NSEvent, NSEventMask,
        NSEventModifierFlags, NSEventType, NSTextInputClient, NSTextView, NSView, NSWindow,
        NSWindowStyleMask,
    },
    objc2_foundation::{
        NSArray, NSAttributedString, NSDate, NSDefaultRunLoopMode, NSDictionary, NSPoint, NSRange,
        NSRect, NSSize, NSString,
    },
};

static SHORTCUTS: AtomicUsize = AtomicUsize::new(0);
static RESULTS: Mutex<String> = Mutex::new(String::new());

const KEYS: [(&str, u16, &str); 5] = [
    ("Enter", 36, "\r"),
    ("Escape", 53, "\u{1b}"),
    ("ArrowLeft", 123, "\u{f702}"),
    ("Space", 49, " "),
    ("Backspace", 51, "\u{7f}"),
];

#[derive(Default)]
struct ClientState {
    marked: Cell<bool>,
    keys: Cell<usize>,
}

define_class!(
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[name = "NshTestComposingClient"]
    #[ivars = ClientState]
    struct ComposingClient;

    impl ComposingClient {
        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> bool { true }

        #[unsafe(method(keyDown:))]
        fn key_down(&self, _event: &NSEvent) {
            self.ivars().keys.set(self.ivars().keys.get() + 1);
        }
    }

    // SAFETY: All required selectors have the protocol's signatures. The
    // fixture models only marked-text state and counts keys delivered to it.
    unsafe impl NSTextInputClient for ComposingClient {
        #[unsafe(method(insertText:replacementRange:))]
        unsafe fn insert_text(&self, _text: &AnyObject, _range: NSRange) {
            self.ivars().marked.set(false);
        }
        #[unsafe(method(doCommandBySelector:))]
        unsafe fn command(&self, _selector: Sel) {}
        #[unsafe(method(setMarkedText:selectedRange:replacementRange:))]
        unsafe fn set_marked(&self, _text: &AnyObject, _selection: NSRange, _range: NSRange) {
            self.ivars().marked.set(true);
        }
        #[unsafe(method(unmarkText))]
        fn unmark(&self) { self.ivars().marked.set(false); }
        #[unsafe(method(selectedRange))]
        fn selection(&self) -> NSRange { NSRange::new(0, 0) }
        #[unsafe(method(markedRange))]
        fn marked_range(&self) -> NSRange {
            if self.ivars().marked.get() { NSRange::new(0, 2) }
            else { NSRange::new(isize::MAX as usize, 0) }
        }
        #[unsafe(method(hasMarkedText))]
        fn has_marked(&self) -> bool { self.ivars().marked.get() }
        #[unsafe(method_id(attributedSubstringForProposedRange:actualRange:))]
        unsafe fn substring(&self, _range: NSRange, _actual: *mut NSRange) -> Option<Retained<NSAttributedString>> { None }
        #[unsafe(method_id(validAttributesForMarkedText))]
        fn attributes(&self) -> Retained<NSArray<NSString>> { NSArray::new() }
        #[unsafe(method(firstRectForCharacterRange:actualRange:))]
        unsafe fn first_rect(&self, _range: NSRange, _actual: *mut NSRange) -> NSRect { NSRect::ZERO }
        #[unsafe(method(characterIndexForPoint:))]
        fn character_index(&self, _point: NSPoint) -> usize { 0 }
    }
);

#[component]
fn Fixture() -> impl IntoElement {
    for key in ["enter", "escape", "left", "space", "backspace"] {
        on_key_with(
            key,
            KeyOptions {
                when: When::Always,
                ..Default::default()
            },
            |_| {
                SHORTCUTS.fetch_add(1, Ordering::SeqCst);
            },
        );
    }
    let results = signal(String::new());
    set_interval(Duration::from_millis(10), move || {
        let next = RESULTS.lock().unwrap().clone();
        if next != results.get_untracked() {
            results.set(next);
        }
    });
    view()
        .flex_1()
        .p_4()
        .gap_4()
        .bg(rgb(0xffffff))
        .text_color(rgb(0x111111))
        .child(text("Hosted input composition keys"))
        .child(text(move || results.get()))
        .child(view().test_id("host").focusable(true).h(px(50.0)).w_full())
}

fn pump(ms: u64) {
    let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
    let deadline = Instant::now() + Duration::from_millis(ms);
    // SAFETY: AppKit's immutable default run-loop mode.
    let mode = unsafe { NSDefaultRunLoopMode };
    // Only press() injects keys. Leave the desktop user's hardware keys in
    // the queue so they cannot change this fixture's shortcut counters.
    let mask =
        NSEventMask::Any & !(NSEventMask::KeyDown | NSEventMask::KeyUp | NSEventMask::FlagsChanged);
    while Instant::now() < deadline {
        if let Some(event) = app.nextEventMatchingMask_untilDate_inMode_dequeue(
            mask,
            Some(&NSDate::dateWithTimeIntervalSinceNow(0.005)),
            mode,
            true,
        ) {
            app.sendEvent(&event);
        }
        app.updateWindows();
    }
}

fn find(view: &NSView) -> Option<Retained<NSView>> {
    if view
        .accessibilityIdentifier()
        .is_some_and(|id| id.to_string() == "host")
    {
        return Some(view.retain());
    }
    view.subviews().iter().find_map(|child| find(&child))
}

fn press(app: &NSApplication, window: &NSWindow, code: u16, chars: &str) {
    let text = NSString::from_str(chars);
    for kind in [NSEventType::KeyDown, NSEventType::KeyUp] {
        let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
            kind, NSPoint::ZERO, NSEventModifierFlags::empty(),
            platform::objc2_foundation::NSProcessInfo::processInfo().systemUptime(),
            window.windowNumber(), None, &text, &text, false, code,
        ).unwrap();
        app.sendEvent(&event);
    }
    pump(200);
}

#[allow(clippy::field_reassign_with_default)]
pub(super) fn run() {
    SHORTCUTS.store(0, Ordering::SeqCst);
    RESULTS.lock().unwrap().clear();
    let mtm = MainThreadMarker::new().unwrap();
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    app.finishLaunching();
    // SAFETY: The window is created and retained on the main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(700.0, 300.0), NSSize::new(640.0, 360.0)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: The scope retains the window through close.
    unsafe {
        window.setReleasedWhenClosed(false);
    }
    let mut options = platform::AppOptions::default();
    options.size = (640, 360);
    let surface = platform::AppView::new(mtm, options);
    window.setContentView(Some(&surface.view()));
    surface.load(platform::App::Rust(platform::Root::of::<Fixture>()));
    window.makeKeyAndOrderFront(None);
    app.activate();
    let deadline = Instant::now() + Duration::from_secs(5);
    let host = loop {
        if let Some(host) = find(&surface.view()) {
            break host;
        }
        assert!(Instant::now() < deadline, "fixture did not mount");
        pump(10);
    };
    // This window is embedded directly, outside run_app's window lifecycle.
    // Make it key explicitly before dispatching through the application.
    window.makeKeyWindow();
    let deadline = Instant::now() + Duration::from_secs(15);
    while !window.isKeyWindow() && Instant::now() < deadline {
        pump(10);
    }
    assert!(
        window.isKeyWindow(),
        "real app key window is required for the monitor (active={}, visible={}, can_become_key={})",
        app.isActive(),
        window.isVisible(),
        window.canBecomeKeyWindow()
    );

    let allocated = ComposingClient::alloc(mtm).set_ivars(ClientState::default());
    // SAFETY: NSView initializes the allocated subclass on the main thread.
    let client: Retained<ComposingClient> =
        unsafe { msg_send![super(allocated), initWithFrame: host.bounds()] };
    host.addSubview(&client);
    assert!(window.makeFirstResponder(Some(&client)));
    assert!(client.downcast_ref::<NSTextView>().is_none());

    let mut failures = Vec::new();
    for (name, code, chars) in KEYS {
        client.unmarkText();
        let before = SHORTCUTS.load(Ordering::SeqCst);
        let keys = client.ivars().keys.get();
        press(&app, &window, code, chars);
        assert_eq!(
            SHORTCUTS.load(Ordering::SeqCst) - before,
            1,
            "{name} unmarked shortcut control"
        );
        assert_eq!(
            client.ivars().keys.get(),
            keys,
            "unmarked shortcut consumes {name}"
        );

        // SAFETY: The fixture accepts NSString, on the main thread.
        unsafe {
            client.setMarkedText_selectedRange_replacementRange(
                &NSString::from_str("ni"),
                NSRange::new(2, 0),
                NSRange::new(isize::MAX as usize, 0),
            );
        }
        assert!(client.hasMarkedText());
        let before = SHORTCUTS.load(Ordering::SeqCst);
        press(&app, &window, code, chars);
        let shortcuts = SHORTCUTS.load(Ordering::SeqCst) - before;
        let delivered = client.ivars().keys.get() - keys;
        println!(
            "custom NSView marked + {name}: shortcuts={shortcuts}, input_key_down={delivered}; expected 0, 1"
        );
        if shortcuts != 0 || delivered != 1 {
            failures.push(name);
        }

        client.unmarkText();
        assert!(!client.hasMarkedText());
        let before = SHORTCUTS.load(Ordering::SeqCst);
        let keys = client.ivars().keys.get();
        press(&app, &window, code, chars);
        let resumed = SHORTCUTS.load(Ordering::SeqCst) - before;
        assert_eq!(resumed, 1, "{name} shortcut resumes after composition");
        assert_eq!(
            client.ivars().keys.get(),
            keys,
            "resumed shortcut consumes {name}"
        );
        RESULTS.lock().unwrap().push_str(&format!(
            "{name}: input {delivered}, shortcut {shortcuts}, resumed {resumed}\n"
        ));
    }

    // The existing NSTextView path must suppress the same Enter shortcut.
    let editor = NSTextView::initWithFrame(NSTextView::alloc(mtm), host.bounds());
    host.addSubview(&editor);
    assert!(window.makeFirstResponder(Some(&editor)));
    // SAFETY: NSTextView accepts NSString for its protocol method.
    unsafe {
        editor.setMarkedText_selectedRange_replacementRange(
            &NSString::from_str("ni"),
            NSRange::new(2, 0),
            NSRange::new(isize::MAX as usize, 0),
        );
    }
    assert!(editor.hasMarkedText());
    let before = SHORTCUTS.load(Ordering::SeqCst);
    press(&app, &window, 36, "\r");
    let fired = SHORTCUTS.load(Ordering::SeqCst) - before;
    println!("NSTextView marked + Enter: shortcuts={fired}; expected 0");
    assert_eq!(
        fired, 0,
        "standard NSTextView composition remains protected"
    );

    // An ordinary focus stop does not implement NSTextInputClient. It keeps
    // its app shortcuts and must never receive hasMarkedText.
    assert!(window.makeFirstResponder(Some(&host)));
    let before = SHORTCUTS.load(Ordering::SeqCst);
    press(&app, &window, 36, "\r");
    assert_eq!(SHORTCUTS.load(Ordering::SeqCst) - before, 1);
    RESULTS
        .lock()
        .unwrap()
        .push_str("NSTextView protected; ordinary view shortcut works");
    screenshot(&surface.view());
    surface.stop();
    window.close();
    assert!(
        failures.is_empty(),
        "app shortcuts stole composition keys from NSTextInputClient: {failures:?}"
    );
    println!("ime-keymap: composition keys reach hosted inputs; shortcuts resume after unmark");
}

fn screenshot(root: &NSView) {
    let Some(path) = std::env::var_os("NSH_IME_KEYMAP_SCREENSHOT") else {
        return;
    };
    pump(150);
    root.displayIfNeeded();
    let bounds = root.bounds();
    let bitmap = root
        .bitmapImageRepForCachingDisplayInRect(bounds)
        .expect("a bitmap");
    root.cacheDisplayInRect_toBitmapImageRep(bounds, &bitmap);
    let properties = NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
    // SAFETY: An empty property dictionary is valid for PNG.
    let png = unsafe {
        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
    }
    .expect("PNG data");
    std::fs::write(path, png.to_vec()).unwrap();
}
