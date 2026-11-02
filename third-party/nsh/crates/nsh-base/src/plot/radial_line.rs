//! `RadialLine` and `RadialGrid`: a series around the plot's center and the
//! rings and spokes behind it, a radar chart's parts (`gpui-base`'s
//! `shape/radial_line.rs`, d3's `lineRadial` / `areaRadial`). Angles are
//! radians, 0 at 12 o'clock and growing clockwise, as a pie's; a row's
//! value goes out from the center on the plot's linear y scale, from the
//! mark's inner radius (the domain's smallest value) to its outer one (the
//! largest), as d3's radial charts map a value with a linear scale whose
//! range is the radii.

use std::{f32::consts::TAU, sync::Arc as Shared};

use nsh_core::{
    SvgPaint,
    canvas::{CanvasOp, Num, PathOp},
    element::{RowAccessor, Style},
    geometry::{DefiniteLength, Percentage, Radians},
    prelude::*,
};

use super::{
    PlotContext, STROKE_ROOM, dot_anchor, layer,
    line::Curve,
    mark_canvas, mark_canvas_with,
    pie::{Pose, Radius, Ring, Update, Var},
    scale::{AxisMap, Linear, extent},
    series::{HoverDot, Mark, values},
};

/// An angle this close to a whole turn is one.
const EPSILON: f32 = 1e-4;

/// Where row `index` of `len` goes round the turn from `start` to `end`
/// (pie angles): evenly, a step of a whole turn's `1 / len` apart round a
/// whole turn (so the last row is a step before the first, as d3's
/// `scaleBand().range([0, 2π])` places a radar's axes), and from `start`
/// to `end` over a part of one (d3's `scalePoint`, both ends a row's).
fn spoke_angle(index: usize, len: usize, start: f32, end: f32) -> f32 {
    let span = end - start;
    let steps = match span.abs() >= TAU - EPSILON {
        true => len,
        false => len.saturating_sub(1),
    };
    match steps {
        0 => start,
        _ => start + span * index as f32 / steps as f32,
    }
}

/// The point at `angle` (pie angles) `radius` out from `center`.
fn polar(center: Point<Points>, angle: f32, radius: f32) -> [f32; 2] {
    [
        center.x.0 + radius * angle.sin(),
        center.y.0 - radius * angle.cos(),
    ]
}

/// The domain of the plot's linear y scale, which places radial values
/// (`None` on a `point` or `band` y scale: they have no place).
fn radial_domain(plot: PlotContext) -> Memo<Option<[f64; 2]>> {
    computed(move || match plot.y_map.get() {
        AxisMap::Linear(map) => Some(map.domain()),
        _ => None,
    })
}

/// A row of a radial line: its angle and its value.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Spoke {
    row: u32,
    angle: f32,
    value: f64,
}

/// What the app gives a radial line, which its motion moves between: its
/// rows' angles and values, the domain that places them and its radii. The
/// plot's size is not part of it, so a resize moves nothing.
#[derive(Debug, Clone, PartialEq)]
struct Polar {
    spokes: Shared<[Spoke]>,
    domain: Option<[f64; 2]>,
    inner: Radius,
    outer: Radius,
}

/// `t` of the way from `a` to `b`, `b` without `a`.
fn lerp_domain(a: Option<[f64; 2]>, b: Option<[f64; 2]>, t: f32) -> Option<[f64; 2]> {
    let t = f64::from(t);
    match (a, b) {
        (Some([a0, a1]), Some([b0, b1])) => Some([a0 + (b0 - a0) * t, a1 + (b1 - a1) * t]),
        _ => b,
    }
}

impl Pose for Polar {
    /// Each row's angle and value `t` of the way to `to`'s (a row new in
    /// `to` where `to` has it), the domain and the radii too: where the
    /// line is drawn when a change stops a move part way.
    fn lerp(&self, to: &Self, t: f32) -> Self {
        let spokes = to
            .spokes
            .iter()
            .map(|s| match self.spokes.iter().find(|f| f.row == s.row) {
                Some(f) => Spoke {
                    row: s.row,
                    angle: f.angle + (s.angle - f.angle) * t,
                    value: f.value + (s.value - f.value) * f64::from(t),
                },
                None => *s,
            })
            .collect();
        Polar {
            spokes,
            domain: lerp_domain(self.domain, to.domain, t),
            inner: self.inner.lerp(to.inner, t),
            outer: self.outer.lerp(to.outer, t),
        }
    }
}

impl Polar {
    /// Where it draws on a plot of `size`.
    fn frame(&self, size: Size<Points>) -> Frame {
        let ring = Ring::of(size, self.inner, self.outer);
        let vertices = match self.domain {
            Some(domain) => {
                let map = Linear::new(domain, [ring.inner, ring.outer]);
                self.spokes
                    .iter()
                    .filter_map(|s| {
                        Some(Vertex {
                            row: s.row,
                            angle: s.angle,
                            radius: map.tick(s.value)?,
                        })
                    })
                    .collect()
            }
            None => Vec::new(),
        };
        Frame {
            center: ring.center,
            inner: ring.inner,
            outer: ring.outer,
            vertices,
        }
    }
}

