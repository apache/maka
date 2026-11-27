//! Typing at index 0 of a multiline `Input` with an explicit `lineHeight`
//! (or typing directly into an empty one, or updating `lineHeight` on existing
//! text) must keep the configured line height. `NSTextView::setDefaultParagraphStyle:`
//! updates neither `typingAttributes` nor existing `textStorage` attributes, so
//! inserting before index 0 fell back to AppKit's default paragraph style and
//! collapsed every line in the paragraph to the font's natural line height.
//! Read from a real `AppView` in a window.
//!
//! `NSH_INPUT_LINE_HEIGHT_CHECK_ONLY=1` runs this check alone.

use std::{
    sync::atomic::{AtomicU32, Ordering},
    time::{Duration, Instant},
};

use nsh_base::input;
use nsh_core::{LineHeight, prelude::*};
use nsh_platform_macos::{
    self as platform,
    objc2::{
        MainThreadMarker, MainThreadOnly, Message, msg_send, rc::Retained, runtime::AnyObject,
    },
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSParagraphStyle,
        NSParagraphStyleAttributeName, NSScrollView, NSTextInputClient, NSTextView, NSView,
        NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{
        NSArray, NSDate, NSNotFound, NSPoint, NSRange, NSRect, NSRunLoop, NSSize, NSString,
    },
};

const INITIAL_TEXT: &str = "alpha beta gamma delta epsilon zeta eta theta iota";
const LINE_HEIGHT_A: f32 = 22.0;
const LINE_HEIGHT_B: f32 = 28.0;

static LINE_HEIGHT: AtomicU32 = AtomicU32::new(LINE_HEIGHT_A.to_bits());

#[component]
fn Page() -> impl IntoElement {
    let line_height = signal(f32::from_bits(LINE_HEIGHT.load(Ordering::SeqCst)));
    set_interval(Duration::from_millis(5), move || {
        let now = f32::from_bits(LINE_HEIGHT.load(Ordering::SeqCst));
        if line_height.get_untracked() != now {
            line_height.set(now);
        }
    });
    view()
        .size_full()
        .p(px(16.0))
        .gap(px(12.0))
        .bg(rgb(0xffffff))
        .child(
            input()
                .test_id("prefilled")
                .multiline(true)
                .default_value(INITIAL_TEXT)
                .text_size(px(14.0))
                .line_height(move || LineHeight::Points(px(line_height.get())))
                .text_color(rgb(0x111111))
                .w(px(140.0))
                .h(px(120.0))
                .border(px(1.0))
                .border_color(rgb(0xcccccc)),
        )
        .child(
            input()
                .test_id("empty")
                .multiline(true)
                .text_size(px(14.0))
                .line_height(LineHeight::Points(px(LINE_HEIGHT_A)))
                .text_color(rgb(0x111111))
                .w(px(140.0))
                .h(px(120.0))
                .border(px(1.0))
                .border_color(rgb(0xcccccc)),
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

fn text_area(root: &NSView, id: &str) -> Option<Retained<NSTextView>> {
    let input = find(root, &|v| {
        v.accessibilityIdentifier()
            .is_some_and(|s| s.to_string() == id)
    })?;
    let scroller = find(&input, &|v| v.downcast_ref::<NSScrollView>().is_some())?
        .downcast::<NSScrollView>()
        .ok()?;
    scroller.documentView()?.downcast::<NSTextView>().ok()
}

fn settle() {
    NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.05));
}

fn until(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "{what}");
        settle();
    }
}

/// Inserts `text` at `index` through `NSTextInputClient`, as user typing does.
fn insert_at(view: &NSTextView, index: usize, text: &str) {
    view.setSelectedRange(NSRange::new(index, 0));
    // SAFETY: a plain string replacing the selection (NSNotFound).
    unsafe {
        view.insertText_replacementRange(
            &NSString::from_str(text),
            NSRange::new(NSNotFound as usize, 0),
        );
    }
}

