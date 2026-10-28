//! `PlotAxis`: an axis along an edge of a plot, its ticks read from the
//! plot's scale and its labels laid out natively (`gpui-base`'s
//! `PlotAxis`, with d3-axis's ticks and orientations).

use std::{fmt, rc::Rc, sync::Arc};

use nsh_core::{
    element::{
        Arg, Callback, JsHost, JsIn, JsKind, JsOwned, JsValue, PropError, Style, StyleRefinement,
        TsTypes,
    },
    prelude::*,
};

use super::{PlotContext, layer, scale::AxisMap};

/// The edge of a [`Plot`](super::Plot) a [`PlotAxis`] runs along, as d3's
/// `axisBottom`, `axisTop`, `axisLeft` and `axisRight`: the bottom and top
/// edges carry the x scale's ticks, the left and right ones the y
/// scale's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum AxisPlacement {
    /// Along the bottom edge, the x scale's ticks.
    #[default]
    Bottom,
    /// Along the top edge, the x scale's ticks.
    Top,
    /// Along the left edge, the y scale's ticks.
    Left,
    /// Along the right edge, the y scale's ticks.
    Right,
}

impl AxisPlacement {
    /// It runs along the x axis (the bottom or the top edge).
    fn along_x(self) -> bool {
        matches!(self, AxisPlacement::Bottom | AxisPlacement::Top)
    }
}

/// Which side of its edge a [`PlotAxis`] lays its labels on
/// (`gpui-base`'s `AxisLabelPlacement`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum AxisLabelPlacement {
    /// Past the plot's edge, in the room the app leaves around the plot
    /// (its margin, or its parent's padding), as d3's axes sit in a
    /// chart's margins: they never cover a mark.
    #[default]
    Outside,
    /// Over the plot, along the inside of its edge, so the plot keeps its
    /// whole size: a label of the x scale just inside the bottom (or top)
    /// edge, one of the y scale beside the edge on its grid line's upper
    /// side (`gpui-component`'s inside value labels).
    Inside,
}

/// The text of a [`PlotAxis`]'s tick (TS `(value: number, index: number)
/// => string`, d3's `axis.tickFormat`): the app's function of the tick's
/// value on the scale (a row's index on a `point` or `band` scale) and
/// its index among the axis's ticks, called once per tick when the ticks
/// or the function change, in the next JS turn, never while the plot
/// draws or follows the pointer (so the function is pure: the same
/// value, the same text).
#[derive(Clone)]
pub enum TickFormat {
    /// The app's JS function.
    Js(Callback<(f64, u32), SharedString>),
    /// A Rust function, for axes made in Rust.
    Rust(Rc<dyn Fn(f64, usize) -> SharedString>),
}

impl TickFormat {
    /// The text `f` gives a tick's value and index (Rust).
    pub fn from_fn(f: impl Fn(f64, usize) -> SharedString + 'static) -> Self {
        TickFormat::Rust(Rc::new(f))
    }
}

impl fmt::Debug for TickFormat {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TickFormat::Js(_) => f.write_str("Js"),
            TickFormat::Rust(_) => f.write_str("Rust"),
        }
    }
}

/// The same Rust function; the app's functions are told apart by the
/// texts they give, so a function set again (an arrow function in JSX is
/// a new one at each render) is called again.
impl PartialEq for TickFormat {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (TickFormat::Rust(a), TickFormat::Rust(b)) => Rc::ptr_eq(a, b),
            _ => false,
        }
    }
}

impl JsValue for TickFormat {
    fn ts_type(_types: &mut TsTypes) -> String {
        "(value: number, index: number) => string".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        match value.kind() {
            JsKind::Function => {
                <Callback<(f64, u32), SharedString> as Arg>::from_js(value).map(TickFormat::Js)
            }
            _ => Err(value.expected("a function of a tick's value and index")),
        }
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        // A function stays the app's: it is not handed back.
        Ok(JsOwned::new(host, host.undefined()))
    }
}