/// A row's vertex: its angle and how far out it is, in points.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Vertex {
    row: u32,
    angle: f32,
    radius: f32,
}

/// A radial line where it draws (at rest, or where a motion moves it
/// from): its center, its radii and its vertices.
#[derive(Debug, Clone, PartialEq)]
struct Frame {
    center: Point<Points>,
    inner: f32,
    outer: f32,
    vertices: Vec<Vertex>,
}

impl Frame {
    /// The point of row `row`'s vertex.
    fn point_of(&self, row: u32) -> Option<Point<Points>> {
        let v = self.vertices.iter().find(|v| v.row == row)?;
        let [x, y] = polar(self.center, v.angle, v.radius);
        Some(point(px(x), px(y)))
    }

    /// The row of the vertex nearest to `at` by angle (`gpui-component`'s
    /// radar finds the spoke nearest to the cursor, `radar_chart.rs:415`),
    /// within the outer radius; none outside it or without vertices.
    fn row_at(&self, at: Point<Points>) -> Option<u32> {
        let (dx, dy) = (at.x.0 - self.center.x.0, at.y.0 - self.center.y.0);
        if dx.hypot(dy) > self.outer {
            return None;
        }
        // The screen's angle as a pie angle: 0 at 12 o'clock, clockwise.
        let angle = dy.atan2(dx) + TAU / 4.0;
        let apart = |a: f32| {
            let d = (angle - a).rem_euclid(TAU);
            d.min(TAU - d)
        };
        self.vertices
            .iter()
            .min_by(|a, b| apart(a.angle).total_cmp(&apart(b.angle)))
            .map(|v| v.row)
    }

    /// The frame it grows out of as it appears: each vertex at the inner
    /// radius (`gpui-component`'s radar scales its radii by the appear's
    /// progress, `radar_chart.rs:535`).
    fn grown(&self) -> Frame {
        Frame {
            vertices: self
                .vertices
                .iter()
                .map(|v| Vertex {
                    radius: self.inner,
                    ..*v
                })
                .collect(),
            ..self.clone()
        }
    }

    /// The frame `self` (an earlier shape) moves to `to` from, vertex for
    /// vertex: a row in both from its own place, a new row from the inner
    /// radius at its angle, so it grows out as its neighbours move.
    fn toward(&self, to: &Frame) -> Frame {
        Frame {
            center: to.center,
            inner: self.inner,
            outer: self.outer,
            vertices: to
                .vertices
                .iter()
                .map(|v| match self.vertices.iter().find(|w| w.row == v.row) {
                    Some(w) => *w,
                    None => Vertex {
                        radius: self.inner,
                        ..*v
                    },
                })
                .collect(),
        }
    }

    /// Its vertices' points, `radius` out (each vertex's own without).
    fn points(&self, radius: Option<f32>) -> Vec<[f32; 2]> {
        self.vertices
            .iter()
            .map(|v| polar(self.center, v.angle, radius.unwrap_or(v.radius)))
            .collect()
    }
}

/// A step of a path, its numbers in the plot's coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Seg {
    Move([f32; 2]),
    Line([f32; 2]),
    Cubic([f32; 6]),
    Close,
}

impl Seg {
    /// Its numbers: x and y in turn.
    fn nums(&self) -> &[f32] {
        match self {
            Seg::Move(n) | Seg::Line(n) => n,
            Seg::Cubic(n) => n,
            Seg::Close => &[],
        }
    }
}

/// Adds the path through `points` as `curve` connects them (`closed`: back
/// to the first, d3's closed curves), starting with a move to the first
/// point (`join`: a line to it, from where the path is).
fn trace(out: &mut Vec<Seg>, points: &[[f32; 2]], curve: Curve, closed: bool, join: bool) {
    let n = points.len();
    let Some(&first) = points.first() else {
        return;
    };
    out.push(match join {
        true => Seg::Line(first),
        false => Seg::Move(first),
    });
    // The segments, with the one back to the first point when closed.
    let segments = match closed && n > 2 {
        true => n,
        false => n - 1,
    };
    let at = |i: usize| points[i % n];
    match curve {
        Curve::Linear => out.extend((1..=segments).map(|i| Seg::Line(at(i)))),
        Curve::StepAfter => {
            for i in 0..segments {
                let (a, b) = (at(i), at(i + 1));
                out.push(Seg::Line([b[0], a[1]]));
                out.push(Seg::Line(b));
            }
        }
        // Each segment a cubic through its neighbours' tangents (`line.rs`'s
        // `trace`); closed, the neighbours wrap round (d3's
        // `curveCardinalClosed` with no tension), open, the ends are their
        // own neighbours.
        Curve::Natural => {
            for i in 0..segments {
                let p0 = match closed {
                    true => at(i + n - 1),
                    false => points[i.saturating_sub(1)],
                };
                let (p1, p2) = (at(i), at(i + 1));
                let p3 = match closed {
                    true => at(i + 2),
                    false => points[(i + 2).min(n - 1)],
                };
                out.push(Seg::Cubic([
                    p1[0] + (p2[0] - p0[0]) / 6.0,
                    p1[1] + (p2[1] - p0[1]) / 6.0,
                    p2[0] - (p3[0] - p1[0]) / 6.0,
                    p2[1] - (p3[1] - p1[1]) / 6.0,
                    p2[0],
                    p2[1],
                ]));
            }
        }
    }
    if closed && n > 2 {
        out.push(Seg::Close);
    }
}

