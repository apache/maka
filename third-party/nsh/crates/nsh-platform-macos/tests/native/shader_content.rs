//! A static nested shader arrives after its reader's first picture. The
//! reader must update without a later mount batch, then become idle.
//! A collapsed shader clears its presentation, including while out of sight.
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
#[cfg(feature = "terminal")]
static RESIZE_STEP: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);
#[cfg(feature = "terminal")]
static TRANSITION_STEP: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);
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

#[cfg(feature = "terminal")]
#[component]
fn HiddenResize() -> impl IntoElement {
    let step = signal(0);
    set_interval(Duration::from_millis(5), move || {
        let next = RESIZE_STEP.load(Ordering::SeqCst);
        if step.get_untracked() != next {
            step.set(next);
        }
    });
    let a = Shader::compile(FILL).unwrap();
    let b = Shader::compile(
        "fn shade(uv: vec2f) -> vec4f { return vec4f(0.0, fract(nsh.time), 0.0, 1.0); }",
    )
    .unwrap();
    view().size_full().test_id("hide-effect").child(
        shader_effect()
            .test_id("resize-effect")
            .source(move || {
                if step.get() == 0 {
                    a.clone()
                } else {
                    b.clone()
                }
            })
            .max_sample_offset(px(4.0))
            .w(move || {
                px(match step.get() {
                    0 => 40.0,
                    1 => 80.0,
                    _ => 0.0,
                })
            })
            .h(px(40.0)),
    )
}

#[cfg(feature = "terminal")]
#[component]
fn ScreenResize() -> impl IntoElement {
    view().size_full().child(
        screen_effect().test_id("screen-resize").source(
            Shader::compile(
                "fn shade(uv: vec2f) -> vec4f { return vec4f(fract(nsh.time), 0.0, 0.0, 1.0); }",
            )
            .unwrap(),
        ),
    )
}

