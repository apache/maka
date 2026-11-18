//! Back-to-back AppKit mouse events must still draw a short press.
//! Uses the ordinary AppView, including its engine and display link.
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use nsh_core::prelude::*;
use nsh_platform_macos as platform;
use platform::{
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSApplicationActivationPolicy, NSBackingStoreType,
        NSBitmapImageFileType, NSBitmapImageRepPropertyKey, NSEvent, NSEventModifierFlags,
        NSEventType, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSDictionary, NSPoint, NSProcessInfo, NSRect, NSRunLoop, NSSize},
};

static EVENTS: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());

#[component]
fn Pad() -> impl IntoElement {
    view()
        .flex_1()
        .flex_row()
        .bg(rgb(0xffffff))
        .child(
            view()
                .test_id("pad")
                .w(px(200.0))
                .h(px(100.0))
                .bg(rgb(0x336699))
                .active(|s| s.opacity(0.2))
                .transition_opacity()
                .duration(150.0)
                .on_press_down(|| EVENTS.lock().unwrap().push("down"))
                .on_press_up(|| EVENTS.lock().unwrap().push("up"))
                .on_press(|| EVENTS.lock().unwrap().push("press"))
                .child(text("Animated tap").text_color(rgb(0xffffff))),
        )
        .child(
            view()
                .test_id("plain")
                .selectable(true)
                .w(px(100.0))
                .h(px(100.0))
                .bg(rgb(0x336699))
                .active(|s| s.opacity(0.2))
                .on_press_down(|| EVENTS.lock().unwrap().push("down"))
                .on_press_up(|| EVENTS.lock().unwrap().push("up"))
                .on_press(|| EVENTS.lock().unwrap().push("press"))
                .child(text("Plain tap").text_color(rgb(0xffffff))),
        )
}

fn pump(ms: u64) {
    let deadline = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < deadline {
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.001));
    }
}

fn find(view: &NSView, id: &str) -> Option<Retained<NSView>> {
    if view
        .accessibilityIdentifier()
        .is_some_and(|value| value.to_string() == id)
    {
        return Some(view.retain());
    }
    view.subviews().iter().find_map(|v| find(&v, id))
}

fn mouse(window: &NSWindow, kind: NSEventType, x: f64) -> Retained<NSEvent> {
    mouse_at(window, kind, NSPoint::new(x, 150.0), 1)
}

fn mouse_at(window: &NSWindow, kind: NSEventType, at: NSPoint, clicks: isize) -> Retained<NSEvent> {
    NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        kind, at, NSEventModifierFlags::empty(),
        NSProcessInfo::processInfo().systemUptime(), window.windowNumber(), None, 1, clicks, 0.0,
    ).unwrap()
}

fn screenshot(root: &NSView, name: &str) {
    let Some(directory) = std::env::var_os("NSH_TAP_SCREENSHOTS") else {
        return;
    };
    root.displayIfNeeded();
    let bounds = root.bounds();
    let bitmap = root
        .bitmapImageRepForCachingDisplayInRect(bounds)
        .expect("bitmap");
    root.cacheDisplayInRect_toBitmapImageRep(bounds, &bitmap);
    let properties =
        NSDictionary::<NSBitmapImageRepPropertyKey, platform::objc2::runtime::AnyObject>::new();
    // SAFETY: an empty dictionary is valid for PNG.
    let png = unsafe {
        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
    }
    .expect("PNG");
    let directory = std::path::PathBuf::from(directory);
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join(format!("{name}.png")), png.to_vec()).unwrap();
}

