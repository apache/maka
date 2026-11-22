//! Types for styling terminal cells.
//!
//! Terminal styling is controlled by [`Sgr`] commands, the `CSI ... m` escape sequences that set
//! foreground color, background color, intensity, underline, and related text attributes. This
//! module provides those low-level SGR attribute types and a small [`StyleExt`] convenience trait
//! for formatting styled text.
//!
//! # Examples
//!
//! ```
//! use termina::style::StyleExt as _;
//!
//! # termina::style::Stylized::force_ansi_color(true);
//! let warning = "warning".red().bold();
//! assert_eq!(warning.to_string(), "\x1b[0;31;1mwarning\x1b[m");
//! ```
//!
//! # Implementation Notes
//!
//! Styling support is shared almost fairly between crossterm and TermWiz: SGR property types like
//! [`Underline`], [`CursorStyle`], and [`Intensity`] are adapted from [termwiz styling], while
//! [`StyleExt`] follows the shape of [crossterm styling] helpers.
//!
//! [termwiz styling]: https://docs.rs/termwiz/latest/termwiz/
//! [crossterm styling]: https://docs.rs/crossterm/latest/crossterm/style/index.html

use std::{
    borrow::Cow,
    fmt::{self, Display},
    str::FromStr,
    sync::atomic::{AtomicBool, Ordering},
};

use crate::escape::{
    self,
    csi::{Csi, Sgr},
};

/// Styling of a cell's underline according to the [Kitty underline extension].
///
/// Single and double underlines are widely understood SGR attributes. Curly, dotted, dashed, and
/// colored underlines are extensions and depend on terminal support.
///
/// ```
/// use termina::{
///     escape::csi::{Csi, Sgr},
///     style::Underline,
/// };
///
/// assert_eq!(Csi::Sgr(Sgr::Underline(Underline::Curly)).to_string(), "\x1b[4:3m");
/// ```
///
/// [kitty underline extension]: https://sw.kovidgoyal.net/kitty/underlines/
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum Underline {
    /// No underline
    #[default]
    None = 0,

    /// Straight underline
    Single = 1,

    /// Two underlines stacked on top of one another
    Double = 2,

    /// Curly / "squiggly" / "wavy" underline
    Curly = 3,

    /// Dotted underline
    Dotted = 4,

    /// Dashed underline
    Dashed = 5,
}

/// Cursor shape values for [DECSCUSR].
///
/// DECSCUSR is the DEC-style cursor shape setting used by many modern terminals. The numeric
/// values select the terminal default, block, underline, or vertical-bar cursor, with blinking and
/// steady variants where the protocol defines both.
///
/// ```
/// use termina::{
///     escape::csi::{Csi, Cursor},
///     style::CursorStyle,
/// };
///
/// let cursor = Csi::Cursor(Cursor::CursorStyle(CursorStyle::SteadyBar));
/// assert_eq!(cursor.to_string(), "\x1b[6 q");
/// ```
///
/// [DECSCUSR]: https://vt100.net/docs/vt510-rm/DECSCUSR.html
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum CursorStyle {
    /// DECSCUSR value 0: use the terminal's configured cursor style.
    #[default]
    Default = 0,
    /// DECSCUSR value 1: a blinking block cursor.
    BlinkingBlock = 1,
    /// DECSCUSR value 2: a steady block cursor.
    SteadyBlock = 2,
    /// DECSCUSR value 3: a blinking underline cursor.
    BlinkingUnderline = 3,
    /// DECSCUSR value 4: a steady underline cursor.
    SteadyUnderline = 4,
    /// DECSCUSR value 5: a blinking vertical bar cursor.
    BlinkingBar = 5,
    /// DECSCUSR value 6: a steady vertical bar cursor.
    SteadyBar = 6,
}

impl Display for CursorStyle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", *self as u8)
    }
}

/// An 8-bit "256-color".
///
/// Colors 0-15 are the same as [`AnsiColor`] values (0-7 being normal colors and 8-15 being
/// "bright").
/// Colors 16-231 make up a 6x6x6 "color cube"; 232-255 define a dark-to-light grayscale.
///
/// These are also known as "web-safe colors" or "X11 colors" historically, although the actual
/// colors varied somewhat between historical usages; see the [ANSI 8-bit color] table.
///
/// Convert a `WebColor` into [`ColorSpec`] when building SGR colors:
///
/// ```
/// use termina::style::{ColorSpec, WebColor};
///
/// let orange: ColorSpec = WebColor(208).into();
/// assert_eq!(orange, ColorSpec::PaletteIndex(208));
/// ```
///
/// [ANSI 8-bit color]: https://en.wikipedia.org/wiki/ANSI_escape_code#8-bit
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WebColor(pub u8);

