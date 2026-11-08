//! `PressRecognizer`: presses with React Native semantics in one gesture
//! recognizer: `onPressDown` when the finger lands (later inside scroll
//! views, where it may start a scroll), `onPressUp` when it lifts or
//! leaves, `onLongPress` after half a second, and `onPress` on release.
//!
//! It stays in the possible state while tracking and only recognizes on
//! release, so scroll views and pans on the same touches win whenever they
//! start first; it then fails and reports `onPressUp`.

use std::cell::Cell;

use dispatch2::{DispatchQueue, DispatchTime, MainThreadBound};
use nsh_core::{EventKind, NodeId, TextLink};
use objc2::{
    ClassType, DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send,
    rc::Retained,
};
use objc2_core_foundation::CGPoint;
use objc2_foundation::{NSObject, NSObjectProtocol, NSSet};
use objc2_ui_kit::{
    UIControl, UIEvent, UIGestureRecognizer, UIGestureRecognizerState, UIScrollView,
    UITapGestureRecognizer, UITouch, UIView, UIWindow,
};

use crate::{target::EventTarget, text_view::TextView};

/// Delay before `onPressDown` inside scroll views, so starting a scroll does
/// not flash pressed states.
const SCROLL_PRESS_DELAY: f64 = 0.13;
/// How long a press must be held to become a long press (by default).
const LONG_PRESS: f64 = 0.5;
/// How far outside the view the finger may wander before the press ends.
const RETENTION: f64 = 20.0;

pub(crate) struct PressIvars {
    target: Retained<EventTarget>,
    start: Cell<CGPoint>,
    /// `onPressDown` was reported.
    pressed: Cell<bool>,
    /// `onLongPress` fired: the release is not a press.
    long_pressed: Cell<bool>,
    /// Invalidates delayed callbacks of earlier touches.
    generation: Cell<u64>,
    /// Report long presses.
    long_press: Cell<bool>,
    /// Seconds before a press becomes a long press.
    long_press_delay: Cell<f64>,
    /// The view itself takes presses (not only its text's pressable spans).
    own: Cell<bool>,
    /// Has press handlers, rather than only tracking the pressed style.
    handles_press: Cell<bool>,
    /// The pressable text span the current touch is on: its presses go
    /// there.
    link: Cell<Option<TextLink>>,
    /// Where the touch is, and what it began with.
    at: Cell<PressAt>,
}

/// A press's touch, for its events' payload.
#[derive(Clone, Copy, Default)]
pub(crate) struct PressAt {
    /// The touch's last location, in the window's coordinates.
    pub(crate) in_window: CGPoint,
    /// The modifier keys held when the touch began (UIKeyModifierFlags).
    pub(crate) modifiers: isize,
    /// UIKit's tap count of the touch: 2 for a double tap.
    pub(crate) clicks: u32,
}

