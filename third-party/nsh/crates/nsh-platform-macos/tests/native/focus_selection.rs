//! A click that focuses an `<Input selectTextOnFocus>` selects its text,
//! both a physical click (`45 ms` hold) and a same-turn tap-to-click (`0 ms`
//! back-to-back `LeftMouseDown` + `LeftMouseUp`), while the user's own
//! selection gestures (click-and-drag, double-click word selection, clicking
//! an already-focused field) keep theirs and an input without the prop places
//! the caret. Presses on hosted editors still report pointer activity
//! (`:active` feedback and `PressOutside` popover dismissal).

use std::{
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::{Duration, Instant},
};

use nsh_base::{button, input, popover};
use nsh_core::prelude::*;
use nsh_platform_macos as platform;
use platform::{
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSEvent, NSEventMask,
        NSEventModifierFlags, NSEventType, NSTextField, NSTextView, NSView, NSWindow,
        NSWindowStyleMask,
    },
    objc2_foundation::{
        NSDate, NSDefaultRunLoopMode, NSPoint, NSProcessInfo, NSRange, NSRect, NSSize,
    },
};

static SECOND_FOCUS_COUNT: AtomicUsize = AtomicUsize::new(0);
static POPOVER_OPEN: AtomicBool = AtomicBool::new(true);

#[component]
fn Page() -> impl IntoElement {
    view()
        .flex_1()
        .p(px(16.0))
        .gap(px(10.0))
        .child(
            button()
                .test_id("base-btn")
                .w(px(140.0))
                .h(px(28.0))
                .active(|s| s.opacity(0.2))
                .child(text("Action")),
        )
        .child(
            popover()
                .default_open(true)
                .on_close(|| {
                    POPOVER_OPEN.store(false, Ordering::SeqCst);
                })
                .trigger(view().w(px(80.0)).h(px(24.0)).child(text("Trigger")))
                .child(view().p(px(8.0)).child(text("Open popover"))),
        )
        .child(
            input()
                .test_id("first")
                .default_value("Hello")
                .w(px(240.0))
                .h(px(32.0))
                .p(px(6.0))
                .select_text_on_focus(true),
        )
        .child(
            input()
                .test_id("second")
                .default_value("World")
                .w(px(240.0))
                .h(px(32.0))
                .p(px(6.0))
                .select_text_on_focus(true)
                .on_focus(|| {
                    SECOND_FOCUS_COUNT.fetch_add(1, Ordering::SeqCst);
                }),
        )
        .child(
            input()
                .test_id("tap")
                .default_value("TapMe")
                .w(px(240.0))
                .h(px(32.0))
                .p(px(6.0))
                .active(|s| s.opacity(0.2))
                .select_text_on_focus(true),
        )
        .child(
            input()
                .test_id("drag")
                .default_value("Alpha Beta")
                .w(px(240.0))
                .h(px(32.0))
                .p(px(6.0))
                .select_text_on_focus(true),
        )
        .child(
            input()
                .test_id("words")
                .default_value("Hello World")
                .w(px(240.0))
                .h(px(32.0))
                .p(px(6.0))
                .select_text_on_focus(true),
        )
        .child(
            input()
                .test_id("area")
                .multiline(true)
                .default_value("Line 1")
                .w(px(240.0))
                .h(px(56.0))
                .p(px(6.0))
                .select_text_on_focus(true),
        )
        .child(
            input()
                .test_id("plain")
                .default_value("Plain")
                .w(px(240.0))
                .h(px(32.0))
                .p(px(6.0)),
        )
}

fn find(view: &NSView, matches: &dyn Fn(&NSView) -> bool) -> Option<Retained<NSView>> {
    if matches(view) {
        return Some(view.retain());
    }
    view.subviews()
        .iter()
        .find_map(|child| find(&child, matches))
}

fn view_by_id(root: &NSView, id: &str) -> Option<Retained<NSView>> {
    find(root, &|v| {
        v.accessibilityIdentifier()
            .is_some_and(|s| s.to_string() == id)
    })
}

fn field_by_id(root: &NSView, id: &str) -> Retained<NSTextField> {
    let outer = view_by_id(root, id).expect("input view");
    find(&outer, &|v| v.downcast_ref::<NSTextField>().is_some())
        .unwrap()
        .downcast::<NSTextField>()
        .unwrap()
}

