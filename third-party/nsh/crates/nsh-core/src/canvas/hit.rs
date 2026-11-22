//! `isPointInPath` / `isPointInStroke`: hit tests of recorded paths,
//! answered in Rust from the operations (no platform round trip, so JS
//! gets the answer synchronously).
//!
//! The operations recorded before the test are replayed for their
//! geometry only (the transform with `save` / `restore`, the current path,
//! `lineWidth` / `lineCap`); paths are flattened into polylines in view
//! space (curves and arcs to within a quarter point) and tested there.
//! Strokes approximate joins as round and ignore `lineJoin`, miters and
//! line dashes; a stroke under a non-uniform scale uses the transform's
//! mean scale.

use std::f32::consts::{PI, TAU};

use super::{CanvasOp, FillRule, LineCap, Num, PathOp, fit, sweep};
use crate::geometry::{Point, Points};

/// How far flattened curves may stray from the true ones, in points.
const TOLERANCE: f32 = 0.25;

/// An affine transform `[a, b, c, d, e, f]` (canvas order: `x' = a x + c y
/// + e`, `y' = b x + d y + f`).
pub(super) type Matrix = [f32; 6];

pub(super) const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `m` after `n` (`n` applies first): what `cx.transform(n)` makes of `m`.
pub(super) fn mul(m: Matrix, n: Matrix) -> Matrix {
    [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
    ]
}

pub(super) fn apply(m: &Matrix, x: f32, y: f32) -> [f32; 2] {
    [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

pub(super) fn invert(m: &Matrix) -> Option<Matrix> {
    let det = m[0] * m[3] - m[1] * m[2];
    if det == 0.0 || !det.is_finite() {
        return None;
    }
    let (a, b, c, d) = (m[3] / det, -m[1] / det, -m[2] / det, m[0] / det);
    Some([a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])])
}

/// The mean scale of `m` (a length of 1 becomes about this long).
fn scale_of(m: &Matrix) -> f32 {
    (m[0] * m[3] - m[1] * m[2]).abs().sqrt()
}

/// A path flattened into polylines, in view space.
#[derive(Default)]
struct Outline {
    subpaths: Vec<Subpath>,
}

#[derive(Default)]
struct Subpath {
    points: Vec<[f32; 2]>,
    closed: bool,
}

impl Outline {
    fn current(&mut self) -> Option<&mut Subpath> {
        self.subpaths.last_mut().filter(|s| !s.closed)
    }

    fn move_to(&mut self, p: [f32; 2]) {
        if let Some(s) = self.subpaths.last_mut()
            && !s.closed
            && s.points.len() <= 1
        {
            s.points.clear();
            s.points.push(p);
            return;
        }
        self.subpaths.push(Subpath {
            points: vec![p],
            closed: false,
        });
    }

    fn line_to(&mut self, p: [f32; 2]) {
        match self.current() {
            Some(s) => s.points.push(p),
            None => self.move_to(p),
        }
    }

    /// Adds `p` if there is no subpath yet (curves start at their first
    /// control point then, as in canvas).
    fn ensure(&mut self, p: [f32; 2]) {
        if self.current().is_none() {
            self.move_to(p);
        }
    }

    fn last(&self) -> Option<[f32; 2]> {
        self.subpaths
            .last()
            .filter(|s| !s.closed)
            .and_then(|s| s.points.last().copied())
    }

    fn close(&mut self) {
        if let Some(s) = self.subpaths.last_mut()
            && !s.closed
        {
            s.closed = true;
            let start = s.points[0];
            self.subpaths.push(Subpath {
                points: vec![start],
                closed: false,
            });
        }
    }

