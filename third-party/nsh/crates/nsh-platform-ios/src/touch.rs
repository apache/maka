//! `TouchTracker`: reports touches to the JS responder system (`onTouch`);
//! `PanGate`: a view's `panActivation`.
//!
//! One tracker sits on the surface root and on each modal's root. It only
//! observes: it never recognizes in a way that blocks other gestures, and
//! views still get their touches. Touches start being tracked when the view
//! under them, or one around it, listens to `onTouch`.
//!
//! A gate sits on each view with a `panActivation` whose native pan or
//! responder follows it (`nsh_core::input::gate_activation`; not on one
//! whose pan is off, which leaves the drags to its content) and decides,
//! as the fingers move, whether its pan activates
//! ([`PanActivation::decide`]): the pans of the scroll views around it
//! must wait for it to fail
//! (`shouldBeRequiredToFailByGestureRecognizer:`), so they keep the touches
//! when it fails and never get them when it activates; the activation goes
//! to the engine with the tracker's touches (`TouchEvent::activated`), and
//! the view becomes the responder there. A scroll view inside the view
//! waits too when the gate names one axis it cannot scroll along (a
//! sideways pan around a vertical list): UIScrollView's pan begins once
//! the finger has moved its slop along its path, so without the wait it
//! would take a mostly sideways diagonal before the gate decides, unlike
//! the other platforms, where such a list takes only movements mostly
//! along its axis (`nsh_core::input::Candidate::accepts`).

use std::cell::{Cell, RefCell};

use nsh_core::{
    NodeId, PanActivation, Point, Points, Size, TouchEvent, TouchPhase, TouchPoint, geometry::point,
};
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send, rc::Retained,
};
use objc2_core_foundation::CGPoint;
use objc2_foundation::{NSObject, NSObjectProtocol, NSSet};
use objc2_ui_kit::{
    UIEvent, UIGestureRecognizer, UIGestureRecognizerState, UIPanGestureRecognizer, UIScrollView,
    UITouch, UIView,
};

use crate::target::EventTarget;

/// A finger being tracked.
pub(crate) struct Tracked {
    touch: Retained<UITouch>,
    id: u32,
    target: NodeId,
    /// The target's view, for `locationX/Y`.
    view: Retained<UIView>,
    path: Vec<NodeId>,
}

pub(crate) struct TrackerIvars {
    target: Retained<EventTarget>,
    tracked: RefCell<Vec<Tracked>>,
    /// The timestamp of the touches last reported.
    reported: Cell<f64>,
    /// A gate activated with touches not reported yet: the next report
    /// carries it.
    activated: Cell<Option<NodeId>>,
}

thread_local! {
    /// Finger identifiers, unique across trackers.
    static NEXT_ID: Cell<u32> = const { Cell::new(0) };
}

define_class!(
    #[unsafe(super(UIGestureRecognizer, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = TrackerIvars]
    pub(crate) struct TouchTracker;

    unsafe impl NSObjectProtocol for TouchTracker {}

    impl TouchTracker {
        #[unsafe(method(touchesBegan:withEvent:))]
        fn touches_began(&self, touches: &NSSet<UITouch>, _event: &UIEvent) {
            self.ivars()
                .target
                .input_with(nsh_core::platform::InputModality::Pointer);
            let mut began = Vec::new();
            for touch in touches.iter() {
                let Some(view) = touch.view() else { continue };
                let point = touch.locationInView(Some(&view));
                let Some((target, target_view, path)) =
                    self.ivars().target.touch_target(&view, point)
                else {
                    continue;
                };
                let id = NEXT_ID.get();
                NEXT_ID.set(id.wrapping_add(1));
                began.push(Tracked {
                    touch: touch.retain(),
                    id,
                    target,
                    view: target_view,
                    path,
                });
            }
            if began.is_empty() {
                return;
            }
            let changed: Vec<u32> = began.iter().map(|t| t.id).collect();
            self.ivars().tracked.borrow_mut().extend(began);
            self.report(TouchPhase::Start, &changed);
        }

        #[unsafe(method(touchesMoved:withEvent:))]
        fn touches_moved(&self, touches: &NSSet<UITouch>, _event: &UIEvent) {
            let changed = self.ids_of(touches);
            if !changed.is_empty() {
                self.report(TouchPhase::Move, &changed);
            }
        }

        #[unsafe(method(touchesEnded:withEvent:))]
        fn touches_ended(&self, touches: &NSSet<UITouch>, _event: &UIEvent) {
            // A tap that only dismisses the keyboard reaches no responder.
            let dismissing = touches.count() == 1
                && touches
                    .anyObject()
                    .is_some_and(|t| self.ivars().target.dismissing_tap(&t));
            self.lift(touches, if dismissing { TouchPhase::Cancel } else { TouchPhase::End });
        }

        #[unsafe(method(touchesCancelled:withEvent:))]
        fn touches_cancelled(&self, touches: &NSSet<UITouch>, _event: &UIEvent) {
            self.lift(touches, TouchPhase::Cancel);
        }

        #[unsafe(method(reset))]
        fn reset(&self) {
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), reset] };
            self.cancel_all();
        }

        #[unsafe(method(canBePreventedByGestureRecognizer:))]
        fn can_be_prevented(&self, _other: &UIGestureRecognizer) -> bool {
            false
        }

        #[unsafe(method(canPreventGestureRecognizer:))]
        fn can_prevent(&self, _other: &UIGestureRecognizer) -> bool {
            false
        }
    }
);

