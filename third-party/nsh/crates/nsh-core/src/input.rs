//! The decisions of pointer input the desktop backends share, over plain
//! data: what a pointer going down may start along the views under it
//! ([`Grab`]: touch listeners, pans, scroll drags, a pinch, `PRESSED`
//! views, a `panActivation` [`Gate`]), when a drag starts and which
//! candidate takes it ([`Candidate`], [`startable`]), a press's events
//! ([`Press`]), hover changes, hit areas, two-finger pinch / rotation
//! ([`Pinch`]), wheel latching, Ctrl + wheel zoom steps and velocities.
//!
//! The backends keep the event flow over their own views and surfaces:
//! hit testing through their toolkit's geometry, reporting touches and
//! events, driving their scroll views and animations, timers. The
//! Windows, GPUI, Linux and macOS backends use it.

use crate::{
    Bounds, EdgeInsets, EventKind, EventMask, GestureValues, NodeId, PanActivation, Point, Points,
    ROOT_ID, Size, ViewKind,
    geometry::Radians,
    tailwind::state::{HOVERED, PRESSED},
};

/// Distance a pointer moves before a pan or scroll drag starts.
pub const PAN_SLOP: Points = Points(6.0);
/// Distance a pointer moves before its press is cancelled.
pub const PRESS_SLOP: Points = Points(10.0);
/// How far outside the pressed view (and its hit slop) a release still
/// counts as a press.
pub const PRESS_RETENTION: Points = Points(8.0);
/// Mouse wheel notches this close together (ms) are one scroll: they stay
/// on the scroll view the first one moved.
pub const WHEEL_LATCH: f64 = 200.0;
/// A precise (touchpad) scroll without phases ends once its deltas stop
/// for this long (ms).
pub const TOUCHPAD_IDLE: f64 = 150.0;
/// Scale one Ctrl + wheel notch pinches by.
pub const ZOOM_STEP: f32 = 1.1;
/// Points of one wheel notch at Windows' default (three lines of 16
/// points): Ctrl + wheel deltas in points are counted in these.
pub const ZOOM_NOTCH: Points = Points(48.0);
/// A Ctrl + wheel pinch ends once the notches stop for this long (ms).
pub const ZOOM_IDLE: u64 = 300;
/// Delay before `onPressDown` for touches inside scroll views (ms).
pub const SCROLL_PRESS_DELAY: u64 = 130;
/// Default `delayLongPress` (ms).
pub const LONG_PRESS: f32 = 500.0;
/// Velocities are measured over this many milliseconds.
pub const VELOCITY_WINDOW: f64 = 100.0;

/// Estimates a pointer's velocity from its recent positions (points).
#[derive(Debug, Clone, Copy, Default)]
pub struct VelocityTracker {
    samples: [(f64, f32, f32); VelocityTracker::LEN],
    count: usize,
    head: usize,
}

impl VelocityTracker {
    const LEN: usize = 16;

    /// The pointer is `at` a point at `time` (ms).
    pub fn add(&mut self, time: f64, at: Point<Points>) {
        self.samples[self.head] = (time, at.x.0, at.y.0);
        self.head = (self.head + 1) % Self::LEN;
        self.count = (self.count + 1).min(Self::LEN);
    }

    /// Points per second over the last [`VELOCITY_WINDOW`] ms (zero after
    /// a pause).
    pub fn velocity(&self) -> (f32, f32) {
        if self.count < 2 {
            return (0.0, 0.0);
        }
        let at = |i: usize| self.samples[(self.head + Self::LEN - 1 - i) % Self::LEN];
        let newest = at(0);
        let mut oldest = newest;
        for i in 1..self.count {
            let s = at(i);
            if newest.0 - s.0 > VELOCITY_WINDOW {
                break;
            }
            oldest = s;
        }
        let dt = newest.0 - oldest.0;
        if dt < 1.0 {
            return (0.0, 0.0);
        }
        let k = (1000.0 / dt) as f32;
        ((newest.1 - oldest.1) * k, (newest.2 - oldest.2) * k)
    }
}

// --- Drags --------------------------------------------------------------------------

