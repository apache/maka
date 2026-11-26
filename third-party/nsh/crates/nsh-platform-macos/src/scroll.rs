//! Scroll views: offsets, wheel / trackpad / keyboard scrolling,
//! snapping, sticky cells, zooming, the core's scroll requests, scroll
//! events.
//!
//! A scroll view moves along its main axis; a zoomable one
//! (`maximumZoomScale` above `minimumZoomScale`) along both, zoomed by
//! trackpad pinches and Control + wheel around the pointer and by
//! `zoomTo` ([`pinch`], [`command`]). Its offset lives in [`ScrollState`]
//! (`x` / `y`, 0 showing the start of the content inset; UIKit's zoomed
//! `contentOffset`) and is shown by its container's layer's
//! `sublayerTransform` while it moves; the container's bounds origin (as
//! `NSClipView` scrolls) takes it once the view and the display link rest
//! ([`commit_due`]), as `setBoundsOrigin:` walks the whole subtree. Scroll
//! views containing inputs, and zoomable ones, instead update the bounds
//! each frame: AppKit draws newly visible fields at the live offset, and a
//! zoom is the bounds' size (the frame's over the zoom scale, which AppKit
//! shows as the container layer's scale), so AppKit draws, hit tests and
//! converts the zoomed children as they show. AppKit's geometry (hit
//! tests, conversions, `visibleRect`) follows the bounds, so what asks it
//! commits first ([`commit_pending`], [`commit_ancestors`]); NSH's own
//! (picking, [`bounds_origin`] and [`zoom`]) follows the live offset.
//! Every change goes through [`moved_to`], which moves the container,
//! pins the sticky cells, feeds the native scroll value in the same frame
//! and queues a report to the engine. Reports are coalesced to one per
//! frame by the view's frame callback, which also runs animated
//! scrolls, the indicator's fade and the refresh spinner, and stops when
//! none of them is left.
//!
//! Offsets are reported as UIKit's `contentOffset` (minus the leading
//! content inset, clamped to the content), so lists see the same numbers
//! as on iOS. Snapping and paging use [`ScrollBehavior::snap_target`].
//!
//! Trackpads follow the system: a gesture (`phase`) rubber-bands past the
//! edges when `bounces`, as AppKit's `.automatic` elasticity does (a
//! horizontal view only while its content overflows, a vertical one whose
//! content fits only when no outer vertical view takes the stretch; see
//! [`bounce_target`]), and springs back when the fingers lift, and the
//! momentum after it is the system's (`momentumPhase` events), not a glide
//! of ours; snapping views snap from the release instead. Mouse wheels (no
//! phases) stop at the edges and settle when the notches stop. Mouse drags
//! never scroll (dragging the content is a touchscreen's way to scroll);
//! the mouse drags the indicator as a scroll bar.
//!
//! Mirrored (right to left) horizontal lists keep their offsets left to
//! right: [`NshView::place`] puts each child at the mirror image of its
//! frame, so the shown origin is the offset negated, and wheels and the
//! indicator are mirrored here.

use std::{f32::consts::PI, rc::Rc};

use nsh_core::{
    Command, EventKind, EventPayload, PayloadValue, Points, ScrollBehavior, Size, StickyCell,
    ViewKind,
    geometry::point,
    scroll::{
        dragged, ease_out, indicator_alpha, indicator_hold_left, indicator_span_within, projected,
        rate, reveal_focus_delta, snap_duration, sticky_shift, thumb_scroll, wheel_glide::Glide,
    },
};
use objc2::{MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained};
use objc2_app_kit::{NSResponder, NSView};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_core_graphics::CGColor;
use objc2_foundation::{NSObject, NSObjectProtocol, NSPoint, NSUserDefaults, ns_string};
use objc2_quartz_core::CALayer;

use crate::{
    input::later,
    surface::{Next, Surface},
    view::{NshView, ScrollState, ViewState},
};

/// A wheel without a gesture (a mouse) has settled after this many ms.
const WHEEL_IDLE: f64 = 150.0;
/// After a trackpad gesture ends, the system's momentum begins within this
/// long (ms), or there is none.
const MOMENTUM_WAIT: f64 = 100.0;
/// Duration of animated scrolls and bounces back (ms).
const ANIMATION: f64 = 300.0;
/// The release speed (points per ms) a settled mouse wheel snaps with:
/// fast enough to move on to the next snap point.
const WHEEL_SNAP: f32 = 0.6;
/// Space between the indicator and the ends of the viewport.
const INDICATOR_MARGIN: f32 = 2.0;
/// The indicator's thickness.
const INDICATOR_THICK: f32 = 6.0;
/// How close to its edge (points) a mouse press grabs the indicator,
/// which is thinner than a pointer is precise...
const THUMB_GRAB: f32 = 12.0;
/// ...and how far past its ends.
const THUMB_SLOP: f32 = 4.0;

/// A scroll offset, a change of one or a point in a viewport (points).
/// Scroll views move along their main axis, zoomable ones along both.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub(crate) struct Offset {
    pub(crate) x: f32,
    pub(crate) y: f32,
}

impl Offset {
    pub(crate) const fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }

    fn along(self, horizontal: bool) -> f32 {
        if horizontal { self.x } else { self.y }
    }

    /// This offset with `v` along one axis.
    fn with(self, horizontal: bool, v: f32) -> Self {
        if horizontal {
            Self::new(v, self.y)
        } else {
            Self::new(self.x, v)
        }
    }

    pub(crate) fn lerp(self, to: Self, k: f32) -> Self {
        Self::new(self.x + (to.x - self.x) * k, self.y + (to.y - self.y) * k)
    }

    /// The larger distance along an axis to `to`.
    fn distance(self, to: Self) -> f32 {
        (to.x - self.x).abs().max((to.y - self.y).abs())
    }
}

impl From<Offset> for nsh_core::Point<Points> {
    fn from(o: Offset) -> Self {
        point(Points(o.x), Points(o.y))
    }
}

impl From<nsh_core::Point<Points>> for Offset {
    fn from(p: nsh_core::Point<Points>) -> Self {
        Self::new(p.x.0, p.y.0)
    }
}

impl std::ops::Sub for Offset {
    type Output = Self;

    fn sub(self, o: Self) -> Self {
        Self::new(self.x - o.x, self.y - o.y)
    }
}

impl std::ops::Add for Offset {
    type Output = Self;

    fn add(self, o: Self) -> Self {
        Self::new(self.x + o.x, self.y + o.y)
    }
}

/// What a scroll view is doing.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
enum Phase {
    /// At rest.
    #[default]
    Idle,
    /// The mouse drags the indicator as a scroll bar's thumb, from offset
    /// `start`.
    Thumb { start: f32 },
    /// Wheel or trackpad input: the last at `last` (ms), `total` points
    /// so far; `gesture` for trackpads (began / ended), not mouse wheels;
    /// `raw` is where the gesture's deltas put the offset before the
    /// rubber band, or a mouse wheel's target, which it glides to
    /// (`glide`, [`nsh_core::scroll::wheel_glide`]).
    Wheel {
        last: f64,
        total: f32,
        gesture: bool,
        raw: Offset,
        glide: Glide,
    },
    /// A trackpad gesture ended at `since` (ms); the system's momentum may
    /// follow.
    AwaitMomentum { since: f64 },
    /// The system's momentum scrolls.
    Momentum,
    /// An eased move from `from` to `to`, started at `start` (ms):
    /// `momentum` for snapping after a fling (momentum events), `end` to
    /// send `onScrollEnd` when it arrives.
    Animate {
        from: Offset,
        to: Offset,
        start: f64,
        duration: f64,
        momentum: bool,
        end: bool,
    },
    /// An eased zoom from `from` to `to`, started at `start` (ms), the
    /// content point (unzoomed) at viewport point `at` moving from `from_c`
    /// to `to_c` meanwhile: `zoomTo`, or a pinch springing back within the
    /// limits.
    Zoom {
        from: f32,
        to: f32,
        from_c: Offset,
        to_c: Offset,
        at: Offset,
        start: f64,
        duration: f64,
    },
}

/// The running state of a scroll view: input phase, the indicator and
/// the refresh spinner ([`ScrollState::live`]).
#[derive(Debug, Default, Clone)]
pub(crate) struct Live {
    phase: Phase,
    /// The view's frame callback runs.
    ticking: bool,
    /// The offset changed since it was last reported.
    report: bool,
    /// When the indicator was last shown (ms).
    shown: f64,
    /// A wake-up for the end of the indicator's hold is on its way
    /// ([`wake_after_hold`]).
    hold_timer: bool,
    /// The indicator's opacity.
    alpha: f32,
    /// The surface is dark (the indicator's color).
    dark: bool,
    /// The refresh spinner shows.
    refreshing: bool,
    /// The spinner's angle (radians).
    spin: f32,
    /// The view above the container that holds the indicator and the
    /// spinner.
    overlay: Option<Retained<NSView>>,
    /// The indicator's layer.
    indicator: Option<Retained<CALayer>>,
    /// The refresh spinner's layer, with a sublayer per spoke.
    spinner: Option<Retained<CALayer>>,
    /// Trackpad offsets waiting to be shown ([`Resampled`]).
    resampled: Option<Resampled>,
    /// When the moving offset should be committed to the container's
    /// bounds (ms; [`COMMIT_MS`] after the last move).
    commit_at: f64,
    /// A bounds-commit task is scheduled.
    commit_armed: bool,
    /// Since when the armed commit found the view at rest (ms): it waits
    /// for the display link to rest at most [`REST_WAIT`] from then.
    rested_at: Option<f64>,
    /// The zoom a pinch began at (a Control + wheel one's moves on at the
    /// limits, [`pinch`]).
    pinch_from: f32,
    /// The zoom last reported to the engine.
    reported_zoom: f32,
    /// The core deleted the view ([`deleted`]): its refresh spinner no
    /// longer turns.
    deleted: bool,
}

/// Where trackpad events (gestures and their momentum) put the offset, by
/// the events' time (ms), shown at display frames ([`tick`]) rather than
/// as they come. Events come at about the display's rate but not in step
/// with it: shown as they come, some frames get two and some none, and a
/// steady scroll judders (measured on a 120 Hz screen: up to a quarter of
/// the frames of a fling moved twice or not at all, depending on how the
/// events fell between the frames). Each frame shows the offset the
/// events give for a moment one event interval before it, interpolated,
/// so every frame moves by what that interval did.
#[derive(Debug, Default, Clone)]
struct Resampled {
    /// `(time, offset)`, oldest first; the first is the offset shown
    /// when the events began.
    points: std::collections::VecDeque<(f64, Offset)>,
    /// The time between events (ms), smoothed.
    interval: f64,
}

impl Resampled {
    /// The newest offset (where the events have put the view).
    fn goal(&self) -> Option<Offset> {
        self.points.back().map(|p| p.1)
    }

    /// Adds where an event at `time` put the offset.
    fn push(&mut self, time: f64, pos: Offset) {
        match self.points.back() {
            Some(&(last, _)) if time <= last => {
                // The same instant (or out of order): the newest wins.
                self.points.pop_back();
                self.points.push_back((last, pos));
            }
            Some(&(last, _)) => {
                // Gaps beyond a frame at 60 Hz are pauses, not the rate.
                let gap = (time - last).clamp(4.0, 17.0);
                self.interval += (gap - self.interval) * 0.25;
                self.points.push_back((time, pos));
            }
            None => self.points.push_back((time, pos)),
        }
    }

    /// The offset at `t` (ms), dropping points before it, and whether
    /// `t` is past the newest (which it then is).
    fn sample(&mut self, t: f64) -> (Offset, bool) {
        while self.points.len() > 2 && self.points[1].0 <= t {
            self.points.pop_front();
        }
        let Some(&(t0, p0)) = self.points.front() else {
            return (Offset::default(), true);
        };
        let Some(&(t1, p1)) = self.points.get(1) else {
            return (p0, true);
        };
        if t >= t1 {
            return (p1, true);
        }
        let k = if t1 > t0 {
            ((t - t0) / (t1 - t0)).clamp(0.0, 1.0)
        } else {
            1.0
        };
        (p0.lerp(p1, k as f32), false)
    }
}

// Accessors.

fn viewport(state: &ViewState, horizontal: bool) -> f32 {
    if horizontal {
        state.frame.size.width.0
    } else {
        state.frame.size.height.0
    }
}

fn main(s: &ScrollState) -> f32 {
    if s.horizontal { s.x } else { s.y }
}

fn pos(s: &ScrollState) -> Offset {
    Offset::new(s.x, s.y)
}

/// The offset of `view` (0, 0 for a view that does not scroll).
fn current(view: &NshView) -> Offset {
    view.state()
        .scroll
        .as_deref()
        .map_or(Offset::default(), pos)
}

/// The rest limits, `(min, max)`: along the main axis (the top is lower
/// while the refresh spinner shows), along both for a zoomable view; the
/// other axis stays at 0.
fn limits(state: &ViewState) -> (Offset, Offset) {
    let Some(s) = &state.scroll else {
        return Default::default();
    };
    range(s, (state.frame.size.width.0, state.frame.size.height.0))
}

