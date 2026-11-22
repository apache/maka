//! Terminal input events.
//!
//! [`Event`] is the typed output of [`Parser`], [`EventReader`], and the optional `EventStream`.
//! Termina reports ordinary input events such as keys, mouse input, focus changes, resize events,
//! and bracketed paste. It also keeps terminal responses such as CSI, OSC, DCS, and Kitty graphics
//! in the same public enum so callers can issue a query and read the response without a second
//! internal event model.
//!
//! Use [`EventReader::read`] or [`Terminal::read`] when reading from a process terminal. Use
//! [`Parser::pop`] when parsing bytes from a PTY, terminal multiplexer, or other caller-owned
//! input source. [`EventReader`] is the main place to look for event-reading examples and filter
//! behavior.
//!
//! # Implementation Notes
//!
//! Most event code is adapted from [crossterm events]. The main difference is intentional: Termina
//! includes escape sequences like [`Csi`] and [`Dcs`] in [`Event`] and does not split the model
//! into separate internal and public events. The key event types otherwise stay close to
//! crossterm's shape.
//!
//! [crossterm events]: https://docs.rs/crossterm/latest/crossterm/event/index.html
//! [`Csi`]: crate::escape::csi::Csi
//! [`Dcs`]: crate::escape::dcs::Dcs
//! [`EventReader`]: crate::EventReader
//! [`EventReader::read`]: crate::EventReader::read
//! [`Parser`]: crate::Parser
//! [`Parser::pop`]: crate::Parser::pop
//! [`Terminal::read`]: crate::Terminal::read

use crate::{
    escape::{csi::Csi, dcs::Dcs, osc::Osc},
    WindowSize,
};

#[cfg(doc)]
use crate::escape::csi::{DecPrivateModeCode, KittyKeyboardFlags};
#[cfg(doc)]
use crate::{EventReader, Parser, Terminal};

pub(crate) mod reader;
pub(crate) mod source;
#[cfg(feature = "event-stream")]
pub(crate) mod stream;

pub use source::PlatformWaker;

/// A parsed terminal input event or terminal protocol response.
///
/// Values of this type are returned by [`EventReader::read`], [`Terminal::read`], and
/// [`Parser::pop`]. See [`EventReader`] for the normal terminal-reading flow, including how
/// filters skip events without losing them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// A keyboard event described by [`KeyEvent`].
    ///
    /// Check [`KeyEvent::kind`] when a binding should run once per physical key press. Some input
    /// sources report both press and release for the same key, so handling every `Event::Key`
    /// without checking for [`KeyEventKind::Press`] can run the binding twice.
    Key(KeyEvent),

    /// A mouse event described by [`MouseEvent`].
    ///
    /// Terminals produce these after an application enables mouse tracking with modes such as
    /// [`DecPrivateModeCode::MouseTracking`], [`DecPrivateModeCode::ButtonEventMouse`], or
    /// [`DecPrivateModeCode::AnyEventMouse`].
    Mouse(MouseEvent),

    /// An SGR mouse report whose coordinates retain their signed wire values.
    ///
    /// The application that enabled mouse tracking owns whether these are one-based cells
    /// (1006) or pixels (1016); the byte stream does not distinguish those modes.
    SgrMouse(SgrMouseEvent),

    /// The pointer left the window, as reported by Kitty's SGR-pixel extension.
    ///
    /// This event has no coordinates or button state. It is not a synthetic button release.
    MouseLeave,

    /// The terminal window was resized to the given [`WindowSize`].
    WindowResized(WindowSize),

    /// Terminal focus entered the application window.
    ///
    /// Terminals send this only after [`DecPrivateModeCode::FocusTracking`] has enabled focus
    /// tracking.
    FocusIn,

    /// Terminal focus left the application window.
    ///
    /// Terminals send this only after [`DecPrivateModeCode::FocusTracking`] has enabled focus
    /// tracking.
    FocusOut,

    /// A "bracketed" paste.
    ///
    /// Normally pasting into a terminal with Ctrl+v (or Super+v) enters the pasted text as if
    /// you had typed the keys individually. [`DecPrivateModeCode::BracketedPaste`] asks compatible
    /// terminals to wrap pasted text in explicit start/end markers so Termina can deliver the
    /// entire pasted content as one event. xterm documents this as [bracketed paste mode].
    ///
    /// [bracketed paste mode]: https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h2-Bracketed-Paste-Mode
    Paste(String),

    /// A parsed CSI response or report described by [`Csi`].
    ///
    /// Applications see this when the terminal sends a Control Sequence Introducer response, such
    /// as a cursor position report, device attributes, mode report, or [`Csi::Keyboard`] protocol
    /// report.
    Csi(Csi),

    /// A parsed OSC response described by [`Osc`].
    ///
    /// Applications see this when the terminal answers an Operating System Command query, such as a
    /// dynamic color query.
    Osc(Osc<'static>),

    /// A parsed DCS response described by [`Dcs`].
    ///
    /// Applications see this when the terminal answers a Device Control String query, such as
    /// DECRQSS.
    Dcs(Dcs),

    /// A complete Kitty graphics protocol response, received through the same input reader.
    KittyGraphicsResponse(KittyGraphicsResponse),

    /// The raw feature string from an iTerm2 `OSC 1337;Capabilities=` reply.
    ///
    /// This may be empty. Feature-token interpretation belongs to the caller; in particular,
    /// this event does not equate any one token with support for image transmission.
    Iterm2Capabilities(String),
}