/// Red, green, and blue color with 8-bit channels.
///
/// Use [`Self::new`] for byte channels, [`Self::new_f32`] for normalized floating-point channels,
/// or [`str::parse`] for xterm-style color strings:
///
/// ```
/// use termina::style::{ColorSpec, RgbColor};
///
/// let from_bytes = RgbColor::new(40, 80, 120);
/// let from_floats = RgbColor::new_f32(0.5, 0.0, 1.0);
/// let from_hex: RgbColor = "#285078".parse().unwrap();
///
/// assert_eq!(from_bytes, from_hex);
/// assert_eq!(from_floats, RgbColor::new(127, 0, 255));
///
/// let color_spec: ColorSpec = from_bytes.into();
/// assert!(matches!(color_spec, ColorSpec::TrueColor(_)));
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RgbColor {
    /// Red channel.
    pub red: u8,
    /// Green channel.
    pub green: u8,
    /// Blue channel.
    pub blue: u8,
}

impl RgbColor {
    /// Creates a new RGB color from 8-bit channel values.
    pub const fn new(red: u8, green: u8, blue: u8) -> Self {
        Self { red, green, blue }
    }

    /// Creates a new RGB color from floating-point channel values.
    ///
    /// Values are multiplied by 255 and cast to `u8`. Rust float-to-integer casts round toward
    /// zero, so fractional values lose their fractional part after scaling. `NaN` and values below
    /// `0.0` become `0`; values above `1.0` and positive infinity become `255`.
    pub fn new_f32(red: f32, green: f32, blue: f32) -> Self {
        let red = (red * 255.) as u8;
        let green = (green * 255.) as u8;
        let blue = (blue * 255.) as u8;
        Self { red, green, blue }
    }

    fn channel_from_hex(s: &str) -> Result<u8, InvalidFormatError> {
        if s.is_empty() || s.len() > 4 {
            return Err(InvalidFormatError);
        }
        let color: u16 = u16::from_str_radix(s, 16).map_err(|_| InvalidFormatError)?;
        let divisor: usize = match s.len() {
            1 => 0xf,
            2 => 0xff,
            3 => 0xfff,
            4 => 0xffff,
            _ => return Err(InvalidFormatError),
        };
        Ok(((color as usize) * 0xff / divisor) as u8)
    }
}

/// Error returned when parsing a red, green, and blue color string fails.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidFormatError;

impl FromStr for RgbColor {
    type Err = InvalidFormatError;

    // See `man xparsecolor`. This parses colors according to some of the formats accepted by
    // xterm's `XParseColor` function.
    //
    // 1. rgb:<red>/<green>/<blue>
    //    <red>, <green>, <blue> := h | hh | hhh | hhhh
    //    h := single hexadecimal digits (case insignificant)
    // 2. #RGB, #RRGGBB, #RRRGGGBBB, #RRRRGGGGBBBB
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        if let Some(rgb) = s.strip_prefix("rgb:") {
            let mut parts = rgb.split('/').map(Self::channel_from_hex);
            let Some(r) = parts.next().transpose()? else {
                return Err(InvalidFormatError);
            };
            let Some(g) = parts.next().transpose()? else {
                return Err(InvalidFormatError);
            };
            let Some(b) = parts.next().transpose()? else {
                return Err(InvalidFormatError);
            };
            Ok(Self::new(r, g, b))
        } else if let Some(hex) = s.strip_prefix('#') {
            if !hex.is_ascii() {
                return Err(InvalidFormatError);
            }
            let (r, g, b) = match hex.len() {
                3 => (
                    Self::channel_from_hex(&hex[0..1])?,
                    Self::channel_from_hex(&hex[1..2])?,
                    Self::channel_from_hex(&hex[2..3])?,
                ),
                6 => (
                    Self::channel_from_hex(&hex[0..2])?,
                    Self::channel_from_hex(&hex[2..4])?,
                    Self::channel_from_hex(&hex[4..6])?,
                ),
                9 => (
                    Self::channel_from_hex(&hex[0..3])?,
                    Self::channel_from_hex(&hex[3..6])?,
                    Self::channel_from_hex(&hex[6..9])?,
                ),
                12 => (
                    Self::channel_from_hex(&hex[0..4])?,
                    Self::channel_from_hex(&hex[4..8])?,
                    Self::channel_from_hex(&hex[8..12])?,
                ),
                _ => return Err(InvalidFormatError),
            };
            Ok(Self::new(r, g, b))
        } else {
            Err(InvalidFormatError)
        }
    }
}

