//! Canvas paths flattened to polylines in the canvas view's points, and the
//! geometry the dot grid samples from them: the spans a fill rule puts
//! inside a path on a horizontal line, and dash patterns along a stroke.

use std::f32::consts::{PI, TAU};

use nsh_core::{
    Corners, Points, Size,
    canvas::{FillRule, Num, PathOp, arc_sweep, fit_radii},
    geometry::Radians,
};

/// How far flattened curves may stray from the true ones, in points; a
/// braille dot is several points across, so this never shows.
const TOLERANCE: f32 = 0.5;

const MAX_ARC_SEGMENTS: usize = 1024;
const MAX_CURVE_SEGMENTS: usize = 512;

/// An affine transform `[a, b, c, d, e, f]` in canvas order: `x' = a x + c y
/// + e`, `y' = b x + d y + f`.
pub(crate) type Matrix = [f32; 6];

pub(crate) const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `m` after `n` (`n` applies first): what `cx.transform(n)` makes of `m`.
pub(crate) fn multiply(m: Matrix, n: Matrix) -> Matrix {
    [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
    ]
}

pub(crate) fn apply(m: &Matrix, x: f32, y: f32) -> [f32; 2] {
    [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

/// The mean scale of `m`: a length of 1 becomes about this long.
pub(crate) fn mean_scale(m: &Matrix) -> f32 {
    (m[0] * m[3] - m[1] * m[2]).abs().sqrt()
}

fn invert(m: &Matrix) -> Option<Matrix> {
    let determinant = m[0] * m[3] - m[1] * m[2];
    if determinant == 0.0 || !determinant.is_finite() {
        return None;
    }
    let (a, b, c, d) = (
        m[3] / determinant,
        -m[1] / determinant,
        -m[2] / determinant,
        m[0] / determinant,
    );
    Some([a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])])
}

pub(crate) fn distance(a: [f32; 2], b: [f32; 2]) -> f32 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

fn normalized(v: [f32; 2]) -> Option<[f32; 2]> {
    let length = v[0].hypot(v[1]);
    (length > 1e-9).then(|| [v[0] / length, v[1] / length])
}

/// A path flattened into polylines, in the view's points.
#[derive(Debug, Default)]
pub(crate) struct Outline {
    pub(crate) subpaths: Vec<Subpath>,
}

#[derive(Debug, Default)]
pub(crate) struct Subpath {
    pub(crate) points: Vec<[f32; 2]>,
    pub(crate) closed: bool,
}

impl Outline {
    /// `ops` under the transform `m`, numbers read through `n`.
    pub(crate) fn of(ops: &[PathOp], m: &Matrix, n: &impl Fn(Num) -> f32) -> Self {
        let mut outline = Self::default();
        for op in ops {
            outline.add(op, m, n);
        }
        outline
    }

    /// The rectangle `[x, y, w, h]` under `m`, as `rect()` adds it.
    pub(crate) fn rect(rect: [f32; 4], m: &Matrix) -> Self {
        let mut outline = Self::default();
        outline.add_rect(rect, m);
        outline
    }

    fn open_subpath(&mut self) -> Option<&mut Subpath> {
        self.subpaths.last_mut().filter(|s| !s.closed)
    }

    fn move_to(&mut self, p: [f32; 2]) {
        if let Some(subpath) = self.open_subpath()
            && subpath.points.len() <= 1
        {
            subpath.points.clear();
            subpath.points.push(p);
            return;
        }
        self.subpaths.push(Subpath {
            points: vec![p],
            closed: false,
        });
    }

    fn line_to(&mut self, p: [f32; 2]) {
        match self.open_subpath() {
            Some(subpath) => subpath.points.push(p),
            None => self.move_to(p),
        }
    }

    /// Curves without a subpath start at their first control point, as in
    /// canvas.
    fn ensure_subpath(&mut self, p: [f32; 2]) {
        if self.open_subpath().is_none() {
            self.move_to(p);
        }
    }

    fn last_point(&self) -> Option<[f32; 2]> {
        self.subpaths
            .last()
            .filter(|s| !s.closed)
            .and_then(|s| s.points.last().copied())
    }

