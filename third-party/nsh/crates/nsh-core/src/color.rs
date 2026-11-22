//! Colors of the Rust API, after GPUI's `color` module: [`Hsla`] is the
//! color Rust code holds, passes and computes with (theme colors, typed
//! styles, components' props), [`Rgba`] is for conversions, and the free
//! functions build them (`rgb(0x2563eb)`, `hsla(0.6, 0.8, 0.5, 1.0)`,
//! `black()`). Adjusting a color is a method on [`Hsla`]: GPUI's (`opacity`,
//! `alpha`, `fade_out`, `blend`, `grayscale`) and gpui-kit's `Colorize`
//! (`lighten`, `darken`, `mix`, `invert`, `to_hex`, ...), plus a few of
//! NSH's own (`saturate`, `desaturate`, `spin`, `contrast_ratio`,
//! `readable_text`).
//!
//! The packed [`Color`] (`0xRRGGBBAA`) is the form styles are stored,
//! diffed and sent to the platforms in; colors become packed where they
//! enter a style, a prop or an operation, and nowhere earlier.
//!
//! # Rounding
//!
//! - Packed to float: each 8-bit channel `c` is `c / 255`.
//! - Float to packed: each channel is clamped to `0..=1`, scaled by 255
//!   and rounded to the nearest integer, halves away from zero
//!   (`f32::round`); the same rule CSS colors (`rgb()`, `hsl()`,
//!   `oklch()`) are packed with. GPUI truncates instead; rounding is what
//!   makes every packed color survive a round trip through [`Hsla`]
//!   unchanged.
//! - HSL to RGB uses the formula of CSS Color 4 (the one `hsl()` in CSS
//!   uses), so `hsla(h, s, l, a)` and `hsl(h·360 s·100% l·100% / a)` pack to
//!   the same color.
//!
//! # Deviations from GPUI
//!
//! - `From<Rgba> for u32` and the packed [`Color`] round, as above.
//! - Parsing (`"…".parse::<Hsla>()`, `Rgba::try_from(&str)`) accepts every
//!   CSS color NSH reads (hex, `rgb()`, `hsl()`, `oklch()`, `oklab()`,
//!   names, `color-mix()`), not only hex, with [`ColorParseError`] instead of `anyhow`.
//! - gpui-kit's `Colorize` methods are inherent methods of [`Hsla`], so no
//!   trait import is needed; its `divide` (which sets the alpha) is left
//!   out for [`Hsla::alpha`], and `lighten` / `darken` clamp the lightness
//!   to `0..=1`.
//! - No serde, schemars or proptest implementations.

use std::{
    fmt::{self, Display, Formatter},
    hash::{Hash, Hasher},
    str::FromStr,
};

use crate::style::Color;

/// Converts an RGB hex color code number (`0xRRGGBB`) to an opaque
/// [`Rgba`].
pub const fn rgb(hex: u32) -> Rgba {
    Rgba::from_packed(hex << 8 | 0xff)
}

/// Converts an RGBA hex color code number (`0xRRGGBBAA`) to an [`Rgba`].
pub const fn rgba(hex: u32) -> Rgba {
    Rgba::from_packed(hex)
}

/// An RGBA color, each channel in `0.0..=1.0`.
#[derive(PartialEq, Clone, Copy, Default)]
#[repr(C)]
pub struct Rgba {
    /// The red component of the color, in the range 0.0 to 1.0.
    pub r: f32,
    /// The green component of the color, in the range 0.0 to 1.0.
    pub g: f32,
    /// The blue component of the color, in the range 0.0 to 1.0.
    pub b: f32,
    /// The alpha component of the color, in the range 0.0 to 1.0.
    pub a: f32,
}

impl fmt::Debug for Rgba {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        write!(f, "rgba({:#010x})", u32::from(*self))
    }
}

impl Rgba {
    const fn from_packed(c: u32) -> Self {
        Rgba {
            r: (c >> 24) as f32 / 255.0,
            g: ((c >> 16) & 0xff) as f32 / 255.0,
            b: ((c >> 8) & 0xff) as f32 / 255.0,
            a: (c & 0xff) as f32 / 255.0,
        }
    }

