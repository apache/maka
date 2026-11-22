//! Number formatting (`Intl.NumberFormat`, `Number.prototype.
//! toLocaleString`): decimal digits rounded half away from zero (from the
//! shortest representation of a double, as ICU does: `1.005` rounds to
//! `1.01`), grouped and signed by the locale, with percent, currency, unit,
//! compact and scientific forms. The output is a list of parts
//! (`formatToParts`); `format` joins them.

use super::{Part, locale::Numbers};

/// What is formatted besides the number.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Style {
    Decimal,
    Percent,
    Currency {
        code: String,
        display: CurrencyDisplay,
    },
    Unit {
        unit: String,
        display: UnitDisplay,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CurrencyDisplay {
    Symbol,
    NarrowSymbol,
    Code,
    Name,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UnitDisplay {
    Short,
    Narrow,
    Long,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Notation {
    Standard,
    Scientific,
    Engineering,
    Compact { long: bool },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SignDisplay {
    Auto,
    Never,
    Always,
    ExceptZero,
    Negative,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Grouping {
    Always,
    /// The locale's (`true`).
    Auto,
    Min2,
    Off,
}

/// How digits are rounded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Rounding {
    Fraction {
        min: u8,
        max: u8,
    },
    Significant {
        min: u8,
        max: u8,
    },
    /// Both, keeping the more precise (`morePrecision`, compact's default)
    /// or the less precise result.
    Both {
        min_fraction: u8,
        max_fraction: u8,
        min_significant: u8,
        max_significant: u8,
        more: bool,
    },
}

/// Resolved options.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Format {
    pub(crate) style: Style,
    pub(crate) notation: Notation,
    pub(crate) sign: SignDisplay,
    pub(crate) grouping: Grouping,
    pub(crate) min_integer: u8,
    pub(crate) rounding: Rounding,
    /// `trailingZeroDisplay: "stripIfInteger"`.
    pub(crate) strip_if_integer: bool,
}

#[cfg(test)]
impl Format {
    /// `toLocaleString()`'s: up to three fraction digits, grouped.
    pub(crate) const DEFAULT: Format = Format {
        style: Style::Decimal,
        notation: Notation::Standard,
        sign: SignDisplay::Auto,
        grouping: Grouping::Auto,
        min_integer: 1,
        rounding: Rounding::Fraction { min: 0, max: 3 },
        strip_if_integer: false,
    };
}

/// The fraction digits of a currency (ISO 4217).
pub(crate) fn currency_digits(code: &str) -> u8 {
    match code {
        "JPY" | "KRW" | "VND" | "CLP" | "ISK" | "UGX" | "PYG" | "XAF" | "XOF" | "RWF" | "KMF"
        | "GNF" | "DJF" | "VUV" => 0,
        "BHD" | "KWD" | "OMR" | "JOD" | "IQD" | "LYD" | "TND" => 3,
        _ => 2,
    }
}

/// A number to format.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Value {
    Nan,
    Infinite { negative: bool },
    Finite(Decimal),
}

/// A finite decimal: `0.d₁d₂… × 10^point`, without leading or trailing
/// zeros (zero has no digits).
#[derive(Clone, Debug, PartialEq, Default)]
pub(crate) struct Decimal {
    pub(crate) negative: bool,
    pub(crate) digits: Vec<u8>,
    pub(crate) point: i32,
}

impl Value {
    /// A double, by its shortest representation.
    pub(crate) fn from_f64(x: f64) -> Value {
        if x.is_nan() {
            return Value::Nan;
        }
        if x.is_infinite() {
            return Value::Infinite { negative: x < 0.0 };
        }
        let negative = x.is_sign_negative();
        // `{:e}` writes the shortest digits that round-trip: `1.005e0`.
        let text = format!("{:e}", x.abs());
        let (mantissa, exponent) = text.split_once('e').unwrap_or((&text, "0"));
        let exponent: i32 = exponent.parse().unwrap_or(0);
        let digits: Vec<u8> = mantissa.bytes().filter(u8::is_ascii_digit).collect();
        let mut d = Decimal {
            negative,
            digits,
            point: exponent + 1,
        };
        d.normalize();
        Value::Finite(d)
    }

    /// A decimal string (`"-1234.5"`, `"1e21"`, a BigInt's digits); `None`
    /// when it is not one.
    pub(crate) fn parse(text: &str) -> Option<Value> {
        let text = text.trim();
        let (negative, rest) = match text.as_bytes().first() {
            Some(b'-') => (true, &text[1..]),
            Some(b'+') => (false, &text[1..]),
            _ => (false, text),
        };
        match rest {
            "Infinity" => return Some(Value::Infinite { negative }),
            "NaN" => return Some(Value::Nan),
            _ => {}
        }
        let (mantissa, exponent) = match rest.find(['e', 'E']) {
            Some(i) => (&rest[..i], rest[i + 1..].parse::<i32>().ok()?),
            None => (rest, 0),
        };
        let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
        if (int.is_empty() && frac.is_empty())
            || !int.bytes().chain(frac.bytes()).all(|b| b.is_ascii_digit())
        {
            return None;
        }
        let mut d = Decimal {
            negative,
            digits: int.bytes().chain(frac.bytes()).collect(),
            point: int.len() as i32 + exponent,
        };
        d.normalize();
        Some(Value::Finite(d))
    }
}

impl Decimal {
    fn normalize(&mut self) {
        let lead = self.digits.iter().take_while(|&&d| d == b'0').count();
        self.digits.drain(..lead);
        self.point -= lead as i32;
        while self.digits.last() == Some(&b'0') {
            self.digits.pop();
        }
        if self.digits.is_empty() {
            self.point = 0;
        }
    }

    fn is_zero(&self) -> bool {
        self.digits.is_empty()
    }

    /// The power of ten of the first digit (`1234`: 3).
    fn magnitude(&self) -> i32 {
        self.point - 1
    }

    /// Keeps the first `keep` digits, rounding half away from zero.
    fn round(&mut self, keep: i32) {
        if keep < 0 {
            self.digits.clear();
            self.point = 0;
            return;
        }
        let k = keep as usize;
        if k >= self.digits.len() {
            return;
        }
        let up = self.digits[k] >= b'5';
        self.digits.truncate(k);
        if up {
            let mut i = k;
            loop {
                if i == 0 {
                    self.digits.insert(0, b'1');
                    self.point += 1;
                    break;
                }
                i -= 1;
                if self.digits[i] == b'9' {
                    self.digits[i] = b'0';
                } else {
                    self.digits[i] += 1;
                    break;
                }
            }
        }
        self.normalize();
    }

    /// Rounded with `rounding`; the minimum fraction digits to show.
    fn rounded(&self, rounding: Rounding) -> (Decimal, usize) {
        let fraction = |min: u8, max: u8| {
            let mut d = self.clone();
            d.round(d.point + i32::from(max));
            (d, usize::from(min), -i32::from(max))
        };
        let significant = |min: u8, max: u8| {
            let mut d = self.clone();
            let magnitude = d.point - i32::from(max);
            d.round(i32::from(max));
            let shown = if d.is_zero() {
                i32::from(min) - 1
            } else {
                i32::from(min) - d.point
            };
            (d, shown.max(0) as usize, magnitude)
        };
        let (d, min, _) = match rounding {
            Rounding::Fraction { min, max } => fraction(min, max),
            Rounding::Significant { min, max } => significant(min, max),
            Rounding::Both {
                min_fraction,
                max_fraction,
                min_significant,
                max_significant,
                more,
            } => {
                let f = fraction(min_fraction, max_fraction);
                let s = significant(min_significant, max_significant);
                // The smaller rounding magnitude is the more precise one.
                if (s.2 <= f.2) == more { s } else { f }
            }
        };
        (d, min)
    }

    /// The integer and fraction digits, with at least `min_fraction`
    /// fraction digits and `min_integer` integer ones.
    fn split(&self, min_integer: u8, min_fraction: usize) -> (String, String) {
        let mut int = String::new();
        let mut frac = String::new();
        for (i, &d) in self.digits.iter().enumerate() {
            if (i as i32) < self.point {
                int.push(char::from(d));
            } else {
                frac.push(char::from(d));
            }
        }
        for _ in self.digits.len() as i32..self.point {
            int.push('0');
        }
        if self.point < 0 {
            frac.insert_str(0, &"0".repeat((-self.point) as usize));
        }
        while frac.len() < min_fraction {
            frac.push('0');
        }
        while int.len() < usize::from(min_integer.max(1)) {
            int.insert(0, '0');
        }
        (int, frac)
    }
}

fn push(parts: &mut Vec<Part>, kind: &'static str, value: impl Into<String>) {
    let value = value.into();
    if !value.is_empty() {
        parts.push(Part { kind, value });
    }
}

/// `text` as parts: its leading and trailing spaces literals, the rest
/// `kind`.
fn push_spaced(parts: &mut Vec<Part>, kind: &'static str, text: &str) {
    let core = text.trim_matches(|c: char| c.is_whitespace());
    let start = text.find(core).unwrap_or(0);
    push(parts, "literal", &text[..start]);
    push(parts, kind, core);
    push(parts, "literal", &text[start + core.len()..]);
}

/// Groups `int` into `parts`.
fn group(parts: &mut Vec<Part>, int: &str, numbers: &Numbers, grouping: Grouping) {
    let min = match grouping {
        Grouping::Off => {
            push(parts, "integer", int);
            return;
        }
        Grouping::Always => 1,
        Grouping::Min2 => 2,
        Grouping::Auto => numbers.min_grouping,
    };
    if int.len() < 3 + usize::from(min) {
        push(parts, "integer", int);
        return;
    }
    // Group sizes from the right: 3, then 3 (or 2 in India).
    let mut cuts = Vec::new();
    let mut end = int.len();
    let mut size = 3;
    while end > size {
        end -= size;
        cuts.push(end);
        if numbers.indian {
            size = 2;
        }
    }
    let mut start = 0;
    for &cut in cuts.iter().rev() {
        push(parts, "integer", &int[start..cut]);
        push(parts, "group", numbers.group.as_str());
        start = cut;
    }
    push(parts, "integer", &int[start..]);
}

/// A currency's symbol for a locale's region.
fn currency_symbol(code: &str, display: CurrencyDisplay, lang: &str, region: &str) -> String {
    let narrow = match code {
        "USD" | "CAD" | "AUD" | "NZD" | "HKD" | "SGD" | "TWD" | "MXN" | "ARS" | "CLP" | "COP" => {
            "$"
        }
        "EUR" => "€",
        "GBP" => "£",
        "JPY" | "CNY" => "¥",
        "KRW" => "₩",
        "INR" => "₹",
        "RUB" => "₽",
        "BRL" => "R$",
        "TRY" => "₺",
        "VND" => "₫",
        "ILS" => "₪",
        "PHP" => "₱",
        "THB" => "฿",
        "UAH" => "₴",
        "NGN" => "₦",
        "SEK" | "NOK" | "DKK" => "kr",
        "PLN" => "zł",
        "IDR" => "Rp",
        "MYR" => "RM",
        "ZAR" => "R",
        "CHF" => "CHF",
        _ => "",
    };
    match display {
        CurrencyDisplay::Code | CurrencyDisplay::Name => return code.to_owned(),
        CurrencyDisplay::NarrowSymbol if !narrow.is_empty() => return narrow.to_owned(),
        _ => {}
    }
    // The currency of the locale's own region gets its plain symbol.
    let home = matches!(
        (code, region),
        ("USD", "US" | "")
            | ("CAD", "CA")
            | ("AUD", "AU")
            | ("NZD", "NZ")
            | ("HKD", "HK")
            | ("SGD", "SG")
            | ("TWD", "TW")
            | ("MXN", "MX")
    ) || matches!(
        (code, lang),
        ("JPY", "ja")
            | ("CNY", "zh")
            | ("KRW", "ko")
            | ("RUB", "ru")
            | ("TRY", "tr")
            | ("SEK", "sv")
            | ("PLN", "pl")
            | ("IDR", "id")
            | ("VND", "vi")
            | ("THB", "th")
    );
    if home {
        return match (code, lang) {
            ("JPY", "ja") => "￥".to_owned(),
            ("TWD", _) if lang == "zh" => "$".to_owned(),
            _ => narrow.to_owned(),
        };
    }
    match code {
        "USD" if lang == "en" || lang == "es" || lang == "ja" || lang == "ko" => {
            if lang == "en" && region != "US" && !region.is_empty() {
                "US$".to_owned()
            } else {
                "$".to_owned()
            }
        }
        "USD" if lang == "de" || lang == "fr" || lang == "it" || lang == "nl" => "$".to_owned(),
        "USD" => "US$".to_owned(),
        "CAD" => "CA$".to_owned(),
        "AUD" => "A$".to_owned(),
        "NZD" => "NZ$".to_owned(),
        "HKD" => "HK$".to_owned(),
        "TWD" => "NT$".to_owned(),
        "MXN" => "MX$".to_owned(),
        "CNY" => "CN¥".to_owned(),
        "JPY" => "¥".to_owned(),
        "EUR" | "GBP" | "INR" | "KRW" | "BRL" | "ILS" | "VND" | "PHP" => narrow.to_owned(),
        _ => code.to_owned(),
    }
}

/// A unit's short, narrow and long forms (singular, plural).
fn unit_forms(unit: &str) -> Option<(&'static str, &'static str, &'static str, &'static str)> {
    Some(match unit {
        "percent" => ("%", "%", "percent", "percent"),
        "bit" => ("bit", "bit", "bit", "bits"),
        "byte" => ("byte", "B", "byte", "bytes"),
        "kilobyte" => ("kB", "kB", "kilobyte", "kilobytes"),
        "megabyte" => ("MB", "MB", "megabyte", "megabytes"),
        "gigabyte" => ("GB", "GB", "gigabyte", "gigabytes"),
        "terabyte" => ("TB", "TB", "terabyte", "terabytes"),
        "millisecond" => ("ms", "ms", "millisecond", "milliseconds"),
        "second" => ("sec", "s", "second", "seconds"),
        "minute" => ("min", "m", "minute", "minutes"),
        "hour" => ("hr", "h", "hour", "hours"),
        "day" => ("day", "d", "day", "days"),
        "week" => ("wk", "w", "week", "weeks"),
        "month" => ("mth", "m", "month", "months"),
        "year" => ("yr", "y", "year", "years"),
        "millimeter" => ("mm", "mm", "millimeter", "millimeters"),
        "centimeter" => ("cm", "cm", "centimeter", "centimeters"),
        "meter" => ("m", "m", "meter", "meters"),
        "kilometer" => ("km", "km", "kilometer", "kilometers"),
        "inch" => ("in", "″", "inch", "inches"),
        "foot" => ("ft", "′", "foot", "feet"),
        "mile" => ("mi", "mi", "mile", "miles"),
        "gram" => ("g", "g", "gram", "grams"),
        "kilogram" => ("kg", "kg", "kilogram", "kilograms"),
        "pound" => ("lb", "lb", "pound", "pounds"),
        "liter" => ("L", "L", "liter", "liters"),
        "milliliter" => ("mL", "mL", "milliliter", "milliliters"),
        "celsius" => ("°C", "°C", "degree Celsius", "degrees Celsius"),
        "fahrenheit" => ("°F", "°", "degree Fahrenheit", "degrees Fahrenheit"),
        "degree" => ("deg", "°", "degree", "degrees"),
        "kilometer-per-hour" => ("km/h", "km/h", "kilometer per hour", "kilometers per hour"),
        "mile-per-hour" => ("mph", "mph", "mile per hour", "miles per hour"),
        "meter-per-second" => ("m/s", "m/s", "meter per second", "meters per second"),
        _ => return None,
    })
}

/// Whether `unit` is one this formatter knows (else a `RangeError`).
pub(crate) fn known_unit(unit: &str) -> bool {
    unit_forms(unit).is_some()
}

/// The parts of `value`.
pub(crate) fn format(value: &Value, f: &Format, numbers: &Numbers, tag: &str) -> Vec<Part> {
    let lang = tag.split('-').next().unwrap_or("en");
    let region = tag
        .split('-')
        .skip(1)
        .find(|p| p.len() == 2 || p.len() == 3)
        .unwrap_or("");
    let mut parts = Vec::new();
    let (negative, number) = match value {
        Value::Nan => (false, None),
        Value::Infinite { negative } => (*negative, None),
        Value::Finite(d) => (d.negative, Some(d.clone())),
    };
    let mut body = Vec::new();
    let mut zero = false;
    let mut plural = true;
    match number {
        None if matches!(value, Value::Nan) => push(&mut body, "nan", "NaN"),
        None => push(&mut body, "infinity", "∞"),
        Some(mut d) => {
            if f.style == Style::Percent && !d.is_zero() {
                d.point += 2;
            }
            zero = number_body(&mut body, d, f, numbers, &mut plural);
        }
    }
    let sign = match (f.sign, negative, zero) {
        (SignDisplay::Never, ..) => None,
        (SignDisplay::Auto, true, _) => Some(true),
        (SignDisplay::Always, n, _) => Some(n),
        (SignDisplay::ExceptZero, n, false) => Some(n),
        (SignDisplay::Negative, true, false) => Some(true),
        _ => None,
    };
    let sign = |parts: &mut Vec<Part>| match sign {
        Some(true) => push(parts, "minusSign", numbers.minus.as_str()),
        Some(false) => push(parts, "plusSign", "+"),
        None => {}
    };
    match &f.style {
        Style::Decimal => {
            sign(&mut parts);
            parts.append(&mut body);
        }
        Style::Percent => {
            sign(&mut parts);
            parts.append(&mut body);
            push_spaced(&mut parts, "percentSign", &numbers.percent);
        }
        Style::Currency { code, display } => {
            let symbol = currency_symbol(code, *display, lang, region);
            let letters = symbol.chars().last().is_some_and(char::is_alphabetic);
            sign(&mut parts);
            if numbers.currency_before && *display != CurrencyDisplay::Name {
                push(&mut parts, "currency", symbol);
                let space = if numbers.currency_space.is_empty() && letters {
                    "\u{a0}"
                } else {
                    numbers.currency_space.as_str()
                };
                push(&mut parts, "literal", space);
                parts.append(&mut body);
            } else {
                parts.append(&mut body);
                let space = if numbers.currency_space.is_empty() {
                    "\u{a0}"
                } else {
                    numbers.currency_space.as_str()
                };
                push(&mut parts, "literal", space);
                push(&mut parts, "currency", symbol);
            }
        }
        Style::Unit { unit, display } => {
            let (short, narrow, one, many) = unit_forms(unit).unwrap_or(("", "", "", ""));
            sign(&mut parts);
            parts.append(&mut body);
            match display {
                UnitDisplay::Narrow => push(&mut parts, "unit", narrow),
                UnitDisplay::Short if unit == "percent" => push(&mut parts, "unit", short),
                UnitDisplay::Short => {
                    push(&mut parts, "literal", " ");
                    push(&mut parts, "unit", short);
                }
                UnitDisplay::Long => {
                    push(&mut parts, "literal", " ");
                    push(&mut parts, "unit", if plural { many } else { one });
                }
            }
        }
    }
    parts
}

/// The digits (and exponent or compact suffix) of a finite number into
/// `parts`; whether it rounded to zero. `plural`: it is not exactly 1.
fn number_body(
    parts: &mut Vec<Part>,
    d: Decimal,
    f: &Format,
    numbers: &Numbers,
    plural: &mut bool,
) -> bool {
    match f.notation {
        Notation::Standard => {
            let (d, min_fraction) = d.rounded(f.rounding);
            digits(parts, &d, min_fraction, f, numbers, f.grouping);
            *plural = !(d.digits == *b"1" && d.point == 1);
            d.is_zero()
        }
        Notation::Scientific | Notation::Engineering => {
            let step = if f.notation == Notation::Engineering {
                3
            } else {
                1
            };
            let exponent_of = |d: &Decimal| {
                if d.is_zero() {
                    0
                } else {
                    d.magnitude().div_euclid(step) * step
                }
            };
            let mut exponent = exponent_of(&d);
            let mut scaled = Decimal {
                point: d.point - exponent,
                ..d.clone()
            };
            let (mut rounded, mut min_fraction) = scaled.rounded(f.rounding);
            // Rounding up may reach the next power (9.9995 → 10).
            let after = exponent_of(&Decimal {
                point: rounded.point + exponent,
                ..rounded.clone()
            });
            if after != exponent {
                exponent = after;
                scaled.point = d.point - exponent;
                (rounded, min_fraction) = scaled.rounded(f.rounding);
            }
            digits(parts, &rounded, min_fraction, f, numbers, Grouping::Off);
            push(parts, "exponentSeparator", "E");
            if exponent < 0 {
                push(parts, "exponentMinusSign", numbers.minus.as_str());
            }
            push(parts, "exponentInteger", exponent.abs().to_string());
            rounded.is_zero()
        }
        Notation::Compact { long } => {
            let units = if long {
                &numbers.compact_long
            } else {
                &numbers.compact_short
            };
            let unit_of = |magnitude: i32| {
                units
                    .iter()
                    .rev()
                    .find(|(power, _)| i32::from(*power) <= magnitude)
                    .map(|(power, suffix)| (*power, suffix.as_str()))
            };
            let mut unit = if d.is_zero() {
                None
            } else {
                unit_of(d.magnitude())
            };
            let scale = |unit: Option<(u8, &str)>| {
                let mut scaled = d.clone();
                if !scaled.is_zero() {
                    scaled.point -= unit.map_or(0, |(p, _)| i32::from(p));
                }
                scaled.rounded(f.rounding)
            };
            let (mut rounded, mut min_fraction) = scale(unit);
            // `999,999` rounds to `1000K`: written `1M`.
            if !rounded.is_zero() {
                let magnitude = rounded.magnitude() + unit.map_or(0, |(p, _)| i32::from(p));
                let next = unit_of(magnitude);
                if next != unit {
                    unit = next;
                    (rounded, min_fraction) = scale(unit);
                }
            }
            let grouping = if f.grouping == Grouping::Auto {
                Grouping::Min2
            } else {
                f.grouping
            };
            digits(parts, &rounded, min_fraction, f, numbers, grouping);
            if let Some((_, suffix)) = unit {
                push_spaced(parts, "compact", suffix);
            }
            rounded.is_zero()
        }
    }
}

fn digits(
    parts: &mut Vec<Part>,
    d: &Decimal,
    min_fraction: usize,
    f: &Format,
    numbers: &Numbers,
    grouping: Grouping,
) {
    let (int, mut frac) = d.split(f.min_integer, min_fraction);
    if f.strip_if_integer && frac.bytes().all(|b| b == b'0') {
        frac.clear();
    }
    group(parts, &int, numbers, grouping);
    if !frac.is_empty() {
        push(parts, "decimal", numbers.decimal.as_str());
        push(parts, "fraction", frac);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web::format::locale::resolve;

    fn fmt(tag: &str, x: f64, f: &Format) -> String {
        let locale = resolve(&[tag.to_owned()], "en-US");
        format(&Value::from_f64(x), f, &locale.numbers, locale.tag.as_str())
            .into_iter()
            .map(|p| p.value)
            .collect()
    }

    fn with(f: impl FnOnce(&mut Format)) -> Format {
        let mut format = Format::DEFAULT;
        f(&mut format);
        format
    }

    #[test]
    fn decimals_group_and_round_like_browsers() {
        let d = Format::DEFAULT;
        assert_eq!(fmt("en-US", 1234567.891, &d), "1,234,567.891");
        assert_eq!(fmt("en-US", 1234.5678, &d), "1,234.568");
        assert_eq!(fmt("en-US", 1.0005, &d), "1.001");
        assert_eq!(fmt("en-US", -0.0001, &d), "-0");
        assert_eq!(fmt("en-US", 0.0, &d), "0");
        assert_eq!(fmt("en-US", 999.9999, &d), "1,000");
        assert_eq!(fmt("en-US", 1e21, &d), "1,000,000,000,000,000,000,000");
        assert_eq!(fmt("de-DE", 1234567.891, &d), "1.234.567,891");
        assert_eq!(fmt("fr-FR", 1234.5, &d), "1\u{202f}234,5");
        assert_eq!(fmt("es-ES", 1234.5, &d), "1234,5");
        assert_eq!(fmt("es-ES", 12345.5, &d), "12.345,5");
        assert_eq!(fmt("en-IN", 12345678.0, &d), "1,23,45,678");
        assert_eq!(fmt("de-CH", 1234.5, &d), "1’234.5");
        assert_eq!(fmt("en-US", f64::NAN, &d), "NaN");
        assert_eq!(fmt("en-US", f64::NEG_INFINITY, &d), "-∞");
        let two = with(|f| f.rounding = Rounding::Fraction { min: 2, max: 2 });
        assert_eq!(fmt("en-US", 1.005, &two), "1.01");
        assert_eq!(fmt("en-US", 3.0, &two), "3.00");
        assert_eq!(fmt("en-US", 0.125, &two), "0.13");
        let off = with(|f| f.grouping = Grouping::Off);
        assert_eq!(fmt("en-US", 1234567.0, &off), "1234567");
        let sig = with(|f| f.rounding = Rounding::Significant { min: 1, max: 3 });
        assert_eq!(fmt("en-US", 123456.0, &sig), "123,000");
        assert_eq!(fmt("en-US", 0.0012345, &sig), "0.00123");
        let min_sig = with(|f| f.rounding = Rounding::Significant { min: 4, max: 21 });
        assert_eq!(fmt("en-US", 1.5, &min_sig), "1.500");
        assert_eq!(fmt("en-US", 0.0, &min_sig), "0.000");
        let int = with(|f| f.min_integer = 3);
        assert_eq!(fmt("en-US", 7.5, &int), "007.5");
    }

    #[test]
    fn signs_display_as_asked() {
        let sign = |s| with(|f| f.sign = s);
        assert_eq!(fmt("en-US", 5.0, &sign(SignDisplay::Always)), "+5");
        assert_eq!(fmt("en-US", 0.0, &sign(SignDisplay::Always)), "+0");
        assert_eq!(fmt("en-US", 0.0, &sign(SignDisplay::ExceptZero)), "0");
        assert_eq!(fmt("en-US", -5.0, &sign(SignDisplay::ExceptZero)), "-5");
        assert_eq!(fmt("en-US", -5.0, &sign(SignDisplay::Never)), "5");
        assert_eq!(fmt("en-US", -0.0, &sign(SignDisplay::Negative)), "0");
        assert_eq!(fmt("sv-SE", -5.0, &Format::DEFAULT), "\u{2212}5");
    }

    #[test]
    fn percents_currencies_and_units() {
        let percent = with(|f| {
            f.style = Style::Percent;
            f.rounding = Rounding::Fraction { min: 0, max: 0 };
        });
        assert_eq!(fmt("en-US", 0.256, &percent), "26%");
        assert_eq!(fmt("de-DE", 0.256, &percent), "26\u{a0}%");
        assert_eq!(fmt("fr-FR", -0.5, &percent), "-50\u{202f}%");
        let money = |code: &str, display| {
            with(|f| {
                f.style = Style::Currency {
                    code: code.to_owned(),
                    display,
                };
                let digits = currency_digits(code);
                f.rounding = Rounding::Fraction {
                    min: digits,
                    max: digits,
                };
            })
        };
        let usd = money("USD", CurrencyDisplay::Symbol);
        assert_eq!(fmt("en-US", 1234.5, &usd), "$1,234.50");
        assert_eq!(fmt("en-US", -3.0, &usd), "-$3.00");
        assert_eq!(fmt("en-GB", 3.0, &usd), "US$3.00");
        assert_eq!(fmt("de-DE", 1234.5, &usd), "1.234,50\u{a0}$");
        let eur = money("EUR", CurrencyDisplay::Symbol);
        assert_eq!(fmt("de-DE", 1234.5, &eur), "1.234,50\u{a0}€");
        assert_eq!(fmt("en-US", 1234.5, &eur), "€1,234.50");
        assert_eq!(
            fmt("ja-JP", 1234.0, &money("JPY", CurrencyDisplay::Symbol)),
            "￥1,234"
        );
        assert_eq!(
            fmt("zh-CN", 12.0, &money("CNY", CurrencyDisplay::Symbol)),
            "¥12.00"
        );
        assert_eq!(
            fmt("en-US", 12.0, &money("CNY", CurrencyDisplay::Symbol)),
            "CN¥12.00"
        );
        assert_eq!(
            fmt("en-US", 12.0, &money("USD", CurrencyDisplay::Code)),
            "USD\u{a0}12.00"
        );
        assert_eq!(
            fmt("en-US", 12.0, &money("CHF", CurrencyDisplay::Symbol)),
            "CHF\u{a0}12.00"
        );
        let unit = |unit: &str, display| {
            with(|f| {
                f.style = Style::Unit {
                    unit: unit.to_owned(),
                    display,
                }
            })
        };
        assert_eq!(
            fmt("en-US", 12.0, &unit("kilometer", UnitDisplay::Short)),
            "12 km"
        );
        assert_eq!(
            fmt("en-US", 1.0, &unit("hour", UnitDisplay::Long)),
            "1 hour"
        );
        assert_eq!(
            fmt("en-US", 2.0, &unit("hour", UnitDisplay::Long)),
            "2 hours"
        );
        assert_eq!(
            fmt("en-US", 30.0, &unit("percent", UnitDisplay::Short)),
            "30%"
        );
    }

    #[test]
    fn compact_and_scientific_notations() {
        let compact = with(|f| {
            f.notation = Notation::Compact { long: false };
            f.rounding = Rounding::Both {
                min_fraction: 0,
                max_fraction: 0,
                min_significant: 1,
                max_significant: 2,
                more: true,
            };
        });
        assert_eq!(fmt("en-US", 999.0, &compact), "999");
        assert_eq!(fmt("en-US", 1234.0, &compact), "1.2K");
        assert_eq!(fmt("en-US", 12345.0, &compact), "12K");
        assert_eq!(fmt("en-US", 123456.0, &compact), "123K");
        assert_eq!(fmt("en-US", 999999.0, &compact), "1M");
        assert_eq!(fmt("en-US", 1.5e9, &compact), "1.5B");
        assert_eq!(fmt("en-US", -2.5e6, &compact), "-2.5M");
        assert_eq!(fmt("en-US", 0.5, &compact), "0.5");
        assert_eq!(fmt("en-US", 2e15, &compact), "2000T");
        assert_eq!(fmt("de-DE", 1234.0, &compact), "1234");
        assert_eq!(fmt("de-DE", 1.5e6, &compact), "1,5\u{a0}Mio.");
        assert_eq!(fmt("zh-CN", 12345.0, &compact), "1.2万");
        assert_eq!(fmt("ja-JP", 1.5e8, &compact), "1.5億");
        let long = with(|f| {
            *f = compact.clone();
            f.notation = Notation::Compact { long: true };
        });
        assert_eq!(fmt("en-US", 1234.0, &long), "1.2 thousand");
        let scientific = with(|f| f.notation = Notation::Scientific);
        assert_eq!(fmt("en-US", 123456.0, &scientific), "1.235E5");
        assert_eq!(fmt("en-US", 0.00012, &scientific), "1.2E-4");
        assert_eq!(fmt("en-US", 9.9999, &scientific), "1E1");
        let engineering = with(|f| f.notation = Notation::Engineering);
        assert_eq!(fmt("en-US", 123456.0, &engineering), "123.456E3");
    }

    #[test]
    fn decimal_strings_parse_exactly() {
        let parse = |s| Value::parse(s).unwrap();
        let d = Format::DEFAULT;
        let locale = resolve(&[], "en-US");
        let text = |v: Value| -> String {
            format(&v, &d, &locale.numbers, "en-US")
                .into_iter()
                .map(|p| p.value)
                .collect()
        };
        assert_eq!(
            text(parse("12345678901234567890")),
            "12,345,678,901,234,567,890"
        );
        assert_eq!(text(parse("-1.5e3")), "-1,500");
        assert_eq!(text(parse(".5")), "0.5");
        assert!(Value::parse("12a").is_none());
    }
}