/// What a drag on a view may start.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Candidate {
    /// A pan along these axes (both when it only has listeners).
    Pan {
        /// It pans horizontally.
        x: bool,
        /// It pans vertically.
        y: bool,
    },
    /// A scroll view.
    Scroll {
        /// It scrolls horizontally.
        horizontal: bool,
    },
}

impl Candidate {
    /// Whether a drag by `(dx, dy)` starts it: single-axis pans and scroll
    /// views take mostly-along-their-axis movements, so a horizontal pan
    /// coexists with a vertical scroll view around it.
    pub fn accepts(self, dx: Points, dy: Points) -> bool {
        let horizontal = dx.0.abs() > dy.0.abs();
        match self {
            Candidate::Pan { x, y } => (x && y) || (x && horizontal) || (y && !horizontal),
            Candidate::Scroll { horizontal: h } => h == horizontal,
        }
    }

    /// The pan a view with gesture `values` and `events` starts: along the
    /// axes it drives values of, or both when it only listens.
    pub fn pan(values: &GestureValues, events: EventMask) -> Option<Candidate> {
        let pans = values.pan_x.is_some()
            || values.pan_y.is_some()
            || events.contains(EventKind::PanStart)
            || events.contains(EventKind::PanEnd);
        pans.then(|| {
            let (x, y) = match (values.pan_x.is_some(), values.pan_y.is_some()) {
                (false, false) => (true, true),
                axes => axes,
            };
            Candidate::Pan { x, y }
        })
    }
}

/// A view's `panActivation` deciding on a pointer's drag.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Gate {
    id: NodeId,
    activation: PanActivation,
    outer: usize,
}

impl Gate {
    /// The gate of view `id`, whose candidates from index `outer` on are
    /// around it: they wait for its pan to fail.
    pub fn new(id: NodeId, activation: PanActivation, outer: usize) -> Gate {
        Gate {
            id,
            activation,
            outer,
        }
    }

    /// The index of the first candidate around the gated view.
    pub fn outer(&self) -> usize {
        self.outer
    }

    /// The view that owns this gate, even if the pointer target moved.
    pub fn id(&self) -> NodeId {
        self.id
    }

    /// Decides on a drag by `(dx, dy)` from where the pointer went down:
    /// the gated view when its pan activates (the candidates around it are
    /// dropped), and whether the gate is still undecided.
    pub fn decide<V, C>(
        &self,
        candidates: &mut Vec<(V, C)>,
        dx: Points,
        dy: Points,
    ) -> (Option<NodeId>, bool) {
        match self.activation.decide(dx, dy) {
            Some(true) => {
                candidates.truncate(self.outer);
                (Some(self.id), false)
            }
            Some(false) => (None, false),
            None => (None, true),
        }
    }

    /// [`Gate::decide`] on a pointer's gate, which stays only while
    /// undecided: the view whose pan activated.
    pub fn step<V, C>(
        gate: &mut Option<Gate>,
        candidates: &mut Vec<(V, C)>,
        dx: Points,
        dy: Points,
    ) -> Option<NodeId> {
        let g = gate.take()?;
        let (id, undecided) = g.decide(candidates, dx, dy);
        if let Some(id) = id {
            log::debug!(target: "nsh::input", "panActivation of {id} activated");
        }
        if undecided {
            *gate = Some(g);
        }
        id
    }
}

/// The candidate a drag by `(dx, dy)` past the pan slop starts, innermost
/// first: while `gate` decides, those around it wait.
pub fn startable<'a, V>(
    candidates: &'a [(V, Candidate)],
    gate: Option<&Gate>,
    dx: Points,
    dy: Points,
) -> Option<&'a (V, Candidate)> {
    let open = gate.map_or(candidates.len(), Gate::outer);
    candidates[..open].iter().find(|(_, c)| c.accepts(dx, dy))
}

/// One view around a pointer going down, as [`Grab::add`] reads it.
#[derive(Debug, Clone, Copy, Default)]
#[non_exhaustive]
pub struct Link {
    /// The view's node.
    pub id: NodeId,
    /// The events it listens to.
    pub events: EventMask,
    /// The interaction states it tracks.
    pub tracked: u16,
    /// Its native gesture values.
    pub values: GestureValues,
    /// It scrolls: horizontally or not.
    pub scroll: Option<bool>,
    /// Its `panActivation`.
    pub pan_activation: Option<PanActivation>,
}

