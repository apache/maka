//! The rules of a number taken in a range with a step, shared by the
//! controls that take one (`Slider`; a number input next): where a value
//! snaps to, how far a key moves it, where it sits along a control (on a
//! linear or a logarithmic scale) and how it reads as text.
//!
//! Values are `f64`, JS's numbers: a value the app gets back is exactly
//! the one it would write (an `f32` `0.1` reaches JS as
//! `0.10000000149011612`).

/// How values spread along a control.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum Scale {
    /// Evenly.
    #[default]
    Linear,
    /// By orders of magnitude: each tenth of the way multiplies the
    /// value by the same factor (a volume, a frequency, a zoom).
    Logarithmic,
}

/// The fraction of a range a page key moves a value by (WAI-ARIA's
/// slider pattern: "a larger amount than the step").
const PAGE: f64 = 0.1;

/// The fraction of a range one key moves a value by when it has no step.
const FREE_STEP: f64 = 0.01;

/// A range of numbers with a step and a scale, made valid whatever it was
/// given: a non-finite `min` is 0, a `max` below `min` is `min`, a step
/// that is not positive (or not finite) is none (any value), and a
/// logarithmic scale needs `min > 0` (as `gpui-base`'s asserts), else it
/// is linear.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Range {
    min: f64,
    max: f64,
    step: f64,
    scale: Scale,
}

impl Range {
    pub(crate) fn new(min: f64, max: f64, step: f64, scale: Scale) -> Self {
        let min = if min.is_finite() { min } else { 0.0 };
        let max = if max.is_finite() && max >= min {
            max
        } else {
            min
        };
        let step = if step.is_finite() && step > 0.0 {
            step
        } else {
            0.0
        };
        let scale = match scale {
            Scale::Logarithmic if min > 0.0 && max > min => Scale::Logarithmic,
            _ => Scale::Linear,
        };
        Self {
            min,
            max,
            step,
            scale,
        }
    }

    pub(crate) fn min(&self) -> f64 {
        self.min
    }

    pub(crate) fn max(&self) -> f64 {
        self.max
    }

    /// `v` held to the range; `NaN` is `min`.
    pub(crate) fn clamp(&self, v: f64) -> f64 {
        if v.is_nan() {
            self.min
        } else {
            v.clamp(self.min, self.max)
        }
    }

    /// The value nearest `v` that the range takes: `min`, `min` plus a
    /// whole number of steps, or `max` (so the last step may be shorter,
    /// and `max` is always reachable). Steps count from `min`, not from 0
    /// (`gpui-base` rounds `value / step`, which leaves a range starting
    /// off the step's grid, `min` 1 with `step` 2, between its values).
    /// The result carries no more decimals than the step and `min`, so
    /// `0.1 + 0.2` snaps to `0.3`.
    pub(crate) fn snap(&self, v: f64) -> f64 {
        let v = self.clamp(v);
        if self.step == 0.0 {
            return v;
        }
        let k = ((v - self.min) / self.step).floor();
        let lo = self.min + k * self.step;
        let hi = (lo + self.step).min(self.max);
        let nearest = if v - lo < hi - v { lo } else { hi };
        self.clamp(self.round(nearest))
    }

    /// `v` rounded to the decimals of the step and `min`.
    fn round(&self, v: f64) -> f64 {
        let d = decimals(self.step).max(decimals(self.min));
        let scale = 10f64.powi(d);
        (v * scale).round() / scale
    }

    /// Where `v` sits along the range, from 0 at `min` to 1 at `max`.
    pub(crate) fn fraction(&self, v: f64) -> f64 {
        let v = self.clamp(v);
        if self.max <= self.min {
            return 0.0;
        }
        let f = match self.scale {
            Scale::Linear => (v - self.min) / (self.max - self.min),
            Scale::Logarithmic => (v / self.min).ln() / (self.max / self.min).ln(),
        };
        f.clamp(0.0, 1.0)
    }

    /// The value at `fraction` of the way from `min` to `max` (not
    /// snapped).
    pub(crate) fn value_at(&self, fraction: f64) -> f64 {
        let f = if fraction.is_nan() {
            0.0
        } else {
            fraction.clamp(0.0, 1.0)
        };
        let v = match self.scale {
            Scale::Linear => self.min + (self.max - self.min) * f,
            Scale::Logarithmic => self.min * (self.max / self.min).powf(f),
        };
        self.clamp(v)
    }

    /// `v` moved by `steps` steps (negative: down) and snapped: what an
    /// arrow key and a screen reader's increment do. Without a step, a
    /// hundredth of the range is one.
    pub(crate) fn step_by(&self, v: f64, steps: f64) -> f64 {
        let step = if self.step > 0.0 {
            self.step
        } else {
            (self.max - self.min) * FREE_STEP
        };
        let from = self.clamp(v);
        let next = from + steps * step;
        if self.step > 0.0 {
            // From a value off the grid (the app's), the first step lands
            // on the grid in its direction rather than one step away.
            let snapped = self.snap(next);
            let off = (self.snap(from) - from).abs() > step * 1e-9;
            if off {
                let grid = self.snap(from);
                if steps > 0.0 && grid > from || steps < 0.0 && grid < from {
                    return grid;
                }
            }
            snapped
        } else {
            self.clamp(next)
        }
    }

    /// `v` moved a tenth of the way along the range (`direction` 1 up, -1
    /// down), on its scale, and snapped, by at least one step: what Page
    /// Up and Page Down do.
    pub(crate) fn page(&self, v: f64, direction: f64) -> f64 {
        let from = self.clamp(v);
        let next = self.snap(self.value_at(self.fraction(from) + direction * PAGE));
        if next == self.snap(from) {
            self.step_by(from, direction)
        } else {
            next
        }
    }

