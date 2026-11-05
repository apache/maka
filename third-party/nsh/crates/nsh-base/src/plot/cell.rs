//! `Cell`: a rectangle per row at its column's band along x and its line's
//! band along y, colored by the row's value: heatmaps, correlation
//! matrices, calendars of monthly returns.

use std::{rc::Rc, sync::Arc};

use nsh_core::{
    SvgPaint,
    canvas::{CanvasOp, Num, PathOp},
    element::{JsHost, JsIn, JsOwned, JsValue, PropError, RowAccessor, RowText, Style, TsTypes},
    prelude::*,
};

use super::{
    Axis, PlotContext, STROKE_ROOM,
    bar::{BarCornerRadii, grown},
    keys::Step,
    layer, mark_canvas,
    pie::{Pose, Update, Var},
    scale::Band,
    series,
};

/// The inline style of a [`Cell`]'s labels: a [`Style`] whose TypeScript
/// type takes text styles too (`StyleProp<TextStyle>`), since a label is a
/// text.
#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct CellLabelStyle(pub Style);

impl From<Style> for CellLabelStyle {
    fn from(style: Style) -> Self {
        Self(style)
    }
}

impl JsValue for CellLabelStyle {
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

/// The props of [`Cell`].
#[derive(Debug, Clone, PartialEq, Props)]
#[props(generic)]
pub struct CellProps {
    /// The column of each row (Observable Plot's cell `x`): a field name
    /// (its text, a number as JS writes it) or a function of the row and
    /// its index; the row's cell goes in the band of that category of the
    /// plot's x scale, which must be a `band` scale. A row without one has
    /// no cell.
    pub x: Prop<Option<RowText>>,
    /// The line of each row (Observable Plot's cell `y`), as `x` along the
    /// plot's y scale, a `band` scale too.
    pub y: Prop<Option<RowText>>,
    /// The number of each cell (Observable Plot's `fill` channel of
    /// numbers): a field name or a function of the row and its index, which
    /// the plot's `colorScale` makes the cell's color when it is a ramp
    /// (`sequential`, `diverging`); a row without one then has no cell (or
    /// the scale's `unknown` color). Not the plot's `y`: a cell's `y` is
    /// its line.
    pub value: Prop<Option<RowAccessor>>,
    /// The category of each cell, which the plot's `colorScale` gives a
    /// color when it is `ordinal` (as `Bar`'s `color`): a field name or a
    /// function of the row and its index.
    pub color: Prop<Option<RowText>>,
    /// The radius of each corner of its cells (as `Bar`'s `cornerRadii`):
    /// a number for all four, or the corners named; square by default.
    #[prop(default)]
    pub corner_radii: Prop<BarCornerRadii>,
    /// How its cells appear one after another (as `Bar`'s `stagger`, 0 to
    /// 0.95): the share of the plot's appear over which they start, row by
    /// row, each growing from its middle for the rest of it; 0 (the
    /// default) grows them together.
    #[prop(default)]
    pub stagger: Prop<Percentage>,
    /// The opacity of its other cells (and their labels) while the pointer
    /// (or the keys) is on one of them: faded in and out with the hover;
    /// none by default.
    pub inactive_opacity: Prop<Option<Percentage>>,
    /// The text in each cell, the `label` part: a field name (its number)
    /// or a function of the row returning the text (a return, a
    /// coefficient), centered in the cell, shown only where its laid-out
    /// size fits inside the cell.
    pub label: Prop<Option<RowText>>,
    /// The Tailwind classes of its labels: their size and color the app's.
    /// A label whose cell's color (of the plot's `colorScale`) is dark has
    /// the attribute `data-dark` (light text reads better on it), so
    /// `data-dark:text-white` turns it light there.
    pub label_class: Prop<Option<SharedString>>,
    /// The style of its labels, over `labelClass` (text styles too).
    #[prop(default)]
    pub label_style: Prop<CellLabelStyle>,
    /// The Tailwind classes of its hover cell, the `hoverCell` part: a view
    /// as big as the cell under the pointer (or the keys), over it, its
    /// corners, border and outline the app's (`rounded-sm outline-2
    /// outline-foreground`); none without a class or style.
    pub hover_cell_class: Prop<Option<SharedString>>,
    /// The style of its hover cell, over `hoverCellClass`.
    #[prop(default)]
    pub hover_cell_style: Prop<Style>,
}

/// A cell the plot knows: the categories it names along each axis (which
/// make the bands of a band scale without a domain) and its values (which
/// the ramps of the plot's `colorScale` spread over).
#[derive(Clone, Copy)]
pub(super) struct CellEntry {
    key: u64,
    x: Signal<Option<Arc<[SharedString]>>>,
    y: Signal<Option<Arc<[SharedString]>>>,
    pub(super) values: Signal<Option<Arc<[f64]>>>,
}

impl PartialEq for CellEntry {
    fn eq(&self, other: &Self) -> bool {
        self.key == other.key
    }
}

impl CellEntry {
    /// The categories its rows name along `axis` (`None` along the second
    /// y scale, which has no bands).
    pub(super) fn categories(&self, axis: Axis) -> Option<Signal<Option<Arc<[SharedString]>>>> {
        match axis {
            Axis::X => Some(self.x),
            Axis::Y => Some(self.y),
            Axis::Y2 => None,
        }
    }
}

/// A row's cell as the app sets it: its box as shares of the plot's width
/// and height (`x` is `NaN`: no cell), so a new size moves nothing and new
/// bands move the cells, and its color (`None`: the mark's own `fill`).
#[derive(Debug, Clone, Copy, PartialEq)]
struct Spot {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    color: Option<Hsla>,
}

impl Spot {
    const NONE: Spot = Spot {
        x: f32::NAN,
        y: f32::NAN,
        w: 0.0,
        h: 0.0,
        color: None,
    };

