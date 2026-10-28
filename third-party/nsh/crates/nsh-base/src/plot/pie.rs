//! `Pie` and `Arc`: radial marks around the plot's center, a whole split
//! into slices by the rows' values and a single arc between two angles
//! (`gpui-base`'s `shape/pie.rs` and `shape/arc.rs`, d3's `pie` and `arc`).
//! Angles are radians, 0 at 12 o'clock and growing clockwise, as theirs
//! are; radii are points or a share of the largest circle the plot holds.

use std::{
    f32::consts::{FRAC_PI_2, PI, TAU},
    fmt,
    rc::Rc,
    sync::Arc as Shared,
};

use nsh_core::{
    SvgPaint,
    element::{
        Arg, CanvasArg, JsHost, JsIn, JsKind, JsOwned, JsValue, PropError, RowAccessor, RowRef,
        RowText, Rows, Style, Timing, TsTypes,
    },
    geometry::{DefiniteLength, Percentage, REM_SIZE, Radians},
    prelude::*,
};

use super::{PlotContext, STROKE_ROOM, mark_canvas, series::values};

/// Below this, a radius or an angle is none (`gpui-base`'s `EPSILON`,
/// `shape/arc.rs:9`, at `f32`'s precision).
const EPSILON: f32 = 1e-6;

/// The classes of a [`Pie`]'s slices, the `slice` part, or of its labels'
/// leader lines, the `labelLine` part (TS `string | ((d: T, index:
/// number) => string)`): the same on every slice, or the app's function
/// of a slice's row and its index, as `gpui-component`'s
/// `PieChart::color` and `label_line_color` take a function of the datum
/// (`chart/pie_chart.rs:206`, `:224`), called once per row when the rows
/// or the function change, in the next JS turn, never while the pie draws
/// or follows the pointer (so the function is pure: the same row, the
/// same classes).
#[derive(Clone)]
pub enum SliceClass {
    /// The same classes on every slice.
    All(SharedString),
    /// The app's JS function of a row and its index.
    Js(nsh_core::element::Callback<(RowRef, u32), SharedString>),
    /// A Rust function of a row's index, for pies made in Rust.
    Rust(Rc<dyn Fn(usize) -> SharedString>),
}

impl SliceClass {
    /// The classes `f` gives the slice of each row's index (Rust).
    pub fn from_fn(f: impl Fn(usize) -> SharedString + 'static) -> Self {
        SliceClass::Rust(Rc::new(f))
    }
}

impl fmt::Debug for SliceClass {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SliceClass::All(class) => f.debug_tuple("All").field(class).finish(),
            SliceClass::Js(_) => f.write_str("Js"),
            SliceClass::Rust(_) => f.write_str("Rust"),
        }
    }
}

/// The same classes, or the same Rust function; the app's functions are
/// told apart by the slices' classes they give, so a function set again
/// (an arrow function in JSX is a new one at each render) is called again.
impl PartialEq for SliceClass {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (SliceClass::All(a), SliceClass::All(b)) => a == b,
            (SliceClass::Rust(a), SliceClass::Rust(b)) => Rc::ptr_eq(a, b),
            _ => false,
        }
    }
}

impl From<&'static str> for SliceClass {
    fn from(class: &'static str) -> Self {
        SliceClass::All(class.into())
    }
}

impl From<SharedString> for SliceClass {
    fn from(class: SharedString) -> Self {
        SliceClass::All(class)
    }
}

impl JsValue for SliceClass {
    fn ts_type(_types: &mut TsTypes) -> String {
        "string | ((d: T, index: number) => string)".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        match value.kind() {
            JsKind::String => <SharedString as JsValue>::from_js(value).map(SliceClass::All),
            JsKind::Function => {
                <nsh_core::element::Callback<(RowRef, u32), SharedString> as Arg>::from_js(value)
                    .map(SliceClass::Js)
            }
            _ => Err(value.expected("classes or a function of a row")),
        }
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            SliceClass::All(class) => class.to_js(host),
            // A function stays the app's: it is not handed back.
            _ => Ok(JsOwned::new(host, host.undefined())),
        }
    }
}

/// The classes of each row's slice, once known: at once for the same
/// classes or a Rust function, in the next JS turn for the app's function
/// (a row whose call throws has none of its own).
fn slice_classes(
    rows: impl Fn() -> Rows + 'static,
    class: impl Fn() -> Option<SliceClass> + 'static,
) -> Signal<Option<Shared<[SharedString]>>> {
    let out = signal(None::<Shared<[SharedString]>>);
    // A newer run wins over the answers of an older one.
    let generation = stored(0u64);
    effect(move || {
        let (rows, class) = (rows(), class());
        let run = generation.get() + 1;
        generation.replace(run);
        match class {
            None => out.set(None),
            Some(SliceClass::All(class)) => out.set(Some(vec![class; rows.len()].into())),
            Some(SliceClass::Rust(f)) => out.set(Some((0..rows.len()).map(|i| f(i)).collect())),
            Some(SliceClass::Js(f)) => {
                let answers: Vec<_> = (0..rows.len())
                    .filter_map(|i| rows.row(i).map(|row| f.call_async((row, i as u32))))
                    .collect();
                spawn(async move {
                    let mut classes = Vec::with_capacity(answers.len());
                    for answer in answers {
                        classes.push(answer.await.unwrap_or_default());
                    }
                    if generation.get() == run {
                        out.set(Some(classes.into()));
                    }
                });
            }
        }
    });
    out
}

/// A slice of a pie (`gpui-base`'s `ArcData`, `shape/arc.rs:15`): its row
/// and the angles it spans, 0 at 12 o'clock and growing clockwise.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Slice {
    index: u32,
    start: f32,
    end: f32,
}

/// The slices of `values` from `start` to `end` (`gpui-base`'s
/// `Pie::arcs`, `shape/pie.rs:59`): one per row with a value above zero,
/// in the rows' order, each spanning its share of the angle; the other
/// rows have none.
fn arcs(values: &[f64], start: f32, end: f32) -> Vec<Slice> {
    let kept = || {
        values
            .iter()
            .enumerate()
            .filter(|(_, v)| **v > 0.0 && v.is_finite())
    };
    let sum: f64 = kept().map(|(_, v)| v).sum();
    let mut k = start;
    kept()
        .map(|(index, &v)| {
            let from = k;
            k += match sum > 0.0 {
                true => (v / sum) as f32 * (end - start),
                false => 0.0,
            };
            Slice {
                index: index as u32,
                start: from,
                end: k,
            }
        })
        .collect()
}

/// Where a radial mark draws: the plot's center and its radii, in points.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Ring {
    center: Point<Points>,
    inner: f32,
    outer: f32,
}

/// A radius as a plot's size resolves it: points, and a share of the
/// largest circle the plot holds (half its smaller side, as d3's and
/// Recharts' percentages are), so a radius on its way from a percentage to
/// points resolves at any size.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Radius {
    points: f32,
    share: f32,
}

impl Radius {
    fn of(length: DefiniteLength) -> Self {
        match length {
            DefiniteLength::Absolute(a) => Radius {
                points: a.to_points(REM_SIZE).0,
                share: 0.0,
            },
            DefiniteLength::Fraction(f) => Radius {
                points: 0.0,
                share: f.0,
            },
        }
    }

    /// In points, around a circle of radius `half`.
    fn at(self, half: f32) -> f32 {
        (self.points + self.share * half).max(0.0)
    }

    /// The radius `t` of the way to `to`.
    fn lerp(self, to: Radius, t: f32) -> Radius {
        Radius {
            points: self.points + (to.points - self.points) * t,
            share: self.share + (to.share - self.share) * t,
        }
    }
}

impl Ring {
    /// The ring of a plot of `size` (`gpui-base`'s `Arc::path`: the center
    /// of the bounds, `shape/arc.rs:105`) between `inner` and `outer`.
    fn of(size: Size<Points>, inner: Radius, outer: Radius) -> Self {
        let half = size.width.0.min(size.height.0) / 2.0;
        Ring {
            center: point(size.width / 2.0, size.height / 2.0),
            inner: inner.at(half),
            outer: outer.at(half),
        }
    }

    /// How far a mark of this ring, its outer edge `lift` further out,
    /// reaches past the edges of a plot of `size`.
    fn reach(&self, size: Size<Points>, lift: f32) -> f32 {
        let half = size.width.0.min(size.height.0) / 2.0;
        (self.outer + lift - half).max(0.0)
    }

