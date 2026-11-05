//! Scales: where a value goes along an axis of a plot, as `gpui-base`'s
//! `plot::scale` (d3-scale's): the app names the kind and the domain, the
//! plot's size is the range.

use std::sync::Arc;

use nsh_core::{
    Color, Hsla,
    element::{JsHost, JsIn, JsOwned, JsValue, PropError, SharedString, TsTypes},
    geometry::{Percentage, Points},
};

/// How an axis of a [`Plot`](super::Plot) places values (TS `Scale`), as
/// `gpui-base`'s scales: `{ type: "point" }` places the rows in order,
/// evenly from one edge to the other (`ScalePoint`); `{ type: "linear",
/// domain? }` places a number in proportion to where it lies in its
/// domain, the extent of `[min, max]` (`ScaleLinear`; the extent of what
/// the plot draws when it has none); and `{ type: "band", … }` gives each
/// row a band of the axis, in order, for the bars drawn in it
/// (`ScaleBand`). Each takes `reverse` (visx's scale option, d3's range
/// written the other way round): the axis runs from its other edge.
#[derive(Debug, Clone, PartialEq)]
pub enum Scale {
    /// One position per row, evenly spaced, the first and last at the
    /// edges (one row: the middle).
    Point {
        /// The rows run the other way: from the right edge leftward on the
        /// x axis, from the bottom edge up on the y axis.
        reverse: bool,
    },
    /// Values in proportion, the domain's smallest at the start of the
    /// range and its largest at the end.
    Linear {
        /// The values at the two ends (in either order); `None`: the
        /// extent of what the plot draws.
        domain: Option<[f64; 2]>,
        /// The domain runs the other way: its smallest value at the right
        /// edge on the x axis, at the top edge on the y axis
        /// (`gpui-base`'s `BarAlignment::Right` and `Top`: bars grow from
        /// there).
        reverse: bool,
    },
    /// One band per row, or per category of its `domain`, in order, with
    /// gaps between them and at the ends (`ScaleBand`).
    Band(BandScale),
}

impl Default for Scale {
    /// `{ type: "point" }`.
    fn default() -> Self {
        Scale::Point { reverse: false }
    }
}

impl Scale {
    /// The axis runs from its other edge (`reverse`).
    pub(crate) fn reversed(&self) -> bool {
        match self {
            Scale::Point { reverse } | Scale::Linear { reverse, .. } => *reverse,
            Scale::Band(band) => band.reverse,
        }
    }
}

/// The options of a band scale (`gpui-base`'s `ScaleBand` builders): the
/// categories of its bands, the gaps, as shares of a band's step, the
/// widest a band may be, and how many bands the axis is laid out for.
#[derive(Debug, Clone, PartialEq, Default)]
#[non_exhaustive]
pub struct BandScale {
    /// The categories its bands stand for, in order (`gpui-base`'s
    /// `ScaleBand::new(domain, ..)`, d3's `scaleBand().domain()`): a
    /// [`Cell`](super::Cell) goes in the band of its row's category, and
    /// an axis labels each band with its category; a category written
    /// twice keeps its first place. Without one, the categories the plot's
    /// cells read along the axis, in the order met, and without cells a
    /// band per row.
    pub domain: Option<Arc<[SharedString]>>,
    /// The gap between neighbouring bands, a share of each (`padding_inner`,
    /// 0 to 1; 0 by default).
    pub padding_inner: Percentage,
    /// The gap before the first band and after the last, a share of a band
    /// (`padding_outer`; 0 by default).
    pub padding_outer: Percentage,
    /// The widest a band may be, in points (`max_band_width`): a few bands
    /// across a wide plot stay narrow, each in the middle of its place.
    pub max_band_width: Option<Points>,
    /// The bands the axis is laid out for when more than the rows
    /// (`band_count`): the rows take the leading ones and keep their width
    /// and place as rows come.
    pub band_count: Option<u32>,
    /// The gap between the bars side by side in a band (grouped bars), a
    /// share of each bar's place: the `padding_inner` of the band scale of
    /// the bars inside a band, as d3's grouped bars nest one (0 by
    /// default).
    pub group_padding: Percentage,
    /// The bands run the other way (`reverse`): the first row's at the
    /// right edge on the x axis, at the bottom edge on the y axis.
    pub reverse: bool,
}

impl JsValue for Scale {
    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("Scale", |_| {
            "/** How an axis of a `Plot` places values: `point` places the rows in order, evenly from one edge to the other; `linear` places a number in proportion to where it lies in its `domain` (the extent of the two values; without one, the extent of what the plot draws); `band` gives each row a band of the axis, in order, for the bars drawn in it, or each category of its `domain` a band, for the cells placed in them (without one, the categories the plot's cells read, in the order met): `paddingInner` is the gap between bands and `paddingOuter` the gap at the ends (shares of a band, 0 by default), `maxBandWidth` the widest a band may be (points), `bandCount` the bands the axis is laid out for when more than the rows, and `groupPadding` the gap between the bars side by side in a band (a share of a bar's place). `reverse` runs the axis from its other edge (false by default): the first row or the domain's smallest value at the right edge of the x axis, and on the y axis the domain's smallest value at the top edge (bars grow down from it) and the first row at the bottom edge. */\nexport type Scale = { type: \"point\"; reverse?: boolean } | { type: \"linear\"; domain?: [number, number]; reverse?: boolean } | { type: \"band\"; domain?: string[]; paddingInner?: number; paddingOuter?: number; maxBandWidth?: number; bandCount?: number; groupPadding?: number; reverse?: boolean };\n".to_owned()
        })
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        let kind = value.field("type")?;
        let reverse = {
            let field = value.field("reverse")?;
            let field = field.get();
            match field.is_nullish() {
                true => false,
                false => field
                    .as_bool()
                    .ok_or_else(|| field.expected("`reverse`: a boolean"))?,
            }
        };
        match kind.get().as_string().as_deref() {
            Some("point") => Ok(Scale::Point { reverse }),
            Some("linear") => {
                let domain = value.field("domain")?;
                let domain = domain.get();
                if domain.is_nullish() {
                    return Ok(Scale::Linear {
                        domain: None,
                        reverse,
                    });
                }
                let ends = Vec::<f64>::from_js(domain)?;
                match ends[..] {
                    [a, b] if a.is_finite() && b.is_finite() => Ok(Scale::Linear {
                        domain: Some([a, b]),
                        reverse,
                    }),
                    _ => Err(PropError(
                        "`domain`: two finite numbers, `[min, max]`".to_owned(),
                    )),
                }
            }
            Some("band") => {
                let number = |key: &str| -> Result<Option<f64>, PropError> {
                    let field = value.field(key)?;
                    let field = field.get();
                    if field.is_nullish() {
                        return Ok(None);
                    }
                    match field.as_number() {
                        Some(n) if n.is_finite() && n >= 0.0 => Ok(Some(n)),
                        _ => Err(field.expected(&format!("`{key}`: a number of 0 or more"))),
                    }
                };
                let domain = value.field("domain")?;
                let domain = match domain.get().is_nullish() {
                    true => None,
                    false => Some(categories(Vec::<SharedString>::from_js(domain.get())?)),
                };
                // As d3 takes them: an inner gap of at most the whole band.
                Ok(Scale::Band(BandScale {
                    domain,
                    padding_inner: Percentage(
                        number("paddingInner")?.unwrap_or(0.0).min(1.0) as f32
                    ),
                    padding_outer: Percentage(number("paddingOuter")?.unwrap_or(0.0) as f32),
                    max_band_width: number("maxBandWidth")?.map(|n| Points(n as f32)),
                    band_count: number("bandCount")?.map(|n| n as u32),
                    group_padding: Percentage(
                        number("groupPadding")?.unwrap_or(0.0).min(1.0) as f32
                    ),
                    reverse,
                }))
            }
            _ => Err(value
                .expected("`{ type: \"point\" }`, `{ type: \"linear\" }` or `{ type: \"band\" }`")),
        }
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        let object = JsOwned::new(host, host.new_object()?);
        let raw = object.get().raw();
        let kind = match self {
            Scale::Point { .. } => "point",
            Scale::Linear { .. } => "linear",
            Scale::Band(_) => "band",
        };
        host.set_field(raw, "type", host.new_string(kind)?)?;
        match self {
            Scale::Linear {
                domain: Some([a, b]),
                ..
            } => {
                let ends = vec![*a, *b].to_js(host)?;
                host.set_field(raw, "domain", ends.into_raw())?;
            }
            Scale::Band(band) => {
                if let Some(domain) = &band.domain {
                    let domain = domain.to_vec().to_js(host)?;
                    host.set_field(raw, "domain", domain.into_raw())?;
                }
                let numbers = [
                    ("paddingInner", Some(band.padding_inner.0 as f64)),
                    ("paddingOuter", Some(band.padding_outer.0 as f64)),
                    ("maxBandWidth", band.max_band_width.map(|w| w.0 as f64)),
                    ("bandCount", band.band_count.map(f64::from)),
                    ("groupPadding", Some(band.group_padding.0 as f64)),
                ];
                for (key, n) in numbers {
                    if let Some(n) = n {
                        host.set_field(raw, key, host.new_number(n))?;
                    }
                }
            }
            _ => {}
        }
        if self.reversed() {
            host.set_field(raw, "reverse", host.new_bool(true))?;
        }
        Ok(object)
    }
}