    /// Blends `other` over this color by `other`'s alpha, keeping this
    /// color's alpha (source over, in sRGB).
    pub fn blend(&self, other: Rgba) -> Self {
        if other.a >= 1.0 {
            other
        } else if other.a <= 0.0 {
            *self
        } else {
            Rgba {
                r: (self.r * (1.0 - other.a)) + (other.r * other.a),
                g: (self.g * (1.0 - other.a)) + (other.g * other.a),
                b: (self.b * (1.0 - other.a)) + (other.b * other.a),
                a: self.a,
            }
        }
    }

    /// The same red, green and blue with alpha `a` (clamped to `0..=1`).
    pub fn alpha(&self, a: f32) -> Self {
        Rgba {
            a: a.clamp(0., 1.),
            ..*self
        }
    }

    /// The same red, green and blue with the alpha multiplied by `factor`
    /// (clamped to `0..=1`).
    pub fn opacity(&self, factor: f32) -> Self {
        Rgba {
            a: self.a * factor.clamp(0., 1.),
            ..*self
        }
    }

    /// The packed form styles store (`From<Rgba> for Color`, usable in
    /// `const`s: the color of a `BoxShadow` constant).
    pub const fn to_packed(self) -> Color {
        Color::rgba(byte(self.r), byte(self.g), byte(self.b), byte(self.a))
    }

    /// The color in HSLA (`From<Rgba> for Hsla`, usable in `const`s:
    /// `const C: Hsla = rgb(0x2563eb).to_hsla();`).
    pub const fn to_hsla(self) -> Hsla {
        let Rgba { r, g, b, a } = self;
        let max = r.max(g.max(b));
        let min = r.min(g.min(b));
        let delta = max - min;
        let l = (max + min) / 2.0;
        let s = if l == 0.0 || l == 1.0 {
            0.0
        } else if l < 0.5 {
            delta / (2.0 * l)
        } else {
            delta / (2.0 - 2.0 * l)
        };
        let h = if delta == 0.0 {
            0.0
        } else if max == r {
            let x = (g - b) / delta;
            // `rem_euclid(6.0)`, which is not `const`.
            (if x < 0.0 { x + 6.0 } else { x }) / 6.0
        } else if max == g {
            ((b - r) / delta + 2.0) / 6.0
        } else {
            ((r - g) / delta + 4.0) / 6.0
        };
        Hsla { h, s, l, a }
    }
}

/// The CSS Color 4 conversion `hsl()` uses: hue in degrees, saturation and
/// lightness in `0..=1`, channels unclamped.
pub(crate) fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (f32, f32, f32) {
    let k = |n: f32| (n + h / 30.0) % 12.0;
    let q = s * l.min(1.0 - l);
    let f = |n: f32| l - q * (k(n) - 3.0).min(9.0 - k(n)).clamp(-1.0, 1.0);
    (f(0.0), f(8.0), f(4.0))
}

/// A float channel in `0..=1` as a byte: clamped, scaled, rounded.
#[inline]
pub(crate) const fn byte(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

impl From<Hsla> for Rgba {
    fn from(color: Hsla) -> Self {
        let (r, g, b) = hsl_to_rgb(color.h.rem_euclid(1.0) * 360.0, color.s, color.l);
        Rgba {
            r: r.clamp(0., 1.),
            g: g.clamp(0., 1.),
            b: b.clamp(0., 1.),
            a: color.a,
        }
    }
}

/// `0xRRGGBBAA`, rounded (GPUI truncates).
impl From<Rgba> for u32 {
    fn from(c: Rgba) -> Self {
        Color::from(c).0
    }
}

impl From<Rgba> for Color {
    fn from(c: Rgba) -> Self {
        c.to_packed()
    }
}

impl From<Color> for Rgba {
    fn from(c: Color) -> Self {
        Rgba::from_packed(c.0)
    }
}

impl From<Hsla> for Color {
    fn from(c: Hsla) -> Self {
        Rgba::from(c).into()
    }
}

impl From<Color> for Hsla {
    fn from(c: Color) -> Self {
        Rgba::from_packed(c.0).to_hsla()
    }
}

/// A string that is not a CSS color.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColorParseError(pub String);

impl Display for ColorParseError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        write!(f, "not a color: `{}`", self.0)
    }
}

impl std::error::Error for ColorParseError {}

