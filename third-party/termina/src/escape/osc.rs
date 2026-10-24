//! Operating System Command (OSC) escape sequences.
//!
//! OSC sequences carry string-style terminal integration commands such as window titles, clipboard
//! access, and dynamic color queries. Termina stores string payloads by borrowing where possible
//! so callers can format an OSC command without first allocating an owned [`String`].
//!
//! # Examples
//!
//! ```
//! use termina::escape::osc::Osc;
//!
//! assert_eq!(Osc::SetWindowTitle("demo").to_string(), "\x1b]2;demo\x1b\\");
//! ```
//!
//! OSC 52 selection payloads are base64-encoded when formatted:
//!
//! ```
//! use termina::escape::osc::{Osc, Selection};
//!
//! let command = Osc::SetSelection(Selection::CLIPBOARD, "copied text");
//! assert_eq!(command.to_string(), "\x1b]52;c;Y29waWVkIHRleHQ=\x1b\\");
//! ```
//!
//! # Implementation Notes
//!
//! This is intentionally a shallow copy of [termwiz's OSC support]. Termina removes the
//! macro-heavy parts, replaces the base64 implementation, and changes command payloads to borrow
//! `str` values instead of owning [`String`] values.
//!
//! [termwiz's OSC support]: https://docs.rs/termwiz/latest/termwiz/escape/struct.Osc.html

use std::{
    fmt::{self, Display},
    num::NonZeroU64,
    ops::Range,
};

use crate::{base64, style::RgbColor};

