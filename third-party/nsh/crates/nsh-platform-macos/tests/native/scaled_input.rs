//! An input under a scaled view (#1675): AppKit places hosted views from
//! its own geometry, which does not see the layer transform above them, so
//! the field drew at the untransformed place (blank when that is off the
//! window) and clicks there missed. The pad is hosted directly above the
//! transformed view in its parent's container, with the box it shows and its
//! natural bounds, so its geometry carries the scale: the editor draws in
//! the box, a click lands where it shows, the caret goes to the character
//! under it, and a sibling stacked over the transformed view stays over the
//! pad and takes its presses.

use std::{
    cell::RefCell,
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

use nsh_base::input;
use nsh_core::{geometry::px, prelude::*};
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSEvent, NSEventModifierFlags,
        NSEventType, NSTextField, NSTextView, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSSize, NSString},
};

/// The window's content, 400 × 300 points.
const VIEWPORT: (f64, f64) = (400.0, 300.0);

/// The scale of the view around the input.
const SCALE: f64 = 2.0;

/// The input's box in the scaled view's space: (x, y, width, height).
const FIELD: (f32, f32, f32, f32) = (60.0, 50.0, 150.0, 30.0);

/// A view stacked over the middle of the field's box on screen (inside the
/// window, so a press there reaches it).
const COVER: (f32, f32, f32, f32) = (200.0, 120.0, 100.0, 60.0);

/// Presses of the view covering the field's right half.
static COVER_PRESSES: AtomicUsize = AtomicUsize::new(0);

/// Changes zoom and scroll while the cell editor keeps focus.
static CLIPPED_STEP: AtomicUsize = AtomicUsize::new(0);

/// A field at [`FIELD`] under a view scaled [`SCALE`] times about its top
/// left corner, with a view stacked over its right half.
#[component]
fn Page() -> impl IntoElement {
    view()
        .size_full()
        .child(
            view()
                .absolute()
                .left(px(20.0))
                .top(px(20.0))
                .w(px(180.0))
                .h(px(60.0))
                .origin_top_left()
                .scale(SCALE as f32)
                .test_id("scaled")
                .child(
                    input()
                        .absolute()
                        .left(px(FIELD.0))
                        .top(px(FIELD.1))
                        .w(px(FIELD.2))
                        .h(px(FIELD.3))
                        .test_id("field")
                        .default_value("Hello world"),
                ),
        )
        .child(
            view()
                .absolute()
                .left(px(COVER.0))
                .top(px(COVER.1))
                .w(px(COVER.2))
                .h(px(COVER.3))
                .test_id("cover")
                .on_press(|| {
                    COVER_PRESSES.fetch_add(1, Ordering::SeqCst);
                }),
        )
}

/// A scrolling viewport between a downscaled pane and its cell editor.
#[component]
fn ClippedPage() -> impl IntoElement {
    let scale = signal(0.6);
    let viewport = element_ref();
    set_interval(Duration::from_millis(5), move || {
        match CLIPPED_STEP.swap(0, Ordering::SeqCst) {
            1 => scale.set(1.0),
            2 => scale.set(1.4),
            3 => viewport.scroll_to(Point::new(px(0.0), px(70.0)), false),
            4 => viewport.scroll_to(Point::new(px(0.0), px(150.0)), false),
            5 => viewport.scroll_to(Point::new(px(0.0), px(0.0)), false),
            _ => {}
        }
    });
    view().size_full().child(
        view()
            .absolute()
            .left(px(40.0))
            .top(px(30.0))
            .w(px(500.0))
            .h(px(400.0))
            .origin_top_left()
            .style_with(move |s| s.scale(scale.get()))
            .child(
                scroll()
                    .element_ref(&viewport)
                    .w(px(240.0))
                    .h(px(100.0))
                    .rounded(px(16.0))
                    .child(
                        view().w(px(180.0)).h(px(300.0)).overflow_hidden().child(
                            input()
                                .absolute()
                                .left(px(0.0))
                                .top(px(70.0))
                                .w(px(200.0))
                                .h(px(60.0))
                                .test_id("clipped-field")
                                .default_value("Clipped editor"),
                        ),
                    ),
            ),
    )
}