    /// The row of the slice under `at` (`gpui-base`'s `Arc::contains`,
    /// `shape/arc.rs:191`): within a slice's angles and between the ring's
    /// radii at rest. The angles are read from the pie's own first angle,
    /// `from`, so a pie that starts before 12 o'clock or turns the other
    /// way finds its slices too.
    fn slice_at(&self, slices: &[Slice], from: f32, at: Point<Points>) -> Option<u32> {
        let dx = at.x.0 - self.center.x.0;
        let dy = at.y.0 - self.center.y.0;
        let radius = dx.hypot(dy);
        if radius < self.inner || radius > self.outer {
            return None;
        }
        // The screen's angle as the pie's: 0 at 12 o'clock, clockwise, in
        // the turn from `from`.
        let angle = from + (dy.atan2(dx) + FRAC_PI_2 - from).rem_euclid(TAU);
        slices
            .iter()
            .find(|s| (s.start.min(s.end)..s.start.max(s.end)).contains(&angle))
            .map(|s| s.index)
    }

    /// The middle of `slice`: halfway between the ring's radii at rest, at
    /// the middle of its angles (0 at 12 o'clock, clockwise).
    fn middle(&self, slice: &Slice) -> Point<Points> {
        let radius = (self.inner + self.outer) / 2.0;
        let angle = (slice.start + slice.end) / 2.0;
        point(
            px(self.center.x.0 + radius * angle.sin()),
            px(self.center.y.0 - radius * angle.cos()),
        )
    }
}

/// A radial mark's shape at a moment: its radii, in points, and the angles
/// it spans (pie angles, `lo` before `hi`).
#[derive(Debug, Clone, Copy, PartialEq)]
struct Shape {
    inner: f32,
    outer: f32,
    lo: f32,
    hi: f32,
}

impl Shape {
    /// The sector of `ring` from `start` to `end`, either way round.
    fn new(ring: Ring, start: f32, end: f32) -> Self {
        Shape {
            inner: ring.inner,
            outer: ring.outer,
            lo: start.min(end),
            hi: start.max(end),
        }
    }

    /// The shape `t` of the way from `self` to `to`.
    fn lerp(&self, to: &Shape, t: f32) -> Shape {
        let at = |a: f32, b: f32| a + (b - a) * t;
        Shape {
            inner: at(self.inner, to.inner),
            outer: at(self.outer, to.outer),
            lo: at(self.lo, to.lo),
            hi: at(self.hi, to.hi),
        }
    }
}

/// What a radial mark's update moves (`motion.update`): its shape as the
/// app gives it, apart from the plot's size.
trait Pose: Clone + PartialEq + 'static {
    /// The pose drawn `t` of the way from `self` to `to`.
    fn lerp(&self, to: &Self, t: f32) -> Self;
}

/// An arc's pose: its radii and the angles it spans (pie angles, `lo`
/// before `hi`).
#[derive(Debug, Clone, Copy, PartialEq)]
struct ArcPose {
    inner: Radius,
    outer: Radius,
    lo: f32,
    hi: f32,
}

impl ArcPose {
    /// The arc between `inner` and `outer` from `start` to `end`, either
    /// way round.
    fn new(inner: Radius, outer: Radius, start: f32, end: f32) -> Self {
        ArcPose {
            inner,
            outer,
            lo: start.min(end),
            hi: start.max(end),
        }
    }

    /// Its shape on a plot of `size`.
    fn shape(&self, size: Size<Points>) -> Shape {
        Shape::new(Ring::of(size, self.inner, self.outer), self.lo, self.hi)
    }
}

impl Pose for ArcPose {
    fn lerp(&self, to: &Self, t: f32) -> Self {
        let at = |a: f32, b: f32| a + (b - a) * t;
        ArcPose {
            inner: self.inner.lerp(to.inner, t),
            outer: self.outer.lerp(to.outer, t),
            lo: at(self.lo, to.lo),
            hi: at(self.hi, to.hi),
        }
    }
}

/// A pie's pose: its radii, its first angle and its slices.
#[derive(Debug, Clone, PartialEq)]
struct PiePose {
    inner: Radius,
    outer: Radius,
    start: f32,
    slices: Shared<[Slice]>,
}

impl PiePose {
    /// The pose of row `row`'s slice, if it has one.
    fn slice(&self, row: u32) -> Option<ArcPose> {
        let s = self.slices.iter().find(|s| s.index == row)?;
        Some(ArcPose::new(self.inner, self.outer, s.start, s.end))
    }

    /// Where row `row`'s slice moves from when the pie moves on from this
    /// pose to one starting at `start` ([`slice_from`]).
    fn slice_from(&self, row: u32, start: f32) -> ArcPose {
        let (a, b) = slice_from(&self.slices, row, start);
        ArcPose::new(self.inner, self.outer, a, b)
    }
}

impl Pose for PiePose {
    /// The slices of `to`, each `t` of the way from where it moves from.
    fn lerp(&self, to: &Self, t: f32) -> Self {
        let at = |a: f32, b: f32| a + (b - a) * t;
        let slices = to.slices.iter().map(|s| {
            let (a, b) = slice_from(&self.slices, s.index, to.start);
            Slice {
                index: s.index,
                start: at(a, s.start),
                end: at(b, s.end),
            }
        });
        PiePose {
            inner: self.inner.lerp(to.inner, t),
            outer: self.outer.lerp(to.outer, t),
            start: to.start,
            slices: slices.collect(),
        }
    }
}

/// A radial mark's move to the shape it draws: from `from`, as far as
/// `progress` has gone (0 to 1, on the platform's animator). The appear
/// sweeps the angles from the ring's start, each `start + (angle - start)
/// * progress` (`gpui-component`'s pie, `chart/pie_chart.rs:318-334`);
/// `motion.update` moves the angles and the radii from the app's last
/// ones (d3's `arcTween`).
#[derive(Clone, Copy)]
struct Motion {
    progress: AnimatedNode,
    from: Shape,
}

impl Motion {
    /// The appear's sweep to `to` from `start` (the mark's first angle).
    fn sweep(progress: AnimatedNode, to: Shape, start: f32) -> Self {
        Motion {
            progress,
            from: Shape {
                lo: start,
                hi: start,
                ..to
            },
        }
    }

    /// How a mark of `to` moves now: it sweeps in while the plot appears,
    /// else it moves from `from` while its update runs.
    fn of(
        plot: PlotContext,
        to: Shape,
        start: f32,
        from: Option<(Shape, AnimatedNode)>,
    ) -> Option<Self> {
        if plot.appearing.get() {
            return Some(Self::sweep(plot.appear.progress(), to, start));
        }
        from.map(|(from, progress)| Motion { progress, from })
    }
}

/// A pair of corners of a slice, one at each of its edges (d3's
/// `cornerTangents`, `arc.js`): circles of `radius` (0: a sharp corner)
/// whose centers lie `distance` from the ring's center, `angle` in from
/// the slice's edges. The rim (or the hole's edge) between them runs where
/// they touch it, `distance + radius` out (`distance - radius` inside).
#[derive(Debug, Clone, Copy, PartialEq)]
struct Corner {
    radius: f32,
    distance: f32,
    angle: f32,
}

/// What a slice draws (d3's `arc` with `cornerRadius`): its angles, and
/// its corners at the rim and at the hole. Without a corner radius the
/// corners are sharp: at the rim `padAngle / 2` in from the slice's
/// angles, inside where [`Edges::inner`] puts the inner edge.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Outline {
    lo: f32,
    hi: f32,
    outer: Corner,
    inner: Corner,
}

impl Outline {
    /// The outline of `shape`, `pad` between it and its neighbours, its
    /// corners rounded by up to `corner` (`None`: narrower than its pad,
    /// nothing to draw). As d3 does, a corner is at most half the ring's
    /// thickness, and smaller where the slice has no angle for it: the two
    /// corners at the rim (or at the hole) touch on the slice's middle
    /// rather than overlap. A whole turn has no corners.
    fn new(shape: Shape, pad: f32, corner: f32) -> Option<Self> {
        let Shape { lo, hi, .. } = shape;
        let span = hi - lo;
        let r1 = shape.outer;
        if r1 < EPSILON || span < EPSILON {
            return None;
        }
        let edges = Edges::new(shape.inner, r1, pad);
        let (r0, h) = (edges.r0, edges.h);
        // The sine of half the slice: its edges meet `h / half` out.
        let half = (span / 2.0).sin();
        if span < PI && r1 * half <= h {
            return None;
        }
        let rc = match span >= TAU - EPSILON {
            true => 0.0,
            false => corner.min((r1 - r0) / 2.0).min((r1 - h) / 2.0).max(0.0),
        };
        // The largest corner whose circle fits between the edges and the
        // rim: its center on the slice's middle (`(r1 - rc) * half = h +
        // rc`, d3's `(r1 - lc) / (kc + 1)`).
        let rc1 = match span < PI {
            true => rc.min((r1 * half - h) / (1.0 + half)).max(0.0),
            false => rc,
        };
        let d1 = r1 - rc1;
        let outer = Corner {
            radius: rc1,
            distance: d1,
            angle: ((h + rc1) / d1).min(1.0).asin().min(span / 2.0),
        };
        let (radius, off) = edges.inner(span);
        // On the hole: round its corners too, the circle outside it
        // (`(r0 + rc) * half = h + rc`, d3's `(r0 - lc) / (kc - 1)`).
        let inner = match rc > 0.0 && r0 > h && radius == r0 {
            true => {
                let rc0 = match span < PI {
                    true => rc.min((r0 * half - h) / (1.0 - half)).max(0.0),
                    false => rc,
                };
                let d0 = r0 + rc0;
                Corner {
                    radius: rc0,
                    distance: d0,
                    angle: ((h + rc0) / d0).min(1.0).asin().min(span / 2.0),
                }
            }
            false => Corner {
                radius: 0.0,
                distance: radius,
                angle: off,
            },
        };
        Some(Outline {
            lo,
            hi,
            outer,
            inner,
        })
    }