impl TryFrom<&'_ str> for Rgba {
    type Error = ColorParseError;

    /// A CSS color: hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`),
    /// `rgb()`, `hsl()`, `oklch()`, `oklab()` or a name.
    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Color::parse(value)
            .map(Rgba::from)
            .ok_or_else(|| ColorParseError(value.into()))
    }
}

impl FromStr for Rgba {
    type Err = ColorParseError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Rgba::try_from(s)
    }
}

/// An HSLA color: hue, saturation, lightness and alpha, each in
/// `0.0..=1.0` (the hue in turns: 0.5 is 180°).
#[derive(Default, Copy, Clone, Debug)]
#[repr(C)]
pub struct Hsla {
    /// Hue, in a range from 0 to 1.
    pub h: f32,
    /// Saturation, in a range from 0 to 1.
    pub s: f32,
    /// Lightness, in a range from 0 to 1.
    pub l: f32,
    /// Alpha, in a range from 0 to 1.
    pub a: f32,
}

// Compared, ordered and hashed by the bits of the channels (`total_cmp`),
// as in GPUI: colors are parts of style keys.
impl PartialEq for Hsla {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other).is_eq()
    }
}

impl PartialOrd for Hsla {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Hsla {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.h
            .total_cmp(&other.h)
            .then(self.s.total_cmp(&other.s))
            .then(self.l.total_cmp(&other.l).then(self.a.total_cmp(&other.a)))
    }
}

impl Eq for Hsla {}

impl Hash for Hsla {
    fn hash<H: Hasher>(&self, state: &mut H) {
        state.write_u32(self.h.to_bits());
        state.write_u32(self.s.to_bits());
        state.write_u32(self.l.to_bits());
        state.write_u32(self.a.to_bits());
    }
}

impl Display for Hsla {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "hsla({:.2}, {:.2}%, {:.2}%, {:.2})",
            self.h * 360.,
            self.s * 100.,
            self.l * 100.,
            self.a
        )
    }
}

/// An [`Hsla`] from plain values, each clamped to `0..=1`.
pub const fn hsla(h: f32, s: f32, l: f32, a: f32) -> Hsla {
    Hsla {
        h: h.clamp(0., 1.),
        s: s.clamp(0., 1.),
        l: l.clamp(0., 1.),
        a: a.clamp(0., 1.),
    }
}

/// An opaque [`Hsla`] in CSS's units (gpui-kit's `hsl`): hue in degrees
/// (`0..360`), saturation and lightness in percent (`0..=100`).
pub const fn hsl(h: f32, s: f32, l: f32) -> Hsla {
    hsla(h / 360., s / 100.0, l / 100.0, 1.0)
}

/// Pure black.
pub const fn black() -> Hsla {
    Hsla {
        h: 0.,
        s: 0.,
        l: 0.,
        a: 1.,
    }
}

/// Transparent black.
pub const fn transparent_black() -> Hsla {
    Hsla {
        h: 0.,
        s: 0.,
        l: 0.,
        a: 0.,
    }
}

/// Transparent white.
pub const fn transparent_white() -> Hsla {
    Hsla {
        h: 0.,
        s: 0.,
        l: 1.,
        a: 0.,
    }
}

/// A gray of `lightness` with alpha `opacity`, both clamped to `0..=1`.
pub const fn opaque_grey(lightness: f32, opacity: f32) -> Hsla {
    Hsla {
        h: 0.,
        s: 0.,
        l: lightness.clamp(0., 1.),
        a: opacity.clamp(0., 1.),
    }
}

/// Pure white.
pub const fn white() -> Hsla {
    Hsla {
        h: 0.,
        s: 0.,
        l: 1.,
        a: 1.,
    }
}

/// Red (`#ff0000`).
pub const fn red() -> Hsla {
    Hsla {
        h: 0.,
        s: 1.,
        l: 0.5,
        a: 1.,
    }
}

/// Blue (`#0000ff`).
pub const fn blue() -> Hsla {
    Hsla {
        h: 0.666_666_7,
        s: 1.,
        l: 0.5,
        a: 1.,
    }
}

/// Green (`#008000`, CSS's `green`).
pub const fn green() -> Hsla {
    Hsla {
        h: 0.333_333_34,
        s: 1.,
        l: 0.25,
        a: 1.,
    }
}