/// The inline style of a [`PlotAxis`]'s labels: a [`Style`] whose
/// TypeScript type takes text styles too (`StyleProp<TextStyle>`), since a
/// label is a text.
#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct AxisLabelStyle(pub Style);

impl From<Style> for AxisLabelStyle {
    fn from(style: Style) -> Self {
        Self(style)
    }
}

impl JsValue for AxisLabelStyle {
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

/// The props of [`PlotAxis`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct PlotAxisProps {
    /// The edge it runs along (d3's `axisBottom`, `axisTop`, `axisLeft`,
    /// `axisRight`): `"bottom"` (the default) and `"top"` carry the x
    /// scale's ticks, `"left"` and `"right"` the y scale's.
    #[prop(default)]
    pub placement: Prop<AxisPlacement>,
    /// Which side of the edge its labels take (`gpui-base`'s
    /// `AxisLabelPlacement`): `"outside"` (the default), past the edge in
    /// the room the app leaves around the plot, or `"inside"`, over the
    /// plot along its edge.
    #[prop(default)]
    pub label_placement: Prop<AxisLabelPlacement>,
    /// About how many ticks it takes (d3's `axis.ticks(count)`;
    /// `gpui-component`'s `y_tick_count` / `x_tick_count`): on a `linear`
    /// scale, d3's nice values (1, 2 or 5 times a power of ten) inside the
    /// domain, about this many (10 by default); on a `point` or `band`
    /// scale, this many rows spread evenly from the first to the last
    /// (every row by default).
    pub ticks: Prop<Option<u32>>,
    /// The values of its ticks, in place of `ticks` (d3's
    /// `axis.tickValues`): values of the scale (row indices on a `point`
    /// or `band` scale, every third row as `[0, 3, 6]`); those outside the
    /// scale's domain have no place and no tick.
    pub tick_values: Prop<Option<Vec<f64>>>,
    /// The text of each tick (d3's `axis.tickFormat`): the app's function
    /// of the tick's value and index. Without one, d3's default: the value
    /// with the decimals the step between ticks needs, thousands grouped
    /// (`1,500`, `0.25`, `−2`).
    pub format: Prop<Option<TickFormat>>,
    /// The Tailwind classes of its labels, the `label` part: a text per
    /// tick, centered on it along the edge (the first and last moved
    /// inward to stay within the plot's ends), its font, color and padding
    /// (its distance from the edge) the app's.
    pub label_class: Prop<Option<SharedString>>,
    /// The style of its labels, over `labelClass` (text styles too).
    #[prop(default)]
    pub label_style: Prop<AxisLabelStyle>,
    /// The Tailwind classes of its tick marks, the `tick` part (d3's
    /// `tickSize`): a view per tick from the edge toward its label,
    /// centered on the tick, its size and color the app's (`w-px h-1.5
    /// bg-border` on a bottom axis); none without a class or style.
    pub tick_class: Prop<Option<SharedString>>,
    /// The style of its tick marks, over `tickClass`.
    #[prop(default)]
    pub tick_style: Prop<Style>,
    /// The Tailwind classes of its line, the `line` part (d3's domain
    /// path, `gpui-base`'s `x_axis` / `y_axis` line): a view along the
    /// whole edge on its labels' side, its thickness and color the app's
    /// (`h-px bg-border` on a bottom axis); none without a class or style.
    pub line_class: Prop<Option<SharedString>>,
    /// The style of its line, over `lineClass`.
    #[prop(default)]
    pub line_style: Prop<Style>,
}

