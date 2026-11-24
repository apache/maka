//! A hidden title bar of the app's height: no toolbar on the window, the
//! traffic lights centered in the bar after the window resizes, and given
//! back to AppKit with the system's title bar.

use std::{
    sync::atomic::{AtomicU32, Ordering},
    time::{Duration, Instant},
};

use nsh_core::{
    desktop::{TitleBarOptions, TitleBarStyle, WindowAttributes},
    element::desktop,
    prelude::*,
};
use nsh_platform_macos as platform;
use platform::{
    objc2::{MainThreadMarker, MainThreadOnly, msg_send, rc::Retained, sel},
    objc2_app_kit::{
        NSApplication, NSBackingStoreType, NSScreen, NSWindow, NSWindowButton, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSSize, NSString},
};

const TITLE: &str = "NSH title bar";

/// The bar the app asks for: 0 the system's, else its height.
static WANT: AtomicU32 = AtomicU32::new(0);
/// The environment's `title_bar().top`, as the app reads it.
static TOP: AtomicU32 = AtomicU32::new(u32::MAX);

#[component]
fn Bar() -> impl IntoElement {
    let window = desktop::current_window();
    let for_interval = window.clone();
    let applied = signal(0u32);
    set_interval(Duration::from_millis(10), move || {
        let want = WANT.load(Ordering::SeqCst);
        if want != applied.get_untracked() {
            applied.set(want);
            let mut bar = TitleBarOptions::default();
            if want != 0 {
                bar.style = TitleBarStyle::Hidden;
                if want == 52 || want == 53 {
                    bar.controls_offset = Some(point(px(18.0), px(19.0)));
                }
                if want != 53 {
                    bar.height = Some(Points(want as f32));
                }
            }
            let mut attributes = WindowAttributes::default();
            attributes.title_bar = Some(bar);
            for_interval.set(attributes);
        }
    });
    effect(move || TOP.store(window.title_bar().top.0 as u32, Ordering::SeqCst));
    view().flex_1().bg(rgb(0xe0e5ed))
}

/// The app root: the host, with the one window the test reads.
#[component]
fn App() -> impl IntoElement {
    desktop::window()
        .id("main")
        .title(TITLE)
        .default_size(size(px(480.0), px(300.0)))
        .content(bar)
}

fn pump(ms: u64) {
    let deadline = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < deadline {
        platform::objc2_foundation::NSRunLoop::currentRunLoop()
            .runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
    }
}

/// Each traffic light's left edge and its center's distance from the
/// window's top edge.
fn lights(window: &NSWindow) -> Vec<(f64, f64)> {
    let height = window.frame().size.height;
    [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .into_iter()
    .map(|kind| {
        let button = window.standardWindowButton(kind).expect("a traffic light");
        let rect = button.convertRect_toView(button.bounds(), None);
        (
            rect.origin.x,
            height - (rect.origin.y + rect.size.height / 2.0),
        )
    })
    .collect()
}

/// Asks for `bar` and waits until the app reads `top`.
fn set_bar(bar: u32, top: u32) {
    WANT.store(bar, Ordering::SeqCst);
    let deadline = Instant::now() + Duration::from_secs(5);
    while TOP.load(Ordering::SeqCst) != top {
        assert!(
            Instant::now() < deadline,
            "title_bar().top must become {top} for bar {bar}, is {}",
            TOP.load(Ordering::SeqCst)
        );
        pump(10);
    }
    pump(100);
}

/// Whether a click at the middle of each traffic light reaches it: a
/// button moved outside its superview's bounds still draws, but AppKit's
/// hit-testing never finds it.
fn assert_clickable(window: &NSWindow, when: &str) {
    let frame_view = window
        .contentView()
        // SAFETY: read on the main thread; the content view is in the
        // window, so its superview is the window's live theme frame.
        .and_then(|content| unsafe { content.superview() })
        .expect("the window's theme frame");
    for kind in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        let button = window.standardWindowButton(kind).expect("a traffic light");
        let rect = button.convertRect_toView(button.bounds(), None);
        let middle = NSPoint::new(
            rect.origin.x + rect.size.width / 2.0,
            rect.origin.y + rect.size.height / 2.0,
        );
        let hit = frame_view.hitTest(middle);
        assert!(
            hit.is_some_and(|view| view.isDescendantOf(&button)),
            "{when}: a click at a traffic light's middle reaches it"
        );
    }
}

