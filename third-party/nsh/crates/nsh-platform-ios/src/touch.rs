//! `TouchTracker`: reports touches to the JS responder system (`onTouch`);
//! `PanGate`: a view's `panActivation`.
//!
//! One tracker sits on the surface root and on each modal's root. It only
//! observes: it never recognizes in a way that blocks other gestures, and
//! views still get their touches. Touches start being tracked when the view
//! under them, or one around it, listens to `onTouch`.
//!
//! A gate sits on each view with a `panActivation` and decides, as the
//! fingers move, whether its pan activates ([`PanActivation::decide`]): the
//! pans of the scroll views around it must wait for it to fail
//! (`shouldBeRequiredToFailByGestureRecognizer:`), so they keep the touches
//! when it fails and never get them when it activates; the activation goes
//! to the engine with the tracker's touches (`TouchEvent::activated`), and
//! the view becomes the responder there.

use std::cell::{Cell, RefCell};

use nsh_core::{
    NodeId, PanActivation, Points, TouchEvent, TouchPhase, TouchPoint, geometry::point,
};
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send, rc::Retained,
};
use objc2_core_foundation::CGPoint;
use objc2_foundation::{NSObject, NSObjectProtocol, NSSet};
use objc2_ui_kit::{
    UIEvent, UIGestureRecognizer, UIGestureRecognizerState, UIScrollView, UITouch, UIView,
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
            self.lift(touches, TouchPhase::End);
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
                }
            })
            .collect();
        drop(tracked);
        self.ivars().reported.set(timestamp);
        self.ivars().target.touches(Box::new(TouchEvent {
            phase,
            timestamp,
            points,
            activated: self.ivars().activated.take(),
        }));
    }
}

pub(crate) struct GateIvars {
    activation: Cell<PanActivation>,
    /// The finger the gate follows and where it went down (window points).
    finger: RefCell<Option<(Retained<UITouch>, CGPoint)>>,
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
            let mut finger = self.ivars().finger.borrow_mut();
            if finger.is_none()
                && let Some(touch) = touches.iter().next()
            {
                let at = touch.locationInView(None);
                *finger = Some((touch.retain(), at));
            }
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
            let (dx, dy) = ((at.x - start.x) as f32, (at.y - start.y) as f32);
            match self.ivars().activation.get().decide(Points(dx), Points(dy)) {
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

        /// The pans of the scroll views around the view wait for the gate.
        #[unsafe(method(shouldBeRequiredToFailByGestureRecognizer:))]
        fn should_be_required_to_fail_by(&self, other: &UIGestureRecognizer) -> bool {
            self.holds_back(other)
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

    /// Whether `other` is the pan of a scroll view around the view.
    fn holds_back(&self, other: &UIGestureRecognizer) -> bool {
        let (Some(view), Some(other_view)) = (self.view(), other.view()) else {
            return false;
        };
        let Some(scroll) = other_view.downcast_ref::<UIScrollView>() else {
            return false;
        };
        let pan = scroll.panGestureRecognizer();
        let pan: &UIGestureRecognizer = &pan;
        std::ptr::eq(pan, other) && view.isDescendantOfView(scroll)
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