    fn shown(&self) -> bool {
        self.x.is_finite() && self.y.is_finite()
    }

    /// The same box shrunk to `t` of its size about its middle.
    fn scaled(self, t: f32) -> Spot {
        Spot {
            x: self.x + self.w * (1.0 - t) / 2.0,
            y: self.y + self.h * (1.0 - t) / 2.0,
            w: self.w * t,
            h: self.h * t,
            ..self
        }
    }
}

/// The cells as the app sets them, one per row: what the plot's
/// `motion.update` moves between.
#[derive(Debug, Clone, Default, PartialEq)]
struct CellPose(Arc<[Spot]>);

impl Pose for CellPose {
    fn lerp(&self, to: &Self, t: f32) -> Self {
        let len = self.0.len().max(to.0.len());
        let spots = (0..len).map(|i| {
            let a = self.0.get(i).copied().unwrap_or(Spot::NONE);
            let b = to.0.get(i).copied().unwrap_or(Spot::NONE);
            match (a.shown(), b.shown()) {
                (true, true) => {
                    let mix = |p: f32, q: f32| p + (q - p) * t;
                    Spot {
                        x: mix(a.x, b.x),
                        y: mix(a.y, b.y),
                        w: mix(a.w, b.w),
                        h: mix(a.h, b.h),
                        color: match (a.color, b.color) {
                            (Some(p), Some(q)) => Some(q.mix_oklab(p, t)),
                            (_, color) => color,
                        },
                    }
                }
                (false, true) => b.scaled(t),
                (true, false) => a.scaled(1.0 - t),
                (false, false) => Spot::NONE,
            }
        });
        CellPose(spots.collect())
    }
}

/// A cell as drawn at rest: its row and its box on the plot, in points.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Placed {
    row: usize,
    bounds: Bounds<Points>,
}

impl Placed {
    fn center(&self) -> Point<Points> {
        self.bounds.center()
    }
}

/// The span along an axis of `length` points of a band at `start` that
/// is `width` wide (shares of the axis), narrowed to `max` points in the
/// middle of its place.
fn span(start: f32, width: f32, length: f32, max: Option<f32>) -> (f32, f32) {
    let (at, w) = (start * length, width * length);
    match max {
        Some(max) if w > max => (at + (w - max) / 2.0, max),
        _ => (at, w),
    }
}

/// The boxes of the shown cells of `pose` on a plot of `size`, the bands
/// no wider than `max` points along each axis.
fn placed(pose: &CellPose, size: Size<Points>, max: (Option<f32>, Option<f32>)) -> Vec<Placed> {
    pose.0
        .iter()
        .enumerate()
        .filter(|(_, s)| s.shown())
        .map(|(row, s)| {
            let (x, w) = span(s.x, s.w, size.width.0, max.0);
            let (y, h) = span(s.y, s.h, size.height.0, max.1);
            Placed {
                row,
                bounds: Bounds::new(point(px(x), px(y)), size_of(w, h)),
            }
        })
        .collect()
}

