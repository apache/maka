//! `nsh/base/plot`: the parts charts are built from, as `gpui-base`'s
//! `plot` module, with no look of their own. A [`Plot`] holds the rows of
//! data, the scales of its two axes (and a second y scale for dual-axis
//! charts, the marks choosing theirs), the pointer over it and its motion;
//! its marks ([`Line`], [`Area`], [`Bar`], [`Rule`], [`Dot`], [`Cell`], [`Grid`], the radial [`Pie`],
//! [`Arc`], [`RadialLine`] and [`RadialGrid`], the [`Sankey`] of flows
//! and the [`Treemap`] of nested rectangles) draw what it holds, each a
//! canvas filling the plot (a pie one per slice, a sankey one per node and
//! ribbon, a treemap one per part and classes), its [`PlotAxis`]es label
//! its edges with the ticks of its scales and its [`PlotLabel`]s write
//! texts at values of them, natively: the rows are read once when the app
//! sets them, scaled, recorded and drawn in Rust, so no JS runs per point,
//! and the pointer, the hover's fade and its glide between rows the keys
//! step to (the pointer's own moves it follows at once, in the same
//! frame), the appear and the scales'
//! moves to new domains (`tween.rs`) run in Rust and on the platform's
//! animator (the app hears of a new index, nothing more). Marks paint with
//! SVG's paint properties, CSS's on any element
//! (`fill-*`, `stroke-*`, `strokeWidth`, `strokeDasharray`),
//! `currentColor` where the app sets none, and an `Area` shows the app's
//! background (a gradient) inside its shape; the hover's cross line, dots
//! (the plot's, or a mark's own) and tooltip are parts the app styles and
//! fills, the tooltip placed and kept inside the plot natively.
//!
//! A module of its own (`nsh/base/plot`, a submodule of the `nsh/base`
//! set) because its marks only make sense inside a plot.

mod appear;
mod area;
mod axis;
mod bar;
mod cell;
mod class;
mod dot;
mod grid;
mod keys;
mod label;
mod line;
mod moves;
mod pie;
mod radial_line;
mod rule;
mod sankey;
mod scale;
mod series;
mod treemap;
mod tween;

use std::rc::Rc;

use nsh_core::{
    AccessibilityActionDef, AccessibilityValue,
    canvas::{CanvasOp, Num},
    element::{Registry, RowAccessor, Rows, Spring, Style, Timing},
    prelude::*,
};

pub use self::{
    appear::{
        AppearKey, PlotAppearScope, PlotAppearScopeElement, PlotAppearScopeProps, plot_appear_scope,
    },
    area::{Area, AreaElement, AreaProps, AreaY0, area},
    axis::{
        AxisLabelPlacement, AxisLabelStyle, AxisPlacement, PlotAxis, PlotAxisElement,
        PlotAxisProps, TickFormat, plot_axis,
    },
    bar::{Bar, BarBase, BarCornerRadii, BarElement, BarLabelStyle, BarProps, bar},
    cell::{Cell, CellElement, CellLabelStyle, CellProps, cell},
    class::RowClass,
    dot::{Dot, DotElement, DotProps, DotRadius, RadiusScale, dot},
    grid::{Grid, GridElement, GridProps, grid},
    label::{PlotLabel, PlotLabelElement, PlotLabelProps, PlotText, PlotTextAlign, plot_label},
    line::{Curve, Line, LineElement, LineProps, line},
    pie::{
        Arc, ArcElement, ArcProps, Pie, PieElement, PieLabelStyle, PieProps, SliceClass, arc, pie,
    },
    radial_line::{
        RadialGrid, RadialGridElement, RadialGridProps, RadialLine, RadialLineElement,
        RadialLineProps, radial_grid, radial_line,
    },
    rule::{Rule, RuleElement, RuleProps, rule},
    sankey::{
        Sankey, SankeyAlign, SankeyElement, SankeyLinkClass, SankeyLinks, SankeyProps,
        SankeyValueLabel, SankeyValueScale, sankey,
    },
    scale::{
        BandScale, ColorScale, DivergingScale, LinearScale, OrdinalScale, Scale, SequentialScale,
    },
    treemap::{
        Treemap, TreemapElement, TreemapLabelPlacement, TreemapPadding, TreemapProps, TreemapSort,
        TreemapValueLabel, treemap,
    },
};
use self::{
    bar::{BarEntry, BarLayout},
    cell::CellEntry,
    scale::{AxisMap, Band, Linear, extent},
    series::{HoverDot, Mark},
    tween::Tween,
};

/// The JS module apps import the plot parts as.
pub const SPECIFIER: &str = "nsh/base/plot";

/// The components of `nsh/base/plot`, served with `nsh/base`
/// ([`Registry::submodule`]).
pub fn registry() -> Registry {
    let mut registry = Registry::ui_set(SPECIFIER);
    registry
        .register::<Plot>()
        .register::<PlotAppearScope>()
        .register::<Line>()
        .register::<Area>()
        .register::<Bar>()
        .register::<Rule>()
        .register::<Dot>()
        .register::<Cell>()
        .register::<Grid>()
        .register::<Pie>()
        .register::<Arc>()
        .register::<RadialLine>()
        .register::<RadialGrid>()
        .register::<PlotAxis>()
        .register::<PlotLabel>()
        .register::<Sankey>()
        .register::<Treemap>();
    registry
}

/// The timing of a plot's motion (`gpui-base`'s `PlotMotion`): how its
/// marks appear and change shape, how the hover fades in and out, and the
/// spring it glides to the row the keys step to (the pointer's moves it
/// follows at once). Each is the app's; none moves at once, as
/// `gpui-base`'s zero durations do, and so does every one while the user
/// asks for reduced motion.
#[derive(Debug, Clone, Copy, Default, PartialEq, JsObject)]
pub struct PlotMotion {
    /// The spring the cross line, the dots and the tooltip glide to the
    /// next row with when the keys or a screen reader step the hover there
    /// (`with_pointer`), and a pie's slice under the pointer lifts with;
    /// none: they move at once. The pointer's own moves never take it:
    /// pointer-driven motion follows the pointer in the same frame (the
    /// parts snap to the row nearest to it), so the hover never trails the
    /// hand. `gpui-base` springs pointer moves too, but snaps by default.
    pub pointer: Option<Spring>,
    /// How the hover fades in when the pointer comes over the plot
    /// (`with_enter`).
    pub enter: Option<Timing>,
    /// How the hover fades out after the pointer leaves (`with_exit`).
    pub exit: Option<Timing>,
    /// How the marks draw in (`with_appear`): lines and areas from the
    /// leading edge, bars growing out of their base (`Bar`'s `stagger`
    /// starts them one after another); when the plot is first shown with
    /// an `appearGeneration`, and again each time that changes.
    pub appear: Option<Timing>,
    /// How marks move to a new shape when the app changes it, as d3's
    /// update transitions do between `enter` and `exit`: a pie's or an
    /// arc's radii (a donut's hole opening or closing) and angles (a
    /// slice or a gauge sweeping round to its new value, d3's `arcTween`),
    /// and a linear scale's domain (the app's `domain`, or the extent of
    /// the marks' values as rows come), interpolated as d3 transitions a
    /// scale's domain, so the marks keep their shapes, the grid lines, the
    /// axes' ticks and labels and the hover's parts move with them, and new rows come in with the rest.
    /// None by default: the new shape shows at once. `gpui-base` has no
    /// such motion.
    pub update: Option<Timing>,
}

/// What screen readers hear as the plot's value (TS `{ min?, max?, now?,
/// text? }`, as a view's `accessibilityValue`): the app's words for the
/// row under the pointer, so a screen reader says the value, not only the
/// label.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct PlotAccessibilityValue {
    /// The smallest value of a range.
    pub min: Option<f64>,
    /// The largest value of a range.
    pub max: Option<f64>,
    /// The value now.
    pub now: Option<f64>,
    /// The value in words (`"Thursday, 2,480 visitors"`).
    pub text: Option<SharedString>,
}

/// Where a [`Plot`]'s tooltip goes (`gpui-base`'s `Plot::tooltip` gets
/// the cursor and the plot's bounds to place it, `plot/mod.rs:215`;
/// `gpui-component`'s `Tooltip` hugs the cursor, `plot/tooltip.rs:585`).
/// Either way it moves along the plot's edges rather than past them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum TooltipPlacement {
    /// At the top of the plot, centered on the cross line and moved with
    /// it, kept between the plot's left and right edges; its
    /// `tooltipOffset` below the top edge (past the bottom one for a tag
    /// under the plot).
    #[default]
    Top,
    /// Beside the pointer, as `gpui-component`'s chart tooltips: on the
    /// side of the cross line toward the plot's middle, below the pointer
    /// in the plot's upper half and above it in the lower one, its
    /// `tooltipOffset` from both, kept inside the plot.
    Pointer,
}

