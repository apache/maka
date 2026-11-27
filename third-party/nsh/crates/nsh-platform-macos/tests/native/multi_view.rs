//! Two apps embedded in one window, each in its own `AppView` (#3514):
//! each draws inside its own view's frame. The second view starts at a
//! size of its options and is then given another frame by the host, as
//! the issue's host does. Run for a Rust app and for a JS bundle whose
//! plain root (`mount`, no `<Window>`) renders in the view, opening no
//! window of its own.

use std::time::{Duration, Instant};

use nsh_core::prelude::*;
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSAutoresizingMaskOptions, NSBackingStoreType, NSView,
        NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize, NSString},
};

#[component]
fn Card() -> impl IntoElement {
    view()
        .size_full()
        .p(px(12.0))
        .gap(px(8.0))
        .child(view().test_id("multi-view-fill").flex_1().bg(rgb(0xff0000)))
        .child(text("count 0"))
}

fn pump(ms: u64) {
    let deadline = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < deadline {
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
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

/// `view`'s frame in its window's content (AppKit's, y up).
fn in_window(view: &NSView) -> NSRect {
    view.convertRect_toView(view.bounds(), None)
}

fn contains(outer: NSRect, inner: NSRect) -> bool {
    let e = 0.5;
    inner.origin.x >= outer.origin.x - e
        && inner.origin.y >= outer.origin.y - e
        && inner.origin.x + inner.size.width <= outer.origin.x + outer.size.width + e
        && inner.origin.y + inner.size.height <= outer.origin.y + outer.size.height + e
}

/// The issue's app as `nsh build` compiles it, its root filled red.
const BUNDLE: &str = r##"
import { append, component, element, insert, prop } from "nsh:rt";
import { mount, signal } from "nsh";
import { Button } from "nsh/base";
const n = signal(0);
function App() {
    const root = element("view");
    prop(root, "testID", "multi-view-fill");
    prop(root, "style", { padding: 12, gap: 8, flex: 1, backgroundColor: "#ff0000" });
    const label = element("text");
    insert(label, () => `count ${n()}`);
    append(root, label);
    insert(root, component(Button, { label: "Add", onPress: () => n.set(n() + 1) }));
    return root;
}
mount(() => component(App, {}));
"##;

#[derive(Clone, Copy, Debug)]
enum Kind {
    Rust,
    Js,
}

impl Kind {
    fn app(self) -> platform::App {
        match self {
            Kind::Rust => platform::App::Rust(platform::Root::of::<Card>()),
            Kind::Js => platform::Bundle::source(BUNDLE.to_owned()).into(),
        }
    }

    /// How far the filled view is inset in its `AppView`.
    fn inset(self) -> f64 {
        match self {
            Kind::Rust => 24.0,
            Kind::Js => 0.0,
        }
    }
}

fn embed(
    mtm: MainThreadMarker,
    content: &NSView,
    kind: Kind,
    options: (i32, i32),
    frame: NSRect,
) -> std::rc::Rc<platform::AppView> {
    let app = platform::AppView::new(
        mtm,
        platform::AppOptions {
            size: options,
            ..Default::default()
        },
    );
    app.load(kind.app());
    let view = app.view();
    view.setAutoresizingMask(NSAutoresizingMaskOptions::empty());
    view.setFrame(frame);
    content.addSubview(&view);
    app
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    let ns_app = NSApplication::sharedApplication(mtm);
    ns_app.finishLaunching();
    for kind in [Kind::Rust, Kind::Js] {
        check(mtm, &ns_app, kind);
    }
    println!("multi view: ok");
}

fn visible_windows(ns_app: &NSApplication) -> usize {
    ns_app.windows().iter().filter(|w| w.isVisible()).count()
}

fn check(mtm: MainThreadMarker, ns_app: &NSApplication, kind: Kind) {
    // SAFETY: The window is created on the process main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(200.0, 200.0), NSSize::new(560.0, 760.0)),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Resizable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(&NSString::from_str("NSH multi view"));
    let content = window.contentView().unwrap();
    let frames = [
        NSRect::new(NSPoint::new(20.0, 80.0), NSSize::new(520.0, 582.0)),
        NSRect::new(NSPoint::new(20.0, 670.0), NSSize::new(520.0, 80.0)),
    ];
    window.orderFrontRegardless();
    let windows = visible_windows(ns_app);
    let first = embed(mtm, &content, kind, (520, 582), frames[0]);
    let second = embed(mtm, &content, kind, (260, 300), frames[1]);
    pump(1500);
    if let Some(ms) = std::env::var("NSH_MULTI_VIEW_HOLD_MS")
        .ok()
        .and_then(|v| v.parse().ok())
    {
        println!(
            "multi view ({kind:?}): holding window {} for {ms}ms",
            window.windowNumber()
        );
        pump(ms);
    }

    assert_eq!(
        visible_windows(ns_app),
        windows,
        "{kind:?}: the embedded apps open no window of their own"
    );
    for (i, app) in [&first, &second].into_iter().enumerate() {
        let view = app.view();
        let host = in_window(&view);
        let fill = find(&view, "multi-view-fill").expect("the app's view is mounted");
        let drawn = in_window(&fill);
        println!(
            "multi view {kind:?} {i}: host {:?} fill {:?}",
            (
                host.origin.x,
                host.origin.y,
                host.size.width,
                host.size.height
            ),
            (
                drawn.origin.x,
                drawn.origin.y,
                drawn.size.width,
                drawn.size.height
            ),
        );
        assert!(
            drawn.size.width > 100.0 && drawn.size.height > 10.0,
            "view {i}'s content is laid out at its view's size ({drawn:?} in {host:?})"
        );
        assert!(
            contains(host, drawn),
            "view {i}'s content is inside its view ({drawn:?} outside {host:?})"
        );
        assert!(
            (drawn.size.width - (host.size.width - kind.inset())).abs() < 1.0,
            "view {i}'s content fills its view's width ({drawn:?} in {host:?})"
        );
    }
    first.stop();
    second.stop();
    window.close();
}
