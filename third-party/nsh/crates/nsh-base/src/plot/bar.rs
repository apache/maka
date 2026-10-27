//! `Bar`: a series drawn as bars, one per row, in the bands of a plot's
//! band scale; bars that share a `stack` pile up, the others stand side by
//! side in each band.

use std::sync::Arc;

use nsh_core::{
    SvgPaint,
    canvas::{CanvasOp, Num, PathOp},
    element::{
        JsHost, JsIn, JsKind, JsOwned, JsValue, PropError, RowAccessor, RowText, Rows, Style,
        TsTypes,
    },
    prelude::*,
};

use super::{
    Axis, PlotContext, STROKE_ROOM, layer, mark_canvas, mark_canvas_with,
    scale::extent,
    series::{self, Mark},
};

/// The radius of each corner of a [`Bar`]'s bars (TS `BarCornerRadii`:
/// a number for all four, or `{ topLeft?, topRight?, bottomRight?,
/// bottomLeft? }`), as `gpui-base`'s `Bar::corner_radii` takes `Corners`:
/// round only the tip end of upright bars with `{ topLeft: 4, topRight: 4
/// }`. A radius larger than half a bar is made to fit it, as a canvas's
/// `roundRect` makes it fit.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
#[non_exhaustive]
pub struct BarCornerRadii {
    /// The top left corner's radius.
    pub top_left: Points,
    /// The top right corner's radius.
    pub top_right: Points,
    /// The bottom right corner's radius.
    pub bottom_right: Points,
    /// The bottom left corner's radius.
    pub bottom_left: Points,
}

impl BarCornerRadii {
    /// One radius for every corner.
    pub fn all(radius: Points) -> Self {
        Self {
            top_left: radius,
            top_right: radius,
            bottom_right: radius,
            bottom_left: radius,
        }
    }

    fn corners(&self) -> [Points; 4] {
        [
            self.top_left,
            self.top_right,
            self.bottom_right,
            self.bottom_left,
        ]
    }
}

impl From<Points> for BarCornerRadii {
    fn from(radius: Points) -> Self {
        Self::all(radius)
    }
}

impl From<Corners<Points>> for BarCornerRadii {
    fn from(c: Corners<Points>) -> Self {
        Self {
            top_left: c.top_left,
            top_right: c.top_right,
            bottom_right: c.bottom_right,
            bottom_left: c.bottom_left,
        }
    }
}

impl JsValue for BarCornerRadii {
    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("BarCornerRadii", |_| {
            "/** The radius of each corner of a `Bar`'s bars: a number for all four, or the corners named (the others square). */\nexport type BarCornerRadii = number | { topLeft?: number; topRight?: number; bottomRight?: number; bottomLeft?: number };\n".to_owned()
        })
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        let radius = |n: Option<f64>| -> Result<Points, PropError> {
            match n {
                None => Ok(Points(0.0)),
                Some(n) if n.is_finite() && n >= 0.0 => Ok(Points(n as f32)),
                Some(_) => Err(value.expected("a radius of 0 or more")),
            }
        };
        if let Some(n) = value.as_number() {
            return radius(Some(n)).map(Self::all);
        }
        if value.kind() != JsKind::Object {
            return Err(value.expected("a number or `{ topLeft?, topRight?, … }`"));
        }
        let corner = |key: &str| -> Result<Points, PropError> {
            let field = value.field(key)?;
            let field = field.get();
            match field.is_nullish() {
                true => Ok(Points(0.0)),
                false => radius(Some(field.as_number().unwrap_or(f64::NAN))),
            }
        };
        Ok(Self {
            top_left: corner("topLeft")?,
            top_right: corner("topRight")?,
            bottom_right: corner("bottomRight")?,
            bottom_left: corner("bottomLeft")?,
        })
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        let object = JsOwned::new(host, host.new_object()?);
        let keys = ["topLeft", "topRight", "bottomRight", "bottomLeft"];
        for (key, r) in keys.into_iter().zip(self.corners()) {
            host.set_field(object.get().raw(), key, host.new_number(r.0 as f64))?;
        }
        Ok(object)
    }
}

