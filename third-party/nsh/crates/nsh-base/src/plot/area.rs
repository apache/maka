//! `Area`: a series drawn as the region between its line and a baseline.

use nsh_core::{
    SvgPaint,
    element::{
        JsHost, JsIn, JsKind, JsOwned, JsValue, PropError, RowAccessor, RowText, Rows, Style,
        TsTypes,
    },
    prelude::*,
};

use super::{
    PlotContext, STROKE_ROOM, layer,
    line::{Curve, trace, trace_back},
    mark_canvas, mark_canvas_with, reach,
    scale::AxisMap,
    series::{self, HoverDot, Series},
};

/// Where an [`Area`]'s bottom edge goes (`y0`; TS `number |
/// Extract<keyof T, string> | ((d: T, index: number) => number)`): a value
/// of the y scale, a constant baseline (`gpui-base`'s `Area::y0`), or a
/// value of each row, read as [`RowAccessor`] reads the top edge's (d3's
/// `area().y0(accessor)`), which makes the area a band: a range from low
/// to high, a forecast's fan.
#[derive(Debug, Clone, PartialEq)]
pub enum AreaY0 {
    /// A value of the y scale, the same for every row.
    Value(f64),
    /// A value of each row: a field name or a function of the row and its
    /// index.
    Row(RowAccessor),
}

impl AreaY0 {
    /// The constant baseline.
    fn value(&self) -> Option<f64> {
        match self {
            AreaY0::Value(v) => Some(*v),
            AreaY0::Row(_) => None,
        }
    }

    /// What reads each row's bottom value.
    fn row(&self) -> Option<RowAccessor> {
        match self {
            AreaY0::Row(accessor) => Some(accessor.clone()),
            AreaY0::Value(_) => None,
        }
    }
}

impl From<f64> for AreaY0 {
    fn from(value: f64) -> Self {
        AreaY0::Value(value)
    }
}

impl From<RowAccessor> for AreaY0 {
    fn from(accessor: RowAccessor) -> Self {
        AreaY0::Row(accessor)
    }
}

impl From<&str> for AreaY0 {
    fn from(key: &str) -> Self {
        AreaY0::Row(key.into())
    }
}

impl JsValue for AreaY0 {
    fn ts_type(types: &mut TsTypes) -> String {
        format!("number | {}", RowAccessor::ts_type(types))
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        match value.kind() {
            JsKind::Number => f64::from_js(value).map(AreaY0::Value),
            JsKind::String | JsKind::Function => RowAccessor::from_js(value).map(AreaY0::Row),
            _ => Err(value.expected("a number, a field name or a function of a row")),
        }
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            AreaY0::Value(v) => v.to_js(host),
            AreaY0::Row(accessor) => accessor.to_js(host),
        }
    }
}