/// Red, green, blue, and alpha color with 8-bit channels.
///
/// Alpha defaults to fully opaque when converting from [`RgbColor`]. Converting back to
/// [`RgbColor`] drops the alpha channel because standard terminal foreground/background colors are
/// RGB values.
///
/// ```
/// use termina::style::{RgbColor, RgbaColor};
///
/// let rgb = RgbColor::new(10, 20, 30);
/// let rgba = RgbaColor::from(rgb);
/// assert_eq!(rgba.alpha, 255);
/// assert_eq!(RgbColor::from(rgba), rgb);
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RgbaColor {
    /// Red channel.
    pub red: u8,
    /// Green channel.
    pub green: u8,
    /// Blue channel.
    pub blue: u8,
    /// Also known as "opacity"
    pub alpha: u8,
}

impl From<RgbaColor> for RgbColor {
    fn from(color: RgbaColor) -> Self {
        Self {
            red: color.red,
            green: color.green,
            blue: color.blue,
        }
    }
}

impl From<RgbColor> for RgbaColor {
    fn from(color: RgbColor) -> Self {
        Self {
            red: color.red,
            green: color.green,
            blue: color.blue,
            alpha: 255,
        }
    }
}

/// Named ANSI colors used by standard 16-color palettes.
///
/// The numeric SGR assignments are stable, but names are not fully consistent across terminal
/// libraries. In particular, SGR 37 may be called white, gray, or silver, while SGR 97 may be
/// called bright white, light white, or white. Termina names the base 37 color [`Self::White`] and
/// the bright 97 color [`Self::BrightWhite`]. Ratatui documents the same naming ambiguity in its
/// [ANSI color table].
///
/// `AnsiColor` converts to [`ColorSpec`] through the indexed palette path:
///
/// ```
/// use termina::style::{AnsiColor, ColorSpec};
///
/// let red: ColorSpec = AnsiColor::Red.into();
/// assert_eq!(red, ColorSpec::RED);
/// ```
///
/// [ANSI color table]: https://en.wikipedia.org/wiki/ANSI_escape_code#Colors
/// [Ratatui color docs]: https://docs.rs/ratatui/latest/ratatui/style/enum.Color.html
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnsiColor {
    /// The standard black palette entry.
    Black = 0,
    /// The standard red palette entry.
    Red,
    /// The standard green palette entry.
    Green,
    /// The standard yellow palette entry.
    Yellow,
    /// The standard blue palette entry.
    Blue,
    /// The standard magenta palette entry.
    Magenta,
    /// The standard cyan palette entry.
    Cyan,
    /// The standard white palette entry.
    ///
    /// This is SGR 37. Some terminal libraries call this gray or silver and reserve white for the
    /// bright SGR 97 color.
    White,
    /// Bright black.
    ///
    /// This is SGR 90. Some terminal libraries call this dark gray, gray, light black, or bright
    /// black.
    BrightBlack,
    /// The bright red palette entry.
    BrightRed,
    /// The bright green palette entry.
    BrightGreen,
    /// The bright yellow palette entry.
    BrightYellow,
    /// The bright blue palette entry.
    BrightBlue,
    /// The bright magenta palette entry.
    BrightMagenta,
    /// The bright cyan palette entry.
    BrightCyan,
    /// The bright white palette entry.
    ///
    /// This is SGR 97. Some terminal libraries call this white, bright white, or light white.
    BrightWhite,
}

/// Index into the terminal's 256-color palette.
pub type PaletteIndex = u8;

