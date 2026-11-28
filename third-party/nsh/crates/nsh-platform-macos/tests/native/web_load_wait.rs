//! A web view mounted while only an animation repeating forever runs (a
//! spinner's keyframes, an animated value looping) starts loading its page
//! within a few frames: the first load waits for motion that ends (a
//! transition, a drag), not for a loop that never does, so it does not
//! wait out `LOAD_WAIT` (500 ms). Measured from the signal that mounts the
//! web view to its `WKWebView` being asked to load; a still page is the
//! baseline.
//!
//! `NSH_WEB_LOAD_WAIT_CHECK_ONLY=1` runs it alone and prints each delay.
use std::{
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU8, Ordering},
    },
    time::{Duration, Instant},
};

use nsh_core::{KeyframeAnimation, Keyframes, element::web_view, prelude::*};
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, msg_send, rc::Retained, runtime::AnyObject},
    objc2_app_kit::{NSApplication, NSBackingStoreType, NSView, NSWindow, NSWindowStyleMask},
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize},
};

/// What moves on the page while the web view mounts.
#[derive(Debug, Clone, Copy, PartialEq)]
#[repr(u8)]
enum Motion {
    Still = 0,
    /// A view's keyframes repeating forever (`animate-spin`).
    Spinner = 1,
    /// An animated value's keyframes repeating forever.
    Loop = 2,
}

static MOTION: AtomicU8 = AtomicU8::new(0);
static SHOW: AtomicBool = AtomicBool::new(false);
static URL: Mutex<String> = Mutex::new(String::new());

#[component]
fn Page() -> impl IntoElement {
    let show = signal(false);
    let x = animated_value(0.0);
    let motion = MOTION.load(Ordering::SeqCst);
    if motion == Motion::Loop as u8 {
        x.keyframes(
            [Keyframe::new(0.0), Keyframe::new(40.0)],
            KeyframeTiming::new(800.0).infinite(),
        );
    }
    set_interval(Duration::from_millis(2), move || {
        show.set(SHOW.load(Ordering::SeqCst))
    });
    let url = URL.lock().unwrap().clone();
    view()
        .flex_1()
        .child(
            view()
                .w(px(24.0))
                .h(px(24.0))
                .bind_translate_x(&x)
                .child(text("…")),
        )
        .child(when(
            move || motion == Motion::Spinner as u8,
            || {
                view()
                    .w(px(24.0))
                    .h(px(24.0))
                    .animation(KeyframeAnimation::new(Keyframes::Spin))
                    .child(text("◌"))
            },
        ))
        .child(when(
            move || show.get(),
            move || web_view(url.clone()).w(px(300.0)).h(px(160.0)),
        ))
}

/// Whether a `WKWebView` under `view` was asked to load a page: its `URL`
/// is set the moment the load starts.
fn loading(view: &NSView) -> bool {
    if view.class().name().to_bytes().ends_with(b"WKWebView") {
        // SAFETY: WebKit's documented API on the main thread.
        let url: Option<Retained<AnyObject>> = unsafe { msg_send![view, URL] };
        return url.is_some();
    }
    view.subviews().iter().any(|v| loading(&v))
}

fn pump(seconds: f64) {
    NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(seconds));
}

/// Mounts a page with `motion`, lets it settle, mounts a web view on it;
/// how long the page's request took to reach the server.
fn delay(mtm: MainThreadMarker, motion: Motion) -> Duration {
    MOTION.store(motion as u8, Ordering::SeqCst);
    SHOW.store(false, Ordering::SeqCst);
    // SAFETY: created on the main thread and retained until after close.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(100.0, 100.0), NSSize::new(360.0, 240.0)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    unsafe { window.setReleasedWhenClosed(false) };
    let app = platform::AppView::new(
        mtm,
        platform::AppOptions {
            size: (360, 240),
            ..Default::default()
        },
    );
    window.setContentView(Some(&app.view()));
    app.load(platform::App::Rust(platform::Root::of::<Page>()));
    window.orderFront(None);
    // The page's own mount and warm-ups settle.
    pump(1.5);
    let shown = Instant::now();
    SHOW.store(true, Ordering::SeqCst);
    let end = shown + Duration::from_secs(5);
    while !loading(&app.view()) {
        assert!(
            Instant::now() < end,
            "the web view never started loading ({motion:?})"
        );
        pump(0.001);
    }
    let started = shown.elapsed();
    app.stop();
    window.close();
    pump(0.2);
    started
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    NSApplication::sharedApplication(mtm).finishLaunching();
    // Nothing answers there: only the load's start is measured.
    *URL.lock().unwrap() = "http://127.0.0.1:9/page".to_string();
    // The process's first web view starts WebKit's processes: not measured.
    delay(mtm, Motion::Still);
    let mut worst = Duration::ZERO;
    for round in 0..3 {
        let still = delay(mtm, Motion::Still);
        let spinner = delay(mtm, Motion::Spinner);
        let looping = delay(mtm, Motion::Loop);
        println!(
            "web_load_wait: round {round}: still {still:?}, spinner {spinner:?}, looping value {looping:?}"
        );
        worst = worst.max(spinner).max(looping);
    }
    // `LOAD_WAIT` is 500 ms; a few frames plus WebKit's own start are far
    // below it.
    assert!(
        worst < Duration::from_millis(350),
        "a web view under an endless animation waited {worst:?} to load"
    );
    println!("web_load_wait: an endless animation does not hold a web view's first load");
}
