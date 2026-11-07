//! `Rule`: a series drawn as a straight line per row along the value axis,
//! from a base to the row's value: a candle's wick, a box plot's whisker,
//! an error bar, a lollipop's stem.

use std::sync::Arc;

use nsh_core::{
    SvgPaint,
    canvas::{CanvasOp, Num, PathOp},
    element::{RowAccessor, RowText},
    prelude::*,
};

use super::{
    Axis, PlotContext, STROKE_ROOM, ValueScale,
    bar::{BarBase, grown, row_opacity},
    layer, mark_canvas,
    scale::extent,
    series::{self, Mark},
};

/// The props of [`Rule`].
#[derive(Debug, Clone, PartialEq, Props)]
#[props(generic)]
pub struct RuleProps {
    /// Where each line ends (Observable Plot's `y2`): a field name, or a
    /// function of the row and its index; the plot's `y` without. A row
    /// without a value has no line.
    pub value: Prop<Option<RowAccessor>>,
    /// Where each line starts (Observable Plot's `y1`), as [`Bar`]'s
    /// `base`: a value of the value scale, 0 by default (a lollipop's stem
    /// from the zero line); or a field name or a function of the row and
    /// its index, a start per row (a candle's low to its high), a row
    /// without one having no line. It counts in the scale's domain.
    ///
    /// [`Bar`]: super::Bar
    #[prop(default)]
    pub base: Prop<BarBase>,
    /// The y scale its values go along, as [`Bar`]'s `scale`: `"y"` (the
    /// default, the plot's `yScale`) or `"y2"` (its second one,
    /// `y2Scale`); lines across the plot put their values along x.
    ///
    /// [`Bar`]: super::Bar
    #[prop(default)]
    pub scale: Prop<ValueScale>,
    /// How its lines appear one after another (as `Bar`'s `stagger`, 0 to
    /// 0.95): the share of the plot's appear over which they start, row by
    /// row, each growing from its start for the rest of it; 0 (the
    /// default) grows them together.
    #[prop(default)]
    pub stagger: Prop<Percentage>,
    /// The opacity of its lines away from the row under the pointer, while
    /// the pointer is over the plot (as `Bar`'s): faded in and out with
    /// the hover and handed from row to row as it glides; none by default.
    pub inactive_opacity: Prop<Option<Percentage>>,
    /// The category of each line, which the plot's `colorScale` gives a
    /// color (as `Bar`'s `color`): a field name or a function of the row and
    /// its index. That color is the line's `stroke` where nothing sets one,
    /// in place of `currentColor`, so the app's `stroke-*` classes and
    /// `stroke` style win.
    pub color: Prop<Option<RowText>>,
}

/// A line as drawn: where its row is along the axis of the rows, and where
/// its two ends go along the value axis.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Stem {
    row: usize,
    at: f32,
    from: f32,
    to: f32,
}

/// A rule's lines, as drawn.
#[derive(Debug, Clone, PartialEq)]
struct Geometry {
    /// Lines across the plot (rows down the y axis).
    across: bool,
    /// The distance between two rows along their axis.
    step: f32,
    /// The rows the appear staggers over.
    rows: usize,
    stems: Vec<Stem>,
}

/// The smallest distance between two of `places` (`0` with fewer than
/// two).
fn spacing(places: &[f32]) -> f32 {
    let closest = places
        .windows(2)
        .map(|w| (w[1] - w[0]).abs())
        .filter(|d| d.is_finite() && *d > 0.0)
        .fold(f32::INFINITY, f32::min);
    match closest.is_finite() {
        true => closest,
        false => 0.0,
    }
}

