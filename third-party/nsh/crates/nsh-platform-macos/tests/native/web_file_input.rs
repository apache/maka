//! A web page's `<input type="file">` shows the open panel (WKUIDelegate
//! `webView:runOpenPanelWithParameters:...`): without the delegate method
//! WebKit shows nothing and the page never hears back. The page's own
//! `cancel` event shows WebKit got the answer; the app stopping with the
//! panel up takes the panel away and still answers WebKit once (an
//! unanswered completion handler raises in WebKit).
//!
//! Read from the real AppKit windows, as `file_panels.rs`. Needs a desktop
//! session with the screen unlocked. Runs on its own:
//! `NSH_WEB_FILE_INPUT_CHECK_ONLY=1 cargo test -p nsh-platform-macos --test native -- --ignored`.

use std::{
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use nsh_core::prelude::*;
use nsh_platform_macos as platform;
use platform::{
    objc2::{MainThreadMarker, MainThreadOnly, msg_send, rc::Retained},
    objc2_app_kit::{NSApplication, NSBackingStoreType, NSWindow, NSWindowStyleMask},
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize, NSString},
};

/// What the page posted, in order (the app runs on the engine's thread).
static HEARD: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Whether the page puts its input in a modal `<dialog>` (`showModal()`).
static MODAL: AtomicBool = AtomicBool::new(false);

const PAGE: &str = r#"<body>
<input id="f" type="file" multiple>
<script>
  const f = document.getElementById("f");
  f.addEventListener("cancel", () => window.nsh.postMessage("cancel"));
  f.addEventListener("change", () => window.nsh.postMessage("change " + f.files.length));
  window.nsh.postMessage("ready");
</script>
</body>"#;

const MODAL_PAGE: &str = r#"<body>
<dialog id="d"><input id="f" type="file" multiple></dialog>
<script>
  document.getElementById("d").showModal();
  const f = document.getElementById("f");
  f.addEventListener("cancel", () => window.nsh.postMessage("cancel"));
  f.addEventListener("change", () => window.nsh.postMessage("change " + f.files.length));
  window.nsh.postMessage("ready");
</script>
</body>"#;

/// A page with a file input; clicks it (a script the app runs counts as
/// the user's gesture) once the page is up.
#[component]
fn Page() -> impl IntoElement {
    let page = element_ref();
    view().flex_1().child(
        web_view_html(
            if MODAL.load(Ordering::SeqCst) {
                MODAL_PAGE
            } else {
                PAGE
            },
            None,
        )
        .element_ref(&page)
        .h(px(300.0))
        .on_message(move |data: &str| {
            HEARD.lock().unwrap().push(data.to_owned());
            if data == "ready" {
                spawn(async move {
                    drop(
                        page.evaluate(
                            "document.getElementById('f').click(); true",
                            Default::default(),
                        )
                        .await,
                    );
                });
            }
        }),
    )
}

/// The process's visible open panels (sheets included).
fn open_panels(mtm: MainThreadMarker) -> Vec<Retained<NSWindow>> {
    NSApplication::sharedApplication(mtm)
        .windows()
        .iter()
        .filter(|w| w.isVisible() && w.class().name().to_string_lossy().contains("OpenPanel"))
        .collect()
}

fn heard(what: &str) -> bool {
    HEARD.lock().unwrap().iter().any(|m| m == what)
}

/// Runs the main run loop until `done` holds, for at most 10 s.
fn until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !done() {
        assert!(Instant::now() < deadline, "{what} never happened");
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.01));
    }
}

fn pump(seconds: f64) {
    let end = Instant::now() + Duration::from_secs_f64(seconds);
    while Instant::now() < end {
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.01));
    }
}

fn new_window(mtm: MainThreadMarker) -> Retained<NSWindow> {
    // SAFETY: The window is created on the process main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(600.0, 300.0), NSSize::new(500.0, 400.0)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(&NSString::from_str("NSH web file input"));
    window
}

/// Loads the page, waits for its file input's panel, then `end` ends it.
fn check(mtm: MainThreadMarker, what: &str, end: impl FnOnce(&platform::AppView, &NSWindow)) {
    assert!(open_panels(mtm).is_empty(), "a panel is up before {what}");
    HEARD.lock().unwrap().clear();
    let window = new_window(mtm);
    let surface = platform::AppView::new(mtm, platform::AppOptions::default());
    window.setContentView(Some(&surface.view()));
    window.makeKeyAndOrderFront(None);
    surface.load(platform::App::Rust(platform::Root::of::<Page>()));
    until("the page", || heard("ready"));
    until("the open panel for the file input", || {
        open_panels(mtm).len() == 1
    });
    let panel = open_panels(mtm).remove(0);
    // SAFETY: an NSOpenPanel, on the main thread.
    let multiple: bool = unsafe { msg_send![&panel, allowsMultipleSelection] };
    assert!(multiple, "`multiple` input, single-selection panel");
    end(&surface, &panel);
    until(&format!("the panel gone after {what}"), || {
        open_panels(mtm).is_empty()
    });
    // WebKit drops the completion handler soon after: it raises if unanswered.
    pump(0.5);
    drop(surface);
    window.close();
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    // Cancelled by the user: the page hears its `cancel` event.
    check(mtm, "cancel", |_, panel| {
        // SAFETY: AppKit's documented NSSavePanel `cancel:`, on the main thread.
        unsafe {
            let _: () =
                msg_send![panel, cancel: std::ptr::null::<platform::objc2::runtime::AnyObject>()];
        }
        until("the page's cancel event", || heard("cancel"));
    });
    // The app stopped with the panel up: the panel goes, WebKit is answered.
    check(mtm, "stop", |surface, _| surface.stop());
    // The input in a modal dialog: the same panel, the same answer.
    MODAL.store(true, Ordering::SeqCst);
    check(mtm, "cancel in a modal dialog", |_, panel| {
        // SAFETY: AppKit's documented NSSavePanel `cancel:`, on the main thread.
        unsafe {
            let _: () =
                msg_send![panel, cancel: std::ptr::null::<platform::objc2::runtime::AnyObject>()];
        }
        until("the page's cancel event", || heard("cancel"));
    });
    MODAL.store(false, Ordering::SeqCst);
    println!(
        "web file input: the open panel shows (in a modal dialog too), answers the page, closes with the app"
    );
}
