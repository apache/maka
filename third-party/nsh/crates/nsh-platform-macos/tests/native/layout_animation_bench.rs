//! What a layout animation costs the main thread on every frame when a
//! sidebar opens and closes beside a page of rows: the page's ~400 views
//! change size (the rows, their text) or only move (the badges on their
//! right edge), as Noop's sidebar does.
//!
//! The window is ordered in without activating the app and ignores the
//! mouse. It is opaque: AppKit drives a see-through window's display link
//! at a few frames a second, which leaves one frame per animation.
//!
//! ```sh
//! NSH_LAYOUT_ANIMATION_BENCH=20 cargo test --release -p nsh-platform-macos \
//!     --test native -- --ignored
//! ```
//!
//! prints the frames each animation took (`NSH_LAYOUT_ANIMATION_BENCH_GLASS=<n>`
//! gives the first `n` rows glass, which changes width with them) and the main thread's cost per
//! frame, from the performance monitor.

use std::{
    rc::Rc,
    sync::atomic::{AtomicU32, Ordering},
    time::{Duration, Instant},
};

use nsh_core::{GlassEffect, LayoutAnimation, LayoutCurve, LayoutTransition, prelude::*};
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize, NSString},
};

/// 0: the sidebar is closed, 1: open.
static OPEN: AtomicU32 = AtomicU32::new(0);
/// How many rows carry glass (`NSH_LAYOUT_ANIMATION_BENCH_GLASS`), which
/// change width with the page as Noop's composer does.
static GLASS: AtomicU32 = AtomicU32::new(0);

const SIZE: (f64, f64) = (1200.0, 800.0);
const SIDEBAR: f32 = 260.0;
const ROWS: usize = 60;
/// The animation's length in ms (`NSH_LAYOUT_ANIMATION_BENCH_MS`, 200 by
/// default): a locked Mac runs the window's display link at a few frames a
/// second, which takes a longer animation to show frames between its ends.
static DURATION_MS: AtomicU32 = AtomicU32::new(200);

fn duration_ms() -> u64 {
    DURATION_MS.load(Ordering::SeqCst) as u64
}