/// [`limits`] of scroll state `s` in a viewport of `viewport` points.
fn range(s: &ScrollState, viewport: (f32, f32)) -> (Offset, Offset) {
    let (mx, my) = s.max(viewport);
    let top = if !s.horizontal && s.live.refreshing {
        -s.behavior.refresh_inset().0
    } else {
        0.0
    };
    if s.behavior.zooms() {
        (Offset::new(0.0, top), Offset::new(mx, my))
    } else if s.horizontal {
        (Offset::default(), Offset::new(mx, 0.0))
    } else {
        (Offset::new(0.0, top), Offset::new(0.0, my))
    }
}

/// `p` within `limits`.
fn clamp(p: Offset, (min, max): (Offset, Offset)) -> Offset {
    Offset::new(
        p.x.clamp(min.x, max.x.max(min.x)),
        p.y.clamp(min.y, max.y.max(min.y)),
    )
}

/// `p` moved by `d`, stopping at the limits; past them (the refresh space)
/// it only moves back.
fn stop_at_edges(p: Offset, d: Offset, (min, max): (Offset, Offset)) -> Offset {
    let one = |p: f32, d: f32, min: f32, max: f32| (p + d).clamp(min.min(p), max.max(min).max(p));
    Offset::new(one(p.x, d.x, min.x, max.x), one(p.y, d.y, min.y, max.y))
}

/// How far a zoomable view is zoomed (1 for any other view): the
/// container's bounds are its size over it.
pub(crate) fn zoom(view: &NshView) -> f32 {
    view.state().scroll.as_ref().map_or(1.0, |s| s.zoom)
}

/// The room before zoomed content smaller than the viewport, which a
/// zoomable view with `centerContent` centers (viewport points).
fn centered(state: &ViewState) -> Offset {
    let Some(s) = &state.scroll else {
        return Offset::default();
    };
    if !s.behavior.zooms() || !s.behavior.center_content {
        return Offset::default();
    }
    let inset = s.behavior.content_inset.map(|v| v.0);
    let free = |viewport: f32, content: f32| ((viewport - content * s.zoom) / 2.0).max(0.0);
    Offset::new(
        free(
            state.frame.size.width.0 - inset.left - inset.right,
            s.content.0,
        ),
        free(
            state.frame.size.height.0 - inset.top - inset.bottom,
            s.content.1,
        ),
    )
}

/// The content point (unzoomed) at point `at` of the viewport.
fn content_at(view: &NshView, at: Offset) -> Offset {
    let (ox, oy) = bounds_origin(view);
    let z = zoom(view);
    Offset::new(at.x / z + ox, at.y / z + oy)
}

/// `scale` within the zoom limits; past them by a rubber band while
/// pinching (`rubber`) when `bouncesZoom`, as the web's.
fn limit_zoom(b: &ScrollBehavior, scale: f32, rubber: bool) -> f32 {
    let (min, max) = (b.min_zoom, b.max_zoom.max(b.min_zoom));
    if scale > max {
        if rubber && b.bounces_zoom {
            max * (scale / max).powf(0.3)
        } else {
            max
        }
    } else if scale < min {
        if rubber && b.bounces_zoom {
            min * (scale / min).powf(0.3)
        } else {
            min
        }
    } else {
        scale
    }
}

/// The offset reported to the engine and in events: UIKit's
/// `contentOffset`, within the content.
fn reported(state: &ViewState) -> (f32, f32) {
    let Some(s) = &state.scroll else {
        return (0.0, 0.0);
    };
    let (mx, my) = s.max((state.frame.size.width.0, state.frame.size.height.0));
    let inset = s.behavior.content_inset.map(|v| v.0);
    (
        s.x.clamp(0.0, mx) - inset.left,
        s.y.clamp(0.0, my) - inset.top,
    )
}

/// Milliseconds on the display link's clock.
pub(crate) fn now() -> f64 {
    objc2_quartz_core::CACurrentMediaTime() * 1000.0
}

fn phase(view: &NshView) -> Phase {
    view.state()
        .scroll
        .as_ref()
        .map_or(Phase::Idle, |s| s.live.phase)
}

fn set_phase(view: &NshView, phase: Phase) {
    if let Some(s) = view.state_mut().scroll.as_mut() {
        s.live.phase = phase;
    }
}

/// Whether the user may scroll `view`.
fn enabled(view: &NshView) -> bool {
    view.state()
        .scroll
        .as_ref()
        .is_some_and(|s| s.behavior.enabled)
}

/// Whether `view` is in a window (gets frames).
fn mapped(view: &NshView) -> bool {
    view.ns().window().is_some()
}

/// Whether `view` is a scroll view the user can scroll by `(dx, dy)`
/// (wheel deltas: positive moves the content up / left): it is enabled,
/// scrolls along that axis and is not at that edge yet. Input uses it to
/// pick which of nested scroll views a wheel moves.
pub(crate) fn can_scroll(view: &NshView, dx: f32, dy: f32) -> bool {
    let state = view.state();
    let Some(s) = &state.scroll else {
        return false;
    };
    if !s.behavior.enabled {
        return false;
    }
    let (min, max) = limits(&state);
    let (d, p) = (wheel_delta(s, dx, dy), pos(s));
    let moves = |d: f32, p: f32, min: f32, max: f32| {
        max > min && ((d > 0.0 && p < max - 0.5) || (d < 0.0 && p > min + 0.5))
    };
    moves(d.x, p.x, min.x, max.x) || moves(d.y, p.y, min.y, max.y)
}

/// Whether `view` is a scroll view the user can move at all: it is
/// enabled and its content is larger than its viewport along its axis
/// (a zoomable view's along either).
/// Unlike [`can_scroll`] it needs no direction, so input can ask it as a
/// scroll begins, before the scroll has one: an embedded app passes on a
/// scroll with no such view under the pointer
/// ([`crate::input::forwards_scroll`]).
pub(crate) fn movable(view: &NshView) -> bool {
    let state = view.state();
    state
        .scroll
        .as_ref()
        .is_some_and(|s| movable_in(s, (state.frame.size.width.0, state.frame.size.height.0)))
}

/// [`movable`] for scroll state `s` in a viewport of `viewport` points.
fn movable_in(s: &ScrollState, viewport: (f32, f32)) -> bool {
    let (min, max) = range(s, viewport);
    s.behavior.enabled && (max.x > min.x || max.y > min.y)
}

