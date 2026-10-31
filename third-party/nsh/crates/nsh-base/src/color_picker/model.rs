//! A color picker's color: the color in sRGB with its channels in each
//! space the picker edits (RGB, HSL, HSB, OKLCH), kept as the user set
//! them. A channel a color does not define (a gray's hue, black's
//! saturation) keeps its last value, so dragging through a gray never makes
//! the hue jump, and a space's channels stay as typed while the color they
//! round to does not change.

use nsh_core::{Color, prelude::*};

/// A color space a [`ColorSlider`](super::ColorSlider) or a
/// [`ColorField`](super::ColorField) edits a channel of.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum ColorSpace {
    /// Red, green and blue, each from 0 to 255.
    Rgb,
    /// Hue (0 to 360), saturation and lightness (0 to 100).
    Hsl,
    /// Hue (0 to 360), saturation and brightness (0 to 100): the space of
    /// a [`ColorArea`](super::ColorArea), also called HSV.
    #[default]
    Hsb,
    /// Lightness (0 to 100), chroma (0 to 0.4) and hue (0 to 360) in
    /// Oklab's polar form, the space of CSS's `oklch()` and of shadcn/ui's
    /// and Tailwind v4's themes. Colors past sRGB keep their channels and
    /// show as the nearest sRGB color of the same lightness and hue.
    Oklch,
}

/// A channel of a [`ColorSpace`], or the alpha every space has.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum ColorChannel {
    /// RGB's red.
    Red,
    /// RGB's green.
    Green,
    /// RGB's blue.
    Blue,
    /// The hue of HSL, HSB or OKLCH.
    #[default]
    Hue,
    /// The saturation of HSL or HSB.
    Saturation,
    /// The lightness of HSL or OKLCH.
    Lightness,
    /// HSB's brightness.
    Brightness,
    /// OKLCH's chroma.
    Chroma,
    /// The opacity, from 0 (transparent) to 100, in any space.
    Alpha,
}

/// How a color is written as text: in a [`ColorField`](super::ColorField),
/// and in the `formatted` of a [`ColorPicker`](super::ColorPicker)'s
/// events.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum ColorFormat {
    /// `#rrggbb`, `#rrggbbaa` when translucent.
    #[default]
    Hex,
    /// `rgb(37 99 235)`, `rgb(37 99 235 / 0.5)` when translucent.
    Rgb,
    /// `hsl(221 83% 53%)`.
    Hsl,
    /// `hsb(221 84% 92%)` (not a CSS color).
    Hsb,
    /// `oklch(54.6% 0.215 262.9)`.
    Oklch,
}

/// The range of a channel as the user sees it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Spec {
    pub(crate) min: f64,
    pub(crate) max: f64,
    /// What keys and slider positions snap to.
    pub(crate) step: f64,
    /// The decimals it is written with.
    pub(crate) decimals: usize,
}

impl Spec {
    const fn new(max: f64, step: f64, decimals: usize) -> Self {
        Self {
            min: 0.0,
            max,
            step,
            decimals,
        }
    }

    /// `v` held to the range and snapped to the step.
    pub(crate) fn snap(self, v: f64) -> f64 {
        let v = v.clamp(self.min, self.max);
        let snapped = self.min + ((v - self.min) / self.step).round() * self.step;
        round_to(snapped.min(self.max), self.decimals)
    }

    /// Where `v` is along the range, from 0 to 1.
    pub(crate) fn fraction(self, v: f64) -> f64 {
        ((v - self.min) / (self.max - self.min)).clamp(0.0, 1.0)
    }

    /// The value `t` (0 to 1) of the way along the range.
    pub(crate) fn at(self, t: f64) -> f64 {
        self.min + t.clamp(0.0, 1.0) * (self.max - self.min)
    }

    /// `v` as text.
    pub(crate) fn format(self, v: f64) -> String {
        number(v, self.decimals)
    }
}