/// Terminal color specification for [`Sgr`] color commands.
///
/// This is the common color input type for foreground, background, and underline colors. Named
/// ANSI colors and 256-color palette values use [`Self::PaletteIndex`]; true-color values use
/// [`Self::TrueColor`]; [`Self::Reset`] returns the terminal color to its default.
///
/// ```
/// use termina::{
///     escape::csi::{Csi, Sgr},
///     style::{ColorSpec, RgbColor},
/// };
///
/// assert_eq!(Csi::Sgr(Sgr::Foreground(ColorSpec::RED)).to_string(), "\x1b[31m");
///
/// let blue = ColorSpec::from(RgbColor::new(0, 0, 255));
/// assert_eq!(Csi::Sgr(Sgr::Foreground(blue)).to_string(), "\x1b[38;2;0;0;255m");
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorSpec {
    /// Reset the color back to the terminal default.
    ///
    /// For SGR foreground and background colors this formats as the standard reset color codes
    /// rather than as an indexed palette color.
    Reset,

    /// Use an indexed palette color.
    ///
    /// Values 0-15 address the standard ANSI palette. Values 16-255 address the 256-color
    /// extension palette described by [`WebColor`].
    PaletteIndex(PaletteIndex),

    /// Use a true-color red, green, blue, and alpha value.
    ///
    /// Red, green, and blue values format using SGR true-color parameters. Non-opaque alpha uses
    /// the colon form from ITU T.416-style color notation.
    TrueColor(RgbaColor),
}

impl ColorSpec {
    /// Standard black palette color.
    pub const BLACK: Self = Self::PaletteIndex(AnsiColor::Black as PaletteIndex);
    /// Standard red palette color.
    pub const RED: Self = Self::PaletteIndex(AnsiColor::Red as PaletteIndex);
    /// Standard green palette color.
    pub const GREEN: Self = Self::PaletteIndex(AnsiColor::Green as PaletteIndex);
    /// Standard yellow palette color.
    pub const YELLOW: Self = Self::PaletteIndex(AnsiColor::Yellow as PaletteIndex);
    /// Standard blue palette color.
    pub const BLUE: Self = Self::PaletteIndex(AnsiColor::Blue as PaletteIndex);
    /// Standard magenta palette color.
    pub const MAGENTA: Self = Self::PaletteIndex(AnsiColor::Magenta as PaletteIndex);
    /// Standard cyan palette color.
    pub const CYAN: Self = Self::PaletteIndex(AnsiColor::Cyan as PaletteIndex);
    /// Standard white palette color.
    pub const WHITE: Self = Self::PaletteIndex(AnsiColor::White as PaletteIndex);
    /// Bright black palette color.
    pub const BRIGHT_BLACK: Self = Self::PaletteIndex(AnsiColor::BrightBlack as PaletteIndex);
    /// Bright red palette color.
    pub const BRIGHT_RED: Self = Self::PaletteIndex(AnsiColor::BrightRed as PaletteIndex);
    /// Bright green palette color.
    pub const BRIGHT_GREEN: Self = Self::PaletteIndex(AnsiColor::BrightGreen as PaletteIndex);
    /// Bright yellow palette color.
    pub const BRIGHT_YELLOW: Self = Self::PaletteIndex(AnsiColor::BrightYellow as PaletteIndex);
    /// Bright blue palette color.
    pub const BRIGHT_BLUE: Self = Self::PaletteIndex(AnsiColor::BrightBlue as PaletteIndex);
    /// Bright magenta palette color.
    pub const BRIGHT_MAGENTA: Self = Self::PaletteIndex(AnsiColor::BrightMagenta as PaletteIndex);
    /// Bright cyan palette color.
    pub const BRIGHT_CYAN: Self = Self::PaletteIndex(AnsiColor::BrightCyan as PaletteIndex);
    /// Bright white palette color.
    pub const BRIGHT_WHITE: Self = Self::PaletteIndex(AnsiColor::BrightWhite as PaletteIndex);
}

impl From<AnsiColor> for ColorSpec {
    fn from(color: AnsiColor) -> Self {
        Self::PaletteIndex(color as u8)
    }
}

impl From<WebColor> for ColorSpec {
    fn from(color: WebColor) -> Self {
        Self::PaletteIndex(color.0)
    }
}

impl From<RgbColor> for ColorSpec {
    fn from(color: RgbColor) -> Self {
        Self::TrueColor(color.into())
    }
}

impl From<RgbaColor> for ColorSpec {
    fn from(color: RgbaColor) -> Self {
        Self::TrueColor(color)
    }
}

/// Text intensity for [`Sgr`].
///
/// Use this directly with [`Sgr::Intensity`] when building escape sequences, or through
/// [`StyleExt::bold`] for simple styled strings.
///
/// ```
/// use termina::{
///     escape::csi::{Csi, Sgr},
///     style::{Intensity, StyleExt as _},
/// };
///
/// assert_eq!(Csi::Sgr(Sgr::Intensity(Intensity::Bold)).to_string(), "\x1b[1m");
///
/// # termina::style::Stylized::force_ansi_color(true);
/// assert_eq!("warn".bold().to_string(), "\x1b[0;1mwarn\x1b[m");
/// ```
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum Intensity {
    /// SGR 22: normal text intensity.
    #[default]
    Normal,
    /// SGR 1: bold text intensity.
    Bold,
    /// SGR 2: dim text intensity.
    Dim,
}

