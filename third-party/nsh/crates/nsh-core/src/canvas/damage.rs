//! Partial redraws: the area of a drawing that changes when some of its
//! animated values do.
//!
//! An animation of a canvas's animated values redraws the canvas on every
//! frame, but usually moves only a small part of it (a pulsing dot on a
//! chart). [`DamageScan::damage`] replays the operations for their
//! geometry only (the transform with `save` / `restore`, the current path's
//! bounds, line and shadow styles) and adds up the view-space bounds of
//! what the operations that read a changed value paint. A platform scans
//! with the old values and the new ones and redraws the union of both
//! areas; everything else keeps its pixels, and replaying the whole drawing
//! clipped to that area paints the same pixels as a full redraw.
//!
//! An operation reads a value when one of its own numbers does, or the
//! state it paints with: the transform, the current path, `globalAlpha`,
//! the paint, the line width and dash offset of strokes. The scan gives up
//! ([`Damage::All`]) when an area can not be bounded: a clip that reads a
//! changed value (what it hides changes everywhere), a painting operation
//! that reads one under a composite operation other than `source-over`
//! (`copy`, `source-in`, ... change pixels outside the shape), an image at
//! its natural size (unknown here) or bounds that are not finite. Text is
//! bounded generously from its font size (1.5 em per character, 1.5 em
//! above and below the baseline): no text engine is at hand.

use super::{
    CanvasOp, CanvasTextAlign, Composite, LineCap, LineJoin, Num, Paint, PathOp,
    hit::{IDENTITY, Matrix, apply, invert, mul, norm},
};
use crate::geometry::{self as geo, Points};

/// What changes when animated values do ([`DamageScan::damage`]).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Damage {
    /// Nothing that is drawn.
    None,
    /// This area, in view coordinates (anti-aliasing included, edges on
    /// whole points).
    Rect(geo::Bounds<Points>),
    /// Unknown: the whole canvas.
    All,
}

impl Damage {
    /// Both areas.
    pub fn union(self, other: Damage) -> Damage {
        match (self, other) {
            (Damage::All, _) | (_, Damage::All) => Damage::All,
            (Damage::None, d) | (d, Damage::None) => d,
            (Damage::Rect(a), Damage::Rect(b)) => Damage::Rect(a.union(&b)),
        }
    }
}

/// How far anti-aliasing reaches past a shape's edge, in points (with room
/// for rounding at any scale).
const AA: f32 = 2.0;

/// Text's horizontal extent per character and its extent above and below
/// the baseline, in ems: more than any common glyph takes.
const TEXT_EM: f32 = 1.5;

/// An axis-aligned box in view space; empty when `min > max`.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Bounds {
    min: [f32; 2],
    max: [f32; 2],
}

impl Bounds {
    const EMPTY: Bounds = Bounds {
        min: [f32::INFINITY; 2],
        max: [f32::NEG_INFINITY; 2],
    };

    fn is_empty(&self) -> bool {
        self.min[0] > self.max[0] || self.min[1] > self.max[1]
    }

    fn add(&mut self, p: [f32; 2]) {
        for ((min, max), v) in self.min.iter_mut().zip(&mut self.max).zip(p) {
            // NaN coordinates make the box unbounded (`finite` fails).
            if v.is_nan() {
                (*min, *max) = (f32::NEG_INFINITY, f32::INFINITY);
            } else {
                (*min, *max) = (min.min(v), max.max(v));
            }
        }
    }

    fn union(&mut self, b: &Bounds) {
        if !b.is_empty() {
            self.add(b.min);
            self.add(b.max);
        }
    }

    /// The user-space box (`x0`, `y0`) .. (`x1`, `y1`) under `m`.
    fn add_box(&mut self, m: &Matrix, x0: f32, y0: f32, x1: f32, y1: f32) {
        self.add(apply(m, x0, y0));
        self.add(apply(m, x1, y0));
        self.add(apply(m, x1, y1));
        self.add(apply(m, x0, y1));
    }

    fn inflate(mut self, by: f32) -> Bounds {
        if !self.is_empty() {
            self.min = self.min.map(|v| v - by);
            self.max = self.max.map(|v| v + by);
        }
        self
    }

    fn offset(mut self, dx: f32, dy: f32) -> Bounds {
        self.min = [self.min[0] + dx, self.min[1] + dy];
        self.max = [self.max[0] + dx, self.max[1] + dy];
        self
    }

    fn finite(&self) -> bool {
        self.min.iter().chain(&self.max).all(|v| v.is_finite())
    }
}

