//! A canvas's content `CALayer` is sized to its 32-point-tile-aligned painted
//! bounds rather than the whole view, and omitted (or torn down) when the
//! drawing paints nothing visible.

use std::{
    sync::atomic::{AtomicU32, Ordering},
    time::{Duration, Instant},
};

use nsh_core::{element::Painter, prelude::*};
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize},
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGBitmapContextGetData, CGColorSpace, CGImageAlphaInfo,
    CGImageByteOrderInfo,
};
use objc2_quartz_core::CALayer;

static PHASE: AtomicU32 = AtomicU32::new(0);

#[component]
fn Scene() -> impl IntoElement {
    let phase = signal(0u32);
    set_interval(Duration::from_millis(5), move || {
        let next = PHASE.load(Ordering::SeqCst);
        if phase.get_untracked() != next {
            phase.set(next);
        }
    });
    view().size_full().child(
        canvas(move || {
            let p = Painter::new();
            match phase.get() {
                // Empty / transparent stroke (`SvgPaint::None` pattern in Sankey links).
                0 => p
                    .stroke_color(transparent_black())
                    .line_width(12.0)
                    .begin_path()
                    .move_to(20.0, 20.0)
                    .line_to(300.0, 200.0)
                    .stroke(),
                // Sparse drawing at (70..78, 100..112) -> tile (64..96, 96..128).
                1 => p
                    .fill_color(rgb(0xff0000))
                    .fill_rect(70.0, 100.0, 8.0, 12.0),
                // Shifted to another tile (196..204, 40..52) -> tile (192..224, 32..64).
                2 => p
                    .fill_color(rgb(0x00c800))
                    .fill_rect(196.0, 40.0, 8.0, 12.0),
                // Cleared back to nothing visible -> content layer must be removed.
                _ => p,
            }
        })
        .test_id("plot")
        .w(px(320.0))
        .h(px(240.0)),
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

fn content_sublayers(view: &NSView) -> Vec<Retained<CALayer>> {
    let Some(layer) = view.layer() else {
        return Vec::new();
    };
    // SAFETY: the main thread owns the layer tree.
    let Some(sublayers) = (unsafe { layer.sublayers() }) else {
        return Vec::new();
    };
    sublayers
        .iter()
        .filter(|l| l.delegate().is_some())
        .collect()
}

fn sample_rgb(layer: &CALayer, x: usize, y: usize, width: usize, height: usize) -> (u8, u8, u8) {
    let space = CGColorSpace::new_device_rgb().unwrap();
    // SAFETY: Core Graphics allocates and owns the pixel buffer while read.
    unsafe {
        let context = CGBitmapContextCreate(
            std::ptr::null_mut(),
            width,
            height,
            8,
            width * 4,
            Some(&space),
            CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0,
        )
        .unwrap();
        layer.renderInContext(&context);
        let data = std::slice::from_raw_parts(
            CGBitmapContextGetData(Some(&context)).cast::<u8>(),
            width * height * 4,
        );
        let offset = (y * width + x) * 4;
        (data[offset], data[offset + 1], data[offset + 2])
    }
}

fn until(what: &str, mut done: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < end, "{what}");
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
    }
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    NSApplication::sharedApplication(mtm).finishLaunching();
    // SAFETY: main-thread creation; retained until after close.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(120.0, 120.0), NSSize::new(320.0, 240.0)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    unsafe { window.setReleasedWhenClosed(false) };
    let app = platform::AppView::new(
        mtm,
        platform::AppOptions {
            size: (320, 240),
            ..Default::default()
        },
    );
    window.setContentView(Some(&app.view()));
    window.orderFront(None);

    PHASE.store(0, Ordering::SeqCst);
    app.load(platform::App::Rust(platform::Root::of::<Scene>()));

    until(
        "plot view mounted with transparent stroke and no content layer",
        || find(&app.view(), "plot").is_some_and(|v| content_sublayers(&v).is_empty()),
    );
    NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.05));
    let plot = find(&app.view(), "plot").unwrap();
    assert!(
        content_sublayers(&plot).is_empty(),
        "transparent stroke without shadow must not allocate a content CALayer"
    );

    // Phase 1: draw a small red mark at (70..78, 100..112) -> 32pt tile (64, 96, 32, 32).
    PHASE.store(1, Ordering::SeqCst);
    until("cropped content layer created at (64, 96, 32, 32)", || {
        let layers = content_sublayers(&plot);
        layers.len() == 1
            && layers[0].frame() == CGRect::new(CGPoint::new(64.0, 96.0), CGSize::new(32.0, 32.0))
    });
    NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.05));
    let host_layer = plot.layer().unwrap();
    host_layer.displayIfNeeded();
    for l in content_sublayers(&plot) {
        l.displayIfNeeded();
    }
    let sub = &content_sublayers(&plot)[0];
    let sub_px_top = sample_rgb(sub, 10, 10, 32, 32);
    let sub_px_bot = sample_rgb(sub, 10, 31 - 10, 32, 32);
    assert!(
        sub_px_top.0 > 200 || sub_px_bot.0 > 200,
        "cropped content layer must paint red at local offset (70 - 64, 100 - 96), got {sub_px_top:?} / {sub_px_bot:?}"
    );
    let outside = sample_rgb(sub, 0, 0, 32, 32);
    assert_eq!(outside, (0, 0, 0), "pixels outside the shape remain clear");

    // Phase 2: move mark to (196..204, 40..52) -> 32pt tile (192, 32, 32, 32).
    PHASE.store(2, Ordering::SeqCst);
    until("cropped content layer moved to (192, 32, 32, 32)", || {
        let layers = content_sublayers(&plot);
        layers.len() == 1
            && layers[0].frame() == CGRect::new(CGPoint::new(192.0, 32.0), CGSize::new(32.0, 32.0))
    });
    NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.05));
    for l in content_sublayers(&plot) {
        l.displayIfNeeded();
    }
    let sub = &content_sublayers(&plot)[0];
    let g_top = sample_rgb(sub, 8, 12, 32, 32);
    let g_bot = sample_rgb(sub, 8, 31 - 12, 32, 32);
    assert!(
        g_top.1 > 150 || g_bot.1 > 150,
        "moved content layer must paint green at local offset (196 - 192, 40 - 32), got {g_top:?} / {g_bot:?}"
    );

    // Phase 3: clear drawing -> content layer removed from superlayer.
    PHASE.store(3, Ordering::SeqCst);
    until("cleared drawing removes content layer", || {
        content_sublayers(&plot).is_empty()
    });
    println!("canvas_bounds: omitted empty, cropped 32pt tiles, shifted and cleared");

    app.stop();
    window.close();
}
