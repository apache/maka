//! The platform's part of `nsh test --target ios` (`nsh_testing::agent`):
//! where a node's view is in the window, and what a user's fingers and
//! keyboard do there, as IOHID events UIKit takes as the system's
//! ([`crate::synth`]): the touches go through hit testing, gesture
//! recognizers, scroll views and text inputs as real ones do. The agent
//! calls from a thread of its own; each call does its work on the main
//! queue (`exec_sync`) and returns once the input is handed over.

use std::{cell::RefCell, rc::Weak, time::Duration};

use dispatch2::DispatchQueue;
use nsh_core::{
    NodeId,
    geometry::{Bounds, Point, Points, Size, point},
};
use nsh_testing::agent::{Key, Native};
use objc2::msg_send;
use objc2_core_foundation::CGRect;
use objc2_ui_kit::{UIView, UIWindow};
use rustc_hash::FxHashMap;

use crate::{
    synth::{self, Phase},
    view::Inner,
};

/// A tap's hold, as a quick tap's.
const TAP: Duration = Duration::from_millis(60);
/// The time between typed keys.
const KEY: Duration = Duration::from_millis(80);
/// A finger's moves, a display frame apart.
const FRAME: Duration = Duration::from_millis(16);
/// How far a finger moves in one frame at most, in points.
const MOVE_STEP: f64 = 20.0;
/// How long a finger rests before it lifts at the end of a scroll, so the
/// scroll view keeps no velocity (no fling after it).
const REST: Duration = Duration::from_millis(120);

thread_local! {
    /// The views agents act on, by key (main thread).
    static VIEWS: RefCell<FxHashMap<u64, Weak<Inner>>> = RefCell::default();
}

/// The view `key` names to agents from now on (on the main thread).
pub(crate) fn register(key: u64, view: Weak<Inner>) {
    VIEWS.with(|v| v.borrow_mut().insert(key, view));
}

/// The view the agent acts on, by key (its calls must be `Send`).
pub(crate) struct IosNative {
    key: u64,
}

impl IosNative {
    pub(crate) fn new(key: u64) -> Self {
        IosNative { key }
    }

    /// `f` with the view and its window on the main queue, waited for;
    /// `None` once either is gone.
    fn on_main<R: Send>(&self, f: impl FnOnce(&Inner, &UIWindow) -> R + Send) -> Option<R> {
        let key = self.key;
        let mut out = None;
        let slot = &mut out;
        DispatchQueue::main().exec_sync(move || {
            let Some(view) = VIEWS.with(|v| v.borrow().get(&key).and_then(Weak::upgrade)) else {
                return;
            };
            let Some(window) = view.container.window() else {
                return;
            };
            *slot = Some(f(&view, &window));
        });
        out
    }

    fn finger(&self, x: f64, y: f64, phase: Phase) {
        self.on_main(move |_, window| synth::touch(window, x, y, phase));
    }

    /// A finger down at `from`, moving to `to` a frame at a time, easing
    /// out, resting, then lifting (a scroll, a swipe).
    fn swipe(&self, from: (f64, f64), to: (f64, f64), rest: Duration) {
        let (dx, dy) = (to.0 - from.0, to.1 - from.1);
        let n = ((dx.abs().max(dy.abs()) / MOVE_STEP).ceil() as u32).max(1);
        self.finger(from.0, from.1, Phase::Down);
        for i in 1..=n {
            std::thread::sleep(FRAME);
            // Easing out, as a finger that stops slows down first: the
            // scroll view sees no speed left when it lifts.
            let t = 1.0 - (1.0 - f64::from(i) / f64::from(n)).powi(3);
            self.finger(from.0 + dx * t, from.1 + dy * t, Phase::Move);
        }
        // A resting finger still reports where it is, every frame: the
        // scroll view sees it stop, so it lifts without a fling.
        let resting = std::time::Instant::now();
        while resting.elapsed() < rest {
            std::thread::sleep(FRAME);
            self.finger(to.0, to.1, Phase::Move);
        }
        self.finger(to.0, to.1, Phase::Up);
    }

    fn tap(&self, x: f64, y: f64, hold: Duration) {
        self.finger(x, y, Phase::Down);
        std::thread::sleep(hold);
        self.finger(x, y, Phase::Up);
        // Touches made in process leave the first responder where it was
        // (UI test tools give it as KIF does): a tap that lands in a text
        // input focuses it, as a finger's does.
        self.on_main(move |_, window| synth::focus_input_at(window, x, y));
    }
}