/// The inline style of a [`Bar`]'s labels: a [`Style`] whose TypeScript
/// type takes text styles too (`StyleProp<TextStyle>`), since a label is a
/// text.
#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct BarLabelStyle(pub Style);

impl From<Style> for BarLabelStyle {
    fn from(style: Style) -> Self {
        Self(style)
    }
}

impl JsValue for BarLabelStyle {
    fn ts_type(_types: &mut TsTypes) -> String {
        "StyleProp<TextStyle>".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        Style::from_js(value).map(Self)
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        self.0.to_js(host)
    }
}

/// The props of [`Bar`].
#[derive(Debug, Clone, PartialEq, Props)]
#[props(generic)]
pub struct BarProps {
    /// What each bar shows (`gpui-base`'s `value`): a field name, or a
    /// function of the row and its index; the plot's `y` without. A row
    /// without a value has no bar.
    pub value: Prop<Option<RowAccessor>>,
    /// The value its bars grow from (`gpui-base`'s `base`), on the plot's
    /// value scale; 0 by default, so a negative value grows the other
    /// way. It counts in the scale's domain. A stack grows from its first
    /// bar's.
    #[prop(default)]
    pub base: Prop<f64>,
    /// The stack it joins (`gpui-base`'s `Stack`, one series of its
    /// `keys`): the bars of a plot with the same `stack` pile up in order,
    /// each row's starting where the one before it ends (a row without a
    /// value adds nothing). Bars in different stacks, or in none, stand
    /// side by side in each band.
    pub stack: Prop<Option<SharedString>>,
    /// The radius of each corner of its bars (`gpui-base`'s
    /// `corner_radii`): a number for all four, or the corners named; square
    /// by default.
    #[prop(default)]
    pub corner_radii: Prop<BarCornerRadii>,
    /// How its bars appear one after another (`gpui-base`'s
    /// `PlotAppear::staggered` spread, 0 to 0.95): the share of the plot's
    /// appear over which they start, row by row, each growing for the
    /// rest of it; 0 (the default) grows them together.
    #[prop(default)]
    pub stagger: Prop<Percentage>,
    /// The opacity of its bars away from the row under the pointer, while
    /// the pointer is over the plot (`gpui-component`'s bar chart fades
    /// them, `HOVER_DIM`), so the row's bars stand out: faded in and out
    /// with the hover, and handed from bar to bar as the hover glides; none
    /// by default (they stay as they are).
    pub inactive_opacity: Prop<Option<Percentage>>,
    /// The text beside each bar, the `label` part (`gpui-base`'s `label`):
    /// a field name (its number) or a function of the row returning the
    /// text, at the bar's value end: above an upright bar, below one that
    /// grows down, after a bar across and before one that grows back.
    pub label: Prop<Option<RowText>>,
    /// The Tailwind classes of its labels: a text centered on the bar's
    /// end, its size, color and padding (its distance from the bar) the
    /// app's.
    pub label_class: Prop<Option<SharedString>>,
    /// The style of its labels, over `labelClass` (text styles too).
    #[prop(default)]
    pub label_style: Prop<BarLabelStyle>,
    /// The Tailwind classes of its background, the `background` part: the
    /// box of each bar, its background (`bg-*`, a gradient: `bg-linear-to-t
    /// from-… to-…` from the bottom of each bar to its top) shown only
    /// inside the bar, as CSS's `clip-path` shows a box's, under its
    /// `fill`. `gpui-base`'s
    /// `Bar::fill` takes a gradient (`shape/bar.rs:147`), CSS's `fill` a
    /// color, so a gradient is a background here, as `Area`'s. With a
    /// background, `fill` is `none` where none is set.
    pub background_class: Prop<Option<SharedString>>,
    /// The style of its background, over `backgroundClass`.
    #[prop(default)]
    pub background_style: Prop<Style>,
}

