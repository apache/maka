//! A multiline input whose text fits its box, as a field that grows with its
//! text always does: AppKit's vertical scroll views bounce whatever their
//! content, so such a field moved with every swipe over it. Its text view
//! must be no taller than its viewport and must not bounce, under a zoom as
//! a popover opens and at its full size, while a text taller than its box
//! still scrolls and bounces. Read from the native `NSView` hierarchy of a
//! real `AppView`.

use std::{
    rc::Rc,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use nsh_base::input;
use nsh_core::{LineHeight, prelude::*};
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSApplication, NSBackingStoreType, NSScrollElasticity, NSScrollView, NSTextView, NSView,
        NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize, NSString},
};

/// Inputs whose box is exactly their lines: (text, text size, line height).
const FITTING: [(&str, f32, f32); 2] = [("Team Kickoff", 16.0, 24.0), ("Notes", 14.0, 20.0)];

/// Whether the fields have zoomed in to their full size.
static ZOOMED: AtomicBool = AtomicBool::new(false);

/// One line's box holding three lines.
const OVERFLOWING: &str = "One\nTwo\nThree";

#[component]
fn Fields() -> impl IntoElement {
    let field = |text: &'static str, size: f32, line: f32| {
        input()
            .multiline(true)
            .default_value(text)
            .text_size(px(size))
            .line_height(LineHeight::Points(px(line)))
            .w(px(200.0))
            .h(px(line))
    };
    // They zoom in as a popover opens: the editors are hosted under the
    // scale first, then at their full size.
    let scale = signal(0.95);
    set_interval(Duration::from_millis(5), move || {
        if ZOOMED.load(Ordering::SeqCst) && scale.get_untracked() != 1.0 {
            scale.set(1.0);
        }
    });
    let mut column = view()
        .p(px(16.0))
        .gap(px(16.0))
        .style_with(move |s| s.scale(scale.get()));
    for (text, size, line) in FITTING {
        column = column.child(field(text, size, line));
    }
    column.child(field(OVERFLOWING, 14.0, 20.0))
}

/// The scroll view of the text view holding `text`, wherever its input
/// hosts it (above a transformed view, while it is scaled).
fn scroller(view: &NSView, text: &str) -> Option<Retained<NSScrollView>> {
    if let Some(scroller) = view.downcast_ref::<NSScrollView>()
        && let Some(document) = scroller.documentView()
        && let Some(editor) = document.downcast_ref::<NSTextView>()
        && editor.string().to_string() == text
    {
        return Some(scroller.retain());
    }
    view.subviews()
        .iter()
        .find_map(|child| scroller(&child, text))
}

/// The height of the text view holding `text` and its viewport's, once both
/// have an area.
fn heights(root: &NSView, text: &str) -> Option<(f64, f64)> {
    let scroller = scroller(root, text)?;
    let text = scroller.documentView()?.frame().size.height;
    let viewport = scroller.contentSize().height;
    (text > 0.0 && viewport > 0.0).then_some((text, viewport))
}

/// Runs the main run loop until `done` holds, for at most five seconds.
fn until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "{what} never happened");
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
    }
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().expect("the checks run on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.finishLaunching();
    // SAFETY: The window is created on the process main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(200.0, 200.0), NSSize::new(320.0, 200.0)),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Closable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(&NSString::from_str("NSH fitting input regression"));
    let options = platform::AppOptions {
        size: (320, 200),
        ..Default::default()
    };
    let surface: Rc<platform::AppView> = platform::AppView::new(mtm, options);
    window.setContentView(Some(&surface.view()));
    surface.load(platform::App::Rust(platform::Root::of::<Fields>()));
    window.orderFront(None);
    let root = surface.view();

    let texts = FITTING.map(|(text, ..)| text);
    ZOOMED.store(false, Ordering::SeqCst);
    until("the inputs laying out their text", || {
        texts
            .iter()
            .chain([&OVERFLOWING])
            .all(|text| heights(&root, text).is_some())
    });
    // TextKit 2 lays the text out after the views have their frames.
    let settle = || {
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.3));
    };
    settle();
    ZOOMED.store(true, Ordering::SeqCst);
    settle();

    let mut failures = Vec::new();
    for text in texts {
        let (height, viewport) = heights(&root, text).expect("laid out");
        if height > viewport {
            failures.push(format!(
                "input `{text}`: text view {height}pt tall in a {viewport}pt viewport its text fits"
            ));
        }
        let elasticity = scroller(&root, text)
            .expect("laid out")
            .verticalScrollElasticity();
        if elasticity != NSScrollElasticity::None {
            failures.push(format!(
                "input `{text}`: bounces ({elasticity:?}) though its text fits"
            ));
        }
    }
    let (height, viewport) = heights(&root, OVERFLOWING).expect("laid out");
    if height <= viewport {
        failures.push(format!(
            "the overflowing input: text view {height}pt tall, not taller than its {viewport}pt viewport"
        ));
    }
    let elasticity = scroller(&root, OVERFLOWING)
        .expect("laid out")
        .verticalScrollElasticity();
    if elasticity == NSScrollElasticity::None {
        failures
            .push("the overflowing input: does not bounce though its text overflows".to_owned());
    }

    surface.stop();
    window.close();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    println!(
        "fitting_input: {} fitting inputs stay still, an overflowing one scrolls",
        FITTING.len()
    );
}