    fn close(&mut self) {
        if let Some(subpath) = self.open_subpath() {
            subpath.closed = true;
            let start = subpath.points[0];
            self.subpaths.push(Subpath {
                points: vec![start],
                closed: false,
            });
        }
    }

    /// An elliptical arc in user space, transformed by `m`; a line joins it
    /// to an open subpath, as in canvas.
    fn arc(
        &mut self,
        m: &Matrix,
        center: [f32; 2],
        radii: [f32; 2],
        rotation: f32,
        start: f32,
        sweep: f32,
    ) {
        let (rotation_sin, rotation_cos) = rotation.sin_cos();
        let at = |t: f32| {
            let (sin, cos) = t.sin_cos();
            let (x, y) = (radii[0] * cos, radii[1] * sin);
            apply(
                m,
                center[0] + x * rotation_cos - y * rotation_sin,
                center[1] + x * rotation_sin + y * rotation_cos,
            )
        };
        let radius = radii[0].max(radii[1]) * mean_scale(m);
        let step = if radius > TOLERANCE {
            2.0 * (1.0 - TOLERANCE / radius).acos()
        } else {
            PI / 2.0
        };
        let segments = ((sweep.abs() / step).ceil() as usize).clamp(1, MAX_ARC_SEGMENTS);
        self.line_to(at(start));
        for i in 1..=segments {
            self.line_to(at(start + sweep * i as f32 / segments as f32));
        }
    }