impl TouchTracker {
    pub(crate) fn new(mtm: MainThreadMarker, target: &Retained<EventTarget>) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(TrackerIvars {
            target: target.clone(),
            tracked: RefCell::new(Vec::new()),
            reported: Cell::new(f64::NAN),
            activated: Cell::new(None),
        });
        // SAFETY: the designated initializer, without an action.
        let this: Retained<Self> = unsafe {
            msg_send![super(this), initWithTarget: Option::<&NSObject>::None, action: Option::<objc2::runtime::Sel>::None]
        };
        this.setCancelsTouchesInView(false);
        this.setDelaysTouchesBegan(false);
        this.setDelaysTouchesEnded(false);
        this
    }

    /// The pan gate of view `id` activated with the touches of `timestamp`
    /// (seconds): reported with them, now if they already were.
    fn activate(&self, id: NodeId, timestamp: f64) {
        let tracked: Vec<u32> = self.ivars().tracked.borrow().iter().map(|t| t.id).collect();
        if tracked.is_empty() {
            return;
        }
        self.ivars().activated.set(Some(id));
        if self.ivars().reported.get() == timestamp * 1000.0 {
            self.report(TouchPhase::Move, &tracked);
        }
    }

    /// A native gesture (a scroll view) took the touches over: JS gets a
    /// cancel and hears no more of them.
    pub(crate) fn cancel_all(&self) {
        if self.ivars().tracked.borrow().is_empty() {
            return;
        }
        let changed: Vec<u32> = self.ivars().tracked.borrow().iter().map(|t| t.id).collect();
        self.report(TouchPhase::Cancel, &changed);
        self.ivars().tracked.borrow_mut().clear();
    }

    fn ids_of(&self, touches: &NSSet<UITouch>) -> Vec<u32> {
        let tracked = self.ivars().tracked.borrow();
        touches
            .iter()
            .filter_map(|touch| {
                tracked
                    .iter()
                    .find(|t| std::ptr::eq::<UITouch>(&*t.touch, &*touch))
                    .map(|t| t.id)
            })
            .collect()
    }

    fn lift(&self, touches: &NSSet<UITouch>, phase: TouchPhase) {
        let changed = self.ids_of(touches);
        if !changed.is_empty() {
            self.report(phase, &changed);
            self.ivars()
                .tracked
                .borrow_mut()
                .retain(|t| !changed.contains(&t.id));
        }
        if self.ivars().tracked.borrow().is_empty() {
            self.ivars().activated.set(None);
            // Done with this sequence (a possible recognizer would wait).
            // SAFETY: `setState:` is the subclass API of UIGestureRecognizer.
            let _: () = unsafe { msg_send![self, setState: UIGestureRecognizerState::Failed] };
        }
    }

    /// Sends the tracked fingers, `changed` marking those the event is
    /// about (with their paths when they `start`).
    fn report(&self, phase: TouchPhase, changed: &[u32]) {
        let Some(root) = self.view() else { return };
        let tracked = self.ivars().tracked.borrow();
        let mut timestamp = 0.0;
        let points = tracked
            .iter()
            .map(|t| {
                let page = t.touch.locationInView(Some(&root));
                let local = t.touch.locationInView(Some(&t.view));
                timestamp = t.touch.timestamp() * 1000.0;
                let is_changed = changed.contains(&t.id);
                let pencil = t.touch.r#type() == objc2_ui_kit::UITouchType::Pencil;
                let max_force = t.touch.maximumPossibleForce();
                let tilt = if pencil {
                    tilt(
                        t.touch.altitudeAngle(),
                        t.touch.azimuthAngleInView(Some(&root)),
                    )
                } else {
                    (0.0, 0.0)
                };
                TouchPoint {
                    id: t.id,
                    target: t.target,
                    path: if phase == TouchPhase::Start && is_changed {
                        t.path.clone()
                    } else {
                        Vec::new()
                    },
                    page: point(Points(page.x as f32), Points(page.y as f32)),
                    location: point(Points(local.x as f32), Points(local.y as f32)),
                    changed: is_changed,
                    pointer_type: if pencil {
                        nsh_core::PointerType::Pen
                    } else {
                        nsh_core::PointerType::Touch
                    },
                    pressure: if is_changed && matches!(phase, TouchPhase::End | TouchPhase::Cancel)
                    {
                        0.0
                    } else if max_force > 0.0 {
                        (t.touch.force() / max_force).clamp(0.0, 1.0) as f32
                    } else {
                        0.5
                    },
                    tilt_x: tilt.0,
                    tilt_y: tilt.1,
                }
            })
            .collect();
        drop(tracked);
        self.ivars().reported.set(timestamp);
        self.ivars().target.touches(Box::new(TouchEvent {
            phase,
            timestamp,
            points,
            modifiers: Default::default(),
            activated: self.ivars().activated.take(),
        }));
    }
}