fn assert_centered(window: &NSWindow, system: &[(f64, f64)], bar: f64, when: &str) {
    assert!(window.toolbar().is_none(), "{when}: no toolbar");
    assert_clickable(window, when);
    for (light, (x, _)) in lights(window).into_iter().zip(system) {
        assert_eq!(light.0, *x, "{when}: the traffic lights keep AppKit's x");
        assert!(
            (light.1 - bar / 2.0).abs() <= 0.5,
            "{when}: a traffic light's center is {} from the top, not {}",
            light.1,
            bar / 2.0
        );
    }
}

/// Runs after `window_press::run`, which launched the application.
// `AppOptions` is non-exhaustive: its fields are set after `default()`.
#[allow(clippy::field_reassign_with_default)]
pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    let app = NSApplication::sharedApplication(mtm);
    app.finishLaunching();
    assert!(
        NSScreen::screens(mtm).count() > 0,
        "native title bar checks need a display"
    );
    // The hidden host window; `App` opens the titled window under test.
    // SAFETY: The window is created on the process main thread.
    let host = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(700.0, 300.0), NSSize::new(480.0, 300.0)),
            NSWindowStyleMask::Titled
                | NSWindowStyleMask::Closable
                | NSWindowStyleMask::Miniaturizable
                | NSWindowStyleMask::Resizable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe {
        host.setReleasedWhenClosed(false);
    }
    host.setTitle(&NSString::from_str("NSH title bar host"));
    let mut options = platform::AppOptions::default();
    options.size = (480, 300);
    let surface = platform::AppView::new(mtm, options);
    host.setContentView(Some(&surface.view()));
    surface.load(platform::App::Rust(platform::Root::of::<App>()));
    let deadline = Instant::now() + Duration::from_secs(5);
    let window: Retained<NSWindow> = loop {
        if let Some(found) = app
            .windows()
            .iter()
            .find(|w| w.title().to_string() == TITLE && w.isVisible())
        {
            break found;
        }
        assert!(Instant::now() < deadline, "app window never appeared");
        pump(10);
    };
    set_bar(0, 0);
    let system = lights(&window);

    set_bar(36, 36);
    assert_centered(&window, &system, 36.0, "36-point bar");

    set_bar(46, 46);
    assert_centered(&window, &system, 46.0, "46-point bar");

    // Live-resize frames arrive faster than the window-state settle timer:
    // every frame must place all three buttons before display, including
    // ZoomButton (the last button AppKit updates in `_updateButtonPositions`).
    // SAFETY: optional AppKit live-resize bracket on the main thread.
    let live_bracket: bool =
        unsafe { msg_send![&*window, respondsToSelector: sel!(_startLiveResize)] };
    if live_bracket {
        // SAFETY: checked with `respondsToSelector:` on the main thread.
        unsafe {
            let _: () = msg_send![&*window, _startLiveResize];
        }
    }
    for step in 0..6 {
        let mut frame = window.frame();
        frame.size.width += if step % 2 == 0 { 24.0 } else { -12.0 };
        frame.size.height += if step % 2 == 0 { 18.0 } else { -8.0 };
        window.setFrame_display(frame, true);
        window.displayIfNeeded();
        assert_centered(
            &window,
            &system,
            46.0,
            &format!("46-point bar during live resize frame {step}"),
        );
        pump(16);
        assert_centered(
            &window,
            &system,
            46.0,
            &format!("46-point bar after live resize pump {step}"),
        );
    }
    if live_bracket {
        // SAFETY: matches `_startLiveResize` above.
        unsafe {
            let _: () = msg_send![&*window, _endLiveResize];
        }
    }
    pump(200);
    assert_centered(&window, &system, 46.0, "46-point bar after live resize");

    // `setTitle:` triggers AppKit's titlebar relayout without a window resize.
    window.setTitle(&NSString::from_str("NSH title bar renamed"));
    pump(50);
    assert_centered(&window, &system, 46.0, "46-point bar after setTitle");
    window.setTitle(&NSString::from_str(TITLE));
    pump(50);

    // A partial AppKit layout moving only ZoomButton must still re-center it.
    let zoom = window
        .standardWindowButton(NSWindowButton::ZoomButton)
        .unwrap();
    let mut origin = zoom.frame().origin;
    origin.y += 7.0;
    zoom.setFrameOrigin(origin);
    pump(50);
    assert_centered(&window, &system, 46.0, "46-point bar after ZoomButton move");

    set_bar(60, 60);
    assert_centered(&window, &system, 60.0, "60-point bar");

    set_bar(0, 0);
    assert!(window.toolbar().is_none(), "system title bar: no toolbar");
    for (light, before) in lights(&window).into_iter().zip(&system) {
        assert!(
            (light.0 - before.0).abs() <= 0.5 && (light.1 - before.1).abs() <= 0.5,
            "the system's title bar gets its traffic lights back: {light:?}, was {before:?}"
        );
    }
    for bar in [52, 53] {
        window.orderOut(None);
        WANT.store(bar, Ordering::SeqCst);
        pump(500);
        assert_offset(&window, &system, "offset before show");
        window.makeKeyAndOrderFront(None);
        pump(100);
        assert_offset(&window, &system, "offset after show");
        for step in 0..3 {
            let mut frame = window.frame();
            frame.size.width += 30.0;
            frame.size.height += 20.0;
            window.setFrame_display(frame, true);
            window.displayIfNeeded();
            assert_offset(
                &window,
                &system,
                &format!("offset immediately after resize {step}"),
            );
            pump(100);
            assert_offset(&window, &system, "offset after resize");
            window.resignKeyWindow();
            window.makeKeyWindow();
            pump(100);
            assert_offset(&window, &system, "offset after becoming key");
        }
        window.setTitle(&NSString::from_str("NSH title bar offset renamed"));
        pump(50);
        assert_offset(&window, &system, "offset after setTitle");
        window.setTitle(&NSString::from_str(TITLE));
        pump(50);
        if bar == 52 {
            // A layout notification can arrive after AppKit reset only
            // close, while the other two still have the custom offset.
            let close = window
                .standardWindowButton(NSWindowButton::CloseButton)
                .unwrap();
            let mut origin = close.frame().origin;
            origin.x = system[0].0;
            close.setFrameOrigin(origin);
            pump(100);
            assert_offset(&window, &system, "after a partial AppKit layout");
            assert_clickable(&window, "offset with bar height");
        }
        set_bar(0, 0);
        for (light, original) in lights(&window).iter().zip(&system) {
            assert!(
                (light.0 - original.0).abs() <= 0.5,
                "removing offset restores AppKit x: {light:?}, {original:?}"
            );
        }
    }
    println!("title bar: centered and offset buttons survive resize and key changes");
    surface.stop();
    window.close();
    host.close();
}

fn assert_offset(window: &NSWindow, system: &[(f64, f64)], when: &str) {
    let actual = lights(window);
    println!(
        "{when}: scale={}, lights={actual:?}",
        window.backingScaleFactor()
    );
    for (light, original) in actual.iter().zip(system) {
        assert!(
            (light.0 - actual[0].0 - (original.0 - system[0].0)).abs() <= 0.5,
            "{when}: spacing must match AppKit: {actual:?}, default {system:?}"
        );
    }
    assert!(
        (actual[0].0 - 18.0).abs() <= 0.5,
        "{when}: close x: {actual:?}"
    );
    for kind in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        let button = window.standardWindowButton(kind).unwrap();
        let rect = button.convertRect_toView(button.bounds(), None);
        let top = window.frame().size.height - rect.origin.y - rect.size.height;
        assert!((top - 19.0).abs() <= 0.5, "{when}: top={top}, expected 19");
    }
}
