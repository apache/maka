//! Streaming parser for terminal input bytes.
//!
//! [`Parser`] turns bytes from a terminal or PTY into [`Event`] values. It accepts partial input:
//! callers append bytes with [`Parser::parse`], then drain completed events with [`Parser::pop`].
//! This is the same parser used behind [`EventReader`], exposed for code that owns its input source
//! directly.
//!
//! # Implementation Notes
//!
//! The parser is adapted from [crossterm's Unix event parser], with additions for Termina-specific
//! escape sequences and Windows input modes. Crossterm comments call this style of parser a bit
//! scary and probably in need of a refactor. I like the approach though, because it is quite easy
//! to read and test. The main uncertainty is performance: `process_bytes` considers the bytes as an
//! increasing slice of the buffer until that slice becomes valid or invalid. WezTerm and Alacritty
//! use more formal parsers, [`vtparse`] and [`vte`] respectively, but those terminal-emulator
//! parsers may be larger or more complex than an application needs.
//!
//! [crossterm's Unix event parser]: https://docs.rs/crossterm/latest/crossterm/event/index.html
//! [`vtparse`]: https://docs.rs/vtparse/latest/vtparse/
//! [`vte`]: https://docs.rs/vte/latest/vte/

#[cfg(windows)]
pub mod windows;

#[cfg(all(windows, feature = "windows-legacy"))]
use windows::legacy;
#[cfg(windows)]
use windows::InputReaderMode;

use std::{
    collections::VecDeque,
    io,
    num::NonZeroU16,
    str,
    time::{Duration, Instant},
};

// These are input resource limits, not limits imposed by the terminal protocols.
// Numeric CSI key prefixes are deliberately excluded: they are ambiguous until
// the final byte and have no finite wire-length limit in the existing grammar.
const MAX_TERMINAL_REPLY_BYTES: usize = 256;
const TERMINAL_REPLY_INPUT_TIMEOUT: Duration = Duration::from_millis(100);

#[cfg(doc)]
use crate::EventReader;

use crate::{
    escape::{
        self,
        csi::{self, Csi, KittyKeyboardFlags, ThemeMode},
        dcs, osc,
    },
    event::{
        KeyCode, KeyEvent, KeyEventKind, KeyEventState, KittyGraphicsResponse, MediaKeyCode,
        ModifierKeyCode, Modifiers, MouseButton, MouseEvent, MouseEventKind, SgrMouseEvent,
    },
    style, Event,
};

/// An incremental parser for terminal input.
///
/// The parser keeps incomplete escape sequences in an internal buffer. Pass `maybe_more = true`
/// when the current byte slice may end in the middle of a sequence. Completed events are queued
/// until [`Self::pop`] removes them.
///
/// # Examples
///
/// ```
/// use termina::{Event, Parser};
///
/// let mut parser = Parser::default();
/// parser.parse(b"\x1b[5~", false).unwrap();
/// assert!(matches!(parser.pop(), Some(Event::Key(_))));
/// ```
#[derive(Debug)]
pub struct Parser {
    buffer: Vec<u8>,
    reply_deadline: Option<Instant>,
    max_pending_bytes: usize,
    failure: Option<(io::ErrorKind, &'static str)>,
    /// Events which have been parsed. Pop out with [`Self::pop`].
    events: VecDeque<Event>,
    #[cfg(windows)]
    mode: InputReaderMode,
    #[cfg(all(windows, feature = "windows-legacy"))]
    surrogate_buffer: Option<u16>,
    #[cfg(all(windows, feature = "windows-legacy"))]
    mouse_buttons_pressed: legacy::MouseButtonsPressed,
}

impl Default for Parser {
    fn default() -> Self {
        Self {
            buffer: Vec::with_capacity(256),
            reply_deadline: None,
            max_pending_bytes: usize::MAX,
            failure: None,
            events: VecDeque::with_capacity(32),
            #[cfg(windows)]
            mode: InputReaderMode::Vte,
            #[cfg(all(windows, feature = "windows-legacy"))]
            surrogate_buffer: None,
            #[cfg(all(windows, feature = "windows-legacy"))]
            mouse_buttons_pressed: legacy::MouseButtonsPressed::default(),
        }
    }
}

impl Parser {
    // The parser is publicly accessible, but we don't currently expose methods for parsing input records, just VTE.
    // So there's no need to make this public.
    #[cfg(windows)]
    pub(crate) fn with_mode(mode: InputReaderMode) -> Self {
        Self {
            mode,
            ..Default::default()
        }
    }

    /// Removes and returns the oldest completed event.
    pub fn pop(&mut self) -> Option<Event> {
        self.events.pop_front()
    }

    pub(crate) fn is_ready(&self) -> bool {
        !self.events.is_empty() || self.failure.is_some()
    }

    /// Adds bytes to the parser and queues any completed events.
    ///
    /// Set `maybe_more` to `true` when the input source may provide more bytes for the same
    /// escape sequence later. Set it to `false` when the buffer should be treated as complete for
    /// now; malformed or incomplete sequences can then be discarded instead of held indefinitely.
    ///
    /// Incomplete `CSI ?`, APC, iTerm2 capability, and XTVERSION replies are limited to 256 bytes
    /// and 100 milliseconds.
    /// Exceeding either limit returns an input error and leaves the parser failed; stop reading
    /// this input source rather than interpreting the remaining reply bytes as key presses.
    /// Numeric CSI prefixes retain their existing key/paste behavior and are not timed out.
    pub fn parse(&mut self, bytes: &[u8], maybe_more: bool) -> io::Result<()> {
        self.parse_at(bytes, maybe_more, Instant::now())
    }

    fn parse_at(&mut self, bytes: &[u8], maybe_more: bool, now: Instant) -> io::Result<()> {
        self.expire_reply_at(now)?;
        if bytes.is_empty() {
            return self.process_bytes_at(maybe_more, now);
        }
        for (idx, b) in bytes.iter().enumerate() {
            self.push_byte_at(*b, maybe_more || idx + 1 < bytes.len(), now)?;
        }
        Ok(())
    }

    fn push_byte_at(&mut self, byte: u8, maybe_more: bool, now: Instant) -> io::Result<()> {
        self.expire_reply_at(now)?;
        if self.buffer.len() >= self.max_pending_bytes {
            return self.fail(
                io::ErrorKind::InvalidData,
                "pending input exceeded its byte limit",
            );
        }
        if self.reply_deadline.is_some() && self.buffer.len() >= MAX_TERMINAL_REPLY_BYTES {
            return self.fail(
                io::ErrorKind::InvalidData,
                "terminal reply exceeded its input byte limit",
            );
        }
        self.buffer.push(byte);
        self.process_bytes_at(maybe_more, now)
    }

    #[cfg(windows)]
    fn push_byte(&mut self, byte: u8, maybe_more: bool) -> io::Result<()> {
        self.push_byte_at(byte, maybe_more, Instant::now())
    }

    #[cfg(windows)]
    fn process_bytes(&mut self, maybe_more: bool) -> io::Result<()> {
        self.process_bytes_at(maybe_more, Instant::now())
    }

    fn process_bytes_at(&mut self, maybe_more: bool, now: Instant) -> io::Result<()> {
        if self.buffer.starts_with(b"\x1b[?")
            || self.buffer.starts_with(b"\x1b_")
            || self.buffer.starts_with(b"\x1b]1337;Capabilities=")
            || self.buffer.starts_with(b"\x1bP>|")
        {
            self.reply_deadline
                .get_or_insert(now + TERMINAL_REPLY_INPUT_TIMEOUT);
        }
        self.expire_reply_at(now)?;
        match parse_event(&self.buffer, maybe_more) {
            Ok(Some(event)) => {
                self.events.push_back(event);
                self.buffer.clear();
                self.reply_deadline = None;
            }
            Ok(None) => {}
            Err(_) => {
                self.buffer.clear();
                self.reply_deadline = None;
            }
        }
        Ok(())
    }

    pub(crate) fn set_max_pending_bytes(&mut self, limit: usize) -> io::Result<()> {
        if limit == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "pending input byte limit must be nonzero",
            ));
        }
        self.max_pending_bytes = limit;
        self.expire_reply_at(Instant::now())
    }

    pub(crate) fn expire_reply_at(&mut self, now: Instant) -> io::Result<()> {
        if let Some((kind, message)) = self.failure {
            return Err(io::Error::new(kind, message));
        }
        if self.buffer.len() > self.max_pending_bytes {
            return self.fail(
                io::ErrorKind::InvalidData,
                "pending input exceeded its byte limit",
            );
        }
        if let Some(deadline) = self.reply_deadline {
            if self.buffer.len() > MAX_TERMINAL_REPLY_BYTES {
                return self.fail(
                    io::ErrorKind::InvalidData,
                    "terminal reply exceeded its input byte limit",
                );
            }
            if now >= deadline {
                return self.fail(
                    io::ErrorKind::TimedOut,
                    "incomplete terminal reply exceeded its input deadline",
                );
            }
        }
        Ok(())
    }

    fn fail(&mut self, kind: io::ErrorKind, message: &'static str) -> io::Result<()> {
        self.failure = Some((kind, message));
        Err(io::Error::new(kind, message))
    }

    pub(crate) fn reply_poll_timeout(&self, timeout: Option<Duration>) -> Option<Duration> {
        self.reply_deadline.map_or(timeout, |deadline| {
            let remaining = deadline.saturating_duration_since(Instant::now());
            Some(timeout.map_or(remaining, |timeout| timeout.min(remaining)))
        })
    }
}

#[derive(Debug)]
struct MalformedSequenceError;

// This is a bit hacky but cuts down on boilerplate conversions
impl From<str::Utf8Error> for MalformedSequenceError {
    fn from(_: str::Utf8Error) -> Self {
        Self
    }
}

type Result<T> = std::result::Result<T, MalformedSequenceError>;

macro_rules! bail {
    () => {
        return Err(MalformedSequenceError)
    };
}

fn parse_event(buffer: &[u8], maybe_more: bool) -> Result<Option<Event>> {
    if buffer.is_empty() {
        return Ok(None);
    }

    match buffer[0] {
        b'\x1B' => {
            if buffer.len() == 1 {
                if maybe_more {
                    // Possible Esc sequence
                    Ok(None)
                } else {
                    Ok(Some(Event::Key(KeyCode::Escape.into())))
                }
            } else {
                match buffer[1] {
                    b'O' => {
                        if buffer.len() == 2 {
                            Ok(None)
                        } else {
                            match buffer[2] {
                                b'D' => Ok(Some(Event::Key(KeyCode::Left.into()))),
                                b'C' => Ok(Some(Event::Key(KeyCode::Right.into()))),
                                b'A' => Ok(Some(Event::Key(KeyCode::Up.into()))),
                                b'B' => Ok(Some(Event::Key(KeyCode::Down.into()))),
                                b'H' => Ok(Some(Event::Key(KeyCode::Home.into()))),
                                b'F' => Ok(Some(Event::Key(KeyCode::End.into()))),
                                // F1-F4
                                val @ b'P'..=b'S' => {
                                    Ok(Some(Event::Key(KeyCode::Function(1 + val - b'P').into())))
                                }
                                _ => bail!(),
                            }
                        }
                    }
                    b'[' => parse_csi(buffer),
                    b']' => parse_osc(buffer),
                    b'P' => parse_dcs(buffer),
                    b'_' => parse_kitty_graphics_response(buffer),
                    b'\x1B' => Ok(Some(Event::Key(KeyCode::Escape.into()))),
                    _ => parse_event(&buffer[1..], maybe_more).map(|event_option| {
                        event_option.map(|event| {
                            if let Event::Key(key_event) = event {
                                let mut alt_key_event = key_event;
                                alt_key_event.modifiers |= Modifiers::ALT;
                                Event::Key(alt_key_event)
                            } else {
                                event
                            }
                        })
                    }),
                }
            }
        }
        b'\r' => Ok(Some(Event::Key(KeyCode::Enter.into()))),
        b'\t' => Ok(Some(Event::Key(KeyCode::Tab.into()))),
        b'\x7F' => Ok(Some(Event::Key(KeyCode::Backspace.into()))),
        b'\0' => Ok(Some(Event::Key(KeyEvent::new(
            KeyCode::Char(' '),
            Modifiers::CONTROL,
        )))),
        c @ b'\x01'..=b'\x1A' => Ok(Some(Event::Key(KeyEvent::new(
            KeyCode::Char((c - 0x1 + b'a') as char),
            Modifiers::CONTROL,
        )))),
        c @ b'\x1C'..=b'\x1F' => Ok(Some(Event::Key(KeyEvent::new(
            KeyCode::Char((c - 0x1C + b'4') as char),
            Modifiers::CONTROL,
        )))),
        _ => parse_utf8_char(buffer).map(|maybe_char| {
            maybe_char.map(|ch| {
                let modifiers = if ch.is_uppercase() {
                    Modifiers::SHIFT
                } else {
                    Modifiers::NONE
                };
                Event::Key(KeyEvent::new(KeyCode::Char(ch), modifiers))
            })
        }),
    }
}