/// The geometry state of a scan.
#[derive(Clone, Copy)]
struct State {
    ctm: Matrix,
    line_width: f32,
    cap: LineCap,
    join: LineJoin,
    miter: f32,
    /// The shadow's blur and offset.
    shadow: (f32, f32, f32),
    /// Its color shows.
    shadow_on: bool,
    source_over: bool,
    font_size: f32,
    align: CanvasTextAlign,
    // What reads a changed value.
    ctm_dep: bool,
    line_width_dep: bool,
    dash_dep: bool,
    alpha_dep: bool,
    fill_dep: bool,
    stroke_dep: bool,
}

impl Default for State {
    fn default() -> Self {
        State {
            ctm: IDENTITY,
            line_width: 1.0,
            cap: LineCap::Butt,
            join: LineJoin::Miter,
            miter: 10.0,
            shadow: (0.0, 0.0, 0.0),
            shadow_on: false,
            source_over: true,
            font_size: 10.0,
            align: CanvasTextAlign::Start,
            ctm_dep: false,
            line_width_dep: false,
            dash_dep: false,
            alpha_dep: false,
            fill_dep: false,
            stroke_dep: false,
        }
    }
}

impl State {
    /// How far a stroke reaches past its path: half the line width under
    /// the transform's largest scale, times the miter limit for miter
    /// joins (a miter is at most that long) or √2 for square caps.
    fn stroke_pad(&self) -> f32 {
        // The largest singular value of the linear part.
        let [a, b, c, d, ..] = self.ctm;
        let sum = a * a + b * b + c * c + d * d;
        let det = a * d - b * c;
        let scale = ((sum + (sum * sum - 4.0 * det * det).max(0.0).sqrt()) / 2.0).sqrt();
        let mut factor = 1.0f32;
        if self.join == LineJoin::Miter {
            factor = factor.max(self.miter);
        }
        if self.cap == LineCap::Square {
            factor = factor.max(std::f32::consts::SQRT_2);
        }
        self.line_width / 2.0 * scale * factor
    }
}

/// The current path's bounds, as a scan sees it.
#[derive(Clone, Copy)]
struct PathBounds {
    bounds: Bounds,
    /// It reads a changed value (or was built under a transform that does).
    dep: bool,
    /// The current point and the open subpath's start, in view space.
    last: Option<[f32; 2]>,
    start: [f32; 2],
}

impl PathBounds {
    const EMPTY: PathBounds = PathBounds {
        bounds: Bounds::EMPTY,
        dep: false,
        last: None,
        start: [0.0; 2],
    };

    fn point(&mut self, p: [f32; 2]) {
        self.bounds.add(p);
        self.last = Some(p);
    }

    fn move_to(&mut self, p: [f32; 2]) {
        self.point(p);
        self.start = p;
    }

    /// Adds `op` under `m` (`n` reads its numbers).
    fn add(&mut self, op: &PathOp, m: &Matrix, n: &impl Fn(Num) -> f32) {
        match op {
            PathOp::MoveTo(x, y) => self.move_to(apply(m, n(*x), n(*y))),
            PathOp::LineTo(x, y) => {
                let p = apply(m, n(*x), n(*y));
                if self.last.is_none() {
                    self.start = p;
                }
                self.point(p);
            }
            // Curves stay within their control points' hull.
            PathOp::QuadTo(v) => {
                let [cx, cy, x, y] = v.map(n);
                self.bounds.add(apply(m, cx, cy));
                self.point(apply(m, x, y));
            }
            PathOp::CubicTo(v) => {
                let [c1x, c1y, c2x, c2y, x, y] = v.map(n);
                self.bounds.add(apply(m, c1x, c1y));
                self.bounds.add(apply(m, c2x, c2y));
                self.point(apply(m, x, y));
            }
            PathOp::Arc {
                x,
                y,
                radius,
                start,
                end,
                ccw,
            } => {
                let (x, y, r) = (n(*x), n(*y), n(*radius));
                if r < 0.0 {
                    return;
                }
                let (s, e) = (n(*start), n(*end));
                let sweep = super::sweep(s, e, *ccw);
                self.ellipse(m, [x, y], r, s + sweep, |t| {
                    [x + r * t.cos(), y + r * t.sin()]
                });
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
                let (s, e) = (n(*start), n(*end));
                let sweep = super::sweep(s, e, *ccw);
                let (sr, cr) = rotation.sin_cos();
                self.ellipse(m, [x, y], rx.max(ry), s + sweep, |t| {
                    let (ex, ey) = (rx * t.cos(), ry * t.sin());
                    [x + ex * cr - ey * sr, y + ex * sr + ey * cr]
                });
            }
            PathOp::ArcTo(v) => {
                let [x1, y1, x2, y2, r] = v.map(n);
                self.arc_to(m, [x1, y1], [x2, y2], r);
            }
            PathOp::Rect(v) | PathOp::RoundRect(v, _) => {
                let [x, y, w, h] = v.map(n);
                self.bounds.add_box(m, x, y, x + w, y + h);
                // A new subpath at the rectangle's origin, as in canvas.
                self.move_to(apply(m, x, y));
            }
            PathOp::Close => {
                if self.last.is_some() {
                    self.last = Some(self.start);
                }
            }
        }
    }

