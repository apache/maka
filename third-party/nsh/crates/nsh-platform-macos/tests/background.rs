//! What an embedded `AppView` paints under its app: a real `AppView` in a
//! window (made as a host app makes one, not by `run_app`), the colour read
//! from the layer of the view holding the root, as Core Animation draws it.
//! Where the app paints nothing the host shows through, in light and dark;
//! an opaque top view filling the root paints its own colour there. AppKit
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

    use nsh_core::{element::Root, prelude::*};
    use nsh_platform_macos::{
        AppOptions, AppView, Appearance,
        objc2::{MainThreadMarker, MainThreadOnly},
        objc2_app_kit::{
            NSAccessibility, NSApplication, NSBackingStoreType, NSColor, NSColorSpace, NSView,
            NSWindow, NSWindowStyleMask,
        },
        objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize},
    };

    /// A text at the top: it covers neither the view nor paints a background.
    #[component]
    fn Sparse() -> impl IntoElement {
        view().test_id("content").child(text("Hello"))
    }

    /// A top view filling the root, painted opaque.
    #[component]
    fn Filled() -> impl IntoElement {
        view()
            .test_id("content")
            .size_full()
            .bg(rgb(0x3366cc))
            .child(text("Hello"))
    }

    /// Runs the main run loop until `done` holds, for at most 5 s.
    fn until(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !done() {
            assert!(Instant::now() < deadline, "{what} never happened");
            let soon = NSDate::dateWithTimeIntervalSinceNow(0.02);
            NSRunLoop::currentRunLoop().runUntilDate(&soon);
        }
    }

    /// Whether `view` or a view under it has accessibility identifier `id`.
    fn has(view: &NSView, id: &str) -> bool {
        view.accessibilityIdentifier()
            .is_some_and(|i| i.to_string() == id)
            || view.subviews().iter().any(|v| has(&v, id))
    }

    /// The sRGB components of the layer background of `view` (`None`: no
    /// colour).
    fn background(view: &NSView) -> Option<[f64; 4]> {
        let cg = view.layer()?.backgroundColor()?;
        let color =
            NSColor::colorWithCGColor(&cg)?.colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())?;
        Some([
            color.redComponent(),
            color.greenComponent(),
            color.blueComponent(),
            color.alphaComponent(),
        ])
    }

    /// Mounts `root` in an `AppView` of a window in `appearance`, runs it
    /// to its first mount and returns the surface's background after it.
    fn painted(mtm: MainThreadMarker, appearance: Appearance, root: Root) -> Option<[f64; 4]> {
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
        let app = AppView::new(
            mtm,
            AppOptions {
                size: (400, 300),
                appearance,
                ..AppOptions::default()
            },
        );
        let view = app.view();
        window.setContentView(Some(&view));
        window.orderFrontRegardless();
        app.load(root.into());
        until("the first mount", || has(&view, "content"));
        // The batch that mounted it has ended: the background follows it.
        let soon = NSDate::dateWithTimeIntervalSinceNow(0.1);
        NSRunLoop::currentRunLoop().runUntilDate(&soon);
        let color = background(&view);
        app.stop();
        window.close();
        color
    }

    pub(super) fn run() {
        let mtm = MainThreadMarker::new().expect("the main thread");
        let _app = NSApplication::sharedApplication(mtm);

        // Where the app paints nothing, an embedded view paints nothing:
        // the host shows through, whatever the scheme.
        for appearance in [Appearance::Light, Appearance::Dark] {
            let color = painted(mtm, appearance, Root::of::<Sparse>());
            assert!(
                color.is_none_or(|c| c[3] == 0.0),
                "{appearance:?}: the embedded view paints {color:?} under its app"
            );
        }

        // An opaque top view filling the root: its colour is painted.
        let color = painted(mtm, Appearance::Light, Root::of::<Filled>())
            .expect("the top view's colour under the root");
        let expected = [
            0x33 as f64 / 255.0,
            0x66 as f64 / 255.0,
            0xcc as f64 / 255.0,
            1.0,
        ];
        assert!(
            color
                .iter()
                .zip(expected)
                .all(|(c, e)| (c - e).abs() < 0.01),
            "painted {color:?}, not the top view's {expected:?}"
        );

        println!("background: ok");
    }
}