/// Text blink mode for [`Sgr`].
///
/// Blink support is terminal-dependent. Some terminals ignore blink entirely or let users disable
/// it in their settings.
///
/// ```
/// use termina::{
///     escape::csi::{Csi, Sgr},
///     style::Blink,
/// };
///
/// assert_eq!(Csi::Sgr(Sgr::Blink(Blink::Slow)).to_string(), "\x1b[5m");
/// ```
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum Blink {
    /// SGR 25: disable blinking text.
    #[default]
    None,
    /// SGR 5: slow blinking text.
    Slow,
    /// SGR 6: rapid blinking text.
    Rapid,
}

/// Font selection for SGR parameters 10-19.
///
/// Alternate fonts are terminal-dependent and uncommon in modern terminal applications. The
/// variant value maps to SGR 11 through SGR 19; `Font::Alternate(1)` emits SGR 11.
///
/// ```
/// use termina::{
///     escape::csi::{Csi, Sgr},
///     style::Font,
/// };
///
/// assert_eq!(Csi::Sgr(Sgr::Font(Font::Alternate(1))).to_string(), "\x1b[11m");
/// ```
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum Font {
    /// SGR 10: use the default font.
    #[default]
    Default,

    /// SGR 11-19: select an alternate font.
    ///
    /// Valid values are 1-9, corresponding to SGR 11 through SGR 19.
    Alternate(u8),
}

/// Vertical alignment for [`Sgr`].
///
/// Superscript and subscript support is terminal-dependent.
///
/// ```
/// use termina::{
///     escape::csi::{Csi, Sgr},
///     style::VerticalAlign,
/// };
///
/// let superscript = Csi::Sgr(Sgr::VerticalAlign(VerticalAlign::SuperScript));
/// assert_eq!(superscript.to_string(), "\x1b[73m");
/// ```
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum VerticalAlign {
    /// SGR 75: baseline text alignment.
    #[default]
    BaseLine = 0,
    /// SGR 73: superscript text alignment.
    SuperScript = 1,
    /// SGR 74: subscript text alignment.
    SubScript = 2,
}

/// Styled text that renders by surrounding content with SGR escape sequences.
///
/// Use this for simple styled strings, for example a CLI help string. Code that already writes
/// structured terminal output can use [`crate::escape::csi::Sgr`] directly instead.
///
/// Instead of using this type directly, `use` the [`StyleExt`] trait and the helper functions
/// attached to strings:
///
/// ```
/// use termina::style::StyleExt as _;
///
/// # termina::style::Stylized::force_ansi_color(true);
/// assert_eq!(
///     "warning".red().bold().underlined().to_string(),
///     "\x1b[0;31;1;4mwarning\x1b[m",
/// );
/// ```
///
/// [`PlatformTerminal`]: crate::PlatformTerminal
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stylized<'a> {
    /// The text rendered between the opening SGR sequence and reset sequence.
    pub content: Cow<'a, str>,
    styles: Vec<Sgr>,
}

static INITIALIZER: parking_lot::Once = parking_lot::Once::new();
static NO_COLOR: AtomicBool = AtomicBool::new(false);

impl Stylized<'_> {
    /// Checks whether ANSI color sequences were turned off in the environment.
    ///
    /// This follows the guidance on [no-color.org][no-color]: if the `NO_COLOR` environment
    /// variable is present and non-empty, color escape sequences will be omitted when rendering
    /// this struct. This behavior can be overridden with [Self::force_ansi_color].
    ///
    /// [no-color]: https://no-color.org/
    pub fn is_ansi_color_disabled() -> bool {
        // Guidance on disabling colors comes from the no-color.org recommendations.
        INITIALIZER.call_once(|| {
            NO_COLOR.store(
                std::env::var("NO_COLOR").is_ok_and(|e| !e.is_empty()),
                Ordering::SeqCst,
            );
        });
        NO_COLOR.load(Ordering::SeqCst)
    }

    /// Overrides detection of the `NO_COLOR` environment variable.
    ///
    /// Pass `true` to ensure that ANSI color codes are always included when displaying this type
    /// or `false` to ensure ANSI color codes are never included.
    pub fn force_ansi_color(enable_color: bool) {
        // Run the `Once` first so this override is not later overwritten by the `Once` fn.
        let _ = Self::is_ansi_color_disabled();
        NO_COLOR.store(!enable_color, Ordering::SeqCst);
    }
}