impl Link {
    /// A view with these props.
    pub fn new(
        id: NodeId,
        events: EventMask,
        tracked: u16,
        values: GestureValues,
        scroll: Option<bool>,
        pan_activation: Option<PanActivation>,
    ) -> Link {
        Link {
            id,
            events,
            tracked,
            values,
            scroll,
            pan_activation,
        }
    }
}

/// How a pointer went down, for [`Grab::add`].
#[derive(Debug, Clone, Copy, Default)]
#[non_exhaustive]
pub struct GrabOptions {
    /// A finger or a pen: it drags scroll views.
    pub touch: bool,
    /// An item that handles its own pointer took it (a hosted widget, a
    /// text field): no pans, scroll drags or gates.
    pub native: bool,
    /// It selects text: no pans or scroll drags.
    pub selects: bool,
    /// No other pointer is down: the gate follows the first pointer only.
    pub first: bool,
}

impl GrabOptions {
    /// Options of a pointer.
    pub fn new(touch: bool, native: bool, selects: bool, first: bool) -> GrabOptions {
        GrabOptions {
            touch,
            native,
            selects,
            first,
        }
    }
}

/// What a pointer going down finds along the views under it, innermost
/// first.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct Grab<V> {
    /// The views that listen to touches.
    pub path: Vec<NodeId>,
    /// What a drag may start.
    pub candidates: Vec<(V, Candidate)>,
    /// The view a second finger would pinch / rotate.
    pub pinch: Option<V>,
    /// Views that track `PRESSED`.
    pub pressed: Vec<V>,
    /// A scroll view is around it.
    pub in_scroll: bool,
    /// The `panActivation` around it.
    pub gate: Option<Gate>,
}

impl<V> Default for Grab<V> {
    fn default() -> Self {
        Grab {
            path: Vec::new(),
            candidates: Vec::new(),
            pinch: None,
            pressed: Vec::new(),
            in_scroll: false,
            gate: None,
        }
    }
}

impl<V: Clone> Grab<V> {
    /// Takes in the next view outwards.
    pub fn add(&mut self, view: &V, link: &Link, options: GrabOptions) {
        if link.events.contains(EventKind::Touch) {
            self.path.push(link.id);
        }
        if link.tracked & PRESSED != 0 {
            self.pressed.push(view.clone());
        }
        if !options.native
            && !options.selects
            && let Some(pan) = Candidate::pan(&link.values, link.events)
        {
            self.candidates.push((view.clone(), pan));
        }
        if let Some(horizontal) = link.scroll {
            self.in_scroll = true;
            // Dragging the content is a touchscreen's way to scroll; on the
            // desktop the mouse's drags are the app's.
            if options.touch && !options.native && !options.selects {
                self.candidates
                    .push((view.clone(), Candidate::Scroll { horizontal }));
            }
        }
        if self.pinch.is_none() && transforms(&link.values, link.events) != (false, false) {
            self.pinch = Some(view.clone());
        }
        if self.gate.is_none()
            && options.first
            && !options.native
            && let Some(activation) = link.pan_activation
        {
            self.gate = Some(Gate::new(link.id, activation, self.candidates.len()));
        }
    }
}

// --- Presses ------------------------------------------------------------------------

/// Whether `events` hold a press listener.
pub fn has_press(events: EventMask) -> bool {
    [
        EventKind::Press,
        EventKind::LongPress,
        EventKind::PressDown,
        EventKind::PressUp,
    ]
    .into_iter()
    .any(|k| events.contains(k))
}

/// A press in progress on a view `V`.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct Press<V> {
    /// The view whose bounds the press must end in (the text view for a
    /// span).
    pub view: V,
    /// The node that gets the events.
    pub node: NodeId,
    /// The events it listens to.
    pub events: EventMask,
    /// Milliseconds before a long press.
    pub long_delay: f32,
    /// `onPressDown` was reported.
    pub pressed: bool,
    /// `onLongPress` was reported: the release is no press.
    pub long: bool,
    /// Tells the press's timers from those of earlier presses.
    pub generation: u64,
    /// The modifier keys held when it went down, sent with its events.
    pub modifiers: crate::keymap::Modifiers,
    /// Consecutive clicks it is (1 for a click, 2 for a double click).
    pub clicks: u32,
}