/// Yellow (`#ffff00`).
pub const fn yellow() -> Hsla {
    Hsla {
        h: 0.166_666_67,
        s: 1.,
        l: 0.5,
        a: 1.,
    }
}

/// WCAG's relative luminance of one sRGB channel.
fn linear(c: f32) -> f32 {
    if c <= 0.039_28 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

impl Hsla {
    /// This color in RGBA.
    pub fn to_rgb(self) -> Rgba {
        self.into()
    }

    /// Red.
    pub const fn red() -> Self {
        red()
    }

    /// Green.
    pub const fn green() -> Self {
        green()
    }

    /// Blue.
    pub const fn blue() -> Self {
        blue()
    }

    /// Black.
    pub const fn black() -> Self {
        black()
    }

    /// White.
    pub const fn white() -> Self {
        white()
    }

    /// Transparent black.
    pub const fn transparent_black() -> Self {
        transparent_black()
    }

    /// Whether it is fully transparent.
    pub fn is_transparent(&self) -> bool {
        self.a == 0.0
    }

    /// Whether it is fully opaque.
    pub fn is_opaque(&self) -> bool {
        self.a == 1.0
    }

    /// `other` drawn over this color by `other`'s alpha (source over, in
    /// sRGB), keeping this color's alpha: `other` when it is opaque, this
    /// color when `other` is transparent.
    pub fn blend(self, other: Hsla) -> Hsla {
        if other.a >= 1.0 {
            other
        } else if other.a <= 0.0 {
            self
        } else {
            Rgba::from(self).blend(Rgba::from(other)).into()
        }
    }

    /// The same hue and lightness with no saturation.
    pub fn grayscale(&self) -> Self {
        Hsla { s: 0., ..*self }
    }

    /// Fades the color out by `factor`: 0 leaves it, 1 makes it
    /// transparent.
    pub fn fade_out(&mut self, factor: f32) {
        self.a *= 1.0 - factor.clamp(0., 1.);
    }

    /// The alpha multiplied by `factor` (clamped to `0..=1`): a hover or
    /// selected state of a color from elsewhere.
    pub fn opacity(&self, factor: f32) -> Self {
        Hsla {
            a: self.a * factor.clamp(0., 1.),
            ..*self
        }
    }

    /// The same hue, saturation and lightness with alpha `a`.
    pub fn alpha(&self, a: f32) -> Self {
        Hsla {
            a: a.clamp(0., 1.),
            ..*self
        }
    }

    /// The opposite color: hue, saturation and lightness each `1 - x`
    /// (gpui-kit's `invert`).
    pub fn invert(&self) -> Self {
        Hsla {
            h: 1.0 - self.h,
            s: 1.0 - self.s,
            l: 1.0 - self.l,
            a: self.a,
        }
    }

    /// The lightness inverted (`1 - l`): a light color's dark counterpart.
    pub fn invert_l(&self) -> Self {
        Hsla {
            l: 1.0 - self.l,
            ..*self
        }
    }

    /// The lightness raised by `factor` of itself (`l · (1 + factor)`,
    /// `factor` in `0..=1`, at most 1).
    pub fn lighten(&self, factor: f32) -> Self {
        Hsla {
            l: (self.l * (1.0 + factor.clamp(0.0, 1.0))).min(1.0),
            ..*self
        }
    }

    /// The lightness lowered by `factor` of itself (`l · (1 - factor)`,
    /// `factor` in `0..=1`).
    pub fn darken(&self, factor: f32) -> Self {
        Hsla {
            l: self.l * (1.0 - factor.clamp(0.0, 1.0)),
            ..*self
        }
    }

    /// The saturation raised by `factor` of itself (`s · (1 + factor)`, at
    /// most 1), as [`Self::lighten`] does the lightness.
    pub fn saturate(&self, factor: f32) -> Self {
        Hsla {
            s: (self.s * (1.0 + factor.clamp(0.0, 1.0))).min(1.0),
            ..*self
        }
    }

    /// The saturation lowered by `factor` of itself (`s · (1 - factor)`).
    pub fn desaturate(&self, factor: f32) -> Self {
        Hsla {
            s: self.s * (1.0 - factor.clamp(0.0, 1.0)),
            ..*self
        }
    }

    /// The hue rotated by `degrees` (either way, wrapping around).
    pub fn spin(&self, degrees: f32) -> Self {
        Hsla {
            h: (self.h + degrees / 360.0).rem_euclid(1.0),
            ..*self
        }
    }

    /// `base`'s hue and saturation with this color's lightness and alpha
    /// (gpui-kit's `apply`).
    pub fn apply(&self, base: Hsla) -> Self {
        Hsla {
            h: base.h,
            s: base.s,
            ..*self
        }
    }

    /// This color with hue `hue` (`0..=1`).
    pub fn hue(&self, hue: f32) -> Self {
        Hsla {
            h: hue.clamp(0., 1.),
            ..*self
        }
    }

    /// This color with saturation `saturation` (`0..=1`).
    pub fn saturation(&self, saturation: f32) -> Self {
        Hsla {
            s: saturation.clamp(0., 1.),
            ..*self
        }
    }

    /// This color with lightness `lightness` (`0..=1`).
    pub fn lightness(&self, lightness: f32) -> Self {
        Hsla {
            l: lightness.clamp(0., 1.),
            ..*self
        }
    }

    /// This color and `other` mixed in HSL, `factor` (`0..=1`) of this one
    /// (gpui-kit's `mix`): the hue goes the short way around.
    pub fn mix(&self, other: Hsla, factor: f32) -> Self {
        let factor = factor.clamp(0.0, 1.0);
        let inv = 1.0 - factor;
        let lerp_hue = |a: f32, b: f32, t: f32| {
            let diff = (b - a + 180.0).rem_euclid(360.) - 180.;
            (a + diff * t).rem_euclid(360.0)
        };
        Hsla {
            h: lerp_hue(self.h * 360., other.h * 360., inv) / 360.,
            s: self.s * factor + other.s * inv,
            l: self.l * factor + other.l * inv,
            a: self.a * factor + other.a * inv,
        }
    }

    /// This color and `other` mixed in Oklab with premultiplied alpha,
    /// `factor` (`0..=1`) of this one: CSS's `color-mix(in oklab, self
    /// factor%, other)`.
    pub fn mix_oklab(&self, other: Hsla, factor: f32) -> Self {
        let factor = factor.clamp(0.0, 1.0);
        let inv = 1.0 - factor;
        let alpha = self.a * factor + other.a * inv;
        if alpha == 0.0 {
            return transparent_black();
        }
        let (l1, a1, b1) = rgb_to_oklab(self.to_rgb());
        let (l2, a2, b2) = rgb_to_oklab(other.to_rgb());
        let (w1, w2) = (self.a * factor / alpha, other.a * inv / alpha);
        let (r, g, b) = oklab_to_rgb(l1 * w1 + l2 * w2, a1 * w1 + a2 * w2, b1 * w1 + b2 * w2);
        Rgba { r, g, b, a: alpha }.into()
    }

    /// WCAG's relative luminance (`0` black to `1` white), alpha ignored.
    pub fn luminance(&self) -> f32 {
        let c = self.to_rgb();
        0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b)
    }

    /// WCAG's contrast ratio of this color and `other`, `1` to `21`
    /// (4.5 is AA for body text).
    pub fn contrast_ratio(&self, other: Hsla) -> f32 {
        let (a, b) = (self.luminance(), other.luminance());
        (a.max(b) + 0.05) / (a.min(b) + 0.05)
    }

    /// White or black, whichever reads better on this color: a
    /// foreground for a background chosen at run time.
    pub fn readable_text(&self) -> Hsla {
        if self.contrast_ratio(white()) >= self.contrast_ratio(black()) {
            white()
        } else {
            black()
        }
    }

    /// `#RRGGBB`, or `#RRGGBBAA` when not opaque (gpui-kit's `to_hex`;
    /// rounded).
    pub fn to_hex(&self) -> String {
        let Color(c) = Color::from(*self);
        if c & 0xff == 0xff {
            format!("#{:06X}", c >> 8)
        } else {
            format!("#{c:08X}")
        }
    }

    /// A hex color, `#` optional: `rgb`, `rgba`, `rrggbb` or `rrggbbaa`
    /// (gpui-kit's `parse_hex`; it took only the long forms).
    pub fn parse_hex(hex: &str) -> Result<Self, ColorParseError> {
        let digits = hex.trim().trim_start_matches('#');
        if !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(ColorParseError(hex.into()));
        }
        Color::parse(&format!("#{digits}"))
            .map(Hsla::from)
            .ok_or_else(|| ColorParseError(hex.into()))
    }
}