/// The first view under `view` (itself included) that `matches`.
fn find(view: &NSView, matches: &dyn Fn(&NSView) -> bool) -> Option<Retained<NSView>> {
    if matches(view) {
        return Some(view.retain());
    }
    view.subviews().iter().find_map(|c| find(&c, matches))
}

/// The view whose accessibility identifier is `id`.
fn view_with_id(view: &NSView, id: &str) -> Option<Retained<NSView>> {
    find(view, &|v| {
        v.accessibilityIdentifier()
            .is_some_and(|value| value.to_string() == id)
    })
}

/// The field editing the input (its placeholder is hidden, and NSH draws
/// every other text itself, so a shown `NSTextField` is the editor).
fn editor(root: &NSView) -> Option<Retained<NSTextField>> {
    find(root, &|v| {
        v.downcast_ref::<NSTextField>().is_some() && !v.isHiddenOrHasHiddenAncestor()
    })
    .map(|v| v.downcast::<NSTextField>().unwrap())
}

/// The pad the editor is in: the field's superview.
fn pad(editor: &NSTextField) -> Option<Retained<NSView>> {
    // SAFETY: AppKit's getter on the main thread.
    unsafe { editor.superview() }
}

/// Where `view` is drawn in the window's content, through the layer tree
/// (AppKit's own conversions do not see layer transforms).
fn drawn(window: &NSWindow, view: &NSView) -> NSRect {
    let content = window.contentView().unwrap();
    let layer = view.layer().expect("a layer-backed view");
    let mut outer = view.retain();
    // SAFETY: AppKit's getter on the main thread.
    let mut parent = unsafe { view.superview() };
    while let Some(view) = parent {
        // SAFETY: AppKit's getter on the main thread.
        parent = unsafe { view.superview() };
        if view.layer().is_some() {
            outer = view;
        }
    }
    let bounds = layer.convertRect_toLayer(view.bounds(), outer.layer().as_deref());
    let r = outer.convertRect_toView(bounds, None);
    let r = content.convertRect_fromView(r, None);
    if content.isFlipped() {
        r
    } else {
        let h = content.frame().size.height;
        NSRect::new(
            NSPoint::new(r.origin.x, h - r.origin.y - r.size.height),
            r.size,
        )
    }
}

/// Runs the app's events for `ms`.
fn pump(ms: u64) {
    let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
    let deadline = Instant::now() + Duration::from_millis(ms);
    // SAFETY: AppKit's immutable default run-loop mode.
    let mode = unsafe { objc2_foundation::NSDefaultRunLoopMode };
    while Instant::now() < deadline {
        if let Some(e) = app.nextEventMatchingMask_untilDate_inMode_dequeue(
            objc2_app_kit::NSEventMask::Any,
            Some(&NSDate::dateWithTimeIntervalSinceNow(0.005)),
            mode,
            true,
        ) {
            app.sendEvent(&e);
        }
        app.updateWindows();
    }
}

/// Runs the app until `done` holds, for at most five seconds.
fn until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "{what} never happened");
        pump(10);
    }
}

/// A point of the window's content (from its top left) in window
/// coordinates.
fn to_window(window: &NSWindow, x: f64, y: f64) -> NSPoint {
    NSPoint::new(x, window.contentView().unwrap().frame().size.height - y)
}