/// What a radial line draws of a frame: its line, and its area down to the
/// inner radius (d3's `areaRadial` with a constant `innerRadius`).
#[derive(Debug, Clone, PartialEq, Default)]
struct Outline {
    line: Vec<Seg>,
    area: Vec<Seg>,
}

impl Outline {
    /// The outline of `frame`; `hole`: its area keeps clear of the inner
    /// radius (an edge there, traced back through the rows' angles with
    /// the same curve), else it closes to the center.
    fn of(frame: &Frame, curve: Curve, closed: bool, hole: bool) -> Self {
        let outer = frame.points(None);
        let mut line = Vec::new();
        trace(&mut line, &outer, curve, closed, false);
        let mut area = line.clone();
        if outer.len() > 1 {
            let mut inner = frame.points(Some(frame.inner));
            inner.reverse();
            match (closed && outer.len() > 2, hole) {
                // A ring: the inner loop the other way round.
                (true, true) => trace(&mut area, &inner, curve, true, false),
                (true, false) => {}
                (false, true) => {
                    trace(&mut area, &inner, curve, false, true);
                    area.push(Seg::Close);
                }
                (false, false) => {
                    area.push(Seg::Line([frame.center.x.0, frame.center.y.0]));
                    area.push(Seg::Close);
                }
            }
        }
        Outline { line, area }
    }

    /// How far it reaches past the edges of a plot of `size` (a vertex out
    /// of the domain, an outer radius past the plot, a curve's swing).
    fn reach(&self, size: Size<Points>) -> f32 {
        let (w, h) = (size.width.0, size.height.0);
        self.line
            .iter()
            .flat_map(|s| s.nums().as_chunks::<2>().0)
            .fold(0.0_f32, |over, &[x, y]| {
                over.max(-x).max(x - w).max(-y).max(y - h)
            })
    }
}

/// `to`, or while a motion runs (`t`: its progress), the animator's line
/// from `from` to it.
fn lerp(t: Option<AnimatedNode>, from: f32, to: f32) -> Var {
    match t {
        Some(t) if from != to => Var::Node(t.interpolate(&[0.0, 1.0], &[from, to])),
        _ => Var::Const(to),
    }
}

/// Records the path of `to`, moving from `from` (step for step) while a
/// motion runs.
fn record(mut p: Painter, to: &[Seg], from: Option<(&[Seg], AnimatedNode)>) -> Painter {
    for (i, seg) in to.iter().enumerate() {
        let before = from.and_then(|(segs, t)| Some((segs.get(i)?, t)));
        let num = |k: usize| match before {
            Some((b, t)) => lerp(Some(t), b.nums()[k], seg.nums()[k]),
            None => Var::Const(seg.nums()[k]),
        };
        p = match seg {
            Seg::Move(_) => p.move_to(&num(0), &num(1)),
            Seg::Line(_) => p.line_to(&num(0), &num(1)),
            Seg::Cubic(_) => {
                let nums: [Num; 6] = std::array::from_fn(|k| p.num(&num(k)));
                p.op(CanvasOp::Path(PathOp::CubicTo(nums)))
            }
            Seg::Close => p.close_path(),
        };
    }
    p
}