/// A series of a [`Plot`](super::Plot) drawn as a straight line per row
/// along the value axis (Vega-Lite's and Observable Plot's rule mark), from
/// `base` to the row's value: in the middle of the row's band on a band
/// scale (`xScale={{ type: "band" }}`; across the plot on a band `yScale`),
/// at the row's place along the x axis otherwise. A candle is a [`Bar`]
/// from its open to its close over a rule from its low to its high; a box
/// plot's whiskers, error bars and lollipops' stems are rules. It strokes
/// with its `stroke` (`stroke-*` classes, `strokeWidth`,
/// `strokeDasharray`; inherited from the plot as CSS inherits it),
/// `currentColor` where none is set (with `color`, each line's category's
/// color of the plot's `colorScale` instead). Its values and base count in
/// the value scale's domain when the plot has none. With the plot's
/// appear, its lines grow out of their start (one after another with
/// `stagger`); while the pointer is over the plot, the lines of other rows
/// fade to `inactiveOpacity`; both on the platform's animator, with no
/// mark drawn again. It shows no hover dot.
///
/// [`Bar`]: super::Bar
#[component]
pub fn Rule(props: RuleProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let Some(plot) = PlotContext::of("Rule") else {
        return layer();
    };
    let (accessor, base, scale) = (props.value, props.base, props.scale);
    let rows = move || plot.rows.get();
    let values = series::values(rows, move || accessor.get().or_else(|| plot.y.get()));
    let bases = series::values(rows, move || base.with(BarBase::row));
    // Each row's start and end, `NaN` where it has either none.
    let spans = computed(move || -> Arc<[[f64; 2]]> {
        let (values, bases, base) = (values.get(), bases.get(), base.get());
        let Some(values) = values else {
            return Arc::from([]);
        };
        values
            .iter()
            .enumerate()
            .map(|(row, &v)| {
                let b = base.at(bases.as_deref(), row);
                match v.is_finite() && b.is_finite() {
                    true => [b, v],
                    false => [f64::NAN; 2],
                }
            })
            .collect()
    });
    // Along the axis without bands.
    let value_axis = computed(move || match plot.band_axis.get() {
        Some(Axis::Y) => Axis::X,
        _ => Axis::from(scale.get()),
    });
    plot.add(move |key| Mark {
        key,
        extent: computed(move || {
            let floor = base.with(BarBase::value);
            spans.with(|s| extent(s.iter().flat_map(|s| s.iter().copied()).chain(floor)))
        }),
        value_axis,
        points: computed(|| Arc::from([])),
        dot_x: animated_value(0.0),
        dot_y: animated_value(0.0),
        dot: None,
    });

    // Where its lines go.
    let geometry = computed(move || -> Option<Geometry> {
        if !plot.is_sized() {
            return None;
        }
        let (x_map, y_map) = (plot.x_map.get(), plot.y_map.get());
        let values_y = plot.y_map_of(scale.get());
        let len = plot.rows.with(|rows| rows.len());
        let (places, step, value_map, across): (Arc<[f32]>, f32, _, bool) =
            match (x_map.band(), y_map.band()) {
                (Some(band), _) => (
                    (0..len)
                        .map(|i| band.center(i).unwrap_or(f32::NAN))
                        .collect(),
                    band.step(),
                    values_y,
                    false,
                ),
                (None, Some(band)) => (
                    (0..len)
                        .map(|i| band.center(i).unwrap_or(f32::NAN))
                        .collect(),
                    band.step(),
                    x_map,
                    true,
                ),
                _ => {
                    let xs = plot.xs.get();
                    let step = spacing(&xs);
                    (xs, step, values_y, false)
                }
            };
        let stems = spans.with(|spans| {
            spans
                .iter()
                .enumerate()
                .filter_map(|(row, &[lo, hi])| {
                    let at = *places.get(row).filter(|at| at.is_finite())?;
                    Some(Stem {
                        row,
                        at,
                        from: value_map.tick(lo)?,
                        to: value_map.tick(hi)?,
                    })
                })
                .collect()
        });
        Some(Geometry {
            across,
            step,
            rows: len,
            stems,
        })
    });

    let (stagger, inactive) = (props.stagger, props.inactive_opacity);
    let colors = series::colors(plot, rows, props.color);
    layer().child(mark_canvas(
        Some(plot),
        || STROKE_ROOM,
        move |p, _| {
            let p = p.line_width_from_view().line_dash_from_view();
            let Some(g) = geometry.get() else { return p };
            let appearing = plot.appearing.get();
            let colors = colors.get();
            let mut p = match &colors {
                None => p.stroke_style_from_view(SvgPaint::CurrentColor),
                Some(_) => p,
            };
            for stem in &g.stems {
                if let Some(alpha) = row_opacity(plot, inactive.get(), g.across, stem.at, g.step) {
                    p = p.global_alpha(&alpha);
                }
                if let Some(colors) = &colors {
                    let color = colors.get(stem.row).copied().flatten();
                    p = p.stroke_style_from_view(series::paint_of(color, SvgPaint::CurrentColor));
                }
                // Growing from its start while the plot appears; through
                // the moving scales' transform while a domain moves.
                let end = match appearing {
                    true => {
                        let q = grown(plot, stem.row, g.rows, stagger.get());
                        let node = q.mul(stem.to - stem.from).add(stem.from);
                        p.num(&node)
                    }
                    false => Num::Const(stem.to),
                };
                let (at, from) = (Num::Const(stem.at), Num::Const(stem.from));
                p = plot
                    .traced(
                        p.begin_path(),
                        true,
                        (!g.across).then_some(scale.get()),
                        |p| match g.across {
                            true => p
                                .op(CanvasOp::Path(PathOp::MoveTo(from, at)))
                                .op(CanvasOp::Path(PathOp::LineTo(end, at))),
                            false => p
                                .op(CanvasOp::Path(PathOp::MoveTo(at, from)))
                                .op(CanvasOp::Path(PathOp::LineTo(at, end))),
                        },
                    )
                    .stroke();
            }
            p
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::spacing;

    /// The distance the hover's fade measures in: the closest two rows.
    #[test]
    fn rows_are_as_far_apart_as_the_closest_two() {
        assert_eq!(spacing(&[0.0, 10.0, 15.0, 40.0]), 5.0);
        assert_eq!(spacing(&[30.0, 20.0, f32::NAN, 0.0]), 10.0);
        assert_eq!(spacing(&[5.0]), 0.0);
        assert_eq!(spacing(&[]), 0.0);
    }
}
