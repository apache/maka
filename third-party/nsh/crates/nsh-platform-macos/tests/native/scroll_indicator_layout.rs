//! A scroll view's indicator follows its frame while a layout animation
//! resizes it (#3188): a list beside a pane goes from `flex_grow(1.0)` to a
//! fixed width and its rows get taller in the same commit, animated with
//! `EaseInEaseOut` over 240 ms, the pointer over the list so the indicator
//! shows. On every in-between frame the indicator's overlay is the list's
//! size and the indicator sits on the list's right edge, not where the old
//! frame had it.
//!
//! The window is ordered in without activating the app, see-through and
//! ignoring the mouse, so the check takes nothing from the person at the
//! machine; the display link still runs for it.
//!
//! With `NSH_SCROLL_INDICATOR_BENCH=<runs>` it also animates the list back
//! and forth `runs` times and prints the frames each run took and the main
//! thread's cost per frame, from the performance monitor. With
//! `NSH_SCROLL_INDICATOR_FRAMES=<dir>` it renders the window's layers at
//! every frame of a few runs into `<dir>/frames.rgba` (raw RGBA, size in
//! `<dir>/size`), to make a recording from.

use std::{
    io::Write,
    rc::Rc,
    sync::atomic::{AtomicU32, Ordering},
    time::{Duration, Instant},
};

use nsh_core::{LayoutAnimation, LayoutCurve, LayoutTransition, prelude::*};
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSEvent, NSEventModifierFlags,
        NSEventType, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{
        NSArgumentDomain, NSDate, NSDictionary, NSPoint, NSRect, NSRunLoop, NSSize, NSString,
        NSUserDefaults,
    },
};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGBitmapContextGetData, CGColorSpace, CGContext, CGImageAlphaInfo,
    CGImageByteOrderInfo,
};
use objc2_quartz_core::CALayer;

/// 0: the list fills the row, 1: it has a fixed width.
static NARROW: AtomicU32 = AtomicU32::new(0);

const SIZE: (f64, f64) = (480.0, 300.0);
const PANE: f32 = 160.0;
const FIXED: f32 = 200.0;
const DURATION_MS: f32 = 240.0;
/// The indicator's gap to the view's edge (`scroll.rs`'s `EDGE`).
const EDGE: f64 = 2.0;

#[component]
fn Scene() -> impl IntoElement {
    let narrow = signal(false);
    set_interval(Duration::from_millis(2), move || {
        let want = NARROW.load(Ordering::SeqCst) == 1;
        if narrow.get_untracked() != want {
            animate_layout(LayoutAnimation {
                update: Some(LayoutTransition::new(
                    LayoutCurve::EaseInEaseOut,
                    DURATION_MS,
                )),
                ..Default::default()
            });
            narrow.set(want);
        }
    });
    view()
        .size_full()
        .flex_row()
        .bg(rgb(0xffffff))
        .child(
            virtual_list(200, move |at| {
                view()
                    .h(move || Length::from(px(if narrow.get() { 44.0 } else { 28.0 })))
                    .px(px(12.0))
                    .justify_center()
                    .bg(if at.index() % 2 == 0 {
                        rgb(0xf4f4f5)
                    } else {
                        rgb(0xffffff)
                    })
                    .child(text(format!("Row {}", at.index())).text_color(rgb(0x18181b)))
            })
            .estimated_item_size(px(28.0))
            .test_id("list")
            .flex_grow(move || if narrow.get() { 0.0_f32 } else { 1.0 })
            .w(move || {
                if narrow.get() {
                    Length::from(px(FIXED))
                } else {
                    Length::Auto
                }
            }),
        )
        .child(
            view()
                .w(px(PANE))
                .flex_none()
                .bg(rgb(0xdbeafe))
                .p(px(12.0))
                .child(text("Pane").text_color(rgb(0x1e3a8a))),
        )
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

fn pump(seconds: f64) {
    NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(seconds));
}

fn until(what: &str, mut done: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < end, "{what} never happened");
        pump(0.005);
    }
}

/// The scroll view's overlay (it holds the indicator).
fn overlay(list: &NSView) -> Option<Retained<NSView>> {
    list.subviews()
        .iter()
        .find(|v| v.class().name().to_str() == Ok("NshScrollOverlay"))
}

/// The indicator: the first layer made in the overlay.
fn indicator(list: &NSView) -> Option<Retained<CALayer>> {
    let layer = overlay(list)?.layer()?;
    // SAFETY: reading the sublayers on the main thread.
    let sublayers = unsafe { layer.sublayers() }?;
    sublayers.firstObject()
}

/// One sample of a frame: the list's width, its overlay's width, and the
/// indicator's right edge and length (`None` while hidden).
#[derive(Debug, Clone, Copy, PartialEq)]
struct Sample {
    width: f64,
    overlay: f64,
    right: Option<f64>,
    length: Option<f64>,
}