/// A linear scale on its own (TS `LinearScale`, `{ type: "linear", domain?,
/// reverse? }`, the `linear` member of [`Scale`]): a plot's second y scale
/// (`y2Scale`), where only a linear one has a meaning.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
#[non_exhaustive]
pub struct LinearScale {
    /// The values at the two ends (in either order); `None`: the extent of
    /// what the plot draws on it.
    pub domain: Option<[f64; 2]>,
    /// The domain runs the other way: its smallest value at the top edge.
    pub reverse: bool,
}

impl JsValue for LinearScale {
    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("LinearScale", |types| {
            // The member of `Scale` it takes.
            Scale::ts_type(types);
            "/** A linear scale on its own: the `linear` member of `Scale`, for a plot's second y scale (`y2Scale`). */\nexport type LinearScale = Extract<Scale, { type: \"linear\" }>;\n".to_owned()
        })
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        match Scale::from_js(value)? {
            Scale::Linear { domain, reverse } => Ok(Self { domain, reverse }),
            _ => Err(PropError(
                "a linear scale, `{ type: \"linear\", domain?, reverse? }`".to_owned(),
            )),
        }
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        Scale::Linear {
            domain: self.domain,
            reverse: self.reverse,
        }
        .to_js(host)
    }
}

/// A linear map from a domain to a range (`ScaleLinear`): `start` to
/// `range[0]`, `start + diff` to `range[1]`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Linear {
    start: f64,
    diff: f64,
    range: [f32; 2],
    /// The step its ticks take when it is laid out in whole steps shared
    /// with another scale (`alignTicks`).
    step: Option<f64>,
}

impl Linear {
    /// The map of the extent of `domain` onto `range`.
    pub(crate) fn new(domain: [f64; 2], range: [f32; 2]) -> Self {
        let (lo, hi) = (domain[0].min(domain[1]), domain[0].max(domain[1]));
        Self {
            start: lo,
            diff: hi - lo,
            range,
            step: None,
        }
    }

    /// The map of an aligned domain onto `range`, its ticks a step apart.
    pub(crate) fn aligned(aligned: Aligned, range: [f32; 2]) -> Self {
        Self {
            step: Some(aligned.step),
            ..Self::new(aligned.domain, range)
        }
    }

    /// The step its ticks take, when it is aligned with another scale.
    pub(crate) fn step(&self) -> Option<f64> {
        self.step
    }

    /// Where `value` goes. A domain of one value puts it in the middle of
    /// the range, as d3 does (`gpui-base` draws nothing there; a flat line
    /// is still a line).
    pub(crate) fn tick(&self, value: f64) -> Option<f32> {
        if !value.is_finite() {
            return None;
        }
        let ratio = if self.diff == 0.0 {
            0.5
        } else {
            (value - self.start) / self.diff
        };
        Some(self.range[0] + ratio as f32 * (self.range[1] - self.range[0]))
    }

    /// The extent of its domain, `[lo, hi]`.
    pub(crate) fn domain(&self) -> [f64; 2] {
        [self.start, self.start + self.diff]
    }

    /// Its range.
    pub(crate) fn range(&self) -> [f32; 2] {
        self.range
    }
}

/// A domain laid out in whole steps (nice ones: 1, 2 or 5 times a power of
/// ten), whose ticks fall on the same places as another's (`alignTicks`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Aligned {
    pub(crate) domain: [f64; 2],
    pub(crate) step: f64,
}

/// The fewest divisions aligned scales take when they may (ai-chat's
/// `MIN_ALIGNED_DIVISIONS`): a grid of fewer lines tells little.
const MIN_ALIGNED_DIVISIONS: usize = 3;

/// The extents `a` and `b` of two scales laid out in nice steps with the
/// same number of divisions, at most `max`, so that their ticks fall on
/// the same places (ai-chat's `aligned_ticks`, ECharts' `alignTicks`): when
/// both extents hold zero, zero falls on the same place too; otherwise a
/// domain gains its extra divisions away from zero when it starts or ends
/// there (volumes from zero grow up) and on both sides when not (a price
/// stays in the middle). Of the choices, those of at least
/// [`MIN_ALIGNED_DIVISIONS`] come first, then those whose data fill the
/// most of both domains, then those of more divisions. `None` when either
/// extent is a single value or not finite.
pub(crate) fn align(a: [f64; 2], b: [f64; 2], max: usize) -> Option<(Aligned, Aligned)> {
    let max = max.max(1);
    let valid = |[lo, hi]: [f64; 2]| lo.is_finite() && hi.is_finite() && hi > lo;
    if !(valid(a) && valid(b)) {
        return None;
    }
    let (ca, cb) = (steps(a, max), steps(b, max));
    let zero = |[lo, hi]: [f64; 2]| lo <= 0.0 && hi >= 0.0;
    let both_zero = zero(a) && zero(b);
    let dense = MIN_ALIGNED_DIVISIONS.min(max);
    let mut best: Option<(bool, f64, usize, Aligned, Aligned)> = None;
    for &(sa, la, ha) in &ca {
        for &(sb, lb, hb) in &cb {
            let (ka, kb, divisions) = match both_zero {
                true => {
                    let (below, above) = ((-la).max(-lb), ha.max(hb));
                    ((-below, above), (-below, above), (below + above) as usize)
                }
                false => {
                    let divisions = (ha - la).max(hb - lb);
                    (
                        widen(la, ha, divisions),
                        widen(lb, hb, divisions),
                        divisions as usize,
                    )
                }
            };
            if divisions == 0 || divisions > max {
                continue;
            }
            let fill =
                (a[1] - a[0]) / (divisions as f64 * sa) + (b[1] - b[0]) / (divisions as f64 * sb);
            let is_dense = divisions >= dense;
            let better = match &best {
                None => true,
                Some((was_dense, f, d, ..)) => {
                    (is_dense && !was_dense)
                        || (is_dense == *was_dense
                            && (fill > f + 1e-9 || ((fill - f).abs() <= 1e-9 && divisions > *d)))
                }
            };
            if better {
                let at = |(lo, hi): (i64, i64), step: f64| Aligned {
                    domain: [lo as f64 * step, hi as f64 * step],
                    step,
                };
                best = Some((is_dense, fill, divisions, at(ka, sa), at(kb, sb)));
            }
        }
    }
    best.map(|(.., a, b)| (a, b))
}

