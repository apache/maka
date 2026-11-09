use std::{
    cell::RefCell,
    rc::Rc,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::{Duration, Instant},
};

use nsh_core::prelude::*;
use nsh_platform_macos as platform;
use platform::{
    objc2::{MainThreadMarker, MainThreadOnly},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSEvent,
        NSEventMask, NSEventModifierFlags, NSEventType, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSDefaultRunLoopMode, NSPoint, NSRect, NSSize, NSString},
};
static DRAGGABLE: AtomicBool = AtomicBool::new(false);
static MUTATE: AtomicBool = AtomicBool::new(false);
static APPEARING: AtomicBool = AtomicBool::new(false);
static ARMED: AtomicBool = AtomicBool::new(false);
static CHANGED: AtomicBool = AtomicBool::new(false);
static CLICKS: AtomicUsize = AtomicUsize::new(0);
thread_local! { static SURFACE: RefCell<Option<Rc<platform::AppView>>> = const {RefCell::new(None)}; }
#[component]
fn Background() -> impl IntoElement {
    view()
        .flex_1()
        .window_drag(true)
        .test_id("initial")
        .bg(rgb(0xe0e5ed))
        .child(text("Hold the background"))
}
#[component]
fn AppearingButton() -> impl IntoElement {
    let shown = signal(false);
    set_interval(Duration::from_millis(10), move || {
        if MUTATE.load(Ordering::SeqCst) {
            shown.set(true);
        }
    });
    view()
        .flex_1()
        .window_drag(true)
        .test_id("initial")
        .bg(rgb(0xe0e5ed))
        .child(when(shown, move || {
            view()
                .absolute()
                .inset_0()
                .window_drag(DRAGGABLE.load(Ordering::SeqCst))
                .test_id("target")
                .bg(rgb(0xeecc88))
                .on_press(move || {
                    CLICKS.fetch_add(1, Ordering::SeqCst);
                })
                .child(text("New button"))
        }))
}
#[component]
fn Replacement() -> impl IntoElement {
    view()
        .flex_1()
        .window_drag(DRAGGABLE.load(Ordering::SeqCst))
        .test_id("target")
        .bg(rgb(0xeecc88))
        .on_press(move || {
            CLICKS.fetch_add(1, Ordering::SeqCst);
        })
        .child(text("Replacement app"))
}
fn pump(ms: u64) {
    let deadline = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < deadline {
        platform::objc2_foundation::NSRunLoop::currentRunLoop()
            .runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
    }
}
fn event(
    kind: NSEventType,
    number: isize,
    timestamp: f64,
) -> platform::objc2::rc::Retained<NSEvent> {
    NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(kind,NSPoint::new(200.0,120.0),NSEventModifierFlags::empty(),timestamp,number,None,1,1,0.0).unwrap()
}
fn after(ms: u64, f: impl FnOnce() + Send + 'static) {
    dispatch2::DispatchQueue::main()
        .after(Duration::from_millis(ms).try_into().unwrap(), f)
        .unwrap();
}
fn contains(view: &NSView, id: &str) -> bool {
    if view
        .accessibilityIdentifier()
        .is_some_and(|value| value.to_string() == id)
        && view.frame().size.width > 0.0
    {
        return true;
    }
    view.subviews().iter().any(|child| contains(&child, id))
}
fn release_when_mounted(number: isize, deadline: Instant) {
    let ready = SURFACE.with(|s| contains(&s.borrow().as_ref().unwrap().view(), "target"));
    if ready {
        CHANGED.store(true, Ordering::SeqCst);
        let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
        app.postEvent_atStart(&event(NSEventType::LeftMouseUp, number, 2.1), false);
    } else {
        assert!(
            Instant::now() < deadline,
            "new native target must mount while held"
        );
        after(10, move || release_when_mounted(number, deadline));
    }
}
fn dispatch_events(ms: u64) {
    let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
    let deadline = Instant::now() + Duration::from_millis(ms);
    // SAFETY: AppKit's immutable default run-loop mode.
    let mode = unsafe { NSDefaultRunLoopMode };
    while Instant::now() < deadline {
        if let Some(e) = app.nextEventMatchingMask_untilDate_inMode_dequeue(
            NSEventMask::Any,
            Some(&NSDate::dateWithTimeIntervalSinceNow(0.01)),
            mode,
            true,
        ) {
            if e.r#type() == NSEventType::LeftMouseDown && ARMED.swap(false, Ordering::SeqCst) {
                let number = e.windowNumber();
                after(50, move || {
                    if APPEARING.load(Ordering::SeqCst) {
                        MUTATE.store(true, Ordering::SeqCst);
                    } else {
                        SURFACE.with(|s| {
                            s.borrow()
                                .as_ref()
                                .unwrap()
                                .load(platform::App::Rust(platform::Root::of::<Replacement>()))
                        });
                    }
                    release_when_mounted(number, Instant::now() + Duration::from_secs(5));
                });
            }
            app.sendEvent(&e);
        }
        app.updateWindows();
    }
}