    /// `v` as text, with the decimals of the step and `min` and no
    /// trailing zeros (`2.5`, `3`): what screen readers say.
    pub(crate) fn format(&self, v: f64) -> String {
        let d = decimals(self.step).max(decimals(self.min)) as usize;
        let text = format!("{v:.d$}");
        let text = if text.contains('.') {
            text.trim_end_matches('0').trim_end_matches('.').to_owned()
        } else {
            text
        };
        if text == "-0" { "0".to_owned() } else { text }
    }
}

/// How many decimals `x` has (at most 10): 0 for `5`, 1 for `0.5`, 2 for
/// `0.25`.
fn decimals(x: f64) -> i32 {
    if !x.is_finite() {
        return 0;
    }
    let mut v = x.abs();
    let mut d = 0;
    while d < 10 && (v - v.round()).abs() > 1e-9 * v.max(1.0) {
        v *= 10.0;
        d += 1;
    }
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    fn linear(min: f64, max: f64, step: f64) -> Range {
        Range::new(min, max, step, Scale::Linear)
    }

    #[test]
    fn values_snap_to_steps_counted_from_min() {
        let r = linear(0.0, 100.0, 1.0);
        assert_eq!(r.snap(49.4), 49.0);
        assert_eq!(r.snap(49.5), 50.0);
        // From `min`, not from 0: 1, 3, 5, ...
        let odd = linear(1.0, 9.0, 2.0);
        assert_eq!(odd.snap(2.2), 3.0);
        assert_eq!(odd.snap(1.9), 1.0);
        assert_eq!(odd.snap(8.9), 9.0);
        // Decimals of the step only.
        let tenths = linear(0.0, 1.0, 0.1);
        assert_eq!(tenths.snap(0.1 + 0.2), 0.3);
        assert_eq!(tenths.snap(0.74), 0.7);
    }

    #[test]
    fn max_is_reachable_when_the_last_step_is_shorter() {
        let r = linear(0.0, 10.0, 3.0);
        assert_eq!(r.snap(8.0), 9.0);
        assert_eq!(r.snap(9.4), 9.0);
        assert_eq!(r.snap(9.6), 10.0);
        assert_eq!(r.snap(12.0), 10.0);
    }

    #[test]
    fn values_outside_the_range_are_held_to_it() {
        let r = linear(-5.0, 5.0, 1.0);
        assert_eq!(r.snap(-50.0), -5.0);
        assert_eq!(r.snap(f64::NAN), -5.0);
        assert_eq!(r.clamp(7.0), 5.0);
        // A max below min is min.
        let flat = linear(3.0, 1.0, 1.0);
        assert_eq!(flat.max(), 3.0);
        assert_eq!(flat.fraction(3.0), 0.0);
        // No step: any value in the range.
        let free = linear(0.0, 1.0, 0.0);
        assert_eq!(free.snap(0.123), 0.123);
    }

    #[test]
    fn a_linear_scale_maps_evenly() {
        let r = linear(0.0, 200.0, 1.0);
        assert_eq!(r.fraction(50.0), 0.25);
        assert_eq!(r.value_at(0.75), 150.0);
        assert_eq!(r.value_at(2.0), 200.0);
    }

    #[test]
    fn a_logarithmic_scale_maps_by_orders_of_magnitude() {
        let r = Range::new(1.0, 1000.0, 0.0, Scale::Logarithmic);
        assert!((r.fraction(10.0) - 1.0 / 3.0).abs() < 1e-9);
        assert!((r.value_at(2.0 / 3.0) - 100.0).abs() < 1e-9);
        assert_eq!(r.value_at(0.0), 1.0);
        assert_eq!(r.value_at(1.0), 1000.0);
        // Without a positive min it is linear (gpui-base panics).
        let zero = Range::new(0.0, 100.0, 1.0, Scale::Logarithmic);
        assert_eq!(zero.fraction(50.0), 0.5);
    }

    #[test]
    fn keys_move_by_a_step_and_a_page() {
        let r = linear(0.0, 100.0, 1.0);
        assert_eq!(r.step_by(40.0, 1.0), 41.0);
        assert_eq!(r.step_by(0.0, -1.0), 0.0);
        assert_eq!(r.page(40.0, 1.0), 50.0);
        assert_eq!(r.page(95.0, 1.0), 100.0);
        assert_eq!(r.page(40.0, -1.0), 30.0);
        // A value off the grid steps onto it first.
        let fives = linear(0.0, 100.0, 5.0);
        assert_eq!(fives.step_by(42.0, 1.0), 45.0);
        assert_eq!(fives.step_by(42.0, -1.0), 40.0);
        // A page smaller than a step moves one step.
        let coarse = linear(0.0, 10.0, 5.0);
        assert_eq!(coarse.page(0.0, 1.0), 5.0);
        // No step: a hundredth of the range.
        let free = linear(0.0, 1.0, 0.0);
        assert!((free.step_by(0.5, 1.0) - 0.51).abs() < 1e-9);
    }

    #[test]
    fn a_page_follows_the_scale() {
        let r = Range::new(1.0, 1000.0, 1.0, Scale::Logarithmic);
        // A tenth of three orders of magnitude: about 2x.
        assert_eq!(r.page(10.0, 1.0), 20.0);
    }

    #[test]
    fn values_read_with_the_steps_decimals() {
        assert_eq!(linear(0.0, 10.0, 0.5).format(2.5), "2.5");
        assert_eq!(linear(0.0, 10.0, 0.5).format(3.0), "3");
        assert_eq!(linear(0.0, 100.0, 1.0).format(40.0), "40");
        assert_eq!(linear(0.0, 1.0, 0.01).format(0.3), "0.3");
        assert_eq!(linear(-1.0, 1.0, 1.0).format(-0.0), "0");
    }
}