    /// An elliptical arc around (`cx`, `cy`) in user space, transformed by
    /// `m`: a line to its start when a subpath is open, as in canvas.
    fn arc(
        &mut self,
        m: &Matrix,
        center: [f32; 2],
        radii: [f32; 2],
        rotation: f32,
        start: f32,
        sweep: f32,
    ) {
        let (sr, cr) = rotation.sin_cos();
        let at = |t: f32| {
            let (s, c) = t.sin_cos();
            let (x, y) = (radii[0] * c, radii[1] * s);
            apply(m, center[0] + x * cr - y * sr, center[1] + x * sr + y * cr)
        };
        let r = radii[0].max(radii[1]) * scale_of(m);
        let step = if r > TOLERANCE {
            2.0 * (1.0 - TOLERANCE / r).acos()
        } else {
            PI / 2.0
        };
        let segments = ((sweep.abs() / step).ceil() as usize).clamp(1, 1024);
        self.line_to(at(start));
        for i in 1..=segments {
            self.line_to(at(start + sweep * i as f32 / segments as f32));
        }
    }

    fn curve(&mut self, points: &[[f32; 2]]) {
        let Some(from) = self.last() else {
            return;
        };
        // Enough segments for the control polygon's length.
        let mut length = 0.0;
        let mut prev = from;
        for p in points {
            length += dist(prev, *p);
            prev = *p;
        }
        let segments = ((length / (4.0 * TOLERANCE)).sqrt().ceil() as usize).clamp(1, 512);
        for i in 1..=segments {
            let t = i as f32 / segments as f32;
            let u = 1.0 - t;
            let p = match points {
                [c, p] => [
                    u * u * from[0] + 2.0 * u * t * c[0] + t * t * p[0],
                    u * u * from[1] + 2.0 * u * t * c[1] + t * t * p[1],
                ],
                [c1, c2, p] => [
                    u * u * u * from[0]
                        + 3.0 * u * u * t * c1[0]
                        + 3.0 * u * t * t * c2[0]
                        + t * t * t * p[0],
                    u * u * u * from[1]
                        + 3.0 * u * u * t * c1[1]
                        + 3.0 * u * t * t * c2[1]
                        + t * t * t * p[1],
                ],
                _ => return,
            };
            self.line_to(p);
        }
    }

    /// Adds `op`, transformed by `m`.
    fn add(&mut self, op: &PathOp, m: &Matrix, n: &impl Fn(Num) -> f32) {
        match op {
            PathOp::MoveTo(x, y) => self.move_to(apply(m, n(*x), n(*y))),
            PathOp::LineTo(x, y) => self.line_to(apply(m, n(*x), n(*y))),
            PathOp::QuadTo(v) => {
                let [cx, cy, x, y] = v.map(n);
                let c = apply(m, cx, cy);
                self.ensure(c);
                self.curve(&[c, apply(m, x, y)]);
            }
            PathOp::CubicTo(v) => {
                let [c1x, c1y, c2x, c2y, x, y] = v.map(n);
                let c1 = apply(m, c1x, c1y);
                self.ensure(c1);
                self.curve(&[c1, apply(m, c2x, c2y), apply(m, x, y)]);
            }
            PathOp::Arc {
                x,
                y,
                radius,
                start,
                end,
                ccw,
            } => {
                let r = n(*radius);
                if r < 0.0 {
                    return;
                }
                let start = n(*start);
                let sweep = sweep(start, n(*end), *ccw);
                self.arc(m, [n(*x), n(*y)], [r, r], 0.0, start, sweep);
            }
            PathOp::Ellipse {
                geometry,
                start,
                end,
                ccw,
            } => {
                let [x, y, rx, ry, rotation] = geometry.map(n);
                if rx < 0.0 || ry < 0.0 {
                    return;
                }
                let start = n(*start);
                let sweep = sweep(start, n(*end), *ccw);
                self.arc(m, [x, y], [rx, ry], rotation, start, sweep);
            }
            PathOp::ArcTo(v) => {
                let [x1, y1, x2, y2, r] = v.map(n);
                self.arc_to(m, [x1, y1], [x2, y2], r);
            }
            PathOp::Rect(v) => {
                let [x, y, w, h] = v.map(n);
                self.move_to(apply(m, x, y));
                self.line_to(apply(m, x + w, y));
                self.line_to(apply(m, x + w, y + h));
                self.line_to(apply(m, x, y + h));
                self.close();
            }
            PathOp::RoundRect(rect, radii) => {
                let [x, y, w, h] = rect.map(n);
                let [tl, tr, br, bl] = fit(w, h, radii.map(n));
                // A box with positive sides (the radii keep their corners).
                let (x, w) = if w < 0.0 { (x + w, -w) } else { (x, w) };
                let (y, h) = if h < 0.0 { (y + h, -h) } else { (y, h) };
                self.move_to(apply(m, x + tl, y));
                let corner = |o: &mut Outline, cx: f32, cy: f32, r: f32, from: f32| {
                    if r > 0.0 {
                        o.arc(m, [cx, cy], [r, r], 0.0, from, PI / 2.0);
                    } else {
                        o.line_to(apply(m, cx, cy));
                    }
                };
                corner(self, x + w - tr, y + tr, tr, -PI / 2.0);
                corner(self, x + w - br, y + h - br, br, 0.0);
                corner(self, x + bl, y + h - bl, bl, PI / 2.0);
                corner(self, x + tl, y + tl, tl, PI);
                self.close();
            }
            PathOp::Close => self.close(),
        }
    }