/// `rect` of `view` in `window`'s points, if the view shows.
fn bounds_in(view: &UIView, rect: CGRect, window: &UIWindow) -> Option<Bounds<Points>> {
    if view.window().is_none() || view.isHidden() {
        return None;
    }
    let r = view.convertRect_toView(rect, Some(window));
    Some(Bounds::new(
        point(Points(r.origin.x as f32), Points(r.origin.y as f32)),
        Size::new(Points(r.size.width as f32), Points(r.size.height as f32)),
    ))
}

impl Native for IosNative {
    fn bounds(&self, id: NodeId) -> Option<Bounds<Points>> {
        self.on_main(move |view, window| {
            let ui = view.with_mounter(|m| m.ui_view(id))??;
            bounds_in(&ui, ui.bounds(), window)
        })
        .flatten()
    }

    fn text_bounds(&self, text: NodeId, start: u32, end: u32) -> Option<Bounds<Points>> {
        self.on_main(move |view, window| {
            let text = view.with_mounter(|m| m.text_view(text))??;
            let (rect, ..) = *text.range_rects(start as usize, end as usize).first()?;
            bounds_in(&text, rect, window)
        })
        .flatten()
    }

    fn viewport(&self) -> Size<Points> {
        self.on_main(|_, window| {
            let s = window.bounds().size;
            Size::new(Points(s.width as f32), Points(s.height as f32))
        })
        .unwrap_or(Size::new(Points(0.0), Points(0.0)))
    }

    fn press(&self, at: Point<Points>) {
        self.tap(f64::from(at.x.0), f64::from(at.y.0), TAP);
    }

    fn long_press(&self, at: Point<Points>, hold: Duration) {
        self.tap(f64::from(at.x.0), f64::from(at.y.0), hold);
    }

    fn scroll(&self, at: Point<Points>, delta: Point<Points>) {
        // The content moves towards its end as the finger moves the other
        // way.
        let from = (f64::from(at.x.0), f64::from(at.y.0));
        let to = (from.0 - f64::from(delta.x.0), from.1 - f64::from(delta.y.0));
        self.swipe(from, to, REST);
    }

    fn drag(&self, from: Point<Points>, to: Point<Points>) {
        let xy = |p: Point<Points>| (f64::from(p.x.0), f64::from(p.y.0));
        let (x, y) = xy(from);
        self.finger(x, y, Phase::Down);
        std::thread::sleep(nsh_testing::agent::LANDING);
        let mut last = (x, y);
        for at in nsh_testing::agent::drag_path(from, to) {
            std::thread::sleep(nsh_testing::agent::FRAME);
            last = xy(at);
            self.finger(last.0, last.1, Phase::Move);
        }
        self.finger(last.0, last.1, Phase::Up);
    }

    fn paste(&self, content: &nsh_core::PasteEvent) -> Result<(), String> {
        let content = content.clone();
        self.on_main(move |_, window| crate::input::test_paste(window, &content))
            .unwrap_or_else(|| Err("the window is gone".into()))
    }

    fn type_text(&self, text: &str) {
        // As the software keyboard types, a character at a time, at a
        // quick typist's pace: a controlled input's value comes back from
        // the app between keys, as it does on a device.
        for ch in text.chars() {
            let s = ch.to_string();
            self.on_main(move |_, window| synth::insert_text(window, &s));
            std::thread::sleep(KEY);
        }
    }

    fn key(&self, key: Key) {
        self.on_main(move |_, window| match key {
            // The keyboard's return key types a line break.
            Key::Return => synth::insert_text(window, "\n"),
            Key::Backspace => synth::delete_backward(window),
            Key::SelectAll => synth::select_all(window),
        });
    }

