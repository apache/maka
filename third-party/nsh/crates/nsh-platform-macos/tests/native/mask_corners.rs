//! A view that clips its children to corners of different radii keeps that
//! clip when it also has a `mask-image` or a `clip-path`: the layer's mask is
//! the corner shape with the effect's mask as its own mask, so both apply.
//! Read back through the layers' `mask` chains and by rendering the view's
//! layer: the clipped corner is clear, the rest of the faded body (and the
//! unrounded corners) still shows the child.
//!
//! Also checked: removing and restoring the mask image, a container that
//! appears (a clip path) while a mask image is set and stays after it goes
//! (it must not keep the old gradient as its own mask), a view with both
//! effects, and a text view, which always masks its corners.

use std::{
    sync::atomic::{AtomicU32, Ordering},
    time::{Duration, Instant},
};

use nsh_core::{ClipInset, prelude::*};
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize},
};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGBitmapContextGetData, CGColorSpace, CGImageAlphaInfo,
    CGImageByteOrderInfo,
};
use objc2_quartz_core::CALayer;

const WIDTH: usize = 200;
const HEIGHT: usize = 100;

static PHASE: AtomicU32 = AtomicU32::new(0);

fn stops(on: bool) -> Vec<ColorStop> {
    if on {
        vec![black().into(), transparent_black().into()]
    } else {
        Vec::new()
    }
}

/// A box with only its top left corner rounded, clipping a red child. The
/// fade runs left to right, so the points sampled near the left edge are
/// still almost opaque.
fn boxed() -> View {
    view()
        .w(px(WIDTH as f32))
        .h(px(HEIGHT as f32))
        .overflow_hidden()
        .rounded_tl(px(40.0))
        .child(view().size_full().bg(rgb(0xff0000)))
}

#[component]
fn Scene() -> impl IntoElement {
    let phase = signal(0u32);
    set_interval(Duration::from_millis(5), move || {
        let next = PHASE.load(Ordering::SeqCst);
        if phase.get_untracked() != next {
            phase.set(next);
        }
    });
    view()
        .size_full()
        .flex_col()
        // A fixed mask image.
        .child(
            boxed()
                .test_id("faded")
                .mask_linear(deg(90.0), [black(), transparent_black()]),
        )
        // Phase 1 takes the mask image off, phase 2 puts it back.
        .child(
            boxed()
                .test_id("toggle")
                .mask_linear(deg(90.0), move || stops(phase.get() != 1)),
        )
        // Phase 3 adds a clip path (a container), phase 4 takes it off
        // again, phase 5 also takes the mask image off.
        .child(
            boxed()
                .test_id("container")
                .mask_linear(deg(90.0), move || stops(phase.get() < 5))
                .style_when(move || phase.get() == 3, |s| s.clip_path(ClipInset::new())),
        )
        // Both effects from the start.
        .child(
            boxed()
                .test_id("clipped")
                .clip_path(ClipInset::new())
                .mask_linear(deg(90.0), [black(), transparent_black()]),
        )
        // Text always masks its odd corners.
        .child(
            text(" ")
                .test_id("label")
                .w(px(WIDTH as f32))
                .h(px(HEIGHT as f32))
                .bg(rgb(0xff0000))
                .rounded_tl(px(40.0))
                .mask_linear(deg(90.0), [black(), transparent_black()]),
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

fn until(what: &str, mut done: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < end, "{what}");
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
    }
}

fn settle() {
    NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.2));
}

/// The red channel at `points`, rendering `layer` at one pixel per point.
fn red_at(layer: &CALayer, points: &[(usize, usize)]) -> Vec<u8> {
    let space = CGColorSpace::new_device_rgb().unwrap();
    // SAFETY: Core Graphics allocates and owns the pixel buffer while read.
    unsafe {
        let context = CGBitmapContextCreate(
            std::ptr::null_mut(),
            WIDTH,
            HEIGHT,
            8,
            WIDTH * 4,
            Some(&space),
            CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0,
        )
        .unwrap();
        layer.renderInContext(&context);
        let data = std::slice::from_raw_parts(
            CGBitmapContextGetData(Some(&context)).cast::<u8>(),
            WIDTH * HEIGHT * 4,
        );
        points
            .iter()
            .map(|&(x, y)| data[(y * WIDTH + x) * 4])
            .collect()
    }
}

