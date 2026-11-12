//! What AppKit's accessibility clients read of mounted views: a real
//! `AppView` in a window, its elements walked through `accessibilityChildren`
//! as VoiceOver and UI tests walk them. AppKit views live on the main thread,
//! so this test runs without libtest's harness, on the process's own.

#[cfg(target_os = "macos")]
#[path = "accessibility/table.rs"]
mod table;

#[cfg(target_os = "macos")]
fn main() {
    macos::run();
    table::run();
}

#[cfg(not(target_os = "macos"))]
fn main() {}

#[cfg(target_os = "macos")]
mod macos {
    use std::{
        sync::atomic::{AtomicBool, AtomicU32, Ordering},
        time::{Duration, Instant},
    };

    use nsh_core::{element::Root, prelude::*};
    use nsh_platform_macos::{
        AppOptions, AppView,
        objc2::{
            MainThreadMarker, MainThreadOnly, Message, msg_send, rc::Retained, runtime::AnyObject,
        },
        objc2_app_kit::{
            NSAccessibility, NSApplication, NSBackingStoreType, NSView, NSWindow, NSWindowStyleMask,
        },
        objc2_foundation::{NSDate, NSNumber, NSPoint, NSRect, NSRunLoop, NSSize, NSString},
    };

    /// The test sets it to change the texts inside the elements.
    static RENAMED: AtomicBool = AtomicBool::new(false);

    /// The scale requested by the frame checks, in percent.
    static ZOOM: AtomicU32 = AtomicU32::new(100);

    /// The test sets it to scroll the scroll area to its end.
    static SCROLLED: AtomicBool = AtomicBool::new(false);

    /// The test sets it to open the dialog.
    static OPENED: AtomicBool = AtomicBool::new(false);

    /// An option and a tree item holding only a text, an option with a
    /// label of its own, and a button holding only a text.
    #[component]
    fn Screen() -> impl IntoElement {
        let renamed = signal(false);
        set_interval(Duration::from_millis(20), move || {
            if RENAMED.load(Ordering::SeqCst) && !renamed.get_untracked() {
                renamed.set(true);
            }
        });
        let name = move |before: &'static str, after: &'static str| {
            text(move || if renamed.get() { after } else { before })
        };
        view()
            .child(
                view()
                    .test_id("option")
                    .role(AccessibilityRole::Option)
                    .child(name("Orders", "Trades")),
            )
            .child(
                view()
                    .test_id("tree-item")
                    .role(AccessibilityRole::TreeItem)
                    .child(name("Hosts", "Processes")),
            )
            .child(
                view()
                    .test_id("labelled")
                    .role(AccessibilityRole::Option)
                    .label("Fixed")
                    .child(name("Shown", "Shown again")),
            )
            .child(
                view()
                    .test_id("button")
                    .on_press(|| {})
                    .child(name("Save", "Save all")),
            )
            .child(geometry())
            .child(order())
            .child(scroll_area())
            .child(confirm())
    }

    /// A dialog named by its title and described by its message, opened
    /// once the test asks.
    #[component]
    fn Confirm() -> impl IntoElement {
        let open = signal(false);
        set_interval(Duration::from_millis(20), move || {
            if OPENED.load(Ordering::SeqCst) && !open.get_untracked() {
                open.set(true);
            }
        });
        when(open, || {
            nsh_base::dialog()
                .test_id("rename")
                .label("Rename file")
                .accessibility_description("Other apps see the new name too.")
                .child(
                    view()
                        .child(text("Rename file"))
                        .child(view().test_id("save").on_press(|| {}).child(text("Save"))),
                )
        })
    }

