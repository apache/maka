//! Strongly typed Control Sequence Introducer (CSI) escape sequences.
//!
//! Each enum in this module represents a family of CSI sequences and implements [`Display`] where
//! Termina knows how to emit the sequence. This keeps terminal control code explicit while still
//! allowing applications to write the formatted value directly to any [`std::io::Write`] target.
//!
//! # Implementation Notes
//!
//! This module is adapted from [termwiz's CSI support], but it was incrementally pulled across
//! rather than copied wholesale. Termina keeps a curated subset, removes conversion traits, and
//! adds focused extensions such as Contour theme reporting and the [`SgrAttributes`] /
//! [`SgrModifiers`] grouping types. TermWiz has a more complete set of CSI escape sequences.
//!
//! [termwiz's CSI support]: https://docs.rs/termwiz/latest/termwiz/escape/enum.Csi.html

use std::{
    fmt::{self, Display},
    num::NonZeroU16,
};

use crate::{
    event::Modifiers,
    style::{Blink, ColorSpec, CursorStyle, Font, Intensity, RgbaColor, Underline, VerticalAlign},
    OneBased,
};

/// A Control Sequence Introducer command.
///
/// Formatting writes the `ESC [` introducer followed by the command family payload. CSI commands
/// are the main terminal protocol surface for cursor movement, text styling, mode changes, device
/// reports, mouse reports, and window operations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Csi {
    /// Select Graphic Rendition commands described by [`Sgr`].
    ///
    /// These `CSI ... m` commands change how subsequent cells are rendered.
    Sgr(Sgr),

    /// Cursor commands described by [`Cursor`].
    ///
    /// This family covers cursor movement, cursor shape, margins, and position reports.
    Cursor(Cursor),

    /// Text and display editing commands described by [`Edit`].
    ///
    /// This family covers insert, delete, erase, repeat, and scroll operations.
    Edit(Edit),

    /// Terminal mode commands described by [`Mode`].
    ///
    /// This family covers setting, resetting, saving, restoring, querying, and reporting terminal
    /// modes.
    Mode(Mode),

    /// Mouse input reports described by [`MouseReport`].
    ///
    /// Modes such as [`DecPrivateModeCode::MouseTracking`],
    /// [`DecPrivateModeCode::ButtonEventMouse`], and [`DecPrivateModeCode::AnyEventMouse`]
    /// control when terminals send these reports.
    Mouse(MouseReport),

    /// Kitty keyboard protocol commands described by [`Keyboard`].
    ///
    /// This family covers flag query, report, push, pop, and set commands.
    Keyboard(Keyboard),

    /// Device and status commands described by [`Device`].
    ///
    /// This family covers device attributes, terminal status, terminal identity, and terminal
    /// parameters.
    Device(Device),

    /// A primary device-attributes response, preserving its numeric parameters.
    PrimaryDeviceAttributes(PrimaryDeviceAttributes),

    /// An XTSMGRAPHICS response, preserving its item, status, and reported values.
    GraphicsAttributes(GraphicsAttributeResponse),

    /// Window commands described by [`Window`].
    ///
    /// This family covers window manipulation and reports, mostly from xterm-compatible
    /// extensions.
    Window(Box<Window>),
}

impl Display for Csi {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // This here is the "control sequence introducer" (CSI):
        f.write_str(super::CSI)?;
        match self {
            Self::Sgr(sgr) => write!(f, "{sgr}m"),
            Self::Cursor(cursor) => cursor.fmt(f),
            Self::Edit(edit) => edit.fmt(f),
            Self::Mode(mode) => mode.fmt(f),
            Self::Mouse(report) => report.fmt(f),
            Self::Keyboard(keyboard) => keyboard.fmt(f),
            Self::Device(device) => device.fmt(f),
            Self::PrimaryDeviceAttributes(attributes) => attributes.fmt(f),
            Self::GraphicsAttributes(attributes) => attributes.fmt(f),
            Self::Window(window) => window.fmt(f),
        }
    }
}

/// The terminal type and supported attributes reported by primary DA.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrimaryDeviceAttributes {
    /// The terminal's architectural type, distinct from its attribute parameters.
    pub terminal_type: u16,
    /// Numeric feature attributes, such as `4` for Sixel graphics.
    pub attributes: Vec<u16>,
}

impl Display for PrimaryDeviceAttributes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "?{}", self.terminal_type)?;
        for attribute in &self.attributes {
            write!(f, ";{attribute}")?;
        }
        f.write_str("c")
    }
}

/// The values reported by xterm's XTSMGRAPHICS graphics-attribute query.
///
/// Replies do not identify whether the request read the current or maximum value. Unknown items
/// and statuses are preserved so callers can interpret the reply for their outstanding request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphicsAttributeResponse {
    /// The requested item: `1` for color registers, `2` for Sixel geometry, or `3` for ReGIS.
    pub item: u16,
    /// `0` is success, `1` an item error, `2` an action error, and `3` a failure.
    pub status: u16,
    /// Values in wire order: successful geometry reports contain width followed by height.
    ///
    /// Zero values are retained. A successful maximum-geometry report of `0;0` means that the
    /// terminal does not impose a maximum geometry. Failure reports may contain no values.
    pub values: Vec<u32>,
}

impl Display for GraphicsAttributeResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "?{};{}", self.item, self.status)?;
        for value in &self.values {
            write!(f, ";{value}")?;
        }
        f.write_str("S")
    }
}

/// A Select Graphic Rendition (`CSI ... m`) attribute update.
///
/// SGR changes rendering state for text written after the sequence: color, intensity, underline,
/// blink, and related cell attributes. Terminals keep that state until another SGR command changes
/// it or [`Self::Reset`] clears it. The VT510 reference documents the standard [SGR] parameter
/// meanings that Termina models here.
///
/// [SGR]: https://vt100.net/docs/vt510-rm/SGR.html
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sgr {
    /// SGR 0: reset all graphic rendition attributes to terminal defaults.
    Reset,

    /// Set text intensity described by [`Intensity`].
    Intensity(Intensity),

    /// Set underline style described by [`Underline`].
    ///
    /// This includes Kitty's styled underline extension when terminals support it.
    Underline(Underline),

    /// Set blink behavior described by [`Blink`].
    Blink(Blink),

    /// Enable SGR 3 italic text or disable it with SGR 23.
    Italic(bool),

    /// Enable SGR 7 reverse video or disable it with SGR 27.
    Reverse(bool),

    /// Enable SGR 8 invisible text or disable it with SGR 28.
    Invisible(bool),

    /// Enable SGR 9 strikethrough text or disable it with SGR 29.
    StrikeThrough(bool),

    /// Enable SGR 53 overline text or disable it with SGR 55.
    Overline(bool),

    /// Select the active font described by [`Font`].
    Font(Font),

    /// Set vertical alignment described by [`VerticalAlign`].
    VerticalAlign(VerticalAlign),

    /// Set the foreground color described by [`ColorSpec`].
    Foreground(ColorSpec),

    /// Set the background color described by [`ColorSpec`].
    Background(ColorSpec),

    /// Set the underline color described by [`ColorSpec`].
    ///
    /// This uses the SGR 58 underline-color extension.
    UnderlineColor(ColorSpec),

    /// Combine multiple SGR updates described by [`SgrAttributes`].
    Attributes(SgrAttributes),
}

