//! The rules of a number taken in a range with a step, shared by the
//! controls that take one (`Slider`, `NumberInput`): where a value snaps
//! to, how far a key moves it, where it sits along a control (on a linear
//! or a logarithmic scale) and how it reads as text; and the rules of a
//! number typed as text (`NumberInput`): which text is a number or on the
//! way to one, what other keyboards' digits and signs read as, and how a
//! step moves the text.
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

/// A number's text with its other spellings made ASCII (`gpui-base`'s
/// `normalize_number_input`): full-width digits, signs and dot, the minus
/// sign (U+2212) and the ideographic full stop; and a decimal comma (a
/// full-width one too), which the decimal key of many languages' keyboards
/// types, read as the decimal point while the text has no point of its own.
pub(crate) fn normalize_number_text(text: &str) -> String {
    let ascii: String = text
        .chars()
        .map(|c| match c {
            '\u{FF10}'..='\u{FF19}' => char::from_u32(c as u32 - 0xFF10 + '0' as u32).unwrap_or(c),
            '\u{FF0B}' => '+',
            '\u{FF0D}' | '\u{2212}' => '-',
            '\u{FF0E}' | '\u{3002}' => '.',
            '\u{FF0C}' => ',',
            c => c,
        })
        .collect();
    if !ascii.contains('.') && ascii.matches(',').count() == 1 {
        ascii.replacen(',', ".", 1)
    } else {
        ascii
    }
}

/// Whether `text` is a number or on the way to one, as the user types it
/// (`gpui-base`'s `MaskPattern::Number` without a group separator): digits
/// with at most one decimal point and one sign, the sign first. The empty
/// text, `-`, `+`, `.`, `-.` and `1.` are on the way.
pub(crate) fn is_number_text(text: &str) -> bool {
    let mut parts = text.split('.');
    let int = parts.next().unwrap_or("");
    let fraction = parts.next();
    if parts.next().is_some() {
        return false;
    }
    let digits = int.strip_prefix(['+', '-']).unwrap_or(int);
    digits.chars().all(|c| c.is_ascii_digit())
        && fraction.is_none_or(|f| f.chars().all(|c| c.is_ascii_digit()))
}

