//! Modal dismissal restores keyboard input to editors whose caret sinks
//! deliberately reject pointer targeting, without reviving stale focus.
use std::{
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::{Duration, Instant},
};

use nsh_core::{
    ModalAnimation,
    element::{input, modal},
    prelude::*,
};
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, Message, msg_send, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSBitmapImageFileType,
        NSBitmapImageRepPropertyKey, NSTextView, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{
        NSDate, NSDictionary, NSPoint, NSRange, NSRect, NSRunLoop, NSSize, NSString,
    },
};

static KIND: AtomicUsize = AtomicUsize::new(0);
static OPEN: AtomicBool = AtomicBool::new(false);
static REMOVED: AtomicBool = AtomicBool::new(false);
static HIDDEN: AtomicBool = AtomicBool::new(false);
static TYPED: AtomicBool = AtomicBool::new(false);

#[component]
fn Scene() -> impl IntoElement {
    let open = signal(false);
    let removed = signal(false);
    let hidden = signal(false);
    set_interval(Duration::from_millis(5), move || {
        open.set(OPEN.load(Ordering::SeqCst));
        removed.set(REMOVED.load(Ordering::SeqCst));
        hidden.set(HIDDEN.load(Ordering::SeqCst));
    });
    let kind = KIND.load(Ordering::SeqCst);
    view()
        .flex_1()
        .bg(rgb(0xffffff))
        .text_color(rgb(0x111111))
        .p_4()
        .gap_4()
        .child(text("Editor focus after a dialog"))
        .child(when(
            move || !removed.get(),
            move || {
                let source = match kind {
                    #[cfg(feature = "editor")]
                    1 => nsh_base::editor()
                        .on_change(|text: &SharedString| {
                            TYPED.store(text.as_ref() == "Restored", Ordering::SeqCst);
                        })
                        .size_full()
                        .into_element(),
                    #[cfg(feature = "rich-editor")]
                    2 => nsh_base::rich_editor::view::rich_editor()
                        .on_change(|change: &nsh_base::rich_editor::view::RichEditorChange| {
                            TYPED.store(change.revision > 0, Ordering::SeqCst);
                        })
                        .size_full()
                        .into_element(),
                    _ => input()
                        .multiline(true)
                        .pointer_events(if kind == 0 {
                            PointerEvents::None
                        } else {
                            PointerEvents::Auto
                        })
                        .on_change(|text: &str| {
                            TYPED.store(text == "Restored", Ordering::SeqCst);
                        })
                        .size_full()
                        .into_element(),
                };
                view()
                    .test_id("source")
                    .style_when(move || hidden.get(), |s| s.invisible())
                    .w_full()
                    .h(px(100.0))
                    .child(source)
            },
        ))
        .child(input().test_id("other").multiline(true).h(px(40.0)))
        .child(when(
            move || open.get(),
            || {
                modal()
                    .test_id("focus-modal")
                    .animation(ModalAnimation::None)
                    .child(
                        input()
                            .test_id("dialog-input")
                            .multiline(true)
                            .w(px(240.0))
                            .h(px(40.0)),
                    )
            },
        ))
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

fn text_view(view: &NSView) -> Option<Retained<NSView>> {
    if view.downcast_ref::<NSTextView>().is_some() {
        return Some(view.retain());
    }
    view.subviews().iter().find_map(|v| text_view(&v))
}

fn pump() {
    NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
}

fn until(what: &str, mut done: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < end, "{what}");
        pump();
    }
}

fn focused(window: &NSWindow, view: &NSView) -> bool {
    window.firstResponder().is_some_and(|r| {
        r.downcast_ref::<NSView>()
            .is_some_and(|v| v.isDescendantOf(view))
    })
}

fn open(window: &NSWindow, root: &NSView) {
    OPEN.store(true, Ordering::SeqCst);
    until("dialog mounted", || find(root, "dialog-input").is_some());
    let dialog = find(root, "dialog-input").unwrap();
    assert!(window.makeFirstResponder(Some(&text_view(&dialog).unwrap())));
    until("dialog input focused", || focused(window, &dialog));
}

fn close(root: &NSView) {
    OPEN.store(false, Ordering::SeqCst);
    until("dialog removed", || find(root, "focus-modal").is_none());
}

