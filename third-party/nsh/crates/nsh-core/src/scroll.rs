//! Scroll views without a toolkit: offsets, wheel / touchpad / touch /
//! keyboard scrolling with momentum, snapping, paging, rubber banding,
//! sticky cells, the indicator as a scroll bar, the refresh spinner's
//! state, the core's scroll requests and scroll events.
//!
//! A scroll view only moves along its main axis (zooming is not
//! supported: `zoomTo` and the zoom props are ignored). Its offset lives in
//! [`ScrollState`] (`x` / `y`, 0 showing the start of the content inset),
//! which the backends keep in their views. Every change goes through one
//! place, which shows the indicator, tells the backend
//! ([`ScrollHost::moved`]: it places the children, pins the sticky cells
//! and feeds the native scroll value in the same frame) and queues a
//! report to the engine. Reports are coalesced to one per frame by the
//! view's frame callback ([`ScrollHost::start_ticking`], which calls
//! [`frame`]), which also runs glides, animated scrolls, the indicator's
//! fade and the refresh spinner, and stops when none of them is left.
//!
//! Offsets are reported as UIKit's `contentOffset` (minus the leading
//! content inset, clamped to the content), so lists see the same numbers
//! as on iOS. Glides decelerate as UIKit does (velocity kept per
//! millisecond: `behavior.deceleration`, 0.998 by default, 0.99 when
//! snapping); snapping and paging use [`ScrollBehavior::snap_target`].
//! Touch drags rubber-band past the edges when `bounces`; wheels and
//! touchpads stop at the edges, as desktop scrolling does.
//!
//! Mirrored (right to left) horizontal lists keep their offsets left to
//! right: the backends place each child at the mirror image of its frame,
//! and drags, wheels and the indicator are mirrored here.
//!
//! The backends keep what their toolkits do: drawing the indicator and
//! the spinner, the sticky cells' views, picking which view a key or a
//! focused field scrolls, and the frame clock.

use std::f32::consts::PI;

use crate::{
    Bounds, Command, EventKind, EventPayload, NodeId, Point, Points, ScrollBehavior, Size,
    StickyCell,
    geometry::{Percentage, Radians, point},
};

/// Below this release speed (points per ms) a drag does not glide.
const MIN_GLIDE: f32 = 0.05;
/// A glide stops below this speed (points per ms).
const STOP: f32 = 0.01;
/// A wheel without a gesture (a mouse) has settled after this many ms.
const WHEEL_IDLE: f64 = 150.0;
/// The indicator stays this long (ms) after the last scroll...
const INDICATOR_HOLD: f64 = 700.0;
/// ...then fades out in this long.
const INDICATOR_FADE: f64 = 300.0;
/// Duration of animated scrolls and bounces back (ms).
const ANIMATION: f64 = 300.0;
/// The release speed (points per ms) a settled mouse wheel snaps with:
/// fast enough to move on to the next snap point.
const WHEEL_SNAP: f32 = 0.6;
/// Space between the indicator and the ends of the viewport.
const INDICATOR_MARGIN: f32 = 2.0;
/// The indicator's thickness.
pub const INDICATOR_THICK: Points = Points(3.0);
/// How close to its edge (points) a mouse press grabs the indicator,
/// which is much thinner than a pointer is precise...
const THUMB_GRAB: f32 = 12.0;
/// ...and how far past its ends.
const THUMB_SLOP: f32 = 4.0;

/// What a scroll view is doing.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
enum Phase {
    /// At rest.
    #[default]
    Idle,
    /// A touch-style drag: `start` is the main-axis offset it began at,
    /// `moved` how far the pointer went since (content follows it).
    Drag { start: f32, moved: f32 },
    /// The mouse drags the indicator as a scroll bar's thumb, from offset
    /// `start`.
    Thumb { start: f32 },
    /// Wheel or touchpad input: the last at `last` (ms), `total` points
    /// so far; `gesture` for touchpads (begin / end), not mouse wheels.
    Wheel {
        last: f64,
        total: f32,
        gesture: bool,
    },
    /// Momentum after a fling: `velocity` points per ms at `last` (ms).
    Glide { velocity: f32, last: f64 },
    /// An eased move from `from` to `to`, started at `start` (ms):
    /// `momentum` for snapping after a fling (momentum events), `end` to
    /// send `onScrollEnd` when it arrives.
    Animate {
        from: f32,
        to: f32,
        start: f64,
        duration: f64,
        momentum: bool,
        end: bool,
    },
}

/// The running state of a scroll view: input phase, the indicator and
/// the refresh spinner.
#[derive(Debug, Default, Clone)]
#[non_exhaustive]
pub struct Live {
    phase: Phase,
    /// The view's frame callback runs.
    ticking: bool,
    /// The offset changed since it was last reported.
    report: bool,
    /// When the indicator was last shown (ms).
    shown: f64,
    /// The indicator's opacity.
    pub alpha: f32,
    /// The refresh spinner shows.
    pub refreshing: bool,
    /// The spinner's angle.
    pub spin: Radians,
    /// [`ScrollHost::dark`] when the indicator was last shown, for
    /// backends that pick its colors then.
    pub dark: bool,
}

/// Scroll position and extent of a scroll view.
#[derive(Debug, Default, Clone)]
#[non_exhaustive]
pub struct ScrollState {
    /// Current offset (points; content coordinates of the viewport's top
    /// left).
    pub x: Points,
    /// Vertical offset.
    pub y: Points,
    /// Size of the scrollable content.
    pub content: Size<Points>,
    /// Scrolls horizontally.
    pub horizontal: bool,
    /// Shows the scroll indicator.
    pub indicator: bool,
    /// How it scrolls (paging, snapping, insets...).
    pub behavior: ScrollBehavior,
    /// Scrolls the core asked for (`ScrollBy`, `scrollTo`) that were
    /// applied: reported with each offset.
    pub applied: u32,
    /// The sticky cells: (cell, start, end).
    pub sticky: Vec<StickyCell>,
    /// A horizontal list laid out right to left: children are placed
    /// mirrored (offsets stay left to right).
    pub mirrored: bool,
    /// Gestures, glides and the indicator.
    pub live: Live,
}

/// A scroll view in a backend's view tree: what the logic here reads and
/// does through it. Backends implement it over a view and its surface.
pub trait ScrollHost {
    /// Runs `f` with the view's scroll state and its size, or `None` when
    /// it is no scroll view.
    fn scroll<R>(&self, f: impl FnOnce(&ScrollState, Size<Points>) -> R) -> Option<R>;
    /// Runs `f` with the view's scroll state, mutable, and its size.
    fn scroll_mut<R>(&self, f: impl FnOnce(&mut ScrollState, Size<Points>) -> R) -> Option<R>;
    /// The clock phases keep, in ms.
    fn now(&self) -> f64;
    /// Whether JS listens to `kind` on the view.
    fn listens(&self, kind: EventKind) -> bool;
    /// Sends `kind` on the view to the engine.
    fn event(&self, kind: EventKind, payload: EventPayload);
    /// Reports the view's offset (UIKit's `contentOffset`) to the engine
    /// with the count of the core's scrolls applied.
    fn report(&self, offset: Point<Points>, applied: u32);
    /// The offset changed (`offset` is the one reported): the children
    /// move, the sticky cells pin to it, native scroll values follow.
    fn moved(&self, offset: Point<Points>);
    /// A vertical view is pulled `distance` past its top (0 once it is
    /// back): its native pull value follows.
    fn pulled(&self, distance: Points);
    /// The children's placement changed (mirroring, insets).
    fn relayout(&self);
    /// The view draws again (the indicator, the spinner, the content).
    fn redraw(&self);
    /// Whether the view is in a window, where frames come.
    fn attached(&self) -> bool;
    /// Runs [`frame`] on every frame from now until it returns false.
    fn start_ticking(&self);
    /// The scroll view came to rest (its drag and momentum ended, as it
    /// sends `onScrollEnd`): the snapping animated values that follow it
    /// settle ([`crate::animation::Animator::scroll_ended`]).
    fn settled(&self) {}
    /// Whether the surface is dark, kept in [`Live::dark`] when the
    /// indicator shows.
    fn dark(&self) -> bool {
        false
    }
}

// Pure logic. Lengths are points; velocities are points per ms, times ms.

/// The rubber band of iOS: how far content dragged `over` points past an
/// edge of a `dim`-point viewport moves.
fn rubber(over: f32, dim: f32) -> f32 {
    let dim = dim.max(1.0);
    (1.0 - 1.0 / (over * 0.55 / dim + 1.0)) * dim
}

/// Position on a drag that went to `raw`, with `[min, max]` the limits, in
/// a `dim`-point viewport: past them it rubber-bands when `bounces`.
pub fn dragged(raw: Points, min: Points, max: Points, dim: Points, bounces: bool) -> Points {
    Points(drag_position(raw.0, min.0, max.0, dim.0, bounces))
}

fn drag_position(raw: f32, min: f32, max: f32, dim: f32, bounces: bool) -> f32 {
    if raw < min {
        if bounces {
            min - rubber(min - raw, dim)
        } else {
            min
        }
    } else if raw > max {
        if bounces {
            max + rubber(raw - max, dim)
        } else {
            max
        }
    } else {
        raw
    }
}

/// The deceleration rate: velocity kept per ms.
pub fn rate(behavior: &ScrollBehavior) -> f32 {
    if behavior.deceleration > 0.0 && behavior.deceleration < 1.0 {
        behavior.deceleration
    } else if behavior.snaps() || behavior.paging {
        0.99
    } else {
        0.998
    }
}

/// One step of a glide: `(distance, new velocity)` after `dt` ms at
/// velocity `v` (points per ms), decaying exponentially by `rate` per ms.
fn glide_step(v: f32, rate: f32, dt: f32) -> (f32, f32) {
    let k = rate.powf(dt);
    (v * (k - 1.0) / rate.ln(), v * k)
}