/// An axis of a [`Plot`](super::Plot) (`gpui-base`'s `PlotAxis`, d3's
/// axes): along one edge, ticks at values of the scale the edge carries
/// (d3's nice values on a `linear` scale, rows on a `point` or `band`
/// one; `ticks`, `tickValues`), each with its label, the text `format`
/// gives, laid out natively by the plot's layout: centered on its tick
/// along the edge, the first and last moved inward so no label passes the
/// plot's ends, and past the edge (`labelPlacement`: `"outside"`, where no
/// mark is) or along its inside. Its parts are the app's to style (the
/// labels, `tick` marks and the `line`), and only the labels show unless
/// the app styles the others. It follows the plot's size and scales, and
/// takes no pointer; screen readers hear the plot, not its labels.
#[component]
pub fn PlotAxis(props: PlotAxisProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let axis = layer().pointer_events(PointerEvents::None);
    let Some(plot) = PlotContext::of("PlotAxis") else {
        return axis;
    };
    let PlotAxisProps {
        placement,
        label_placement,
        ticks: count,
        tick_values,
        format,
        label_class,
        label_style,
        tick_class,
        tick_style,
        line_class,
        line_style,
        ..
    } = props;
    let map = move || match placement.get().along_x() {
        true => plot.x_map.get(),
        false => plot.y_map.get(),
    };
    // The ticks follow the scale's domain (or its rows), not the plot's
    // size: a resize moves the labels without writing them again.
    let scale = computed(move || ScaleTicks::of(&map(), plot.rows.with(|r| r.len())));
    let ticks = computed(move || {
        tick_values.with(|values| scale.get().ticks(count.get(), values.as_deref()))
    });
    let labels = label_texts(ticks, format);
    let side = move || Side {
        placement: placement.get(),
        labels: label_placement.get(),
        size: plot.size.get(),
    };
    // Where tick `i` is along the edge, once the plot has a size.
    let at = move |i: usize| {
        let value = labels.with(|l| l.get(i).map(|l| l.value))?;
        map().tick(value).filter(|t| t.is_finite())
    };
    let indices = move || (0..labels.with(|l| l.len())).collect::<Vec<usize>>();
    // While the axis's domain glides (`motion.update`), tick `i` moves with
    // the marks from where the layout puts it (its place on the new scale)
    // to where the domain shown puts it, as d3's axis transitions: the
    // offset the tick's view is translated by along its edge.
    let glide = move |i: usize, s: View| {
        let along_x = placement.get_untracked().along_x();
        let tween = match along_x {
            true => plot.x_tween,
            false => plot.y_tween,
        };
        let place = animated_value(0.0);
        effect(move || {
            if let Some(t) = at(i).filter(|_| tween.moving.get()) {
                place.set(t);
            }
        });
        let moved = tween.moved(&place);
        match along_x {
            true => s.bind_translate_x(&moved),
            false => s.bind_translate_y(&moved),
        }
    };
    let has_line =
        move || line_class.with(Option::is_some) || line_style.with(|s| *s != Style::default());
    let has_ticks =
        move || tick_class.with(Option::is_some) || tick_style.with(|s| *s != Style::default());

    axis.child(when(
        move || plot.is_sized() && has_line(),
        move || {
            view().absolute().style_with(move |s| side().line(s)).child(
                view()
                    .flex_none()
                    .app_class(line_class)
                    .inline_style(line_style),
            )
        },
    ))
    .child(when(
        move || plot.is_sized() && has_ticks(),
        move || {
            each(
                indices,
                |i| *i,
                move |i, _| {
                    let i = i.get_untracked();
                    view()
                        .absolute()
                        .w(px(0.0))
                        .h(px(0.0))
                        .items_center()
                        .style_with(move |s| side().tick(s, at(i)))
                        .map(|s| glide(i, s))
                        .child(
                            view()
                                .flex_none()
                                .app_class(tick_class)
                                .inline_style(tick_style),
                        )
                },
            )
        },
    ))
    .child(when(
        move || plot.is_sized(),
        move || {
            each(
                indices,
                |i| *i,
                move |i, _| {
                    let i = i.get_untracked();
                    let content = move || {
                        labels
                            .with(|l| l.get(i).map(|l| l.text.clone()))
                            .unwrap_or_default()
                    };
                    // The anchor spans the room around the tick, the window
                    // inside it aligns the label toward the tick's end of
                    // the plot, and the label's own automatic margins center
                    // it on the tick while it fits: CSS's automatic margins
                    // are none when the label is wider than its room, so it
                    // starts at the plot's end it is near rather than
                    // passing it.
                    view()
                        .absolute()
                        .style_with(move |s| side().anchor(s, at(i)))
                        .map(|s| glide(i, s))
                        .child(
                            view().style_with(move |s| side().window(s, at(i))).child(
                                view()
                                    .flex_none()
                                    .style_with(move |s| side().label(s))
                                    .child(
                                        text(content)
                                            .app_class(label_class)
                                            .inline_style(move || label_style.get().0),
                                    ),
                            ),
                        )
                },
            )
        },
    ))
}