#[cfg(feature = "terminal")]
#[component]
fn CollapsingTransition() -> impl IntoElement {
    let step = signal(0u8);
    set_interval(Duration::from_millis(5), move || {
        let next = TRANSITION_STEP.load(Ordering::SeqCst);
        if step.get_untracked() != next {
            step.set(next);
        }
    });
    let screen = SCREEN.load(Ordering::SeqCst);
    let transition = if screen {
        screen_transition()
    } else {
        shader_transition()
    };
    let transition = transition
        .test_id("collapse-transition")
        .source(Shader::compile("fn shade(uv: vec2f) -> vec4f { return mix(sample_from(uv), sample_to(uv), nsh.progress); }").unwrap())
        .value(move || nsh_core::shader::TransitionKey::Bool(step.get() != 0))
        .duration(Duration::from_secs(5));
    let child = shader()
        .test_id("transition-child")
        .source(Shader::compile(FILL).unwrap())
        .w(px(64.0))
        .h(px(64.0))
        .absolute();
    let root = view().size_full();
    if screen {
        root.child(child).child(transition)
    } else {
        root.child(
            transition
                .w(move || px(if step.get() == 2 { 0.0 } else { 64.0 }))
                .h(px(64.0))
                .child(child),
        )
    }
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
#[track_caller]
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

#[cfg(feature = "terminal")]
fn check_hidden_resize(app: &NSApplication) {
    use nsh_engine::EngineConfig;
    use nsh_terminal::{DevicePixels, NativeSurface};

    RESIZE_STEP.store(0, Ordering::SeqCst);
    let host = platform::TerminalSurface::new(
        EngineConfig::new(platform::App::Rust(platform::Root::of::<HiddenResize>())),
        nsh_terminal::size(DevicePixels(320), DevicePixels(240)),
        1.0,
        Box::new(|_| {}),
        std::sync::Arc::new(|| {}),
    )
    .unwrap();
    // Drive AppKit's frame callbacks without relying on display-link events
    // from a visible desktop window.
    let pump = || {
        host.pump_with_draw(false);
        assert_eq!(host.take_error(), None);
    };
    // SAFETY: all layer contents are read on the AppKit thread.
    let contents = |layer: &CALayer| unsafe { layer.contents() };
    let mut presented = None;
    until("the effect must present", || {
        pump();
        presented = app.windows().iter().find_map(|window| {
            let root = window.contentView()?;
            let parent = find(&root, "hide-effect")?;
            let effect = find(&parent, "resize-effect")?;
            let layer = output(&effect)?;
            let a = contents(&layer)?;
            Some((parent, effect, layer, a))
        });
        presented.is_some()
    });
    let (parent, effect, layer, a) = presented.unwrap();
    assert_eq!(a.class().name(), c"IOSurface", "A must come from Metal");

    RESIZE_STEP.store(1, Ordering::SeqCst);
    // The output bounds change in the render pass. B's pipeline is cold,
    // so that pass replaces the pool without presenting B.
    until("the effect must render at B's size", || {
        pump();
        layer.frame().size.width == 88.0
    });
    let still_a = || contents(&layer).is_some_and(|shown| std::ptr::eq(&*shown, &*a));
    assert!(still_a(), "B presented before it could be hidden");
    parent.setHidden(true);
    // B is animated: its next pass sees the effect out of sight and takes
    // it off the ticker, before geometry collapses in a separate batch.
    pump();
    assert!(still_a(), "the hidden effect replaced its old frame");

    RESIZE_STEP.store(2, Ordering::SeqCst);
    until("the hidden effect must clear when it collapses", || {
        pump();
        layer.frame().size.width == 8.0 && contents(&layer).is_none()
    });
    assert!(
        effect.isHiddenOrHasHiddenAncestor(),
        "the effect became visible before clearing"
    );
    println!("shader_content: hidden effect cleared after resize and collapse");
}

#[cfg(feature = "terminal")]
fn check_screen_resize(app: &NSApplication) {
    use nsh_engine::EngineConfig;
    use nsh_terminal::{DevicePixels, NativeSurface};

    let host = platform::TerminalSurface::new(
        EngineConfig::new(platform::App::Rust(platform::Root::of::<ScreenResize>())),
        nsh_terminal::size(DevicePixels(320), DevicePixels(240)),
        1.0,
        Box::new(|_| {}),
        std::sync::Arc::new(|| {}),
    )
    .unwrap();
    let pump = || {
        host.pump_with_draw(false);
        assert_eq!(host.take_error(), None);
    };
    // SAFETY: all layer contents are read on the AppKit thread.
    let contents = |layer: &CALayer| unsafe { layer.contents() };
    let mut presented = None;
    until("the screen effect must present at 320 × 240", || {
        pump();
        presented = app.windows().iter().find_map(|window| {
            window.contentView()?.subviews().iter().find_map(|root| {
                find(&root, "screen-resize")?;
                let layer = output(&root)?;
                (layer.frame().size == NSSize::new(320.0, 240.0) && contents(&layer).is_some())
                    .then_some((root, layer))
            })
        });
        presented.is_some()
    });
    let (root, layer) = presented.unwrap();
    assert_eq!(contents(&layer).unwrap().class().name(), c"IOSurface");
    // Set the native root's frame directly: a zero-width view is valid,
    // but a zero-width terminal capture viewport isn't.
    root.setFrameSize(NSSize::new(0.0, 240.0));
    until(
        "the screen effect must clear after its root collapses",
        || {
            pump();
            layer.frame().size == NSSize::new(0.0, 240.0) && contents(&layer).is_none()
        },
    );

    root.setFrameSize(NSSize::new(320.0, 240.0));
    until(
        "expanding the root must redraw the same screen effect layer",
        || {
            pump();
            layer.frame().size == NSSize::new(320.0, 240.0) && contents(&layer).is_some()
        },
    );
    println!("shader_content: animated screen effect redrawn after root collapse");
}

#[cfg(feature = "terminal")]
fn check_transition_collapse(app: &NSApplication, screen: bool) {
    use nsh_engine::EngineConfig;
    use nsh_terminal::{DevicePixels, NativeSurface};

    SCREEN.store(screen, Ordering::SeqCst);
    TRANSITION_STEP.store(0, Ordering::SeqCst);
    let host = platform::TerminalSurface::new(
        EngineConfig::new(platform::App::Rust(platform::Root::of::<
            CollapsingTransition,
        >())),
        nsh_terminal::size(DevicePixels(320), DevicePixels(240)),
        1.0,
        Box::new(|_| {}),
        std::sync::Arc::new(|| {}),
    )
    .unwrap();
    let pump = || {
        host.pump_with_draw(false);
        assert_eq!(host.take_error(), None);
    };
    let mut views = None;
    until(
        "the transition's child must present its first frame",
        || {
            pump();
            views = app.windows().iter().find_map(|window| {
                window.contentView()?.subviews().iter().find_map(|root| {
                    let node = find(&root, "collapse-transition")?;
                    let owner = if screen { root } else { node };
                    let child = find(&owner, "transition-child")?;
                    // SAFETY: the main thread owns the layer tree.
                    let ready = unsafe { child.layer()?.sublayers()? }
                        .iter()
                        .any(|layer| unsafe { layer.contents() }.is_some());
                    if !ready {
                        return None;
                    }
                    Some((owner.clone(), child, output(&owner)?))
                })
            });
            views.is_some()
        },
    );
    let (owner, child, layer) = views.unwrap();
    let ancestor_mask = || {
        let owner_layer = owner.layer().unwrap();
        let mut parent = child.layer().unwrap().superlayer();
        while let Some(layer) = parent {
            if std::ptr::eq(&*layer, &*owner_layer) {
                break;
            }
            if layer.mask().is_some() {
                return true;
            }
            parent = layer.superlayer();
        }
        false
    };
    // SAFETY: all layer contents are read on the AppKit thread.
    let contents = || unsafe { layer.contents() };
    TRANSITION_STEP.store(1, Ordering::SeqCst);
    until(
        "the transition must present a frame and mask its child",
        || {
            pump();
            ancestor_mask() && contents().is_some()
        },
    );
    assert_eq!(contents().unwrap().class().name(), c"IOSurface");

    if screen {
        owner.setFrameSize(NSSize::new(0.0, 240.0));
    } else {
        TRANSITION_STEP.store(2, Ordering::SeqCst);
    }
    until("collapse must clear the transition frame", || {
        pump();
        layer.frame().size.width == 0.0 && contents().is_none()
    });
    assert!(
        !ancestor_mask(),
        "collapsed transition still masks its child, screen={screen}"
    );
    println!("shader_content: collapsed transition unmasked its child, screen={screen}");
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    let application = NSApplication::sharedApplication(mtm);
    application.finishLaunching();
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
        #[cfg(feature = "terminal")]
        {
            check_hidden_resize(&application);
            check_screen_resize(&application);
            for screen in [false, true] {
                check_transition_collapse(&application, screen);
            }
        }
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
    #[cfg(feature = "terminal")]
    {
        check_hidden_resize(&application);
        check_screen_resize(&application);
    }
}
