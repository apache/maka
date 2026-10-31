//! A mark's series: its rows (its own or the plot's), the values it reads
//! of them (a field, or the app's function, called when they change), where
//! each row lands, and what it adds to the plot (its extent in the y
//! domain, its hover dot and how the app styles it).

use std::sync::Arc;

use nsh_core::{
    SvgPaint,
    element::{RowAccessor, RowText, Rows, Style},
    prelude::*,
};

use super::{Axis, PlotContext, scale::extent};

/// A mark the plot knows: the extent of its values and the axis they go
/// along, its points, where its hover dot is and the app's classes and
/// style of it (`hoverDotClass` / `hoverDotStyle`; the plot's `dotClass` /
/// `dotStyle` where it sets none; bars have none).
#[derive(Clone, Copy)]
pub(super) struct Mark {
    pub(super) key: u64,
    pub(super) extent: Memo<Option<[f64; 2]>>,
    pub(super) value_axis: Memo<Axis>,
    pub(super) points: Memo<Arc<[Point<Points>]>>,
    pub(super) dot_x: AnimatedValue,
    pub(super) dot_y: AnimatedValue,
    pub(super) dot: Option<HoverDot>,
}

/// A mark's own part of the hover's dots (`hoverDotClass` /
/// `hoverDotStyle`).
#[derive(Clone, Copy)]
pub(super) struct HoverDot {
    pub(super) class: Prop<Option<SharedString>>,
    pub(super) style: Prop<Style>,
}

impl HoverDot {
    /// The mark styles its hover dot.
    pub(super) fn is_set(&self) -> bool {
        self.class.with(Option::is_some) || self.style.with(|s| *s != Style::default())
    }
}

impl PartialEq for Mark {
    fn eq(&self, other: &Self) -> bool {
        self.key == other.key
    }
}

impl Mark {
    /// Its point nearest to `x` along the x axis (`TooltipState::dots`: one
    /// per series at the hovered row; a series of rows of its own takes
    /// its row nearest to the plot's).
    pub(super) fn near(&self, x: f32) -> Option<Point<Points>> {
        self.points.try_get().and_then(|points| {
            points
                .iter()
                .copied()
                .min_by(|a, b| (a.x.0 - x).abs().total_cmp(&(b.x.0 - x).abs()))
        })
    }
}

/// The values `accessor` reads of `rows`, once known: at once for a field
/// or a Rust function, in the next JS turn for the app's function (called
/// once per row whenever the rows or the function change, never while
/// the mark draws or the pointer moves).
pub(super) fn values(
    rows: impl Fn() -> Rows + 'static,
    accessor: impl Fn() -> Option<RowAccessor> + 'static,
) -> Signal<Option<Arc<[f64]>>> {
    let out = signal(None::<Arc<[f64]>>);
    // A newer run wins over the answers of an older one.
    let generation = stored(0u64);
    effect(move || {
        let (rows, accessor) = (rows(), accessor());
        let run = generation.get() + 1;
        generation.replace(run);
        let Some(accessor) = accessor else {
            out.set(None);
            return;
        };
        match accessor.values_now(&rows) {
            Some(values) => out.set(Some(values)),
            None => {
                spawn(async move {
                    let values = accessor.values(&rows).await;
                    if generation.get() == run {
                        out.set(Some(values));
                    }
                });
            }
        }
    });
    out
}

/// The texts `text` reads of `rows`, once known (as [`values`]).
pub(super) fn texts(
    rows: impl Fn() -> Rows + 'static,
    text: impl Fn() -> Option<RowText> + 'static,
) -> Signal<Option<Arc<[SharedString]>>> {
    let out = signal(None::<Arc<[SharedString]>>);
    // A newer run wins over the answers of an older one.
    let generation = stored(0u64);
    effect(move || {
        let (rows, text) = (rows(), text());
        let run = generation.get() + 1;
        generation.replace(run);
        let Some(text) = text else {
            out.set(None);
            return;
        };
        match text.texts_now(&rows) {
            Some(texts) => out.set(Some(texts)),
            None => {
                spawn(async move {
                    let texts = text.texts(&rows).await;
                    if generation.get() == run {
                        out.set(Some(texts));
                    }
                });
            }
        }
    });
    out
}

/// The color of each of `rows` (`None`: none of the plot's) that the
/// plot's `colorScale` gives the category `color` reads of it, once known
/// (as [`values`]); `None` without a `color` or a scale.
pub(super) fn colors(
    plot: PlotContext,
    rows: impl Fn() -> Rows + 'static,
    color: Prop<Option<RowText>>,
) -> Memo<Option<Arc<[Option<Hsla>]>>> {
    let categories = texts(rows, move || color.get());
    computed(move || categories.with(|c| plot.colors(c.as_deref()?)))
}

/// The color of a series of rows' [`colors`]: its first row's that has
/// one.
pub(super) fn first_color(colors: Memo<Option<Arc<[Option<Hsla>]>>>) -> Option<Hsla> {
    colors.with(|c| c.as_ref()?.iter().find_map(|c| *c))
}