fn size_of(w: f32, h: f32) -> Size<Points> {
    Size {
        width: px(w),
        height: px(h),
    }
}

/// The distance from `at` to `bounds` (0 inside).
fn distance(bounds: &Bounds<Points>, at: Point<Points>) -> f32 {
    let (o, s) = (bounds.origin, bounds.size);
    let dx = (o.x.0 - at.x.0).max(at.x.0 - (o.x.0 + s.width.0)).max(0.0);
    let dy = (o.y.0 - at.y.0).max(at.y.0 - (o.y.0 + s.height.0)).max(0.0);
    dx.hypot(dy)
}

/// The cell under `at`, or the nearest within `reach` of it (the gaps
/// between cells, so the hover stays on the grid as the pointer crosses
/// them).
fn cell_at(cells: &[Placed], at: Point<Points>, reach: f32) -> Option<u32> {
    cells
        .iter()
        .map(|c| (c, distance(&c.bounds, at)))
        .filter(|(_, d)| *d <= reach)
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(c, _)| c.row as u32)
}

/// The cell the keys step to from `from` across `cells` on the screen
/// (WAI-ARIA's data grid): the arrows to the nearest cell on their side
/// in the same line (Left, Right) or column (Up, Down), Home and End to the
/// first and last cell of the line; from none, the top left cell (the
/// bottom right one for Left, Up and End). At an edge the hover stays.
fn grid_step(cells: &[Placed], from: Option<u32>, step: Step) -> Option<u32> {
    let order = |a: &&Placed, b: &&Placed| {
        let (p, q) = (a.center(), b.center());
        p.y.0.total_cmp(&q.y.0).then(p.x.0.total_cmp(&q.x.0))
    };
    let Some(here) = from.and_then(|r| cells.iter().find(|c| c.row == r as usize)) else {
        let found = match step {
            Step::Previous | Step::Up | Step::Last => cells.iter().max_by(order),
            Step::Next | Step::Down | Step::First => cells.iter().min_by(order),
        };
        return found.map(|c| c.row as u32);
    };
    let c = here.center();
    let (half_w, half_h) = (
        here.bounds.size.width.0 / 2.0,
        here.bounds.size.height.0 / 2.0,
    );
    let in_line = |p: &Placed| (p.center().y.0 - c.y.0).abs() < half_h.max(0.5);
    let in_column = |p: &Placed| (p.center().x.0 - c.x.0).abs() < half_w.max(0.5);
    let x = |p: &&Placed| p.center().x.0;
    let y = |p: &&Placed| p.center().y.0;
    let line = cells.iter().filter(|p| in_line(p));
    let column = cells.iter().filter(|p| in_column(p));
    let found = match step {
        Step::Next => line
            .filter(|p| x(p) > c.x.0)
            .min_by(|a, b| x(a).total_cmp(&x(b))),
        Step::Previous => line
            .filter(|p| x(p) < c.x.0)
            .max_by(|a, b| x(a).total_cmp(&x(b))),
        Step::Down => column
            .filter(|p| y(p) > c.y.0)
            .min_by(|a, b| y(a).total_cmp(&y(b))),
        Step::Up => column
            .filter(|p| y(p) < c.y.0)
            .max_by(|a, b| y(a).total_cmp(&y(b))),
        Step::First => line.min_by(|a, b| x(a).total_cmp(&x(b))),
        Step::Last => line.max_by(|a, b| x(a).total_cmp(&x(b))),
    };
    Some(found.unwrap_or(here).row as u32)
}

/// The index of each of `texts` among `categories` (`None`: none, or not
/// one of them).
fn indices(texts: &[SharedString], categories: &[SharedString]) -> Vec<Option<usize>> {
    texts
        .iter()
        .map(|t| match t.is_empty() {
            true => None,
            false => categories.iter().position(|c| c == t),
        })
        .collect()
}

