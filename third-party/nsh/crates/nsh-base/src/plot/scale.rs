//! Scales: where a value goes along an axis of a plot, as `gpui-base`'s
//! `plot::scale` (d3-scale's): the app names the kind and the domain, the
//! plot's size is the range.

use std::sync::Arc;

use nsh_core::{
    element::{JsHost, JsIn, JsOwned, JsValue, PropError, TsTypes},
    geometry::{Percentage, Points},
};

/// How an axis of a [`Plot`](super::Plot) places values (TS `Scale`), as
/// `gpui-base`'s scales: `{ type: "point" }` places the rows in order,
/// evenly from one edge to the other (`ScalePoint`); `{ type: "linear",
/// domain? }` places a number in proportion to where it lies in its
/// domain, the extent of `[min, max]` (`ScaleLinear`; the extent of what
/// the plot draws when it has none); and `{ type: "band", … }` gives each
/// row a band of the axis, in order, for the bars drawn in it
/// (`ScaleBand`).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum Scale {
    /// One position per row, evenly spaced, the first and last at the
    /// edges (one row: the middle).
    #[default]
    Point,
    /// Values in proportion, the domain's smallest at the start of the
    /// range and its largest at the end.
    Linear {
        /// The values at the two ends (in either order); `None`: the
        /// extent of what the plot draws.
        domain: Option<[f64; 2]>,
    },
    /// One band per row, in order, with gaps between them and at the ends
    /// (`ScaleBand`).
    Band(BandScale),
}

/// The options of a band scale (`gpui-base`'s `ScaleBand` builders): the
/// gaps, as shares of a band's step, the widest a band may be, and how
/// many bands the axis is laid out for.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
#[non_exhaustive]
pub struct BandScale {
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
}

impl JsValue for Scale {
    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("Scale", |_| {
            "/** How an axis of a `Plot` places values: `point` places the rows in order, evenly from one edge to the other; `linear` places a number in proportion to where it lies in its `domain` (the extent of the two values; without one, the extent of what the plot draws); `band` gives each row a band of the axis, in order, for the bars drawn in it: `paddingInner` is the gap between bands and `paddingOuter` the gap at the ends (shares of a band, 0 by default), `maxBandWidth` the widest a band may be (points), `bandCount` the bands the axis is laid out for when more than the rows, and `groupPadding` the gap between the bars side by side in a band (a share of a bar's place). */\nexport type Scale = { type: \"point\" } | { type: \"linear\"; domain?: [number, number] } | { type: \"band\"; paddingInner?: number; paddingOuter?: number; maxBandWidth?: number; bandCount?: number; groupPadding?: number };\n".to_owned()
        })
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        let kind = value.field("type")?;
        match kind.get().as_string().as_deref() {
            Some("point") => Ok(Scale::Point),
            Some("linear") => {
                let domain = value.field("domain")?;
                let domain = domain.get();
                if domain.is_nullish() {
                    return Ok(Scale::Linear { domain: None });
                }
                let ends = Vec::<f64>::from_js(domain)?;
                match ends[..] {
                    [a, b] if a.is_finite() && b.is_finite() => Ok(Scale::Linear {
                        domain: Some([a, b]),
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
                // As d3 takes them: an inner gap of at most the whole band.
                Ok(Scale::Band(BandScale {
                    padding_inner: Percentage(
                        number("paddingInner")?.unwrap_or(0.0).min(1.0) as f32
                    ),
                    padding_outer: Percentage(number("paddingOuter")?.unwrap_or(0.0) as f32),
                    max_band_width: number("maxBandWidth")?.map(|n| Points(n as f32)),
                    band_count: number("bandCount")?.map(|n| n as u32),
                    group_padding: Percentage(
                        number("groupPadding")?.unwrap_or(0.0).min(1.0) as f32
                    ),
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
            Scale::Point => "point",
            Scale::Linear { .. } => "linear",
            Scale::Band(_) => "band",
        };
        host.set_field(raw, "type", host.new_string(kind)?)?;
        match self {
            Scale::Linear {
                domain: Some([a, b]),
            } => {
                let ends = vec![*a, *b].to_js(host)?;
                host.set_field(raw, "domain", ends.into_raw())?;
            }
            Scale::Band(band) => {
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
        Ok(object)
    }
}

/// A linear map from a domain to a range (`ScaleLinear`): `start` to
/// `range[0]`, `start + diff` to `range[1]`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Linear {
    start: f64,
    diff: f64,
    range: [f32; 2],
}

impl Linear {
    /// The map of the extent of `domain` onto `range`.
    pub(crate) fn new(domain: [f64; 2], range: [f32; 2]) -> Self {
        let (lo, hi) = (domain[0].min(domain[1]), domain[0].max(domain[1]));
        Self {
            start: lo,
            diff: hi - lo,
            range,
        }
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
}

impl Band {
    /// `rows` bands (or `band_count` when more) across `range`.
    pub(crate) fn new(rows: usize, range: [f32; 2], options: BandScale) -> Self {
        Self {
            len: rows.max(options.band_count.unwrap_or(0) as usize),
            start: range[0].min(range[1]),
            diff: (range[1] - range[0]).abs(),
            padding_inner: options.padding_inner.0,
            padding_outer: options.padding_outer.0,
            max_width: options.max_band_width.map(|w| w.0),
            group_padding: options.group_padding.0,
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
        }
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
    /// `max_width` in the middle of its place.
    pub(crate) fn start(&self, index: usize) -> Option<f32> {
        if index >= self.len {
            return None;
        }
        let step = self.step();
        // The bands and their inner gaps, in the middle of the range.
        let first = self.start + (self.diff - step * (self.len as f32 - self.padding_inner)) / 2.0;
        let full = self.full_width();
        Some(first + index as f32 * step + (full - self.width()) / 2.0)
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
        Some(first + value as f32 * self.step())
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

#[cfg(test)]
mod tests {
    use super::*;

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
        Band::new(rows, range, options)
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
}