impl From<Rgba> for Hsla {
    fn from(color: Rgba) -> Self {
        color.to_hsla()
    }
}

impl FromStr for Hsla {
    type Err = ColorParseError;

    /// A CSS color, as [`Rgba::try_from`] takes it.
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Rgba::try_from(s).map(Hsla::from)
    }
}

impl TryFrom<&'_ str> for Hsla {
    type Error = ColorParseError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        value.parse()
    }
}

/// sRGB's transfer function undone: an sRGB channel as linear light.
pub(crate) fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// Linear light as an sRGB channel in `0..=1` (clamped before the
/// transfer function).
pub(crate) fn linear_to_srgb(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    if x <= 0.003_130_8 {
        12.92 * x
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

/// sRGB to OKLab (Björn Ottosson's matrices).
pub(crate) fn rgb_to_oklab(c: Rgba) -> (f32, f32, f32) {
    let (r, g, b) = (
        srgb_to_linear(c.r),
        srgb_to_linear(c.g),
        srgb_to_linear(c.b),
    );
    let l = (0.412_221_46 * r + 0.536_332_55 * g + 0.051_445_995 * b).cbrt();
    let m = (0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b).cbrt();
    let s = (0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b).cbrt();
    (
        0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s,
        1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
        0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
    )
}

/// OKLab to sRGB channels in `0..=1` (clamped before the transfer
/// function, as CSS's `oklch()` and `oklab()` are).
pub(crate) fn oklab_to_rgb(l: f32, a: f32, b: f32) -> (f32, f32, f32) {
    let l_ = l + 0.396_337_78 * a + 0.215_803_76 * b;
    let m_ = l - 0.105_561_346 * a - 0.063_854_17 * b;
    let s_ = l - 0.089_484_18 * a - 1.291_485_5 * b;
    let (l3, m3, s3) = (l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
    let r = 4.076_741_7 * l3 - 3.307_711_6 * m3 + 0.230_969_94 * s3;
    let g = -1.268_438 * l3 + 2.609_757_4 * m3 - 0.341_319_38 * s3;
    let bl = -0.004_196_086_3 * l3 - 0.703_418_6 * m3 + 1.707_614_7 * s3;
    (linear_to_srgb(r), linear_to_srgb(g), linear_to_srgb(bl))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packed(c: impl Into<Color>) -> u32 {
        c.into().0
    }

    #[test]
    fn every_packed_color_survives_a_round_trip() {
        // Every 24-bit color through HSLA and back (alpha is a plain
        // division and multiplication; checked on its own below).
        for rgb in 0..=0xff_ffffu32 {
            let c = Color(rgb << 8 | 0xff);
            assert_eq!(packed(Hsla::from(c)), c.0, "{c:?}");
        }
        for a in 0..=0xffu32 {
            let c = Color(0x3366_9900 | a);
            assert_eq!(packed(Hsla::from(c)), c.0);
            assert_eq!(packed(Rgba::from(c)), c.0);
        }
    }

    #[test]
    fn constructors() {
        assert_eq!(packed(rgb(0x2563eb)), 0x2563_ebff);
        assert_eq!(packed(rgba(0x2563eb80)), 0x2563_eb80);
        assert_eq!(packed(black()), 0x0000_00ff);
        assert_eq!(packed(white()), 0xffff_ffff);
        assert_eq!(packed(transparent_black()), 0);
        assert_eq!(packed(transparent_white()), 0xffff_ff00);
        assert_eq!(packed(opaque_grey(0.5, 1.0)), 0x8080_80ff);
        assert_eq!(packed(red()), 0xff00_00ff);
        assert_eq!(packed(green()), 0x0080_00ff);
        assert_eq!(packed(blue()), 0x0000_ffff);
        assert_eq!(packed(yellow()), 0xffff_00ff);
        assert_eq!(packed(hsl(217.2, 91.2, 59.8)), 0x3b82_f6ff);
        assert_eq!(hsla(2.0, -1.0, 0.5, 1.0), hsla(1.0, 0.0, 0.5, 1.0));
        const C: Hsla = rgb(0xff0000).to_hsla();
        assert_eq!(C, red());
    }

    #[test]
    fn hsla_packs_as_css_hsl_does() {
        for (h, s, l, a) in [
            (0.0, 100.0, 50.0, 1.0),
            (200.0, 50.0, 50.0, 1.0),
            (30.0, 80.0, 60.0, 0.4),
            (222.2, 84.0, 4.9, 1.0),
            (300.0, 76.0, 72.0, 1.0),
            (45.0, 93.0, 47.0, 1.0),
            (160.0, 84.0, 39.0, 0.5),
        ] {
            let css = Color::parse(&format!("hsl({h} {s}% {l}% / {a})")).unwrap();
            assert_eq!(
                packed(hsla(h / 360.0, s / 100.0, l / 100.0, a)),
                css.0,
                "{h} {s} {l} {a}"
            );
        }
    }

    /// `opacity` on an `Hsla` packs as the packed alpha scaled by the
    /// factor did before (`Color::with_alpha`, `AdaptiveColor::opacity`):
    /// exactly for opaque colors, and within one alpha step otherwise
    /// (where `alpha · factor` is a half, float rounding may fall either
    /// way).
    #[test]
    fn opacity_packs_as_the_packed_alpha_did() {
        for a in 0..=0xffu32 {
            let c = Color(0x3366_9900 | a);
            for step in 0..=100 {
                let f = step as f32 / 100.0;
                let (now, before) = (Color::from(Hsla::from(c).opacity(f)), c.with_alpha(f));
                assert_eq!(now.0 >> 8, before.0 >> 8);
                if a == 0xff {
                    assert_eq!(now, before, "{f}");
                } else {
                    assert!((now.0 & 0xff).abs_diff(before.0 & 0xff) <= 1, "{c:?} {f}");
                }
            }
        }
    }

    #[test]
    fn equality_and_hash_follow_the_bits() {
        use std::collections::HashSet;
        let set: HashSet<Hsla> = [red(), red(), blue()].into_iter().collect();
        assert_eq!(set.len(), 2);
        assert!(black() < white());
        // Bitwise: 0 and -0 differ (they pack the same).
        assert_ne!(black(), Hsla { l: -0.0, ..black() });
    }

    #[test]
    fn opacity_alpha_fade() {
        let c = rgb(0x3399ff).to_hsla();
        assert_eq!(c.opacity(0.5).a, 0.5);
        assert_eq!(c.opacity(2.0).a, 1.0);
        assert_eq!(c.alpha(0.25).a, 0.25);
        assert_eq!(packed(c.alpha(0.5)), 0x3399_ff80);
        let mut f = c;
        f.fade_out(0.25);
        assert_eq!(f.a, 0.75);
        assert!(c.alpha(0.0).is_transparent());
        assert!(c.is_opaque());
        assert_eq!(rgb(0x3399ff).opacity(0.5).a, 0.5);
        assert_eq!(rgba(0x3399ffcc).alpha(1.0).a, 1.0);
    }

    #[test]
    fn blend_is_source_over() {
        let base = white();
        assert_eq!(base.blend(red()), red());
        assert_eq!(base.blend(red().alpha(0.0)), base);
        // Half black over white: middle gray, white's alpha.
        assert_eq!(packed(base.blend(black().alpha(0.5))), 0x8080_80ff);
        assert_eq!(
            packed(rgb(0x7c3aed).to_hsla().blend(opaque_grey(0.0, 0.12))),
            0x6d33_d1ff
        );
    }

    #[test]
    fn lightness_saturation_hue() {
        let c = hsl(210.0, 40.0, 50.0);
        assert_eq!(c.lighten(0.2).l, 0.6);
        assert_eq!(c.lighten(1.0).l, 1.0);
        assert_eq!(white().lighten(0.5).l, 1.0);
        assert_eq!(c.darken(0.2).l, 0.4);
        assert_eq!(c.darken(1.0).l, 0.0);
        assert!((c.saturate(0.5).s - 0.6).abs() < 1e-6);
        assert_eq!(hsl(0.0, 80.0, 50.0).saturate(1.0).s, 1.0);
        assert!((c.desaturate(0.5).s - 0.2).abs() < 1e-6);
        assert_eq!(c.grayscale().s, 0.0);
        assert_eq!(packed(red().grayscale()), 0x8080_80ff);
        assert_eq!(packed(red().spin(120.0)), 0x00ff_00ff);
        assert_eq!(packed(red().spin(-120.0)), 0x0000_ffff);
        assert_eq!(packed(red().spin(720.0)), 0xff00_00ff);
        assert_eq!(c.hue(0.5).h, 0.5);
        assert_eq!(c.saturation(2.0).s, 1.0);
        assert_eq!(c.lightness(0.1).l, 0.1);
        assert_eq!(
            c.apply(red()),
            Hsla {
                h: 0.0,
                s: 1.0,
                ..c
            }
        );
    }

    #[test]
    fn invert() {
        assert_eq!(packed(white().invert()), 0x0000_00ff);
        assert_eq!(packed(black().invert_l()), 0xffff_ffff);
        let c = hsl(90.0, 30.0, 20.0);
        assert_eq!(packed(c.invert().invert()), packed(c));
        assert!((c.invert_l().l - 0.8).abs() < 1e-6);
    }

    #[test]
    fn mix() {
        let (r, b) = (red(), blue());
        assert_eq!(r.mix(b, 1.0), r);
        assert_eq!(packed(r.mix(b, 0.0)), packed(b));
        // Halfway the short way around: magenta.
        assert_eq!(packed(r.mix(b, 0.5)), 0xff00_ffff);
        assert_eq!(packed(white().mix(black(), 0.5)), 0x8080_80ff);
        assert_eq!(
            packed(white().mix(black().alpha(0.0), 0.5)),
            packed(opaque_grey(0.5, 0.5))
        );
        assert_eq!(packed(r.mix_oklab(b, 1.0)), packed(r));
        assert_eq!(packed(r.mix_oklab(b, 0.0)), packed(b));
        assert_eq!(packed(white().mix_oklab(white(), 0.3)), 0xffff_ffff);
        // CSS: color-mix(in oklab, white, black) is rgb(99 99 99).
        assert_eq!(packed(white().mix_oklab(black(), 0.5)), 0x6363_63ff);
        assert_eq!(
            packed(red().alpha(0.0).mix_oklab(blue().alpha(0.0), 0.5)),
            0
        );
    }

    #[test]
    fn contrast() {
        assert_eq!(white().luminance(), 1.0);
        assert_eq!(black().luminance(), 0.0);
        assert!((white().contrast_ratio(black()) - 21.0).abs() < 1e-4);
        assert_eq!(red().contrast_ratio(red()), 1.0);
        assert_eq!(rgb(0x171717).to_hsla().readable_text(), white());
        assert_eq!(rgb(0xfafafa).to_hsla().readable_text(), black());
        assert_eq!(yellow().readable_text(), black());
    }

    #[test]
    fn hex_and_parsing() {
        assert_eq!(rgb(0xf8fafc).to_hsla().to_hex(), "#F8FAFC");
        assert_eq!(rgba(0xf8fafc80).to_hsla().to_hex(), "#F8FAFC80");
        for hex in ["#F8FAFC", "#3399FFCC", "#000000", "#FFFFFF00"] {
            assert_eq!(Hsla::parse_hex(hex).unwrap().to_hex(), hex);
        }
        assert_eq!(Hsla::parse_hex("f8fafc"), Ok(rgb(0xf8fafc).into()));
        assert_eq!(Hsla::parse_hex("#fff"), Ok(white()));
        assert!(Hsla::parse_hex("red").is_err());
        assert!(Hsla::parse_hex("#12345").is_err());
        assert_eq!("red".parse::<Hsla>(), Ok(red()));
        assert_eq!(
            packed("hsl(200 50% 50%)".parse::<Hsla>().unwrap()),
            0x4095_bfff
        );
        assert_eq!(Rgba::try_from("#2563eb"), Ok(rgb(0x2563eb)));
        assert!("nope".parse::<Rgba>().is_err());
        assert_eq!(format!("{:?}", rgb(0x2563eb)), "rgba(0x2563ebff)");
        assert_eq!(format!("{}", red()), "hsla(0.00, 100.00%, 50.00%, 1.00)");
    }
}
