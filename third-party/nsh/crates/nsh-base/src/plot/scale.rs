//! Scales: where a value goes along an axis of a plot, as `gpui-base`'s
//! `plot::scale` (d3-scale's): the app names the kind and the domain, the
//! plot's size is the range.

use nsh_core::ui::{JsHost, JsIn, JsOwned, JsValue, PropError, TsTypes};

/// How an axis of a [`Plot`](super::Plot) places values (TS `Scale`), as
/// `gpui-base`'s scales: `{ type: "point" }` places the rows in order,
/// evenly from one edge to the other (`ScalePoint`), and `{ type:
/// "linear", domain? }` places a number in proportion to where it lies in
/// its domain, the extent of `[min, max]` (`ScaleLinear`; the extent of
/// what the plot draws when it has none).
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
}

impl JsValue for Scale {
    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("Scale", |_| {
            "/** How an axis of a `Plot` places values: `point` places the rows in order, evenly from one edge to the other; `linear` places a number in proportion to where it lies in its `domain` (the extent of the two values; without one, the extent of what the plot draws). */\nexport type Scale = { type: \"point\" } | { type: \"linear\"; domain?: [number, number] };\n".to_owned()
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
            _ => Err(value.expected("`{ type: \"point\" }` or `{ type: \"linear\" }`")),
        }
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        let object = JsOwned::new(host, host.new_object()?);
        let kind = match self {
            Scale::Point => "point",
            Scale::Linear { .. } => "linear",
        };
        host.set_field(object.get().raw(), "type", host.new_string(kind)?)?;
        if let Scale::Linear {
            domain: Some([a, b]),
        } = self
        {
            let ends = vec![*a, *b].to_js(host)?;
            host.set_field(object.get().raw(), "domain", ends.into_raw())?;
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
}