    /// What a moving slice narrower than its pad draws: a point on the
    /// middle of its rim.
    fn point(shape: Shape) -> Self {
        let middle = Corner {
            radius: 0.0,
            distance: shape.outer,
            angle: (shape.hi - shape.lo).max(0.0) / 2.0,
        };
        Outline {
            lo: shape.lo,
            hi: shape.hi,
            outer: middle,
            inner: middle,
        }
    }

    fn is_rounded(&self) -> bool {
        self.outer.radius > 0.0 || self.inner.radius > 0.0
    }
}

/// A number of a drawing: a constant, or one the animator moves.
#[derive(Clone, Copy)]
enum Var {
    Const(f32),
    Node(AnimatedNode),
}

impl Var {
    fn add(&self, other: &Var) -> Var {
        match (self, other) {
            (Var::Const(a), Var::Const(b)) => Var::Const(a + b),
            (Var::Node(a), Var::Const(b)) | (Var::Const(b), Var::Node(a)) => Var::Node(a.add(*b)),
            (Var::Node(a), Var::Node(b)) => Var::Node(a.add(b)),
        }
    }

    fn sub(&self, other: &Var) -> Var {
        match (self, other) {
            (Var::Const(a), Var::Const(b)) => Var::Const(a - b),
            (Var::Node(a), Var::Const(b)) => Var::Node(a.sub(*b)),
            (Var::Const(a), Var::Node(b)) => Var::Node(b.mul(-1.0).add(*a)),
            (Var::Node(a), Var::Node(b)) => Var::Node(a.sub(b)),
        }
    }

    fn mul(&self, other: &Var) -> Var {
        match (self, other) {
            (Var::Const(a), Var::Const(b)) => Var::Const(a * b),
            (Var::Node(a), Var::Const(b)) | (Var::Const(b), Var::Node(a)) => Var::Node(a.mul(*b)),
            (Var::Node(a), Var::Node(b)) => Var::Node(a.mul(b)),
        }
    }
}

impl From<&Var> for CanvasArg {
    fn from(v: &Var) -> Self {
        match v {
            Var::Const(n) => (*n).into(),
            Var::Node(n) => n.into(),
        }
    }
}

/// What a radial mark draws over its motion (one at rest), `T` of each
/// sampled shape: each number of its drawing is a constant, or the
/// animator's piecewise-linear map of the motion's progress through the
/// numbers of the samples, so angles, radii and corners (and a label with
/// its slice) move together and no JS runs per frame.
struct Samples<T> {
    progress: Option<AnimatedNode>,
    ts: Vec<f32>,
    all: Vec<T>,
}

/// The outlines of a slice over its motion.
type Outlines = Samples<Outline>;

impl<T> Samples<T> {
    /// `f` of `to`, or of its moves under `motion`, sampled densely near
    /// the start where a sweep opens a slice from nothing.
    fn of(to: Shape, motion: Option<Motion>, f: impl Fn(Shape) -> T) -> Self {
        match motion {
            None => Samples {
                progress: None,
                ts: vec![1.0],
                all: vec![f(to)],
            },
            Some(Motion { progress, from }) => {
                let (ts, all) = (0..=MOTION_SAMPLES)
                    .map(|i| {
                        let t = (i as f32 / MOTION_SAMPLES as f32).powi(2);
                        (t, f(from.lerp(&to, t)))
                    })
                    .unzip();
                Samples {
                    progress: Some(progress),
                    ts,
                    all,
                }
            }
        }
    }

    /// `f` of the samples: a constant where it does not move.
    fn num(&self, f: impl Fn(&T) -> f32) -> Var {
        let out: Vec<f32> = self.all.iter().map(f).collect();
        match self.progress {
            Some(t) if out.iter().any(|v| *v != out[0]) => Var::Node(t.interpolate(&self.ts, &out)),
            _ => Var::Const(out[0]),
        }
    }
}

impl Outlines {
    /// The outline of `to`, or of its moves under `motion` (`None`:
    /// nothing to draw at rest).
    fn new(to: Shape, pad: f32, corner: f32, motion: Option<Motion>) -> Option<Self> {
        let outline = |shape| Outline::new(shape, pad, corner);
        Some(match motion {
            None => {
                let at = outline(to)?;
                Samples::of(to, None, |_| at)
            }
            Some(_) => Samples::of(to, motion, |shape| {
                outline(shape).unwrap_or_else(|| Outline::point(shape))
            }),
        })
    }

    /// An arc's start and its end `len` past it (`len` never below 0, so
    /// the canvas never takes a sliver for a whole turn the other way).
    fn angles(
        &self,
        start: impl Fn(&Outline) -> f32,
        len: impl Fn(&Outline) -> f32,
        ccw: bool,
    ) -> (Var, Var) {
        let start = self.num(|o| start(o) + SCREEN);
        let len = self.num(|o| len(o).max(0.0));
        let end = match ccw {
            true => start.sub(&len),
            false => start.add(&len),
        };
        (start, end)
    }

    /// The center of a corner `distance` out at `angle` (pie angles) from
    /// `center`, pushed out by `lift` along the way there.
    fn corner_center(
        &self,
        center: Point<Points>,
        angle: impl Fn(&Outline) -> f32 + Copy,
        distance: impl Fn(&Outline) -> f32 + Copy,
        lift: Option<AnimatedNode>,
    ) -> (Var, Var) {
        let x = self.num(|o| center.x.0 + distance(o) * (angle(o) + SCREEN).cos());
        let y = self.num(|o| center.y.0 + distance(o) * (angle(o) + SCREEN).sin());
        match lift {
            None => (x, y),
            Some(lift) => {
                let lift = Var::Node(lift);
                let cos = self.num(|o| (angle(o) + SCREEN).cos());
                let sin = self.num(|o| (angle(o) + SCREEN).sin());
                (x.add(&lift.mul(&cos)), y.add(&lift.mul(&sin)))
            }
        }
    }
}

/// The canvas's angle of a pie angle's 0: 3 o'clock is the canvas's 0.
const SCREEN: f32 = -FRAC_PI_2;

/// The samples of a moving slice's outline.
const MOTION_SAMPLES: usize = 64;

