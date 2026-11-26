//! What an `AppView` draws once it can be seen: text mounted or changed
//! while it could not (out of any window, or hidden) is put off, and drawn
//! when it enters a window or shows again, with nothing else to come (no
//! batch, input or animation). A host app makes the view and puts it in a
//! window itself; an app hides a view of its own with `visibility: hidden`.
//! AppKit views live on the main thread, so this test runs without
//! libtest's harness, on the process's own. Its arguments pick the cases to
//! run (`window`, `unhide`, `invisible`, `scaled`, `animated`, `sharp`,
//! `nested`, `canvas`); none runs all.

#[cfg(target_os = "macos")]
fn main() {
    macos::run();
}

#[cfg(not(target_os = "macos"))]
fn main() {}

#[cfg(target_os = "macos")]
mod macos {
    use std::{
        sync::atomic::{AtomicBool, AtomicU8, Ordering},
        time::{Duration, Instant},
    };

    use nsh_core::{element::Root, prelude::*};
    use nsh_platform_macos::{
        AppOptions, AppView,
        objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained, runtime::AnyObject},
        objc2_app_kit::{
            NSAccessibility, NSApplication, NSBackingStoreType, NSGraphicsContext, NSView,
            NSWindow, NSWindowStyleMask,
        },
        objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize, NSString},
    };

    /// The test sets it to change the text.
    static CHANGED: AtomicBool = AtomicBool::new(false);

    /// The test sets it to hide [`Hiding`]'s view, and clears it to show it.
    static INVISIBLE: AtomicBool = AtomicBool::new(false);

    /// Starts the native transform after the test checks deferred text.
    static REVEAL: AtomicBool = AtomicBool::new(false);

    /// Shrinks the scale of [`Sharpened`]'s ancestor after the test checks
    /// the content layer's resolution.
    static SHRINK: AtomicBool = AtomicBool::new(false);

    /// The scales [`NestedSharpened`]'s two ancestors take, in order.
    static NESTED: AtomicU8 = AtomicU8::new(0);

    /// A text, in a view the test finds.
    #[component]
    fn Label() -> impl IntoElement {
        view().test_id("label").child(text("Orders"))
    }

    /// A text the test changes.
    #[component]
    fn Changing() -> impl IntoElement {
        let changed = signal(false);
        set_interval(Duration::from_millis(20), move || {
            if CHANGED.load(Ordering::SeqCst) && !changed.get_untracked() {
                changed.set(true);
            }
        });
        view().test_id("label").child(text(
            move || if changed.get() { "Trades" } else { "Orders" },
        ))
    }

    /// A text the test changes, in a view the test hides with
    /// `visibility: hidden`, and the same text beside it, always shown:
    /// its drawing says when the change was mounted.
    #[component]
    fn Hiding() -> impl IntoElement {
        let (changed, invisible) = (signal(false), signal(false));
        set_interval(Duration::from_millis(20), move || {
            if CHANGED.load(Ordering::SeqCst) != changed.get_untracked() {
                changed.set(CHANGED.load(Ordering::SeqCst));
            }
            if INVISIBLE.load(Ordering::SeqCst) != invisible.get_untracked() {
                invisible.set(INVISIBLE.load(Ordering::SeqCst));
            }
        });
        let words = move || if changed.get() { "Trades" } else { "Orders" };
        view()
            .child(
                view()
                    .test_id("page")
                    .style_when(move || invisible.get(), |s| s.invisible())
                    .child(view().test_id("label").child(text(words))),
            )
            .child(view().test_id("beside").child(text(words)))
    }

    #[component]
    fn Scaled() -> impl IntoElement {
        view().flex_1().overflow_hidden().child(
            view()
                .w(px(500.0))
                .h(px(250.0))
                .origin_top_left()
                .scale(0.8)
                .children(
                    [
                        (20.0, "inside", "Inside"),
                        (420.0, "outside", "Outside"),
                        (520.0, "clipped", "Clipped"),
                    ]
                    .map(|(x, id, label)| {
                        nsh_base::button()
                            .absolute()
                            .left(px(x))
                            .top(px(40.0))
                            .w(px(80.0))
                            .h(px(24.0))
                            .bg(|| nsh_base::theme().primary)
                            .text_color(|| nsh_base::theme().primary_foreground)
                            .child(text(label).test_id(id))
                    }),
                ),
        )
    }

    #[component]
    fn Animated() -> impl IntoElement {
        let x = animated_value(0.0);
        let reveal = stored(Animation::timing(
            &x,
            -100.0,
            Timing::new(400.0, Easing::Linear),
        ));
        set_interval(Duration::from_millis(20), move || {
            if REVEAL.swap(false, Ordering::SeqCst) {
                reveal.with(|animation| animation.start());
            }
        });
        view()
            .flex_1()
            .overflow_hidden()
            .child(
                view()
                    .absolute()
                    .left(px(420.0))
                    .top(px(40.0))
                    .w(px(80.0))
                    .h(px(24.0))
                    .bind_translate_x(&x)
                    .child(text("Ancestor").test_id("ancestor")),
            )
            .child(
                text("Target")
                    .test_id("target")
                    .absolute()
                    .left(px(420.0))
                    .top(px(80.0))
                    .w(px(80.0))
                    .h(px(24.0))
                    .bind_translate_x(&x),
            )
            .child(
                text("Clipped")
                    .test_id("clipped")
                    .absolute()
                    .left(px(620.0))
                    .top(px(120.0))
                    .w(px(80.0))
                    .h(px(24.0))
                    .bind_translate_x(&x),
            )
    }

    /// A text inside an ancestor whose scale the test changes.
    #[component]
    fn Sharpened() -> impl IntoElement {
        let zoom = signal(2.0);
        set_interval(Duration::from_millis(20), move || {
            let next: f32 = if SHRINK.load(Ordering::SeqCst) {
                0.5
            } else {
                2.0
            };
            if zoom.get_untracked() != next {
                zoom.set(next);
            }
        });
        view().flex_1().overflow_hidden().child(
            view()
                .w(px(200.0))
                .h(px(120.0))
                .origin_top_left()
                .scale(move || zoom.get())
                .child(
                    text("Sharp")
                        .test_id("sharp")
                        .absolute()
                        .left(px(20.0))
                        .top(px(20.0))
                        .w(px(120.0))
                        .h(px(24.0)),
                ),
        )
    }

    /// A text under two scaled ancestors, each the test changes: the
    /// outer moves within one density step while the inner crosses one,
    /// and the inner moves after the outer shrank its subtree.
    #[component]
    fn NestedSharpened() -> impl IntoElement {
        let outer = signal(2.0);
        let inner = signal(2.0);
        set_interval(Duration::from_millis(20), move || {
            let (o, i): (f32, f32) = match NESTED.load(Ordering::SeqCst) {
                0 => (2.0, 2.0),
                1 => (1.0, 2.0),
                2 => (1.0, 4.6),
                _ => (1.09, 4.6),
            };
            if outer.get_untracked() != o {
                outer.set(o);
            }
            if inner.get_untracked() != i {
                inner.set(i);
            }
        });
        view().flex_1().overflow_hidden().child(
            view()
                .w(px(200.0))
                .h(px(120.0))
                .origin_top_left()
                .scale(move || outer.get())
                .child(
                    view()
                        .w(px(100.0))
                        .h(px(60.0))
                        .origin_top_left()
                        .scale(move || inner.get())
                        .child(
                            text("Nested")
                                .test_id("nested")
                                .absolute()
                                .left(px(20.0))
                                .top(px(20.0))
                                .w(px(120.0))
                                .h(px(24.0)),
                        ),
                ),
        )
    }

    /// Runs the main run loop until `done` holds, for at most 5 s.
    fn until(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !done() {
            assert!(Instant::now() < deadline, "{what} never happened");
            spin(0.02);
        }
    }

    /// Runs the main run loop for `seconds`.
    fn spin(seconds: f64) {
        let soon = NSDate::dateWithTimeIntervalSinceNow(seconds);
        NSRunLoop::currentRunLoop().runUntilDate(&soon);
    }

    /// The view with accessibility identifier `id` under `view`.
    fn find(view: &NSView, id: &str) -> Option<Retained<NSView>> {
        if view
            .accessibilityIdentifier()
            .is_some_and(|i| i.to_string() == id)
        {
            return Some(view.retain());
        }
        view.subviews()
            .iter()
            .find_map(|c| find(&c, id))
            // A layer-backed leaf is accessible without being a native subview.
            .or_else(|| ax_views(view).find_map(|child| find(&child, id)))
    }

    fn ax_views(view: &NSView) -> impl Iterator<Item = Retained<NSView>> {
        view.accessibilityChildren()
            .into_iter()
            .flat_map(|children| children.to_vec())
            .filter_map(|child| child.downcast::<NSView>().ok())
    }

    /// What clients read of the text in `view`: its value.
    fn value(view: &NSView) -> Option<String> {
        view.accessibilityValue()
            .and_then(|o: Retained<AnyObject>| o.downcast::<NSString>().ok())
            .map(|s| s.to_string())
            .or_else(|| ax_views(view).find_map(|child| value(&child)))
    }

    /// The pixels Core Animation holds for `view`: its layer tree's
    /// contents, rendered into a bitmap as they are (nothing is drawn
    /// for it). Transparent where nothing was drawn.
    fn picture(view: &NSView) -> Vec<u8> {
        let rep = view
            .bitmapImageRepForCachingDisplayInRect(view.bounds())
            .expect("a bitmap");
        let cx = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep).expect("a context");
        let layer = view.layer().expect("a layer-backed view");
        layer.renderInContext(&cx.CGContext());
        cx.flushGraphics();
        let len = (rep.bytesPerRow() * rep.pixelsHigh()) as usize;
        // SAFETY: the rep's own buffer, `len` bytes, alive with `rep`.
        unsafe { std::slice::from_raw_parts(rep.bitmapData(), len) }.to_vec()
    }

    /// Whether anything was drawn in `view`.
    fn drawn(view: &NSView) -> bool {
        picture(view).iter().any(|&b| b != 0)
    }

    /// The density of `view`'s content layer: the pixels it draws per
    /// point, which must follow a scaled ancestor.
    fn content_scale(view: &NSView) -> Option<f64> {
        let layer = view.layer()?;
        let sublayers = unsafe { layer.sublayers() }?;
        sublayers
            .iter()
            .filter(|layer| layer.delegate().is_some())
            .map(|layer| layer.contentsScale())
            .reduce(f64::max)
    }

    fn window(mtm: MainThreadMarker) -> Retained<NSWindow> {
        let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(400.0, 300.0));
        // SAFETY: a plain titled window, released by the test's end.
        let window = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(
                NSWindow::alloc(mtm),
                frame,
                NSWindowStyleMask::Titled,
                NSBackingStoreType::Buffered,
                false,
            )
        };
        unsafe { window.setReleasedWhenClosed(false) };
        window
    }

    fn app_view(mtm: MainThreadMarker) -> std::rc::Rc<AppView> {
        AppView::new(
            mtm,
            AppOptions {
                size: (400, 300),
                ..AppOptions::default()
            },
        )
    }

    /// The view is made and its app mounted out of any window, as a host
    /// app may; then it enters one.
    fn window_entry(mtm: MainThreadMarker) {
        let app = app_view(mtm);
        app.load(Root::of::<Label>().into());
        let root = app.view();
        until("the first mount", || {
            find(&root, "label").is_some_and(|l| value(&l).as_deref() == Some("Orders"))
        });
        let label = find(&root, "label").expect("the label");
        spin(0.2);
        assert!(!drawn(&label), "the text was drawn out of any window");

        let window = window(mtm);
        window.setContentView(Some(&root));
        window.orderFrontRegardless();
        until("the text's drawing", || drawn(&label));

        app.stop();
        window.close();
        println!("draw_on_show: window: ok");
    }

    /// The text changes while the view is hidden, as a host app hides a
    /// view scrolled out of sight; then it shows again.
    fn unhide(mtm: MainThreadMarker) {
        let window = window(mtm);
        let app = app_view(mtm);
        let root = app.view();
        window.setContentView(Some(&root));
        window.orderFrontRegardless();
        app.load(Root::of::<Changing>().into());
        until("the first mount", || {
            find(&root, "label").is_some_and(|l| value(&l).as_deref() == Some("Orders"))
        });
        let label = find(&root, "label").expect("the label");
        until("the first text's drawing", || drawn(&label));
        spin(0.2);
        let before = picture(&label);

        root.setHidden(true);
        CHANGED.store(true, Ordering::SeqCst);
        until("the change", || value(&label).as_deref() == Some("Trades"));
        spin(0.2);
        assert_eq!(picture(&label), before, "the text was drawn while hidden");

        root.setHidden(false);
        until("the new text's drawing", || picture(&label) != before);

        app.stop();
        window.close();
        println!("draw_on_show: unhide: ok");
    }

    /// The app hides a view with `visibility: hidden`: its `NSView` is
    /// hidden with its frame kept, a text changed under it is not drawn,
    /// and it is drawn once the view shows again.
    fn invisible(mtm: MainThreadMarker) {
        CHANGED.store(false, Ordering::SeqCst);
        INVISIBLE.store(false, Ordering::SeqCst);
        let window = window(mtm);
        let app = app_view(mtm);
        let root = app.view();
        window.setContentView(Some(&root));
        window.orderFrontRegardless();
        app.load(Root::of::<Hiding>().into());
        until("the first mount", || {
            find(&root, "label").is_some() && find(&root, "beside").is_some()
        });
        let (page, label, beside) = (
            find(&root, "page").expect("the page"),
            find(&root, "label").expect("the label"),
            find(&root, "beside").expect("the text beside"),
        );
        until("the first texts' drawing", || {
            drawn(&label) && drawn(&beside)
        });
        spin(0.2);
        let (before, beside_before, frame) = (picture(&label), picture(&beside), page.frame());

        INVISIBLE.store(true, Ordering::SeqCst);
        until("the view hidden", || page.isHidden());
        assert_eq!(page.frame(), frame, "the hidden view lost its frame");
        CHANGED.store(true, Ordering::SeqCst);
        // The text beside, always shown, draws the change once it is mounted.
        until("the change", || picture(&beside) != beside_before);
        spin(0.2);
        assert_eq!(picture(&label), before, "the text was drawn while hidden");

        INVISIBLE.store(false, Ordering::SeqCst);
        until("the view shown", || !page.isHidden());
        until("the new text's drawing", || picture(&label) != before);

        app.stop();
        window.close();
        println!("draw_on_show: invisible: ok");
    }

    /// Ordinary window composition, not cacheDisplayInRect (which forces
    /// drawing and can conceal deferred text). The fully clipped control
    /// must keep its text deferred.
    fn scaled_window(mtm: MainThreadMarker) {
        let window = window(mtm);
        window.setContentSize(NSSize::new(400.0, 200.0));
        window.setTitle(&NSString::from_str("Scaled visibility"));
        window.center();
        let app = AppView::new(
            mtm,
            AppOptions {
                size: (400, 200),
                ..AppOptions::default()
            },
        );
        let root = app.view();
        window.setContentView(Some(&root));
        window.orderFrontRegardless();
        app.load(Root::of::<Scaled>().into());
        until("the scaled mount", || find(&root, "clipped").is_some());
        let inside = find(&root, "inside").unwrap();
        let outside = find(&root, "outside").unwrap();
        let clipped = find(&root, "clipped").unwrap();
        until("the inside text", || drawn(&inside));
        until("the outside text", || drawn(&outside));
        assert!(!drawn(&clipped), "fully clipped text was drawn");
        app.stop();
        window.close();
        println!("draw_on_show: scaled: ok");
    }

    /// A text under a scaled ancestor draws at the ancestor's resolution:
    /// its content layer must not stretch the bitmap the window's backing
    /// scale gave it. Shrinking the ancestor puts the density back.
    fn sharp_scaled_window(mtm: MainThreadMarker) {
        let window = window(mtm);
        window.setContentSize(NSSize::new(400.0, 200.0));
        let app = AppView::new(
            mtm,
            AppOptions {
                size: (400, 200),
                ..AppOptions::default()
            },
        );
        let root = app.view();
        window.setContentView(Some(&root));
        window.orderFrontRegardless();
        app.load(Root::of::<Sharpened>().into());
        until("the sharpened mount", || find(&root, "sharp").is_some());
        let text = find(&root, "sharp").unwrap();
        until("the sharp text", || drawn(&text));

        let backing = window.backingScaleFactor();
        let scale = content_scale(&text).expect("a content layer");
        assert!(
            scale >= backing * 2.0,
            "content drawn at {scale}, below {backing} x 2"
        );
        assert!(
            scale <= backing * 2.5,
            "content drawn at {scale}, above {backing} x 2.5"
        );

        SHRINK.store(true, Ordering::SeqCst);
        until("the unzoomed text", || {
            content_scale(&text).is_some_and(|scale| scale <= backing * 1.001)
        });
        app.stop();
        window.close();
        println!("draw_on_show: sharp: ok");
    }

    /// Two scaled ancestors: the outer's step does not describe the inner
    /// text's density, and an inner change after the outer shrank must not
    /// trust the mark the shrink replaced.
    fn nested_scaled_window(mtm: MainThreadMarker) {
        let window = window(mtm);
        window.setContentSize(NSSize::new(400.0, 200.0));
        let app = AppView::new(
            mtm,
            AppOptions {
                size: (400, 200),
                ..AppOptions::default()
            },
        );
        let root = app.view();
        window.setContentView(Some(&root));
        window.orderFrontRegardless();
        app.load(Root::of::<NestedSharpened>().into());
        until("the nested mount", || find(&root, "nested").is_some());
        let text = find(&root, "nested").unwrap();
        until("the nested text", || drawn(&text));

        let backing = window.backingScaleFactor();
        let density = |what: &str, step: f64| {
            until(what, || {
                content_scale(&text).is_some_and(|s| (s / (backing * step) - 1.0).abs() < 1e-6)
            });
        };
        // The density steps `raster_zoom` picks for the effective scales
        // 4, 2, 4.6 and 5.014.
        density("the initial nested density", 1.25_f64.powi(7));
        NESTED.store(1, Ordering::SeqCst);
        density("the outer shrink's density", 1.25_f64.powi(4));
        NESTED.store(2, Ordering::SeqCst);
        density("the inner growth's density", 1.25_f64.powi(7));
        // The outer keeps its own density step (1.0 -> 1.09 is below
        // 1.25x), while the text's effective scale 4.6 -> 5.014 steps.
        NESTED.store(3, Ordering::SeqCst);
        density("the inner crossing's density", 1.25_f64.powi(8));

        app.stop();
        window.close();
        println!("draw_on_show: nested: ok");
    }

    /// A native transform must reveal deferred text on itself and below
    /// it, without a layout change or a drawing-forcing screenshot.
    fn animated_window(mtm: MainThreadMarker) {
        let window = window(mtm);
        let app = app_view(mtm);
        let root = app.view();
        window.setContentView(Some(&root));
        window.orderFrontRegardless();
        app.load(Root::of::<Animated>().into());
        until("the animated mount", || find(&root, "clipped").is_some());
        spin(0.2);
        let ancestor = find(&root, "ancestor").unwrap();
        let target = find(&root, "target").unwrap();
        let clipped = find(&root, "clipped").unwrap();
        assert!(!drawn(&ancestor), "ancestor text drew before it showed");
        assert!(!drawn(&target), "target text drew before it showed");
        REVEAL.store(true, Ordering::SeqCst);
        until("the ancestor's revealed text", || drawn(&ancestor));
        until("the target's revealed text", || drawn(&target));
        spin(0.5);
        assert!(!drawn(&clipped), "fully clipped text was drawn");
        app.stop();
        window.close();
        println!("draw_on_show: animated: ok");
    }

    pub(super) fn run() {
        let mtm = MainThreadMarker::new().expect("the main thread");
        let _app = NSApplication::sharedApplication(mtm);
        let cases: Vec<String> = std::env::args().skip(1).collect();
        let runs = |case: &str| cases.is_empty() || cases.iter().any(|c| c == case);
        if runs("window") {
            window_entry(mtm);
        }
        if runs("unhide") {
            unhide(mtm);
        }
        if runs("invisible") {
            invisible(mtm);
        }
        if runs("scaled") {
            scaled_window(mtm);
        }
        if runs("animated") {
            animated_window(mtm);
        }
        if runs("sharp") {
            sharp_scaled_window(mtm);
        }
        if runs("nested") {
            nested_scaled_window(mtm);
        }
        if runs("canvas") {
            canvas_window(mtm);
        }
    }

    /// An animated canvas mounted out of any window waits to draw until it
    /// enters one, and heals its static bands on the next animation frame if
    /// its content layer loses its whole-layer paint.
    fn canvas_window(mtm: MainThreadMarker) {
        let code = r##"
            import { element, append, prop } from "nsh:rt";
            import { mount, Canvas, createAnimatedValue, Animated } from "nsh";
            mount(() => {
                const x = createAnimatedValue(20);
                Animated.loop(Animated.sequence([
                    Animated.timing(x, { toValue: 60, duration: 160 }),
                    Animated.timing(x, { toValue: 20, duration: 160 }),
                ])).start();
                const root = element("view");
                prop(root, "style", { flex: 1, alignItems: "center", justifyContent: "center" });
                const c = Canvas({
                    testID: "mascot",
                    style: { width: 100, height: 100 },
                    draw: (cx) => {
                        cx.fillStyle = "#ff0000";
                        cx.fillRect(10, 4, 80, 16);
                        cx.fillStyle = "#0000ff";
                        cx.fillRect(10, 80, 80, 16);
                        cx.fillStyle = "#00aa00";
                        cx.fillRect(x, 44, 20, 12);
                    },
                });
                append(root, c);
                return root;
            });
        "##;

        let app = app_view(mtm);
        app.load(nsh_platform_macos::Bundle::source(code.to_owned()).into());
        let root = app.view();
        until("the canvas's mount", || find(&root, "mascot").is_some());
        let mascot = find(&root, "mascot").expect("the canvas");
        spin(0.2);
        assert!(
            content_scale(&mascot).is_none(),
            "the canvas made a content layer out of any window"
        );
        assert!(!drawn(&mascot), "the canvas was drawn out of any window");

        let window = window(mtm);
        window.setContentView(Some(&root));
        window.orderFrontRegardless();

        let bands_drawn = |view: &NSView| {
            let rep = view
                .bitmapImageRepForCachingDisplayInRect(view.bounds())
                .expect("a bitmap");
            let cx = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep).expect("a context");
            let layer = view.layer().expect("a layer-backed view");
            layer.renderInContext(&cx.CGContext());
            cx.flushGraphics();
            let (w, h, stride) = (
                rep.pixelsWide() as usize,
                rep.pixelsHigh() as usize,
                rep.bytesPerRow() as usize,
            );
            if w == 0 || h == 0 {
                return false;
            }
            let data = unsafe { std::slice::from_raw_parts(rep.bitmapData(), stride * h) };
            let opaque = |fx: f64, fy: f64| {
                let px = ((fx * w as f64) as usize).min(w - 1);
                let py = ((fy * h as f64) as usize).min(h - 1);
                let i = py * stride + px * 4;
                data[i..i + 4].iter().any(|&b| b != 0)
            };
            opaque(0.5, 0.12) && opaque(0.5, 0.88)
        };

        until("the canvas's initial whole paint", || bands_drawn(&mascot));

        // Drop the content layer's backing store at an unpainted scale so any
        // partial `setNeedsDisplayInRect` tick alone would leave only the
        // animated middle band (`y = 44..56`).
        let content = {
            let host = mascot.layer().expect("host layer");
            let sublayers = unsafe { host.sublayers() }.expect("sublayers");
            sublayers
                .iter()
                .find(|l| l.delegate().is_some())
                .expect("content layer")
                .retain()
        };
        unsafe { content.setContents(None) };
        content.setContentsScale(1.0);
        // Let several animation frames commit first so `content` holds what
        // the frame ticks asked Core Animation to draw (`Damage::Rect` alone
        // would populate the backing store with only the middle band).
        spin(0.1);
        until(
            "the canvas's whole repaint after a lost backing store",
            || bands_drawn(&mascot),
        );

        app.stop();
        window.close();
        println!("draw_on_show: canvas: ok");
    }
}
