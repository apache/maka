//! Clearing a view's animation bindings must clear the stale `AnimValues`
//! stored on the native view so later static styles (such as `active:scale-*`
//! or static opacity) are not overridden by the old animated values.
use std::{
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::{Duration, Instant},
};

use nsh_core::prelude::*;
use nsh_platform_macos as platform;
use platform::{
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSEvent,
        NSEventModifierFlags, NSEventType, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSProcessInfo, NSRect, NSRunLoop, NSSize},
};

static UNBIND: AtomicBool = AtomicBool::new(false);
static PRESSES: AtomicUsize = AtomicUsize::new(0);

#[component]
fn UnboundCard() -> impl IntoElement {
    let bound = signal(true);
    let tx = animated_value(0.0);
    let fade = animated_value(0.3);
    set_interval(Duration::from_millis(10), move || {
        if UNBIND.load(Ordering::SeqCst) && bound.get() {
            bound.set(false);
        }
    });
    view()
        .flex_1()
        .bg(rgb(0xffffff))
        // Two views without a key share the same native node across the branch
        // switch, so toggling `bound` off emits `AnimationBindings { bindings: [] }`.
        .child(
            when(bound, move || {
                view()
                    .test_id("row")
                    .w(px(200.0))
                    .h(px(60.0))
                    .bg(rgb(0x336699))
                    .bind_opacity(&fade)
                    .bind_translate_x(&tx)
                    .child(text("Row").text_color(rgb(0xffffff)))
            })
            .otherwise(move || {
                view()
                    .test_id("row")
                    .w(px(200.0))
                    .h(px(60.0))
                    .bg(rgb(0x336699))
                    .active(|s| s.scale(0.98))
                    .on_press(|| {
                        PRESSES.fetch_add(1, Ordering::SeqCst);
                    })
                    .child(text("Row").text_color(rgb(0xffffff)))
            }),
        )
}

fn pump(ms: u64) {
    let deadline = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < deadline {
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.002));
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

fn mouse(window: &NSWindow, kind: NSEventType, x: f64, y: f64) -> Retained<NSEvent> {
    NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        kind,
        NSPoint::new(x, y),
        NSEventModifierFlags::empty(),
        NSProcessInfo::processInfo().systemUptime(),
        window.windowNumber(),
        None,
        1,
        1,
        0.0,
    )
    .unwrap()
}

pub(super) fn run() {
    UNBIND.store(false, Ordering::SeqCst);
    PRESSES.store(0, Ordering::SeqCst);

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
    surface.load(platform::App::Rust(platform::Root::of::<UnboundCard>()));
    window.orderFrontRegardless();
    pump(400);

    let content = surface.view();
    let row = find(&content, "row").expect("mounted row");
    let bound_opacity = row.layer().unwrap().opacity();
    assert!(
        (bound_opacity - 0.3).abs() < 0.02,
        "expected bound opacity 0.3, got {bound_opacity}"
    );

    // Unbind animated opacity and translateX on the same native view.
    UNBIND.store(true, Ordering::SeqCst);
    pump(200);

    let unbound_opacity = row.layer().unwrap().opacity();
    assert!(
        (unbound_opacity - 1.0).abs() < 0.02,
        "stale animated opacity persisted after unbind: {unbound_opacity}"
    );

    // Hold-press the row so `:active` (`scale(0.98)`) commits before release.
    // A stale `anim.transform[0] = Some(0.0)` from `translateX` would override
    // `Scale(0.98)` to `Scale(0.0)`, collapsing the layer and dropping `onPress`.
    let (x, y) = (100.0, 170.0);
    let root = content.hitTest(NSPoint::new(x, y)).expect("input root");
    root.mouseDown(&mouse(&window, NSEventType::LeftMouseDown, x, y));
    pump(150);
    let m11 = row.layer().unwrap().transform().m11;
    assert!(
        (m11 - 0.98).abs() < 0.02,
        "expected active scale 0.98, got m11={m11}"
    );
    root.mouseUp(&mouse(&window, NSEventType::LeftMouseUp, x, y));
    pump(150);

    assert_eq!(
        PRESSES.load(Ordering::SeqCst),
        1,
        "held click on unbound view must still fire onPress"
    );

    surface.stop();
    pump(50);
    window.close();
}