    /// A scroll view and a plain view, each holding two texts made bottom
    /// first, as a list's recycled cells can be.
    #[component]
    fn Order() -> impl IntoElement {
        let two = |second: &'static str, first: &'static str| {
            [
                text("Second").test_id(second).absolute().top(px(40.0)),
                text("First").test_id(first).absolute().top(px(0.0)),
            ]
        };
        view()
            .absolute()
            .left(px(260.0))
            .top(px(0.0))
            .w(px(120.0))
            .child(
                scroll()
                    .test_id("scrolled")
                    .h(px(80.0))
                    .children(two("scrolled-second", "scrolled-first")),
            )
            .child(
                view()
                    .test_id("plain")
                    .h(px(80.0))
                    .children(two("plain-second", "plain-first")),
            )
    }

    /// A scroll view whose content is three times its height.
    #[component]
    fn ScrollArea() -> impl IntoElement {
        let area = element_ref();
        set_interval(Duration::from_millis(20), move || {
            if SCROLLED.swap(false, Ordering::SeqCst) {
                area.scroll_to_end(false);
            }
        });
        scroll()
            .element_ref(&area)
            .test_id("scroll-area")
            .absolute()
            .left(px(260.0))
            .top(px(180.0))
            .w(px(100.0))
            .h(px(50.0))
            .child(view().h(px(150.0)))
    }

    /// Fixed geometry makes the expected screen frames independent of
    /// both AppKit's view conversions and Core Animation's conversions.
    #[component]
    fn Geometry() -> impl IntoElement {
        let zoom = signal(1.0);
        set_interval(Duration::from_millis(20), move || {
            zoom.set(ZOOM.load(Ordering::SeqCst) as f32 / 100.0);
        });
        view()
            .absolute()
            .left(px(40.0))
            .top(px(100.0))
            .w(px(200.0))
            .h(px(160.0))
            .scale(move || zoom.get())
            .child(
                text("Scaled row")
                    .test_id("scaled-row")
                    .absolute()
                    .left(px(20.0))
                    .top(px(30.0))
                    .w(px(80.0))
                    .h(px(20.0)),
            )
            .child(
                view()
                    .absolute()
                    .left(px(30.0))
                    .top(px(70.0))
                    .w(px(100.0))
                    .h(px(60.0))
                    .origin_top_left()
                    .scale_x(0.5)
                    .scale_y(1.5)
                    .child(
                        text("Nested")
                            .test_id("nested-row")
                            .absolute()
                            .left(px(10.0))
                            .top(px(8.0))
                            .w(px(40.0))
                            .h(px(12.0))
                            .translate_x(px(6.0))
                            .translate_y(px(4.0)),
                    ),
            )
            .child(
                view()
                    .absolute()
                    .left(px(100.0))
                    .top(px(20.0))
                    .w(px(50.0))
                    .h(px(50.0))
                    .origin_top_left()
                    .rotate(deg(45.0))
                    .child(
                        text("Rotated")
                            .test_id("rotated-row")
                            .w(px(30.0))
                            .h(px(10.0))
                            .origin_top_left()
                            .rotate(deg(-45.0)),
                    ),
            )
    }