define_class!(
    #[unsafe(super(UIGestureRecognizer, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = PressIvars]
    pub(crate) struct PressRecognizer;

    impl PressRecognizer {
        #[unsafe(method(touchesBegan:withEvent:))]
        fn touches_began(&self, touches: &NSSet<UITouch>, event: &UIEvent) {
            let (Some(view), Some(touch)) = (self.view(), touches.anyObject()) else {
                return self.set_state(UIGestureRecognizerState::Failed);
            };
            if touches.count() > 1
                || self.handled_deeper(&touch, &view)
                || !self.ivars().target.press_allowed(&view)
            {
                return self.set_state(UIGestureRecognizerState::Failed);
            }
            let ivars = self.ivars();
            let link = view
                .downcast_ref::<TextView>()
                .and_then(|t| t.link_at(touch.locationInView(Some(&view))));
            ivars.link.set(link);
            if link.is_none() && !ivars.own.get() {
                return self.set_state(UIGestureRecognizerState::Failed);
            }
            let long_press = match link {
                Some(l) => l.events.contains(EventKind::LongPress),
                None => ivars.long_press.get(),
            };
            ivars.start.set(touch.locationInView(Some(&view)));
            // SAFETY: UIEvent's `modifierFlags` (iOS 13.4), a
            // UIKeyModifierFlags (NSInteger).
            let modifiers: isize = unsafe { msg_send![event, modifierFlags] };
            ivars.at.set(PressAt {
                in_window: touch.locationInView(None),
                modifiers,
                clicks: touch.tapCount().max(1) as u32,
            });
            ivars.pressed.set(false);
            ivars.long_pressed.set(false);
            let generation = ivars.generation.get() + 1;
            ivars.generation.set(generation);
            let delay = if inside_scroll_view(&view) { SCROLL_PRESS_DELAY } else { 0.0 };
            if delay == 0.0 {
                self.press_in();
            } else {
                self.after(delay, generation, |r| r.press_in());
            }
            if long_press {
                self.after(ivars.long_press_delay.get(), generation, |r| {
                    if !r.ivars().pressed.get() {
                        r.press_in();
                    }
                    r.ivars().long_pressed.set(true);
                    r.report(Report::LongPress);
                });
            }
        }

        #[unsafe(method(touchesMoved:withEvent:))]
        fn touches_moved(&self, touches: &NSSet<UITouch>, _event: &UIEvent) {
            let (Some(view), Some(touch)) = (self.view(), touches.anyObject()) else { return };
            self.track(&touch);
            let p = touch.locationInView(Some(&view));
            let b = view.bounds();
            let inside = p.x >= -RETENTION
                && p.y >= -RETENTION
                && p.x <= b.size.width + RETENTION
                && p.y <= b.size.height + RETENTION;
            if !inside {
                self.set_state(UIGestureRecognizerState::Failed);
            }
        }

        #[unsafe(method(touchesEnded:withEvent:))]
        fn touches_ended(&self, touches: &NSSet<UITouch>, _event: &UIEvent) {
            if let Some(touch) = touches.anyObject() {
                self.track(&touch);
            }
            if !self.ivars().pressed.get() {
                // A quick tap inside a scroll view: report the press in now.
                self.press_in();
            }
            // A style observer reports the pressed state without competing
            // with an ancestor that handles the click.
            self.set_state(if self.ivars().handles_press.get() || self.ivars().link.get().is_some() {
                UIGestureRecognizerState::Ended
            } else {
                UIGestureRecognizerState::Failed
            });
        }

        #[unsafe(method(touchesCancelled:withEvent:))]
        fn touches_cancelled(&self, _touches: &NSSet<UITouch>, _event: &UIEvent) {
            self.set_state(UIGestureRecognizerState::Cancelled);
        }

        #[unsafe(method(reset))]
        fn reset(&self) {
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), reset] };
            let ivars = self.ivars();
            ivars.generation.set(ivars.generation.get() + 1);
            if ivars.pressed.replace(false) {
                self.report(Report::PressOut);
            }
            ivars.link.set(None);
        }

        #[unsafe(method(canBePreventedByGestureRecognizer:))]
        fn can_be_prevented(&self, other: &UIGestureRecognizer) -> bool {
            // Taps UIKit attaches to the window skip `UIControl`s, and a
            // press stands in for one: on iOS 26+ the window's top-edge tap
            // interaction (`_UIDoubleTapInteraction`, top 64 pt, cancels
            // touches, never simultaneous) would otherwise swallow every
            // press near the top, such as a navigation bar's back button.
            !is_window_tap(other)
        }

        #[unsafe(method(canPreventGestureRecognizer:))]
        fn can_prevent(&self, other: &UIGestureRecognizer) -> bool {
            // Never block scroll views or pans: they start before a press ends.
            other.isKindOfClass(PressRecognizer::class())
        }
    }
);

#[derive(Clone, Copy)]
enum Report {
    PressIn,
    PressOut,
    LongPress,
}

