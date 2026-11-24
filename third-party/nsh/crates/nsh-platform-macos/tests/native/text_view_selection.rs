//! Real AppKit drag-selection and copy checks for a `selectable` `TextView`:
//! - dragging past the bottom/end of a multi-block list item (paragraph +
//!   blockquote) selects only the blockquote and never highlights or copies
//!   the top-left `•` marker;
//! - dragging across list items omits bullets and keeps `selectedText` in
//!   Markdown structured;
//! - dragging past the bottom of a code block with floating text actions
//!   never selects the floating action label.

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use nsh_base::{
    TextSelectionFormat, TextSelectionOptions, TextView, TextViewApi, TextViewCodeAction,
    TextViewSelectionEvent, text_view,
};
use nsh_core::prelude::*;
use nsh_platform_macos as platform;
use platform::{
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSEvent, NSEventMask,
        NSEventModifierFlags, NSEventType, NSPasteboard, NSPasteboardTypeString, NSView, NSWindow,
        NSWindowStyleMask,
    },
    objc2_foundation::{
        NSDate, NSDefaultRunLoopMode, NSPoint, NSProcessInfo, NSRect, NSSize, NSString,
    },
};

const DOC: &str = "\
- **不想辩论、礼貌结束话题版：**

  > “每个人对安全感的定义不一样，你觉得岗位不动才稳，我觉得自己一直在涨本事才稳。”
- 第二条

```rs
let answer = 42;
```
";

const QUOTE_NEEDLE: &str = "安全感";

static SELECTED: Mutex<String> = Mutex::new(String::new());
static MARKDOWN: Mutex<String> = Mutex::new(String::new());

#[component]
fn Page() -> impl IntoElement {
    let doc_ref = component_ref::<TextView>();
    view().flex_1().p(px(20.0)).child(
        text_view()
            .component_ref(&doc_ref)
            .test_id("doc")
            .selectable(true)
            .markdown(DOC)
            .code_block_actions(vec![
                TextViewCodeAction::new("copy").with_label("Copy"),
                TextViewCodeAction::new("run").with_label("RunAction"),
            ])
            .on_selection_change(move |e: &TextViewSelectionEvent| {
                *SELECTED.lock().unwrap() = e.text.to_string();
                let md = doc_ref
                    .api::<TextViewApi>()
                    .map(|r| {
                        r.selected_text(Some(TextSelectionOptions::format(
                            TextSelectionFormat::Markdown,
                        )))
                    })
                    .unwrap_or_default();
                *MARKDOWN.lock().unwrap() = md;
            }),
    )
}

fn ax_value_string(view: &NSView) -> Option<String> {
    let value = view.accessibilityValue()?;
    value.downcast::<NSString>().ok().map(|s| s.to_string())
}

fn find_all(view: &NSView, matches: &dyn Fn(&NSView) -> bool, out: &mut Vec<Retained<NSView>>) {
    if matches(view) {
        out.push(view.retain());
    }
    for child in view.subviews().iter() {
        find_all(&child, matches, out);
    }
}

fn find_text_view(root: &NSView, needle: &str) -> Option<Retained<NSView>> {
    let mut found = Vec::new();
    find_all(
        root,
        &|v| ax_value_string(v).is_some_and(|s| s.contains(needle)),
        &mut found,
    );
    found.into_iter().next()
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

fn drag_window_points(window: &NSWindow, app: &NSApplication, start: NSPoint, end: NSPoint) {
    let number = window.windowNumber();
    let ts = NSProcessInfo::processInfo().systemUptime();
    window.sendEvent(&mouse_event(
        NSEventType::LeftMouseDown,
        start,
        number,
        ts,
        1,
    ));
    let steps = 8;
    for step in 1..=steps {
        let t = f64::from(step) / f64::from(steps);
        let p = NSPoint::new(
            start.x + (end.x - start.x) * t,
            start.y + (end.y - start.y) * t,
        );
        window.sendEvent(&mouse_event(
            NSEventType::LeftMouseDragged,
            p,
            number,
            ts + 0.005 * f64::from(step),
            1,
        ));
    }
    window.sendEvent(&mouse_event(
        NSEventType::LeftMouseUp,
        end,
        number,
        ts + 0.05,
        1,
    ));
    pump_events(app, 80);
}

fn send_cmd_c(window: &NSWindow, app: &NSApplication) {
    let ts = NSProcessInfo::processInfo().systemUptime();
    let c = NSString::from_str("c");
    let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
        NSEventType::KeyDown,
        NSPoint::ZERO,
        NSEventModifierFlags::Command,
        ts,
        window.windowNumber(),
        None,
        &c,
        &c,
        false,
        8, // kVK_ANSI_C
    )
    .unwrap();
    window.sendEvent(&event);
    pump_events(app, 60);
}

