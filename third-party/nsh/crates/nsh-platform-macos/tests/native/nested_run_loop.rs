//! A batch item that runs a nested run loop (AppKit animates the `zoom:`
//! a window's `SetMode(Maximized)` asks for, #3175): what fires in it (the
//! engine's wake-up, a deadline's frame, the display link) must not apply
//! the next batch in the middle of this one, which held the mounter and
//! aborted with "RefCell already borrowed". The next batch applies once
//! the one that ran the loop is done, and later ones follow as usual.
//!
//! A registered native component stands for the zoom: it is made while
//! its batch is applied, asks the app for the next step, and runs the main
//! run loop while the engine sends it. An animation runs all along, so
//! batches wait for the display link's frames ([`Surface::apply_queued`]):
//! the batch running the loop is applied in a frame, as the zoom's is at
//! launch, and the link fires again inside it. The window is 2 × 2 points
//! and fully transparent, and the app is never activated: nothing shows.

use std::{
    cell::RefCell,
    rc::Rc,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::{Duration, Instant},
};

use nsh_core::{element::Root, prelude::*};
use nsh_platform_macos::{
    AppOptions, AppView, ComponentContext, NativeComponent,
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize},
};

/// The step [`Steps`] shows: 1 mounts the spinning component, 2 and 3 a
/// view each.
static STEP: AtomicUsize = AtomicUsize::new(0);

/// The spinning component ran its nested run loop.
static SPUN: AtomicBool = AtomicBool::new(false);

const COMPONENT: &str = "nested-run-loop.spin";

thread_local! {
    /// The app's root view, which the component looks into while it spins.
    static ROOT: RefCell<Option<Retained<NSView>>> = const { RefCell::new(None) };
    /// What the component saw while it spun: whether step 2 was mounted.
    static SAW_NEXT: RefCell<Option<bool>> = const { RefCell::new(None) };
}

/// A view per step reached, the spinning component at step 1.
#[component]
fn Steps() -> impl IntoElement {
    let step = signal(STEP.load(Ordering::SeqCst));
    set_interval(Duration::from_millis(5), move || {
        let now = STEP.load(Ordering::SeqCst);
        if step.get_untracked() != now {
            step.set(now);
        }
    });
    // Runs for the whole check: batches wait for frames meanwhile.
    let fade = animated_value(0.0);
    set_timeout(Duration::ZERO, move || {
        fade.timing(1.0, 600_000.0, Easing::EASE);
    });
    let shown = move |at: usize, id: &'static str| {
        each(
            move || if step.get() >= at { vec![at] } else { vec![] },
            |key: &usize| *key,
            move |_, _| {
                if at == 1 {
                    nsh_core::element::native(COMPONENT)
                        .test_id(id)
                        .h(px(4.0))
                        .into_element()
                } else {
                    view().test_id(id).h(px(4.0)).into_element()
                }
            },
        )
    };
    view()
        .size_full()
        .child(view().test_id("ready").h(px(4.0)).bind_opacity(&fade))
        .child(shown(1, "spin"))
        .child(shown(2, "next"))
        .child(shown(3, "later"))
}

/// Made while its batch is applied: asks for step 2, then runs the main
/// run loop until long after the engine sent it.
struct Spin(Retained<NSView>);

impl Spin {
    fn new() -> Spin {
        let mtm = MainThreadMarker::new().expect("components are made on the main thread");
        STEP.store(2, Ordering::SeqCst);
        let deadline = Instant::now() + Duration::from_millis(300);
        while Instant::now() < deadline {
            let soon = NSDate::dateWithTimeIntervalSinceNow(0.005);
            NSRunLoop::currentRunLoop().runUntilDate(&soon);
        }
        let next = ROOT.with(|r| r.borrow().as_ref().is_some_and(|root| has(root, "next")));
        SAW_NEXT.with(|s| *s.borrow_mut() = Some(next));
        SPUN.store(true, Ordering::SeqCst);
        Spin(NSView::initWithFrame(NSView::alloc(mtm), NSRect::ZERO))
    }
}

impl NativeComponent for Spin {
    fn view(&self) -> Retained<NSView> {
        self.0.clone()
    }

    fn set_prop(&mut self, _name: &str, _value: Option<&serde_json::Value>) {}
}

fn has(view: &NSView, id: &str) -> bool {
    view.accessibilityIdentifier()
        .is_some_and(|i| i.to_string() == id)
        || view.subviews().iter().any(|v| has(&v, id))
}

/// Runs the main run loop until `done` holds, for at most 5 s.
fn until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "{what} never happened");
        let soon = NSDate::dateWithTimeIntervalSinceNow(0.005);
        NSRunLoop::currentRunLoop().runUntilDate(&soon);
    }
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().expect("the main thread");
    let _app = NSApplication::sharedApplication(mtm);
    let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(2.0, 2.0));
    // SAFETY: a borderless window, created on the main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            frame,
            NSWindowStyleMask::Borderless,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: `window` is kept until after it closes.
    unsafe { window.setReleasedWhenClosed(false) };
    window.setAlphaValue(0.0);
    window.setIgnoresMouseEvents(true);
    let app = AppView::new(
        mtm,
        AppOptions {
            size: (2, 2),
            ..AppOptions::default()
        },
    );
    window.setContentView(Some(&app.view()));
    window.orderFrontRegardless();
    app.register_component(
        COMPONENT,
        Rc::new(|_context: ComponentContext| -> Box<dyn NativeComponent> { Box::new(Spin::new()) }),
    );
    app.load(Root::of::<Steps>().into());
    let root = app.view();
    ROOT.with(|r| *r.borrow_mut() = Some(root.retain()));
    until("the first mount", || has(&root, "ready"));

    STEP.store(1, Ordering::SeqCst);
    until("the spinning component", || SPUN.load(Ordering::SeqCst));
    assert_eq!(
        SAW_NEXT.with(|s| *s.borrow()),
        Some(false),
        "the next batch applied inside the one running a nested run loop"
    );
    assert!(
        has(&root, "spin"),
        "the batch running the loop applied whole"
    );
    until("the batch sent during the nested run loop", || {
        has(&root, "next")
    });
    STEP.store(3, Ordering::SeqCst);
    until("a later batch", || has(&root, "later"));

    ROOT.with(|r| r.borrow_mut().take());
    app.stop();
    window.close();
    println!("nested run loop: ok");
}