/// An Operating System Command string control.
///
/// Formatting writes the OSC introducer, a command number or command letter, the command payload,
/// and the string terminator. The numbered variants use common xterm-compatible assignments: OSC
/// 2 sets the window title, OSC 52 manages selections, and OSC 10-19 manage dynamic colors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Osc<'a> {
    /// OSC 0: set both the icon name and window title.
    SetIconNameAndWindowTitle(&'a str),

    /// OSC 2: set the window title.
    SetWindowTitle(&'a str),

    /// Sun terminal form: set the window title with `OSC l`.
    SetWindowTitleSun(&'a str),

    /// OSC 1: set the icon name.
    SetIconName(&'a str),

    /// Sun terminal form: set the icon name with `OSC L`.
    SetIconNameSun(&'a str),

    /// OSC 52: clear one or more terminal selections described by [`Selection`].
    ///
    /// Terminals use OSC 52 to expose clipboard-like selections. Clearing sends a selection target
    /// without content.
    ClearSelection(Selection),

    /// OSC 52: query one or more terminal selections described by [`Selection`].
    ///
    /// Querying sends `?` as the content payload and lets a cooperating terminal report the
    /// selection contents.
    QuerySelection(Selection),

    /// OSC 52: set one or more terminal selections described by [`Selection`].
    ///
    /// The string payload is base64-encoded when formatted, as required by OSC 52.
    SetSelection(Selection, &'a str),

    /// OSC 10-19: change or query dynamic terminal colors.
    ///
    /// Each [`DynamicColorNumber`] identifies the color slot. [`ColorOrQuery::Query`] formats as
    /// `?`, asking the terminal to report its current value; [`ColorOrQuery::Color`] carries the
    /// [`RgbColor`] to set.
    ChangeDynamicColors(DynamicColorNumber, Vec<ColorOrQuery>),

    /// OSC 110-119: reset a [`DynamicColorNumber`] slot to its default value.
    ///
    /// xterm defines reset commands by adding 100 to the dynamic color number.
    ResetDynamicColor(DynamicColorNumber),

    /// Private OSC 777 `nsh-text-input` negotiation, composition, or caret geometry.
    NshTextInput(NshTextInput),
    // TODO: I didn't copy many available commands yet...
}

/// The negotiated, private NSH text-input extension carried by OSC 777.
///
/// Text selection offsets count UTF-16 code units within `preedit`. Enable and
/// disable nonces identify an application subscription; composition IDs identify
/// source-owned lifetimes. The application owns admission and stale-ID rejection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NshTextInput {
    /// Ask whether the terminal implements this extension.
    Query,
    /// Acknowledge extension support without enabling forwarding.
    Supported,
    /// Subscribe to composition delivery with a positive application nonce.
    Enable(NonZeroU64),
    /// Acknowledge the subscription after draining old native delivery.
    Ready(NonZeroU64),
    /// Cancel only the named source-owned composition lifetime.
    Cancel(NonZeroU64),
    /// Revoke the subscription identified by this application nonce.
    Disable(NonZeroU64),
    /// Acknowledge revocation after draining native delivery.
    Disabled(NonZeroU64),
    /// Set or clear candidate-window bounds for the named subscription.
    Caret {
        nonce: NonZeroU64,
        bounds: Option<NshTextInputCaretRect>,
    },
    /// One atomic committed prefix and remaining composition snapshot.
    ///
    /// An inactive snapshot has empty preedit and selection `0..0`. Active
    /// snapshots may have empty preedit, including composition start. The range
    /// must fall on Unicode scalar boundaries; it may not split a surrogate pair.
    Update {
        composition: NonZeroU64,
        active: bool,
        selection: Range<usize>,
        commit: String,
        preedit: String,
    },
}

/// Exact candidate-window bounds in fractional terminal-cell coordinates.
///
/// All edges are finite and nonnegative. Zero-width insertion carets are valid;
/// the bottom edge must be strictly below the top edge.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NshTextInputCaretRect {
    edges: [f64; 4],
}

impl NshTextInputCaretRect {
    /// Validate left, top, right, and bottom edges.
    pub fn new(left: f64, top: f64, right: f64, bottom: f64) -> Option<Self> {
        let edges = [left, top, right, bottom];
        (edges.iter().all(|edge| edge.is_finite() && *edge >= 0.0) && right >= left && bottom > top)
            .then_some(Self { edges })
    }

    /// Return left, top, right, and bottom edges, in that order.
    pub fn edges(&self) -> [f64; 4] {
        self.edges
    }
}

// Construction excludes NaN, so equality is reflexive.
impl Eq for NshTextInputCaretRect {}

pub(crate) fn valid_text_input_update(
    active: bool,
    selection: &Range<usize>,
    preedit: &str,
) -> bool {
    if (!active && !preedit.is_empty()) || selection.start > selection.end {
        return false;
    }
    let mut offset = 0;
    let mut start_seen = selection.start == 0;
    if selection.end == 0 {
        return start_seen;
    }
    for ch in preedit.chars() {
        offset += ch.len_utf16();
        start_seen |= offset == selection.start;
        if offset >= selection.end {
            return offset == selection.end && start_seen;
        }
    }
    false
}

impl Display for Osc<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Self::NshTextInput(NshTextInput::Update {
            active,
            selection,
            preedit,
            ..
        }) = self
        {
            if !valid_text_input_update(*active, selection, preedit) {
                return Err(fmt::Error);
            }
        }
        f.write_str(super::OSC)?;
        match self {
            Self::SetIconNameAndWindowTitle(s) => write!(f, "0;{s}")?,
            Self::SetWindowTitle(s) => write!(f, "2;{s}")?,
            Self::SetWindowTitleSun(s) => write!(f, "l{s}")?,
            Self::SetIconName(s) => write!(f, "1;{s}")?,
            Self::SetIconNameSun(s) => write!(f, "L{s}")?,
            Self::ClearSelection(selection) => write!(f, "52;{selection}")?,
            Self::QuerySelection(selection) => write!(f, "52;{selection};?")?,
            Self::SetSelection(selection, content) => {
                // TODO: it'd be nice to avoid allocating a string to base64 encode.
                write!(f, "52;{selection};{}", base64::encode(content.as_bytes()))?
            }
            Self::ChangeDynamicColors(color, colors) => {
                write!(f, "{}", *color as u8)?;
                for color in colors {
                    write!(f, ";{color}")?
                }
            }
            Self::ResetDynamicColor(color) => write!(f, "{}", 100 + *color as u8)?,
            Self::NshTextInput(input) => {
                f.write_str("777;nsh-text-input;")?;
                match input {
                    NshTextInput::Query => f.write_str("query")?,
                    NshTextInput::Supported => f.write_str("supported")?,
                    NshTextInput::Enable(nonce) => write!(f, "enable;{nonce}")?,
                    NshTextInput::Ready(nonce) => write!(f, "ready;{nonce}")?,
                    NshTextInput::Cancel(composition) => write!(f, "cancel;{composition}")?,
                    NshTextInput::Disable(nonce) => write!(f, "disable;{nonce}")?,
                    NshTextInput::Disabled(nonce) => write!(f, "disabled;{nonce}")?,
                    NshTextInput::Caret { nonce, bounds } => {
                        write!(f, "caret;{nonce}")?;
                        if let Some(bounds) = bounds {
                            let [left, top, right, bottom] = bounds.edges();
                            write!(f, ";{left};{top};{right};{bottom}")?;
                        }
                    }
                    NshTextInput::Update {
                        composition,
                        active,
                        selection,
                        commit,
                        preedit,
                    } => write!(
                        f,
                        "update;{composition};{};{};{};{};{}",
                        u8::from(*active),
                        selection.start,
                        selection.end,
                        base64::encode(commit.as_bytes()),
                        base64::encode(preedit.as_bytes())
                    )?,
                }
            }
        }
        f.write_str(super::ST)?;
        Ok(())
    }
}

bitflags::bitflags! {
    /// OSC 52 selection targets.
    ///
    /// Multiple targets can be combined. Formatting concatenates the target letters/numbers in the
    /// order expected by xterm-compatible terminals.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Selection : u16 {
        /// No OSC 52 selection target.
        const NONE = 0;

        /// OSC 52 selection target `c`: the clipboard selection.
        const CLIPBOARD = 1<<1;

        /// OSC 52 selection target `p`: the primary selection.
        const PRIMARY=1<<2;

        /// OSC 52 selection target `s`: the select selection.
        const SELECT=1<<3;

        /// OSC 52 selection target `0`: cut buffer 0.
        const CUT0=1<<4;

        /// OSC 52 selection target `1`: cut buffer 1.
        const CUT1=1<<5;

        /// OSC 52 selection target `2`: cut buffer 2.
        const CUT2=1<<6;

        /// OSC 52 selection target `3`: cut buffer 3.
        const CUT3=1<<7;

        /// OSC 52 selection target `4`: cut buffer 4.
        const CUT4=1<<8;

        /// OSC 52 selection target `5`: cut buffer 5.
        const CUT5=1<<9;

        /// OSC 52 selection target `6`: cut buffer 6.
        const CUT6=1<<10;

        /// OSC 52 selection target `7`: cut buffer 7.
        const CUT7=1<<11;

        /// OSC 52 selection target `8`: cut buffer 8.
        const CUT8=1<<12;

        /// OSC 52 selection target `9`: cut buffer 9.
        const CUT9=1<<13;
    }
}