    /// Reads AXFrame through NSAccessibility in a normal window. Screen
    /// coordinates have their origin at the bottom left, unlike our root.
    fn check_frame(root: &NSView, id: &str, expected: (f64, f64, f64, f64)) {
        let element = find(root, id).expect("a mounted element");
        let actual = element.accessibilityFrame();
        let window = root.window().expect("a window");
        let content = window.convertRectToScreen(root.convertRect_toView(root.bounds(), None));
        let (x, y, width, height) = expected;
        let expected = [
            content.origin.x + x,
            content.origin.y + content.size.height - y - height,
            width,
            height,
        ];
        let actual = [
            actual.origin.x,
            actual.origin.y,
            actual.size.width,
            actual.size.height,
        ];
        println!("AXFrame {id}: {actual:?}, expected {expected:?}");
        for (got, want) in actual.into_iter().zip(expected) {
            assert!(
                (got - want).abs() < 0.01,
                "{id}: {actual:?} != {expected:?}"
            );
        }
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

    /// The element with accessibility identifier `id` under `view`, as
    /// clients find it: through `accessibilityChildren`.
    fn find(view: &NSView, id: &str) -> Option<Retained<NSView>> {
        if view
            .accessibilityIdentifier()
            .is_some_and(|i| i.to_string() == id)
        {
            return Some(view.retain());
        }
        let children = view.accessibilityChildren()?;
        children
            .iter()
            .filter_map(|c| c.downcast::<NSView>().ok())
            .find_map(|c| find(&c, id))
    }

    /// The view with identifier `id` under `view`, through the view tree
    /// (it need not be an element).
    fn view_with_id(view: &NSView, id: &str) -> Option<Retained<NSView>> {
        if view
            .accessibilityIdentifier()
            .is_some_and(|i| i.to_string() == id)
        {
            return Some(view.retain());
        }
        view.subviews().iter().find_map(|c| view_with_id(&c, id))
    }

    /// The identifiers of the accessibility children of view `id`, in
    /// their order.
    fn children_of(root: &NSView, id: &str) -> Vec<String> {
        let view = view_with_id(root, id).unwrap_or_else(|| panic!("no view {id}"));
        view.accessibilityChildren()
            .map(|children| {
                children
                    .iter()
                    .filter_map(|c| c.downcast::<NSView>().ok())
                    .filter_map(|c| c.accessibilityIdentifier().map(|i| i.to_string()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The role and value of the accessibility element `object`.
    fn role_and_value(object: &AnyObject) -> (Option<String>, Option<f64>) {
        // SAFETY: NSAccessibility getters, sent to an element on the main
        // thread.
        let role: Option<Retained<NSString>> = unsafe { msg_send![object, accessibilityRole] };
        let value: Option<Retained<AnyObject>> = unsafe { msg_send![object, accessibilityValue] };
        (
            role.map(|r| r.to_string()),
            value
                .and_then(|v| v.downcast::<NSNumber>().ok())
                .map(|n| n.as_f64()),
        )
    }

    fn string(object: Option<Retained<AnyObject>>) -> Option<String> {
        object
            .and_then(|o| o.downcast::<NSString>().ok())
            .map(|s| s.to_string())
    }

    /// The label, value and accessibility children of element `id`.
    fn read(root: &NSView, id: &str) -> (Option<String>, Option<String>, usize) {
        let e = find(root, id).unwrap_or_else(|| panic!("no element {id}"));
        let label = e.accessibilityLabel().map(|s| s.to_string());
        let value = string(e.accessibilityValue());
        let children = e.accessibilityChildren().map_or(0, |c| c.count());
        (label, value, children)
    }

    pub(super) fn run() {
        let mtm = MainThreadMarker::new().expect("the main thread");
        let _app = NSApplication::sharedApplication(mtm);
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
                ..AppOptions::default()
            },
        );
        window.setContentView(Some(&app.view()));
        window.orderFrontRegardless();
        app.load(Root::of::<Screen>().into());
        let root = app.view();

        until("the first mount", || find(&root, "button").is_some());

        // Static text reads its name as its value: the folded text goes
        // there, and no text child is left to say it again.
        until("the option's value", || {
            read(&root, "option") == (None, Some("Orders".into()), 0)
        });
        assert_eq!(read(&root, "tree-item"), (None, Some("Hosts".into()), 0));
        // A label of its own stays what it reads, as its value.
        assert_eq!(read(&root, "labelled"), (None, Some("Fixed".into()), 0));
        // A button reads its name as its label.
        assert_eq!(read(&root, "button"), (Some("Save".into()), None, 0));

        // The texts change: what clients read follows.
        RENAMED.store(true, Ordering::SeqCst);
        until("the option's new value", || {
            read(&root, "option").1.as_deref() == Some("Trades")
        });
        assert_eq!(
            read(&root, "tree-item"),
            (None, Some("Processes".into()), 0)
        );
        assert_eq!(read(&root, "labelled"), (None, Some("Fixed".into()), 0));
        assert_eq!(read(&root, "button"), (Some("Save all".into()), None, 0));

        // A scroll view's content is read in the order it is on screen,
        // not the order its views were made in; elsewhere the tree's order
        // stays.
        until("the order mount", || {
            find(&root, "scrolled-first").is_some()
        });
        assert_eq!(
            children_of(&root, "scrolled"),
            ["scrolled-first", "scrolled-second"]
        );
        assert_eq!(children_of(&root, "plain"), ["plain-second", "plain-first"]);

        // A scroll view is a scroll area, its scroll bar on its axis telling
        // where it is scrolled to, from 0 at the start to 1 at the end.
        until("the scroll area", || find(&root, "scroll-area").is_some());
        let area = find(&root, "scroll-area").expect("the scroll area");
        assert_eq!(
            area.accessibilityRole().map(|r| r.to_string()).as_deref(),
            Some("AXScrollArea")
        );
        assert!(area.accessibilityHorizontalScrollBar().is_none());
        let bar = area
            .accessibilityVerticalScrollBar()
            .expect("a vertical bar");
        assert_eq!(
            role_and_value(&bar),
            (Some("AXScrollBar".into()), Some(0.0))
        );
        let children = area.accessibilityChildren().expect("children");
        assert!(
            children
                .iter()
                .any(|c| std::ptr::eq(&*c as *const AnyObject, &*bar as *const AnyObject)),
            "the bar is among the children"
        );
        SCROLLED.store(true, Ordering::SeqCst);
        until("the bar's value at the end", || {
            role_and_value(&bar).1 == Some(1.0)
        });

        until("the geometry mount", || find(&root, "nested-row").is_some());
        println!("window backing scale: {}", window.backingScaleFactor());
        for percent in [120, 80, 100] {
            ZOOM.store(percent, Ordering::SeqCst);
            // Allow the reactive scale and the ordinary display pass to
            // settle. Do not force screenshot rendering of the views.
            let soon = NSDate::dateWithTimeIntervalSinceNow(0.15);
            NSRunLoop::currentRunLoop().runUntilDate(&soon);
            let s = percent as f64 / 100.0;
            check_frame(
                &root,
                "scaled-row",
                (140.0 - 80.0 * s, 180.0 - 50.0 * s, 80.0 * s, 20.0 * s),
            );
            check_frame(
                &root,
                "nested-row",
                (140.0 - 62.0 * s, 180.0 + 8.0 * s, 20.0 * s, 18.0 * s),
            );
            // Opposite rotations cancel before enclosing the rectangle.
            check_frame(
                &root,
                "rotated-row",
                (140.0, 180.0 - 60.0 * s, 30.0 * s, 10.0 * s),
            );
        }

        // A dialog is an AXGroup with the dialog subrole, as WebKit makes
        // ARIA's `dialog`, named by its label; its controls stay elements
        // of their own inside it.
        OPENED.store(true, Ordering::SeqCst);
        until("the dialog", || find(&root, "rename").is_some());
        let dialog = find(&root, "rename").expect("the dialog");
        assert_eq!(
            dialog.accessibilityRole().map(|r| r.to_string()).as_deref(),
            Some("AXGroup")
        );
        assert_eq!(
            dialog
                .accessibilitySubrole()
                .map(|r| r.to_string())
                .as_deref(),
            Some("AXApplicationDialog")
        );
        assert_eq!(
            dialog
                .accessibilityLabel()
                .map(|s| s.to_string())
                .as_deref(),
            Some("Rename file")
        );
        // Its description is its help, which VoiceOver reads after the
        // name.
        assert_eq!(
            dialog.accessibilityHelp().map(|s| s.to_string()).as_deref(),
            Some("Other apps see the new name too.")
        );
        assert_eq!(read(&dialog, "save"), (Some("Save".into()), None, 0));

        app.stop();
        window.close();
        println!("accessibility: ok");
    }
}