/// The props of [`Area`].
#[derive(Debug, Clone, PartialEq, Props)]
#[props(generic)]
pub struct AreaProps {
    /// Rows of its own (`gpui-base`'s `data`); the plot's rows without.
    pub data: Prop<Option<Rows>>,
    /// What places its own rows along the plot's x axis (`gpui-base`'s
    /// `x`); a row's index without.
    pub x: Prop<Option<RowAccessor>>,
    /// What makes its top edge (`gpui-base`'s `y1`): a field name or a
    /// function of the row and its index; the plot's `y` without.
    pub y1: Prop<Option<RowAccessor>>,
    /// Its bottom edge (`gpui-base`'s `y0`, d3's `area().y0`): a value of
    /// the y scale, a constant baseline; or a field name or a function of
    /// the row and its index, a bottom value per row (a band: a day's low
    /// to its high, a forecast's fan), traced with the top edge's `curve`,
    /// a row without one skipped. Without one, the edge of the plot where
    /// the y scale's smallest values are: the bottom edge, the top one
    /// when the scale is reversed (an area hanging from the top).
    pub y0: Prop<Option<AreaY0>>,
    /// How its edges connect their points: `"natural"` (the default, a
    /// smooth curve, as `gpui-base`'s), `"linear"` or `"stepAfter"`.
    #[prop(default)]
    pub curve: Prop<Curve>,
    /// The Tailwind classes of its background, the `background` part: a
    /// box around its shape (from its first point to its last, from its
    /// highest point or baseline to its lowest), its background (`bg-*`, a
    /// gradient: `bg-linear-to-b from-… to-…`) shown only inside the
    /// shape, as CSS's `clip-path` shows a box's, under its `fill`.
    /// `gpui-base`'s `Area::fill` takes a gradient
    /// (`shape/area.rs:71`); CSS's `fill` takes a color, so a gradient is
    /// a background here, as in a browser. With a background, `fill` is
    /// `none` where none is set.
    pub background_class: Prop<Option<SharedString>>,
    /// The style of its background (`backgroundColor`, `backgroundImage:
    /// "linear-gradient(…)"`), over `backgroundClass`.
    #[prop(default)]
    pub background_style: Prop<Style>,
    /// The Tailwind classes of its hover dot, the `hoverDot` part: the dot
    /// the plot shows on its top edge at the row under the pointer
    /// (`TooltipState::dots`), its size, background and border the app's;
    /// the plot's `dotClass` where none is set. `hidden` shows none (an
    /// area under a line that has its own).
    pub hover_dot_class: Prop<Option<SharedString>>,
    /// The style of its hover dot, over `hoverDotClass`; the plot's
    /// `dotStyle` where none is set.
    #[prop(default)]
    pub hover_dot_style: Prop<Style>,
    /// The category of its rows, which the plot's `colorScale` gives a
    /// color (d3's `scaleOrdinal` of a field): a field name (its text, a
    /// number as JS writes it) or a function of the row and its index. An
    /// area is one series: its first row with a category gives the color.
    /// That color is its `fill` where nothing sets one, in place of
    /// `currentColor` (beside a background, `fill` stays `none`), so the
    /// app's `fill-*` classes and `fill` style win.
    pub color: Prop<Option<RowText>>,
}