/// The props of [`Plot`].
#[derive(Debug, Clone, PartialEq, Props)]
#[props(generic)]
pub struct PlotProps {
    /// The rows of data, one object per point (`gpui-base`'s `data`): the
    /// marks read their values by field name or through the app's
    /// functions, once, when the app sets the rows. A row without a value
    /// is skipped, as `gpui-base` skips it.
    pub data: Prop<Rows>,
    /// What places a row along the x axis on a `linear` x scale
    /// (`gpui-base`'s `x`): a field name, or a function of the row and its
    /// index; without one, a row's index. A `point` or `band` scale places
    /// the rows in order.
    pub x: Prop<Option<RowAccessor>>,
    /// What the marks draw unless they name their own (`gpui-base`'s `y`,
    /// `Area`'s `y1`, `Bar`'s `value`): a field name or a function.
    pub y: Prop<Option<RowAccessor>>,
    /// How the x axis places rows: `{ type: "point" }` (the default, the
    /// rows in order, evenly from the left edge to the right one), `{
    /// type: "linear", domain? }`, or `{ type: "band", … }` (a band per
    /// row, for bars); with a band y scale it defaults to linear, for
    /// bars across. `reverse: true` runs it from the right edge: the first
    /// row, or the domain's smallest value, at the right (bars across
    /// grow leftward from it, `gpui-base`'s `BarAlignment::Right`).
    pub x_scale: Prop<Option<Scale>>,
    /// How the y axis places values: `{ type: "linear", domain? }` (the
    /// default; without a domain, the extent of what the marks draw), the
    /// domain's smallest value at the bottom edge and its largest at the
    /// top one; or `{ type: "band", … }`, a band per row from the top edge
    /// down, for bars across (the x scale then `linear`, its domain the
    /// extent of the bars' values without one). `reverse: true` runs it
    /// the other way: the domain's smallest value at the top edge (bars
    /// grow down from it, `gpui-base`'s `BarAlignment::Top`), the rows
    /// from the bottom edge up.
    pub y_scale: Prop<Option<Scale>>,
    /// A second scale along the y axis, for the values of the marks that
    /// name it (`scale: "y2"`), as dual-axis charts put a series of other
    /// units (a price beside volumes, a margin beside revenue) on a scale
    /// of its own, its axis on the right (`<PlotAxis placement="right"
    /// scale="y2">`): `{ type: "linear", domain?, reverse? }`, its domain
    /// the extent of the values on it without one, moving to a new one as
    /// the y scale's does (`motion.update`). Without it, marks that name
    /// `y2` go on a linear scale of their values' extent. It shares the y
    /// scale's range (the plot's height) and has no meaning when the y
    /// axis has bands.
    pub y2_scale: Prop<Option<LinearScale>>,
    /// The ticks of the y scale and the second one fall on the same places
    /// (ECharts' `alignTicks`; true by default): while both domains are
    /// automatic (neither `yScale` nor `y2Scale` names one) and marks are
    /// on both, each is widened to nice steps (1, 2 or 5 times a power of
    /// ten), the same number of them on both, zero on the same place when
    /// both hold it, a step for about every 32 points of the plot's
    /// height (2 to 10 of them); the axes' default ticks and a `Grid` without values
    /// take those steps, so one grid serves both axes. False keeps each
    /// domain the extent of its values.
    #[prop(default = true)]
    pub align_ticks: Prop<bool>,
    /// The plot follows the pointer (`gpui-base`'s `Plot::interactive`;
    /// default true): it reports the row under it and shows the hover's
    /// parts. It is also a stop of the keyboard focus whose keys move the
    /// hover (Left / Right, Home / End, Escape), and screen readers'
    /// increment and decrement step through the rows. False draws the
    /// marks only (a sparkline in a list): no focus, and presses go to the
    /// views around it. Whether it offers the focus and the actions at all
    /// is decided when the plot is made.
    #[prop(default = true)]
    pub interactive: Prop<bool>,
    /// The timing of its motion: the appear, the moves to new shapes and
    /// domains (`update`), the hover's fade and the keys' glide; none
    /// by default, so everything shows at once.
    pub motion: Prop<Option<PlotMotion>>,
    /// Opts in to the appear (`gpui-base`'s `Plot::appear_generation`):
    /// the marks draw in over `motion.appear` when the plot is first shown,
    /// and again whenever this changes (another symbol, another period):
    /// a number or a string (`gpui-component`'s `appear_key`). Inside a
    /// [`PlotAppearScope`], a generation that finished there shows whole
    /// at once.
    pub appear_generation: Prop<Option<AppearKey>>,
    /// What screen readers say of the plot: what it shows and what stands
    /// out (it is one element to them, its marks are not).
    pub accessibility_label: Prop<Option<SharedString>>,
    /// What screen readers hear as its value: the app's words for the row
    /// under the pointer.
    pub accessibility_value: Prop<Option<PlotAccessibilityValue>>,
    /// The Tailwind classes of the cross line (`gpui-base`'s
    /// `TooltipState::cross_line`): a view as tall as the plot, centered on
    /// the row under the pointer (its width and color the app's), shown
    /// while the pointer is over the plot. On a band scale it sits in the
    /// row's band, as wide as the band (`gpui-component`'s `CrossLine::band`),
    /// so `w-full` fills the band and `w-px` is a line in its middle; on a
    /// band y scale it lies across the plot, as wide as the plot.
    pub cross_line_class: Prop<Option<SharedString>>,
    /// The style of the cross line, over `crossLineClass`.
    #[prop(default)]
    pub cross_line_style: Prop<Style>,
    /// The Tailwind classes of the hover's dots (`TooltipState::dots`): one
    /// view per `Line` and `Area`, centered on its point at the row under
    /// the pointer (its size, color and border the app's). A mark's
    /// `hoverDotClass` replaces it for that mark's dot.
    pub dot_class: Prop<Option<SharedString>>,
    /// The style of the hover's dots, over `dotClass`; a mark's
    /// `hoverDotStyle` replaces it for that mark's dot.
    #[prop(default)]
    pub dot_style: Prop<Style>,
    /// The app's tooltip (`gpui-base`'s `Plot::tooltip`): placed by
    /// `tooltipPlacement` and kept inside the plot's edges, moved and faded with
    /// the cross line; its content is the app's, for the row
    /// `onHoverChange` reported.
    pub tooltip_content: Prop<Option<Slot>>,
    /// Where the tooltip goes: `"top"` (the default, at the top, centered
    /// on the cross line, between the left and right edges) or
    /// `"pointer"` (beside the pointer, toward the plot's middle, inside
    /// the plot).
    #[prop(default)]
    pub tooltip_placement: Prop<TooltipPlacement>,
    /// The distance between the tooltip and what places it
    /// (`gpui-component`'s `Tooltip::gap`, `gpui-base`'s
    /// `Positioner::offset`): the top edge for `"top"`, the cross line and
    /// the pointer for `"pointer"`; 0 by default.
    #[prop(default)]
    pub tooltip_offset: Prop<Points>,
    /// The colors of the marks: of the categories the marks' `color`
    /// reads of their rows (`gpui-base`'s `ScaleOrdinal`, d3's
    /// `scaleOrdinal`), `{ type: "ordinal", domain?, range, unknown? }`;
    /// or of the numbers a `Cell`'s `value` or a `Treemap`'s `colorValue`
    /// reads, along a ramp of colors
    /// mixed in OKLab (d3's `scaleSequential` and `scaleDiverging`), `{
    /// type: "sequential", domain?, range, unknown? }` or `{ type:
    /// "diverging", domain?, pivot?, range, unknown? }`. A slice's, a
    /// bar's or a cell's color is its row's, a line's or an area's its
    /// first row's; it is the mark's `fill` (a line's `stroke`) where
    /// nothing sets one, so the app's classes and styles, the mark's or
    /// inherited from the plot, win over it. None by default: the marks
    /// take no color of a scale.
    pub color_scale: Prop<Option<ColorScale>>,
    /// The marks, drawn in order over each other (each fills the plot),
    /// and whatever the app lays over them.
    pub children: Prop<Children>,
}

/// What [`Plot`] reports.
#[derive(Debug, Clone, PartialEq, Event)]
pub enum PlotEvent {
    /// The pointer came over another row (`gpui-base`'s
    /// `TooltipState::index`): the index of the row nearest to it along
    /// the x axis (the y axis when only that one has bands), of the slice
    /// of a `Pie`, the dot of a `Dot`, the cell of a `Cell` or the node of
    /// a `Treemap` under it (a leaf, or a group in its band or padding),
    /// or of a `RadialLine`'s row nearest to it by angle; `null` once it
    /// leaves the plot (or, over a pie, its slices; over a radial line,
    /// its outer radius).
    #[args(index)]
    HoverChange(Option<u32>),
}