pub(crate) struct GateIvars {
    activation: Cell<PanActivation>,
    /// The finger the gate follows and where it went down (window points).
    finger: RefCell<Option<(Retained<UITouch>, CGPoint)>>,
    /// The finger's offset from there at its last move.
    judged: Cell<Point<Points>>,
}

define_class!(
    /// `panActivation`: recognizes a pan once the finger passes an active
    /// offset, fails once it passes a fail offset first. It has no action:
    /// recognizing makes the scroll views around it fail, and the
    /// activation goes to the engine with the touches.
    #[unsafe(super(UIGestureRecognizer, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = GateIvars]
    pub(crate) struct PanGate;

    unsafe impl NSObjectProtocol for PanGate {}

    impl PanGate {
        #[unsafe(method(touchesBegan:withEvent:))]
        fn touches_began(&self, touches: &NSSet<UITouch>, _event: &UIEvent) {
            if self.ivars().finger.borrow().is_some() {
                return;
            }
            let Some(touch) = touches.iter().next() else {
                return;
            };
            let at = touch.locationInView(None);
            // An edge pan starts only from its edge of the window.
            if !starts_at(&self.ivars().activation.get(), &touch, at) {
                self.set_state(UIGestureRecognizerState::Failed);
                return;
            }
            *self.ivars().finger.borrow_mut() = Some((touch.retain(), at));
            self.ivars().judged.set(Point::default());
        }

        #[unsafe(method(touchesMoved:withEvent:))]
        fn touches_moved(&self, _touches: &NSSet<UITouch>, _event: &UIEvent) {
            let state = self.state();
            if state == UIGestureRecognizerState::Began || state == UIGestureRecognizerState::Changed {
                self.set_state(UIGestureRecognizerState::Changed);
                return;
            }
            if state != UIGestureRecognizerState::Possible {
                return;
            }
            let Some((touch, start)) = self.ivars().finger.borrow().clone() else {
                return;
            };
            let at = touch.locationInView(None);
            // Judged along the line from the last move: one move of a
            // diagonal can pass both offsets.
            let to = point(Points((at.x - start.x) as f32), Points((at.y - start.y) as f32));
            let from = self.ivars().judged.replace(to);
            match self.ivars().activation.get().decide_move(from, to) {
                Some(true) => {
                    self.set_state(UIGestureRecognizerState::Began);
                    self.report_activation(touch.timestamp());
                }
                Some(false) => self.set_state(UIGestureRecognizerState::Failed),
                None => {}
            }
        }

        #[unsafe(method(touchesEnded:withEvent:))]
        fn touches_ended(&self, touches: &NSSet<UITouch>, _event: &UIEvent) {
            self.lift(touches, UIGestureRecognizerState::Ended);
        }

        #[unsafe(method(touchesCancelled:withEvent:))]
        fn touches_cancelled(&self, touches: &NSSet<UITouch>, _event: &UIEvent) {
            self.lift(touches, UIGestureRecognizerState::Cancelled);
        }

        #[unsafe(method(reset))]
        fn reset(&self) {
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), reset] };
            self.ivars().finger.borrow_mut().take();
        }

        /// The pans of the scroll views around the view, and of those
        /// inside it across its axis, wait for the gate.
        #[unsafe(method(shouldBeRequiredToFailByGestureRecognizer:))]
        fn should_be_required_to_fail_by(&self, other: &UIGestureRecognizer) -> bool {
            self.holds_back(other)
        }

        /// An edge pan lets a stack's swipe back go first.
        #[unsafe(method(shouldRequireFailureOfGestureRecognizer:))]
        fn should_require_failure_of(&self, other: &UIGestureRecognizer) -> bool {
            self.ivars().activation.get().edge.is_some()
                && self
                    .view()
                    .is_some_and(|view| crate::navigation::is_back_swipe(&view, other))
        }

        /// Recognizers on the same view (`pan`, `pinch`) go on with it.
        #[unsafe(method(canPreventGestureRecognizer:))]
        fn can_prevent(&self, other: &UIGestureRecognizer) -> bool {
            match (self.view(), other.view()) {
                (Some(a), Some(b)) => !std::ptr::eq::<UIView>(&*a, &*b),
                _ => true,
            }
        }
    }
);