fn layer_of(root: &NSView, id: &str) -> Retained<CALayer> {
    let layer = find(root, id).and_then(|v| v.layer());
    layer.unwrap_or_else(|| panic!("{id} has no layer"))
}

/// The layer's mask and that mask's own mask.
fn chain(layer: &CALayer) -> (Option<Retained<CALayer>>, Option<Retained<CALayer>>) {
    let mask = layer.mask();
    let inner = mask.as_ref().and_then(|m| m.mask());
    (mask, inner)
}

/// The corner clip: the bitmap's vertical direction depends on the layer's
/// geometry, so both left corners 6 points in are sampled: the rounded one
/// is clear, the square one still shows the child.
fn assert_corner_clips(layer: &CALayer, what: &str) {
    let red = red_at(layer, &[(6, 6), (6, HEIGHT - 6)]);
    let (clear, shown) = (red[0].min(red[1]), red[0].max(red[1]));
    assert!(
        clear < 20,
        "{what}: the rounded corner must clip the child, red {red:?}"
    );
    assert!(
        shown > 200,
        "{what}: the square corner must show the child, red {red:?}"
    );
}

/// Whether the right side, where the fade ends, is faded out.
fn assert_fade(layer: &CALayer, faded: bool, what: &str) {
    let red = red_at(layer, &[(WIDTH - 6, HEIGHT / 2)])[0];
    if faded {
        assert!(red < 60, "{what}: the right side must be faded, red {red}");
    } else {
        assert!(red > 200, "{what}: the right side must show, red {red}");
    }
}

/// The view's container (its subview that clips), when it has one.
fn container_layer(view: &NSView) -> Option<Retained<CALayer>> {
    view.subviews()
        .iter()
        .filter_map(|v| v.layer())
        .find(|l| l.mask().is_some())
}