/// A tick and its text.
#[derive(Debug, Clone, PartialEq)]
struct Label {
    value: f64,
    text: SharedString,
}

/// The ticks and their texts, once known: at once for d3's default texts
/// or a Rust function, in the next JS turn for the app's function. A
/// label keeps the value its text was written for, so it shows at that
/// value's place until the new texts come.
fn label_texts(ticks: Memo<TickValues>, format: Prop<Option<TickFormat>>) -> Signal<Arc<[Label]>> {
    let out = signal(Arc::<[Label]>::from([]));
    // A newer run wins over the answers of an older one.
    let generation = stored(0u64);
    effect(move || {
        let ticks = ticks.get();
        let run = generation.get() + 1;
        generation.replace(run);
        let values = ticks.values.clone();
        match format.get() {
            None => out.set(paired(
                &values,
                values.iter().map(|&v| default_text(v, ticks.precision)),
            )),
            Some(TickFormat::Rust(f)) => out.set(paired(
                &values,
                values.iter().enumerate().map(|(i, &v)| f(v, i)),
            )),
            Some(TickFormat::Js(f)) => {
                let answers: Vec<_> = values
                    .iter()
                    .enumerate()
                    .map(|(i, &v)| f.call_async((v, i as u32)))
                    .collect();
                spawn(async move {
                    let mut texts = Vec::with_capacity(answers.len());
                    for answer in answers {
                        texts.push(answer.await.unwrap_or_default());
                    }
                    if generation.get() == run {
                        out.set(paired(&values, texts));
                    }
                });
            }
        }
    });
    out
}

/// `values` with their `texts`, in order.
fn paired(values: &[f64], texts: impl IntoIterator<Item = SharedString>) -> Arc<[Label]> {
    values
        .iter()
        .zip(texts)
        .map(|(&value, text)| Label { value, text })
        .collect()
}

/// An axis's place on the plot: its edge, its labels' side of it and the
/// plot's size, laying out its parts.
#[derive(Clone, Copy)]
struct Side {
    placement: AxisPlacement,
    labels: AxisLabelPlacement,
    size: Size<Points>,
}

impl Side {
    /// The plot's length along the edge.
    fn extent(&self) -> f32 {
        match self.placement.along_x() {
            true => self.size.width.0,
            false => self.size.height.0,
        }
    }

    /// The edge's position across it: 0 for the top and left edges, the
    /// plot's height or width for the bottom and right ones.
    fn edge(&self) -> f32 {
        match self.placement {
            AxisPlacement::Top | AxisPlacement::Left => 0.0,
            AxisPlacement::Bottom => self.size.height.0,
            AxisPlacement::Right => self.size.width.0,
        }
    }

    /// The labels' side of the edge is toward larger x or y (below the
    /// bottom edge, right of the right one, inside the top and left ones):
    /// the tick marks and the line grow that way from the edge.
    fn forward(&self) -> bool {
        matches!(
            (self.placement, self.labels),
            (
                AxisPlacement::Bottom | AxisPlacement::Right,
                AxisLabelPlacement::Outside
            ) | (
                AxisPlacement::Top | AxisPlacement::Left,
                AxisLabelPlacement::Inside
            )
        )
    }

