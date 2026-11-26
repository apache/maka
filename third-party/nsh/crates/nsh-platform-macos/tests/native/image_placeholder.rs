//! An image's placeholder that is still loading when the image's filters
//! change (a hover blur, a grayscale toggle) still shows once it loads. The
//! filter change decodes the source again under a new generation, which
//! made the placeholder's result stale: it was dropped, yet its load stayed
//! recorded, so nothing asked for the placeholder again and the view stayed
//! empty. The load that was in flight is kept (one request in all: a
//! filter change does no placeholder work). Two local servers on
//! 127.0.0.1: the placeholder's holds its response until the check
//! releases it, the source's never answers.
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU16, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use nsh_core::prelude::*;
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize},
};
use objc2_quartz_core::CALayer;

static PLACEHOLDER_PORT: AtomicU16 = AtomicU16::new(0);
static SOURCE_PORT: AtomicU16 = AtomicU16::new(0);
static GRAYSCALE: AtomicBool = AtomicBool::new(false);

/// A 1x1 red PNG.
const PNG: [u8; 70] = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0,
    0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

/// Answers every connection with the PNG once `release` is set (each on a
/// thread of its own, giving up after 30 s), and counts the connections.
fn serve(release: Arc<AtomicBool>) -> (u16, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a local port");
    let port = listener.local_addr().unwrap().port();
    let requests = Arc::new(AtomicUsize::new(0));
    let counted = requests.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let release = release.clone();
            let counted = counted.clone();
            std::thread::spawn(move || {
                let mut buffer = [0u8; 4096];
                let _ = stream.read(&mut buffer);
                counted.fetch_add(1, Ordering::SeqCst);
                let end = Instant::now() + Duration::from_secs(30);
                while !release.load(Ordering::SeqCst) && Instant::now() < end {
                    std::thread::sleep(Duration::from_millis(5));
                }
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\n\
                     Connection: close\r\n\r\n",
                    PNG.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&PNG);
            });
        }
    });
    (port, requests)
}

#[component]
fn Scene() -> impl IntoElement {
    let gray = signal(false);
    set_interval(Duration::from_millis(5), move || {
        let next = GRAYSCALE.load(Ordering::SeqCst);
        if gray.get_untracked() != next {
            gray.set(next);
        }
    });
    let url = |port: &AtomicU16, name: &str| {
        format!(
            "http://127.0.0.1:{}/{name}.png",
            port.load(Ordering::SeqCst)
        )
    };
    view().size_full().child(
        image(url(&SOURCE_PORT, "source"))
            .placeholder(url(&PLACEHOLDER_PORT, "placeholder"))
            .style_when(gray, |s| s.grayscale(1.0))
            .test_id("pic")
            .w(px(64.0))
            .h(px(64.0)),
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

/// Whether `layer` or a layer below it shows a picture.
fn has_contents(layer: &CALayer) -> bool {
    // SAFETY: the main thread owns the layer tree.
    unsafe {
        layer.contents().is_some()
            || layer
                .sublayers()
                .is_some_and(|l| l.iter().any(|l| has_contents(&l)))
    }
}

/// Runs the main run loop until `done` holds or `seconds` pass.
fn pump_until(seconds: f64, mut done: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + Duration::from_secs_f64(seconds);
    while Instant::now() < end {
        if done() {
            return true;
        }
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
    }
    done()
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    NSApplication::sharedApplication(mtm).finishLaunching();
    let release = Arc::new(AtomicBool::new(false));
    let (placeholder_port, placeholder_requests) = serve(release.clone());
    // Never answers (until the check ends): the placeholder is all there is
    // to show.
    let (source_port, _) = serve(Arc::new(AtomicBool::new(false)));
    PLACEHOLDER_PORT.store(placeholder_port, Ordering::SeqCst);
    SOURCE_PORT.store(source_port, Ordering::SeqCst);
    GRAYSCALE.store(false, Ordering::SeqCst);

    // SAFETY: main-thread creation; retained until after close.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(120.0, 120.0), NSSize::new(160.0, 160.0)),
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
            size: (160, 160),
            ..Default::default()
        },
    );
    window.setContentView(Some(&app.view()));
    window.orderFront(None);
    app.load(platform::App::Rust(platform::Root::of::<Scene>()));

    assert!(
        pump_until(5.0, || placeholder_requests.load(Ordering::SeqCst) >= 1),
        "the placeholder was never requested"
    );
    // The filters change while the placeholder is still loading.
    GRAYSCALE.store(true, Ordering::SeqCst);
    pump_until(0.5, || false);
    let picture = find(&app.view(), "pic").expect("the image view");
    assert!(
        !picture.layer().is_some_and(|l| has_contents(&l)),
        "the placeholder shows before its response was sent"
    );

    release.store(true, Ordering::SeqCst);
    let shown = pump_until(5.0, || picture.layer().is_some_and(|l| has_contents(&l)));
    assert!(
        shown,
        "the placeholder that loaded after the image's filters changed is not shown"
    );
    // The load that was in flight when the filters changed was neither
    // cancelled nor asked for again.
    assert_eq!(
        placeholder_requests.load(Ordering::SeqCst),
        1,
        "a filter change must not re-request the placeholder"
    );
    println!("image_placeholder: a placeholder loading across a filter change still shows");

    app.stop();
    window.close();
}