fn step(root: &NSView, phase: u32) {
    PHASE.store(phase, Ordering::SeqCst);
    settle();
    for id in ["faded", "toggle", "container", "clipped", "label"] {
        layer_of(root, id).displayIfNeeded();
    }
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    NSApplication::sharedApplication(mtm).finishLaunching();
    // SAFETY: main-thread creation; retained until after close.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(120.0, 120.0), NSSize::new(320.0, 560.0)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: the retained window is closed explicitly below.
    unsafe { window.setReleasedWhenClosed(false) };
    let app = platform::AppView::new(
        mtm,
        platform::AppOptions {
            size: (320, 560),
            ..Default::default()
        },
    );
    let root = app.view();
    window.setContentView(Some(&root));
    window.orderFront(None);
    PHASE.store(0, Ordering::SeqCst);
    app.load(platform::App::Rust(platform::Root::of::<Scene>()));

    until("the views are laid out", || {
        ["faded", "toggle", "container", "clipped", "label"]
            .iter()
            .all(|id| {
                find(&root, id).and_then(|v| v.layer()).is_some_and(|l| {
                    l.frame().size.width as usize == WIDTH
                        && l.frame().size.height as usize == HEIGHT
                })
            })
    });
    step(&root, 0);

    // A mask image: the layer's mask is the corner shape, with the gradient
    // as its mask, rather than the bare gradient.
    let faded = layer_of(&root, "faded");
    let (mask, inner) = chain(&faded);
    assert!(mask.is_some(), "faded: the view is masked");
    assert!(
        inner.is_some(),
        "faded: the layer's mask must be the corner shape masked by the gradient, not the bare gradient"
    );
    assert_corner_clips(&faded, "faded");
    assert_fade(&faded, true, "faded");

    // The mask image comes off and goes back on.
    let toggle = layer_of(&root, "toggle");
    assert!(chain(&toggle).1.is_some(), "toggle: on");
    assert_corner_clips(&toggle, "toggle, on");
    assert_fade(&toggle, true, "toggle, on");
    step(&root, 1);
    let (mask, inner) = chain(&toggle);
    assert!(
        mask.is_some(),
        "toggle, off: the corner shape stays the mask"
    );
    assert!(
        inner.is_none(),
        "toggle, off: the corner shape keeps no mask of its own"
    );
    assert_corner_clips(&toggle, "toggle, off");
    assert_fade(&toggle, false, "toggle, off");
    step(&root, 2);
    assert!(chain(&toggle).1.is_some(), "toggle, on again");
    assert_corner_clips(&toggle, "toggle, on again");
    assert_fade(&toggle, true, "toggle, on again");

    // A container appears while the mask image is set: the corner shape
    // masks it, without the gradient the view's layer is masked by.
    let boxed = find(&root, "container").unwrap();
    let container = layer_of(&root, "container");
    assert!(container_layer(&boxed).is_none(), "container: none yet");
    assert!(chain(&container).1.is_some(), "container: on, no container");
    step(&root, 3);
    let inner_layer = container_layer(&boxed).expect("the clip path gives the view a container");
    assert!(
        inner_layer.mask().is_some_and(|m| m.mask().is_none()),
        "container: the corner shape of the container keeps no mask of its own"
    );
    let (mask, inner) = chain(&container);
    assert!(
        mask.is_some() && inner.is_some(),
        "container: the clip shape is the layer's mask, masked by the gradient"
    );
    assert_corner_clips(&container, "container, clip path");
    // The clip path goes, the container stays.
    step(&root, 4);
    if let Some(inner_layer) = container_layer(&boxed) {
        assert!(
            inner_layer.mask().is_some_and(|m| m.mask().is_none()),
            "container, clip path gone: the container's corner shape keeps no mask"
        );
    }
    assert!(
        chain(&container).0.is_some_and(|g| g.mask().is_none()),
        "container, clip path gone: the gradient alone masks the layer"
    );
    assert_corner_clips(&container, "container, clip path gone");
    // The mask image goes too.
    step(&root, 5);
    if let Some(inner_layer) = container_layer(&boxed) {
        assert!(
            inner_layer.mask().is_some_and(|m| m.mask().is_none()),
            "container, no effects: the container's corner shape keeps no mask"
        );
    }
    assert!(
        container.mask().is_none(),
        "container, no effects: the layer is not masked"
    );
    assert_corner_clips(&container, "container, no effects");
    assert_fade(&container, false, "container, no effects");

    // Both effects from the start: the clip shape, masked by the gradient.
    let clipped = layer_of(&root, "clipped");
    let (mask, inner) = chain(&clipped);
    assert!(
        mask.is_some() && inner.is_some(),
        "clipped: the clip shape masked by the gradient"
    );
    let clipped_view = find(&root, "clipped").unwrap();
    let inner_layer = container_layer(&clipped_view).expect("clipped: a container");
    assert!(
        inner_layer.mask().is_some_and(|m| m.mask().is_none()),
        "clipped: the container's corner shape keeps no mask of its own"
    );
    assert_corner_clips(&clipped, "clipped");
    assert_fade(&clipped, true, "clipped");

    // Text: its odd corners are masked even without clipping.
    let label = layer_of(&root, "label");
    let (mask, inner) = chain(&label);
    assert!(mask.is_some(), "label: masked");
    assert!(
        inner.is_some(),
        "label: the corner shape must carry the gradient, not be replaced by it"
    );
    assert_corner_clips(&label, "label");
    println!("mask_corners: mask images and clip paths keep odd corners clipped");

    app.stop();
    window.close();
}
