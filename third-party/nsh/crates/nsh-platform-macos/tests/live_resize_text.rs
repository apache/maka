//! A text made while a window is in a live resize draws once it is placed.
//! During a live resize the mounter holds back the frames of plain and text
//! views (`unplaced`), so a text that the resize itself brings in (a
//! responsive layout crossing its breakpoint) gets its content while its box
//! is still empty. In an app `<Window>`, nothing above its root clips it, so
//! the empty text counts as shown and is drawn at once, which draws nothing
//! (an empty box has no layer): it must draw when its frame is placed. AppKit
//! views live on the main thread, so this test runs without libtest's
//! harness, on the process's own.

#[cfg(target_os = "macos")]
fn main() {
    macos::run();
}

#[cfg(not(target_os = "macos"))]
fn main() {}

#[cfg(target_os = "macos")]
mod macos {
    use std::time::{Duration, Instant};

    use nsh_core::{
        element::{Root, desktop},
        prelude::*,
    };
    use nsh_platform_macos::{
        AppOptions, AppView,
        objc2::{MainThreadMarker, Message, msg_send, rc::Retained},
        objc2_app_kit::{NSAccessibility, NSApplication, NSGraphicsContext, NSView, NSWindow},
        objc2_foundation::{NSDate, NSRunLoop, NSSize},
    };

    /// The title the test finds its window by.
    const TITLE: &str = "NSH live resize text";

    /// The width the layout switches at.
    const BREAKPOINT: f32 = 350.0;

    /// A window whose layout adds a text below [`BREAKPOINT`], as a
    /// responsive app does: it is made when the window's width crosses it.
    /// Nothing is removed at the same time, so the text gets a new native
    /// view of its own (an empty box until it is placed), not the one of a
    /// view going away.
    #[component]
    fn Responsive() -> impl IntoElement {
        desktop::window()
            .id("main")
            .title(TITLE)
            .default_size(size(px(400.0), px(300.0)))
            .content(|| {
                let narrow = computed(|| window().width.0 < BREAKPOINT);
                view()
                    .flex_1()
                    .child(view().test_id("wide").child(text("Wide")))
                    .child(when(
                        move || narrow.get(),
                        || view().test_id("narrow").child(text("Narrow")),
                    ))
            })
    }

    fn until(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !done() {
            assert!(Instant::now() < deadline, "{what} never happened");
            let soon = NSDate::dateWithTimeIntervalSinceNow(0.02);
            NSRunLoop::currentRunLoop().runUntilDate(&soon);
        }
    }

    /// The view with accessibility identifier `id` under `view`.
    fn find(view: &NSView, id: &str) -> Option<Retained<NSView>> {
        if view
            .accessibilityIdentifier()
            .is_some_and(|i| i.to_string() == id)
        {
            return Some(view.retain());
        }
        view.subviews().iter().find_map(|c| find(&c, id))
    }

    /// Whether anything was drawn in `view`: its layer tree's contents,
    /// rendered into a bitmap as they are (nothing is drawn for it).
    fn drawn(view: &NSView) -> bool {
        let bounds = view.bounds();
        if bounds.size.width <= 0.0 || bounds.size.height <= 0.0 {
            return false;
        }
        let rep = view
            .bitmapImageRepForCachingDisplayInRect(bounds)
            .expect("a bitmap");
        let cx = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep).expect("a context");
        let layer = view.layer().expect("a layer-backed view");
        layer.renderInContext(&cx.CGContext());
        cx.flushGraphics();
        let len = (rep.bytesPerRow() * rep.pixelsHigh()) as usize;
        // SAFETY: the rep's own buffer, `len` bytes, alive with `rep`.
        unsafe { std::slice::from_raw_parts(rep.bitmapData(), len) }
            .iter()
            .any(|&b| b != 0)
    }

    /// Tells `view` and every view under it that a live resize starts or
    /// ends, as AppKit does for a window's whole hierarchy when the user
    /// drags its edge.
    fn live_resize(view: &NSView, start: bool) {
        // SAFETY: NSView's own live resize notifications, no arguments.
        unsafe {
            if start {
                let _: () = msg_send![view, viewWillStartLiveResize];
            } else {
                let _: () = msg_send![view, viewDidEndLiveResize];
            }
        }
        for child in view.subviews().iter() {
            live_resize(&child, start);
        }
    }

    /// The window is dragged narrower than the breakpoint: the narrow text
    /// is made during the drag, and draws once the drag places it.
    fn drag_across_breakpoint(mtm: MainThreadMarker) {
        let host = AppView::new(mtm, AppOptions::default());
        host.load(Root::of::<Responsive>().into());
        let app = NSApplication::sharedApplication(mtm);
        let shown = || -> Option<Retained<NSWindow>> {
            app.windows()
                .iter()
                .find(|w| w.title().to_string() == TITLE && w.isVisible())
        };
        until("the window's showing", || shown().is_some());
        let window = shown().expect("the window");
        let content = window.contentView().expect("the window's content");
        until("the wide text's mount", || find(&content, "wide").is_some());
        let wide = find(&content, "wide").expect("the wide text");
        until("the wide text's drawing", || drawn(&wide));

        // What AppKit tells the window's views when the user starts
        // dragging its edge, and when they let go.
        live_resize(&content, true);
        window.setContentSize(NSSize::new(300.0, 300.0));
        until("the narrow text's mount", || {
            find(&content, "narrow").is_some()
        });
        let narrow = find(&content, "narrow").expect("the narrow text");
        live_resize(&content, false);
        until("the narrow text's drawing", || drawn(&narrow));

        host.stop();
        window.close();
        println!("live_resize_text: drag: ok");
    }

    pub(super) fn run() {
        let mtm = MainThreadMarker::new().expect("the main thread");
        NSApplication::sharedApplication(mtm).finishLaunching();
        drag_across_breakpoint(mtm);
    }
}