/// The props of [`RadialLine`].
#[derive(Debug, Clone, PartialEq, Props)]
#[props(generic)]
pub struct RadialLineProps {
    /// What places each row out from the center (`gpui-base`'s
    /// `RadialLine::radius`, d3's `lineRadial().radius`): a field name or
    /// a function of the row and its index, a value of the plot's y scale
    /// (from `innerRadius` at the domain's smallest value to `outerRadius`
    /// at its largest); the plot's `y` without. A row without one is
    /// skipped.
    pub radius: Prop<Option<RowAccessor>>,
    /// Where each row goes round the center (`RadialLine::angle`, d3's
    /// `lineRadial().angle`): a field name or a function of the row and
    /// its index, in radians from 12 o'clock, clockwise. Without one, the
    /// rows go evenly from `startAngle` to `endAngle`, in order: round a
    /// whole turn a step of `1 / rows` of it apart, so the last row is a
    /// step before the first.
    pub angle: Prop<Option<RowAccessor>>,
    /// Where the first row goes without an `angle`: radians from 12
    /// o'clock, clockwise; 0 by default.
    #[prop(default)]
    pub start_angle: Prop<Radians>,
    /// Where the rows end without an `angle`: a whole turn (`2 *
    /// Math.PI`) by default. Over a part of a turn the last row is on it.
    #[prop(default = Radians(TAU))]
    pub end_angle: Prop<Radians>,
    /// The radius of the y domain's smallest value and of its area's inner
    /// edge (d3's `areaRadial().innerRadius`): points, or a percentage of
    /// the largest circle the plot holds; 0 by default, the center.
    #[prop(default)]
    pub inner_radius: Prop<DefiniteLength>,
    /// The radius of the y domain's largest value: points, or a percentage
    /// of the largest circle the plot holds; `"100%"` by default.
    #[prop(default = DefiniteLength::Fraction(Percentage(1.0)))]
    pub outer_radius: Prop<DefiniteLength>,
    /// How it connects its points (`gpui-base`'s `RadialLine` draws
    /// straight segments, d3's `curveLinear`): `"linear"` (the default),
    /// `"natural"` (a smooth curve) or `"stepAfter"`.
    #[prop(default = Curve::Linear)]
    pub curve: Prop<Curve>,
    /// It goes back from its last point to its first (`RadialLine::closed`,
    /// d3's `curveLinearClosed`, and `curveCardinalClosed` for a smooth
    /// one): a radar's polygon. False by default.
    #[prop(default)]
    pub closed: Prop<bool>,
    /// A dot on every point (`RadialLine::dot`): the `dot` part.
    #[prop(default)]
    pub dot: Prop<bool>,
    /// The Tailwind classes of its dots (`RadialLine::dot_size`,
    /// `dot_fill`, `dot_stroke`): a view centered on each point, its size,
    /// background and border the app's.
    pub dot_class: Prop<Option<SharedString>>,
    /// The style of its dots, over `dotClass`.
    #[prop(default)]
    pub dot_style: Prop<Style>,
    /// The Tailwind classes of its background, the `background` part: a
    /// box around its outer circle, its background (`bg-*`, a gradient)
    /// shown only inside its area, under its `fill`, as `Area`'s.
    pub background_class: Prop<Option<SharedString>>,
    /// The style of its background, over `backgroundClass`.
    #[prop(default)]
    pub background_style: Prop<Style>,
    /// The Tailwind classes of its hover dot, the `hoverDot` part: the dot
    /// on its point at the row under the pointer (`gpui-component`'s
    /// radar marks the hovered spoke's vertex of each series,
    /// `radar_chart.rs:612`), its size, background and border the app's;
    /// the plot's `dotClass` where none is set. `hidden` shows none.
    pub hover_dot_class: Prop<Option<SharedString>>,
    /// The style of its hover dot, over `hoverDotClass`; the plot's
    /// `dotStyle` where none is set.
    #[prop(default)]
    pub hover_dot_style: Prop<Style>,
}

