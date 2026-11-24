//! #2226: the shared single-line field editor must not inherit another
//! field's horizontal scroll. Inspect actual AppKit character geometry.
//!
//! `NSH_INPUT_FOCUS_CHECK_ONLY=1` runs this check alone; add
//! `NSH_INPUT_FOCUS_BENCH=1` for 1000 focus changes and CPU time. To capture
//! the gallery fixture, build `examples/gallery/tests/fixtures/input-focus.tsx`
//! with `nsh build`, set `NSH_INPUT_FOCUS_GALLERY` to its `bundle.js`, and
//! `NSH_INPUT_FOCUS_SHOTS` to a PNG path prefix outside the repository.
//! `NSH_INPUT_FOCUS_DARK=1` uses the dark appearance.
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use nsh_base::input;
use nsh_core::prelude::*;
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, Message, msg_send, rc::Retained, sel},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSTextField, NSTextInputClient,
        NSTextView, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRange, NSRect, NSRunLoop, NSSize, NSString},
};

const LONG: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789";

static CARET: Mutex<Option<Bounds<Points>>> = Mutex::new(None);
static SELECTION: Mutex<Option<Selection>> = Mutex::new(None);
static KEYS: Mutex<Vec<String>> = Mutex::new(Vec::new());

#[component]
fn Page() -> impl IntoElement {
    let field = |id, value| {
        input()
            .test_id(id)
            .default_value(value)
            .w(px(200.0))
            .h(px(36.0))
            .p(px(8.0))
    };
    view()
        .size_full()
        .gap(px(8.0))
        .child(
            field("long", LONG)
                .on_caret_move(|event: &CaretEvent| *CARET.lock().unwrap() = Some(event.bounds))
                .on_selection_change(|range: &Selection| *SELECTION.lock().unwrap() = Some(*range)),
        )
        .child(field("reference", LONG))
        .child(field("short", "ABC").on_key_press(|key: &str| {
            KEYS.lock().unwrap().push(key.to_owned());
        }))
        .child(field("center", "Centered").text_center())
        .child(field("right", "Right aligned").text_right())
        .child(
            field("pending-caret", LONG)
                .selected_range(((LONG.len() - 2) as u32, (LONG.len() - 2) as u32)),
        )
        .child(
            field("pending-selection", LONG)
                .selected_range(((LONG.len() - 5) as u32, (LONG.len() - 2) as u32)),
        )
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

fn editor(field: &NSTextField) -> Retained<NSTextView> {
    field
        .currentEditor()
        .unwrap()
        .downcast::<NSTextView>()
        .unwrap()
}

fn character_x(field: &NSTextField, index: usize) -> f64 {
    let view = editor(field);
    // SAFETY: the field editor implements NSTextInputClient; no actual range requested.
    let screen = unsafe {
        view.firstRectForCharacterRange_actualRange(NSRange::new(index, 0), std::ptr::null_mut())
    };
    let rect = field.window().unwrap().convertRectFromScreen(screen);
    field.convertRect_fromView(rect, None).origin.x
}

fn focus(window: &NSWindow, field: &NSTextField) {
    assert!(window.makeFirstResponder(Some(field)));
    // Match NSH's programmatic focus: collapse AppKit's select-all to the end.
    let editor = editor(field);
    editor.setSelectedRange(NSRange::new(editor.string().length(), 0));
}

fn shot(root: &NSView, name: &str) {
    let Some(prefix) = std::env::var_os("NSH_INPUT_FOCUS_SHOTS") else {
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

pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    let app = NSApplication::sharedApplication(mtm);
    app.finishLaunching();
    // SAFETY: window creation and ownership on the main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(200.0, 200.0), NSSize::new(600.0, 500.0)),
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
            size: (600, 500),
            appearance: if std::env::var_os("NSH_INPUT_FOCUS_DARK").is_some() {
                Appearance::Dark
            } else {
                Appearance::System
            },
            ..Default::default()
        },
    );
    let root = surface.view();
    window.setContentView(Some(&root));
    let bundle = std::env::var_os("NSH_INPUT_FOCUS_GALLERY");
    let native_fixture = bundle.is_none();
    surface.load(match bundle {
        Some(path) => {
            platform::App::Js(nsh_engine::Bundle::read(std::path::Path::new(&path)).unwrap())
        }
        None => platform::App::Rust(platform::Root::of::<Page>()),
    });
    window.makeKeyAndOrderFront(None);
    app.activate();
    let deadline = Instant::now() + Duration::from_secs(10);
    while field(&root, "right").is_none() {
        assert!(Instant::now() < deadline, "inputs did not mount");
        settle();
    }
    let long = field(&root, "long").unwrap();
    let short = field(&root, "short").unwrap();
    if native_fixture {
        focus(&window, &short);
        settle();
        KEYS.lock().unwrap().clear();
        let editor = editor(&short);
        let delegate = short.delegate().unwrap();
        for command in [sel!(moveUp:), sel!(moveDown:)] {
            // SAFETY: the mounted input's delegate implements this
            // NSTextFieldDelegate method; the field and editor are live.
            let handled: bool = unsafe {
                msg_send![&*delegate, control: &*short, textView: &*editor, doCommandBySelector: command]
            };
            assert!(!handled, "arrow commands must keep AppKit's caret movement");
        }
        settle();
        assert_eq!(*KEYS.lock().unwrap(), ["ArrowUp", "ArrowDown"]);
    }
    settle();
    shot(&root, "idle");
    let mut positions = Vec::new();
    focus(&window, &long);
    settle();
    positions.push(("initial long", character_x(&long, 0)));
    shot(&root, "focus");
    for _ in 0..3 {
        focus(&window, &short);
        settle();
        positions.push(("short", character_x(&short, 0)));
        focus(&window, &long);
        settle();
        positions.push(("long after short", character_x(&long, 0)));
    }
    shot(&root, "switch");
    // The borderless idle cell starts two points into its frame. Long and
    // short fields must agree, regardless of the previously edited text.
    for (case, x) in &positions {
        println!("input_focus: {case} first character x={x:.3}");
    }
    for (case, x) in &positions {
        assert!((x - 2.0).abs() < 0.5, "{case}: x={x}, expected 2");
    }
    // Measure synchronous native focus work, without sleeps or screenshots.
    if std::env::var_os("NSH_INPUT_FOCUS_BENCH").is_some() {
        let mut sampler = nsh_engine::perf::ProcessSampler::new();
        sampler.sample();
        let start = Instant::now();
        for _ in 0..500 {
            focus(&window, &short);
            focus(&window, &long);
        }
        let elapsed = start.elapsed().as_secs_f64();
        let sample = sampler.sample();
        println!(
            "input_focus: 1000 focus changes in {:.3} ms; CPU {:?}%, CPU time {:.3} ms",
            elapsed * 1000.0,
            sample.cpu,
            elapsed * f64::from(sample.cpu.unwrap_or(0.0)) * 10.0
        );
    }
    // Switching between two overflowing fields must not depend on a short
    // field first resetting the shared clip. Check before and after layout.
    let reference = field(&root, "reference").unwrap();
    for target in [&reference, &long, &reference, &long] {
        focus(&window, target);
        assert!(
            (character_x(target, 0) - 2.0).abs() < 0.5,
            "long-to-long initial origin"
        );
        settle();
        assert!(
            (character_x(target, 0) - 2.0).abs() < 0.5,
            "long-to-long settled origin"
        );
    }
    if native_fixture {
        // Selection and caret events still describe the actual native editor
        // after resolving it once per notification. The short field has no
        // listeners, exercising the notification fast path as focus moves.
        let text = editor(&long);
        text.setSelectedRange(NSRange::new(3, 4));
        let deadline = Instant::now() + Duration::from_secs(5);
        while *SELECTION.lock().unwrap() != Some(Selection { start: 3, end: 7 }) {
            assert!(Instant::now() < deadline, "selection event missing");
            settle();
        }
        settle();
        // SAFETY: NSTextInputClient character geometry; no actual range requested.
        let rect = unsafe {
            text.firstRectForCharacterRange_actualRange(NSRange::new(7, 0), std::ptr::null_mut())
        };
        // SAFETY: the field's parent getter on the main thread.
        let pad = unsafe { long.superview() }.unwrap();
        let expected = pad.convertRect_fromView(window.convertRectFromScreen(rect), None);
        let caret = CARET.lock().unwrap().expect("caret event missing");
        assert!(
            (f64::from(caret.origin.x.0) - expected.origin.x).abs() < 0.5,
            "caret event x"
        );
        assert!(
            (f64::from(caret.origin.y.0) - expected.origin.y).abs() < 0.5,
            "caret event y"
        );
    }
    // End-of-line scrolling remains AppKit's while editing, and typing
    // at that caret still appends rather than resetting to the beginning.
    let text = editor(&long);
    text.setSelectedRange(NSRange::new(LONG.len(), 0));
    text.scrollRangeToVisible(NSRange::new(LONG.len(), 0));
    settle();
    let x = character_x(&long, LONG.len());
    assert!(
        {
            // SAFETY: the editing view's parent, on the main thread.
            let clip = unsafe { text.superview() }.unwrap();
            let viewport = long.convertRect_fromView(clip.bounds(), Some(&clip));
            x >= viewport.origin.x && x < viewport.origin.x + viewport.size.width
        },
        "end caret hidden: {x}"
    );
    let scrolled_x = character_x(&long, 0);
    assert!(scrolled_x < 0.0, "long text did not scroll");
    settle();
    assert!(
        (character_x(&long, 0) - scrolled_x).abs() < 0.5,
        "editing scroll was reset"
    );
    // Returning to the first character uses the same native scroll path as
    // focus. It must align with the idle cell, then still scroll to the end.
    text.setSelectedRange(NSRange::new(0, 0));
    text.scrollRangeToVisible(NSRange::new(0, 0));
    settle();
    assert!(
        (character_x(&long, 0) - 2.0).abs() < 0.5,
        "scroll-to-start origin"
    );
    text.setSelectedRange(NSRange::new(LONG.len(), 0));
    text.scrollRangeToVisible(NSRange::new(LONG.len(), 0));
    settle();
    // SAFETY: NSTextInputClient insertion on the active field editor.
    let _: () = unsafe {
        platform::objc2::msg_send![&*text, insertText: &*NSString::from_str("!"), replacementRange: NSRange::new(isize::MAX as usize, 0)]
    };
    assert_eq!(long.stringValue().to_string(), format!("{LONG}!"));
    for id in ["center", "right"] {
        let aligned = field(&root, id).unwrap();
        focus(&window, &aligned);
        settle();
        let before = character_x(&aligned, 0);
        focus(&window, &long);
        focus(&window, &aligned);
        settle();
        let after = character_x(&aligned, 0);
        assert!(
            (before - after).abs() < 0.5,
            "{id} changed with focus history"
        );
        assert!(after > 2.0, "{id} was forced left");
    }
    // Pending selections must survive focus, and scrolling them into view
    // must remain possible after restoring the initial text origin.
    // These fields belong to the Rust fixture; the gallery is captured above.
    for (id, start) in [
        ("pending-caret", LONG.len() - 2),
        ("pending-selection", LONG.len() - 5),
    ] {
        let Some(pending) = field(&root, id) else {
            continue;
        };
        focus(&window, &long);
        settle();
        let text = editor(&long);
        text.scrollRangeToVisible(NSRange::new(LONG.len(), 0));
        settle();
        assert!(
            character_x(&long, 0) < 0.0,
            "source field did not retain its scroll"
        );
        assert!(window.makeFirstResponder(Some(&pending)));
        settle();
        let range = editor(&pending).selectedRange();
        assert_eq!(range, NSRange::new(start, LONG.len() - 2 - start));
        editor(&pending).scrollRangeToVisible(range);
        settle();
        let x = character_x(&pending, LONG.len() - 2);
        // SAFETY: AppKit parent getter on the main thread.
        let clip = unsafe { editor(&pending).superview() }.unwrap();
        let viewport = pending.convertRect_fromView(clip.bounds(), Some(&clip));
        assert!(
            x >= viewport.origin.x && x < viewport.origin.x + viewport.size.width,
            "{id}: caret hidden after scrolling at {x}"
        );
        assert!(character_x(&pending, 0) < 0.0, "{id}: scroll reset");
    }
    surface.stop();
    window.close();
}