/// The nice steps that lay `extent` out in at most `max` divisions, each
/// with the whole steps its ends round out to (`lo / step` down, `hi /
/// step` up).
fn steps([lo, hi]: [f64; 2], max: usize) -> Vec<(f64, i64, i64)> {
    // Float division's slack (0.3 / 0.1 = 2.9999…) adds no division.
    const EPS: f64 = 1e-9;
    let least = (hi - lo) / max as f64;
    let base = 10f64.powi(least.log10().floor() as i32);
    let mut out: Vec<(f64, i64, i64)> = Vec::new();
    for k in 0..4 {
        for factor in [1.0, 2.0, 5.0] {
            let step = base * 10f64.powi(k) * factor;
            let (l, h) = (
                (lo / step + EPS).floor() as i64,
                (hi / step - EPS).ceil() as i64,
            );
            if h - l >= 1 && (h - l) as usize <= max && !out.iter().any(|(s, ..)| *s == step) {
                out.push((step, l, h));
            }
        }
    }
    out
}

/// Whole steps `lo..hi` widened to `divisions`: up from a domain that
/// starts at zero, down to one that ends there, evenly round others.
fn widen(lo: i64, hi: i64, divisions: i64) -> (i64, i64) {
    let extra = divisions - (hi - lo);
    match (lo, hi) {
        (0, _) => (lo, hi + extra),
        (_, 0) => (lo - extra, hi),
        _ => (lo - extra / 2, hi + (extra - extra / 2)),
    }
}

/// Bands laid out across a range (`ScaleBand`, over row indices), as
/// d3's `scaleBand` lays them out, the reference `gpui-base`'s cites: `len`
/// bands one `step` apart, `padding_inner` of a step between neighbours
/// and `padding_outer` of a step at each end, the whole in the middle of
/// the range; each band at most `max_width` wide, in the middle of its
/// place.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Band {
    len: usize,
    start: f32,
    diff: f32,
    padding_inner: f32,
    padding_outer: f32,
    max_width: Option<f32>,
    /// The gap between the bars side by side in a band.
    group_padding: f32,
    /// The first band at the end of the range (`reverse`).
    reverse: bool,
}

impl Band {
    /// `rows` bands (or `band_count` when more) across `range`.
    pub(crate) fn new(rows: usize, range: [f32; 2], options: &BandScale) -> Self {
        Self {
            len: rows.max(options.band_count.unwrap_or(0) as usize),
            start: range[0].min(range[1]),
            diff: (range[1] - range[0]).abs(),
            padding_inner: options.padding_inner.0,
            padding_outer: options.padding_outer.0,
            max_width: options.max_band_width.map(|w| w.0),
            group_padding: options.group_padding.0,
            reverse: options.reverse,
        }
    }

    /// `count` bands across `width` with `padding` between them and none at
    /// the ends: the places of the bars side by side in a band.
    pub(crate) fn group(count: usize, width: f32, padding: f32) -> Self {
        Self {
            len: count,
            start: 0.0,
            diff: width,
            // One bar fills the band: the gap is between bars.
            padding_inner: if count > 1 { padding } else { 0.0 },
            padding_outer: 0.0,
            max_width: None,
            group_padding: 0.0,
            reverse: false,
        }
    }

    /// The same bands over a range from 0 to 1 and no widest band: where
    /// they go as shares of the axis, whatever its length (`max_width` is
    /// points, applied where the shares become points).
    pub(crate) fn unit(&self) -> Self {
        Self {
            start: 0.0,
            diff: 1.0,
            max_width: None,
            ..*self
        }
    }

    /// The widest a band may be, in points.
    pub(crate) fn max_width(&self) -> Option<f32> {
        self.max_width
    }

    /// The places of `count` bars side by side in each band (the scale's
    /// `group_padding` between them).
    pub(crate) fn groups(&self, count: usize) -> Self {
        Self::group(count, self.width(), self.group_padding)
    }

    /// How many bands there are (the rows, or `band_count` when more).
    pub(crate) fn len(&self) -> usize {
        self.len
    }

    /// The distance between the starts of two neighbouring bands (d3's
    /// `step`): the range over the bands and the paddings; the whole range
    /// for a single band without padding.
    pub(crate) fn step(&self) -> f32 {
        if self.len == 0 {
            return 0.0;
        }
        let units = self.len as f32 - self.padding_inner + 2.0 * self.padding_outer;
        self.diff / units.max(1.0)
    }

    /// The width of a band before `max_width` (d3's `bandwidth`).
    fn full_width(&self) -> f32 {
        self.step() * (1.0 - self.padding_inner)
    }

    /// The width of a band: its step less the inner padding, and no wider
    /// than `max_width`.
    pub(crate) fn width(&self) -> f32 {
        let width = self.full_width();
        self.max_width.map_or(width, |max| width.min(max))
    }

    /// Where band `index` starts (`ScaleBand::tick`), a band narrowed by
    /// `max_width` in the middle of its place; from the end of the range
    /// when reversed, as d3's band scale over a range written backwards.
    pub(crate) fn start(&self, index: usize) -> Option<f32> {
        if index >= self.len {
            return None;
        }
        let place = match self.reverse {
            true => self.len - 1 - index,
            false => index,
        };
        let step = self.step();
        // The bands and their inner gaps, in the middle of the range.
        let first = self.start + (self.diff - step * (self.len as f32 - self.padding_inner)) / 2.0;
        let full = self.full_width();
        Some(first + place as f32 * step + (full - self.width()) / 2.0)
    }

    /// The middle of band `index`.
    pub(crate) fn center(&self, index: usize) -> Option<f32> {
        self.start(index).map(|s| s + self.width() / 2.0)
    }

    /// Where `value` goes: the middle of band `value`, and in proportion
    /// between the middles of two bands (a grid line between them).
    pub(crate) fn tick(&self, value: f64) -> Option<f32> {
        if !value.is_finite() {
            return None;
        }
        let first = self.center(0)?;
        let step = match self.reverse {
            true => -self.step(),
            false => self.step(),
        };
        Some(first + value as f32 * step)
    }

    /// The first band is at the end of the range.
    pub(crate) fn reversed(&self) -> bool {
        self.reverse
    }
}