impl<V> Press<V> {
    /// A press of `node` listening to `events`, ended in `view`'s bounds,
    /// with the view's `delayLongPress`.
    pub fn new(
        view: V,
        node: NodeId,
        events: EventMask,
        long_delay: Option<f32>,
        generation: u64,
    ) -> Press<V> {
        Press {
            view,
            node,
            events,
            long_delay: long_delay.unwrap_or(LONG_PRESS),
            pressed: false,
            long: false,
            generation,
            modifiers: crate::keymap::Modifiers::default(),
            clicks: 1,
        }
    }

    /// The press with the modifier keys held and the consecutive clicks
    /// (at least 1) of the pointer that went down.
    pub fn clicked(mut self, modifiers: crate::keymap::Modifiers, clicks: u32) -> Press<V> {
        self.modifiers = modifiers;
        self.clicks = clicks.max(1);
        self
    }

    /// The press goes in: `onPressDown`, the first time, if it listens.
    pub fn press_in(&mut self) -> Option<EventKind> {
        if self.pressed {
            return None;
        }
        self.pressed = true;
        self.events
            .contains(EventKind::PressDown)
            .then_some(EventKind::PressDown)
    }

    /// The press ends: `onPressUp`, then `onPress` if `fire` (released
    /// inside) and it was no long press, those it listens to.
    pub fn press_out(&mut self, fire: bool) -> impl Iterator<Item = EventKind> + use<V> {
        let was = std::mem::replace(&mut self.pressed, false);
        let up = was && self.events.contains(EventKind::PressUp);
        let press = was && fire && !self.long && self.events.contains(EventKind::Press);
        [
            up.then_some(EventKind::PressUp),
            press.then_some(EventKind::Press),
        ]
        .into_iter()
        .flatten()
    }
}

/// Whether a release at `local` (the pressed view's coordinates) is on a
/// view of `size`, its hit `slop` and [`PRESS_RETENTION`] around them.
pub fn released_inside(local: Point<Points>, size: Size<Points>, slop: EdgeInsets) -> bool {
    let (lx, ly) = (local.x.0, local.y.0);
    let r = PRESS_RETENTION.0;
    lx >= -slop.left.0 - r
        && ly >= -slop.top.0 - r
        && lx <= size.width.0 + slop.right.0 + r
        && ly <= size.height.0 + slop.bottom.0 + r
}

// --- States and hover ---------------------------------------------------------------

/// Interaction states `states` with `bit` set (or cleared), when the view
/// tracks it and they change.
pub fn next_states(tracked: u16, states: u16, bit: u16, on: bool) -> Option<u16> {
    if tracked & bit == 0 {
        return None;
    }
    let next = if on { states | bit } else { states & !bit };
    (next != states).then_some(next)
}

/// Whether hovering a view that tracks `tracked` and listens to `events`
/// matters: for its `hover:` styles (the `HOVERED` state) or its
/// `onMouseEnter` / `onMouseLeave` / `onMouseMove`.
pub fn hoverable(tracked: u16, events: EventMask) -> bool {
    tracked & HOVERED != 0
        || events.contains(EventKind::MouseEnter)
        || events.contains(EventKind::MouseLeave)
        || events.contains(EventKind::MouseMove)
}

/// The views under the mouse went from `old` to `new` (innermost first):
/// those it left, from the inside out, and those it came over, from the
/// outside in, as with the DOM's `pointerleave` / `pointerenter`.
pub fn hover_changes<'a, V: PartialEq>(
    old: &'a [V],
    new: &'a [V],
) -> (
    impl Iterator<Item = &'a V> + 'a,
    impl Iterator<Item = &'a V> + 'a,
) {
    (
        old.iter().filter(move |v| !new.contains(v)),
        new.iter().rev().filter(move |v| !old.contains(v)),
    )
}

// --- Hit testing --------------------------------------------------------------------

/// Whether the core lays out the children of a view of `kind`, so that
/// they are outside its bounds only in its overflow area.
pub fn laid_out(kind: ViewKind, id: NodeId) -> bool {
    id != ROOT_ID && matches!(kind, ViewKind::View | ViewKind::Text)
}