/// Records an annular sector of `to` (pie angles) around `center`, its
/// outer edge `lift` past the ring's (a lifted slice), `pad` between it
/// and its neighbours, its corners rounded by up to `corner`. The gaps
/// keep the width the pad makes at the rim at every radius: each edge runs
/// parallel to its radial, offset by half that width, so a gap is a band
/// of even width rather than a wedge closing at the center. Where a slice
/// is too narrow to reach the hole (or there is none) its edges meet in a
/// point short of the center; a slice narrower than its pad draws nothing.
/// A whole turn takes no pad and no corners, as d3's. While `motion` runs
/// the shape moves from its `from`. `None`: nothing to draw.
#[allow(clippy::too_many_arguments)]
fn sector(
    p: Painter,
    center: Point<Points>,
    to: Shape,
    lift: Option<AnimatedNode>,
    pad: f32,
    corner: f32,
    motion: Option<Motion>,
) -> Option<Painter> {
    let pad = match to.hi - to.lo >= TAU - EPSILON {
        true => 0.0,
        false => pad.clamp(0.0, PI),
    };
    let o = Outlines::new(to, pad, corner, motion)?;
    let (cx, cy) = (center.x.0, center.y.0);
    let lifted = |v: Var| match lift {
        Some(lift) => v.add(&Var::Node(lift)),
        None => v,
    };
    let span = |o: &Outline| o.hi - o.lo;
    let p = p.begin_path();
    if !o.all.iter().any(Outline::is_rounded) {
        let rim = lifted(o.num(|o| o.outer.distance));
        let (a0, a1) = o.angles(
            |o| o.lo + o.outer.angle,
            |o| span(o) - 2.0 * o.outer.angle,
            false,
        );
        let p = p.arc(cx, cy, &rim, &a0, &a1);
        let (a0, a1) = o.angles(
            |o| o.hi - o.inner.angle,
            |o| span(o) - 2.0 * o.inner.angle,
            true,
        );
        let radius = o.num(|o| o.inner.distance);
        return Some(
            p.arc_counterclockwise(cx, cy, &radius, &a0, &a1)
                .close_path(),
        );
    }
    // Clockwise around the slice: the corner at its start's rim, the rim,
    // the corner at its end's; the corner at its end's hole, the hole's
    // edge back, the corner at its start's. Each corner turns from its
    // edge (a quarter turn off the edge's radial) to the circle it meets.
    let outer_radius = o.num(|o| o.outer.radius);
    let inner_radius = o.num(|o| o.inner.radius);
    let (x, y) = o.corner_center(center, |o| o.lo + o.outer.angle, |o| o.outer.distance, lift);
    let (a0, a1) = o.angles(|o| o.lo - FRAC_PI_2, |o| FRAC_PI_2 + o.outer.angle, false);
    let p = p.arc(&x, &y, &outer_radius, &a0, &a1);
    let rim = lifted(o.num(|o| o.outer.distance + o.outer.radius));
    let (a0, a1) = o.angles(
        |o| o.lo + o.outer.angle,
        |o| span(o) - 2.0 * o.outer.angle,
        false,
    );
    let p = p.arc(cx, cy, &rim, &a0, &a1);
    let (x, y) = o.corner_center(center, |o| o.hi - o.outer.angle, |o| o.outer.distance, lift);
    let (a0, a1) = o.angles(
        |o| o.hi - o.outer.angle,
        |o| FRAC_PI_2 + o.outer.angle,
        false,
    );
    let p = p.arc(&x, &y, &outer_radius, &a0, &a1);
    let (x, y) = o.corner_center(center, |o| o.hi - o.inner.angle, |o| o.inner.distance, None);
    let (a0, a1) = o.angles(|o| o.hi + FRAC_PI_2, |o| FRAC_PI_2 - o.inner.angle, false);
    let p = p.arc(&x, &y, &inner_radius, &a0, &a1);
    let hole = o.num(|o| o.inner.distance - o.inner.radius);
    let (a0, a1) = o.angles(
        |o| o.hi - o.inner.angle,
        |o| span(o) - 2.0 * o.inner.angle,
        true,
    );
    let p = p.arc_counterclockwise(cx, cy, &hole, &a0, &a1);
    let (x, y) = o.corner_center(center, |o| o.lo + o.inner.angle, |o| o.inner.distance, None);
    let (a0, a1) = o.angles(
        |o| o.lo + o.inner.angle + PI,
        |o| FRAC_PI_2 - o.inner.angle,
        false,
    );
    let p = p.arc(&x, &y, &inner_radius, &a0, &a1);
    Some(p.close_path())
}

/// A radial mark's move to a new pose (`motion.update`, d3's
/// `arcTween`): the pose it draws, the one it moves from while a move
/// runs, and how far that has gone, on the platform's animator. The
/// angles and the radii move, not the outline, so a ring sweeps round to
/// its new end and a donut's hole opens. A change while a move runs moves
/// on from where the mark is drawn then, as the plot's axes glide on from
/// the domain they show (`tween.rs`): the move stops, the animator tells
/// how far it had gone, and the next one starts from the pose drawn there
/// (the mark holds still until the animator answers). The plot's size
/// changing moves nothing: only the app's pose.
struct Update<P> {
    /// The pose it moves to, and the one it moves from while a move runs.
    shown: Signal<(P, Option<P>)>,
    progress: AnimatedValue,
}

impl<P> Clone for Update<P> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<P> Copy for Update<P> {}

impl<P: Pose> Update<P> {
    /// Follows `pose`, moving to each new one with the plot's
    /// `motion.update` (at once without one or with reduced motion).
    fn new(plot: PlotContext, pose: impl Fn() -> P + 'static) -> Self {
        let shown = signal((untracked(&pose), None::<P>));
        let progress = animated_value(1.0);
        // The app's last pose (none before the first run, which only
        // shows its pose: what a mark's other effects settle before it is
        // no move), and how many changes came: a stopped move's successor
        // starts only if no change came while the animator was asked how
        // far it had gone.
        let last = stored(None::<P>);
        let changes = stored(0_u32);
        effect(move || {
            let to = pose();
            let Some(before) = last.replace(Some(to.clone())) else {
                if shown.with_untracked(|(at, from)| *at != to || from.is_some()) {
                    shown.set((to, None));
                }
                return;
            };
            if before == to {
                return;
            }
            let change = changes.with(|c| {
                *c = c.wrapping_add(1);
                *c
            });
            let timing = untracked(|| plot.motion.get().and_then(|m| m.update))
                .filter(|t| t.duration_ms > 0.0 && !reduce_motion());
            let Some(timing) = timing else {
                return shown.set((to, None));
            };
            let (at, moving) = shown.with_untracked(|(at, from)| (at.clone(), from.is_some()));
            if !moving {
                return Self::run(shown, progress, at, to, timing);
            }
            progress.stop();
            let read = progress.value();
            spawn(async move {
                let t = read.await;
                if changes.get() != change {
                    // A newer change asks again.
                    return;
                }
                let at = shown.with_untracked(|(at, from)| match from {
                    Some(from) => from.lerp(at, t),
                    None => at.clone(),
                });
                Self::run(shown, progress, at, to, timing);
            });
        });
        Update { shown, progress }
    }

    /// Moves from `from` to `to` over `timing`.
    fn run(shown: Signal<(P, Option<P>)>, progress: AnimatedValue, from: P, to: P, timing: Timing) {
        shown.set((to, Some(from)));
        progress.set(0.0);
        let end = progress.timing_with(1.0, timing);
        spawn(async move {
            // Stopped by a newer change: that one ends it.
            if end.await {
                shown.update(|(_, from)| *from = None);
            }
        });
    }

    /// The pose it moves to and, while a move runs, the pose it moves
    /// from and how far it has gone.
    fn shown(&self) -> (P, Option<(P, AnimatedNode)>) {
        let progress = *self.progress.node();
        self.shown
            .with(|(to, from)| (to.clone(), from.clone().map(|from| (from, progress))))
    }
}

/// Where slice `row` moves from among the slices before a change, `from`:
/// its own angles, or, for a slice new to the pie, none at all where the
/// slice before it ended (the pie's `start` for the first), so it opens
/// as its neighbours make room.
fn slice_from(from: &[Slice], row: u32, start: f32) -> (f32, f32) {
    match from.iter().find(|s| s.index == row) {
        Some(s) => (s.start, s.end),
        None => {
            let at = from
                .iter()
                .rev()
                .find(|s| s.index < row)
                .map_or(start, |s| s.end);
            (at, at)
        }
    }
}

/// The edges of the slices of a ring whose gaps are `pad` wide at the
/// rim and as wide at every radius (`h` is half that width).
#[derive(Debug, Clone, Copy)]
struct Edges {
    r0: f32,
    r1: f32,
    h: f32,
}

impl Edges {
    fn new(r0: f32, r1: f32, pad: f32) -> Self {
        Self {
            r0: r0.max(0.0),
            r1,
            h: r1 * (pad / 2.0).sin(),
        }
    }

    /// The inner edge of a slice spanning `span`: the radius it lies on
    /// and how far its ends are turned in from the slice's angles. On the
    /// hole where the slice reaches it; a slice narrower than a half turn
    /// that does not ends where its edges meet (an arc of no length there),
    /// a wider one rounds the center at half the gap's width.
    fn inner(&self, span: f32) -> (f32, f32) {
        let Self { r0, r1, h } = *self;
        if h <= 0.0 {
            return (r0, 0.0);
        }
        if span < PI {
            // Where the two edges meet, on the slice's middle.
            let meet = match (span / 2.0).sin() {
                s if s > EPSILON => h / s,
                _ => f32::INFINITY,
            };
            if meet >= r1 {
                // Narrower than its pad: closes on its rim's middle.
                return (r1, span / 2.0);
            }
            if meet > r0 {
                return (meet, span / 2.0);
            }
        }
        let r = r0.max(h);
        (r, (h / r).min(1.0).asin())
    }
}

/// Fills `sector` with the view's `fill` (`currentColor` where none is
/// set) and strokes it with its `stroke` (none where none is set): a
/// slice's edge in the surface's color draws the gaps between slices.
fn paint(p: Painter, sector: impl FnOnce(Painter) -> Option<Painter>) -> Painter {
    let p = p.fill_style_from_view(SvgPaint::CurrentColor);
    let p = p
        .stroke_style_from_view(SvgPaint::None)
        .line_width_from_view()
        .line_dash_from_view();
    match sector(p.clone()) {
        Some(p) => p.fill().stroke(),
        None => p,
    }
}