impl Event {
    /// Returns `true` for terminal protocol responses.
    #[inline]
    pub fn is_escape(&self) -> bool {
        matches!(
            self,
            Self::Csi(_)
                | Self::Dcs(_)
                | Self::Osc(_)
                | Self::KittyGraphicsResponse(_)
                | Self::Iterm2Capabilities(_)
        )
    }
}

/// An identified response from the [Kitty graphics protocol].
///
/// These fields preserve the terminal's identifiers; matching them to an outstanding query or
/// placement belongs to the caller. A successful result reports protocol acceptance, not that a
/// frame has reached the screen. The parser accepts at most 256 bytes for the entire reply.
///
/// [Kitty graphics protocol]: https://sw.kovidgoyal.net/kitty/graphics-protocol/
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KittyGraphicsResponse {
    /// The image identifier from the response's `i` field.
    pub image_id: u32,
    /// The original image number, when the terminal also reports an `I` field.
    pub image_number: Option<u32>,
    /// The placement identifier, when the terminal reports a `p` field.
    pub placement_id: Option<u32>,
    /// `Ok(())` for an exact `OK`; otherwise the terminal's nonempty printable ASCII message.
    pub result: Result<(), String>,
}

/// A key event plus modifiers and protocol state.
///
/// `KeyEvent` appears inside [`Event::Key`], which is normally returned by [`EventReader::read`]
/// or [`Terminal::read`]. See [`EventReader`] for examples of filtering key events while leaving
/// other terminal events buffered.
///
/// `code` identifies the key, `kind` distinguishes press/release/repeat when the terminal reports
/// that detail, `modifiers` carries held modifier keys, and `state` carries protocol state such as
/// keypad-originated input.
///
/// Code that handles shortcuts should usually check `kind == KeyEventKind::Press` before acting.
/// Unix-style terminal input commonly reports only presses unless a keyboard enhancement protocol
/// requests event types, but the Windows legacy console API reports press and release records for
/// many keys. Ignoring `kind` can make a shortcut run twice on backends that expose releases.
///
/// Some key combinations also cannot be represented by some terminals at all. Crossterm's
/// [missing key combinations] issue is a useful catalogue of those terminal-level limitations;
/// report Termina bugs in Termina, not on that upstream issue.
///
/// # Implementation Notes
///
/// This mirrors the layout used by [crossterm key events].
///
/// [crossterm key events]: https://docs.rs/crossterm/latest/crossterm/event/struct.KeyEvent.html
/// [missing key combinations]: https://github.com/crossterm-rs/crossterm/issues/685
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyEvent {
    /// The key identity.
    pub code: KeyCode,

    /// Whether this event is a press, release, or repeat.
    ///
    /// Check this before triggering a shortcut or command. If the command should run once per
    /// physical key press, require [`KeyEventKind::Press`] and ignore release events.
    pub kind: KeyEventKind,

    /// Modifier keys active for this key event.
    ///
    /// This is the modifier state Termina could infer from the terminal protocol or platform
    /// backend. Plain terminal input does not report every modifier independently; for example,
    /// Shift may be inferred from an uppercase decoded character, while lock-key and keypad state
    /// require an enhanced keyboard protocol or platform backend that reports them.
    pub modifiers: Modifiers,

    /// Extra key state reported by the terminal protocol.
    ///
    /// This is empty unless the input source reports state outside the ordinary modifier mask,
    /// such as keypad-originated input, Caps Lock, or Num Lock.
    pub state: KeyEventState,
}

impl KeyEvent {
    /// Creates a key-press event with the given key code and modifiers.
    pub const fn new(code: KeyCode, modifiers: Modifiers) -> Self {
        Self {
            code,
            modifiers,
            kind: KeyEventKind::Press,
            state: KeyEventState::NONE,
        }
    }
}