impl Display for Sgr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fn write_true_color(
            code: u8,
            RgbaColor {
                red,
                green,
                blue,
                alpha,
            }: RgbaColor,
            f: &mut fmt::Formatter,
        ) -> fmt::Result {
            if alpha == 255 {
                // [ITU T.416](https://www.itu.int/rec/T-REC-T.416-199303-I/en) § 13.1.8
                // says that the correct way to format true colors, even for foreground/background
                // is  `{code}:2:{colorspace (optional)}:{red}:{green}:{blue}`. More commonly than
                // not though terminals support the semicolon format shown below. We use semicolon
                // as it seems to have better compatibility in the wild, especially with legacy or
                // limited terminals like Windows conhost.
                //
                // The Microsoft docs also recommend the semicolon format (however Windows
                // Terminal accepts either):
                // <https://learn.microsoft.com/en-us/windows/console/console-virtual-terminal-sequences#extended-colors>
                write!(f, "{code};2;{red};{green};{blue}")
            } else {
                write!(f, "{code}:6::{red}:{green}:{blue}:{alpha}")
            }
        }

        // CSI <n> m
        match self {
            // The proper thing to do here is `write!(f, "0")?`. By default though when no Ps
            // is specified the terminal defaults to 0, so we can save a byte here.
            Self::Reset => (),
            Self::Intensity(Intensity::Normal) => write!(f, "22")?,
            Self::Intensity(Intensity::Bold) => write!(f, "1")?,
            Self::Intensity(Intensity::Dim) => write!(f, "2")?,
            Self::Underline(Underline::None) => write!(f, "24")?,
            Self::Underline(Underline::Single) => write!(f, "4")?,
            Self::Underline(Underline::Double) => write!(f, "21")?,
            Self::Underline(Underline::Curly) => write!(f, "4:3")?,
            Self::Underline(Underline::Dotted) => write!(f, "4:4")?,
            Self::Underline(Underline::Dashed) => write!(f, "4:5")?,
            Self::Blink(Blink::None) => write!(f, "25")?,
            Self::Blink(Blink::Slow) => write!(f, "5")?,
            Self::Blink(Blink::Rapid) => write!(f, "6")?,
            Self::Italic(true) => write!(f, "3")?,
            Self::Italic(false) => write!(f, "23")?,
            Self::Reverse(true) => write!(f, "7")?,
            Self::Reverse(false) => write!(f, "27")?,
            Self::Invisible(true) => write!(f, "8")?,
            Self::Invisible(false) => write!(f, "28")?,
            Self::StrikeThrough(true) => write!(f, "9")?,
            Self::StrikeThrough(false) => write!(f, "29")?,
            Self::Overline(true) => write!(f, "53")?,
            Self::Overline(false) => write!(f, "55")?,
            Self::Font(Font::Default) => write!(f, "10")?,
            Self::Font(Font::Alternate(1)) => write!(f, "11")?,
            Self::Font(Font::Alternate(2)) => write!(f, "12")?,
            Self::Font(Font::Alternate(3)) => write!(f, "13")?,
            Self::Font(Font::Alternate(4)) => write!(f, "14")?,
            Self::Font(Font::Alternate(5)) => write!(f, "15")?,
            Self::Font(Font::Alternate(6)) => write!(f, "16")?,
            Self::Font(Font::Alternate(7)) => write!(f, "17")?,
            Self::Font(Font::Alternate(8)) => write!(f, "18")?,
            Self::Font(Font::Alternate(9)) => write!(f, "19")?,
            Self::Font(_) => (),
            Self::VerticalAlign(VerticalAlign::BaseLine) => write!(f, "75")?,
            Self::VerticalAlign(VerticalAlign::SuperScript) => write!(f, "73")?,
            Self::VerticalAlign(VerticalAlign::SubScript) => write!(f, "74")?,
            Self::Foreground(ColorSpec::Reset) => write!(f, "39")?,
            Self::Foreground(ColorSpec::BLACK) => write!(f, "30")?,
            Self::Foreground(ColorSpec::RED) => write!(f, "31")?,
            Self::Foreground(ColorSpec::GREEN) => write!(f, "32")?,
            Self::Foreground(ColorSpec::YELLOW) => write!(f, "33")?,
            Self::Foreground(ColorSpec::BLUE) => write!(f, "34")?,
            Self::Foreground(ColorSpec::MAGENTA) => write!(f, "35")?,
            Self::Foreground(ColorSpec::CYAN) => write!(f, "36")?,
            Self::Foreground(ColorSpec::WHITE) => write!(f, "37")?,
            Self::Foreground(ColorSpec::BRIGHT_BLACK) => write!(f, "90")?,
            Self::Foreground(ColorSpec::BRIGHT_RED) => write!(f, "91")?,
            Self::Foreground(ColorSpec::BRIGHT_GREEN) => write!(f, "92")?,
            Self::Foreground(ColorSpec::BRIGHT_YELLOW) => write!(f, "93")?,
            Self::Foreground(ColorSpec::BRIGHT_BLUE) => write!(f, "94")?,
            Self::Foreground(ColorSpec::BRIGHT_MAGENTA) => write!(f, "95")?,
            Self::Foreground(ColorSpec::BRIGHT_CYAN) => write!(f, "96")?,
            Self::Foreground(ColorSpec::BRIGHT_WHITE) => write!(f, "97")?,
            Self::Foreground(ColorSpec::PaletteIndex(idx)) => write!(f, "38;5;{idx}")?,
            Self::Foreground(ColorSpec::TrueColor(color)) => write_true_color(38, *color, f)?,
            Self::Background(ColorSpec::Reset) => write!(f, "49")?,
            Self::Background(ColorSpec::BLACK) => write!(f, "40")?,
            Self::Background(ColorSpec::RED) => write!(f, "41")?,
            Self::Background(ColorSpec::GREEN) => write!(f, "42")?,
            Self::Background(ColorSpec::YELLOW) => write!(f, "43")?,
            Self::Background(ColorSpec::BLUE) => write!(f, "44")?,
            Self::Background(ColorSpec::MAGENTA) => write!(f, "45")?,
            Self::Background(ColorSpec::CYAN) => write!(f, "46")?,
            Self::Background(ColorSpec::WHITE) => write!(f, "47")?,
            Self::Background(ColorSpec::BRIGHT_BLACK) => write!(f, "100")?,
            Self::Background(ColorSpec::BRIGHT_RED) => write!(f, "101")?,
            Self::Background(ColorSpec::BRIGHT_GREEN) => write!(f, "102")?,
            Self::Background(ColorSpec::BRIGHT_YELLOW) => write!(f, "103")?,
            Self::Background(ColorSpec::BRIGHT_BLUE) => write!(f, "104")?,
            Self::Background(ColorSpec::BRIGHT_MAGENTA) => write!(f, "105")?,
            Self::Background(ColorSpec::BRIGHT_CYAN) => write!(f, "106")?,
            Self::Background(ColorSpec::BRIGHT_WHITE) => write!(f, "107")?,
            Self::Background(ColorSpec::PaletteIndex(idx)) => write!(f, "48;5;{idx}")?,
            Self::Background(ColorSpec::TrueColor(color)) => write_true_color(48, *color, f)?,
            Self::UnderlineColor(ColorSpec::Reset) => write!(f, "59")?,
            Self::UnderlineColor(ColorSpec::PaletteIndex(idx)) => write!(f, "58:5:{idx}")?,
            Self::UnderlineColor(ColorSpec::TrueColor(RgbaColor {
                red,
                green,
                blue,
                alpha: 255,
            })) => {
                // As mentioned above in `write_true_color`, this is the _correct_ format for a
                // true color. Styled and colored underlines are a relatively new extension and
                // terminals tend to support colon syntax since it is correct.
                write!(f, "58:2::{red}:{green}:{blue}")?;
            }
            Self::UnderlineColor(ColorSpec::TrueColor(RgbaColor {
                red,
                green,
                blue,
                alpha,
            })) => {
                write!(f, "58:6::{red}:{green}:{blue}:{alpha}")?;
            }
            Self::Attributes(attributes) => {
                use SgrModifiers as Mod;

                let ps_budget = attributes.parameter_chunk_size.get();
                let mut ps_written = 0;
                let mut first = true;
                let mut write = |sgr: Self, n_ps: u16| {
                    if first {
                        // Nothing to split before the first parameter: write it as-is, even if it
                        // alone exceeds the budget. (Splitting here would emit a leading `CSI m`,
                        // i.e. an unintended SGR reset.)
                        ps_written = n_ps;
                    } else if ps_written + n_ps > ps_budget {
                        // Writing this parameter would exceed the budget, finish this CSI sequence
                        // and start a new one beginning with this SGR.
                        write!(f, "m{}", super::CSI)?;
                        ps_written = n_ps;
                    } else {
                        f.write_str(";")?;
                        ps_written += n_ps;
                    }
                    first = false;
                    write!(f, "{sgr}")
                };
                if attributes.modifiers.contains(Mod::RESET) {
                    write(Self::Reset, 0)?;
                }
                if let Some(color) = attributes.foreground {
                    write(
                        Self::Foreground(color),
                        // TODO: for colors currently we estimate the largest Ps count. This could
                        // be fine-tuned a bit more.
                        match color {
                            ColorSpec::Reset => 1,
                            ColorSpec::PaletteIndex(_) => 3,
                            ColorSpec::TrueColor(RgbaColor { alpha: 255, .. }) => 5,
                            ColorSpec::TrueColor(_) => 6,
                        },
                    )?;
                }
                if let Some(color) = attributes.background {
                    write(
                        Self::Background(color),
                        match color {
                            ColorSpec::Reset => 1,
                            ColorSpec::PaletteIndex(_) => 3,
                            ColorSpec::TrueColor(RgbaColor { alpha: 255, .. }) => 5,
                            ColorSpec::TrueColor(_) => 6,
                        },
                    )?;
                }
                if let Some(color) = attributes.underline_color {
                    write(
                        Self::UnderlineColor(color),
                        match color {
                            ColorSpec::Reset => 1,
                            ColorSpec::PaletteIndex(_) => 3,
                            ColorSpec::TrueColor(_) => 6,
                        },
                    )?;
                }
                if attributes.modifiers.contains(Mod::INTENSITY_NORMAL) {
                    write(Self::Intensity(Intensity::Normal), 1)?;
                }
                if attributes.modifiers.contains(Mod::INTENSITY_DIM) {
                    write(Self::Intensity(Intensity::Dim), 1)?;
                }
                if attributes.modifiers.contains(Mod::INTENSITY_BOLD) {
                    write(Self::Intensity(Intensity::Bold), 1)?;
                }
                if attributes.modifiers.contains(Mod::UNDERLINE_NONE) {
                    write(Self::Underline(Underline::None), 1)?;
                }
                if attributes.modifiers.contains(Mod::UNDERLINE_SINGLE) {
                    write(Self::Underline(Underline::Single), 1)?;
                }
                if attributes.modifiers.contains(Mod::UNDERLINE_DOUBLE) {
                    write(Self::Underline(Underline::Double), 1)?;
                }
                if attributes.modifiers.contains(Mod::UNDERLINE_CURLY) {
                    write(Self::Underline(Underline::Curly), 2)?;
                }
                if attributes.modifiers.contains(Mod::UNDERLINE_DOTTED) {
                    write(Self::Underline(Underline::Dotted), 2)?;
                }
                if attributes.modifiers.contains(Mod::UNDERLINE_DASHED) {
                    write(Self::Underline(Underline::Dashed), 2)?;
                }
                if attributes.modifiers.contains(Mod::BLINK_NONE) {
                    write(Self::Blink(Blink::None), 1)?;
                }
                if attributes.modifiers.contains(Mod::BLINK_SLOW) {
                    write(Self::Blink(Blink::Slow), 1)?;
                }
                if attributes.modifiers.contains(Mod::BLINK_RAPID) {
                    write(Self::Blink(Blink::Rapid), 1)?;
                }
                if attributes.modifiers.contains(Mod::ITALIC) {
                    write(Self::Italic(true), 1)?;
                }
                if attributes.modifiers.contains(Mod::NO_ITALIC) {
                    write(Self::Italic(false), 1)?;
                }
                if attributes.modifiers.contains(Mod::REVERSE) {
                    write(Self::Reverse(true), 1)?;
                }
                if attributes.modifiers.contains(Mod::NO_REVERSE) {
                    write(Self::Reverse(false), 1)?;
                }
                if attributes.modifiers.contains(Mod::INVISIBLE) {
                    write(Self::Invisible(true), 1)?;
                }
                if attributes.modifiers.contains(Mod::NO_INVISIBLE) {
                    write(Self::Invisible(false), 1)?;
                }
                if attributes.modifiers.contains(Mod::STRIKE_THROUGH) {
                    write(Self::StrikeThrough(true), 1)?;
                }
                if attributes.modifiers.contains(Mod::NO_STRIKE_THROUGH) {
                    write(Self::StrikeThrough(false), 1)?;
                }
            }
        }
        Ok(())
    }
}

/// A grouped SGR update.
///
/// [`Sgr`] accepts more than one parameter in a single `CSI ... m` sequence, so one escape can set
/// the foreground color, background color, underline color, and text modifiers together. Grouping
/// related changes reduces the number of bytes written and the number of CSI sequences the
/// terminal has to parse.
///
/// Note that if no attributes are set ([`SgrAttributes::default`]) the terminal will treat the
/// escape the same as [`Sgr::Reset`]. So if you are using this type you may wish to compare the
/// attributes you've built with [`SgrAttributes::default`] to decide whether or not you want to
/// write it to the terminal. Otherwise the escape codes for this type do not reset SGR. The
/// example below sets a green foreground and bold intensity but would not affect any other SGR
/// settings like underline or background color.
///
/// ```
/// # use termina::escape::csi::{Csi, Sgr, SgrAttributes, SgrModifiers};
/// # use termina::style::{ColorSpec, Intensity};
/// let attributes = SgrAttributes {
///     foreground: Some(ColorSpec::GREEN),
///     modifiers: SgrModifiers::INTENSITY_BOLD,
///     ..Default::default()
/// };
/// // Both SGR codes are in one CSI escape.
/// assert_eq!(Csi::Sgr(Sgr::Attributes(attributes)).to_string(), "\x1b[32;1m");
/// // Compare to emitting them separately:
/// assert_eq!(Csi::Sgr(Sgr::Foreground(ColorSpec::GREEN)).to_string(), "\x1b[32m");
/// assert_eq!(Csi::Sgr(Sgr::Intensity(Intensity::Bold)).to_string(), "\x1b[1m");
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
// > You can use more than one Ps value to select different character attributes.
// <https://vt100.net/docs/vt510-rm/SGR>
pub struct SgrAttributes {
    /// The foreground color used to paint text.
    pub foreground: Option<ColorSpec>,

    /// The background color used to paint the cell.
    pub background: Option<ColorSpec>,

    /// The color of the underline in the current cell.
    pub underline_color: Option<ColorSpec>,

    /// Bitflags for text modifiers such as intensity, underline, blink, italic, and reverse video.
    pub modifiers: SgrModifiers,

