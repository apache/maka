//! Dialogs in windows of the app's own (#1451): a dialog in a window's
//! first render is presented in the batch that opens the window, before
//! the window exists, and must still show over that window, not over the
//! main one. Checked for a window opened with `open_window`, one declared
//! in the tree with `window().open(..)`, and a dialog that mounts once its
//! window is open (#1217), read from the real AppKit windows: the window
//! each dialog's view is in, its size, and that none is left over the main
//! window once the windows close.

use std::{
    cell::RefCell,
    rc::Rc,
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

use nsh_core::{
    element::{
        desktop::{WindowRef, open_window, window},
        modal,
    },
    prelude::*,
};
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize, NSString},
};

/// What the app does next: 1 opens the windows, 2 shows the late dialog,
/// 3 closes the windows.
static STEP: AtomicUsize = AtomicUsize::new(0);

/// The dialogs, by test id, with the test id of their window's content.
const DIALOGS: [(&str, &str); 3] = [
    ("first-dialog", "first-content"),
    ("declared-dialog", "declared-content"),
    ("late-dialog", "late-content"),
];

/// A dialog filling its window, as the issue's.
fn dialog(id: &'static str) -> impl IntoElement {
    modal().child(
        view()
            .test_id(id)
            .flex_1()
            .items_center()
            .justify_center()
            .child(text(id)),
    )
}

/// The main window's content: steps through [`STEP`].
#[component]
fn Windows() -> impl IntoElement {
    let declared = signal(false);
    let late = signal(false);
    let opened: Rc<RefCell<Vec<WindowRef>>> = Rc::default();
    let done = signal(0);
    set_interval(Duration::from_millis(5), move || {
        let step = STEP.load(Ordering::SeqCst);
        if done.get_untracked() >= step {
            return;
        }
        done.set(step);
        match step {
            1 => {
                // A dialog in the window's first render.
                opened.borrow_mut().extend(open_window(
                    window().id("first").title("First").content(|| {
                        view()
                            .test_id("first-content")
                            .flex_1()
                            .child(text("First window"))
                            .child(dialog("first-dialog"))
                    }),
                ));
                // A dialog that mounts once its window is open.
                opened
                    .borrow_mut()
                    .extend(open_window(window().id("late").title("Late").content(
                        move || {
                            view()
                                .test_id("late-content")
                                .flex_1()
                                .child(text("Late window"))
                                .child(when(move || late.get(), || dialog("late-dialog")))
                        },
                    )));
                // A window declared in the tree.
                declared.set(true);
            }
            2 => late.set(true),
            3 => {
                for w in opened.borrow_mut().drain(..) {
                    w.close();
                }
                declared.set(false);
            }
            _ => {}
        }
    });
    view()
        .test_id("main-content")
        .flex_1()
        .child(text("Main window"))
        .child(
            window()
                .id("declared")
                .title("Declared")
                .open(declared)
                .on_open_change(move |e| declared.set(e.open))
                .content(|| {
                    view()
                        .test_id("declared-content")
                        .flex_1()
                        .child(text("Declared window"))
                        .child(dialog("declared-dialog"))
                }),
        )
}

/// The view whose accessibility identifier is `id` in `view`.
fn find_in(view: &NSView, id: &str) -> Option<Retained<NSView>> {
    if view
        .accessibilityIdentifier()
        .is_some_and(|value| value.to_string() == id)
    {
        return Some(view.retain());
    }
    view.subviews().iter().find_map(|child| find_in(&child, id))
}

/// The view `id` in any of the app's windows.
fn find(mtm: MainThreadMarker, id: &str) -> Option<Retained<NSView>> {
    NSApplication::sharedApplication(mtm)
        .windows()
        .iter()
        .filter(|w| w.isVisible())
        .find_map(|w| find_in(&*w.contentView()?, id))
}

/// Runs the main run loop until `done` holds, for at most five seconds.
fn until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "{what} never happened");
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
    }
}

/// Runs the main run loop for `seconds`.
fn settle(seconds: f64) {
    NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(seconds));
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().expect("the checks run on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.finishLaunching();
    STEP.store(0, Ordering::SeqCst);
    // SAFETY: The window is created on the process main thread.
    let main = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(100.0, 100.0), NSSize::new(480.0, 360.0)),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Closable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe { main.setReleasedWhenClosed(false) };
    main.setTitle(&NSString::from_str("NSH window dialog regression"));
    let options = platform::AppOptions {
        size: (480, 360),
        ..Default::default()
    };
    let surface: Rc<platform::AppView> = platform::AppView::new(mtm, options);
    main.setContentView(Some(&surface.view()));
    surface.load(platform::App::Rust(platform::Root::of::<Windows>()));
    main.orderFront(None);
    until("the main window's content", || {
        find(mtm, "main-content").is_some()
    });

    STEP.store(1, Ordering::SeqCst);
    until("the windows' content", || {
        DIALOGS
            .iter()
            .all(|(_, content)| find(mtm, content).is_some())
    });
    until("the first render's dialogs", || {
        DIALOGS[..2]
            .iter()
            .all(|(dialog, _)| find(mtm, dialog).is_some())
    });
    STEP.store(2, Ordering::SeqCst);
    until("the late dialog", || find(mtm, "late-dialog").is_some());
    // The windows show with their first frames.
    settle(0.3);

    let mut failures = Vec::new();
    for (dialog, content) in DIALOGS {
        let dialog_view = find(mtm, dialog).expect("shown");
        let content_view = find(mtm, content).expect("shown");
        let (Some(at), Some(own)) = (dialog_view.window(), content_view.window()) else {
            failures.push(format!(
                "`{dialog}` or its window's content is in no window"
            ));
            continue;
        };
        if at == main {
            failures.push(format!("`{dialog}` shows over the main window"));
        } else if at != own {
            failures.push(format!("`{dialog}` shows over another window"));
        } else {
            // It covers its window's content area.
            let size = dialog_view.frame().size;
            let area = own.contentView().expect("a content view").bounds().size;
            if (size.width - area.width).abs() > 0.5 || (size.height - area.height).abs() > 0.5 {
                failures.push(format!(
                    "`{dialog}` is {}x{}, its window {}x{}",
                    size.width, size.height, area.width, area.height
                ));
            }
        }
    }

    STEP.store(3, Ordering::SeqCst);
    until("the windows closing", || {
        DIALOGS
            .iter()
            .all(|(_, content)| find(mtm, content).is_none())
    });
    settle(0.5);
    let root = surface.view();
    for (dialog, _) in DIALOGS {
        if find_in(&root, dialog).is_some() {
            failures.push(format!("`{dialog}` stays over the main window"));
        }
    }

    surface.stop();
    main.close();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    println!(
        "window_dialog: {} dialogs over their own windows",
        DIALOGS.len()
    );
}
