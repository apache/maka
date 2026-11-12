//! Frames reach a window of the app's own while the main window is out of
//! sight, as a tray app's (nsh.json `window.defaultVisible: false`). A
//! surface's one display link drives all of its windows, and AppKit fires
//! a view's link only while some of the view's window shows on a screen:
//! made from the hidden main window's root, it gave the app's window no
//! frames at all (its frame requests waited for ever, and a trackpad
//! scroll in it froze under the fingers). The app counts the frames it gets
//! (`next_frame`) in its own window over half a second: with the main
//! window never shown, then with the main window shown and the app's window
//! hidden, where the link moves back to the main window. Needs a desktop
//! session with the screen unlocked: a locked screen shows no window, and
//! no link fires.

use std::{
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

use nsh_core::{element::desktop::window, prelude::*};
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, rc::Retained},
    objc2_app_kit::{
        NSApplication, NSBackingStoreType, NSEventMask, NSWindow, NSWindowOcclusionState,
        NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSDefaultRunLoopMode, NSPoint, NSRect, NSSize, NSString},
};

/// The display frames the app got.
static FRAMES: AtomicUsize = AtomicUsize::new(0);

/// The title of the app's own window.
const TITLE: &str = "NSH frames beside a hidden main window";

/// The fewest frames half a second must give: a frame every other refresh
/// at 60 Hz is 15. A link that does not fire gives none.
const FEWEST: usize = 10;

/// Counts the display frames the app gets while it shows.
#[component]
fn FrameCounter() -> impl IntoElement {
    spawn(async {
        loop {
            next_frame().await;
            FRAMES.fetch_add(1, Ordering::SeqCst);
        }
    });
    view().size_full().child(text("Counting frames"))
}

/// The main window's content: a window of the app's own, which counts the
/// frames.
#[component]
fn Tray() -> impl IntoElement {
    view().size_full().child(
        window()
            .id("frames")
            .title(TITLE)
            .default_size(size(px(320.0), px(200.0)))
            .content(frame_counter),
    )
}

/// Runs the app for `ms` milliseconds: its events (the window server's
/// too, which tell the windows' occlusion), the main queue and the display
/// link.
fn pump(ms: u64) {
    let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
    let deadline = Instant::now() + Duration::from_millis(ms);
    // SAFETY: AppKit's immutable default run-loop mode.
    let mode = unsafe { NSDefaultRunLoopMode };
    while Instant::now() < deadline {
        if let Some(event) = app.nextEventMatchingMask_untilDate_inMode_dequeue(
            NSEventMask::Any,
            Some(&NSDate::dateWithTimeIntervalSinceNow(0.005)),
            mode,
            true,
        ) {
            app.sendEvent(&event);
        }
        app.updateWindows();
    }
}

/// Runs the app until `found` finds something, for at most five seconds.
fn until<T>(what: &str, mut found: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(value) = found() {
            return value;
        }
        assert!(Instant::now() < deadline, "{what} never happened");
        pump(10);
    }
}

/// Whether some of `window` shows on a screen, as the window server tells:
/// its views' display links fire then.
fn shows(window: &NSWindow) -> bool {
    window.isVisible()
        && window
            .occlusionState()
            .contains(NSWindowOcclusionState::Visible)
}

/// The frames the app gets in `ms` milliseconds.
fn frames_in(ms: u64) -> usize {
    let before = FRAMES.load(Ordering::SeqCst);
    pump(ms);
    FRAMES.load(Ordering::SeqCst) - before
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().expect("the checks run on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.finishLaunching();
    FRAMES.store(0, Ordering::SeqCst);
    // The main window, never shown, as a tray app's.
    // SAFETY: The window is created on the process main thread.
    let main = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(100.0, 100.0), NSSize::new(400.0, 240.0)),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Closable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe { main.setReleasedWhenClosed(false) };
    main.setTitle(&NSString::from_str("NSH hidden main window"));
    let options = platform::AppOptions {
        size: (400, 240),
        ..Default::default()
    };
    let surface = platform::AppView::new(mtm, options);
    main.setContentView(Some(&surface.view()));
    surface.load(platform::App::Rust(platform::Root::of::<Tray>()));

    // The app's window shows with its first frame; the window server tells
    // a moment later that it does, and the link moves to it.
    let own: Retained<NSWindow> = until("the app's window on the screen", || {
        app.windows()
            .iter()
            .find(|w| w.title().to_string() == TITLE && shows(w))
    });
    assert!(!main.isVisible(), "the main window stays hidden");
    pump(200);
    let beside_hidden = frames_in(500);

    // The main window shows and the app's window hides (its content still
    // asks for frames): the link moves back to the main window's root.
    main.orderFrontRegardless();
    own.orderOut(None);
    until("the main window on the screen", || {
        shows(&main).then_some(())
    });
    pump(200);
    let main_shown = frames_in(500);

    surface.stop();
    main.close();
    println!(
        "window_frames: {beside_hidden} frames in 0.5 s beside the hidden main window, \
         {main_shown} with the main window shown and the app's window hidden"
    );
    assert!(
        beside_hidden >= FEWEST,
        "the app's window must get frames while the main window is hidden \
         ({beside_hidden} in 0.5 s)"
    );
    assert!(
        main_shown >= FEWEST,
        "the link must move back to the main window once the app's window hides \
         ({main_shown} in 0.5 s)"
    );
}