impl Display for Selection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.contains(Self::CLIPBOARD) {
            write!(f, "c")?;
        }
        if self.contains(Self::PRIMARY) {
            write!(f, "p")?;
        }
        if self.contains(Self::SELECT) {
            write!(f, "s")?;
        }
        if self.contains(Self::CUT0) {
            write!(f, "0")?;
        }
        if self.contains(Self::CUT1) {
            write!(f, "1")?;
        }
        if self.contains(Self::CUT2) {
            write!(f, "2")?;
        }
        if self.contains(Self::CUT3) {
            write!(f, "3")?;
        }
        if self.contains(Self::CUT4) {
            write!(f, "4")?;
        }
        if self.contains(Self::CUT5) {
            write!(f, "5")?;
        }
        if self.contains(Self::CUT6) {
            write!(f, "6")?;
        }
        if self.contains(Self::CUT7) {
            write!(f, "7")?;
        }
        if self.contains(Self::CUT8) {
            write!(f, "8")?;
        }
        if self.contains(Self::CUT9) {
            write!(f, "9")?;
        }
        Ok(())
    }
}

/// Dynamic color slots addressed by OSC 10-19.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum DynamicColorNumber {
    /// OSC 10: the default text foreground color used for normal cells.
    TextForegroundColor = 10,
    /// OSC 11: the default text background color used for normal cells.
    TextBackgroundColor = 11,
    /// OSC 12: the text cursor color.
    TextCursorColor = 12,
    /// OSC 13: the pointer foreground color used by xterm-compatible terminals.
    MouseForegroundColor = 13,
    /// OSC 14: the pointer background color used by xterm-compatible terminals.
    MouseBackgroundColor = 14,
    /// OSC 15: the Tektronix foreground color.
    TektronixForegroundColor = 15,
    /// OSC 16: the Tektronix background color.
    TektronixBackgroundColor = 16,
    /// OSC 17: the selection highlight background color.
    HighlightBackgroundColor = 17,
    /// OSC 18: the Tektronix cursor color.
    TektronixCursorColor = 18,
    /// OSC 19: the selection highlight foreground color.
    HighlightForegroundColor = 19,
}