/// The space and channel as a picker edits them: a channel the space does
/// not have is the space's first.
pub(crate) fn resolve(space: ColorSpace, channel: ColorChannel) -> (ColorSpace, ColorChannel) {
    if channel == ColorChannel::Alpha || index(space, channel).is_some() {
        return (space, channel);
    }
    let first = match space {
        ColorSpace::Rgb => ColorChannel::Red,
        ColorSpace::Hsl | ColorSpace::Hsb => ColorChannel::Hue,
        ColorSpace::Oklch => ColorChannel::Lightness,
    };
    (space, first)
}

/// Where `channel` is in `space`'s three channels.
fn index(space: ColorSpace, channel: ColorChannel) -> Option<usize> {
    use ColorChannel::*;
    match (space, channel) {
        (ColorSpace::Rgb, Red) => Some(0),
        (ColorSpace::Rgb, Green) => Some(1),
        (ColorSpace::Rgb, Blue) => Some(2),
        (ColorSpace::Hsl | ColorSpace::Hsb, Hue) => Some(0),
        (ColorSpace::Hsl | ColorSpace::Hsb, Saturation) => Some(1),
        (ColorSpace::Hsl, Lightness) | (ColorSpace::Hsb, Brightness) => Some(2),
        (ColorSpace::Oklch, Lightness) => Some(0),
        (ColorSpace::Oklch, Chroma) => Some(1),
        (ColorSpace::Oklch, Hue) => Some(2),
        _ => None,
    }
}

/// The range of `channel` in `space` (a resolved pair).
pub(crate) fn spec(space: ColorSpace, channel: ColorChannel) -> Spec {
    use ColorChannel::*;
    match (space, channel) {
        (_, Alpha) => Spec::new(100.0, 1.0, 0),
        (ColorSpace::Rgb, _) => Spec::new(255.0, 1.0, 0),
        (ColorSpace::Oklch, Lightness) => Spec::new(100.0, 0.1, 1),
        (ColorSpace::Oklch, Chroma) => Spec::new(0.4, 0.001, 3),
        (ColorSpace::Oklch, _) => Spec::new(360.0, 0.1, 1),
        (_, Hue) => Spec::new(360.0, 1.0, 0),
        _ => Spec::new(100.0, 1.0, 0),
    }
}

/// How many straight gradients draw `channel`'s track: one where the
/// channel moves the color along a line in sRGB, more where it curves.
pub(crate) fn segments(space: ColorSpace, channel: ColorChannel) -> usize {
    use ColorChannel::*;
    match (space, channel) {
        (ColorSpace::Oklch, _) if channel != Alpha => 12,
        (ColorSpace::Hsl | ColorSpace::Hsb, Hue) => 6,
        (ColorSpace::Hsl, Lightness) => 2,
        _ => 1,
    }
}

/// A picker's color (see the module).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Model {
    /// sRGB, each from 0 to 1.
    rgb: [f64; 3],
    /// From 0 to 1.
    alpha: f64,
    /// Hue 0–360, saturation and lightness 0–100.
    hsl: [f64; 3],
    /// Hue 0–360, saturation and brightness 0–100.
    hsb: [f64; 3],
    /// Lightness 0–100, chroma 0–0.4, hue 0–360.
    oklch: [f64; 3],
}

impl Default for Model {
    /// Opaque black.
    fn default() -> Self {
        Self::from_hsla(black())
    }
}

impl Model {
    /// `color` with its channels in every space.
    pub(crate) fn from_hsla(color: Hsla) -> Self {
        Self::derive(rgb_of(color.to_rgb()), color.a as f64, None)
    }

    /// `color` with the channels it does not define kept from this one.
    pub(crate) fn follow(&self, color: Hsla) -> Self {
        Self::derive(rgb_of(color.to_rgb()), color.a as f64, Some(self))
    }