impl PanGate {
    pub(crate) fn new(mtm: MainThreadMarker, activation: PanActivation) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(GateIvars {
            activation: Cell::new(activation),
            finger: RefCell::new(None),
            judged: Cell::new(Point::default()),
        });
        // SAFETY: the designated initializer, without an action.
        let this: Retained<Self> = unsafe {
            msg_send![super(this), initWithTarget: Option::<&NSObject>::None, action: Option::<objc2::runtime::Sel>::None]
        };
        // The view and the views inside it still get their touches.
        this.setCancelsTouchesInView(false);
        this.setDelaysTouchesBegan(false);
        this.setDelaysTouchesEnded(false);
        this
    }

    pub(crate) fn set_activation(&self, activation: PanActivation) {
        self.ivars().activation.set(activation);
    }

    /// Whether `other` is the pan of a scroll view around the view, or of
    /// one inside it that cannot scroll along the gate's one axis: until
    /// the gate decides, the finger's movement is the gate's to judge.
    /// Asked once per recognition attempt, so a scroll view's content
    /// growing past its bounds takes effect with the next touch.
    fn holds_back(&self, other: &UIGestureRecognizer) -> bool {
        let (Some(view), Some(other_view)) = (self.view(), other.view()) else {
            return false;
        };
        let Some(scroll) = other_view.downcast_ref::<UIScrollView>() else {
            return false;
        };
        let pan = scroll.panGestureRecognizer();
        let pan: &UIGestureRecognizer = &pan;
        if !std::ptr::eq(pan, other) {
            return false;
        }
        if view.isDescendantOfView(scroll) {
            return true;
        }
        let Some(horizontal) = self.ivars().activation.get().axis() else {
            return false;
        };
        scroll.isDescendantOfView(&view) && !scrolls_along(scroll, horizontal)
    }

    fn set_state(&self, state: UIGestureRecognizerState) {
        // SAFETY: `setState:` is the subclass API of UIGestureRecognizer.
        let _: () = unsafe { msg_send![self, setState: state] };
    }

    fn lift(&self, touches: &NSSet<UITouch>, how: UIGestureRecognizerState) {
        let followed = self
            .ivars()
            .finger
            .borrow()
            .as_ref()
            .is_some_and(|(finger, _)| {
                touches
                    .iter()
                    .any(|t| std::ptr::eq::<UITouch>(&*t, &**finger))
            });
        if !followed {
            return;
        }
        let state = self.state();
        self.set_state(
            if state == UIGestureRecognizerState::Began
                || state == UIGestureRecognizerState::Changed
            {
                how
            } else {
                UIGestureRecognizerState::Failed
            },
        );
    }

    /// Tells the tracker of the root around the view, which reports the
    /// activation with the touches of `timestamp`.
    fn report_activation(&self, timestamp: f64) {
        let Some(view) = self.view() else { return };
        let id = view.tag() as NodeId;
        let mut current = Some(view);
        while let Some(v) = current {
            if let Some(recognizers) = v.gestureRecognizers() {
                for r in recognizers.iter() {
                    if let Some(tracker) = r.downcast_ref::<TouchTracker>() {
                        tracker.activate(id, timestamp);
                        return;
                    }
                }
            }
            current = v.superview();
        }
    }
}

/// Whether a finger going down at `at` (window points) may start a pan with
/// `activation`: an edge pan's finger goes down at its edge of the window.
fn starts_at(activation: &PanActivation, touch: &UITouch, at: CGPoint) -> bool {
    let Some(window) = touch.window() else {
        return true;
    };
    let size = window.bounds().size;
    activation.starts_at(
        point(Points(at.x as f32), Points(at.y as f32)),
        Size::new(Points(size.width as f32), Points(size.height as f32)),
    )
}