/// The paint of a mark's shape where nothing sets one: `color`, the one
/// its category takes, in place of `currentColor`; `initial` otherwise.
pub(super) fn paint_of(color: Option<Hsla>, initial: SvgPaint) -> SvgPaint {
    match color {
        Some(color) if matches!(initial, SvgPaint::CurrentColor) => SvgPaint::Color(color.into()),
        _ => initial,
    }
}

/// What a mark of `plot` draws: its points, in the plot's space, the rows
/// without a value skipped (as `gpui-base`'s shapes skip them), and for a
/// band (an [`Area`](super::Area) whose `y0` reads the rows, d3's
/// `area().y0(accessor)`) the points of its bottom edge, one under each.
#[derive(Clone, Copy)]
pub(super) struct Series {
    pub(super) points: Memo<Arc<[Point<Points>]>>,
    /// The bottom edge's points, one at each of `points`' x; empty without
    /// a `low` accessor.
    pub(super) lows: Memo<Arc<[Point<Points>]>>,
    pub(super) ys: Signal<Option<Arc<[f64]>>>,
    low_values: Signal<Option<Arc<[f64]>>>,
}

/// A series' edges: its points, and its bottom edge's for a band.
#[derive(Clone, Default, PartialEq)]
struct Edges {
    top: Arc<[Point<Points>]>,
    bottom: Arc<[Point<Points>]>,
}

impl Series {
    /// The series of rows `data` (the plot's without), placed along the x
    /// axis by `x` (the plot's position of each row without own rows; a
    /// row's index without `x`), its values `y` (the plot's `y` without)
    /// and, for a band, its bottom edge's `low` (a row without one skipped
    /// as one without a `y`).
    pub(super) fn new(
        plot: PlotContext,
        data: Prop<Option<Rows>>,
        x: Prop<Option<RowAccessor>>,
        y: Prop<Option<RowAccessor>>,
        low: impl Fn() -> Option<RowAccessor> + Copy + 'static,
    ) -> Self {
        let rows = move || data.get().unwrap_or_else(|| plot.rows.get());
        let ys = values(rows, move || y.get().or_else(|| plot.y.get()));
        let low_values = values(rows, low);
        let own_x = values(rows, move || {
            data.with(Option::is_some).then(|| x.get()).flatten()
        });
        let xs = computed(move || -> Arc<[f32]> {
            if !data.with(Option::is_some) {
                return plot.xs.get();
            }
            let len = data.with(|rows| rows.as_ref().map_or(0, Rows::len));
            plot.x_map.get().ticks(len, own_x.get().as_deref())
        });
        let edges = computed(move || -> Edges {
            let (xs, y_map) = (xs.get(), plot.y_map.get());
            let Some(ys) = ys.get() else {
                return Edges::default();
            };
            let lows = low_values.get();
            // A band whose bottom values are still coming draws nothing
            // yet, rather than a shape down to the plot's bottom edge.
            if lows.is_none() && low().is_some() {
                return Edges::default();
            }
            let mut top = Vec::with_capacity(ys.len());
            let mut bottom = Vec::with_capacity(lows.as_ref().map_or(0, |_| ys.len()));
            for (i, (&x, &v)) in xs.iter().zip(ys.iter()).enumerate() {
                let Some(y) = y_map.tick(v).filter(|_| x.is_finite()) else {
                    continue;
                };
                if let Some(lows) = &lows {
                    let Some(y0) = lows.get(i).and_then(|&v| y_map.tick(v)) else {
                        continue;
                    };
                    bottom.push(point(px(x), px(y0)));
                }
                top.push(point(px(x), px(y)));
            }
            Edges {
                top: top.into(),
                bottom: bottom.into(),
            }
        });
        let points = computed(move || edges.with(|e| e.top.clone()));
        let lows = computed(move || edges.with(|e| e.bottom.clone()));
        Self {
            points,
            lows,
            ys,
            low_values,
        }
    }

    /// Adds the series to `plot` while the mark lives: its values, its
    /// bottom edge's and `also` in the y domain, and a hover dot on its
    /// points, styled by `dot`.
    pub(super) fn join(
        &self,
        plot: PlotContext,
        also: impl Fn() -> Option<f64> + 'static,
        dot: HoverDot,
    ) {
        let (ys, lows) = (self.ys, self.low_values);
        let extent = computed(move || {
            let values = ys.get()?;
            let lows = lows.get();
            let lows = lows.as_deref().unwrap_or_default();
            extent(values.iter().chain(lows).copied().chain(also()))
        });
        let points = self.points;
        let (dot_x, dot_y) = (animated_value(0.0), animated_value(0.0));
        let value_axis = computed(|| Axis::Y);
        plot.add(move |key| Mark {
            key,
            extent,
            value_axis,
            points,
            dot_x,
            dot_y,
            dot: Some(dot),
        });
    }
}