    /// `arcTo`, computed in user space (the current point brought back
    /// through `m`).
    fn arc_to(&mut self, m: &Matrix, p1: [f32; 2], p2: [f32; 2], r: f32) {
        if r < 0.0 {
            return;
        }
        let Some(current) = self.last() else {
            self.move_to(apply(m, p1[0], p1[1]));
            return;
        };
        let Some(inverse) = invert(m) else {
            return;
        };
        let p0 = apply(&inverse, current[0], current[1]);
        let u = norm([p0[0] - p1[0], p0[1] - p1[1]]);
        let v = norm([p2[0] - p1[0], p2[1] - p1[1]]);
        let (Some(u), Some(v)) = (u, v) else {
            self.line_to(apply(m, p1[0], p1[1]));
            return;
        };
        let cross = u[0] * v[1] - u[1] * v[0];
        let cos = (u[0] * v[0] + u[1] * v[1]).clamp(-1.0, 1.0);
        if r == 0.0 || cross.abs() < 1e-6 {
            self.line_to(apply(m, p1[0], p1[1]));
            return;
        }
        let theta = cos.acos();
        let d = r / (theta / 2.0).tan();
        let t1 = [p1[0] + u[0] * d, p1[1] + u[1] * d];
        let t2 = [p1[0] + v[0] * d, p1[1] + v[1] * d];
        let Some(bisector) = norm([u[0] + v[0], u[1] + v[1]]) else {
            return;
        };
        let h = r / (theta / 2.0).sin();
        let c = [p1[0] + bisector[0] * h, p1[1] + bisector[1] * h];
        let a1 = (t1[1] - c[1]).atan2(t1[0] - c[0]);
        let a2 = (t2[1] - c[1]).atan2(t2[0] - c[0]);
        // The short way round, from the first tangent point to the second.
        let mut sweep = (a2 - a1).rem_euclid(TAU);
        if sweep > PI {
            sweep -= TAU;
        }
        self.arc(m, c, [r, r], 0.0, a1, sweep);
    }

    /// Whether `p` is inside the filled area (every subpath closed).
    fn contains(&self, p: [f32; 2], rule: FillRule) -> bool {
        let mut winding = 0i32;
        let mut crossings = 0u32;
        for s in &self.subpaths {
            let n = s.points.len();
            if n < 2 {
                continue;
            }
            for i in 0..n {
                let a = s.points[i];
                let b = s.points[(i + 1) % n];
                // Points on an edge are inside, as in canvas.
                if segment_distance(p, a, b) < 1e-3 {
                    return true;
                }
                if (a[1] <= p[1]) != (b[1] <= p[1]) {
                    let x = a[0] + (p[1] - a[1]) / (b[1] - a[1]) * (b[0] - a[0]);
                    if x > p[0] {
                        crossings += 1;
                        winding += if b[1] > a[1] { 1 } else { -1 };
                    }
                }
            }
        }
        match rule {
            FillRule::NonZero => winding != 0,
            FillRule::EvenOdd => crossings % 2 == 1,
        }
    }