/// A series of a [`Plot`](super::Plot) around its center (`gpui-base`'s
/// `RadialLine`, d3's `lineRadial` and `areaRadial`): a point per row with
/// a value, at the row's angle (`angle`, or the rows evenly round the
/// turn) and as far out as the plot's y scale puts its value between
/// `innerRadius` and `outerRadius`, the rows without one skipped; `closed`
/// joins the last point to the first, a radar's polygon. It strokes its
/// line with its `stroke` (`currentColor` where none is set) and fills its
/// area down to `innerRadius` (the center by default) with its `fill`
/// (none where none is set), over its `background` part (a gradient); its
/// paint inherits from the plot as CSS's does. Its values count in the y
/// scale's domain when the plot has none, with 0, the center. Over it, the
/// plot reports the row whose angle is nearest the pointer's within the
/// outer radius, and its hover dot sits on that row's point. It grows out
/// of its inner radius with the plot's appear, and moves to new values,
/// angles and radii with the plot's `motion.update`.
#[component]
pub fn RadialLine(props: RadialLineProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let plot = PlotContext::of("RadialLine");
    let Some(plot) = plot else {
        return layer();
    };
    let (curve, closed) = (props.curve, props.closed);
    let (start, end) = (props.start_angle, props.end_angle);
    let (inner, outer) = (props.inner_radius, props.outer_radius);
    let radius = props.radius;
    let rows = move || plot.rows.get();
    let radii = values(rows, move || radius.get().or_else(|| plot.y.get()));
    let angle = props.angle;
    let angles = values(rows, move || angle.get());
    let domain = radial_domain(plot);
    let polar = computed(move || -> Polar {
        let len = plot.rows.with(|rows| rows.len());
        let radii = radii.get();
        let angles = angles.get();
        // The app's angles, once read: none before.
        let own = angle.with(Option::is_some);
        let (start, end) = (start.get().0, end.get().0);
        let spokes = match (&radii, own, &angles) {
            (Some(radii), false, _) | (Some(radii), true, Some(_)) => (0..len)
                .filter_map(|i| {
                    let value = *radii.get(i).filter(|v| v.is_finite())?;
                    let angle = match &angles {
                        Some(angles) if own => *angles.get(i).filter(|a| a.is_finite())? as f32,
                        _ => spoke_angle(i, len, start, end),
                    };
                    Some(Spoke {
                        row: i as u32,
                        angle,
                        value,
                    })
                })
                .collect(),
            _ => Shared::from([]),
        };
        Polar {
            spokes,
            domain: domain.get(),
            inner: Radius::of(inner.get()),
            outer: Radius::of(outer.get()),
        }
    });
    // Its values, and the center's 0, in the y domain; its hover dot is
    // its own (below), not one the plot places along the x axis.
    let span = computed(move || {
        let values = radii.get()?;
        extent(values.iter().copied().chain([0.0]))
    });
    plot.add(move |key| Mark {
        key,
        extent: span,
        value_axis: computed(|| super::Axis::Y),
        points: computed(|| -> Shared<[Point<Points>]> { Shared::from([]) }),
        dot_x: animated_value(0.0),
        dot_y: animated_value(0.0),
        dot: None,
    });
    // Where it draws at rest: the pose its motion moves to, which holds
    // still while the animator tells how far a stopped move had gone.
    let update = Update::new(plot, move || polar.get());
    let rest = computed(move || update.shown().0.frame(plot.size.get()));
    plot.add_hit(
        move |at| rest.with_untracked(|f| f.row_at(at)),
        move |row| rest.with_untracked(|f| f.point_of(row)),
    );
    // Where it moves from now: its inner radius while the plot appears, its
    // last shape while an update runs.
    let moving = move |rest: &Frame| -> Option<(Frame, AnimatedNode)> {
        if plot.appearing.get() {
            return Some((rest.grown(), plot.appear.progress()));
        }
        let (before, t) = update.shown().1?;
        Some((before.frame(plot.size.get()).toward(rest), t))
    };
    // Its outlines now: at rest, or the two a motion moves between, with
    // the same steps (a hole in both if either has one).
    let outlines = move || -> (Outline, Option<(Outline, AnimatedNode)>) {
        let rest = rest.get();
        let (curve, closed) = (curve.get(), closed.get());
        let from = moving(&rest);
        let hole = rest.inner > 0.0 || from.as_ref().is_some_and(|(f, _)| f.inner > 0.0);
        let to = Outline::of(&rest, curve, closed, hole);
        let from = from.map(|(f, t)| (Outline::of(&f, curve, closed, hole), t));
        (to, from)
    };
    let at_rest = computed(move || {
        let (curve, closed) = (curve.get(), closed.get());
        rest.with(|f| Outline::of(f, curve, closed, f.inner > 0.0))
    });
    let bleed = move || STROKE_ROOM + at_rest.with(|o| o.reach(plot.size.get())).ceil();
    let (background_class, background_style) = (props.background_class, props.background_style);
    let has_background = move || {
        background_class.with(Option::is_some) || background_style.with(|s| *s != Style::default())
    };
    let hover_dot = HoverDot {
        class: props.hover_dot_class,
        style: props.hover_dot_style,
    };
    let (dot, dot_class, dot_style) = (props.dot, props.dot_class, props.dot_style);
    layer()
        // The background part: shown inside the area only, as `Area`'s.
        .child(when(has_background, move || {
            let nothing = |p: Painter| p.begin_path().fill_background_from_view(Bounds::default());
            mark_canvas_with(
                Some(plot),
                bleed,
                move || nothing(Painter::new()),
                move |p, _| {
                    let (to, from) = outlines();
                    if to.line.is_empty() {
                        return nothing(p);
                    }
                    // A box round its outer circle: a radial gradient
                    // centers on the plot's center.
                    let f = rest.get();
                    let corner = point(px(f.center.x.0 - f.outer), px(f.center.y.0 - f.outer));
                    let area = Bounds::new(corner, size(px(2.0 * f.outer), px(2.0 * f.outer)));
                    let from = from.as_ref().map(|(o, t)| (&o.area[..], *t));
                    record(p.begin_path(), &to.area, from).fill_background_from_view(area)
                },
            )
            .app_class(background_class)
            .inline_style(background_style)
        }))
        .child(mark_canvas(Some(plot), bleed, move |p, _| {
            let p = p.fill_style_from_view(SvgPaint::None);
            let (to, from) = outlines();
            if to.line.is_empty() {
                return p;
            }
            let area_from = from.as_ref().map(|(o, t)| (&o.area[..], *t));
            let line_from = from.as_ref().map(|(o, t)| (&o.line[..], *t));
            let p = record(p.begin_path(), &to.area, area_from)
                .fill()
                .stroke_style_from_view(SvgPaint::CurrentColor)
                .line_width_from_view()
                .line_dash_from_view();
            record(p.begin_path(), &to.line, line_from).stroke()
        }))
        .child(when(
            move || dot.get(),
            move || {
                let dot = Dot {
                    plot,
                    rest,
                    update,
                    class: dot_class,
                    style: dot_style,
                };
                each(
                    move || rest.with(|f| f.vertices.iter().map(|v| v.row).collect::<Vec<u32>>()),
                    |row| *row,
                    move |row, _| dot.view(row.get_untracked()),
                )
            },
        ))
        .child(hover_dot_view(plot, rest, hover_dot))
}

/// What a radial line's dots (the `dot` part) are drawn from.
#[derive(Clone, Copy)]
struct Dot {
    plot: PlotContext,
    rest: Memo<Frame>,
    update: Update<Polar>,
    class: Prop<Option<SharedString>>,
    style: Prop<Style>,
}

