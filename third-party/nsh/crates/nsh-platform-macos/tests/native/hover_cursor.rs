//! Hover cursors across nested views inside overlays and popovers stay
//! synchronized with tracking-area cursor updates and style/prop commits
//! without requiring Accessibility permission.
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use nsh_core::prelude::*;
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSCursor, NSEvent,
        NSEventModifierFlags, NSEventType, NSGraphicsContext, NSTrackingAreaOptions, NSView,
        NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSDefaultRunLoopMode, NSPoint, NSRect, NSRunLoop, NSSize},
};

static POPOVER_STYLE_DEFAULT: AtomicBool = AtomicBool::new(false);
static CHILD_BLOCKED: AtomicBool = AtomicBool::new(false);

#[component]
fn Scene() -> impl IntoElement {
    let default_cursor = signal(false);
    let child_blocked = signal(false);
    set_interval(Duration::from_millis(5), move || {
        default_cursor.set(POPOVER_STYLE_DEFAULT.load(Ordering::SeqCst));
        child_blocked.set(CHILD_BLOCKED.load(Ordering::SeqCst));
    });
    view().size_full().bg(rgb(0xffffff)).child(
        nsh_core::element::overlay().child(
            view()
                .absolute()
                .left(px(40.0))
                .top(px(40.0))
                .w(px(280.0))
                .h(px(160.0))
                .bg(rgb(0xf8fafc))
                // Outer link container with nested child + label + dynamic badge.
                .child(
                    view()
                        .test_id("popover-link")
                        .w(px(260.0))
                        .h(px(56.0))
                        .p_2()
                        .flex_row()
                        .items_center()
                        .gap_2()
                        .cursor(Cursor::Pointer)
                        .style_when(move || default_cursor.get(), |s| s.cursor(Cursor::Default))
                        .hover(|s| s.bg(rgb(0xe2e8f0)))
                        .child(
                            view()
                                .w(px(28.0))
                                .h(px(28.0))
                                .hover(|s| s.bg(rgb(0xcbd5e1))),
                        )
                        .child(
                            view()
                                .flex_1()
                                .h(px(28.0))
                                .justify_center()
                                .child(text("Nested popover link")),
                        )
                        .child(
                            view()
                                .w(px(48.0))
                                .h(px(24.0))
                                .cursor(Cursor::Grab)
                                .pointer_events(move || {
                                    if child_blocked.get() {
                                        PointerEvents::None
                                    } else {
                                        PointerEvents::Auto
                                    }
                                }),
                        ),
                ),
        ),
    )
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().expect("main thread");
    NSApplication::sharedApplication(mtm).finishLaunching();

    // SAFETY: created and retained on the main thread until closed.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(160.0, 200.0), NSSize::new(420.0, 300.0)),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Closable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: retained window lives until closed below.
    unsafe { window.setReleasedWhenClosed(false) };
    let app = platform::AppView::new(
        mtm,
        platform::AppOptions {
            size: (420, 300),
            ..Default::default()
        },
    );
    let container = app.view();
    window.setContentView(Some(&container));
    app.load(platform::App::Rust(platform::Root::of::<Scene>()));
    window.orderFront(None);

    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        pump_ms(10);
        if let Some(root) = container.subviews().firstObject() {
            let areas = root.trackingAreas();
            let has_cursor_update = (0..areas.count()).any(|i| {
                areas
                    .objectAtIndex(i)
                    .options()
                    .contains(NSTrackingAreaOptions::CursorUpdate)
            });
            if has_cursor_update {
                break;
            }
        }
    }
    let root = container.subviews().firstObject().expect("surface root");
    let areas = root.trackingAreas();
    assert!(
        (0..areas.count()).any(|i| areas
            .objectAtIndex(i)
            .options()
            .contains(NSTrackingAreaOptions::CursorUpdate)),
        "root tracking area must opt into AppKit CursorUpdate notifications"
    );

    let win_point = |x: f64, y_from_top: f64| -> NSPoint {
        let local = NSPoint::new(x, y_from_top);
        root.convertPoint_toView(local, None)
    };
    let send_mouse = |ty: NSEventType, x: f64, y: f64| {
        let event_ty = NSEventType::MouseMoved;
        let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            event_ty,
            win_point(x, y),
            NSEventModifierFlags::empty(),
            0.0,
            window.windowNumber(),
            None::<&NSGraphicsContext>,
            0,
            0,
            0.0,
        )
        .expect("synthetic NSEvent");
        match ty {
            NSEventType::MouseMoved => root.mouseMoved(&event),
            NSEventType::MouseEntered => root.mouseEntered(&event),
            NSEventType::CursorUpdate => root.cursorUpdate(&event),
            _ => unreachable!(),
        }
    };

    let mount_deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < mount_deadline {
        if let Some(link) = find(&root, "popover-link")
            && link.frame().size.width > 0.0
        {
            break;
        }
        pump_ms(10);
    }
    assert!(
        find(&root, "popover-link").is_some_and(|v| v.frame().size.width > 0.0),
        "popover link did not mount in time"
    );

    let pointer = NSCursor::pointingHandCursor();
    let grab = NSCursor::openHandCursor();
    let arrow = NSCursor::arrowCursor();

    send_mouse(NSEventType::MouseEntered, 56.0, 62.0);
    assert_eq!(NSCursor::currentCursor(), pointer);
    for (x, y) in [(58.0, 62.0), (140.0, 62.0), (80.0, 62.0), (200.0, 62.0)] {
        send_mouse(NSEventType::MouseMoved, x, y);
        assert_eq!(
            NSCursor::currentCursor(),
            pointer,
            "nested move to ({x}, {y}) must keep pointingHandCursor"
        );
        // Simulate AppKit resetting cursor rects to arrow before delivering cursorUpdate:.
        arrow.set();
        send_mouse(NSEventType::CursorUpdate, x, y);
        assert_eq!(
            NSCursor::currentCursor(),
            pointer,
            "cursorUpdate: at ({x}, {y}) must restore pointingHandCursor"
        );
    }

    POPOVER_STYLE_DEFAULT.store(true, Ordering::SeqCst);
    let style_deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < style_deadline && NSCursor::currentCursor() != arrow {
        pump_ms(10);
    }
    assert_eq!(
        NSCursor::currentCursor(),
        arrow,
        "ViewStyle cursor change under pointer must update immediately"
    );
    POPOVER_STYLE_DEFAULT.store(false, Ordering::SeqCst);
    let restore_deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < restore_deadline && NSCursor::currentCursor() != pointer {
        pump_ms(10);
    }
    assert_eq!(NSCursor::currentCursor(), pointer);

    send_mouse(NSEventType::MouseMoved, 260.0, 62.0);
    assert_eq!(NSCursor::currentCursor(), grab);
    CHILD_BLOCKED.store(true, Ordering::SeqCst);
    let props_deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < props_deadline && NSCursor::currentCursor() != pointer {
        pump_ms(10);
    }
    assert_eq!(
        NSCursor::currentCursor(),
        pointer,
        "ViewProps pointerEvents change under pointer must refresh cursor immediately"
    );

    send_mouse(NSEventType::CursorUpdate, 10.0, 10.0);
    assert_eq!(NSCursor::currentCursor(), arrow);

    arrow.set();
    window.close();
}

fn find(view: &NSView, id: &str) -> Option<Retained<NSView>> {
    if view
        .accessibilityIdentifier()
        .is_some_and(|v| v.to_string() == id)
    {
        return Some(view.retain());
    }
    view.subviews().iter().find_map(|v| find(&v, id))
}

fn pump_ms(ms: u64) {
    let until = NSDate::dateWithTimeIntervalSinceNow(ms as f64 / 1000.0);
    unsafe {
        NSRunLoop::currentRunLoop().runMode_beforeDate(NSDefaultRunLoopMode, &until);
    }
}