/// The scale along the y axis a part places its values on (TS `"y" |
/// "y2"`): the plot's `yScale`, or its second one, `y2Scale` (a dual-axis
/// chart's right-hand scale).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, PropEnum)]
pub enum ValueScale {
    /// The plot's y scale (`yScale`).
    #[default]
    Y,
    /// The plot's second y scale (`y2Scale`).
    Y2,
}

/// The height an aligned step of the y scales takes at least, in points
/// (`alignTicks`: ai-chat's tick pitch): from 2 to 10 steps, as the plot's
/// height allows.
const ALIGNED_PITCH: Points = Points(32.0);

/// An axis of a plot's scales: x, y, or the second y scale.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Axis {
    X,
    Y,
    Y2,
}

impl From<ValueScale> for Axis {
    fn from(scale: ValueScale) -> Self {
        match scale {
            ValueScale::Y => Axis::Y,
            ValueScale::Y2 => Axis::Y2,
        }
    }
}

/// The appear's time, on the platform's animator: linear from 0 to 1 over
/// `motion.appear`'s duration, which each mark eases on its own slice of it
/// (`gpui-base`'s `PlotAppear`, whose `staggered` eases each mark over the
/// part of the time it runs in).
#[derive(Clone, Copy)]
struct Appear {
    time: AnimatedValue,
    /// `motion.appear`'s curve.
    easing: Signal<Easing>,
}

impl Appear {
    /// How far the whole plot has appeared, 0 to 1, eased
    /// (`PlotAppear::progress`).
    fn progress(&self) -> AnimatedNode {
        self.staggered(0, 1, 0.0)
    }

    /// How far mark `index` of `count` has appeared, 0 to 1, eased
    /// (`PlotAppear::staggered`, `appear.rs:68`): the marks start one after
    /// another over the first `spread` of the time and each runs for the
    /// rest of it, so the last one finishes with the appear.
    fn staggered(&self, index: usize, count: usize, spread: f32) -> AnimatedNode {
        let spread = match count {
            0 | 1 => 0.0,
            _ => spread.clamp(0.0, 0.95),
        };
        let start = match count {
            0 | 1 => 0.0,
            _ => spread * index.min(count - 1) as f32 / (count - 1) as f32,
        };
        self.time.interpolate_with(
            &[start, start + (1.0 - spread)],
            AnimationOutput::Numbers(vec![0.0, 1.0]),
            Interpolation {
                easing: self.easing.get(),
                ..Interpolation::default()
            },
        )
    }
}

/// The plot's state, for its marks.
#[derive(Clone, Copy)]
struct PlotContext {
    rows: Prop<Rows>,
    /// What the plot's `x` reads of its rows (none without an `x`).
    x_values: Signal<Option<std::sync::Arc<[f64]>>>,
    y: Prop<Option<RowAccessor>>,
    /// Where values go along the x axis.
    x_map: Memo<AxisMap>,
    /// Where each of the plot's rows goes along the x axis (NaN: nowhere).
    xs: Memo<std::sync::Arc<[f32]>>,
    /// Where values go along the y axis.
    y_map: Memo<AxisMap>,
    /// Where values go along the second y scale (`y2Scale`).
    y2_map: Memo<AxisMap>,
    /// The moves of the linear axes to new domains (`motion.update`).
    x_tween: Tween,
    y_tween: Tween,
    y2_tween: Tween,
    /// The plot's size.
    size: Signal<Size<Points>>,
    /// Its marks that count in a domain and may show a hover dot.
    marks: Signal<Vec<Mark>>,
    /// The next mark's key.
    next: Stored<u64>,
    /// The appear's time and curve.
    appear: Appear,
    /// The appear runs: the lines and areas clip to it, the bars grow, a
    /// pie's slices sweep in.
    appearing: Signal<bool>,
    /// The plot's motion, for marks that move on hover (a pie's slices
    /// lift on the pointer spring).
    motion: Prop<Option<PlotMotion>>,
    /// Its bars, in order, and where each one's segments go.
    bars: Signal<Vec<BarEntry>>,
    bar_layout: Memo<std::sync::Arc<BarLayout>>,
    /// The hover's place along each axis (the cross line's along the axis
    /// of the rows, the pointer's along the other) and how far it has
    /// faded in (`PlotHover::progress`), on the platform's animator: the
    /// hover's parts fade with it, the bars follow it to fade the others,
    /// a pie's slices lift and dim with it.
    cross: Point<AnimatedValue>,
    fade: AnimatedValue,
    /// The row under the pointer (`TooltipState::index`).
    hovered: Signal<Option<u32>>,
    /// The keys (or a screen reader) moved the hover last, not the
    /// pointer: its parts may glide to the row on `motion.pointer`. What
    /// the pointer drives follows it in the same frame.
    keyed: Stored<bool>,
    /// What the y axes' labels need kept inside the plot's top and bottom
    /// edges (top, bottom), while each lives.
    insets: Signal<Vec<(u64, Memo<[f32; 2]>)>>,
    /// The radial marks' tests of the row under a point (a pie's slice):
    /// with any, the pointer is over what they find, not the row nearest
    /// along the x axis.
    hits: Signal<Vec<Hit>>,
    /// The plot follows the pointer.
    interactive: Prop<bool>,
    /// The plot's own hover dot (`dotClass` / `dotStyle`), for the marks
    /// that place their hover dot themselves (a radial line's, at the
    /// hovered row's vertex).
    dot: HoverDot,
    /// The axis with bands (the x axis when both have them).
    band_axis: Memo<Option<Axis>>,
    /// The colors of the marks' categories and of the cells' values.
    color_scale: Prop<Option<ColorScale>>,
    /// The categories outside `color_scale`'s domain the marks have met,
    /// in order, and the scale they were met for (d3's implicit domain:
    /// they keep their colors while the scale stays).
    met: Stored<(Option<OrdinalScale>, Vec<SharedString>)>,
    /// Its cells, which name the bands' categories and whose values the
    /// ramps of `color_scale` spread over.
    cells: Signal<Vec<CellEntry>>,
    /// The categories of the bands along each axis (`None`: a band per
    /// row, or no bands).
    x_categories: Memo<Option<std::sync::Arc<[SharedString]>>>,
    y_categories: Memo<Option<std::sync::Arc<[SharedString]>>>,
    /// The extent of the cells' values.
    cell_extent: Memo<Option<[f64; 2]>>,
}

/// A radial mark's test of the row under a point of the plot
/// (`gpui-base`'s `Arc::contains`, `shape/arc.rs:191`), while it lives,
/// and where a row's slice is for the keys (its middle; `None`: the row
/// has no slice).
#[derive(Clone)]
struct Hit {
    key: u64,
    at: Rc<dyn Fn(Point<Points>) -> Option<u32>>,
    center: Rc<dyn Fn(u32) -> Option<Point<Points>>>,
    /// Where a key steps from a row across a grid of them (cells): the row
    /// beside it on the screen (the arrows, Up and Down too) or at either
    /// end of its line (Home, End). `None`: the keys step through the rows
    /// in order.
    grid: Option<GridStep>,
}

/// Where a key steps from a row across a grid of rows ([`Hit::grid`]).
type GridStep = Rc<dyn Fn(Option<u32>, keys::Step) -> Option<u32>>;

impl PartialEq for Hit {
    fn eq(&self, other: &Self) -> bool {
        self.key == other.key
    }
}

impl PlotContext {
    /// The plot has been laid out with an area to draw on: before that, a
    /// mark records nothing, so the first frame sends each drawing once,
    /// at the plot's size.
    fn is_sized(&self) -> bool {
        let size = self.size.get();
        size.width.0 > 0.0 && size.height.0 > 0.0
    }

    /// Where values go along the y scale `scale` names.
    fn y_map_of(&self, scale: ValueScale) -> AxisMap {
        match scale {
            ValueScale::Y => self.y_map.get(),
            ValueScale::Y2 => self.y2_map.get(),
        }
    }

    /// The move of the y scale `scale` names to a new domain.
    fn y_tween_of(&self, scale: ValueScale) -> Tween {
        match scale {
            ValueScale::Y => self.y_tween,
            ValueScale::Y2 => self.y2_tween,
        }
    }

    /// The move of `axis`'s scale to a new domain.
    fn tween_of(&self, axis: Axis) -> Tween {
        match axis {
            Axis::X => self.x_tween,
            Axis::Y => self.y_tween,
            Axis::Y2 => self.y2_tween,
        }
    }

    /// The plot a mark is in (`None`: a mark outside any).
    fn of(mark: &str) -> Option<Self> {
        let plot = use_context::<PlotContext>();
        if plot.is_none() {
            log::warn!("`{mark}` draws only inside a `Plot`");
        }
        plot
    }