    /// A quadratic (`[control, end]`) or cubic (`[control, control, end]`)
    /// Bézier curve from the current point.
    fn curve(&mut self, points: &[[f32; 2]]) {
        let Some(from) = self.last_point() else {
            return;
        };
        let mut polygon_length = 0.0;
        let mut previous = from;
        for &p in points {
            polygon_length += distance(previous, p);
            previous = p;
        }
        let segments = ((polygon_length / (4.0 * TOLERANCE)).sqrt().ceil() as usize)
            .clamp(1, MAX_CURVE_SEGMENTS);
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

    fn add_rect(&mut self, [x, y, w, h]: [f32; 4], m: &Matrix) {
        self.move_to(apply(m, x, y));
        self.line_to(apply(m, x + w, y));
        self.line_to(apply(m, x + w, y + h));
        self.line_to(apply(m, x, y + h));
        self.close();
    }

    pub(crate) fn add(&mut self, op: &PathOp, m: &Matrix, n: &impl Fn(Num) -> f32) {
        match op {
            PathOp::MoveTo(x, y) => self.move_to(apply(m, n(*x), n(*y))),
            PathOp::LineTo(x, y) => self.line_to(apply(m, n(*x), n(*y))),
            PathOp::QuadTo(v) => {
                let [cx, cy, x, y] = v.map(n);
                let control = apply(m, cx, cy);
                self.ensure_subpath(control);
                self.curve(&[control, apply(m, x, y)]);
            }
            PathOp::CubicTo(v) => {
                let [c1x, c1y, c2x, c2y, x, y] = v.map(n);
                let first = apply(m, c1x, c1y);
                self.ensure_subpath(first);
                self.curve(&[first, apply(m, c2x, c2y), apply(m, x, y)]);
            }
            PathOp::Arc {
                x,
                y,
                radius,
                start,
                end,
                ccw,
            } => {
                let radius = n(*radius);
                if radius < 0.0 {
                    return;
                }
                let start = n(*start);
                let sweep = arc_sweep(Radians(start), Radians(n(*end)), *ccw).0;
                self.arc(m, [n(*x), n(*y)], [radius, radius], 0.0, start, sweep);
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
                let sweep = arc_sweep(Radians(start), Radians(n(*end)), *ccw).0;
                self.arc(m, [x, y], [rx, ry], rotation, start, sweep);
            }
            PathOp::ArcTo(v) => {
                let [x1, y1, x2, y2, radius] = v.map(n);
                self.arc_to(m, [x1, y1], [x2, y2], radius);
            }
            PathOp::Rect(v) => self.add_rect(v.map(n), m),
            PathOp::RoundRect(rect, radii) => {
                let [x, y, w, h] = rect.map(n);
                let [top_left, top_right, bottom_right, bottom_left] = radii.map(n).map(Points);
                let fitted = fit_radii(
                    Size::new(Points(w), Points(h)),
                    Corners {
                        top_left,
                        top_right,
                        bottom_right,
                        bottom_left,
                    },
                );
                let (x, w) = if w < 0.0 { (x + w, -w) } else { (x, w) };
                let (y, h) = if h < 0.0 { (y + h, -h) } else { (y, h) };
                self.move_to(apply(m, x + fitted.top_left.0, y));
                let corners = [
                    (
                        x + w - fitted.top_right.0,
                        y + fitted.top_right.0,
                        fitted.top_right.0,
                        -PI / 2.0,
                    ),
                    (
                        x + w - fitted.bottom_right.0,
                        y + h - fitted.bottom_right.0,
                        fitted.bottom_right.0,
                        0.0,
                    ),
                    (
                        x + fitted.bottom_left.0,
                        y + h - fitted.bottom_left.0,
                        fitted.bottom_left.0,
                        PI / 2.0,
                    ),
                    (
                        x + fitted.top_left.0,
                        y + fitted.top_left.0,
                        fitted.top_left.0,
                        PI,
                    ),
                ];
                for (cx, cy, radius, from) in corners {
                    if radius > 0.0 {
                        self.arc(m, [cx, cy], [radius, radius], 0.0, from, PI / 2.0);
                    } else {
                        self.line_to(apply(m, cx, cy));
                    }
                }
                self.close();
            }
            PathOp::Close => self.close(),
        }
    }

    /// `arcTo`, computed in user space (the current point brought back
    /// through `m`).
    fn arc_to(&mut self, m: &Matrix, p1: [f32; 2], p2: [f32; 2], radius: f32) {
        if radius < 0.0 {
            return;
        }
        let Some(current) = self.last_point() else {
            self.move_to(apply(m, p1[0], p1[1]));
            return;
        };
        let Some(inverse) = invert(m) else {
            return;
        };
        let p0 = apply(&inverse, current[0], current[1]);
        let towards_start = normalized([p0[0] - p1[0], p0[1] - p1[1]]);
        let towards_end = normalized([p2[0] - p1[0], p2[1] - p1[1]]);
        let (Some(u), Some(v)) = (towards_start, towards_end) else {
            self.line_to(apply(m, p1[0], p1[1]));
            return;
        };
        let cross = u[0] * v[1] - u[1] * v[0];
        if radius == 0.0 || cross.abs() < 1e-6 {
            self.line_to(apply(m, p1[0], p1[1]));
            return;
        }
        let theta = (u[0] * v[0] + u[1] * v[1]).clamp(-1.0, 1.0).acos();
        let tangent_distance = radius / (theta / 2.0).tan();
        let t1 = [
            p1[0] + u[0] * tangent_distance,
            p1[1] + u[1] * tangent_distance,
        ];
        let t2 = [
            p1[0] + v[0] * tangent_distance,
            p1[1] + v[1] * tangent_distance,
        ];
        let Some(bisector) = normalized([u[0] + v[0], u[1] + v[1]]) else {
            return;
        };
        let center_distance = radius / (theta / 2.0).sin();
        let center = [
            p1[0] + bisector[0] * center_distance,
            p1[1] + bisector[1] * center_distance,
        ];
        let a1 = (t1[1] - center[1]).atan2(t1[0] - center[0]);
        let a2 = (t2[1] - center[1]).atan2(t2[0] - center[0]);
        let mut sweep = (a2 - a1).rem_euclid(TAU);
        if sweep > PI {
            sweep -= TAU;
        }
        self.arc(m, center, [radius, radius], 0.0, a1, sweep);
    }

    /// The x intervals inside the path on the horizontal line at `y`, by
    /// `rule`, every subpath closed (as fills close them), into `spans`.
    /// A crossing counts when the edge's ends lie on different sides of
    /// the line, the lower end included, so a vertex on the line counts
    /// once.
    pub(crate) fn spans(&self, y: f32, rule: FillRule, spans: &mut Vec<(f32, f32)>) {
        spans.clear();
        let mut crossings: Vec<(f32, i32)> = Vec::new();
        for subpath in &self.subpaths {
            let count = subpath.points.len();
            if count < 2 {
                continue;
            }
            for i in 0..count {
                let a = subpath.points[i];
                let b = subpath.points[(i + 1) % count];
                if (a[1] <= y) != (b[1] <= y) {
                    let x = a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]);
                    if x.is_finite() {
                        crossings.push((x, if b[1] > a[1] { 1 } else { -1 }));
                    }
                }
            }
        }
        crossings.sort_unstable_by(|a, b| a.0.total_cmp(&b.0));
        let mut winding = 0;
        let mut parity = 0;
        let mut start = 0.0;
        let inside = |winding: i32, parity: i32| match rule {
            FillRule::NonZero => winding != 0,
            FillRule::EvenOdd => parity % 2 == 1,
        };
        for (x, direction) in crossings {
            let was_inside = inside(winding, parity);
            winding += direction;
            parity += 1;
            match (was_inside, inside(winding, parity)) {
                (false, true) => start = x,
                (true, false) => spans.push((start, x)),
                _ => {}
            }
        }
    }
}