fn parse_kitty_graphics_response(buffer: &[u8]) -> Result<Option<Event>> {
    // Keep the whole APC until ST, including malformed or unknown strings. Rejecting an early
    // byte would let the rest of a terminal response escape into ordinary keyboard input.
    if !buffer.ends_with(b"\x1b\\") {
        return Ok(None);
    }
    let body = buffer
        .strip_prefix(b"\x1b_G")
        .and_then(|body| body.strip_suffix(b"\x1b\\"))
        .ok_or(MalformedSequenceError)?;
    let (control, message) = str::from_utf8(body)?
        .split_once(';')
        .ok_or(MalformedSequenceError)?;
    if message.is_empty()
        || !message
            .bytes()
            .all(|byte| byte.is_ascii_graphic() || byte == b' ')
    {
        bail!();
    }
    let (mut image_id, mut image_number, mut placement_id) = (None, None, None);
    for field in control.split(',') {
        let (key, value) = field.split_once('=').ok_or(MalformedSequenceError)?;
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            bail!();
        }
        let value = value.parse::<u32>().map_err(|_| MalformedSequenceError)?;
        let target = match key {
            "i" => &mut image_id,
            "I" => &mut image_number,
            "p" => &mut placement_id,
            _ => bail!(),
        };
        if target.replace(value).is_some() {
            bail!();
        }
    }
    Ok(Some(Event::KittyGraphicsResponse(KittyGraphicsResponse {
        image_id: image_id.ok_or(MalformedSequenceError)?,
        image_number,
        placement_id,
        result: if message == "OK" {
            Ok(())
        } else {
            Err(message.to_owned())
        },
    })))
}

fn parse_utf8_char(buffer: &[u8]) -> Result<Option<char>> {
    assert!(!buffer.is_empty());
    match str::from_utf8(buffer) {
        Ok(s) => Ok(Some(s.chars().next().unwrap())),
        Err(_) => {
            // `from_utf8` failed but it could be because we don't have enough bytes to make a
            // valid UTF-8 codepoint. Check the validity of the bytes so far:
            let required_bytes = match buffer[0] {
                // https://en.wikipedia.org/wiki/UTF-8#Description
                (0x00..=0x7F) => 1, // 0xxxxxxx
                (0xC0..=0xDF) => 2, // 110xxxxx 10xxxxxx
                (0xE0..=0xEF) => 3, // 1110xxxx 10xxxxxx 10xxxxxx
                (0xF0..=0xF7) => 4, // 11110xxx 10xxxxxx 10xxxxxx 10xxxxxx
                (0x80..=0xBF) | (0xF8..=0xFF) => bail!(),
            };
            if required_bytes > 1 && buffer.len() > 1 {
                for byte in &buffer[1..] {
                    if byte & !0b0011_1111 != 0b1000_0000 {
                        bail!()
                    }
                }
            }
            if buffer.len() < required_bytes {
                Ok(None)
            } else {
                bail!()
            }
        }
    }
}

fn parse_csi(buffer: &[u8]) -> Result<Option<Event>> {
    assert!(buffer.starts_with(b"\x1B["));
    if buffer.len() == 2 {
        return Ok(None);
    }
    let maybe_event = match buffer[2] {
        b'[' => match buffer.get(3) {
            None => None,
            Some(b @ b'A'..=b'E') => Some(Event::Key(KeyCode::Function(1 + b - b'A').into())),
            Some(_) => bail!(),
        },
        b'D' => Some(Event::Key(KeyCode::Left.into())),
        b'C' => Some(Event::Key(KeyCode::Right.into())),
        b'A' => Some(Event::Key(KeyCode::Up.into())),
        b'B' => Some(Event::Key(KeyCode::Down.into())),
        b'H' => Some(Event::Key(KeyCode::Home.into())),
        b'F' => Some(Event::Key(KeyCode::End.into())),
        b'Z' => Some(Event::Key(KeyEvent {
            code: KeyCode::BackTab,
            modifiers: Modifiers::SHIFT,
            kind: KeyEventKind::Press,
            state: KeyEventState::NONE,
        })),
        b'M' => return parse_csi_normal_mouse(buffer),
        b'<' => return parse_csi_sgr_mouse(buffer),
        b'I' => Some(Event::FocusIn),
        b'O' => Some(Event::FocusOut),
        b';' => return parse_csi_modifier_key_code(buffer),
        // P, Q, and S for compatibility with Kitty keyboard protocol,
        // as the 1 in 'CSI 1 P' etc. must be omitted if there are no
        // modifiers pressed:
        // https://sw.kovidgoyal.net/kitty/keyboard-protocol/#legacy-functional-keys
        b'P' => Some(Event::Key(KeyCode::Function(1).into())),
        b'Q' => Some(Event::Key(KeyCode::Function(2).into())),
        b'S' => Some(Event::Key(KeyCode::Function(4).into())),
        b'?' => match buffer[buffer.len() - 1] {
            b'S' => return parse_csi_graphics_attributes(buffer),
            b'u' => return parse_csi_keyboard_enhancement_flags(buffer),
            b'c' => return parse_csi_primary_device_attributes(buffer),
            b'n' => return parse_csi_theme_mode(buffer),
            b'y' => return parse_csi_mode(buffer),
            _ => None,
        },
        b'>' => match buffer[buffer.len() - 2..buffer.len()] {
            [b' ', b'q'] => return parse_csi_cursor_shape_query_response(buffer),
            _ => None,
        },
        b'0'..=b'9' => {
            // Numbered escape code.
            if buffer.len() == 3 {
                None
            } else {
                // The final byte of a CSI sequence can be in the range 64-126, so
                // let's keep reading anything else.
                let last_byte = buffer[buffer.len() - 1];
                if !(64..=126).contains(&last_byte) {
                    None
                } else {
                    if buffer.starts_with(b"\x1B[200~") {
                        return parse_csi_bracketed_paste(buffer);
                    }
                    match last_byte {
                        b'M' => return parse_csi_rxvt_mouse(buffer),
                        b'~' => return parse_csi_special_key_code(buffer),
                        b'u' => return parse_csi_u_encoded_key_code(buffer),
                        b'R' => return parse_csi_cursor_position(buffer),
                        b't' => return parse_csi_pixel_size(buffer),
                        _ => return parse_csi_modifier_key_code(buffer),
                    }
                }
            }
        }
        _ => bail!(),
    };
    Ok(maybe_event)
}

fn parse_osc(buffer: &[u8]) -> Result<Option<Event>> {
    assert!(buffer.starts_with(b"\x1B]"));
    // > In addition to the ECMA-48 string terminator (ST), xterm(1) accepts a BEL to
    // > terminate an OSC string.
    // https://www.man7.org/linux/man-pages/man4/console_codes.4.html
    let Some(buffer) = buffer
        .strip_suffix(escape::ST.as_bytes())
        .or_else(|| buffer.strip_suffix(escape::BEL.as_bytes()))
    else {
        return Ok(None);
    };
    let s = str::from_utf8(&buffer[2..buffer.len()])?;
    if let Some(features) = s.strip_prefix("1337;Capabilities=") {
        if !features
            .bytes()
            .all(|byte| byte.is_ascii_graphic() || byte == b' ')
        {
            bail!();
        }
        return Ok(Some(Event::Iterm2Capabilities(features.to_owned())));
    }
    if let Some(payload) = s.strip_prefix("777;nsh-text-input;") {
        return parse_nsh_text_input(payload)
            .map(|input| Some(Event::Osc(osc::Osc::NshTextInput(input))));
    }
    let mut split = s.split(';');
    let index = next_parsed::<u8>(&mut split)?;
    let Some(color_number) = osc::DynamicColorNumber::from_index(index) else {
        bail!()
    };
    let Some(color_or_query) = split.next() else {
        bail!()
    };
    let response = match color_or_query {
        "?" => osc::ColorOrQuery::Query,
        _ => osc::ColorOrQuery::Color(color_or_query.parse().map_err(|_| MalformedSequenceError)?),
    };
    // This parsing could be expanded, see <https://terminalguide.namepad.de/seq/osc-4/>.
    Ok(Some(Event::Osc(osc::Osc::ChangeDynamicColors(
        color_number,
        vec![response],
    ))))
}

fn parse_nsh_text_input(payload: &str) -> Result<osc::NshTextInput> {
    fn unsigned<T: str::FromStr>(field: Option<&str>) -> Result<T> {
        let field = field.ok_or(MalformedSequenceError)?;
        if field.is_empty() || !field.bytes().all(|byte| byte.is_ascii_digit()) {
            bail!();
        }
        field.parse().map_err(|_| MalformedSequenceError)
    }
    fn text(field: Option<&str>) -> Result<String> {
        let bytes = crate::base64::decode(field.ok_or(MalformedSequenceError)?)
            .ok_or(MalformedSequenceError)?;
        String::from_utf8(bytes).map_err(|_| MalformedSequenceError)
    }

    let mut fields = payload.split(';');
    let input = match fields.next() {
        Some("query") => osc::NshTextInput::Query,
        Some("supported") => osc::NshTextInput::Supported,
        Some("focus") => osc::NshTextInput::Focus(unsigned(fields.next())?),
        Some("focused") => osc::NshTextInput::Focused(unsigned(fields.next())?),
        Some("update") => {
            let context = std::num::NonZeroU64::new(unsigned(fields.next())?)
                .ok_or(MalformedSequenceError)?;
            let active = match fields.next() {
                Some("0") => false,
                Some("1") => true,
                _ => bail!(),
            };
            let selection = unsigned(fields.next())?..unsigned(fields.next())?;
            let commit = text(fields.next())?;
            let preedit = text(fields.next())?;
            if !osc::valid_text_input_update(active, &selection, &preedit) {
                bail!();
            }
            osc::NshTextInput::Update {
                context,
                active,
                selection,
                commit,
                preedit,
            }
        }
        _ => bail!(),
    };
    if fields.next().is_some() {
        bail!();
    }
    Ok(input)
}

fn next_parsed<T>(iter: &mut dyn Iterator<Item = &str>) -> Result<T>
where
    T: str::FromStr,
{
    iter.next()
        .ok_or(MalformedSequenceError)?
        .parse::<T>()
        .map_err(|_| MalformedSequenceError)
}

