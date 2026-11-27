//! Ending `refreshing` on a vertical scroll view keeps all eight gradient
//! spokes turning and fades the spinner out while the list retracts back to
//! 0, including when `contentInset.top` keeps the spinner inside the viewport
//! up to the final frame and when no `onRefresh` listener is attached.
//! The window is ordered in without activating the app.
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use nsh_core::prelude::*;
use nsh_platform_macos as platform;
use objc2_quartz_core::CALayer;
use platform::{
    objc2::{
        MainThreadMarker, MainThreadOnly, Message,
        rc::{Retained, autoreleasepool},
    },
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSBitmapImageFileType,
        NSBitmapImageRepPropertyKey, NSColor, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSDictionary, NSPoint, NSRect, NSRunLoop, NSSize, NSString},
};

/// The test clears it to end `refreshing` on all lists.
static REFRESHING: AtomicBool = AtomicBool::new(true);

fn rows(prefix: &'static str) -> impl IntoElement {
    view().children((0..20).map(move |i| {
        view()
            .h(px(36.0))
            .px(px(12.0))
            .justify_center()
            .bg(rgb(if i % 2 == 0 { 0xf5f6f8 } else { 0xffffff }))
            .child(text(format!("{prefix} Row {i}")))
            .into_element()
    }))
}

#[component]
fn Lists() -> impl IntoElement {
    let refreshing = signal(true);
    set_interval(Duration::from_millis(5), move || {
        refreshing.set(REFRESHING.load(Ordering::SeqCst))
    });
    view()
        .flex_1()
        .bg(rgb(0xffffff))
        .p(px(12.0))
        .gap(px(10.0))
        .child(
            scroll()
                .test_id("with_handler")
                .h(px(140.0))
                .bg(rgb(0xfafbfc))
                .on_refresh(|_: &()| {})
                .refreshing(refreshing)
                .child(rows("Handler")),
        )
        .child(
            scroll()
                .test_id("controlled_only")
                .h(px(140.0))
                .bg(rgb(0xfafbfc))
                .refreshing(refreshing)
                .child(rows("Controlled")),
        )
        .child(
            scroll()
                .test_id("with_inset")
                .h(px(160.0))
                .bg(rgb(0xfafbfc))
                .content_inset(EdgeInsets {
                    top: px(48.0),
                    ..EdgeInsets::default()
                })
                .on_refresh(|_: &()| {})
                .refreshing(refreshing)
                .child(rows("Inset 48")),
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

struct SpinnerSnapshot {
    opacity: f32,
    visible_spokes: usize,
    alpha_spread: f64,
    lead: Option<usize>,
    center_y: f64,
}

/// Reads the visible refresh spinner of `list` (layer opacity, visible spoke
/// count, max-minus-min spoke background alpha, brightest spoke index, and
/// center y), or `None` when hidden.
fn spinner_snapshot(list: &NSView) -> Option<SpinnerSnapshot> {
    list.subviews().iter().find_map(|v| {
        if v.class().name().to_str() != Ok("NshScrollOverlay") {
            return None;
        }
        let overlay = v.layer()?;
        // SAFETY: getter on the main thread.
        let sublayers = unsafe { overlay.sublayers() }?;
        sublayers.iter().find_map(|layer: Retained<CALayer>| {
            // SAFETY: getter on the main thread.
            let spokes = unsafe { layer.sublayers() }?;
            if spokes.count() != 8 || layer.isHidden() {
                return None;
            }
            let mut visible_spokes = 0;
            let mut min_alpha = f64::INFINITY;
            let mut max_alpha = 0.0_f64;
            let mut lead = None;
            for (i, spoke) in spokes.iter().enumerate() {
                if spoke.isHidden() {
                    continue;
                }
                visible_spokes += 1;
                if let Some(cg) = spoke.backgroundColor()
                    && let Some(color) = NSColor::colorWithCGColor(&cg)
                {
                    let a = color.alphaComponent();
                    min_alpha = min_alpha.min(a);
                    if a > max_alpha {
                        max_alpha = a;
                        lead = Some(i);
                    }
                }
            }
            Some(SpinnerSnapshot {
                opacity: layer.opacity(),
                visible_spokes,
                alpha_spread: if visible_spokes > 0 {
                    max_alpha - min_alpha
                } else {
                    0.0
                },
                lead,
                center_y: layer.position().y,
            })
        })
    })
}

fn screenshot(root: &NSView, name: &str) {
    let Some(directory) = std::env::var_os("NSH_REFRESH_DISMISS_SCREENSHOTS") else {
        return;
    };
    root.displayIfNeeded();
    let bounds = root.bounds();
    let bitmap = root
        .bitmapImageRepForCachingDisplayInRect(bounds)
        .expect("bitmap");
    root.cacheDisplayInRect_toBitmapImageRep(bounds, &bitmap);
    let properties =
        NSDictionary::<NSBitmapImageRepPropertyKey, platform::objc2::runtime::AnyObject>::new();
    // SAFETY: an empty dictionary is valid for PNG.
    let png = unsafe {
        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
    }
    .expect("PNG");
    let directory = std::path::PathBuf::from(directory);
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join(format!("{name}.png")), png.to_vec()).unwrap();
}

fn pump(ms: f64) {
    autoreleasepool(|_| {
        NSRunLoop::currentRunLoop()
            .runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(ms / 1000.0));
    });
}