impl Dot {
    /// The dot on row `row`'s point. While the line appears or moves it
    /// shows from where the motion starts, the distance closing on the
    /// animator as the line's points move.
    fn view(self, row: u32) -> View {
        let Dot {
            plot, rest, update, ..
        } = self;
        let (ax, ay) = (animated_value(0.0), animated_value(0.0));
        let (ux, uy) = (animated_value(0.0), animated_value(0.0));
        effect(move || {
            let Some(at) = rest.with(|f| f.point_of(row)) else {
                return;
            };
            let off = |from: Option<Point<Points>>, (x, y): (AnimatedValue, AnimatedValue)| {
                let p = from.unwrap_or(at);
                x.set(p.x.0 - at.x.0);
                y.set(p.y.0 - at.y.0);
            };
            let appearing = plot.appearing.get();
            let grown = appearing.then(|| rest.with(|f| f.grown().point_of(row)));
            off(grown.flatten(), (ax, ay));
            let before = update.shown().1.and_then(|(before, _)| {
                let size = plot.size.get();
                rest.with(|f| before.frame(size).toward(f).point_of(row))
            });
            off(before.filter(|_| !appearing), (ux, uy));
        });
        let left_a = plot.appear.progress().mul(-1.0).add(1.0);
        let left_u = update.progress.mul(-1.0).add(1.0);
        view()
            .absolute()
            .w(px(0.0))
            .h(px(0.0))
            .items_center()
            .justify_center()
            .pointer_events(PointerEvents::None)
            .style_with(move |s| match rest.with(|f| f.point_of(row)) {
                Some(p) => s.left(p.x).top(p.y),
                None => s,
            })
            .bind_translate_x(&ax.mul(&left_a).add(&ux.mul(&left_u)))
            .bind_translate_y(&ay.mul(&left_a).add(&uy.mul(&left_u)))
            .child(
                view()
                    .flex_none()
                    .app_class(self.class)
                    .inline_style(self.style),
            )
    }
}

/// A radial line's hover dot: on the hovered row's point, taking the first
/// row at once, gliding to the next on the plot's pointer spring when the
/// keys step there and moving with the pointer in the same frame, faded
/// with the hover; styled by the line (`hoverDotClass`) or the plot
/// (`dotClass`), none where neither styles one.
fn hover_dot_view(plot: PlotContext, rest: Memo<Frame>, own: HoverDot) -> impl IntoElement {
    let (x, y) = (animated_value(0.0), animated_value(0.0));
    let on = stored(None::<u32>);
    effect(move || {
        let hovered = plot.hovered.get();
        let Some(at) = hovered.and_then(|row| rest.with(|f| f.point_of(row))) else {
            on.replace(None);
            return;
        };
        let was = on.get();
        on.replace(hovered);
        let glide = was.is_some() && was != hovered && plot.keyed.get() && !reduce_motion();
        let spring = untracked(|| plot.motion.get().and_then(|m| m.pointer));
        match spring.filter(|_| glide) {
            Some(spring) => {
                drop(x.spring(at.x.0, spring));
                drop(y.spring(at.y.0, spring));
            }
            None => {
                x.set(at.x.0);
                y.set(at.y.0);
            }
        }
    });
    let mine = move || own.style.with(|s| *s != Style::default());
    when(
        move || plot.interactive.get() && (own.is_set() || plot.dot.is_set()),
        move || {
            dot_anchor(&x, &y, &plot.fade).child(
                view()
                    .flex_none()
                    .app_class(move || own.class.get().or_else(|| plot.dot.class.get()))
                    .inline_style(move || match mine() {
                        true => own.style.get(),
                        false => plot.dot.style.get(),
                    }),
            )
        },
    )
}

/// The props of [`RadialGrid`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct RadialGridProps {
    /// Where its rings go, as values of the plot's y scale (as `Grid`'s
    /// `y`): each as far out as a [`RadialLine`] puts that value, between
    /// `innerRadius` and `outerRadius`.
    #[prop(default)]
    pub rings: Prop<Vec<f64>>,
    /// A spoke from `innerRadius` to `outerRadius` at each row's angle,
    /// the rows evenly from `startAngle` to `endAngle` as a
    /// [`RadialLine`] without an `angle` places them: a radar's axes.
    #[prop(default)]
    pub spokes: Prop<bool>,
    /// Its rings are circles (arcs over a part of a turn); by default they
    /// are polygons through the rows' angles (`gpui-component`'s radar
    /// grid, `radar_chart.rs:505`), circles with fewer than three rows.
    #[prop(default)]
    pub circular: Prop<bool>,
    /// Where the rows start: radians from 12 o'clock, clockwise; 0 by
    /// default.
    #[prop(default)]
    pub start_angle: Prop<Radians>,
    /// Where they end: a whole turn (`2 * Math.PI`) by default.
    #[prop(default = Radians(TAU))]
    pub end_angle: Prop<Radians>,
    /// The radius of the y domain's smallest value and where its spokes
    /// start: points, or a percentage of the largest circle the plot
    /// holds; 0 by default.
    #[prop(default)]
    pub inner_radius: Prop<DefiniteLength>,
    /// The radius of the y domain's largest value and where its spokes
    /// end: points, or a percentage of the largest circle the plot holds;
    /// `"100%"` by default.
    #[prop(default = DefiniteLength::Fraction(Percentage(1.0)))]
    pub outer_radius: Prop<DefiniteLength>,
}