impl Display for Stylized<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let no_color = Self::is_ansi_color_disabled();
        let mut styles = self
            .styles
            .iter()
            .filter(|sgr| {
                !(no_color
                    && matches!(
                        sgr,
                        Sgr::Foreground(_) | Sgr::Background(_) | Sgr::UnderlineColor(_)
                    ))
            })
            .peekable();

        if styles.peek().is_none() {
            write!(f, "{}", self.content)?;
        } else {
            write!(f, "{}0", escape::CSI)?;
            for sgr in styles {
                write!(f, ";{sgr}")?;
            }
            write!(f, "m{}{}", self.content, Csi::Sgr(Sgr::Reset))?;
        }
        Ok(())
    }
}

/// Convenience methods for building [`Stylized`] text.
///
/// Methods that accept `impl Into<ColorSpec>` work with named ANSI colors, 256-color palette
/// values, and true-color RGB values:
///
/// ```
/// use termina::style::{AnsiColor, RgbColor, StyleExt as _, Stylized, WebColor};
///
/// Stylized::force_ansi_color(true);
///
/// assert_eq!("red".foreground(AnsiColor::Red).to_string(), "\x1b[0;31mred\x1b[m");
/// assert_eq!("orange".foreground(WebColor(208)).to_string(), "\x1b[0;38;5;208morange\x1b[m");
/// assert_eq!(
///     "blue".foreground(RgbColor::new(0, 0, 255)).bold().to_string(),
///     "\x1b[0;38;2;0;0;255;1mblue\x1b[m",
/// );
/// ```
pub trait StyleExt<'a>: Sized {
    /// Wraps this value in [`Stylized`] without adding styles.
    fn stylized(self) -> Stylized<'a>;

    /// Adds a foreground color.
    fn foreground(self, color: impl Into<ColorSpec>) -> Stylized<'a> {
        let mut this = self.stylized();
        this.styles.push(Sgr::Foreground(color.into()));
        this
    }
    /// Adds the standard red foreground color.
    fn red(self) -> Stylized<'a> {
        self.foreground(ColorSpec::RED)
    }
    /// Adds the standard yellow foreground color.
    fn yellow(self) -> Stylized<'a> {
        self.foreground(ColorSpec::YELLOW)
    }
    /// Adds the standard green foreground color.
    fn green(self) -> Stylized<'a> {
        self.foreground(ColorSpec::GREEN)
    }
    /// Adds a single underline.
    fn underlined(self) -> Stylized<'a> {
        let mut this = self.stylized();
        this.styles.push(Sgr::Underline(Underline::Single));
        this
    }
    /// Adds bold intensity.
    fn bold(self) -> Stylized<'a> {
        let mut this = self.stylized();
        this.styles.push(Sgr::Intensity(Intensity::Bold));
        this
    }
}

impl<'a> StyleExt<'a> for Cow<'a, str> {
    fn stylized(self) -> Stylized<'a> {
        Stylized {
            content: self,
            styles: Vec::with_capacity(2),
        }
    }
}

impl<'a> StyleExt<'a> for &'a str {
    fn stylized(self) -> Stylized<'a> {
        Cow::Borrowed(self).stylized()
    }
}

impl StyleExt<'static> for String {
    fn stylized(self) -> Stylized<'static> {
        Cow::<str>::Owned(self).stylized()
    }
}

// NOTE: this allows chaining like `"hello".green().bold()`.
impl<'a> StyleExt<'a> for Stylized<'a> {
    fn stylized(self) -> Stylized<'a> {
        self
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn parse_color() {
        assert_eq!("#282828".parse(), Ok(RgbColor::new(40, 40, 40)));
        assert_eq!("rgb:28/28/28".parse(), Ok(RgbColor::new(40, 40, 40)));
        assert_eq!("rgb:2828/2828/2828".parse(), Ok(RgbColor::new(40, 40, 40)));
    }

    #[test]
    fn parse_color_non_ascii_hex_is_err_not_panic() {
        assert_eq!("#é2".parse::<RgbColor>(), Err(InvalidFormatError));
        assert_eq!("#ééé".parse::<RgbColor>(), Err(InvalidFormatError));
    }
}