pub(crate) struct ActivatedPanIvars {
    activation: Cell<PanActivation>,
    /// The finger the activation follows and where it went down (window
    /// points).
    finger: RefCell<Option<(Retained<UITouch>, CGPoint)>>,
    /// The finger's offset from there at its last move.
    judged: Cell<Point<Points>>,
    /// The activation activated: the pan recognizes as usual.
    active: Cell<bool>,
}

define_class!(
    /// A view's own pan (`pan`, `onPanStart`) with a `panActivation` along
    /// a way or past offsets: it sees the finger's moves only once the
    /// activation activates, so it begins then, and fails when the
    /// activation fails. Edge pans use `UIScreenEdgePanGestureRecognizer`.
    #[unsafe(super(UIPanGestureRecognizer, UIGestureRecognizer, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ActivatedPanIvars]
    pub(crate) struct ActivatedPan;

    unsafe impl NSObjectProtocol for ActivatedPan {}

    impl ActivatedPan {
        #[unsafe(method(touchesBegan:withEvent:))]
        fn touches_began(&self, touches: &NSSet<UITouch>, event: &UIEvent) {
            if self.ivars().finger.borrow().is_none()
                && let Some(touch) = touches.iter().next()
            {
                let at = touch.locationInView(None);
                *self.ivars().finger.borrow_mut() = Some((touch.retain(), at));
                self.ivars().judged.set(Point::default());
            }
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), touchesBegan: touches, withEvent: event] };
        }

        #[unsafe(method(touchesMoved:withEvent:))]
        fn touches_moved(&self, touches: &NSSet<UITouch>, event: &UIEvent) {
            if !self.ivars().active.get() {
                let Some((touch, start)) = self.ivars().finger.borrow().clone() else {
                    return;
                };
                let at = touch.locationInView(None);
                let to = point(Points((at.x - start.x) as f32), Points((at.y - start.y) as f32));
                let from = self.ivars().judged.replace(to);
                match self.ivars().activation.get().decide_move(from, to) {
                    Some(true) => self.ivars().active.set(true),
                    Some(false) => {
                        // SAFETY: `setState:` is the subclass API of
                        // UIGestureRecognizer.
                        let _: () =
                            unsafe { msg_send![self, setState: UIGestureRecognizerState::Failed] };
                        return;
                    }
                    None => return,
                }
            }
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), touchesMoved: touches, withEvent: event] };
        }

        #[unsafe(method(reset))]
        fn reset(&self) {
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), reset] };
            self.ivars().finger.borrow_mut().take();
            self.ivars().active.set(false);
        }
    }
);

impl ActivatedPan {
    /// A pan sending `action` to `target`.
    pub(crate) fn new(
        mtm: MainThreadMarker,
        activation: PanActivation,
        target: &EventTarget,
        action: objc2::runtime::Sel,
    ) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(ActivatedPanIvars {
            activation: Cell::new(activation),
            finger: RefCell::new(None),
            judged: Cell::new(Point::default()),
            active: Cell::new(false),
        });
        // SAFETY: the designated initializer; `target` implements `action`
        // and outlives the recognizer (the mounter keeps both).
        unsafe { msg_send![super(this), initWithTarget: target, action: action] }
    }
}

/// Whether `scroll` scrolls, or bounces, horizontally (else vertically).
fn scrolls_along(scroll: &UIScrollView, horizontal: bool) -> bool {
    let (bounds, content, inset) = (
        scroll.bounds().size,
        scroll.contentSize(),
        scroll.adjustedContentInset(),
    );
    if horizontal {
        scroll.alwaysBounceHorizontal() || content.width + inset.left + inset.right > bounds.width
    } else {
        scroll.alwaysBounceVertical() || content.height + inset.top + inset.bottom > bounds.height
    }
}

/// A pen's `tiltX` / `tiltY` in degrees (the DOM's) from its altitude
/// (radians from the surface) and azimuth (radians, clockwise from the
/// right in a y-down view).
fn tilt(altitude: f64, azimuth: f64) -> (f32, f32) {
    let t = altitude.tan();
    if !t.is_finite() || t <= 0.0 {
        return (0.0, 0.0);
    }
    let x = (azimuth.cos() / t).atan().to_degrees();
    let y = (azimuth.sin() / t).atan().to_degrees();
    (x as f32, y as f32)
}
