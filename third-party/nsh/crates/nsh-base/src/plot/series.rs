//! A mark's series: its rows (its own or the plot's), the values it reads
//! of them (a field, or the app's function, called when they change), where
//! each row lands, and what it adds to the plot (its extent in the y
//! domain, its hover dot and how the app styles it).

use std::sync::Arc;

use nsh_core::{
    element::{RowAccessor, Rows, Style},
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

/// What a mark of `plot` draws: its points, in the plot's space, the rows
/// without a value skipped (as `gpui-base`'s shapes skip them).
#[derive(Clone, Copy)]
pub(super) struct Series {
    pub(super) points: Memo<Arc<[Point<Points>]>>,
    pub(super) ys: Signal<Option<Arc<[f64]>>>,
}

impl Series {
    /// The series of rows `data` (the plot's without), placed along the x
    /// axis by `x` (the plot's position of each row without own rows; a
    /// row's index without `x`), its values `y` (the plot's `y` without).
    pub(super) fn new(
        plot: PlotContext,
        data: Prop<Option<Rows>>,
        x: Prop<Option<RowAccessor>>,
        y: Prop<Option<RowAccessor>>,
    ) -> Self {
        let rows = move || data.get().unwrap_or_else(|| plot.rows.get());
        let ys = values(rows, move || y.get().or_else(|| plot.y.get()));
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
        let points = computed(move || -> Arc<[Point<Points>]> {
            let (xs, y_map) = (xs.get(), plot.y_map.get());
            let Some(ys) = ys.get() else {
                return Arc::from([]);
            };
            xs.iter()
                .zip(ys.iter())
                .filter_map(|(&x, &v)| {
                    let y = y_map.tick(v)?;
                    x.is_finite().then(|| point(px(x), px(y)))
                })
                .collect()
        });
        Self { points, ys }
    }

    /// Adds the series to `plot` while the mark lives: its values (and
    /// `also`) in the y domain, and a hover dot, styled by `dot`.
    pub(super) fn join(
        &self,
        plot: PlotContext,
        also: impl Fn() -> Option<f64> + 'static,
        dot: HoverDot,
    ) {
        let ys = self.ys;
        let extent = computed(move || {
            let values = ys.get()?;
            extent(values.iter().copied().chain(also()))
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