    /// An arc within the circle of radius `r` around `center` (user
    /// space), ending at `at(end)`.
    fn ellipse(
        &mut self,
        m: &Matrix,
        center: [f32; 2],
        r: f32,
        end: f32,
        at: impl Fn(f32) -> [f32; 2],
    ) {
        if self.last.is_none() {
            // The arc's start opens the subpath; it lies in the box.
            self.start = apply(m, center[0], center[1]);
        }
        self.bounds.add_box(
            m,
            center[0] - r,
            center[1] - r,
            center[0] + r,
            center[1] + r,
        );
        let [ex, ey] = at(end);
        self.point(apply(m, ex, ey));
    }

    /// `arcTo`: a line to the first tangent point, then an arc inside the
    /// triangle of the tangent points and the corner (`p1`).
    fn arc_to(&mut self, m: &Matrix, p1: [f32; 2], p2: [f32; 2], r: f32) {
        if r < 0.0 {
            return;
        }
        let corner = apply(m, p1[0], p1[1]);
        let Some(current) = self.last else {
            self.move_to(corner);
            return;
        };
        let Some(inverse) = invert(m) else {
            // Nothing to go by: unbounded.
            self.bounds.add([f32::NAN; 2]);
            return;
        };
        let p0 = apply(&inverse, current[0], current[1]);
        let u = norm([p0[0] - p1[0], p0[1] - p1[1]]);
        let v = norm([p2[0] - p1[0], p2[1] - p1[1]]);
        let (Some(u), Some(v)) = (u, v) else {
            self.point(corner);
            return;
        };
        let cross = u[0] * v[1] - u[1] * v[0];
        if r == 0.0 || cross.abs() < 1e-6 {
            self.point(corner);
            return;
        }
        let theta = (u[0] * v[0] + u[1] * v[1]).clamp(-1.0, 1.0).acos();
        let d = r / (theta / 2.0).tan();
        self.bounds.add(corner);
        self.bounds
            .add(apply(m, p1[0] + u[0] * d, p1[1] + u[1] * d));
        self.point(apply(m, p1[0] + v[0] * d, p1[1] + v[1] * d));
    }
}

/// Scans drawings for what changes ([`Damage`]); keeps its scratch space
/// between scans, so a scan per frame allocates nothing.
#[derive(Default)]
pub struct DamageScan {
    stack: Vec<State>,
}