/// Where a glide at `velocity` (points per ms) from `offset` comes to
/// rest, decelerating by `rate` ([`rate`]).
pub fn projected(offset: Points, velocity: f32, rate: f32) -> Points {
    Points(offset.0 - velocity / rate.ln())
}

/// How far a sticky cell from `start` to `end` (where the next one pushes
/// it out) moves at `offset`.
pub fn sticky_shift(offset: Points, start: Points, end: Points) -> Points {
    Points((offset.0 - start.0).clamp(0.0, (end.0 - start.0).max(0.0)))
}

/// Cubic ease out of `t` (0 to 1).
pub fn ease_out(t: f64) -> f32 {
    let t = t.clamp(0.0, 1.0);
    (1.0 - (1.0 - t).powi(3)) as f32
}

/// How long (ms) an eased move of `distance` that starts at `velocity`
/// (points per ms, in its direction) takes: ease out starts at 3 ×
/// distance / duration, which then matches the release.
pub fn snap_duration(distance: Points, velocity: f32) -> f64 {
    let (distance, v) = (distance.0, velocity);
    if distance.abs() < 0.5 {
        return 0.0;
    }
    if v * distance > 0.0 {
        (3.0 * distance.abs() / v.abs()).clamp(180.0, 600.0) as f64
    } else {
        ANIMATION
    }
}

/// The indicator's opacity `since` ms after it was shown.
pub fn indicator_alpha(since: f64) -> f32 {
    if since < INDICATOR_HOLD {
        1.0
    } else {
        (1.0 - (since - INDICATOR_HOLD) / INDICATOR_FADE).max(0.0) as f32
    }
}

/// The indicator along the main axis: `(start, length)` in a viewport of
/// `viewport` points showing `total` points at `offset`, or `None` when
/// everything fits.
pub fn indicator_span(viewport: Points, total: Points, offset: Points) -> Option<(Points, Points)> {
    span(viewport.0, total.0, offset.0).map(|(start, len)| (Points(start), Points(len)))
}

fn span(viewport: f32, total: f32, offset: f32) -> Option<(f32, f32)> {
    /// Short enough to see where it is in long lists, long enough to see.
    const MIN_LENGTH: f32 = 32.0;
    if total <= viewport + 0.5 || viewport <= 4.0 * INDICATOR_MARGIN {
        return None;
    }
    let track = viewport - 2.0 * INDICATOR_MARGIN;
    let max = total - viewport;
    // Overscrolling shrinks it, as on iOS.
    let over = if offset < 0.0 {
        -offset
    } else {
        (offset - max).max(0.0)
    };
    let len = (track * viewport / total - over).max(MIN_LENGTH).min(track);
    let t = (offset / max).clamp(0.0, 1.0);
    Some((INDICATOR_MARGIN + (track - len) * t, len))
}

/// How far the offset moves when the thumb moves by `d`: the thumb's
/// `travel` (`track - length`) spans the whole scroll `range`.
pub fn thumb_scroll(d: Points, range: Points, travel: Points) -> Points {
    if travel.0 > 0.0 {
        Points(d.0 * range.0 / travel.0)
    } else {
        Points(0.0)
    }
}

/// A gesture or animation in flight when the core moves the content by
/// `d` (`ScrollBy`) moves along, so that it continues from the content it
/// was on.
fn shifted(phase: Phase, d: f32) -> Phase {
    match phase {
        Phase::Drag { start, moved } => Phase::Drag {
            start: start + d,
            moved,
        },
        Phase::Thumb { start } => Phase::Thumb { start: start + d },
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
    }
}

/// The spokes of the refresh spinner, as an activity indicator of eight
/// spokes draws them: `progress` of them show while pulling, and they turn
/// in whole spokes by `spin`. Each is its rotation and its opacity; a
/// spoke is drawn pointing up from the spinner's center.
pub fn spokes(progress: Percentage, spin: Radians) -> impl Iterator<Item = (Radians, f32)> {
    const SPOKES: usize = 8;
    let (progress, spin) = (progress.0, spin.0);
    let shown = ((progress * SPOKES as f32).ceil() as usize).min(SPOKES);
    let step = 2.0 * PI / SPOKES as f32;
    let lead = (spin / step) as usize % SPOKES;
    (0..shown).map(move |i| {
        let fade = if progress < 1.0 {
            0.8
        } else {
            1.0 - ((lead + SPOKES - i) % SPOKES) as f32 / SPOKES as f32 * 0.85
        };
        (Radians(i as f32 * step), fade)
    })
}

// The state.

impl ScrollState {
    /// The largest offsets in a view of `size`.
    pub fn max(&self, size: Size<Points>) -> Point<Points> {
        let (x, y) = self.max_f(size);
        point(Points(x), Points(y))
    }

    fn max_f(&self, size: Size<Points>) -> (f32, f32) {
        let inset = self.behavior.content_inset;
        (
            (self.content.width.0 + inset.left.0 + inset.right.0 - size.width.0).max(0.0),
            (self.content.height.0 + inset.top.0 + inset.bottom.0 - size.height.0).max(0.0),
        )
    }

    /// The offset children are drawn at: the scroll offset less the
    /// content inset.
    pub fn origin(&self) -> Point<Points> {
        let inset = self.behavior.content_inset;
        point(self.x - inset.left, self.y - inset.top)
    }

    /// The offset along the main axis.
    fn offset(&self) -> f32 {
        if self.horizontal { self.x.0 } else { self.y.0 }
    }

    /// Where the offset is headed: the end of a running animated scroll,
    /// else the offset (a key repeat or a reveal continues from there).
    fn goal(&self) -> f32 {
        match self.live.phase {
            Phase::Animate { to, .. } => to,
            _ => self.offset(),
        }
    }

    /// The viewport's length along the main axis, in a view of `size`.
    fn viewport(&self, size: Size<Points>) -> f32 {
        if self.horizontal {
            size.width.0
        } else {
            size.height.0
        }
    }

    /// The leading content inset along the main axis.
    fn lead(&self) -> f32 {
        if self.horizontal {
            self.behavior.content_inset.left.0
        } else {
            self.behavior.content_inset.top.0
        }
    }

    /// The rest limits along the main axis (the top is lower while the
    /// refresh spinner shows).
    fn limits(&self, size: Size<Points>) -> (f32, f32) {
        let max = self.max_f(size);
        let min = if !self.horizontal && self.live.refreshing {
            -self.behavior.refresh_inset().0
        } else {
            0.0
        };
        (min, if self.horizontal { max.0 } else { max.1 })
    }

    /// The offset reported to the engine and in events: UIKit's
    /// `contentOffset`, within the content.
    pub fn reported(&self, size: Size<Points>) -> Point<Points> {
        let (mx, my) = self.max_f(size);
        let inset = self.behavior.content_inset;
        point(
            Points(self.x.0.clamp(0.0, mx) - inset.left.0),
            Points(self.y.0.clamp(0.0, my) - inset.top.0),
        )
    }

    /// Whether the user can scroll the view of `size` by `delta` (wheel
    /// deltas: positive moves the content up / left): it is enabled,
    /// scrolls along that axis and is not at that edge yet. Input uses it
    /// to pick which of nested scroll views a wheel moves.
    pub fn can_scroll(&self, size: Size<Points>, delta: Point<Points>) -> bool {
        let (dx, dy) = (delta.x.0, delta.y.0);
        if !self.behavior.enabled {
            return false;
        }
        let (min, max) = self.limits(size);
        if max <= min {
            return false;
        }
        let d = if self.horizontal {
            let d = if dx != 0.0 { dx } else { dy };
            if self.mirrored && dx != 0.0 { -d } else { d }
        } else {
            dy
        };
        let pos = self.offset();
        (d > 0.0 && pos < max - 0.5) || (d < 0.0 && pos > min + 0.5)
    }

    /// The indicator's rectangle in a view of `size` and how far it can
    /// travel along its track, or `None` when the content fits.
    pub fn thumb(&self, size: Size<Points>) -> Option<(Bounds<Points>, Points)> {
        let (rect, travel) = self.thumb_f(size)?;
        Some((rect, Points(travel)))
    }

    fn thumb_f(&self, size: Size<Points>) -> Option<(Bounds<Points>, f32)> {
        const EDGE: f32 = 2.0;
        let thick = INDICATOR_THICK.0;
        let (w, h) = (size.width.0, size.height.0);
        let inset = self.behavior.content_inset;
        let (dim, total, offset) = if self.horizontal {
            (
                w,
                self.content.width.0 + inset.left.0 + inset.right.0,
                self.x.0,
            )
        } else {
            (
                h,
                self.content.height.0 + inset.top.0 + inset.bottom.0,
                self.y.0,
            )
        };
        let (start, len) = span(dim, total, offset)?;
        let (x, y, rw, rh) = if self.horizontal {
            let x = if self.mirrored {
                w - start - len
            } else {
                start
            };
            (x, h - thick - EDGE, len, thick)
        } else {
            (w - thick - EDGE, start, thick, len)
        };
        let rect = Bounds {
            origin: point(Points(x), Points(y)),
            size: Size {
                width: Points(rw),
                height: Points(rh),
            },
        };
        Some((rect, dim - 2.0 * INDICATOR_MARGIN - len))
    }

    /// Whether a mouse press `at` a point (view coordinates) in a view of
    /// `size` grabs the indicator, faded out or not: on the desktop it is a
    /// scroll bar.
    pub fn grabs_thumb(&self, size: Size<Points>, at: Point<Points>) -> bool {
        let (x, y) = (at.x.0, at.y.0);
        if !self.indicator || !self.behavior.enabled {
            return false;
        }
        let Some((rect, _)) = self.thumb_f(size) else {
            return false;
        };
        let (along, across, start, len, edge) = if self.horizontal {
            (x, y, rect.origin.x.0, rect.size.width.0, size.height.0)
        } else {
            (y, x, rect.origin.y.0, rect.size.height.0, size.width.0)
        };
        (edge - THUMB_GRAB..=edge).contains(&across)
            && (start - THUMB_SLOP..=start + len + THUMB_SLOP).contains(&along)
    }

