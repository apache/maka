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
    objc2::{MainThreadMarker, MainThreadOnly},
    objc2_app_kit::{
        NSApplication, NSBackingStoreType, NSScreen, NSWindow, NSWindowButton, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSSize, NSString},
};

/// The bar the app asks for: 0 the system's, else its height.
static WANT: AtomicU32 = AtomicU32::new(0);
/// The environment's `title_bar().top`, as the app reads it.
static TOP: AtomicU32 = AtomicU32::new(u32::MAX);

#[component]
fn Bar() -> impl IntoElement {
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
            desktop::main_window().set(attributes);
        }
    });
    effect(|| TOP.store(desktop::title_bar().top.0 as u32, Ordering::SeqCst));
    view().flex_1().bg(rgb(0xe0e5ed))
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
    // SAFETY: The window is created on the process main thread.
    let window = unsafe {
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
        window.setReleasedWhenClosed(false);
    }
    window.setTitle(&NSString::from_str("NSH title bar"));
    let mut options = platform::AppOptions::default();
    options.size = (480, 300);
    let surface = platform::AppView::new(mtm, options);
    window.setContentView(Some(&surface.view()));
    surface.load(platform::App::Rust(platform::Root::of::<Bar>()));
    window.makeKeyAndOrderFront(None);
    set_bar(0, 0);
    let system = lights(&window);

    set_bar(36, 36);
    assert_centered(&window, &system, 36.0, "36-point bar");

    let mut frame = window.frame();
    frame.size.width += 160.0;
    frame.size.height += 120.0;
    window.setFrame_display(frame, true);
    pump(200);
    assert_centered(&window, &system, 36.0, "36-point bar after a resize");

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
        for _ in 0..3 {
            let mut frame = window.frame();
            frame.size.width += 30.0;
            frame.size.height += 20.0;
            window.setFrame_display(frame, true);
            pump(100);
            assert_offset(&window, &system, "offset after resize");
            window.resignKeyWindow();
            window.makeKeyWindow();
            pump(100);
            assert_offset(&window, &system, "offset after becoming key");
        }
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