impl DamageScan {
    /// The area that the operations of `ops` reading an animated value slot
    /// for which `changed` is true paint, with slot values `value`.
    ///
    /// Scanned with the values before a change and after it, the union of
    /// both is what a platform redraws.
    pub fn damage(
        &mut self,
        ops: &[CanvasOp],
        value: impl Fn(u16) -> f32,
        changed: impl Fn(u16) -> bool,
    ) -> Damage {
        let n = |v: Num| v.get(&value);
        let dep = |v: &Num| matches!(*v, Num::Slot(s) if changed(s));
        let paint_dep = |p: &Paint| matches!(*p, Paint::Slot(s) if changed(s));
        let path_dep = |ops: &[PathOp]| ops.iter().any(|op| path_op_dep(op, &dep));

        self.stack.clear();
        let mut state = State::default();
        let mut path = PathBounds::EMPTY;
        let mut area = Bounds::EMPTY;
        for op in ops {
            // What the operation paints, if it reads a changed value.
            let painted: Option<Bounds> = match op {
                CanvasOp::Save => {
                    self.stack.push(state);
                    None
                }
                CanvasOp::Restore => {
                    if let Some(s) = self.stack.pop() {
                        state = s;
                    }
                    None
                }
                CanvasOp::Translate(x, y) => {
                    state.ctm = mul(state.ctm, [1.0, 0.0, 0.0, 1.0, n(*x), n(*y)]);
                    state.ctm_dep |= dep(x) || dep(y);
                    None
                }
                CanvasOp::Scale(x, y) => {
                    state.ctm = mul(state.ctm, [n(*x), 0.0, 0.0, n(*y), 0.0, 0.0]);
                    state.ctm_dep |= dep(x) || dep(y);
                    None
                }
                CanvasOp::Rotate(a) => {
                    let (s, c) = n(*a).sin_cos();
                    state.ctm = mul(state.ctm, [c, s, -s, c, 0.0, 0.0]);
                    state.ctm_dep |= dep(a);
                    None
                }
                CanvasOp::Transform(v) => {
                    state.ctm = mul(state.ctm, v.map(n));
                    state.ctm_dep |= v.iter().any(dep);
                    None
                }
                CanvasOp::SetTransform(v) => {
                    state.ctm = v.map(n);
                    state.ctm_dep = v.iter().any(dep);
                    None
                }
                CanvasOp::BeginPath => {
                    path = PathBounds::EMPTY;
                    None
                }
                CanvasOp::Path(op) => {
                    path.add(op, &state.ctm, &n);
                    path.dep |= state.ctm_dep || path_op_dep(op, &dep);
                    None
                }
                CanvasOp::Fill(p, _) => {
                    let (bounds, d) = shape(p.as_deref(), &path, &state, &n, &path_dep);
                    (d || state.alpha_dep || state.fill_dep).then_some(bounds)
                }
                CanvasOp::Stroke(p) => {
                    let (bounds, d) = shape(p.as_deref(), &path, &state, &n, &path_dep);
                    (d || state.alpha_dep
                        || state.stroke_dep
                        || state.line_width_dep
                        || state.dash_dep)
                        .then(|| bounds.inflate(state.stroke_pad()))
                }
                CanvasOp::Clip(p, _) => {
                    let (_, d) = shape(p.as_deref(), &path, &state, &n, &path_dep);
                    if d {
                        return Damage::All;
                    }
                    None
                }
                CanvasOp::FillRect(r) | CanvasOp::ClearRect(r) => {
                    let fill = matches!(op, CanvasOp::FillRect(_));
                    let d = r.iter().any(dep)
                        || state.ctm_dep
                        || (fill && (state.alpha_dep || state.fill_dep));
                    d.then(|| rect(&state.ctm, r.map(n)))
                }
                CanvasOp::StrokeRect(r) => {
                    let d = r.iter().any(dep)
                        || state.ctm_dep
                        || state.alpha_dep
                        || state.stroke_dep
                        || state.line_width_dep
                        || state.dash_dep;
                    d.then(|| rect(&state.ctm, r.map(n)).inflate(state.stroke_pad()))
                }
                CanvasOp::FillStyle(p) => {
                    state.fill_dep = paint_dep(p);
                    None
                }
                CanvasOp::StrokeStyle(p) => {
                    state.stroke_dep = paint_dep(p);
                    None
                }
                CanvasOp::LineWidth(w) => {
                    let v = n(*w);
                    // Invalid widths are ignored, as in canvas.
                    if v.is_finite() && v > 0.0 {
                        state.line_width = v;
                    }
                    state.line_width_dep = dep(w);
                    None
                }
                CanvasOp::LineCap(c) => {
                    state.cap = *c;
                    None
                }
                CanvasOp::LineJoin(j) => {
                    state.join = *j;
                    None
                }
                CanvasOp::MiterLimit(m) => {
                    state.miter = *m;
                    None
                }
                CanvasOp::LineDashOffset(o) => {
                    state.dash_dep = dep(o);
                    None
                }
                CanvasOp::GlobalAlpha(a) => {
                    state.alpha_dep = dep(a);
                    None
                }
                CanvasOp::Composite(c) => {
                    state.source_over = *c == Composite::SourceOver;
                    None
                }
                CanvasOp::ShadowColor(c) => {
                    state.shadow_on = c.0 & 0xff != 0;
                    None
                }
                CanvasOp::ShadowBlur(b) => {
                    state.shadow.0 = b.0;
                    None
                }
                CanvasOp::ShadowOffset(offset) => {
                    (state.shadow.1, state.shadow.2) = (offset.x.0, offset.y.0);
                    None
                }
                CanvasOp::Font(f) => {
                    state.font_size = f.size.0;
                    None
                }
                CanvasOp::TextAlign(a) => {
                    state.align = *a;
                    None
                }
                CanvasOp::FillText {
                    text,
                    x,
                    y,
                    max_width,
                }
                | CanvasOp::StrokeText {
                    text,
                    x,
                    y,
                    max_width,
                } => {
                    let fill = matches!(op, CanvasOp::FillText { .. });
                    let d = dep(x)
                        || dep(y)
                        || state.ctm_dep
                        || state.alpha_dep
                        || if fill {
                            state.fill_dep
                        } else {
                            state.stroke_dep || state.line_width_dep || state.dash_dep
                        };
                    d.then(|| {
                        let b = text_bounds(&state, text, n(*x), n(*y), max_width.map(|m| m.0));
                        if fill {
                            b
                        } else {
                            b.inflate(state.stroke_pad())
                        }
                    })
                }
                CanvasOp::DrawImage { dest, .. } => {
                    let d = dest.iter().any(dep) || state.ctm_dep || state.alpha_dep;
                    if d {
                        let [x, y, w, h] = dest.map(n);
                        if w.is_nan() || h.is_nan() {
                            // Its natural size: unknown here.
                            return Damage::All;
                        }
                        Some(rect(&state.ctm, [x, y, w, h]))
                    } else {
                        None
                    }
                }
                CanvasOp::LineDash(_)
                | CanvasOp::FontVariantNumeric(_)
                | CanvasOp::TextBaseline(_) => None,
            };
            let Some(mut bounds) = painted else {
                continue;
            };
            if !state.source_over {
                return Damage::All;
            }
            if state.shadow_on {
                let (blur, dx, dy) = state.shadow;
                // Shadow offsets ignore the transform, as in canvas.
                let shadow = bounds.offset(dx, dy).inflate(blur * 2.0);
                bounds.union(&shadow);
            }
            area.union(&bounds);
        }
        if area.is_empty() {
            return Damage::None;
        }
        if !area.finite() {
            return Damage::All;
        }
        let area = area.inflate(AA);
        let (x, y) = (area.min[0].floor(), area.min[1].floor());
        Damage::Rect(geo::rect(
            x,
            y,
            area.max[0].ceil() - x,
            area.max[1].ceil() - y,
        ))
    }
}