impl From<KeyCode> for KeyEvent {
    fn from(code: KeyCode) -> Self {
        Self {
            code,
            kind: KeyEventKind::Press,
            modifiers: Modifiers::NONE,
            state: KeyEventState::NONE,
        }
    }
}

/// Whether a key was pressed, released, or repeated.
///
/// This controls whether a key event should trigger an action. Unix-style terminal input commonly
/// produces [`Self::Press`] only, while Windows legacy console input and enhanced keyboard
/// protocols can also produce [`Self::Release`] and [`Self::Repeat`]. Code that treats every
/// [`Event::Key`] as an action can therefore run twice for one physical key press. Shortcuts and
/// commands should usually act only on [`Self::Press`]. Some key combinations are also limited by
/// what the terminal can encode; Crossterm's [missing key combinations] issue is useful background
/// for those limitations, but Termina bugs should be reported to Termina.
///
/// [missing key combinations]: https://github.com/crossterm-rs/crossterm/issues/685
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyEventKind {
    /// A key was pressed.
    Press,

    /// A key was released.
    ///
    /// Terminals report releases when a keyboard protocol flag such as
    /// [`KittyKeyboardFlags::REPORT_EVENT_TYPES`] requests event types, or when the platform
    /// backend exposes releases directly.
    Release,

    /// A key press was repeated while held.
    Repeat,
}

bitflags::bitflags! {
    /// Modifier keys active during a key or mouse event.
    ///
    /// Terminals vary in which modifiers they report. Treat these flags as the state Termina
    /// observed, not as proof that every unlisted physical modifier was inactive.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Modifiers: u8 {
        /// No modifier keys were active.
        const NONE = 0;

        /// Shift was active.
        const SHIFT = 1;

        /// Alt or Option was active.
        const ALT = 1 << 1;

        /// Control was active.
        const CONTROL = 1 << 2;

        /// Super key.
        ///
        /// This is Command on macOS, the Windows key on Windows, and commonly the Super key on
        /// Linux and other Unix-like systems.
        const SUPER = 1 << 3;
        /// Hyper key.
        ///
        /// Hyper is an additional modifier from older keyboard layouts and terminal protocols. It
        /// is uncommon on modern Mac and Windows keyboards, but some terminals can still report it.
        const HYPER = 1 << 4;

        /// Meta was active.
        const META = 1 << 5;

        /// Caps Lock was active.
        const CAPS_LOCK = 1 << 6;

        /// Num Lock was active.
        const NUM_LOCK = 1 << 7;
    }
}

bitflags::bitflags! {
    /// Extra key state reported by the terminal or platform backend.
    ///
    /// These flags are present only when the input source reports them. Ordinary terminal input
    /// often cannot distinguish keypad-originated keys or lock-key state.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct KeyEventState: u8 {
        /// No extra key state was reported.
        const NONE = 0;

        /// The key came from the keypad.
        const KEYPAD = 1 << 1;

        /// Caps Lock was active for this key event.
        const CAPS_LOCK = 1 << 2;

        /// Num Lock was active for this key event.
        const NUM_LOCK = 1 << 3;
    }
}

/// The key identity reported by the terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyCode {
    /// A Unicode character key after terminal decoding.
    ///
    /// Termina stores the character it can identify from the input source rather than normalizing
    /// every alphabetic key to lowercase plus [`Modifiers::SHIFT`]. For ordinary UTF-8 terminal
    /// input, `A` is reported as `Char('A')` and Shift is also recorded in `modifiers` when Termina
    /// can infer it from the decoded character. Control bytes such as Ctrl+A are reported as
    /// `Char('a')` with [`Modifiers::CONTROL`]. Enhanced keyboard protocols and the Windows
    /// backend may use layout-aware or protocol-supplied characters, so callers should compare
    /// against the character they want to handle instead of assuming another terminal library's
    /// capitalization model.
    Char(char),

    /// The Enter or Return key.
    Enter,

    /// The Backspace key.
    Backspace,

    /// The Tab key.
    Tab,

    /// The Escape key.
    Escape,

    /// The left arrow key.
    Left,

    /// The right arrow key.
    Right,

    /// The up arrow key.
    Up,

    /// The down arrow key.
    Down,

    /// The Home key.
    Home,

    /// The End key.
    End,

    /// Shift+Tab or another backwards-tab key sequence.
    BackTab,

    /// The Page Up key.
    PageUp,

    /// The Page Down key.
    PageDown,

    /// The Insert key.
    Insert,

    /// The Delete key.
    Delete,

    /// The keypad begin key.
    KeypadBegin,

    /// The Caps Lock key.
    CapsLock,

    /// The Scroll Lock key.
    ScrollLock,

    /// The Num Lock key.
    NumLock,

    /// The Print Screen key.
    PrintScreen,

    /// The Pause or Break key.
    Pause,

    /// The Menu or Application key.
    Menu,

    /// A null key code.
    ///
    /// This can appear when a platform backend reports a key event without a printable or named
    /// key identity.
    Null,

    /// F1-F35 function keys.
    Function(u8),

    /// A modifier key such as Shift, Control, Alt, Super, Hyper, or Meta.
    Modifier(ModifierKeyCode),

    /// A media control key.
    Media(MediaKeyCode),
}

