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
        Rows, Style, TsTypes,
    },
    geometry::{AbsoluteLength, DefiniteLength, Percentage, REM_SIZE, Radians},
    prelude::*,
};

use super::{PlotContext, STROKE_ROOM, mark_canvas, series::values};

/// Below this, a radius or an angle is none (`gpui-base`'s `EPSILON`,
/// `shape/arc.rs:9`, at `f32`'s precision).
const EPSILON: f32 = 1e-6;

/// The classes of a [`Pie`]'s slices, the `slice` part (TS `string | ((d:
/// T, index: number) => string)`): the same on every slice, or the app's
/// function of a slice's row and its index, as `gpui-component`'s
/// `PieChart::color` takes a function of the datum
/// (`chart/pie_chart.rs:206`), called once per row when the rows or the
/// function change, in the next JS turn, never while the pie draws or
/// follows the pointer (so the function is pure: the same row, the same
/// classes).
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

impl Ring {
    /// The ring of a plot of `size` (`gpui-base`'s `Arc::path`: the center
    /// of the bounds, `shape/arc.rs:105`), its radii in points or as a
    /// share of the largest circle the plot holds (half its smaller side,
    /// as d3's and Recharts' percentages are).
    fn of(size: Size<Points>, inner: DefiniteLength, outer: DefiniteLength) -> Self {
        let half = size.width.0.min(size.height.0) / 2.0;
        let r = |l: DefiniteLength| {
            l.to_points(AbsoluteLength::Points(px(half)), REM_SIZE)
                .0
                .max(0.0)
        };
        Ring {
            center: point(size.width / 2.0, size.height / 2.0),
            inner: r(inner),
            outer: r(outer),
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
}

/// The ring's appear: the angles sweep from `from`, each `from + (angle -
/// from) * reveal`, `reveal` the appear's eased progress
/// (`gpui-component`'s pie, `chart/pie_chart.rs:318-334`).
#[derive(Clone, Copy)]
struct Sweep {
    reveal: AnimatedNode,
    from: f32,
}

/// `max(n, 0)` on the platform's animator.
fn above_zero(n: AnimatedNode) -> AnimatedNode {
    n.interpolate(&[0.0, 1.0e4], &[0.0, 1.0e4])
}

/// Records an annular sector of `ring` from `start` to `end` (pie angles),
/// its outer edge `lift` past the ring's (a lifted slice), `pad` between
/// it and its neighbours. The gaps keep the
/// width the pad makes at the rim at every radius: each edge runs parallel
/// to its radial, offset by half that width, so a gap is a band of even
/// width rather than a wedge closing at the center. Where a slice is too
/// narrow to reach the hole (or there is none) its edges meet in a point
/// short of the center; a slice narrower than its pad draws nothing. A
/// whole turn takes no pad, as d3's. While `sweep` runs the angles move
/// with it; while `morph` runs the radii move from its ring's to `ring`'s.
/// `None`: nothing to draw.
#[allow(clippy::too_many_arguments)]
fn sector(
    p: Painter,
    ring: Ring,
    lift: Option<AnimatedNode>,
    start: f32,
    end: f32,
    pad: f32,
    sweep: Option<Sweep>,
    morph: Option<(Ring, AnimatedValue)>,
) -> Option<Painter> {
    let (lo, hi) = (start.min(end), start.max(end));
    let span = hi - lo;
    let r1 = ring.outer;
    if r1 < EPSILON || span < EPSILON {
        return None;
    }
    let pad = match span >= TAU - EPSILON {
        true => 0.0,
        false => pad.clamp(0.0, PI),
    };
    let edges = Edges::new(ring.inner, r1, pad);
    let (cx, cy) = (ring.center.x.0, ring.center.y.0);
    // The appear draws the ring it ends on.
    let morph = morph.filter(|_| sweep.is_none());
    let rim = match morph {
        Some((from, t)) if from.outer != r1 => Some(t.interpolate(&[0.0, 1.0], &[from.outer, r1])),
        _ => None,
    };
    let outer: CanvasArg = match (rim, lift) {
        (None, None) => r1.into(),
        (None, Some(lift)) => (&lift.add(r1)).into(),
        (Some(rim), None) => (&rim).into(),
        (Some(rim), Some(lift)) => (&rim.add(&lift)).into(),
    };
    // The canvas's angles: 0 at 3 o'clock.
    let screen = -FRAC_PI_2;
    let p = p.begin_path();
    let p = match sweep {
        None => {
            let (a0, a1) = (lo + pad / 2.0, hi - pad / 2.0);
            if a1 - a0 <= 0.0 {
                return None;
            }
            let p = p.arc(cx, cy, outer, a0 + screen, a1 + screen);
            match morph {
                None => {
                    let (radius, off) = edges.inner(span);
                    p.arc_counterclockwise(cx, cy, radius, hi - off + screen, lo + off + screen)
                }
                Some((from, t)) => {
                    // The inner edge of the ring in between, sampled: it
                    // turns from a point into an arc as the hole opens.
                    let lerp = |a: f32, b: f32, k: f32| a + (b - a) * k;
                    let (ts, (radii, offs)): (Vec<f32>, (Vec<f32>, Vec<f32>)) = (0..=MORPH_SAMPLES)
                        .map(|i| {
                            let k = i as f32 / MORPH_SAMPLES as f32;
                            let edges = Edges::new(
                                lerp(from.inner, ring.inner, k),
                                lerp(from.outer, r1, k),
                                pad,
                            );
                            (k, edges.inner(span))
                        })
                        .unzip();
                    let radius = t.interpolate(&ts, &radii);
                    let off = t.interpolate(&ts, &offs);
                    p.arc_counterclockwise(
                        cx,
                        cy,
                        &radius,
                        &off.mul(-1.0).add(hi + screen),
                        &off.add(lo + screen),
                    )
                }
            }
        }
        Some(Sweep { reveal, from }) => {
            // An angle at the sweep's progress.
            let at = |a: f32, plus: f32| reveal.mul(a - from).add(from + plus + screen);
            let a0 = at(lo, pad / 2.0);
            // Never past its start (a slice narrower than its pad, early).
            let a1 = a0.add(&above_zero(reveal.mul(span).sub(pad)));
            let p = p.arc(cx, cy, outer, &a0, &a1);
            // The inner edge as the slice opens, sampled densely where it
            // turns from a point into an arc.
            let (ts, (radii, offs)): (Vec<f32>, (Vec<f32>, Vec<f32>)) = (0..=SWEEP_SAMPLES)
                .map(|i| {
                    let t = (i as f32 / SWEEP_SAMPLES as f32).powi(2);
                    (t, edges.inner(span * t))
                })
                .unzip();
            let radius = reveal.interpolate(&ts, &radii);
            let off = reveal.interpolate(&ts, &offs);
            p.arc_counterclockwise(
                cx,
                cy,
                &radius,
                &at(hi, 0.0).sub(&off),
                &at(lo, 0.0).add(&off),
            )
        }
    };
    Some(p.close_path())
}

/// The samples of the inner edge of a sweeping slice.
const SWEEP_SAMPLES: usize = 48;

/// The samples of the inner edge of a slice changing its radii.
const MORPH_SAMPLES: usize = 32;

/// A radial mark's move to new radii (`motion.update`): the radii it moves
/// from, while it runs, and how far it has gone, on the platform's
/// animator. The plot's size changing moves nothing: only the app's radii.
#[derive(Clone, Copy)]
struct Morph {
    from: Signal<Option<(DefiniteLength, DefiniteLength)>>,
    progress: AnimatedValue,
}

impl Morph {
    /// Follows `inner` and `outer`, moving to each new pair with the
    /// plot's `motion.update` (at once without one or with reduced motion).
    fn new(plot: PlotContext, inner: Prop<DefiniteLength>, outer: Prop<DefiniteLength>) -> Self {
        let from = signal(None);
        let progress = animated_value(1.0);
        let last = stored(None::<(DefiniteLength, DefiniteLength)>);
        effect(move || {
            let to = (inner.get(), outer.get());
            let Some(before) = last.get() else {
                last.replace(Some(to));
                return;
            };
            if before == to {
                return;
            }
            last.replace(Some(to));
            let timing = untracked(|| plot.motion.get().and_then(|m| m.update));
            match timing {
                Some(timing) if timing.duration_ms > 0.0 && !reduce_motion() => {
                    from.set(Some(before));
                    progress.set(0.0);
                    spawn(async move {
                        // Stopped by a newer change: that one ends it.
                        if progress.timing_with(1.0, timing).await {
                            from.set(None);
                        }
                    });
                }
                _ => from.set(None),
            }
        });
        Morph { from, progress }
    }

    /// The ring it moves from in a plot of `size`, and how far, while it
    /// runs.
    fn ring(&self, size: Size<Points>) -> Option<(Ring, AnimatedValue)> {
        let (inner, outer) = self.from.get()?;
        Some((Ring::of(size, inner, outer), self.progress))
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
/// appear. Its values take no part in the plot's scales.
#[component]
pub fn Pie(props: PieProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let plot = PlotContext::of("Pie");
    let (start, end, pad) = (props.start_angle, props.end_angle, props.pad_angle);
    let (inner, outer) = (props.inner_radius, props.outer_radius);
    let (lift, dim) = (props.hover_lift, props.hover_dim);
    let Some(plot) = plot else {
        return layer_of(None);
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
    let ring = computed(move || Ring::of(plot.size.get(), inner.get(), outer.get()));
    let morph = Morph::new(plot, inner, outer);
    plot.add_hit(move |at| {
        let from = start.get_untracked().0.min(end.get_untracked().0);
        slices.with_untracked(|all| ring.get_untracked().slice_at(all, from, at))
    });
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
    layer_of(Some(each(
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
            // How far this slice has lifted, 0 to 1: on the pointer
            // spring while the plot moves, at once without one or with
            // reduced motion; it shows as far as the hover has faded in.
            let lifted = animated_value(0.0);
            if lifts || dim > 0.0 {
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
            }
            let view = mark_canvas(Some(plot), bleed, move |p, _| {
                let Some(slice) = slices.with(|all| all.iter().find(|s| s.index == row).copied())
                else {
                    return p;
                };
                let ring = ring.get();
                let lift = lifts.then(|| lifted.mul(&plot.fade).mul(lift.get().0));
                let sweep = plot.appearing.get().then(|| Sweep {
                    reveal: plot.appear.progress(),
                    from: start.get().0,
                });
                let morph = morph.ring(plot.size.get());
                paint(p, |p| {
                    sector(
                        p,
                        ring,
                        lift,
                        slice.start,
                        slice.end,
                        pad.get().0,
                        sweep,
                        morph,
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
    )))
}

/// A radial mark's layer: it fills the plot and holds its slices.
fn layer_of(slices: Option<AnyElement>) -> View {
    let layer = super::layer();
    match slices {
        Some(slices) => layer.child(slices),
        None => layer,
    }
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
}

/// An arc of a [`Plot`](super::Plot) (`gpui-base`'s `Arc`, painting one
/// `ArcData`): the sector from `startAngle` to `endAngle` around the
/// plot's center, between `innerRadius` and `outerRadius`; a gauge's
/// track and its value, or a ring behind a pie. It fills with its `fill`
/// (`fill-*`; `currentColor` where none is set) and strokes with its
/// `stroke` (none where none is set), as CSS inherits them from the plot,
/// and sweeps in from `startAngle` with the plot's appear. It is a shape,
/// not a row: the pointer over it finds nothing.
#[component]
pub fn Arc(props: ArcProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let plot = PlotContext::of("Arc");
    let (start, end) = (props.start_angle, props.end_angle);
    let (inner, outer) = (props.inner_radius, props.outer_radius);
    let ring = move |plot: PlotContext| Ring::of(plot.size.get(), inner.get(), outer.get());
    let morph = plot.map(|plot| Morph::new(plot, inner, outer));
    mark_canvas(
        plot,
        move || match plot {
            Some(plot) => STROKE_ROOM + ring(plot).reach(plot.size.get(), 0.0).ceil(),
            None => STROKE_ROOM,
        },
        move |p, _| {
            let Some(plot) = plot else { return p };
            let ring = ring(plot);
            let sweep = plot.appearing.get().then(|| Sweep {
                reveal: plot.appear.progress(),
                from: start.get().0,
            });
            let morph = morph.and_then(|m| m.ring(plot.size.get()));
            paint(p, |p| {
                sector(p, ring, None, start.get().0, end.get().0, 0.0, sweep, morph)
            })
        },
    )
}

#[cfg(test)]
mod tests {
    use std::f32::consts::{FRAC_PI_2, PI, TAU};

    use nsh_core::geometry::{AbsoluteLength, DefiniteLength, Percentage, point, px, size};

    use super::{Edges, Ring, Slice, arcs};

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
        let ring = Ring::of(size(px(100.0), px(100.0)), pts(10.0), pts(40.0));
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
        let ring = Ring::of(size(px(200.0), px(100.0)), share(0.6), share(1.0));
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
}