    /// Lays out `s` from the edge toward the labels' side: from its start
    /// toward larger values, or from its end toward smaller ones.
    fn grow(&self, s: StyleRefinement) -> StyleRefinement {
        match self.forward() {
            true => s.justify_start(),
            false => s.justify_end(),
        }
    }

    /// The line: a box with no thickness along the whole edge, the app's
    /// view growing from it toward the labels and stretched along it.
    fn line(&self, s: StyleRefinement) -> StyleRefinement {
        let (edge, extent) = (px(self.edge()), px(self.extent()));
        let s = match self.placement.along_x() {
            true => s.flex_col().left(px(0.0)).top(edge).w(extent).h(px(0.0)),
            false => s.flex_row().top(px(0.0)).left(edge).h(extent).w(px(0.0)),
        };
        self.grow(s)
    }

    /// A tick mark's anchor: a point on the edge at `at`, the app's view
    /// centered on it and growing toward the labels.
    fn tick(&self, s: StyleRefinement, at: Option<f32>) -> StyleRefinement {
        let Some(at) = at else { return s.hidden() };
        let (at, edge) = (px(at), px(self.edge()));
        let s = match self.placement.along_x() {
            true => s.flex_col().left(at).top(edge),
            false => s.flex_row().top(at).left(edge),
        };
        self.grow(s)
    }

    /// A label's anchor: the room around the tick at `at` that lies within
    /// the plot's ends (as far on either side, so the label centers on
    /// the tick in it), past the edge or inside it. Beside the y scale's
    /// edge it is a column with no width, the label's window overflowing
    /// it away from the plot (outside) or into it (inside); inside, the
    /// room runs from the top edge down to the tick, the label at its
    /// bottom: on the grid line's upper side.
    fn anchor(&self, s: StyleRefinement, at: Option<f32>) -> StyleRefinement {
        let Some(at) = at else { return s.hidden() };
        let room = at.min(self.extent() - at).max(0.0);
        let edge = self.edge();
        match self.placement.along_x() {
            true => {
                let s = s.flex_row().left(px(at - room)).w(px(2.0 * room));
                match (self.placement, self.labels) {
                    (AxisPlacement::Bottom, AxisLabelPlacement::Outside)
                    | (AxisPlacement::Top, AxisLabelPlacement::Inside) => s.top(px(edge)),
                    // Its lower edge on the plot's top edge, or on the
                    // inside of the bottom one.
                    (AxisPlacement::Top, AxisLabelPlacement::Outside) => {
                        s.bottom(px(self.size.height.0))
                    }
                    _ => s.bottom(px(0.0)),
                }
            }
            false => {
                let s = s.flex_row().left(px(edge)).w(px(0.0));
                let s = match self.labels {
                    AxisLabelPlacement::Outside => s.top(px(at - room)).h(px(2.0 * room)),
                    AxisLabelPlacement::Inside => s.top(px(0.0)).h(px(at)),
                };
                self.grow(s)
            }
        }
    }

    /// A label's window in its anchor: along the x scale's edge it fills
    /// the anchor; beside the y scale's it is as wide as the label and as
    /// tall as the anchor. Its label goes toward the plot's end the tick
    /// is nearer (inside, toward the tick, at the window's bottom).
    fn window(&self, s: StyleRefinement, at: Option<f32>) -> StyleRefinement {
        let near_start = at.is_some_and(|at| at <= self.extent() / 2.0);
        // Inside, beside the y scale's edge, the room ends at the tick.
        let to_tick = self.labels == AxisLabelPlacement::Inside && !self.placement.along_x();
        let s = match self.placement.along_x() {
            true => s.flex_1().min_w(px(0.0)).flex_row(),
            false => s.flex_none().flex_col(),
        };
        match near_start || to_tick {
            true => s.justify_start(),
            false => s.justify_end(),
        }
    }

