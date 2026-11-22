//! Alerts (`AlertDialog`) while the main window is out of sight, as a tray
//! app's (nsh.json `window.defaultVisible: false`): a sheet of the hidden
//! main window was never seen, and `show()` waited for the window to show.
//! Read from the real AppKit windows, the alerts answered with input posted
//! to the app as the system posts it (a click, Escape, Return):
//! - with the main window hidden, an alert shows on its own: a window of
//!   its own, no sheet, in front (the app active, the alert's window key
//!   and on the screen), the main window still hidden, and the app's
//!   batches go on while it shows; a click on a button answers that button,
//!   Escape the cancel button;
//! - two alerts, the second raised while the first shows, show one at a
//!   time, in order;
//! - with the main window shown, the alert is a sheet of it, as before;
//! - the app stopping while one shows on its own takes it away, unanswered.
//!
//! An alert on its own runs a modal loop, so the checks inside it run from
//! a timer in the run loop's common modes, which a modal loop runs too.
//! Needs a desktop session with the screen unlocked: a locked screen shows
//! no window and activates no app. Nobody may work in another app while it
//! runs either: macOS (14 and later) may then decline to activate this one,
//! and step 1 fails on "the app is not active". So it is left out of the
//! full run, whose other checks would not run after it on a machine in
//! use, and runs on its own:
//! `NSH_WINDOW_ALERT_CHECK_ONLY=1 cargo test -p nsh-platform-macos --test native -- --ignored`.

use std::{
    cell::{Cell, RefCell},
    ptr::NonNull,
    rc::Rc,
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use block2::RcBlock;
use nsh_base::alert_dialog;
use nsh_core::prelude::*;
use nsh_platform_macos::{
    self as platform,
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSApplicationActivationPolicy, NSBackingStoreType,
        NSButton, NSEvent, NSEventMask, NSEventModifierFlags, NSEventType, NSModalResponseAbort,
        NSView, NSWindow, NSWindowOcclusionState, NSWindowStyleMask,
    },
    objc2_foundation::{
        NSDate, NSDefaultRunLoopMode, NSPoint, NSProcessInfo, NSRect, NSRunLoop,
        NSRunLoopCommonModes, NSSize, NSString, NSTimer,
    },
};

/// What the app does next: each new step raises its alerts once.
static STEP: AtomicUsize = AtomicUsize::new(0);
/// The answers the app got, in order: the alert, the action chosen.
static ANSWERS: Mutex<Vec<(&str, Option<String>)>> = Mutex::new(Vec::new());
/// What went wrong while an alert showed (inside its modal loop).
static FAILURES: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// The alerts each step raises, by name (the second of step 3 a moment
/// after the first, while it shows). Each has the buttons "Cancel" (the
/// cancel action, `cancel`) and "<name> OK" (`ok`, the default one).
const STEPS: [&[&str]; 5] = [
    &["First"],
    &["Second"],
    &["Third", "Fourth"],
    &["Fifth"],
    &["Sixth"],
];

/// How long an alert may take to show as it should.
const ALERT_TIMEOUT: Duration = Duration::from_secs(5);
/// `kVK_Escape` and `kVK_Return`.
const ESCAPE: u16 = 53;
const RETURN: u16 = 36;

thread_local! {
    /// The app's view: stopped from inside an alert's modal loop.
    static SURFACE: RefCell<Option<Rc<platform::AppView>>> = const { RefCell::new(None) };
    /// The main window, which must stay hidden while an alert shows on its
    /// own.
    static MAIN: RefCell<Option<Retained<NSWindow>>> = const { RefCell::new(None) };
}

/// Raises alert `name`; its answer goes to [`ANSWERS`].
fn raise(name: &'static str) {
    let answer = alert_dialog()
        .title(name)
        .description("An alert of the native checks.")
        .cancel("cancel", "Cancel")
        .action("ok", format!("{name} OK"))
        .show();
    spawn(async move {
        let action = answer
            .await
            .ok()
            .and_then(|r| r.action)
            .map(|a| a.to_string());
        ANSWERS.lock().unwrap().push((name, action));
    });
}