    /// Adds `mark` while the current owner lives; its key.
    fn add(&self, make: impl FnOnce(u64) -> Mark) -> u64 {
        let key = self.next.get();
        self.next.replace(key + 1);
        let marks = self.marks;
        marks.update(|all| all.push(make(key)));
        cleanup(move || {
            if let Some(mut all) = marks.try_get() {
                all.retain(|m| m.key != key);
                marks.try_set(all);
            }
        });
        key
    }

    /// Keeps `need` (top, bottom) inside the plot's top and bottom edges
    /// while the current owner lives: the linear y scales' range starts and
    /// ends that far in (an axis's labels centered on ticks near its ends).
    fn add_inset(&self, need: Memo<[f32; 2]>) {
        let key = self.next.get();
        self.next.replace(key + 1);
        let insets = self.insets;
        insets.update(|all| all.push((key, need)));
        cleanup(move || {
            if let Some(mut all) = insets.try_get() {
                all.retain(|(k, _)| *k != key);
                insets.try_set(all);
            }
        });
    }

    /// Tests what is under the pointer with `at` while the current owner
    /// lives (a radial mark's slices), `center` placing a row's slice for
    /// the keys.
    fn add_hit(
        &self,
        at: impl Fn(Point<Points>) -> Option<u32> + 'static,
        center: impl Fn(u32) -> Option<Point<Points>> + 'static,
    ) {
        self.add_hit_with(at, center, None);
    }

    /// [`Self::add_hit`], the keys stepping across a grid of rows with
    /// `grid` when given.
    fn add_hit_with(
        &self,
        at: impl Fn(Point<Points>) -> Option<u32> + 'static,
        center: impl Fn(u32) -> Option<Point<Points>> + 'static,
        grid: Option<GridStep>,
    ) {
        let key = self.next.get();
        self.next.replace(key + 1);
        let hits = self.hits;
        hits.update(|all| {
            all.push(Hit {
                key,
                at: Rc::new(at),
                center: Rc::new(center),
                grid,
            })
        });
        cleanup(move || {
            if let Some(mut all) = hits.try_get() {
                all.retain(|h| h.key != key);
                hits.try_set(all);
            }
        });
    }

    /// Records the clip of the appear while it runs (before what a mark
    /// draws): the marks show from the leading edge, where the x scale
    /// starts (the right one when it is reversed), to the appear's
    /// progress of the plot's width.
    fn clip(&self, p: Painter, bleed: f32) -> Painter {
        if !self.appearing.get() {
            return p;
        }
        let size = self.size.get();
        let (w, h) = (size.width.0, size.height.0);
        let shown = self.appear.progress().mul(w);
        // What the mark draws past the plot's edges (`bleed`) is revealed
        // with the rest, from the leading edge.
        let (lead, edge) = match self.x_map.get().backward() {
            true => (w + bleed, shown.mul(-1.0).add(w)),
            false => (-bleed, shown),
        };
        p.begin_path()
            .move_to(lead, -bleed)
            .line_to(&edge, -bleed)
            .line_to(&edge, h + bleed)
            .line_to(lead, h + bleed)
            .close_path()
            .clip()
    }

    /// Records what `trace` adds to the path where the moving scales show
    /// it (along x if `x`, along y if it names a y scale): through the
    /// moves' transform while one runs, as it is otherwise. The path keeps
    /// its points after the transform is undone, so its stroke is not
    /// scaled.
    fn traced(
        &self,
        p: Painter,
        x: bool,
        y: Option<ValueScale>,
        trace: impl FnOnce(Painter) -> Painter,
    ) -> Painter {
        let y_tween = self.y_tween_of(y.unwrap_or_default());
        let x = x && self.x_tween.moving.get();
        let y = y.is_some() && y_tween.moving.get();
        if !(x || y) {
            return trace(p);
        }
        let mut p = p.save();
        let mut along = |tween: Tween, moving: bool| match moving {
            true => {
                let (scale, offset) = tween.transform();
                (p.num(&scale), p.num(&offset))
            }
            false => (Num::Const(1.0), Num::Const(0.0)),
        };
        let ((sx, ox), (sy, oy)) = (along(self.x_tween, x), along(y_tween, y));
        let none = Num::Const(0.0);
        let p = p.op(CanvasOp::Transform([sx, none, none, sy, ox, oy]));
        trace(p).restore()
    }

    /// The colors `colorScale` gives `categories` (`None`: the plot has no
    /// scale), a category met first taking the next color (d3's implicit
    /// domain).
    fn colors(&self, categories: &[SharedString]) -> Option<std::sync::Arc<[Option<Hsla>]>> {
        let scale = self.color_scale.with(|s| s.as_ref()?.ordinal().cloned())?;
        Some(self.met.with(|(of, met)| {
            if of.as_ref() != Some(&scale) {
                *of = Some(scale.clone());
                met.clear();
            }
            categories.iter().map(|c| scale.color(met, c)).collect()
        }))
    }

    /// The colors a ramp of `colorScale` (`sequential`, `diverging`) gives
    /// `values`, over its domain (the app's, or the extent of the plot's
    /// cells' values); `None` without such a scale or any value.
    fn shades(&self, values: &[f64]) -> Option<std::sync::Arc<[Option<Hsla>]>> {
        self.shades_over(values, self.cell_extent.get())
    }

    /// [`Self::shades`] over `extent`, the extent of the values a mark
    /// colors, where the scale has no domain of its own.
    fn shades_over(
        &self,
        values: &[f64],
        extent: Option<[f64; 2]>,
    ) -> Option<std::sync::Arc<[Option<Hsla>]>> {
        self.color_scale.with(|scale| {
            let scale = scale.as_ref()?;
            let domain = scale.domain(extent)?;
            Some(values.iter().map(|&v| scale.shade(v, domain)).collect())
        })
    }
}

/// The categories of the bands of an axis whose scale is `scale`: its
/// `domain`, else the categories the plot's `cells` read along the axis,
/// in the order met (a band per row without any).
fn band_categories(
    scale: Option<Scale>,
    cells: Signal<Vec<CellEntry>>,
    axis: Axis,
) -> Option<std::sync::Arc<[SharedString]>> {
    let Some(Scale::Band(band)) = scale else {
        return None;
    };
    if let Some(domain) = band.domain {
        return Some(domain);
    }
    cells.with(|all| {
        let mut met: Vec<SharedString> = Vec::new();
        let mut any = false;
        for cell in all {
            let Some(texts) = cell.categories(axis).and_then(|c| c.try_get().flatten()) else {
                continue;
            };
            any = true;
            for t in texts.iter() {
                if !t.is_empty() && !met.contains(t) {
                    met.push(t.clone());
                }
            }
        }
        any.then(|| met.into())
    })
}

