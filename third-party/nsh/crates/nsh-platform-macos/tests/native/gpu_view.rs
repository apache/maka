//! A GPU view shows its renderer's frame: the frame's IOSurface becomes
//! the contents of the layer under its children, inside its rounded box.
//! Skipped where no GPU answers.
use std::time::{Duration, Instant};

use nsh_core::prelude::*;
use nsh_gpu::{GpuFrame, GpuRenderer, GpuViewExt, wgpu};
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize},
};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGBitmapContextGetData, CGColorSpace, CGContext, CGImageAlphaInfo,
    CGImageByteOrderInfo,
};
use objc2_quartz_core::CALayer;

/// Clears its frame to opaque red.
struct Red;

impl GpuRenderer for Red {
    fn render(&mut self, frame: &mut GpuFrame<'_>) {
        let target = frame.target().clone();
        frame
            .encoder()
            .begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &target,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::RED),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
    }
}

#[component]
fn Content() -> impl IntoElement {
    view().flex_1().child(
        gpu_view()
            .test_id("gpu")
            .renderer(|| Red)
            .w(px(40.0))
            .h(px(30.0))
            .rounded(px(8.0)),
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

/// The layer showing the view's frames: the sublayer with contents.
fn frames(view: &NSView) -> Option<Retained<CALayer>> {
    // SAFETY: the main thread owns the layer tree.
    unsafe { view.layer()?.sublayers() }?
        .iter()
        .find(|l| unsafe { l.contents() }.is_some())
}

/// The RGBA of the pixel at the layer's center.
fn center(layer: &CALayer) -> [u8; 4] {
    let space = CGColorSpace::new_device_rgb().unwrap();
    // SAFETY: Core Graphics owns this one-pixel buffer; it lives while read.
    unsafe {
        let context = CGBitmapContextCreate(
            std::ptr::null_mut(),
            1,
            1,
            8,
            4,
            Some(&space),
            CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0,
        )
        .unwrap();
        let size = layer.bounds().size;
        CGContext::translate_ctm(Some(&context), -size.width / 2.0, -size.height / 2.0);
        layer.renderInContext(&context);
        *CGBitmapContextGetData(Some(&context)).cast::<[u8; 4]>()
    }
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    NSApplication::sharedApplication(mtm).finishLaunching();
    // SAFETY: main-thread creation; retained until after close.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(100.0, 100.0), NSSize::new(320.0, 240.0)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: the window is retained by `window` until after close.
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
    app.load(platform::App::Rust(platform::Root::of::<Content>()));
    let end = Instant::now() + Duration::from_secs(10);
    let layer = loop {
        if let Some(layer) = find(&app.view(), "gpu").and_then(|v| frames(&v)) {
            break Some(layer);
        }
        if Instant::now() > end {
            break None;
        }
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
    };
    let Some(layer) = layer else {
        // No GPU answered: GPU views draw nothing of their own.
        println!("gpu_view: no frame (no GPU), skipped");
        window.close();
        return;
    };
    let pixel = center(&layer);
    let corners = layer.cornerRadius();
    window.close();
    assert_eq!(pixel, [255, 0, 0, 255], "the renderer's red frame shows");
    assert!(
        (corners - 8.0).abs() < 0.01,
        "clipped to the view's rounded corners, not {corners}"
    );
    println!("gpu_view: frame shown, center {pixel:?}");
}