    /// The number of parameters which are allowed in a chunk.
    ///
    /// The VT parsers used in many terminal emulators set limits on the number of parameters a
    /// CSI sequence can use. After the limit they typically ignore all other parameters. For
    /// many terminals this is a relatively high number like 256 but some set their limit as low as
    /// 10. For maximum compatibility this is set to 10 by default.
    ///
    /// The number of parameters taken to describe a modifier varies by modifier. True-color colors
    /// (foreground, background, underline color) take the most while simple modifiers like
    /// [`SgrModifiers::ITALIC`] take just one.
    pub parameter_chunk_size: NonZeroU16,
}

impl Default for SgrAttributes {
    fn default() -> Self {
        Self {
            foreground: Default::default(),
            background: Default::default(),
            underline_color: Default::default(),
            modifiers: Default::default(),
            parameter_chunk_size: unsafe { NonZeroU16::new_unchecked(10) },
        }
    }
}

impl SgrAttributes {
    /// Returns `true` if no attributes are set, `false` otherwise.
    ///
    /// When empty attributes are displayed they produce the same escape sequence as [`Sgr::Reset`].
    /// If you are building attributes incrementally starting with [`SgrAttributes::default`] then
    /// you may wish to check whether the attributes are empty to decide whether or not you should
    /// write them to the terminal.
    ///
    /// ```
    /// # use termina::escape::csi::{Csi, Sgr, SgrAttributes, SgrModifiers};
    /// let mut attributes = SgrAttributes::default();
    /// assert!(attributes.is_empty());
    /// assert_eq!(
    ///     Csi::Sgr(Sgr::Reset).to_string(),
    ///     Csi::Sgr(Sgr::Attributes(attributes)).to_string(),
    /// );
    ///
    /// attributes.modifiers |= SgrModifiers::ITALIC;
    /// assert!(!attributes.is_empty());
    /// ```
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.foreground.is_none()
            && self.background.is_none()
            && self.underline_color.is_none()
            && self.modifiers.is_empty()
    }
}

// We could represent `SgrAttributes` as a `Vec<Sgr>` but we can flatten the type out to have a
// more compact representation with bitflags for each SGR instead:
bitflags::bitflags! {
    /// SGR modifier bits used by [`SgrAttributes`].
    ///
    /// These flags mirror SGR attributes that can be represented without carrying additional
    /// color or font data.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct SgrModifiers: u32 {
        /// No SGR modifiers.
        const NONE = 0;

        /// SGR 0: reset all attributes.
        const RESET = 1 << 1;

        /// SGR 22: normal intensity.
        const INTENSITY_NORMAL = 1 << 2;

        /// SGR 2: dim intensity.
        const INTENSITY_DIM = 1 << 3;

        /// SGR 1: bold intensity.
        const INTENSITY_BOLD = 1 << 4;

        /// SGR 24: no underline.
        const UNDERLINE_NONE = 1 << 5;

        /// SGR 4: single underline.
        const UNDERLINE_SINGLE = 1 << 6;

        /// SGR 21: double underline.
        const UNDERLINE_DOUBLE = 1 << 7;

        /// Kitty underline style 3: curly underline.
        const UNDERLINE_CURLY = 1 << 8;

        /// Kitty underline style 4: dotted underline.
        const UNDERLINE_DOTTED = 1 << 9;

        /// Kitty underline style 5: dashed underline.
        const UNDERLINE_DASHED = 1 << 10;

        /// SGR 25: no blink.
        const BLINK_NONE = 1 << 11;

        /// SGR 5: slow blink.
        const BLINK_SLOW = 1 << 12;

        /// SGR 6: rapid blink.
        const BLINK_RAPID = 1 << 13;

        /// SGR 3: italic.
        const ITALIC = 1 << 14;

        /// SGR 23: no italic.
        const NO_ITALIC = 1 << 15;

        /// SGR 7: reverse video.
        const REVERSE = 1 << 16;

        /// SGR 27: no reverse video.
        const NO_REVERSE = 1 << 17;

        /// SGR 8: invisible text.
        const INVISIBLE = 1 << 18;

        /// SGR 28: visible text.
        const NO_INVISIBLE = 1 << 19;

        /// SGR 9: strikethrough.
        const STRIKE_THROUGH = 1 << 20;

        /// SGR 29: no strikethrough.
        const NO_STRIKE_THROUGH = 1 << 21;
        // Support font and vertical align? They're not well supported in terminals so I think
        // it's fine to leave them out of this type.
    }
}

impl Default for SgrModifiers {
    fn default() -> Self {
        Self::NONE
    }
}

// Cursor

/// The cursor shape for the Kitty multi-cursor protocol.
///
/// This represents either a specific [`CursorStyle`] (protocol values 0-6)
/// or the special "follow main cursor" value (protocol value 29).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MultiCursorShape {
    /// Use a specific cursor style for secondary cursors.
    Style(CursorStyle),

    /// Use the main cursor's current shape for secondary cursors.
    FollowMainCursor,
}

/// Supported operations in the kitty multi-cursor protocol.
///
/// Returned in the capability query response (`CSI > SP q`). Each variant
/// corresponds to a protocol operation code the terminal advertises support for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MultiCursorCapability {
    /// Block cursor shape.
    BlockShape = 1,
    /// Beam cursor shape.
    BeamShape = 2,
    /// Underline cursor shape.
    UnderlineShape = 3,
    /// Follow the main cursor's shape.
    FollowMainCursorShape = 29,
    /// Change the color of text under extra cursors.
    TextColor = 30,
    /// Change the color of extra cursors.
    CursorColor = 40,
    /// Query currently set cursors.
    QueryCurrentCursors = 100,
    /// Query extra cursor colors.
    QueryColors = 101,
}

impl TryFrom<u8> for MultiCursorCapability {
    type Error = u8;

    fn try_from(value: u8) -> std::result::Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::BlockShape),
            2 => Ok(Self::BeamShape),
            3 => Ok(Self::UnderlineShape),
            29 => Ok(Self::FollowMainCursorShape),
            30 => Ok(Self::TextColor),
            40 => Ok(Self::CursorColor),
            100 => Ok(Self::QueryCurrentCursors),
            101 => Ok(Self::QueryColors),
            _ => Err(value),
        }
    }
}

/// Cursor-related CSI commands.
///
/// This includes cursor movement, tabulation, position reports, margins, cursor style, and
/// Kitty's multi-cursor extension.
///
/// ```
/// use termina::{
///     escape::csi::{Csi, Cursor},
///     OneBased,
/// };
///
/// let position = Cursor::Position {
///     line: OneBased::new(3).unwrap(),
///     col: OneBased::new(10).unwrap(),
/// };
/// assert_eq!(Csi::Cursor(position).to_string(), "\x1b[3;10H");
/// assert_eq!(Csi::Cursor(Cursor::default_position()).to_string(), "\x1b[1;1H");
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cursor {
    /// CBT Moves cursor to the Ps tabs backward. The default value of Ps is 1.
    BackwardTabulation(u32),

    /// TBC - TABULATION CLEAR
    TabulationClear(TabulationClear),

    /// CHA: Moves cursor to the Ps-th column of the active line. The default
    /// value of Ps is 1.
    CharacterAbsolute(OneBased),

    /// HPA CHARACTER POSITION ABSOLUTE
    /// HPA Moves cursor to the Ps-th column of the active line. The default
    /// value of Ps is 1.
    CharacterPositionAbsolute(OneBased),

    /// HPB - CHARACTER POSITION BACKWARD
    /// HPB Moves cursor to the left Ps columns. The default value of Ps is 1.
    CharacterPositionBackward(u32),

    /// HPR - CHARACTER POSITION FORWARD
    /// HPR Moves cursor to the right Ps columns. The default value of Ps is 1.
    CharacterPositionForward(u32),

    /// HVP - CHARACTER AND LINE POSITION
    /// HVP Moves cursor to the Ps1-th line and to the Ps2-th column. The
    /// default value of Ps1 and Ps2 is 1.
    CharacterAndLinePosition {
        /// The destination line.
        line: OneBased,
        /// The destination column.
        col: OneBased,
    },

    /// VPA - LINE POSITION ABSOLUTE
    /// Move to the corresponding vertical position (line Ps) of the current
    /// column. The default value of Ps is 1.
    LinePositionAbsolute(u32),

    /// VPB - LINE POSITION BACKWARD
    /// Moves cursor up Ps lines in the same column. The default value of Ps is
    /// 1.
    LinePositionBackward(u32),

    /// VPR - LINE POSITION FORWARD
    /// Moves cursor down Ps lines in the same column. The default value of Ps
    /// is 1.
    LinePositionForward(u32),

    /// CHT
    /// Moves cursor to the Ps tabs forward. The default value of Ps is 1.
    ForwardTabulation(u32),

    /// CNL Moves cursor to the first column of Ps-th following line. The
    /// default value of Ps is 1.
    NextLine(u32),

    /// CPL Moves cursor to the first column of Ps-th preceding line. The
    /// default value of Ps is 1.
    PrecedingLine(u32),

    /// CPR - ACTIVE POSITION REPORT
    /// If the DEVICE COMPONENT SELECT MODE (DCSM)
    /// is set to PRESENTATION, CPR is used to report the active presentation
    /// position of the sending device as residing in the presentation
    /// component at the n-th line position according to the line progression
    /// and at the m-th character position according to the character path,
    /// where n equals the value of Pn1 and m equal s the value of Pn2.
    /// If the DEVICE COMPONENT SELECT MODE (DCSM) is set to DATA, CPR is used
    /// to report the active data position of the sending device as
    /// residing in the data component at the n-th line position according
    /// to the line progression and at the m-th character position
    /// according to the character progression, where n equals the value of
    /// Pn1 and m equals the value of Pn2. CPR may be solicited by a DEVICE
    /// STATUS REPORT (DSR) or be sent unsolicited .
    ActivePositionReport {
        /// The reported line.
        line: OneBased,
        /// The reported column.
        col: OneBased,
    },

    /// CPR: this is the request from the client.
    /// The terminal will respond with ActivePositionReport.
    RequestActivePositionReport,

    /// SCP - Save Cursor Position.
    /// Only works when DECLRMM is disabled
    SaveCursor,

    /// RCP - Restore Cursor Position.
    RestoreCursor,

    /// CTC - CURSOR TABULATION CONTROL
    /// CTC causes one or more tabulation stops to be set or cleared in the
    /// presentation component, depending on the parameter values.
    /// In the case of parameter values 0, 2 or 4 the number of lines affected
    /// depends on the setting of the TABULATION STOP MODE (TSM).
    TabulationControl(CursorTabulationControl),

    /// CUB - Cursor Left
    /// Moves cursor to the left Ps columns. The default value of Ps is 1.
    Left(u32),

    /// CUD - Cursor Down
    Down(u32),

    /// CUF - Cursor Right
    Right(u32),

    /// CUU - Cursor Up
    Up(u32),

    /// CUP - Cursor Position
    /// Moves cursor to the Ps1-th line and to the Ps2-th column. The default
    /// value of Ps1 and Ps2 is 1.
    Position {
        /// The destination line.
        line: OneBased,
        /// The destination column.
        col: OneBased,
    },

    /// CVT - Cursor Line Tabulation
    /// CVT causes the active presentation position to be moved to the
    /// corresponding character position of the line corresponding to the n-th
    /// following line tabulation stop in the presentation component, where n
    /// equals the value of Pn.
    LineTabulation(u32),

    /// DECSTBM - Set top and bottom margins.
    SetTopAndBottomMargins {
        /// The top margin line.
        top: OneBased,
        /// The bottom margin line.
        bottom: OneBased,
    },

    /// [DECSLRM] - Set left and right margins.
    ///
    /// [DECSLRM]: https://vt100.net/docs/vt510-rm/DECSLRM.html
    SetLeftAndRightMargins {
        /// The left margin column.
        left: OneBased,
        /// The right margin column.
        right: OneBased,
    },

    /// Set the cursor style.
    CursorStyle(CursorStyle),

    /// Query the current cursor shape.
    QueryCursorShape,

    /// Capability query response (kitty multi-cursor protocol).
    ///
    /// Contains the set of operations the terminal supports. An empty list
    /// means the protocol is not supported.
    CursorShapeQueryResponse(Vec<MultiCursorCapability>),

    /// Set secondary cursor positions for the kitty multi-cursor protocol.
    SetMultipleCursors {
        /// The shape used for the secondary cursors.
        shape: MultiCursorShape,

        /// The one-based `(line, column)` positions of the secondary cursors.
        positions: Vec<(OneBased, OneBased)>,
    },

    /// Clear all secondary cursors from the kitty multi-cursor protocol.
    ClearSecondaryCursors,
}