fn modifier_and_kind_parsed(iter: &mut dyn Iterator<Item = &str>) -> Result<(u8, u8)> {
    let mut sub_split = iter.next().ok_or(MalformedSequenceError)?.split(':');

    let modifier_mask = next_parsed::<u8>(&mut sub_split)?;

    if let Ok(kind_code) = next_parsed::<u8>(&mut sub_split) {
        Ok((modifier_mask, kind_code))
    } else {
        Ok((modifier_mask, 1))
    }
}

fn parse_csi_u_encoded_key_code(buffer: &[u8]) -> Result<Option<Event>> {
    assert!(buffer.starts_with(b"\x1B")); // CSI
    assert!(buffer.ends_with(b"u"));

    // This function parses `CSI … u` sequences. These are sequences defined in either
    // the `CSI u` (a.k.a. "Fix Keyboard Input on Terminals - Please", https://www.leonerd.org.uk/hacks/fixterms/)
    // or Kitty Keyboard Protocol (https://sw.kovidgoyal.net/kitty/keyboard-protocol/) specifications.
    // This CSI sequence is a tuple of semicolon-separated numbers.
    let s = str::from_utf8(&buffer[2..buffer.len() - 1])?;
    let mut split = s.split(';');

    // In `CSI u`, this is parsed as:
    //
    //     CSI codepoint ; modifiers u
    //     codepoint: ASCII Dec value
    //
    // The Kitty Keyboard Protocol extends this with optional components that can be
    // enabled progressively. The full sequence is parsed as:
    //
    //     CSI unicode-key-code:alternate-key-codes ; modifiers:event-type ; text-as-codepoints u
    let mut codepoints = split.next().ok_or(MalformedSequenceError)?.split(':');

    let codepoint = codepoints
        .next()
        .ok_or(MalformedSequenceError)?
        .parse::<u32>()
        .map_err(|_| MalformedSequenceError)?;

    let (mut modifiers, kind, state_from_modifiers) =
        if let Ok((modifier_mask, kind_code)) = modifier_and_kind_parsed(&mut split) {
            (
                parse_modifiers(modifier_mask),
                parse_key_event_kind(kind_code),
                parse_modifiers_to_state(modifier_mask),
            )
        } else {
            (Modifiers::NONE, KeyEventKind::Press, KeyEventState::NONE)
        };

    let (mut code, state_from_keycode) = {
        if let Some((special_key_code, state)) = translate_functional_key_code(codepoint) {
            (special_key_code, state)
        } else if let Some(c) = char::from_u32(codepoint) {
            (
                match c {
                    '\x1B' => KeyCode::Escape,
                    '\r' => KeyCode::Enter,
                    /*
                    // Issue #371: \n = 0xA, which is also the keycode for Ctrl+J. The only reason we get
                    // newlines as input is because the terminal converts \r into \n for us. When we
                    // enter raw mode, we disable that, so \n no longer has any meaning - it's better to
                    // use Ctrl+J. Waiting to handle it here means it gets picked up later
                    '\n' if !crate::terminal::sys::is_raw_mode_enabled() => KeyCode::Enter,
                    */
                    '\t' => {
                        if modifiers.contains(Modifiers::SHIFT) {
                            KeyCode::BackTab
                        } else {
                            KeyCode::Tab
                        }
                    }
                    '\x7F' => KeyCode::Backspace,
                    _ => KeyCode::Char(c),
                },
                KeyEventState::empty(),
            )
        } else {
            bail!();
        }
    };

    if let KeyCode::Modifier(modifier_keycode) = code {
        match modifier_keycode {
            ModifierKeyCode::LeftAlt | ModifierKeyCode::RightAlt => {
                modifiers.set(Modifiers::ALT, true)
            }
            ModifierKeyCode::LeftControl | ModifierKeyCode::RightControl => {
                modifiers.set(Modifiers::CONTROL, true)
            }
            ModifierKeyCode::LeftShift | ModifierKeyCode::RightShift => {
                modifiers.set(Modifiers::SHIFT, true)
            }
            ModifierKeyCode::LeftSuper | ModifierKeyCode::RightSuper => {
                modifiers.set(Modifiers::SUPER, true)
            }
            ModifierKeyCode::LeftHyper | ModifierKeyCode::RightHyper => {
                modifiers.set(Modifiers::HYPER, true)
            }
            ModifierKeyCode::LeftMeta | ModifierKeyCode::RightMeta => {
                modifiers.set(Modifiers::META, true)
            }
            _ => {}
        }
    }

    // When the "report alternate keys" flag is enabled in the Kitty Keyboard Protocol
    // and the terminal sends a keyboard event containing shift, the sequence will
    // contain an additional codepoint separated by a ':' character which contains
    // the shifted character according to the keyboard layout.
    if modifiers.contains(Modifiers::SHIFT) {
        if let Some(shifted_c) = codepoints
            .next()
            .and_then(|codepoint| codepoint.parse::<u32>().ok())
            .and_then(char::from_u32)
        {
            code = KeyCode::Char(shifted_c);
            modifiers.set(Modifiers::SHIFT, false);
        }
    }

    let event = Event::Key(KeyEvent {
        code,
        modifiers,
        kind,
        state: state_from_keycode | state_from_modifiers,
    });

    Ok(Some(event))
}

fn parse_modifiers(mask: u8) -> Modifiers {
    let modifier_mask = mask.saturating_sub(1);
    let mut modifiers = Modifiers::empty();
    if modifier_mask & 1 != 0 {
        modifiers |= Modifiers::SHIFT;
    }
    if modifier_mask & 2 != 0 {
        modifiers |= Modifiers::ALT;
    }
    if modifier_mask & 4 != 0 {
        modifiers |= Modifiers::CONTROL;
    }
    if modifier_mask & 8 != 0 {
        modifiers |= Modifiers::SUPER;
    }
    if modifier_mask & 16 != 0 {
        modifiers |= Modifiers::HYPER;
    }
    if modifier_mask & 32 != 0 {
        modifiers |= Modifiers::META;
    }
    modifiers
}

fn parse_modifiers_to_state(mask: u8) -> KeyEventState {
    let modifier_mask = mask.saturating_sub(1);
    let mut state = KeyEventState::empty();
    if modifier_mask & 64 != 0 {
        state |= KeyEventState::CAPS_LOCK;
    }
    if modifier_mask & 128 != 0 {
        state |= KeyEventState::NUM_LOCK;
    }
    state
}

fn parse_key_event_kind(kind: u8) -> KeyEventKind {
    match kind {
        1 => KeyEventKind::Press,
        2 => KeyEventKind::Repeat,
        3 => KeyEventKind::Release,
        _ => KeyEventKind::Press,
    }
}

fn parse_csi_modifier_key_code(buffer: &[u8]) -> Result<Option<Event>> {
    assert!(buffer.starts_with(b"\x1B[")); // CSI
    let s = str::from_utf8(&buffer[2..buffer.len() - 1])?;
    let mut split = s.split(';');

    split.next();

    let (modifiers, kind) =
        if let Ok((modifier_mask, kind_code)) = modifier_and_kind_parsed(&mut split) {
            (
                parse_modifiers(modifier_mask),
                parse_key_event_kind(kind_code),
            )
        } else if buffer.len() > 3 {
            (
                parse_modifiers(
                    (buffer[buffer.len() - 2] as char)
                        .to_digit(10)
                        .ok_or(MalformedSequenceError)? as u8,
                ),
                KeyEventKind::Press,
            )
        } else {
            (Modifiers::NONE, KeyEventKind::Press)
        };
    let key = buffer[buffer.len() - 1];

    let code = match key {
        b'A' => KeyCode::Up,
        b'B' => KeyCode::Down,
        b'C' => KeyCode::Right,
        b'D' => KeyCode::Left,
        b'F' => KeyCode::End,
        b'H' => KeyCode::Home,
        b'P' => KeyCode::Function(1),
        b'Q' => KeyCode::Function(2),
        b'R' => KeyCode::Function(3),
        b'S' => KeyCode::Function(4),
        _ => bail!(),
    };

    let event = Event::Key(KeyEvent {
        code,
        modifiers,
        kind,
        state: KeyEventState::NONE,
    });

    Ok(Some(event))
}

fn parse_csi_special_key_code(buffer: &[u8]) -> Result<Option<Event>> {
    assert!(buffer.starts_with(b"\x1B[")); // CSI
    assert!(buffer.ends_with(b"~"));

    let s = str::from_utf8(&buffer[2..buffer.len() - 1])?;
    let mut split = s.split(';');

    // This CSI sequence can be a list of semicolon-separated numbers.
    let first = next_parsed::<u8>(&mut split)?;

    let (modifiers, kind, state) =
        if let Ok((modifier_mask, kind_code)) = modifier_and_kind_parsed(&mut split) {
            (
                parse_modifiers(modifier_mask),
                parse_key_event_kind(kind_code),
                parse_modifiers_to_state(modifier_mask),
            )
        } else {
            (Modifiers::NONE, KeyEventKind::Press, KeyEventState::NONE)
        };

    let code = match first {
        1 | 7 => KeyCode::Home,
        2 => KeyCode::Insert,
        3 => KeyCode::Delete,
        4 | 8 => KeyCode::End,
        5 => KeyCode::PageUp,
        6 => KeyCode::PageDown,
        v @ 11..=15 => KeyCode::Function(v - 10),
        v @ 17..=21 => KeyCode::Function(v - 11),
        v @ 23..=26 => KeyCode::Function(v - 12),
        v @ 28..=29 => KeyCode::Function(v - 15),
        v @ 31..=34 => KeyCode::Function(v - 17),
        _ => bail!(),
    };

    let event = Event::Key(KeyEvent {
        code,
        modifiers,
        kind,
        state,
    });

    Ok(Some(event))
}