/// The main window's content: raises each step's alerts and, a moment
/// after, mounts `raised-<step>`, a batch the main thread applies while the
/// alert shows.
#[component]
fn Alerts() -> impl IntoElement {
    let done = signal(0);
    let raised = signal(0);
    set_interval(Duration::from_millis(5), move || {
        let step = STEP.load(Ordering::SeqCst);
        if done.get_untracked() >= step {
            return;
        }
        done.set(step);
        let names = STEPS[step - 1];
        raise(names[0]);
        if let Some(&second) = names.get(1) {
            set_timeout(Duration::from_millis(150), move || raise(second));
        }
        set_timeout(Duration::from_millis(300), move || raised.set(step));
    });
    let mut content = view().test_id("alerts").flex_1().child(text("Alerts"));
    for step in 1..=STEPS.len() {
        content = content.child(when(
            move || raised.get() >= step,
            move || {
                view()
                    .test_id(&format!("raised-{step}"))
                    .child(text("Raised"))
            },
        ));
    }
    content
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

/// Whether the app's views hold `id`.
fn mounted(id: &str) -> bool {
    SURFACE.with(|s| {
        s.borrow()
            .as_ref()
            .is_some_and(|s| find_in(&s.view(), id).is_some())
    })
}

/// The button titled `title` in `view`.
fn button_in(view: &NSView, title: &str) -> Option<Retained<NSButton>> {
    if let Some(button) = view.downcast_ref::<NSButton>()
        && button.title().to_string() == title
    {
        return Some(button.retain());
    }
    view.subviews()
        .iter()
        .find_map(|child| button_in(&child, title))
}

/// The button titled `title` in `window`.
fn button(window: &NSWindow, title: &str) -> Option<Retained<NSButton>> {
    button_in(&*window.contentView()?, title)
}

/// The app's windows that show an alert of these checks.
fn alerts_shown(app: &NSApplication) -> Vec<Retained<NSWindow>> {
    app.windows()
        .iter()
        .filter(|w| {
            w.isVisible()
                && STEPS
                    .iter()
                    .flat_map(|names| names.iter())
                    .any(|name| button(w, &format!("{name} OK")).is_some())
        })
        .collect()
}

/// Whether some of `window` shows on a screen, as the window server tells.
fn on_screen(window: &NSWindow) -> bool {
    window.isVisible()
        && window
            .occlusionState()
            .contains(NSWindowOcclusionState::Visible)
}

/// Seconds since the system started: the clock of events' timestamps.
fn uptime() -> f64 {
    NSProcessInfo::processInfo().systemUptime()
}

/// A left click at the middle of `view`, in `window`, posted to the app.
fn click(window: &NSWindow, view: &NSView) {
    let app = NSApplication::sharedApplication(MainThreadMarker::from(window));
    let bounds = view.bounds();
    let middle = NSPoint::new(
        bounds.origin.x + bounds.size.width / 2.0,
        bounds.origin.y + bounds.size.height / 2.0,
    );
    let at = view.convertPoint_toView(middle, None);
    for (kind, pressure) in [
        (NSEventType::LeftMouseDown, 1.0),
        (NSEventType::LeftMouseUp, 0.0),
    ] {
        let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            kind,
            at,
            NSEventModifierFlags::empty(),
            uptime(),
            window.windowNumber(),
            None,
            0,
            1,
            pressure,
        )
        .expect("a mouse event");
        app.postEvent_atStart(&event, false);
    }
}

/// Key `chars` (`code`, a virtual key code) pressed in `window`, posted to
/// the app.
fn key(window: &NSWindow, chars: &str, code: u16) {
    let app = NSApplication::sharedApplication(MainThreadMarker::from(window));
    let chars = NSString::from_str(chars);
    for kind in [NSEventType::KeyDown, NSEventType::KeyUp] {
        let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
            kind,
            NSPoint::new(0.0, 0.0),
            NSEventModifierFlags::empty(),
            uptime(),
            window.windowNumber(),
            None,
            &chars,
            &chars,
            false,
            code,
        )
        .expect("a key event");
        app.postEvent_atStart(&event, false);
    }
}

