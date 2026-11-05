//! `Dot`: a series drawn as a dot per row, at the row's place and value: a
//! scatter plot's points, a bubble chart's bubbles (a radius per row, area
//! in proportion to a value), a dot plot's marks, a lollipop's head.

use std::sync::Arc;

use nsh_core::{
    SvgPaint,
    element::{
        JsHost, JsIn, JsKind, JsOwned, JsValue, PropError, RowAccessor, RowText, Style, TsTypes,
    },
    prelude::*,
};

use super::{
    Axis, PlotContext, STROKE_ROOM, ValueScale,
    bar::grown,
    dot_anchor, layer, mark_canvas,
    pie::{Pose, Update, Var},
    scale::{AxisMap, extent},
    series::{self, HoverDot, Mark},
};

/// How big a [`Dot`]'s dots are (`r`; TS `number | Extract<keyof T,
/// string> | ((d: T, index: number) => number)`): one radius for every row
/// (SVG's `<circle r>`), or a value of each row, read as [`RowAccessor`]
/// reads the dots' values, which the dot's `rScale` makes a radius (the
/// value is the radius without one): a bubble's market cap, a city's
/// population.
#[derive(Debug, Clone, PartialEq)]
pub enum DotRadius {
    /// The radius of every dot.
    Points(Points),
    /// A value of each row: a field name or a function of the row and its
    /// index.
    Row(RowAccessor),
}

impl Default for DotRadius {
    /// 3 points, Observable Plot's dot's.
    fn default() -> Self {
        DotRadius::Points(Points(3.0))
    }
}

impl DotRadius {
    /// What reads each row's value.
    fn row(&self) -> Option<RowAccessor> {
        match self {
            DotRadius::Row(accessor) => Some(accessor.clone()),
            DotRadius::Points(_) => None,
        }
    }
}

impl From<Points> for DotRadius {
    fn from(radius: Points) -> Self {
        DotRadius::Points(radius)
    }
}

impl From<RowAccessor> for DotRadius {
    fn from(accessor: RowAccessor) -> Self {
        DotRadius::Row(accessor)
    }
}

impl From<&str> for DotRadius {
    fn from(key: &str) -> Self {
        DotRadius::Row(key.into())
    }
}

impl JsValue for DotRadius {
    fn ts_type(types: &mut TsTypes) -> String {
        format!("number | {}", RowAccessor::ts_type(types))
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        match value.kind() {
            JsKind::Number => f32::from_js(value).map(|r| DotRadius::Points(Points(r))),
            JsKind::String | JsKind::Function => RowAccessor::from_js(value).map(DotRadius::Row),
            _ => Err(value.expected("a number, a field name or a function of a row")),
        }
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            DotRadius::Points(r) => r.0.to_js(host),
            DotRadius::Row(accessor) => accessor.to_js(host),
        }
    }
}

/// How a [`Dot`]'s values of `r` become radii (`rScale`; TS `{ type:
/// "sqrt", domain?, range }`), as d3's `scaleSqrt` (and Observable Plot's
/// `r` scale) map them: the square roots of the `domain` onto the `range`
/// of radii, so with a range from 0 a dot's area is in proportion to its
/// value, as a bubble's should be; a range from more than 0 keeps the
/// smallest dots in sight and the differences between all of them. The
/// domain is 0 to the largest value without one; values outside it take
/// the range's ends.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct RadiusScale {
    /// The values the range's ends stand for; 0 to the largest value
    /// without one.
    pub domain: Option<[f64; 2]>,
    /// The radii of the domain's ends.
    pub range: [Points; 2],
}

impl Default for RadiusScale {
    /// Radii from 0 to 3 points (the default radius) over 0 to the largest
    /// value.
    fn default() -> Self {
        Self {
            domain: None,
            range: [Points(0.0), Points(3.0)],
        }
    }
}

impl RadiusScale {
    /// The scale of the values' square roots onto radii from `min` to
    /// `max`.
    pub fn new(min: Points, max: Points) -> Self {
        Self {
            domain: None,
            range: [min, max],
        }
    }

    /// The same scale, over `domain`.
    pub fn domain(mut self, domain: [f64; 2]) -> Self {
        self.domain = Some(domain);
        self
    }