fn translate_functional_key_code(codepoint: u32) -> Option<(KeyCode, KeyEventState)> {
    if let Some(keycode) = match codepoint {
        57399 => Some(KeyCode::Char('0')),
        57400 => Some(KeyCode::Char('1')),
        57401 => Some(KeyCode::Char('2')),
        57402 => Some(KeyCode::Char('3')),
        57403 => Some(KeyCode::Char('4')),
        57404 => Some(KeyCode::Char('5')),
        57405 => Some(KeyCode::Char('6')),
        57406 => Some(KeyCode::Char('7')),
        57407 => Some(KeyCode::Char('8')),
        57408 => Some(KeyCode::Char('9')),
        57409 => Some(KeyCode::Char('.')),
        57410 => Some(KeyCode::Char('/')),
        57411 => Some(KeyCode::Char('*')),
        57412 => Some(KeyCode::Char('-')),
        57413 => Some(KeyCode::Char('+')),
        57414 => Some(KeyCode::Enter),
        57415 => Some(KeyCode::Char('=')),
        57416 => Some(KeyCode::Char(',')),
        57417 => Some(KeyCode::Left),
        57418 => Some(KeyCode::Right),
        57419 => Some(KeyCode::Up),
        57420 => Some(KeyCode::Down),
        57421 => Some(KeyCode::PageUp),
        57422 => Some(KeyCode::PageDown),
        57423 => Some(KeyCode::Home),
        57424 => Some(KeyCode::End),
        57425 => Some(KeyCode::Insert),
        57426 => Some(KeyCode::Delete),
        57427 => Some(KeyCode::KeypadBegin),
        _ => None,
    } {
        return Some((keycode, KeyEventState::KEYPAD));
    }

    if let Some(keycode) = match codepoint {
        57358 => Some(KeyCode::CapsLock),
        57359 => Some(KeyCode::ScrollLock),
        57360 => Some(KeyCode::NumLock),
        57361 => Some(KeyCode::PrintScreen),
        57362 => Some(KeyCode::Pause),
        57363 => Some(KeyCode::Menu),
        57376 => Some(KeyCode::Function(13)),
        57377 => Some(KeyCode::Function(14)),
        57378 => Some(KeyCode::Function(15)),
        57379 => Some(KeyCode::Function(16)),
        57380 => Some(KeyCode::Function(17)),
        57381 => Some(KeyCode::Function(18)),
        57382 => Some(KeyCode::Function(19)),
        57383 => Some(KeyCode::Function(20)),
        57384 => Some(KeyCode::Function(21)),
        57385 => Some(KeyCode::Function(22)),
        57386 => Some(KeyCode::Function(23)),
        57387 => Some(KeyCode::Function(24)),
        57388 => Some(KeyCode::Function(25)),
        57389 => Some(KeyCode::Function(26)),
        57390 => Some(KeyCode::Function(27)),
        57391 => Some(KeyCode::Function(28)),
        57392 => Some(KeyCode::Function(29)),
        57393 => Some(KeyCode::Function(30)),
        57394 => Some(KeyCode::Function(31)),
        57395 => Some(KeyCode::Function(32)),
        57396 => Some(KeyCode::Function(33)),
        57397 => Some(KeyCode::Function(34)),
        57398 => Some(KeyCode::Function(35)),
        57428 => Some(KeyCode::Media(MediaKeyCode::Play)),
        57429 => Some(KeyCode::Media(MediaKeyCode::Pause)),
        57430 => Some(KeyCode::Media(MediaKeyCode::PlayPause)),
        57431 => Some(KeyCode::Media(MediaKeyCode::Reverse)),
        57432 => Some(KeyCode::Media(MediaKeyCode::Stop)),
        57433 => Some(KeyCode::Media(MediaKeyCode::FastForward)),
        57434 => Some(KeyCode::Media(MediaKeyCode::Rewind)),
        57435 => Some(KeyCode::Media(MediaKeyCode::TrackNext)),
        57436 => Some(KeyCode::Media(MediaKeyCode::TrackPrevious)),
        57437 => Some(KeyCode::Media(MediaKeyCode::Record)),
        57438 => Some(KeyCode::Media(MediaKeyCode::LowerVolume)),
        57439 => Some(KeyCode::Media(MediaKeyCode::RaiseVolume)),
        57440 => Some(KeyCode::Media(MediaKeyCode::MuteVolume)),
        57441 => Some(KeyCode::Modifier(ModifierKeyCode::LeftShift)),
        57442 => Some(KeyCode::Modifier(ModifierKeyCode::LeftControl)),
        57443 => Some(KeyCode::Modifier(ModifierKeyCode::LeftAlt)),
        57444 => Some(KeyCode::Modifier(ModifierKeyCode::LeftSuper)),
        57445 => Some(KeyCode::Modifier(ModifierKeyCode::LeftHyper)),
        57446 => Some(KeyCode::Modifier(ModifierKeyCode::LeftMeta)),
        57447 => Some(KeyCode::Modifier(ModifierKeyCode::RightShift)),
        57448 => Some(KeyCode::Modifier(ModifierKeyCode::RightControl)),
        57449 => Some(KeyCode::Modifier(ModifierKeyCode::RightAlt)),
        57450 => Some(KeyCode::Modifier(ModifierKeyCode::RightSuper)),
        57451 => Some(KeyCode::Modifier(ModifierKeyCode::RightHyper)),
        57452 => Some(KeyCode::Modifier(ModifierKeyCode::RightMeta)),
        57453 => Some(KeyCode::Modifier(ModifierKeyCode::IsoLevel3Shift)),
        57454 => Some(KeyCode::Modifier(ModifierKeyCode::IsoLevel5Shift)),
        _ => None,
    } {
        return Some((keycode, KeyEventState::empty()));
    }

    None
}

fn parse_csi_rxvt_mouse(buffer: &[u8]) -> Result<Option<Event>> {
    // rxvt mouse encoding:
    // CSI Cb ; Cx ; Cy ; M

    assert!(buffer.starts_with(b"\x1B[")); // CSI
    assert!(buffer.ends_with(b"M"));

    let s = str::from_utf8(&buffer[2..buffer.len() - 1])?;
    let mut split = s.split(';');

    let cb = next_parsed::<u8>(&mut split)?
        .checked_sub(32)
        .ok_or(MalformedSequenceError)?;
    let (kind, modifiers) = parse_cb(cb)?;

    let cx = next_parsed::<u16>(&mut split)?.saturating_sub(1);
    let cy = next_parsed::<u16>(&mut split)?.saturating_sub(1);

    Ok(Some(Event::Mouse(MouseEvent {
        kind,
        column: cx,
        row: cy,
        modifiers,
    })))
}

fn parse_csi_normal_mouse(buffer: &[u8]) -> Result<Option<Event>> {
    // Normal mouse encoding: CSI M CB Cx Cy (6 characters only).

    assert!(buffer.starts_with(b"\x1B[M")); // CSI M

    if buffer.len() < 6 {
        return Ok(None);
    }

    let cb = buffer[3].checked_sub(32).ok_or(MalformedSequenceError)?;
    let (kind, modifiers) = parse_cb(cb)?;

    // See http://www.xfree86.org/current/ctlseqs.html#Mouse%20Tracking
    // Mouse positions are encoded as (value + 32), but the upper left
    // character position on the terminal is denoted as 1,1.
    // So, we need to subtract 32 + 1 (33) to keep it synced with the cursor.
    let cx = u16::from(buffer[4].saturating_sub(33));
    let cy = u16::from(buffer[5].saturating_sub(33));

    Ok(Some(Event::Mouse(MouseEvent {
        kind,
        column: cx,
        row: cy,
        modifiers,
    })))
}

fn parse_csi_sgr_mouse(buffer: &[u8]) -> Result<Option<Event>> {
    // CSI < Cb ; Cx ; Cy (M or m)

    assert!(buffer.starts_with(b"\x1B[<")); // CSI <

    if !buffer.ends_with(b"m") && !buffer.ends_with(b"M") {
        return Ok(None);
    }

    let s = str::from_utf8(&buffer[3..buffer.len() - 1])?;
    let mut split = s.split(';');

    let cb = split.next().ok_or(MalformedSequenceError)?;
    if cb.is_empty() || !cb.bytes().all(|byte| byte.is_ascii_digit()) {
        bail!();
    }
    let cb = cb.parse::<u32>().map_err(|_| MalformedSequenceError)?;
    let x = parse_sgr_coordinate(split.next().ok_or(MalformedSequenceError)?)?;
    let y = parse_sgr_coordinate(split.next().ok_or(MalformedSequenceError)?)?;
    if split.next().is_some() {
        bail!();
    }
    // Kitty's leave extension ignores every other bit and both coordinates. Recognize it before
    // interpreting button/modifier bits, without inventing a location or a button release.
    if cb & (1 << 8) != 0 {
        return Ok(Some(Event::MouseLeave));
    }
    let (kind, modifiers) = parse_cb(u8::try_from(cb).map_err(|_| MalformedSequenceError)?)?;

    // When button 3 in Cb is used to represent mouse release, you can't tell which button was
    // released. SGR mode solves this by having the sequence end with a lowercase m if it's a
    // button release and an uppercase M if it's a button press.
    //
    // We've already checked that the last character is a lowercase or uppercase M at the start of
    // this function, so we just need one if.
    let kind = if buffer.last() == Some(&b'm') {
        match kind {
            MouseEventKind::Down(button) => MouseEventKind::Up(button),
            other => other,
        }
    } else {
        kind
    };

    Ok(Some(Event::SgrMouse(SgrMouseEvent {
        kind,
        x,
        y,
        modifiers,
    })))
}

fn parse_sgr_coordinate(parameter: &str) -> Result<i32> {
    let digits = parameter.strip_prefix('-').unwrap_or(parameter);
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        bail!();
    }
    parameter.parse().map_err(|_| MalformedSequenceError)
}

/// Cb is the byte of a mouse input that contains the button being used, the key modifiers being
/// held and whether the mouse is dragging or not.
///
/// Bit layout of cb, from low to high:
///
/// - button number
/// - button number
/// - shift
/// - meta (alt)
/// - control
/// - mouse is dragging
/// - button number
/// - button number
fn parse_cb(cb: u8) -> Result<(MouseEventKind, Modifiers)> {
    let button_number = (cb & 0b0000_0011) | ((cb & 0b1100_0000) >> 4);
    let dragging = cb & 0b0010_0000 == 0b0010_0000;

    let kind = match (button_number, dragging) {
        (0, false) => MouseEventKind::Down(MouseButton::Left),
        (1, false) => MouseEventKind::Down(MouseButton::Middle),
        (2, false) => MouseEventKind::Down(MouseButton::Right),
        (0, true) => MouseEventKind::Drag(MouseButton::Left),
        (1, true) => MouseEventKind::Drag(MouseButton::Middle),
        (2, true) => MouseEventKind::Drag(MouseButton::Right),
        (3, false) => MouseEventKind::Up(MouseButton::Left),
        (3, true) | (4, true) | (5, true) => MouseEventKind::Moved,
        (4, false) => MouseEventKind::ScrollUp,
        (5, false) => MouseEventKind::ScrollDown,
        (6, false) => MouseEventKind::ScrollLeft,
        (7, false) => MouseEventKind::ScrollRight,
        // We do not support other buttons.
        _ => bail!(),
    };

    let mut modifiers = Modifiers::empty();

    if cb & 0b0000_0100 == 0b0000_0100 {
        modifiers |= Modifiers::SHIFT;
    }
    if cb & 0b0000_1000 == 0b0000_1000 {
        modifiers |= Modifiers::ALT;
    }
    if cb & 0b0001_0000 == 0b0001_0000 {
        modifiers |= Modifiers::CONTROL;
    }

    Ok((kind, modifiers))
}

fn parse_csi_bracketed_paste(buffer: &[u8]) -> Result<Option<Event>> {
    // CSI 2 0 0 ~ pasted text CSI 2 0 1 ~
    let buffer = buffer
        .strip_prefix(b"\x1b[200~")
        .expect("asserted by calling functions");

    if let Some(contents) = buffer.strip_suffix(b"\x1b[201~") {
        let paste = String::from_utf8_lossy(contents).to_string();
        Ok(Some(Event::Paste(paste)))
    } else {
        Ok(None)
    }
}

fn parse_csi_cursor_position(buffer: &[u8]) -> Result<Option<Event>> {
    // CSI Cy ; Cx R
    //   Cy - cursor row number (starting from 1)
    //   Cx - cursor column number (starting from 1)
    assert!(buffer.starts_with(b"\x1B[")); // CSI
    assert!(buffer.ends_with(b"R"));

    let s = str::from_utf8(&buffer[2..buffer.len() - 1])?;

    let mut split = s.split(';');

    let line = next_parsed::<NonZeroU16>(&mut split)?.into();
    let col = next_parsed::<NonZeroU16>(&mut split)?.into();

    Ok(Some(Event::Csi(Csi::Cursor(
        csi::Cursor::ActivePositionReport { line, col },
    ))))
}

