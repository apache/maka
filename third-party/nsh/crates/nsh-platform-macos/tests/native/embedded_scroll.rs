//! An app embedded in a host's view passes on the scrolls it cannot use:
//! over a view with nothing to scroll, or a scroll view switched off, the
//! scroll goes up the responder chain to the host's view (as to a page
//! scrolling under the app); over a scroll view whose content overflows,
//! the app scrolls it and the host gets nothing. The host is a view that
//! counts the scrolls it gets: an `NSScrollView` would wait for the
//! system's own events once a synthesized gesture reached it. The window
//! is ordered in without activating the app, and the events go to the
//! window directly, so the check takes the focus from no one.
use std::{
    sync::atomic::{AtomicU32, AtomicUsize, Ordering},
    time::{Duration, Instant},
};

use nsh_core::prelude::*;
use nsh_platform_macos as platform;
use objc2::{define_class, msg_send};
use objc2_core_graphics::{CGEvent, CGEventField, CGScrollEventUnit};
use platform::{
    objc2::{MainThreadMarker, MainThreadOnly, rc::Retained},
    objc2_app_kit::{
        NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSEvent, NSScreen,
        NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString},
};

/// The app's scroll view's content offset (`f32` bits), as its
/// `on_scroll` last told.
static OFFSET: AtomicU32 = AtomicU32::new(0);
/// The scroll events the host's view got.
static HOST_SCROLLS: AtomicUsize = AtomicUsize::new(0);

/// The window's content size.
const SIZE: (f64, f64) = (420.0, 240.0);
/// Where the events land, in the window's content (AppKit's, y up).
const AT: (f64, f64) = (200.0, 120.0);
/// The events of the gesture each check sends.
const GESTURE: usize = 8;

define_class!(
    /// The host's view the app is in: counts the scrolls it gets.
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[name = "NshTestScrollHost"]
    struct Host;

    unsafe impl NSObjectProtocol for Host {}

    impl Host {
        #[unsafe(method(scrollWheel:))]
        fn scroll_wheel(&self, _event: &NSEvent) {
            HOST_SCROLLS.fetch_add(1, Ordering::SeqCst);
        }
    }
);

fn rows() -> impl IntoElement {
    view().children((0..200).map(|i| text(format!("Row {i}")).h(px(40.0)).into_element()))
}

/// A view with nothing to scroll.
#[component]
fn Fixed() -> impl IntoElement {
    view().flex_1().child(text("A card"))
}

/// A scroll view switched off, however long its content.
#[component]
fn Off() -> impl IntoElement {
    scroll().flex_1().scrollable(false).child(rows())
}

/// A scroll view whose content overflows.
#[component]
fn Long() -> impl IntoElement {
    scroll()
        .flex_1()
        .on_scroll(|e: &ScrollEvent| OFFSET.store(e.offset.y.0.to_bits(), Ordering::SeqCst))
        .child(rows())
}

fn pump(ms: u64) {
    let deadline = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < deadline {
        platform::objc2_foundation::NSRunLoop::currentRunLoop()
            .runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
    }
}

/// A trackpad scroll of `dy` points (content up) in gesture `phase`
/// (`CGScrollPhase`), stamped `at` seconds, over the window point `AT`.
fn wheel(window: &NSWindow, dy: i32, phase: i64, at: f64) -> Retained<NSEvent> {
    let event =
        CGEvent::new_scroll_wheel_event2(None, CGScrollEventUnit::Pixel, 2, -dy, 0, 0).unwrap();
    // A window-less event's `locationInWindow` is its screen point (y up
    // from the primary display's bottom): place it at the window point.
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

/// Scrolls with two fingers over `app`, in a host's view: the scrolls the
/// host got and how far the app's scroll view moved.
fn check(app: fn() -> platform::Root, name: &str) -> (usize, f32) {
    OFFSET.store(0f32.to_bits(), Ordering::SeqCst);
    HOST_SCROLLS.store(0, Ordering::SeqCst);
    let mtm = MainThreadMarker::new().unwrap();
    let frame = NSRect::new(NSPoint::new(800.0, 300.0), NSSize::new(SIZE.0, SIZE.1));
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
    window.setTitle(&NSString::from_str("NSH embedded scroll"));
    let bounds = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(SIZE.0, SIZE.1));
    // SAFETY: NSView's designated initializer.
    let host: Retained<Host> = unsafe { msg_send![Host::alloc(mtm), initWithFrame: bounds] };
    let host: Retained<NSView> = Retained::into_super(host);
    let surface = platform::AppView::new(
        mtm,
        platform::AppOptions {
            size: (SIZE.0 as i32, SIZE.1 as i32),
            ..Default::default()
        },
    );
    // The app is in the host's view, not the window's content view.
    let card = surface.view();
    card.setFrame(bounds);
    host.addSubview(&card);
    window.setContentView(Some(&host));
    surface.load(platform::App::Rust(app()));
    // In front, but neither key nor active: the user's app keeps the focus.
    window.orderFrontRegardless();
    pump(1500);

    // Stamped as the system stamps events: seconds since it started.
    let mut t = platform::objc2_foundation::NSProcessInfo::processInfo().systemUptime();
    let send = |e: Retained<NSEvent>| {
        window.sendEvent(&e);
        pump(16);
    };
    // The fingers: began, changed, ended.
    send(wheel(&window, 0, 1, t));
    for _ in 0..GESTURE - 2 {
        t += 0.016;
        send(wheel(&window, 20, 2, t));
    }
    t += 0.016;
    send(wheel(&window, 0, 4, t));
    pump(300);
    let host_scrolls = HOST_SCROLLS.load(Ordering::SeqCst);
    let app_moved = f32::from_bits(OFFSET.load(Ordering::SeqCst));
    println!("embedded scroll {name}: host got {host_scrolls}, app moved {app_moved}");
    surface.stop();
    window.close();
    (host_scrolls, app_moved)
}

pub(super) fn run() {
    let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    app.finishLaunching();
    let (host, _) = check(platform::Root::of::<Fixed>, "fixed");
    assert_eq!(
        host, GESTURE,
        "over a view with nothing to scroll the host gets the scroll"
    );
    let (host, _) = check(platform::Root::of::<Off>, "off");
    assert_eq!(
        host, GESTURE,
        "over a scroll view switched off the host gets the scroll"
    );
    let (host, app) = check(platform::Root::of::<Long>, "long");
    assert!(
        app > 1.0,
        "over an overflowing scroll view the app scrolls (moved {app})"
    );
    assert_eq!(host, 0, "and the host gets nothing");
    println!("embedded scroll: ok");
}