    fn derive(rgb: [f64; 3], alpha: f64, prev: Option<&Model>) -> Self {
        let mut hsb = rgb_to_hsb(rgb);
        let mut hsl = rgb_to_hsl(rgb);
        let mut oklch = rgb_to_oklch(rgb);
        if let Some(prev) = prev {
            // A gray has no hue, black no saturation: keep the last.
            if hsb[1] < EPSILON || hsb[2] < EPSILON {
                hsb[0] = prev.hsb[0];
            }
            if hsb[2] < EPSILON {
                hsb[1] = prev.hsb[1];
            }
            if hsl[1] < EPSILON || hsl[2] < EPSILON || hsl[2] > 100.0 - EPSILON {
                hsl[0] = prev.hsl[0];
            }
            if hsl[2] < EPSILON || hsl[2] > 100.0 - EPSILON {
                hsl[1] = prev.hsl[1];
            }
            if oklch[1] < ACHROMATIC {
                oklch[2] = prev.oklch[2];
            }
        }
        Self {
            rgb,
            alpha: alpha.clamp(0.0, 1.0),
            hsl,
            hsb,
            oklch,
        }
    }

    /// The value of `channel` in `space` (a resolved pair).
    pub(crate) fn channel(&self, space: ColorSpace, channel: ColorChannel) -> f64 {
        match index(space, channel) {
            Some(i) => self.triple(space)[i],
            None => self.alpha * 100.0,
        }
    }

    fn triple(&self, space: ColorSpace) -> [f64; 3] {
        match space {
            ColorSpace::Rgb => self.rgb.map(|c| c * 255.0),
            ColorSpace::Hsl => self.hsl,
            ColorSpace::Hsb => self.hsb,
            ColorSpace::Oklch => self.oklch,
        }
    }

    /// The color with `channel` of `space` set to `v` (held to its range).
    pub(crate) fn with_channel(&self, space: ColorSpace, channel: ColorChannel, v: f64) -> Self {
        let v = v.clamp(spec(space, channel).min, spec(space, channel).max);
        match index(space, channel) {
            Some(i) => {
                let mut triple = self.triple(space);
                triple[i] = v;
                self.with_triple(space, triple)
            }
            None => Self {
                alpha: v / 100.0,
                ..*self
            },
        }
    }

    /// The color with `space`'s channels set to `triple`, kept as given.
    pub(crate) fn with_triple(&self, space: ColorSpace, triple: [f64; 3]) -> Self {
        let rgb = match space {
            ColorSpace::Rgb => triple.map(|c| c / 255.0),
            ColorSpace::Hsl => hsl_to_rgb(triple),
            ColorSpace::Hsb => hsb_to_rgb(triple),
            ColorSpace::Oklch => oklch_to_rgb(triple),
        };
        let mut next = Self::derive(rgb.map(|c| c.clamp(0.0, 1.0)), self.alpha, Some(self));
        match space {
            ColorSpace::Rgb => {}
            ColorSpace::Hsl => next.hsl = triple,
            ColorSpace::Hsb => next.hsb = triple,
            ColorSpace::Oklch => next.oklch = triple,
        }
        next
    }

    /// The color.
    pub(crate) fn hsla(&self) -> Hsla {
        self.rgba().into()
    }

    fn rgba(&self) -> Rgba {
        let [r, g, b] = self.rgb.map(|c| c as f32);
        Rgba {
            r,
            g,
            b,
            a: self.alpha as f32,
        }
    }

    /// The color, packed: two models show the same color when it is equal.
    pub(crate) fn packed(&self) -> u32 {
        Color::from(self.rgba()).0
    }

    /// The color, opaque.
    pub(crate) fn opaque(&self) -> Hsla {
        Self {
            alpha: 1.0,
            ..*self
        }
        .hsla()
    }

    /// The color of `channel`'s track at `t` (0 to 1) along it: the color
    /// with the channel there, opaque (but on alpha's). The hue of HSL
    /// and HSB is shown at full saturation, a rainbow whatever the color.
    pub(crate) fn track(&self, space: ColorSpace, channel: ColorChannel, t: f64) -> Hsla {
        let v = spec(space, channel).at(t);
        let base = match (space, channel) {
            (ColorSpace::Hsb, ColorChannel::Hue) => self.with_triple(space, [v, 100.0, 100.0]),
            (ColorSpace::Hsl, ColorChannel::Hue) => self.with_triple(space, [v, 100.0, 50.0]),
            (_, ColorChannel::Alpha) => return self.with_channel(space, channel, v).hsla(),
            _ => self.with_channel(space, channel, v),
        };
        base.opaque()
    }

