//! A static nested shader arrives after its reader's first picture. The
//! reader must update without a later mount batch, then become idle.
//! A static fill also redraws after its layout collapses and expands.
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use nsh_core::{prelude::*, shader::Shader};
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
static SCREEN: AtomicBool = AtomicBool::new(false);
static COLLAPSED: AtomicBool = AtomicBool::new(false);
const FILL: &str = "fn shade(uv: vec2f) -> vec4f { return vec4f(8.0/255.0, 0.0, 0.0, 1.0); }";
const EFFECT: &str =
    "fn shade(uv: vec2f) -> vec4f { return vec4f(sample_content(uv).rgb * 24.0, 1.0); }";
#[component]
fn Content() -> impl IntoElement {
    let child = shader()
        .source(Shader::compile(FILL).unwrap())
        .w_full()
        .h_full();
    if SCREEN.load(Ordering::SeqCst) {
        view()
            .flex_1()
            .child(child)
            .child(screen_effect().source(Shader::compile(EFFECT).unwrap()))
            // Two readers must not continuously invalidate each other.
            .child(screen_effect().source(Shader::compile(EFFECT).unwrap()))
            .into_element()
    } else {
        view()
            .flex_1()
            .child(
                shader_effect()
                    .test_id("effect")
                    .source(Shader::compile(EFFECT).unwrap())
                    .flex_1()
                    .child(child),
            )
            .into_element()
    }
}

#[component]
fn Resizable() -> impl IntoElement {
    let collapsed = signal(false);
    set_interval(Duration::from_millis(5), move || {
        let next = COLLAPSED.load(Ordering::SeqCst);
        if collapsed.get_untracked() != next {
            collapsed.set(next);
        }
    });
    view().size_full().child(
        view()
            .w(px(40.0))
            .h(px(40.0))
            .style_when(collapsed, |s| s.w(px(0.0)).h(px(0.0)))
            .child(
                shader()
                    .test_id("static-fill")
                    .source(Shader::compile(FILL).unwrap())
                    .w_full()
                    .h_full(),
            ),
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
fn output(view: &NSView) -> Option<Retained<CALayer>> {
    // SAFETY: the main thread owns the layer tree.
    unsafe { view.layer()?.sublayers() }?
        .iter()
        .find(|l| l.zPosition() >= 1.0e6)
}
fn red(layer: &CALayer) -> u8 {
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
        CGContext::scale_ctm(
            Some(&context),
            1.0 / layer.bounds().size.width,
            1.0 / layer.bounds().size.height,
        );
        layer.renderInContext(&context);
        *CGBitmapContextGetData(Some(&context)).cast::<u8>()
    }
}
fn until(what: &str, mut done: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < end, "{what}");
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
    }
}

fn check_static_resize(app: &platform::AppView) {
    COLLAPSED.store(false, Ordering::SeqCst);
    app.load(platform::App::Rust(platform::Root::of::<Resizable>()));
    let mut displayed = None;
    until("the static fill must show its first frame", || {
        displayed = find(&app.view(), "static-fill").and_then(|view| {
            // SAFETY: the main thread owns the layer tree.
            unsafe {
                view.layer()?
                    .sublayers()?
                    .iter()
                    .find(|layer| layer.contents().is_some())
            }
        });
        displayed.is_some()
    });
    let layer = displayed.unwrap();
    // SAFETY: retained layer contents on the main thread.
    let showing = || unsafe { layer.contents() }.is_some();
    COLLAPSED.store(true, Ordering::SeqCst);
    until("collapsing must clear the static fill", || !showing());
    COLLAPSED.store(false, Ordering::SeqCst);
    until("expanding must redraw the same static fill", showing);
    println!("shader_content: static fill redrawn after collapse");
    app.stop();
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
    if std::env::var("NSH_SHADER_CONTENT_CHECK_ONLY").as_deref() == Ok("resize") {
        check_static_resize(&app);
        window.close();
        return;
    }
    for screen in [false, true] {
        SCREEN.store(screen, Ordering::SeqCst);
        app.load(platform::App::Rust(platform::Root::of::<Content>()));
        let layer = || {
            let view = if screen {
                app.view()
            } else {
                find(&app.view(), "effect")?
            };
            output(&view)
        };
        until("nested shader must reach sample_content", || {
            layer().is_some_and(|l| (185..=199).contains(&red(&l)))
        });
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.5));
        let output = layer().unwrap();
        // SAFETY: retained layer contents on the main thread.
        let contents = unsafe { output.contents() };
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.5));
        assert_eq!(
            unsafe { output.contents() }
                .as_deref()
                .map(std::ptr::from_ref),
            contents.as_deref().map(std::ptr::from_ref),
            "static effect must settle, screen={screen}"
        );
        println!(
            "shader_content: screen={screen}, red={}, settled",
            red(&output)
        );
        app.stop();
    }
    check_static_resize(&app);
    window.close();
}