/// The index of the first operation of `ops` that reads an animated value
/// slot (`ops.len()` when none does). What the operations before it paint
/// is the same whatever the slots hold: a platform may keep those pixels
/// and, when slots change, replay only the painting from there on (the
/// operations before it still set the state: transforms, styles, paths,
/// clips).
pub fn first_animated(ops: &[CanvasOp]) -> usize {
    let dep = |v: &Num| matches!(v, Num::Slot(_));
    let paint = |p: &Paint| matches!(p, Paint::Slot(_));
    let path = |p: &Option<super::Path>| {
        p.as_deref()
            .is_some_and(|ops| ops.iter().any(|op| path_op_dep(op, &dep)))
    };
    ops.iter()
        .position(|op| match op {
            CanvasOp::Translate(x, y) | CanvasOp::Scale(x, y) => dep(x) || dep(y),
            CanvasOp::Rotate(v)
            | CanvasOp::LineWidth(v)
            | CanvasOp::LineDashOffset(v)
            | CanvasOp::GlobalAlpha(v) => dep(v),
            CanvasOp::Transform(v) | CanvasOp::SetTransform(v) => v.iter().any(dep),
            CanvasOp::Path(op) => path_op_dep(op, &dep),
            CanvasOp::Fill(p, _) | CanvasOp::Stroke(p) | CanvasOp::Clip(p, _) => path(p),
            CanvasOp::FillRect(r) | CanvasOp::StrokeRect(r) | CanvasOp::ClearRect(r) => {
                r.iter().any(dep)
            }
            CanvasOp::FillStyle(p) | CanvasOp::StrokeStyle(p) => paint(p),
            CanvasOp::FillText { x, y, .. } | CanvasOp::StrokeText { x, y, .. } => dep(x) || dep(y),
            CanvasOp::DrawImage { dest, .. } => dest.iter().any(dep),
            CanvasOp::Save
            | CanvasOp::Restore
            | CanvasOp::BeginPath
            | CanvasOp::LineCap(_)
            | CanvasOp::LineJoin(_)
            | CanvasOp::MiterLimit(_)
            | CanvasOp::LineDash(_)
            | CanvasOp::Composite(_)
            | CanvasOp::ShadowColor(_)
            | CanvasOp::ShadowBlur(_)
            | CanvasOp::ShadowOffset(_)
            | CanvasOp::Font(_)
            | CanvasOp::FontVariantNumeric(_)
            | CanvasOp::TextAlign(_)
            | CanvasOp::TextBaseline(_) => false,
        })
        .unwrap_or(ops.len())
}