/// A bar a plot knows, for laying out its stacks and groups.
#[derive(Clone, Copy)]
pub(super) struct BarEntry {
    key: u64,
    stack: Prop<Option<SharedString>>,
    base: Prop<f64>,
    values: Signal<Option<Arc<[f64]>>>,
}

impl PartialEq for BarEntry {
    fn eq(&self, other: &Self) -> bool {
        self.key == other.key
    }
}

/// Where a plot's bars go: how many stand side by side in a band, and each
/// bar's place among them and its segments.
#[derive(Debug, Default, PartialEq)]
pub(super) struct BarLayout {
    slots: usize,
    bars: Vec<BarPlace>,
}

/// A bar's place in a band, its segment in each row (the values it spans,
/// `NaN` where it has none) and the value its stack grows from.
#[derive(Debug, Clone)]
struct BarPlace {
    key: u64,
    slot: usize,
    segments: Arc<[[f64; 2]]>,
    origin: f64,
}

/// The same numbers, gaps included.
impl PartialEq for BarPlace {
    fn eq(&self, other: &Self) -> bool {
        let same = |a: f64, b: f64| a.to_bits() == b.to_bits();
        self.key == other.key
            && self.slot == other.slot
            && same(self.origin, other.origin)
            && self.segments.len() == other.segments.len()
            && self
                .segments
                .iter()
                .zip(other.segments.iter())
                .all(|(a, b)| same(a[0], b[0]) && same(a[1], b[1]))
    }
}

/// The layout of `bars`, in order (`gpui-base`'s `Stack::series`: each
/// stack's rows start at its first bar's base, each bar's segment from
/// where the one before it ends, a missing value adding nothing).
pub(super) fn layout(bars: Signal<Vec<BarEntry>>) -> Memo<Arc<BarLayout>> {
    computed(move || {
        let all = bars.get();
        // A slot per bar outside any stack, one per stack.
        let mut slots: Vec<Option<SharedString>> = Vec::new();
        // Each stack's ends so far, by row, and its base.
        let mut tops: Vec<(SharedString, Vec<f64>, f64)> = Vec::new();
        let mut places = Vec::with_capacity(all.len());
        for bar in &all {
            let (stack, base) = (bar.stack.get(), bar.base.get());
            let values = bar.values.get().unwrap_or_else(|| Arc::from([]));
            let slot = match &stack {
                Some(id) => match slots.iter().position(|s| s.as_ref() == Some(id)) {
                    Some(at) => at,
                    None => {
                        slots.push(Some(id.clone()));
                        slots.len() - 1
                    }
                },
                None => {
                    slots.push(None);
                    slots.len() - 1
                }
            };
            let (segments, origin): (Arc<[[f64; 2]]>, f64) = match stack {
                None => (
                    values
                        .iter()
                        .map(|&v| match v.is_finite() {
                            true => [base, v],
                            false => [f64::NAN; 2],
                        })
                        .collect(),
                    base,
                ),
                Some(id) => {
                    let at = match tops.iter().position(|(s, _, _)| *s == id) {
                        Some(at) => at,
                        None => {
                            tops.push((id, Vec::new(), base));
                            tops.len() - 1
                        }
                    };
                    let (_, ends, origin) = &mut tops[at];
                    if ends.len() < values.len() {
                        ends.resize(values.len(), *origin);
                    }
                    let segments = values
                        .iter()
                        .zip(ends.iter_mut())
                        .map(|(&v, end)| {
                            let lo = *end;
                            if !v.is_finite() {
                                return [f64::NAN; 2];
                            }
                            *end = lo + v;
                            [lo, *end]
                        })
                        .collect();
                    (segments, *origin)
                }
            };
            places.push(BarPlace {
                key: bar.key,
                slot,
                segments,
                origin,
            });
        }
        Arc::new(BarLayout {
            slots: slots.len(),
            bars: places,
        })
    })
}