impl Cursor {
    /// Returns the home cursor position, line 1 column 1.
    pub const fn default_position() -> Self {
        Self::Position {
            line: OneBased::from_zero_based(0),
            col: OneBased::from_zero_based(0),
        }
    }
}

impl Display for Cursor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fn write_csi<T: Default + Eq + Display>(
            value: T,
            f: &mut fmt::Formatter<'_>,
            control: &str,
        ) -> fmt::Result {
            if value == T::default() {
                write!(f, "{control}")
            } else {
                write!(f, "{value}{control}")
            }
        }

        match self {
            Cursor::BackwardTabulation(n) => write_csi(*n, f, "Z"),
            Cursor::TabulationClear(n) => write_csi(*n, f, "g"),
            Cursor::CharacterAbsolute(n) => write_csi(*n, f, "G"),
            Cursor::CharacterPositionAbsolute(n) => write_csi(*n, f, "``"),
            Cursor::CharacterPositionBackward(n) => write_csi(*n, f, "j"),
            Cursor::CharacterPositionForward(n) => write_csi(*n, f, "a"),
            Cursor::CharacterAndLinePosition { line, col } => write!(f, "{line};{col}f"),
            Cursor::LinePositionAbsolute(n) => write_csi(*n, f, "d"),
            Cursor::LinePositionBackward(n) => write_csi(*n, f, "k"),
            Cursor::LinePositionForward(n) => write_csi(*n, f, "e"),
            Cursor::ForwardTabulation(n) => write_csi(*n, f, "I"),
            Cursor::NextLine(n) => write_csi(*n, f, "E"),
            Cursor::PrecedingLine(n) => write_csi(*n, f, "F"),
            Cursor::ActivePositionReport { line, col } => write!(f, "{line};{col}R"),
            Cursor::RequestActivePositionReport => write!(f, "6n"),
            Cursor::SaveCursor => write!(f, "s"),
            Cursor::RestoreCursor => write!(f, "u"),
            Cursor::TabulationControl(n) => write_csi(*n, f, "W"),
            Cursor::Left(n) => write_csi(*n, f, "D"),
            Cursor::Down(n) => write_csi(*n, f, "B"),
            Cursor::Right(n) => write_csi(*n, f, "C"),
            Cursor::Up(n) => write_csi(*n, f, "A"),
            Cursor::Position { line, col } => write!(f, "{line};{col}H"),
            Cursor::LineTabulation(n) => write_csi(*n, f, "Y"),
            Cursor::SetTopAndBottomMargins { top, bottom } => {
                if top.get() == 1 && bottom.get() == u16::MAX {
                    write!(f, "r")
                } else {
                    write!(f, "{top};{bottom}r")
                }
            }
            Cursor::SetLeftAndRightMargins { left, right } => {
                if left.get() == 1 && right.get() == u16::MAX {
                    write!(f, "s")
                } else {
                    write!(f, "{left};{right}s")
                }
            }
            Cursor::CursorStyle(style) => write!(f, "{} q", *style as u8),
            Cursor::QueryCursorShape => write!(f, "> q"),
            Cursor::CursorShapeQueryResponse(caps) => {
                write!(f, ">")?;
                for (i, cap) in caps.iter().enumerate() {
                    if i > 0 {
                        write!(f, ";")?;
                    }
                    write!(f, "{}", *cap as u8)?;
                }
                write!(f, " q")
            }
            Cursor::SetMultipleCursors { shape, positions } => {
                write!(
                    f,
                    ">{}",
                    match shape {
                        MultiCursorShape::Style(style) => *style as u8,
                        MultiCursorShape::FollowMainCursor => 29,
                    }
                )?;
                for (line, col) in positions {
                    write!(f, ";2:{}:{}", line, col)?;
                }
                write!(f, " q")
            }
            Cursor::ClearSecondaryCursors => write!(f, ">0;4 q"),
        }
    }
}

/// Cursor tabulation control actions for CTC.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum CursorTabulationControl {
    /// Set a character tab stop at the active position.
    #[default]
    SetCharacterTabStopAtActivePosition = 0,

    /// Set a line tab stop at the active line.
    SetLineTabStopAtActiveLine = 1,

    /// Clear the character tab stop at the active position.
    ClearCharacterTabStopAtActivePosition = 2,

    /// Clear the line tab stop at the active line.
    ClearLineTabstopAtActiveLine = 3,

    /// Clear all character tab stops on the active line.
    ClearAllCharacterTabStopsAtActiveLine = 4,

    /// Clear all character tab stops.
    ClearAllCharacterTabStops = 5,

    /// Clear all line tab stops.
    ClearAllLineTabStops = 6,
}

impl Display for CursorTabulationControl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", *self as u8)
    }
}

/// Tab-stop clearing actions for TBC.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum TabulationClear {
    /// Clear the character tab stop at the active position.
    #[default]
    ClearCharacterTabStopAtActivePosition = 0,

    /// Clear the line tab stop at the active line.
    ClearLineTabStopAtActiveLine = 1,

    /// Clear all character tab stops on the active line.
    ClearCharacterTabStopsAtActiveLine = 2,

    /// Clear all character tab stops.
    ClearAllCharacterTabStops = 3,

    /// Clear all line tab stops.
    ClearAllLineTabStops = 4,

    /// Clear all character and line tab stops.
    ClearAllTabStops = 5,
}

impl Display for TabulationClear {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", *self as u8)
    }
}

// Edit

/// Text and display editing CSI commands.
///
/// ```
/// use termina::escape::csi::{Csi, Edit, EraseInDisplay, EraseInLine};
///
/// assert_eq!(
///     Csi::Edit(Edit::EraseInLine(EraseInLine::EraseToEndOfLine)).to_string(),
///     "\x1b[0K",
/// );
/// assert_eq!(
///     Csi::Edit(Edit::EraseInDisplay(EraseInDisplay::EraseDisplay)).to_string(),
///     "\x1b[2J",
/// );
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Edit {
    /// DCH - DELETE CHARACTER
    /// Deletes Ps characters from the cursor position to the right. The
    /// default value of Ps is 1. If the DEVICE COMPONENT SELECT MODE
    /// (DCSM) is set to PRESENTATION, DCH causes the contents of the
    /// active presentation position and, depending on the setting of the
    /// CHARACTER EDITING MODE (HEM), the contents of the n-1 preceding or
    /// following character positions to be removed from the presentation
    /// component, where n equals the value of Pn. The resulting gap is
    /// closed by shifting the contents of the adjacent character positions
    /// towards the active presentation position. At the other end of the
    /// shifted part, n character positions are put into the erased state.
    DeleteCharacter(u32),

    /// DL - DELETE LINE
    /// If the DEVICE COMPONENT SELECT MODE (DCSM) is set to PRESENTATION, DL
    /// causes the contents of the active line (the line that contains the
    /// active presentation position) and, depending on the setting of the
    /// LINE EDITING MODE (VEM), the contents of the n-1 preceding or
    /// following lines to be removed from the presentation component, where n
    /// equals the value of Pn. The resulting gap is closed by shifting the
    /// contents of a number of adjacent lines towards the active line. At
    /// the other end of the shifted part, n lines are put into the
    /// erased state.  The active presentation position is moved to the line
    /// home position in the active line. The line home position is
    /// established by the parameter value of SET LINE HOME (SLH). If the
    /// TABULATION STOP MODE (TSM) is set to SINGLE, character tabulation stops
    /// are cleared in the lines that are put into the erased state.  The
    /// extent of the shifted part is established by SELECT EDITING EXTENT
    /// (SEE).  Any occurrences of the start or end of a selected area, the
    /// start or end of a qualified area, or a tabulation stop in the shifted
    /// part, are also shifted.
    DeleteLine(u32),

    /// ECH - ERASE CHARACTER
    /// If the DEVICE COMPONENT SELECT MODE (DCSM) is set to PRESENTATION, ECH
    /// causes the active presentation position and the n-1 following
    /// character positions in the presentation component to be put into
    /// the erased state, where n equals the value of Pn.
    EraseCharacter(u32),

    /// EL - ERASE IN LINE
    /// If the DEVICE COMPONENT SELECT MODE (DCSM) is set to PRESENTATION, EL
    /// causes some or all character positions of the active line (the line
    /// which contains the active presentation position in the presentation
    /// component) to be put into the erased state, depending on the
    /// parameter values
    EraseInLine(EraseInLine),

    /// ICH - INSERT CHARACTER
    /// If the DEVICE COMPONENT SELECT MODE (DCSM) is set to PRESENTATION, ICH
    /// is used to prepare the insertion of n characters, by putting into the
    /// erased state the active presentation position and, depending on the
    /// setting of the CHARACTER EDITING MODE (HEM), the n-1 preceding or
    /// following character positions in the presentation component, where n
    /// equals the value of Pn. The previous contents of the active
    /// presentation position and an adjacent string of character positions are
    /// shifted away from the active presentation position. The contents of n
    /// character positions at the other end of the shifted part are removed.
    /// The active presentation position is moved to the line home position in
    /// the active line. The line home position is established by the parameter
    /// value of SET LINE HOME (SLH).
    InsertCharacter(u32),

    /// IL - INSERT LINE
    /// If the DEVICE COMPONENT SELECT MODE (DCSM) is set to PRESENTATION, IL
    /// is used to prepare the insertion of n lines, by putting into the
    /// erased state in the presentation component the active line (the
    /// line that contains the active presentation position) and, depending on
    /// the setting of the LINE EDITING MODE (VEM), the n-1 preceding or
    /// following lines, where n equals the value of Pn. The previous
    /// contents of the active line and of adjacent lines are shifted away
    /// from the active line. The contents of n lines at the other end of the
    /// shifted part are removed. The active presentation position is moved
    /// to the line home position in the active line. The line home
    /// position is established by the parameter value of SET LINE
    /// HOME (SLH).
    InsertLine(u32),

    /// SD - SCROLL DOWN
    /// SD causes the data in the presentation component to be moved by n line
    /// positions if the line orientation is horizontal, or by n character
    /// positions if the line orientation is vertical, such that the data
    /// appear to move down; where n equals the value of Pn. The active
    /// presentation position is not affected by this control function.
    ///
    /// Also known as Pan Up in DEC; see [SD].
    ///
    /// [SD]: https://vt100.net/docs/vt510-rm/SD.html
    ScrollDown(u32),

    /// SU - SCROLL UP
    /// SU causes the data in the presentation component to be moved by n line
    /// positions if the line orientation is horizontal, or by n character
    /// positions if the line orientation is vertical, such that the data
    /// appear to move up; where n equals the value of Pn. The active
    /// presentation position is not affected by this control function.
    ScrollUp(u32),

    /// ED - ERASE IN PAGE (XTerm calls this Erase in Display)
    EraseInDisplay(EraseInDisplay),

    /// REP - Repeat the preceding character n times
    Repeat(u32),
}

