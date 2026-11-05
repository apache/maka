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

use super::{PlotContext, ValueScale, layer, scale::AxisMap};

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
    /// The y scale a `"left"` or `"right"` axis carries: `"y"` (the
    /// default, the plot's `yScale`) or `"y2"` (its second one,
    /// `y2Scale`: a dual-axis chart's right-hand axis). A `"bottom"` or
    /// `"top"` axis carries the x scale whatever this says.
    #[prop(default)]
    pub scale: Prop<ValueScale>,
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
    /// of the tick's value and index. Without one, the category of a band
    /// on a band scale of categories (its `domain`, or its cells'), else
    /// d3's default: the value with the decimals the step between ticks
    /// needs, thousands grouped (`1,500`, `0.25`, `−2`).
    pub format: Prop<Option<TickFormat>>,
    /// The Tailwind classes of its labels, the `label` part: a text per
    /// tick, centered on it along the edge (along the x scale's edge the
    /// first and last moved inward to stay within the plot's ends), its
    /// font, color and padding
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
/// along the edge (along the x scale's, the first and last moved inward so
/// no label passes the plot's ends; beside the y scale's, each on its
/// tick, the plot keeping what a label near its top or bottom edge would
/// pass it by inside it, so every label sits on its tick within the plot),
/// and past the edge (`labelPlacement`: `"outside"`, where no
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
        scale: value_scale,
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
        false => plot.y_map_of(value_scale.get()),
    };
    // The categories of the scale's bands, which its labels write.
    let categories = computed(move || match placement.get().along_x() {
        true => plot.x_categories.get(),
        false if value_scale.get() == ValueScale::Y => plot.y_categories.get(),
        false => None,
    });
    // The ticks follow the scale's domain (or its rows, or its bands'
    // categories), not the plot's size: a resize moves the labels without
    // writing them again.
    let scale = computed(move || {
        let rows = categories.with(|c| c.as_ref().map(|c| c.len()));
        ScaleTicks::of(&map(), rows.unwrap_or_else(|| plot.rows.with(|r| r.len())))
    });
    let ticks = computed(move || {
        tick_values.with(|values| scale.get().ticks(count.get(), values.as_deref()))
    });
    let labels = label_texts(ticks, format, categories);
    // Beside the y scale's edge, outside, a label on its tick reaches half
    // its height above and below it: the plot keeps what would pass its
    // top and bottom edges inside them (`add_inset`), from each label's
    // height (as laid out) and where its tick lies along the scale (a
    // share of the range from its top, which an inset does not change).
    let heights = signal(Vec::<(usize, f32)>::new());
    let shares = signal(Vec::<(usize, f32)>::new());
    effect(move || {
        // The plot's state goes with the plot, which may go first.
        if plot.size.try_get().is_none() {
            return;
        }
        let AxisMap::Linear(linear) = map() else {
            return shares.set(Vec::new());
        };
        let [a, b] = linear.range();
        let (top, span) = (a.min(b), (a - b).abs());
        let now: Vec<(usize, f32)> = labels.with(|l| {
            l.iter()
                .enumerate()
                .filter_map(|(i, label)| {
                    // Only a label on the scale: one a new domain left
                    // behind (its text still coming) has no place there.
                    let share = (linear.tick(label.value)? - top) / span;
                    (span > 0.0 && (-1e-3..=1.0 + 1e-3).contains(&share)).then_some((i, share))
                })
                .collect()
        });
        // A share does not change with the inset it feeds, but recomputed
        // over the inset's new range it differs in its last bits: compared
        // exactly, each change would move the inset again, without end.
        let moved = |was: &Vec<(usize, f32)>| {
            was.len() != now.len()
                || was
                    .iter()
                    .zip(&now)
                    .any(|(a, b)| a.0 != b.0 || (a.1 - b.1).abs() > SHARE_EPSILON)
        };
        if shares.with_untracked(moved) {
            shares.set(now);
        }
    });
    plot.add_inset(computed(move || {
        let beside =
            !placement.get().along_x() && label_placement.get() == AxisLabelPlacement::Outside;
        if !beside {
            return [0.0; 2];
        }
        let Some(size) = plot.size.try_get() else {
            return [0.0; 2];
        };
        heights.with(|h| shares.with(|s| label_insets(h, s, size.height.0)))
    }));
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
    // Keyed by the scale too: a tick glides with its scale's domain.
    let indices = move || {
        let scale = value_scale.get();
        (0..labels.with(|l| l.len()))
            .map(|i| (i, scale))
            .collect::<Vec<_>>()
    };
    // While the axis's domain glides (`motion.update`), tick `i` moves with
    // the marks from where the layout puts it (its place on the new scale)
    // to where the domain shown puts it, as d3's axis transitions: the
    // offset the tick's view is translated by along its edge.
    let glide = move |(i, scale): (usize, ValueScale), s: View| {
        let along_x = placement.get_untracked().along_x();
        let tween = match along_x {
            true => plot.x_tween,
            false => plot.y_tween_of(scale),
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
                move |item, _| {
                    let item = item.get_untracked();
                    let i = item.0;
                    view()
                        .absolute()
                        .w(px(0.0))
                        .h(px(0.0))
                        .items_center()
                        .style_with(move |s| side().tick(s, at(i)))
                        .map(|s| glide(item, s))
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
                move |item, _| {
                    let item = item.get_untracked();
                    let i = item.0;
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
                    cleanup(move || {
                        if let Some(mut all) = heights.try_get() {
                            all.retain(|(at, _)| *at != i);
                            heights.try_set(all);
                        }
                    });
                    view()
                        .absolute()
                        .style_with(move |s| side().anchor(s, at(i)))
                        .map(|s| glide(item, s))
                        .child(
                            view().style_with(move |s| side().window(s, at(i))).child(
                                view()
                                    .flex_none()
                                    .on_layout(move |b: &Bounds<Points>| {
                                        let h = b.size.height.0;
                                        let known =
                                            heights.with_untracked(|all| all.contains(&(i, h)));
                                        if !known {
                                            heights.update(|all| {
                                                all.retain(|(at, _)| *at != i);
                                                all.push((i, h));
                                            });
                                        }
                                    })
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

/// How far a label's share of the range moves before the insets follow
/// it: far above f32's rounding of a share recomputed over a new range,
/// far below a share any tick moves by.
const SHARE_EPSILON: f32 = 1e-4;

/// How far in from a plot `height` tall its y scale's range must start
/// and end (top, bottom) for labels of `heights`, centered on ticks at
/// `shares` of the range from its top (by label index), to stay inside it:
/// a label `h` tall at share `f` sits at `top + f * (height - top -
/// bottom)`, which must be `h / 2` from either edge. The two insets lean
/// on each other, so they are found in a few rounds; neither takes more
/// than a third of the plot.
fn label_insets(heights: &[(usize, f32)], shares: &[(usize, f32)], height: f32) -> [f32; 2] {
    let (mut top, mut bottom) = (0.0_f32, 0.0_f32);
    let most = height / 3.0;
    let pairs: Vec<(f32, f32)> = heights
        .iter()
        .filter_map(|(i, h)| {
            shares
                .iter()
                .find(|(j, _)| j == i)
                .map(|(_, f)| (f.clamp(0.0, 1.0), h / 2.0))
        })
        .collect();
    for _ in 0..4 {
        top = pairs
            .iter()
            .filter(|(f, _)| *f < 1.0)
            .map(|(f, half)| (half - f * (height - bottom)) / (1.0 - f))
            .fold(0.0_f32, f32::max)
            .min(most);
        bottom = pairs
            .iter()
            .filter(|(f, _)| *f > 0.0)
            .map(|(f, half)| (half - (1.0 - f) * (height - top)) / f)
            .fold(0.0_f32, f32::max)
            .min(most);
    }
    [top, bottom]
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
fn label_texts(
    ticks: Memo<TickValues>,
    format: Prop<Option<TickFormat>>,
    categories: Memo<Option<Arc<[SharedString]>>>,
) -> Signal<Arc<[Label]>> {
    let out = signal(Arc::<[Label]>::from([]));
    // A newer run wins over the answers of an older one.
    let generation = stored(0u64);
    effect(move || {
        let ticks = ticks.get();
        let run = generation.get() + 1;
        generation.replace(run);
        let values = ticks.values.clone();
        match format.get() {
            // A band's category, or d3's default text.
            None => out.set(categories.with(|c| {
                let category = |v: f64| {
                    let c = c.as_ref()?;
                    (v.fract() == 0.0 && v >= 0.0)
                        .then(|| c.get(v as usize).cloned())
                        .flatten()
                };
                paired(
                    &values,
                    values
                        .iter()
                        .map(|&v| category(v).unwrap_or_else(|| default_text(v, ticks.precision))),
                )
            })),
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

    /// A label's anchor: room around the tick at `at`, as far on either
    /// side so the label centers on the tick in it, past the edge or
    /// inside it. Along the x scale's edge the room lies within the plot's
    /// ends (a wide label at an end moves inward); beside the y scale's,
    /// outside, it reaches the plot's height either way, so every label
    /// sits on its tick, as a grid line's label reads (the plot keeps what
    /// one would pass its top or bottom edge by inside it, `add_inset`).
    /// There it is a column with no width, the label's window overflowing
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
                    AxisLabelPlacement::Outside => {
                        let room = self.extent().max(room);
                        s.top(px(at - room)).h(px(2.0 * room))
                    }
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

/// The values of the ticks of `map` for a plot of `rows` rows: about
/// `count` (a `PlotAxis`'s `ticks`), or its default ticks without one, the
/// step of an aligned scale's.
pub(super) fn tick_values(map: &AxisMap, rows: usize, count: Option<u32>) -> Arc<[f64]> {
    ScaleTicks::of(map, rows).ticks(count, None).values
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
    /// A linear domain, and the step of its ticks when it is aligned with
    /// another scale's (`alignTicks`).
    Linear([f64; 2], Option<f64>),
    Rows {
        places: usize,
        rows: usize,
    },
}

impl ScaleTicks {
    /// What `map`'s ticks follow, for a plot of `rows` rows.
    fn of(map: &AxisMap, rows: usize) -> Self {
        match map {
            AxisMap::Linear(linear) => ScaleTicks::Linear(linear.domain(), linear.step()),
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
            // Aligned with another scale: a tick at every step, as that
            // one's, unless the app asks for other ticks.
            ScaleTicks::Linear([lo, hi], Some(step)) if count.is_none() && values.is_none() => {
                let n = ((hi - lo) / step).round().max(0.0) as usize;
                TickValues {
                    values: (0..=n).map(|i| lo + i as f64 * step).collect(),
                    precision: step_precision(step),
                }
            }
            ScaleTicks::Linear([lo, hi], _) => {
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

/// The decimals a tick `step` apart needs, up to six (0.25: two).
fn step_precision(step: f64) -> usize {
    (0..6)
        .find(|&p| {
            let scaled = step * 10f64.powi(p as i32);
            (scaled - scaled.round()).abs() < 1e-6 * scaled.abs().max(1.0)
        })
        .unwrap_or(6)
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

    /// Labels on ticks at the ends of the range need half their height
    /// kept inside the plot; one in the middle needs nothing; one near an
    /// end only what it would pass the edge by.
    #[test]
    fn labels_keep_what_would_pass_the_edges_inside() {
        let h = [(0, 10.0), (1, 10.0), (2, 10.0)];
        assert_eq!(
            label_insets(&h, &[(0, 0.0), (1, 0.5), (2, 1.0)], 100.0),
            [5.0, 5.0]
        );
        assert_eq!(label_insets(&h, &[(1, 0.5)], 100.0), [0.0, 0.0]);
        let [top, bottom] = label_insets(&h[..1], &[(0, 0.02)], 100.0);
        assert_eq!(bottom, 0.0);
        // At 2% of the range below the top, the label's middle is half its
        // height (5) down.
        assert!((top + 0.02 * (100.0 - top) - 5.0).abs() < 1e-4, "{top}");
        // A tick past the domain has no share and needs nothing.
        assert_eq!(label_insets(&h, &[], 100.0), [0.0, 0.0]);
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
        let linear = ScaleTicks::Linear([0.0, 100.0], None);
        assert_eq!(
            &*linear
                .ticks(None, Some(&[-1.0, 0.0, 50.0, 100.0, 101.0]))
                .values,
            [0.0, 50.0, 100.0]
        );
    }
}