    /// The radius of `value` over `domain` (d3's signed square root, so a
    /// domain through 0 keeps its order); `NaN` for no value. A domain of
    /// one value puts it in the middle of the range, as d3 does.
    fn radius(&self, value: f64, domain: [f64; 2]) -> f32 {
        if !value.is_finite() {
            return f32::NAN;
        }
        let root = |v: f64| v.signum() * v.abs().sqrt();
        let (lo, hi) = (root(domain[0]), root(domain[1]));
        let t = match hi - lo {
            d if d == 0.0 || !d.is_finite() => 0.5,
            d => ((root(value) - lo) / d).clamp(0.0, 1.0),
        };
        let [a, b] = self.range;
        (a.0 + (b.0 - a.0) * t as f32).max(0.0)
    }
}

impl JsValue for RadiusScale {
    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("RadiusScale", |_| {
            "/** How a `Dot`'s values of `r` become radii, as d3's `scaleSqrt`: the square roots of the `domain` (0 to the largest value without one) onto the `range` of radii in points, so a range from 0 makes each dot's area in proportion to its value. Values outside the domain take the range's ends. */\nexport type RadiusScale = { type: \"sqrt\"; domain?: [number, number]; range: [number, number] };\n".to_owned()
        })
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        let kind = value.field("type")?;
        if kind.get().as_string().as_deref() != Some("sqrt") {
            return Err(value.expected("`{ type: \"sqrt\", range }`"));
        }
        let pair = |key: &str, what: &str| -> Result<Option<[f64; 2]>, PropError> {
            let field = value.field(key)?;
            let field = field.get();
            if field.is_nullish() {
                return Ok(None);
            }
            match Vec::<f64>::from_js(field)?[..] {
                [a, b] if a.is_finite() && b.is_finite() => Ok(Some([a, b])),
                _ => Err(PropError(format!("`{key}`: {what}"))),
            }
        };
        let domain = pair("domain", "two finite numbers, `[min, max]`")?;
        let range = pair("range", "two radii, `[min, max]`")?
            .filter(|[a, b]| *a >= 0.0 && *b >= 0.0)
            .ok_or_else(|| PropError("`range`: two radii of 0 or more, `[min, max]`".to_owned()))?;
        Ok(RadiusScale {
            domain,
            range: range.map(|r| Points(r as f32)),
        })
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        let object = JsOwned::new(host, host.new_object()?);
        let raw = object.get().raw();
        host.set_field(raw, "type", host.new_string("sqrt")?)?;
        if let Some([a, b]) = self.domain {
            let ends = vec![a, b].to_js(host)?;
            host.set_field(raw, "domain", ends.into_raw())?;
        }
        let ends = self.range.iter().map(|r| r.0 as f64).collect::<Vec<_>>();
        host.set_field(raw, "range", ends.to_js(host)?.into_raw())?;
        Ok(object)
    }
}