    /// True when the indicator may draw something (it shows, or the view
    /// is pulled down).
    pub fn indicates(&self) -> bool {
        (self.indicator && self.live.alpha > 0.0) || self.y.0 < 0.0
    }

    /// The refresh spinner's center in a view `width` wide and how far it
    /// is pulled out (all of it while refreshing), when it shows (not when
    /// the app draws its own); `refresh` is whether JS listens to
    /// `onRefresh`.
    pub fn spinner(&self, width: Points, refresh: bool) -> Option<(Point<Points>, Percentage)> {
        let y = self.y.0;
        let b = &self.behavior;
        if self.horizontal
            || y >= 0.0
            || b.refresh_indicator.is_some()
            || !(self.live.refreshing || refresh)
        {
            return None;
        }
        let progress = if self.live.refreshing {
            1.0
        } else {
            (-y / b.refresh_threshold().0).min(1.0)
        };
        let cy = b.content_inset.top.0 - y - b.refresh_inset().0 / 2.0;
        Some((point(width / 2.0, Points(cy)), Percentage(progress)))
    }

    /// Each sticky cell with how far it moves at the offset.
    pub fn sticky_shifts(&self) -> impl Iterator<Item = (NodeId, Point<Points>)> + '_ {
        self.sticky_shifts_with(|_| 0.0)
    }

    /// [`ScrollState::sticky_shifts`], a cell's animated offset
    /// (`StickyCell::offset`) valued by `value` (the animation graph's).
    pub fn sticky_shifts_with<'a>(
        &'a self,
        value: impl Fn(crate::animation::NodeId) -> f32 + 'a,
    ) -> impl Iterator<Item = (NodeId, Point<Points>)> + 'a {
        let offset = Points(self.offset() - self.lead());
        self.sticky.iter().map(move |c| {
            let extra = c.offset.map_or(0.0, &value);
            let t = sticky_shift(Points(offset.0 + extra), c.start, c.end);
            let zero = Points(0.0);
            (
                c.cell,
                if self.horizontal {
                    point(t, zero)
                } else {
                    point(zero, t)
                },
            )
        })
    }
}

// Accessors.

fn phase(host: &impl ScrollHost) -> Phase {
    host.scroll(|s, _| s.live.phase).unwrap_or(Phase::Idle)
}

fn set_phase(host: &impl ScrollHost, phase: Phase) {
    host.scroll_mut(|s, _| s.live.phase = phase);
}

/// Whether the user may scroll the view.
fn enabled(host: &impl ScrollHost) -> bool {
    host.scroll(|s, _| s.behavior.enabled).unwrap_or(false)
}

/// Sends `kind` with the offset if JS listens to it.
fn emit(host: &impl ScrollHost, kind: EventKind) {
    if kind == EventKind::ScrollEnd {
        host.settled();
    }
    if !host.listens(kind) {
        return;
    }
    let offset = host.scroll(|s, size| s.reported(size)).unwrap_or_default();
    host.event(kind, EventPayload::Scroll(offset));
}

/// Ends a glide or a snap a new input interrupts (`onMomentumEnd`,
/// as UIKit sends when a drag catches a glide).
fn interrupt(host: &impl ScrollHost) {
    let momentum = matches!(
        phase(host),
        Phase::Glide { .. } | Phase::Animate { momentum: true, .. }
    );
    set_phase(host, Phase::Idle);
    if momentum {
        emit(host, EventKind::MomentumEnd);
    }
}

// Moving.

/// Moves the main axis offset to `pos` (not clamped: drags rubber band)
/// and updates everything that follows it.
fn moved_to(host: &impl ScrollHost, pos: f32) {
    let moved = host.scroll_mut(|s, size| {
        let target = if s.horizontal { &mut s.x } else { &mut s.y };
        if target.0 == pos {
            return None;
        }
        // How far it is pulled past its top, when that changes.
        let pulled =
            (!s.horizontal && (target.0 < 0.0 || pos < 0.0)).then(|| Points((-pos).max(0.0)));
        *target = Points(pos);
        if s.indicator {
            s.live.shown = host.now();
            s.live.alpha = 1.0;
            s.live.dark = host.dark();
        }
        s.live.report = true;
        Some((s.reported(size), pulled))
    });
    let Some(Some((offset, pulled))) = moved else {
        return;
    };
    host.moved(offset);
    if let Some(distance) = pulled {
        host.pulled(distance);
    }
    if host.attached() {
        ensure_ticking(host);
    } else {
        // No frames draw it while detached: report now.
        report(host);
    }
}

fn report(host: &impl ScrollHost) {
    let pending = host.scroll_mut(|s, size| {
        std::mem::take(&mut s.live.report).then(|| (s.reported(size), s.applied))
    });
    if let Some(Some((offset, applied))) = pending {
        host.report(offset, applied);
    }
}

/// Eases to `to` (clamped to the rest limits).
fn animate_to(host: &impl ScrollHost, to: f32, duration: f64, momentum: bool, end: bool) {
    let (min, max) = host.scroll(|s, size| s.limits(size)).unwrap_or((0.0, 0.0));
    let to = to.clamp(min, max.max(min));
    let from = host.scroll(|s, _| s.offset()).unwrap_or(0.0);
    if (to - from).abs() < 0.5 || duration <= 0.0 {
        set_phase(host, Phase::Idle);
        moved_to(host, to);
        if momentum {
            emit(host, EventKind::MomentumEnd);
        }
        if end {
            emit(host, EventKind::ScrollEnd);
        }
        return;
    }
    set_phase(
        host,
        Phase::Animate {
            from,
            to,
            start: host.now(),
            duration,
            momentum,
            end,
        },
    );
    ensure_ticking(host);
}

/// The user let go at `v` points per ms along the main axis (positive:
/// the offset grows): bounces back, snaps, glides or settles. Snapping
/// uses `snap_velocity` when it is not 0 (a settled mouse wheel).
fn release(host: &impl ScrollHost, v: f32, snap_velocity: f32) {
    let Some((pos, min, max, target)) = host.scroll(|s, size| {
        let (min, max) = s.limits(size);
        let pos = s.offset();
        let lead = s.lead();
        let dim = s.viewport(size);
        let snap_velocity = if snap_velocity == 0.0 {
            v
        } else {
            snap_velocity
        };
        // Snap points are content offsets: UIKit's coordinates.
        let target = s
            .behavior
            .snap_target(
                Points(pos - lead),
                projected(Points(pos), v, rate(&s.behavior)) - Points(lead),
                snap_velocity,
                Points(dim),
                Points(max + dim - lead),
            )
            .map(|t| t.0 + lead);
        (pos, min, max, target)
    }) else {
        return;
    };
    if pos < min - 0.5 || pos > max + 0.5 {
        animate_to(host, pos.clamp(min, max.max(min)), ANIMATION, false, true);
    } else if let Some(target) = target {
        let duration = snap_duration(Points(target - pos), v);
        if duration > 0.0 {
            emit(host, EventKind::MomentumStart);
        }
        animate_to(host, target, duration, duration > 0.0, true);
    } else if v.abs() > MIN_GLIDE && (v > 0.0 && pos < max || v < 0.0 && pos > min) {
        set_phase(
            host,
            Phase::Glide {
                velocity: v,
                last: host.now(),
            },
        );
        emit(host, EventKind::MomentumStart);
        ensure_ticking(host);
    } else {
        set_phase(host, Phase::Idle);
        emit(host, EventKind::ScrollEnd);
    }
}

// The frame clock.

fn ensure_ticking(host: &impl ScrollHost) {
    let start = host.scroll_mut(|s, _| !std::mem::replace(&mut s.live.ticking, true));
    if start == Some(true) {
        host.start_ticking();
    }
}

/// A physical pointer capture was lost. Stop its drag or thumb phase
/// without release, snap, refresh or end callbacks; other motion is left alone.
pub fn cancel_pointer(host: &impl ScrollHost) {
    let cancelled = host.scroll_mut(|s, _| {
        if !matches!(s.live.phase, Phase::Drag { .. } | Phase::Thumb { .. }) {
            return false;
        }
        s.live.phase = Phase::Idle;
        s.live.shown = host.now();
        true
    });
    if cancelled == Some(true) {
        host.redraw();
        ensure_ticking(host);
    }
}

/// One frame of the view's motion at `now` (ms); false when there is
/// nothing left to do, and the frame callback stops.
pub fn frame(host: &impl ScrollHost, now: f64) -> bool {
    let busy = tick(host, now);
    if !busy {
        host.scroll_mut(|s, _| s.live.ticking = false);
    }
    busy
}

/// Ends an owner's pending input or animated command without end callbacks.
/// Preserve the existing frame registration: the platform may still have
/// that callback queued, and a new motion before its next frame reuses it.
pub fn stop_motion(host: &impl ScrollHost) {
    set_phase(host, Phase::Idle);
    report(host);
}

/// The view left the window during its frames: it stops (a later move
/// starts again) and reports where it is.
pub fn detached(host: &impl ScrollHost) {
    stop_motion(host);
    host.scroll_mut(|s, _| s.live.ticking = false);
}