fn area_by_id(root: &NSView, id: &str) -> Retained<NSTextView> {
    let outer = view_by_id(root, id).expect("area view");
    find(&outer, &|v| v.downcast_ref::<NSTextView>().is_some())
        .unwrap()
        .downcast::<NSTextView>()
        .unwrap()
}

fn mouse_event(
    kind: NSEventType,
    point: NSPoint,
    window_number: isize,
    timestamp: f64,
    clicks: isize,
) -> Retained<NSEvent> {
    NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        kind,
        point,
        NSEventModifierFlags::empty(),
        timestamp,
        window_number,
        None,
        0,
        clicks,
        if kind == NSEventType::MouseMoved { 0.0 } else { 1.0 },
    )
    .unwrap()
}

fn pump_events(app: &NSApplication, ms: u64) {
    let deadline = Instant::now() + Duration::from_millis(ms);
    // SAFETY: AppKit's immutable default run-loop mode.
    let mode = unsafe { NSDefaultRunLoopMode };
    while Instant::now() < deadline {
        if let Some(e) = app.nextEventMatchingMask_untilDate_inMode_dequeue(
            NSEventMask::Any,
            Some(&NSDate::dateWithTimeIntervalSinceNow(0.002)),
            mode,
            true,
        ) {
            app.sendEvent(&e);
        }
        app.updateWindows();
    }
}

fn click_with_hold(window: &NSWindow, view: &NSView, local_x: f64, local_y: f64, clicks: isize) {
    let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
    let point = view.convertPoint_toView(NSPoint::new(local_x, local_y), None);
    let number = window.windowNumber();
    let ts = NSProcessInfo::processInfo().systemUptime();
    dispatch2::DispatchQueue::main()
        .after(Duration::from_millis(45).try_into().unwrap(), move || {
            let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
            let up_ts = NSProcessInfo::processInfo().systemUptime();
            app.postEvent_atStart(
                &mouse_event(NSEventType::LeftMouseUp, point, number, up_ts, clicks),
                false,
            );
        })
        .unwrap();
    let down = mouse_event(NSEventType::LeftMouseDown, point, number, ts, clicks);
    window.sendEvent(&down);
    pump_events(&app, 100);
}

fn tap_same_turn(window: &NSWindow, view: &NSView, local_x: f64, local_y: f64) -> f32 {
    let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
    let point = view.convertPoint_toView(NSPoint::new(local_x, local_y), None);
    let number = window.windowNumber();
    let ts = NSProcessInfo::processInfo().systemUptime();
    // Queue `LeftMouseUp` ahead of entering `mouseDown:` so AppKit's modal
    // tracking loop consumes it in the same turn (~0 ms elapsed, matching
    // synthesized trackpad tap-to-click).
    app.postEvent_atStart(
        &mouse_event(NSEventType::LeftMouseUp, point, number, ts + 0.0001, 1),
        false,
    );
    window.sendEvent(&mouse_event(
        NSEventType::LeftMouseDown,
        point,
        number,
        ts,
        1,
    ));
    let mut min_opacity = 1.0f32;
    let deadline = Instant::now() + Duration::from_millis(220);
    while Instant::now() < deadline {
        pump_events(&app, 2);
        let current = view.layer().unwrap().opacity();
        if current < min_opacity {
            min_opacity = current;
        }
    }
    min_opacity
}

