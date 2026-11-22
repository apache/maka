//! Typed ANSI escape-sequence helpers.
//!
//! Termina models Control Sequence Introducer (CSI), Device Control String (DCS), and Operating
//! System Command (OSC) sequences it knows how to emit so callers can compose terminal control
//! payloads through [`Display`] instead of hand-written byte strings.
//!
//! # Examples
//!
//! ```
//! use termina::{
//!     escape::{
//!         csi::{Csi, Cursor},
//!         CSI,
//!     },
//!     OneBased,
//! };
//!
//! let cursor_home = Csi::Cursor(Cursor::Position {
//!     line: OneBased::new(1).unwrap(),
//!     col: OneBased::new(1).unwrap(),
//! });
//!
//! assert_eq!(cursor_home.to_string(), format!("{CSI}1;1H"));
//! ```
//!
//! # Implementation Notes
//!
//! This module tree is adapted from [termwiz escape helpers]. It was originally yanked from TermWiz
//! equivalents and then trimmed into the set of escape sequences Termina needs. Most differences
//! are stylistic edits plus additions and subtractions in the modeled sequence set.
//!
//! [termwiz escape helpers]: https://docs.rs/termwiz/latest/termwiz/escape/index.html
//! [`Display`]: std::fmt::Display

pub mod csi;
pub mod dcs;
pub mod osc;

/// Control Sequence Introducer (`ESC [`), the prefix for parameterized terminal control functions.
///
/// CSI sequences carry numeric parameters and a final byte. Termina models the supported CSI
/// families in [`csi::Csi`].
pub const CSI: &str = "\x1b[";

/// Operating System Command introducer (`ESC ]`), used for terminal integration commands.
///
/// OSC sequences are commonly used for window titles, clipboard integration, and color queries.
/// Termina models the supported commands in [`osc::Osc`].
pub const OSC: &str = "\x1b]";

/// String Terminator (`ESC \`), used to end OSC and DCS string controls.
///
/// Most modern terminal string controls may also be terminated by [`BEL`], but Termina emits the
/// explicit string terminator form for the sequences it formats.
pub const ST: &str = "\x1b\\";

/// Single Shift 3 (`ESC O`), the prefix used by SS3 key sequences.
///
/// Application-keypad and function-key encodings commonly use this prefix instead of [`CSI`].
pub const SS3: &str = "\x1bO";

/// Device Control String introducer (`ESC P`), used for structured terminal queries.
///
/// Termina models the supported request and response forms in [`dcs::Dcs`].
pub const DCS: &str = "\x1bP";

/// Bell control character (`BEL`, `0x07`).
///
/// BEL can ring the terminal bell and is also accepted by many terminals as an OSC terminator.
pub const BEL: &str = "\x07";