impl Display for Edit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fn write_csi(param: u32, f: &mut fmt::Formatter<'_>, control: &str) -> fmt::Result {
            if param == 1 {
                write!(f, "{control}")
            } else {
                write!(f, "{param}{control}")
            }
        }

        match self {
            Self::DeleteCharacter(n) => write_csi(*n, f, "P"),
            Self::DeleteLine(n) => write_csi(*n, f, "M"),
            Self::EraseCharacter(n) => write_csi(*n, f, "X"),
            Self::EraseInLine(n) => write_csi(*n as u32, f, "K"),
            Self::InsertCharacter(n) => write_csi(*n, f, "@"),
            Self::InsertLine(n) => write_csi(*n, f, "L"),
            Self::ScrollDown(n) => write_csi(*n, f, "T"),
            Self::ScrollUp(n) => write_csi(*n, f, "S"),
            Self::EraseInDisplay(n) => write_csi(*n as u32, f, "J"),
            Self::Repeat(n) => write_csi(*n, f, "b"),
        }
    }
}

/// Erase-in-line modes for EL.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum EraseInLine {
    /// Erase from the active position to the end of the line.
    #[default]
    EraseToEndOfLine = 0,

    /// Erase from the start of the line through the active position.
    EraseToStartOfLine = 1,

    /// Erase the entire active line.
    EraseLine = 2,
}

/// Erase-in-display modes for ED.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum EraseInDisplay {
    /// the active presentation position and the character positions up to the
    /// end of the page are put into the erased state
    #[default]
    EraseToEndOfDisplay = 0,
    /// the character positions from the beginning of the page up to and
    /// including the active presentation position are put into the erased
    /// state
    EraseToStartOfDisplay = 1,
    /// all character positions of the page are put into the erased state
    EraseDisplay = 2,
    /// Clears the scrollback.  This is an Xterm extension to ECMA-48.
    EraseScrollback = 3,
}

// Mode

/// Terminal mode CSI commands.
///
/// This enum covers Digital Equipment Corporation (DEC) private modes
/// (`CSI ? ... h/l/s/r/$p`), standard modes, xterm key modifier resources, and terminal theme
/// query/report extensions.
///
/// ```
/// use termina::escape::csi::{Csi, DecPrivateMode, DecPrivateModeCode, Mode};
///
/// let bracketed_paste = DecPrivateMode::Code(DecPrivateModeCode::BracketedPaste);
/// assert_eq!(
///     Csi::Mode(Mode::SetDecPrivateMode(bracketed_paste)).to_string(),
///     "\x1b[?2004h",
/// );
/// assert_eq!(
///     Csi::Mode(Mode::ResetDecPrivateMode(bracketed_paste)).to_string(),
///     "\x1b[?2004l",
/// );
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Set a DEC private mode.
    SetDecPrivateMode(DecPrivateMode),

    /// Reset a DEC private mode.
    ResetDecPrivateMode(DecPrivateMode),

    /// Save a DEC private mode.
    SaveDecPrivateMode(DecPrivateMode),

    /// Restore a DEC private mode.
    RestoreDecPrivateMode(DecPrivateMode),

    /// Query a DEC private mode setting.
    QueryDecPrivateMode(DecPrivateMode),

    /// Report a DEC private mode setting.
    ReportDecPrivateMode {
        /// The DEC private mode being reported.
        mode: DecPrivateMode,

        /// The current setting state for the mode.
        setting: DecModeSetting,
    },

    /// Set a standard terminal mode.
    SetMode(TerminalMode),

    /// Reset a standard terminal mode.
    ResetMode(TerminalMode),

    /// Query a standard terminal mode.
    QueryMode(TerminalMode),

    /// Set or query an xterm key modifier resource.
    XtermKeyMode {
        /// The xterm key modifier resource.
        resource: XtermKeyModifierResource,

        /// The resource value, or `None` to query it.
        value: Option<i64>,
    },

    /// Query the current terminal theme.
    QueryTheme,

    /// Report the current terminal theme.
    ReportTheme(ThemeMode),
}

impl Display for Mode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SetDecPrivateMode(mode) => write!(f, "?{mode}h"),
            Self::ResetDecPrivateMode(mode) => write!(f, "?{mode}l"),
            Self::SaveDecPrivateMode(mode) => write!(f, "?{mode}s"),
            Self::RestoreDecPrivateMode(mode) => write!(f, "?{mode}r"),
            Self::QueryDecPrivateMode(mode) => write!(f, "?{mode}$p"),
            Self::ReportDecPrivateMode { mode, setting } => {
                write!(f, "?{mode};{}$y", *setting as u8)
            }
            Self::SetMode(mode) => write!(f, "{mode}h"),
            Self::ResetMode(mode) => write!(f, "{mode}l"),
            Self::QueryMode(mode) => write!(f, "?{mode}$p"),
            Self::XtermKeyMode { resource, value } => {
                write!(f, ">{}", *resource as u8)?;
                if let Some(value) = value {
                    write!(f, ";{}", value)?;
                } else {
                    write!(f, ";")?;
                }
                write!(f, "m")
            }
            Self::QueryTheme => write!(f, "?996n"),
            Self::ReportTheme(mode) => write!(f, "?997;{}n", *mode as u8),
        }
    }
}

/// A Digital Equipment Corporation private mode value.
///
/// DEC private modes are terminal-specific mode numbers encoded with `CSI ? ...` sequences. Many
/// modern terminal emulators still use this namespace for xterm-compatible extensions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecPrivateMode {
    /// A known DEC private mode code.
    Code(DecPrivateModeCode),

    /// A DEC private mode code not modeled by [`DecPrivateModeCode`].
    Unspecified(u16),
}

impl Display for DecPrivateMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match *self {
            Self::Code(code) => code as u16,
            Self::Unspecified(code) => code,
        };
        write!(f, "{code}")
    }
}