/// Which scroll view in `chain` (innermost first) a trackpad gesture by
/// `(dx, dy)` stretches past its edge, when [`can_scroll`] found none that can
/// move:
///
/// 1. The innermost bouncing scroll view along the gesture's axis whose
///    content overflows, that zooms, or (vertically) that pulls to refresh.
/// 2. Otherwise, for a vertical gesture only, the outermost enabled vertical
///    scroll view in `chain`, if it bounces: on macOS, AppKit's `.automatic`
///    elasticity still stretches a standalone short vertical scroll view while
///    horizontal elasticity requires overflow, and a fitting inner vertical
///    scroll view (an editor as tall as its document inside a list) hands the
///    stretch to the list around it.
pub(crate) fn bounce_target(chain: &[NshView], dx: f32, dy: f32) -> Option<NshView> {
    let horizontal = dx.abs() > dy.abs();
    let kind = |i: usize| {
        let state = chain[i].state();
        let refreshes = state.events.contains(EventKind::Refresh);
        state.scroll.as_ref().map(|s| {
            bounce_kind(
                s,
                (state.frame.size.width.0, state.frame.size.height.0),
                horizontal,
                refreshes,
            )
        })
    };
    let idx = bounce_index(chain.len(), kind, horizontal)?;
    Some(chain[idx].clone())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Bounce {
    /// Does not participate along this gesture's axis.
    None,
    /// Stretches at its edge: zooms, overflows along the gesture's axis, or
    /// pulls to refresh vertically.
    Primary,
    /// Enabled vertical scroll view whose content fits with `bounces: true`:
    /// stretches only when it is the outermost enabled vertical scroll view.
    VerticalFit,
    /// Enabled vertical scroll view with `bounces: false`: never stretches,
    /// and claims the outer vertical slot so a fitting inner view stays still.
    VerticalRigid,
}

fn bounce_kind(s: &ScrollState, viewport: (f32, f32), horizontal: bool, refreshes: bool) -> Bounce {
    if !s.behavior.enabled {
        return Bounce::None;
    }
    if s.behavior.zooms() {
        return if s.behavior.bounces {
            Bounce::Primary
        } else {
            Bounce::None
        };
    }
    if s.horizontal != horizontal {
        return Bounce::None;
    }
    let (min, max) = range(s, viewport);
    if horizontal {
        return if s.behavior.bounces && max.x > min.x {
            Bounce::Primary
        } else {
            Bounce::None
        };
    }
    if !s.behavior.bounces {
        return Bounce::VerticalRigid;
    }
    if max.y > min.y || refreshes {
        Bounce::Primary
    } else {
        Bounce::VerticalFit
    }
}

/// The index [`bounce_target`] picks among `len` views (innermost first)
/// whose [`Bounce`] classification is `kind(i)`, without collecting them.
fn bounce_index(
    len: usize,
    kind: impl Fn(usize) -> Option<Bounce>,
    horizontal: bool,
) -> Option<usize> {
    if let Some(i) = (0..len).find(|&i| kind(i) == Some(Bounce::Primary)) {
        return Some(i);
    }
    if horizontal {
        return None;
    }
    let outermost = (0..len)
        .rev()
        .find(|&i| matches!(kind(i), Some(Bounce::VerticalFit | Bounce::VerticalRigid)))?;
    (kind(outermost) == Some(Bounce::VerticalFit)).then_some(outermost)
}

/// Sends `kind` with the offset if JS listens to it.
fn emit(surface: &Rc<Surface>, view: &NshView, kind: EventKind) {
    if kind == EventKind::ScrollEnd {
        // Snapping animated values that follow it settle.
        let id = view.state().id;
        if surface.anim.borrow_mut().scroll_ended(id) {
            surface.ensure_ticking();
        }
    }
    let (id, x, y) = {
        let state = view.state();
        if !state.events.contains(kind) {
            return;
        }
        let (x, y) = reported(&state);
        (state.id, x, y)
    };
    surface.event(id, kind, EventPayload::Scroll(point(Points(x), Points(y))));
}

/// Ends momentum or a snap a new input interrupts (`onMomentumEnd`,
/// as UIKit sends when a drag catches a glide).
fn interrupt(surface: &Rc<Surface>, view: &NshView) {
    settle(surface, view);
    let momentum = matches!(
        phase(view),
        Phase::Momentum | Phase::Animate { momentum: true, .. }
    );
    set_phase(view, Phase::Idle);
    if momentum {
        emit(surface, view, EventKind::MomentumEnd);
    }
}

/// A trackpad event at `time` (ms, on the display link's clock) put the
/// offset at `pos`: shown from the next frame on ([`Resampled`]).
fn feed(surface: &Rc<Surface>, view: &NshView, to: Offset, time: f64) {
    if !mapped(view) {
        return moved_to(surface, view, to);
    }
    {
        let mut state = view.state_mut();
        let Some(s) = state.scroll.as_mut() else {
            return;
        };
        let shown = pos(s);
        let r = s.live.resampled.get_or_insert_with(|| Resampled {
            points: Default::default(),
            interval: 1000.0 / 120.0,
        });
        if r.points.is_empty() {
            // The motion starts from what shows, an interval before.
            r.points.push_back((time - r.interval, shown));
        }
        r.push(time, to);
    }
    ensure_ticking(surface, view);
}

/// The offset trackpad events have put `view` at (ahead of what shows
/// while [`Resampled`] catches up).
fn goal(s: &ScrollState) -> Offset {
    s.live
        .resampled
        .as_ref()
        .and_then(Resampled::goal)
        .unwrap_or_else(|| pos(s))
}

/// Shows where trackpad events put `view` at once (something else moves
/// it from there).
fn settle(surface: &Rc<Surface>, view: &NshView) {
    let goal = {
        let mut state = view.state_mut();
        let Some(s) = state.scroll.as_mut() else {
            return;
        };
        match s.live.resampled.take().and_then(|r| r.goal()) {
            Some(goal) => goal,
            None => return,
        }
    };
    moved_to(surface, view, goal);
}

// Moving.

/// The container bounds origin that shows the scroll offset: the content
/// point (unzoomed) at the viewport's top left. Mirrored children are
/// placed from the right: the offset runs the other way.
pub(crate) fn bounds_origin(view: &NshView) -> (f32, f32) {
    let state = view.state();
    let Some(s) = &state.scroll else {
        return (0.0, 0.0);
    };
    let inset = s.behavior.content_inset.map(|v| v.0);
    let room = centered(&state);
    let x = (s.x - inset.left - room.x) / s.zoom;
    (
        if s.mirrored { -x } else { x },
        (s.y - inset.top - room.y) / s.zoom,
    )
}

/// A bounds commit follows the last move by this long (ms).
const COMMIT_MS: u64 = 140;

/// Shows the offset by translating the container layer's sublayers: the
/// pixels move without any view geometry changing, so AppKit does not
/// walk the subtree (`setBoundsOrigin` invalidates every descendant's
/// geometry in the window — focus, tracking areas, cursor rects — and
/// hosted views sync their remote state, per scroll step, which is the
/// jank on long lists). The bounds commit once it settles ([`commit`])
/// puts AppKit's model right for the price of one walk per scroll.
/// Inputs need live bounds instead: AppKit clips their drawing by its
/// visible rectangles, which do not follow the layer transform; so does a
/// zoomable view, whose zoom is the bounds' size.
fn apply_offset(surface: &Rc<Surface>, view: &NshView) {
    let origin = bounds_origin(view);
    // Every offset, inset, zoom and mirroring change comes through here:
    // what shows under it changed ([`crate::sight`]).
    crate::sight::moved();
    let live = {
        let state = view.state();
        state.input_count != 0 || state.scroll.as_ref().is_some_and(|s| s.behavior.zooms())
    };
    if live {
        view.commit_bounds(origin.0, origin.1);
    } else {
        let committed = view.container_bounds_origin();
        view.set_layer_scroll(committed.0 - origin.0, committed.1 - origin.1);
        arm_commit(surface, view);
    }
    // The effects around it (and a screen effect reading the surface)
    // picture the changed viewport again.
    crate::shader::ui_changed(view);
}

/// Schedules the trailing bounds commit, `COMMIT_MS` after the offset
/// last moved (`s.live.commit_at`).
fn arm_commit(surface: &Rc<Surface>, view: &NshView) {
    let (key, id) = {
        let mut state = view.state_mut();
        let Some(s) = state.scroll.as_mut() else {
            return;
        };
        s.live.commit_at = now() + COMMIT_MS as f64;
        if std::mem::replace(&mut s.live.commit_armed, true) {
            return;
        }
        (surface.key(), state.id)
    };
    later(COMMIT_MS, move || commit(key, id));
}

/// The longest a bounds commit waits for the display link to rest once the
/// view is at rest (ms): past the indicator's fade, so a scroll alone
/// commits when nothing draws, while an animation that keeps the link
/// running (a spinner) does not hold AppKit's model back for long.
const REST_WAIT: f64 = 1000.0;

/// Whether the armed bounds commit lands at `t` (ms): the offset has not
/// moved for [`COMMIT_MS`] (`commit_at`) and no scroll phase runs (`idle`;
/// input and glides go on as long as they last, each frame moving only the
/// layer transform), then once the display link rests (`link_busy` false)
/// or [`REST_WAIT`] after the view came to rest (`rested_at`, kept here).
fn commit_due(
    t: f64,
    commit_at: f64,
    idle: bool,
    link_busy: bool,
    rested_at: &mut Option<f64>,
) -> bool {
    if commit_at - t > 1.0 || !idle {
        *rested_at = None;
        return false;
    }
    let since = *rested_at.get_or_insert(t);
    !link_busy || t - since >= REST_WAIT
}

/// Commits every pending scroll offset of `surface` to its container's
/// bounds now: before anything asks AppKit where views are (a press's hit
/// test, a conversion of rectangles), which follows the bounds, not the
/// layer transforms showing the offsets meanwhile. The armed commits still
/// run, and find nothing left to move.
pub(crate) fn commit_pending(surface: &Surface) {
    let Ok(mounter) = surface.mounter.try_borrow() else {
        return;
    };
    let pending: Vec<NshView> = mounter
        .views
        .values()
        .filter(|v| {
            v.state()
                .scroll
                .as_ref()
                .is_some_and(|s| s.live.commit_armed)
        })
        .cloned()
        .collect();
    drop(mounter);
    for view in pending {
        commit_now(&view);
    }
}

/// [`commit_pending`] for the scroll views around `view` only (what
/// AppKit's geometry of `view` depends on).
pub(crate) fn commit_ancestors(view: &NshView) {
    for v in std::iter::successors(Some(view.clone()), NshView::parent_view) {
        if v.state()
            .scroll
            .as_ref()
            .is_some_and(|s| s.live.commit_armed)
        {
            commit_now(&v);
        }
    }
}

fn commit_now(view: &NshView) {
    let origin = bounds_origin(view);
    crate::surface::quiet(|| view.commit_bounds(origin.0, origin.1));
}

/// Moves the scroll offset the layer transform has been showing into the
/// container's bounds: a single subtree walk updates tracking areas,
/// cursor rects and accessibility with where things really are.
fn commit(key: u64, id: nsh_core::NodeId) {
    let Some(surface) = Surface::with_key(key) else {
        return;
    };
    let Ok(mounter) = surface.mounter.try_borrow() else {
        // A batch is being applied: try again shortly.
        later(20, move || commit(key, id));
        return;
    };
    let Some(view) = mounter.views.get(&id).cloned() else {
        return;
    };
    drop(mounter);
    // `setBoundsOrigin` walks the whole subtree (descendants' window
    // geometry, tracking areas, cursor rects, hosted views' remote
    // state): on a live frame that walk drops it, so the commit waits
    // for the display link to rest — the input ended and nothing draws.
    let idle = phase(&view) == Phase::Idle;
    let link_busy = surface.wants_frames();
    let due = {
        let mut state = view.state_mut();
        let Some(s) = state.scroll.as_mut() else {
            return;
        };
        let due = commit_due(
            now(),
            s.live.commit_at,
            idle,
            link_busy,
            &mut s.live.rested_at,
        );
        if due {
            s.live.commit_armed = false;
            s.live.rested_at = None;
        }
        due
    };
    if !due {
        later(32, move || commit(key, id));
        return;
    }
    let origin = bounds_origin(&view);
    crate::surface::quiet(|| view.commit_bounds(origin.0, origin.1));
}

/// Moves `view`'s offset to `to` (not clamped: drags rubber band) and
/// updates everything that follows it.
fn moved_to(surface: &Rc<Surface>, view: &NshView, to: Offset) {
    if current(view) != to {
        shown_at(surface, view, to);
    }
}

/// Shows `view` at offset `to` (and its zoom) and updates everything that
/// follows it.
fn shown_at(surface: &Rc<Surface>, view: &NshView, to: Offset) {
    let (id, x, y, pulled) = {
        let mut state = view.state_mut();
        let Some(s) = state.scroll.as_mut() else {
            return;
        };
        // How far it is pulled past its top, when that changes.
        let pulled = (!s.horizontal && (s.y < 0.0 || to.y < 0.0)).then(|| Points((-to.y).max(0.0)));
        (s.x, s.y) = (to.x, to.y);
        if s.indicator {
            s.live.shown = now();
            s.live.alpha = 1.0;
            s.live.dark = surface.environment.get().color_scheme == nsh_engine::ColorScheme::Dark;
        }
        s.live.report = true;
        let (x, y) = reported(&state);
        (state.id, x, y, pulled)
    };
    crate::surface::quiet(|| {
        apply_offset(surface, view);
        pin_sticky(surface, view);
        update_overlays(view);
    });
    crate::input::content_moved(surface, Some(view));
    let mut fed = surface.anim.borrow_mut().scrolled(id, x, y);
    if let Some(distance) = pulled {
        fed |= surface.anim.borrow_mut().pulled(id, distance);
    }
    if fed && surface.mounter.try_borrow().is_ok() {
        // While a batch is applied the surface writes animations after it.
        surface.write_animations();
    }
    if mapped(view) {
        ensure_ticking(surface, view);
    } else {
        // No frames come while it is not in a window: report now.
        report(surface, view);
    }
}

fn report(surface: &Surface, view: &NshView) {
    let (id, x, y, applied, zoom) = {
        let mut state = view.state_mut();
        let Some(s) = state.scroll.as_mut() else {
            return;
        };
        if !std::mem::take(&mut s.live.report) {
            return;
        }
        let applied = s.applied;
        // The zoom goes before the offset it changed: `onScroll` carries it
        // (and the 1 a view that zooms no more is back at).
        let known = s.behavior.zooms() || s.live.reported_zoom != 0.0;
        let zoom = (known && s.zoom != s.live.reported_zoom).then(|| {
            s.live.reported_zoom = s.zoom;
            s.zoom
        });
        let (x, y) = reported(&state);
        (state.id, x, y, applied, zoom)
    };
    if let Some(zoom) = zoom {
        surface.control(|c| c.zoom(id, zoom));
    }
    surface.control(|c| c.scroll(id, point(Points(x), Points(y)), applied));
    crate::access::scroll_bar::moved(view);
}

/// Eases to `to` (clamped to the rest limits).
fn animate_to(
    surface: &Rc<Surface>,
    view: &NshView,
    to: Offset,
    duration: f64,
    momentum: bool,
    end: bool,
) {
    settle(surface, view);
    let to = clamp(to, limits(&view.state()));
    let from = current(view);
    if from.distance(to) < 0.5 || duration <= 0.0 {
        set_phase(view, Phase::Idle);
        moved_to(surface, view, to);
        if momentum {
            emit(surface, view, EventKind::MomentumEnd);
        }
        if end {
            emit(surface, view, EventKind::ScrollEnd);
        }
        return;
    }
    set_phase(
        view,
        Phase::Animate {
            from,
            to,
            start: now(),
            duration,
            momentum,
            end,
        },
    );
    ensure_ticking(surface, view);
}

/// The user let go at `v` points per ms along the main axis (positive:
/// the offset grows): bounces back, snaps or settles. Snapping uses
/// `snap_velocity` when it is not 0 (a settled mouse wheel).
fn release(surface: &Rc<Surface>, view: &NshView, v: f32, snap_velocity: f32) {
    settle(surface, view);
    let (p, back, target) = {
        let state = view.state();
        let Some(s) = &state.scroll else { return };
        let lims = limits(&state);
        let (p, max) = (pos(s), lims.1.along(s.horizontal));
        let pos = main(s);
        let lead = if s.horizontal {
            s.behavior.content_inset.left.0
        } else {
            s.behavior.content_inset.top.0
        };
        let dim = viewport(&state, s.horizontal);
        let snap_velocity = if snap_velocity == 0.0 {
            v
        } else {
            snap_velocity
        };
        // Snap points are content offsets: UIKit's coordinates. Zoomed
        // content does not snap.
        let target = s
            .behavior
            .snap_target(
                Points(pos - lead),
                projected(Points(pos), v, rate(&s.behavior)) - Points(lead),
                snap_velocity,
                Points(dim),
                Points(max + dim - lead),
            )
            .filter(|_| !s.behavior.zooms())
            .map(|t| (p.with(s.horizontal, t.0 + lead), t.0 + lead - pos));
        (p, clamp(p, lims), target)
    };
    if p.distance(back) > 0.5 {
        animate_to(surface, view, back, ANIMATION, false, true);
    } else if let Some((target, distance)) = target {
        let duration = snap_duration(Points(distance), v);
        if duration > 0.0 {
            emit(surface, view, EventKind::MomentumStart);
        }
        animate_to(surface, view, target, duration, duration > 0.0, true);
    } else {
        set_phase(view, Phase::Idle);
        emit(surface, view, EventKind::ScrollEnd);
    }
}

// The frame clock.

fn ensure_ticking(surface: &Rc<Surface>, view: &NshView) {
    {
        let mut state = view.state_mut();
        let Some(s) = state.scroll.as_mut() else {
            return;
        };
        if s.live.ticking {
            return;
        }
        s.live.ticking = true;
    }
    let view = view.clone();
    // Whether only the indicator's fade is left (the agent of `nsh test`
    // does not wait for it).
    let mut fading = false;
    surface.add_frame_callback(move |surface, now| {
        let left = tick(surface, &view, now * 1000.0);
        if (left == Tick::Fading) != fading {
            fading = !fading;
            surface.cosmetic_frame(fading);
        }
        if matches!(left, Tick::Busy | Tick::Fading) {
            return deadline(&view).map_or(Next::Frame, |ms| Next::At(ms / 1000.0));
        }
        if let Some(s) = view.state_mut().scroll.as_mut() {
            s.live.ticking = false;
        }
        if let Tick::Hold(ms) = left {
            wake_after_hold(surface, &view, ms);
        }
        Next::Done
    });
}

/// Nothing changes on screen until the indicator's hold ends: no frames until
/// then, or following the end of a stream would run the display link all along.
fn wake_after_hold(surface: &Rc<Surface>, view: &NshView, ms: u64) {
    let armed = view
        .state_mut()
        .scroll
        .as_mut()
        .is_some_and(|s| !std::mem::replace(&mut s.live.hold_timer, true));
    if !armed {
        return;
    }
    let key = surface.key();
    let view = dispatch2::MainThreadBound::new(view.clone(), view.mtm());
    later(ms, move || {
        let view = view.into_inner(MainThreadMarker::new().expect("main queue"));
        let attached = mapped(&view);
        if let Some(s) = view.state_mut().scroll.as_mut() {
            s.live.hold_timer = false;
            // No frames come out of the window: the indicator is gone when it returns.
            if !attached {
                s.live.alpha = 0.0;
            }
        }
        if !attached {
            update_overlays(&view);
        } else if let Some(surface) = Surface::with_key(key) {
            ensure_ticking(&surface, &view);
        }
    });
}

/// The core deleted `view` (it alone or with its parent): its refresh
/// spinner stops turning. The core never ends a deleted view's refresh, so
/// a spinner turning on would keep its frame callback, which holds the
/// view, running every frame for good: the view never freed and the display
/// link never at rest. Its other motion ends by itself, as before.
pub(crate) fn deleted(view: &NshView) {
    if let Some(s) = view.state_mut().scroll.as_mut() {
        s.live.deleted = true;
    }
}

/// When `view`'s motion next comes to something (ms, the frames' clock):
/// an eased move's end, a mouse wheel's or a touchpad's rest; what runs
/// its frame while no frames are drawn ([`Next::At`]). `None` while only
/// drawing is left (the indicator's fade, the spinner) or input it waits
/// for.
fn deadline(view: &NshView) -> Option<f64> {
    let state = view.state();
    let end = match state.scroll.as_ref()?.live.phase {
        Phase::Animate {
            start, duration, ..
        }
        | Phase::Zoom {
            start, duration, ..
        } => start + duration,
        Phase::Wheel {
            last,
            gesture: false,
            glide,
            ..
        } => (last + WHEEL_IDLE).max(glide.end()),
        Phase::AwaitMomentum { since } => since + MOMENTUM_WAIT,
        _ => return None,
    };
    // A millisecond past it: the frame there finds it ended whatever the
    // rounding.
    Some(end + 1.0)
}

/// What a scroll view has left to do after a frame ([`tick`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tick {
    /// Nothing: its frame callback ends.
    Done,
    /// Motion, input it waits for, or the refresh spinner.
    Busy,
    /// Only the indicator's fade.
    Fading,
    /// Only the indicator's hold, for this many ms.
    Hold(u64),
}