/// How an axis of a plot places values, laid out for its size.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum AxisMap {
    /// Row indices, evenly over `range` (fractions between rows).
    Point { len: usize, range: [f32; 2] },
    /// Values in proportion.
    Linear(Linear),
    /// A band per row index (the middle of each).
    Band(Band),
}

impl AxisMap {
    /// Where `value` goes.
    pub(crate) fn tick(&self, value: f64) -> Option<f32> {
        match *self {
            AxisMap::Point { len, range } => match len {
                0 => None,
                _ if !value.is_finite() => None,
                1 => point_tick(0, 1, range),
                _ => Some(range[0] + value as f32 * (range[1] - range[0]) / (len - 1) as f32),
            },
            AxisMap::Linear(map) => map.tick(value),
            AxisMap::Band(band) => band.tick(value),
        }
    }

    /// Where the rows `values` go (a row's index without values, and on a
    /// scale of rows).
    pub(crate) fn ticks(&self, len: usize, values: Option<&[f64]>) -> Arc<[f32]> {
        let at = |v: f64| self.tick(v).unwrap_or(f32::NAN);
        match (self, values) {
            (AxisMap::Linear(_), Some(values)) => values.iter().map(|&v| at(v)).collect(),
            _ => (0..len).map(|i| at(i as f64)).collect(),
        }
    }

    /// The bands, on a band scale.
    pub(crate) fn band(&self) -> Option<Band> {
        match *self {
            AxisMap::Band(band) => Some(band),
            _ => None,
        }
    }

    /// Its places run back along the axis, toward smaller coordinates as
    /// the rows or values grow: a reversed scale along x (right to left),
    /// and along y a linear scale unless reversed (bottom up).
    pub(crate) fn backward(&self) -> bool {
        match *self {
            AxisMap::Point { range, .. } => range[1] < range[0],
            AxisMap::Linear(map) => map.range()[1] < map.range()[0],
            AxisMap::Band(band) => band.reversed(),
        }
    }
}

/// Where row `index` of `len` goes on a point scale over `range`
/// (`ScalePoint::tick_at`).
pub(crate) fn point_tick(index: usize, len: usize, range: [f32; 2]) -> Option<f32> {
    match len {
        0 => None,
        _ if index >= len => None,
        1 => Some((range[0] + range[1]) / 2.0),
        _ => Some(range[0] + index as f32 * (range[1] - range[0]) / (len - 1) as f32),
    }
}

/// `domain` without the categories written again (each keeps its first
/// place).
pub(crate) fn categories(domain: Vec<SharedString>) -> Arc<[SharedString]> {
    let mut out: Vec<SharedString> = Vec::with_capacity(domain.len());
    for c in domain {
        if !out.contains(&c) {
            out.push(c);
        }
    }
    out.into()
}

/// The extent of `values`' finite numbers.
pub(crate) fn extent(values: impl IntoIterator<Item = f64>) -> Option<[f64; 2]> {
    values
        .into_iter()
        .filter(|v| v.is_finite())
        .fold(None, |acc, v| match acc {
            None => Some([v, v]),
            Some([lo, hi]) => Some([lo.min(v), hi.max(v)]),
        })
}

/// The colors of a [`Plot`](super::Plot)'s categories (TS `OrdinalScale`,
/// `{ type: "ordinal", domain?, range, unknown? }`), as `gpui-base`'s
/// `ScaleOrdinal` (`scale/ordinal.rs`) and d3's `scaleOrdinal` map a
/// discrete domain to a discrete range: the `domain`'s `i`th category
/// takes the `range`'s `i % range.len()`th color, so the range repeats
/// over a longer domain. A category outside the domain takes `unknown`
/// where it is set; otherwise, as d3's implicit domain, the plot adds it
/// after the domain the first time a mark meets it (marks in order, rows
/// in order) and it takes the next color. The marks' `color` reads each
/// row's category; its color is the mark's `fill` (a line's `stroke`)
/// where nothing sets one, in place of `currentColor`.
#[derive(Debug, Clone, PartialEq, Default)]
#[non_exhaustive]
pub struct OrdinalScale {
    /// The categories, in order (`ScaleOrdinal::domain`); a category
    /// written twice keeps its first place.
    pub domain: Vec<SharedString>,
    /// The colors, in order (`ScaleOrdinal::range`), CSS colors in TS;
    /// none: no category takes a color.
    pub range: Vec<Hsla>,
    /// The color of every category outside the domain
    /// (`ScaleOrdinal::unknown`); none: each takes the next color.
    pub unknown: Option<Hsla>,
}

impl OrdinalScale {
    /// The scale of `domain` to `range` (`ScaleOrdinal::new`).
    pub fn new(
        domain: impl IntoIterator<Item = impl Into<SharedString>>,
        range: impl IntoIterator<Item = impl Into<Hsla>>,
    ) -> Self {
        Self {
            domain: domain.into_iter().map(Into::into).collect(),
            range: range.into_iter().map(Into::into).collect(),
            unknown: None,
        }
    }

    /// The same scale, with `color` for the categories outside its domain
    /// (`ScaleOrdinal::unknown`).
    pub fn unknown(mut self, color: impl Into<Hsla>) -> Self {
        self.unknown = Some(color.into());
        self
    }

    /// The color of `category`, its place in the domain and then among
    /// `met`, the categories outside the domain met so far (d3's implicit
    /// domain), where it goes when new; `unknown` instead when set. An
    /// empty category (a row without one) has none.
    pub(crate) fn color(&self, met: &mut Vec<SharedString>, category: &str) -> Option<Hsla> {
        if category.is_empty() || self.range.is_empty() {
            return None;
        }
        let mut known = 0;
        for (i, d) in self.domain.iter().enumerate() {
            if self.domain[..i].contains(d) {
                continue;
            }
            if d == category {
                return Some(self.range[known % self.range.len()]);
            }
            known += 1;
        }
        if let Some(unknown) = self.unknown {
            return Some(unknown);
        }
        let at = match met.iter().position(|m| m == category) {
            Some(at) => at,
            None => {
                met.push(SharedString::from(category.to_owned()));
                met.len() - 1
            }
        };
        Some(self.range[(known + at) % self.range.len()])
    }
}

impl JsValue for OrdinalScale {
    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("OrdinalScale", |_| {
            "/** The colors of a `Plot`'s categories, as d3's `scaleOrdinal`: the `domain`'s categories in order take the `range`'s colors in order (CSS colors), the range repeating over a longer domain. A category outside the domain takes `unknown`; without one, it joins the domain the first time a mark meets it and takes the next color. A mark's `color` names each row's category. */\nexport type OrdinalScale = { type: \"ordinal\"; domain?: string[]; range: string[]; unknown?: string };\n".to_owned()
        })
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        let kind = value.field("type")?;
        if kind.get().as_string().as_deref() != Some("ordinal") {
            return Err(value.expected("`{ type: \"ordinal\", range }`"));
        }
        let domain = value.field("domain")?;
        let domain = match domain.get().is_nullish() {
            true => Vec::new(),
            false => Vec::<SharedString>::from_js(domain.get())?,
        };
        let range = value.field("range")?;
        let range = Vec::<Color>::from_js(range.get())?;
        let unknown = value.field("unknown")?;
        let unknown = match unknown.get().is_nullish() {
            true => None,
            false => Some(Color::from_js(unknown.get())?.into()),
        };
        Ok(OrdinalScale {
            domain,
            range: range.into_iter().map(Hsla::from).collect(),
            unknown,
        })
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        let object = JsOwned::new(host, host.new_object()?);
        let raw = object.get().raw();
        host.set_field(raw, "type", host.new_string("ordinal")?)?;
        let domain = self.domain.to_js(host)?;
        host.set_field(raw, "domain", domain.into_raw())?;
        let range: Vec<Color> = self.range.iter().map(|&c| c.into()).collect();
        host.set_field(raw, "range", range.to_js(host)?.into_raw())?;
        if let Some(unknown) = self.unknown {
            let unknown = Color::from(unknown).to_js(host)?;
            host.set_field(raw, "unknown", unknown.into_raw())?;
        }
        Ok(object)
    }
}