/// The inline style of a [`Pie`]'s labels: a [`Style`] whose TypeScript
/// type takes text styles too (`StyleProp<TextStyle>`), since a label is a
/// text.
#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct PieLabelStyle(pub Style);

impl From<Style> for PieLabelStyle {
    fn from(style: Style) -> Self {
        Self(style)
    }
}

impl JsValue for PieLabelStyle {
    fn ts_type(_types: &mut TsTypes) -> String {
        "StyleProp<TextStyle>".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        <Style as JsValue>::from_js(value).map(Self)
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        self.0.to_js(host)
    }
}

/// The props of [`Pie`].
#[derive(Debug, Clone, PartialEq, Props)]
#[props(generic)]
pub struct PieProps {
    /// What each row is worth (`gpui-base`'s `Pie::value`,
    /// `shape/pie.rs:32`): a field name, or a function of the row and its
    /// index; the plot's `y` without. A row worth nothing, less, or no
    /// number has no slice.
    pub value: Prop<Option<RowAccessor>>,
    /// Where the first slice starts (`Pie::start_angle`,
    /// `shape/pie.rs:41`): radians from 12 o'clock, clockwise; 0 by
    /// default.
    #[prop(default)]
    pub start_angle: Prop<Radians>,
    /// Where the last slice ends (`Pie::end_angle`, `shape/pie.rs:47`):
    /// radians from 12 o'clock, clockwise; a whole turn (`2 * Math.PI`) by
    /// default. Less than `startAngle` lays the slices out the other way.
    #[prop(default = Radians(TAU))]
    pub end_angle: Prop<Radians>,
    /// The angle between neighbouring slices at the rim (`Pie::pad_angle`,
    /// `shape/pie.rs:53`), in radians, 0 by default: each gap keeps the
    /// width it has there at every radius, its edges parallel, so it is
    /// as wide at the center (or the hole) as at the rim.
    #[prop(default)]
    pub pad_angle: Prop<Radians>,
    /// The radius of the hole (`Arc::inner_radius`, `shape/arc.rs:69`): a
    /// donut. Points, or a percentage of the largest circle the plot holds
    /// (`"60%"`); 0 by default, a whole pie.
    #[prop(default)]
    pub inner_radius: Prop<DefiniteLength>,
    /// The radius of the slices (`Arc::outer_radius`, `shape/arc.rs:75`):
    /// points, or a percentage of the largest circle the plot holds;
    /// `"100%"` by default, half the plot's smaller side.
    #[prop(default = DefiniteLength::Fraction(Percentage(1.0)))]
    pub outer_radius: Prop<DefiniteLength>,
    /// The radius of each slice's corners, in points (d3's
    /// `arc.cornerRadius`): 0 by default, sharp. As d3's, at most half the
    /// ring's thickness and smaller on a slice too narrow for two whole
    /// corners; the corners follow the pad's parallel edges.
    #[prop(default)]
    pub corner_radius: Prop<Points>,
    /// The Tailwind classes of each slice, the `slice` part: the same on
    /// every slice (`"stroke-card stroke-2"`), or a function of the
    /// slice's row and its index that gives each its own
    /// (`gpui-component`'s `PieChart::color`): its `fill-*`, `stroke-*`.
    pub slice_class: Prop<Option<SliceClass>>,
    /// The style of every slice, over its classes (`fill`, `stroke`,
    /// `strokeWidth`).
    #[prop(default)]
    pub slice_style: Prop<Style>,
    /// How far the slice under the pointer grows past the others, in
    /// points (`gpui-component`'s pie lifts it, `HOVER_LIFT`,
    /// `chart/pie_chart.rs:27`): it lifts on the plot's pointer spring and
    /// fades in and out with the hover; 0 by default.
    #[prop(default)]
    pub hover_lift: Prop<Points>,
    /// How much the other slices fade while one is under the pointer, as a
    /// share of their opacity (`gpui-component`'s `HOVER_DIM`,
    /// `chart/pie_chart.rs:30`), with the hover's fade; 0 by default.
    #[prop(default)]
    pub hover_dim: Prop<Percentage>,
    /// The text beside each slice, the `label` part (`gpui-component`'s
    /// `PieChart::label`): a field name (its number) or a function of the
    /// row and its index returning the text, outside the ring toward the
    /// slice's middle (`gpui-base`'s `Arc::centroid` at the label's
    /// radius), `labelGap` past the rim, then across to that radius on
    /// the slice's side of the pie: the text starts there on the right
    /// half and ends there on the left. A row whose text is empty, or a
    /// slice narrower than half a degree, has no label.
    pub label: Prop<Option<RowText>>,
    /// The Tailwind classes of its labels: a text centered vertically on
    /// the end of its leader line, its size, color and padding (its
    /// distance from the line's end) the app's.
    pub label_class: Prop<Option<SharedString>>,
    /// The style of its labels, over `labelClass` (text styles too).
    #[prop(default)]
    pub label_style: Prop<PieLabelStyle>,
    /// How far past the rim its labels sit, in points (`gpui-component`'s
    /// `PieChart::label_gap`): 15 by default, as there.
    #[prop(default = Points(15.0))]
    pub label_gap: Prop<Points>,
    /// The Tailwind classes of each label's leader line, the `labelLine`
    /// part (`gpui-component`'s `PieChart::label_line_color`): from the
    /// slice's rim out to the label's radius, then across to the text.
    /// The same on every line, or a function of the slice's row and its
    /// index that gives each its own: its `stroke-*` (`currentColor` where
    /// none is set) and stroke width. Drawn only with a class or a style.
    pub label_line_class: Prop<Option<SliceClass>>,
    /// The style of the leader lines, over `labelLineClass` (`stroke`,
    /// `strokeWidth`, `strokeDasharray`).
    #[prop(default)]
    pub label_line_style: Prop<Style>,
}