    /// Whether `p` is within `half` of the stroke's centerline.
    fn stroke_contains(&self, p: [f32; 2], half: f32, cap: LineCap) -> bool {
        if half <= 0.0 {
            return false;
        }
        for s in &self.subpaths {
            let n = s.points.len();
            if n < 2 {
                continue;
            }
            let segments = if s.closed { n } else { n - 1 };
            for i in 0..segments {
                let a = s.points[i];
                let b = s.points[(i + 1) % n];
                let (first, last) = (!s.closed && i == 0, !s.closed && i + 1 == segments);
                let (t, d) = project(p, a, b);
                let len = dist(a, b);
                let ext = if cap == LineCap::Square && len > 0.0 {
                    half / len
                } else {
                    0.0
                };
                let inside = if (first && t < 0.0) || (last && t > 1.0) {
                    match cap {
                        // Butt ends stop at the end points.
                        LineCap::Butt => false,
                        LineCap::Square => {
                            t >= -ext && t <= 1.0 + ext && line_distance(p, a, b) <= half
                        }
                        LineCap::Round => d <= half,
                    }
                } else {
                    // Inner joins: round.
                    d <= half
                };
                if inside {
                    return true;
                }
            }
        }
        false
    }
}

fn dist(a: [f32; 2], b: [f32; 2]) -> f32 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

pub(super) fn norm(v: [f32; 2]) -> Option<[f32; 2]> {
    let l = v[0].hypot(v[1]);
    (l > 1e-9).then(|| [v[0] / l, v[1] / l])
}

/// Where `p` projects onto the line through `a` and `b` (0 at `a`, 1 at
/// `b`), and its distance to the segment.
fn project(p: [f32; 2], a: [f32; 2], b: [f32; 2]) -> (f32, f32) {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    if l2 == 0.0 {
        return (0.0, dist(p, a));
    }
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
    let c = t.clamp(0.0, 1.0);
    (t, dist(p, [a[0] + c * dx, a[1] + c * dy]))
}

fn segment_distance(p: [f32; 2], a: [f32; 2], b: [f32; 2]) -> f32 {
    project(p, a, b).1
}

fn line_distance(p: [f32; 2], a: [f32; 2], b: [f32; 2]) -> f32 {
    let l = dist(a, b);
    if l == 0.0 {
        return dist(p, a);
    }
    ((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])).abs() / l
}

/// The geometry state of a replay.
#[derive(Clone, Copy)]
struct State {
    ctm: Matrix,
    line_width: f32,
    cap: LineCap,
}

/// Replays `ops` for their transform, current path and line style.
fn replay(ops: &[CanvasOp], n: &impl Fn(Num) -> f32) -> (State, Outline) {
    let mut state = State {
        ctm: IDENTITY,
        line_width: 1.0,
        cap: LineCap::Butt,
    };
    let mut stack = Vec::new();
    let mut path = Outline::default();
    for op in ops {
        match op {
            CanvasOp::Save => stack.push(state),
            CanvasOp::Restore => {
                if let Some(s) = stack.pop() {
                    state = s;
                }
            }
            CanvasOp::Translate(x, y) => {
                state.ctm = mul(state.ctm, [1.0, 0.0, 0.0, 1.0, n(*x), n(*y)]);
            }
            CanvasOp::Scale(x, y) => {
                state.ctm = mul(state.ctm, [n(*x), 0.0, 0.0, n(*y), 0.0, 0.0]);
            }
            CanvasOp::Rotate(a) => {
                let (s, c) = n(*a).sin_cos();
                state.ctm = mul(state.ctm, [c, s, -s, c, 0.0, 0.0]);
            }
            CanvasOp::Transform(v) => state.ctm = mul(state.ctm, v.map(n)),
            CanvasOp::SetTransform(v) => state.ctm = v.map(n),
            CanvasOp::BeginPath => path = Outline::default(),
            CanvasOp::Path(op) => path.add(op, &state.ctm, n),
            CanvasOp::LineWidth(w) => {
                let w = n(*w);
                if w.is_finite() && w > 0.0 {
                    state.line_width = w;
                }
            }
            CanvasOp::LineCap(c) => state.cap = *c,
            _ => {}
        }
    }
    (state, path)
}