/// A series of a [`Plot`](super::Plot) drawn as a rectangle per row
/// (Observable Plot's `cell`, Vega-Lite's `rect` over two band scales): in
/// the band of its `x` category along the plot's x scale and of its `y`
/// category along its y scale, both `band` scales (the cells name their
/// bands where a scale has no `domain`; it has no second y scale), filling
/// the two bands, so the scales' `paddingInner` and `paddingOuter` are the
/// gaps between and around the cells. Its color is its row's of the plot's
/// `colorScale`: of its `value` along a ramp (`sequential`, `diverging`),
/// of its `color` category (`ordinal`), or its `fill` (`fill-*` classes;
/// inherited from the plot as CSS inherits it) where the app sets one,
/// `currentColor` where nothing does. Its corners are `cornerRadii`. Its
/// `label` writes a text in each cell, light on dark cells with
/// `data-dark:` classes, shown where it fits. The pointer finds the cell
/// under it (or the nearest across a gap), which the plot reports
/// (`onHoverChange`) and marks with the `hoverCell` part; the keys step
/// across the grid (the arrows, Home and End) and screen readers through
/// the rows in order. With the plot's appear, its cells grow from their
/// middles (one after another with `stagger`); with `motion.update`, a
/// cell's color glides to its new one, new rows' cells grow in, those of
/// rows that are gone shrink away, and cells move to new bands; while one
/// is hovered, the others fade to `inactiveOpacity`; all on the platform's
/// animator, with no mark drawn again.
#[component]
pub fn Cell(props: CellProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let Some(plot) = PlotContext::of("Cell") else {
        return layer();
    };
    let (x_text, y_text, value) = (props.x, props.y, props.value);
    let rows = move || plot.rows.get();
    let xs = series::texts(rows, move || x_text.get());
    let ys = series::texts(rows, move || y_text.get());
    let values = series::values(rows, move || value.get());
    // The plot's bands are made of the cells' categories.
    let key = plot.next.get();
    plot.next.replace(key + 1);
    plot.cells.update(|all| {
        all.push(CellEntry {
            key,
            x: xs,
            y: ys,
            values,
        })
    });
    let cells = plot.cells;
    cleanup(move || {
        if let Some(mut all) = cells.try_get() {
            all.retain(|c| c.key != key);
            cells.try_set(all);
        }
    });

    // Each row's color: its category's of an ordinal scale, or its value's
    // of a ramp (`None` with a ramp: no cell).
    let categories = series::colors(plot, rows, props.color);
    let ramp = computed(move || {
        plot.color_scale
            .with(|s| s.as_ref().is_some_and(|s| s.ordinal().is_none()))
    });
    let shades = computed(move || values.with(|v| plot.shades(v.as_deref()?)));

    let update = Update::new(plot, move || {
        let (Some(xb), Some(yb)) = (plot.x_map.get().band(), plot.y_map.get().band()) else {
            return CellPose::default();
        };
        let (xb, yb) = (xb.unit(), yb.unit());
        let (Some(x_of), Some(y_of)) = (
            xs.with(|xs| {
                let c = plot.x_categories.get()?;
                Some(indices(xs.as_deref()?, &c))
            }),
            ys.with(|ys| {
                let c = plot.y_categories.get()?;
                Some(indices(ys.as_deref()?, &c))
            }),
        ) else {
            return CellPose::default();
        };
        let ramp = ramp.get();
        // A ramp waits for the values.
        if ramp && values.with(Option::is_none) {
            return CellPose::default();
        }
        let (categories, shades) = (categories.get(), shades.get());
        let len = x_of.len().min(y_of.len());
        let place = |band: &Band, i: Option<usize>| band.start(i?).map(|s| (s, band.width()));
        let spots = (0..len).map(|row| {
            let (Some((x, w)), Some((y, h))) = (place(&xb, x_of[row]), place(&yb, y_of[row]))
            else {
                return Spot::NONE;
            };
            let category = categories
                .as_ref()
                .and_then(|c| c.get(row).copied().flatten());
            let shade = shades.as_ref().and_then(|c| c.get(row).copied().flatten());
            let color = category.or(shade);
            if ramp && color.is_none() {
                return Spot::NONE;
            }
            Spot { x, y, w, h, color }
        });
        CellPose(spots.collect())
    });
    let max_widths = move || {
        let max = |b: Option<Band>| b.and_then(|b| b.max_width());
        (max(plot.x_map.get().band()), max(plot.y_map.get().band()))
    };
    // Where the cells are at rest: what the pointer finds, where the hover
    // cell and the labels go.
    let rest = computed(move || -> Arc<[Placed]> {
        if !plot.is_sized() {
            return Arc::from([]);
        }
        let (to, _) = update.shown();
        placed(&to, plot.size.get(), max_widths()).into()
    });
    // The gap between neighbouring cells, which the pointer crosses
    // without leaving the grid.
    let reach = move || {
        let gap = |b: Option<Band>| b.map_or(0.0, |b| (b.step() - b.width()).max(0.0));
        gap(plot.x_map.get_untracked().band()).max(gap(plot.y_map.get_untracked().band())) + 1.0
    };
    plot.add_hit_with(
        move |at| rest.with_untracked(|cells| cell_at(cells, at, reach())),
        move |row| {
            rest.with_untracked(|cells| {
                cells
                    .iter()
                    .find(|c| c.row == row as usize)
                    .map(Placed::center)
            })
        },
        Some(Rc::new(move |from, step| {
            rest.with_untracked(|cells| grid_step(cells, from, step))
        })),
    );

    // The hovered row, on the animator, which the others fade away from
    // (set at once: the rows' order is no path to glide along).
    let hovered_at = animated_value(-2.0);
    effect(move || {
        if let Some(row) = plot.hovered.get() {
            hovered_at.set(row as f32);
        }
    });
    let (stagger, inactive) = (props.stagger, props.inactive_opacity);
    // How much row `row` is shown: grown in while the plot appears, faded
    // away from the hovered row.
    let dim = move || {
        inactive
            .get()
            .map(|o| 1.0 - o.0.clamp(0.0, 1.0))
            .filter(|d| *d > 0.0 && plot.interactive.get())
    };
    let away = move |row: usize, dim: f32| {
        let c = row as f32;
        let away = hovered_at.interpolate(&[c - 1.0, c, c + 1.0], &[dim, 0.0, dim]);
        away.mul(&plot.fade).mul(-1.0).add(1.0)
    };

    let radii = props.corner_radii;
    let canvas = mark_canvas(
        Some(plot),
        || STROKE_ROOM,
        move |p, _| {
            let mut p = p
                .stroke_style_from_view(SvgPaint::None)
                .line_width_from_view()
                .line_dash_from_view();
            let (to, from) = update.shown();
            let size = plot.size.get();
            let max = max_widths();
            let len = to.0.len().max(from.as_ref().map_or(0, |(f, _)| f.0.len()));
            let appearing = plot.appearing.get();
            let dim = dim();
            let corners = radii.get().corners().map(|r| Num::Const(r.0));
            let square = corners.iter().all(|r| *r == Num::Const(0.0));
            let bounds = |s: &Spot| {
                let (x, w) = span(s.x, s.w, size.width.0, max.0);
                let (y, h) = span(s.y, s.h, size.height.0, max.1);
                [x, y, w, h]
            };
            for row in 0..len {
                let target = to.0.get(row).copied().filter(Spot::shown);
                // The box, moving from where the move started (a new cell
                // from nothing at its middle, one that is gone to nothing
                // at its own), and its colors.
                let (rect, under) = match &from {
                    None => {
                        let Some(t) = target else { continue };
                        (bounds(&t).map(Var::Const), None)
                    }
                    Some((from, q)) => {
                        let source = from.0.get(row).copied().filter(Spot::shown);
                        let (a, b) = match (source, target) {
                            (Some(a), Some(b)) => (a, b),
                            (None, Some(b)) => (b.scaled(0.0), b),
                            (Some(a), None) => (a, a.scaled(0.0)),
                            (None, None) => continue,
                        };
                        let q = Var::Node(*q);
                        let (ra, rb) = (bounds(&a), bounds(&b));
                        let rect = std::array::from_fn(|i| {
                            Var::Const(rb[i] - ra[i]).mul(&q).add(&Var::Const(ra[i]))
                        });
                        let under = (source.is_some() && target.is_some() && a.color != b.color)
                            .then_some((a.color, q));
                        (rect, under)
                    }
                };
                let color =
                    target.or_else(|| from.as_ref().and_then(|(f, _)| f.0.get(row).copied()));
                let color = color.and_then(|s| s.color);
                let rect = match appearing {
                    true => {
                        let g = Var::Node(grown(plot, row, len, stagger.get()));
                        let [x, y, w, h] = rect;
                        let left = g.mul(&Var::Const(-0.5)).add(&Var::Const(0.5));
                        [
                            x.add(&w.mul(&left)),
                            y.add(&h.mul(&left)),
                            w.mul(&g),
                            h.mul(&g),
                        ]
                    }
                    false => rect,
                };
                let alpha = dim.map(|d| away(row, d));
                let rect = rect.map(|v| p.num(&v));
                let path = move |p: Painter| {
                    p.begin_path().op(CanvasOp::Path(match square {
                        true => PathOp::Rect(rect),
                        false => PathOp::RoundRect(rect, corners),
                    }))
                };
                let paint = |c: Option<Hsla>| series::paint_of(c, SvgPaint::CurrentColor);
                let over = match under {
                    Some((old, q)) => {
                        p = match &alpha {
                            Some(a) => p.global_alpha(a),
                            None => p.global_alpha(1.0),
                        };
                        p = path(p.fill_style_from_view(paint(old))).fill();
                        Some(q)
                    }
                    None => None,
                };
                let shown = match (&alpha, over) {
                    (Some(a), Some(q)) => Some(Var::Node(*a).mul(&q)),
                    (Some(a), None) => Some(Var::Node(*a)),
                    (None, Some(q)) => Some(q),
                    (None, None) => None,
                };
                p = match &shown {
                    Some(a) => p.global_alpha(a),
                    None => p.global_alpha(1.0),
                };
                p = path(p.fill_style_from_view(paint(color))).fill().stroke();
            }
            p
        },
    );

    let (label, label_class, label_style) = (props.label, props.label_class, props.label_style);
    let hover = HoverCell {
        class: props.hover_cell_class,
        style: props.hover_cell_style,
    };
    layer()
        .child(canvas)
        // The label part: a text in each cell.
        .child(when(
            move || label.with(Option::is_some),
            move || {
                let texts = series::texts(rows, move || label.get());
                let shown =
                    move || rest.with(|cells| cells.iter().map(|c| c.row).collect::<Vec<_>>());
                each(
                    shown,
                    |row| *row,
                    move |row, _| {
                        let row = row.get_untracked();
                        let len = untracked(|| plot.rows.with(|r| r.len()));
                        let opacity = {
                            let g = grown(plot, row, len, stagger.get_untracked());
                            match dim() {
                                Some(d) => g.mul(&away(row, d)),
                                None => g,
                            }
                        };
                        cell_label(CellLabel {
                            bounds: move || {
                                rest.with(|cells| {
                                    cells.iter().find(|c| c.row == row).map(|c| c.bounds)
                                })
                            },
                            dark: move || {
                                update
                                    .shown()
                                    .0
                                    .0
                                    .get(row)
                                    .and_then(|s| s.color)
                                    .is_some_and(is_dark)
                            },
                            text: move || {
                                texts.with(|t| {
                                    t.as_ref()
                                        .and_then(|t| t.get(row).cloned())
                                        .unwrap_or_default()
                                })
                            },
                            opacity,
                            class: label_class,
                            style: label_style,
                        })
                    },
                )
            },
        ))
        .child(hover_cell_view(plot, rest, hover))
}

