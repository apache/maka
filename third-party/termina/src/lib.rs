//! Terminal I/O, escape-sequence types, styling, and input parsing.
//!
//! Termina keeps the terminal protocol visible. Applications write typed CSI, OSC, and DCS values
//! from [`escape`] instead of assembling byte strings, and read typed [`Event`] values instead of
//! decoding terminal input by hand. [`PlatformTerminal`] opens the current process terminal,
//! switches raw/cooked mode, writes bytes, and creates an [`EventReader`] for synchronous input.
//!
//! Code that already has terminal bytes can use [`Parser`] directly. That is useful for PTY tests,
//! terminal multiplexers, or callers that own the input source and only need Termina's parser.
//!
//! # Examples
//!
//! ```no_run
//! use std::io::{self, Write};
//!
//! use termina::{
//!     event::{KeyCode, KeyEventKind},
//!     Event, PlatformTerminal, Terminal,
//! };
//!
//! fn main() -> io::Result<()> {
//!     let mut terminal = PlatformTerminal::new()?;
//!     terminal.enter_raw_mode()?;
//!     writeln!(terminal, "Press q to exit.")?;
//!
//!     let reader = terminal.event_reader();
//!     loop {
//!         let event = reader.read(|_| true)?;
//!         if matches!(
//!             event,
//!             Event::Key(key)
//!                 if key.kind == KeyEventKind::Press && key.code == KeyCode::Char('q')
//!         ) {
//!             break;
//!         }
//!     }
//!
//!     terminal.enter_cooked_mode()
//! }
//! ```
//!
//! Parsing PTY bytes directly does not require opening a terminal handle:
//!
//! ```
//! use termina::{Event, Parser};
//!
//! let mut parser = Parser::default();
//! parser.parse(b"\x1b[5~", false).unwrap();
//! assert!(matches!(parser.pop(), Some(Event::Key(_))));
//! ```

pub(crate) mod base64;
pub mod escape;
pub mod event;
pub(crate) mod parse;
pub mod style;
mod terminal;

use std::{fmt, num::NonZeroU16};

pub use event::{reader::EventReader, Event, PlatformWaker};
#[cfg(windows)]
pub use parse::windows;
pub use parse::Parser;

pub use terminal::{PlatformHandle, PlatformTerminal, Terminal};

#[cfg(feature = "event-stream")]
pub use event::stream::EventStream;

/// A one-based terminal coordinate or dimension.
///
/// Terminal protocols generally count rows and columns from 1, while Rust collections and many
/// application models count from 0. `OneBased` stores the protocol value and rejects zero. Use
/// [`Self::from_zero_based`] when converting from an application index and [`Self::get_zero_based`]
/// when converting back.
///
/// # Examples
///
/// ```
/// use termina::OneBased;
///
/// let column = OneBased::from_zero_based(4);
/// assert_eq!(column.get(), 5);
/// assert_eq!(column.get_zero_based(), 4);
/// assert!(OneBased::new(0).is_none());
/// ```
///
/// # Implementation Notes
///
/// This reimplements the coordinate helper from [termwiz escape helpers] on top of
/// [`NonZeroU16`].
///
/// [termwiz escape helpers]: https://docs.rs/termwiz/latest/termwiz/escape/index.html
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OneBased(NonZeroU16);

impl OneBased {
    /// Creates a one-based value from an already one-based integer.
    ///
    /// Returns `None` for zero because zero is not a valid terminal row, column, or dimension in
    /// the escape sequences modeled by Termina.
    pub const fn new(n: u16) -> Option<Self> {
        match NonZeroU16::new(n) {
            Some(n) => Some(Self(n)),
            None => None,
        }
    }

    /// Converts a zero-based application index into a one-based terminal value.
    ///
    /// This panics when `n` is [`u16::MAX`], because adding one would overflow the stored
    /// [`NonZeroU16`].
    pub const fn from_zero_based(n: u16) -> Self {
        assert!(n < u16::MAX);
        Self(unsafe { NonZeroU16::new_unchecked(n + 1) })
    }

    /// Returns the stored one-based value.
    pub const fn get(self) -> u16 {
        self.0.get()
    }

    /// Converts the stored terminal value back to a zero-based application index.
    pub const fn get_zero_based(self) -> u16 {
        self.get() - 1
    }
}

impl Default for OneBased {
    fn default() -> Self {
        Self(unsafe { NonZeroU16::new_unchecked(1) })
    }
}

impl fmt::Display for OneBased {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl From<NonZeroU16> for OneBased {
    fn from(n: NonZeroU16) -> Self {
        Self(n)
    }
}

/// The dimensions of a terminal window.
///
/// `cols` and `rows` describe the terminal window in character cells, which is the size used by
/// cursor positioning and layout code. Pixel dimensions are available when the platform reports
/// them. On Unix, Termina reads those optional pixel fields from the `TIOCGWINSZ` window-size
/// query when the terminal fills them in. Windows currently reports `None` for both pixel fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowSize {
    /// The width in terminal cells.
    #[doc(alias = "width")]
    pub cols: u16,

    /// The height in terminal cells.
    #[doc(alias = "height")]
    pub rows: u16,

    /// The width of the window in pixels, if the platform reports it.
    pub pixel_width: Option<u16>,

    /// The height of the window in pixels, if the platform reports it.
    pub pixel_height: Option<u16>,
}