fn sample(list: &NSView) -> Sample {
    let ind = indicator(list).filter(|l| !l.isHidden() && l.opacity() > 0.0);
    Sample {
        width: list.frame().size.width,
        overlay: overlay(list).map_or(0.0, |o| o.frame().size.width),
        right: ind.as_ref().map(|l| l.position().x + l.bounds().size.width),
        length: ind.as_ref().map(|l| l.bounds().size.height),
    }
}

/// Keeps the pointer over the list, as AppKit sends it.
fn hover(root: &NSView, window: &NSWindow) {
    let at = root.convertPoint_toView(NSPoint::new(60.0, 120.0), None);
    let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        NSEventType::MouseMoved,
        at,
        NSEventModifierFlags::empty(),
        0.0,
        window.windowNumber(),
        None,
        0,
        0,
        0.0,
    )
    .expect("a mouse event");
    root.mouseMoved(&event);
}

/// Flips the list to `narrow` and samples every frame until the animation
/// settled: the samples, one per frame the list's width changed in.
fn animate(
    list: &NSView,
    root: &NSView,
    window: &NSWindow,
    narrow: bool,
    mut on_frame: impl FnMut(),
) -> Vec<(Duration, Sample)> {
    let end_width = if narrow {
        FIXED as f64
    } else {
        SIZE.0 - PANE as f64
    };
    hover(root, window);
    let start = Instant::now();
    NARROW.store(narrow as u32, Ordering::SeqCst);
    let mut frames = Vec::new();
    let mut last = list.frame().size.width;
    let deadline = start + Duration::from_millis(DURATION_MS as u64 + 1500);
    loop {
        pump(0.001);
        let width = list.frame().size.width;
        if width != last {
            last = width;
            frames.push((start.elapsed(), sample(list)));
            on_frame();
        }
        if width == end_width && start.elapsed() > Duration::from_millis(DURATION_MS as u64 + 50) {
            break;
        }
        assert!(Instant::now() < deadline, "the animation never settled");
    }
    frames
}