/// Whether the current path the operations of `ops` before `split` build
/// matters from `split` on: a clip by it before `split` keeps it, and so
/// does an operation from `split` on that uses it before a `beginPath`
/// starts anew. A platform replaying only from [`first_animated`] on skips
/// the path operations before it when it does not.
pub fn prefix_path_needed(ops: &[CanvasOp], split: usize) -> bool {
    let split = split.min(ops.len());
    if ops[..split]
        .iter()
        .any(|op| matches!(op, CanvasOp::Clip(None, _)))
    {
        return true;
    }
    ops[split..]
        .iter()
        .find_map(|op| match op {
            CanvasOp::BeginPath => Some(false),
            CanvasOp::Path(_)
            | CanvasOp::Fill(None, _)
            | CanvasOp::Stroke(None)
            | CanvasOp::Clip(None, _) => Some(true),
            _ => None,
        })
        .unwrap_or(false)
}

/// Whether `op` reads a changed value.
fn path_op_dep(op: &PathOp, dep: &impl Fn(&Num) -> bool) -> bool {
    match op {
        PathOp::MoveTo(x, y) | PathOp::LineTo(x, y) => dep(x) || dep(y),
        PathOp::QuadTo(v) => v.iter().any(dep),
        PathOp::CubicTo(v) => v.iter().any(dep),
        PathOp::Arc {
            x,
            y,
            radius,
            start,
            end,
            ..
        } => [x, y, radius, start, end].into_iter().any(dep),
        PathOp::Ellipse {
            geometry,
            start,
            end,
            ..
        } => geometry.iter().any(dep) || dep(start) || dep(end),
        PathOp::ArcTo(v) => v.iter().any(dep),
        PathOp::Rect(v) => v.iter().any(dep),
        PathOp::RoundRect(v, r) => v.iter().chain(r).any(dep),
        PathOp::Close => false,
    }
}

/// The bounds of what `fill` / `stroke` / `clip` take (`path` under the
/// current transform, else the current path) and whether they read a
/// changed value.
fn shape(
    path: Option<&[PathOp]>,
    current: &PathBounds,
    state: &State,
    n: &impl Fn(Num) -> f32,
    path_dep: &impl Fn(&[PathOp]) -> bool,
) -> (Bounds, bool) {
    match path {
        Some(ops) => {
            let mut b = PathBounds::EMPTY;
            for op in ops {
                b.add(op, &state.ctm, n);
            }
            (b.bounds, state.ctm_dep || path_dep(ops))
        }
        // Strokes widen with the transform current when they are drawn.
        None => (current.bounds, current.dep || state.ctm_dep),
    }
}

/// The rectangle `[x, y, w, h]` under `m`.
fn rect(m: &Matrix, [x, y, w, h]: [f32; 4]) -> Bounds {
    let mut b = Bounds::EMPTY;
    b.add_box(m, x, y, x + w, y + h);
    b
}