/// Known Digital Equipment Corporation private mode numbers.
///
/// The DEC private-mode namespace started with DEC terminals and now also carries common
/// xterm-compatible extensions such as mouse tracking, alternate screens, and bracketed paste.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecPrivateModeCode {
    /// Mode 1: [DECCKM] - Application Cursor Keys.
    ///
    /// This mode is only effective when the terminal is in keypad application mode (see DECKPAM)
    /// and the ANSI/VT52 mode (DECANM) is set (see DECANM). Under these conditions, if the cursor
    /// key mode is reset, the four cursor function keys will send ANSI cursor control commands. If
    /// cursor key mode is set, the four cursor function keys will send application functions.
    ///
    /// [DECCKM]: https://vt100.net/docs/vt510-rm/DECCKM.html
    ApplicationCursorKeys = 1,

    /// Mode 2: [DECANM] - behave like a VT52.
    ///
    /// This is a historical compatibility mode. Modern terminal applications usually leave the
    /// terminal in ANSI mode and should not need to enable VT52 behavior.
    ///
    /// [DECANM]: https://vt100.net/docs/vt510-rm/DECANM.html
    DecAnsiMode = 2,

    /// Mode 3: [DECCOLM] - Select 132 columns.
    ///
    /// Setting this mode asks the terminal to switch from 80 columns to 132 columns. Many modern
    /// terminals ignore or restrict this behavior.
    ///
    /// [DECCOLM]: https://vt100.net/docs/vt510-rm/DECCOLM.html
    Select132Columns = 3,

    /// Mode 4: [DECSCLM] - Smooth scroll.
    ///
    /// This mode controls whether scrolling should be smooth or jump-scroll style on DEC
    /// terminals. Modern emulators commonly ignore it.
    ///
    /// [DECSCLM]: https://vt100.net/docs/vt510-rm/DECSCLM.html
    SmoothScroll = 4,

    /// Mode 5: [DECSCNM] - Reverse video.
    ///
    /// Setting this mode swaps the screen's foreground and background presentation.
    ///
    /// [DECSCNM]: https://vt100.net/docs/vt510-rm/DECSCNM.html
    ReverseVideo = 5,

    /// Mode 6: [DECOM] - Origin Mode.
    ///
    /// When enabled, OriginMode constrains cursor to the scroll region and makes its position
    /// relative to that region.
    ///
    /// [DECOM]: https://vt100.net/docs/vt510-rm/DECOM.html
    OriginMode = 6,

    /// Mode 7: [DECAWM] - Auto Wrap.
    ///
    /// When enabled, wrap to next line. Otherwise replace the last character.
    ///
    /// [DECAWM]: https://vt100.net/docs/vt510-rm/DECAWM.html
    AutoWrap = 7,

    /// Mode 8: [DECARM] - Auto Repeat.
    ///
    /// This controls whether held-down keys repeatedly generate input.
    ///
    /// [DECARM]: https://vt100.net/docs/vt510-rm/DECARM.html
    AutoRepeat = 8,

    /// Mode 12: start blinking the cursor.
    ///
    /// This is an xterm cursor-control extension, not a DEC private mode from the VT manuals.
    StartBlinkingCursor = 12,

    /// Mode 25: show the cursor.
    ///
    /// Applications commonly set this mode while running and reset it to hide the cursor during
    /// full-screen drawing.
    ShowCursor = 25,

    /// Mode 45: reverse-wrap from the left edge to the previous line.
    ///
    /// This xterm extension controls whether cursor-left from column 1 wraps to the previous line.
    ReverseWraparound = 45,

    /// Mode 69: [DECLRMM] - Left Right Margin Mode.
    ///
    /// [DECLRMM]: https://vt100.net/docs/vt510-rm/DECLRMM.html
    LeftRightMarginMode = 69,

    /// Mode 80: DECSDM - Sixel Display Mode.
    ///
    /// See the sixel mode discussion in [EK-VT38T-UG-001].
    ///
    /// [EK-VT38T-UG-001]: https://vt100.net/dec/ek-vt38t-ug-001.pdf#page=132
    SixelDisplayMode = 80,

    /// Mode 1000: enable mouse button press/release reporting.
    ///
    /// xterm mouse tracking defines the report encoding for this mode. Termina parses compatible
    /// reports as [`crate::Event::Mouse`].
    ///
    /// [xterm mouse tracking]: https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
    MouseTracking = 1000,

    /// Mode 1001: enable highlight mouse tracking.
    ///
    /// Warning: this requires a cooperative and timely application response; otherwise the
    /// terminal can hang. xterm mouse tracking defines the report encoding for this mode.
    /// Termina parses compatible reports as [`crate::Event::Mouse`].
    ///
    /// [xterm mouse tracking]: https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
    HighlightMouseTracking = 1001,

    /// Mode 1002: enable mouse button press/release and drag reporting.
    ///
    /// xterm mouse tracking defines the report encoding for this mode. Termina parses compatible
    /// reports as [`crate::Event::Mouse`].
    ///
    /// [xterm mouse tracking]: https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
    ButtonEventMouse = 1002,

    /// Mode 1003: enable mouse motion, button press/release, and drag reporting.
    ///
    /// xterm mouse tracking defines the report encoding for this mode. Termina parses compatible
    /// reports as [`crate::Event::Mouse`].
    ///
    /// [xterm mouse tracking]: https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
    AnyEventMouse = 1003,

    /// Mode 1004: enable FocusIn/FocusOut events.
    ///
    /// When enabled, compatible terminals send focus events as CSI `I` and CSI `O`. Termina parses
    /// those reports as [`crate::Event::FocusIn`] and [`crate::Event::FocusOut`].
    FocusTracking = 1004,

    /// Mode 1005: use the UTF-8 mouse coordinate encoding.
    ///
    /// This is an older extended-coordinate encoding. New applications generally prefer
    /// [`Self::SGRMouse`] when supported.
    Utf8Mouse = 1005,

    /// Mode 1006: use SGR extended coordinates in mouse reporting.
    ///
    /// This does not enable mouse reporting itself; it only controls how reports are encoded.
    /// xterm extended coordinates define the `CSI < ... M/m` report shape parsed as
    /// [`MouseReport::Sgr1006`].
    ///
    /// [xterm extended coordinates]: https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
    SGRMouse = 1006,

    /// Mode 1015: use RXVT mouse coordinate encoding.
    ///
    /// xterm extended coordinates document this as the older urxvt-style coordinate extension.
    ///
    /// [xterm extended coordinates]: https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
    RXVTMouse = 1015,

    /// Mode 1016: use pixels rather than text cells in mouse reporting.
    ///
    /// This does not enable mouse reporting itself; it only controls how reports are encoded.
    /// xterm SGR pixels define the pixel-coordinate report shape parsed as
    /// [`MouseReport::Sgr1016`].
    ///
    /// [xterm SGR pixels]: https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h3-SGR-Pixels
    SGRPixelsMouse = 1016,

    /// Mode 1036: make xterm send Escape before Meta-modified keys.
    ///
    /// This changes keyboard encoding so Meta-modified input is delivered as an Escape-prefixed
    /// sequence.
    XTermMetaSendsEscape = 1036,

    /// Mode 1039: make xterm send Escape before Alt-modified keys.
    ///
    /// This changes keyboard encoding so Alt-modified input is delivered as an Escape-prefixed
    /// sequence.
    XTermAltSendsEscape = 1039,

    /// Mode 1048: save cursor as in DECSC.
    ///
    /// Full-screen applications often combine this with alternate-screen modes so they can restore
    /// the user's cursor position on exit.
    SaveCursor = 1048,

    /// Mode 1049: clear and switch to the alternate screen.
    ///
    /// This is the common xterm private mode for full-screen applications. It switches away from
    /// the scrollback-backed main screen and clears the alternate screen.
    ClearAndEnableAlternateScreen = 1049,

    /// Mode 47: switch to the alternate screen.
    ///
    /// This is an older alternate-screen mode. New applications usually use mode 1049.
    EnableAlternateScreen = 47,

    /// Mode 1047: switch to the alternate screen using xterm's optional alternate-screen mode.
    ///
    /// Unlike mode 1049, this does not imply saving/restoring the cursor.
    OptEnableAlternateScreen = 1047,

    /// Mode 2004: enable bracketed paste mode.
    ///
    /// When enabled, pasted text is wrapped in explicit start/end markers so applications can
    /// distinguish paste from typed input. Termina parses the wrapped payload as
    /// [`crate::Event::Paste`]. xterm documents this mode as [bracketed paste mode].
    ///
    /// [bracketed paste mode]: https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h2-Bracketed-Paste-Mode
    BracketedPaste = 2004,

    /// Mode 2027: grapheme clustering mode from [Contour Unicode core].
    ///
    /// [Contour Unicode core]: https://github.com/contour-terminal/terminal-unicode-core/
    GraphemeClustering = 2027,

    /// Mode 2031: theme notification mode from [Contour color-palette notifications].
    ///
    /// [Contour color-palette notifications]: https://github.com/contour-terminal/contour/
    Theme = 2031,

    /// Mode 1070: use private color registers for each sixel or ReGIS graphic.
    ///
    /// This keeps image color registers local to a graphic instead of sharing them globally across
    /// the terminal session.
    UsePrivateColorRegistersForEachGraphic = 1070,

    /// Mode 2026: [Synchronized output proposal] mode.
    ///
    /// [Synchronized output proposal]: https://gist.github.com/christianparpart/
    SynchronizedOutput = 2026,

    /// Mode 7727: enable MinTTY application Escape key mode.
    ///
    /// This MinTTY extension changes how the Escape key is encoded in application contexts.
    MinTTYApplicationEscapeKeyMode = 7727,

    /// Mode 8452: adjust cursor positioning after emitting sixel.
    ///
    /// This xterm mode controls whether sixel output advances the cursor as if the graphic
    /// occupied cells.
    SixelScrollsRight = 8452,

    /// Mode 9001: Windows Terminal win32-input-mode from [Microsoft terminal keyboard handling].
    ///
    /// [Microsoft terminal keyboard handling]: https://github.com/microsoft/terminal/
    Win32InputMode = 9001,
}

/// A standard terminal mode value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalMode {
    /// A known standard terminal mode code.
    Code(TerminalModeCode),

    /// A standard terminal mode code not modeled by [`TerminalModeCode`].
    Unspecified(u16),
}

impl Display for TerminalMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match *self {
            Self::Code(code) => code as u16,
            Self::Unspecified(code) => code,
        };
        write!(f, "{code}")
    }
}

/// Known standard terminal mode numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalModeCode {
    /// Mode 2: [KAM] - Keyboard Action Mode.
    ///
    /// When set, keyboard input is disabled. Applications usually avoid this mode unless they are
    /// intentionally locking local keyboard entry.
    ///
    /// [KAM]: https://vt100.net/docs/vt510-rm/KAM.html
    KeyboardAction = 2,

    /// Mode 4: [IRM] - Insert Replace Mode.
    ///
    /// When set, printable characters insert at the cursor and shift existing content right.
    /// When reset, printable characters replace existing cells.
    ///
    /// [IRM]: https://vt100.net/docs/vt510-rm/IRM.html
    Insert = 4,

    /// Mode 8: bidirectional support mode.
    ///
    /// The terminal-wg bidi recommendation uses this mode to enable bidirectional text support in
    /// terminals that implement the proposal.
    ///
    /// [Terminal WG bidi recommendation]: https://terminal-wg.pages.freedesktop.org/bidi/
    BiDirectionalSupportMode = 8,

    /// Mode 12: [SRM] - Send Receive Mode.
    ///
    /// ECMA-48 defines this as local echo control. Microsoft terminal implementations also use
    /// mode 12 for cursor blinking, so callers should be aware of that compatibility difference.
    ///
    /// [SRM]: https://vt100.net/docs/vt510-rm/SRM.html
    SendReceive = 12,

    /// Mode 20: [LNM] - Line Feed/New Line Mode.
    ///
    /// When set, line feed also performs carriage return. When reset, line feed only moves to the
    /// next line.
    ///
    /// [LNM]: https://vt100.net/docs/vt510-rm/LNM.html
    AutomaticNewline = 20,

    /// Mode 25: Microsoft terminal cursor visibility.
    ///
    /// This mirrors the DEC private cursor-visibility mode in some Microsoft terminal contexts.
    ShowCursor = 25,
}

/// xterm key modifier resources addressed by `CSI > ... m`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum XtermKeyModifierResource {
    /// Resource 0: xterm keyboard modifier keys.
    ///
    /// This resource controls xterm's general modified-key behavior.
    Keyboard = 0,

    /// Resource 1: xterm cursor-key modifier keys.
    ///
    /// This resource controls modified arrow-key and navigation-key encodings.
    CursorKeys = 1,

    /// Resource 2: xterm function-key modifier keys.
    ///
    /// This resource controls modified function-key encodings.
    FunctionKeys = 2,

    /// Resource 4: xterm other-key modifier keys.
    ///
    /// This resource controls modified-key encodings for keys outside the cursor/function groups.
    OtherKeys = 4,
}

/// Reported state for a DEC private mode query.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecModeSetting {
    /// Report value 0: the terminal does not recognize the requested mode.
    NotRecognized = 0,

    /// Report value 1: the mode is set.
    Set = 1,

    /// Report value 2: the mode is reset.
    Reset = 2,

    /// Report value 3: the mode is permanently set and cannot be changed.
    PermanentlySet = 3,

    /// Report value 4: the mode is permanently reset and cannot be changed.
    PermanentlyReset = 4,
}

/// Terminal theme values reported by the Contour theme extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeMode {
    /// Report value 1: the terminal is using a dark theme.
    Dark = 1,

    /// Report value 2: the terminal is using a light theme.
    Light = 2,
}

// Mouse

/// Mouse reports emitted by terminal mouse tracking modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseReport {
    /// An SGR 1006 mouse report using text-cell coordinates.
    ///
    /// This is the report format enabled by [`DecPrivateModeCode::SGRMouse`]. Coordinates are
    /// one-based terminal cell positions.
    Sgr1006 {
        /// The one-based cell column.
        x: u16,

        /// The one-based cell row.
        y: u16,

        /// The reported mouse button action.
        button: MouseButton,

        /// The modifiers active during the mouse event.
        modifiers: Modifiers,
    },

    /// An SGR 1016 mouse report using pixel coordinates.
    ///
    /// This is the report format enabled by [`DecPrivateModeCode::SGRPixelsMouse`]. Coordinates
    /// are pixel positions instead of terminal cell positions.
    Sgr1016 {
        /// The x coordinate in pixels.
        x_pixels: u16,

        /// The y coordinate in pixels.
        y_pixels: u16,

        /// The reported mouse button action.
        button: MouseButton,

        /// The modifiers active during the mouse event.
        modifiers: Modifiers,
    },
}