/// `color` is dark: light text reads better on it.
pub(super) fn is_dark(color: Hsla) -> bool {
    oklab_lightness(color) < 0.65
}

/// The OKLab lightness of `color` (Björn Ottosson's matrices), 0 to 1.
fn oklab_lightness(color: Hsla) -> f32 {
    let rgb = color.to_rgb();
    let linear = |c: f32| match c <= 0.04045 {
        true => c / 12.92,
        false => ((c + 0.055) / 1.055).powf(2.4),
    };
    let (r, g, b) = (linear(rgb.r), linear(rgb.g), linear(rgb.b));
    let l = (0.412_221_46 * r + 0.536_332_55 * g + 0.051_445_995 * b).cbrt();
    let m = (0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b).cbrt();
    let s = (0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b).cbrt();
    0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s
}

/// A cell's own part of the hover (`hoverCellClass` / `hoverCellStyle`).
#[derive(Clone, Copy)]
struct HoverCell {
    class: Prop<Option<SharedString>>,
    style: Prop<Style>,
}

impl HoverCell {
    fn is_set(&self) -> bool {
        self.class.with(Option::is_some) || self.style.with(|s| *s != Style::default())
    }
}

/// What a cell's label needs.
struct CellLabel<B, D, T> {
    bounds: B,
    dark: D,
    text: T,
    opacity: AnimatedNode,
    class: Prop<Option<SharedString>>,
    style: Prop<CellLabelStyle>,
}