/// The props of [`Dot`].
#[derive(Debug, Clone, PartialEq, Props)]
#[props(generic)]
pub struct DotProps {
    /// Where each dot goes along the value axis (Observable Plot's `y`, as
    /// [`Rule`]'s `value`): a field name, or a function of the row and its
    /// index; the plot's `y` without. A row without a value has no dot.
    ///
    /// [`Rule`]: super::Rule
    pub value: Prop<Option<RowAccessor>>,
    /// The dots' radius (SVG's `<circle r>`, Observable Plot's `r`): a
    /// number of points for every dot (3 by default), or a field name or a
    /// function of the row and its index, a value per row, which `rScale`
    /// makes a radius (the value is the radius without one). A row whose
    /// value is missing has no dot. With a radius per row, the bigger
    /// dots draw first, so the smaller ones stay in sight over them.
    #[prop(default)]
    pub r: Prop<DotRadius>,
    /// How the values of `r` become radii: `{ type: "sqrt", domain?, range
    /// }` (d3's `scaleSqrt`), a dot's area in proportion to its value with
    /// a range from 0; none by default, the values are radii.
    pub r_scale: Prop<Option<RadiusScale>>,
    /// How its dots appear one after another (as `Bar`'s `stagger`, 0 to
    /// 0.95): the share of the plot's appear over which they start, row by
    /// row, each growing from nothing for the rest of it; 0 (the default)
    /// grows them together.
    #[prop(default)]
    pub stagger: Prop<Percentage>,
    /// The opacity of its other dots while the pointer (or the keys) is on
    /// one of them: faded in and out with the hover; none by default.
    pub inactive_opacity: Prop<Option<Percentage>>,
    /// The category of each dot, which the plot's `colorScale` gives a
    /// color (as `Bar`'s `color`): a field name or a function of the row and
    /// its index. That color is the dot's `fill` where nothing sets one, in
    /// place of `currentColor`, so the app's `fill-*` classes and `fill`
    /// style win.
    pub color: Prop<Option<RowText>>,
    /// How far past a dot's edge the pointer still finds it (Observable
    /// Plot's pointer `maxRadius`, measured from the edge here so a big
    /// bubble is found all over): of the dots within this distance, the
    /// pointer finds the one whose center is nearest (Voronoi's cells), so
    /// a small bubble over a big one is found around its own center. 8
    /// points by default.
    #[prop(default = Points(8.0))]
    pub hit_radius: Prop<Points>,
    /// The y scale its values go along: `"y"` (the default, the plot's
    /// `yScale`) or `"y2"` (its second one, `y2Scale`: a dual-axis chart's
    /// right-hand scale). Dots across a band y scale put their values
    /// along x whatever this says.
    #[prop(default)]
    pub scale: Prop<ValueScale>,
    /// The Tailwind classes of its hover dot, the `hoverDot` part: a view
    /// as big as the dot under the pointer (its diameter wide and tall),
    /// centered on it, its corners, border, outline and background the
    /// app's (`rounded-full outline-2 outline-background`, a ring that
    /// lifts the dot out of the ones it overlaps); the plot's `dotClass`
    /// where none is set. None where neither styles one.
    pub hover_dot_class: Prop<Option<SharedString>>,
    /// The style of its hover dot, over `hoverDotClass`; the plot's
    /// `dotStyle` where none is set.
    #[prop(default)]
    pub hover_dot_style: Prop<Style>,
}

/// A row's dot as the app sets it: where it goes, in the plot's values
/// (its `x` on a linear x scale, else `NaN`: placed by its index), and its
/// radius in points (`NaN`: none).
#[derive(Debug, Clone, Copy, PartialEq)]
struct Spot {
    x: f64,
    value: f64,
    r: f32,
}

impl Spot {
    fn shown(&self) -> bool {
        self.value.is_finite() && self.r.is_finite()
    }
}

/// The dots as the app sets them, one per row: what the plot's
/// `motion.update` moves between, in the plot's values, so that a new
/// size moves nothing and a new domain moves the dots with the scales.
#[derive(Debug, Clone, Default, PartialEq)]
struct DotPose(Arc<[Spot]>);

impl Pose for DotPose {
    fn lerp(&self, to: &Self, t: f32) -> Self {
        let none = Spot {
            x: f64::NAN,
            value: f64::NAN,
            r: f32::NAN,
        };
        let len = self.0.len().max(to.0.len());
        let spots = (0..len).map(|i| {
            let (a, b) = (
                self.0.get(i).copied().unwrap_or(none),
                to.0.get(i).copied().unwrap_or(none),
            );
            match (a.shown(), b.shown()) {
                (true, true) => Spot {
                    x: a.x + (b.x - a.x) * t as f64,
                    value: a.value + (b.value - a.value) * t as f64,
                    r: a.r + (b.r - a.r) * t,
                },
                (false, true) => Spot { r: b.r * t, ..b },
                (true, false) => Spot {
                    r: a.r * (1.0 - t),
                    ..a
                },
                (false, false) => none,
            }
        });
        DotPose(spots.collect())
    }
}

/// A dot as drawn: its row, its center and radius on the plot (at rest,
/// the pose moved to).
#[derive(Debug, Clone, Copy, PartialEq)]
struct Placed {
    row: usize,
    x: f32,
    y: f32,
    r: f32,
}

