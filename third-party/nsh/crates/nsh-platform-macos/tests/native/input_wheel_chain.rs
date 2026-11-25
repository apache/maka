//! A multiline input in a scroll view chains trackpad gestures as a web
//! textarea does: a gesture its overflowing text can take stays on the
//! text, and once the text is at its end, the next gesture down scrolls the
//! page. A trackpad's `Began` carries no delta, so the gesture is decided
//! by its first move, not by whether the text overflows (which kept every
//! gesture on text already at its end). A gesture back towards the start
//! of the text stays on the text. The text is moved to its end directly:
//! synthesized gestures do not move an `NSScrollView` on every machine (a
//! locked screen). Synthesized gestures handed to the window, so this
//! checks the event routing, not a finger on a real trackpad.

use std::{
    sync::atomic::{AtomicU32, Ordering},
    time::{Duration, Instant},
};

use nsh_base::input;
use nsh_core::prelude::*;
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, rc::Retained},
    objc2_app_kit::{
        NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSEvent, NSScreen,
        NSStandardKeyBindingResponding, NSTextView, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize, NSString},
};
use objc2_core_graphics::{CGEvent, CGEventField, CGScrollEventUnit};

/// The page's content offset (`f32` bits), as its `on_scroll` last told.
static PAGE: AtomicU32 = AtomicU32::new(0);

/// The window's content size.
const SIZE: (f64, f64) = (400.0, 600.0);
/// Where the gestures land, in the window's content (AppKit's, y up): 200
/// points from the top, inside the input (180–380) before and after the
/// page scrolls by one small gesture.
const AT: (f64, f64) = (200.0, SIZE.1 - 200.0);
/// The changes of one gesture.
const CHANGES: usize = 8;

#[component]
fn Page() -> impl IntoElement {
    let long = (1..=59)
        .map(|i| format!("line {i}"))
        .collect::<Vec<_>>()
        .join("\n");
    scroll()
        .flex_1()
        .on_scroll(|e: &ScrollEvent| PAGE.store(e.offset.y.0.to_bits(), Ordering::SeqCst))
        .child(view().h(px(180.0)))
        .child(
            input()
                .multiline(true)
                .default_value(long)
                .mx(px(32.0))
                .h(px(200.0)),
        )
        .child(view().h(px(2000.0)))
}

fn pump(ms: u64) {
    let deadline = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < deadline {
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
    }
}

/// The text view of the multiline input under `view`.
fn text_view(view: &NSView) -> Option<Retained<NSTextView>> {
    if let Some(text) = view.downcast_ref::<NSTextView>() {
        return Some(platform::objc2::Message::retain(text));
    }
    view.subviews().iter().find_map(|child| text_view(&child))
}

/// A trackpad scroll of `dy` points (content up) in gesture `phase`
/// (`CGScrollPhase`), stamped `at` seconds, over the window point `AT`.
fn wheel(window: &NSWindow, dy: i32, phase: i64, at: f64) -> Retained<NSEvent> {
    let event =
        CGEvent::new_scroll_wheel_event2(None, CGScrollEventUnit::Pixel, 2, -dy, 0, 0).unwrap();
    let main_height = NSScreen::screens(MainThreadMarker::from(window))
        .firstObject()
        .map_or(0.0, |s| s.frame().size.height);
    CGEvent::set_location(
        Some(&event),
        objc2_core_foundation::CGPoint::new(AT.0, main_height - AT.1),
    );
    CGEvent::set_integer_value_field(
        Some(&event),
        CGEventField::ScrollWheelEventScrollPhase,
        phase,
    );
    CGEvent::set_timestamp(Some(&event), (at * 1e9) as u64);
    NSEvent::eventWithCGEvent(&event).unwrap()
}

/// One gesture of `CHANGES` changes of `step` points each: began (no
/// delta, as a trackpad's), changed, ended. The page's offset after it.
fn gesture(window: &NSWindow, step: i32) -> f32 {
    let mut t = platform::objc2_foundation::NSProcessInfo::processInfo().systemUptime();
    let send = |e: Retained<NSEvent>| {
        window.sendEvent(&e);
        pump(16);
    };
    send(wheel(window, 0, 1, t));
    for _ in 0..CHANGES {
        t += 0.016;
        send(wheel(window, step, 2, t));
    }
    t += 0.016;
    send(wheel(window, 0, 4, t));
    // Past the gap that ties events into one gesture.
    pump(400);
    f32::from_bits(PAGE.load(Ordering::SeqCst))
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
    window.setTitle(&NSString::from_str("NSH input wheel chain"));
    let surface = platform::AppView::new(
        mtm,
        platform::AppOptions {
            size: (SIZE.0 as i32, SIZE.1 as i32),
            ..Default::default()
        },
    );
    window.setContentView(Some(&surface.view()));
    surface.load(platform::App::Rust(platform::Root::of::<Page>()));
    window.orderFrontRegardless();
    pump(1500);

    // Down over text (about 1000 points in a 200-point box) that can take it.
    let page = gesture(&window, 15);
    println!("input wheel chain: text at its start, page {page}");
    assert!(
        page.abs() < 0.5,
        "a gesture the text can take stays on the text (page moved {page})"
    );
    let text = text_view(&surface.view()).expect("the input's text view");
    // SAFETY: NSResponder's action, on the main thread, with no sender.
    unsafe { text.scrollToEndOfDocument(None) };
    pump(100);
    // A new gesture the text cannot take scrolls the page.
    let page = gesture(&window, 15);
    println!("input wheel chain: next gesture, page {page}");
    assert!(
        page > 1.0,
        "the next gesture past the text's end scrolls the page (page {page})"
    );
    // Back towards the start of the text: the text takes it again.
    let before = page;
    let page = gesture(&window, -10);
    println!("input wheel chain: back up, page {page}");
    assert!(
        (page - before).abs() < 0.5,
        "a gesture the text can take stays on the text (page {before} -> {page})"
    );
    surface.stop();
    window.close();
    println!("input wheel chain: ok");
}