/// The label of a cell: its box, the text centered in it at its own size,
/// shown while that size fits inside the box, with `data-dark` on a dark
/// cell; it fades with the cell's growth and the hover's dimming, and takes
/// no pointer.
fn cell_label(
    label: CellLabel<
        impl Fn() -> Option<Bounds<Points>> + Copy + 'static,
        impl Fn() -> bool + 'static,
        impl Fn() -> SharedString + 'static,
    >,
) -> View {
    let CellLabel {
        bounds,
        dark,
        text: content,
        opacity,
        class,
        style,
    } = label;
    let measured = signal(Size::<Points>::default());
    let fits = computed(move || {
        let (Some(b), m) = (bounds(), measured.get()) else {
            return false;
        };
        m.width.0 > 0.0 && m.width.0 <= b.size.width.0 && m.height.0 <= b.size.height.0
    });
    // A point with no size at the cell's middle: the text keeps its own
    // size on one line around it (a box as big as the cell would wrap it
    // to fit), and that size is what must fit in the cell.
    view()
        .absolute()
        .w(px(0.0))
        .h(px(0.0))
        .flex_row()
        .items_center()
        .justify_center()
        .pointer_events(PointerEvents::None)
        .bind_opacity(&opacity)
        .style_with(move |s| match bounds() {
            Some(b) => {
                let c = b.center();
                s.left(c.x).top(c.y)
            }
            None => s.hidden(),
        })
        .child(
            text(content)
                .flex_none()
                .on_layout(move |b: &Bounds<Points>| {
                    if measured.get_untracked() != b.size {
                        measured.set(b.size);
                    }
                })
                .project_data("dark", dark)
                .app_class(class)
                .inline_style(move || style.get().0)
                .style_with(move |s| match fits.get() {
                    true => s,
                    false => s.opacity(0.0),
                }),
        )
}

