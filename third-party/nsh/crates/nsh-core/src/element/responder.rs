//! The touch responder of Rust components: an element claims the touches
//! of a gesture ([`Interactive::claim_touches`]), on start or as the
//! fingers move, and then hears them alone ([`ResponderEvent`]s with the
//! gesture's [`PanGesture`]), while native scroll views around it stop
//! taking them over. The negotiation is React Native's (and the one `nsh-js`
//! runs for JS's handlers), run by the core on the engine thread
//! (`core/touch.rs`).
//!
//! [`Interactive::claim_touches`]: super::Interactive::claim_touches

use std::cell::Cell;

use super::{IntoListener, Listener};
use crate::{
    PanActivation, TouchEvent, TouchPhase, TouchPoint,
    geometry::{Point, Points, point, px},
};

/// A pan gesture followed through touch events (TS: `PanResponder`'s
/// `PanResponderGestureState`): the fingers' centroid, how far it moved
/// and how fast. A finger going down or up makes the centroid jump, which
/// is no movement. The responder's events carry one
/// ([`ResponderEvent::gesture`]); [`PanGesture::begin`] and
/// [`PanGesture::update`] follow one from raw touches
/// ([`super::Interactive::on_touch`]).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct PanGesture {
    /// The centroid's latest position in the surface (TS: `moveX`,
    /// `moveY`).
    pub position: Point<Points>,
    /// Where the centroid was when the gesture began, the grant (TS: `x0`,
    /// `y0`).
    pub origin: Point<Points>,
    /// How far the centroid moved since then (TS: `dx`, `dy`).
    pub delta: Point<Points>,
    /// Its velocity, points per millisecond (smoothed over a few
    /// samples).
    pub vx: f32,
    /// Its velocity, points per millisecond.
    pub vy: f32,
    /// The fingers down.
    pub active_touches: u32,
    /// The centroid, time and fingers of the last update.
    last: (f32, f32, f64, u32),
}

/// The centroid of the fingers down during `touch` (an end or a cancel
/// lists the lifted ones too) and their number.
fn centroid(touch: &TouchEvent) -> (f32, f32, u32) {
    let lifted = matches!(touch.phase, TouchPhase::End | TouchPhase::Cancel);
    let (mut x, mut y, mut n) = (0.0, 0.0, 0u32);
    for p in touch.points.iter().filter(|p| !lifted || !p.changed) {
        x += p.page.x.0;
        y += p.page.y.0;
        n += 1;
    }
    let d = n.max(1) as f32;
    (x / d, y / d, n)
}

impl PanGesture {
    /// A gesture beginning at the fingers of `touch`.
    pub fn begin(touch: &TouchEvent) -> Self {
        let (x, y, n) = centroid(touch);
        Self {
            position: point(px(x), px(y)),
            origin: point(px(x), px(y)),
            active_touches: n,
            last: (x, y, touch.timestamp, n),
            ..Self::default()
        }
    }

    /// Follows the fingers to `touch` (the same event twice changes
    /// nothing).
    pub fn update(&mut self, touch: &TouchEvent) {
        let (lx, ly, lt, ln) = self.last;
        let (x, y, n) = centroid(touch);
        if touch.timestamp == lt && n == ln {
            return;
        }
        self.active_touches = n;
        if n == ln {
            let dt = (touch.timestamp - lt).max(1.0) as f32;
            self.delta.x += px(x - lx);
            self.delta.y += px(y - ly);
            self.vx = self.vx * 0.3 + (x - lx) / dt * 0.7;
            self.vy = self.vy * 0.3 + (y - ly) / dt * 0.7;
        }
        self.position = point(px(x), px(y));
        self.last = (x, y, touch.timestamp, n);
    }
}

/// An event of the touch responder (`on_responder_grant`, `_move`, ...):
/// the finger it is about and the gesture so far.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ResponderEvent {
    /// Where the finger is in the view it went down on (TS: `locationX`,
    /// `locationY`).
    pub location: Point<Points>,
    /// Where it is in the surface (TS: `pageX`, `pageY`).
    pub page: Point<Points>,
    /// Milliseconds since an arbitrary origin.
    pub timestamp: f64,
    /// The gesture since it began: since the grant for the responder's
    /// events, since the first finger went down for a claim's question.
    pub gesture: PanGesture,
}

impl ResponderEvent {
    pub(crate) fn new(about: &TouchPoint, timestamp: f64, gesture: PanGesture) -> Self {
        Self {
            location: about.location,
            page: about.page,
            timestamp,
            gesture,
        }
    }
}

/// When a claim is asked ([`TouchClaim::ask`]): the listener claims the
/// touches with [`ClaimRequest::claim`] (TS: `on…ShouldSetResponder`
/// returning true).
#[derive(Debug)]
pub struct ClaimRequest {
    /// The touch the question is about.
    pub event: ResponderEvent,
    claimed: Cell<bool>,
}