/// A `setLineDash` pattern in the view's points: which lengths along a
/// subpath are drawn.
pub(crate) struct Dash {
    pattern: Vec<f32>,
    period: f32,
    offset: f32,
}

impl Dash {
    /// The pattern `segments` (user space, an odd count repeated as in
    /// canvas) starting `offset` into it, under a transform of mean scale
    /// `scale`; `None` draws solid lines, as canvas does for an empty or
    /// all-zero pattern.
    pub(crate) fn new(segments: &[Points], offset: f32, scale: f32) -> Option<Self> {
        if segments.iter().any(|s| !s.0.is_finite() || s.0 < 0.0) {
            return None;
        }
        let mut pattern: Vec<f32> = segments.iter().map(|s| s.0 * scale).collect();
        if pattern.len() % 2 == 1 {
            pattern.extend_from_within(..);
        }
        let period: f32 = pattern.iter().sum();
        (period > 0.0 && period.is_finite()).then_some(Self {
            pattern,
            period,
            offset: offset * scale,
        })
    }

    /// The pattern scaled up, in proportion, until its shortest dash or
    /// gap is `length` (none shorter is left as it is). Sampled at dot
    /// centers, a dash or gap shorter than two dots alternates single
    /// dots: a dotted line, which reads as a denser row of a dot grid
    /// rather than as dashes.
    pub(crate) fn at_least(mut self, length: f32) -> Self {
        let shortest = self
            .pattern
            .iter()
            .copied()
            .filter(|&s| s > 0.0)
            .fold(f32::INFINITY, f32::min);
        if shortest < length && length.is_finite() {
            let scale = length / shortest;
            for s in &mut self.pattern {
                *s *= scale;
            }
            self.period *= scale;
            self.offset *= scale;
        }
        self
    }