/// A left click at `(x, y)` of the window's content.
fn click(window: &NSWindow, x: f64, y: f64) {
    let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
    let at = to_window(window, x, y);
    let now = objc2_foundation::NSProcessInfo::processInfo().systemUptime();
    let event = |kind, t| {
        NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            kind, at, NSEventModifierFlags::empty(), t, window.windowNumber(), None, 0, 1, 1.0,
        )
        .unwrap()
    };
    // A field tracks the press until it sees the release, inside
    // `sendEvent`, so the release must already be queued. The press goes to
    // the window itself: the checks run from a terminal, which keeps the
    // key, and an app-level first click would only activate it.
    app.postEvent_atStart(&event(NSEventType::LeftMouseUp, now + 0.05), false);
    window.sendEvent(&event(NSEventType::LeftMouseDown, now));
    pump(120);
}

/// Types `text` into the field that has the focus, as the keyboard does.
fn type_text(window: &NSWindow, text: &str) {
    let responder = window.firstResponder().expect("a focused editor");
    let text = NSString::from_str(text);
    // SAFETY: `NSTextInputClient`'s insertion on the field editor, on the
    // main thread.
    let _: () = unsafe {
        objc2::msg_send![
            &*responder,
            insertText: &*text,
            replacementRange: objc2_foundation::NSRange::new(isize::MAX as usize, 0)
        ]
    };
    pump(50);
}