/// A pie of a [`Plot`](super::Plot)'s rows (`gpui-base`'s `Pie`, its
/// slices drawn with `Arc`, as `gpui-component`'s `PieChart` draws them):
/// a slice per row worth more than nothing, each its share of the turn
/// from `startAngle` to `endAngle`, in the rows' order, around the plot's
/// center between `innerRadius` (a donut's hole) and `outerRadius`, `padAngle`
/// apart. Each slice is a canvas of its own, the `slice` part, so each
/// paints with its own classes (`sliceClass`, a function of its row) over
/// the pie's, as CSS inherits `fill` and `stroke`: `fill` (`currentColor`
/// where none is set) and `stroke` (none). Over a pie, the plot reports
/// the row of the slice under the pointer, none in the hole or outside,
/// and its tooltip follows the pointer; that slice grows by `hoverLift`
/// and the others fade by `hoverDim`, on the platform's animator with the
/// plot's motion. The ring sweeps in from its first slice with the plot's
/// appear, and when the values or the radii change each slice moves from
/// its old angles to its new ones with the plot's `motion.update` (d3's
/// `arcTween`); `cornerRadius` rounds each slice's corners. With a
/// `label`, each slice has a text outside the ring and, styled, a leader
/// line to it (`gpui-component`'s pie labels); they follow their slices'
/// motion and lift. Its values take no part in the plot's scales.
#[component]
pub fn Pie(props: PieProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let plot = PlotContext::of("Pie");
    let (start, end, pad) = (props.start_angle, props.end_angle, props.pad_angle);
    let (inner, outer, corner) = (props.inner_radius, props.outer_radius, props.corner_radius);
    let (lift, dim) = (props.hover_lift, props.hover_dim);
    let Some(plot) = plot else {
        return super::layer();
    };
    let ys = values(
        move || plot.rows.get(),
        move || props.value.get().or_else(|| plot.y.get()),
    );
    let slices = computed(move || -> Shared<[Slice]> {
        match ys.get() {
            Some(ys) => arcs(&ys, start.get().0, end.get().0).into(),
            None => Shared::from([]),
        }
    });
    let radii = move || (Radius::of(inner.get()), Radius::of(outer.get()));
    let ring = computed(move || {
        let (inner, outer) = radii();
        Ring::of(plot.size.get(), inner, outer)
    });
    let update = Update::new(plot, move || {
        let (inner, outer) = radii();
        PiePose {
            inner,
            outer,
            start: start.get().0,
            slices: slices.get(),
        }
    });
    plot.add_hit(
        move |at| {
            let from = start.get_untracked().0.min(end.get_untracked().0);
            slices.with_untracked(|all| ring.get_untracked().slice_at(all, from, at))
        },
        move |row| {
            slices.with_untracked(|all| {
                let slice = all.iter().find(|s| s.index == row)?;
                Some(ring.get_untracked().middle(slice))
            })
        },
    );
    let classes = slice_classes(move || plot.rows.get(), move || props.slice_class.get());
    let slice_style = props.slice_style;
    // Whether the hover moves the slices: their lift drawn, their
    // opacity bound to how much the others fade (part of their keys, so
    // a change makes them again).
    let lifts = move || lift.get().0 > 0.0;
    let dims = move || dim.get().0.clamp(0.0, 1.0).to_bits();
    let bleed = move || {
        let reach = ring.get().reach(plot.size.get(), lift.get().0.max(0.0));
        STROKE_ROOM + reach.ceil()
    };
    let slices_view = each(
        move || {
            let (lifts, dims) = (lifts(), dims());
            slices.with(|all| {
                all.iter()
                    .map(|s| (s.index, lifts, dims))
                    .collect::<Vec<_>>()
            })
        },
        |key| *key,
        move |key, _| {
            let (row, lifts, dims) = key.get_untracked();
            let dim = f32::from_bits(dims);
            let lifted = match lifts || dim > 0.0 {
                true => hover_lift(plot, row),
                false => animated_value(0.0),
            };
            let view = mark_canvas(Some(plot), bleed, move |p, _| {
                let (pose, from) = update.shown();
                let Some(slice) = pose.slice(row) else {
                    return p;
                };
                let ring = ring.get();
                let size = plot.size.get();
                let lift = lifts.then(|| lifted.mul(&plot.fade).mul(lift.get().0));
                let to = slice.shape(size);
                let from = from.map(|(from, t)| (from.slice_from(row, pose.start).shape(size), t));
                let motion = Motion::of(plot, to, pose.start, from);
                paint(p, |p| {
                    sector(
                        p,
                        ring.center,
                        to,
                        lift,
                        pad.get().0,
                        corner.get().0,
                        motion,
                    )
                })
            })
            .app_class(move || {
                classes.with(|c| c.as_ref().and_then(|c| c.get(row as usize).cloned()))
            })
            .inline_style(slice_style);
            match dim > 0.0 {
                // `1 - dim * fade * (1 - lifted)` (`slice_emphasis`,
                // `chart/pie_chart.rs:300`).
                true => {
                    view.bind_opacity(&lifted.mul(-1.0).add(1.0).mul(&plot.fade).mul(-dim).add(1.0))
                }
                false => view,
            }
        },
    );
    let (label, label_class, label_style) = (props.label, props.label_class, props.label_style);
    let (gap, line_class, line_style) = (
        props.label_gap,
        props.label_line_class,
        props.label_line_style,
    );
    // The label part: a label per slice whose text is not empty.
    let labels = when(
        move || label.with(Option::is_some),
        move || {
            let texts = super::bar::texts(move || plot.rows.get(), move || label.get());
            let line_classes = slice_classes(move || plot.rows.get(), move || line_class.get());
            let text_of = move |row: u32| {
                texts.with(|t| {
                    t.as_ref()
                        .and_then(|t| t.get(row as usize).cloned())
                        .unwrap_or_default()
                })
            };
            each(
                move || {
                    let lifts = lifts();
                    slices.with(|all| {
                        all.iter()
                            .filter(|s| !text_of(s.index).is_empty())
                            .map(|s| (s.index, lifts))
                            .collect::<Vec<_>>()
                    })
                },
                |key| *key,
                move |key, _| {
                    let (row, lifts) = key.get_untracked();
                    slice_label(SliceLabel {
                        plot,
                        update,
                        ring,
                        row,
                        gap,
                        lift: lifts.then(|| (hover_lift(plot, row), lift)),
                        text: move || text_of(row),
                        class: label_class,
                        style: label_style,
                        line_class,
                        line_classes,
                        line_style,
                    })
                },
            )
        },
    );
    super::layer().child(slices_view).child(labels)
}

/// How far row `row`'s slice has lifted, 0 to 1 (`gpui-component`'s
/// `PieHover::lift`): on the pointer spring while the plot moves, at once
/// without one or with reduced motion; it shows as far as the hover has
/// faded in.
fn hover_lift(plot: PlotContext, row: u32) -> AnimatedValue {
    let lifted = animated_value(0.0);
    let target = stored(0.0_f32);
    effect(move || {
        let to = match plot.hovered.get() == Some(row) {
            true => 1.0,
            false => 0.0,
        };
        if target.get() == to {
            return;
        }
        target.replace(to);
        let spring = untracked(|| plot.motion.get().and_then(|m| m.pointer));
        match spring.filter(|_| !reduce_motion()) {
            Some(spring) => drop(lifted.spring(to, spring)),
            None => lifted.set(to),
        }
    });
    lifted
}

/// How far into the appear a pie's labels start fading in
/// (`gpui-component`'s `LABEL_APPEAR_START`, `chart/pie_chart.rs:33`):
/// once their slices are mostly drawn.
const LABEL_APPEAR_START: f32 = 0.7;

/// A slice narrower than this has no label (`gpui-component`'s half a
/// degree, `chart/pie_chart.rs:384`): too thin to point at.
const LABEL_MIN_SPAN: f32 = PI / 360.0;

/// Where a slice's label goes (`gpui-component`'s pie labels,
/// `chart/pie_chart.rs:388-449`): its leader line runs from the rim at
/// the slice's middle out to the label's radius, `gap` past the rim
/// (there it passes the slice's centroid at that radius, `gpui-base`'s
/// `Arc::centroid`), then across to that radius on the label's side,
/// where the text is anchored.
#[derive(Debug, Clone, Copy, PartialEq)]
struct LabelPlace {
    /// The direction of the slice's middle from the center: a lift moves
    /// the label along it.
    dir: (f32, f32),
    rim: (f32, f32),
    elbow: (f32, f32),
    end: (f32, f32),
    /// The right half (1) or the left (-1).
    side: f32,
}

impl LabelPlace {
    /// The label of a slice of `shape` around `center`, `gap` past its
    /// rim, on `side`.
    fn new(center: Point<Points>, shape: Shape, gap: f32, side: f32) -> Self {
        let middle = (shape.lo + shape.hi) / 2.0;
        let dir = (middle.sin(), -middle.cos());
        let (cx, cy) = (center.x.0, center.y.0);
        let at = |r: f32| (cx + r * dir.0, cy + r * dir.1);
        let r = shape.outer + gap;
        let elbow = at(r);
        LabelPlace {
            dir,
            rim: at(shape.outer),
            elbow,
            end: (cx + side * r, elbow.1),
            side,
        }
    }

    /// The side a slice of `shape` is labeled on: the right where its
    /// middle is right of the center, else the left (`gpui-component`'s
    /// `centroid.x > 0`).
    fn side(shape: Shape) -> f32 {
        match ((shape.lo + shape.hi) / 2.0).sin() > 0.0 {
            true => 1.0,
            false => -1.0,
        }
    }
}

impl Samples<LabelPlace> {
    /// `at` of the label places, moved out by `lift` along the slice's
    /// middle.
    fn point(
        &self,
        at: impl Fn(&LabelPlace) -> (f32, f32),
        lift: Option<AnimatedNode>,
    ) -> (Var, Var) {
        let (x, y) = (self.num(|l| at(l).0), self.num(|l| at(l).1));
        match lift {
            None => (x, y),
            Some(lift) => {
                let lift = Var::Node(lift);
                let (dx, dy) = (self.num(|l| l.dir.0), self.num(|l| l.dir.1));
                (x.add(&lift.mul(&dx)), y.add(&lift.mul(&dy)))
            }
        }
    }
}

/// What a slice's label needs.
struct SliceLabel<F> {
    plot: PlotContext,
    update: Update<PiePose>,
    ring: Memo<Ring>,
    row: u32,
    gap: Prop<Points>,
    /// How far its slice has lifted (0 to 1), and the pie's `hoverLift`.
    lift: Option<(AnimatedValue, Prop<Points>)>,
    text: F,
    class: Prop<Option<SharedString>>,
    style: Prop<PieLabelStyle>,
    line_class: Prop<Option<SliceClass>>,
    /// The leader lines' classes, by row.
    line_classes: Signal<Option<Shared<[SharedString]>>>,
    line_style: Prop<Style>,
}