fn tick(host: &impl ScrollHost, now: f64) -> bool {
    let Some((phase, pos, rate, (min, max), corrected)) = host.scroll_mut(|s, size| {
        let (mx, my) = s.max_f(size);
        let (cross, max) = if s.horizontal {
            (&mut s.y, my)
        } else {
            (&mut s.x, mx)
        };
        let bounded = Points(cross.0.clamp(0.0, max));
        let changed = *cross != bounded;
        *cross = bounded;
        s.live.report |= changed;
        (
            s.live.phase,
            s.offset(),
            rate(&s.behavior),
            s.limits(size),
            changed.then(|| s.reported(size)),
        )
    }) else {
        return false;
    };
    if let Some(offset) = corrected {
        host.moved(offset);
    }
    match phase {
        Phase::Glide { velocity, last } => {
            let dt = (now - last).max(0.0) as f32;
            let (d, v) = glide_step(velocity, rate, dt);
            let next = pos + d;
            let stop = v.abs() < STOP || next <= min || next >= max;
            moved_to(host, next.clamp(min, max.max(min)));
            if stop {
                set_phase(host, Phase::Idle);
                emit(host, EventKind::MomentumEnd);
                emit(host, EventKind::ScrollEnd);
            } else {
                set_phase(
                    host,
                    Phase::Glide {
                        velocity: v,
                        last: now,
                    },
                );
            }
        }
        Phase::Animate {
            from,
            to,
            start,
            duration,
            momentum,
            end,
        } => {
            let t = (now - start) / duration;
            let to = to.clamp(min, max.max(min));
            moved_to(host, from + (to - from) * ease_out(t));
            if t >= 1.0 {
                set_phase(host, Phase::Idle);
                if momentum {
                    emit(host, EventKind::MomentumEnd);
                }
                if end {
                    emit(host, EventKind::ScrollEnd);
                }
            }
        }
        Phase::Wheel {
            last,
            total,
            gesture: false,
        } if now - last > WHEEL_IDLE => {
            // A mouse wheel came to rest: snapping views move on to the
            // next snap point in the wheel's direction.
            set_phase(host, Phase::Idle);
            let snaps = host
                .scroll(|s, _| s.behavior.snaps() || s.behavior.paging)
                .unwrap_or(false);
            if snaps {
                let v = if total.abs() >= 1.0 {
                    total.signum() * WHEEL_SNAP
                } else {
                    0.0
                };
                release(host, 0.0, v);
            } else {
                moved_to(host, pos.clamp(min, max.max(min)));
                emit(host, EventKind::ScrollEnd);
            }
        }
        Phase::Idle | Phase::Thumb { .. } | Phase::Wheel { .. }
            if pos < min || pos > max.max(min) + 0.5 =>
        {
            moved_to(host, pos.clamp(min, max.max(min)));
        }
        _ => {}
    }
    report(host);
    let Some((busy, redraw)) = host.scroll_mut(|s, _| {
        let mut redraw = false;
        let mut busy = !matches!(
            s.live.phase,
            Phase::Idle
                | Phase::Drag { .. }
                | Phase::Thumb { .. }
                | Phase::Wheel { gesture: true, .. }
        );
        if matches!(s.live.phase, Phase::Thumb { .. }) {
            // A held thumb stays until it is let go (`thumb_end`).
            s.live.shown = now;
        } else if s.live.alpha > 0.0 {
            let alpha = indicator_alpha(now - s.live.shown);
            if alpha != s.live.alpha {
                s.live.alpha = alpha;
                redraw = true;
            }
            busy |= alpha > 0.0;
        }
        if !s.horizontal
            && s.offset() < 0.0
            && s.live.refreshing
            && s.behavior.refresh_indicator.is_none()
        {
            s.live.spin = Radians(((now / 1000.0) as f32 * 2.0 * PI) % (2.0 * PI));
            redraw = true;
            busy = true;
        }
        (busy, redraw)
    }) else {
        return false;
    };
    if redraw {
        host.redraw();
    }
    busy
}

// Mount items.

/// `ScrollConfig`.
pub fn config(host: &impl ScrollHost, horizontal: bool, indicator: bool, mirrored: bool) {
    let changed = host.scroll_mut(|s, _| {
        let axis_changed = std::mem::replace(&mut s.horizontal, horizontal) != horizontal;
        if axis_changed {
            // Motion coordinates belong to the axis on which they began.
            s.live.phase = Phase::Idle;
        }
        // A horizontal view keeps its indicator: it is the mouse's scroll
        // bar, and a mouse without a horizontal wheel has no other way
        // to move it (mouse drags do not scroll).
        s.indicator = indicator || horizontal;
        if !indicator {
            s.live.alpha = 0.0;
        }
        let mirrored = mirrored && horizontal;
        (
            std::mem::replace(&mut s.mirrored, mirrored) != mirrored,
            axis_changed,
        )
    });
    if let Some((mirrored, axis)) = changed {
        if mirrored || axis {
            host.relayout();
        }
        if axis {
            resized(host);
        }
    }
}

/// The viewport size changed. Offsets outside the new extent settle on
/// the next frame, after the rest of the mount batch is applied.
pub fn resized(host: &impl ScrollHost) {
    let past = host.scroll(|s, size| {
        let (mx, my) = s.max_f(size);
        let cross = if s.horizontal {
            s.y.0 < 0.0 || s.y.0 > my
        } else {
            s.x.0 < 0.0 || s.x.0 > mx
        };
        let (min, max) = s.limits(size);
        cross || s.offset() < min || s.offset() > max + 0.5
    });
    if past == Some(true) {
        ensure_ticking(host);
    }
}

/// `ScrollContent`. Content that shrank below the offset pulls it back on
/// the next frame, once the rest of the batch (the `ScrollBy` that keeps
/// the visible content in place) is applied.
pub fn content(host: &impl ScrollHost, content: Size<Points>) {
    if host.scroll_mut(|s, _| s.content = content).is_none() {
        return;
    }
    resized(host);
    host.redraw();
}

/// `ScrollBy`: the core keeps the visible content in place (items above
/// the viewport changed size); not clamped, the core knows its content.
pub fn scroll_by(host: &impl ScrollHost, delta: Point<Points>) {
    let (dx, dy) = (delta.x.0, delta.y.0);
    let Some((pos, d)) = host.scroll_mut(|s, _| {
        s.applied = s.applied.wrapping_add(1);
        // The off axis would only push the content out of the viewport.
        let d = if s.horizontal { dx } else { dy };
        s.live.phase = shifted(s.live.phase, d);
        s.live.report = true;
        (s.offset(), d)
    }) else {
        return;
    };
    if d != 0.0 {
        moved_to(host, pos + d);
    }
    report(host);
}

/// `ScrollBehavior`.
pub fn behavior(host: &impl ScrollHost, behavior: &ScrollBehavior) {
    let Some((inset, refresh, held)) = host.scroll_mut(|s, _| {
        let inset = s.behavior.content_inset != behavior.content_inset;
        let refresh = s.behavior.refresh_indicator != behavior.refresh_indicator;
        s.behavior = behavior.clone();
        if !behavior.enabled
            && matches!(
                s.live.phase,
                Phase::Drag { .. } | Phase::Thumb { .. } | Phase::Wheel { .. }
            )
        {
            s.live.phase = Phase::Idle;
        }
        // A refresh in progress keeps the room of the indicator now showing.
        let held = (refresh
            && !s.horizontal
            && s.live.refreshing
            && s.offset() < 0.0
            && !matches!(s.live.phase, Phase::Drag { .. }))
        .then(|| behavior.refresh_inset().0);
        (inset, refresh, held)
    }) else {
        return;
    };
    if inset {
        host.relayout();
        resized(host);
    }
    if refresh {
        host.redraw();
    }
    if let Some(room) = held {
        animate_to(host, -room, ANIMATION, false, false);
    }
}

/// `Refreshing`: shows the spinner above the content (scrolling to it
/// when at the top) or hides it.
pub fn refreshing(host: &impl ScrollHost, refreshing: bool) {
    let Some(Some((pos, dragging, inset))) = host.scroll_mut(|s, _| {
        if s.horizontal || s.live.refreshing == refreshing {
            return None;
        }
        s.live.refreshing = refreshing;
        Some((
            s.offset(),
            matches!(s.live.phase, Phase::Drag { .. }),
            s.behavior.refresh_inset().0,
        ))
    }) else {
        return;
    };
    host.redraw();
    if dragging {
        return;
    }
    if refreshing && pos <= 0.5 {
        animate_to(host, -inset, ANIMATION, false, false);
    } else if !refreshing && pos < 0.0 {
        animate_to(host, 0.0, ANIMATION, false, false);
    }
}

/// `scrollTo` and `scrollToEnd` (the core resolves `scrollToIndex` and,
/// usually, `scrollToEnd` into `scrollTo`); `zoomTo` is not supported.
pub fn command(host: &impl ScrollHost, command: &Command) {
    let Some(Some((target, animated))) = host.scroll_mut(|s, size| {
        let (min, max) = s.limits(size);
        let inset = s.behavior.content_inset;
        let (target, animated) = match *command {
            Command::ScrollTo { x, y, animated } => (
                if s.horizontal {
                    x.0 + inset.left.0
                } else {
                    y.0 + inset.top.0
                },
                animated,
            ),
            Command::ScrollToEnd { animated } => (max, animated),
            Command::ScrollToIndex { .. } | Command::ZoomTo { .. } => {
                log::debug!("scroll: {command:?} is not supported");
                return None;
            }
            _ => return None,
        };
        s.applied = s.applied.wrapping_add(1);
        s.live.report = true;
        Some((target.clamp(min, max.max(min)), animated))
    }) else {
        return;
    };
    interrupt(host);
    if animated {
        animate_to(host, target, ANIMATION, false, true);
    } else {
        moved_to(host, target);
    }
    report(host);
}

// Drags.

/// A finger or pen drag starts scrolling the view (the mouse never drags
/// content).
pub fn drag_begin(host: &impl ScrollHost) {
    if !enabled(host) {
        return;
    }
    interrupt(host);
    let start = host.scroll(|s, _| s.offset()).unwrap_or(0.0);
    set_phase(host, Phase::Drag { start, moved: 0.0 });
    emit(host, EventKind::ScrollDragStart);
}

/// The drag moved by `delta` since the last move (content follows the
/// pointer: positive scrolls toward the start).
pub fn drag_move(host: &impl ScrollHost, delta: Point<Points>) {
    drag(host, delta.x.0, delta.y.0, false);
}

/// The drag moved by `moved` since it began.
pub fn drag_to(host: &impl ScrollHost, moved: Point<Points>) {
    drag(host, moved.x.0, moved.y.0, true);
}