impl PressRecognizer {
    pub(crate) fn new(mtm: MainThreadMarker, target: &Retained<EventTarget>) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(PressIvars {
            target: target.clone(),
            start: Cell::new(CGPoint::ZERO),
            pressed: Cell::new(false),
            long_pressed: Cell::new(false),
            generation: Cell::new(0),
            long_press: Cell::new(false),
            long_press_delay: Cell::new(LONG_PRESS),
            own: Cell::new(false),
            handles_press: Cell::new(false),
            link: Cell::new(None),
            at: Cell::new(PressAt::default()),
        });
        // SAFETY: the designated initializer; `handlePress:` is implemented by
        // the target, which outlives the recognizer.
        let this: Retained<Self> = unsafe {
            msg_send![super(this), initWithTarget: &**target, action: objc2::sel!(handlePress:)]
        };
        this.setCancelsTouchesInView(false);
        this.setDelaysTouchesEnded(false);
        this
    }

    /// Whether long presses are reported.
    pub(crate) fn set_long_press(&self, on: bool) {
        self.ivars().long_press.set(on);
    }

    /// `delayLongPress` in milliseconds (the default when `None`).
    pub(crate) fn set_long_press_delay(&self, ms: Option<f32>) {
        self.ivars()
            .long_press_delay
            .set(ms.map_or(LONG_PRESS, |ms| ms as f64 / 1000.0));
    }

    /// Whether the view itself takes presses.
    pub(crate) fn set_own(&self, on: bool, handles_press: bool) {
        self.ivars().own.set(on);
        self.ivars().handles_press.set(handles_press);
    }

    /// The pressable text span the current press is on.
    pub(crate) fn link(&self) -> Option<TextLink> {
        self.ivars().link.get()
    }

    /// Where the current press's touch is.
    pub(crate) fn at(&self) -> PressAt {
        self.ivars().at.get()
    }

    fn track(&self, touch: &UITouch) {
        let at = self.ivars().at.get();
        self.ivars().at.set(PressAt {
            in_window: touch.locationInView(None),
            ..at
        });
    }

    /// The touch ended on the view: reports the press out, and returns
    /// true if this was a press (not a long press).
    pub(crate) fn release(&self) -> bool {
        if self.ivars().pressed.replace(false) {
            self.report(Report::PressOut);
        }
        !self.ivars().long_pressed.get()
    }

    fn set_state(&self, state: UIGestureRecognizerState) {
        // SAFETY: `setState:` is the subclass API of UIGestureRecognizer.
        let _: () = unsafe { msg_send![self, setState: state] };
    }

    fn press_in(&self) {
        if !self.ivars().pressed.replace(true) {
            self.report(Report::PressIn);
        }
    }

    fn report(&self, report: Report) {
        let target = &self.ivars().target;
        let Some(view) = self.view() else { return };
        let id = view.tag() as NodeId;
        let at = self.ivars().at.get();
        if let Some(link) = self.ivars().link.get() {
            let kind = match report {
                Report::PressIn => EventKind::PressDown,
                Report::PressOut => EventKind::PressUp,
                Report::LongPress => EventKind::LongPress,
            };
            return target.link_event(&link, kind, id, at);
        }
        match report {
            Report::PressIn => target.press_changed(id, true, at),
            Report::PressOut => target.press_changed(id, false, at),
            Report::LongPress => target.long_press(id, at),
        }
    }

    /// Runs `f` after `delay` seconds unless the touch ended meanwhile.
    fn after(&self, delay: f64, generation: u64, f: impl FnOnce(&PressRecognizer) + 'static) {
        let this = MainThreadBound::new(self.retain(), self.mtm());
        let f = MainThreadBound::new(f, self.mtm());
        let when = DispatchTime::NOW.time((delay * 1e9) as i64);
        DispatchQueue::main()
            .after(when, move || {
                let mtm = MainThreadMarker::new().expect("main queue");
                let this = this.get(mtm);
                let state = this.state();
                if this.ivars().generation.get() == generation
                    && matches!(state, UIGestureRecognizerState::Possible)
                {
                    (f.into_inner(mtm))(this);
                }
            })
            .ok();
    }

    /// A deeper pressable view or a control under the finger handles the
    /// touch (only the innermost pressable reacts, as in React Native).
    fn handled_deeper(&self, touch: &UITouch, view: &UIView) -> bool {
        let mut current = touch.view();
        while let Some(v) = current {
            if std::ptr::eq::<UIView>(&*v, view) {
                return false;
            }
            if v.isKindOfClass(UIControl::class()) {
                return true;
            }
            if let Some(recognizers) = v.gestureRecognizers()
                && recognizers.iter().any(|r| {
                    r.isEnabled()
                        && r.downcast_ref::<PressRecognizer>().is_some_and(|r| {
                            r.ivars().handles_press.get()
                                || v.downcast_ref::<TextView>().is_some_and(|t| {
                                    t.link_at(touch.locationInView(Some(&v))).is_some()
                                })
                        })
                })
            {
                return true;
            }
            current = v.superview();
        }
        false
    }
}

/// A tap recognizer UIKit attaches to a window (the top-edge tap
/// interaction, keyboard dismissal): it ignores controls, so it must not
/// prevent a press either. Edge-gesture gates are not taps and still do.
fn is_window_tap(recognizer: &UIGestureRecognizer) -> bool {
    recognizer.isKindOfClass(UITapGestureRecognizer::class())
        && recognizer
            .view()
            .is_some_and(|view| view.isKindOfClass(UIWindow::class()))
}

fn inside_scroll_view(view: &UIView) -> bool {
    let mut current = view.superview();
    while let Some(v) = current {
        if v.isKindOfClass(UIScrollView::class()) {
            return true;
        }
        current = v.superview();
    }
    false
}