/// Returns the laid-out top y-coordinate of each visual line fragment in `view`
/// (TextKit 2 when present, else TextKit 1).
fn line_ys(view: &NSTextView) -> Vec<f64> {
    let mut ys = Vec::new();
    // SAFETY: TextKit 2 objects and methods on `NSTextView` when present.
    unsafe {
        let tlm: Option<Retained<AnyObject>> = msg_send![view, textLayoutManager];
        if let Some(tlm) = tlm {
            let tcm: Option<Retained<AnyObject>> = msg_send![&tlm, textContentManager];
            if let Some(tcm) = tcm {
                let doc: Option<Retained<AnyObject>> = msg_send![&tcm, documentRange];
                if let Some(doc) = doc {
                    let _: () = msg_send![&tlm, ensureLayoutForRange: &*doc];
                    let location: Option<Retained<AnyObject>> = msg_send![&doc, location];
                    if let Some(mut loc) = location {
                        // Walk fragments via `textLayoutFragmentForLocation:` across the document.
                        loop {
                            let frag: Option<Retained<AnyObject>> =
                                msg_send![&tlm, textLayoutFragmentForLocation: &*loc];
                            let Some(frag) = frag else { break };
                            let frame: NSRect = msg_send![&frag, layoutFragmentFrame];
                            let lines: Retained<NSArray<AnyObject>> =
                                msg_send![&frag, textLineFragments];
                            for line in lines.iter() {
                                let bounds: NSRect = msg_send![&*line, typographicBounds];
                                ys.push(frame.origin.y + bounds.origin.y);
                            }
                            let range: Option<Retained<AnyObject>> =
                                msg_send![&frag, rangeInElement];
                            let next: Option<Retained<AnyObject>> =
                                range.as_deref().and_then(|r| msg_send![r, endLocation]);
                            match next {
                                Some(end) => {
                                    let same: bool = msg_send![&end, isEqual: &*loc];
                                    if same {
                                        break;
                                    }
                                    loc = end;
                                }
                                None => break,
                            }
                        }
                        if !ys.is_empty() {
                            return ys;
                        }
                    }
                }
            }
        }
    }
    // Fallback to TextKit 1 if TextKit 2 is unavailable.
    // SAFETY: TextKit 1 layout manager and container on `NSTextView`.
    unsafe {
        let lm: Option<Retained<AnyObject>> = msg_send![view, layoutManager];
        let tc: Option<Retained<AnyObject>> = msg_send![view, textContainer];
        if let (Some(lm), Some(tc)) = (lm, tc) {
            let _: () = msg_send![&lm, ensureLayoutForTextContainer: &*tc];
            let glyphs: NSRange = msg_send![&lm, glyphRangeForTextContainer: &*tc];
            let mut idx = glyphs.location;
            let end = glyphs.location + glyphs.length;
            while idx < end {
                let mut effective = NSRange::new(0, 0);
                let rect: NSRect = msg_send![
                    &lm,
                    lineFragmentRectForGlyphAtIndex: idx,
                    effectiveRange: &mut effective
                ];
                ys.push(rect.origin.y);
                if effective.length == 0 {
                    break;
                }
                idx = effective.location + effective.length;
            }
        }
    }
    ys
}

fn assert_line_step(label: &str, ys: &[f64], expected: f64) {
    assert!(
        ys.len() >= 3,
        "{label}: expected at least 3 wrapped lines, got {ys:?}"
    );
    for pair in ys.windows(2) {
        let step = pair[1] - pair[0];
        assert!(
            (step - expected).abs() < 0.5,
            "{label}: expected line step ~{expected}pt, got {step:.2}pt in {ys:?}"
        );
    }
}