fn drag(host: &impl ScrollHost, dx: f32, dy: f32, since_begin: bool) {
    let Phase::Drag { start, moved } = phase(host) else {
        return;
    };
    let Some((pos, moved)) = host.scroll(|s, size| {
        let (min, max) = s.limits(size);
        let d = if !s.horizontal {
            -dy
        } else if s.mirrored {
            dx
        } else {
            -dx
        };
        // Accumulated, not added to the offset: the rubber band applies to
        // where the pointer went, not to where the content was.
        let moved = if since_begin { d } else { moved + d };
        let pos = drag_position(
            start + moved,
            min,
            max.max(min),
            s.viewport(size),
            s.behavior.bounces,
        );
        (pos, moved)
    }) else {
        return;
    };
    set_phase(host, Phase::Drag { start, moved });
    moved_to(host, pos);
}

/// The drag ended with a velocity of `(vx, vy)` points per second: a
/// glide follows.
pub fn drag_end(host: &impl ScrollHost, vx: f32, vy: f32) {
    if !matches!(phase(host), Phase::Drag { .. }) {
        return;
    }
    let listens = host.listens(EventKind::Refresh);
    let Some((v, refresh)) = host.scroll(|s, _| {
        let v = if !s.horizontal {
            -vy
        } else if s.mirrored {
            vx
        } else {
            -vx
        } / 1000.0;
        let refresh = !s.horizontal
            && !s.live.refreshing
            && listens
            && s.behavior.refreshes(Points(s.offset()));
        (v, refresh)
    }) else {
        return;
    };
    set_phase(host, Phase::Idle);
    emit(host, EventKind::ScrollDragEnd);
    if refresh {
        // Shown right away, as UIRefreshControl does; JS turns it off.
        host.scroll_mut(|s, _| s.live.refreshing = true);
        host.event(EventKind::Refresh, EventPayload::None);
    }
    release(host, v, 0.0);
}

// The indicator as a scroll bar.

/// The mouse moved over the view: its indicator shows (and fades again
/// once the mouse rests), as overlay scroll bars do, so that a mouse user
/// sees it can scroll and where its scroll bar is.
pub fn hovered(host: &impl ScrollHost) {
    let shown = host.scroll_mut(|s, size| {
        if s.thumb_f(size).is_none() || !s.indicator || !s.behavior.enabled {
            return false;
        }
        s.live.shown = host.now();
        if s.live.alpha == 1.0 {
            return false;
        }
        s.live.alpha = 1.0;
        s.live.dark = host.dark();
        true
    });
    if shown != Some(true) {
        return;
    }
    host.redraw();
    ensure_ticking(host);
}

/// The mouse grabbed the view's indicator ([`ScrollState::grabs_thumb`]).
pub fn thumb_begin(host: &impl ScrollHost) {
    interrupt(host);
    let grabbed = host.scroll_mut(|s, _| {
        s.live.phase = Phase::Thumb { start: s.offset() };
        s.live.shown = host.now();
        s.live.alpha = 1.0;
        s.live.dark = host.dark();
    });
    if grabbed.is_none() {
        return;
    }
    host.redraw();
    emit(host, EventKind::ScrollDragStart);
}

/// The grabbed indicator was dragged by `moved` since it was grabbed: the
/// content moves the other way, so the thumb follows the pointer (a
/// content drag moves the content with it).
pub fn thumb_move(host: &impl ScrollHost, moved: Point<Points>) {
    let (dx, dy) = (moved.x.0, moved.y.0);
    let Phase::Thumb { start } = phase(host) else {
        return;
    };
    let Some(Some(pos)) = host.scroll(|s, size| {
        let (_, travel) = s.thumb_f(size)?;
        let (min, max) = s.limits(size);
        let d = if !s.horizontal {
            dy
        } else if s.mirrored {
            -dx
        } else {
            dx
        };
        let d = thumb_scroll(Points(d), Points(max), Points(travel)).0;
        Some((start + d).clamp(min, max.max(min)))
    }) else {
        return;
    };
    moved_to(host, pos);
}

/// The grabbed indicator was let go: it fades from now, snapping views
/// settle on a snap point.
pub fn thumb_end(host: &impl ScrollHost) {
    if !matches!(phase(host), Phase::Thumb { .. }) {
        return;
    }
    set_phase(host, Phase::Idle);
    host.scroll_mut(|s, _| s.live.shown = host.now());
    ensure_ticking(host);
    emit(host, EventKind::ScrollDragEnd);
    release(host, 0.0, 0.0);
}

// Wheels and touchpads.

/// A wheel or touchpad scroll starts on the view (a touchpad gesture: it
/// ends with [`wheel_end`]).
pub fn wheel_begin(host: &impl ScrollHost) {
    if !enabled(host) {
        return;
    }
    interrupt(host);
    set_phase(
        host,
        Phase::Wheel {
            last: host.now(),
            total: 0.0,
            gesture: true,
        },
    );
    emit(host, EventKind::ScrollDragStart);
}

/// Scrolls the view by `delta` (positive toward the end). Without
/// [`wheel_begin`] it is a mouse wheel, which settles when idle.
pub fn wheel(host: &impl ScrollHost, delta: Point<Points>) {
    let (dx, dy) = (delta.x.0, delta.y.0);
    if !enabled(host) {
        return;
    }
    let (gesture, total) = match phase(host) {
        Phase::Wheel { gesture, total, .. } => (gesture, total),
        _ => {
            interrupt(host);
            (false, 0.0)
        }
    };
    let Some((pos, total)) = host.scroll(|s, size| {
        let (min, max) = s.limits(size);
        let d = if !s.horizontal {
            dy
        } else if dx != 0.0 {
            if s.mirrored { -dx } else { dx }
        } else {
            // Vertical wheels scroll horizontal views too.
            dy
        };
        let pos = s.offset();
        // Past an edge (the refresh space) wheels only move back.
        let lo = min.min(pos);
        let hi = max.max(min).max(pos);
        ((pos + d).clamp(lo, hi), total + d)
    }) else {
        return;
    };
    set_phase(
        host,
        Phase::Wheel {
            last: host.now(),
            total,
            gesture,
        },
    );
    moved_to(host, pos);
    ensure_ticking(host);
}

/// The wheel scroll ended at a velocity of `(vx, vy)` points per second
/// (0 for wheels without momentum).
pub fn wheel_end(host: &impl ScrollHost, vx: f32, vy: f32) {
    let Phase::Wheel { gesture, total, .. } = phase(host) else {
        return;
    };
    let Some(v) = host.scroll(|s, _| {
        if !s.horizontal {
            vy
        } else if vx != 0.0 {
            if s.mirrored { -vx } else { vx }
        } else {
            vy
        }
    }) else {
        return;
    };
    let v = v / 1000.0;
    set_phase(host, Phase::Idle);
    if gesture {
        emit(host, EventKind::ScrollDragEnd);
    }
    let snap = if v == 0.0 && total.abs() >= 1.0 {
        total.signum() * WHEEL_SNAP
    } else {
        0.0
    };
    release(host, v, snap);
}

// The keyboard.

/// Points an arrow key scrolls, as browsers do.
pub const KEY_LINE: Points = Points(40.0);
/// The share of the viewport a page key scrolls (the rest stays in view).
const KEY_PAGE: f32 = 0.875;
/// Duration of keyboard scrolls (ms); repeats retarget the running one.
const KEY_ANIMATION: f64 = 200.0;

/// Where a scroll key moves along an axis.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum KeyMove {
    /// By this far (positive: towards the end).
    Points(Points),
    /// By this many viewports.
    Pages(f32),
    /// To the start.
    Start,
    /// To the end.
    End,
}

impl KeyMove {
    /// The direction it moves in: 1 towards the end, -1 towards the start.
    pub fn sign(self) -> f32 {
        match self {
            KeyMove::Points(d) => d.0.signum(),
            KeyMove::Pages(n) => n.signum(),
            KeyMove::Start => -1.0,
            KeyMove::End => 1.0,
        }
    }
}

/// What the key of Windows virtual key code `vk` scrolls (the codes the
/// Windows and GPUI backends' keys carry): whether along the horizontal
/// axis, and how. `ctrl` held leaves only Ctrl+Home / Ctrl+End, which go
/// to the edges as in browsers; other Ctrl combinations are shortcuts.
pub fn vk_key_move(vk: u16, shift: bool, ctrl: bool) -> Option<(bool, KeyMove)> {
    const VK_SPACE: u16 = 0x20;
    const VK_PRIOR: u16 = 0x21;
    const VK_NEXT: u16 = 0x22;
    const VK_END: u16 = 0x23;
    const VK_HOME: u16 = 0x24;
    const VK_LEFT: u16 = 0x25;
    const VK_UP: u16 = 0x26;
    const VK_RIGHT: u16 = 0x27;
    const VK_DOWN: u16 = 0x28;
    if ctrl {
        return match vk {
            VK_HOME => Some((false, KeyMove::Start)),
            VK_END => Some((false, KeyMove::End)),
            _ => None,
        };
    }
    Some(match vk {
        VK_UP => (false, KeyMove::Points(-KEY_LINE)),
        VK_DOWN => (false, KeyMove::Points(KEY_LINE)),
        VK_LEFT => (true, KeyMove::Points(-KEY_LINE)),
        VK_RIGHT => (true, KeyMove::Points(KEY_LINE)),
        VK_PRIOR => (false, KeyMove::Pages(-1.0)),
        VK_NEXT => (false, KeyMove::Pages(1.0)),
        VK_SPACE if shift => (false, KeyMove::Pages(-1.0)),
        VK_SPACE => (false, KeyMove::Pages(1.0)),
        VK_HOME => (false, KeyMove::Start),
        VK_END => (false, KeyMove::End),
        _ => return None,
    })
}

/// The offset a key move from `base` aims at, within `[min, max]`.
fn key_target(m: KeyMove, base: f32, viewport: f32, min: f32, max: f32) -> f32 {
    let max = max.max(min);
    match m {
        KeyMove::Points(d) => base + d.0,
        KeyMove::Pages(n) => base + n * (viewport * KEY_PAGE).max(KEY_LINE.0),
        KeyMove::Start => min,
        KeyMove::End => max,
    }
    .clamp(min, max)
}