#[component]
fn Scene() -> impl IntoElement {
    let open = signal(false);
    set_interval(Duration::from_millis(2), move || {
        let want = OPEN.load(Ordering::SeqCst) == 1;
        if open.get_untracked() != want {
            animate_layout(LayoutAnimation {
                update: Some(LayoutTransition::new(
                    LayoutCurve::EaseInEaseOut,
                    duration_ms() as f32,
                )),
                ..Default::default()
            });
            open.set(want);
        }
    });
    view()
        .size_full()
        .flex_row()
        .bg(rgb(0xffffff))
        .child(
            view()
                .test_id("sidebar")
                .flex_none()
                .overflow_hidden()
                .w(move || Length::from(px(if open.get() { SIDEBAR } else { 0.0 })))
                .bg(rgb(0xf4f4f5))
                .children((0..20).map(|i| {
                    view()
                        .h(px(28.0))
                        .px(px(12.0))
                        .justify_center()
                        .child(text(format!("Session {i}")).text_color(rgb(0x18181b)))
                })),
        )
        .child(
            view()
                .flex_1()
                .overflow_hidden()
                .children((0..ROWS).map(|i| {
                    let glass = (i as u32) < GLASS.load(Ordering::SeqCst);
                    view()
                        .when(glass, |v| {
                            v.glass_effect(GlassEffect::Regular)
                                .rounded(px(20.0))
                                .bg(rgba(0xffffff8c))
                        })
                        .flex_row()
                        .items_center()
                        .gap(px(8.0))
                        .h(px(40.0))
                        .px(px(16.0))
                        .child(view().size(px(24.0)).rounded(px(12.0)).bg(rgb(0xdbeafe)))
                        .child(
                            view()
                                .flex_1()
                                .child(text(format!("Message {i}")).text_color(rgb(0x18181b)))
                                .child(
                                    text("A line of text that fills the row")
                                        .text_color(rgb(0x71717a)),
                                ),
                        )
                        .child(
                            view()
                                .px(px(6.0))
                                .rounded(px(4.0))
                                .bg(rgb(0xe4e4e7))
                                .child(text(format!("#{i}"))),
                        )
                })),
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

/// The `NSGlassEffectView`s under `view` (AppKit may hand out a subclass).
fn find_glass(view: &NSView, found: &mut Vec<Retained<NSView>>) {
    let name = view.class().name().to_str().unwrap_or_default();
    if name.contains("GlassEffectView") && !name.starts_with("Nsh") {
        found.push(view.retain());
        return;
    }
    for v in view.subviews().iter() {
        find_glass(&v, found);
    }
}

/// What resizing every glass view by a point costs the main thread, laid
/// out and committed at once: the work a layout animation that resizes
/// them asks of every frame, measured without the display link (which a
/// locked Mac runs at a frame or two a second).
fn glass_resize_cost(container: &NSView, glass: &[Retained<NSView>]) -> f64 {
    const STEPS: usize = 60;
    let start = Instant::now();
    for step in 0..STEPS {
        for g in glass {
            let mut f = g.frame();
            f.size.width += if step % 2 == 0 { -1.0 } else { 1.0 };
            g.setFrame(f);
        }
        container.layoutSubtreeIfNeeded();
        objc2_quartz_core::CATransaction::flush();
    }
    start.elapsed().as_secs_f64() * 1000.0 / STEPS as f64
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

/// Opens or closes the sidebar and waits until the animation settled: the
/// number of frames its width changed in, and how many times the first
/// glass view (if any) changed size.
fn animate(sidebar: &NSView, glass: Option<&NSView>, open: bool) -> (usize, usize) {
    let end = if open { SIDEBAR as f64 } else { 0.0 };
    let start = Instant::now();
    OPEN.store(open as u32, Ordering::SeqCst);
    let mut frames = 0;
    let mut last = sidebar.frame().size.width;
    let mut resized = 0;
    let mut glass_last = glass.map(|g| g.frame().size);
    let deadline = start + Duration::from_millis(duration_ms() + 1500);
    loop {
        pump(0.001);
        let width = sidebar.frame().size.width;
        if width != last {
            last = width;
            frames += 1;
        }
        let size = glass.map(|g| g.frame().size);
        if size != glass_last {
            glass_last = size;
            resized += 1;
        }
        if width == end && start.elapsed() > Duration::from_millis(duration_ms() + 50) {
            break;
        }
        assert!(Instant::now() < deadline, "the animation never settled");
    }
    (frames, resized)
}

pub(super) fn run() {
    let Some(runs) = std::env::var("NSH_LAYOUT_ANIMATION_BENCH")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
    else {
        return;
    };
    let glass = std::env::var("NSH_LAYOUT_ANIMATION_BENCH_GLASS")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(0);
    GLASS.store(glass, Ordering::SeqCst);
    if let Some(ms) = std::env::var("NSH_LAYOUT_ANIMATION_BENCH_MS")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
    {
        DURATION_MS.store(ms, Ordering::SeqCst);
    }
    let mtm = MainThreadMarker::new().expect("the bench runs on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.finishLaunching();
    // SAFETY: The window is created on the process main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(100.0, 100.0), NSSize::new(SIZE.0, SIZE.1)),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Closable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(&NSString::from_str("NSH layout animation bench"));
    window.setIgnoresMouseEvents(true);
    let surface: Rc<platform::AppView> = platform::AppView::new(
        mtm,
        platform::AppOptions {
            size: (SIZE.0 as i32, SIZE.1 as i32),
            fps: true,
            ..Default::default()
        },
    );
    let container = surface.view();
    window.setContentView(Some(&container));
    OPEN.store(0, Ordering::SeqCst);
    surface.load(platform::App::Rust(platform::Root::of::<Scene>()));
    window.orderFrontRegardless();
    surface.set_fps_mode(FpsMode::Hidden);
    until("the page mounting", || {
        find(&container, "sidebar").is_some()
    });
    let sidebar = find(&container, "sidebar").expect("the sidebar");
    let mut glass_views = Vec::new();
    find_glass(&container, &mut glass_views);
    assert!(
        glass == 0 || !glass_views.is_empty(),
        "glass rows asked for, but AppKit has no NSGlassEffectView here"
    );
    let glass_view = glass_views.first().cloned();
    if !glass_views.is_empty() {
        println!(
            "  resizing {} glass views by a point, laid out and committed: {:.2} ms",
            glass_views.len(),
            glass_resize_cost(&container, &glass_views)
        );
    }
    pump(0.3);

    let monitor = surface.perf_monitor().expect("the performance monitor");
    let mut counts = Vec::new();
    let mut resizes = Vec::new();
    let mut costs = Vec::new();
    for run in 0..runs {
        let (frames, resized) = animate(&sidebar, glass_view.as_deref(), run % 2 == 0);
        counts.push(frames);
        resizes.push(resized);
        // The monitor keeps the last 120 frames: read them after each run.
        let snapshot = monitor.snapshot();
        let n = frames.min(snapshot.frames.len());
        costs.extend(
            snapshot.frames[snapshot.frames.len() - n..]
                .iter()
                .map(|d| d.as_secs_f64() * 1000.0),
        );
        pump(0.15);
    }
    let refresh = monitor.snapshot().refresh_rate;
    costs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let at = |q: f64| costs[((costs.len() as f64 * q).ceil() as usize).clamp(1, costs.len()) - 1];
    let mean = costs.iter().sum::<f64>() / costs.len() as f64;
    let mean_frames = counts.iter().sum::<usize>() as f64 / counts.len() as f64;
    println!(
        "layout animation bench: {runs} runs of {} ms, {glass} glass rows, refresh {refresh:?} Hz",
        duration_ms()
    );
    println!(
        "  frames per run: mean {mean_frames:.1} (min {}, max {})",
        counts.iter().min().unwrap(),
        counts.iter().max().unwrap(),
    );
    if glass > 0 {
        println!(
            "  glass size changes per run: mean {:.1} (max {})",
            resizes.iter().sum::<usize>() as f64 / resizes.len() as f64,
            resizes.iter().max().unwrap(),
        );
    }
    println!(
        "  main-thread cost per frame: mean {mean:.2} ms, p50 {:.2} ms, p95 {:.2} ms, max {:.2} ms",
        at(0.5),
        at(0.95),
        costs[costs.len() - 1]
    );

    surface.stop();
    window.close();
}
