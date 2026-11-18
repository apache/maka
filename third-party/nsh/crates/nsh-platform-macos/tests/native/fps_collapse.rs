//! The performance monitor's panel takes its own clicks and only them: a
//! click on it collapses it to a pill with the frame rate and another
//! expands it again, while a point beside it still reaches the app. The app
//! sets how it shows (`AppView::set_fps_mode`, `setFpsMode`): collapsed,
//! expanded, or hidden while it still measures. Read from the native
//! `NSView`s of a real `AppView`.

use std::{
    rc::Rc,
    time::{Duration, Instant},
};

use nsh_core::prelude::*;
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, rc::Retained},
    objc2_app_kit::{
        NSApplication, NSBackingStoreType, NSEvent, NSEventModifierFlags, NSEventType, NSView,
        NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize, NSString},
};

#[component]
fn Blank() -> impl IntoElement {
    view().size_full().test_id("app")
}

/// The performance monitor's panel among `view`'s descendants.
fn panel(view: &NSView) -> Option<Retained<NSView>> {
    view.subviews().iter().find_map(|child| {
        if child.class().name().to_str() == Ok("NshFpsPanel") {
            Some(child.clone())
        } else {
            panel(&child)
        }
    })
}

/// Runs the main run loop until `done` holds, for at most five seconds.
fn until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "{what} never happened");
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
    }
}

/// A click at `at` (window coordinates), sent through the window as the
/// system sends it.
fn click(window: &NSWindow, at: NSPoint) {
    let time = platform::objc2_foundation::NSProcessInfo::processInfo().systemUptime();
    for (kind, pressure) in [
        (NSEventType::LeftMouseDown, 1.0),
        (NSEventType::LeftMouseUp, 0.0),
    ] {
        let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            kind,
            at,
            NSEventModifierFlags::empty(),
            time,
            window.windowNumber(),
            None,
            0,
            1,
            pressure,
        )
        .expect("a mouse event");
        window.sendEvent(&event);
    }
}

/// The view a point in `window` hits, as AppKit finds it for a click.
fn hit(window: &NSWindow, at: NSPoint) -> Option<Retained<NSView>> {
    let content = window.contentView()?;
    // SAFETY: the content view's superview (the frame view), as hitTest:
    // takes points in it.
    let outer = unsafe { content.superview() };
    let point = outer.map_or(at, |o| o.convertPoint_fromView(at, None));
    content.hitTest(point)
}

/// The middle of `view`, in its window's coordinates.
fn middle(view: &NSView) -> NSPoint {
    let b = view.bounds();
    view.convertPoint_toView(
        NSPoint::new(
            b.origin.x + b.size.width / 2.0,
            b.origin.y + b.size.height / 2.0,
        ),
        None,
    )
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().expect("the checks run on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.finishLaunching();
    // SAFETY: The window is created on the process main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(200.0, 200.0), NSSize::new(480.0, 320.0)),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Closable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(&NSString::from_str("NSH performance monitor collapse"));
    let options = platform::AppOptions {
        size: (480, 320),
        ..Default::default()
    };
    let surface: Rc<platform::AppView> = platform::AppView::new(mtm, options);
    window.setContentView(Some(&surface.view()));
    surface.load(platform::App::Rust(platform::Root::of::<Blank>()));
    window.makeKeyAndOrderFront(None);
    surface.set_fps_monitor(true);
    let root = surface.view();
    let width = |p: &NSView| p.frame().size.width;

    until("the panel showing", || {
        panel(&root).is_some_and(|p| width(&p) > 200.0)
    });
    let shown = panel(&root).expect("the panel");
    let expanded = width(&shown);
    // A point on it hits it; one beside it reaches the app, not the panel.
    let on = middle(&shown);
    assert!(
        hit(&window, on).is_some_and(|v| *v == *shown),
        "a click on the panel goes to it"
    );
    let beside = NSPoint::new(40.0, 40.0);
    assert!(
        hit(&window, beside).is_some_and(|v| *v != *shown),
        "a click beside it goes to the app"
    );

    // A click collapses it to a pill; another expands it again.
    click(&window, on);
    until("the panel collapsing", || width(&shown) < 120.0);
    click(&window, middle(&shown));
    until("the panel expanding", || width(&shown) == expanded);

    // The app sets the mode.
    surface.set_fps_mode(FpsMode::Collapsed);
    until("the app collapsing it", || width(&shown) < 120.0);
    surface.set_fps_mode(FpsMode::Hidden);
    until("the app hiding it", || shown.isHidden());
    assert!(
        hit(&window, on).is_none_or(|v| *v != *shown),
        "a hidden panel takes no click"
    );
    assert!(
        surface.perf_monitor().is_some(),
        "it still measures while hidden"
    );
    surface.set_fps_mode(FpsMode::Expanded);
    until("the app expanding it", || {
        !shown.isHidden() && width(&shown) == expanded
    });

    surface.stop();
    window.close();
}