/// Scrolls the view by the key move `m`, animated; a repeat continues
/// from where the running scroll goes. With `flip`, a move by points goes
/// the other way in a mirrored view (Left and Right follow what they show
/// in a right-to-left list).
pub fn key_scroll(host: &impl ScrollHost, m: KeyMove, flip: bool) {
    let Some((base, viewport, min, max, flip)) = host.scroll(|s, size| {
        let (min, max) = s.limits(size);
        (s.goal(), s.viewport(size), min, max, flip && s.mirrored)
    }) else {
        return;
    };
    let m = match m {
        KeyMove::Points(d) if flip => KeyMove::Points(-d),
        m => m,
    };
    let to = key_target(m, base, viewport, min, max);
    interrupt(host);
    animate_to(host, to, KEY_ANIMATION, false, true);
}

/// Room kept around a view scrolled into view.
const REVEAL_MARGIN: f32 = 16.0;

/// How far a scroll view must move along an axis so that the span
/// `[start, end)` (viewport coordinates) shows in `[0, viewport)`, with
/// a margin; the start wins when the span does not fit.
pub fn reveal_delta(start: Points, end: Points, viewport: Points) -> Points {
    Points(reveal_by(start.0, end.0, viewport.0))
}

fn reveal_by(start: f32, end: f32, viewport: f32) -> f32 {
    let margin = REVEAL_MARGIN.min(viewport / 4.0);
    if start < margin {
        start - margin
    } else if end > viewport - margin {
        (end - (viewport - margin)).min(start - margin)
    } else {
        0.0
    }
}