fn typing_line_spacing(view: &NSTextView) -> f64 {
    let attrs = view.typingAttributes();
    // SAFETY: immutable AppKit attribute key.
    let key = unsafe { NSParagraphStyleAttributeName };
    attrs
        .objectForKey(key)
        .and_then(|v| v.downcast::<NSParagraphStyle>().ok())
        .map_or(0.0, |ps| ps.lineSpacing())
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().expect("the checks run on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.finishLaunching();
    // SAFETY: window creation on the process main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(200.0, 200.0), NSSize::new(300.0, 320.0)),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Closable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: retained here through close.
    unsafe { window.setReleasedWhenClosed(false) };
    let surface = platform::AppView::new(
        mtm,
        platform::AppOptions {
            size: (300, 320),
            ..Default::default()
        },
    );
    let root = surface.view();
    window.setContentView(Some(&root));
    LINE_HEIGHT.store(LINE_HEIGHT_A.to_bits(), Ordering::SeqCst);
    surface.load(platform::App::Rust(platform::Root::of::<Page>()));
    window.makeKeyAndOrderFront(None);
    app.activate();

    until("multiline inputs did not mount", || {
        text_area(&root, "prefilled").is_some_and(|v| v.string().to_string() == INITIAL_TEXT)
            && text_area(&root, "empty").is_some()
    });
    settle();

    let prefilled = text_area(&root, "prefilled").unwrap();
    let empty = text_area(&root, "empty").unwrap();

    // 1. Prefilled multiline input keeps its configured line height before and
    //    after typing at index 0.
    assert!(window.makeFirstResponder(Some(&prefilled)));
    settle();
    let before = line_ys(&prefilled);
    assert_line_step("prefilled initial", &before, f64::from(LINE_HEIGHT_A));
    assert!(
        typing_line_spacing(&prefilled) > 1.0,
        "typingAttributes should carry the configured lineSpacing"
    );

    insert_at(&prefilled, 0, "/");
    settle();
    assert!(prefilled.string().to_string().starts_with('/'));
    let after = line_ys(&prefilled);
    assert_line_step(
        "prefilled after typing at index 0",
        &after,
        f64::from(LINE_HEIGHT_A),
    );

    // 2. Typing directly into an initially empty multiline input uses the
    //    configured line height from the first character.
    assert!(window.makeFirstResponder(Some(&empty)));
    settle();
    insert_at(&empty, 0, INITIAL_TEXT);
    settle();
    let empty_typed = line_ys(&empty);
    assert_line_step(
        "empty after direct typing",
        &empty_typed,
        f64::from(LINE_HEIGHT_A),
    );

    // 3. Updating lineHeight dynamically restyles existing text and keeps the
    //    new line height when typing at index 0.
    let restyle = |height: f32| {
        LINE_HEIGHT.store(height.to_bits(), Ordering::SeqCst);
        until("updated lineHeight not applied", || {
            let ys = line_ys(&prefilled);
            ys.len() >= 2 && ((ys[1] - ys[0]) - f64::from(height)).abs() < 0.5
        });
    };
    restyle(LINE_HEIGHT_B);
    assert!(window.makeFirstResponder(Some(&prefilled)));
    settle();
    insert_at(&prefilled, 0, "!");
    settle();
    let after_restyle = line_ys(&prefilled);
    assert_line_step(
        "prefilled after lineHeight update and typing at index 0",
        &after_restyle,
        f64::from(LINE_HEIGHT_B),
    );

    // An undo record holds an attributed substring from before the restyle.
    let before_replace = prefilled.string();
    prefilled.breakUndoCoalescing();
    // SAFETY: a plain string replacing the entire current UTF-16 range.
    unsafe {
        prefilled.insertText_replacementRange(
            &NSString::from_str(INITIAL_TEXT),
            NSRange::new(0, before_replace.length()),
        );
    }
    prefilled.breakUndoCoalescing();
    settle();
    let manager = prefilled.undoManager().unwrap();
    assert!(window.makeFirstResponder(Some(&empty)));
    restyle(LINE_HEIGHT_A);
    manager.undo();
    assert_eq!(prefilled.string(), before_replace);
    assert_line_step(
        "undo after restyle",
        &line_ys(&prefilled),
        f64::from(LINE_HEIGHT_A),
    );
    // The redo record was captured at A; restore it after switching back to B.
    restyle(LINE_HEIGHT_B);
    manager.redo();
    assert_eq!(prefilled.string().to_string(), INITIAL_TEXT);
    assert_line_step(
        "redo after restyle",
        &line_ys(&prefilled),
        f64::from(LINE_HEIGHT_B),
    );

    surface.stop();
    window.close();
    println!("input_line_height: multiline lineHeight stays intact when typing at index 0");
}