/// Stops the app: its alerts go, unanswered.
fn stop_app() {
    if let Some(surface) = SURFACE.with(|s| s.borrow().clone()) {
        surface.stop();
    }
}

/// What the checks do to an alert shown on its own.
#[derive(Clone, Copy, Debug)]
enum Act {
    /// Click its "<name> OK" button.
    Click,
    /// Press Escape: its cancel button.
    Escape,
    /// Stop the app.
    Stop,
}

/// Where the watch of a step's alerts is.
enum Phase {
    /// Waiting for the alert watched to show as it should.
    Show,
    /// Acted on the alert watched (its window): waiting for it to close.
    Close(Retained<NSWindow>),
    /// Failed (since then): ending a modal loop left up, so the checks go
    /// on to report instead of waiting in it for ever.
    Fail(Instant),
    Done,
}

/// Watches a step's alerts shown on their own, from a timer: each must
/// show as it should, is acted on, and must close, in order.
struct Watch {
    step: usize,
    alerts: &'static [(&'static str, Act)],
    /// The alert watched now.
    at: Cell<usize>,
    phase: RefCell<Phase>,
    /// When the phase of the alert watched started.
    since: Cell<Instant>,
    /// Whether `raised-<step>` was mounted already when the step's first
    /// alert first showed.
    raised_before: Cell<Option<bool>>,
}

impl Watch {
    /// One look; true once done.
    fn tick(&self) -> bool {
        let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
        let late = self.since.get().elapsed() > ALERT_TIMEOUT;
        let phase = self.phase.replace(Phase::Done);
        let next = match phase {
            Phase::Show => match self.alerts.get(self.at.get()) {
                None => Phase::Done,
                Some(&(name, act)) => match self.look(name) {
                    Ok(alert) => {
                        match act {
                            Act::Click => {
                                let ok = button(&alert, &format!("{name} OK")).expect("its button");
                                click(&alert, &ok);
                            }
                            Act::Escape => key(&alert, "\u{1b}", ESCAPE),
                            Act::Stop => stop_app(),
                        }
                        self.since.set(Instant::now());
                        Phase::Close(alert)
                    }
                    Err(why) if late => self.fail(format!("{name}: {why}")),
                    Err(_) => Phase::Show,
                },
            },
            Phase::Close(alert) => {
                let modal = app.modalWindow().is_some_and(|w| w == alert);
                if !modal && !alert.isVisible() {
                    self.at.set(self.at.get() + 1);
                    self.since.set(Instant::now());
                    Phase::Show
                } else if late {
                    let (name, act) = self.alerts[self.at.get()];
                    self.fail(format!("{name}: it stays after {act:?}"))
                } else {
                    Phase::Close(alert)
                }
            }
            Phase::Fail(since) => match app.modalWindow() {
                None => Phase::Done,
                Some(_) => {
                    // Apple's way to end a modal loop from a timer.
                    if since.elapsed() > Duration::from_secs(1) {
                        app.abortModal();
                    }
                    Phase::Fail(since)
                }
            },
            Phase::Done => Phase::Done,
        };
        let done = matches!(next, Phase::Done);
        self.phase.replace(next);
        done
    }