pub(super) fn run() {
    *SELECTED.lock().unwrap() = String::new();
    *MARKDOWN.lock().unwrap() = String::new();

    let mtm = MainThreadMarker::new().unwrap();
    let app = NSApplication::sharedApplication(mtm);
    app.finishLaunching();
    // SAFETY: window creation on the main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(260.0, 220.0), NSSize::new(460.0, 420.0)),
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
            size: (460, 420),
            ..Default::default()
        },
    );
    let root = surface.view();
    window.setContentView(Some(&root));
    surface.load(platform::App::Rust(platform::Root::of::<Page>()));
    window.makeKeyAndOrderFront(None);
    app.activate();

    let deadline = Instant::now() + Duration::from_secs(10);
    while find_text_view(&root, "let answer = 42;").is_none() {
        assert!(Instant::now() < deadline, "TextView did not mount");
        pump_events(&app, 10);
    }

    let quote_view = find_text_view(&root, QUOTE_NEEDLE).expect("blockquote text view");
    let second_view = find_text_view(&root, "第二条").expect("second list item view");
    let code_view = find_text_view(&root, "let answer = 42;").expect("code block view");

    // 1. Exact repro: drag from inside the blockquote slightly past its right
    //    and bottom edge. The top-left `•` must never be selected or copied.
    let q_bounds = quote_view.bounds();
    let start = quote_view.convertPoint_toView(
        NSPoint::new(q_bounds.size.width * 0.25, q_bounds.size.height * 0.5),
        None,
    );
    let end = quote_view.convertPoint_toView(
        NSPoint::new(q_bounds.size.width + 20.0, q_bounds.size.height + 10.0),
        None,
    );
    drag_window_points(&window, &app, start, end);

    let sel = SELECTED.lock().unwrap().clone();
    let md = MARKDOWN.lock().unwrap().clone();
    assert!(!sel.is_empty(), "expected non-empty blockquote selection");
    assert!(
        !sel.contains('•'),
        "overshoot drag leaked list marker into selection: {sel:?}"
    );
    assert!(
        md.starts_with("- > ") || md.starts_with("> "),
        "selectedText(markdown) lost quote structure: {md:?}"
    );

    // Verify no bullet marker NSView reports an AX selected text range.
    let mut bullets = Vec::new();
    find_all(
        &root,
        &|v| ax_value_string(v).as_deref() == Some("•"),
        &mut bullets,
    );
    assert!(!bullets.is_empty(), "expected list bullet views");
    for bullet in &bullets {
        assert!(
            bullet
                .accessibilitySelectedText()
                .is_none_or(|s| s.is_empty()),
            "bullet marker view must not carry a selection"
        );
    }

    // Verify Cmd+C writes clean text without `•` to the system pasteboard.
    // The pasteboard is the developer's own: its text is put back right
    // after the copy is read.
    let pasteboard = NSPasteboard::generalPasteboard();
    // SAFETY: immutable AppKit pasteboard type constant.
    let string_type = unsafe { NSPasteboardTypeString };
    let saved = pasteboard.stringForType(string_type);
    pasteboard.clearContents();
    send_cmd_c(&window, &app);
    let copied = pasteboard
        .stringForType(string_type)
        .map(|s| s.to_string())
        .unwrap_or_default();
    pasteboard.clearContents();
    if let Some(saved) = saved {
        pasteboard.setString_forType(&saved, string_type);
    }
    assert_eq!(copied, sel, "Cmd+C must match clean selection without •");

    // 2. Drag from the blockquote down into the second list item: omits `•`
    //    and preserves Markdown list structure in `selectedText`.
    let s_bounds = second_view.bounds();
    let end_second = second_view.convertPoint_toView(
        NSPoint::new(s_bounds.size.width * 0.8, s_bounds.size.height * 0.5),
        None,
    );
    drag_window_points(&window, &app, start, end_second);
    let across = SELECTED.lock().unwrap().clone();
    let across_md = MARKDOWN.lock().unwrap().clone();
    assert!(
        across.contains("第二") && !across.contains('•') && !across.contains('\t'),
        "drag across list items leaked marker or tab: {across:?}"
    );
    assert!(
        across_md.contains("\n- 第二"),
        "selectedText(markdown) across items should keep list syntax: {across_md:?}"
    );

    // 3. Drag inside the code block past its bottom/right edge: floating
    //    `RunAction` button in `codeBlockHeader` must never be selected.
    let c_bounds = code_view.bounds();
    let c_start = code_view.convertPoint_toView(
        NSPoint::new(c_bounds.size.width * 0.1, c_bounds.size.height * 0.5),
        None,
    );
    let c_end = code_view.convertPoint_toView(
        NSPoint::new(c_bounds.size.width + 20.0, c_bounds.size.height + 12.0),
        None,
    );
    drag_window_points(&window, &app, c_start, c_end);
    let code_sel = SELECTED.lock().unwrap().clone();
    assert!(
        code_sel.contains("answer") && !code_sel.contains("RunAction"),
        "code block overshoot drag leaked floating action label: {code_sel:?}"
    );

    surface.stop();
    window.close();
    println!("text_view_selection: all macOS AppKit list/quote/code selection checks passed");
}