/// One frame of `view`'s motion.
fn tick(surface: &Rc<Surface>, view: &NshView, now: f64) -> Tick {
    let sampled = {
        let mut state = view.state_mut();
        let Some(s) = state.scroll.as_mut() else {
            return Tick::Done;
        };
        // Events still come in these phases: hold at the newest until the
        // next one, rather than ending.
        let input = matches!(
            s.live.phase,
            Phase::Wheel { gesture: true, .. } | Phase::AwaitMomentum { .. } | Phase::Momentum
        );
        match s.live.resampled.as_mut() {
            Some(r) => {
                // A little more than an interval back: the event after it
                // has come by then, even a little late.
                let (pos, past) = r.sample(now - r.interval - 2.0);
                if past && !input {
                    s.live.resampled = None;
                }
                Some(pos)
            }
            None => None,
        }
    };
    if let Some(pos) = sampled {
        moved_to(surface, view, pos);
    }
    let (phase, p, (min, max)) = {
        let state = view.state();
        let Some(s) = &state.scroll else {
            return Tick::Done;
        };
        (s.live.phase, pos(s), limits(&state))
    };
    let hi = Offset::new(max.x.max(min.x), max.y.max(min.y));
    match phase {
        Phase::Animate {
            from,
            to,
            start,
            duration,
            momentum,
            end,
        } => {
            let t = (now - start) / duration;
            moved_to(surface, view, from.lerp(to, ease_out(t)));
            if t >= 1.0 {
                set_phase(view, Phase::Idle);
                if momentum {
                    emit(surface, view, EventKind::MomentumEnd);
                }
                if end {
                    emit(surface, view, EventKind::ScrollEnd);
                }
            }
        }
        Phase::Zoom {
            from,
            to,
            from_c,
            to_c,
            at,
            start,
            duration,
        } => {
            let t = (now - start) / duration;
            let k = ease_out(t);
            zoom_at(
                surface,
                view,
                from + (to - from) * k,
                from_c.lerp(to_c, k),
                at,
            );
            if t >= 1.0 {
                set_phase(view, Phase::Idle);
                sharpen(view);
            }
        }
        Phase::Wheel {
            last,
            gesture: false,
            raw,
            glide,
            ..
        } if now - last <= WHEEL_IDLE || now < glide.end() => {
            moved_to(surface, view, glide.value(raw.into(), now).into());
        }
        Phase::Wheel {
            total,
            gesture: false,
            raw,
            ..
        } => {
            // A mouse wheel came to rest: snapping views move on to the
            // next snap point in the wheel's direction.
            moved_to(surface, view, raw);
            set_phase(view, Phase::Idle);
            let snaps = view
                .state()
                .scroll
                .as_ref()
                .is_some_and(|s| s.behavior.snaps() || s.behavior.paging);
            if snaps {
                let v = if total.abs() >= 1.0 {
                    total.signum() * WHEEL_SNAP
                } else {
                    0.0
                };
                release(surface, view, 0.0, v);
            } else {
                emit(surface, view, EventKind::ScrollEnd);
            }
        }
        Phase::AwaitMomentum { since } if now - since > MOMENTUM_WAIT => {
            set_phase(view, Phase::Idle);
            emit(surface, view, EventKind::ScrollEnd);
        }
        Phase::Idle if p.x > hi.x + 0.5 || p.y > hi.y + 0.5 => {
            moved_to(surface, view, Offset::new(p.x.min(hi.x), p.y.min(hi.y)));
        }
        _ => {}
    }
    report(surface, view);
    let (left, overlays) = {
        let mut state = view.state_mut();
        let Some(s) = state.scroll.as_mut() else {
            return Tick::Done;
        };
        let resampling = s.live.resampled.is_some();
        let mut indicator = Indicator::Gone;
        let mut overlays = false;
        if matches!(s.live.phase, Phase::Thumb { .. }) {
            // A held thumb stays until it is let go (`thumb_end`).
            s.live.shown = now;
        } else if s.live.alpha > 0.0 {
            let since = now - s.live.shown;
            let alpha = indicator_alpha(since);
            if alpha != s.live.alpha {
                s.live.alpha = alpha;
                overlays = true;
            }
            indicator = match indicator_hold_left(since) {
                Some(ms) => Indicator::Holding(ms),
                None if alpha > 0.0 => Indicator::Fading,
                None => Indicator::Gone,
            };
        }
        // A deleted view's spinner stops ([`deleted`]).
        let spinning = !s.horizontal
            && main(s) < 0.0
            && s.live.refreshing
            && !s.live.deleted
            && s.behavior.refresh_indicator.is_none();
        if spinning {
            s.live.spin = ((now / 1000.0) as f32 * 2.0 * PI) % (2.0 * PI);
            overlays = true;
        }
        (
            what_is_left(&s.live.phase, resampling, indicator, spinning),
            overlays,
        )
    };
    if overlays {
        update_overlays(view);
    }
    left
}

/// What a scroll view in `phase` has left after a frame: its own motion
/// (an animated scroll, a mouse wheel coming to rest, the wait for
/// momentum), trackpad offsets still to show (`resampling`) or the
/// refresh spinner (`spinning`) keep it busy; the phases events drive
/// (a trackpad gesture, momentum, a held thumb) wait for them; the
/// `indicator` is all that may be left.
fn what_is_left(phase: &Phase, resampling: bool, indicator: Indicator, spinning: bool) -> Tick {
    let moving = !matches!(
        phase,
        Phase::Idle | Phase::Thumb { .. } | Phase::Momentum | Phase::Wheel { gesture: true, .. }
    );
    if moving || resampling || spinning {
        return Tick::Busy;
    }
    match indicator {
        Indicator::Gone => Tick::Done,
        Indicator::Holding(ms) => Tick::Hold(ms),
        Indicator::Fading => Tick::Fading,
    }
}

/// Where a scroll view's indicator is after a frame.
#[derive(Debug, Clone, Copy)]
enum Indicator {
    /// Not shown, or held by the thumb until it is let go.
    Gone,
    /// Fully shown for this many ms more.
    Holding(u64),
    Fading,
}

// The indicator and the refresh spinner.

fn rect(x: f32, y: f32, w: f32, h: f32) -> CGRect {
    CGRect::new(
        CGPoint::new(x as f64, y as f64),
        CGSize::new(w.max(0.0) as f64, h.max(0.0) as f64),
    )
}

define_class!(
    /// Holds a scroll view's indicator and refresh spinner above its
    /// container (and so above the content), as macOS's overlay scrollers
    /// are; never takes the mouse.
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "NshScrollOverlay"]
    struct Overlay;

    unsafe impl NSObjectProtocol for Overlay {}

    impl Overlay {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        #[unsafe(method(wantsUpdateLayer))]
        fn wants_update_layer(&self) -> bool {
            true
        }

        #[unsafe(method(updateLayer))]
        fn update_layer(&self) {}

        #[unsafe(method_id(hitTest:))]
        fn hit_test(&self, _point: NSPoint) -> Option<Retained<NSView>> {
            None
        }
    }
);

/// A layer in `view`'s overlay view (made on first use), which stays the
/// size of the view.
fn overlay_layer(
    view: &NshView,
    overlay: &mut Option<Retained<NSView>>,
) -> Option<Retained<CALayer>> {
    let host = match overlay {
        Some(host) => host.clone(),
        None => {
            // SAFETY: NSView's designated initializer.
            let host: Retained<Overlay> =
                unsafe { msg_send![Overlay::alloc(view.mtm()), initWithFrame: view.ns().bounds()] };
            host.setWantsLayer(true);
            view.ns().addSubview(&host);
            let host = Retained::into_super(host);
            *overlay = Some(host.clone());
            host
        }
    };
    let layer = CALayer::new();
    layer.setAnchorPoint(CGPoint::new(0.0, 0.0));
    host.layer()?.addSublayer(&layer);
    Some(layer)
}

/// The indicator's frame in a `w` × `h` scroll view and how far it can
/// travel along its track, or `None` when the content fits.
fn thumb(s: &ScrollState, w: f32, h: f32) -> Option<(CGRect, f32)> {
    const EDGE: f32 = 2.0;
    // Zoomed content pans both ways, without a bar (as on the web).
    if s.behavior.zooms() {
        return None;
    }
    let inset = s.behavior.content_inset.map(|v| v.0);
    let bar = s.behavior.scrollbar_inset.map(|v| v.0.max(0.0));
    // Along the axis, from where the offset counts (the right of a mirrored
    // view).
    let (dim, total, offset, before, after) = if s.horizontal {
        let (before, after) = if s.mirrored {
            (bar.right, bar.left)
        } else {
            (bar.left, bar.right)
        };
        (
            w,
            s.content.0 + inset.left + inset.right,
            s.x,
            before,
            after,
        )
    } else {
        (
            h,
            s.content.1 + inset.top + inset.bottom,
            s.y,
            bar.top,
            bar.bottom,
        )
    };
    let (start, len) = indicator_span_within(
        Points(dim),
        Points(total),
        Points(offset),
        Points(before),
        Points(after),
    )?;
    let (start, len) = (start.0, len.0);
    let frame = if s.horizontal {
        let x = if s.mirrored { w - start - len } else { start };
        rect(
            x,
            h - bar.bottom - INDICATOR_THICK - EDGE,
            len,
            INDICATOR_THICK,
        )
    } else {
        rect(
            w - bar.right - INDICATOR_THICK - EDGE,
            start,
            INDICATOR_THICK,
            len,
        )
    };
    Some((frame, dim - before - after - 2.0 * INDICATOR_MARGIN - len))
}

/// Updates the indicator and the refresh spinner of `view` to its offset.
fn update_overlays(view: &NshView) {
    let mut state = view.state_mut();
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    let refresh_listened = state.events.contains(EventKind::Refresh);
    let Some(s) = state.scroll.as_mut() else {
        return;
    };
    if let Some(overlay) = &s.live.overlay {
        let size = overlay.frame().size;
        if size.width != w as f64 || size.height != h as f64 {
            overlay.setFrame(rect(0.0, 0.0, w, h));
        }
    }
    // The indicator.
    let frame = if s.indicator && s.live.alpha > 0.0 {
        thumb(s, w, h).map(|(frame, _)| frame)
    } else {
        None
    };
    match frame {
        Some(frame) => {
            if s.live.indicator.is_none() {
                s.live.indicator = overlay_layer(view, &mut s.live.overlay);
            }
            if let Some(layer) = &s.live.indicator {
                layer.setBounds(rect(
                    0.0,
                    0.0,
                    frame.size.width as f32,
                    frame.size.height as f32,
                ));
                layer.setPosition(frame.origin);
                layer.setCornerRadius(INDICATOR_THICK as f64 / 2.0);
                let color = if s.live.dark {
                    CGColor::new_srgb(1.0, 1.0, 1.0, 0.55)
                } else {
                    CGColor::new_srgb(0.0, 0.0, 0.0, 0.45)
                };
                layer.setBackgroundColor(Some(&color));
                layer.setOpacity(s.live.alpha);
                layer.setHidden(false);
            }
        }
        None => {
            if let Some(layer) = &s.live.indicator {
                layer.setHidden(true);
            }
        }
    }
    // The refresh spinner.
    let shows = !s.horizontal
        && s.y < 0.0
        && s.behavior.refresh_indicator.is_none()
        && (s.live.refreshing || refresh_listened);
    if !shows {
        if let Some(layer) = &s.live.spinner {
            layer.setHidden(true);
        }
        return;
    }
    if s.live.spinner.is_none() {
        s.live.spinner = overlay_layer(view, &mut s.live.overlay).inspect(|layer| {
            for _ in 0..SPOKES {
                let spoke = CALayer::new();
                spoke.setBounds(rect(0.0, 0.0, 2.5, 5.5));
                spoke.setCornerRadius(1.25);
                layer.addSublayer(&spoke);
            }
        });
    }
    let Some(layer) = &s.live.spinner else { return };
    layer.setHidden(false);
    let progress = if s.live.refreshing {
        1.0
    } else {
        (-s.y / s.behavior.refresh_threshold().0).min(1.0)
    };
    let cy = s.behavior.content_inset.top.0 - s.y - s.behavior.refresh_inset().0 / 2.0;
    layer.setBounds(rect(0.0, 0.0, 0.0, 0.0));
    layer.setPosition(CGPoint::new((w / 2.0) as f64, cy as f64));
    let shown = ((progress * SPOKES as f32).ceil() as usize).min(SPOKES);
    let step = 2.0 * PI / SPOKES as f32;
    // Turns in whole spokes, as a native spinner does.
    let lead = (s.live.spin / step) as usize % SPOKES;
    let base = if s.live.dark { 1.0 } else { 0.25 };
    // SAFETY: a getter; the spinner's sublayers are the spokes we added,
    // never mutated elsewhere while this runs (main thread).
    let Some(spokes) = (unsafe { layer.sublayers() }) else {
        return;
    };
    for (i, spoke) in spokes.iter().enumerate() {
        let fade = if progress < 1.0 {
            0.8
        } else {
            1.0 - ((lead + SPOKES - i) % SPOKES) as f32 / SPOKES as f32 * 0.85
        };
        // Each spoke 7.25 points from the center, pointing outwards.
        let angle = i as f32 * step;
        let (sin, cos) = angle.sin_cos();
        spoke.setPosition(CGPoint::new((sin * 7.25) as f64, (-cos * 7.25) as f64));
        spoke.setAffineTransform(objc2_core_foundation::CGAffineTransform {
            a: cos as f64,
            b: sin as f64,
            c: -sin as f64,
            d: cos as f64,
            tx: 0.0,
            ty: 0.0,
        });
        let color = CGColor::new_srgb(base, base, base, fade as f64);
        spoke.setBackgroundColor(Some(&color));
        spoke.setHidden(i >= shown);
    }
}