/// A bar as drawn: where it starts across its band and how thick it is,
/// the middle of its row's band, and where its two values go along the
/// value axis.
#[derive(Debug, Clone, Copy, PartialEq)]
struct BarRect {
    row: usize,
    start: f32,
    thick: f32,
    center: f32,
    /// The base end and the value end, along the value axis.
    from: f32,
    to: f32,
}

impl BarRect {
    /// Its box along the value axis: where it starts and how long it is.
    fn span(&self) -> (f32, f32) {
        (self.from.min(self.to), (self.to - self.from).abs())
    }
}

/// A bar's bars, as drawn.
#[derive(Debug, Clone, PartialEq)]
struct Geometry {
    /// Bars across the plot (bands down the y axis).
    across: bool,
    /// Where the stack's base goes along the value axis: the bars grow
    /// from it as they appear.
    origin: f32,
    /// The distance between the middles of two bands.
    step: f32,
    /// The rows the bands are laid out for (the appear's order).
    rows: usize,
    bars: Vec<BarRect>,
}

/// A series of a [`Plot`](super::Plot) drawn as bars (`gpui-base`'s `Bar`):
/// one per row with a value, in the row's band of the plot's band scale
/// (`xScale={{ type: "band" }}` for upright bars, `yScale` for bars
/// across), from `base` to the row's value on the other scale. Bars with
/// the same `stack` pile up; the others stand side by side in each band
/// (`groupPadding` between them). It fills with its `fill` (`fill-*`
/// classes; inherited from the plot as CSS inherits it), `currentColor`
/// where none is set, over its `background` part (a gradient per bar,
/// `bg-linear-*`; `fill` is then `none` where none is set), its corners
/// rounded by `cornerRadii`. Its values and base count in the value
/// scale's domain when the plot has none. With the plot's appear, its bars
/// grow out of their base (one after another with `stagger`); while the
/// pointer is over the plot, the bars of other rows fade to
/// `inactiveOpacity`; both on the platform's animator, with no mark drawn
/// again. Its `label` part writes a text at each bar's end. It shows no
/// hover dot.
#[component]
pub fn Bar(props: BarProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let Some(plot) = PlotContext::of("Bar") else {
        return layer();
    };
    let accessor = props.value;
    let values = series::values(
        move || plot.rows.get(),
        move || accessor.get().or_else(|| plot.y.get()),
    );
    let (stack, base) = (props.stack, props.base);
    let layout = plot.bar_layout;
    let key = plot.add(move |key| Mark {
        key,
        // Its segments' ends and its stack's base.
        extent: computed(move || {
            layout.with(|l| {
                let place = l.bars.iter().find(|b| b.key == key)?;
                extent(
                    place
                        .segments
                        .iter()
                        .flat_map(|s| s.iter().copied())
                        .chain([place.origin]),
                )
            })
        }),
        // Along the axis without bands.
        value_axis: computed(move || match plot.band_axis.get() {
            Some(Axis::Y) => Axis::X,
            _ => Axis::Y,
        }),
        points: computed(|| Arc::from([])),
        dot_x: animated_value(0.0),
        dot_y: animated_value(0.0),
        dot: None,
    });
    let bars = plot.bars;
    bars.update(|all| {
        all.push(BarEntry {
            key,
            stack,
            base,
            values,
        })
    });
    cleanup(move || {
        if let Some(mut all) = bars.try_get() {
            all.retain(|b| b.key != key);
            bars.try_set(all);
        }
    });

    // Where its bars go.
    let warned = stored(false);
    let geometry = computed(move || -> Option<Geometry> {
        if !plot.is_sized() {
            return None;
        }
        let (x_map, y_map) = (plot.x_map.get(), plot.y_map.get());
        let (band, value_map, across) = match (x_map.band(), y_map.band()) {
            (Some(band), _) => (band, y_map, false),
            (None, Some(band)) => (band, x_map, true),
            _ => {
                if !warned.get() {
                    warned.replace(true);
                    log::warn!("`Bar` draws on a band scale: `xScale={{{{ type: \"band\" }}}}`");
                }
                return None;
            }
        };
        layout.with(|l| {
            let place = l.bars.iter().find(|b| b.key == key)?;
            let group = band.groups(l.slots);
            let origin = value_map.tick(place.origin)?;
            let bars = place
                .segments
                .iter()
                .enumerate()
                .filter_map(|(row, &[lo, hi])| {
                    if !(lo.is_finite() && hi.is_finite()) || lo == hi {
                        return None;
                    }
                    let start = band.start(row)? + group.start(place.slot)?;
                    Some(BarRect {
                        row,
                        start,
                        thick: group.width(),
                        center: band.center(row)?,
                        from: value_map.tick(lo)?,
                        to: value_map.tick(hi)?,
                    })
                })
                .collect();
            Some(Geometry {
                across,
                origin,
                step: band.step(),
                rows: band.len(),
                bars,
            })
        })
    });

    let (radii, stagger, inactive) = (props.corner_radii, props.stagger, props.inactive_opacity);
    // How far row `row`'s bars have grown while the plot appears.
    let grown = move |g: &Geometry, row: usize| {
        plot.appear
            .staggered(row, g.rows, stagger.get().0.clamp(0.0, 0.95))
    };
    // The opacity of row `row`'s bars: `inactiveOpacity` away from the
    // hover's row, by the distance of the hover's band (gliding on the
    // pointer spring) in bands, as far as the hover has faded in.
    let opacity = move |g: &Geometry, bar: &BarRect| -> Option<AnimatedNode> {
        let dim = 1.0 - inactive.get()?.0.clamp(0.0, 1.0);
        if dim <= 0.0 || g.step <= 0.0 || !plot.interactive.get() {
            return None;
        }
        let at = match g.across {
            true => plot.cross.y,
            false => plot.cross.x,
        };
        let (c, s) = (bar.center, g.step);
        let away = at.interpolate(&[c - s, c, c + s], &[dim, 0.0, dim]);
        Some(away.mul(&plot.fade).mul(-1.0).add(1.0))
    };
    // Records the bars, each its own path, growing while the plot appears.
    let draw = move |mut p: Painter, fill: &dyn Fn(Painter, &BarRect) -> Painter| {
        let Some(g) = geometry.get() else { return p };
        let appearing = plot.appearing.get();
        let corners = radii.get().corners().map(|r| Num::Const(r.0));
        let square = corners.iter().all(|r| *r == Num::Const(0.0));
        for bar in &g.bars {
            if let Some(alpha) = opacity(&g, bar) {
                p = p.global_alpha(&alpha);
            }
            let (lo, len) = bar.span();
            let (at, length) = match appearing {
                // Scaled about the stack's base, so a stack grows whole.
                true => {
                    let q = grown(&g, bar.row);
                    (
                        p.num(&q.mul(lo - g.origin).add(g.origin)),
                        p.num(&q.mul(len)),
                    )
                }
                false => (Num::Const(lo), Num::Const(len)),
            };
            let (start, thick) = (Num::Const(bar.start), Num::Const(bar.thick));
            let rect = match g.across {
                true => [at, start, length, thick],
                false => [start, at, thick, length],
            };
            p = p.begin_path().op(CanvasOp::Path(match square {
                true => PathOp::Rect(rect),
                false => PathOp::RoundRect(rect, corners),
            }));
            p = fill(p, bar);
        }
        p
    };

    let (background_class, background_style) = (props.background_class, props.background_style);
    let has_background = move || {
        background_class.with(Option::is_some) || background_style.with(|s| *s != Style::default())
    };
    let (label, label_class, label_style) = (props.label, props.label_class, props.label_style);

    layer()
        // The background part: a canvas whose view takes the app's
        // background and shows it inside each bar only.
        .child(when(has_background, move || {
            let nothing = |p: Painter| p.begin_path().fill_background_from_view(Bounds::default());
            mark_canvas_with(
                Some(plot),
                || STROKE_ROOM,
                move || nothing(Painter::new()),
                move |p, _| {
                    let Some(g) = geometry.get() else {
                        return nothing(p);
                    };
                    if g.bars.is_empty() {
                        return nothing(p);
                    }
                    draw(p, &|p, bar| {
                        // The bar's own box: a gradient runs from its base
                        // to its tip, whatever its length.
                        let (lo, len) = bar.span();
                        let area = match g.across {
                            true => Bounds::new(
                                point(px(lo), px(bar.start)),
                                size(px(len), px(bar.thick)),
                            ),
                            false => Bounds::new(
                                point(px(bar.start), px(lo)),
                                size(px(bar.thick), px(len)),
                            ),
                        };
                        p.fill_background_from_view(area)
                    })
                },
            )
            .app_class(background_class)
            .inline_style(background_style)
        }))
        .child(mark_canvas(
            Some(plot),
            || STROKE_ROOM,
            move |p, _| {
                let initial = match has_background() {
                    true => SvgPaint::None,
                    false => SvgPaint::CurrentColor,
                };
                draw(p.fill_style_from_view(initial), &|p, _| p.fill())
            },
        ))
        // The label part: a text at each bar's value end.
        .child(when(
            move || label.with(Option::is_some),
            move || {
                let texts = texts(move || plot.rows.get(), move || label.get());
                // A label per row with a bar, made again when the rows the
                // appear staggers over or the bars' direction change.
                let shown = move || {
                    geometry.with(|g| match g {
                        Some(g) => g.bars.iter().map(|b| (b.row, g.rows, g.across)).collect(),
                        None => Vec::new(),
                    })
                };
                each(
                    shown,
                    |at| *at,
                    move |at, _| {
                        let (row, rows, across) = at.get_untracked();
                        bar_label(BarLabel {
                            plot,
                            geometry,
                            row,
                            rows,
                            across,
                            stagger,
                            text: move || {
                                texts.with(|t| {
                                    t.as_ref()
                                        .and_then(|t| t.get(row).cloned())
                                        .unwrap_or_default()
                                })
                            },
                            class: label_class,
                            style: label_style,
                        })
                    },
                )
            },
        ))
}