/// The label of row `row`'s slice, in a layer of its own: its leader line
/// (the `labelLine` part, drawn only when styled), and a point with no
/// size where the line ends, the text beside it on the label's side,
/// centered on it. It follows its slice's appear and `motion.update` and
/// its lift, fades in over the end of the appear and takes no pointer.
fn slice_label(label: SliceLabel<impl Fn() -> SharedString + Copy + 'static>) -> View {
    let SliceLabel {
        plot,
        update,
        ring,
        row,
        gap,
        lift,
        text: content,
        class,
        style,
        line_class,
        line_classes,
        line_style,
    } = label;
    // Where it rests, and where it goes over its slice's motion (`None`:
    // the slice has no label).
    let places = move || -> Option<(LabelPlace, Samples<LabelPlace>)> {
        let (pose, from) = update.shown();
        let slice = pose.slice(row)?;
        if slice.hi - slice.lo < LABEL_MIN_SPAN {
            return None;
        }
        let size = plot.size.get();
        let to = slice.shape(size);
        let from = from.map(|(from, t)| (from.slice_from(row, pose.start).shape(size), t));
        let motion = Motion::of(plot, to, pose.start, from);
        let (center, gap, side) = (ring.get().center, gap.get().0, LabelPlace::side(to));
        let place = |shape| LabelPlace::new(center, shape, gap, side);
        Some((place(to), Samples::of(to, motion, place)))
    };
    let lifted = move || lift.map(|(lifted, by)| lifted.mul(&plot.fade).mul(by.get().0));
    let has_line =
        move || line_class.with(Option::is_some) || line_style.with(|s| *s != Style::default());
    let bleed = move || {
        let by = lift.map_or(0.0, |(_, by)| by.get().0.max(0.0));
        let reach = ring.get().reach(plot.size.get(), by + gap.get().0.max(0.0));
        STROKE_ROOM + reach.ceil()
    };
    let line = when(has_line, move || {
        mark_canvas(Some(plot), bleed, move |p, _| {
            let Some((_, places)) = places() else {
                return p;
            };
            let lift = lifted();
            let (x0, y0) = places.point(|l| l.rim, lift);
            let (x1, y1) = places.point(|l| l.elbow, lift);
            let (x2, y2) = places.point(|l| l.end, lift);
            p.stroke_style_from_view(SvgPaint::CurrentColor)
                .line_width_from_view()
                .line_dash_from_view()
                .begin_path()
                .move_to(&x0, &y0)
                .line_to(&x1, &y1)
                .line_to(&x2, &y2)
                .stroke()
        })
        .app_class(move || {
            line_classes.with(|c| c.as_ref().and_then(|c| c.get(row as usize).cloned()))
        })
        .inline_style(line_style)
    });
    // Made again for each move: laid out where it rests and moved from
    // there by the animator.
    let anchor = dynamic(move || {
        let (rest, places) = places()?;
        let (x, y) = places.point(|l| l.end, lifted());
        let anchor = view()
            .absolute()
            .left(px(rest.end.0))
            .top(px(rest.end.1))
            .w(px(0.0))
            .h(px(0.0))
            .flex_row()
            .items_center()
            .pointer_events(PointerEvents::None);
        let anchor = match rest.side > 0.0 {
            true => anchor.justify_start(),
            false => anchor.justify_end(),
        };
        let anchor = match x {
            Var::Node(x) => anchor.bind_translate_x(&x.sub(rest.end.0)),
            Var::Const(_) => anchor,
        };
        let anchor = match y {
            Var::Node(y) => anchor.bind_translate_y(&y.sub(rest.end.1)),
            Var::Const(_) => anchor,
        };
        Some(
            anchor.child(
                text(content)
                    .flex_none()
                    .app_class(class)
                    .inline_style(move || style.get().0),
            ),
        )
    });
    let fade_in =
        untracked(|| plot.appear.progress()).interpolate(&[LABEL_APPEAR_START, 1.0], &[0.0, 1.0]);
    super::layer()
        .pointer_events(PointerEvents::None)
        .bind_opacity(&fade_in)
        .child(line)
        .child(anchor)
}

/// The props of [`Arc`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct ArcProps {
    /// Where it starts (`gpui-base`'s `ArcData::start_angle`,
    /// `shape/arc.rs:19`): radians from 12 o'clock, clockwise; 0 by
    /// default.
    #[prop(default)]
    pub start_angle: Prop<Radians>,
    /// Where it ends (`ArcData::end_angle`, `shape/arc.rs:20`): radians
    /// from 12 o'clock, clockwise; a whole turn (`2 * Math.PI`) by
    /// default, a ring.
    #[prop(default = Radians(TAU))]
    pub end_angle: Prop<Radians>,
    /// The radius of its inner edge (`Arc::inner_radius`,
    /// `shape/arc.rs:69`): points, or a percentage of the largest circle
    /// the plot holds; 0 by default, down to the center.
    #[prop(default)]
    pub inner_radius: Prop<DefiniteLength>,
    /// The radius of its outer edge (`Arc::outer_radius`,
    /// `shape/arc.rs:75`): points, or a percentage of the largest circle
    /// the plot holds; `"100%"` by default.
    #[prop(default = DefiniteLength::Fraction(Percentage(1.0)))]
    pub outer_radius: Prop<DefiniteLength>,
    /// The radius of its corners, in points (d3's `arc.cornerRadius`): 0
    /// by default, sharp. As d3's, at most half the ring's thickness and
    /// smaller where the arc is too short for two whole corners; half the
    /// thickness gives round caps. A whole ring has none.
    #[prop(default)]
    pub corner_radius: Prop<Points>,
}

/// An arc of a [`Plot`](super::Plot) (`gpui-base`'s `Arc`, painting one
/// `ArcData`): the sector from `startAngle` to `endAngle` around the
/// plot's center, between `innerRadius` and `outerRadius`; a gauge's
/// track and its value, or a ring behind a pie. It fills with its `fill`
/// (`fill-*`; `currentColor` where none is set) and strokes with its
/// `stroke` (none where none is set), as CSS inherits them from the plot,
/// and sweeps in from `startAngle` with the plot's appear; when its angles
/// or radii change it moves to the new ones with the plot's
/// `motion.update` (d3's `arcTween`), so a gauge sweeps round to its new
/// value. `cornerRadius` rounds its corners. It is a shape, not a row: the
/// pointer over it finds nothing.
#[component]
pub fn Arc(props: ArcProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let plot = PlotContext::of("Arc");
    let (start, end, corner) = (props.start_angle, props.end_angle, props.corner_radius);
    let (inner, outer) = (props.inner_radius, props.outer_radius);
    let radii = move || (Radius::of(inner.get()), Radius::of(outer.get()));
    let ring = move |plot: PlotContext| {
        let (inner, outer) = radii();
        Ring::of(plot.size.get(), inner, outer)
    };
    let update = plot.map(|plot| {
        Update::new(plot, move || {
            let (inner, outer) = radii();
            ArcPose::new(inner, outer, start.get().0, end.get().0)
        })
    });
    mark_canvas(
        plot,
        move || match plot {
            Some(plot) => STROKE_ROOM + ring(plot).reach(plot.size.get(), 0.0).ceil(),
            None => STROKE_ROOM,
        },
        move |p, _| {
            let (Some(plot), Some(update)) = (plot, update) else {
                return p;
            };
            let size = plot.size.get();
            let (pose, from) = update.shown();
            let to = pose.shape(size);
            let from = from.map(|(from, t)| (from.shape(size), t));
            let motion = Motion::of(plot, to, start.get().0, from);
            let center = ring(plot).center;
            paint(p, |p| {
                sector(p, center, to, None, 0.0, corner.get().0, motion)
            })
        },
    )
}

#[cfg(test)]
mod tests {
    use std::f32::consts::{FRAC_PI_2, PI, TAU};

    use nsh_core::geometry::{AbsoluteLength, DefiniteLength, Percentage, point, px, size};

    use super::{ArcPose, Edges, Outline, PiePose, Pose, Radius, Ring, Shape, Slice, arcs};

    fn radius(length: DefiniteLength) -> Radius {
        Radius::of(length)
    }

    fn slice(index: u32, start: f32, end: f32) -> Slice {
        Slice { index, start, end }
    }

    /// Gaps keep their width at the rim at every radius: a slice's edges
    /// run parallel to its radials, half the gap in, so a narrow slice of a
    /// whole pie ends where they meet, a wide one rounds the center and
    /// one of a donut ends on the hole, turned in by the same width.
    #[test]
    fn gaps_are_as_wide_at_the_center_as_at_the_rim() {
        let pad = 0.1;
        let pie = Edges::new(0.0, 100.0, pad);
        let h = 100.0 * (pad / 2.0).sin();
        let (meet, off) = pie.inner(PI / 3.0);
        assert!((meet - h / (PI / 6.0).sin()).abs() < 1e-3);
        assert!((off - PI / 6.0).abs() < 1e-6);
        let (r, off) = pie.inner(1.5 * PI);
        assert!(r == h && (off - FRAC_PI_2).abs() < 1e-6);
        // Narrower than its pad: nothing inside the rim.
        assert_eq!(pie.inner(0.05), (100.0, 0.025));
        let donut = Edges::new(60.0, 100.0, pad);
        let (r, off) = donut.inner(PI / 3.0);
        assert_eq!(r, 60.0);
        assert!((60.0 * off.sin() - h).abs() < 1e-3);
        assert_eq!(Edges::new(60.0, 100.0, 0.0).inner(1.0), (60.0, 0.0));
    }