/// Spokes of the refresh spinner.
const SPOKES: usize = 8;

// Sticky cells.

/// Calls `f` with the view of node `id` in `view` (a child, or for a list
/// in the scroll view's viewport, the list's).
fn with_cell(surface: &Surface, view: &NshView, id: nsh_core::NodeId, f: impl FnOnce(&NshView)) {
    if let Ok(mounter) = surface.mounter.try_borrow() {
        if let Some(cell) = mounter.views.get(&id) {
            f(cell);
        }
        return;
    }
    // While a batch is applied: look among the children, then deeper (the
    // cells of a list in the scroll view's viewport are in the list).
    let mut views = view.child_views();
    if let Some(cell) = views.iter().find(|c| c.id() == id) {
        f(cell);
        return;
    }
    while let Some(v) = views.pop() {
        if v.id() == id {
            f(&v);
            return;
        }
        views.extend(v.child_views());
    }
}

/// Translates the sticky cells to the offset.
fn pin_sticky(surface: &Surface, view: &NshView) {
    let (cells, offset, horizontal) = {
        let state = view.state();
        let Some(s) = &state.scroll else { return };
        if s.sticky.is_empty() {
            return;
        }
        let lead = if s.horizontal {
            s.behavior.content_inset.left.0
        } else {
            s.behavior.content_inset.top.0
        };
        (s.sticky.clone(), main(s) - lead, s.horizontal)
    };
    // An animated offset is the graph's (pinned again with its frames,
    // `pin_animated_sticky`, when it is being written).
    let anim = surface.anim.try_borrow().ok();
    for c in &cells {
        let extra = c.offset.zip(anim.as_ref()).map_or(0.0, |(n, a)| a.value(n));
        let t = sticky_shift(Points(offset + extra), c.start, c.end).0;
        let shift = if horizontal { (t, 0.0) } else { (0.0, t) };
        with_cell(surface, view, c.cell, |cell| {
            let changed = {
                let mut cs = cell.state_mut();
                std::mem::replace(&mut cs.shift, shift) != shift
            };
            if changed {
                cell.place();
            }
        });
    }
}

/// Pins again the sticky cells of the scroll views whose cells stick an
/// animated value further in, after the graph's values were written.
pub(crate) fn pin_animated_sticky(surface: &Surface) {
    let views: Vec<u32> = surface.anim.borrow().sticky_views().to_vec();
    if views.is_empty() {
        return;
    }
    for id in views {
        let view = surface
            .mounter
            .try_borrow()
            .ok()
            .and_then(|m| m.views.get(&id).cloned());
        if let Some(view) = view {
            pin_sticky(surface, &view);
        }
    }
}

/// Keeps the sticky cells last among `view`'s children, so they draw (and
/// take pointers) above the other cells.
fn front_sticky(view: &NshView) {
    let sticky: Vec<nsh_core::NodeId> = {
        let state = view.state();
        let Some(s) = &state.scroll else { return };
        s.sticky.iter().map(|c| c.cell).collect()
    };
    if sticky.is_empty() {
        return;
    }
    let children = view.child_views();
    let is_sticky = |v: &NshView| sticky.contains(&v.id());
    let at_end = children.iter().rev().take_while(|v| is_sticky(v)).count();
    let cells: Vec<&NshView> = children.iter().filter(|v| is_sticky(v)).collect();
    if at_end == cells.len() {
        return;
    }
    let container: Retained<NSView> = view.container();
    for cell in cells {
        // Re-adding moves it on top of its siblings (hosted views are not
        // in a scroll view's container).
        crate::surface::quiet(|| container.addSubview(cell.ns()));
    }
}

/// A child was inserted into scroll view `view` (mounting): new cells must
/// not cover the pinned ones.
pub(crate) fn child_inserted(view: &NshView) {
    front_sticky(view);
}

// Mount items.

/// `ScrollConfig`.
pub(crate) fn config(
    _surface: &Rc<Surface>,
    view: &NshView,
    horizontal: bool,
    indicator: bool,
    replaced: bool,
    mirrored: bool,
) {
    let changed = {
        let mut state = view.state_mut();
        let Some(s) = state.scroll.as_mut() else {
            return;
        };
        s.horizontal = horizontal;
        // The view shows its indicator only when it asks to, on either
        // axis: a mouse without a horizontal wheel still moves a
        // horizontal view with Shift + wheel, with the vertical wheel
        // where nothing around scrolls vertically, and with the keys. A
        // built-in bar of the app's (`replaced`) takes its place.
        s.indicator = indicator && !replaced;
        if !indicator {
            s.live.alpha = 0.0;
        }
        let mirrored = mirrored && horizontal;
        std::mem::replace(&mut s.mirrored, mirrored) != mirrored
    };
    if changed {
        // The children's places depend on the mirroring.
        for child in view.child_views() {
            child.place();
        }
    }
    apply_offset(_surface, view);
    update_overlays(view);
}

/// `ScrollContent`. Content that shrank below the offset pulls it back on
/// the next frame, once the rest of the batch (the `ScrollBy` that keeps
/// the visible content in place) is applied.
pub(crate) fn content(surface: &Rc<Surface>, view: &NshView, size: Size<Points>) {
    let (past, zooms) = {
        let mut state = view.state_mut();
        let Some(s) = state.scroll.as_mut() else {
            return;
        };
        s.content = (size.width.0, size.height.0);
        let (p, zooms) = (pos(s), s.behavior.zooms());
        let (min, max) = limits(&state);
        (
            p.x > max.x.max(min.x) + 0.5 || p.y > max.y.max(min.y) + 0.5,
            zooms,
        )
    };
    if zooms {
        // Centered content moves with its size.
        apply_offset(surface, view);
    }
    if past {
        ensure_ticking(surface, view);
    }
    update_overlays(view);
    crate::access::scroll_bar::moved(view);
}

/// The viewport changed size: an offset now past the end is pulled back.
pub(crate) fn resized(surface: &Rc<Surface>, view: &NshView) {
    let past = {
        let state = view.state();
        let Some(s) = &state.scroll else {
            return;
        };
        {
            let max = limits(&state).1;
            let p = pos(s);
            p.x > max.x + 0.5 || p.y > max.y + 0.5
        }
    };
    if past {
        ensure_ticking(surface, view);
    }
    update_overlays(view);
}

/// `ScrollBy`: the core keeps the visible content in place (items above
/// the viewport changed size); not clamped, the core knows its content.
pub(crate) fn scroll_by(surface: &Rc<Surface>, view: &NshView, dx: f32, dy: f32) {
    let (p, d) = {
        let mut state = view.state_mut();
        let Some(s) = state.scroll.as_mut() else {
            return;
        };
        s.applied = s.applied.wrapping_add(1);
        // The off axis would only push the content out of the viewport
        // (zoomed content moves along both).
        let d = if s.behavior.zooms() {
            Offset::new(dx, dy)
        } else {
            Offset::default().with(s.horizontal, if s.horizontal { dx } else { dy })
        };
        // A gesture or animation in flight moves along.
        s.live.phase = match s.live.phase {
            Phase::Thumb { start } => Phase::Thumb {
                start: start + d.along(s.horizontal),
            },
            Phase::Wheel {
                last,
                total,
                gesture,
                raw,
                glide,
            } => Phase::Wheel {
                last,
                total,
                gesture,
                raw: raw + d,
                glide: glide.shifted(d.into()),
            },
            Phase::Animate {
                from,
                to,
                start,
                duration,
                momentum,
                end,
            } => Phase::Animate {
                from: from + d,
                to: to + d,
                start,
                duration,
                momentum,
                end,
            },
            other => other,
        };
        if let Some(r) = s.live.resampled.as_mut() {
            for p in &mut r.points {
                p.1 = p.1 + d;
            }
        }
        s.live.report = true;
        (pos(s), d)
    };
    if d != Offset::default() {
        moved_to(surface, view, p + d);
    }
    report(surface, view);
}

/// Scrolls `view` at rest by `(dx, dy)` along its axis, within its rest
/// limits: a selection dragged past its edge. False if it did not move.
pub(crate) fn autoscroll(surface: &Rc<Surface>, view: &NshView, dx: f32, dy: f32) -> bool {
    let (from, to) = {
        let state = view.state();
        let Some(s) = &state.scroll else {
            return false;
        };
        if !matches!(s.live.phase, Phase::Idle) {
            return false;
        }
        let from = pos(s);
        // Mirrored lists keep left-to-right offsets.
        let d = match (s.behavior.zooms(), s.horizontal, s.mirrored) {
            (true, ..) => Offset::new(dx, dy),
            (false, true, true) => Offset::new(-dx, 0.0),
            (false, true, false) => Offset::new(dx, 0.0),
            _ => Offset::new(0.0, dy),
        };
        (from, clamp(from + d, limits(&state)))
    };
    if to == from {
        return false;
    }
    moved_to(surface, view, to);
    true
}

/// `StickyCells`.
pub(crate) fn sticky(surface: &Rc<Surface>, view: &NshView, cells: Vec<StickyCell>) {
    let old = {
        let mut state = view.state_mut();
        let Some(s) = state.scroll.as_mut() else {
            return;
        };
        std::mem::replace(&mut s.sticky, cells)
    };
    // Cells no longer sticky go back to their frames.
    for c in old {
        let still = view
            .state()
            .scroll
            .as_ref()
            .is_some_and(|s| s.sticky.iter().any(|n| n.cell == c.cell));
        if !still {
            with_cell(surface, view, c.cell, |cell| {
                cell.state_mut().shift = (0.0, 0.0);
                cell.place();
            });
        }
    }
    front_sticky(view);
    pin_sticky(surface, view);
}

/// `ScrollBehavior`.
pub(crate) fn behavior(surface: &Rc<Surface>, view: &NshView, behavior: &ScrollBehavior) {
    let (inset, refresh, held, zoom) = {
        let mut state = view.state_mut();
        let Some(s) = state.scroll.as_mut() else {
            return;
        };
        let inset = s.behavior.content_inset != behavior.content_inset
            || s.behavior.zooms() != behavior.zooms()
            || s.behavior.center_content != behavior.center_content;
        let refresh = s.behavior.refresh_indicator != behavior.refresh_indicator;
        s.behavior = behavior.clone();
        // Within the new limits; back to 1 when it zooms no more.
        let zoom = if behavior.zooms() {
            limit_zoom(behavior, s.zoom, false)
        } else {
            1.0
        };
        if !behavior.enabled && matches!(s.live.phase, Phase::Thumb { .. } | Phase::Wheel { .. }) {
            s.live.phase = Phase::Idle;
        }
        // A refresh in progress keeps the room of the indicator now showing.
        let held = (refresh
            && !s.horizontal
            && s.live.refreshing
            && main(s) < 0.0
            && !matches!(s.live.phase, Phase::Wheel { gesture: true, .. }))
        .then(|| behavior.refresh_inset().0);
        (inset, refresh, held, (zoom != s.zoom).then_some(zoom))
    };
    if let Some(zoom) = zoom {
        zoom_to(surface, view, zoom, None, false);
    }
    if inset {
        apply_offset(surface, view);
    }
    if inset || refresh {
        update_overlays(view);
    }
    if let Some(room) = held {
        let to = current(view).with(false, -room);
        animate_to(surface, view, to, ANIMATION, false, false);
    }
}