    /// The label's box: centered in its window while it fits (its upper
    /// margin taking the room inside beside the y scale's edge, so it sits
    /// on the tick).
    fn label(&self, s: StyleRefinement) -> StyleRefinement {
        match (self.placement.along_x(), self.labels) {
            (true, _) => s.mx(auto()),
            (false, AxisLabelPlacement::Outside) => s.my(auto()),
            (false, AxisLabelPlacement::Inside) => s.mt(auto()),
        }
    }
}

/// The ticks of a [`PlotAxis`] when the app gives no `ticks` (d3's
/// `scale.ticks()` count).
const DEFAULT_TICKS: u32 = 10;

/// The values an axis ticks, and the decimals its default texts write.
#[derive(Debug, Clone, PartialEq)]
struct TickValues {
    values: Arc<[f64]>,
    precision: usize,
}

/// What a scale's ticks follow: its domain, or how many places (rows,
/// bands) it lays out and how many rows there are.
#[derive(Debug, Clone, Copy, PartialEq)]
enum ScaleTicks {
    Linear([f64; 2]),
    Rows { places: usize, rows: usize },
}

impl ScaleTicks {
    /// What `map`'s ticks follow, for a plot of `rows` rows.
    fn of(map: &AxisMap, rows: usize) -> Self {
        match map {
            AxisMap::Linear(linear) => ScaleTicks::Linear(linear.domain()),
            AxisMap::Point { len, .. } => ScaleTicks::Rows {
                places: *len,
                rows: *len,
            },
            AxisMap::Band(band) => ScaleTicks::Rows {
                places: band.len(),
                rows,
            },
        }
    }

    /// Its ticks: about `count` nice values in the domain (d3's
    /// `ticks`), or `count` of the rows spread evenly from the first to
    /// the last (`gpui-component`'s `labeled_items`), or the app's
    /// `values` within the domain.
    fn ticks(self, count: Option<u32>, values: Option<&[f64]>) -> TickValues {
        match self {
            ScaleTicks::Linear([lo, hi]) => {
                let count = f64::from(count.unwrap_or(DEFAULT_TICKS));
                let values = match values {
                    Some(values) => {
                        let slack = (hi - lo) * 1e-9;
                        values
                            .iter()
                            .copied()
                            .filter(|v| *v >= lo - slack && *v <= hi + slack)
                            .collect()
                    }
                    None => linear_ticks(lo, hi, count).into(),
                };
                TickValues {
                    values,
                    precision: precision(lo, hi, count),
                }
            }
            ScaleTicks::Rows { places, rows } => {
                let values = match values {
                    Some(values) => values
                        .iter()
                        .copied()
                        .filter(|v| *v >= 0.0 && *v <= places as f64 - 1.0)
                        .collect(),
                    None => spread(places, count)
                        .into_iter()
                        .filter(|&i| i < rows)
                        .map(|i| i as f64)
                        .collect(),
                };
                TickValues {
                    values,
                    precision: 0,
                }
            }
        }
    }
}

/// `count` of `places` spread evenly from the first to the last, both
/// included (every one without a count, or with as many).
fn spread(places: usize, count: Option<u32>) -> Vec<usize> {
    match count.map(|c| c as usize) {
        _ if places == 0 => Vec::new(),
        Some(0) => Vec::new(),
        Some(1) => vec![0],
        Some(count) if count < places => (0..count)
            .map(|k| (k as f64 * (places - 1) as f64 / (count - 1) as f64).round() as usize)
            .collect(),
        _ => (0..places).collect(),
    }
}

/// d3's thresholds between the steps of 1, 2, 5 and 10 times a power of
/// ten (`d3-array`'s `ticks.js`: √50, √10, √2).
const E10: f64 = 7.0710678118654755;
const E5: f64 = 3.1622776601683795;
const E2: f64 = std::f64::consts::SQRT_2;