/// Renders `layer` (`w` × `h` points at `scale`) and appends its RGBA.
fn render(layer: &CALayer, w: usize, h: usize, scale: f64, out: &mut impl Write) {
    let space = CGColorSpace::new_device_rgb().unwrap();
    // SAFETY: Core Graphics allocates and owns the pixel buffer while read.
    unsafe {
        let context = CGBitmapContextCreate(
            std::ptr::null_mut(),
            w,
            h,
            8,
            w * 4,
            Some(&space),
            CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0,
        )
        .unwrap();
        CGContext::scale_ctm(Some(&context), scale, scale);
        layer.renderInContext(&context);
        let data = std::slice::from_raw_parts(
            CGBitmapContextGetData(Some(&context)).cast::<u8>(),
            w * h * 4,
        );
        out.write_all(data).unwrap();
    }
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().expect("the checks run on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.finishLaunching();
    // The indicator shows on hover unless the user only wants it while
    // scrolling: ask for it in this process only (the argument domain is
    // volatile and not saved).
    let defaults = NSUserDefaults::standardUserDefaults();
    let shows = NSDictionary::from_slices(
        &[&*NSString::from_str("AppleShowScrollBars")],
        &[&*Retained::into_super(Retained::into_super(
            NSString::from_str("Automatic"),
        ))],
    );
    // SAFETY: a dictionary of strings for the argument domain.
    unsafe { defaults.setVolatileDomain_forName(&shows, NSArgumentDomain) };

    // SAFETY: The window is created on the process main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(160.0, 200.0), NSSize::new(SIZE.0, SIZE.1)),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Closable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(&NSString::from_str("NSH scroll indicator layout"));
    window.setAlphaValue(0.0);
    window.setIgnoresMouseEvents(true);
    let surface: Rc<platform::AppView> = platform::AppView::new(
        mtm,
        platform::AppOptions {
            size: (SIZE.0 as i32, SIZE.1 as i32),
            fps: std::env::var_os("NSH_SCROLL_INDICATOR_BENCH").is_some(),
            ..Default::default()
        },
    );
    let container = surface.view();
    window.setContentView(Some(&container));
    NARROW.store(0, Ordering::SeqCst);
    surface.load(platform::App::Rust(platform::Root::of::<Scene>()));
    window.orderFrontRegardless();
    if surface.perf_monitor().is_some() {
        surface.set_fps_mode(FpsMode::Hidden);
    }

    until("the list mounting", || {
        find(&container, "list").is_some_and(|l| l.frame().size.width > 0.0)
    });
    let list = find(&container, "list").expect("the list");
    let root = container
        .subviews()
        .firstObject()
        .expect("the surface's root");
    pump(0.3);
    hover(&root, &window);
    until("the indicator showing on hover", || {
        sample(&list).right.is_some()
    });

    if let Some(runs) = std::env::var("NSH_SCROLL_INDICATOR_BENCH")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
    {
        // Measured first, so a build without the fix measures too.
        bench(&surface, &list, &root, &window, runs);
    }
    if let Some(dir) = std::env::var_os("NSH_SCROLL_INDICATOR_FRAMES") {
        record(
            &container,
            &list,
            &root,
            &window,
            std::path::Path::new(&dir),
        );
    }

    // Narrower: every in-between frame has the indicator on the list's
    // right edge and the overlay the list's size.
    let frames = animate(&list, &root, &window, true, || {});
    let wide = SIZE.0 - PANE as f64;
    let between: Vec<_> = frames
        .iter()
        .filter(|(_, s)| s.width > FIXED as f64 + 1.0 && s.width < wide - 1.0)
        .collect();
    assert!(
        between.len() >= 3,
        "the list animated over too few frames: {frames:?}"
    );
    for (at, s) in &between {
        assert_eq!(
            s.overlay, s.width,
            "at {at:?} the overlay must be the list's size: {s:?}"
        );
        let right = s.right.expect("the indicator shows while hovered");
        assert!(
            (right - (s.width - EDGE)).abs() < 0.5,
            "at {at:?} the indicator must be on the list's right edge: {s:?}"
        );
    }
    // And back, wider.
    let frames = animate(&list, &root, &window, false, || {});
    for (at, s) in frames
        .iter()
        .filter(|(_, s)| s.width > FIXED as f64 + 1.0 && s.width < wide - 1.0)
    {
        let right = s.right.expect("the indicator shows while hovered");
        assert!(
            (right - (s.width - EDGE)).abs() < 0.5,
            "widening, at {at:?} the indicator must be on the list's right edge: {s:?}"
        );
    }

    surface.stop();
    window.close();
    // SAFETY: the same domain, emptied.
    unsafe {
        defaults.setVolatileDomain_forName(&NSDictionary::new(), NSArgumentDomain);
    }
}

/// Animates the list back and forth `runs` times and prints what each
/// animation took.
fn bench(
    surface: &platform::AppView,
    list: &NSView,
    root: &NSView,
    window: &NSWindow,
    runs: usize,
) {
    let monitor = surface.perf_monitor().expect("the performance monitor");
    let mut counts = Vec::new();
    let mut gaps = Vec::new();
    let mut costs = Vec::new();
    for run in 0..runs {
        let frames = animate(list, root, window, run % 2 == 0, || {});
        counts.push(frames.len());
        gaps.extend(
            frames
                .windows(2)
                .map(|w| (w[1].0 - w[0].0).as_secs_f64() * 1000.0),
        );
        // The monitor keeps the last 120 frames: read them after each run
        // (one run is far fewer), taking only this run's.
        let snapshot = monitor.snapshot();
        let n = frames.len().min(snapshot.frames.len());
        costs.extend(
            snapshot.frames[snapshot.frames.len() - n..]
                .iter()
                .map(|d| d.as_secs_f64() * 1000.0),
        );
        pump(0.15);
    }
    let snapshot = monitor.snapshot();
    let stat = |v: &mut Vec<f64>| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let at = |q: f64| v[((v.len() as f64 * q).ceil() as usize).clamp(1, v.len()) - 1];
        let mean = v.iter().sum::<f64>() / v.len() as f64;
        format!(
            "mean {mean:.2} ms, p50 {:.2} ms, p95 {:.2} ms, max {:.2} ms",
            at(0.5),
            at(0.95),
            v[v.len() - 1]
        )
    };
    let mean_frames = counts.iter().sum::<usize>() as f64 / counts.len() as f64;
    println!(
        "scroll indicator bench: {runs} runs of {DURATION_MS} ms, refresh {:?} Hz",
        snapshot.refresh_rate
    );
    println!(
        "  frames per run: mean {mean_frames:.1} (min {}, max {}) = {:.1} fps",
        counts.iter().min().unwrap(),
        counts.iter().max().unwrap(),
        mean_frames / (DURATION_MS as f64 / 1000.0)
    );
    println!("  frame interval: {}", stat(&mut gaps));
    println!("  main-thread cost per frame: {}", stat(&mut costs));
}

/// Renders every frame of a few runs into `dir`.
fn record(
    container: &NSView,
    list: &NSView,
    root: &NSView,
    window: &NSWindow,
    dir: &std::path::Path,
) {
    std::fs::create_dir_all(dir).unwrap();
    let scale = 2.0;
    let (w, h) = ((SIZE.0 * scale) as usize, (SIZE.1 * scale) as usize);
    std::fs::write(dir.join("size"), format!("{w}x{h}")).unwrap();
    let mut out = std::io::BufWriter::new(std::fs::File::create(dir.join("frames.rgba")).unwrap());
    let layer = container.layer().expect("the container's layer");
    let mut count = 0;
    for run in 0..4 {
        // Still frames between runs.
        for _ in 0..20 {
            hover(root, window);
            pump(0.016);
            render(&layer, w, h, scale, &mut out);
            count += 1;
        }
        animate(list, root, window, run % 2 == 0, || {
            render(&layer, w, h, scale, &mut out);
            count += 1;
        });
    }
    println!("scroll indicator frames: {count} in {}", dir.display());
}