impl DynamicColorNumber {
    pub(crate) fn from_index(index: u8) -> Option<Self> {
        match index {
            10 => Some(Self::TextForegroundColor),
            11 => Some(Self::TextBackgroundColor),
            12 => Some(Self::TextCursorColor),
            13 => Some(Self::MouseForegroundColor),
            14 => Some(Self::MouseBackgroundColor),
            15 => Some(Self::TektronixForegroundColor),
            16 => Some(Self::TektronixBackgroundColor),
            17 => Some(Self::HighlightBackgroundColor),
            18 => Some(Self::TektronixCursorColor),
            19 => Some(Self::HighlightForegroundColor),
            _ => None,
        }
    }
}

/// A dynamic color value or query marker for OSC color commands.
///
/// Use [`Self::Query`] to ask the terminal for a slot's current value, or [`Self::Color`] to set a
/// new RGB value:
///
/// ```
/// use termina::{
///     escape::osc::{ColorOrQuery, DynamicColorNumber, Osc},
///     style::RgbColor,
/// };
///
/// let query = Osc::ChangeDynamicColors(
///     DynamicColorNumber::TextBackgroundColor,
///     vec![ColorOrQuery::Query],
/// );
/// assert_eq!(query.to_string(), "\x1b]11;?\x1b\\");
///
/// let set = Osc::ChangeDynamicColors(
///     DynamicColorNumber::TextForegroundColor,
///     vec![RgbColor::new(40, 40, 40).into()],
/// );
/// assert_eq!(set.to_string(), "\x1b]10;rgb:2828/2828/2828\x1b\\");
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorOrQuery {
    /// Set the dynamic color to an RGB value.
    ///
    /// Formatting emits the `rgb:RRRR/GGGG/BBBB` form used by xterm OSC color controls.
    Color(RgbColor),

    /// Query the current dynamic color value.
    ///
    /// Formatting emits `?`, which asks the terminal to report the current value for that slot.
    Query,
}

impl Display for ColorOrQuery {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            ColorOrQuery::Query => write!(f, "?"),
            ColorOrQuery::Color(c) => {
                // rgb:RRRR/GGGG/BBBB
                write!(
                    f,
                    "rgb:{red:02x}{red:02x}/{green:02x}{green:02x}/{blue:02x}{blue:02x}",
                    red = c.red,
                    green = c.green,
                    blue = c.blue
                )
            }
        }
    }
}

impl From<RgbColor> for ColorOrQuery {
    fn from(color: RgbColor) -> Self {
        Self::Color(color)
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn encoding() {
        // OSC 11 query, asks the terminal for the background color.
        // <https://terminalguide.namepad.de/seq/osc-11/>
        // <https://terminalguide.namepad.de/seq/osc-4/>
        assert_eq!(
            "\x1b]11;?\x1b\\",
            Osc::ChangeDynamicColors(
                DynamicColorNumber::TextBackgroundColor,
                vec![ColorOrQuery::Query]
            )
            .to_string()
        );

        assert_eq!(
            "\x1b]11;rgb:2828/2828/2828\x1b\\",
            Osc::ChangeDynamicColors(
                DynamicColorNumber::TextBackgroundColor,
                vec![RgbColor::new(40, 40, 40).into()]
            )
            .to_string()
        );
    }
}