/// The texts `label` reads of `rows`, once known (as [`series::values`]).
fn texts(
    rows: impl Fn() -> Rows + 'static,
    label: impl Fn() -> Option<RowText> + 'static,
) -> Signal<Option<Arc<[SharedString]>>> {
    let out = signal(None::<Arc<[SharedString]>>);
    // A newer run wins over the answers of an older one.
    let generation = stored(0u64);
    effect(move || {
        let (rows, label) = (rows(), label());
        let run = generation.get() + 1;
        generation.replace(run);
        let Some(label) = label else {
            out.set(None);
            return;
        };
        match label.texts_now(&rows) {
            Some(texts) => out.set(Some(texts)),
            None => {
                spawn(async move {
                    let texts = label.texts(&rows).await;
                    if generation.get() == run {
                        out.set(Some(texts));
                    }
                });
            }
        }
    });
    out
}

/// What a bar's label needs.
struct BarLabel<F> {
    plot: PlotContext,
    geometry: Memo<Option<Geometry>>,
    row: usize,
    rows: usize,
    across: bool,
    stagger: Prop<Percentage>,
    text: F,
    class: Prop<Option<SharedString>>,
    style: Prop<BarLabelStyle>,
}

/// The label of the bar in row `row`: a point with no size at the bar's
/// value end, the text on the side away from the bar (above an upright
/// bar, after a bar across), centered across the bar; it rides the bar's
/// end and fades in as the bar grows. It takes no pointer.
fn bar_label(label: BarLabel<impl Fn() -> SharedString + 'static>) -> View {
    let BarLabel {
        plot,
        geometry,
        row,
        rows,
        across,
        stagger,
        text: content,
        class,
        style,
    } = label;
    let bar = move || {
        geometry.with(|g| {
            let g = g.as_ref()?;
            let bar = g.bars.iter().find(|b| b.row == row)?;
            Some((g.across, g.origin, *bar))
        })
    };
    // While the bars grow, the label sits back toward the base by what is
    // left to grow: (origin - end) * (1 - grown).
    let back = animated_value(0.0);
    effect(move || {
        if let Some((_, origin, b)) = bar() {
            back.set(origin - b.to);
        }
    });
    let grown = untracked(|| {
        plot.appear
            .staggered(row, rows, stagger.get().0.clamp(0.0, 0.95))
    });
    let left = grown.mul(-1.0).add(1.0);
    let ride = back.mul(&left);
    let anchor = view()
        .absolute()
        .w(px(0.0))
        .h(px(0.0))
        .flex_row()
        .pointer_events(PointerEvents::None)
        .bind_opacity(&grown)
        .style_with(move |s| {
            let Some((across, _, b)) = bar() else {
                return s;
            };
            let middle = b.start + b.thick / 2.0;
            // Away from the base: up (a smaller y) for an upright bar,
            // right for a bar across.
            let up = b.to <= b.from;
            let right = b.to >= b.from;
            match across {
                false => {
                    let s = s.left(px(middle)).top(px(b.to)).justify_center();
                    match up {
                        true => s.items_end(),
                        false => s.items_start(),
                    }
                }
                true => {
                    let s = s.left(px(b.to)).top(px(middle)).items_center();
                    match right {
                        true => s.justify_start(),
                        false => s.justify_end(),
                    }
                }
            }
        });
    let anchor = match across {
        true => anchor.bind_translate_x(&ride),
        false => anchor.bind_translate_y(&ride),
    };
    anchor.child(
        text(content)
            .flex_none()
            .app_class(class)
            .inline_style(move || style.get().0),
    )
}