    /// The pure hue of the color in HSB, opaque: the base of a
    /// [`ColorArea`](super::ColorArea).
    pub(crate) fn hue_color(&self) -> Hsla {
        Self::default()
            .with_triple(ColorSpace::Hsb, [self.hsb[0], 100.0, 100.0])
            .opaque()
    }

    /// The color written as `format` says.
    pub(crate) fn format(&self, format: ColorFormat) -> String {
        let alpha = if self.packed() & 0xff == 0xff {
            String::new()
        } else {
            format!(" / {}", number(self.alpha, 2))
        };
        let [a, b, c] = self.hsl;
        let [d, e, f] = self.hsb;
        let [l, ch, h] = self.oklch;
        match format {
            ColorFormat::Hex => {
                let packed = self.packed();
                if packed & 0xff == 0xff {
                    format!("#{:06x}", packed >> 8)
                } else {
                    format!("#{packed:08x}")
                }
            }
            ColorFormat::Rgb => {
                let [r, g, b] = self.rgb.map(|c| (c * 255.0).round());
                format!("rgb({r} {g} {b}{alpha})")
            }
            ColorFormat::Hsl => format!(
                "hsl({} {}% {}%{alpha})",
                number(a, 1),
                number(b, 1),
                number(c, 1)
            ),
            ColorFormat::Hsb => format!(
                "hsb({} {}% {}%{alpha})",
                number(d, 1),
                number(e, 1),
                number(f, 1)
            ),
            ColorFormat::Oklch => format!(
                "oklch({}% {} {}{alpha})",
                number(l, 1),
                number(ch, 3),
                number(h, 1)
            ),
        }
    }
}

/// A color as the user types it: anything CSS writes (hex, `rgb()`,
/// `hsl()`, `oklch()`, a name), hex without its `#`, and `hsb()`.
pub(crate) fn parse(text: &str) -> Option<ParsedColor> {
    let text = text.trim();
    if let Some(color) = Color::parse(text) {
        return Some(ParsedColor::Css(color.into()));
    }
    if matches!(text.len(), 3 | 4 | 6 | 8) && text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Color::parse(&format!("#{text}")).map(|c| ParsedColor::Css(c.into()));
    }
    let args = text.strip_prefix("hsb(")?.strip_suffix(')')?;
    let (channels, alpha) = match args.split_once('/') {
        Some((channels, alpha)) => (channels, Some(alpha.trim())),
        None => (args, None),
    };
    let mut parts = channels
        .split([' ', ','])
        .filter(|p| !p.is_empty())
        .map(|p| p.trim_end_matches('%').parse::<f64>().ok());
    let triple = [parts.next()??, parts.next()??, parts.next()??];
    if parts.next().is_some() {
        return None;
    }
    let alpha = match alpha {
        Some(a) => match a.strip_suffix('%') {
            Some(percent) => percent.parse::<f64>().ok()? / 100.0,
            None => a.parse::<f64>().ok()?,
        },
        None => 1.0,
    };
    Some(ParsedColor::Hsb(
        [
            triple[0].rem_euclid(360.0),
            triple[1].clamp(0.0, 100.0),
            triple[2].clamp(0.0, 100.0),
        ],
        alpha.clamp(0.0, 1.0),
    ))
}

/// What [`parse`] read.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum ParsedColor {
    /// A CSS color.
    Css(Hsla),
    /// HSB's channels and the alpha.
    Hsb([f64; 3], f64),
}

impl ParsedColor {
    /// The color `model` becomes.
    pub(crate) fn apply(self, model: &Model) -> Model {
        match self {
            Self::Css(color) => model.follow(color),
            Self::Hsb(triple, alpha) => {
                Model { alpha, ..*model }.with_triple(ColorSpace::Hsb, triple)
            }
        }
    }
}