impl Display for MouseReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MouseReport::Sgr1006 {
                x,
                y,
                button,
                modifiers,
            } => {
                let mut b = 0;
                // TODO: check this.
                if (*modifiers & Modifiers::SHIFT) != Modifiers::NONE {
                    b |= 4;
                }
                if (*modifiers & Modifiers::ALT) != Modifiers::NONE {
                    b |= 8;
                }
                if (*modifiers & Modifiers::CONTROL) != Modifiers::NONE {
                    b |= 16;
                }
                b |= match button {
                    MouseButton::Button1Press | MouseButton::Button1Release => 0,
                    MouseButton::Button2Press | MouseButton::Button2Release => 1,
                    MouseButton::Button3Press | MouseButton::Button3Release => 2,
                    MouseButton::Button4Press | MouseButton::Button4Release => 64,
                    MouseButton::Button5Press | MouseButton::Button5Release => 65,
                    MouseButton::Button6Press | MouseButton::Button6Release => 66,
                    MouseButton::Button7Press | MouseButton::Button7Release => 67,
                    MouseButton::Button1Drag => 32,
                    MouseButton::Button2Drag => 33,
                    MouseButton::Button3Drag => 34,
                    MouseButton::None => 35,
                };
                let trailer = match button {
                    MouseButton::Button1Press
                    | MouseButton::Button2Press
                    | MouseButton::Button3Press
                    | MouseButton::Button4Press
                    | MouseButton::Button5Press
                    | MouseButton::Button1Drag
                    | MouseButton::Button2Drag
                    | MouseButton::Button3Drag
                    | MouseButton::None => 'M',
                    _ => 'm',
                };
                write!(f, "<{b};{x};{y}{trailer}")
            }
            MouseReport::Sgr1016 {
                x_pixels,
                y_pixels,
                button,
                modifiers,
            } => {
                let mut b = 0;
                // TODO: check this.
                if (*modifiers & Modifiers::SHIFT) != Modifiers::NONE {
                    b |= 4;
                }
                if (*modifiers & Modifiers::ALT) != Modifiers::NONE {
                    b |= 8;
                }
                if (*modifiers & Modifiers::CONTROL) != Modifiers::NONE {
                    b |= 16;
                }
                b |= match button {
                    MouseButton::Button1Press | MouseButton::Button1Release => 0,
                    MouseButton::Button2Press | MouseButton::Button2Release => 1,
                    MouseButton::Button3Press | MouseButton::Button3Release => 2,
                    MouseButton::Button4Press | MouseButton::Button4Release => 64,
                    MouseButton::Button5Press | MouseButton::Button5Release => 65,
                    MouseButton::Button6Press | MouseButton::Button6Release => 66,
                    MouseButton::Button7Press | MouseButton::Button7Release => 67,
                    MouseButton::Button1Drag => 32,
                    MouseButton::Button2Drag => 33,
                    MouseButton::Button3Drag => 34,
                    MouseButton::None => 35,
                };
                let trailer = match button {
                    MouseButton::Button1Press
                    | MouseButton::Button2Press
                    | MouseButton::Button3Press
                    | MouseButton::Button4Press
                    | MouseButton::Button5Press
                    | MouseButton::Button1Drag
                    | MouseButton::Button2Drag
                    | MouseButton::Button3Drag
                    | MouseButton::None => 'M',
                    _ => 'm',
                };
                write!(f, "<{b};{x_pixels};{y_pixels}{trailer}")
            }
        }
    }
}

/// Mouse button actions encoded in SGR mouse reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    /// Button 1 was pressed; encoded with button value 0 and trailer `M`.
    Button1Press,

    /// Button 2 was pressed; encoded with button value 1 and trailer `M`.
    Button2Press,

    /// Button 3 was pressed; encoded with button value 2 and trailer `M`.
    Button3Press,

    /// Button 4 was pressed; encoded with button value 64 and trailer `M`.
    Button4Press,

    /// Button 5 was pressed; encoded with button value 65 and trailer `M`.
    Button5Press,

    /// Button 6 was pressed; encoded with button value 66.
    Button6Press,

    /// Button 7 was pressed; encoded with button value 67.
    Button7Press,

    /// Button 1 was released; encoded with button value 0 and trailer `m`.
    Button1Release,

    /// Button 2 was released; encoded with button value 1 and trailer `m`.
    Button2Release,

    /// Button 3 was released; encoded with button value 2 and trailer `m`.
    Button3Release,

    /// Button 4 was released; encoded with button value 64 and trailer `m`.
    Button4Release,

    /// Button 5 was released; encoded with button value 65 and trailer `m`.
    Button5Release,

    /// Button 6 was released; encoded with button value 66.
    Button6Release,

    /// Button 7 was released; encoded with button value 67.
    Button7Release,

    /// Button 1 was dragged; encoded with button value 32 and trailer `M`.
    Button1Drag,

    /// Button 2 was dragged; encoded with button value 33 and trailer `M`.
    Button2Drag,

    /// Button 3 was dragged; encoded with button value 34 and trailer `M`.
    Button3Drag,

    /// No mouse button was involved; encoded with button value 35 and trailer `M`.
    None,
}

// --- Kitty keyboard protocol ---
//
// <https://sw.kovidgoyal.net/kitty/keyboard-protocol/>.

bitflags::bitflags! {
    /// Feature flags for the Kitty keyboard protocol.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct KittyKeyboardFlags: u8 {
        /// No keyboard enhancement flags.
        const NONE = 0;

        /// Disambiguate escape codes for keys that otherwise share encodings.
        const DISAMBIGUATE_ESCAPE_CODES = 1;

        /// Report press, release, and repeat event types.
        const REPORT_EVENT_TYPES = 2;

        /// Report alternate key values.
        const REPORT_ALTERNATE_KEYS = 4;

        /// Report all keys as escape codes.
        const REPORT_ALL_KEYS_AS_ESCAPE_CODES = 8;

        /// Report associated text for key events.
        const REPORT_ASSOCIATED_TEXT = 16;
    }
}

impl Display for KittyKeyboardFlags {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.bits())
    }
}

/// CSI sequences for interacting with the [Kitty Keyboard Protocol].
///
/// [Kitty Keyboard Protocol]: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
///
/// Note that the Kitty Keyboard Protocol requires terminals to maintain different stacks for the
/// main and alternate screens. This means that applications which use alternate screens do not
/// necessarily need to pop flags (via [`Self::PopFlags`]) when exiting. By entering the main screen
/// the flags must be automatically reset by the terminal. Any flags which were pushed, however,
/// will remain active in the alternate screen, even if the alternate screen is entered by a
/// different application. Pop flags during shutdown when the application pushed flags itself.
///
/// ```
/// use termina::escape::csi::{
///     Csi, Keyboard, KittyKeyboardFlags, SetKeyboardFlagsMode,
/// };
///
/// let command = Keyboard::SetFlags {
///     flags: KittyKeyboardFlags::REPORT_EVENT_TYPES,
///     mode: SetKeyboardFlagsMode::SetSpecified,
/// };
/// assert_eq!(Csi::Keyboard(command).to_string(), "\x1b[=2;2u");
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Keyboard {
    /// Query the current values of the flags.
    QueryFlags,

    /// A report from the terminal declaring which flags are currently set.
    ReportFlags(KittyKeyboardFlags),

    /// Pushes the given flags onto the terminal's stack.
    PushFlags(KittyKeyboardFlags),

    /// Pops the given number of stack entries from the terminal's stack.
    PopFlags(u8),

    /// Requests keyboard enhancement with the given flags according to the mode.
    ///
    /// Also see [SetKeyboardFlagsMode].
    SetFlags {
        /// The flags to assign, set, or clear.
        flags: KittyKeyboardFlags,
        /// How the terminal should apply `flags`.
        mode: SetKeyboardFlagsMode,
    },
}

impl Display for Keyboard {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::QueryFlags => write!(f, "?u"),
            // NOTE: this is sent by the terminal, not meant to be sent by the application.
            Self::ReportFlags(flags) => write!(f, "?{flags}u"),
            Self::PushFlags(flags) => write!(f, ">{flags}u"),
            Self::PopFlags(number) => write!(f, "<{number}u"),
            Self::SetFlags { flags, mode } => write!(f, "={flags};{mode}u"),
        }
    }
}

/// Controls how the flags passed in [Keyboard::SetFlags] are interpreted by the terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetKeyboardFlagsMode {
    /// Request any of the given flags and reset any flags which are not given.
    AssignAll = 1,

    /// Request the given flags and ignore any flags which are not given.
    SetSpecified = 2,

    /// Clear the given flags and ignore any flags which are not given.
    ClearSpecified = 3,
}

impl Display for SetKeyboardFlagsMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", *self as u8)
    }
}

/// Device and status CSI commands.
///
/// ```
/// use termina::escape::csi::{Csi, Device};
///
/// assert_eq!(Csi::Device(Device::StatusReport).to_string(), "\x1b[5n");
/// assert_eq!(
///     Csi::Device(Device::RequestPrimaryDeviceAttributes).to_string(),
///     "\x1b[c",
/// );
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Device {
    /// A device-attributes response.
    DeviceAttributes(()),

    /// [DECSTR] - soft terminal reset.
    ///
    /// [DECSTR]: https://vt100.net/docs/vt510-rm/DECSTR.html
    SoftReset,

    /// Request primary device attributes.
    RequestPrimaryDeviceAttributes,

    /// Request secondary device attributes.
    RequestSecondaryDeviceAttributes,

    /// Request tertiary device attributes.
    RequestTertiaryDeviceAttributes,

    /// Request terminal status.
    StatusReport,

    /// Request the terminal name and version.
    ///
    /// Mintty and GNOME VTE discuss this query in [Mintty issue #881] and [GNOME VTE issue #235].
    ///
    /// [Mintty issue #881]: https://github.com/mintty/mintty/issues/881
    /// [GNOME VTE issue #235]: https://gitlab.gnome.org/GNOME/vte/-/issues/235
    RequestTerminalNameAndVersion,

    /// Request terminal parameters.
    RequestTerminalParameters(i64),
}

impl Display for Device {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DeviceAttributes(_) => unimplemented!(),
            Self::SoftReset => write!(f, "!p"),
            Self::RequestPrimaryDeviceAttributes => write!(f, "c"),
            Self::RequestSecondaryDeviceAttributes => write!(f, ">c"),
            Self::RequestTertiaryDeviceAttributes => write!(f, "=c"),
            Self::StatusReport => write!(f, "5n"),
            Self::RequestTerminalNameAndVersion => write!(f, ">q"),
            Self::RequestTerminalParameters(n) => write!(f, "{};1;1;128;128;1;0x", n + 2),
        }
    }
}

// Window