fn until(what: &str, mut done: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(5);
    while !autoreleasepool(|_| done()) {
        assert!(Instant::now() < end, "{what}");
        pump(5.0);
    }
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    NSApplication::sharedApplication(mtm).finishLaunching();
    REFRESHING.store(true, Ordering::SeqCst);
    // SAFETY: The window is created on the process main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(760.0, 220.0), NSSize::new(360.0, 500.0)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe {
        window.setReleasedWhenClosed(false);
    }
    window.setTitle(&NSString::from_str("NSH refresh dismiss"));
    let app = platform::AppView::new(
        mtm,
        platform::AppOptions {
            size: (360, 500),
            ..Default::default()
        },
    );
    window.setContentView(Some(&app.view()));
    app.load(platform::App::Rust(platform::Root::of::<Lists>()));
    window.orderFrontRegardless();
    let root = app.view();

    let ids = ["with_handler", "controlled_only", "with_inset"];
    until("all lists mount", || {
        ids.iter().all(|id| find(&root, id).is_some())
    });
    // Wait until all spinners settle into the refreshing inset at full opacity.
    until("all refresh spinners show at full gradient", || {
        ids.iter().all(|id| {
            find(&root, id)
                .and_then(|v| spinner_snapshot(&v))
                .is_some_and(|s| {
                    s.visible_spokes == 8 && s.alpha_spread > 0.5 && (s.opacity - 1.0).abs() < 1e-3
                })
        })
    });
    // Let the reveal animation finish so all views rest at -56pt.
    for _ in 0..70 {
        pump(5.0);
    }
    autoreleasepool(|_| screenshot(&root, "01-refreshing"));

    REFRESHING.store(false, Ordering::SeqCst);
    let mut saw_fading = [false; 3];
    let mut first_lead: [Option<usize>; 3] = [None; 3];
    let mut saw_spin_advance = [false; 3];
    let mut saw_inset_in_viewport = false;
    let mut shot_mid = false;
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        let mut all_hidden = true;
        autoreleasepool(|_| {
            for (idx, id) in ids.iter().enumerate() {
                let list = find(&root, id).expect("list stays mounted");
                if let Some(s) = spinner_snapshot(&list) {
                    all_hidden = false;
                    assert_eq!(
                        s.visible_spokes, 8,
                        "{id}: dismissal dropped spokes instead of keeping all 8"
                    );
                    assert!(
                        s.alpha_spread > 0.5,
                        "{id}: dismissal snapped spokes to flat opacity (spread={})",
                        s.alpha_spread
                    );
                    if s.opacity > 0.0 && s.opacity < 0.99 {
                        saw_fading[idx] = true;
                        if idx == 2 && s.center_y > 20.0 {
                            saw_inset_in_viewport = true;
                        }
                        if !shot_mid && idx == 2 && s.opacity < 0.6 {
                            screenshot(&root, "02-dismiss-mid");
                            shot_mid = true;
                        }
                    }
                    if let Some(lead) = s.lead {
                        match first_lead[idx] {
                            None => first_lead[idx] = Some(lead),
                            Some(first) if first != lead => saw_spin_advance[idx] = true,
                            _ => {}
                        }
                    }
                }
            }
        });
        if all_hidden {
            break;
        }
        assert!(Instant::now() < end, "spinners never finished retracting");
        pump(5.0);
    }
    autoreleasepool(|_| screenshot(&root, "03-dismiss-done"));
    for (idx, id) in ids.iter().enumerate() {
        assert!(
            saw_fading[idx],
            "{id}: expected to observe spinner fading out during dismissal"
        );
        assert!(
            saw_spin_advance[idx],
            "{id}: expected spinner lead spoke to keep advancing during dismissal"
        );
    }
    assert!(
        saw_inset_in_viewport,
        "with_inset: expected fading spinner to stay inside viewport under contentInset.top = 48"
    );
    println!(
        "refresh_dismiss: all spinners kept 8 turning gradient spokes and faded out while retracting"
    );
    app.stop();
    window.close();
}