/// Where a point is relative to a view, for hit testing.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct HitArea {
    /// Inside its bounds.
    pub inside: bool,
    /// Inside its bounds and hit slop: the view itself is hit.
    pub in_slop: bool,
    /// Its children are looked into.
    pub children: bool,
}

/// Where `p` (the view's coordinates) is on a view of `size` with hit
/// `slop`, whose descendants cover `overflow` outside it; `clip`: it clips
/// its children; `laid_out`: the core lays them out ([`laid_out`]), else
/// the platform places them (screens, header items) and the core knows no
/// area for them.
pub fn hit_area(
    p: Point<Points>,
    size: Size<Points>,
    slop: EdgeInsets,
    overflow: Option<Bounds<Points>>,
    clip: bool,
    laid_out: bool,
) -> HitArea {
    let (x, y) = (p.x.0, p.y.0);
    let (w, h) = (size.width.0, size.height.0);
    let inside = x >= 0.0 && y >= 0.0 && x < w && y < h;
    let in_slop =
        x >= -slop.left.0 && y >= -slop.top.0 && x < w + slop.right.0 && y < h + slop.bottom.0;
    let children = if clip {
        inside
    } else if laid_out {
        in_slop
            || overflow.is_some_and(|e| {
                x >= e.origin.x.0
                    && y >= e.origin.y.0
                    && x < e.origin.x.0 + e.size.width.0
                    && y < e.origin.y.0 + e.size.height.0
            })
    } else {
        true
    };
    HitArea {
        inside,
        in_slop,
        children,
    }
}

// --- Pans, pinches and rotations ----------------------------------------------------

/// Whether a view pinches / rotates natively or listens to it.
pub fn transforms(values: &GestureValues, events: EventMask) -> (bool, bool) {
    (
        values.pinch.is_some()
            || events.contains(EventKind::PinchStart)
            || events.contains(EventKind::PinchEnd),
        values.rotation.is_some()
            || events.contains(EventKind::RotationStart)
            || events.contains(EventKind::RotationEnd),
    )
}

/// Two fingers pinching / rotating, from where they began.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Pinch {
    distance: f32,
    angle: f32,
}

impl Pinch {
    /// Fingers at `a` and `b` begin.
    pub fn new(a: Point<Points>, b: Point<Points>) -> Pinch {
        let (dx, dy) = (b.x.0 - a.x.0, b.y.0 - a.y.0);
        Pinch {
            distance: dx.hypot(dy).max(1.0),
            angle: dy.atan2(dx),
        }
    }

    /// The fingers are at `a` and `b`: the scale and the rotation from
    /// where they began.
    pub fn at(&self, a: Point<Points>, b: Point<Points>) -> (f32, Radians) {
        let (dx, dy) = (b.x.0 - a.x.0, b.y.0 - a.y.0);
        (
            dx.hypot(dy) / self.distance,
            Radians(dy.atan2(dx) - self.angle),
        )
    }
}

/// The scale `notches` Ctrl + wheel notches pinch by: one notch is one
/// [`ZOOM_STEP`], scrolling up (negative) zooms in.
pub fn zoom_factor(notches: f32) -> f32 {
    ZOOM_STEP.powf(-notches)
}

// --- Wheels -------------------------------------------------------------------------

/// Whether wheel notches latched to a view at `last` (ms) along
/// `latched_horizontal` still go there at `time`.
pub fn latch_holds(latched_horizontal: bool, last: f64, horizontal: bool, time: f64) -> bool {
    latched_horizontal == horizontal && time - last < WHEEL_LATCH
}

/// How much longer (ms) to wait for the precise scroll whose last delta
/// came at `last` before it ends, or `None` when it ended (or there is
/// none).
pub fn touchpad_wait(last: Option<f64>, now: f64) -> Option<f64> {
    let idle = now - last?;
    (idle < TOUCHPAD_IDLE).then(|| (TOUCHPAD_IDLE - idle).max(1.0))
}