/// Where the rows of `pose` go on the plot's scales (their values on the y
/// scale `scale` names), in drawing order: the bigger dots first.
fn placed(plot: PlotContext, pose: &DotPose, scale: ValueScale) -> Vec<Placed> {
    let (x_map, y_map) = (plot.x_map.get(), plot.y_map.get());
    let values_y = plot.y_map_of(scale);
    let across = matches!(y_map, AxisMap::Band(_)) && !matches!(x_map, AxisMap::Band(_));
    let mut out: Vec<Placed> = pose
        .0
        .iter()
        .enumerate()
        .filter(|(_, s)| s.shown())
        .filter_map(|(row, s)| {
            let along = |map: AxisMap| match (map, s.x.is_finite()) {
                (AxisMap::Linear(_), true) => map.tick(s.x),
                _ => map.tick(row as f64),
            };
            let (x, y) = match across {
                true => (x_map.tick(s.value)?, along(y_map)?),
                false => (along(x_map)?, values_y.tick(s.value)?),
            };
            Some(Placed { row, x, y, r: s.r })
        })
        .collect();
    out.sort_by(|a, b| b.r.total_cmp(&a.r));
    out
}

/// The dot nearest to `at` among `dots`, by the distance to its center (a
/// Voronoi cell's, Observable Plot's pointer): a small bubble over a big
/// one is found from around its own center, as close as its neighbours
/// let it be. Only dots whose edge is `reach` from `at` at most count; on
/// a tie, the one drawn last (on top).
fn dot_at(dots: &[Placed], at: Point<Points>, reach: f32) -> Option<u32> {
    let center = |d: &Placed| (d.x - at.x.0).hypot(d.y - at.y.0);
    dots.iter()
        .rev()
        .filter(|d| center(d) - d.r <= reach)
        .min_by(|a, b| center(a).total_cmp(&center(b)))
        .map(|d| d.row as u32)
}