/// The colors of a [`Plot`](super::Plot)'s marks (TS `ColorScale`): the
/// categories' colors (`ordinal`, which the marks' `color` reads), or the
/// colors of numbers along a ramp (`sequential`, `diverging`, which a
/// [`Cell`](super::Cell)'s `value` and a [`Treemap`](super::Treemap)'s
/// `colorValue` read), as d3's `scaleOrdinal`,
/// `scaleSequential` and `scaleDiverging`.
#[derive(Debug, Clone, PartialEq)]
pub enum ColorScale {
    /// A color per category (`{ type: "ordinal", … }`).
    Ordinal(OrdinalScale),
    /// Numbers from low to high along a ramp of colors (`{ type:
    /// "sequential", … }`).
    Sequential(SequentialScale),
    /// Numbers on either side of a pivot along a ramp of colors whose middle
    /// is the pivot's (`{ type: "diverging", … }`).
    Diverging(DivergingScale),
}

impl Default for ColorScale {
    /// An ordinal scale with no colors.
    fn default() -> Self {
        ColorScale::Ordinal(OrdinalScale::default())
    }
}

impl From<OrdinalScale> for ColorScale {
    fn from(scale: OrdinalScale) -> Self {
        ColorScale::Ordinal(scale)
    }
}

impl From<SequentialScale> for ColorScale {
    fn from(scale: SequentialScale) -> Self {
        ColorScale::Sequential(scale)
    }
}

impl From<DivergingScale> for ColorScale {
    fn from(scale: DivergingScale) -> Self {
        ColorScale::Diverging(scale)
    }
}

impl ColorScale {
    /// The ordinal scale, the one the marks' categories take colors of.
    pub(crate) fn ordinal(&self) -> Option<&OrdinalScale> {
        match self {
            ColorScale::Ordinal(scale) => Some(scale),
            _ => None,
        }
    }

    /// The domain its numbers are spread over, given the `extent` of the
    /// values it colors: the app's, else the extent (for `diverging`, made
    /// even on both sides of its pivot); `None` for `ordinal`.
    pub(crate) fn domain(&self, extent: Option<[f64; 2]>) -> Option<[f64; 2]> {
        match self {
            ColorScale::Ordinal(_) => None,
            ColorScale::Sequential(s) => s.domain.or(extent),
            ColorScale::Diverging(d) => d.domain.or_else(|| {
                let [lo, hi] = extent?;
                let r = (lo - d.pivot).abs().max((hi - d.pivot).abs());
                Some([d.pivot - r, d.pivot + r])
            }),
        }
    }

    /// The color of `value` over `domain` (from [`Self::domain`]): where
    /// it lies along the ramp, the range's colors spread evenly over it and
    /// mixed in OKLab between them; values outside the domain take its
    /// ends. `unknown` (or none) for no value; none for `ordinal`.
    pub(crate) fn shade(&self, value: f64, domain: [f64; 2]) -> Option<Hsla> {
        let (range, unknown) = match self {
            ColorScale::Ordinal(_) => return None,
            ColorScale::Sequential(s) => (&s.range, s.unknown),
            ColorScale::Diverging(d) => (&d.range, d.unknown),
        };
        if !value.is_finite() {
            return unknown;
        }
        let [lo, hi] = domain;
        let t = match self {
            ColorScale::Diverging(d) => {
                // d3's `scaleDiverging`: each side of the pivot over half
                // the ramp, the middle the pivot's.
                let p = d.pivot;
                let side = |from: f64, to: f64| match to - from {
                    span if span == 0.0 || !span.is_finite() => 0.0,
                    span => (value - from) / span,
                };
                match value < p {
                    true => (1.0 - side(p, lo)) * 0.5,
                    false => 0.5 + side(p, hi) * 0.5,
                }
            }
            _ => match hi - lo {
                // One value: the middle, as d3 does.
                span if span == 0.0 || !span.is_finite() => 0.5,
                span => (value - lo) / span,
            },
        };
        ramp(range, t.clamp(0.0, 1.0) as f32)
    }
}

/// The color at `t` (0 to 1) along `colors`, spread evenly over it and
/// mixed in OKLab (d3's `piecewise` over `interpolateOklab`): perceptually
/// even, with no gray dip between two hues as mixes in RGB have.
fn ramp(colors: &[Hsla], t: f32) -> Option<Hsla> {
    match colors {
        [] => None,
        [one] => Some(*one),
        _ => {
            let at = t * (colors.len() - 1) as f32;
            let i = (at.floor() as usize).min(colors.len() - 2);
            // On a stop, its color as the app wrote it.
            match at - i as f32 {
                f if f <= 0.0 => Some(colors[i]),
                f if f >= 1.0 => Some(colors[i + 1]),
                f => Some(colors[i + 1].mix_oklab(colors[i], f)),
            }
        }
    }
}

/// Numbers from low to high along a ramp of colors (TS `{ type:
/// "sequential", domain?, range, unknown? }`), as d3's `scaleSequential`
/// over a ramp of the `range`'s colors: the domain's low end takes the
/// first color, its high end the last, the colors spread evenly between
/// and mixed in OKLab. Values outside the domain take its ends.
#[derive(Debug, Clone, PartialEq, Default)]
#[non_exhaustive]
pub struct SequentialScale {
    /// The values of the ramp's ends; the extent of the values it colors
    /// without one.
    pub domain: Option<[f64; 2]>,
    /// The colors along the ramp, from the low end to the high one (CSS
    /// colors in TS).
    pub range: Vec<Hsla>,
    /// The color of a row without a value; none: it has no color of the
    /// scale.
    pub unknown: Option<Hsla>,
}

impl SequentialScale {
    /// The ramp of `range`'s colors over the values' extent.
    pub fn new(range: impl IntoIterator<Item = impl Into<Hsla>>) -> Self {
        Self {
            range: range.into_iter().map(Into::into).collect(),
            ..Self::default()
        }
    }

    /// The same scale, over `domain`.
    pub fn domain(mut self, domain: [f64; 2]) -> Self {
        self.domain = Some(domain);
        self
    }
}