/// Generous bounds of `text` at (`x`, `y`).
fn text_bounds(state: &State, text: &str, x: f32, y: f32, max_width: Option<f32>) -> Bounds {
    let em = state.font_size;
    let mut w = text.chars().count() as f32 * em * TEXT_EM;
    if let Some(max) = max_width.filter(|m| *m >= 0.0) {
        w = w.min(max);
    }
    // `start` / `end` depend on the direction: either side.
    let (left, right) = match state.align {
        CanvasTextAlign::Left => (0.0, w),
        CanvasTextAlign::Right => (-w, 0.0),
        CanvasTextAlign::Center => (-w / 2.0, w / 2.0),
        CanvasTextAlign::Start | CanvasTextAlign::End => (-w, w),
    };
    // Overhangs (italics, accents) past the advance.
    let pad = em * 0.5;
    let mut b = Bounds::EMPTY;
    b.add_box(
        &state.ctm,
        x + left - pad,
        y - em * TEXT_EM,
        x + right + pad,
        y + em * TEXT_EM,
    );
    b
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::{canvas::FillRule, style::Color};

    const S0: Num = Num::Slot(0);

    fn c(v: f32) -> Num {
        Num::Const(v)
    }

    /// Damage with slot 0 = `v0`, slot 1 = `v1`, slot 0 changed.
    fn scan(ops: &[CanvasOp], v0: f32, v1: f32) -> Damage {
        DamageScan::default().damage(ops, |s| if s == 0 { v0 } else { v1 }, |s| s == 0)
    }

    fn r(x: f32, y: f32, width: f32, height: f32) -> Damage {
        Damage::Rect(geo::rect(x, y, width, height))
    }

    fn arc(x: f32, y: f32, radius: Num) -> CanvasOp {
        CanvasOp::Path(PathOp::Arc {
            x: c(x),
            y: c(y),
            radius,
            start: c(0.0),
            end: c(std::f32::consts::TAU),
            ccw: false,
        })
    }

    /// A chart: a big static line, then a dot whose radius is slot 0 and
    /// alpha slot 1.
    fn pulse() -> Vec<CanvasOp> {
        vec![
            CanvasOp::BeginPath,
            CanvasOp::Path(PathOp::MoveTo(c(0.0), c(0.0))),
            CanvasOp::Path(PathOp::LineTo(c(500.0), c(300.0))),
            CanvasOp::LineWidth(c(2.0)),
            CanvasOp::Stroke(None),
            CanvasOp::GlobalAlpha(Num::Slot(1)),
            CanvasOp::BeginPath,
            arc(100.0, 50.0, S0),
            CanvasOp::Fill(None, FillRule::NonZero),
            CanvasOp::GlobalAlpha(c(1.0)),
            CanvasOp::BeginPath,
            arc(100.0, 50.0, c(3.0)),
            CanvasOp::Fill(None, FillRule::NonZero),
        ]
    }

    #[test]
    fn the_animated_part_starts_at_the_first_slot_read() {
        // The static line, then the alpha read from slot 1.
        assert_eq!(first_animated(&pulse()), 5);
        assert_eq!(first_animated(&pulse()[..5]), 5);
        assert_eq!(first_animated(&[]), 0);
    }

    #[test]
    fn only_what_reads_changed_values_is_damaged() {
        let ops = pulse();
        // The ring of radius 10 at (100, 50), anti-aliasing around it.
        assert_eq!(scan(&ops, 10.0, 0.5), r(88.0, 38.0, 24.0, 24.0));
        let old = scan(&ops, 3.0, 0.5);
        let new = scan(&ops, 13.0, 0.5);
        assert_eq!(old.union(new), r(85.0, 35.0, 30.0, 30.0));
        // Slot 1 (alpha) did not change: the alpha alone damages nothing,
        // but changing it damages the ring, not the static dot after.
        let alpha = DamageScan::default().damage(&ops, |_| 5.0, |s| s == 1);
        assert_eq!(alpha, r(93.0, 43.0, 14.0, 14.0));
        // Nothing reads slot 2.
        assert_eq!(
            DamageScan::default().damage(&ops, |_| 5.0, |s| s == 2),
            Damage::None
        );
    }

    #[test]
    fn transforms_and_save_restore_carry_dependence() {
        let ops = vec![
            CanvasOp::Save,
            CanvasOp::Translate(S0, c(10.0)),
            CanvasOp::FillRect([c(0.0), c(0.0), c(10.0), c(10.0)]),
            CanvasOp::Restore,
            // After restore the transform is static again.
            CanvasOp::FillRect([c(200.0), c(200.0), c(10.0), c(10.0)]),
            CanvasOp::Scale(c(2.0), c(2.0)),
            CanvasOp::FillRect([S0, c(0.0), c(5.0), c(5.0)]),
        ];
        // The first rect at x 50, the last at 2 * 50 .. 2 * 55.
        assert_eq!(scan(&ops, 50.0, 0.0), r(48.0, -2.0, 64.0, 24.0));
        // A path built under a changing transform reads it.
        let ops = vec![
            CanvasOp::Rotate(S0),
            CanvasOp::BeginPath,
            CanvasOp::Path(PathOp::Rect([c(10.0), c(0.0), c(10.0), c(10.0)])),
            CanvasOp::SetTransform([1.0, 0.0, 0.0, 1.0, 0.0, 0.0].map(c)),
            CanvasOp::Fill(None, FillRule::NonZero),
        ];
        let Damage::Rect(rect) = scan(&ops, std::f32::consts::FRAC_PI_2, 0.0) else {
            panic!()
        };
        // Rotated a quarter turn: x in -10..0, y in 10..20 (give or take
        // rounding).
        assert!(
            (-13.0..=-12.0).contains(&rect.origin.x.0)
                && rect.origin.x.0 + rect.size.width.0 >= 2.0
        );
        assert_eq!((rect.origin.y.0, rect.size.height.0), (8.0, 14.0));
    }

    #[test]
    fn strokes_and_shadows_widen_the_area() {
        let ops = vec![
            CanvasOp::LineWidth(c(4.0)),
            CanvasOp::LineJoin(LineJoin::Round),
            CanvasOp::ShadowColor(Color(0x000000ff)),
            CanvasOp::ShadowBlur(crate::geometry::px(3.0)),
            CanvasOp::ShadowOffset(crate::geometry::point(
                crate::geometry::px(10.0),
                crate::geometry::px(0.0),
            )),
            CanvasOp::StrokeRect([S0, c(0.0), c(10.0), c(10.0)]),
        ];
        // The stroke: 2 past the box; its shadow 10 right, 6 wider.
        assert_eq!(scan(&ops, 0.0, 0.0), r(-4.0, -10.0, 34.0, 30.0));
        // A miter join may reach the miter limit (10) times half the width.
        let ops = vec![
            CanvasOp::LineWidth(c(4.0)),
            CanvasOp::StrokeRect([S0, c(0.0), c(10.0), c(10.0)]),
        ];
        assert_eq!(scan(&ops, 0.0, 0.0), r(-22.0, -22.0, 54.0, 54.0));
        // A transparent shadow casts nothing.
        let ops = vec![
            CanvasOp::ShadowBlur(crate::geometry::px(30.0)),
            CanvasOp::FillRect([S0, c(0.0), c(10.0), c(10.0)]),
        ];
        assert_eq!(scan(&ops, 0.0, 0.0), r(-2.0, -2.0, 14.0, 14.0));
    }

    #[test]
    fn text_and_paths_are_bounded() {
        let ops = vec![
            CanvasOp::TextAlign(CanvasTextAlign::Left),
            CanvasOp::FillStyle(Paint::Slot(0)),
            CanvasOp::FillText {
                text: "ab".into(),
                x: c(10.0),
                y: c(20.0),
                max_width: None,
            },
        ];
        // 2 chars of 10pt: 30 wide, 15 above and below, 5 of overhang.
        assert_eq!(scan(&ops, 0.0, 0.0), r(3.0, 3.0, 44.0, 34.0));
        // A Path2D reading a changed value, and curves within their hulls.
        let path: Arc<[PathOp]> = vec![
            PathOp::MoveTo(c(0.0), c(0.0)),
            PathOp::CubicTo([c(0.0), c(-20.0), S0, c(20.0), c(10.0), c(0.0)]),
        ]
        .into();
        let ops = vec![CanvasOp::Fill(Some(path), FillRule::NonZero)];
        assert_eq!(scan(&ops, 40.0, 0.0), r(-2.0, -22.0, 44.0, 44.0));
    }

    #[test]
    fn unknown_areas_fall_back_to_the_whole_canvas() {
        // A clip that moves changes what it hides everywhere.
        let ops = vec![
            CanvasOp::BeginPath,
            CanvasOp::Path(PathOp::Rect([S0, c(0.0), c(10.0), c(10.0)])),
            CanvasOp::Clip(None, FillRule::NonZero),
        ];
        assert_eq!(scan(&ops, 0.0, 0.0), Damage::All);
        // `copy` clears outside the shape.
        let ops = vec![
            CanvasOp::Composite(Composite::Copy),
            CanvasOp::FillRect([S0, c(0.0), c(10.0), c(10.0)]),
        ];
        assert_eq!(scan(&ops, 0.0, 0.0), Damage::All);
        // ... but a composite of static operations alone is fine.
        let ops = vec![
            CanvasOp::Composite(Composite::Copy),
            CanvasOp::FillRect([c(0.0), c(0.0), c(10.0), c(10.0)]),
            CanvasOp::Composite(Composite::SourceOver),
            CanvasOp::FillRect([S0, c(0.0), c(10.0), c(10.0)]),
        ];
        assert_eq!(scan(&ops, 0.0, 0.0), r(-2.0, -2.0, 14.0, 14.0));
        // An image at its natural size.
        let ops = vec![CanvasOp::DrawImage {
            image: crate::canvas::CanvasImage {
                uri: "a.png".into(),
            },
            source: None,
            dest: [S0, c(0.0), c(f32::NAN), c(f32::NAN)],
        }];
        assert_eq!(scan(&ops, 0.0, 0.0), Damage::All);
        // Unbounded numbers.
        let ops = vec![CanvasOp::FillRect([S0, c(0.0), c(10.0), c(10.0)])];
        assert_eq!(scan(&ops, f32::INFINITY, 0.0), Damage::All);
        assert_eq!(scan(&ops, f32::NAN, 0.0), Damage::All);
        assert_eq!(Damage::None.union(Damage::All), Damage::All);
        assert_eq!(scan(&[], 0.0, 0.0), Damage::None);
    }

    #[test]
    fn arc_to_stays_in_its_corner() {
        let ops = vec![
            CanvasOp::BeginPath,
            CanvasOp::Path(PathOp::MoveTo(c(0.0), c(0.0))),
            CanvasOp::Path(PathOp::ArcTo([c(50.0), c(0.0), c(50.0), c(50.0), S0])),
            CanvasOp::LineWidth(c(2.0)),
            CanvasOp::LineJoin(LineJoin::Round),
            CanvasOp::Stroke(None),
        ];
        // From (0, 0) along the top to (40, 0), round to (50, 10).
        assert_eq!(scan(&ops, 10.0, 0.0), r(-3.0, -3.0, 56.0, 16.0));
    }
}
