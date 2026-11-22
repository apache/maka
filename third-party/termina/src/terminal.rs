//! Terminal handles and platform-neutral terminal operations.
//!
//! [`PlatformTerminal`] opens the process terminal for the current target. It implements
//! [`Terminal`], which combines byte output, raw/cooked mode switching, terminal dimensions,
//! synchronous event reads, polling, and panic-hook cleanup. Termina does not enter alternate
//! screen with [`DecPrivateModeCode::ClearAndEnableAlternateScreen`], enable
//! [`DecPrivateModeCode::BracketedPaste`], or enable mouse tracking modes such as
//! [`DecPrivateModeCode::MouseTracking`] for you. Those are protocol choices the application
//! writes explicitly with [`crate::escape`].
//!
//! # Examples
//!
//! ```no_run
//! use std::{io, time::Duration};
//!
//! use termina::{
//!     event::{Event, KeyEventKind},
//!     PlatformTerminal, Terminal,
//! };
//!
//! fn main() -> io::Result<()> {
//!     let mut terminal = PlatformTerminal::new()?;
//!     terminal.enter_raw_mode()?;
//!
//!     if terminal.poll(|_| true, Some(Duration::from_millis(250)))? {
//!         let event = terminal.read(|event| {
//!             matches!(event, Event::Key(key) if key.kind == KeyEventKind::Press)
//!         })?;
//!         if let Event::Key(key) = event {
//!             println!("received {:?}", key.code);
//!         }
//!     }
//!
//!     terminal.enter_cooked_mode()
//! }
//! ```

#[cfg(unix)]
mod unix;

#[cfg(windows)]
mod windows;

use std::{io, time::Duration};

#[cfg(unix)]
pub use unix::*;

#[cfg(windows)]
pub use windows::*;

use crate::{Event, EventReader, WindowSize};

#[cfg(doc)]
use crate::escape::csi::{DecPrivateModeCode, Keyboard};

/// The terminal implementation for the current platform.
///
/// On Unix this aliases `UnixTerminal`. On Windows this aliases `WindowsTerminal`.
#[cfg(unix)]
pub type PlatformTerminal = UnixTerminal;
#[cfg(windows)]
pub type PlatformTerminal = WindowsTerminal;

/// The output handle type passed to panic hooks on the current platform.
///
/// The hook receives this lower-level handle instead of `PlatformTerminal` so cleanup code can
/// write terminal reset sequences even while the higher-level terminal value is unwinding.
#[cfg(unix)]
pub type PlatformHandle = FileDescriptor;
#[cfg(windows)]
pub type PlatformHandle = OutputHandle;

/// Platform-agnostic terminal I/O surface.
///
/// The trait is implemented by the Unix and Windows backends and also requires [`io::Write`], so a
/// terminal value is both an output sink and an input/event source. `enter_raw_mode` and
/// `enter_cooked_mode` only manage the platform terminal mode. Application-level terminal features
/// such as alternate screen, bracketed paste, focus tracking, mouse tracking, and keyboard
/// protocol flags are CSI/OSC writes and remain the caller's responsibility. See
/// [`DecPrivateModeCode::ClearAndEnableAlternateScreen`],
/// [`DecPrivateModeCode::BracketedPaste`], [`DecPrivateModeCode::FocusTracking`],
/// [`DecPrivateModeCode::MouseTracking`], and [`Keyboard`] for the typed escape values.
///
/// `poll` and `read` use filters because the terminal stream may include responses that the caller
/// is not currently waiting for. Rejected events stay buffered in [`EventReader`] so later reads
/// can still observe them.
///
/// # Implementation Notes
///
/// This trait is based on [termwiz's terminal API], but Termina keeps feature setup outside the
/// terminal type and mirrors crossterm's synchronous event-reader shape for `poll` and `read`.
///
/// [termwiz's terminal API]: https://docs.rs/termwiz/latest/termwiz/terminal/index.html
pub trait Terminal: io::Write {
    /// Enters raw mode for the platform terminal.
    ///
    /// Raw mode disables line buffering and other terminal-driver processing, so key presses and
    /// escape sequences can reach the application without waiting for Enter. Use
    /// [`Self::enter_cooked_mode`] before returning control to a normal shell.
    fn enter_raw_mode(&mut self) -> io::Result<()>;

    /// Enters cooked mode for the platform terminal.
    ///
    /// Cooked mode is the normal shell-facing mode for a terminal device. The terminal driver
    /// handles echo, line editing, and Enter-delimited input before passing data to the
    /// application. On Unix, this restores the termios state captured when the terminal was opened.
    /// On Windows, this switches the console input flags back to cooked behavior, but leaves other
    /// captured state, such as code pages and virtual-terminal flags, for drop-time cleanup.
    fn enter_cooked_mode(&mut self) -> io::Result<()>;

    /// Reads the current terminal window dimensions.
    fn get_dimensions(&self) -> io::Result<WindowSize>;

    /// Returns a cloneable event reader backed by the terminal input handle.
    fn event_reader(&self) -> EventReader;

    /// Checks if there is an [`Event`] available.
    ///
    /// Returns `Ok(true)` if an [`Event`] is available or `Ok(false)` if one is not available.
    /// If `timeout` is `None`, this blocks until a matching event is available.
    fn poll<F: Fn(&Event) -> bool>(&self, filter: F, timeout: Option<Duration>)
        -> io::Result<bool>;

    /// Reads a single [`Event`] from the terminal.
    ///
    /// This function blocks until an [`Event`] is available. Use [`Self::poll`] first to guarantee
    /// that the read won't block.
    fn read<F: Fn(&Event) -> bool>(&self, filter: F) -> io::Result<Event>;
    /// Installs a panic hook that can write terminal cleanup sequences.
    ///
    /// Depending on how your application handles panics, you may want to eagerly reset
    /// application-level terminal state before the process exits. Use this hook for cleanup such as
    /// disabling [`DecPrivateModeCode::BracketedPaste`] or returning from
    /// [`DecPrivateModeCode::ClearAndEnableAlternateScreen`] to the main screen.
    ///
    /// The hook receives a [`PlatformHandle`] for stdout or the platform console output. After the
    /// hook runs, Termina restores the platform mode as if [`Self::enter_cooked_mode`] had run.
    fn set_panic_hook(&mut self, f: impl Fn(&mut PlatformHandle) + Send + Sync + 'static);
}