/// `Refreshing`: shows the spinner above the content (scrolling to it
/// when at the top) or hides it.
pub(crate) fn refreshing(surface: &Rc<Surface>, view: &NshView, refreshing: bool) {
    let (pos, held, inset) = {
        let mut state = view.state_mut();
        let Some(s) = state.scroll.as_mut() else {
            return;
        };
        if s.horizontal || s.live.refreshing == refreshing {
            return;
        }
        s.live.refreshing = refreshing;
        (
            main(s),
            matches!(s.live.phase, Phase::Wheel { gesture: true, .. }),
            s.behavior.refresh_inset().0,
        )
    };
    update_overlays(view);
    if held {
        return;
    }
    let at = |y: f32| current(view).with(false, y);
    if refreshing && pos <= 0.5 {
        animate_to(surface, view, at(-inset), ANIMATION, false, false);
    } else if !refreshing && pos < 0.0 {
        animate_to(surface, view, at(0.0), ANIMATION, false, false);
    }
}

/// `scrollTo`, `scrollToEnd` (the core resolves `scrollToIndex` and,
/// usually, `scrollToEnd` into `scrollTo`) and `zoomTo`.
pub(crate) fn command(surface: &Rc<Surface>, view: &NshView, command: &Command) {
    if let Command::ZoomTo {
        scale,
        center,
        animated,
    } = *command
    {
        // Not one of the core's counted scrolls (`ScrollBy`, `ScrollTo`),
        // as on the other platforms.
        let center = center.map(|c| Offset::new(c.x.0, c.y.0));
        return zoom_to(surface, view, scale, center, animated);
    }
    let (target, animated) = {
        let mut state = view.state_mut();
        let lims = limits(&state);
        let Some(s) = state.scroll.as_mut() else {
            return;
        };
        let inset = s.behavior.content_inset.map(|v| v.0);
        let p = pos(s);
        let (target, animated) = match *command {
            Command::ScrollTo { x, y, animated } => {
                let to = Offset::new(x.0 + inset.left, y.0 + inset.top);
                // Zoomed content goes to both; any other view along its axis.
                let to = if s.behavior.zooms() {
                    to
                } else {
                    p.with(s.horizontal, to.along(s.horizontal))
                };
                (to, animated)
            }
            Command::ScrollToEnd { animated } => {
                (p.with(s.horizontal, lims.1.along(s.horizontal)), animated)
            }
            Command::ScrollToIndex { .. } => {
                log::debug!("scroll: {command:?} is not supported");
                return;
            }
            _ => return,
        };
        s.applied = s.applied.wrapping_add(1);
        s.live.report = true;
        (clamp(target, lims), animated)
    };
    interrupt(surface, view);
    if animated {
        animate_to(surface, view, target, ANIMATION, false, true);
    } else {
        moved_to(surface, view, target);
    }
    report(surface, view);
}

// Zooming.

/// Zooms `view` to `scale` with content point `c` (unzoomed) at point `at`
/// of its viewport, as far as the content's edges let it.
fn zoom_at(surface: &Rc<Surface>, view: &NshView, scale: f32, c: Offset, at: Offset) {
    let to = {
        let mut state = view.state_mut();
        let Some(s) = state.scroll.as_mut() else {
            return;
        };
        s.zoom = scale;
        let inset = s.behavior.content_inset.map(|v| v.0);
        let room = centered(&state);
        let to = Offset::new(
            c.x * scale + room.x - at.x + inset.left,
            c.y * scale + room.y - at.y + inset.top,
        );
        clamp(to, limits(&state))
    };
    shown_at(surface, view, to);
}

/// `zoomTo`: `scale` (within the limits) with content point `center`
/// (unzoomed) in the middle of the viewport, or the point there now.
fn zoom_to(
    surface: &Rc<Surface>,
    view: &NshView,
    scale: f32,
    center: Option<Offset>,
    animated: bool,
) {
    let (from, to, at) = {
        let state = view.state();
        let Some(s) = &state.scroll else { return };
        // One that zooms no more goes back to 1 ([`behavior`]).
        if !s.behavior.zooms() && s.zoom == 1.0 {
            log::debug!("scroll: zoomTo on a scroll view that does not zoom");
            return;
        }
        let to = if s.behavior.zooms() {
            limit_zoom(&s.behavior, scale, false)
        } else {
            1.0
        };
        let size = state.frame.size;
        (
            s.zoom,
            to,
            Offset::new(size.width.0 / 2.0, size.height.0 / 2.0),
        )
    };
    interrupt(surface, view);
    let now_c = content_at(view, at);
    let c = center.unwrap_or(now_c);
    if animated && mapped(view) && (to - from).abs() > 1e-4 {
        zoom_eased(surface, view, from, to, now_c, c, at);
    } else {
        zoom_at(surface, view, to, c, at);
        sharpen(view);
        report(surface, view);
    }
}

/// Eases the zoom from `from` to `to`, the content point at `at` moving
/// from `from_c` to `to_c`.
fn zoom_eased(
    surface: &Rc<Surface>,
    view: &NshView,
    from: f32,
    to: f32,
    from_c: Offset,
    to_c: Offset,
    at: Offset,
) {
    set_phase(
        view,
        Phase::Zoom {
            from,
            to,
            from_c,
            to_c,
            at,
            start: now(),
            duration: ANIMATION,
        },
    );
    ensure_ticking(surface, view);
}

/// Whether a pinch at `view` zooms it: it zooms and is `zoomable`.
pub(crate) fn pinches(view: &NshView) -> bool {
    view.state()
        .scroll
        .as_ref()
        .is_some_and(|s| s.behavior.zooms() && s.behavior.pinch)
}

/// A pinch (a trackpad's, or Control + wheel steps) over `view`
/// ([`pinches`]) began: what moves stops.
pub(crate) fn pinch_begin(surface: &Rc<Surface>, view: &NshView) {
    interrupt(surface, view);
    if let Some(s) = view.state_mut().scroll.as_mut() {
        s.live.pinch_from = s.zoom;
    }
}

/// The pinch is at `scale` times the zoom it began at, around point `at` of
/// the viewport, which stays on the same content point. Past the limits
/// it rubber-bands when `rubber` (fingers) and `bouncesZoom`; otherwise it
/// stops there, and moves on from there (wheel steps back zoom out at
/// once).
pub(crate) fn pinch(
    surface: &Rc<Surface>,
    view: &NshView,
    scale: f32,
    at: (f32, f32),
    rubber: bool,
) {
    let at = Offset::new(at.0, at.1);
    let to = {
        let mut state = view.state_mut();
        let Some(s) = state.scroll.as_mut() else {
            return;
        };
        let raw = s.live.pinch_from * scale;
        let to = limit_zoom(&s.behavior, raw, rubber);
        if !rubber && to != raw {
            s.live.pinch_from = to / scale;
        }
        to
    };
    let c = content_at(view, at);
    zoom_at(surface, view, to, c, at);
}

/// The pinch around `at` ended: past the limits it springs back to them.
pub(crate) fn pinch_end(surface: &Rc<Surface>, view: &NshView, at: (f32, f32)) {
    let at = Offset::new(at.0, at.1);
    let (from, to) = {
        let state = view.state();
        let Some(s) = &state.scroll else { return };
        (s.zoom, limit_zoom(&s.behavior, s.zoom, false))
    };
    if (to - from).abs() > 1e-4 {
        let c = content_at(view, at);
        zoom_eased(surface, view, from, to, c, c, at);
    } else {
        sharpen(view);
    }
}

/// Draws the texts and canvases of `view`'s subtree again at the density
/// its zoom and the transforms above it need, once a zoom ends, as iOS
/// does, so that zoomed in they stay sharp rather than scale their
/// pictures (and back at the screen's once it is not zoomed in).
fn sharpen(view: &NshView) {
    view.sharpen();
}

// Pointer drags.

/// The mouse went down in `view`: a snap after a fling stops where it is,
/// as a finger catches one on iOS. Whether it caught one.
pub(crate) fn catch(surface: &Rc<Surface>, view: &NshView) -> bool {
    let moving = matches!(phase(view), Phase::Animate { momentum: true, .. });
    if moving {
        interrupt(surface, view);
        emit(surface, view, EventKind::ScrollEnd);
    }
    moving
}

/// Whether a release of `view` at its offset starts a refresh (pulled far
/// enough past the top and JS listens), marking it refreshing.
fn pulled_to_refresh(surface: &Surface, view: &NshView) -> bool {
    let refresh = {
        let state = view.state();
        let Some(s) = &state.scroll else { return false };
        !s.horizontal
            && !s.live.refreshing
            && state.events.contains(EventKind::Refresh)
            && s.behavior.refreshes(Points(main(s)))
    };
    if refresh {
        // Shown right away, as UIRefreshControl does; JS turns it off.
        if let Some(s) = view.state_mut().scroll.as_mut() {
            s.live.refreshing = true;
        }
        surface.event(view.id(), EventKind::Refresh, EventPayload::None);
    }
    refresh
}

/// Whether a mouse press at `(x, y)` (view coordinates) grabs `view`'s
/// indicator, faded out or not: on the desktop it is a scroll bar.
pub(crate) fn grabs_thumb(view: &NshView, x: f32, y: f32) -> bool {
    let state = view.state();
    let Some(s) = &state.scroll else {
        return false;
    };
    if !s.indicator || !s.behavior.enabled {
        return false;
    }
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    let Some((frame, _)) = thumb(s, w, h) else {
        return false;
    };
    // The edge the indicator runs along, moved in by its inset.
    let bar = s.behavior.scrollbar_inset.map(|v| v.0.max(0.0));
    let (along, across, start, len, edge) = if s.horizontal {
        (
            x,
            y,
            frame.origin.x as f32,
            frame.size.width as f32,
            h - bar.bottom,
        )
    } else {
        (
            y,
            x,
            frame.origin.y as f32,
            frame.size.height as f32,
            w - bar.right,
        )
    };
    (edge - THUMB_GRAB..=edge).contains(&across)
        && (start - THUMB_SLOP..=start + len + THUMB_SLOP).contains(&along)
}

/// Reveal the indicator on hover unless the user only wants it while scrolling.
pub(crate) fn hovered(surface: &Rc<Surface>, view: &NshView) {
    if NSUserDefaults::standardUserDefaults()
        .stringForKey(ns_string!("AppleShowScrollBars"))
        .is_some_and(|setting| setting.isEqualToString(ns_string!("WhenScrolling")))
    {
        return;
    }
    {
        let mut state = view.state_mut();
        let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
        let Some(s) = state.scroll.as_mut() else {
            return;
        };
        if !s.indicator || !s.behavior.enabled || thumb(s, w, h).is_none() {
            return;
        }
        s.live.shown = now();
        if s.live.alpha == 1.0 {
            return;
        }
        s.live.alpha = 1.0;
        s.live.dark = surface.environment.get().color_scheme == nsh_engine::ColorScheme::Dark;
    }
    update_overlays(view);
    ensure_ticking(surface, view);
}

/// The mouse grabbed `view`'s indicator ([`grabs_thumb`]).
pub(crate) fn thumb_begin(surface: &Rc<Surface>, view: &NshView) {
    interrupt(surface, view);
    {
        let mut state = view.state_mut();
        let Some(s) = state.scroll.as_mut() else {
            return;
        };
        s.live.phase = Phase::Thumb { start: main(s) };
        s.live.shown = now();
        s.live.alpha = 1.0;
        s.live.dark = surface.environment.get().color_scheme == nsh_engine::ColorScheme::Dark;
    }
    update_overlays(view);
    emit(surface, view, EventKind::ScrollDragStart);
}

/// The grabbed indicator was dragged by `(dx, dy)` points since it was
/// grabbed: the content moves the other way, so the thumb follows the
/// pointer (a content drag moves the content with it).
pub(crate) fn thumb_move(surface: &Rc<Surface>, view: &NshView, dx: f32, dy: f32) {
    let Phase::Thumb { start } = phase(view) else {
        return;
    };
    let pos = {
        let state = view.state();
        let Some(s) = &state.scroll else { return };
        let Some((_, travel)) = thumb(s, state.frame.size.width.0, state.frame.size.height.0)
        else {
            return;
        };
        let lims = limits(&state);
        let d = if !s.horizontal {
            dy
        } else if s.mirrored {
            -dx
        } else {
            dx
        };
        let max = lims.1.along(s.horizontal);
        let to = start + thumb_scroll(Points(d), Points(max), Points(travel)).0;
        clamp(pos(s).with(s.horizontal, to), lims)
    };
    moved_to(surface, view, pos);
}

/// The grabbed indicator was let go: it fades from now, snapping views
/// settle on a snap point.
pub(crate) fn thumb_end(surface: &Rc<Surface>, view: &NshView) {
    if !matches!(phase(view), Phase::Thumb { .. }) {
        return;
    }
    set_phase(view, Phase::Idle);
    if let Some(s) = view.state_mut().scroll.as_mut() {
        s.live.shown = now();
    }
    ensure_ticking(surface, view);
    emit(surface, view, EventKind::ScrollDragEnd);
    release(surface, view, 0.0, 0.0);
}

// Wheels and trackpads.

/// What wheel deltas `(dx, dy)` move `s` by (positive: the offset grows):
/// their main-axis share, both for zoomed content.
fn wheel_delta(s: &ScrollState, dx: f32, dy: f32) -> Offset {
    let d = if s.behavior.zooms() {
        return Offset::new(dx, dy);
    } else if !s.horizontal {
        dy
    } else if dx != 0.0 {
        if s.mirrored { -dx } else { dx }
    } else {
        // Vertical wheels scroll horizontal views too.
        dy
    };
    Offset::default().with(s.horizontal, d)
}