/// What a radial grid's motion moves between: the domain placing its
/// rings and its radii.
#[derive(Debug, Clone, Copy, PartialEq)]
struct GridShape {
    domain: Option<[f64; 2]>,
    inner: Radius,
    outer: Radius,
}

impl Pose for GridShape {
    fn lerp(&self, to: &Self, t: f32) -> Self {
        GridShape {
            domain: lerp_domain(self.domain, to.domain, t),
            inner: self.inner.lerp(to.inner, t),
            outer: self.outer.lerp(to.outer, t),
        }
    }
}

/// A radar's grid in a [`Plot`](super::Plot) (`gpui-component`'s radar
/// draws its rings with `RadialLine` and its spokes as lines,
/// `radar_chart.rs:505-533`; `Grid`'s polar counterpart): rings around the
/// plot's center at the values `rings` of its y scale, polygons through
/// the rows' angles or `circular`, and with `spokes` a line out from the
/// inner radius at each row's angle. It strokes with its paint properties
/// (`stroke-*`, `strokeWidth`, `strokeDasharray`; inherited from the plot
/// as CSS inherits them), `currentColor` where none is set. Its values do
/// not count in the scale's domain; its rings move with the domain and the
/// radii over the plot's `motion.update`, with the radial lines.
#[component]
pub fn RadialGrid(props: RadialGridProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let plot = PlotContext::of("RadialGrid");
    let Some(plot) = plot else {
        return mark_canvas(None, || STROKE_ROOM, |p, _| p);
    };
    let (rings, spokes, circular) = (props.rings, props.spokes, props.circular);
    let (start, end) = (props.start_angle, props.end_angle);
    let (inner, outer) = (props.inner_radius, props.outer_radius);
    let domain = radial_domain(plot);
    let shape = computed(move || GridShape {
        domain: domain.get(),
        inner: Radius::of(inner.get()),
        outer: Radius::of(outer.get()),
    });
    let update = Update::new(plot, move || shape.get());
    let bleed = move || {
        let ring = Ring::of(
            plot.size.get(),
            Radius::of(inner.get()),
            Radius::of(outer.get()),
        );
        let half = plot.size.with(|s| s.width.0.min(s.height.0)) / 2.0;
        STROKE_ROOM + (ring.outer.max(ring.inner) - half).max(0.0).ceil()
    };
    mark_canvas(Some(plot), bleed, move |p, _| {
        let mut p = p
            .stroke_style_from_view(SvgPaint::CurrentColor)
            .line_width_from_view()
            .line_dash_from_view()
            .begin_path();
        let size = plot.size.get();
        // What it draws: the shape it moves to (still while the animator
        // tells how far a stopped move had gone) and the one it moves from.
        let (to, from) = update.shown();
        let ring = Ring::of(size, to.inner, to.outer);
        let from = from.map(|(f, t)| (f, Ring::of(size, f.inner, f.outer), t));
        let t = from.map(|(.., t)| t);
        let map = |s: GridShape, r: Ring| s.domain.map(|d| Linear::new(d, [r.inner, r.outer]));
        let (to_map, from_map) = (map(to, ring), from.and_then(|(f, r, _)| map(f, r)));
        let (cx, cy) = (ring.center.x.0, ring.center.y.0);
        // A point `r` out at `angle` (pie angles), moving out from where
        // `r0` put it.
        let at = |angle: f32, r0: f32, r: f32| {
            let ([x0, y0], [x, y]) = (polar(ring.center, angle, r0), polar(ring.center, angle, r));
            (lerp(t, x0, x), lerp(t, y0, y))
        };
        let len = plot.rows.with(|rows| rows.len());
        let (a0, a1) = (start.get().0, end.get().0);
        let whole = (a1 - a0).abs() >= TAU - EPSILON;
        let angles: Vec<f32> = (0..len).map(|i| spoke_angle(i, len, a0, a1)).collect();
        let fewest = if whole { 3 } else { 2 };
        let polygon = !circular.get() && angles.len() >= fewest;
        // The canvas's arcs run from 3 o'clock; a pie angle's 0 is 12.
        let screen = |a: f32| a - TAU / 4.0;
        if let Some(to_map) = to_map {
            for v in rings.get() {
                let Some(r) = to_map.tick(v) else { continue };
                let r0 = from_map.and_then(|m| m.tick(v)).unwrap_or(r);
                if polygon {
                    for (i, &a) in angles.iter().enumerate() {
                        let (x, y) = at(a, r0, r);
                        p = match i {
                            0 => p.move_to(&x, &y),
                            _ => p.line_to(&x, &y),
                        };
                    }
                    if whole {
                        p = p.close_path();
                    }
                } else {
                    let (x, y) = at(a0, r0, r);
                    let radius = lerp(t, r0, r);
                    let (s, e) = match whole {
                        true => (screen(a0), screen(a0) + TAU),
                        false => (screen(a0), screen(a1)),
                    };
                    p = p.move_to(&x, &y);
                    p = match e < s {
                        true => p.arc_counterclockwise(cx, cy, &radius, s, e),
                        false => p.arc(cx, cy, &radius, s, e),
                    };
                }
            }
        }
        if spokes.get() {
            let (i0, o0) = match from {
                Some((_, r, _)) => (r.inner, r.outer),
                None => (ring.inner, ring.outer),
            };
            for &a in &angles {
                let (x, y) = at(a, i0, ring.inner);
                p = p.move_to(&x, &y);
                let (x, y) = at(a, o0, ring.outer);
                p = p.line_to(&x, &y);
            }
        }
        p.stroke()
    })
}

