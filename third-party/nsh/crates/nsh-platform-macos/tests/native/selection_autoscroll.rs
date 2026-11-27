//! A mouse drag that selects text in a selectable view scrolls a scroll
//! view *inside* the area (#2996): a horizontal `Scroll` holding a line
//! wider than itself, inside the area, scrolls toward the pointer held
//! past its right edge, and the selection follows to the line's end. The
//! autoscroll used to look only at scroll views around the area.
//!
//! ```sh
//! NSH_SELECTION_AUTOSCROLL_CHECK_ONLY=1 cargo test -p nsh-platform-macos --test native -- --ignored
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

/// The box's content offset (`f32` bits), as its `on_scroll` last told.
static OFFSET: AtomicU32 = AtomicU32::new(0);
/// The selected text, as the area's `on_text_selection_change` last told.
static SELECTED: Mutex<String> = Mutex::new(String::new());

/// The window's content size.
const SIZE: (f64, f64) = (400.0, 300.0);
/// The page's padding.
const PAD: f64 = 24.0;
/// The first line's height, and the gap below it.
const LINE: f64 = 20.0;
/// The box's width.
const BOX: f64 = 300.0;
/// The width of the line in the box.
const LINE_WIDTH: f32 = 2000.0;

#[component]
fn Page() -> impl IntoElement {
    let line = "A line much wider than its scroll view, ".repeat(8) + "END";
    view()
        .selectable(true)
        .flex_1()
        .p(px(PAD as f32))
        .gap(px(LINE as f32))
        .on_text_selection_change(|e: &TextSelectionEvent| {
            *SELECTED.lock().unwrap() = e.text.clone();
        })
        .child(text("Press here and drag to the right, past the box.").h(px(LINE as f32)))
        .child(
            scroll()
                .horizontal()
                .w(px(BOX as f32))
                .h(px(40.0))
                .on_scroll(|e: &ScrollEvent| OFFSET.store(e.offset.x.0.to_bits(), Ordering::SeqCst))
                .child(text(line).w(px(LINE_WIDTH))),
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
    window.setTitle(&NSString::from_str("NSH selection autoscroll"));
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

    // Press on the first line, drag down into the box, then past its right
    // edge, and hold there.
    let send = |kind, at| {
        window.sendEvent(&mouse(&window, kind, at));
        pump(16);
    };
    let row = PAD + LINE + LINE + 20.0;
    send(NSEventType::LeftMouseDown, (PAD + 10.0, PAD + LINE / 2.0));
    for i in 1..=8 {
        let t = f64::from(i) / 8.0;
        send(
            NSEventType::LeftMouseDragged,
            (
                PAD + 10.0 + 100.0 * t,
                PAD + LINE / 2.0 + (row - PAD - LINE / 2.0) * t,
            ),
        );
    }
    let past = (PAD + BOX + 30.0, row);
    send(NSEventType::LeftMouseDragged, past);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !SELECTED.lock().unwrap().ends_with("END") && Instant::now() < deadline {
        pump(50);
    }
    send(NSEventType::LeftMouseUp, past);

    let offset = f32::from_bits(OFFSET.load(Ordering::SeqCst));
    let selected = SELECTED.lock().unwrap().clone();
    window.close();
    assert!(
        offset > 0.0,
        "the box inside the area never scrolled (offset {offset})"
    );
    assert!(
        selected.contains("ress here") && selected.contains("A line much wider"),
        "the selection did not reach into the box: {selected:?}"
    );
    // A locked screen pauses the display link the autoscroll runs on, so
    // the box may stop short of its end; once it gets there, the selection
    // ends with the line.
    if offset >= LINE_WIDTH - BOX as f32 - 1.0 {
        assert!(
            selected.ends_with("END"),
            "the selection did not follow to the line's end: {selected:?}"
        );
    }
}