fn screenshot(root: &NSView, name: &str) {
    let Some(directory) = std::env::var_os("NSH_MODAL_FOCUS_SCREENSHOTS") else {
        return;
    };
    // Document events reach the engine before its next painted frame.
    let end = Instant::now() + Duration::from_millis(100);
    while Instant::now() < end {
        pump();
    }
    root.displayIfNeeded();
    let bounds = root.bounds();
    let bitmap = root
        .bitmapImageRepForCachingDisplayInRect(bounds)
        .expect("a bitmap");
    root.cacheDisplayInRect_toBitmapImageRep(bounds, &bitmap);
    let properties =
        NSDictionary::<NSBitmapImageRepPropertyKey, platform::objc2::runtime::AnyObject>::new();
    // SAFETY: an empty property dictionary is valid for PNG.
    let png = unsafe {
        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
    }
    .expect("PNG data");
    let directory = std::path::PathBuf::from(directory);
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join(format!("{name}.png")), png.to_vec()).unwrap();
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    NSApplication::sharedApplication(mtm).finishLaunching();
    let kinds = [
        #[cfg(feature = "editor")]
        1,
        #[cfg(feature = "rich-editor")]
        2,
        0,
        3,
    ];
    for kind in kinds {
        KIND.store(kind, Ordering::SeqCst);
        OPEN.store(false, Ordering::SeqCst);
        REMOVED.store(false, Ordering::SeqCst);
        HIDDEN.store(false, Ordering::SeqCst);
        // SAFETY: created and retained on the main thread until closed.
        let window = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(
                NSWindow::alloc(mtm),
                NSRect::new(NSPoint::new(100.0, 100.0), NSSize::new(480.0, 320.0)),
                NSWindowStyleMask::Titled,
                NSBackingStoreType::Buffered,
                false,
            )
        };
        // SAFETY: the retained window owns its lifetime after close.
        unsafe { window.setReleasedWhenClosed(false) };
        let app = platform::AppView::new(
            mtm,
            platform::AppOptions {
                size: (480, 320),
                ..Default::default()
            },
        );
        let root = app.view();
        window.setContentView(Some(&root));
        app.load(platform::App::Rust(platform::Root::of::<Scene>()));
        window.orderFront(None);
        until("editor mounted", || {
            find(&root, "source").and_then(|v| text_view(&v)).is_some()
        });
        let source = find(&root, "source").unwrap();
        assert!(window.makeFirstResponder(Some(&text_view(&source).unwrap())));
        until("source focused", || focused(&window, &source));
        open(&window, &root);
        screenshot(&root, &format!("kind-{kind}-dialog"));
        close(&root);
        until(
            "the previous input regains focus after the dialog closes",
            || focused(&window, &source),
        );
        TYPED.store(false, Ordering::SeqCst);
        let responder = window.firstResponder().unwrap();
        // SAFETY: the restored responder is the source's NSTextInputClient.
        unsafe {
            let _: () = msg_send![&*responder, insertText: &*NSString::from_str("Restored"), replacementRange: NSRange::new(usize::MAX, 0)];
        }
        until("typing reaches the restored editor", || {
            TYPED.load(Ordering::SeqCst)
        });
        screenshot(&root, &format!("kind-{kind}-restored"));

        open(&window, &root);
        let other = find(&root, "other").unwrap();
        assert!(window.makeFirstResponder(Some(&text_view(&other).unwrap())));
        close(&root);
        assert!(
            focused(&window, &other),
            "dismissal must not steal focus acquired elsewhere"
        );

        assert!(window.makeFirstResponder(Some(&text_view(&source).unwrap())));
        open(&window, &root);
        source.setHidden(true);
        close(&root);
        assert!(
            !focused(&window, &source),
            "a hidden ancestor must prevent restoration"
        );
        source.setHidden(false);

        assert!(window.makeFirstResponder(Some(&text_view(&source).unwrap())));
        open(&window, &root);
        HIDDEN.store(true, Ordering::SeqCst);
        until("source visibility hidden while covered", || {
            source.layer().is_some_and(|l| l.isHidden())
        });
        close(&root);
        assert!(
            !focused(&window, &source),
            "visibility-hidden editors must not regain focus"
        );
        HIDDEN.store(false, Ordering::SeqCst);
        until("source visible again", || {
            source.layer().is_some_and(|l| !l.isHidden())
        });

        assert!(window.makeFirstResponder(Some(&text_view(&source).unwrap())));
        open(&window, &root);
        REMOVED.store(true, Ordering::SeqCst);
        until("source removed while covered", || {
            find(&root, "source").is_none()
        });
        close(&root);
        assert!(
            !focused(&window, &source),
            "an unmounted editor must not regain focus"
        );
        app.stop();
        window.close();
        println!(
            "modal_focus: kind {kind} restores typing, preserves newer focus and rejects hidden or removed editors"
        );
    }
}