#[cfg(test)]
mod tests {
    use std::f32::consts::{PI, TAU};

    use nsh_core::prelude::*;

    use super::{Curve, Frame, Outline, Seg, Vertex, spoke_angle};

    /// A frame of four rows at 12, 3, 6 and 9 o'clock round (50, 50), each
    /// 10 out, as `gpui-base`'s test of `RadialLine::points`.
    fn square(inner: f32) -> Frame {
        Frame {
            center: point(px(50.0), px(50.0)),
            inner,
            outer: 40.0,
            vertices: (0..4)
                .map(|i| Vertex {
                    row: i,
                    angle: spoke_angle(i as usize, 4, 0.0, TAU),
                    radius: 10.0,
                })
                .collect(),
        }
    }

    fn near(a: [f32; 2], b: [f32; 2]) -> bool {
        (a[0] - b[0]).abs() < 1e-4 && (a[1] - b[1]).abs() < 1e-4
    }

    /// The rows go evenly round a whole turn, the last a step before the
    /// first; over a part of a turn from its start to its end.
    #[test]
    fn the_rows_go_evenly_round() {
        let is = |got: f32, want: f32| assert!((got - want).abs() < 1e-6, "{got} is not {want}");
        is(spoke_angle(1, 4, 0.0, TAU), PI / 2.0);
        is(spoke_angle(3, 4, 0.0, TAU), 3.0 * PI / 2.0);
        is(spoke_angle(2, 3, -PI / 2.0, PI / 2.0), PI / 2.0);
        is(spoke_angle(0, 1, 0.5, PI), 0.5);
    }

    /// The points at 12, 3, 6 and 9 o'clock; closed, back to the first; its
    /// area to the center is the polygon, with a hole it is a ring.
    #[test]
    fn a_closed_line_is_a_polygon() {
        let f = square(0.0);
        let o = Outline::of(&f, Curve::Linear, true, false);
        let pts: Vec<[f32; 2]> = o
            .line
            .iter()
            .filter_map(|s| match s {
                Seg::Move(p) | Seg::Line(p) => Some(*p),
                _ => None,
            })
            .collect();
        let want = [
            [50.0, 40.0],
            [60.0, 50.0],
            [50.0, 60.0],
            [40.0, 50.0],
            [50.0, 40.0],
        ];
        assert!(pts.iter().zip(want).all(|(a, b)| near(*a, b)), "{pts:?}");
        assert_eq!(o.line.last(), Some(&Seg::Close));
        assert_eq!(o.area, o.line);
        // A hole: the inner loop the other way round, after the outer one.
        let ring = Outline::of(&square(5.0), Curve::Linear, true, true);
        assert_eq!(ring.area.len(), 2 * o.line.len());
        // Open: down to the center and back.
        let open = Outline::of(&f, Curve::Linear, false, false);
        assert_eq!(open.line.len(), 4);
        assert_eq!(open.area[4..], [Seg::Line([50.0, 50.0]), Seg::Close]);
    }

    /// A smooth closed line: a cubic per row, the last back to the first.
    #[test]
    fn a_smooth_closed_line_wraps_its_tangents() {
        let o = Outline::of(&square(0.0), Curve::Natural, true, false);
        let cubics: Vec<_> = o
            .line
            .iter()
            .filter(|s| matches!(s, Seg::Cubic(_)))
            .collect();
        assert_eq!(cubics.len(), 4);
        // The first leaves 12 o'clock level, its tangent from 9 o'clock
        // to 3 o'clock.
        let Seg::Cubic(c) = cubics[0] else {
            unreachable!()
        };
        assert!(near([c[0], c[1]], [50.0 + 20.0 / 6.0, 40.0]), "{c:?}");
        let Seg::Cubic(last) = cubics[3] else {
            unreachable!()
        };
        assert!(near([last[4], last[5]], [50.0, 40.0]));
    }

    /// The pointer finds the row nearest by angle, within the outer
    /// radius.
    #[test]
    fn the_pointer_finds_the_nearest_row_by_angle() {
        let f = square(0.0);
        let at = |x: f32, y: f32| f.row_at(point(px(x), px(y)));
        assert_eq!(at(55.0, 20.0), Some(0));
        assert_eq!(at(80.0, 45.0), Some(1));
        assert_eq!(at(45.0, 80.0), Some(2));
        assert_eq!(at(25.0, 40.0), Some(3));
        // Just left of 12 o'clock: still the first row, round the turn.
        assert_eq!(at(48.0, 15.0), Some(0));
        assert_eq!(at(95.0, 95.0), None);
    }
}