    /// Records failure `why` (printed first, in case ending the modal loop
    /// left up ends the process) and stops the app, which takes its alerts
    /// away; the modal loop left up is told to end.
    fn fail(&self, why: String) -> Phase {
        let message = format!("step {}, {why}", self.step);
        eprintln!("window_alert: {message}");
        FAILURES.lock().unwrap().push(message);
        stop_app();
        let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
        if let Some(modal) = app.modalWindow() {
            // A button tracking a press waits for its release.
            let release = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
                NSEventType::LeftMouseUp,
                NSPoint::new(0.0, 0.0),
                NSEventModifierFlags::empty(),
                uptime(),
                modal.windowNumber(),
                None,
                0,
                1,
                0.0,
            );
            let wake = NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(
                NSEventType::ApplicationDefined,
                NSPoint::new(0.0, 0.0),
                NSEventModifierFlags::empty(),
                0.0,
                0,
                None,
                0,
                0,
                0,
            );
            app.stopModalWithCode(NSModalResponseAbort);
            for event in [release, wake].into_iter().flatten() {
                app.postEvent_atStart(&event, false);
            }
        }
        Phase::Fail(Instant::now())
    }

    /// Alert `name` once it shows on its own as it should, else what it
    /// does not do yet.
    fn look(&self, name: &str) -> Result<Retained<NSWindow>, String> {
        let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
        let main = MAIN.with(|m| m.borrow().clone()).expect("the main window");
        let alert = app
            .modalWindow()
            .ok_or("no alert shows on its own (no app-modal window)")?;
        if button(&alert, &format!("{name} OK")).is_none() {
            return Err("the alert on its own is another".into());
        }
        // The app's batches go on while it shows: the one after it mounts
        // `raised-<step>`.
        if self.at.get() == 0 {
            let raised = mounted(&format!("raised-{}", self.step));
            let before = self.raised_before.get().unwrap_or(raised);
            self.raised_before.set(Some(before));
            if before {
                return Err("it showed only after the app's next batch".into());
            }
            if !raised {
                return Err("the app's batches stopped while it shows".into());
            }
        }
        if alert == main || alert.sheetParent().is_some() {
            return Err("it is a sheet".into());
        }
        if main.isVisible() {
            return Err("the main window showed".into());
        }
        let shown = alerts_shown(&app).len();
        if shown != 1 {
            return Err(format!("{shown} alerts show at once"));
        }
        if !app.isActive() {
            return Err("the app is not active: the alert is not in front".into());
        }
        if !alert.isKeyWindow() {
            return Err("its window does not have the keyboard".into());
        }
        if !on_screen(&alert) {
            return Err("the window server does not show it".into());
        }
        Ok(alert)
    }
}

/// Runs the app (its events too, which tell the windows' occlusion) for
/// `ms` milliseconds; an alert's modal loop runs inside.
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

/// Runs the app until `found` finds something, `timeout` at most; fails
/// at once with what went wrong inside an alert's modal loop.
fn until<T>(what: &str, timeout: Duration, mut found: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + timeout;
    loop {
        let failures = std::mem::take(&mut *FAILURES.lock().unwrap());
        assert!(failures.is_empty(), "{}", failures.join("\n"));
        if let Some(value) = found() {
            return value;
        }
        assert!(Instant::now() < deadline, "{what} never happened");
        pump(10);
    }
}

/// Raises step `step`'s alerts with the main window hidden and does to
/// each what `alerts` says, once it shows on its own as it should.
fn alone(step: usize, alerts: &'static [(&'static str, Act)]) {
    let watch = Rc::new(Watch {
        step,
        alerts,
        at: Cell::new(0),
        phase: RefCell::new(Phase::Show),
        since: Cell::new(Instant::now()),
        raised_before: Cell::new(None),
    });
    let timer = {
        let watch = watch.clone();
        let block = RcBlock::new(move |timer: NonNull<NSTimer>| {
            if watch.tick() {
                // SAFETY: the timer firing, alive while it fires.
                unsafe { timer.as_ref() }.invalidate();
            }
        });
        // SAFETY: the block runs on the main thread, where it was made: the
        // timer is the main run loop's.
        unsafe { NSTimer::timerWithTimeInterval_repeats_block(0.01, true, &block) }
    };
    // In the common modes, which an alert's modal loop runs, whatever it
    // does with the main queue.
    // SAFETY: the main run loop and an immutable constant of Foundation.
    unsafe { NSRunLoop::mainRunLoop().addTimer_forMode(&timer, NSRunLoopCommonModes) };
    STEP.store(step, Ordering::SeqCst);
    until(
        &format!("step {step}'s alerts"),
        Duration::from_secs(30),
        || matches!(*watch.phase.borrow(), Phase::Done).then_some(()),
    );
    timer.invalidate();
}