    fn press_keys(&self, keys: &str) -> Result<(), String> {
        use nsh_core::keymap::Keystroke;
        let stroke =
            Keystroke::parse(keys, nsh_core::platform::Os::Ios).map_err(|e| e.to_string())?;
        let usage = stroke
            .key
            .hid_usage()
            .ok_or_else(|| format!("a hardware keyboard has no key {keys:?}"))?;
        let m = stroke.modifiers;
        let modifiers: Vec<u16> = [
            (m.ctrl, synth::CONTROL),
            (m.alt, synth::OPTION),
            (m.shift, synth::SHIFT),
            (m.cmd, synth::COMMAND),
        ]
        .into_iter()
        .filter_map(|(on, usage)| on.then_some(usage))
        .collect();
        // As a hand presses a shortcut: the modifiers down first, the key
        // pressed and released, then the modifiers released.
        let held = modifiers.clone();
        self.on_main(move |_, window| {
            for usage in held {
                synth::key(window, usage, true);
            }
            synth::key(window, usage, true)
        })
        .filter(|sent| *sent)
        .ok_or_else(|| "the simulator takes no keyboard events".to_owned())?;
        std::thread::sleep(TAP);
        self.on_main(move |_, window| {
            synth::key(window, usage, false);
            for usage in modifiers.into_iter().rev() {
                synth::key(window, usage, false);
            }
        });
        Ok(())
    }

    fn input_text(&self, id: NodeId) -> Option<String> {
        self.on_main(move |view, _| view.with_mounter(|m| m.input_text(id)).flatten())
            .flatten()
    }

    fn back(&self) -> Result<(), String> {
        // What a user does: a sheet is swiped down; while the app listens
        // to going back (a menu's or popover's `onCancel`, over the whole
        // screen), VoiceOver's escape gesture reaches the surface, as the
        // headless driver's back reaches the core; a pushed screen goes
        // with the header's back button.
        enum Gesture {
            Tap(f64, f64),
            Swipe((f64, f64), (f64, f64)),
            Escaped,
        }
        let gesture = self
            .on_main(|view, window| {
                let size = window.bounds().size;
                if let Some(sheet) = crate::navigation::presented_sheet(window) {
                    let top = sheet
                        .convertRect_toView(sheet.bounds(), Some(window))
                        .origin
                        .y;
                    let x = size.width / 2.0;
                    return Ok(Gesture::Swipe(
                        (x, top + 20.0),
                        (x, top + size.height * 0.6),
                    ));
                }
                // Taken out first: the escape reads the mounter too.
                let root = view
                    .with_mounter(|m| m.ui_view(nsh_core::ROOT_ID))
                    .flatten();
                // SAFETY: a UIAccessibilityAction method every view has.
                if root.is_some_and(|r| unsafe { msg_send![&r, accessibilityPerformEscape] }) {
                    return Ok(Gesture::Escaped);
                }
                let button = crate::navigation::back_button(window)
                    .ok_or("the screen shows no back button to go back with")?;
                let r = button.convertRect_toView(button.bounds(), Some(window));
                Ok(Gesture::Tap(
                    r.origin.x + r.size.width / 2.0,
                    r.origin.y + r.size.height / 2.0,
                ))
            })
            .unwrap_or_else(|| Err("the window is gone".to_owned()))?;
        match gesture {
            Gesture::Tap(x, y) => self.tap(x, y, TAP),
            Gesture::Swipe(from, to) => self.swipe(from, to, Duration::ZERO),
            Gesture::Escaped => {}
        }
        Ok(())
    }

    fn answer_dialog(&self, button: Option<&str>) -> Result<(), String> {
        let button = button.map(str::to_owned);
        let (x, y) = self
            .on_main(move |_, window| crate::system::dialog_point(window, button.as_deref()))
            .unwrap_or_else(|| Err("the window is gone".into()))?;
        self.tap(x, y, TAP);
        Ok(())
    }

    fn animating(&self) -> bool {
        self.on_main(|view, window| {
            view.with_mounter(|m| m.animating()).unwrap_or(false) || synth::animating(window)
        })
        .unwrap_or(false)
    }

    fn screenshot(&self) -> Result<Vec<u8>, String> {
        self.on_main(|_, window| synth::screenshot(window))
            .unwrap_or_else(|| Err("the window is gone".into()))
    }

    fn resize(&self, _: Points, _: Points) -> Result<(), String> {
        Err("a simulator's screen keeps its device's size".into())
    }

    fn set_dark(&self, _: bool) -> Result<(), String> {
        // The system's appearance is the simulator's, which `nsh test`
        // switches (`simctl ui appearance`).
        Err("the simulator's settings switch its appearance".into())
    }

    fn quit(&self) {
        // The test's side ends the app (`simctl terminate`).
    }
}