fn check(animated: bool) {
    let mtm = MainThreadMarker::new().unwrap();
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    app.finishLaunching();
    // SAFETY: main thread; retained until after close.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(800.0, 300.0), NSSize::new(320.0, 200.0)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: this scope retains the window until after it closes.
    unsafe {
        window.setReleasedWhenClosed(false);
    }
    let surface = platform::AppView::new(
        mtm,
        platform::AppOptions {
            size: (320, 200),
            ..Default::default()
        },
    );
    window.setContentView(Some(&surface.view()));
    surface.load(platform::App::Rust(platform::Root::of::<Pad>()));
    window.orderFrontRegardless();
    pump(1000);
    let content = surface.view();
    let id = if animated { "pad" } else { "plain" };
    let x = if animated { 50.0 } else { 250.0 };
    let pad = find(&content, id).expect("mounted pad");
    let root = content
        .hitTest(NSPoint::new(50.0, 150.0))
        .expect("input root");
    let opacity = || pad.layer().unwrap().opacity();
    // Positive control: the display link must animate an ordinary held click.
    root.mouseDown(&mouse(&window, NSEventType::LeftMouseDown, x));
    pump(250);
    println!(
        "animated={animated} held: opacity={}, events={:?}, visible={}, occlusion={:?}, screen={:?}",
        opacity(),
        EVENTS.lock().unwrap(),
        window.isVisible(),
        window.occlusionState(),
        window.screen().map(|s| s.frame())
    );
    assert!(opacity() < 0.3, "a held press must draw active feedback");
    root.mouseUp(&mouse(&window, NSEventType::LeftMouseUp, x));
    pump(250);
    assert!((opacity() - 1.0).abs() < 0.01);
    screenshot(&content, "idle");
    EVENTS.lock().unwrap().clear();
    root.mouseDown(&mouse(&window, NSEventType::LeftMouseDown, x));
    root.mouseUp(&mouse(&window, NSEventType::LeftMouseUp, x));
    let mut minimum = 1.0f32;
    let deadline = Instant::now() + Duration::from_millis(400);
    while Instant::now() < deadline {
        pump(2);
        if opacity() < minimum {
            minimum = opacity();
            screenshot(&content, "tap");
        }
    }
    println!(
        "animated={animated} tap: minimum opacity={minimum}, final={}, events={:?}",
        opacity(),
        EVENTS.lock().unwrap()
    );
    assert_eq!(*EVENTS.lock().unwrap(), ["down", "up", "press"]);
    assert!(minimum < 0.95, "a same-turn tap must draw active feedback");
    assert!((opacity() - 1.0).abs() < 0.01, "feedback must end");
    // An old tap's timer must not clear the next physical press.
    root.mouseDown(&mouse(&window, NSEventType::LeftMouseDown, x));
    root.mouseUp(&mouse(&window, NSEventType::LeftMouseUp, x));
    root.mouseDown(&mouse(&window, NSEventType::LeftMouseDown, x));
    pump(250);
    assert!(
        opacity() < 0.3,
        "an earlier tap must not release the next press"
    );
    root.mouseUp(&mouse(&window, NSEventType::LeftMouseUp, x));
    pump(250);
    assert!((opacity() - 1.0).abs() < 0.01);

    // Moving outside cancels even a very short press, without a click.
    EVENTS.lock().unwrap().clear();
    root.mouseDown(&mouse(&window, NSEventType::LeftMouseDown, x));
    root.mouseDragged(&mouse(&window, NSEventType::LeftMouseDragged, 315.0));
    root.mouseUp(&mouse(&window, NSEventType::LeftMouseUp, 315.0));
    pump(250);
    assert!(!EVENTS.lock().unwrap().contains(&"press"));
    assert!((opacity() - 1.0).abs() < 0.01);

    if !animated {
        // A double-click selects without a drag event, cancelling the
        // press. It must not get a completed tap's visual pulse.
        EVENTS.lock().unwrap().clear();
        root.mouseDown(&mouse_at(
            &window,
            NSEventType::LeftMouseDown,
            NSPoint::new(220.0, 190.0),
            2,
        ));
        root.mouseUp(&mouse_at(
            &window,
            NSEventType::LeftMouseUp,
            NSPoint::new(220.0, 190.0),
            2,
        ));
        let deadline = Instant::now() + Duration::from_millis(250);
        while Instant::now() < deadline {
            pump(2);
            assert!(
                (opacity() - 1.0).abs() < 0.01,
                "a selecting click must not pulse"
            );
        }
        assert!(!EVENTS.lock().unwrap().contains(&"press"));
    }

    // A timer that outlives its app must not retain it or touch a new tree.
    root.mouseDown(&mouse(&window, NSEventType::LeftMouseDown, x));
    root.mouseUp(&mouse(&window, NSEventType::LeftMouseUp, x));
    surface.stop();
    pump(100);
    window.close();
}

pub(super) fn run() {
    check(false);
    // The plain check covers event/state delivery even in a session with
    // no screen. Animations require a live display link and run by default.
    if std::env::var_os("NSH_TAP_FEEDBACK_PLAIN_ONLY").is_none() {
        check(true);
    } else {
        println!("Animated tap checks not requested (NSH_TAP_FEEDBACK_PLAIN_ONLY)");
    }
}