/// The answers the app got are `expected`.
fn answered(expected: &[(&str, Option<&str>)]) {
    let answers = ANSWERS.lock().unwrap().clone();
    let answers: Vec<(&str, Option<&str>)> = answers
        .iter()
        .map(|(name, action)| (*name, action.as_deref()))
        .collect();
    assert_eq!(answers, expected, "the answers");
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().expect("the checks run on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    // A regular app, which an alert on its own activates.
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    app.finishLaunching();
    STEP.store(0, Ordering::SeqCst);
    ANSWERS.lock().unwrap().clear();
    FAILURES.lock().unwrap().clear();
    // The main window, never shown, as a tray app's.
    // SAFETY: The window is created on the process main thread.
    let main = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(120.0, 120.0), NSSize::new(480.0, 320.0)),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Closable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe { main.setReleasedWhenClosed(false) };
    main.setTitle(&NSString::from_str(
        "NSH alerts beside a hidden main window",
    ));
    let options = platform::AppOptions {
        size: (480, 320),
        ..Default::default()
    };
    let surface = platform::AppView::new(mtm, options);
    main.setContentView(Some(&surface.view()));
    SURFACE.with(|s| *s.borrow_mut() = Some(surface.clone()));
    MAIN.with(|m| *m.borrow_mut() = Some(main.clone()));
    surface.load(platform::App::Rust(platform::Root::of::<Alerts>()));
    until("the app's content", Duration::from_secs(5), || {
        mounted("alerts").then_some(())
    });

    // The main window hidden: each alert on its own, answered by a click
    // on its button, then by Escape (its cancel button).
    alone(1, &[("First", Act::Click)]);
    alone(2, &[("Second", Act::Escape)]);
    // The second raised while the first shows: one at a time, in order.
    alone(3, &[("Third", Act::Click), ("Fourth", Act::Escape)]);
    until("the answers", Duration::from_secs(5), || {
        (ANSWERS.lock().unwrap().len() >= 4).then_some(())
    });
    answered(&[
        ("First", Some("ok")),
        ("Second", Some("cancel")),
        ("Third", Some("ok")),
        ("Fourth", Some("cancel")),
    ]);

    // The main window shown: a sheet of it, as before, its default button
    // Return.
    main.makeKeyAndOrderFront(None);
    #[allow(deprecated)]
    app.activateIgnoringOtherApps(true);
    until("the main window in front", Duration::from_secs(5), || {
        (on_screen(&main) && main.isKeyWindow()).then_some(())
    });
    STEP.store(4, Ordering::SeqCst);
    let sheet = until("the alert as a sheet", Duration::from_secs(5), || {
        main.attachedSheet()
    });
    assert!(
        button(&sheet, "Fifth OK").is_some(),
        "the sheet is the alert's"
    );
    assert!(
        app.modalWindow().is_none(),
        "a sheet leaves the app's other windows to the user (no app-modal window)"
    );
    until(
        "the sheet with the keyboard",
        Duration::from_secs(5),
        || sheet.isKeyWindow().then_some(()),
    );
    key(&sheet, "\r", RETURN);
    until("the sheet's answer", Duration::from_secs(5), || {
        (ANSWERS.lock().unwrap().len() >= 5).then_some(())
    });
    until("the sheet gone", Duration::from_secs(5), || {
        main.attachedSheet().is_none().then_some(())
    });

    // Hidden again: the app stopping while its alert shows on its own takes
    // the alert away, unanswered.
    main.orderOut(None);
    alone(5, &[("Sixth", Act::Stop)]);
    until("the alert gone", Duration::from_secs(5), || {
        (app.modalWindow().is_none() && alerts_shown(&app).is_empty()).then_some(())
    });
    pump(300);

    SURFACE.with(|s| s.borrow_mut().take());
    MAIN.with(|m| m.borrow_mut().take());
    surface.stop();
    main.close();
    answered(&[
        ("First", Some("ok")),
        ("Second", Some("cancel")),
        ("Third", Some("ok")),
        ("Fourth", Some("cancel")),
        ("Fifth", Some("ok")),
    ]);
    println!(
        "window_alert: alerts on their own in front with the main window hidden, \
         one at a time; a sheet with it shown; gone with the app"
    );
}