/// Numbers on either side of a pivot along a ramp of colors (TS `{ type:
/// "diverging", domain?, pivot?, range, unknown? }`), as d3's
/// `scaleDiverging` and Observable Plot's `pivot`: the values from the
/// domain's low end to the pivot take the first half of the ramp, those
/// from the pivot to its high end the second, so the pivot (0 by default)
/// takes the middle color: losses one hue, gains another, flat neutral.
/// Without a domain, the extent of the values made even on both sides of
/// the pivot (Observable Plot's `symmetric`), so a loss and a gain of the
/// same size are as strong.
#[derive(Debug, Clone, PartialEq, Default)]
#[non_exhaustive]
pub struct DivergingScale {
    /// The values of the ramp's ends; the extent of the values it colors,
    /// even on both sides of the pivot, without one.
    pub domain: Option<[f64; 2]>,
    /// The value of the ramp's middle; 0 by default.
    pub pivot: f64,
    /// The colors along the ramp, from the low end to the high one (CSS
    /// colors in TS), the middle of the ramp the pivot's.
    pub range: Vec<Hsla>,
    /// The color of a row without a value; none: it has no color of the
    /// scale.
    pub unknown: Option<Hsla>,
}

impl DivergingScale {
    /// The ramp of `range`'s colors about 0, over the values' extent made
    /// even on both sides.
    pub fn new(range: impl IntoIterator<Item = impl Into<Hsla>>) -> Self {
        Self {
            range: range.into_iter().map(Into::into).collect(),
            ..Self::default()
        }
    }

    /// The same scale, over `domain`.
    pub fn domain(mut self, domain: [f64; 2]) -> Self {
        self.domain = Some(domain);
        self
    }

    /// The same scale, about `pivot`.
    pub fn pivot(mut self, pivot: f64) -> Self {
        self.pivot = pivot;
        self
    }
}