/// A series of a [`Plot`](super::Plot) drawn as a dot per row (Observable
/// Plot's `dot`, Vega-Lite's `point` and `circle`): at the row's place
/// along the x axis (its `x` on a linear x scale: a scatter plot; the
/// middle of its band on a band scale) and its `value` along the y axis,
/// or across, down a band y scale, its value along x (a dot plot). Its
/// radius is `r`, one for every dot or one per row (a bubble chart, the
/// area in proportion to a value with `rScale`), the bigger dots drawn
/// first. It fills with its `fill` (`fill-*` classes; inherited from the
/// plot as CSS inherits it), `currentColor` where none is set (with
/// `color`, each dot's category's color of the plot's `colorScale`
/// instead), and strokes with its `stroke` where one is set (`stroke-*`,
/// `strokeWidth`: a ring around each dot). Its values count in the value
/// scale's domain when the plot has none (without 0: a scatter's axes fit
/// its points). The pointer finds the dot whose center is nearest to it,
/// among those within `hitRadius` of their edge, which the plot reports (`onHoverChange`) and marks with
/// the `hoverDot` part, as big as that dot; the keys and screen readers
/// step through the dots in the rows' order. With the plot's appear, its
/// dots grow from nothing (one after another with `stagger`); with
/// `motion.update`, they move to new values and sizes, new rows' dots grow
/// in and the dots of rows that are gone shrink away; while one is
/// hovered, the others fade to `inactiveOpacity`; all on the platform's
/// animator, with no mark drawn again.
#[component]
pub fn Dot(props: DotProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let Some(plot) = PlotContext::of("Dot") else {
        return layer();
    };
    let (accessor, r, r_scale, scale) = (props.value, props.r, props.r_scale, props.scale);
    let rows = move || plot.rows.get();
    let values = series::values(rows, move || accessor.get().or_else(|| plot.y.get()));
    let sizes = series::values(rows, move || r.with(DotRadius::row));
    // Along the axis without bands.
    let value_axis = computed(move || match plot.band_axis.get() {
        Some(Axis::Y) => Axis::X,
        _ => Axis::from(scale.get()),
    });
    plot.add(move |key| Mark {
        key,
        extent: computed(move || values.with(|v| extent(v.as_deref()?.iter().copied()))),
        value_axis,
        points: computed(|| Arc::from([])),
        dot_x: animated_value(0.0),
        dot_y: animated_value(0.0),
        dot: None,
    });

    // The dots as the app sets them, which `motion.update` moves between.
    let update = Update::new(plot, move || {
        let Some(values) = values.get() else {
            return DotPose::default();
        };
        let xs = plot.x_values.get();
        let (radius, sizes) = (r.get(), sizes.get());
        // A radius per row waits for its values.
        if matches!(radius, DotRadius::Row(_)) && sizes.is_none() {
            return DotPose::default();
        }
        let scale = r_scale.get();
        let domain = sizes.as_deref().and_then(|s| {
            let scale = scale.as_ref()?;
            scale
                .domain
                .or_else(|| extent(s.iter().copied()).map(|[_, hi]| [0.0, hi]))
        });
        let radius_of = |row: usize| match &radius {
            DotRadius::Points(r) => r.0,
            DotRadius::Row(_) => {
                let v = sizes.as_deref().and_then(|s| s.get(row)).copied();
                let v = v.unwrap_or(f64::NAN);
                match (&scale, domain) {
                    (Some(scale), Some(domain)) => scale.radius(v, domain),
                    _ if v.is_finite() && v >= 0.0 => v as f32,
                    _ => f32::NAN,
                }
            }
        };
        let spots = values.iter().enumerate().map(|(row, &value)| Spot {
            x: xs
                .as_deref()
                .and_then(|xs| xs.get(row))
                .copied()
                .unwrap_or(f64::NAN),
            value,
            r: radius_of(row),
        });
        DotPose(spots.collect())
    });
    // Where the dots are at rest: what the pointer finds, where the hover
    // dot goes.
    let rest = computed(move || -> Arc<[Placed]> {
        if !plot.is_sized() {
            return Arc::from([]);
        }
        update.shown().0.with_placed(plot, scale.get())
    });
    let hit = props.hit_radius;
    plot.add_hit(
        move |at| rest.with_untracked(|dots| dot_at(dots, at, hit.get_untracked().0)),
        move |row| {
            rest.with_untracked(|dots| {
                let d = dots.iter().find(|d| d.row == row as usize)?;
                Some(point(px(d.x), px(d.y)))
            })
        },
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
    let colors = series::colors(plot, rows, props.color);
    let canvas = mark_canvas(
        Some(plot),
        move || {
            let (to, from) = update.shown();
            let widest = |pose: &DotPose| pose.0.iter().map(|s| s.r).fold(0.0_f32, f32::max);
            let r = widest(&to).max(from.as_ref().map_or(0.0, |(f, _)| widest(f)));
            STROKE_ROOM + r.ceil()
        },
        move |p, _| {
            let colors = colors.get();
            let p = p
                .stroke_style_from_view(SvgPaint::None)
                .line_width_from_view()
                .line_dash_from_view();
            let mut p = match &colors {
                None => p.fill_style_from_view(SvgPaint::CurrentColor),
                Some(_) => p,
            };
            let (to, from) = update.shown();
            let to_at = to.with_placed(plot, scale.get());
            let from_at = from
                .as_ref()
                .map(|(f, q)| (f.with_placed(plot, scale.get()), q));
            let len = to.0.len().max(from.as_ref().map_or(0, |(f, _)| f.0.len()));
            let appearing = plot.appearing.get();
            let dim = inactive
                .get()
                .map(|o| 1.0 - o.0.clamp(0.0, 1.0))
                .filter(|d| *d > 0.0 && plot.interactive.get());
            let y_tween = plot.y_tween_of(scale.get());
            let (x_moving, y_moving) = (plot.x_tween.moving.get(), y_tween.moving.get());
            let shown = |tween: super::tween::Tween, moving: bool, at: Var| match moving {
                true => {
                    let (scale, offset) = tween.transform();
                    at.mul(&Var::Node(scale)).add(&Var::Node(offset))
                }
                false => at,
            };
            // The dots in the order they draw: those at rest (bigger
            // first), then those of rows that are gone, shrinking away.
            let mut order: Vec<usize> = to_at.iter().map(|d| d.row).collect();
            if let Some((from_at, _)) = &from_at {
                for d in from_at.iter() {
                    if !order.contains(&d.row) {
                        order.push(d.row);
                    }
                }
            }
            let find = |dots: &[Placed], row: usize| dots.iter().find(|d| d.row == row).copied();
            for row in order {
                let target = find(&to_at, row);
                let (x, y, radius) = match (&from_at, target) {
                    (None, Some(t)) => (Var::Const(t.x), Var::Const(t.y), Var::Const(t.r)),
                    (None, None) => continue,
                    (Some((from_at, q)), target) => {
                        let q = Var::Node(**q);
                        let lerp = |a: f32, b: f32| Var::Const(b - a).mul(&q).add(&Var::Const(a));
                        match (find(from_at, row), target) {
                            (Some(f), Some(t)) => (lerp(f.x, t.x), lerp(f.y, t.y), lerp(f.r, t.r)),
                            (None, Some(t)) => (Var::Const(t.x), Var::Const(t.y), lerp(0.0, t.r)),
                            (Some(f), None) => (Var::Const(f.x), Var::Const(f.y), lerp(f.r, 0.0)),
                            (None, None) => continue,
                        }
                    }
                };
                let radius = match appearing {
                    true => radius.mul(&Var::Node(grown(plot, row, len, stagger.get()))),
                    false => radius,
                };
                let (x, y) = (
                    shown(plot.x_tween, x_moving, x),
                    shown(y_tween, y_moving, y),
                );
                if let Some(dim) = dim {
                    // `1 - fade * dim` away from the hovered row.
                    let c = row as f32;
                    let away = hovered_at.interpolate(&[c - 1.0, c, c + 1.0], &[dim, 0.0, dim]);
                    p = p.global_alpha(&away.mul(&plot.fade).mul(-1.0).add(1.0));
                }
                if let Some(colors) = &colors {
                    let color = colors.get(row).copied().flatten();
                    p = p.fill_style_from_view(series::paint_of(color, SvgPaint::CurrentColor));
                }
                p = p
                    .begin_path()
                    .arc(&x, &y, &radius, 0.0, std::f32::consts::TAU)
                    .fill()
                    .stroke();
            }
            p
        },
    );
    let own = HoverDot {
        class: props.hover_dot_class,
        style: props.hover_dot_style,
    };
    layer()
        .child(canvas)
        .child(hover_dot_view(plot, rest, own, scale))
}

impl DotPose {
    /// [`placed`] of this pose.
    fn with_placed(&self, plot: PlotContext, scale: ValueScale) -> Arc<[Placed]> {
        placed(plot, self, scale).into()
    }
}

/// A dot's hover dot: as big as the hovered row's dot and centered on it,
/// taking the first row at once, gliding to the next on the plot's pointer
/// spring when the keys step there and moving with the pointer in the same
/// frame, faded with the hover; styled by the dot (`hoverDotClass`) or the
/// plot (`dotClass`), none where neither styles one.
fn hover_dot_view(
    plot: PlotContext,
    rest: Memo<Arc<[Placed]>>,
    own: HoverDot,
    scale: Prop<ValueScale>,
) -> impl IntoElement {
    let (x, y) = (animated_value(0.0), animated_value(0.0));
    let diameter = signal(0.0_f32);
    // Shown while the hovered row is one of this mark's dots: a plot of two
    // dots (holdings and their benchmark) rings the one the pointer is on.
    let mine = animated_value(0.0);
    let on = stored(None::<u32>);
    effect(move || {
        let hovered = plot.hovered.get();
        let found = hovered
            .and_then(|row| rest.with(|dots| dots.iter().find(|d| d.row == row as usize).copied()));
        let Some(dot) = found else {
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
        match spring.filter(|_| glide) {
            Some(spring) => {
                drop(x.spring(dot.x, spring));
                drop(y.spring(dot.y, spring));
            }
            None => {
                x.set(dot.x);
                y.set(dot.y);
            }
        }
        if diameter.get_untracked() != dot.r * 2.0 {
            diameter.set(dot.r * 2.0);
        }
    });
    let styled = move || own.style.with(|s| *s != Style::default());
    when(
        move || plot.interactive.get() && (own.is_set() || plot.dot.is_set()),
        move || {
            // Made again on the other y scale: it moves with that one's
            // domain.
            each(
                move || vec![scale.get()],
                |scale| *scale,
                move |scale, _| {
                    let y_tween = plot.y_tween_of(scale.get_untracked());
                    let (sx, sy) = (plot.x_tween.shown(&x), y_tween.shown(&y));
                    dot_anchor(&sx, &sy, &plot.fade.mul(&mine)).child(
                        view()
                            .flex_none()
                            .style_with(move |s| {
                                let d = px(diameter.get());
                                s.w(d).h(d)
                            })
                            .app_class(move || own.class.get().or_else(|| plot.dot.class.get()))
                            .inline_style(move || match styled() {
                                true => own.style.get(),
                                false => plot.dot.style.get(),
                            }),
                    )
                },
            )
        },
    )
}

#[cfg(test)]
mod tests {
    use nsh_core::geometry::{point, px};

    use super::{DotPose, Placed, Pose, RadiusScale, Spot, dot_at};

    /// A bubble's area is in proportion to its value over a range from 0:
    /// a quarter of the largest value has half its radius; a range from
    /// more than 0 lifts the smallest without hiding the differences.
    #[test]
    fn a_sqrt_scale_makes_areas_proportional() {
        let scale = RadiusScale::new(px(0.0), px(20.0));
        let domain = [0.0, 400.0];
        assert_eq!(scale.radius(400.0, domain), 20.0);
        assert_eq!(scale.radius(100.0, domain), 10.0);
        assert_eq!(scale.radius(0.0, domain), 0.0);
        // Outside the domain: the range's ends.
        assert_eq!(scale.radius(900.0, domain), 20.0);
        assert_eq!(scale.radius(-5.0, domain), 0.0);
        assert!(scale.radius(f64::NAN, domain).is_nan());
        let lifted = RadiusScale::new(px(4.0), px(20.0));
        assert_eq!(lifted.radius(0.0, domain), 4.0);
        assert_eq!(lifted.radius(100.0, domain), 12.0);
        // One value: the middle of the range.
        assert_eq!(scale.radius(7.0, [7.0, 7.0]), 10.0);
    }

    /// The pointer finds the dot whose center is nearest, among those
    /// whose edge is within the reach: a small bubble over a big one is
    /// found around its own center, inside the big one.
    #[test]
    fn the_pointer_finds_the_dot_nearest_to_it() {
        let dot = |row, x, y, r| Placed { row, x, y, r };
        // A big bubble under a small one drawn over it.
        let dots = [dot(0, 50.0, 50.0, 30.0), dot(1, 60.0, 50.0, 4.0)];
        let at = |x: f32, y: f32| point(px(x), px(y));
        assert_eq!(dot_at(&dots, at(61.0, 50.0), 8.0), Some(1));
        // Inside both, nearer the small one's center.
        assert_eq!(dot_at(&dots, at(56.0, 50.0), 8.0), Some(1));
        // Inside the big one, the small one out of reach.
        assert_eq!(dot_at(&dots, at(40.0, 50.0), 8.0), Some(0));
        // Outside both: the big one's edge within reach.
        assert_eq!(dot_at(&dots, at(85.0, 50.0), 8.0), Some(0));
        assert_eq!(dot_at(&dots, at(95.0, 50.0), 8.0), None);
        assert_eq!(dot_at(&[], at(0.0, 0.0), 8.0), None);
    }

    /// Between two poses, a dot in both moves and resizes, a new one grows
    /// in and one that is gone shrinks away.
    #[test]
    fn poses_move_grow_and_shrink_dots() {
        let spot = |x: f64, value: f64, r: f32| Spot { x, value, r };
        let none = spot(f64::NAN, f64::NAN, f32::NAN);
        let a = DotPose([spot(0.0, 10.0, 2.0), spot(1.0, 5.0, 4.0)].into());
        let b = DotPose([spot(2.0, 20.0, 6.0), none, spot(3.0, 1.0, 8.0)].into());
        let mid = a.lerp(&b, 0.5);
        assert_eq!(mid.0[0], spot(1.0, 15.0, 4.0));
        assert_eq!(mid.0[1], spot(1.0, 5.0, 2.0));
        assert_eq!(mid.0[2], spot(3.0, 1.0, 4.0));
        assert_eq!(a.lerp(&b, 1.0).0[2], spot(3.0, 1.0, 8.0));
    }
}