/// The innermost of `views` (innermost first) a wheel by `(dx, dy)`
/// scrolls: `axis` is a view's scroll axis (horizontal or not; `None` for
/// views that do not scroll), `takes` whether a scroll view can move by it
/// (nested views fall through to outer ones at their edges). Scroll views
/// along the wheel's axis take it: a vertical wheel over a carousel
/// scrolls the page around it, as in browsers; horizontal views take
/// vertical wheels only where nothing around scrolls vertically.
pub fn scroll_target<V>(
    views: Vec<V>,
    dx: Points,
    dy: Points,
    axis: impl Fn(&V) -> Option<bool>,
    takes: impl Fn(&V) -> bool,
) -> Option<V> {
    let horizontal = dx.0.abs() > dy.0.abs();
    let along = |v: &V| axis(v) == Some(horizontal);
    let any_along = views.iter().any(along);
    views
        .into_iter()
        .find(|v| (!any_along || along(v)) && takes(v))
}

// --- The keyboard -------------------------------------------------------------------

/// The Tab stop Tab (Shift + Tab with `back`) moves to among `n` from
/// `current`: past the ends it wraps around with `wrap`, else leaves them
/// (`None`).
pub fn tab_stop(current: Option<usize>, n: usize, back: bool, wrap: bool) -> Option<usize> {
    if n == 0 {
        return None;
    }
    Some(match (current, back) {
        (Some(i), false) if i + 1 == n => {
            if !wrap {
                return None;
            }
            0
        }
        (Some(0), true) => {
            if !wrap {
                return None;
            }
            n - 1
        }
        (Some(i), false) => i + 1,
        (Some(i), true) => i - 1,
        (None, false) => 0,
        (None, true) => n - 1,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{point, size};

    fn p(x: f32, y: f32) -> Point<Points> {
        point(Points(x), Points(y))
    }

    #[test]
    fn velocity_over_recent_samples() {
        let mut v = VelocityTracker::default();
        for i in 0..10 {
            v.add(i as f64 * 10.0, p(i as f32 * 5.0, 0.0));
        }
        let (vx, vy) = v.velocity();
        assert!((vx - 500.0).abs() < 1.0, "{vx}");
        assert_eq!(vy, 0.0);
    }

    #[test]
    fn velocity_is_zero_after_a_pause() {
        let mut v = VelocityTracker::default();
        v.add(0.0, p(0.0, 0.0));
        v.add(10.0, p(10.0, 10.0));
        v.add(300.0, p(10.0, 10.0));
        assert_eq!(v.velocity(), (0.0, 0.0));
    }

    #[test]
    fn velocity_needs_two_samples() {
        let mut v = VelocityTracker::default();
        assert_eq!(v.velocity(), (0.0, 0.0));
        v.add(5.0, p(3.0, 3.0));
        assert_eq!(v.velocity(), (0.0, 0.0));
    }

    #[test]
    fn velocity_wraps_around() {
        let mut v = VelocityTracker::default();
        for i in 0..100 {
            v.add(i as f64 * 8.0, p(0.0, -(i as f32) * 4.0));
        }
        let (_, vy) = v.velocity();
        assert!((vy + 500.0).abs() < 1.0, "{vy}");
    }

    #[test]
    fn candidates_take_their_axis() {
        let accepts = |c: Candidate, dx: f32, dy: f32| c.accepts(Points(dx), Points(dy));
        let horizontal = Candidate::Pan { x: true, y: false };
        assert!(accepts(horizontal, 8.0, 2.0));
        assert!(!accepts(horizontal, 2.0, 8.0));
        let both = Candidate::Pan { x: true, y: true };
        assert!(accepts(both, 2.0, 8.0) && accepts(both, 8.0, 2.0));
        let vertical = Candidate::Scroll { horizontal: false };
        assert!(accepts(vertical, 1.0, -7.0));
        assert!(!accepts(vertical, -7.0, 1.0));
    }

    #[test]
    fn gates_decide_on_their_offsets() {
        let gate = Gate::new(7, PanActivation::horizontal(Points(6.0), Points(8.0)), 0);
        let mut candidates: Vec<((), Candidate)> = Vec::new();
        let mut decide = |dx: f32, dy: f32| gate.decide(&mut candidates, Points(dx), Points(dy));
        assert_eq!(decide(3.0, 3.0), (None, true));
        assert_eq!(decide(7.0, 1.0), (Some(7), false));
        assert_eq!(decide(2.0, -9.0), (None, false));
        // A fail offset passed by the same move wins.
        assert_eq!(decide(9.0, 9.0), (None, false));
    }

    #[test]
    fn an_activated_gate_drops_the_candidates_around_it() {
        let pan = Candidate::Pan { x: true, y: true };
        let mut candidates = vec![(1, pan), (2, pan)];
        let mut gate = Some(Gate::new(
            1,
            PanActivation::horizontal(Points(6.0), Points(8.0)),
            1,
        ));
        // Undecided: the outer candidate waits.
        let (dx, dy) = (Points(3.0), Points(0.0));
        assert_eq!(Gate::step(&mut gate, &mut candidates, dx, dy), None);
        assert!(gate.is_some());
        assert_eq!(
            startable(&candidates, gate.as_ref(), dx, dy),
            Some(&(1, pan))
        );
        let (dx, dy) = (Points(7.0), Points(0.0));
        assert_eq!(Gate::step(&mut gate, &mut candidates, dx, dy), Some(1));
        assert!(gate.is_none());
        assert_eq!(candidates, vec![(1, pan)]);
    }

    #[test]
    fn grabs_collect_along_the_chain() {
        let mut grab = Grab::default();
        let mut values = GestureValues::default();
        let mut events = EventMask::default();
        events.set(EventKind::Touch, true);
        let options = GrabOptions::new(true, false, false, true);
        grab.add(
            &"inner",
            &Link::new(4, events, PRESSED, values, None, None),
            options,
        );
        values.pinch = Some(1);
        let activation = PanActivation::horizontal(Points(6.0), Points(8.0));
        let link = Link::new(
            6,
            EventMask::default(),
            0,
            values,
            Some(false),
            Some(activation),
        );
        grab.add(&"scroll", &link, options);
        assert_eq!(grab.path, vec![4]);
        assert_eq!(grab.pressed, vec!["inner"]);
        assert_eq!(
            grab.candidates,
            vec![("scroll", Candidate::Scroll { horizontal: false })]
        );
        assert_eq!(grab.pinch, Some("scroll"));
        assert!(grab.in_scroll);
        assert_eq!(grab.gate.map(|g| g.outer()), Some(1));
        // The mouse drags no scroll view.
        let mut mouse = Grab::default();
        mouse.add(
            &"scroll",
            &link,
            GrabOptions::new(false, false, false, true),
        );
        assert!(mouse.candidates.is_empty() && mouse.in_scroll);
    }

    #[test]
    fn presses_report_down_up_and_press() {
        let mut events = EventMask::default();
        assert!(!has_press(events));
        events.set(EventKind::LongPress, true);
        assert!(has_press(events));
        events.set(EventKind::PressDown, true);
        events.set(EventKind::PressUp, true);
        events.set(EventKind::Press, true);
        let mut press = Press::new((), 3, events, None, 0);
        assert_eq!(press.long_delay, LONG_PRESS);
        assert!(press.press_out(true).next().is_none());
        assert_eq!(press.press_in(), Some(EventKind::PressDown));
        assert_eq!(press.press_in(), None);
        let out: Vec<_> = press.press_out(true).collect();
        assert_eq!(out, vec![EventKind::PressUp, EventKind::Press]);
        press.press_in();
        press.long = true;
        let out: Vec<_> = press.press_out(true).collect();
        assert_eq!(out, vec![EventKind::PressUp]);
    }

    #[test]
    fn releases_count_near_the_view() {
        let slop = EdgeInsets::all(Points(2.0));
        let s = size(Points(10.0), Points(10.0));
        assert!(released_inside(p(19.0, 0.0), s, slop));
        assert!(!released_inside(p(21.0, 0.0), s, slop));
        assert!(released_inside(p(-9.0, -9.0), s, slop));
    }

    #[test]
    fn states_change_only_when_tracked() {
        let hovered = HOVERED;
        assert_eq!(next_states(0, 0, hovered, true), None);
        assert_eq!(next_states(hovered, 0, hovered, true), Some(hovered));
        assert_eq!(next_states(hovered, hovered, hovered, true), None);
        assert_eq!(next_states(hovered, hovered, hovered, false), Some(0));
    }

    #[test]
    fn hovers_leave_inside_out_and_enter_outside_in() {
        let (left, entered) = hover_changes(&[3, 2, 1], &[5, 4, 1]);
        assert_eq!(left.collect::<Vec<_>>(), vec![&3, &2]);
        assert_eq!(entered.collect::<Vec<_>>(), vec![&4, &5]);
    }

    #[test]
    fn hit_areas() {
        let s = size(Points(10.0), Points(10.0));
        let slop = EdgeInsets::all(Points(5.0));
        let a = hit_area(p(12.0, 5.0), s, slop, None, false, true);
        assert!(!a.inside && a.in_slop && a.children);
        assert!(!hit_area(p(12.0, 5.0), s, slop, None, true, true).children);
        let overflow = Bounds::new(p(0.0, 10.0), size(Points(10.0), Points(50.0)));
        let a = hit_area(p(5.0, 40.0), s, slop, Some(overflow), false, true);
        assert!(!a.in_slop && a.children);
        assert!(hit_area(p(500.0, 500.0), s, slop, None, false, false).children);
    }

    #[test]
    fn only_laid_out_views_bound_their_children() {
        assert!(laid_out(ViewKind::View, 8));
        assert!(laid_out(ViewKind::Text, 8));
        assert!(!laid_out(ViewKind::View, ROOT_ID));
        assert!(!laid_out(ViewKind::Screen, 8));
        assert!(!laid_out(ViewKind::Modal, 8));
    }

    #[test]
    fn two_fingers_scale_and_rotate() {
        let pinch = Pinch::new(p(0.0, 0.0), p(10.0, 0.0));
        let (scale, rotation) = pinch.at(p(0.0, 0.0), p(0.0, 20.0));
        assert!((scale - 2.0).abs() < 1e-5);
        assert!((rotation.0.to_degrees() - 90.0).abs() < 1e-3);
    }

    #[test]
    fn wheel_notches_latch_along_their_axis() {
        assert!(latch_holds(false, 1000.0, false, 1150.0));
        assert!(!latch_holds(false, 1000.0, false, 1250.0));
        assert!(!latch_holds(false, 1000.0, true, 1050.0));
    }

    #[test]
    fn touchpad_scrolls_end_after_a_pause() {
        assert_eq!(touchpad_wait(None, 500.0), None);
        assert_eq!(touchpad_wait(Some(400.0), 500.0), Some(50.0));
        assert_eq!(touchpad_wait(Some(300.0), 500.0), None);
    }

    #[test]
    fn ctrl_wheel_zooms_by_notches() {
        assert!((zoom_factor(-1.0) - 1.1).abs() < 1e-5);
        assert!((zoom_factor(2.0) - 1.0 / 1.21).abs() < 1e-5);
    }

    #[test]
    fn wheels_take_scroll_views_along_their_axis() {
        // (id, axis, can scroll)
        let views = vec![
            (1, Some(true), true),
            (2, None, false),
            (3, Some(false), true),
        ];
        let target = |dx, dy, views: &Vec<(i32, Option<bool>, bool)>| {
            scroll_target(
                views.clone(),
                Points(dx),
                Points(dy),
                |v| v.1,
                |v| v.1.is_some() && v.2,
            )
            .map(|v| v.0)
        };
        assert_eq!(target(0.0, 5.0, &views), Some(3));
        assert_eq!(target(5.0, 0.0, &views), Some(1));
        // Only a horizontal view: it takes vertical wheels too.
        assert_eq!(target(0.0, 5.0, &views[..2].to_vec()), Some(1));
    }

    #[test]
    fn tab_stops_wrap_or_leave() {
        assert_eq!(tab_stop(None, 0, false, true), None);
        assert_eq!(tab_stop(None, 3, false, true), Some(0));
        assert_eq!(tab_stop(None, 3, true, true), Some(2));
        assert_eq!(tab_stop(Some(2), 3, false, true), Some(0));
        assert_eq!(tab_stop(Some(0), 3, true, true), Some(2));
        assert_eq!(tab_stop(Some(2), 3, false, false), None);
        assert_eq!(tab_stop(Some(0), 3, true, false), None);
        assert_eq!(tab_stop(Some(1), 3, true, false), Some(0));
    }
}