/// Physical modifier keys reported as key events.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModifierKeyCode {
    /// Left Shift key.
    LeftShift,
    /// Left Control key. (Control on macOS, Ctrl on other platforms)
    LeftControl,
    /// Left Alt key. (Option on macOS, Alt on other platforms)
    LeftAlt,
    /// Left Super key. (Command on macOS, Windows key on Windows, Super on Linux)
    LeftSuper,
    /// Left Hyper key. (An extended modifier used by some keyboards and terminal protocols)
    LeftHyper,
    /// Left Meta key.
    LeftMeta,
    /// Right Shift key.
    RightShift,
    /// Right Control key. (Control on macOS, Ctrl on other platforms)
    RightControl,
    /// Right Alt key. (Option on macOS, Alt on other platforms)
    RightAlt,
    /// Right Super key. (Command on macOS, Windows key on Windows, Super on Linux)
    RightSuper,
    /// Right Hyper key. (An extended modifier used by some keyboards and terminal protocols)
    RightHyper,
    /// Right Meta key.
    RightMeta,
    /// Iso Level3 Shift key.
    IsoLevel3Shift,
    /// Iso Level5 Shift key.
    IsoLevel5Shift,
}

/// Media keys reported as key events.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKeyCode {
    /// Play media key.
    Play,
    /// Pause media key.
    Pause,
    /// Play/Pause media key.
    PlayPause,
    /// Reverse media key.
    Reverse,
    /// Stop media key.
    Stop,
    /// Fast-forward media key.
    FastForward,
    /// Rewind media key.
    Rewind,
    /// Next-track media key.
    TrackNext,
    /// Previous-track media key.
    TrackPrevious,
    /// Record media key.
    Record,
    /// Lower-volume media key.
    LowerVolume,
    /// Raise-volume media key.
    RaiseVolume,
    /// Mute media key.
    MuteVolume,
}

/// Mouse input event with zero-based terminal cell coordinates.
///
/// Legacy terminal mouse protocols encode cell positions as one-based coordinates, but Termina
/// converts them to zero-based `column` and `row` values. SGR reports instead preserve their raw
/// coordinates in [`SgrMouseEvent`], because the application owns the negotiated coordinate mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MouseEvent {
    /// The mouse action.
    pub kind: MouseEventKind,

    /// The zero-based terminal column where the event occurred.
    pub column: u16,

    /// The zero-based terminal row where the event occurred.
    pub row: u16,

    /// The key modifiers active when the event occurred.
    pub modifiers: Modifiers,
}

/// An SGR mouse report with signed, unmodified wire coordinates.
///
/// Mode 1006 uses one-based cells. Mode 1016 uses pixels; Kitty and Ghostty send zero-based pixels,
/// including negative values for positions outside the viewport. This parser does not track the
/// mode or convert coordinates. Applications interpret them using the mode they enabled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SgrMouseEvent {
    /// The decoded mouse action.
    pub kind: MouseEventKind,
    /// The original horizontal coordinate.
    pub x: i32,
    /// The original vertical coordinate.
    pub y: i32,
    /// The key modifiers active when the event occurred.
    pub modifiers: Modifiers,
}

/// The mouse action reported by the terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseEventKind {
    /// A mouse button was pressed.
    Down(MouseButton),

    /// A mouse button was released.
    Up(MouseButton),

    /// The pointer moved while a mouse button was pressed.
    Drag(MouseButton),

    /// The pointer moved without a pressed mouse button.
    Moved,

    /// The wheel scrolled down, usually toward the user.
    ScrollDown,

    /// The wheel scrolled up, usually away from the user.
    ScrollUp,

    /// The wheel or touchpad scrolled left.
    ScrollLeft,

    /// The wheel or touchpad scrolled right.
    ScrollRight,
}

/// Mouse buttons reported by terminal mouse tracking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    /// Left mouse button.
    Left,
    /// Right mouse button.
    Right,
    /// Middle mouse button.
    Middle,
}