/// The number `text` reads as: none for the empty text and the ones on the
/// way to a number (`-`, `.`), `1` for `1.`, `0.5` for `.5`.
pub(crate) fn parse_number(text: &str) -> Option<f64> {
    let text = text.trim();
    if !is_number_text(text) {
        return None;
    }
    text.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// `v` as a number input shows a value it did not type: the shortest text
/// that reads back as `v` (`0.3`, `12`, never `-0`).
pub(crate) fn number_text(v: f64) -> String {
    if v == 0.0 {
        "0".to_owned()
    } else {
        format!("{v}")
    }
}

/// `step` times `n`, with the step's decimals and no float noise (`0.3`
/// times 10 is `3`, not `3.0000000000000004`): a page of steps.
pub(crate) fn steps(step: f64, n: f64) -> f64 {
    let scale = 10f64.powi(decimals(step));
    (step * scale * n).round() / scale
}

/// `v` held to `min` and `max`, either of which may be absent.
pub(crate) fn clamp_to(v: f64, min: Option<f64>, max: Option<f64>) -> f64 {
    let v = min.map_or(v, |min| v.max(min));
    max.map_or(v, |max| v.min(max))
}

/// The text a step up (`up`) or down by `step` makes of `text`, held to
/// `min` and `max` (`gpui-base`'s `step_value`): an empty text, or one on
/// the way to a number, counts as 0; the result keeps the decimals of the
/// text, of the step and of a bound it was held to (`0.1` up by `0.2` is
/// `0.3`, `99.5` up by 1 to at most 100 is `100.0`). `None` when the step
/// would not move the value the way it goes (at a bound, or outside the
/// range on the other side): the step does nothing.
pub(crate) fn step_text(
    text: &str,
    up: bool,
    step: f64,
    min: Option<f64>,
    max: Option<f64>,
) -> Option<String> {
    fn fraction_digits(text: &str) -> usize {
        text.split('.').nth(1).map_or(0, str::len)
    }
    let current = parse_number(text);
    let from = current.unwrap_or(0.0);
    let mut next = if up { from + step } else { from - step };
    let mut digits = fraction_digits(text.trim()).max(fraction_digits(&step.to_string()));
    if let Some(min) = min
        && next < min
    {
        next = min;
        digits = digits.max(fraction_digits(&min.to_string()));
    }
    if let Some(max) = max
        && next > max
    {
        next = max;
        digits = digits.max(fraction_digits(&max.to_string()));
    }
    if let Some(current) = current {
        let moved = if up { next > current } else { next < current };
        if !moved {
            return None;
        }
    }
    let text = format!("{next:.digits$}");
    // A step to zero with a little float noise below it (`-0.0`): no sign.
    match text.strip_prefix('-') {
        Some(zero) if zero.chars().all(|c| c == '0' || c == '.') => Some(zero.to_owned()),
        _ => Some(text),
    }
}

/// Whether [`step_text`] of the same arguments moves the value (is
/// `Some`), from the numbers alone: no text is made.
pub(crate) fn can_step_text(
    text: &str,
    up: bool,
    step: f64,
    min: Option<f64>,
    max: Option<f64>,
) -> bool {
    let Some(current) = parse_number(text) else {
        return true;
    };
    let next = clamp_to(if up { current + step } else { current - step }, min, max);
    if up { next > current } else { next < current }
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

    #[test]
    fn whether_a_step_moves_is_known_without_its_text() {
        let texts = ["", "-", "0", "0.5", "-3", "9.99", "10", "100", "1e"];
        let bounds = [None, Some(0.0), Some(10.0), Some(-5.0)];
        for text in texts {
            for up in [true, false] {
                for step in [1.0, 0.25, 20.0] {
                    for min in bounds {
                        for max in bounds {
                            assert_eq!(
                                can_step_text(text, up, step, min, max),
                                step_text(text, up, step, min, max).is_some(),
                                "{text:?} up {up} by {step} in {min:?}..{max:?}"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn steps_keep_the_decimals_and_go_the_way_they_are_pressed() {
        // `gpui-base`'s `number_input.rs` tests and its styled layer's
        // `test_step_value`, case by case.
        let up = |t: &str, step, min, max| step_text(t, true, step, min, max);
        let down = |t: &str, step, min, max| step_text(t, false, step, min, max);
        let some = |t: &str| Some(t.to_owned());
        // From an empty text, or one on the way to a number: from 0.
        assert_eq!(up("", 1.0, None, None), some("1"));
        assert_eq!(down("", 1.0, None, None), some("-1"));
        assert_eq!(up("-", 1.0, None, None), some("1"));
        assert_eq!(up("1", 1.0, None, None), some("2"));
        assert_eq!(up("-2", 1.0, None, None), some("-1"));
        // No float noise: 0.1 + 0.2 is 0.3.
        assert_eq!(up("0.1", 0.2, None, None), some("0.3"));
        assert_eq!(down("0.3", 0.1, None, None), some("0.2"));
        // The text's decimals stay.
        assert_eq!(up("1.25", 1.0, None, None), some("2.25"));
        // From empty, into the range both ways.
        assert_eq!(up("", 1.0, Some(10.0), None), some("10"));
        assert_eq!(down("", 1.0, Some(10.0), None), some("10"));
        // Held to the bounds, with the decimals of the text or the bound.
        assert_eq!(up("99.5", 1.0, None, Some(100.0)), some("100.0"));
        assert_eq!(down("1000", 1.0, None, Some(100.0)), some("100"));
        assert_eq!(down("1", 1.0, Some(0.25), None), some("0.25"));
        assert_eq!(down("5", 10.0, Some(0.0), None), some("0"));
        // Nothing at a bound, nor against the way pressed.
        assert_eq!(down("10", 1.0, Some(10.0), None), None);
        assert_eq!(up("100", 1.0, None, Some(100.0)), None);
        assert_eq!(down("5", 1.0, Some(10.0), None), None);
        assert_eq!(up("1000", 1.0, None, Some(100.0)), None);
        // No sign on zero.
        assert_eq!(up("-0.5", 0.5, None, None), some("0.0"));
        assert_eq!(down("0.3", 0.3, None, None), some("0.0"));
    }

    #[test]
    fn number_texts_take_what_is_on_the_way_to_a_number() {
        // `gpui-base`'s `test_signed_number_numbers` and
        // `test_number_leading_dot`, without a group separator.
        for ok in [
            "",
            "-",
            "+",
            ".",
            "-.",
            "1.",
            "-1.",
            ".5",
            "-.5",
            "+1234567.89",
            "007",
        ] {
            assert!(is_number_text(ok), "{ok:?}");
        }
        for bad in [
            "+-", "-+", "+-1", "12-3", "1.2.3", "1..", "+1.-", "1e5", "abc", "1 2", "1,5",
        ] {
            assert!(!is_number_text(bad), "{bad:?}");
        }
        assert_eq!(parse_number("1."), Some(1.0));
        assert_eq!(parse_number(".5"), Some(0.5));
        assert_eq!(parse_number("+3"), Some(3.0));
        assert_eq!(parse_number("-"), None);
        assert_eq!(parse_number("."), None);
        assert_eq!(parse_number(""), None);
        assert_eq!(parse_number("inf"), None);
        assert_eq!(parse_number("NaN"), None);
    }

    #[test]
    fn other_keyboards_digits_and_signs_read_as_ascii() {
        // `gpui-base`'s `test_normalize_number_input`.
        assert_eq!(normalize_number_text("０１２３４５６７８９"), "0123456789");
        assert_eq!(normalize_number_text("＋1．5"), "+1.5");
        assert_eq!(normalize_number_text("−1.5"), "-1.5");
        assert_eq!(normalize_number_text("12。5"), "12.5");
        assert_eq!(normalize_number_text("ab 中 1"), "ab 中 1");
        // A decimal comma, while the text has no point.
        assert_eq!(normalize_number_text("1,5"), "1.5");
        assert_eq!(normalize_number_text("－1，5"), "-1.5");
        assert_eq!(normalize_number_text("1,234.5"), "1,234.5");
        assert_eq!(normalize_number_text("1,2,3"), "1,2,3");
    }

    #[test]
    fn values_read_as_their_shortest_text() {
        assert_eq!(number_text(0.3), "0.3");
        assert_eq!(number_text(12.0), "12");
        assert_eq!(number_text(-0.0), "0");
        assert_eq!(number_text(-2.5), "-2.5");
        assert_eq!(clamp_to(5.0, Some(10.0), None), 10.0);
        assert_eq!(clamp_to(500.0, None, Some(100.0)), 100.0);
        assert_eq!(clamp_to(50.0, None, None), 50.0);
        assert_eq!(steps(0.3, 10.0), 3.0);
        assert_eq!(steps(0.01, 10.0), 0.1);
        assert_eq!(steps(5.0, 10.0), 50.0);
    }
}