/// Below this a channel that defines another is taken as zero.
const EPSILON: f64 = 1e-6;

/// Below this OKLCH's chroma is a gray's: a color rounded to 8 bits keeps
/// a trace of chroma.
const ACHROMATIC: f64 = 2e-4;

/// `v` with at most `decimals` decimals, without trailing zeros.
pub(crate) fn number(v: f64, decimals: usize) -> String {
    let text = format!("{:.*}", decimals, round_to(v, decimals));
    let text = if text.contains('.') {
        text.trim_end_matches('0').trim_end_matches('.')
    } else {
        &text
    };
    if text == "-0" {
        "0".into()
    } else {
        text.into()
    }
}

fn round_to(v: f64, decimals: usize) -> f64 {
    let scale = 10f64.powi(decimals as i32);
    (v * scale).round() / scale
}

fn rgb_of(c: Rgba) -> [f64; 3] {
    [c.r as f64, c.g as f64, c.b as f64]
}

/// The hue (0–360) of `rgb` whose largest channel is `max` and range `d`.
fn hue(rgb: [f64; 3], max: f64, d: f64) -> f64 {
    let [r, g, b] = rgb;
    if d <= 0.0 {
        0.0
    } else if max == r {
        60.0 * ((g - b) / d).rem_euclid(6.0)
    } else if max == g {
        60.0 * ((b - r) / d + 2.0)
    } else {
        60.0 * ((r - g) / d + 4.0)
    }
}

fn rgb_to_hsb(rgb: [f64; 3]) -> [f64; 3] {
    let max = rgb.into_iter().fold(f64::MIN, f64::max);
    let min = rgb.into_iter().fold(f64::MAX, f64::min);
    let d = max - min;
    let s = if max <= 0.0 { 0.0 } else { d / max };
    [hue(rgb, max, d), s * 100.0, max * 100.0]
}

fn hsb_to_rgb([h, s, b]: [f64; 3]) -> [f64; 3] {
    let (s, v) = (s / 100.0, b / 100.0);
    let f = |n: f64| {
        let k = (n + h / 60.0).rem_euclid(6.0);
        v - v * s * k.min(4.0 - k).clamp(0.0, 1.0)
    };
    [f(5.0), f(3.0), f(1.0)]
}

fn rgb_to_hsl(rgb: [f64; 3]) -> [f64; 3] {
    let max = rgb.into_iter().fold(f64::MIN, f64::max);
    let min = rgb.into_iter().fold(f64::MAX, f64::min);
    let d = max - min;
    let l = (max + min) / 2.0;
    let s = if d <= 0.0 {
        0.0
    } else {
        d / (1.0 - (2.0 * l - 1.0).abs())
    };
    [hue(rgb, max, d), s * 100.0, l * 100.0]
}

fn hsl_to_rgb([h, s, l]: [f64; 3]) -> [f64; 3] {
    let (s, l) = (s / 100.0, l / 100.0);
    let a = s * l.min(1.0 - l);
    let f = |n: f64| {
        let k = (n + h / 30.0).rem_euclid(12.0);
        l - a * (k - 3.0).min(9.0 - k).clamp(-1.0, 1.0)
    };
    [f(0.0), f(8.0), f(4.0)]
}

