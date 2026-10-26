//! `Grid`: lines across a plot at values of its scales.

use nsh_core::{SvgPaint, prelude::*};

use super::{PlotContext, STROKE_ROOM, layer, mark_canvas};

/// The props of [`Grid`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct GridProps {
    /// Where its vertical lines go, as values of the plot's x scale (row
    /// indices on a `point` scale; `gpui-base`'s `x`).
    #[prop(default)]
    pub x: Prop<Vec<f64>>,
    /// Where its horizontal lines go, as values of the plot's y scale
    /// (`gpui-base`'s `y`).
    #[prop(default)]
    pub y: Prop<Vec<f64>>,
}

/// Lines across a [`Plot`](super::Plot) (`gpui-base`'s `Grid`), vertical at the
/// values `x` of its x scale and horizontal at the values `y` of its y
/// scale, from edge to edge, each on whole device pixels so a thin line
/// stays sharp. It strokes with its paint properties (`stroke-*`,
/// `strokeWidth`, `strokeDasharray` for dashes; inherited from the plot as
/// CSS inherits them), `currentColor` where none is set. Its values do
/// not count in the scales' domains.
#[component]
pub fn Grid(props: GridProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let plot = PlotContext::of("Grid");
    let (x, y) = (props.x, props.y);
    layer().child(mark_canvas(
        plot,
        || STROKE_ROOM,
        move |p, _| {
            let mut p = p
                .stroke_style_from_view(SvgPaint::CurrentColor)
                .line_width_from_view()
                .line_dash_from_view()
                .begin_path();
            let Some(plot) = plot else { return p };
            let size = plot.size.get();
            // A line on the middle of a device pixel row or column (a hairline
            // 1 pt wide on a 1x screen is one pixel, not two half ones).
            let ratio = pixel_ratio();
            let sharp = |v: f32| ((v * ratio).floor() + 0.5) / ratio;
            let x_map = plot.x_map.get();
            for v in x.get() {
                if let Some(at) = x_map.tick(v) {
                    let at = sharp(at);
                    p = p.move_to(at, 0.0).line_to(at, size.height.0);
                }
            }
            let y_map = plot.y_map.get();
            for v in y.get() {
                if let Some(at) = y_map.tick(v) {
                    let at = sharp(at);
                    p = p.move_to(0.0, at).line_to(size.width.0, at);
                }
            }
            p.stroke()
        },
    ))
}