impl JsValue for ColorScale {
    fn ts_type(types: &mut TsTypes) -> String {
        let ordinal = OrdinalScale::ts_type(types);
        types.declare("ColorScale", |_| {
            format!(
                "/** The colors of a `Plot`'s marks: `ordinal`, a color per category (a mark's `color`); `sequential`, a number's color along the ramp of the `range`'s colors, from the `domain`'s low end to its high end (without one, the extent of the values it colors), the colors spread evenly and mixed in OKLab; `diverging`, the same ramp with its middle at `pivot` (0 by default), the values below the pivot over its first half and those above over its second (without a `domain`, the extent made even on both sides of the pivot). A `Cell`'s `value` and a `Treemap`'s `colorValue` take the colors of `sequential` and `diverging`; values outside the domain take its ends, and a row without one takes `unknown`. */\nexport type ColorScale = {ordinal} | {{ type: \"sequential\"; domain?: [number, number]; range: string[]; unknown?: string }} | {{ type: \"diverging\"; domain?: [number, number]; pivot?: number; range: string[]; unknown?: string }};\n"
            )
        })
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        let kind = value.field("type")?;
        let kind = kind.get().as_string();
        let diverging = match kind.as_deref() {
            Some("ordinal") => return OrdinalScale::from_js(value).map(ColorScale::Ordinal),
            Some("sequential") => false,
            Some("diverging") => true,
            _ => {
                return Err(value.expected(
                    "`{ type: \"ordinal\" }`, `{ type: \"sequential\" }` or `{ type: \"diverging\" }`",
                ));
            }
        };
        let domain = value.field("domain")?;
        let domain = match domain.get().is_nullish() {
            true => None,
            false => match Vec::<f64>::from_js(domain.get())?[..] {
                [a, b] if a.is_finite() && b.is_finite() => Some([a.min(b), a.max(b)]),
                _ => {
                    return Err(PropError(
                        "`domain`: two finite numbers, `[min, max]`".to_owned(),
                    ));
                }
            },
        };
        let range = value.field("range")?;
        let range: Vec<Hsla> = Vec::<Color>::from_js(range.get())?
            .into_iter()
            .map(Hsla::from)
            .collect();
        let unknown = value.field("unknown")?;
        let unknown = match unknown.get().is_nullish() {
            true => None,
            false => Some(Color::from_js(unknown.get())?.into()),
        };
        if !diverging {
            return Ok(ColorScale::Sequential(SequentialScale {
                domain,
                range,
                unknown,
            }));
        }
        let pivot = value.field("pivot")?;
        let pivot = pivot.get();
        let pivot = match pivot.is_nullish() {
            true => 0.0,
            false => match pivot.as_number() {
                Some(p) if p.is_finite() => p,
                _ => return Err(pivot.expected("`pivot`: a finite number")),
            },
        };
        Ok(ColorScale::Diverging(DivergingScale {
            domain,
            pivot,
            range,
            unknown,
        }))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        let (kind, domain, range, unknown, pivot) = match self {
            ColorScale::Ordinal(scale) => return scale.to_js(host),
            ColorScale::Sequential(s) => ("sequential", s.domain, &s.range, s.unknown, None),
            ColorScale::Diverging(d) => ("diverging", d.domain, &d.range, d.unknown, Some(d.pivot)),
        };
        let object = JsOwned::new(host, host.new_object()?);
        let raw = object.get().raw();
        host.set_field(raw, "type", host.new_string(kind)?)?;
        if let Some([a, b]) = domain {
            host.set_field(raw, "domain", vec![a, b].to_js(host)?.into_raw())?;
        }
        if let Some(pivot) = pivot {
            host.set_field(raw, "pivot", host.new_number(pivot))?;
        }
        let range: Vec<Color> = range.iter().map(|&c| c.into()).collect();
        host.set_field(raw, "range", range.to_js(host)?.into_raw())?;
        if let Some(unknown) = unknown {
            let unknown = Color::from(unknown).to_js(host)?;
            host.set_field(raw, "unknown", unknown.into_raw())?;
        }
        Ok(object)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two scales laid out in the same nice steps (ai-chat's
    /// `aligned_ticks`): volumes from zero grow up and a price keeps its
    /// own range, three steps each; two extents that hold zero put it on
    /// the same place.
    #[test]
    fn aligned_scales_share_their_steps() {
        let (volume, price) = align([0.0, 280e6], [172.4, 191.8], 5).unwrap();
        assert_eq!((volume.domain, volume.step), ([0.0, 300e6], 100e6));
        assert_eq!((price.domain, price.step), ([170.0, 200.0], 10.0));

        let (profit, margin) = align([-20.0, 100.0], [-0.05, 0.3], 6).unwrap();
        assert_eq!((profit.domain, profit.step), ([-20.0, 100.0], 20.0));
        assert_eq!(margin.step, 0.1);
        let zero = |a: Aligned| -a.domain[0] / (a.domain[1] - a.domain[0]);
        assert!((zero(profit) - zero(margin)).abs() < 1e-9);
        let divisions = |a: Aligned| ((a.domain[1] - a.domain[0]) / a.step).round();
        assert_eq!(divisions(profit), divisions(margin));

        // A single value has no steps.
        assert_eq!(align([5.0, 5.0], [0.0, 1.0], 5), None);
    }

    #[test]
    fn scales_place_values_as_gpui_base_and_d3_do() {
        let y = Linear::new([0.0, 100.0], [200.0, 0.0]);
        assert_eq!(y.tick(0.0), Some(200.0));
        assert_eq!(y.tick(25.0), Some(150.0));
        assert_eq!(y.tick(100.0), Some(0.0));
        assert_eq!(y.tick(f64::NAN), None);
        // The extent, whatever the order.
        assert_eq!(
            Linear::new([100.0, 0.0], [200.0, 0.0]).tick(0.0),
            Some(200.0)
        );
        // One value: the middle.
        assert_eq!(Linear::new([5.0, 5.0], [0.0, 100.0]).tick(5.0), Some(50.0));
        assert_eq!(point_tick(0, 3, [0.0, 100.0]), Some(0.0));
        assert_eq!(point_tick(1, 3, [0.0, 100.0]), Some(50.0));
        assert_eq!(point_tick(2, 3, [0.0, 100.0]), Some(100.0));
        assert_eq!(point_tick(0, 1, [0.0, 100.0]), Some(50.0));
        assert_eq!(point_tick(3, 3, [0.0, 100.0]), None);
        assert_eq!(extent([3.0, f64::NAN, -1.0, 2.0]), Some([-1.0, 3.0]));
        assert_eq!(extent([f64::NAN]), None);
    }

    fn band(rows: usize, range: [f32; 2], f: impl FnOnce(&mut BandScale)) -> Band {
        let mut options = BandScale::default();
        f(&mut options);
        Band::new(rows, range, &options)
    }

    /// `gpui-base`'s `ScaleBand` tests (`scale/band.rs:166-265`), over row
    /// indices.
    #[test]
    fn bands_are_laid_out_as_gpui_base_lays_them_out() {
        let plain = band(3, [0.0, 90.0], |_| {});
        assert_eq!(plain.start(0), Some(0.0));
        assert_eq!(plain.start(1), Some(30.0));
        assert_eq!(plain.start(2), Some(60.0));
        assert_eq!(plain.width(), 30.0);
        assert_eq!(plain.step(), 30.0);
        assert_eq!(plain.center(1), Some(45.0));
        // Fractions between the middles (a grid line between bands).
        assert_eq!(plain.tick(0.5), Some(30.0));

        // Adjacent bands start one step apart, whatever the padding.
        let padded = band(3, [0.0, 90.0], |o| {
            o.padding_inner = Percentage(0.4);
            o.padding_outer = Percentage(0.2);
        });
        let gap = padded.start(1).unwrap() - padded.start(0).unwrap();
        assert!((padded.step() - gap).abs() < 1e-4);
        // A single band spans the range.
        assert_eq!(band(1, [0.0, 90.0], |_| {}).step(), 90.0);

        // `band_count`: the rows take the leading bands, placed as if all
        // were full; a count below the rows has no effect.
        let count = |rows| {
            band(rows, [0.0, 100.0], |o| {
                o.band_count = Some(4);
                o.padding_inner = Percentage(0.4);
                o.padding_outer = Percentage(0.2);
            })
        };
        assert_eq!(count(2).start(1), count(4).start(1));
        assert_eq!(count(2).width(), count(4).width());
        assert_eq!(count(1).start(0), count(4).start(0));
        assert_eq!(
            band(3, [0.0, 90.0], |o| o.band_count = Some(2)).start(2),
            Some(60.0)
        );

        // No bands; no room.
        let empty = band(0, [0.0, 90.0], |_| {});
        assert_eq!(empty.start(0), None);
        assert_eq!(empty.width(), 0.0);
        let flat = band(3, [0.0, 0.0], |_| {});
        assert_eq!(flat.start(2), Some(0.0));
        assert_eq!(flat.width(), 0.0);
        // The lower end leads whichever way the range is written.
        assert_eq!(band(3, [10.0, 100.0], |_| {}).start(1), Some(40.0));
        assert_eq!(band(3, [100.0, 10.0], |_| {}).start(0), Some(10.0));
    }

    /// `max_band_width` narrows a band in the middle of its place (where
    /// `gpui-base` keeps its start), so its middle stays where the app
    /// centers the band's label.
    #[test]
    fn a_narrowed_band_stays_in_the_middle_of_its_place() {
        let wide = band(2, [0.0, 200.0], |_| {});
        let capped = band(2, [0.0, 200.0], |o| o.max_band_width = Some(Points(30.0)));
        assert_eq!(wide.width(), 100.0);
        assert_eq!(capped.width(), 30.0);
        assert_eq!(capped.start(1), Some(135.0));
        assert_eq!(capped.center(1), wide.center(1));
    }

    /// Both paddings as d3 sets them: the outer gaps are equal, and with
    /// an inner padding twice the outer one, the bands' middles divide the
    /// range evenly (where labels in equal cells sit).
    #[test]
    fn padded_bands_sit_in_the_middle_of_the_range() {
        let padded = band(6, [0.0, 600.0], |o| {
            o.padding_inner = Percentage(0.3);
            o.padding_outer = Percentage(0.15);
        });
        let first = padded.start(0).unwrap();
        let end = padded.start(5).unwrap() + padded.width();
        assert!((first - (600.0 - end)).abs() < 1e-3, "{first} {end}");
        for i in 0..6 {
            let cell = 100.0 * i as f32 + 50.0;
            assert!((padded.center(i).unwrap() - cell).abs() < 1e-3);
        }
        assert!((padded.width() - 70.0).abs() < 1e-3);
    }

    /// The bars side by side in a band: one fills it, more share it with
    /// gaps between them and none at the ends.
    #[test]
    fn a_group_shares_its_band() {
        let one = Band::group(1, 30.0, 0.5);
        assert_eq!((one.start(0), one.width()), (Some(0.0), 30.0));
        let two = Band::group(2, 30.0, 0.0);
        assert_eq!((two.start(1), two.width()), (Some(15.0), 15.0));
        let gapped = Band::group(3, 30.0, 0.25);
        let end = gapped.start(2).unwrap() + gapped.width();
        assert!((end - 30.0).abs() < 1e-4, "{end}");
        assert!(gapped.start(1).unwrap() - gapped.width() > 0.0);
    }

    fn colors(scale: &OrdinalScale, met: &mut Vec<SharedString>, of: &[&str]) -> Vec<Option<Hsla>> {
        of.iter().map(|c| scale.color(met, c)).collect()
    }

    /// d3's `scaleOrdinal` (and `gpui-base`'s `ScaleOrdinal` tests,
    /// `scale/ordinal.rs:70-104`): the domain's order, the range repeating
    /// over a longer domain, a category written twice keeping its first
    /// place, and no color without a range or for a row without a
    /// category.
    #[test]
    fn an_ordinal_scale_maps_its_domain_in_order_and_repeats_its_range() {
        let [red, green, blue] = [0xff0000ff, 0x00ff00ff, 0x0000ffff].map(|c| Hsla::from(Color(c)));
        let scale = OrdinalScale::new(["a", "b", "c", "d", "e"], [red, green, blue]);
        let mut met = Vec::new();
        assert_eq!(
            colors(&scale, &mut met, &["a", "b", "c", "d", "e"]),
            [Some(red), Some(green), Some(blue), Some(red), Some(green)]
        );
        // The domain's order, not the rows'.
        assert_eq!(
            colors(&scale, &mut met, &["e", "a"]),
            [Some(green), Some(red)]
        );
        assert!(met.is_empty());
        let twice = OrdinalScale::new(["a", "a", "b"], [red, green, blue]);
        assert_eq!(colors(&twice, &mut met, &["b"]), [Some(green)]);
        assert_eq!(colors(&scale, &mut met, &[""]), [None]);
        let empty = OrdinalScale::new(["a"], Vec::<Hsla>::new());
        assert_eq!(colors(&empty, &mut met, &["a", "z"]), [None, None]);
        assert!(met.is_empty());
    }

    /// A category outside the domain: `unknown` where it is set
    /// (`ScaleOrdinal::unknown`); otherwise d3's implicit domain, the
    /// category added after the domain the first time it is met, taking
    /// the next color and keeping it.
    #[test]
    fn an_ordinal_scale_takes_unknown_categories_as_d3_does() {
        let [red, green, blue, gray] =
            [0xff0000ff, 0x00ff00ff, 0x0000ffff, 0x999999ff].map(|c| Hsla::from(Color(c)));
        let fixed = OrdinalScale::new(["a"], [red, green, blue]).unknown(gray);
        let mut met = Vec::new();
        assert_eq!(
            colors(&fixed, &mut met, &["z", "a", "y"]),
            [Some(gray), Some(red), Some(gray)]
        );
        assert!(met.is_empty());

        let implicit = OrdinalScale::new(["a"], [red, green, blue]);
        assert_eq!(
            colors(&implicit, &mut met, &["z", "a", "y", "z", "x"]),
            [Some(green), Some(red), Some(blue), Some(green), Some(red)]
        );
        assert_eq!(met, ["z", "y", "x"].map(SharedString::from));
        // Met before, the same color, whatever comes first now.
        assert_eq!(
            colors(&implicit, &mut met, &["x", "y"]),
            [Some(red), Some(blue)]
        );
        // No domain at all: the order the categories are met in.
        let mut met = Vec::new();
        let none = OrdinalScale::new(Vec::<SharedString>::new(), [red, green]);
        assert_eq!(
            colors(&none, &mut met, &["q", "p", "q", "r"]),
            [Some(red), Some(green), Some(red), Some(red)]
        );
    }

    /// A reversed band scale (`reverse`, d3's range written backwards):
    /// the first band at the end of the range, the same widths and gaps,
    /// and the values between bands running back with them.
    #[test]
    fn a_reversed_band_scale_starts_at_the_end() {
        let reversed = band(3, [0.0, 90.0], |o| o.reverse = true);
        assert_eq!(reversed.start(0), Some(60.0));
        assert_eq!(reversed.start(2), Some(0.0));
        assert_eq!(reversed.center(0), Some(75.0));
        assert_eq!(reversed.tick(0.5), Some(60.0));
        assert_eq!(reversed.tick(2.0), Some(15.0));
        assert!(AxisMap::Band(reversed).backward());
        // Narrowed bands stay in the middle of their places.
        let capped = band(2, [0.0, 200.0], |o| {
            o.max_band_width = Some(Points(30.0));
            o.reverse = true;
        });
        assert_eq!(capped.start(0), Some(135.0));
        // A reversed range of the other scales runs back too.
        let x = Linear::new([0.0, 100.0], [200.0, 0.0]);
        assert!(AxisMap::Linear(x).backward());
        assert!(!AxisMap::Linear(Linear::new([0.0, 100.0], [0.0, 200.0])).backward());
        assert_eq!(point_tick(0, 3, [100.0, 0.0]), Some(100.0));
    }

    /// A sequential ramp (d3's `scaleSequential`): the domain's ends take
    /// the range's ends, the colors between spread evenly and mixed in
    /// OKLab, values outside the domain clamped, no value `unknown`, one
    /// value the middle; without a domain, the values' extent.
    #[test]
    fn a_sequential_scale_ramps_its_colors_in_oklab() {
        let [white, blue, gray] =
            [0xffffffff, 0x0000ffff, 0x999999ff].map(|c| Hsla::from(Color(c)));
        let mut scale = SequentialScale::new([white, blue]);
        scale.unknown = Some(gray);
        let ramp = ColorScale::from(scale.clone());
        let domain = ramp.domain(Some([0.0, 10.0])).unwrap();
        assert_eq!(domain, [0.0, 10.0]);
        assert_eq!(ramp.shade(0.0, domain), Some(white));
        assert_eq!(ramp.shade(10.0, domain), Some(blue));
        assert_eq!(ramp.shade(5.0, domain), Some(blue.mix_oklab(white, 0.5)));
        assert_eq!(ramp.shade(-3.0, domain), Some(white));
        assert_eq!(ramp.shade(99.0, domain), Some(blue));
        assert_eq!(ramp.shade(f64::NAN, domain), Some(gray));
        assert_eq!(
            ramp.shade(4.0, [4.0, 4.0]),
            Some(blue.mix_oklab(white, 0.5))
        );
        // The app's domain over the extent; none without either.
        let fixed = ColorScale::from(scale.domain([0.0, 100.0]));
        assert_eq!(fixed.domain(Some([0.0, 10.0])), Some([0.0, 100.0]));
        assert_eq!(
            ColorScale::from(SequentialScale::new([white])).domain(None),
            None
        );
        // Three colors: the middle one halfway.
        let three = ColorScale::from(SequentialScale::new([white, gray, blue]));
        assert_eq!(three.shade(5.0, domain), Some(gray));
        // An ordinal scale colors no number.
        assert_eq!(ColorScale::default().shade(1.0, domain), None);
    }

    /// A diverging ramp (d3's `scaleDiverging`, Observable Plot's
    /// `pivot`): the pivot takes the middle color, each side of it its
    /// half of the ramp, however lopsided the domain; without a domain, the
    /// extent made even about the pivot.
    #[test]
    fn a_diverging_scale_puts_its_pivot_in_the_middle() {
        let [red, white, green] =
            [0xff0000ff, 0xffffffff, 0x00ff00ff].map(|c| Hsla::from(Color(c)));
        let scale = ColorScale::from(DivergingScale::new([red, white, green]));
        // Even about 0: a loss of 4 as strong as a gain of 4.
        let domain = scale.domain(Some([-2.0, 4.0])).unwrap();
        assert_eq!(domain, [-4.0, 4.0]);
        assert_eq!(scale.shade(0.0, domain), Some(white));
        assert_eq!(scale.shade(-4.0, domain), Some(red));
        assert_eq!(scale.shade(4.0, domain), Some(green));
        assert_eq!(scale.shade(-2.0, domain), Some(white.mix_oklab(red, 0.5)));
        // A lopsided domain keeps the pivot in the middle.
        assert_eq!(
            scale.shade(5.0, [-1.0, 10.0]),
            Some(green.mix_oklab(white, 0.5))
        );
        assert_eq!(
            scale.shade(-0.5, [-1.0, 10.0]),
            Some(white.mix_oklab(red, 0.5))
        );
        // Another pivot.
        let about = ColorScale::from(DivergingScale::new([red, white, green]).pivot(100.0));
        assert_eq!(about.domain(Some([90.0, 105.0])), Some([90.0, 110.0]));
        assert_eq!(about.shade(100.0, [90.0, 110.0]), Some(white));
        // All values on the pivot: the middle.
        assert_eq!(scale.shade(0.0, [0.0, 0.0]), Some(white));
        assert_eq!(scale.shade(f64::NAN, domain), None);
    }

    /// A band domain without repeats keeps each category's first place.
    #[test]
    fn band_categories_keep_their_first_place() {
        let domain = categories(["b", "a", "b", "c"].map(SharedString::from).to_vec());
        assert_eq!(&*domain, ["b", "a", "c"].map(SharedString::from));
    }
}