/// The hover cell: as big as the hovered row's cell and over it, taking
/// the first row at once, gliding to the next on the plot's pointer
/// spring when the keys step there and moving with the pointer in the
/// same frame, faded with the hover; none unless the app styles it.
fn hover_cell_view(
    plot: PlotContext,
    rest: Memo<Arc<[Placed]>>,
    own: HoverCell,
) -> impl IntoElement {
    let (x, y) = (animated_value(0.0), animated_value(0.0));
    let cell_size = signal(Size::<Points>::default());
    // Shown while the hovered row is one of this mark's cells.
    let mine = animated_value(0.0);
    let on = stored(None::<u32>);
    effect(move || {
        let hovered = plot.hovered.get();
        let found = hovered.and_then(|row| {
            rest.with(|cells| cells.iter().find(|c| c.row == row as usize).copied())
        });
        let Some(cell) = found else {
            if hovered.is_some() {
                mine.set(0.0);
            }
            on.replace(None);
            return;
        };
        mine.set(1.0);
        let was = on.get();
        on.replace(hovered);
        let glide = was.is_some() && was != hovered && plot.keyed.get() && !reduce_motion();
        let spring = untracked(|| plot.motion.get().and_then(|m| m.pointer));
        let (cx, cy) = (cell.bounds.origin.x.0, cell.bounds.origin.y.0);
        match spring.filter(|_| glide) {
            Some(spring) => {
                drop(x.spring(cx, spring));
                drop(y.spring(cy, spring));
            }
            None => {
                x.set(cx);
                y.set(cy);
            }
        }
        if cell_size.get_untracked() != cell.bounds.size {
            cell_size.set(cell.bounds.size);
        }
    });
    when(
        move || plot.interactive.get() && own.is_set(),
        move || {
            view()
                .absolute()
                .left(px(0.0))
                .top(px(0.0))
                .pointer_events(PointerEvents::None)
                .bind_translate_x(&x)
                .bind_translate_y(&y)
                .bind_opacity(&plot.fade.mul(&mine))
                .style_with(move |s| {
                    let size = cell_size.get();
                    s.w(size.width).h(size.height)
                })
                .child(view().flex_1().app_class(own.class).inline_style(own.style))
        },
    )
}

#[cfg(test)]
mod tests {
    use nsh_core::geometry::{point, px};

    use super::*;

    fn cell(row: usize, x: f32, y: f32) -> Placed {
        Placed {
            row,
            bounds: Bounds::new(point(px(x), px(y)), size_of(10.0, 10.0)),
        }
    }