/// Scrolls the view (animated) so that the span of `len` points at
/// `start` along its main axis (viewport coordinates, as measured now)
/// shows, as iOS and Android do for the focused field; how far it moves
/// (0 when it shows already). Backends call it on each scroll view around
/// the field, innermost first, less what the inner ones moved.
pub fn reveal(host: &impl ScrollHost, start: Points, len: Points) -> Points {
    let (start, len) = (start.0, len.0);
    let Some((base, pos, dim, min, max)) = host.scroll(|s, size| {
        let (min, max) = s.limits(size);
        (s.goal(), s.offset(), s.viewport(size), min, max)
    }) else {
        return Points(0.0);
    };
    // Pending animations count from where they are headed.
    let start = start - (base - pos);
    let delta = reveal_by(start, start + len, dim);
    let to = (base + delta).clamp(min, max.max(min));
    if (to - base).abs() < 0.5 {
        return Points(0.0);
    }
    interrupt(host);
    animate_to(host, to, ANIMATION, false, true);
    Points(to - base)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EdgeInsets;

    struct ExtentHost {
        state: std::cell::RefCell<ScrollState>,
        size: std::cell::Cell<Size<Points>>,
        moved: std::cell::RefCell<Vec<Point<Points>>>,
        pulls: std::cell::RefCell<Vec<Points>>,
        reports: std::cell::RefCell<Vec<(Point<Points>, u32)>>,
        ticks: std::cell::Cell<usize>,
    }

    impl ExtentHost {
        fn new(x: f32, y: f32) -> Self {
            Self {
                state: std::cell::RefCell::new(ScrollState {
                    x: Points(x),
                    y: Points(y),
                    ..scroll_state((900.0, 900.0), true)
                }),
                size: std::cell::Cell::new(sz(300.0, 400.0)),
                moved: Default::default(),
                pulls: Default::default(),
                reports: Default::default(),
                ticks: Default::default(),
            }
        }
    }

    impl ScrollHost for ExtentHost {
        fn scroll<R>(&self, f: impl FnOnce(&ScrollState, Size<Points>) -> R) -> Option<R> {
            Some(f(&self.state.borrow(), self.size.get()))
        }
        fn scroll_mut<R>(&self, f: impl FnOnce(&mut ScrollState, Size<Points>) -> R) -> Option<R> {
            Some(f(&mut self.state.borrow_mut(), self.size.get()))
        }
        fn now(&self) -> f64 {
            0.0
        }
        fn listens(&self, _: EventKind) -> bool {
            false
        }
        fn event(&self, _: EventKind, _: EventPayload) {
            panic!("extent changes must not send gesture callbacks")
        }
        fn report(&self, offset: Point<Points>, applied: u32) {
            self.reports.borrow_mut().push((offset, applied));
        }
        fn moved(&self, offset: Point<Points>) {
            self.moved.borrow_mut().push(offset);
        }
        fn pulled(&self, distance: Points) {
            self.pulls.borrow_mut().push(distance);
        }
        fn relayout(&self) {}
        fn redraw(&self) {}
        fn attached(&self) -> bool {
            true
        }
        fn start_ticking(&self) {
            self.ticks.set(self.ticks.get() + 1);
        }
    }

    fn scroll_state(content: (f32, f32), horizontal: bool) -> ScrollState {
        ScrollState {
            content: sz(content.0, content.1),
            horizontal,
            ..Default::default()
        }
    }

    fn sz(w: f32, h: f32) -> Size<Points> {
        crate::geometry::size(Points(w), Points(h))
    }

    fn pt(x: f32, y: f32) -> Point<Points> {
        point(Points(x), Points(y))
    }

    #[test]
    fn content_shrink_reconciles_the_old_axis_after_the_anchor_scroll() {
        let host = ExtentHost::new(120.0, 70.0);
        config(&host, false, false, false);
        frame(&host, 0.0);
        // Changing the scrolling direction does not discard a valid position.
        assert_eq!(host.state.borrow().origin(), pt(120.0, 70.0));

        content(&host, sz(300.0, 900.0));
        scroll_by(&host, pt(0.0, 25.0));
        assert_eq!(host.state.borrow().origin(), pt(120.0, 95.0));
        frame(&host, 1.0);
        assert_eq!(host.state.borrow().origin(), pt(0.0, 95.0));
        assert_eq!(host.moved.borrow().last(), Some(&pt(0.0, 95.0)));
        assert_eq!(host.reports.borrow().last(), Some(&(pt(0.0, 95.0), 1)));

        // An old-axis rubber band must not leave the content displaced either.
        let host = ExtentHost::new(-30.0, 70.0);
        config(&host, false, false, false);
        assert_eq!(host.ticks.get(), 1);
        frame(&host, 0.0);
        assert_eq!(host.state.borrow().origin(), pt(0.0, 70.0));
        assert_eq!(host.moved.borrow().last(), Some(&pt(0.0, 70.0)));
        assert_eq!(host.reports.borrow().last(), Some(&(pt(0.0, 70.0), 0)));
    }

    #[test]
    fn changing_axis_ends_the_old_animation_without_moving_the_new_axis() {
        let host = ExtentHost::new(120.0, 70.0);
        command(
            &host,
            &Command::ScrollTo {
                x: Points(240.0),
                y: Points(0.0),
                animated: true,
            },
        );
        // An indicator-only change must preserve the running animation.
        config(&host, true, false, false);
        frame(&host, 150.0);
        assert_eq!(host.state.borrow().origin(), pt(225.0, 70.0));
        assert!(host.pulls.borrow().is_empty());

        // No ScrollContent follows this configuration change.
        config(&host, false, false, false);
        frame(&host, 200.0);
        assert_eq!(host.state.borrow().origin(), pt(225.0, 70.0));
        command(
            &host,
            &Command::ScrollTo {
                x: Points(0.0),
                y: Points(170.0),
                animated: true,
            },
        );
        frame(&host, 300.0);
        assert_eq!(host.state.borrow().origin(), pt(225.0, 170.0));
    }

    #[test]
    fn viewport_growth_and_inset_changes_reconcile_the_current_extent() {
        let host = ExtentHost::new(500.0, 70.0);
        config(&host, false, false, false);
        frame(&host, 0.0);
        host.size.set(sz(800.0, 400.0));
        resized(&host);
        assert_eq!(host.state.borrow().origin(), pt(500.0, 70.0));
        frame(&host, 1.0);
        assert_eq!(host.state.borrow().origin(), pt(100.0, 70.0));
        assert_eq!(host.moved.borrow().last(), Some(&pt(100.0, 70.0)));

        let mut with_inset = ScrollBehavior::default();
        with_inset.content_inset.right = Points(80.0);
        behavior(&host, &with_inset);
        config(&host, true, false, false);
        command(
            &host,
            &Command::ScrollTo {
                x: Points(170.0),
                y: Points(0.0),
                animated: false,
            },
        );
        config(&host, false, false, false);
        frame(&host, 2.0);
        assert_eq!(host.state.borrow().origin(), pt(170.0, 70.0));

        behavior(&host, &ScrollBehavior::default());
        assert_eq!(host.state.borrow().origin(), pt(170.0, 70.0));
        frame(&host, 3.0);
        assert_eq!(host.state.borrow().origin(), pt(100.0, 70.0));
        assert_eq!(host.moved.borrow().last(), Some(&pt(100.0, 70.0)));
        assert_eq!(host.reports.borrow().last(), Some(&(pt(100.0, 70.0), 1)));
    }

    #[test]
    fn range_changes_bound_the_last_animation_frame_without_a_scrollbar() {
        let host = ExtentHost::new(0.0, 70.0);
        config(&host, false, false, false);
        command(
            &host,
            &Command::ScrollTo {
                x: Points(0.0),
                y: Points(500.0),
                animated: true,
            },
        );
        host.size.set(sz(300.0, 800.0));
        resized(&host);
        assert!(!frame(&host, 300.0));
        assert_eq!(host.state.borrow().origin(), pt(0.0, 100.0));
        assert_eq!(host.moved.borrow().last(), Some(&pt(0.0, 100.0)));
        assert_eq!(host.reports.borrow().last(), Some(&(pt(0.0, 100.0), 1)));
        assert!(host.pulls.borrow().is_empty());

        // Retargeting the end keeps the original rubber-band bounce smooth.
        let host = ExtentHost::new(0.0, -40.0);
        config(&host, false, false, false);
        command(
            &host,
            &Command::ScrollTo {
                x: Points(0.0),
                y: Points(0.0),
                animated: true,
            },
        );
        frame(&host, 150.0);
        assert_eq!(host.state.borrow().origin(), pt(0.0, -5.0));
        assert_eq!(*host.pulls.borrow(), vec![Points(5.0)]);
        frame(&host, 300.0);
        assert_eq!(host.state.borrow().origin(), pt(0.0, 0.0));
        assert_eq!(*host.pulls.borrow(), vec![Points(5.0), Points::ZERO]);
    }

    #[test]
    fn rubber_band_resists() {
        assert_eq!(drag_position(50.0, 0.0, 100.0, 400.0, true), 50.0);
        let over = drag_position(-100.0, 0.0, 100.0, 400.0, true);
        assert!(over < 0.0 && over > -100.0, "{over}");
        let more = drag_position(-400.0, 0.0, 100.0, 400.0, true);
        assert!(more < over && more > -400.0 * 0.55);
        assert_eq!(drag_position(-100.0, 0.0, 100.0, 400.0, false), 0.0);
        assert_eq!(drag_position(300.0, 0.0, 100.0, 400.0, false), 100.0);
        assert!(drag_position(150.0, 0.0, 100.0, 400.0, true) > 100.0);
        let p = Points;
        assert_eq!(dragged(p(50.0), p(0.0), p(100.0), p(400.0), true), p(50.0));
        // Never more than 55% of the viewport.
        assert!(rubber(1e6, 400.0) < 400.0);
    }

    #[test]
    fn glide_integrates_to_projection() {
        let rate = 0.998;
        let (mut pos, mut v) = (0.0f32, 2.0f32);
        for _ in 0..2000 {
            let (d, nv) = glide_step(v, rate, 16.0);
            pos += d;
            v = nv;
        }
        let end = projected(Points(0.0), 2.0, rate).0;
        assert!((pos - end).abs() < 1.0, "{pos} vs {end}");
        // Frame rate does not change the path.
        let (a, _) = glide_step(2.0, rate, 32.0);
        let (b1, v1) = glide_step(2.0, rate, 16.0);
        let (b2, _) = glide_step(v1, rate, 16.0);
        assert!((a - (b1 + b2)).abs() < 1e-3);
    }

    #[test]
    fn animated_sticky_offsets_stick_further_in() {
        let mut s = scroll_state((320.0, 2000.0), false);
        s.y = Points(150.0);
        s.sticky = vec![
            crate::StickyCell {
                cell: 1,
                start: Points(100.0),
                end: Points(300.0),
                offset: None,
            },
            crate::StickyCell {
                cell: 2,
                start: Points(100.0),
                end: Points(300.0),
                offset: Some(7),
            },
        ];
        // Below a 56 pt header: the second sticks 56 further in.
        let shifts: Vec<_> = s
            .sticky_shifts_with(|n| if n == 7 { 56.0 } else { 0.0 })
            .map(|(c, p)| (c, p.y.0))
            .collect();
        assert_eq!(shifts, [(1, 50.0), (2, 106.0)]);
    }

    #[test]
    fn sticky_shift_clamps() {
        let p = Points;
        assert_eq!(sticky_shift(p(0.0), p(100.0), p(300.0)), p(0.0));
        assert_eq!(sticky_shift(p(150.0), p(100.0), p(300.0)), p(50.0));
        assert_eq!(sticky_shift(p(500.0), p(100.0), p(300.0)), p(200.0));
        assert_eq!(sticky_shift(p(500.0), p(100.0), p(f32::INFINITY)), p(400.0));
    }

    #[test]
    fn rates_follow_behavior() {
        let mut b = ScrollBehavior::default();
        assert_eq!(rate(&b), 0.998);
        b.paging = true;
        assert_eq!(rate(&b), 0.99);
        b.deceleration = 0.95;
        assert_eq!(rate(&b), 0.95);
    }

    #[test]
    fn snapping_and_paging_targets() {
        // Paging in a 400 point viewport over 1600 points of content: a
        // slow release past half a page moves on, a fling moves one page.
        let b = ScrollBehavior {
            paging: true,
            ..Default::default()
        };
        let r = rate(&b);
        let pt = Points;
        let t = b.snap_target(
            pt(250.0),
            projected(pt(250.0), 0.0, r),
            0.0,
            pt(400.0),
            pt(1600.0),
        );
        assert_eq!(t, Some(pt(400.0)));
        let t = b.snap_target(
            pt(100.0),
            projected(pt(100.0), 1.0, r),
            1.0,
            pt(400.0),
            pt(1600.0),
        );
        assert_eq!(t, Some(pt(400.0)));
        let t = b.snap_target(
            pt(300.0),
            projected(pt(300.0), -1.0, r),
            -1.0,
            pt(400.0),
            pt(1600.0),
        );
        assert_eq!(t, Some(pt(0.0)));
        let b = ScrollBehavior {
            snap_interval: pt(100.0),
            ..Default::default()
        };
        let t = b.snap_target(pt(140.0), pt(140.0), 0.0, pt(400.0), pt(1600.0));
        assert_eq!(t, Some(pt(100.0)));
        assert_eq!(
            ScrollBehavior::default().snap_target(pt(140.0), pt(140.0), 0.0, pt(400.0), pt(1600.0)),
            None
        );
    }

    #[test]
    fn indicator_geometry() {
        assert_eq!(span(400.0, 400.0, 0.0), None);
        let (s0, l0) = span(400.0, 1600.0, 0.0).unwrap();
        assert_eq!(s0, 2.0);
        assert!((l0 - 99.0).abs() < 0.01);
        let (s1, l1) = span(400.0, 1600.0, 1200.0).unwrap();
        assert!((s1 + l1 - 398.0).abs() < 0.01);
        let (_, l2) = span(400.0, 1600.0, -50.0).unwrap();
        assert!(l2 < l0);
        assert_eq!(
            indicator_span(Points(400.0), Points(1600.0), Points(0.0)),
            Some((Points(s0), Points(l0)))
        );
        assert_eq!(indicator_alpha(0.0), 1.0);
        assert_eq!(indicator_alpha(INDICATOR_HOLD + INDICATOR_FADE), 0.0);
    }

    #[test]
    fn snap_durations() {
        let p = Points;
        assert_eq!(snap_duration(p(0.2), 1.0), 0.0);
        assert_eq!(snap_duration(p(100.0), -1.0), ANIMATION);
        assert_eq!(snap_duration(p(300.0), 1.0), 600.0);
        assert_eq!(snap_duration(p(300.0), 3.0), 300.0);
        assert_eq!(ease_out(1.0), 1.0);
        assert_eq!(ease_out(2.0), 1.0);
    }

    #[test]
    fn insets_clamp_and_report() {
        let mut s = scroll_state((300.0, 1000.0), false);
        let size = sz(300.0, 400.0);
        s.behavior.content_inset = EdgeInsets {
            top: Points(50.0),
            bottom: Points(20.0),
            ..Default::default()
        };
        assert_eq!(s.limits(size), (0.0, 670.0));
        assert_eq!(s.max(size), pt(0.0, 670.0));
        // The offset 0 shows the top inset: UIKit's contentOffset is -50.
        assert_eq!(s.reported(size), pt(0.0, -50.0));
        s.y = Points(900.0);
        assert_eq!(s.reported(size), pt(0.0, 620.0));
        // Children are drawn up by the offset, down by the inset.
        assert_eq!(s.origin(), pt(0.0, 850.0));
        // Refreshing lowers the top limit.
        s.live.refreshing = true;
        assert_eq!(s.limits(size).0, -56.0);
        s.behavior.refresh_indicator = Some(Points(80.0));
        assert_eq!(s.limits(size).0, -80.0);
    }

    #[test]
    fn can_scroll_follows_edges_and_mirroring() {
        let size = sz(300.0, 400.0);
        let mut s = scroll_state((300.0, 1000.0), false);
        s.behavior.enabled = true;
        assert!(s.can_scroll(size, pt(0.0, 10.0)));
        assert!(!s.can_scroll(size, pt(0.0, -10.0)));
        s.y = Points(600.0);
        assert!(!s.can_scroll(size, pt(0.0, 10.0)));
        s.behavior.enabled = false;
        assert!(!s.can_scroll(size, pt(0.0, -10.0)));

        let size = sz(300.0, 100.0);
        let mut row = scroll_state((1000.0, 100.0), true);
        row.behavior.enabled = true;
        row.mirrored = true;
        // Right to left: content past the start is on the left.
        assert!(row.can_scroll(size, pt(-10.0, 0.0)));
        assert!(!row.can_scroll(size, pt(10.0, 0.0)));
        // Vertical wheels move horizontal lists, unmirrored.
        assert!(row.can_scroll(size, pt(0.0, 10.0)));
    }

    #[test]
    fn scroll_by_moves_gestures_along() {
        let drag = shifted(
            Phase::Drag {
                start: 10.0,
                moved: 5.0,
            },
            30.0,
        );
        assert_eq!(
            drag,
            Phase::Drag {
                start: 40.0,
                moved: 5.0
            }
        );
        let anim = Phase::Animate {
            from: 0.0,
            to: 100.0,
            start: 1.0,
            duration: 300.0,
            momentum: false,
            end: true,
        };
        let Phase::Animate { from, to, .. } = shifted(anim, -20.0) else {
            panic!()
        };
        assert_eq!((from, to), (-20.0, 80.0));
        assert_eq!(shifted(Phase::Idle, 5.0), Phase::Idle);
        assert_eq!(
            shifted(Phase::Thumb { start: 10.0 }, 30.0),
            Phase::Thumb { start: 40.0 }
        );
    }

    #[test]
    fn thumb_follows_the_pointer() {
        // The thumb's travel spans the scroll range: moving it by its
        // whole travel scrolls to the end, and it ends that far along.
        let p = Points;
        let (s0, l0) = span(400.0, 1600.0, 0.0).unwrap();
        let travel = 400.0 - 2.0 * INDICATOR_MARGIN - l0;
        let end = thumb_scroll(p(travel), p(1200.0), p(travel)).0;
        assert!((end - 1200.0).abs() < 0.01);
        let (s1, _) = span(400.0, 1600.0, end).unwrap();
        assert!((s1 - s0 - travel).abs() < 0.01);
        assert!(thumb_scroll(p(-10.0), p(1200.0), p(travel)).0 < 0.0);
        assert_eq!(thumb_scroll(p(10.0), p(1200.0), p(0.0)), p(0.0));
    }

    #[test]
    fn thumb_is_grabbed_at_the_edge() {
        let mut s = scroll_state((300.0, 1600.0), false);
        s.indicator = true;
        s.behavior.enabled = true;
        let size = sz(300.0, 400.0);
        let (rect, _) = s.thumb(size).unwrap();
        assert_eq!(rect.origin.x.0, 300.0 - INDICATOR_THICK.0 - 2.0);
        assert!(s.grabs_thumb(size, pt(295.0, 10.0)));
        assert!(!s.grabs_thumb(size, pt(200.0, 10.0)));
        assert!(!s.grabs_thumb(size, pt(295.0, 300.0)));
    }

    #[test]
    fn scroll_keys() {
        assert_eq!(
            vk_key_move(0x28, false, false),
            Some((false, KeyMove::Points(KEY_LINE)))
        );
        assert_eq!(
            vk_key_move(0x25, false, false),
            Some((true, KeyMove::Points(-KEY_LINE)))
        );
        assert_eq!(
            vk_key_move(0x20, true, false),
            Some((false, KeyMove::Pages(-1.0)))
        );
        assert_eq!(
            vk_key_move(0x24, false, true),
            Some((false, KeyMove::Start))
        );
        assert_eq!(vk_key_move(0x28, false, true), None);
        assert_eq!(vk_key_move(b'A' as u16, false, false), None);
        assert_eq!(KeyMove::Start.sign(), -1.0);
        assert_eq!(KeyMove::Pages(1.0).sign(), 1.0);
        assert_eq!(
            key_target(KeyMove::Points(Points(40.0)), 10.0, 400.0, 0.0, 1000.0),
            50.0
        );
        assert_eq!(
            key_target(KeyMove::Pages(1.0), 0.0, 400.0, 0.0, 1000.0),
            350.0
        );
        assert_eq!(
            key_target(KeyMove::Pages(-1.0), 100.0, 400.0, 0.0, 1000.0),
            0.0
        );
        assert_eq!(key_target(KeyMove::End, 0.0, 400.0, 0.0, 1000.0), 1000.0);
        assert_eq!(
            key_target(KeyMove::Start, 500.0, 400.0, -56.0, 1000.0),
            -56.0
        );
    }

    #[test]
    fn reveal_deltas() {
        assert_eq!(reveal_by(100.0, 140.0, 400.0), 0.0);
        assert_eq!(reveal_by(-30.0, 10.0, 400.0), -46.0);
        assert_eq!(reveal_by(380.0, 420.0, 400.0), 36.0);
        // Taller than the viewport: its start shows.
        assert_eq!(reveal_by(200.0, 900.0, 400.0), 184.0);
        assert_eq!(
            reveal_delta(Points(-30.0), Points(10.0), Points(400.0)),
            Points(-46.0)
        );
    }

    #[test]
    fn spinner_spokes() {
        assert_eq!(spokes(Percentage(0.3), Radians(0.0)).count(), 3);
        assert!(spokes(Percentage(0.3), Radians(0.0)).all(|(_, a)| a == 0.8));
        let all: Vec<_> = spokes(Percentage(1.0), Radians(0.0)).collect();
        assert_eq!(all.len(), 8);
        // The leading spoke is the brightest.
        assert_eq!(all[0].1, 1.0);
        assert_eq!(all[1].0, Radians(PI / 4.0));
    }
    #[test]
    fn capture_loss_cancels_only_pointer_phases_without_callbacks() {
        use std::cell::{Cell, RefCell};

        struct Host {
            state: RefCell<ScrollState>,
            redraws: Cell<usize>,
            ticks: Cell<usize>,
        }
        impl ScrollHost for Host {
            fn scroll<R>(&self, f: impl FnOnce(&ScrollState, Size<Points>) -> R) -> Option<R> {
                Some(f(&self.state.borrow(), sz(300.0, 400.0)))
            }
            fn scroll_mut<R>(
                &self,
                f: impl FnOnce(&mut ScrollState, Size<Points>) -> R,
            ) -> Option<R> {
                Some(f(&mut self.state.borrow_mut(), sz(300.0, 400.0)))
            }
            fn now(&self) -> f64 {
                123.0
            }
            fn listens(&self, _: EventKind) -> bool {
                true
            }
            fn event(&self, _: EventKind, _: EventPayload) {
                panic!("capture loss must not send events")
            }
            fn report(&self, _: Point<Points>, _: u32) {
                panic!("capture loss must not report motion")
            }
            fn moved(&self, _: Point<Points>) {
                panic!("capture loss must not move content")
            }
            fn pulled(&self, _: Points) {
                panic!("capture loss must not report a pull")
            }
            fn relayout(&self) {
                panic!("capture loss must not relayout")
            }
            fn redraw(&self) {
                self.redraws.set(self.redraws.get() + 1);
            }
            fn attached(&self) -> bool {
                true
            }
            fn start_ticking(&self) {
                self.ticks.set(self.ticks.get() + 1);
            }
        }
        for phase in [
            Phase::Drag {
                start: 10.0,
                moved: 20.0,
            },
            Phase::Thumb { start: 10.0 },
        ] {
            let mut state = scroll_state((300.0, 1600.0), false);
            state.y = Points(90.0);
            state.live.phase = phase;
            let host = Host {
                state: RefCell::new(state),
                redraws: Cell::new(0),
                ticks: Cell::new(0),
            };
            cancel_pointer(&host);
            {
                let state = host.state.borrow();
                assert_eq!(state.live.phase, Phase::Idle);
                assert_eq!(state.live.shown, 123.0);
                assert_eq!(state.y, Points(90.0));
                assert!(state.live.ticking);
            }
            assert_eq!((host.redraws.get(), host.ticks.get()), (1, 1));
            cancel_pointer(&host);
            assert_eq!((host.redraws.get(), host.ticks.get()), (1, 1));
            let phase = Phase::Glide {
                velocity: 1.0,
                last: 20.0,
            };
            host.state.borrow_mut().live.phase = phase;
            cancel_pointer(&host);
            assert_eq!(host.state.borrow().live.phase, phase);
            assert_eq!((host.redraws.get(), host.ticks.get()), (1, 1));
        }
    }

    #[test]
    fn refresh_follows_its_props() {
        let mut s = scroll_state((300.0, 1000.0), false);
        assert!(!s.behavior.refreshes(Points(-63.0)));
        assert!(s.behavior.refreshes(Points(-64.0)));
        // Pulled 32 of 64: half the spokes, centered in the 56 kept.
        s.y = Points(-32.0);
        assert_eq!(
            s.spinner(Points(300.0), true),
            Some((pt(150.0, 4.0), Percentage(0.5)))
        );
        // The app's own indicator, 100 tall: no spinner, a pull refreshes
        // at its height, which refreshing keeps.
        s.behavior.refresh_indicator = Some(Points(100.0));
        assert!(!s.behavior.refreshes(Points(-64.0)));
        assert!(s.behavior.refreshes(Points(-100.0)));
        assert_eq!(s.behavior.refresh_inset(), Points(100.0));
        assert_eq!(s.spinner(Points(300.0), true), None);
    }

    /// A vertical view 500 tall the tests drive by hand: the clock stays
    /// at 0, frames run when called.
    struct TestHost {
        state: std::cell::RefCell<ScrollState>,
        redraws: std::cell::Cell<u32>,
    }

    impl ScrollHost for TestHost {
        fn scroll<R>(&self, f: impl FnOnce(&ScrollState, Size<Points>) -> R) -> Option<R> {
            Some(f(&self.state.borrow(), sz(300.0, 500.0)))
        }
        fn scroll_mut<R>(&self, f: impl FnOnce(&mut ScrollState, Size<Points>) -> R) -> Option<R> {
            Some(f(&mut self.state.borrow_mut(), sz(300.0, 500.0)))
        }
        fn now(&self) -> f64 {
            0.0
        }
        fn listens(&self, _: EventKind) -> bool {
            true
        }
        fn event(&self, _: EventKind, _: EventPayload) {}
        fn report(&self, _: Point<Points>, _: u32) {}
        fn moved(&self, _: Point<Points>) {}
        fn pulled(&self, _: Points) {}
        fn relayout(&self) {}
        fn redraw(&self) {
            self.redraws.set(self.redraws.get() + 1);
        }
        fn attached(&self) -> bool {
            true
        }
        fn start_ticking(&self) {}
    }

    #[test]
    fn switching_indicators_while_refreshing_keeps_the_new_room() {
        let host = TestHost {
            state: std::cell::RefCell::new(scroll_state((300.0, 1000.0), false)),
            redraws: std::cell::Cell::new(0),
        };
        let own = ScrollBehavior {
            refresh_indicator: Some(Points(72.0)),
            ..Default::default()
        };
        behavior(&host, &own);
        refreshing(&host, true);
        frame(&host, 1000.0);
        assert_eq!(host.state.borrow().y, Points(-72.0));
        // The app drops its own indicator: the spinner draws, in its room.
        let redraws = host.redraws.get();
        behavior(&host, &ScrollBehavior::default());
        assert!(host.redraws.get() > redraws);
        frame(&host, 1000.0);
        assert_eq!(host.state.borrow().y, Points(-56.0));
        // Unchanged props leave it where it is.
        behavior(&host, &ScrollBehavior::default());
        assert!(matches!(host.state.borrow().live.phase, Phase::Idle));
    }
}
