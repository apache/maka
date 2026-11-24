//! A mouse wheel's smooth scroll, as Chromium animates one
//! (`cc/animation/scroll_offset_animation_curve.cc`, `ScrollType::kMouseWheel`):
//! each step eases in and out (`cubic-bezier(0.42, 0, 0.58, 1)`) to its
//! target over 100–200 ms, shorter the farther it goes; a step during the
//! glide moves the target on by its delta and starts a new segment from
//! where the glide is, at the speed it has there, so a run of steps flows
//! into one motion instead of restarting each time. Without it every step
//! landed at once, a jump per event. Times are ms, offsets points.
//!
//! `smoothWheel` glides a scroll view's notches with it on every desktop:
//! the shared scroll views (Linux, Windows, GPUI: [`super::wheel_smooth`])
//! and macOS's own.

use crate::geometry::{Point, Points, point};

/// An offset or a change of one (points).
#[derive(Debug, Default, Clone, Copy, PartialEq)]
struct Offset {
    x: f32,
    y: f32,
}

impl Offset {
    fn lerp(self, to: Self, k: f32) -> Self {
        Self {
            x: self.x + (to.x - self.x) * k,
            y: self.y + (to.y - self.y) * k,
        }
    }
}

impl std::ops::Add for Offset {
    type Output = Self;

    fn add(self, o: Self) -> Self {
        Self {
            x: self.x + o.x,
            y: self.y + o.y,
        }
    }
}

impl std::ops::Sub for Offset {
    type Output = Self;

    fn sub(self, o: Self) -> Self {
        Self {
            x: self.x - o.x,
            y: self.y - o.y,
        }
    }
}

impl From<Point<Points>> for Offset {
    fn from(p: Point<Points>) -> Self {
        Self { x: p.x.0, y: p.y.0 }
    }
}

impl From<Offset> for Point<Points> {
    fn from(o: Offset) -> Self {
        point(Points(o.x), Points(o.y))
    }
}

/// One 60 Hz frame (ms): Chromium counts its durations in them.
const FRAME: f64 = 1000.0 / 60.0;
/// Chromium's `kInverseDelta*`: steps up to 120 points take 12 frames,
/// from 480 points 6, linearly between.
const RAMP_START: f64 = 120.0;
const RAMP_END: f64 = 480.0;
const MIN_FRAMES: f64 = 6.0;
const MAX_FRAMES: f64 = 12.0;
/// The ease-in-out curve's control points (`kEaseInOutControlPoints`).
const X1: f64 = 0.42;
const X2: f64 = 0.58;
const Y2: f64 = 1.0;
/// Chromium's `kEpsilon` (points, and seconds for durations).
const EPSILON: f64 = 0.01;

/// The glide in flight. `target` is kept by the caller (the wheel phase's
/// `raw`), so a shift of the content moves it with the rest.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct Glide {
    /// Where the current segment starts.
    initial: Offset,
    /// The curve's time origin (ms, the frames' clock).
    start: f64,
    /// When the current segment began, from `start`.
    retarget: f64,
    /// When it ends, from `start`.
    total: f64,
    /// The segment's first control point's y: 0, or what carries the
    /// previous segment's speed on.
    y1: f64,
}

/// The larger component, with its sign (`MaximumDimension`).
fn major(d: Offset) -> f64 {
    if d.x.abs() > d.y.abs() {
        d.x as f64
    } else {
        d.y as f64
    }
}

/// How long a segment of `delta` takes, less what it is late by
/// (`EaseInOutSegmentDuration`, `kInverseDelta`).
fn segment(delta: Offset, late: f64) -> f64 {
    let slope = (MIN_FRAMES - MAX_FRAMES) / (RAMP_END - RAMP_START);
    let offset = MAX_FRAMES - RAMP_START * slope;
    let frames = (offset + major(delta).abs() * slope).clamp(MIN_FRAMES, MAX_FRAMES);
    (frames * FRAME - late).max(0.0)
}

impl Glide {
    /// A glide from `initial` to `target` starting `now`: one frame in
    /// already, as Chromium starts it (`animation_start_offset`), so the
    /// first frame drawn has moved.
    pub fn new(initial: Point<Points>, target: Point<Points>, now: f64) -> Self {
        let (initial, target) = (Offset::from(initial), Offset::from(target));
        Self {
            initial,
            start: now - FRAME,
            retarget: 0.0,
            total: segment(target - initial, 0.0),
            y1: 0.0,
        }
    }

    /// When it arrives (ms, the frames' clock).
    pub fn end(&self) -> f64 {
        self.start + self.total
    }

    /// Moved with the content by `d` (`ApplyAdjustment`).
    pub fn shifted(self, d: Point<Points>) -> Self {
        Self {
            initial: self.initial + d.into(),
            ..self
        }
    }

    fn curve(&self) -> Bezier {
        Bezier::new(X1, self.y1, X2, Y2)
    }

    /// Where it is at `now` on its way to `target` (`GetValue`).
    pub fn value(&self, target: Point<Points>, now: f64) -> Point<Points> {
        self.at(target.into(), now).into()
    }

    fn at(&self, target: Offset, now: f64) -> Offset {
        let duration = self.total - self.retarget;
        let t = now - self.start - self.retarget;
        if duration <= 0.0 || t >= duration {
            return target;
        }
        if t <= 0.0 {
            return self.initial;
        }
        let p = self.curve().solve(t / duration);
        self.initial.lerp(target, p as f32)
    }

    /// Its speed at curve time `t` (points per second, `CalculateVelocity`).
    fn velocity(&self, target: Offset, t: f64) -> f64 {
        let duration = self.total - self.retarget;
        if duration <= 0.0 {
            return 0.0;
        }
        let slope = self.curve().velocity((t - self.retarget) / duration);
        slope * (major(target - self.initial) / (duration / 1000.0))
    }