fn check(scenario: &str) {
    DRAGGABLE.store(scenario.ends_with("draggable"), Ordering::SeqCst);
    MUTATE.store(false, Ordering::SeqCst);
    APPEARING.store(scenario.starts_with("appearing"), Ordering::SeqCst);
    CHANGED.store(false, Ordering::SeqCst);
    CLICKS.store(0, Ordering::SeqCst);
    let mtm = MainThreadMarker::new().unwrap();
    let app = NSApplication::sharedApplication(mtm);
    // SAFETY: The window is created on the process main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(800.0, 300.0), NSSize::new(420.0, 240.0)),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Closable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe {
        window.setReleasedWhenClosed(false);
    }
    window.setTitle(&NSString::from_str("NSH held-press regression"));
    let options = platform::AppOptions {
        size: (420, 240),
        ..Default::default()
    };
    let surface = platform::AppView::new(mtm, options);
    window.setContentView(Some(&surface.view()));
    SURFACE.with(|s| *s.borrow_mut() = Some(surface.clone()));
    let root = if scenario.starts_with("appearing") {
        platform::Root::of::<AppearingButton>()
    } else {
        platform::Root::of::<Background>()
    };
    surface.load(platform::App::Rust(root));
    window.makeKeyAndOrderFront(None);
    app.activate();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !contains(&surface.view(), "initial") {
        assert!(
            Instant::now() < deadline,
            "initial native target must mount"
        );
        pump(10);
    }
    let number = window.windowNumber();
    ARMED.store(true, Ordering::SeqCst);
    app.postEvent_atStart(&event(NSEventType::LeftMouseDown, number, 1.0), false);
    dispatch_events(1000);
    assert!(
        CHANGED.load(Ordering::SeqCst),
        "new native target must mount before release"
    );
    pump(200);
    let clicks = CLICKS.load(Ordering::SeqCst);
    app.postEvent_atStart(&event(NSEventType::LeftMouseDown, number, 3.0), false);
    app.postEvent_atStart(&event(NSEventType::LeftMouseUp, number, 3.1), false);
    dispatch_events(200);
    pump(200);
    let control = CLICKS.load(Ordering::SeqCst) - clicks;
    assert_eq!(control, 1, "a fresh click must reach the new control");
    println!(
        "scenario={scenario} tree_changed=true unintended_clicks={clicks} fresh_click={control}"
    );
    surface.stop();
    SURFACE.with(|s| s.borrow_mut().take());
    window.close();
    assert_eq!(
        clicks, 0,
        "a held background press must not activate a new target"
    );
}

pub(super) fn run() {
    let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    app.finishLaunching();
    for scenario in [
        "appearing",
        "appearing-draggable",
        "reset",
        "reset-draggable",
    ] {
        check(scenario);
    }
}