impl ClaimRequest {
    pub(crate) fn new(event: ResponderEvent) -> Self {
        Self {
            event,
            claimed: Cell::new(false),
        }
    }

    /// The element takes the touches.
    pub fn claim(&self) {
        self.claimed.set(true);
    }

    pub(crate) fn claimed(&self) -> bool {
        self.claimed.get()
    }
}

/// When a [`TouchClaim`] asks for the touches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClaimPhase {
    Start,
    Move,
    /// When the platform activates the element's pan.
    Pan,
}

/// When an element claims the touches of a gesture (TS:
/// `onStartShouldSetResponder`, `onMoveShouldSetResponder` and their
/// `Capture` forms), for [`super::Interactive::claim_touches`].
///
/// Elements are asked from the outermost in for captures, then from the
/// finger's element outwards; the first that claims becomes the responder
/// (once one is, only the elements around it are asked, and it may keep
/// the touches: [`super::Interactive::keep_touches`]). Without
/// [`TouchClaim::ask`] the core decides from the element alone, running no
/// component code.
#[derive(Clone)]
pub struct TouchClaim {
    pub(crate) phase: ClaimPhase,
    pub(crate) capture: bool,
    pub(crate) block_native: bool,
    pub(crate) ask: Option<Listener<ClaimRequest>>,
    /// The pan the platform recognizes ([`TouchClaim::on_pan`]).
    pub(crate) pan: Option<PanActivation>,
}

impl TouchClaim {
    fn new(phase: ClaimPhase) -> Self {
        Self {
            phase,
            capture: false,
            block_native: true,
            ask: None,
            pan: None,
        }
    }

    /// When a finger goes down on the element or inside it (TS:
    /// `onStartShouldSetResponder`).
    pub fn on_start() -> Self {
        Self::new(ClaimPhase::Start)
    }

    /// When the fingers move on the element or inside it (TS:
    /// `onMoveShouldSetResponder`), also from a responder inside it that
    /// does not keep them.
    pub fn on_move() -> Self {
        Self::new(ClaimPhase::Move)
    }

    /// When the platform activates a pan on the element as `activation`
    /// says (TS: `panActivation`), deciding on the main thread as the
    /// fingers move: past an active offset the element claims the touches,
    /// and the scroll views around it can no longer take them; past a fail
    /// offset first it never does, and they keep them (a chart scrubbed
    /// horizontally in a vertical scroll view:
    /// `PanActivation::horizontal(10.0, 10.0)`). The element's other claims
    /// are not asked meanwhile; [`TouchClaim::ask`] still is, at the
    /// activation.
    pub fn on_pan(activation: PanActivation) -> Self {
        Self {
            pan: Some(activation),
            ..Self::new(ClaimPhase::Pan)
        }
    }

    /// Asked before the elements inside it (outermost first), so it takes
    /// the touches from them (TS: the `…Capture` handlers).
    pub fn capture(mut self) -> Self {
        self.capture = true;
        self
    }

    /// Claims only when `listener` does ([`ClaimRequest::claim`]), deciding
    /// with the component's state and the gesture so far (a horizontal
    /// swipe: `request.event.gesture.delta.x.abs() > px(10.0)`).
    pub fn ask<M>(mut self, listener: impl IntoListener<ClaimRequest, M>) -> Self {
        self.ask = Some(listener.into_listener());
        self
    }

    /// Whether native scroll views around the element stop taking the
    /// touches while it has them (default true; TS: `onResponderGrant`
    /// returning true, `PanResponder`'s `onShouldBlockNativeResponder`). A
    /// scroll view that started dragging first still takes them over.
    pub fn block_native(mut self, block: bool) -> Self {
        self.block_native = block;
        self
    }
}

/// An element's part in the negotiation and its responder events.
#[derive(Clone, Default)]
pub(crate) struct ResponderEl {
    pub(crate) claims: Vec<TouchClaim>,
    /// Refuses to hand the touches over.
    pub(crate) keep: bool,
    pub(crate) grant: Option<Listener<ResponderEvent>>,
    pub(crate) reject: Option<Listener<ResponderEvent>>,
    pub(crate) start: Option<Listener<ResponderEvent>>,
    pub(crate) moved: Option<Listener<ResponderEvent>>,
    pub(crate) end: Option<Listener<ResponderEvent>>,
    pub(crate) release: Option<Listener<ResponderEvent>>,
    pub(crate) terminate: Option<Listener<ResponderEvent>>,
}

/// `node`'s part in the negotiation, made on first use.
pub(crate) fn of(node: &mut super::ElNode) -> &mut ResponderEl {
    std::rc::Rc::make_mut(node.responder.get_or_insert_default())
}
