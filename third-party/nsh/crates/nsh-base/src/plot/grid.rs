//! `Grid`: lines across a plot at values of its scales.

use nsh_core::{SvgPaint, prelude::*};

use super::{Axis, PlotContext, STROKE_ROOM, ValueScale, axis::tick_values, layer, mark_canvas};

/// The props of [`Grid`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct GridProps {
    /// Where its vertical lines go, as values of the plot's x scale (row
    /// indices on a `point` scale; `gpui-base`'s `x`).
    pub x: Prop<Option<Vec<f64>>>,
    /// Where its horizontal lines go, as values of its y scale (`scale`;
    /// `gpui-base`'s `y`).
    pub y: Prop<Option<Vec<f64>>>,
    /// The y scale its horizontal lines' values are of: `"y"` (the
    /// default, the plot's `yScale`) or `"y2"` (its second one,
    /// `y2Scale`).
    #[prop(default)]
    pub scale: Prop<ValueScale>,
    /// About how many lines it draws without `x` or `y` (as a `PlotAxis`'s
    /// `ticks`); without, the lines of a `PlotAxis` with no `ticks`: d3's
    /// nice values, or every step of scales whose ticks are aligned
    /// (`alignTicks`).
    pub ticks: Prop<Option<u32>>,
}

/// Lines across a [`Plot`](super::Plot) (`gpui-base`'s `Grid`), vertical at the
/// values `x` of its x scale and horizontal at the values `y` of its y
/// scale (`scale`), from edge to edge, each on whole device pixels so a
/// thin line stays sharp. With neither `x` nor `y`, it follows the ticks of
/// the scale the values go along (the y scale it names; x for bars across),
/// where a [`PlotAxis`](super::PlotAxis) of that scale puts them: about
/// `ticks` of them, or the axis's default ones (the aligned step of a
/// dual-axis chart, so one grid serves both axes). It strokes with its
/// paint properties (`stroke-*`, `strokeWidth`, `strokeDasharray` for
/// dashes; inherited from the plot as CSS inherits them), `currentColor`
/// where none is set. Its values do not count in the scales' domains.
#[component]
pub fn Grid(props: GridProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let plot = PlotContext::of("Grid");
    let (x, y, scale, ticks) = (props.x, props.y, props.scale, props.ticks);
    layer().child(mark_canvas(
        plot,
        || STROKE_ROOM,
        move |p, _| {
            let p = p
                .stroke_style_from_view(SvgPaint::CurrentColor)
                .line_width_from_view()
                .line_dash_from_view()
                .begin_path();
            let Some(plot) = plot else { return p };
            let size = plot.size.get();
            let rows = plot.rows.with(|rows| rows.len());
            // Without values, the ticks along the values' axis.
            let (xs, ys) = match (x.get(), y.get()) {
                (None, None) => match plot.band_axis.get() {
                    Some(Axis::Y) => (
                        tick_values(&plot.x_map.get(), rows, ticks.get()).to_vec(),
                        Vec::new(),
                    ),
                    _ => (
                        Vec::new(),
                        tick_values(&plot.y_map_of(scale.get()), rows, ticks.get()).to_vec(),
                    ),
                },
                (x, y) => (x.unwrap_or_default(), y.unwrap_or_default()),
            };
            // A line on the middle of a device pixel row or column (a hairline
            // 1 pt wide on a 1x screen is one pixel, not two half ones).
            let ratio = pixel_ratio();
            let sharp = |v: f32| ((v * ratio).floor() + 0.5) / ratio;
            // Each line moves with its scale's domain, across the whole plot.
            let p = plot.traced(p, true, None, |mut p| {
                let x_map = plot.x_map.get();
                for v in xs {
                    if let Some(at) = x_map.tick(v) {
                        let at = sharp(at);
                        p = p.move_to(at, 0.0).line_to(at, size.height.0);
                    }
                }
                p
            });
            plot.traced(p, false, Some(scale.get()), |mut p| {
                let y_map = plot.y_map_of(scale.get());
                for v in ys {
                    if let Some(at) = y_map.tick(v) {
                        let at = sharp(at);
                        p = p.move_to(0.0, at).line_to(size.width.0, at);
                    }
                }
                p
            })
            .stroke()
        },
    ))
}