#[cfg(test)]
mod tests {
    use nsh_core::element::{Runtime, create_root, signal};

    use super::*;

    fn entry(key: u64, stack: Option<&'static str>, base: f64, values: &[f64]) -> BarEntry {
        BarEntry {
            key,
            stack: Prop::new(stack.map(SharedString::from)),
            base: Prop::new(base),
            values: signal(Some(Arc::from(values))),
        }
    }

    /// `gpui-base`'s `Stack` (`shape/stack.rs:151-192`): each bar of a
    /// stack starts where the one before it ends, from the stack's base;
    /// bars outside a stack each take a place in the band, a stack one.
    #[test]
    fn bars_stack_and_stand_side_by_side() {
        let runtime = Runtime::default();
        let _entered = runtime.enter();
        let _ = create_root(|| {
            let bars = signal(vec![
                entry(0, Some("fruit"), 0.0, &[10.0, 15.0]),
                entry(1, None, 0.0, &[5.0, -3.0]),
                entry(2, Some("fruit"), 99.0, &[20.0, f64::NAN]),
                entry(3, Some("fruit"), 0.0, &[30.0, 35.0]),
            ]);
            let layout = layout(bars).get();
            assert_eq!(layout.slots, 2);
            let place = |key: u64| layout.bars.iter().find(|b| b.key == key).unwrap().clone();
            assert_eq!(&*place(0).segments, &[[0.0, 10.0], [0.0, 15.0]]);
            assert_eq!((place(0).slot, place(1).slot, place(3).slot), (0, 1, 0));
            assert_eq!(&*place(1).segments, &[[0.0, 5.0], [0.0, -3.0]]);
            // The stack's base is its first bar's; a gap adds nothing.
            let second = place(2);
            assert_eq!(second.segments[0], [10.0, 30.0]);
            assert!(second.segments[1][0].is_nan());
            assert_eq!(&*place(3).segments, &[[30.0, 60.0], [15.0, 50.0]]);
        });
    }
}