/// Window manipulation and window report CSI commands.
///
/// ```
/// use termina::escape::csi::{Csi, Window};
///
/// assert_eq!(
///     Csi::Window(Box::new(Window::ReportWindowTitle)).to_string(),
///     "\x1b[21t",
/// );
/// assert_eq!(
///     Csi::Window(Box::new(Window::ResizeWindowCells {
///         width: Some(120),
///         height: Some(40),
///     }))
///     .to_string(),
///     "\x1b[8;40;120t",
/// );
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Window {
    /// De-iconify the window.
    DeIconify,

    /// Iconify the window.
    Iconify,

    /// Move the window to a pixel position.
    MoveWindow {
        /// The x coordinate in pixels.
        x: i64,

        /// The y coordinate in pixels.
        y: i64,
    },

    /// Resize the window to a pixel size.
    ResizeWindowPixels {
        /// The desired width in pixels.
        width: Option<i64>,

        /// The desired height in pixels.
        height: Option<i64>,
    },

    /// Raise the window.
    RaiseWindow,

    /// Lower the window.
    LowerWindow,

    /// Refresh the window.
    RefreshWindow,

    /// Resize the window to a cell size.
    ResizeWindowCells {
        /// The desired width in cells.
        width: Option<i64>,

        /// The desired height in cells.
        height: Option<i64>,
    },

    /// Restore a maximized window.
    RestoreMaximizedWindow,

    /// Maximize the window.
    MaximizeWindow,

    /// Maximize the window vertically.
    MaximizeWindowVertically,

    /// Maximize the window horizontally.
    MaximizeWindowHorizontally,

    /// Leave fullscreen mode.
    UndoFullScreenMode,

    /// Enter fullscreen mode.
    ChangeToFullScreenMode,

    /// Toggle fullscreen mode.
    ToggleFullScreen,

    /// Request the window state.
    ReportWindowState,

    /// Request the window position.
    ReportWindowPosition,

    /// Request the text-area position.
    ReportTextAreaPosition,

    /// Request the text-area size in pixels.
    ReportTextAreaSizePixels,

    /// Report the text-area size in pixels in response to `CSI 14 t`.
    ReportTextAreaSizePixelsResponse {
        /// The reported text-area width in pixels.
        width: Option<i64>,

        /// The reported text-area height in pixels.
        height: Option<i64>,
    },

    /// Request the window size in pixels.
    ReportWindowSizePixels,

    /// Request the screen size in pixels.
    ReportScreenSizePixels,

    /// Request the cell size in pixels.
    ReportCellSizePixels,

    /// Report the cell size in pixels.
    ReportCellSizePixelsResponse {
        /// The reported cell width in pixels.
        width: Option<i64>,

        /// The reported cell height in pixels.
        height: Option<i64>,
    },

    /// Request the text-area size in cells.
    ReportTextAreaSizeCells,

    /// Request the screen size in cells.
    ReportScreenSizeCells,

    /// Request the icon label.
    ReportIconLabel,

    /// Request the window title.
    ReportWindowTitle,

    /// Push the icon and window title onto the title stack.
    PushIconAndWindowTitle,

    /// Push the icon title onto the title stack.
    PushIconTitle,

    /// Push the window title onto the title stack.
    PushWindowTitle,

    /// Pop the icon and window title from the title stack.
    PopIconAndWindowTitle,

    /// Pop the icon title from the title stack.
    PopIconTitle,

    /// Pop the window title from the title stack.
    PopWindowTitle,

    /// DECRQCRA; used by esctest
    ChecksumRectangularArea {
        /// The checksum request identifier.
        request_id: i64,

        /// The page number to checksum.
        page_number: i64,

        /// The top row of the rectangular area.
        top: OneBased,

        /// The left column of the rectangular area.
        left: OneBased,

        /// The bottom row of the rectangular area.
        bottom: OneBased,

        /// The right column of the rectangular area.
        right: OneBased,
    },
}

impl Display for Window {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        struct NumstrOrEmpty(Option<i64>);
        impl Display for NumstrOrEmpty {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                if let Some(x) = self.0 {
                    write!(f, "{x}")?
                }
                Ok(())
            }
        }

        match self {
            Window::DeIconify => write!(f, "1t"),
            Window::Iconify => write!(f, "2t"),
            Window::MoveWindow { x, y } => write!(f, "3;{x};{y}t"),
            Window::ResizeWindowPixels { width, height } => {
                write!(f, "4;{};{}t", NumstrOrEmpty(*height), NumstrOrEmpty(*width))
            }
            Window::RaiseWindow => write!(f, "5t"),
            Window::LowerWindow => write!(f, "6t"),
            Window::RefreshWindow => write!(f, "7t"),
            Window::ResizeWindowCells { width, height } => {
                write!(f, "8;{};{}t", NumstrOrEmpty(*height), NumstrOrEmpty(*width))
            }
            Window::RestoreMaximizedWindow => write!(f, "9;0t"),
            Window::MaximizeWindow => write!(f, "9;1t"),
            Window::MaximizeWindowVertically => write!(f, "9;2t"),
            Window::MaximizeWindowHorizontally => write!(f, "9;3t"),
            Window::UndoFullScreenMode => write!(f, "10;0t"),
            Window::ChangeToFullScreenMode => write!(f, "10;1t"),
            Window::ToggleFullScreen => write!(f, "10;2t"),
            Window::ReportWindowState => write!(f, "11t"),
            Window::ReportWindowPosition => write!(f, "13t"),
            Window::ReportTextAreaPosition => write!(f, "13;2t"),
            Window::ReportTextAreaSizePixels => write!(f, "14t"),
            Window::ReportTextAreaSizePixelsResponse { width, height } => {
                write!(f, "4;{};{}t", NumstrOrEmpty(*height), NumstrOrEmpty(*width))
            }
            Window::ReportWindowSizePixels => write!(f, "14;2t"),
            Window::ReportScreenSizePixels => write!(f, "15t"),
            Window::ReportCellSizePixels => write!(f, "16t"),
            Window::ReportCellSizePixelsResponse { width, height } => {
                write!(f, "6;{};{}t", NumstrOrEmpty(*height), NumstrOrEmpty(*width))
            }
            Window::ReportTextAreaSizeCells => write!(f, "18t"),
            Window::ReportScreenSizeCells => write!(f, "19t"),
            Window::ReportIconLabel => write!(f, "20t"),
            Window::ReportWindowTitle => write!(f, "21t"),
            Window::PushIconAndWindowTitle => write!(f, "22;0t"),
            Window::PushIconTitle => write!(f, "22;1t"),
            Window::PushWindowTitle => write!(f, "22;2t"),
            Window::PopIconAndWindowTitle => write!(f, "23;0t"),
            Window::PopIconTitle => write!(f, "23;1t"),
            Window::PopWindowTitle => write!(f, "23;2t"),
            Window::ChecksumRectangularArea {
                request_id,
                page_number,
                top,
                left,
                bottom,
                right,
            } => write!(
                f,
                "{request_id};{page_number};{top};{left};{bottom};{right}*y"
            ),
        }
    }
}

#[cfg(test)]
mod test {
    use crate::style::RgbColor;

    use super::*;

    const ENTER_ALTERNATE_SCREEN: Csi = Csi::Mode(Mode::SetDecPrivateMode(DecPrivateMode::Code(
        DecPrivateModeCode::ClearAndEnableAlternateScreen,
    )));

    const EXIT_ALTERNATE_SCREEN: Csi = Csi::Mode(Mode::ResetDecPrivateMode(DecPrivateMode::Code(
        DecPrivateModeCode::ClearAndEnableAlternateScreen,
    )));

    #[test]
    fn encoding() {
        // Enter the alternate screen using the mode part of CSI.
        // <https://learn.microsoft.com/en-us/windows/console/console-virtual-terminal-sequences#alternate-screen-buffer>
        assert_eq!("\x1b[?1049h", ENTER_ALTERNATE_SCREEN.to_string());
        assert_eq!("\x1b[?1049l", EXIT_ALTERNATE_SCREEN.to_string());

        // Push Kitty keyboard flags used by Helix and Kakoune at time of writing.
        assert_eq!(
            "\x1b[>5u",
            Csi::Keyboard(Keyboard::PushFlags(
                KittyKeyboardFlags::DISAMBIGUATE_ESCAPE_CODES
                    | KittyKeyboardFlags::REPORT_ALTERNATE_KEYS
            ))
            .to_string()
        );

        // Common SGR: turn the text (i.e. foreground) green
        assert_eq!(
            "\x1b[32m",
            Csi::Sgr(Sgr::Foreground(ColorSpec::GREEN)).to_string(),
        );
        // ... and then reset to turn off the green.
        assert_eq!(
            "\x1b[39m",
            Csi::Sgr(Sgr::Foreground(ColorSpec::Reset)).to_string(),
        );

        // Push current window title to the terminal's stack.
        assert_eq!(
            "\x1b[22;0t",
            Csi::Window(Box::new(Window::PushIconAndWindowTitle)).to_string(),
        );
        // ... and pop it.
        assert_eq!(
            "\x1b[23;0t",
            Csi::Window(Box::new(Window::PopIconAndWindowTitle)).to_string(),
        );

        // Set the cursor style to the terminal's default.
        // <https://terminalguide.namepad.de/seq/csi_sq_t_space/>
        assert_eq!(
            "\x1b[0 q",
            Csi::Cursor(Cursor::CursorStyle(CursorStyle::Default)).to_string()
        );
    }

    #[test]
    fn sgr_attributes_csi_param_limit() {
        let mut attributes = SgrAttributes {
            foreground: Some(ColorSpec::TrueColor(RgbColor::new(80, 100, 120).into())),
            background: Some(ColorSpec::TrueColor(RgbColor::new(80, 100, 120).into())),
            underline_color: Some(ColorSpec::TrueColor(RgbColor::new(80, 100, 120).into())),
            modifiers: SgrModifiers::UNDERLINE_CURLY,
            ..Default::default()
        };
        // The sequence must be chunked into two since the chunk size is exceeded.
        // Here it is perfectly chunked so that the foreground and background are a full chunk.
        let expected = "\x1b[38;2;80;100;120;48;2;80;100;120m\x1b[58:2::80:100:120;4:3m";
        assert_eq!(expected, Csi::Sgr(Sgr::Attributes(attributes)).to_string());
        // If we make the chunk size bigger, we still chunk the same way. We wouldn't cut an SGR
        // sequence up in the middle: that would make it nonsense.
        attributes.parameter_chunk_size = NonZeroU16::new(12).unwrap();
        assert_eq!(expected, Csi::Sgr(Sgr::Attributes(attributes)).to_string());
    }

    #[test]
    fn sgr_attributes_small_chunk_size_no_leading_reset() {
        // A `parameter_chunk_size` smaller than a single color group must not emit a leading
        // empty SGR (`\x1b[m`), that would reset all attributes. There's nothing to split
        // before the first parameter, so it is written as-is.
        let attributes = SgrAttributes {
            foreground: Some(ColorSpec::TrueColor(RgbColor::new(1, 2, 3).into())),
            parameter_chunk_size: NonZeroU16::new(4).unwrap(),
            ..Default::default()
        };
        let s = Csi::Sgr(Sgr::Attributes(attributes)).to_string();
        assert!(!s.starts_with("\x1b[m"), "spurious leading reset: {s:?}");
        assert_eq!(s, "\x1b[38;2;1;2;3m");
    }

    #[test]
    fn multi_cursor_encoding() {
        // QueryCursorShape
        assert_eq!(
            "\x1b[> q",
            Csi::Cursor(Cursor::QueryCursorShape).to_string()
        );

        // CursorShapeQueryResponse with capability codes
        assert_eq!(
            "\x1b[>1;2;29;100 q",
            Csi::Cursor(Cursor::CursorShapeQueryResponse(vec![
                MultiCursorCapability::BlockShape,
                MultiCursorCapability::BeamShape,
                MultiCursorCapability::FollowMainCursorShape,
                MultiCursorCapability::QueryCurrentCursors,
            ]))
            .to_string()
        );

        // SetMultipleCursors with MultiCursorShape::FollowMainCursor
        assert_eq!(
            "\x1b[>29;2:1:1;2:2:5 q",
            Csi::Cursor(Cursor::SetMultipleCursors {
                shape: MultiCursorShape::FollowMainCursor,
                positions: vec![
                    (OneBased::new(1).unwrap(), OneBased::new(1).unwrap()),
                    (OneBased::new(2).unwrap(), OneBased::new(5).unwrap()),
                ],
            })
            .to_string()
        );

        // SetMultipleCursors with MultiCursorShape::Style
        assert_eq!(
            "\x1b[>2;2:3:10 q",
            Csi::Cursor(Cursor::SetMultipleCursors {
                shape: MultiCursorShape::Style(CursorStyle::SteadyBlock),
                positions: vec![(OneBased::new(3).unwrap(), OneBased::new(10).unwrap()),],
            })
            .to_string()
        );

        // ClearSecondaryCursors
        assert_eq!(
            "\x1b[>0;4 q",
            Csi::Cursor(Cursor::ClearSecondaryCursors).to_string()
        );
    }
}