/// A trackpad scroll gesture over `view` began (also fingers resting on
/// it: that stops what moves).
pub(crate) fn wheel_begin(surface: &Rc<Surface>, view: &NshView) {
    if !enabled(view) {
        return;
    }
    interrupt(surface, view);
    let raw = current(view);
    set_phase(
        view,
        Phase::Wheel {
            last: now(),
            total: 0.0,
            gesture: true,
            raw,
            glide: Glide::default(),
        },
    );
    emit(surface, view, EventKind::ScrollDragStart);
}

/// A wheel or trackpad scroll by `(dx, dy)` points (positive: the content
/// moves up / left). Without [`wheel_begin`] it is a mouse wheel, which
/// settles by itself once it stops; a `notched` one on a `smoothWheel`
/// view glides there as Chromium's does ([`nsh_core::scroll::wheel_glide`]), others
/// land at once as AppKit's.
pub(crate) fn wheel(
    surface: &Rc<Surface>,
    view: &NshView,
    dx: f32,
    dy: f32,
    notched: bool,
    time: f64,
) {
    if !enabled(view) {
        return;
    }
    let (gesture, total, prev, glide) = match phase(view) {
        Phase::Wheel {
            gesture,
            total,
            raw,
            glide,
            ..
        } => (gesture, total, raw, Some(glide)),
        _ => {
            interrupt(surface, view);
            (false, 0.0, current(view), None)
        }
    };
    let at = now();
    let (pos, total, raw, smooth, intent) = {
        let state = view.state();
        let Some(s) = &state.scroll else { return };
        let (min, max) = limits(&state);
        let b = &s.behavior;
        let smooth = notched
            && !gesture
            && b.smooth_wheel
            && !b.zooms()
            && !b.snaps()
            && !b.paging
            && !surface.environment.get().reduce_motion;
        // A notch's lines are the view's own (`wheelLineHeight`), not
        // AppKit's 10 points.
        let k = if notched && b.wheel_line_height.0 > 0.0 {
            b.wheel_line_height.0 / crate::input::WHEEL_LINE
        } else {
            1.0
        };
        let d = wheel_delta(s, dx * k, dy * k);
        let total = total + d.along(s.horizontal);
        if gesture {
            // Trackpads stretch past the edges, as macOS does.
            let previous_raw = prev;
            let raw = previous_raw + d;
            let stretch = |raw: f32, min: f32, max: f32, horizontal: bool| {
                let dim = Points(viewport(&state, horizontal));
                dragged(
                    Points(raw),
                    Points(min),
                    Points(max.max(min)),
                    dim,
                    s.behavior.bounces,
                )
                .0
            };
            let to = Offset::new(
                stretch(raw.x, min.x, max.x, true),
                stretch(raw.y, min.y, max.y, false),
            );
            let along = s.horizontal;
            let crossed = previous_raw.along(along) <= max.along(along)
                && raw.along(along) > max.along(along);
            (to, total, raw, false, crossed.then(|| d.along(along)))
        } else {
            // A smooth wheel's steps add up from where the last one
            // pointed, not from where its glide has got to. Past an edge
            // (the refresh space) wheels only move back.
            let from = if smooth { prev } else { pos(s) };
            let to = stop_at_edges(from, d, (min, max));
            (to, total, to, smooth, Some(d.along(s.horizontal)))
        }
    };
    if let Some(delta) = intent {
        // A gesture stretching past the end can keep the same reported offset.
        scroll_intent(surface, view, "scroll", Some(delta));
    }
    // A smooth wheel glides there, in the frames ([`tick`]): on from the
    // glide in flight, or anew from where it is.
    let glide = match glide {
        _ if !smooth => Glide::default(),
        Some(g) if at < g.end() => g.retargeted(prev.into(), raw.into(), at),
        _ => Glide::new(current(view).into(), raw.into(), at),
    };
    set_phase(
        view,
        Phase::Wheel {
            last: at,
            total,
            gesture,
            raw,
            glide,
        },
    );
    if gesture {
        feed(surface, view, pos, time);
    } else if !smooth {
        moved_to(surface, view, pos);
    }
    ensure_ticking(surface, view);
}

/// The trackpad gesture ended with velocity `(vx, vy)` points per second:
/// springs back from past an edge, snaps, or waits for the system's
/// momentum.
pub(crate) fn wheel_end(surface: &Rc<Surface>, view: &NshView, vx: f32, vy: f32) {
    let Phase::Wheel { gesture, total, .. } = phase(view) else {
        return;
    };
    let (v, snaps) = {
        let state = view.state();
        let Some(s) = &state.scroll else { return };
        (
            wheel_delta(s, vx, vy).along(s.horizontal) / 1000.0,
            s.behavior.snaps() || s.behavior.paging,
        )
    };
    set_phase(view, Phase::Idle);
    if gesture {
        emit(surface, view, EventKind::ScrollDragEnd);
        pulled_to_refresh(surface, view);
    }
    // After the refresh check: refreshing lowers the top limit.
    let outside = {
        let state = view.state();
        let p = state.scroll.as_deref().map_or(Offset::default(), goal);
        p.distance(clamp(p, limits(&state))) > 0.5
    };
    if gesture && !outside && !snaps {
        // The system's momentum may follow ([`momentum_begin`]).
        set_phase(view, Phase::AwaitMomentum { since: now() });
        ensure_ticking(surface, view);
        return;
    }
    let snap = if v == 0.0 && total.abs() >= 1.0 {
        total.signum() * WHEEL_SNAP
    } else {
        0.0
    };
    release(surface, view, v, snap);
}

/// The system's momentum after a trackpad gesture began on `view`: whether
/// the view takes it (not when it springs back or snaps instead).
pub(crate) fn momentum_begin(surface: &Rc<Surface>, view: &NshView) -> bool {
    if !matches!(phase(view), Phase::AwaitMomentum { .. }) {
        return false;
    }
    set_phase(view, Phase::Momentum);
    emit(surface, view, EventKind::MomentumStart);
    true
}

/// The system's momentum moved `view` by `(dx, dy)` points (as
/// [`wheel`]); it stops at the edges.
pub(crate) fn momentum(surface: &Rc<Surface>, view: &NshView, dx: f32, dy: f32, time: f64) {
    if phase(view) != Phase::Momentum {
        return;
    }
    let pos = {
        let state = view.state();
        let Some(s) = &state.scroll else { return };
        stop_at_edges(goal(s), wheel_delta(s, dx, dy), limits(&state))
    };
    feed(surface, view, pos, time);
}

/// The system's momentum on `view` ended.
pub(crate) fn momentum_end(surface: &Rc<Surface>, view: &NshView) {
    if phase(view) != Phase::Momentum {
        return;
    }
    set_phase(view, Phase::Idle);
    emit(surface, view, EventKind::MomentumEnd);
    emit(surface, view, EventKind::ScrollEnd);
}

// The keyboard.

/// Points an arrow key scrolls, as browsers do.
const KEY_LINE: f32 = 40.0;
/// The share of the viewport a page key scrolls (the rest stays in view).
const KEY_PAGE: f32 = 0.875;
/// Duration of keyboard scrolls (ms); repeats retarget the running one.
const KEY_ANIMATION: f64 = 200.0;

/// Where a scroll key moves along an axis.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum KeyMove {
    /// By this many points (positive: towards the end).
    Points(f32),
    /// By this many viewports.
    Pages(f32),
    /// To the start.
    Start,
    /// To the end.
    End,
}

/// Virtual key codes of the keys that scroll.
mod keys {
    pub(crate) const SPACE: u16 = 49;
    pub(crate) const HOME: u16 = 115;
    pub(crate) const PAGE_UP: u16 = 116;
    pub(crate) const END: u16 = 119;
    pub(crate) const PAGE_DOWN: u16 = 121;
    pub(crate) const LEFT: u16 = 123;
    pub(crate) const RIGHT: u16 = 124;
    pub(crate) const DOWN: u16 = 125;
    pub(crate) const UP: u16 = 126;
}

/// What key `code` scrolls: whether along the horizontal axis, and how.
/// `shortcut` is Command, Control or Option held (shortcuts never scroll).
pub(crate) fn key_move(code: u16, shift: bool, shortcut: bool) -> Option<(bool, KeyMove)> {
    if shortcut {
        return None;
    }
    Some(match code {
        keys::UP => (false, KeyMove::Points(-KEY_LINE)),
        keys::DOWN => (false, KeyMove::Points(KEY_LINE)),
        keys::LEFT => (true, KeyMove::Points(-KEY_LINE)),
        keys::RIGHT => (true, KeyMove::Points(KEY_LINE)),
        keys::PAGE_UP => (false, KeyMove::Pages(-1.0)),
        keys::PAGE_DOWN => (false, KeyMove::Pages(1.0)),
        keys::SPACE if shift => (false, KeyMove::Pages(-1.0)),
        keys::SPACE => (false, KeyMove::Pages(1.0)),
        keys::HOME => (false, KeyMove::Start),
        keys::END => (false, KeyMove::End),
        _ => return None,
    })
}

/// The offset a key move from `base` aims at, within `[min, max]`.
fn key_target(m: KeyMove, base: f32, viewport: f32, min: f32, max: f32) -> f32 {
    let max = max.max(min);
    match m {
        KeyMove::Points(d) => base + d,
        KeyMove::Pages(n) => base + n * (viewport * KEY_PAGE).max(KEY_LINE),
        KeyMove::Start => min,
        KeyMove::End => max,
    }
    .clamp(min, max)
}

/// Scrolls the innermost scroll view from `from` outwards that the key
/// move `(horizontal, m)` can move, animated; whether one moved.
pub(crate) fn key_scroll(
    surface: &Rc<Surface>,
    from: &NshView,
    horizontal: bool,
    m: KeyMove,
) -> bool {
    let sign = match m {
        KeyMove::Points(d) => d.signum(),
        KeyMove::Pages(n) => n.signum(),
        KeyMove::Start => -1.0,
        KeyMove::End => 1.0,
    };
    let (dx, dy) = if horizontal { (sign, 0.0) } else { (0.0, sign) };
    let Some(view) = key_scroll_view(from, horizontal, dx, dy) else {
        return false;
    };
    let (base, viewport, min, max, axis) = {
        let state = view.state();
        let Some(s) = &state.scroll else {
            return false;
        };
        let (min, max) = limits(&state);
        // A repeat continues from where the running scroll goes.
        let base = match s.live.phase {
            Phase::Animate { to, .. } => to,
            _ => pos(s),
        };
        // Zoomed content moves along the key's axis.
        let axis = if s.behavior.zooms() {
            horizontal
        } else {
            s.horizontal
        };
        (base, viewport(&state, axis), min, max, axis)
    };
    let to = base.with(
        axis,
        key_target(
            m,
            base.along(axis),
            viewport,
            min.along(axis),
            max.along(axis),
        ),
    );
    let intent = match m {
        KeyMove::Start => "start",
        KeyMove::End => "end",
        _ => "scroll",
    };
    scroll_intent(surface, &view, intent, None);
    interrupt(surface, &view);
    animate_to(surface, &view, to, KEY_ANIMATION, false, true);
    // A list follows its real end from here on (rows never rendered are
    // only estimated), and the other keys leave it.
    let id = view.state().id;
    let m = match m {
        KeyMove::Points(d) => nsh_core::scroll::KeyMove::Points(Points(d)),
        KeyMove::Pages(n) => nsh_core::scroll::KeyMove::Pages(n),
        KeyMove::Start => nsh_core::scroll::KeyMove::Start,
        KeyMove::End => nsh_core::scroll::KeyMove::End,
    };
    surface.control(|c| c.key_scrolled(id, m));
    true
}

/// The innermost scroll view from `view` outwards that a key moving by
/// `(dx, dy)` can move; for vertical keys one along that axis first, then
/// a horizontal one (as vertical wheels move those).
fn key_scroll_view(view: &NshView, horizontal: bool, dx: f32, dy: f32) -> Option<NshView> {
    nsh_core::input::key_scroll_target(
        std::iter::successors(Some(view.clone()), NshView::parent_view),
        horizontal,
        |v| v.state().scroll.as_ref().map(|s| s.horizontal),
        |v| v.kind() == ViewKind::Scroll && can_scroll(v, dx, dy),
        listens_to_scroll_intent,
    )
}

pub(crate) fn listens_to_scroll_intent(view: &NshView) -> bool {
    let state = view.state();
    state.events.contains(EventKind::ScrollIntent)
        && state.scroll.as_ref().is_some_and(|s| s.behavior.enabled)
}

fn scroll_intent(surface: &Surface, view: &NshView, intent: &'static str, delta: Option<f32>) {
    if listens_to_scroll_intent(view) {
        let mut payload = vec![("intent", PayloadValue::Str(intent.into()))];
        if let Some(delta) = delta {
            payload.push(("delta", PayloadValue::Number(delta.into())));
        }
        surface.event(
            view.state().id,
            EventKind::ScrollIntent,
            EventPayload::Map(payload),
        );
    }
}

