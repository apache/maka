//! `Line`: a series drawn as a line through its points.

use nsh_core::{
    SvgPaint,
    element::{RowAccessor, Rows, Style},
    prelude::*,
};

use super::{
    PlotContext, STROKE_ROOM, layer, mark_canvas, reach,
    series::{HoverDot, Series},
};

/// How a [`Line`] or an [`Area`](super::Area) connects its points
/// (`gpui-base`'s `Curve`, d3's curve factories).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum Curve {
    /// A smooth curve through every point (`gpui-base`'s default: cubic
    /// Bézier segments through the neighbours' tangents).
    #[default]
    Natural,
    /// Straight segments between points (`d3.curveLinear`).
    Linear,
    /// A step that holds each value until the next point
    /// (`d3.curveStepAfter`).
    StepAfter,
}

/// Records the path through `points` (already moved to the first one) as
/// `curve` connects them.
pub(super) fn trace(mut p: Painter, points: &[Point<Points>], curve: Curve) -> Painter {
    let n = points.len();
    match curve {
        Curve::Linear => {
            for q in &points[1..] {
                p = p.line_to(q.x, q.y);
            }
        }
        Curve::StepAfter => {
            for w in points.windows(2) {
                p = p.line_to(w[1].x, w[0].y).line_to(w[1].x, w[1].y);
            }
        }
        // Each segment a cubic through its neighbours' tangents, the end
        // points their own neighbours (`gpui-base`'s `Curve::Natural`).
        Curve::Natural => {
            for i in 0..n - 1 {
                let p0 = points[i.saturating_sub(1)];
                let (p1, p2) = (points[i], points[i + 1]);
                let p3 = points[(i + 2).min(n - 1)];
                let c1 = point(p1.x + (p2.x - p0.x) / 6.0, p1.y + (p2.y - p0.y) / 6.0);
                let c2 = point(p2.x - (p3.x - p1.x) / 6.0, p2.y - (p3.y - p1.y) / 6.0);
                p = p.bezier_curve_to(c1, c2, p2);
            }
        }
    }
    p
}

/// The props of [`Line`].
#[derive(Debug, Clone, PartialEq, Props)]
#[props(generic)]
pub struct LineProps {
    /// Rows of its own (`gpui-base`'s `data`), for a series whose rows are
    /// not the plot's (other x values); the plot's rows without.
    pub data: Prop<Option<Rows>>,
    /// What places its own rows along the plot's x axis (`gpui-base`'s
    /// `x`); a row's index without. The plot's `x` places the plot's rows.
    pub x: Prop<Option<RowAccessor>>,
    /// What it draws (`gpui-base`'s `y`): a field name, or a function of the
    /// row and its index; the plot's `y` without.
    pub y: Prop<Option<RowAccessor>>,
    /// How it connects its points: `"natural"` (the default, a smooth
    /// curve, as `gpui-base`'s), `"linear"` or `"stepAfter"`.
    #[prop(default)]
    pub curve: Prop<Curve>,
    /// A dot on every point (`gpui-base`'s `dot`): the `dot` part.
    #[prop(default)]
    pub dot: Prop<bool>,
    /// The Tailwind classes of its dots (`gpui-base`'s `dot_size`,
    /// `dot_fill`, `dot_stroke`): a view centered on each point, its size,
    /// background and border the app's.
    pub dot_class: Prop<Option<SharedString>>,
    /// The style of its dots, over `dotClass`.
    #[prop(default)]
    pub dot_style: Prop<Style>,
    /// The Tailwind classes of its hover dot, the `hoverDot` part: the
    /// dot the plot shows on its point at the row under the pointer
    /// (`TooltipState::dots`, which `gpui-component` fills with each
    /// series' color, as `gpui-base`'s `Line::dot_fill` / `dot_stroke`
    /// paint a line's own dots, `shape/line.rs:103-114`), its size,
    /// background and border the app's; the plot's `dotClass` where none
    /// is set. `hidden` shows none.
    pub hover_dot_class: Prop<Option<SharedString>>,
    /// The style of its hover dot, over `hoverDotClass`; the plot's
    /// `dotStyle` where none is set.
    #[prop(default)]
    pub hover_dot_style: Prop<Style>,
}

/// A series of a [`Plot`](super::Plot) drawn as a line through its points
/// (`gpui-base`'s `Line`): one point per row with a value, placed by the
/// plot's scales, the rows without one skipped (as `gpui-base` skips
/// them), a smooth curve unless `curve` says otherwise. It strokes with its
/// paint properties (`stroke-*` classes, `strokeWidth`, `strokeDasharray`;
/// inherited from the plot as CSS inherits them), `currentColor` where none
/// is set, and with `dot` shows a dot the app styles on every point. Its
/// values count in the y scale's domain when the plot has none, and it has
/// a hover dot when it or the plot styles one (`hoverDotClass`, the plot's
/// `dotClass`). It draws in with the plot's appear.
#[component]
pub fn Line(props: LineProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let plot = PlotContext::of("Line");
    let curve = props.curve;
    let hover_dot = HoverDot {
        class: props.hover_dot_class,
        style: props.hover_dot_style,
    };
    let series = plot.map(|plot| {
        let series = Series::new(plot, props.data, props.x, props.y);
        series.join(plot, || None, hover_dot);
        series
    });
    let (dot, dot_class, dot_style) = (props.dot, props.dot_class, props.dot_style);
    layer()
        .child(mark_canvas(
            plot,
            move || {
                let (Some(plot), Some(series)) = (plot, series) else {
                    return STROKE_ROOM;
                };
                let height = plot.size.get().height.0;
                STROKE_ROOM
                    + series
                        .points
                        .with(|ps| reach(ps, curve.get(), height))
                        .ceil()
            },
            move |p, bleed| {
                let p = p
                    .stroke_style_from_view(SvgPaint::CurrentColor)
                    .line_width_from_view()
                    .line_dash_from_view();
                let (Some(plot), Some(series)) = (plot, series) else {
                    return p;
                };
                let points = series.points.get();
                let Some(first) = points.first() else {
                    return p;
                };
                let p = plot.clip(p, bleed).begin_path().move_to(first.x, first.y);
                trace(p, &points, curve.get()).stroke()
            },
        ))
        .child(when(
            move || dot.get() && series.is_some(),
            move || {
                let points = series.expect("a series").points;
                each(
                    move || (0..points.get().len()).collect::<Vec<usize>>(),
                    |i| *i,
                    move |i, _| {
                        view()
                            .absolute()
                            .w(px(0.0))
                            .h(px(0.0))
                            .items_center()
                            .justify_center()
                            .pointer_events(PointerEvents::None)
                            .style_with(move |s| match points.get().get(i.get()) {
                                Some(p) => s.left(p.x).top(p.y),
                                None => s,
                            })
                            .child(
                                view()
                                    .flex_none()
                                    .app_class(dot_class)
                                    .inline_style(dot_style),
                            )
                    },
                )
            },
        ))
}