/// A plot (`gpui-base`'s `Plot`): the rows of data a chart shows, the
/// scales of its x and y axes, its size as their range, the pointer over
/// it and its motion. It draws nothing itself: its marks, the children
/// (`Line`, `Area`, `Bar`, `Rule`, `Dot`, `Cell`, `Grid`, `Pie`, `Arc`,
/// `RadialLine`, `RadialGrid`, `Sankey`, `Treemap`), each fill it and draw in order over each other. It
/// reports the row nearest to the pointer, the slice of a pie under it, or
/// a radial line's row nearest to it by angle (`onHoverChange`), and
/// shows the hover's parts the app styles (`crossLineClass`, `dotClass` or
/// a mark's `hoverDotClass`, `tooltipContent`), moved and faded natively
/// with `motion`, the tooltip placed by `tooltipPlacement` and kept inside
/// the plot on the platform's animator. The keyboard drives the same
/// hover: the plot is a stop of the focus (the app's `focus-visible:`
/// classes or `focusVisibleStyle` draw its ring), and while it has it Left / Right move to
/// the row on that side (the row before / after; the other way round on
/// a reversed x scale), Home / End to the first / last, Escape clears
/// it (`keys.rs`). It is one element for screen readers, with the image
/// role, the app's `accessibilityLabel` and `accessibilityValue`, and
/// increment / decrement step through the rows. The app's `class` and
/// `style` size and style it; the marks' paint inherits from it as CSS
/// inherits `fill` and `stroke`.
#[component]
pub fn Plot(props: PlotProps, cx: Scope<PlotEvent>) -> impl IntoElement {
    let size = signal(Size::<Points>::default());
    let marks = signal(Vec::<Mark>::new());
    // How far in from the top and bottom edges the linear y scales' range
    // runs: what the y axes beside the plot need, so their labels on ticks
    // near the ends stay inside it.
    let insets = signal(Vec::<(u64, Memo<[f32; 2]>)>::new());
    let inset = computed(move || {
        insets.with(|all| {
            all.iter()
                .filter_map(|(_, need)| need.try_get())
                .fold([0.0_f32; 2], |[t, b], [nt, nb]| [t.max(nt), b.max(nb)])
        })
    });
    let (data, x, x_scale, y_scale) = (props.data, props.x, props.x_scale, props.y_scale);
    let y2_scale = props.y2_scale;
    let motion = props.motion;
    // A row's value along the x axis: its `x` on a linear scale, else its
    // index.
    let x_values = series::values(move || data.get(), move || x.get());
    // The axis with bands, from the scales the app names (not their maps,
    // which read the marks' extents, which read this).
    let band_axis = computed(move || match (x_scale.get(), y_scale.get()) {
        (Some(Scale::Band(_)), _) => Some(Axis::X),
        (_, Some(Scale::Band(_))) => Some(Axis::Y),
        _ => None,
    });
    // The extent of what the marks draw along an axis.
    let extent_on = move |axis: Axis| {
        marks.with(|all| {
            extent(
                all.iter()
                    .filter(|m| m.value_axis.try_get() == Some(axis))
                    .filter_map(|m| m.extent.try_get().flatten())
                    .flatten(),
            )
        })
    };
    // The bands' categories: a band scale's domain, or its cells'.
    let cells = signal(Vec::<CellEntry>::new());
    let x_categories = computed(move || band_categories(x_scale.get(), cells, Axis::X));
    let y_categories = computed(move || band_categories(y_scale.get(), cells, Axis::Y));
    let bands = move |categories: Memo<Option<std::sync::Arc<[SharedString]>>>, rows: usize| {
        categories.with(|c| c.as_ref().map_or(rows, |c| c.len()))
    };
    let x_map = computed(move || {
        let width = size.get().width.0;
        let len = data.with(|rows| rows.len());
        // Bars across a band y axis put their values along x.
        let fallback = match y_scale.get() {
            Some(Scale::Band(_)) => Scale::Linear {
                domain: None,
                reverse: false,
            },
            _ => Scale::Point { reverse: false },
        };
        let scale = x_scale.get().unwrap_or(fallback);
        // Left to right; reversed, from the right edge.
        let range = match scale.reversed() {
            true => [width, 0.0],
            false => [0.0, width],
        };
        match scale {
            Scale::Point { .. } => AxisMap::Point { len, range },
            Scale::Band(band) => AxisMap::Band(Band::new(bands(x_categories, len), range, &band)),
            Scale::Linear { domain, .. } => {
                // The rows' `x`, or the values of bars across the plot.
                let domain = domain
                    .or_else(|| match x_values.get() {
                        Some(values) => extent(values.iter().copied()),
                        None => None,
                    })
                    .or_else(|| extent_on(Axis::X))
                    .or_else(|| (len > 0).then(|| [0.0, (len - 1) as f64]));
                AxisMap::Linear(Linear::new(domain.unwrap_or([0.0, 0.0]), range))
            }
        }
    });
    let xs = computed(move || {
        let len = data.with(|rows| rows.len());
        x_map.get().ticks(len, x_values.get().as_deref())
    });
    // The y scales laid out in the same steps (`alignTicks`), while both
    // domains are the marks' and marks are on both.
    let align_ticks = props.align_ticks;
    let aligned = computed(move || {
        if !align_ticks.get() {
            return None;
        }
        let y_auto = matches!(
            y_scale.get(),
            None | Some(Scale::Linear { domain: None, .. })
        );
        if !y_auto || y2_scale.with(|s| s.is_some_and(|s| s.domain.is_some())) {
            return None;
        }
        let (y, y2) = (extent_on(Axis::Y)?, extent_on(Axis::Y2)?);
        let [top, bottom] = inset.get();
        let room = size.get().height.0 - top - bottom;
        let steps = (room / ALIGNED_PITCH.0).floor() as usize;
        scale::align(y, y2, steps.clamp(2, 10))
    });
    let y_map = computed(move || {
        let height = size.get().height.0;
        let len = data.with(|rows| rows.len());
        let scale = y_scale.get();
        // Rows from the top edge down, values from the bottom edge up (the
        // axes' labels' inset in from both); reversed, the other way.
        let [top, bottom] = inset.get();
        let (down, up) = match scale.as_ref().is_some_and(|s| s.reversed()) {
            true => ([height, 0.0], [top, height - bottom]),
            false => ([0.0, height], [height - bottom, top]),
        };
        match scale {
            Some(Scale::Point { .. }) => AxisMap::Point { len, range: down },
            Some(Scale::Band(band)) => {
                AxisMap::Band(Band::new(bands(y_categories, len), down, &band))
            }
            Some(Scale::Linear {
                domain: Some(domain),
                ..
            }) => AxisMap::Linear(Linear::new(domain, up)),
            _ => match aligned.get() {
                Some((y, _)) => AxisMap::Linear(Linear::aligned(y, up)),
                None => AxisMap::Linear(Linear::new(extent_on(Axis::Y).unwrap_or([0.0, 0.0]), up)),
            },
        }
    });
    // The second y scale: linear, over the same range as the y scale's
    // values.
    let warned = stored(false);
    let y2_map = computed(move || {
        let height = size.get().height.0;
        let scale = y2_scale.get();
        if scale.is_some() && band_axis.get() == Some(Axis::Y) && !warned.get() {
            warned.replace(true);
            log::warn!("`y2Scale` places values along y: the y axis has bands");
        }
        let scale = scale.unwrap_or_default();
        let [top, bottom] = inset.get();
        let range = match scale.reverse {
            true => [top, height - bottom],
            false => [height - bottom, top],
        };
        if let (None, Some((_, y2))) = (scale.domain, aligned.get()) {
            return AxisMap::Linear(Linear::aligned(y2, range));
        }
        let domain = scale.domain.or_else(|| extent_on(Axis::Y2));
        AxisMap::Linear(Linear::new(domain.unwrap_or([0.0, 0.0]), range))
    });
    let hover_axis = computed(move || match band_axis.get() {
        Some(Axis::Y) => Axis::Y,
        _ => Axis::X,
    });
    // Where each row is along the axis the hover finds rows along.
    let rows_at = computed(move || match hover_axis.get() {
        Axis::X => xs.get(),
        Axis::Y | Axis::Y2 => y_map.get().ticks(data.with(|rows| rows.len()), None),
    });

    // The appear: from the first frame with a size, and again for each new
    // generation, over `motion.appear`; at once without one or with reduced
    // motion; whole at once for a generation the plot's
    // `PlotAppearScope` saw finish. Its time runs linearly; the marks ease
    // it.
    let appear = Appear {
        time: animated_value(1.0),
        easing: signal(Easing::Linear),
    };
    let appearing = signal(false);
    let shown = computed(move || size.get().width.0 > 0.0);
    let generation = props.appear_generation;
    let memory = appear::AppearMemory::new();
    effect(move || {
        let Some(key) = generation.get() else { return };
        if !shown.get() {
            return;
        }
        let finished = memory.finished(&key);
        let timing = untracked(|| motion.get().and_then(|m| m.appear));
        let time = appear.time;
        match timing {
            Some(timing) if timing.duration_ms > 0.0 && !reduce_motion() && !finished => {
                appear.easing.set(timing.easing);
                time.set(0.0);
                appearing.set(true);
                let linear = Timing {
                    easing: Easing::Linear,
                    ..timing
                };
                let memory = memory.clone();
                spawn(async move {
                    // Stopped by a newer generation: that one ends it.
                    if time.timing_with(1.0, linear).await {
                        memory.finish(&key);
                        appearing.set(false);
                    }
                });
            }
            _ => {
                time.set(1.0);
                appearing.set(false);
                if !finished {
                    memory.finish(&key);
                }
            }
        }
    });

    // The linear axes' moves to new domains, over `motion.update`.
    let (x_tween, y_tween, y2_tween) = (Tween::new(), Tween::new(), Tween::new());
    let update = move || untracked(|| motion.get().and_then(|m| m.update));
    effect(move || x_tween.follow(x_map.get(), update()));
    effect(move || y_tween.follow(y_map.get(), update()));
    effect(move || y2_tween.follow(y2_map.get(), update()));

    // The hover: the row under the pointer, where its parts are and how
    // far they have faded in.
    let cross = point(animated_value(0.0), animated_value(0.0));
    let fade = animated_value(0.0);
    let hovered = signal(None::<u32>);
    let keyed = stored(false);
    let hits = signal(Vec::<Hit>::new());
    let bars = signal(Vec::<BarEntry>::new());
    provide_context(PlotContext {
        rows: data,
        x_values,
        y: props.y,
        x_map,
        xs,
        y_map,
        y2_map,
        x_tween,
        y_tween,
        y2_tween,
        size,
        marks,
        next: stored(0),
        appear,
        appearing,
        motion,
        bars,
        bar_layout: bar::layout(bars),
        cross,
        fade,
        hovered,
        keyed,
        hits,
        insets,
        interactive: props.interactive,
        dot: HoverDot {
            class: props.dot_class,
            style: props.dot_style,
        },
        band_axis,
        color_scale: props.color_scale,
        met: stored((None, Vec::new())),
        cells,
        x_categories,
        y_categories,
        cell_extent: computed(move || {
            cells.with(|all| {
                extent(
                    all.iter()
                        .filter_map(|c| c.values.try_get().flatten())
                        .flat_map(|v| v.to_vec()),
                )
            })
        }),
    });

    let place = TooltipPlace::new(props.tooltip_placement, props.tooltip_offset);
    // `pointer_x`: a radial mark found the row, and the parts follow the
    // pointer rather than the row (`gpui-base`'s pie puts the cross line at
    // the cursor, and `gpui-component`'s pie tooltip follows it). `keys`:
    // the keys or a screen reader moved the hover, which may glide; the
    // pointer's moves land in the same frame.
    let follow = move |index: Option<u32>, pointer_x: Option<f32>, keys: bool| {
        keyed.replace(keys);
        let was = hovered.get_untracked();
        if was == index {
            if let (Some(_), Some(x)) = (index, pointer_x) {
                place.row_at(x);
                cross.x.set(x);
            }
            return;
        }
        hovered.set(index);
        cx.emit(PlotEvent::HoverChange(index));
        let m = motion.get_untracked().unwrap_or_default();
        let still = reduce_motion();
        let Some(index) = index else {
            match m.exit.filter(|_| !still) {
                Some(exit) => drop(fade.timing_with(0.0, exit)),
                None => fade.set(0.0),
            }
            return;
        };
        let (at, across) = match pointer_x {
            Some(x) => (x, false),
            None => {
                let Some(at) = rows_at.with_untracked(|rows| rows.get(index as usize).copied())
                else {
                    return;
                };
                (at, hover_axis.get_untracked() == Axis::Y)
            }
        };
        if !across {
            place.row_at(at);
        }
        // Entering: the parts take the row where they are, then fade in.
        // A step of the keys glides to the next row on the pointer spring
        // (`PlotHover::glide`); the pointer's moves snap to the row under
        // it in the same frame, so the hover never trails the hand.
        let entering = was.is_none();
        let glide = keys && !entering && !still;
        let to = |value: AnimatedValue, target: f32| match m.pointer.filter(|_| glide) {
            Some(spring) => drop(value.spring(target, spring)),
            None => value.set(target),
        };
        match across {
            true => to(cross.y, at),
            false => to(cross.x, at),
        }
        // A mark that finds its rows itself (a dot) on a band y scale: the
        // cross line lies across the plot at the row's band.
        if pointer_x.is_some()
            && hover_axis.get_untracked() == Axis::Y
            && let Some(y) = rows_at
                .with_untracked(|rows| rows.get(index as usize).copied())
                .filter(|y| y.is_finite())
        {
            to(cross.y, y);
        }
        // The dots of the series through the row (bars have none).
        if !across {
            marks.with_untracked(|all| {
                for mark in all {
                    if let Some(p) = mark.near(at) {
                        to(mark.dot_x, p.x.0);
                        to(mark.dot_y, p.y.0);
                    }
                }
            });
        }
        if entering {
            match m.enter.filter(|_| !still) {
                Some(enter) => drop(fade.timing_with(1.0, enter)),
                None => fade.set(1.0),
            }
        }
    };
    // The hovered row's parts stay on it as the rows or the scales change
    // (at once: a domain's move carries them with the marks). Over a
    // radial mark or across, they follow the pointer instead.
    effect(move || {
        rows_at.with(|_| ());
        marks.with(|all| {
            for mark in all {
                let _ = mark.points.try_get();
            }
        });
        let Some(index) = hovered.get_untracked() else {
            return;
        };
        if hover_axis.get_untracked() != Axis::X || hits.with_untracked(|all| !all.is_empty()) {
            return;
        }
        let Some(at) = rows_at
            .with_untracked(|rows| rows.get(index as usize).copied())
            .filter(|at| at.is_finite())
        else {
            return;
        };
        place.row_at(at);
        cross.x.set(at);
        marks.with_untracked(|all| {
            for mark in all {
                if let Some(p) = mark.near(at) {
                    mark.dot_x.set(p.x.0);
                    mark.dot_y.set(p.y.0);
                }
            }
        });
    });
    let interactive = props.interactive;
    // The keyboard (`keys.rs`): the same hover, a row at a time, while the
    // plot has the focus.
    let focused = signal(false);
    let pointer_over = stored(false);
    // Where a radial mark has row `i`'s slice: the parts go to its middle,
    // as the pointer there would put them.
    let radial = move || hits.with_untracked(|all| !all.is_empty());
    let slice_at =
        move |i: u32| hits.with_untracked(|all| all.iter().rev().find_map(|h| (h.center)(i)));
    let placed = move |i: usize| match radial() {
        true => slice_at(i as u32).is_some(),
        false => rows_at.with_untracked(|rows| rows.get(i).is_some_and(|x| x.is_finite())),
    };
    let step_to = move |step: keys::Step| {
        let len = data.with_untracked(|rows| rows.len());
        keys::step(len, placed, hovered.get_untracked(), step)
    };
    let key_to = move |index: Option<u32>| {
        let Some(i) = index else {
            return follow(None, None, true);
        };
        if radial() {
            if let Some(p) = slice_at(i) {
                place.pointer_at(p.y.0);
                follow(Some(i), Some(p.x.0), true);
            }
            return;
        }
        // No pointer to follow: a tooltip beside it goes beside the first
        // series' point at the row, else the plot's middle (bars).
        let Some(at) = rows_at.with_untracked(|rows| rows.get(i as usize).copied()) else {
            return;
        };
        let size = size.get_untracked();
        match hover_axis.get_untracked() {
            Axis::X => {
                let y = marks
                    .with_untracked(|all| all.iter().find_map(|m| m.near(at)))
                    .map_or(size.height.0 / 2.0, |p| p.y.0);
                place.pointer_at(y);
            }
            Axis::Y | Axis::Y2 => {
                let x = size.width.0 / 2.0;
                cross.x.set(x);
                place.row_at(x);
                place.pointer_at(at);
            }
        }
        follow(Some(i), None, true);
    };
    // Left and Right follow the screen: the rows along a reversed x scale
    // run right to left (a pie's slices keep the rows' order).
    let mirrored = move || {
        !radial()
            && hover_axis.get_untracked() == Axis::X
            && x_map.with_untracked(AxisMap::backward)
    };
    // Over a grid of cells, the keys step across it on the screen; screen
    // readers' increment and decrement keep the rows' order.
    let grid = computed(move || hits.with(|all| all.iter().any(|h| h.grid.is_some())));
    let key_step = move |step: keys::Step| {
        let on_grid = hits.with_untracked(|all| all.iter().rev().find_map(|h| h.grid.clone()));
        match on_grid {
            Some(grid) => grid(hovered.get_untracked(), step),
            None => step_to(step),
        }
    };
    keys::bind(
        move || focused.get() && interactive.get(),
        mirrored,
        move || grid.get(),
        hovered,
        key_step,
        key_to,
    );
    // Decided when the plot is made: a sparkline offers none of it and
    // mounts nothing more.
    let actions = interactive.get_untracked().then(|| {
        let action = |name: &str| AccessibilityActionDef {
            name: name.into(),
            label: None,
        };
        vec![action("increment"), action("decrement")]
    });
    let (cross_class, cross_style) = (props.cross_line_class, props.cross_line_style);
    let (dot_class, dot_style) = (props.dot_class, props.dot_style);
    let has_cross = move || cross_class.get().is_some() || cross_style.get() != Style::default();
    let has_dots = move || dot_class.get().is_some() || dot_style.get() != Style::default();
    let tooltip = props.tooltip_content;
    let a11y_value = props.accessibility_value;

    view()
        .accessible(true)
        .role(AccessibilityRole::Image)
        .optional_label(props.accessibility_label)
        .accessibility_value(move || {
            a11y_value.get().map(|v| AccessibilityValue {
                min: v.min.map(|n| n as f32),
                max: v.max.map(|n| n as f32),
                now: v.now.map(|n| n as f32),
                text: v.text.map(|t| std::sync::Arc::from(&*t)),
            })
        })
        .map(|root| match actions {
            // A stop of the keyboard focus that takes no presses: a
            // pressable around it (a card that opens a page) keeps them.
            // Screen readers step through the rows as the arrow keys do.
            Some(actions) => root
                .focusable(move || interactive.get())
                .on_focus(move || focused.set(true))
                .on_blur(move || {
                    focused.set(false);
                    // The keys' hover goes with the focus; the pointer's
                    // stays.
                    if !pointer_over.get() {
                        follow(None, None, true);
                    }
                })
                .accessibility_actions(actions)
                .on_accessibility_action(move |action: &str| {
                    let step = match action {
                        "increment" => keys::Step::Next,
                        "decrement" => keys::Step::Previous,
                        _ => return,
                    };
                    if interactive.get_untracked() {
                        key_to(step_to(step));
                    }
                }),
            None => root,
        })
        .on_layout(move |b: &Bounds<Points>| {
            size.set(b.size);
            place.plot_is(b.size);
        })
        // Hovering, not dragging: a drag leaves the hover where it was.
        .on_mouse_move(move |e: &MouseEvent| {
            if !interactive.get_untracked() || e.pressed_button.is_some() {
                return;
            }
            pointer_over.replace(true);
            place.pointer_at(e.position.y.0);
            // Over a radial mark: the slice under the pointer, if any.
            let found = hits.with_untracked(|all| {
                (!all.is_empty()).then(|| all.iter().rev().find_map(|h| (h.at)(e.position)))
            });
            if let Some(index) = found {
                follow(index, Some(e.position.x.0), false);
                return;
            }
            // Across (bands down the y axis): the rows are found along y,
            // and the tooltip follows the pointer along x.
            let across = hover_axis.get_untracked() == Axis::Y;
            let at = match across {
                true => {
                    cross.x.set(e.position.x.0);
                    place.row_at(e.position.x.0);
                    e.position.y.0
                }
                false => e.position.x.0,
            };
            let nearest = rows_at.with_untracked(|rows| {
                rows.iter()
                    .enumerate()
                    .filter(|(_, x)| x.is_finite())
                    .min_by(|(_, a), (_, b)| (*a - at).abs().total_cmp(&(*b - at).abs()))
                    .map(|(i, _)| i as u32)
            });
            follow(nearest, None, false);
        })
        .on_mouse_leave(move |_: &MouseEvent| {
            pointer_over.replace(false);
            follow(None, None, false);
        })
        .child(props.children)
        // The hover's parts, over the marks; they take no pointer, so the
        // plot keeps the hover.
        .child(when(
            move || interactive.get() && has_cross(),
            move || {
                // As wide as a band on a band scale (none otherwise), its
                // middle on the row.
                let band = move || {
                    match hover_axis.get() {
                        Axis::X => x_map.get().band(),
                        Axis::Y | Axis::Y2 => y_map.get().band(),
                    }
                    .map_or(0.0, |b| b.width())
                };
                let line = move || view().app_class(cross_class).inline_style(cross_style);
                when(
                    move || hover_axis.get() == Axis::X,
                    move || {
                        anchor(&x_tween.shown(&cross.x), &fade)
                            .top(px(0.0))
                            .bottom(px(0.0))
                            .style_with(move |s| s.w(px(band())))
                            .child(line().h_full())
                    },
                )
                .otherwise(move || {
                    // Across the plot, at the row along the y axis.
                    view()
                        .absolute()
                        .left(px(0.0))
                        .right(px(0.0))
                        .top(px(0.0))
                        .items_center()
                        .justify_center()
                        .pointer_events(PointerEvents::None)
                        .translate_y(relative(-0.5))
                        .bind_translate_y(&cross.y)
                        .bind_opacity(&fade)
                        .style_with(move |s| s.h(px(band())))
                        .child(line().w_full())
                })
            },
        ))
        // A dot per series, styled by the mark (`hoverDotClass` /
        // `hoverDotStyle`) or else by the plot (`dotClass` / `dotStyle`);
        // none where neither styles one, and none for bars.
        .child(when(
            move || interactive.get(),
            move || {
                // Keyed by the scale too: a mark that moves to the other y
                // scale gets a dot that moves with that one's domain.
                each(
                    move || {
                        marks.with(|all| {
                            all.iter()
                                .map(|m| (*m, m.value_axis.get()))
                                .collect::<Vec<_>>()
                        })
                    },
                    |(m, axis)| (m.key, *axis),
                    move |mark, _| {
                        let (m, axis) = mark.get_untracked();
                        let y_tween = match axis {
                            Axis::Y2 => y2_tween,
                            _ => y_tween,
                        };
                        let own: Option<HoverDot> = m.dot;
                        let own_style =
                            move || own.is_some_and(|o| o.style.with(|s| *s != Style::default()));
                        when(
                            move || own.is_some_and(|o| has_dots() || o.is_set()),
                            move || {
                                let (x, y) = (x_tween.shown(&m.dot_x), y_tween.shown(&m.dot_y));
                                dot_anchor(&x, &y, &fade).child(
                                    view()
                                        .flex_none()
                                        .app_class(move || {
                                            own.and_then(|o| o.class.get())
                                                .or_else(|| dot_class.get())
                                        })
                                        .inline_style(move || match own {
                                            Some(o) if own_style() => o.style.get(),
                                            _ => dot_style.get(),
                                        }),
                                )
                            },
                        )
                    },
                )
            },
        ))
        // Along the row's x (moving with the x scale's domain), or across,
        // the pointer's.
        .child(when(
            move || interactive.get() && tooltip.get().is_some(),
            move || {
                when(
                    move || hover_axis.get() == Axis::X,
                    move || place.view(&x_tween.shown(&cross.x), &fade, tooltip.place(|t| t)),
                )
                .otherwise(move || place.view(&cross.x, &fade, tooltip.place(|t| t)))
            },
        ))
}