    /// Whether the point `along` points into a subpath is in a dash.
    pub(crate) fn is_on(&self, along: f32) -> bool {
        let mut position = (along + self.offset).rem_euclid(self.period);
        for (index, &length) in self.pattern.iter().enumerate() {
            if position < length {
                return index % 2 == 0;
            }
            position -= length;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn constant(v: f32) -> Num {
        Num::Const(v)
    }

    fn read(n: Num) -> f32 {
        n.get(|_| 0.0)
    }

    fn spans_at(outline: &Outline, y: f32, rule: FillRule) -> Vec<(f32, f32)> {
        let mut spans = Vec::new();
        outline.spans(y, rule, &mut spans);
        spans
    }

    #[test]
    fn nested_squares_follow_the_fill_rule() {
        let outline = Outline::of(
            &[
                PathOp::Rect([
                    constant(0.0),
                    constant(0.0),
                    constant(100.0),
                    constant(100.0),
                ]),
                PathOp::Rect([
                    constant(25.0),
                    constant(25.0),
                    constant(50.0),
                    constant(50.0),
                ]),
            ],
            &IDENTITY,
            &read,
        );
        assert_eq!(spans_at(&outline, 50.0, FillRule::NonZero), [(0.0, 100.0)]);
        assert_eq!(
            spans_at(&outline, 50.0, FillRule::EvenOdd),
            [(0.0, 25.0), (75.0, 100.0)]
        );
        assert_eq!(spans_at(&outline, 10.0, FillRule::EvenOdd), [(0.0, 100.0)]);
        assert!(spans_at(&outline, 150.0, FillRule::NonZero).is_empty());
    }

    #[test]
    fn opposite_windings_cancel_under_nonzero() {
        let clockwise = [(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0)];
        let counterclockwise = [(25.0, 25.0), (25.0, 75.0), (75.0, 75.0), (75.0, 25.0)];
        let mut ops = Vec::new();
        for square in [&clockwise[..], &counterclockwise[..]] {
            ops.push(PathOp::MoveTo(constant(square[0].0), constant(square[0].1)));
            for &(x, y) in &square[1..] {
                ops.push(PathOp::LineTo(constant(x), constant(y)));
            }
            ops.push(PathOp::Close);
        }
        let outline = Outline::of(&ops, &IDENTITY, &read);
        assert_eq!(
            spans_at(&outline, 50.0, FillRule::NonZero),
            [(0.0, 25.0), (75.0, 100.0)]
        );
    }

    #[test]
    fn open_subpaths_fill_as_if_closed() {
        let outline = Outline::of(
            &[
                PathOp::MoveTo(constant(0.0), constant(0.0)),
                PathOp::LineTo(constant(40.0), constant(40.0)),
                PathOp::LineTo(constant(0.0), constant(40.0)),
            ],
            &IDENTITY,
            &read,
        );
        let spans = spans_at(&outline, 20.0, FillRule::NonZero);
        assert_eq!(spans.len(), 1);
        assert!((spans[0].0 - 0.0).abs() < 1e-4 && (spans[0].1 - 20.0).abs() < 1e-4);
    }

    #[test]
    fn transforms_apply_before_flattening() {
        let mut m = IDENTITY;
        m = multiply(m, [1.0, 0.0, 0.0, 1.0, 10.0, 20.0]);
        m = multiply(m, [2.0, 0.0, 0.0, 2.0, 0.0, 0.0]);
        let outline = Outline::rect([0.0, 0.0, 5.0, 5.0], &m);
        assert_eq!(
            outline.subpaths[0].points,
            [[10.0, 20.0], [20.0, 20.0], [20.0, 30.0], [10.0, 30.0]]
        );
        assert!(outline.subpaths[0].closed);
    }

    #[test]
    fn arcs_flatten_within_the_tolerance_of_the_circle() {
        let outline = Outline::of(
            &[PathOp::Arc {
                x: constant(50.0),
                y: constant(50.0),
                radius: constant(40.0),
                start: constant(0.0),
                end: constant(TAU),
                ccw: false,
            }],
            &IDENTITY,
            &read,
        );
        let points = &outline.subpaths[0].points;
        assert!(points.len() > 16);
        for pair in points.windows(2) {
            let middle = [
                (pair[0][0] + pair[1][0]) / 2.0,
                (pair[0][1] + pair[1][1]) / 2.0,
            ];
            assert!((distance(pair[0], [50.0, 50.0]) - 40.0).abs() < 1e-3);
            assert!(40.0 - distance(middle, [50.0, 50.0]) <= TOLERANCE + 1e-3);
        }
        assert!(distance(points[0], *points.last().unwrap()) < 1e-3);
    }

    #[test]
    fn curves_end_at_their_end_points_and_bend_toward_the_controls() {
        let outline = Outline::of(
            &[
                PathOp::MoveTo(constant(0.0), constant(0.0)),
                PathOp::QuadTo([
                    constant(50.0),
                    constant(100.0),
                    constant(100.0),
                    constant(0.0),
                ]),
                PathOp::CubicTo([
                    constant(100.0),
                    constant(-100.0),
                    constant(200.0),
                    constant(-100.0),
                    constant(200.0),
                    constant(0.0),
                ]),
            ],
            &IDENTITY,
            &read,
        );
        let points = &outline.subpaths[0].points;
        assert_eq!(*points.last().unwrap(), [200.0, 0.0]);
        assert!(points.contains(&[100.0, 0.0]));
        let deepest = points.iter().map(|p| p[1]).fold(f32::MIN, f32::max);
        assert!(
            (deepest - 50.0).abs() < 1.0,
            "the quadratic's apex is 50, got {deepest}"
        );
        let highest = points.iter().map(|p| p[1]).fold(f32::MAX, f32::min);
        assert!(
            (highest + 75.0).abs() < 1.0,
            "the cubic's apex is -75, got {highest}"
        );
    }

    #[test]
    fn ellipses_and_round_rects_stay_inside_their_boxes() {
        let outline = Outline::of(
            &[
                PathOp::Ellipse {
                    geometry: [
                        constant(50.0),
                        constant(20.0),
                        constant(40.0),
                        constant(10.0),
                        constant(0.0),
                    ],
                    start: constant(0.0),
                    end: constant(TAU),
                    ccw: false,
                },
                PathOp::RoundRect(
                    [
                        constant(0.0),
                        constant(40.0),
                        constant(100.0),
                        constant(20.0),
                    ],
                    [constant(8.0); 4],
                ),
            ],
            &IDENTITY,
            &read,
        );
        let ellipse = spans_at(&outline, 20.0, FillRule::NonZero);
        assert!((ellipse[0].0 - 10.0).abs() < 0.5 && (ellipse[0].1 - 90.0).abs() < 0.5);
        let round = spans_at(&outline, 41.0, FillRule::NonZero);
        assert!(
            round[0].0 > 3.0 && round[0].1 < 97.0,
            "corners are cut: {round:?}"
        );
        assert_eq!(spans_at(&outline, 50.0, FillRule::NonZero), [(0.0, 100.0)]);
    }

    #[test]
    fn dashes_alternate_from_their_offset_and_repeat_odd_patterns() {
        let dash = Dash::new(&[Points(4.0), Points(2.0)], 0.0, 1.0).unwrap();
        assert!(dash.is_on(0.0) && dash.is_on(3.9));
        assert!(!dash.is_on(4.0) && !dash.is_on(5.9));
        assert!(dash.is_on(6.0));
        let shifted = Dash::new(&[Points(4.0), Points(2.0)], 4.0, 1.0).unwrap();
        assert!(!shifted.is_on(0.0) && shifted.is_on(2.0));
        let odd = Dash::new(&[Points(3.0)], 0.0, 2.0).unwrap();
        assert!(odd.is_on(5.0) && !odd.is_on(7.0) && odd.is_on(13.0));
        assert!(Dash::new(&[], 0.0, 1.0).is_none());
        assert!(Dash::new(&[Points(0.0), Points(0.0)], 0.0, 1.0).is_none());
    }

    #[test]
    fn dashes_shorter_than_two_dots_are_scaled_up_in_proportion() {
        // 3 on, 5 off at 4pt dots: 8 on, 13⅓ off, the offset with them.
        let dash = Dash::new(&[Points(3.0), Points(5.0)], 1.5, 1.0)
            .unwrap()
            .at_least(8.0);
        assert!(dash.is_on(0.0) && dash.is_on(3.9));
        assert!(!dash.is_on(4.1) && !dash.is_on(17.0));
        assert!(dash.is_on(17.4));
        // A short gap scales the pattern as well; long ones keep theirs.
        let gap = Dash::new(&[Points(8.0), Points(2.0)], 0.0, 1.0)
            .unwrap()
            .at_least(8.0);
        assert!(gap.is_on(31.0) && !gap.is_on(33.0) && gap.is_on(40.5));
        let long = Dash::new(&[Points(10.0), Points(9.0)], 0.0, 1.0)
            .unwrap()
            .at_least(8.0);
        assert!(long.is_on(9.9) && !long.is_on(10.1) && long.is_on(19.1));
    }
}