fn near(a: f64, b: f64, what: &str) {
    assert!((a - b).abs() < 0.6, "{what}: {a} is not {b}");
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().expect("the checks run on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.finishLaunching();
    // SAFETY: The window is created on the process main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(
                NSPoint::new(200.0, 200.0),
                NSSize::new(VIEWPORT.0, VIEWPORT.1),
            ),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Closable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(&NSString::from_str("NSH scaled input regression"));
    let options = platform::AppOptions {
        size: (VIEWPORT.0 as i32, VIEWPORT.1 as i32),
        ..Default::default()
    };
    let surface: std::rc::Rc<platform::AppView> = platform::AppView::new(mtm, options);
    window.setContentView(Some(&surface.view()));
    surface.load(platform::App::Rust(platform::Root::of::<Page>()));
    window.makeKeyAndOrderFront(None);
    app.activate();
    let root = surface.view();
    let failures = RefCell::new(Vec::new());
    let fail = |what: String| failures.borrow_mut().push(what);

    until("the field", || editor(&root).is_some());
    let field = editor(&root).expect("the editor");
    let pad = pad(&field).expect("the pad");
    let input = view_with_id(&root, "field").expect("the input view");

    // The pad carries the scale in its geometry, with the input view's
    // space as its bounds, so AppKit draws the text at the scale it shows
    // at and converts presses at that scale.
    let frame = pad.frame().size;
    let bounds = pad.bounds().size;
    if (frame.width - bounds.width * SCALE).abs() > 0.6
        || (frame.height - bounds.height * SCALE).abs() > 0.6
    {
        fail(format!(
            "the pad's frame {frame:?} is not {SCALE} times its bounds {bounds:?}"
        ));
    }
    if pad.isDescendantOf(&input) {
        fail("the pad is still inside the input view".into());
    }

    // The pad rides directly above the transformed view in its parent's
    // container, so a sibling stacked over that view stays over the pad.
    let scaled = view_with_id(&root, "scaled").expect("the scaled view");
    let cover = view_with_id(&root, "cover").expect("the cover");
    // SAFETY: AppKit's getters, on the main thread.
    let holder = unsafe { scaled.superview() }.expect("the scaled view's container");
    let pad_holder = unsafe { pad.superview() };
    let subs: Vec<_> = holder.subviews().iter().collect();
    let index = subs.iter().position(|v| std::ptr::eq(&**v, &*pad));
    let below = index
        .and_then(|i| i.checked_sub(1))
        .and_then(|i| subs.get(i));
    let above = index.and_then(|i| {
        subs.iter()
            .position(|v| std::ptr::eq(&**v, &*cover))
            .map(|c| c > i)
    });
    if !pad_holder.is_some_and(|s| std::ptr::eq(&*s, &*holder))
        || !below.is_some_and(|v| std::ptr::eq(&**v, &*scaled))
        || above != Some(true)
    {
        fail("the pad is not stacked directly above the scaled view, under the cover".into());
    }

    // It draws where the input view does, its text inside the box.
    let box_rect = drawn(&window, &input);
    let editor_rect = drawn(&window, &field);
    let inside = editor_rect.origin.x >= box_rect.origin.x - 4.0
        && editor_rect.origin.y >= box_rect.origin.y - 1.0
        && editor_rect.origin.x + editor_rect.size.width
            <= box_rect.origin.x + box_rect.size.width + 4.0
        && editor_rect.origin.y + editor_rect.size.height
            <= box_rect.origin.y + box_rect.size.height + 1.0;
    if !inside {
        fail(format!(
            "the editor {editor_rect:?} does not draw in the box {box_rect:?}"
        ));
    }
    near(
        box_rect.origin.x,
        20.0 + FIELD.0 as f64 * SCALE,
        "the box drawn at x",
    );
    near(
        box_rect.origin.y,
        20.0 + FIELD.1 as f64 * SCALE,
        "the box drawn at y",
    );
    near(
        box_rect.size.width,
        FIELD.2 as f64 * SCALE,
        "the box drawn width",
    );

    // A click at the drawn left edge puts the caret before the text; at
    // the middle, in it; at the right edge, after it. The untransformed
    // geometry put all of them beside the field.
    let caret = |field: &NSTextField| {
        field
            .currentEditor()
            .map(|e| {
                let range = e.selectedRange();
                if range.length == 0 {
                    range.location
                } else {
                    usize::MAX
                }
            })
            .unwrap_or(usize::MAX)
    };
    // A press in the box's padding, above the editor: the pad sends it to
    // the editor at the clicked x, as a press on an input's padding does.
    let padding = box_rect.origin.y + 4.0;
    click(&window, box_rect.origin.x + 3.0, padding);
    until("the field's focus", || field.currentEditor().is_some());
    let start = caret(&field);
    if start != 0 {
        fail(format!(
            "a click at the box's left put the caret at {start}"
        ));
    }
    type_text(&window, "X");
    pump(80);
    if field.stringValue().to_string() != "XHello world" {
        fail(format!(
            "typing at the caret gave `{}`",
            field.stringValue()
        ));
    }

    // A press elsewhere in the drawn box reaches the editor at the text
    // position drawn there: AppKit maps the window point through the pad's
    // scaled geometry, so the insertion index follows the scaled box. (The
    // window's field editor only moves its caret for presses while the test
    // app, started from a terminal, has the key; this asks the same text
    // view where a press would put it.)
    let editor = field
        .currentEditor()
        .and_then(|e| e.downcast::<NSTextView>().ok())
        .expect("the focused editor");
    let middle_y = box_rect.origin.y + box_rect.size.height / 2.0;
    let insertion = |x: f64| {
        let at = to_window(&window, x, middle_y);
        let local = editor.convertPoint_fromView(at, None);
        editor.characterIndexForInsertionAtPoint(local)
    };
    let end = insertion(box_rect.origin.x + box_rect.size.width - 3.0);
    if end != "XHello world".len() {
        fail(format!(
            "a press at the box's right maps to {end}, not {}",
            "XHello world".len()
        ));
    }
    let middle = insertion(box_rect.origin.x + 80.0);
    if !(3..="XHello world".len() - 2).contains(&middle) {
        fail(format!("a press in the text maps to {middle}, not in it"));
    }

    // A sibling stacked over the scaled view takes the press where it shows:
    // the pad under it must not swallow it (it used to sit above every
    // sibling, on the host view itself).
    let before = COVER_PRESSES.load(Ordering::SeqCst);
    click(
        &window,
        (COVER.0 + COVER.2 / 2.0) as f64,
        (COVER.1 + COVER.3 / 2.0) as f64,
    );
    pump(150);
    let pressed = COVER_PRESSES.load(Ordering::SeqCst);
    if pressed != before + 1 {
        fail(format!(
            "a press under the cover reached the pad (cover presses {before} to {pressed})"
        ));
    }

    surface.load(platform::App::Rust(platform::Root::of::<ClippedPage>()));
    until("the clipped field", || {
        view_with_id(&root, "clipped-field").is_some()
    });
    pump(100);
    let field = self::editor(&root).expect("the clipped editor");
    let input = view_with_id(&root, "clipped-field").unwrap();
    let box_rect = drawn(&window, &input);
    let native_rect = field.convertRect_toView(field.bounds(), None);
    near(
        native_rect.size.width,
        (200.0 + 4.0) * 0.6,
        "clipped native width",
    );
    click(&window, box_rect.origin.x + 2.0, box_rect.origin.y + 3.0);
    until("the clipped editor's focus", || {
        field.currentEditor().is_some()
    });
    type_text(&window, "X");
    assert_eq!(field.stringValue().to_string(), "XClipped editor");

    let pad = self::pad(&field).unwrap();
    let hits_pad = |x, y| {
        let p = root.convertPoint_fromView(to_window(&window, x, y), None);
        root.hitTest(p).is_some_and(|hit| hit.isDescendantOf(&pad))
    };
    for (step, scale) in [(0, 0.6), (1, 1.0), (2, 1.4)] {
        CLIPPED_STEP.store(step, Ordering::SeqCst);
        pump(150);
        near(
            field.convertRect_toView(field.bounds(), None).size.width,
            204.0 * scale,
            "native width after zoom",
        );
        near(
            field.convertRect_toView(field.bounds(), None).origin.x,
            40.0 - 2.0 * scale,
            "native position after zoom",
        );
        // AppKit insets the accessible frame from the field's native edge.
        // It must still have the drawn field's center and scale.
        let accessible = field.accessibilityFrame();
        let native = window.convertRectToScreen(field.convertRect_toView(field.bounds(), None));
        near(
            accessible.origin.x + accessible.size.width / 2.0,
            native.origin.x + native.size.width / 2.0,
            "accessible center after zoom",
        );
        assert!((accessible.size.width - 204.0 * scale).abs() < 4.0);
        assert!(field.currentEditor().is_some(), "zoom lost the edit");
        assert!(hits_pad(40.0 + 30.0 * scale, 30.0 + 80.0 * scale));
        assert!(
            !hits_pad(40.0 + 190.0 * scale, 30.0 + 80.0 * scale),
            "nested clip leaked a hit"
        );
        assert!(
            !hits_pad(40.0 + 30.0 * scale, 30.0 + 110.0 * scale),
            "viewport clip leaked a hit"
        );
    }
    CLIPPED_STEP.store(3, Ordering::SeqCst);
    pump(200);
    near(drawn(&window, &input).origin.y, 30.0, "scrolled editor y");
    assert!(hits_pad(40.0 + 30.0 * 1.4, 30.0 + 10.0 * 1.4));
    assert!(
        !hits_pad(40.0 + 1.4, 30.0 + 1.4),
        "rounded viewport corner leaked a hit"
    );
    CLIPPED_STEP.store(4, Ordering::SeqCst);
    pump(200);
    assert!(!hits_pad(60.0, 40.0), "fully clipped editor leaked a hit");
    CLIPPED_STEP.store(5, Ordering::SeqCst);
    pump(200);
    assert!(field.currentEditor().is_some(), "scrolling lost the edit");
    type_text(&window, "Y");
    assert_eq!(field.stringValue().to_string(), "XYClipped editor");

    surface.stop();
    window.close();
    let failures = failures.into_inner();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    println!("scaled_input: the field under a scaled view draws and edits where it shows");
    println!(
        "scaled_input: nested and rounded clips, scrolling, focus and accessibility checked at 0.6, 1.0 and 1.4"
    );
}