/// The outline to test: `path` under the current transform, or the
/// current path.
fn outline(
    state: &State,
    current: Outline,
    path: Option<&[PathOp]>,
    n: &impl Fn(Num) -> f32,
) -> Outline {
    match path {
        Some(ops) => {
            let mut o = Outline::default();
            for op in ops {
                o.add(op, &state.ctm, n);
            }
            o
        }
        None => current,
    }
}

/// `cx.isPointInPath([path,] x, y, rule)`: whether `point` (view
/// coordinates, untransformed) is inside `path` (transformed by the
/// transform after `ops`) or, without one, the current path after `ops`.
/// Animated values (`Num::Slot`) are read through `slot`.
pub fn point_in_path(
    ops: &[CanvasOp],
    path: Option<&[PathOp]>,
    rule: FillRule,
    point: Point<Points>,
    slot: impl Fn(u16) -> f32,
) -> bool {
    let n = |v: Num| v.get(&slot);
    let (state, current) = replay(ops, &n);
    outline(&state, current, path, &n).contains([point.x.0, point.y.0], rule)
}

/// `cx.isPointInStroke([path,] x, y)`: whether `point` is on the
/// stroke of `path` or the current path with the `lineWidth` and `lineCap`
/// after `ops` ([`point_in_path`]'s coordinates).
pub fn point_in_stroke(
    ops: &[CanvasOp],
    path: Option<&[PathOp]>,
    point: Point<Points>,
    slot: impl Fn(u16) -> f32,
) -> bool {
    let n = |v: Num| v.get(&slot);
    let (state, current) = replay(ops, &n);
    let half = state.line_width * scale_of(&state.ctm) / 2.0;
    outline(&state, current, path, &n).stroke_contains([point.x.0, point.y.0], half, state.cap)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(v: f32) -> Num {
        Num::Const(v)
    }

    fn pt(x: f32, y: f32) -> Point<Points> {
        crate::geometry::point(Points(x), Points(y))
    }

    fn zero(_: u16) -> f32 {
        0.0
    }

    #[test]
    fn fills_follow_the_rule() {
        // Two nested squares drawn the same way round.
        let path = [
            PathOp::Rect([c(0.0), c(0.0), c(100.0), c(100.0)]),
            PathOp::Rect([c(25.0), c(25.0), c(50.0), c(50.0)]),
        ];
        let hit = |rule, x, y| point_in_path(&[], Some(&path), rule, pt(x, y), zero);
        assert!(hit(FillRule::NonZero, 50.0, 50.0));
        assert!(!hit(FillRule::EvenOdd, 50.0, 50.0));
        assert!(hit(FillRule::EvenOdd, 10.0, 10.0));
        assert!(!hit(FillRule::NonZero, 150.0, 50.0));
        // On the edge.
        assert!(hit(FillRule::NonZero, 100.0, 50.0));
    }

    #[test]
    fn arcs_curves_and_round_rects_are_flattened() {
        let circle = [PathOp::Arc {
            x: c(50.0),
            y: c(50.0),
            radius: c(20.0),
            start: c(0.0),
            end: c(TAU),
            ccw: false,
        }];
        let hit = |path: &[PathOp], x, y| {
            point_in_path(&[], Some(path), FillRule::NonZero, pt(x, y), zero)
        };
        assert!(hit(&circle, 50.0, 69.0));
        assert!(!hit(&circle, 64.5, 64.5));
        let rounded = [PathOp::RoundRect(
            [c(0.0), c(0.0), c(100.0), c(50.0)],
            [c(20.0); 4],
        )];
        assert!(!hit(&rounded, 2.0, 2.0));
        assert!(hit(&rounded, 20.0, 2.0));
        let curve = [
            PathOp::MoveTo(c(0.0), c(0.0)),
            PathOp::QuadTo([c(50.0), c(100.0), c(100.0), c(0.0)]),
            PathOp::Close,
        ];
        assert!(hit(&curve, 50.0, 40.0));
        assert!(!hit(&curve, 50.0, 60.0));
    }

    #[test]
    fn the_transform_and_current_path_come_from_the_recording() {
        let ops = [
            CanvasOp::Translate(c(100.0), c(0.0)),
            CanvasOp::Scale(c(2.0), c(2.0)),
            CanvasOp::BeginPath,
            CanvasOp::Path(PathOp::Rect([c(0.0), c(0.0), c(10.0), c(10.0)])),
            CanvasOp::Save,
            CanvasOp::SetTransform([c(1.0), c(0.0), c(0.0), c(1.0), c(0.0), c(0.0)]),
            CanvasOp::Restore,
        ];
        // The current path was transformed when it was added.
        let hit = |x, y| point_in_path(&ops, None, FillRule::NonZero, pt(x, y), zero);
        assert!(hit(115.0, 15.0));
        assert!(!hit(5.0, 5.0));
        // A path is transformed by the transform now.
        let path = [PathOp::Rect([c(0.0), c(0.0), c(10.0), c(10.0)])];
        assert!(point_in_path(
            &ops,
            Some(&path),
            FillRule::NonZero,
            pt(119.0, 19.0),
            zero
        ));
        // Animated values read through `slot`.
        let path = [PathOp::Rect([Num::Slot(0), c(0.0), c(10.0), c(10.0)])];
        assert!(point_in_path(
            &[],
            Some(&path),
            FillRule::NonZero,
            pt(55.0, 5.0),
            |_| 50.0
        ));
    }

    #[test]
    fn strokes_use_the_line_width_and_caps() {
        let line = [
            PathOp::MoveTo(c(0.0), c(0.0)),
            PathOp::LineTo(c(100.0), c(0.0)),
        ];
        let width = |w| [CanvasOp::LineWidth(c(w))];
        let hit = |ops: &[CanvasOp], x, y| point_in_stroke(ops, Some(&line), pt(x, y), zero);
        assert!(hit(&width(10.0), 50.0, 4.0));
        assert!(!hit(&width(10.0), 50.0, 6.0));
        assert!(!hit(&width(1.0), 50.0, 4.0));
        // Butt ends stop at the end point; round and square ones do not.
        assert!(!hit(&width(10.0), -3.0, 0.0));
        let capped = |cap| [CanvasOp::LineWidth(c(10.0)), CanvasOp::LineCap(cap)];
        assert!(hit(&capped(LineCap::Round), -3.0, 0.0));
        assert!(hit(&capped(LineCap::Square), -4.0, 4.0));
        assert!(!hit(&capped(LineCap::Round), -4.0, 4.0));
        // Scaled with the transform.
        let scaled = [CanvasOp::Scale(c(4.0), c(4.0))];
        assert!(hit(&scaled, 200.0, 1.5));
        // `arcTo` rounds the corner between its tangents.
        let corner = [
            PathOp::MoveTo(c(0.0), c(0.0)),
            PathOp::ArcTo([c(100.0), c(0.0), c(100.0), c(100.0), c(50.0)]),
        ];
        let hit = |x, y| point_in_stroke(&[], Some(&corner), pt(x, y), zero);
        assert!(hit(50.0, 0.0));
        assert!(hit(
            50.0 + 50.0 * (PI / 4.0).cos(),
            50.0 - 50.0 * (PI / 4.0).sin()
        ));
        assert!(!hit(99.0, 1.0));
    }
}