/// Scrolls the scroll views around `target` (animated) so that it shows,
/// as iOS and Android do for the focused field. Called when a field gets
/// the keyboard focus, and when another stop gets it other than by a click
/// (Tab, `focus()`).
pub(crate) fn reveal(surface: &Rc<Surface>, target: &NshView) {
    // The rectangles are AppKit's, which the bounds place.
    commit_ancestors(target);
    // Content moved by the scroll views inside, which rectangles measured
    // now do not show yet.
    let (mut moved_x, mut moved_y) = (0.0, 0.0);
    let mut current = target.parent_view();
    while let Some(view) = current {
        current = view.parent_view();
        if view.kind() != ViewKind::Scroll || !mapped(&view) {
            continue;
        }
        // In the scroll view's coordinates: zoomed, as AppKit converts.
        let bounds = target
            .ns()
            .convertRect_toView(target.ns().bounds(), Some(view.ns()));
        let (base, p, lims, dims) = {
            let state = view.state();
            let Some(s) = &state.scroll else { continue };
            let base = match s.live.phase {
                Phase::Animate { to, .. } => to,
                _ => pos(s),
            };
            let dims = Offset::new(viewport(&state, true), viewport(&state, false));
            (base, pos(s), limits(&state), dims)
        };
        // Along both axes: the limits keep a view where it does not move.
        let reveal = |start: f64, len: f64, moved: f32, horizontal: bool| {
            // Pending animations count from where they are headed.
            let start = start as f32 - moved - (base.along(horizontal) - p.along(horizontal));
            let end = Points(start + len as f32);
            let dim = Points(dims.along(horizontal));
            base.along(horizontal) + reveal_focus_delta(Points(start), end, dim).0
        };
        let (o, size) = (bounds.origin, bounds.size);
        let to = clamp(
            Offset::new(
                reveal(o.x, size.width, moved_x, true),
                reveal(o.y, size.height, moved_y, false),
            ),
            lims,
        );
        if base.distance(to) < 0.5 {
            continue;
        }
        moved_x += to.x - base.x;
        moved_y += to.y - base.y;
        interrupt(surface, &view);
        animate_to(surface, &view, to, ANIMATION, false, true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scroll view of `content` points in a 300 x 200 viewport.
    fn movable_with(content: (f32, f32), horizontal: bool, enabled: bool) -> bool {
        let s = ScrollState {
            content,
            horizontal,
            behavior: nsh_core::ScrollBehavior {
                enabled,
                ..Default::default()
            },
            ..Default::default()
        };
        movable_in(&s, (300.0, 200.0))
    }

    /// A scroll view switched off (`scrollable={false}`) cannot move, however
    /// long its content: an embedded app passes its scrolls on.
    #[test]
    fn a_disabled_scroll_view_does_not_move() {
        assert!(!movable_with((300.0, 800.0), false, false));
        assert!(!movable_with((900.0, 200.0), true, false));
    }

    /// A scroll view whose content fits its viewport along its axis cannot
    /// move, even when the content overflows across it.
    #[test]
    fn a_scroll_view_whose_content_fits_does_not_move() {
        assert!(!movable_with((300.0, 200.0), false, true));
        assert!(!movable_with((300.0, 120.0), false, true));
        assert!(!movable_with((900.0, 200.0), false, true));
        assert!(!movable_with((300.0, 800.0), true, true));
    }

    /// An enabled scroll view whose content overflows along its axis moves:
    /// an embedded app keeps its scrolls.
    #[test]
    fn an_overflowing_scroll_view_moves() {
        assert!(movable_with((300.0, 800.0), false, true));
        assert!(movable_with((900.0, 200.0), true, true));
    }

    /// A scroll view's [`Bounce`] classification for `content` points in a
    /// 300 x 200 viewport along `horizontal`.
    /// [`bounce_index`] over already classified views.
    fn bounce_in(kinds: &[Option<Bounce>], horizontal: bool) -> Option<usize> {
        bounce_index(kinds.len(), |i| kinds[i], horizontal)
    }

    fn bounce_kind_with(
        content: (f32, f32),
        view_horizontal: bool,
        horizontal: bool,
        refreshes: bool,
        bounces: bool,
    ) -> Bounce {
        let s = ScrollState {
            content,
            horizontal: view_horizontal,
            behavior: nsh_core::ScrollBehavior {
                enabled: true,
                bounces,
                ..Default::default()
            },
            ..Default::default()
        };
        bounce_kind(&s, (300.0, 200.0), horizontal, refreshes)
    }

    /// A standalone short vertical scroll view still stretches (AppKit's
    /// `.automatic` vertical elasticity), while a horizontal scroll view whose
    /// content fits does not.
    #[test]
    fn standalone_bounce_matches_appkit_axes() {
        let short_v = bounce_kind_with((300.0, 120.0), false, false, false, true);
        let short_h = bounce_kind_with((300.0, 200.0), true, true, false, true);
        assert_eq!(bounce_in(&[Some(short_v)], false), Some(0));
        assert_eq!(bounce_in(&[Some(short_h)], true), None);
    }

    /// An inner vertical scroll view whose content fits (an editor as tall as
    /// its document inside a list) hands the stretch to the outer list,
    /// whether the outer list overflows or also fits; if the outer list
    /// disables bounce, neither stretches.
    #[test]
    fn nested_fitting_vertical_scroll_view_hands_bounce_to_outer() {
        let fit = bounce_kind_with((300.0, 120.0), false, false, false, true);
        let overflow = bounce_kind_with((300.0, 800.0), false, false, false, true);
        let no_bounce = bounce_kind_with((300.0, 800.0), false, false, false, false);
        assert_eq!(bounce_in(&[Some(fit), Some(overflow)], false), Some(1));
        assert_eq!(bounce_in(&[Some(fit), Some(fit)], false), Some(1));
        assert_eq!(bounce_in(&[Some(fit), Some(no_bounce)], false), None);
        // When the inner view itself overflows, it keeps its edge stretch.
        assert_eq!(bounce_in(&[Some(overflow), Some(overflow)], false), Some(0));
    }

    #[test]
    fn an_overflowing_scroll_view_bounces_along_its_axis() {
        let tall_v = bounce_kind_with((300.0, 800.0), false, false, false, true);
        let wide_h = bounce_kind_with((900.0, 200.0), true, true, false, true);
        let wrong_axis = bounce_kind_with((300.0, 800.0), false, true, false, true);
        assert_eq!(bounce_in(&[Some(tall_v)], false), Some(0));
        assert_eq!(bounce_in(&[Some(wide_h)], true), Some(0));
        assert_eq!(bounce_in(&[Some(wrong_axis)], true), None);
    }

    /// Pulling to refresh needs the stretch, however short the content, even
    /// when nested inside another vertical scroll view.
    #[test]
    fn a_scroll_view_that_refreshes_bounces_when_its_content_fits() {
        let refreshes = bounce_kind_with((300.0, 120.0), false, false, true, true);
        let outer_fit = bounce_kind_with((300.0, 120.0), false, false, false, true);
        assert_eq!(bounce_in(&[Some(refreshes)], false), Some(0));
        assert_eq!(
            bounce_in(&[Some(refreshes), Some(outer_fit)], false),
            Some(0)
        );
    }

    #[test]
    fn a_long_scroll_commits_only_when_it_ends() {
        let mut rested = None;
        // Ten seconds of input or glide: never mid-scroll.
        for t in (0..10_000).step_by(16) {
            let t = t as f64;
            assert!(!commit_due(t, t + 140.0, false, true, &mut rested));
        }
        // The offset still moved recently: not yet.
        assert!(!commit_due(10_000.0, 10_100.0, true, false, &mut rested));
        // At rest, with the display link resting too.
        assert!(commit_due(10_200.0, 10_100.0, true, false, &mut rested));
    }

    #[test]
    fn a_running_animation_holds_a_commit_only_briefly() {
        let mut rested = None;
        assert!(!commit_due(1000.0, 900.0, true, true, &mut rested));
        assert!(!commit_due(
            1000.0 + REST_WAIT - 32.0,
            900.0,
            true,
            true,
            &mut rested
        ));
        assert!(commit_due(
            1000.0 + REST_WAIT,
            900.0,
            true,
            true,
            &mut rested
        ));
        // Input again starts the wait over.
        let mut rested = Some(0.0);
        assert!(!commit_due(5000.0, 4900.0, false, true, &mut rested));
        assert_eq!(rested, None);
    }

    /// A keyboard scroll keeps the view busy while it moves; then only its
    /// indicator's fade is left, which `nsh test`'s agent does not wait for
    /// (`Surface::animating`); the spinner and resampled offsets stay busy.
    #[test]
    fn only_the_indicators_fade_is_cosmetic() {
        let gliding = Phase::Animate {
            from: Offset::new(0.0, 0.0),
            to: Offset::new(0.0, 40.0),
            start: 0.0,
            duration: KEY_ANIMATION,
            momentum: false,
            end: true,
        };
        let fading = Indicator::Fading;
        assert_eq!(what_is_left(&gliding, false, fading, false), Tick::Busy);
        assert_eq!(
            what_is_left(&Phase::Idle, false, fading, false),
            Tick::Fading
        );
        assert_eq!(
            what_is_left(&Phase::Idle, false, Indicator::Gone, false),
            Tick::Done
        );
        assert_eq!(what_is_left(&Phase::Idle, true, fading, false), Tick::Busy);
        assert_eq!(what_is_left(&Phase::Idle, false, fading, true), Tick::Busy);
        assert_eq!(
            what_is_left(&Phase::AwaitMomentum { since: 0.0 }, false, fading, false),
            Tick::Busy
        );
        assert_eq!(
            what_is_left(&Phase::Momentum, false, fading, false),
            Tick::Fading
        );
        assert_eq!(
            what_is_left(&Phase::Idle, false, Indicator::Holding(300), false),
            Tick::Hold(300)
        );
    }

    #[test]
    fn resampling_moves_evenly_between_events() {
        let mut r = Resampled {
            points: Default::default(),
            interval: 8.0,
        };
        let at = |y: f32| Offset::new(0.0, y);
        r.points.push_back((0.0, at(0.0)));
        // Events every 8 ms, 10 points each; frames sample at other times.
        for i in 1..=4 {
            r.push(i as f64 * 8.0, at(i as f32 * 10.0));
        }
        assert!((r.interval - 8.0).abs() < 1e-9);
        assert_eq!(r.goal(), Some(at(40.0)));
        assert_eq!(r.sample(4.0), (at(5.0), false));
        assert_eq!(r.sample(12.0), (at(15.0), false));
        assert_eq!(r.sample(20.0), (at(25.0), false));
        // Past the newest event: it holds there.
        assert_eq!(r.sample(50.0), (at(40.0), true));
        // An event at the same instant replaces the newest.
        r.push(32.0, at(42.0));
        assert_eq!(r.goal(), Some(at(42.0)));
    }

    #[test]
    fn zooms_stay_within_their_limits_unless_fingers_stretch_them() {
        let b = ScrollBehavior {
            min_zoom: 0.25,
            max_zoom: 1.5,
            ..ScrollBehavior::default()
        };
        assert_eq!(limit_zoom(&b, 1.2, true), 1.2);
        assert_eq!(limit_zoom(&b, 3.0, false), 1.5);
        assert_eq!(limit_zoom(&b, 0.1, false), 0.25);
        // A pinch past the limits rubber-bands, less and less.
        let over = limit_zoom(&b, 3.0, true);
        assert!(over > 1.5 && over < 2.0, "{over}");
        assert!(limit_zoom(&b, 0.1, true) < 0.25);
        let firm = ScrollBehavior {
            bounces_zoom: false,
            ..b
        };
        assert_eq!(limit_zoom(&firm, 3.0, true), 1.5);
    }

    #[test]
    fn wheels_move_zoomed_content_both_ways_and_other_views_along_their_axis() {
        let mut s = ScrollState::default();
        assert_eq!(wheel_delta(&s, 3.0, 5.0), Offset::new(0.0, 5.0));
        s.horizontal = true;
        assert_eq!(wheel_delta(&s, 3.0, 5.0), Offset::new(3.0, 0.0));
        assert_eq!(wheel_delta(&s, 0.0, 5.0), Offset::new(5.0, 0.0));
        s.behavior.max_zoom = 2.0;
        assert_eq!(wheel_delta(&s, 3.0, 5.0), Offset::new(3.0, 5.0));
        // At the edges they stop, past them (the refresh space) they only
        // move back.
        let lims = (Offset::new(0.0, 0.0), Offset::new(100.0, 50.0));
        assert_eq!(
            stop_at_edges(Offset::new(95.0, 10.0), Offset::new(10.0, -20.0), lims),
            Offset::new(100.0, 0.0)
        );
        assert_eq!(
            stop_at_edges(Offset::new(0.0, -30.0), Offset::new(0.0, -5.0), lims),
            Offset::new(0.0, -30.0)
        );
    }

    #[test]
    fn scroll_keys() {
        assert_eq!(
            key_move(keys::DOWN, false, false),
            Some((false, KeyMove::Points(KEY_LINE)))
        );
        assert_eq!(
            key_move(keys::SPACE, true, false),
            Some((false, KeyMove::Pages(-1.0)))
        );
        assert_eq!(key_move(keys::LEFT, false, true), None);
        assert_eq!(key_move(0, false, false), None);
        assert_eq!(
            key_target(KeyMove::Pages(1.0), 0.0, 400.0, 0.0, 1000.0),
            350.0
        );
        assert_eq!(key_target(KeyMove::End, 0.0, 400.0, 0.0, 1000.0), 1000.0);
    }
}