/// JS's `Math.round`: halves up.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// d3's `tickSpec(start, stop, count)` (`start < stop`): the first and last
/// tick as multiples of the increment `inc`, which is the step, or for a
/// step below 1 its inverse, negated (so the ticks are `i / -inc`, exact).
fn tick_spec(start: f64, stop: f64, count: f64) -> (f64, f64, f64) {
    let step = (stop - start) / count.max(0.0);
    let power = step.log10().floor();
    let error = step / 10f64.powf(power);
    let factor = match error {
        e if e >= E10 => 10.0,
        e if e >= E5 => 5.0,
        e if e >= E2 => 2.0,
        _ => 1.0,
    };
    let (mut i1, mut i2, inc);
    if power < 0.0 {
        let n = 10f64.powf(-power) / factor;
        i1 = js_round(start * n);
        i2 = js_round(stop * n);
        if i1 / n < start {
            i1 += 1.0;
        }
        if i2 / n > stop {
            i2 -= 1.0;
        }
        inc = -n;
    } else {
        let n = 10f64.powf(power) * factor;
        i1 = js_round(start / n);
        i2 = js_round(stop / n);
        if i1 * n < start {
            i1 += 1.0;
        }
        if i2 * n > stop {
            i2 -= 1.0;
        }
        inc = n;
    }
    if i2 < i1 && (0.5..2.0).contains(&count) {
        return tick_spec(start, stop, count * 2.0);
    }
    (i1, i2, inc)
}

/// d3's `ticks(lo, hi, count)`: about `count` values of 1, 2 or 5 times a
/// power of ten inside `lo..=hi`, from the lowest.
fn linear_ticks(lo: f64, hi: f64, count: f64) -> Vec<f64> {
    if count.is_nan() || count <= 0.0 || !lo.is_finite() || !hi.is_finite() {
        return Vec::new();
    }
    if lo == hi {
        return vec![lo];
    }
    let (i1, i2, inc) = tick_spec(lo, hi, count);
    if i2.is_nan() || i1.is_nan() || i2 < i1 {
        return Vec::new();
    }
    (0..=(i2 - i1) as usize)
        .map(|i| {
            let k = i1 + i as f64;
            match inc < 0.0 {
                true => k / -inc,
                false => k * inc,
            }
        })
        .collect()
}

/// The decimals d3's default tick text writes (`tickFormat`'s
/// `precisionFixed(tickStep(lo, hi, count))`): as many as the step needs.
/// A domain of one value writes what the value needs, up to six.
fn precision(lo: f64, hi: f64, count: f64) -> usize {
    if lo == hi || count.is_nan() || count <= 0.0 {
        return (0..6)
            .find(|&p| {
                let scale = 10f64.powi(p as i32);
                ((lo * scale).round() / scale - lo).abs() < 1e-9
            })
            .unwrap_or(6);
    }
    match tick_spec(lo, hi, count).2 {
        inc if inc < 0.0 => (-inc).log10().ceil().max(0.0) as usize,
        _ => 0,
    }
}