    /// A step during the glide moved its target from `old` to `new` at
    /// `now` (`UpdateTarget`).
    pub fn retargeted(self, old: Point<Points>, new: Point<Points>, now: f64) -> Self {
        self.moved_on(old.into(), new.into(), now)
    }

    fn moved_on(mut self, old: Offset, new: Offset, now: f64) -> Self {
        let mut t = now - self.start;
        let late = (self.retarget - t).max(0.0);
        t = t.max(self.retarget);
        if major(old - new).abs() < EPSILON {
            return self;
        }
        let here = self.at(old, self.start + t);
        let delta = new - here;
        if major(delta).abs() < EPSILON {
            self.initial = here;
            self.retarget = t;
            self.total = t;
            return self;
        }
        let old_duration = self.total - self.retarget;
        if old_duration <= 0.0 {
            self.total = segment(delta, late);
            return self;
        }
        let velocity = self.velocity(old, t);
        // The speed it has bounds the new segment's length (less "rubber
        // band" when a fast glide gets a short step)
        let bound = if velocity.abs() < EPSILON {
            f64::INFINITY
        } else {
            let b = major(delta) / velocity * 2.5 * 1000.0;
            if b < 0.0 { f64::INFINITY } else { b }
        };
        let duration = segment(delta, late).min(bound);
        if duration / 1000.0 < EPSILON {
            self.total = t;
            return self;
        }
        // The new segment starts at the speed the old one had there
        let slope = (velocity * (duration / 1000.0) / major(delta)).clamp(-1000.0, 1000.0);
        self.y1 = X1 * slope;
        self.initial = here;
        self.retarget = t;
        self.total = t + duration;
        self
    }
}

/// A cubic Bézier timing function from (0, 0) to (1, 1) (`gfx::CubicBezier`).
struct Bezier {
    ax: f64,
    bx: f64,
    cx: f64,
    ay: f64,
    by: f64,
    cy: f64,
}

impl Bezier {
    fn new(x1: f64, y1: f64, x2: f64, y2: f64) -> Self {
        let cx = 3.0 * x1;
        let bx = 3.0 * (x2 - x1) - cx;
        let cy = 3.0 * y1;
        let by = 3.0 * (y2 - y1) - cy;
        Self {
            ax: 1.0 - cx - bx,
            bx,
            cx,
            ay: 1.0 - cy - by,
            by,
            cy,
        }
    }

    fn x(&self, t: f64) -> f64 {
        ((self.ax * t + self.bx) * t + self.cx) * t
    }

    fn y(&self, t: f64) -> f64 {
        ((self.ay * t + self.by) * t + self.cy) * t
    }

    fn dx(&self, t: f64) -> f64 {
        (3.0 * self.ax * t + 2.0 * self.bx) * t + self.cx
    }

    fn dy(&self, t: f64) -> f64 {
        (3.0 * self.ay * t + 2.0 * self.by) * t + self.cy
    }

    /// The curve's parameter where its x is `x`: Newton, then bisection.
    fn t_for(&self, x: f64) -> f64 {
        let mut t = x;
        for _ in 0..8 {
            let err = self.x(t) - x;
            if err.abs() < 1e-7 {
                return t;
            }
            let d = self.dx(t);
            if d.abs() < 1e-6 {
                break;
            }
            t -= err / d;
        }
        let (mut lo, mut hi) = (0.0, 1.0);
        t = x;
        while lo < hi {
            let v = self.x(t);
            if (v - x).abs() < 1e-7 {
                return t;
            }
            if x > v {
                lo = t
            } else {
                hi = t
            }
            t = (hi - lo) / 2.0 + lo;
            if hi - lo < 1e-9 {
                break;
            }
        }
        t
    }

    /// Progress at time fraction `x`.
    fn solve(&self, x: f64) -> f64 {
        self.y(self.t_for(x.clamp(0.0, 1.0)))
    }

    /// The curve's slope (progress per time fraction) at `x`.
    fn velocity(&self, x: f64) -> f64 {
        let t = self.t_for(x.clamp(0.0, 1.0));
        let dx = self.dx(t);
        if dx.abs() < 1e-9 {
            0.0
        } else {
            self.dy(t) / dx
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn y(v: f32) -> Offset {
        Offset { x: 0.0, y: v }
    }

    #[test]
    fn durations_follow_the_step() {
        let d = |v: f32| segment(y(v), 0.0);
        assert!((d(40.0) - 200.0).abs() < 0.01);
        assert!((d(300.0) - 150.0).abs() < 0.01);
        assert!((d(1000.0) - 100.0).abs() < 0.01);
    }

    #[test]
    fn eases_in_and_out_and_arrives() {
        let to = y(100.0);
        let g = Glide::new(Offset::default().into(), to.into(), 0.0);
        assert_eq!(g.at(to, -FRAME), Offset::default());
        let mid = g.at(to, g.start + g.total / 2.0).y;
        assert!((mid - 50.0).abs() < 0.5);
        assert_eq!(g.at(to, g.end()), to);
    }

    #[test]
    fn a_step_mid_glide_keeps_its_speed() {
        let (a, b) = (y(100.0), y(200.0));
        let g = Glide::new(Offset::default().into(), a.into(), 0.0);
        let now = g.start + g.total / 2.0;
        let before = g.velocity(a, now - g.start);
        let h = g.moved_on(a, b, now);
        assert!((h.at(b, now).y - g.at(a, now).y).abs() < 0.01);
        let after = h.velocity(b, now - h.start);
        assert!((after - before).abs() / before < 0.02, "{before} {after}");
        assert_eq!(h.at(b, h.end()), b);
    }
}
