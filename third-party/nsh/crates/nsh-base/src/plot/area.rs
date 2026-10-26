//! `Area`: a series drawn as the region between its line and a baseline.

use nsh_core::{
    SvgPaint,
    element::{RowAccessor, Rows, Style},
    prelude::*,
};

use super::{
    PlotContext, STROKE_ROOM, layer,
    line::{Curve, trace},
    mark_canvas, mark_canvas_with, reach,
    series::{HoverDot, Series},
};

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
    /// The value of its baseline on the y scale (`gpui-base`'s `y0`);
    /// without one, the bottom edge of the plot.
    pub y0: Prop<Option<f64>>,
    /// How its top edge connects its points: `"natural"` (the default, a
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
}

/// A series of a [`Plot`](super::Plot) drawn as the region between its
/// line and a baseline (`gpui-base`'s `Area`): its top edge goes through
/// one point per row with a value, placed by the plot's scales, the rows
/// without one skipped, as a [`Line`](super::Line)'s does, and it closes
/// down to `y0`. It fills with its `fill` (`fill-*` classes; inherited from
/// the plot as CSS inherits it), `currentColor` where none is set, over its
/// `background` part (a gradient, `bg-linear-*`, shown inside its shape;
/// `fill` is then `none` where none is set), and strokes its top edge with
/// its `stroke` (`stroke-*`, `strokeWidth`, `strokeDasharray`), none where
/// none is set. Its values and baseline count in the y scale's domain when
/// the plot has none; it has a hover dot when it or the plot styles one
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
        let series = Series::new(plot, props.data, props.x, props.y1);
        series.join(plot, move || y0.get(), hover_dot);
        series
    });
    let base = move |plot: PlotContext| match y0.get() {
        Some(v) => plot.y_map.get().tick(v).unwrap_or(0.0),
        None => plot.size.get().height.0,
    };
    // How far past the plot it draws: its curve's swing and its baseline.
    let bleed = move || {
        let (Some(plot), Some(series)) = (plot, series) else {
            return STROKE_ROOM;
        };
        let height = plot.size.get().height.0;
        let floor = base(plot);
        let swing = series.points.with(|ps| reach(ps, curve.get(), height));
        STROKE_ROOM + swing.max(-floor).max(floor - height).ceil()
    };
    // Its shape: the top edge, down to the baseline and back.
    let shape = move |p: Painter, plot: PlotContext, points: &[Point<Points>]| {
        let (first, last) = (points[0], points[points.len() - 1]);
        let base = base(plot);
        trace(
            p.begin_path().move_to(first.x, first.y),
            points,
            curve.get(),
        )
        .line_to(last.x, px(base))
        .line_to(first.x, px(base))
        .close_path()
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
                    let points = series.points.get();
                    if points.is_empty() {
                        return nothing(p);
                    }
                    let base = base(plot);
                    let (first, last) = (points[0], points[points.len() - 1]);
                    let (top, bottom) = points
                        .iter()
                        .fold((base, base), |(lo, hi), q| (lo.min(q.y.0), hi.max(q.y.0)));
                    let area = Bounds::new(
                        point(first.x, px(top)),
                        size(last.x - first.x, px(bottom - top)),
                    );
                    shape(plot.clip(p, bleed), plot, &points).fill_background_from_view(area)
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
            let p = p.fill_style_from_view(initial);
            let (Some(plot), Some(series)) = (plot, series) else {
                return p;
            };
            let points = series.points.get();
            let Some(first) = points.first() else {
                return p;
            };
            let p = shape(plot.clip(p, bleed), plot, &points)
                .fill()
                .stroke_style_from_view(SvgPaint::None)
                .line_width_from_view()
                .line_dash_from_view();
            trace(
                p.begin_path().move_to(first.x, first.y),
                &points,
                curve.get(),
            )
            .stroke()
        }))
}