fn parse_csi_cursor_shape_query_response(buffer: &[u8]) -> Result<Option<Event>> {
    assert!(buffer.starts_with(b"\x1B[>")); // CSI >
    assert!(buffer.ends_with(b" q"));

    if buffer.len() < 5 {
        // Minimum: ESC [ > SP q
        return Ok(None);
    }

    let s = str::from_utf8(&buffer[3..buffer.len() - 2])?;

    // An empty parameter string (CSI > SP q) is a query.
    if s.is_empty() {
        return Ok(Some(Event::Csi(Csi::Cursor(csi::Cursor::QueryCursorShape))));
    }

    let caps: Vec<csi::MultiCursorCapability> = s
        .split(';')
        .filter(|part| !part.is_empty())
        .map(|part| {
            part.parse::<u8>()
                .map_err(|_| MalformedSequenceError)
                .and_then(|v| {
                    csi::MultiCursorCapability::try_from(v).map_err(|_| MalformedSequenceError)
                })
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(Some(Event::Csi(Csi::Cursor(
        csi::Cursor::CursorShapeQueryResponse(caps),
    ))))
}

fn parse_csi_keyboard_enhancement_flags(buffer: &[u8]) -> Result<Option<Event>> {
    // CSI ? flags u
    assert!(buffer.starts_with(b"\x1B[?")); // ESC [ ?
    assert!(buffer.ends_with(b"u"));

    if buffer.len() < 5 {
        return Ok(None);
    }

    let bits = buffer[3];
    let mut flags = KittyKeyboardFlags::empty();

    if bits & 1 != 0 {
        flags |= KittyKeyboardFlags::DISAMBIGUATE_ESCAPE_CODES;
    }
    if bits & 2 != 0 {
        flags |= KittyKeyboardFlags::REPORT_EVENT_TYPES;
    }
    if bits & 4 != 0 {
        flags |= KittyKeyboardFlags::REPORT_ALTERNATE_KEYS;
    }
    if bits & 8 != 0 {
        flags |= KittyKeyboardFlags::REPORT_ALL_KEYS_AS_ESCAPE_CODES;
    }
    // TODO: support this
    // if bits & 16 != 0 {
    //     flags |= KeyboardEnhancementFlags::REPORT_ASSOCIATED_TEXT;
    // }

    Ok(Some(Event::Csi(Csi::Keyboard(csi::Keyboard::ReportFlags(
        flags,
    )))))
}

fn parse_csi_primary_device_attributes(buffer: &[u8]) -> Result<Option<Event>> {
    // CSI 64 ; attr1 ; attr2 ; ... ; attrn ; c
    assert!(buffer.starts_with(b"\x1B[?"));
    assert!(buffer.ends_with(b"c"));

    let parameters = str::from_utf8(&buffer[3..buffer.len() - 1])?;
    let mut parameters = parameters.split(';');
    let terminal_type = parse_reply_parameter(parameters.next().ok_or(MalformedSequenceError)?)?;
    let attributes = parameters
        .map(parse_reply_parameter)
        .collect::<Result<Vec<_>>>()?;
    Ok(Some(Event::Csi(Csi::PrimaryDeviceAttributes(
        csi::PrimaryDeviceAttributes {
            terminal_type,
            attributes,
        },
    ))))
}

fn parse_csi_graphics_attributes(buffer: &[u8]) -> Result<Option<Event>> {
    let parameters = str::from_utf8(&buffer[3..buffer.len() - 1])?;
    let mut parameters = parameters.split(';');
    let item = parse_reply_parameter(parameters.next().ok_or(MalformedSequenceError)?)?;
    let status = parse_reply_parameter(parameters.next().ok_or(MalformedSequenceError)?)?;
    let values = parameters
        .map(|parameter| {
            if parameter.is_empty() || !parameter.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(MalformedSequenceError);
            }
            parameter.parse::<u32>().map_err(|_| MalformedSequenceError)
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Some(Event::Csi(Csi::GraphicsAttributes(
        csi::GraphicsAttributeResponse {
            item,
            status,
            values,
        },
    ))))
}

fn parse_csi_pixel_size(buffer: &[u8]) -> Result<Option<Event>> {
    let parameters = str::from_utf8(&buffer[2..buffer.len() - 1])?;
    let mut parameters = parameters.split(';');
    let kind = parameters.next().ok_or(MalformedSequenceError)?;
    let height = parse_reply_parameter(parameters.next().ok_or(MalformedSequenceError)?)?;
    let width = parse_reply_parameter(parameters.next().ok_or(MalformedSequenceError)?)?;
    if height == 0 || width == 0 {
        bail!();
    }
    if parameters.next().is_some() {
        bail!();
    }
    let window = match kind {
        "4" => csi::Window::ReportTextAreaSizePixelsResponse {
            width: Some(i64::from(width)),
            height: Some(i64::from(height)),
        },
        "6" => csi::Window::ReportCellSizePixelsResponse {
            width: Some(i64::from(width)),
            height: Some(i64::from(height)),
        },
        _ => bail!(),
    };
    Ok(Some(Event::Csi(Csi::Window(Box::new(window)))))
}

fn parse_reply_parameter(parameter: &str) -> Result<u16> {
    if parameter.is_empty() || !parameter.bytes().all(|byte| byte.is_ascii_digit()) {
        bail!();
    }
    parameter.parse().map_err(|_| MalformedSequenceError)
}

fn parse_csi_theme_mode(buffer: &[u8]) -> Result<Option<Event>> {
    // dark mode:  CSI ? 997 ; 1 n
    // light mode: CSI ? 997 ; 2 n
    assert!(buffer.starts_with(b"\x1B[?"));
    assert!(buffer.ends_with(b"n"));

    let s = str::from_utf8(&buffer[3..buffer.len() - 1])?;

    let mut split = s.split(';');

    if next_parsed::<u16>(&mut split)? != 997 {
        bail!();
    }

    let theme_mode = match next_parsed::<u8>(&mut split)? {
        1 => ThemeMode::Dark,
        2 => ThemeMode::Light,
        _ => bail!(),
    };

    Ok(Some(Event::Csi(Csi::Mode(csi::Mode::ReportTheme(
        theme_mode,
    )))))
}

fn parse_csi_mode(buffer: &[u8]) -> Result<Option<Event>> {
    // pixel mouse mode:       CSI ? 1016 ; 2 $ y
    // sync output mode:       CSI ? 2026 ; 0 $ y
    // grapheme clustering:    CSI ? 2027 ; 1 $ y
    assert!(buffer.starts_with(b"\x1B[?"));
    assert!(buffer.ends_with(b"y"));

    let s = str::from_utf8(&buffer[3..buffer.len() - 1])?;
    let s = match s.strip_suffix('$') {
        Some(s) => s,
        None => bail!(),
    };

    let mut split = s.split(';');

    let mode = match parse_reply_parameter(split.next().ok_or(MalformedSequenceError)?)? {
        80 => csi::DecPrivateMode::Code(csi::DecPrivateModeCode::SixelDisplayMode),
        1016 => csi::DecPrivateMode::Code(csi::DecPrivateModeCode::SGRPixelsMouse),
        2026 => csi::DecPrivateMode::Code(csi::DecPrivateModeCode::SynchronizedOutput),
        2027 => csi::DecPrivateMode::Code(csi::DecPrivateModeCode::GraphemeClustering),
        _ => bail!(),
    };

    let setting = match parse_reply_parameter(split.next().ok_or(MalformedSequenceError)?)? {
        // For synchronized output specifically, 3 is undefined and 0 and 4 are treated as "not
        // supported."
        0 | 4 if mode == csi::DecPrivateMode::Code(csi::DecPrivateModeCode::SynchronizedOutput) => {
            csi::DecModeSetting::NotRecognized
        }
        0 => csi::DecModeSetting::NotRecognized,
        1 => csi::DecModeSetting::Set,
        2 => csi::DecModeSetting::Reset,
        3 if matches!(
            mode,
            csi::DecPrivateMode::Code(
                csi::DecPrivateModeCode::SixelDisplayMode
                    | csi::DecPrivateModeCode::GraphemeClustering
                    | csi::DecPrivateModeCode::SGRPixelsMouse
            )
        ) =>
        {
            csi::DecModeSetting::PermanentlySet
        }
        4 => csi::DecModeSetting::PermanentlyReset,
        _ => bail!(),
    };
    if split.next().is_some() {
        bail!();
    }

    Ok(Some(Event::Csi(Csi::Mode(
        csi::Mode::ReportDecPrivateMode { mode, setting },
    ))))
}

fn parse_dcs(buffer: &[u8]) -> Result<Option<Event>> {
    assert!(buffer.starts_with(escape::DCS.as_bytes()));
    if !buffer.ends_with(escape::ST.as_bytes()) {
        return Ok(None);
    }
    if let Some(value) = buffer.strip_prefix(b"\x1bP>|") {
        let value = &value[..value.len() - escape::ST.len()];
        if value.is_empty()
            || !value
                .iter()
                .all(|byte| byte.is_ascii_graphic() || *byte == b' ')
        {
            bail!();
        }
        return Ok(Some(Event::Dcs(dcs::Dcs::TerminalNameAndVersion(
            str::from_utf8(value)?.to_owned(),
        ))));
    }
    match buffer[buffer.len() - 3] {
        // SGR response: DCS Ps $ r SGR m ST
        b'm' => {
            if buffer.get(3..5) != Some(b"$r") {
                bail!();
            }
            // NOTE: <https://www.xfree86.org/current/ctlseqs.html> says that '1' is a valid
            // request and '0' is invalid while the vt100.net docs for DECRQSS say the opposite.
            // Kitty and WezTerm both follow the ctlseqs doc.
            let is_request_valid = match buffer[2] {
                b'1' => true,
                // TODO: don't parse attributes if the request isn't valid?
                b'0' => false,
                _ => bail!(),
            };
            let s = str::from_utf8(&buffer[5..buffer.len() - 3])?;
            let mut sgrs = Vec::new();
            // TODO: is this correct? What about terminals that use ';' for true colors?
            for sgr in s.split(';') {
                sgrs.push(parse_sgr(sgr)?);
            }
            Ok(Some(Event::Dcs(dcs::Dcs::Response {
                is_request_valid,
                value: dcs::DcsResponse::GraphicRendition(sgrs),
            })))
        }
        _ => bail!(),
    }
}

fn parse_sgr(buffer: &str) -> Result<csi::Sgr> {
    use csi::Sgr;
    use style::*;

    let sgr = match buffer {
        "0" => Sgr::Reset,
        "22" => Sgr::Intensity(Intensity::Normal),
        "1" => Sgr::Intensity(Intensity::Bold),
        "2" => Sgr::Intensity(Intensity::Dim),
        "24" => Sgr::Underline(Underline::None),
        "4" => Sgr::Underline(Underline::Single),
        "21" => Sgr::Underline(Underline::Double),
        "4:3" => Sgr::Underline(Underline::Curly),
        "4:4" => Sgr::Underline(Underline::Dotted),
        "4:5" => Sgr::Underline(Underline::Dashed),
        "25" => Sgr::Blink(Blink::None),
        "5" => Sgr::Blink(Blink::Slow),
        "6" => Sgr::Blink(Blink::Rapid),
        "3" => Sgr::Italic(true),
        "23" => Sgr::Italic(false),
        "7" => Sgr::Reverse(true),
        "27" => Sgr::Reverse(false),
        "8" => Sgr::Invisible(true),
        "28" => Sgr::Invisible(false),
        "9" => Sgr::StrikeThrough(true),
        "29" => Sgr::StrikeThrough(false),
        "53" => Sgr::Overline(true),
        "55" => Sgr::Overline(false),
        "10" => Sgr::Font(Font::Default),
        "11" => Sgr::Font(Font::Alternate(1)),
        "12" => Sgr::Font(Font::Alternate(2)),
        "13" => Sgr::Font(Font::Alternate(3)),
        "14" => Sgr::Font(Font::Alternate(4)),
        "15" => Sgr::Font(Font::Alternate(5)),
        "16" => Sgr::Font(Font::Alternate(6)),
        "17" => Sgr::Font(Font::Alternate(7)),
        "18" => Sgr::Font(Font::Alternate(8)),
        "19" => Sgr::Font(Font::Alternate(9)),
        "75" => Sgr::VerticalAlign(VerticalAlign::BaseLine),
        "73" => Sgr::VerticalAlign(VerticalAlign::SuperScript),
        "74" => Sgr::VerticalAlign(VerticalAlign::SubScript),
        "39" => Sgr::Foreground(ColorSpec::Reset),
        "30" => Sgr::Foreground(ColorSpec::BLACK),
        "31" => Sgr::Foreground(ColorSpec::RED),
        "32" => Sgr::Foreground(ColorSpec::GREEN),
        "33" => Sgr::Foreground(ColorSpec::YELLOW),
        "34" => Sgr::Foreground(ColorSpec::BLUE),
        "35" => Sgr::Foreground(ColorSpec::MAGENTA),
        "36" => Sgr::Foreground(ColorSpec::CYAN),
        "37" => Sgr::Foreground(ColorSpec::WHITE),
        "90" => Sgr::Foreground(ColorSpec::BRIGHT_BLACK),
        "91" => Sgr::Foreground(ColorSpec::BRIGHT_RED),
        "92" => Sgr::Foreground(ColorSpec::BRIGHT_GREEN),
        "93" => Sgr::Foreground(ColorSpec::BRIGHT_YELLOW),
        "94" => Sgr::Foreground(ColorSpec::BRIGHT_BLUE),
        "95" => Sgr::Foreground(ColorSpec::BRIGHT_MAGENTA),
        "96" => Sgr::Foreground(ColorSpec::BRIGHT_CYAN),
        "97" => Sgr::Foreground(ColorSpec::BRIGHT_WHITE),
        "49" => Sgr::Background(ColorSpec::Reset),
        "40" => Sgr::Background(ColorSpec::BLACK),
        "41" => Sgr::Background(ColorSpec::RED),
        "42" => Sgr::Background(ColorSpec::GREEN),
        "43" => Sgr::Background(ColorSpec::YELLOW),
        "44" => Sgr::Background(ColorSpec::BLUE),
        "45" => Sgr::Background(ColorSpec::MAGENTA),
        "46" => Sgr::Background(ColorSpec::CYAN),
        "47" => Sgr::Background(ColorSpec::WHITE),
        "100" => Sgr::Background(ColorSpec::BRIGHT_BLACK),
        "101" => Sgr::Background(ColorSpec::BRIGHT_RED),
        "102" => Sgr::Background(ColorSpec::BRIGHT_GREEN),
        "103" => Sgr::Background(ColorSpec::BRIGHT_YELLOW),
        "104" => Sgr::Background(ColorSpec::BRIGHT_BLUE),
        "105" => Sgr::Background(ColorSpec::BRIGHT_MAGENTA),
        "106" => Sgr::Background(ColorSpec::BRIGHT_CYAN),
        "107" => Sgr::Background(ColorSpec::BRIGHT_WHITE),
        "59" => Sgr::UnderlineColor(ColorSpec::Reset),
        _ => {
            let mut split = buffer.split(':').filter(|s| !s.is_empty());
            let first = next_parsed::<u8>(&mut split)?;
            let color = match next_parsed::<u8>(&mut split)? {
                2 => RgbColor {
                    red: next_parsed::<u8>(&mut split)?,
                    green: next_parsed::<u8>(&mut split)?,
                    blue: next_parsed::<u8>(&mut split)?,
                }
                .into(),
                5 => ColorSpec::PaletteIndex(next_parsed::<u8>(&mut split)?),
                6 => RgbaColor {
                    red: next_parsed::<u8>(&mut split)?,
                    green: next_parsed::<u8>(&mut split)?,
                    blue: next_parsed::<u8>(&mut split)?,
                    alpha: next_parsed::<u8>(&mut split)?,
                }
                .into(),
                _ => bail!(),
            };
            match first {
                38 => Sgr::Foreground(color),
                48 => Sgr::Background(color),
                58 => Sgr::UnderlineColor(color),
                _ => bail!(),
            }
        }
    };
    Ok(sgr)
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn graphics_replies_preserve_input_and_paste_at_every_byte_boundary() {
        let wire = concat!(
            "你\x1b_Gi=31;OK\x1b\\\x1b]1337;Capabilities=T3FFSxSy;future=1\x1b\\",
            "\x1bP>|XTerm(411)\x1b\\\x1b[?1016;2$y\x1b[?64;1;4;22c",
            "\x1b[?2;0;1000;800S\x1b[?2;0;0;0S",
            "\x1b[?2;1S\x1b[?2;2S\x1b[?2;3S\x1b[?17;99;4294967295S\x10",
            "\x1b[6;16;8t\x1b[4;680;960t\x1b_Gp=1,i=32;ENOENT: missing image\x1b\\",
            "\x1b[<0;4;5M\x1b[<0;4;5m\x1b[<288;-1;-20M",
            "\x1b[200~literal \x1b[?64;4c \x1b[?2;0;1000;800S ",
            "\x1b[6;16;8t \x1b_Gi=33;OK\x1b\\\x1b[201~z",
        );
        let expected = vec![
            Event::Key(KeyCode::Char('你').into()),
            Event::KittyGraphicsResponse(KittyGraphicsResponse {
                image_id: 31,
                image_number: None,
                placement_id: None,
                result: Ok(()),
            }),
            Event::Iterm2Capabilities("T3FFSxSy;future=1".to_owned()),
            Event::Dcs(dcs::Dcs::TerminalNameAndVersion("XTerm(411)".to_owned())),
            Event::Csi(Csi::Mode(csi::Mode::ReportDecPrivateMode {
                mode: csi::DecPrivateMode::Code(csi::DecPrivateModeCode::SGRPixelsMouse),
                setting: csi::DecModeSetting::Reset,
            })),
            Event::Csi(Csi::PrimaryDeviceAttributes(csi::PrimaryDeviceAttributes {
                terminal_type: 64,
                attributes: vec![1, 4, 22],
            })),
            Event::Csi(Csi::GraphicsAttributes(csi::GraphicsAttributeResponse {
                item: 2,
                status: 0,
                values: vec![1000, 800],
            })),
            Event::Csi(Csi::GraphicsAttributes(csi::GraphicsAttributeResponse {
                item: 2,
                status: 0,
                values: vec![0, 0],
            })),
            Event::Csi(Csi::GraphicsAttributes(csi::GraphicsAttributeResponse {
                item: 2,
                status: 1,
                values: vec![],
            })),
            Event::Csi(Csi::GraphicsAttributes(csi::GraphicsAttributeResponse {
                item: 2,
                status: 2,
                values: vec![],
            })),
            Event::Csi(Csi::GraphicsAttributes(csi::GraphicsAttributeResponse {
                item: 2,
                status: 3,
                values: vec![],
            })),
            Event::Csi(Csi::GraphicsAttributes(csi::GraphicsAttributeResponse {
                item: 17,
                status: 99,
                values: vec![4294967295],
            })),
            Event::Key(KeyEvent::new(KeyCode::Char('p'), Modifiers::CONTROL)),
            Event::Csi(Csi::Window(Box::new(
                csi::Window::ReportCellSizePixelsResponse {
                    width: Some(8),
                    height: Some(16),
                },
            ))),
            Event::Csi(Csi::Window(Box::new(
                csi::Window::ReportTextAreaSizePixelsResponse {
                    width: Some(960),
                    height: Some(680),
                },
            ))),
            Event::KittyGraphicsResponse(KittyGraphicsResponse {
                image_id: 32,
                image_number: None,
                placement_id: Some(1),
                result: Err("ENOENT: missing image".to_owned()),
            }),
            Event::SgrMouse(SgrMouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                x: 4,
                y: 5,
                modifiers: Modifiers::NONE,
            }),
            Event::SgrMouse(SgrMouseEvent {
                kind: MouseEventKind::Up(MouseButton::Left),
                x: 4,
                y: 5,
                modifiers: Modifiers::NONE,
            }),
            Event::MouseLeave,
            Event::Paste(
                concat!(
                    "literal \x1b[?64;4c \x1b[?2;0;1000;800S ",
                    "\x1b[6;16;8t \x1b_Gi=33;OK\x1b\\",
                )
                .to_string(),
            ),
            Event::Key(KeyCode::Char('z').into()),
        ];
        for split in 0..=wire.len() {
            let mut parser = Parser::default();
            parser.parse(&wire.as_bytes()[..split], true).unwrap();
            parser.parse(&wire.as_bytes()[split..], false).unwrap();
            let actual: Vec<_> = std::iter::from_fn(|| parser.pop()).collect();
            assert_eq!(actual, expected, "split at byte {split}");
        }
        assert_eq!(
            Csi::PrimaryDeviceAttributes(csi::PrimaryDeviceAttributes {
                terminal_type: 64,
                attributes: vec![1, 4, 22],
            })
            .to_string(),
            "\x1b[?64;1;4;22c"
        );
        assert_eq!(
            Csi::GraphicsAttributes(csi::GraphicsAttributeResponse {
                item: 2,
                status: 0,
                values: vec![1000, 800],
            })
            .to_string(),
            "\x1b[?2;0;1000;800S"
        );
        assert_eq!(
            Csi::GraphicsAttributes(csi::GraphicsAttributeResponse {
                item: 2,
                status: 3,
                values: vec![],
            })
            .to_string(),
            "\x1b[?2;3S"
        );
    }

    #[test]
    fn kitty_graphics_reply_preserves_identifiers_and_exact_status() {
        let mut parser = Parser::default();
        parser
            .parse(
                b"\x1b_GI=13,p=4294967295,i=0;OK\x1b\\\x1b_Gi=99;OK extra\x1b\\",
                false,
            )
            .unwrap();
        let response = parser.pop().unwrap();
        assert!(response.is_escape());
        assert_eq!(
            response,
            Event::KittyGraphicsResponse(KittyGraphicsResponse {
                image_id: 0,
                image_number: Some(13),
                placement_id: Some(u32::MAX),
                result: Ok(()),
            })
        );
        assert_eq!(
            parser.pop(),
            Some(Event::KittyGraphicsResponse(KittyGraphicsResponse {
                image_id: 99,
                image_number: None,
                placement_id: None,
                result: Err("OK extra".to_owned()),
            }))
        );
        assert_eq!(parser.pop(), None);
    }

    #[test]
    fn malformed_or_unknown_apc_never_becomes_keys_and_keeps_following_input() {
        for invalid in [
            "unknown APC",
            "G;OK",
            "GI=13;OK",
            "Gi=1,i=2;OK",
            "Gi=1,p=2,p=3;OK",
            "Gi=1,I=2,I=3;OK",
            "Gi=+1;OK",
            "Gi=-1;OK",
            "Gi=4294967296;OK",
            "Gi=;OK",
            "Gi=1,;OK",
            "Gi=1,x=2;OK",
            "Gi=1;",
            "Gi=1;不行",
            "Gi=1;bad\x07message",
            "Gi=1;bad\x1b[Amesssage",
        ] {
            let wire = format!("\x1b_{invalid}\x1b\\你\x1b[A\x03");
            let mut parser = Parser::default();
            parser.parse(wire.as_bytes(), false).unwrap();
            let actual: Vec<_> = std::iter::from_fn(|| parser.pop()).collect();
            assert_eq!(
                actual,
                vec![
                    Event::Key(KeyCode::Char('你').into()),
                    Event::Key(KeyCode::Up.into()),
                    Event::Key(KeyEvent::new(KeyCode::Char('c'), Modifiers::CONTROL)),
                ],
                "{invalid:?}"
            );
        }
    }

    #[test]
    fn graphics_csi_parameters_are_decimal_and_cell_pixels_are_nonzero() {
        for invalid in [
            b"\x1b[?+64;4c".as_slice(),
            b"\x1b[?64;+4c",
            b"\x1b[?64;;4c",
            b"\x1b[?64;65536c",
            b"\x1b[?S",
            b"\x1b[?2S",
            b"\x1b[?;0S",
            b"\x1b[?+2;0;1000;800S",
            b"\x1b[?65536;0S",
            b"\x1b[?2;+0S",
            b"\x1b[?2;65536S",
            b"\x1b[?2;;0S",
            b"\x1b[?2;0;+1000;800S",
            b"\x1b[?2;0;1:2;800S",
            b"\x1b[?2;0;4294967296;800S",
            b"\x1b[?2;0;1000;S",
            b"\x1b[6;+16;8t",
            b"\x1b[6;16;+8t",
            b"\x1b[6;0;8t",
            b"\x1b[6;16;0t",
            b"\x1b[6;16;65536t",
            b"\x1b[6;16;8;1t",
            b"\x1b[4;0;960t",
            b"\x1b[4;680;0t",
            b"\x1b[4;+680;960t",
            b"\x1b[4;680;+960t",
            b"\x1b[4;680;65536t",
            b"\x1b[4;680;960;1t",
        ] {
            assert!(parse_event(invalid, false).is_err(), "{invalid:?}");
            let start = Instant::now();
            let mut parser = Parser::default();
            parser.parse_at(invalid, false, start).unwrap();
            parser
                .parse_at(b"\x10", false, start + Duration::from_millis(100))
                .unwrap();
            assert_eq!(
                parser.pop(),
                Some(Event::Key(KeyEvent::new(
                    KeyCode::Char('p'),
                    Modifiers::CONTROL
                ))),
                "{invalid:?}"
            );
            assert_eq!(parser.pop(), None, "{invalid:?}");
        }
    }

    #[test]
    fn pending_limit_keeps_a_full_64k_paste_and_does_not_sum_completed_events() {
        let mut parser = Parser::default();
        parser.set_max_pending_bytes(64 * 1024 + 12).unwrap();
        let text = "x".repeat(64 * 1024);
        let wire = format!("\x1b[200~{text}\x1b[201~");
        parser.parse(wire.as_bytes(), false).unwrap();
        assert_eq!(parser.pop(), Some(Event::Paste(text)));
        assert_eq!(parser.pop(), None);

        let mut parser = Parser::default();
        parser.set_max_pending_bytes(1).unwrap();
        parser.parse(b"abcdefghijklmnopqrstuvwxyz", false).unwrap();
        let actual: Vec<_> = std::iter::from_fn(|| parser.pop()).collect();
        assert_eq!(
            actual,
            "abcdefghijklmnopqrstuvwxyz"
                .chars()
                .map(|character| Event::Key(KeyCode::Char(character).into()))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn pending_limit_failure_is_sticky_and_never_replays_the_tail() {
        let mut parser = Parser::default();
        assert_eq!(
            parser.set_max_pending_bytes(0).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        parser.set_max_pending_bytes(8).unwrap();
        assert_eq!(
            parser.parse(b"\x1b[6;2;0000", true).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(parser.buffer.len() <= 8);
        assert_eq!(
            parser.set_max_pending_bytes(1024).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            parser.parse(b"~z", false).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(parser.pop(), None);
    }

    #[test]
    fn private_csi_replies_expire_without_more_bytes_but_numeric_keys_do_not() {
        let start = Instant::now();
        let mut parser = Parser::default();
        parser.parse_at(b"\x1b[?64;4", true, start).unwrap();
        assert_eq!(
            parser
                .parse_at(b"", false, start + Duration::from_millis(100))
                .unwrap_err()
                .kind(),
            io::ErrorKind::TimedOut
        );
        assert_eq!(
            parser
                .parse_at(b"cz", false, start + Duration::from_millis(101))
                .unwrap_err()
                .kind(),
            io::ErrorKind::TimedOut
        );
        assert_eq!(parser.pop(), None);

        let mut parser = Parser::default();
        parser.parse_at(b"\x1b[6;2", true, start).unwrap();
        parser
            .parse_at(b"~", false, start + Duration::from_secs(1))
            .unwrap();
        assert_eq!(
            parser.pop(),
            Some(Event::Key(KeyEvent::new(
                KeyCode::PageDown,
                Modifiers::SHIFT
            )))
        );

        let mut parser = Parser::default();
        parser
            .parse_at(b"\x1b[200~\x1b[?64;4", true, start)
            .unwrap();
        parser
            .parse_at(b"c\x1b[201~", false, start + Duration::from_secs(1))
            .unwrap();
        assert_eq!(parser.pop(), Some(Event::Paste("\x1b[?64;4c".to_string())));
    }

    #[test]
    fn terminal_metadata_bounds_keep_completed_replies_and_never_replay_rejected_tails() {
        let mut parser = Parser::default();
        let wire = format!("\x1b_Gi=31;{}\x1b\\", "E".repeat(246));
        assert_eq!(wire.len(), 256);
        parser.parse(wire.as_bytes(), false).unwrap();
        assert!(matches!(
            parser.pop(),
            Some(Event::KittyGraphicsResponse(KittyGraphicsResponse { image_id: 31, result: Err(message), .. }))
                if message.len() == 246
        ));
        assert_eq!(parser.pop(), None);

        let start = Instant::now();
        for prefix in [
            b"\x1b_".as_slice(),
            b"\x1b_Gi=31;OK\x1b",
            b"\x1b_unknown",
            b"\x1b]1337;Capabilities=FF",
            b"\x1bP>|XTerm(411)",
        ] {
            let mut parser = Parser::default();
            parser.parse_at(b"x", false, start).unwrap();
            parser.parse_at(prefix, false, start).unwrap();
            assert_eq!(parser.pop(), Some(Event::Key(KeyCode::Char('x').into())));
            assert_eq!(parser.pop(), None);
            assert_eq!(
                parser
                    .expire_reply_at(start + Duration::from_millis(100))
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::TimedOut
            );
            assert_eq!(
                parser.parse(b"\\z", false).unwrap_err().kind(),
                io::ErrorKind::TimedOut
            );
            assert_eq!(parser.pop(), None);
        }

        for prefix in ["\x1b_Gi=31;", "\x1b]1337;Capabilities=", "\x1bP>|"] {
            let mut parser = Parser::default();
            let wire = format!("x{prefix}{}", "E".repeat(300));
            assert_eq!(
                parser.parse(wire.as_bytes(), true).unwrap_err().kind(),
                io::ErrorKind::InvalidData
            );
            assert_eq!(parser.pop(), Some(Event::Key(KeyCode::Char('x').into())));
            assert!(parser.buffer.len() <= 256);
            assert_eq!(
                parser.parse(b"\x1b\\z", false).unwrap_err().kind(),
                io::ErrorKind::InvalidData
            );
            assert_eq!(parser.pop(), None);
        }
        // Other OSC 1337 replies retain their existing framing and resource behavior.
        let mut parser = Parser::default();
        let wire = format!("\x1b]1337;ReportVariable={}\x1b\\z", "E".repeat(300));
        parser.parse(wire.as_bytes(), false).unwrap();
        assert_eq!(parser.pop(), Some(Event::Key(KeyCode::Char('z').into())));
        assert_eq!(parser.pop(), None);
    }

    #[test]
    fn private_csi_reply_byte_limit_is_sticky_before_its_deadline() {
        let mut parser = Parser::default();
        let wire = format!("\x1b[?64;{}", "0".repeat(300));
        assert_eq!(
            parser.parse(wire.as_bytes(), true).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(parser.buffer.len() <= 256);
        assert_eq!(
            parser.parse(b"cz", false).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(parser.pop(), None);
    }

    #[test]
    fn parse_dcs_sgr_response() {
        // Example from <https://vt100.net/docs/vt510-rm/DECRPSS.html>
        // > If the current graphic rendition is underline, blinking, and reverse, then the
        // > terminal responds with the following DECRPSS sequence:
        // > DCS 0 $ r 0 ; 4 ; 5 ; 7 m ST
        // NOTE: The vt100.net docs have the Ps part of this reversed. 0 is invalid and 1 is
        // valid according to the xterm docs. See `parse_dcs`.
        let event = parse_event(b"\x1bP0$r0;4;5;7m\x1b\\", false)
            .unwrap()
            .unwrap();
        assert_eq!(
            event,
            Event::Dcs(dcs::Dcs::Response {
                is_request_valid: false,
                value: dcs::DcsResponse::GraphicRendition(vec![
                    csi::Sgr::Reset,
                    csi::Sgr::Underline(style::Underline::Single),
                    csi::Sgr::Blink(style::Blink::Slow),
                    csi::Sgr::Reverse(true),
                ])
            })
        );
    }

    #[test]
    fn parse_dcs_sgr_curly_underline() {
        // A DECRPSS reply describing a curly (`4:3`) underline must round-trip through `parse_sgr`.
        let event = parse_event(b"\x1bP1$r4:3m\x1b\\", false).unwrap().unwrap();
        assert_eq!(
            event,
            Event::Dcs(dcs::Dcs::Response {
                is_request_valid: true,
                value: dcs::DcsResponse::GraphicRendition(vec![csi::Sgr::Underline(
                    style::Underline::Curly
                )])
            })
        );
    }

    #[test]
    fn parse_osc_dynamic_color_response() {
        assert_eq!(
            parse_event(b"\x1b]11;rgb:2828/2828/2828\x1b\\", false)
                .unwrap()
                .unwrap(),
            Event::Osc(osc::Osc::ChangeDynamicColors(
                osc::DynamicColorNumber::TextBackgroundColor,
                vec![style::RgbColor::new(40, 40, 40).into()]
            ))
        );
        // BEL ending instead of ST
        assert_eq!(
            parse_event(b"\x1b]11;rgb:2828/2828/2828\x07", false)
                .unwrap()
                .unwrap(),
            Event::Osc(osc::Osc::ChangeDynamicColors(
                osc::DynamicColorNumber::TextBackgroundColor,
                vec![style::RgbColor::new(40, 40, 40).into()]
            ))
        );
    }

    #[test]
    fn nsh_text_input_packets_keep_composition_and_following_keys_separate() {
        use osc::NshTextInput;
        let mut parser = Parser::default();
        parser
            .parse(b"\x1b]777;nsh-text-input;focused;7\x1b\\", false)
            .unwrap();
        assert_eq!(
            parser.pop(),
            Some(Event::Osc(osc::Osc::NshTextInput(NshTextInput::Focused(7))))
        );
        // One partial commit containing a delimiter/control, with a remaining
        // preedit selecting the entire supplementary-plane character.
        parser
            .parse(
                b"\x1b]777;nsh-text-input;update;7;1;1;3;5aW9Oxs=;5L2g8J+",
                true,
            )
            .unwrap();
        assert_eq!(parser.pop(), None);
        parser.parse(b"YgDs=\x1b\\z", false).unwrap();
        assert_eq!(
            parser.pop(),
            Some(Event::Osc(osc::Osc::NshTextInput(NshTextInput::Update {
                context: std::num::NonZeroU64::new(7).unwrap(),
                active: true,
                selection: 1..3,
                commit: "好;\x1b".into(),
                preedit: "你😀;".into(),
            })))
        );
        assert_eq!(parser.pop(), Some(Event::Key(KeyCode::Char('z').into())));
        for valid in [
            "update;7;1;0;0;;", // composition start, not a commit
            "update;7;0;0;0;;", // cancellation, not a commit
            "focus;0",
            "focused;0",
        ] {
            parser
                .parse(
                    format!("\x1b]777;nsh-text-input;{valid}\x1b\\").as_bytes(),
                    false,
                )
                .unwrap();
            assert!(matches!(
                parser.pop(),
                Some(Event::Osc(osc::Osc::NshTextInput(_)))
            ));
        }
        for invalid in [
            "update;7;1;2;3;;5L2g8J+YgDs=", // surrogate interior
            "update;7;1;3;1;;5L2g8J+YgDs=", // reversed range
            "update;7;1;0;5;;5L2g8J+YgDs=", // past the preedit
            "update;0;1;0;0;;",             // no admitted context
            "update;7;2;0;0;;",             // invalid active flag
            "update;7;0;0;1;;YQ==",         // inactive preedit
            "update;7;1;0;0;/w==;",         // invalid decoded UTF-8
            "update;7;1;0;0;YR==;",         // nonzero Base64 padding bits
            "update;7;1;0;0;YQ=;",          // missing Base64 padding
            "update;7;1;0;0;;extra;",       // extra field
            "focus;18446744073709551616",   // u64 overflow
            "focus;+7",                     // not unsigned decimal wire text
            "future;7",
        ] {
            parser
                .parse(
                    format!("\x1b]777;nsh-text-input;{invalid}\x1b\\q").as_bytes(),
                    false,
                )
                .unwrap();
            assert_eq!(parser.pop(), Some(Event::Key(KeyCode::Char('q').into())));
            assert_eq!(parser.pop(), None);
        }
    }

    #[test]
    fn iterm_capabilities_preserve_raw_features_and_complete_osc_framing() {
        for (wire, features) in [
            ("\x1b]1337;Capabilities=\x07", ""),
            ("\x1b]1337;Capabilities=F\x07", "F"),
            ("\x1b]1337;Capabilities=FFSxSy\x1b\\", "FFSxSy"),
            ("\x1b]1337;Capabilities=F0F2;future !\x07", "F0F2;future !"),
        ] {
            let mut parser = Parser::default();
            parser.parse(wire.as_bytes(), false).unwrap();
            let event = parser.pop().unwrap();
            assert!(event.is_escape());
            assert_eq!(event, Event::Iterm2Capabilities(features.to_owned()));
            assert_eq!(parser.pop(), None);
        }
        for invalid in [
            "\x1b]1337;Capabilities\x07",
            "\x1b]1337;capabilities=FF\x07",
            "\x1b]1337;Capabilities=FF\u{1}\x07",
            "\x1b]1337;Capabilities=图\x07",
            "\x1b]1337;File=FF\x1b\\",
        ] {
            let mut parser = Parser::default();
            let wire = format!("{invalid}你\x03");
            parser.parse(wire.as_bytes(), false).unwrap();
            assert_eq!(parser.pop(), Some(Event::Key(KeyCode::Char('你').into())));
            assert_eq!(
                parser.pop(),
                Some(Event::Key(KeyEvent::new(
                    KeyCode::Char('c'),
                    Modifiers::CONTROL
                )))
            );
            assert_eq!(parser.pop(), None);
        }
    }

    #[test]
    fn terminal_version_reply_preserves_identity_without_parsing_a_product() {
        for value in [
            "XTerm(411)",
            "kitty(0.45.0)",
            "ghostty 1.3.0",
            "Other terminal",
        ] {
            let wire = format!("\x1bP>|{value}\x1b\\");
            let mut parser = Parser::default();
            parser.parse(wire.as_bytes(), false).unwrap();
            assert_eq!(
                parser.pop(),
                Some(Event::Dcs(dcs::Dcs::TerminalNameAndVersion(
                    value.to_owned()
                )))
            );
            assert_eq!(parser.pop(), None);
        }
        for invalid in [
            "\x1bP>|\x1b\\",
            "\x1bP>|XTerm\u{1}\x1b\\",
            "\x1bP>|终端\x1b\\",
            "\x1bP>!XTerm(411)\x1b\\",
        ] {
            let mut parser = Parser::default();
            let wire = format!("{invalid}z");
            parser.parse(wire.as_bytes(), false).unwrap();
            assert_eq!(parser.pop(), Some(Event::Key(KeyCode::Char('z').into())));
            assert_eq!(parser.pop(), None);
        }
    }

    #[test]
    fn parse_cursor_shape_query() {
        // CSI > SP q with no parameters is a query.
        let event = parse_event(b"\x1b[> q", false).unwrap().unwrap();
        assert_eq!(
            event,
            Event::Csi(Csi::Cursor(csi::Cursor::QueryCursorShape))
        );
    }

    #[test]
    fn parse_cursor_shape_query_response() {
        // Kitty responds with the supported operation codes.
        let event = parse_event(b"\x1b[>1;2;29;100 q", false).unwrap().unwrap();
        assert_eq!(
            event,
            Event::Csi(Csi::Cursor(csi::Cursor::CursorShapeQueryResponse(vec![
                csi::MultiCursorCapability::BlockShape,
                csi::MultiCursorCapability::BeamShape,
                csi::MultiCursorCapability::FollowMainCursorShape,
                csi::MultiCursorCapability::QueryCurrentCursors,
            ])))
        );
    }

    #[test]
    fn parse_cursor_shape_query_response_invalid() {
        // Value 7 is not a valid MultiCursorCapability code.
        assert!(parse_event(b"\x1b[>7 q", false).is_err());
    }

    #[test]
    fn cursor_shape_query_response_round_trip() {
        let response = csi::Cursor::CursorShapeQueryResponse(vec![
            csi::MultiCursorCapability::BlockShape,
            csi::MultiCursorCapability::FollowMainCursorShape,
            csi::MultiCursorCapability::QueryCurrentCursors,
        ]);
        let encoded = Csi::Cursor(response.clone()).to_string();
        assert_eq!(encoded, "\x1b[>1;29;100 q");

        let parsed = parse_event(encoded.as_bytes(), false).unwrap().unwrap();
        assert_eq!(parsed, Event::Csi(Csi::Cursor(response)));
    }

    #[test]
    fn parse_synchronized_output_mode_set() {
        let event = parse_event(b"\x1b[?2026;1$y", false).unwrap().unwrap();
        assert_eq!(
            event,
            Event::Csi(Csi::Mode(csi::Mode::ReportDecPrivateMode {
                mode: csi::DecPrivateMode::Code(csi::DecPrivateModeCode::SynchronizedOutput),
                setting: csi::DecModeSetting::Set,
            }))
        );
    }

    #[test]
    fn parse_grapheme_clustering_mode_set() {
        let event = parse_event(b"\x1b[?2027;1$y", false).unwrap().unwrap();
        assert_eq!(
            event,
            Event::Csi(Csi::Mode(csi::Mode::ReportDecPrivateMode {
                mode: csi::DecPrivateMode::Code(csi::DecPrivateModeCode::GraphemeClustering),
                setting: csi::DecModeSetting::Set,
            }))
        );
    }

    #[test]
    fn pixel_mouse_and_sixel_mode_reports_preserve_all_five_states() {
        for (code, mode) in [
            (80, csi::DecPrivateModeCode::SixelDisplayMode),
            (1016, csi::DecPrivateModeCode::SGRPixelsMouse),
        ] {
            for (value, setting) in [
                (0, csi::DecModeSetting::NotRecognized),
                (1, csi::DecModeSetting::Set),
                (2, csi::DecModeSetting::Reset),
                (3, csi::DecModeSetting::PermanentlySet),
                (4, csi::DecModeSetting::PermanentlyReset),
            ] {
                let wire = format!("\x1b[?{code};{value}$y");
                let mut parser = Parser::default();
                parser.parse(wire.as_bytes(), false).unwrap();
                assert_eq!(
                    parser.pop(),
                    Some(Event::Csi(Csi::Mode(csi::Mode::ReportDecPrivateMode {
                        mode: csi::DecPrivateMode::Code(mode),
                        setting,
                    })))
                );
                assert_eq!(parser.pop(), None);
            }
        }
        for invalid in [
            b"\x1b[?+1016;1$y".as_slice(),
            b"\x1b[?1016;+1$y",
            b"\x1b[?1016;5$y",
            b"\x1b[?1016;;1$y",
            b"\x1b[?1016;1;2$y",
        ] {
            assert!(parse_event(invalid, false).is_err(), "{invalid:?}");
        }
        assert_eq!(
            Csi::Window(Box::new(csi::Window::ReportTextAreaSizePixelsResponse {
                width: Some(960),
                height: Some(680),
            }))
            .to_string(),
            "\x1b[4;680;960t"
        );
    }

    #[test]
    fn sgr_mouse_keeps_signed_wire_positions_and_legacy_mouse_keeps_cells() {
        let mut parser = Parser::default();
        parser
            .parse(
                b"\x1b[<0;0;1M\x1b[<0;1;0m\x1b[<35;-17;70000M\x1b[<60;-2147483648;2147483647M\x1b[<64;10;20M\x1b[32;33;34M\x1b[M !!",
                false,
            )
            .unwrap();
        let actual: Vec<_> = std::iter::from_fn(|| parser.pop()).collect();
        assert_eq!(
            actual,
            vec![
                Event::SgrMouse(SgrMouseEvent {
                    kind: MouseEventKind::Down(MouseButton::Left),
                    x: 0,
                    y: 1,
                    modifiers: Modifiers::NONE,
                }),
                Event::SgrMouse(SgrMouseEvent {
                    kind: MouseEventKind::Up(MouseButton::Left),
                    x: 1,
                    y: 0,
                    modifiers: Modifiers::NONE,
                }),
                Event::SgrMouse(SgrMouseEvent {
                    kind: MouseEventKind::Moved,
                    x: -17,
                    y: 70000,
                    modifiers: Modifiers::NONE,
                }),
                Event::SgrMouse(SgrMouseEvent {
                    kind: MouseEventKind::Drag(MouseButton::Left),
                    x: i32::MIN,
                    y: i32::MAX,
                    modifiers: Modifiers::SHIFT | Modifiers::ALT | Modifiers::CONTROL,
                }),
                Event::SgrMouse(SgrMouseEvent {
                    kind: MouseEventKind::ScrollUp,
                    x: 10,
                    y: 20,
                    modifiers: Modifiers::NONE,
                }),
                Event::Mouse(MouseEvent {
                    kind: MouseEventKind::Down(MouseButton::Left),
                    column: 32,
                    row: 33,
                    modifiers: Modifiers::NONE,
                }),
                Event::Mouse(MouseEvent {
                    kind: MouseEventKind::Down(MouseButton::Left),
                    column: 0,
                    row: 0,
                    modifiers: Modifiers::NONE,
                }),
            ]
        );
    }

    #[test]
    fn pixel_mouse_leave_ignores_button_bits_and_coordinates_but_not_bad_framing() {
        for cb in [256, 288, 511, u32::MAX] {
            let mut parser = Parser::default();
            let wire = format!("\x1b[<{cb};-17;-99M\x1b[<0;0;1m");
            parser.parse(wire.as_bytes(), false).unwrap();
            assert_eq!(parser.pop(), Some(Event::MouseLeave));
            assert_eq!(
                parser.pop(),
                Some(Event::SgrMouse(SgrMouseEvent {
                    kind: MouseEventKind::Up(MouseButton::Left),
                    x: 0,
                    y: 1,
                    modifiers: Modifiers::NONE,
                }))
            );
            assert_eq!(parser.pop(), None);
        }
        for invalid in [
            b"\x1b[<+288;0;0M".as_slice(),
            b"\x1b[<-288;0;0M",
            b"\x1b[<4294967296;0;0M",
            b"\x1b[<288;;0M",
            b"\x1b[<288;0M",
            b"\x1b[<288;0;0;1M",
            b"\x1b[<288;0;+1M",
            b"\x1b[<288;0;-M",
            b"\x1b[<288;0;2147483648M",
            b"\x1b[<288;-2147483649;0M",
            b"\x1b[<512;0;0M",
        ] {
            assert!(parse_event(invalid, false).is_err(), "{invalid:?}");
        }
    }

    #[test]
    fn parse_bracketed_paste() {
        // Incomplete input is not considered a paste.
        let event = parse_event(b"\x1b[200~", false).unwrap();
        assert_eq!(event, None);
        let event = parse_event(b"\x1b[200~Hello, world!\x1b[201~", false).unwrap();
        assert_eq!(event, Some(Event::Paste("Hello, world!".to_string())));
        let event = parse_event(b"\x1b[200~\x1b[201~", false).unwrap();
        assert_eq!(event, Some(Event::Paste("".to_string())));
    }
}