fn to_linear(c: f64) -> f64 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn from_linear(c: f64) -> f64 {
    if c <= 0.003_130_8 {
        12.92 * c
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

fn rgb_to_oklch(rgb: [f64; 3]) -> [f64; 3] {
    let [r, g, b] = rgb.map(to_linear);
    let l = (0.412_221_470_8 * r + 0.536_332_536_3 * g + 0.051_445_992_9 * b).cbrt();
    let m = (0.211_903_498_2 * r + 0.680_699_545_1 * g + 0.107_396_956_6 * b).cbrt();
    let s = (0.088_302_461_9 * r + 0.281_718_837_6 * g + 0.629_978_700_5 * b).cbrt();
    let lightness = 0.210_454_255_3 * l + 0.793_617_785 * m - 0.004_072_046_8 * s;
    let a = 1.977_998_495_1 * l - 2.428_592_205 * m + 0.450_593_709_9 * s;
    let b = 0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766 * s;
    let chroma = a.hypot(b);
    let hue = if chroma < ACHROMATIC {
        0.0
    } else {
        b.atan2(a).to_degrees().rem_euclid(360.0)
    };
    [lightness * 100.0, chroma, hue]
}

/// OKLCH in linear sRGB, unclamped.
fn oklch_to_linear([l, c, h]: [f64; 3]) -> [f64; 3] {
    let (l, h) = (l / 100.0, h.to_radians());
    let (a, b) = (c * h.cos(), c * h.sin());
    let l_ = (l + 0.396_337_777_4 * a + 0.215_803_757_3 * b).powi(3);
    let m_ = (l - 0.105_561_345_8 * a - 0.063_854_172_8 * b).powi(3);
    let s_ = (l - 0.089_484_177_5 * a - 1.291_485_548 * b).powi(3);
    [
        4.076_741_662_1 * l_ - 3.307_711_591_3 * m_ + 0.230_969_929_2 * s_,
        -1.268_438_004_6 * l_ + 2.609_757_401_1 * m_ - 0.341_319_396_5 * s_,
        -0.004_196_086_3 * l_ - 0.703_418_614_7 * m_ + 1.707_614_701 * s_,
    ]
}

/// OKLCH in sRGB: a color past sRGB is the one of its lightness and hue
/// with the most chroma sRGB has (CSS Color 4's gamut mapping, without its
/// tolerance).
fn oklch_to_rgb([l, c, h]: [f64; 3]) -> [f64; 3] {
    let inside = |rgb: [f64; 3]| rgb.iter().all(|&v| (-1e-6..=1.0 + 1e-6).contains(&v));
    let mut linear = oklch_to_linear([l, c, h]);
    if !inside(linear) {
        let (mut low, mut high) = (0.0, c);
        for _ in 0..20 {
            let mid = (low + high) / 2.0;
            if inside(oklch_to_linear([l, mid, h])) {
                low = mid;
            } else {
                high = mid;
            }
        }
        linear = oklch_to_linear([l, low, h]);
    }
    linear.map(|v| from_linear(v.clamp(0.0, 1.0)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(text: &str) -> Model {
        let Some(ParsedColor::Css(color)) = parse(text) else {
            panic!("{text} does not parse");
        };
        Model::from_hsla(color)
    }

    fn close(a: [f64; 3], b: [f64; 3], tolerance: f64) {
        for (x, y) in a.iter().zip(b) {
            assert!((x - y).abs() <= tolerance, "{a:?} != {b:?}");
        }
    }

    #[test]
    fn every_space_reads_the_color() {
        let blue = hex("#2563eb");
        close(blue.triple(ColorSpace::Rgb), [37.0, 99.0, 235.0], 1e-3);
        close(blue.hsl, [221.2, 83.2, 53.3], 0.1);
        close(blue.hsb, [221.2, 84.3, 92.2], 0.1);
        close(blue.oklch, [54.6, 0.215, 262.9], 0.05);
    }

    #[test]
    fn spaces_round_trip() {
        let m = hex("#2563eb");
        for space in [
            ColorSpace::Rgb,
            ColorSpace::Hsl,
            ColorSpace::Hsb,
            ColorSpace::Oklch,
        ] {
            let again = m.with_triple(space, m.triple(space));
            assert_eq!(again.packed(), m.packed(), "{space:?}");
        }
    }

    #[test]
    fn a_gray_keeps_the_hue() {
        let blue = hex("#2563eb");
        let gray = blue.with_channel(ColorSpace::Hsb, ColorChannel::Saturation, 0.0);
        assert_eq!(gray.hsb[0], blue.hsb[0]);
        assert_eq!(gray.hsl[0], blue.hsl[0]);
        assert_eq!(gray.oklch[2], blue.oklch[2]);
        let black = blue.with_channel(ColorSpace::Hsb, ColorChannel::Brightness, 0.0);
        assert_eq!(black.hsb[1], blue.hsb[1]);
        let back = black.with_channel(ColorSpace::Hsb, ColorChannel::Brightness, blue.hsb[2]);
        assert_eq!(back.packed(), blue.packed());
    }

    #[test]
    fn edited_channels_stay_as_set() {
        let m = hex("#808080").with_channel(ColorSpace::Oklch, ColorChannel::Hue, 140.0);
        assert_eq!(m.channel(ColorSpace::Oklch, ColorChannel::Hue), 140.0);
        // Past sRGB: the channels stay, the color is mapped.
        let wide = m
            .with_channel(ColorSpace::Oklch, ColorChannel::Chroma, 0.4)
            .with_channel(ColorSpace::Oklch, ColorChannel::Lightness, 70.0);
        assert_eq!(wide.oklch, [70.0, 0.4, 140.0]);
        assert!(wide.rgb.iter().all(|c| (0.0..=1.0).contains(c)));
        let mapped = rgb_to_oklch(wide.rgb);
        assert!((mapped[0] - 70.0).abs() < 0.5, "{mapped:?}");
    }

    #[test]
    fn alpha_is_a_percent() {
        let m = hex("#ff000080");
        assert!((m.channel(ColorSpace::Rgb, ColorChannel::Alpha) - 50.2).abs() < 0.1);
        let clear = m.with_channel(ColorSpace::Hsl, ColorChannel::Alpha, 0.0);
        assert_eq!(clear.packed() & 0xff, 0);
        assert_eq!(clear.packed() >> 8, 0xff0000);
    }

    #[test]
    fn formats() {
        let blue = hex("#2563eb");
        assert_eq!(blue.format(ColorFormat::Hex), "#2563eb");
        assert_eq!(blue.format(ColorFormat::Rgb), "rgb(37 99 235)");
        assert_eq!(blue.format(ColorFormat::Hsl), "hsl(221.2 83.2% 53.3%)");
        assert_eq!(blue.format(ColorFormat::Oklch), "oklch(54.6% 0.215 262.9)");
        let half = blue.with_channel(ColorSpace::Rgb, ColorChannel::Alpha, 50.0);
        assert_eq!(half.format(ColorFormat::Hex), "#2563eb80");
        assert_eq!(half.format(ColorFormat::Rgb), "rgb(37 99 235 / 0.5)");
    }

    #[test]
    fn parses_what_users_type() {
        let blue = hex("#2563eb").packed();
        for text in [
            "#2563eb",
            "2563eb",
            " rgb(37 99 235) ",
            "hsb(221.2 84.3% 92.2%)",
        ] {
            let m = parse(text).unwrap().apply(&Model::default());
            assert_eq!(m.packed(), blue, "{text}");
        }
        assert_eq!(
            parse("red").map(|p| p.apply(&Model::default()).packed()),
            Some(0xff0000ff)
        );
        for text in ["", "#12", "nope", "hsb(1 2)", "hsb(1 2 3 4)"] {
            assert_eq!(parse(text), None, "{text}");
        }
    }

    #[test]
    fn specs_snap_and_format() {
        let chroma = spec(ColorSpace::Oklch, ColorChannel::Chroma);
        assert_eq!(chroma.snap(0.21449), 0.214);
        assert_eq!(chroma.snap(9.0), 0.4);
        assert_eq!(chroma.format(0.2), "0.2");
        let hue = spec(ColorSpace::Oklch, ColorChannel::Hue);
        assert_eq!(hue.format(259.81), "259.8");
        assert_eq!(number(-0.0001, 2), "0");
    }

    #[test]
    fn a_channel_the_space_lacks_is_its_first() {
        assert_eq!(
            resolve(ColorSpace::Rgb, ColorChannel::Chroma),
            (ColorSpace::Rgb, ColorChannel::Red)
        );
        assert_eq!(
            resolve(ColorSpace::Oklch, ColorChannel::Alpha),
            (ColorSpace::Oklch, ColorChannel::Alpha)
        );
    }
}