/// `value` as d3's default tick format writes it (`,.<precision>f`):
/// `precision` decimals, thousands grouped with commas, a minus sign
/// (U+2212) before a value below zero that does not round to zero.
fn default_text(value: f64, precision: usize) -> SharedString {
    if !value.is_finite() {
        return SharedString::default();
    }
    // JS's `toFixed`, which d3 writes with: halves away from zero.
    let scale = 10f64.powi(precision as i32);
    let fixed = format!("{:.*}", precision, (value.abs() * scale).round() / scale);
    let (whole, fraction) = match fixed.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (fixed.as_str(), None),
    };
    let zero = fixed.bytes().all(|b| b == b'0' || b == b'.');
    let mut out = String::with_capacity(fixed.len() + whole.len() / 3 + 3);
    if value < 0.0 && !zero {
        out.push('\u{2212}');
    }
    for (i, c) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    if let Some(fraction) = fraction {
        out.push('.');
        out.push_str(fraction);
    }
    out.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// d3's `ticks(start, stop, count)` (`d3-array`'s tests): values of 1,
    /// 2 or 5 times a power of ten inside the domain, about `count` of
    /// them, exact at fractional steps.
    #[test]
    fn linear_ticks_are_d3s() {
        assert_eq!(
            linear_ticks(0.0, 1.0, 10.0),
            [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
        );
        assert_eq!(linear_ticks(0.0, 1.0, 5.0), [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]);
        assert_eq!(linear_ticks(0.0, 1.0, 2.0), [0.0, 0.5, 1.0]);
        assert_eq!(linear_ticks(0.0, 1.0, 1.0), [0.0, 1.0]);
        assert_eq!(linear_ticks(0.0, 10.0, 2.0), [0.0, 5.0, 10.0]);
        assert_eq!(
            linear_ticks(-10.0, 10.0, 4.0),
            [-10.0, -5.0, 0.0, 5.0, 10.0]
        );
        assert_eq!(
            linear_ticks(0.0, 100.0, 5.0),
            [0.0, 20.0, 40.0, 60.0, 80.0, 100.0]
        );
        // Inside a domain whose ends are not ticks.
        assert_eq!(linear_ticks(40.9, 41.7, 4.0), [41.0, 41.2, 41.4, 41.6]);
        assert_eq!(linear_ticks(0.0, 130.0, 4.0), [0.0, 50.0, 100.0]);
        assert_eq!(linear_ticks(1.0, 1.0, 10.0), [1.0]);
        assert!(linear_ticks(0.0, 1.0, 0.0).is_empty());
    }

    /// d3's default text: the step's decimals, thousands grouped, a minus
    /// sign for what stays below zero.
    #[test]
    fn default_texts_are_d3s() {
        assert_eq!(precision(0.0, 1.0, 10.0), 1);
        assert_eq!(precision(0.0, 1.0, 50.0), 2);
        assert_eq!(precision(0.0, 100.0, 5.0), 0);
        assert_eq!(precision(2.5, 2.5, 10.0), 1);
        assert_eq!(default_text(1500.0, 0), "1,500");
        assert_eq!(default_text(1234567.25, 2), "1,234,567.25");
        assert_eq!(default_text(0.25, 1), "0.3");
        assert_eq!(default_text(-2.0, 0), "\u{2212}2");
        assert_eq!(default_text(-0.001, 1), "0.0");
    }

    /// Rows on a `point` or `band` scale: every one, or `count` of them
    /// spread from the first to the last (`gpui-component`'s
    /// `labeled_items`); a band scale laid out for more bands than rows
    /// ticks only the rows, at the places of the spread over all bands.
    #[test]
    fn rows_spread_from_the_first_to_the_last() {
        assert_eq!(spread(4, None), [0, 1, 2, 3]);
        assert_eq!(spread(7, Some(3)), [0, 3, 6]);
        assert_eq!(spread(120, Some(5)), [0, 30, 60, 89, 119]);
        assert_eq!(spread(3, Some(1)), [0]);
        assert_eq!(spread(3, Some(9)), [0, 1, 2]);
        assert!(spread(0, Some(1)).is_empty());
        let band = ScaleTicks::Rows { places: 7, rows: 4 };
        assert_eq!(&*band.ticks(Some(3), None).values, [0.0, 3.0]);
        assert_eq!(
            &*band.ticks(None, Some(&[0.0, 6.0, 7.0])).values,
            [0.0, 6.0]
        );
        let linear = ScaleTicks::Linear([0.0, 100.0]);
        assert_eq!(
            &*linear
                .ticks(None, Some(&[-1.0, 0.0, 50.0, 100.0, 101.0]))
                .values,
            [0.0, 50.0, 100.0]
        );
    }
}