fn click_and_drag(window: &NSWindow, view: &NSView, from_x: f64, to_x: f64, local_y: f64) {
    let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
    let start = view.convertPoint_toView(NSPoint::new(from_x, local_y), None);
    let end = view.convertPoint_toView(NSPoint::new(to_x, local_y), None);
    let number = window.windowNumber();
    let ts = NSProcessInfo::processInfo().systemUptime();
    dispatch2::DispatchQueue::main()
        .after(Duration::from_millis(20).try_into().unwrap(), move || {
            let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
            let drag_ts = NSProcessInfo::processInfo().systemUptime();
            app.postEvent_atStart(
                &mouse_event(NSEventType::LeftMouseDragged, end, number, drag_ts, 1),
                false,
            );
        })
        .unwrap();
    dispatch2::DispatchQueue::main()
        .after(Duration::from_millis(45).try_into().unwrap(), move || {
            let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
            let up_ts = NSProcessInfo::processInfo().systemUptime();
            app.postEvent_atStart(
                &mouse_event(NSEventType::LeftMouseUp, end, number, up_ts, 1),
                false,
            );
        })
        .unwrap();
    window.sendEvent(&mouse_event(
        NSEventType::LeftMouseDown,
        start,
        number,
        ts,
        1,
    ));
    pump_events(&app, 100);
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    let app = NSApplication::sharedApplication(mtm);
    app.finishLaunching();
    // SAFETY: window creation on the main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(260.0, 220.0), NSSize::new(400.0, 480.0)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: retained until closed below.
    unsafe { window.setReleasedWhenClosed(false) };
    let surface = platform::AppView::new(
        mtm,
        platform::AppOptions {
            size: (400, 480),
            ..Default::default()
        },
    );
    let root = surface.view();
    window.setContentView(Some(&root));
    surface.load(platform::App::Rust(platform::Root::of::<Page>()));
    window.makeKeyAndOrderFront(None);
    app.activate();

    let deadline = Instant::now() + Duration::from_secs(10);
    while view_by_id(&root, "plain").is_none_or(|v| v.frame().size.width <= 0.0) {
        assert!(Instant::now() < deadline, "inputs did not mount");
        pump_events(&app, 10);
    }

    // 1. Same-turn tap-to-click (0 ms) on an unfocused `<Input>` must:
    //    - dismiss the open Popover via PressOutside,
    //    - pulse `:active` opacity below 0.95 and return to 1.0,
    //    - select the text (`selectTextOnFocus`).
    assert!(POPOVER_OPEN.load(Ordering::SeqCst), "popover starts open");
    let tap_view = view_by_id(&root, "tap").unwrap();
    let tap_field = field_by_id(&root, "tap");
    let min_opacity = tap_same_turn(&window, &tap_view, 16.0, 16.0);
    assert!(
        !POPOVER_OPEN.load(Ordering::SeqCst),
        "tapping a hosted input outside an open popover must dismiss it"
    );
    assert!(
        min_opacity < 0.95,
        "same-turn tap on a hosted input must draw :active feedback (min={min_opacity})"
    );
    assert!(
        (tap_view.layer().unwrap().opacity() - 1.0).abs() < 0.01,
        "hosted input :active feedback must end cleanly"
    );
    let tap_editor = tap_field
        .currentEditor()
        .unwrap()
        .downcast::<NSTextView>()
        .unwrap();
    assert_eq!(
        tap_editor.selectedRange(),
        NSRange::new(0, 5),
        "same-turn tap-to-click on a selectTextOnFocus input should select 0..5"
    );

    // 2. Click padding beside text ("Hello" in a 240pt field -> right edge padding).
    let first_view = view_by_id(&root, "first").unwrap();
    let first_field = field_by_id(&root, "first");
    click_with_hold(&window, &first_view, 180.0, 16.0, 1);
    let first_editor = first_field
        .currentEditor()
        .unwrap()
        .downcast::<NSTextView>()
        .unwrap();
    assert_eq!(
        first_editor.selectedRange(),
        NSRange::new(0, 5),
        "padding click on a selectTextOnFocus input should select 0..5"
    );

    // 3. Click directly on text inside unfocused second field ("World").
    let second_view = view_by_id(&root, "second").unwrap();
    let second_field = field_by_id(&root, "second");
    click_with_hold(&window, &second_view, 16.0, 16.0, 1);
    let second_editor = second_field
        .currentEditor()
        .unwrap()
        .downcast::<NSTextView>()
        .unwrap();
    assert_eq!(
        second_editor.selectedRange(),
        NSRange::new(0, 5),
        "direct text click on a selectTextOnFocus input should select 0..5"
    );

    // 4. Second click while already focused collapses selection to caret normally.
    let focus_before = SECOND_FOCUS_COUNT.load(Ordering::SeqCst);
    click_with_hold(&window, &second_view, 180.0, 16.0, 1);
    let focus_after = SECOND_FOCUS_COUNT.load(Ordering::SeqCst);
    let after_second = second_field
        .currentEditor()
        .unwrap()
        .downcast::<NSTextView>()
        .unwrap()
        .selectedRange();
    assert_eq!(focus_before, focus_after, "onFocus must not re-fire");
    assert_eq!(
        after_second,
        NSRange::new(5, 0),
        "clicking inside already-focused field must move caret normally"
    );

    // 5. A click-and-drag on an unfocused input keeps the dragged range.
    let drag_view = view_by_id(&root, "drag").unwrap();
    let drag_field = field_by_id(&root, "drag");
    click_and_drag(&window, &drag_view, 8.0, 42.0, 16.0);
    let dragged_range = drag_field
        .currentEditor()
        .unwrap()
        .downcast::<NSTextView>()
        .unwrap()
        .selectedRange();
    assert!(
        dragged_range.length > 0 && dragged_range != NSRange::new(0, 10),
        "user click-and-drag selection must win over selectTextOnFocus, got {dragged_range:?}"
    );

    // 6. A double click on an unfocused input (click 1 focuses and selects
    //    all; click 2 selects the word "Hello") keeps the word 0..5.
    let words_view = view_by_id(&root, "words").unwrap();
    let words_field = field_by_id(&root, "words");
    {
        let point = words_view.convertPoint_toView(NSPoint::new(14.0, 16.0), None);
        let number = window.windowNumber();
        let ts = NSProcessInfo::processInfo().systemUptime();
        app.postEvent_atStart(
            &mouse_event(NSEventType::LeftMouseUp, point, number, ts + 0.001, 1),
            false,
        );
        window.sendEvent(&mouse_event(
            NSEventType::LeftMouseDown,
            point,
            number,
            ts,
            1,
        ));
        app.postEvent_atStart(
            &mouse_event(NSEventType::LeftMouseUp, point, number, ts + 0.003, 2),
            false,
        );
        window.sendEvent(&mouse_event(
            NSEventType::LeftMouseDown,
            point,
            number,
            ts + 0.002,
            2,
        ));
        pump_events(&app, 100);
    }
    let word_range = words_field
        .currentEditor()
        .unwrap()
        .downcast::<NSTextView>()
        .unwrap()
        .selectedRange();
    assert_eq!(
        word_range,
        NSRange::new(0, 5),
        "double-click word selection must win over selectTextOnFocus"
    );

    // 7. A click focusing a multiline input selects its text.
    let area_view = view_by_id(&root, "area").unwrap();
    let area_editor = area_by_id(&root, "area");
    click_with_hold(&window, &area_view, 180.0, 28.0, 1);
    assert_eq!(
        area_editor.selectedRange(),
        NSRange::new(0, 6),
        "multiline click on a selectTextOnFocus input should select 0..6"
    );

    // 8. `nsh_base::button()` (component touch responder calling `hold_pressed(None)`
    //    on `TouchPhase::End`) must still render `:active` on a same-turn 0 ms tap.
    let btn_view = view_by_id(&root, "base-btn").unwrap();
    {
        let point = btn_view.convertPoint_toView(NSPoint::new(40.0, 14.0), None);
        let number = window.windowNumber();
        let ts = NSProcessInfo::processInfo().systemUptime();
        window.sendEvent(&mouse_event(
            NSEventType::LeftMouseDown,
            point,
            number,
            ts,
            1,
        ));
        window.sendEvent(&mouse_event(
            NSEventType::LeftMouseUp,
            point,
            number,
            ts + 0.0001,
            1,
        ));
        let mut min_opacity = 1.0f32;
        let deadline = Instant::now() + Duration::from_millis(200);
        while Instant::now() < deadline {
            pump_events(&app, 2);
            min_opacity = min_opacity.min(btn_view.layer().unwrap().opacity());
        }
        assert!(
            min_opacity < 0.3,
            "nsh_base::button same-turn tap must pulse :active opacity, got {min_opacity}"
        );
    }

    // 9. Without `selectTextOnFocus`, a focusing click places the caret.
    let plain_view = view_by_id(&root, "plain").unwrap();
    let plain_field = field_by_id(&root, "plain");
    click_with_hold(&window, &plain_view, 180.0, 16.0, 1);
    let plain_range = plain_field
        .currentEditor()
        .unwrap()
        .downcast::<NSTextView>()
        .unwrap()
        .selectedRange();
    assert_eq!(
        plain_range.length, 0,
        "a click on an input without selectTextOnFocus must place the caret, got {plain_range:?}"
    );

    surface.stop();
    window.close();
    println!("focus_selection: all 9 focus/tap/drag/word/button selection checks passed");
}
