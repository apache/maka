//! Hover in the main surface and in `window()` content. Inspect AppKit's
//! tracking areas too: the test agent's hover bypasses those areas.
//! This check moves the system pointer and needs an unlocked desktop and
//! permission to post input events.

use std::{
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

use nsh_core::{element::desktop, prelude::*};
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSEventMask, NSScreen, NSView,
        NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSDefaultRunLoopMode, NSPoint, NSRect, NSSize, NSString},
};
use objc2_core_foundation::CGPoint;
use objc2_core_graphics::{CGEvent, CGEventTapLocation, CGEventType, CGMouseButton};

static ENTERS: [AtomicUsize; 2] = [AtomicUsize::new(0), AtomicUsize::new(0)];
static LEAVES: [AtomicUsize; 2] = [AtomicUsize::new(0), AtomicUsize::new(0)];

fn target(index: usize) -> impl IntoElement {
    let hovered = signal(false);
    view()
        .absolute()
        .left(px(100.0))
        .top(px(60.0))
        .w(px(200.0))
        .h(px(120.0))
        .test_id("hover-target")
        .bg(rgb(0xdbeafe))
        .on_mouse_enter(move |_: &MouseEvent| {
            hovered.set(true);
            ENTERS[index].fetch_add(1, Ordering::SeqCst);
        })
        .on_mouse_leave(move |_: &MouseEvent| {
            hovered.set(false);
            LEAVES[index].fetch_add(1, Ordering::SeqCst);
        })
        .child(text(move || {
            if hovered.get() {
                "Pointer inside"
            } else {
                "Pointer outside"
            }
        }))
}

#[component]
fn HoverWindows() -> impl IntoElement {
    view().size_full().child(target(0)).child(
        desktop::window()
            .id("hover-window")
            .title("NSH secondary hover")
            .default_size(size(px(400.0), px(240.0)))
            .content(|| view().size_full().child(target(1))),
    )
}

fn dispatch(ms: u64) {
    let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
    let deadline = Instant::now() + Duration::from_millis(ms);
    // SAFETY: AppKit's immutable default run-loop mode.
    let mode = unsafe { NSDefaultRunLoopMode };
    while Instant::now() < deadline {
        if let Some(event) = app.nextEventMatchingMask_untilDate_inMode_dequeue(
            NSEventMask::Any,
            Some(&NSDate::dateWithTimeIntervalSinceNow(0.005)),
            mode,
            true,
        ) {
            app.sendEvent(&event);
        }
        app.updateWindows();
    }
}

fn find(view: &NSView) -> Option<Retained<NSView>> {
    if view
        .accessibilityIdentifier()
        .is_some_and(|id| id.to_string() == "hover-target")
    {
        return Some(Retained::from(view));
    }
    view.subviews().iter().find_map(|child| find(&child))
}

fn move_mouse(window: &NSWindow, at: NSPoint) {
    let screen = window.convertPointToScreen(at);
    let height = NSScreen::screens(MainThreadMarker::from(window))
        .firstObject()
        .unwrap()
        .frame()
        .size
        .height;
    let event = CGEvent::new_mouse_event(
        None,
        CGEventType::MouseMoved,
        CGPoint::new(screen.x, height - screen.y),
        CGMouseButton::Left,
    )
    .unwrap();
    CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
    dispatch(100);
}

#[allow(clippy::field_reassign_with_default)]
pub(super) fn run() {
    assert!(
        objc2_core_graphics::CGPreflightPostEventAccess(),
        "native hover check needs permission to post input events"
    );
    let mtm = MainThreadMarker::new().unwrap();
    let app = NSApplication::sharedApplication(mtm);
    // SAFETY: The window is created on the process main thread.
    let main = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(50.0, 300.0), NSSize::new(400.0, 240.0)),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Closable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe { main.setReleasedWhenClosed(false) };
    main.setTitle(&NSString::from_str("NSH main hover"));
    let mut options = platform::AppOptions::default();
    options.size = (400, 240);
    let surface = platform::AppView::new(mtm, options);
    main.setContentView(Some(&surface.view()));
    main.makeFirstResponder(Some(&surface.view()));
    surface.load(platform::App::Rust(platform::Root::of::<HoverWindows>()));
    main.makeKeyAndOrderFront(None);
    let deadline = Instant::now() + Duration::from_secs(5);
    let own = loop {
        dispatch(10);
        if let Some(window) = app.windows().iter().find(|w| {
            w.title().to_string() == "NSH secondary hover"
                && w.contentView().is_some_and(|v| find(&v).is_some())
        }) {
            break window;
        }
        assert!(Instant::now() < deadline, "secondary content must mount");
    };
    dispatch(200);
    own.setFrameOrigin(NSPoint::new(650.0, 300.0));
    dispatch(300);
    for (index, window) in [(1, &*own), (0, &*main)] {
        window.makeKeyAndOrderFront(None);
        #[allow(deprecated)]
        app.activateIgnoringOtherApps(true);
        dispatch(100);
        let target = find(&window.contentView().unwrap()).unwrap();
        let mut ancestor = Some(target.clone());
        let mut areas = Vec::new();
        while let Some(view) = ancestor {
            areas.extend(view.trackingAreas().iter().map(|area| area.options()));
            // SAFETY: The mounted view's superview is alive on the main thread.
            ancestor = unsafe { view.superview() };
        }
        println!("hover window={index} native_tracking_options={areas:?}");
        move_mouse(window, NSPoint::new(10.0, 10.0));
        ENTERS[index].store(0, Ordering::SeqCst);
        LEAVES[index].store(0, Ordering::SeqCst);
        let rect = target.convertRect_toView(target.bounds(), None);
        move_mouse(window, NSPoint::new(rect.mid().x, rect.mid().y));
        dispatch(2000);
        move_mouse(window, NSPoint::new(10.0, 10.0));
        println!(
            "hover window={index} system_pointer enters={} leaves={}",
            ENTERS[index].load(Ordering::SeqCst),
            LEAVES[index].load(Ordering::SeqCst),
        );
    }
    surface.stop();
    main.close();
    for index in 0..2 {
        assert_eq!(
            ENTERS[index].load(Ordering::SeqCst),
            1,
            "window {index}: enter"
        );
        assert_eq!(
            LEAVES[index].load(Ordering::SeqCst),
            1,
            "window {index}: leave"
        );
    }
}