    /// A grid of 3 columns by 2 lines, rows in reading order.
    fn grid() -> Vec<Placed> {
        (0..6)
            .map(|i| cell(i, (i % 3) as f32 * 12.0, (i / 3) as f32 * 12.0))
            .collect()
    }

    /// The pointer finds the cell under it, and across a gap the nearest
    /// one, within the reach.
    #[test]
    fn the_pointer_finds_the_cell_under_it() {
        let cells = grid();
        let at = |x: f32, y: f32| point(px(x), px(y));
        assert_eq!(cell_at(&cells, at(5.0, 5.0), 3.0), Some(0));
        assert_eq!(cell_at(&cells, at(29.0, 17.0), 3.0), Some(5));
        // In the gap, nearer the second column.
        assert_eq!(cell_at(&cells, at(11.5, 5.0), 3.0), Some(1));
        // Past the grid, out of reach.
        assert_eq!(cell_at(&cells, at(60.0, 5.0), 3.0), None);
    }

    /// The keys step across the grid on the screen and stay at its edges;
    /// the first key starts at a corner.
    #[test]
    fn the_keys_step_across_the_grid() {
        let cells = grid();
        let go = |from, step| grid_step(&cells, from, step);
        assert_eq!(go(None, Step::Next), Some(0));
        assert_eq!(go(None, Step::Up), Some(5));
        assert_eq!(go(Some(0), Step::Next), Some(1));
        assert_eq!(go(Some(1), Step::Down), Some(4));
        assert_eq!(go(Some(4), Step::Up), Some(1));
        assert_eq!(go(Some(4), Step::Previous), Some(3));
        assert_eq!(go(Some(3), Step::Previous), Some(3));
        assert_eq!(go(Some(5), Step::Down), Some(5));
        assert_eq!(go(Some(4), Step::First), Some(3));
        assert_eq!(go(Some(3), Step::Last), Some(5));
        assert_eq!(grid_step(&[], None, Step::Next), None);
    }

    /// Between two poses, a cell in both moves and mixes its color, a new
    /// one grows from its middle and one that is gone shrinks to it.
    #[test]
    fn poses_move_grow_and_shrink_cells() {
        let [red, green] = [0xff0000ff_u32, 0x00ff00ff].map(|c| Hsla::from(nsh_core::Color(c)));
        let spot = |x: f32, color| Spot {
            x,
            y: 0.0,
            w: 0.2,
            h: 0.2,
            color: Some(color),
        };
        let a = CellPose([spot(0.0, red), spot(0.5, red)].into());
        let b = CellPose([spot(0.4, green), Spot::NONE, spot(0.8, green)].into());
        let mid = a.lerp(&b, 0.5);
        assert!((mid.0[0].x - 0.2).abs() < 1e-6);
        assert_eq!(mid.0[0].color, Some(green.mix_oklab(red, 0.5)));
        assert!((mid.0[1].w - 0.1).abs() < 1e-6);
        assert!((mid.0[1].x - 0.55).abs() < 1e-6);
        assert!((mid.0[2].w - 0.1).abs() < 1e-6);
        assert_eq!(a.lerp(&b, 1.0).0[2], spot(0.8, green));
    }

    /// Dark cells take light text: saturated mid tones and deep colors are
    /// dark, pale ones and bright greens and yellows are not.
    #[test]
    fn dark_cells_are_told_apart_by_their_lightness() {
        let of = |c: u32| is_dark(Hsla::from(nsh_core::Color(c)));
        // Tailwind's red-500, blue-500, green-700; #990000.
        for c in [0xef4444ff, 0x3b82f6ff, 0x15803dff, 0x990000ff, 0x000000ff] {
            assert!(of(c), "{c:08x}");
        }
        // green-400, amber-300, red-200, white.
        for c in [0x4ade80ff, 0xfcd34dff, 0xfecacaff, 0xffffffff] {
            assert!(!of(c), "{c:08x}");
        }
        assert!((oklab_lightness(Hsla::from(nsh_core::Color(0xffffffff))) - 1.0).abs() < 1e-3);
    }

    /// A band narrowed to its widest stays in the middle of its place.
    #[test]
    fn a_narrowed_band_keeps_its_middle() {
        assert_eq!(span(0.25, 0.5, 100.0, None), (25.0, 50.0));
        assert_eq!(span(0.25, 0.5, 100.0, Some(20.0)), (40.0, 20.0));
    }
}