/// Where a plot's tooltip goes (`tooltipPlacement`, `tooltipOffset`), kept
/// inside the plot: between its left and right edges for `"top"` (its
/// offset from the top edge is the app's, a tag under the plot too), and
/// its edges all round for `"pointer"`. The layout puts the tooltip on a
/// side of a point with no size (its margins the offset), and the animator
/// moves that point to the cross line (and the pointer) and clamps it, from
/// the plot's size and the tooltip's, which the layout sets as animated
/// values: no JS runs as the pointer moves, and the clamp follows the cross
/// line's glide.
#[derive(Clone, Copy)]
struct TooltipPlace {
    placement: Prop<TooltipPlacement>,
    offset: Prop<Points>,
    /// Where the point goes along y before the clamp: the pointer for
    /// `"pointer"` (the top edge for `"top"`); along x it goes to the cross
    /// line ([`Self::view`]'s `x`).
    y: AnimatedValue,
    plot: Size<AnimatedValue>,
    tooltip: Size<AnimatedValue>,
    /// The tooltip goes left of the cross line, above the pointer (the
    /// plot's right and lower halves, for `"pointer"`).
    flip: Point<Signal<bool>>,
    /// The size of the plot, to tell its halves apart.
    size: Stored<Size<Points>>,
    /// The terms the clamp takes from the placement ([`Self::new`]).
    terms: [AnimatedValue; 6],
}