/// A series of a [`Plot`](super::Plot) drawn as the region between its
/// line and a baseline (`gpui-base`'s `Area`): its top edge goes through
/// one point per row with a value, placed by the plot's scales, the rows
/// without one skipped, as a [`Line`](super::Line)'s does, and it closes
/// down to `y0`: a constant baseline, or with a `y0` of each row (d3's
/// `area().y0(accessor)`) a bottom edge through those values with the same
/// curve, back to the first row, a band. It fills with its `fill`
/// (`fill-*` classes; inherited from the plot as CSS inherits it),
/// `currentColor` where none is set (with `color`, its category's color
/// of the plot's `colorScale` instead), over its `background` part (a
/// gradient, `bg-linear-*`, shown inside its shape; `fill` is then `none`
/// where none is set), and strokes its top edge with its `stroke`
/// (`stroke-*`, `strokeWidth`, `strokeDasharray`), none where none is set.
/// Its values and its `y0` count in the y scale's domain when the plot has
/// none; it has a hover dot on its top edge when it or the plot styles one
/// (`hoverDotClass`, the plot's `dotClass`), and draws in with the plot's
/// appear.
#[component]
pub fn Area(props: AreaProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let plot = PlotContext::of("Area");
    let (y0, curve) = (props.y0, props.curve);
    let hover_dot = HoverDot {
        class: props.hover_dot_class,
        style: props.hover_dot_style,
    };
    let series = plot.map(|plot| {
        let low = move || y0.with(|y0| y0.as_ref().and_then(AreaY0::row));
        let series = Series::new(plot, props.data, props.x, props.y1, low);
        series.join(
            plot,
            move || y0.with(|y0| y0.as_ref().and_then(AreaY0::value)),
            hover_dot,
        );
        series
    });
    let (data, color) = (props.data, props.color);
    let colors = plot.map(|plot| {
        series::colors(
            plot,
            move || data.get().unwrap_or_else(|| plot.rows.get()),
            color,
        )
    });
    // Its constant baseline: `y0`'s value, or the edge of the plot where
    // the y scale's smallest values are (the bottom one; the top one when
    // reversed).
    let base = move |plot: PlotContext| match y0.with(|y0| y0.as_ref().map(AreaY0::value)) {
        Some(Some(v)) => plot.y_map.get().tick(v).unwrap_or(0.0),
        _ => match plot.y_map.get() {
            AxisMap::Linear(map) => map.range()[0],
            _ => plot.size.get().height.0,
        },
    };
    // How far past the plot it draws: its edges' swing, or its baseline.
    let bleed = move || {
        let (Some(plot), Some(series)) = (plot, series) else {
            return STROKE_ROOM;
        };
        let height = plot.size.get().height.0;
        let swing = series.points.with(|ps| reach(ps, curve.get(), height));
        let past = series.lows.with(|lows| match lows.is_empty() {
            true => {
                let floor = base(plot);
                (-floor).max(floor - height)
            }
            false => reach(lows, curve.get(), height),
        });
        STROKE_ROOM + swing.max(past).ceil()
    };
    // Its shape: the top edge, to the baseline or the plot's edge, and
    // back. Both edges of a band and a baseline at a value move with the y
    // scale's domain; the plot's edge stays.
    let shape =
        move |p: Painter, plot: PlotContext, points: &[Point<Points>], lows: &[Point<Points>]| {
            let (first, last) = (points[0], points[points.len() - 1]);
            let p = plot.traced(p.begin_path(), true, true, |p| {
                trace(p.move_to(first.x, first.y), points, curve.get())
            });
            let p = match lows.last() {
                Some(end) => plot.traced(p, true, true, |p| {
                    trace_back(p.line_to(end.x, end.y), lows, curve.get())
                }),
                None => {
                    let base = base(plot);
                    let at_value = y0.with(|y0| y0.as_ref().and_then(AreaY0::value).is_some());
                    plot.traced(p, true, at_value, |p| {
                        p.line_to(last.x, px(base)).line_to(first.x, px(base))
                    })
                }
            };
            p.close_path()
        };
    let (background_class, background_style) = (props.background_class, props.background_style);
    let has_background = move || {
        background_class.with(Option::is_some) || background_style.with(|s| *s != Style::default())
    };
    layer()
        // The background part: a canvas whose view takes the app's
        // background and shows it inside the shape only.
        .child(when(has_background, move || {
            // From its first drawing on, before the plot's layout and with
            // no rows too (a fill of nothing), so its view never draws the
            // background as a box.
            let nothing = |p: Painter| p.begin_path().fill_background_from_view(Bounds::default());
            mark_canvas_with(
                plot,
                bleed,
                move || nothing(Painter::new()),
                move |p, bleed| {
                    let (Some(plot), Some(series)) = (plot, series) else {
                        return nothing(p);
                    };
                    let (points, lows) = (series.points.get(), series.lows.get());
                    if points.is_empty() {
                        return nothing(p);
                    }
                    // From its highest point to its lowest, the baseline's
                    // or the bottom edge's included.
                    let start = match lows.is_empty() {
                        true => base(plot),
                        false => points[0].y.0,
                    };
                    let (first, last) = (points[0], points[points.len() - 1]);
                    let (top, bottom) = points
                        .iter()
                        .chain(lows.iter())
                        .fold((start, start), |(lo, hi), q| (lo.min(q.y.0), hi.max(q.y.0)));
                    let area = Bounds::new(
                        point(first.x, px(top)),
                        size(last.x - first.x, px(bottom - top)),
                    );
                    shape(plot.clip(p, bleed), plot, &points, &lows).fill_background_from_view(area)
                },
            )
            .app_class(background_class)
            .inline_style(background_style)
        }))
        .child(mark_canvas(plot, bleed, move |p, bleed| {
            let initial = match has_background() {
                true => SvgPaint::None,
                false => SvgPaint::CurrentColor,
            };
            let p = p.fill_style_from_view(series::paint_of(
                colors.and_then(series::first_color),
                initial,
            ));
            let (Some(plot), Some(series)) = (plot, series) else {
                return p;
            };
            let (points, lows) = (series.points.get(), series.lows.get());
            let Some(first) = points.first() else {
                return p;
            };
            let p = shape(plot.clip(p, bleed), plot, &points, &lows)
                .fill()
                .stroke_style_from_view(SvgPaint::None)
                .line_width_from_view()
                .line_dash_from_view();
            plot.traced(p.begin_path(), true, true, |p| {
                trace(p.move_to(first.x, first.y), &points, curve.get())
            })
            .stroke()
        }))
}
