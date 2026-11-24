//! A multiline input with padding shows its text only in its content box:
//! scrolled into the middle of a long text, no line is drawn in the padding
//! above or below the box, as on every platform. Its own bar off, a bar of
//! the app's that follows it (a scroll watch) still hears how far the text
//! scrolled. Read from the drawing and the native `NSView` hierarchy of a
//! real `AppView`.

use std::{
    rc::Rc,
    sync::atomic::{AtomicU32, Ordering},
    time::{Duration, Instant},
};

use nsh_base::input;
use nsh_core::prelude::*;
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSScrollView, NSTextView, NSView,
        NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize, NSString},
};

/// The input's padding on every side.
const PADDING: f32 = 16.0;

/// How far the app's watch heard the text scrolled (points, as bits), or
/// `u32::MAX` before it heard anything.
static HEARD: AtomicU32 = AtomicU32::new(u32::MAX);

/// A padded multiline input of 40 lines without a bar of its own, which a
/// scroll watch follows (as a `Scrollbar` the app placed would).
#[component]
fn Area() -> impl IntoElement {
    let text = (1..=40)
        .map(|n| format!("Line {n} ████████████████"))
        .collect::<Vec<_>>()
        .join("\n");
    let field = element_ref();
    watch_scroll(
        move || field.node(),
        |e: &ScrollEvent| HEARD.store(e.offset.y.0.to_bits(), Ordering::SeqCst),
    );
    view().p(px(20.0)).child(
        input()
            .test_id("area")
            .element_ref(&field)
            .multiline(true)
            .scrollbar(false)
            .default_value(text)
            .text_size(px(16.0))
            .w(px(240.0))
            .h(px(160.0))
            .p(px(PADDING)),
    )
}

/// The view whose accessibility identifier is `id`.
fn find(view: &NSView, id: &str) -> Option<Retained<NSView>> {
    if view
        .accessibilityIdentifier()
        .is_some_and(|value| value.to_string() == id)
    {
        return Some(view.retain());
    }
    view.subviews().iter().find_map(|child| find(&child, id))
}

/// The scroll view of the text view in `view`.
fn scroller(view: &NSView) -> Option<Retained<NSScrollView>> {
    if let Some(scroller) = view.downcast_ref::<NSScrollView>()
        && scroller
            .documentView()
            .is_some_and(|d| d.downcast_ref::<NSTextView>().is_some())
    {
        return Some(scroller.retain());
    }
    view.subviews().iter().find_map(|child| scroller(&child))
}

/// Runs the main run loop until `done` holds, for at most five seconds.
fn until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "{what} never happened");
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
    }
}

/// How many pixels of each row of `view`'s drawing are inked, top first,
/// and the drawing's scale.
fn inked_rows(view: &NSView) -> (Vec<usize>, f64) {
    let bounds = view.bounds();
    let rep = view
        .bitmapImageRepForCachingDisplayInRect(bounds)
        .expect("a bitmap of the input");
    view.cacheDisplayInRect_toBitmapImageRep(bounds, &rep);
    let (w, h) = (rep.pixelsWide(), rep.pixelsHigh());
    let rows = (0..h)
        .map(|y| {
            (0..w)
                .filter(|&x| {
                    rep.colorAtX_y(x, y)
                        .is_some_and(|c| c.alphaComponent() > 0.1)
                })
                .count()
        })
        .collect();
    (rows, h as f64 / bounds.size.height)
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().expect("the checks run on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.finishLaunching();
    HEARD.store(u32::MAX, Ordering::SeqCst);
    // SAFETY: The window is created on the process main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(200.0, 200.0), NSSize::new(320.0, 240.0)),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Closable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(&NSString::from_str("NSH input clip regression"));
    let options = platform::AppOptions {
        size: (320, 240),
        ..Default::default()
    };
    let surface: Rc<platform::AppView> = platform::AppView::new(mtm, options);
    window.setContentView(Some(&surface.view()));
    surface.load(platform::App::Rust(platform::Root::of::<Area>()));
    window.orderFront(None);
    let root = surface.view();
    until("the input showing", || {
        find(&root, "area")
            .and_then(|v| scroller(&v))
            .is_some_and(|s| s.frame().size.height > 0.0)
    });
    // The watch hears where the text is once it follows the input.
    until("the watch hearing the input", || {
        HEARD.load(Ordering::SeqCst) == 0.0_f32.to_bits()
    });
    let input = find(&root, "area").expect("the input");
    let text = scroller(&input)
        .and_then(|s| s.documentView())
        .expect("the text view");
    // Half a line past a line's top: lines are cut at both edges.
    text.scrollPoint(NSPoint::new(0.0, 205.0));
    until("the watch hearing the scroll", || {
        HEARD.load(Ordering::SeqCst) == 205.0_f32.to_bits()
    });
    let (rows, scale) = inked_rows(&input);
    let pad = (f64::from(PADDING) * scale) as usize;
    let top: usize = rows[..pad].iter().sum();
    let bottom: usize = rows[rows.len() - pad..].iter().sum();
    let content: usize = rows[pad..rows.len() - pad].iter().sum();
    surface.stop();
    window.close();
    assert!(content > 0, "the content box shows text");
    assert_eq!(
        (top, bottom),
        (0, 0),
        "text drawn in the padding (inked pixels above, below)"
    );
    println!("input_clip: text clipped at the content box; a watch hears the scroll");
}