    /// d3's `arc.cornerRadius`: each corner's circle touches the slice's
    /// edge (`h` from its radial with a pad) and the rim or the hole; the
    /// radius is at most half the ring's thickness, and on a narrow slice
    /// the two corners meet on its middle. A whole ring has none.
    #[test]
    fn corners_touch_the_edges_and_are_clamped_as_d3_clamps_them() {
        let shape = |inner: f32, outer: f32, span: f32| Shape {
            inner,
            outer,
            lo: 0.0,
            hi: span,
        };
        // Room for the whole radius: its circle `rc` from the edge and the
        // rim, and from the hole.
        let pad: f32 = 0.1;
        let h = 100.0 * (pad / 2.0).sin();
        let o = Outline::new(shape(60.0, 100.0, PI), pad, 6.0).unwrap();
        assert_eq!(o.outer.radius, 6.0);
        assert_eq!(o.outer.distance, 94.0);
        assert!((94.0 * o.outer.angle.sin() - (h + 6.0)).abs() < 1e-3);
        assert_eq!(o.inner.radius, 6.0);
        assert_eq!(o.inner.distance, 66.0);
        assert!((66.0 * o.inner.angle.sin() - (h + 6.0)).abs() < 1e-3);
        // At most half the ring's thickness: round caps.
        let o = Outline::new(shape(80.0, 100.0, PI), 0.0, 40.0).unwrap();
        assert_eq!((o.outer.radius, o.inner.radius), (10.0, 10.0));
        assert_eq!((o.outer.distance, o.inner.distance), (90.0, 90.0));
        // A narrow slice: the corners meet on its middle, rim and hole.
        let o = Outline::new(shape(60.0, 100.0, 0.2), 0.0, 20.0).unwrap();
        let half = 0.1f32.sin();
        assert!((o.outer.radius - 100.0 * half / (1.0 + half)).abs() < 1e-3);
        assert!((o.outer.angle - 0.1).abs() < 1e-5);
        assert!((o.inner.radius - 60.0 * half / (1.0 - half)).abs() < 1e-3);
        assert!((o.inner.angle - 0.1).abs() < 1e-5);
        // A whole ring has no corners; no radius draws sharp ones, where
        // `Edges` puts them.
        let o = Outline::new(shape(60.0, 100.0, TAU), 0.0, 10.0).unwrap();
        assert!(!o.is_rounded());
        let o = Outline::new(shape(0.0, 100.0, PI / 3.0), pad, 0.0).unwrap();
        let (meet, off) = Edges::new(0.0, 100.0, pad).inner(PI / 3.0);
        assert_eq!((o.inner.distance, o.inner.angle), (meet, off));
        assert!((o.outer.angle - pad / 2.0).abs() < 1e-6);
        // A pie's corners at the rim only: its edges meet short of the
        // center.
        let o = Outline::new(shape(0.0, 100.0, PI / 3.0), pad, 8.0).unwrap();
        assert_eq!((o.outer.radius, o.inner.radius), (8.0, 0.0));
        // Narrower than its pad: nothing.
        assert!(Outline::new(shape(0.0, 100.0, 0.05), pad, 8.0).is_none());
    }

    /// `gpui-base`'s `test_pie` and `test_pie_zero_values`
    /// (`shape/pie.rs:103-133`): equal shares split the turn; rows worth
    /// nothing, less or no number have no slice, and the others keep their
    /// rows' indices.
    #[test]
    fn a_pie_splits_the_turn_by_value() {
        let all = arcs(&[1.0, 1.0, 1.0], 0.0, TAU);
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].start, 0.0);
        assert_eq!(all[0].end, all[1].start);
        assert_eq!(all[1].end, all[2].start);
        assert!((all[2].end - TAU).abs() < 1e-5);
        let some = arcs(&[0.0, 1.0, f64::NAN, 3.0, -2.0], 0.0, TAU);
        assert_eq!(some.iter().map(|s| s.index).collect::<Vec<_>>(), [1, 3]);
        assert!((some[0].end - TAU / 4.0).abs() < 1e-5);
        // Nothing worth anything: no slices.
        assert!(arcs(&[0.0, f64::NAN], 0.0, TAU).is_empty());
        // Half a turn the other way, from 3 o'clock.
        let back = arcs(&[1.0, 1.0], FRAC_PI_2, -FRAC_PI_2);
        assert_eq!(back[1].start, 0.0);
        assert_eq!(back[1].end, -FRAC_PI_2);
    }

    /// `gpui-base`'s `test_arc_contains` (`shape/arc.rs:296-325`): the
    /// right half, 12 to 6 o'clock, of a ring from 10 to 40 in a 100 by
    /// 100 plot; and a half that starts before 12 o'clock.
    #[test]
    fn the_pointer_finds_the_slice_under_it() {
        let pts = |n: f32| DefiniteLength::Absolute(AbsoluteLength::Points(px(n)));
        let ring = Ring::of(
            size(px(100.0), px(100.0)),
            radius(pts(10.0)),
            radius(pts(40.0)),
        );
        let right = [slice(0, 0.0, PI), slice(1, PI, TAU)];
        let at = |x: f32, y: f32| ring.slice_at(&right, 0.0, point(px(x), px(y)));
        assert_eq!(at(80.0, 50.0), Some(0));
        assert_eq!(at(20.0, 50.0), Some(1));
        // Inside the hole and past the rim.
        assert_eq!(at(55.0, 50.0), None);
        assert_eq!(at(95.0, 50.0), None);
        // 12 o'clock starts the first slice, 6 o'clock the second.
        assert_eq!(at(50.0, 20.0), Some(0));
        assert_eq!(at(50.0, 80.0), Some(1));
        // From 9 o'clock: the upper half, then the lower.
        let upper = [
            slice(0, -FRAC_PI_2, FRAC_PI_2),
            slice(1, FRAC_PI_2, 3.0 * FRAC_PI_2),
        ];
        let at = |x: f32, y: f32| ring.slice_at(&upper, -FRAC_PI_2, point(px(x), px(y)));
        assert_eq!(at(50.0, 20.0), Some(0));
        assert_eq!(at(25.0, 45.0), Some(0));
        assert_eq!(at(50.0, 80.0), Some(1));
    }

    /// Radii in points or as a share of the largest circle the plot holds
    /// (half its smaller side), and how far a lifted rim reaches past it.
    #[test]
    fn radii_are_points_or_a_share_of_the_plot() {
        let share = |n: f32| DefiniteLength::Fraction(Percentage(n));
        let ring = Ring::of(
            size(px(200.0), px(100.0)),
            radius(share(0.6)),
            radius(share(1.0)),
        );
        assert_eq!(ring.center, point(px(100.0), px(50.0)));
        assert!(
            (ring.inner - 30.0).abs() < 1e-4 && ring.outer == 50.0,
            "{} {}",
            ring.inner,
            ring.outer
        );
        assert_eq!(ring.reach(size(px(200.0), px(100.0)), 6.0), 6.0);
        assert_eq!(ring.reach(size(px(200.0), px(120.0)), 6.0), 0.0);
    }

    /// A move stopped part of the way (`motion.update` changed again)
    /// moves on from the pose drawn there: radii between a share and
    /// points resolve at any size, a pie's slices each part of the way
    /// from where they came from, a new one opening from where the slice
    /// before it ended.
    #[test]
    fn a_move_goes_on_from_the_pose_drawn() {
        let near = |a: f32, b: f32| (a - b).abs() < 1e-5;
        let pts = |n: f32| Radius::of(DefiniteLength::Absolute(AbsoluteLength::Points(px(n))));
        let share = |n: f32| Radius::of(DefiniteLength::Fraction(Percentage(n)));
        let from = ArcPose::new(share(0.5), pts(40.0), 0.0, PI);
        let to = ArcPose::new(pts(0.0), pts(40.0), 0.0, FRAC_PI_2);
        let half = from.lerp(&to, 0.5);
        assert!(near(half.hi, 0.75 * PI), "{half:?}");
        let ring = Ring::of(size(px(100.0), px(100.0)), half.inner, half.outer);
        assert_eq!((ring.inner, ring.outer), (12.5, 40.0));
        let pie = |slices: &[Slice]| PiePose {
            inner: pts(0.0),
            outer: pts(40.0),
            start: 0.0,
            slices: slices.into(),
        };
        let before = pie(&[slice(0, 0.0, PI), slice(1, PI, TAU)]);
        let after = pie(&[slice(0, 0.0, FRAC_PI_2), slice(2, FRAC_PI_2, TAU)]);
        let shown = before.lerp(&after, 0.5);
        let [first, new] = shown.slices[..] else {
            panic!("{shown:?}")
        };
        assert!(first.index == 0 && near(first.start, 0.0) && near(first.end, 0.75 * PI));
        // Row 2 opens where row 1 ended, a whole turn round.
        assert!(new.index == 2 && near(new.start, 1.25 * PI) && near(new.end, TAU));
    }
}