impl TooltipPlace {
    fn new(placement: Prop<TooltipPlacement>, offset: Prop<Points>) -> Self {
        let value = || animated_value(0.0);
        let place = Self {
            placement,
            offset,
            y: value(),
            plot: size(value(), value()),
            tooltip: size(value(), value()),
            flip: point(signal(false), signal(false)),
            size: stored(Size::default()),
            terms: [value(), value(), value(), value(), value(), value()],
        };
        // What the clamp takes from the placement: how far the tooltip's
        // width moves it from the point (`shift`, -1/2 to center it), and
        // where its box starts from the point along each axis, as a share
        // of its size and an offset (the box starts at `-(share * size +
        // offset)`, as its margins and the alignment place it); and whether
        // it follows the pointer, whose y is clamped (`pointer`, 1 or 0).
        let [shift, share_x, off_x, share_y, off_y, pointer] = place.terms;
        effect(move || {
            let off = offset.get().0;
            let side = |flipped: bool| match flipped {
                true => (1.0, off),
                false => (0.0, -off),
            };
            let (s, (sx, ox), (sy, oy), p) = match placement.get() {
                TooltipPlacement::Top => (-0.5, (0.0, 0.0), (0.0, -off), 0.0),
                TooltipPlacement::Pointer => {
                    (0.0, side(place.flip.x.get()), side(place.flip.y.get()), 1.0)
                }
            };
            for (value, v) in [
                (shift, s),
                (share_x, sx),
                (off_x, ox),
                (share_y, sy),
                (off_y, oy),
                (pointer, p),
            ] {
                value.set(v);
            }
        });
        place
    }

    /// The plot has `size`.
    fn plot_is(&self, size: Size<Points>) {
        self.size.replace(size);
        self.plot.width.set(size.width.0);
        self.plot.height.set(size.height.0);
    }

    /// The hover is at the row at `x` (where the cross line goes).
    fn row_at(&self, x: f32) {
        let right = x > self.size.get().width.0 / 2.0;
        if self.flip.x.get_untracked() != right {
            self.flip.x.set(right);
        }
    }

    /// The pointer is at `y`.
    fn pointer_at(&self, y: f32) {
        if self.placement.get_untracked() != TooltipPlacement::Pointer {
            return;
        }
        self.y.set(y);
        let lower = y > self.size.get().height.0 / 2.0;
        if self.flip.y.get_untracked() != lower {
            self.flip.y.set(lower);
        }
    }

    /// `at` clamped so that a box of `extent` starting `-(share * extent +
    /// offset)` from it stays within `0..room`: `lo + clamp01((at - lo) /
    /// (room - extent)) * (room - extent)`, `lo` the least `at`.
    fn clamped(
        at: &impl Animated,
        room: AnimatedValue,
        extent: AnimatedValue,
        share: AnimatedValue,
        offset: AnimatedValue,
    ) -> AnimatedNode {
        let range = room.sub(&extent);
        let lo = extent.mul(&share).add(&offset);
        let t = at
            .animated_node()
            .sub(&lo)
            .div(&range)
            .interpolate(&[0.0, 1.0], &[0.0, 1.0]);
        lo.add(&t.mul(&range))
    }

    /// The tooltip, faded by `fade`, holding `content`: a point with no
    /// size the animator places (along x at `x`, the cross line), the
    /// content on its side of it.
    fn view(self, x: &impl Animated, fade: &AnimatedValue, content: impl IntoElement) -> View {
        let [shift, share_x, off_x, share_y, off_y, pointer] = self.terms;
        let want_x = x.animated_node().add(&self.tooltip.width.mul(&shift));
        let x = Self::clamped(&want_x, self.plot.width, self.tooltip.width, share_x, off_x);
        // At the top edge for `"top"`: its offset there is the app's.
        let y = Self::clamped(
            &self.y,
            self.plot.height,
            self.tooltip.height,
            share_y,
            off_y,
        )
        .mul(&pointer);
        let (placement, offset, flip, tooltip) =
            (self.placement, self.offset, self.flip, self.tooltip);
        // A row with no size whose item does not shrink: the content keeps
        // its own size and overflows the point on the side the alignment
        // gives it, its margins away from it.
        view()
            .absolute()
            .left(px(0.0))
            .top(px(0.0))
            .w(px(0.0))
            .h(px(0.0))
            .flex_row()
            .pointer_events(PointerEvents::None)
            .bind_translate_x(&x)
            .bind_translate_y(&y)
            .bind_opacity(fade)
            .style_with(move |s| {
                let pointer = placement.get() == TooltipPlacement::Pointer;
                let s = match pointer && flip.x.get() {
                    true => s.justify_end(),
                    false => s.justify_start(),
                };
                match pointer && flip.y.get() {
                    true => s.items_end(),
                    false => s.items_start(),
                }
            })
            .child(
                view()
                    .flex_none()
                    .on_layout(move |b: &Bounds<Points>| {
                        tooltip.width.set(b.size.width.0);
                        tooltip.height.set(b.size.height.0);
                    })
                    .style_with(move |s| {
                        let off = offset.get();
                        if placement.get() == TooltipPlacement::Top {
                            return s.mt(off);
                        }
                        let s = match flip.x.get() {
                            true => s.mr(off),
                            false => s.ml(off),
                        };
                        match flip.y.get() {
                            true => s.mb(off),
                            false => s.mt(off),
                        }
                    })
                    .child(content),
            )
    }
}

/// The cross line's anchor: a column with its middle at `x` (as wide as
/// its caller makes it: none, or a band), faded by `fade`, its content
/// centered in it; it takes no pointer.
fn anchor(x: &impl Animated, fade: &AnimatedValue) -> View {
    view()
        .absolute()
        .left(px(0.0))
        .top(px(0.0))
        .items_center()
        .justify_center()
        .pointer_events(PointerEvents::None)
        .translate_x(relative(-0.5))
        .bind_translate_x(x)
        .bind_opacity(fade)
}

/// A hover dot's place: a box the size of the dot it holds, its center at
/// (`x`, `y`) (moved back by half its size, then by the animated point),
/// faded by `fade`; it takes no pointer.
fn dot_anchor(x: &impl Animated, y: &impl Animated, fade: &impl Animated) -> View {
    view()
        .absolute()
        .left(px(0.0))
        .top(px(0.0))
        .pointer_events(PointerEvents::None)
        .translate_x(relative(-0.5))
        .translate_y(relative(-0.5))
        .bind_translate_x(x)
        .bind_translate_y(y)
        .bind_opacity(fade)
}

/// A mark's layer: it fills the plot.
fn layer() -> View {
    view().absolute().inset(px(0.0))
}

/// Room a mark's canvas keeps past the plot's edges for its strokes: a
/// stroke centred on an edge (a line through the domain's highest value,
/// a grid line at its end) is half outside the plot, and a canvas draws
/// nothing outside itself. Strokes up to twice this wide draw whole.
const STROKE_ROOM: f32 = 8.0;

/// How far what a mark traces through `points` reaches past the plot's
/// top and bottom edges (`height` apart): a smooth curve swings past its
/// highest and lowest points, never past its control points.
fn reach(points: &[Point<Points>], curve: Curve, height: f32) -> f32 {
    let mut over = 0.0_f32;
    let mut take = |y: f32| over = over.max(-y).max(y - height);
    for q in points {
        take(q.y.0);
    }
    if curve == Curve::Natural {
        let n = points.len();
        for i in 0..n.saturating_sub(1) {
            let p0 = points[i.saturating_sub(1)];
            let (p1, p2) = (points[i], points[i + 1]);
            let p3 = points[(i + 2).min(n - 1)];
            take(p1.y.0 + (p2.y.0 - p0.y.0) / 6.0);
            take(p2.y.0 - (p3.y.0 - p1.y.0) / 6.0);
        }
    }
    over
}

/// A mark's canvas: the plot's area and `bleed()` points around it (half
/// its strokes and its curves' swing past the plot's edges, which a
/// canvas the size of the plot would cut off), its drawing in the plot's
/// coordinates. It takes no pointer: the plot follows it. Before the
/// plot's first layout it draws nothing.
fn mark_canvas(
    plot: Option<PlotContext>,
    bleed: impl Fn() -> f32 + Copy + 'static,
    draw: impl Fn(Painter, f32) -> Painter + 'static,
) -> CanvasView {
    mark_canvas_with(plot, bleed, Painter::new, draw)
}

/// [`mark_canvas`], recording `before_layout()` before the plot's first
/// layout.
fn mark_canvas_with(
    plot: Option<PlotContext>,
    bleed: impl Fn() -> f32 + Copy + 'static,
    before_layout: impl Fn() -> Painter + 'static,
    draw: impl Fn(Painter, f32) -> Painter + 'static,
) -> CanvasView {
    // A terminal lays the canvas out in whole Cells: an inset of a few
    // points past the plot rounds to none on one side and a Cell on the
    // other, so the drawing, moved by the bleed, would reach into the
    // padding beside the plot. Its dots cut nothing a stroke's half would
    // show, so there the canvas is the plot's area.
    let bleed = move || {
        if crate::terminal::is_terminal() {
            0.0
        } else {
            bleed()
        }
    };
    canvas(move || {
        if plot.is_some_and(|plot| !plot.is_sized()) {
            return before_layout();
        }
        let b = bleed();
        draw(Painter::new().translate(b, b), b)
    })
    .absolute()
    .pointer_events(PointerEvents::None)
    // Typed, so the app's inline style of a part's canvas (an area's
    // background) is its own.
    .style_with(move |s| {
        let b = px(-bleed());
        s.left(b).top(b).right(b).bottom(b)
    })
}

#[cfg(test)]
mod tests {
    use nsh_core::geometry::{point, px};

    use super::{Curve, reach};

    /// What a mark draws past the plot's top and bottom edges: nothing for
    /// straight segments inside it; a smooth curve that rises to the top
    /// edge and levels off there swings above it, so its canvas reaches
    /// further.
    #[test]
    fn a_curve_through_an_edge_reaches_past_it() {
        let pts = |ys: &[f32]| {
            ys.iter()
                .enumerate()
                .map(|(i, y)| point(px(i as f32 * 10.0), px(*y)))
                .collect::<Vec<_>>()
        };
        let rise = pts(&[100.0, 50.0, 0.0, 0.0]);
        assert_eq!(reach(&rise, Curve::Linear, 100.0), 0.0);
        assert_eq!(reach(&rise, Curve::StepAfter, 100.0), 0.0);
        let swing = reach(&rise, Curve::Natural, 100.0);
        assert!((swing - 50.0 / 6.0).abs() < 1e-4, "{swing}");
        // Points outside the plot (a domain narrower than the data) count.
        assert_eq!(reach(&pts(&[-5.0, 50.0]), Curve::Linear, 100.0), 5.0);
        assert_eq!(reach(&pts(&[]), Curve::Natural, 100.0), 0.0);
    }
}
