use std::{
    cell::RefCell,
    io::{self, Write},
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use nsh_platform_tui::{
    ColorDepth, CursorStyle, Input, Modifiers, MouseButton, MouseInput, MouseKind, RunEvent,
    TerminalCapabilities,
};
use ratatui_crossterm::crossterm::{cursor, event, execute, style::Print, terminal};

const ENABLE_ALTERNATE_SCROLL: &str = "\x1b[?1007h";
const DISABLE_ALTERNATE_SCROLL: &str = "\x1b[?1007l";
// Crossterm's use-dev-tty reader skips both input and buffered parser events at
// zero timeout. Give it a positive budget even when another frame is already due.
#[cfg(unix)]
const DECODE_POLL: Duration = Duration::from_micros(50);
/// How long startup waits for the terminal to answer its queries. Every terminal
/// answers the primary device attributes (DA1), which ends the wait earlier.
/// Remote terminals can answer after a network round trip; an answer that arrives
/// after the host stops reading reaches the app as typed input.
#[cfg(unix)]
const QUERY_TIMEOUT: Duration = Duration::from_secs(1);
/// The default foreground (OSC 10) and background (OSC 11), the kitty keyboard
/// protocol's flags (`CSI ? u`), synchronized output (DECRQM 2026) and DA1 last:
/// its answer closes the replies.
#[cfg(unix)]
const QUERY: &[u8] = b"\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b[?u\x1b[?2026$p\x1b[c";

#[cfg(unix)]
mod unix;

#[cfg(all(test, unix))]
mod input_tests;

/// What restoration must undo; shared with the panic hook.
#[derive(Default)]
struct Modes {
    active: AtomicBool,
    keyboard: AtomicBool,
}

pub(crate) struct Session {
    modes: Arc<Modes>,
    capabilities: TerminalCapabilities,
    synchronized: bool,
    mouse: bool,
    #[cfg(unix)]
    _transport: unix::Transport,
}

pub(crate) struct Output;

/// What ratatui writes for one frame, collected by [`FrameWriter`] and
/// written by [`Frames::commit`] between frames: as one synchronized update
/// (`?2026`), so the terminal shows a frame whole, and not at all when the
/// frame changes nothing on the screen.
pub(crate) struct Frames<W> {
    inner: W,
    pending: Rc<RefCell<Vec<u8>>>,
    /// The last frame written, to recognize one that only repeats its cursor.
    last: Vec<u8>,
    synchronized: bool,
}

/// The frame buffer ratatui's backend writes into; [`Frames`] owns its output.
pub(crate) struct FrameWriter(Rc<RefCell<Vec<u8>>>);

impl Write for FrameWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.borrow_mut().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    // Ratatui flushes after its cursor commands within a frame too: the
    // frame ends at `Frames::commit`, never here.
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<W: Write> Frames<W> {
    /// Frames for `inner`, wrapped in synchronized updates when `synchronized`.
    pub(crate) fn new(inner: W, synchronized: bool) -> (Self, FrameWriter) {
        let pending = Rc::new(RefCell::new(Vec::new()));
        let frames = Self {
            inner,
            pending: pending.clone(),
            last: Vec::new(),
            synchronized,
        };
        (frames, FrameWriter(pending))
    }

    /// Writes the frame drawn since the last commit, if it changes anything.
    pub(crate) fn commit(&mut self) -> io::Result<()> {
        let frame = std::mem::take(&mut *self.pending.borrow_mut());
        if frame.is_empty() || (cursor_only(&frame) && self.last.ends_with(&frame)) {
            return Ok(());
        }
        if self.synchronized {
            execute!(self.inner, terminal::BeginSynchronizedUpdate)?;
        }
        self.inner.write_all(&frame)?;
        if self.synchronized {
            execute!(self.inner, terminal::EndSynchronizedUpdate)?;
        }
        self.inner.flush()?;
        self.last = frame;
        Ok(())
    }
}

/// Whether `bytes` are only the cursor commands ratatui ends every frame with:
/// show (`CSI ? 25 h`), hide (`CSI ? 25 l`) and move (`CSI row ; column H`).
/// Repeating the previous frame's last ones leaves the screen as it is.
fn cursor_only(bytes: &[u8]) -> bool {
    let mut rest = bytes;
    while !rest.is_empty() {
        let Some(body) = rest.strip_prefix(b"\x1b[") else {
            return false;
        };
        let Some(end) = body.iter().position(|b| (0x40..=0x7e).contains(b)) else {
            return false;
        };
        let (params, last) = (&body[..end], body[end]);
        let cursor = match last {
            b'h' | b'l' => params == b"?25",
            b'H' => params.iter().all(|&b| b.is_ascii_digit() || b == b';'),
            _ => false,
        };
        if !cursor {
            return false;
        }
        rest = &body[end + 1..];
    }
    true
}

/// Whether to wrap frames in synchronized updates. Terminals without the mode
/// ignore it, but tmux may pass it to a terminal while drawing on its own: inside
/// tmux (`TMUX` set) only when tmux answered DECRQM 2026 with the mode known.
pub(crate) fn synchronized_output(replies: &Replies, var: impl Fn(&str) -> Option<String>) -> bool {
    var("TMUX").is_none_or(|value| value.is_empty()) || replies.synchronized
}

impl Write for Output {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        #[cfg(unix)]
        {
            unix::write(bytes)
        }
        #[cfg(not(unix))]
        {
            io::stdout().write(bytes)
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        #[cfg(unix)]
        {
            Ok(())
        }
        #[cfg(not(unix))]
        {
            io::stdout().flush()
        }
    }
}

fn restore(modes: &Modes) {
    if !modes.active.swap(false, Ordering::AcqRel) {
        return;
    }
    let mut bytes = Vec::new();
    if modes.keyboard.swap(false, Ordering::AcqRel) {
        let _ = execute!(bytes, event::PopKeyboardEnhancementFlags);
    }
    let _ = execute!(
        bytes,
        terminal::EndSynchronizedUpdate,
        event::DisableMouseCapture,
        event::DisableBracketedPaste,
        event::DisableFocusChange,
        Print(DISABLE_ALTERNATE_SCROLL),
        cursor::SetCursorStyle::DefaultUserShape,
        terminal::LeaveAlternateScreen,
        cursor::Show
    );
    #[cfg(unix)]
    unix::restore(&bytes);
    #[cfg(not(unix))]
    {
        let _ = io::stdout().write_all(&bytes);
        let _ = io::stdout().flush();
    }
    let _ = terminal::disable_raw_mode();
}

impl Session {
    pub(crate) fn is_active(&self) -> bool {
        self.modes.active.load(Ordering::Acquire)
    }

    /// What the terminal answered at startup, with the color depth from the environment.
    pub(crate) fn capabilities(&self) -> TerminalCapabilities {
        self.capabilities.clone()
    }

    /// Whether frames are written as synchronized updates (`synchronized_output`).
    pub(crate) fn synchronized(&self) -> bool {
        self.synchronized
    }

    /// Turns the input modes on again: a terminal coming back to focus (a
    /// multiplexer's pane or tab switch) may have reset them.
    pub(crate) fn reassert(&self) -> io::Result<()> {
        execute!(
            Output,
            event::EnableBracketedPaste,
            event::EnableFocusChange
        )?;
        if self.mouse {
            execute!(Output, event::EnableMouseCapture)?;
        }
        Ok(())
    }

    /// Enters raw mode and the alternate screen. With `mouse`, the terminal reports
    /// every press, release, drag and motion (any-event tracking, SGR coordinates).
    pub(crate) fn enter(mouse: bool) -> io::Result<Self> {
        let mut session = Self {
            modes: Arc::new(Modes::default()),
            capabilities: TerminalCapabilities::default(),
            synchronized: false,
            mouse,
            #[cfg(unix)]
            _transport: unix::Transport::enter()?,
        };
        session.modes.active.store(true, Ordering::Release);
        let previous = std::panic::take_hook();
        let modes = session.modes.clone();
        std::panic::set_hook(Box::new(move |panic| {
            restore(&modes);
            previous(panic);
        }));
        terminal::enable_raw_mode()?;
        // Before crossterm's reader exists, so the replies are the host's to read.
        #[cfg(unix)]
        let replies = unix::query(QUERY, QUERY_TIMEOUT)
            .map(|bytes| parse_replies(&bytes))
            .unwrap_or_default();
        #[cfg(not(unix))]
        let replies = Replies::default();
        session.capabilities = capabilities(&replies, |name| std::env::var(name).ok());
        session.synchronized = synchronized_output(&replies, |name| std::env::var(name).ok());
        execute!(
            Output,
            terminal::EnterAlternateScreen,
            Print(ENABLE_ALTERNATE_SCROLL),
            cursor::Hide
        )?;
        // Optional modes: a terminal without them ignores the sequences.
        let _ = execute!(
            Output,
            event::EnableBracketedPaste,
            event::EnableFocusChange
        );
        if keyboard_protocol(&replies, |name| std::env::var(name).ok()) {
            execute!(
                Output,
                event::PushKeyboardEnhancementFlags(
                    event::KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
                        | event::KeyboardEnhancementFlags::REPORT_EVENT_TYPES
                        | event::KeyboardEnhancementFlags::REPORT_ALTERNATE_KEYS
                )
            )?;
            session.modes.keyboard.store(true, Ordering::Release);
            session.capabilities.command_key = true;
        }
        if mouse {
            execute!(Output, event::EnableMouseCapture)?;
        }
        Ok(session)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        restore(&self.modes);
    }
}

/// Writes the cursor shape a frame asks for: a steady bar while a field is edited.
pub(crate) fn set_cursor_style(style: CursorStyle) -> io::Result<()> {
    match style {
        CursorStyle::Bar => execute!(Output, cursor::SetCursorStyle::SteadyBar),
        _ => execute!(Output, cursor::SetCursorStyle::DefaultUserShape),
    }
}

/// The terminal's answers to the startup queries.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Replies {
    pub(crate) foreground: Option<[u8; 3]>,
    pub(crate) background: Option<[u8; 3]>,
    /// The terminal answered the kitty keyboard protocol's flags query.
    pub(crate) keyboard: bool,
    /// The terminal reported synchronized output (mode 2026) set or reset.
    pub(crate) synchronized: bool,
    /// The primary device attributes arrived: no further answer will come.
    pub(crate) complete: bool,
}

/// Reads OSC 10 / 11 color answers (`ESC ] 1x ; rgb:RRRR/GGGG/BBBB` ended by ST or BEL),
/// the kitty flags answer (`CSI ? flags u`), the mode 2026 report (`CSI ? 2026 ; Ps $ y`)
/// and DA1 (`CSI ? … c`) from `bytes`.
pub(crate) fn parse_replies(bytes: &[u8]) -> Replies {
    let mut replies = Replies::default();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] != 0x1b {
            i += 1;
            continue;
        }
        match bytes[i + 1] {
            b']' => {
                let body = &bytes[i + 2..];
                let end = body
                    .iter()
                    .position(|&b| b == 0x07 || b == 0x1b)
                    .unwrap_or(body.len());
                let text = String::from_utf8_lossy(&body[..end]);
                if let Some((code, value)) = text.split_once(';') {
                    let color = parse_color(value);
                    match code {
                        "10" => replies.foreground = color.or(replies.foreground),
                        "11" => replies.background = color.or(replies.background),
                        _ => {}
                    }
                }
                i += 2 + end;
            }
            b'[' => {
                let body = &bytes[i + 2..];
                let Some(end) = body.iter().position(|b| (0x40..=0x7e).contains(b)) else {
                    break;
                };
                if body.first() == Some(&b'?') {
                    match body[end] {
                        b'u' => replies.keyboard = true,
                        b'c' => replies.complete = true,
                        // Ps 1 / 2: set / reset, 3 / 4: permanently so, 0: unknown.
                        b'y' => {
                            if let Some(value) = body[1..end].strip_prefix(b"2026;") {
                                replies.synchronized |= matches!(value, b"1$" | b"2$" | b"3$");
                            }
                        }
                        _ => {}
                    }
                }
                i += 3 + end;
            }
            _ => i += 1,
        }
    }
    replies
}

/// An X11 color specification as terminals answer it: `rgb:` (or `rgba:`) with one to
/// four hex digits per channel, scaled to eight bits.
fn parse_color(value: &str) -> Option<[u8; 3]> {
    let channels = value
        .strip_prefix("rgb:")
        .or_else(|| value.strip_prefix("rgba:"))?;
    let mut out = [0; 3];
    let mut parts = channels.split('/');
    for slot in &mut out {
        let part = parts.next()?;
        if part.is_empty() || part.len() > 4 {
            return None;
        }
        let value = u32::from_str_radix(part, 16).ok()?;
        let max = (1u32 << (4 * part.len())) - 1;
        *slot = ((value * 255 + max / 2) / max) as u8;
    }
    Some(out)
}

/// The capabilities from the startup answers and the environment: `NSH_TUI_COLORS`
/// (`truecolor`, `256`, `16` or `mono`) wins, then `NO_COLOR` (no colors at
/// all, as no-color.org asks), then `COLORTERM`, then `TERM`. Hyperlinks are
/// drawn everywhere but the Linux console (`TERM=linux`).
pub(crate) fn capabilities(
    replies: &Replies,
    var: impl Fn(&str) -> Option<String>,
) -> TerminalCapabilities {
    let mut capabilities = TerminalCapabilities::default();
    capabilities.foreground_color = replies.foreground;
    capabilities.background_color = replies.background;
    if let Some([r, g, b]) = replies.background {
        let linear = |c: u8| {
            let c = f32::from(c) / 255.0;
            if c <= 0.04045 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        };
        let luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
        capabilities.background = if luminance > 0.4 {
            nsh_core::platform::ColorScheme::Light
        } else {
            nsh_core::platform::ColorScheme::Dark
        };
    }
    let lower = |name| var(name).map(|value| value.to_ascii_lowercase());
    // The Linux console prints an OSC 8 sequence instead of ignoring it.
    capabilities.hyperlinks = !lower("TERM").is_some_and(|term| term.starts_with("linux"));
    capabilities.colors = match lower("NSH_TUI_COLORS").as_deref() {
        Some("truecolor" | "24bit") => ColorDepth::TrueColor,
        Some("256") => ColorDepth::Ansi256,
        Some("16") => ColorDepth::Ansi16,
        Some("mono" | "none") => ColorDepth::Monochrome,
        _ if var("NO_COLOR").is_some_and(|value| !value.is_empty()) => ColorDepth::Monochrome,
        _ => {
            if lower("COLORTERM").is_some_and(|c| c == "truecolor" || c == "24bit")
                || truecolor_brand(&var)
            {
                ColorDepth::TrueColor
            } else if lower("TERM").is_some_and(|term| term.contains("256color")) {
                ColorDepth::Ansi256
            } else {
                ColorDepth::Ansi16
            }
        }
    };
    capabilities
}

/// Whether the environment names a terminal known to draw 24-bit color:
/// tmux, SSH and mosh often drop `COLORTERM`, while these keep their own
/// markers (as grok-build's color detection reads them).
fn truecolor_brand(var: &impl Fn(&str) -> Option<String>) -> bool {
    let program = var("TERM_PROGRAM").map(|value| value.to_ascii_lowercase());
    let term = var("TERM")
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    matches!(
        program.as_deref(),
        Some("iterm.app" | "ghostty" | "wezterm" | "vscode" | "warpterminal" | "rio" | "alacritty")
    ) || [
        "KITTY_WINDOW_ID",
        "ALACRITTY_WINDOW_ID",
        "WEZTERM_EXECUTABLE",
        "GHOSTTY_RESOURCES_DIR",
        "WT_SESSION",
    ]
    .iter()
    .any(|name| var(name).is_some_and(|value| !value.is_empty()))
        || ["kitty", "alacritty", "ghostty", "foot", "wezterm", "rio"]
            .iter()
            .any(|brand| term.contains(brand))
}

/// Whether to push the kitty keyboard flags: the terminal answered their
/// query, and it is none of those whose answer overstates what they do
/// (Apple's Terminal, VS Code's xterm.js, VTE) or a tmux before 3.3.
pub(crate) fn keyboard_protocol(replies: &Replies, var: impl Fn(&str) -> Option<String>) -> bool {
    if !replies.keyboard || var("VTE_VERSION").is_some_and(|v| !v.is_empty()) {
        return false;
    }
    match var("TERM_PROGRAM").as_deref() {
        Some("Apple_Terminal" | "vscode") => false,
        Some("tmux") => var("TERM_PROGRAM_VERSION").is_some_and(|version| {
            let mut parts = version.split(|c: char| !c.is_ascii_digit());
            let major: u32 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
            let minor: u32 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
            (major, minor) >= (3, 3)
        }),
        _ => true,
    }
}

pub(crate) fn poll(timeout: Duration) -> io::Result<RunEvent> {
    if crate::shutdown::requested() {
        return Ok(RunEvent::Exit);
    }
    #[cfg(unix)]
    if unix::disconnected()? {
        return Ok(RunEvent::Exit);
    }
    #[cfg(unix)]
    let timeout = timeout.max(DECODE_POLL);
    // filedescriptor's non-macOS poll truncates milliseconds and spins through
    // the remainder. Bound decoding and let run_app sleep the rest of its wait.
    #[cfg(all(unix, not(target_os = "macos")))]
    let timeout = timeout.min(DECODE_POLL);
    let available = event::poll(timeout)?;
    if crate::shutdown::requested() {
        return Ok(RunEvent::Exit);
    }
    #[cfg(unix)]
    if unix::disconnected()? {
        return Ok(RunEvent::Exit);
    }
    if available {
        // A successful poll queues the event, so this read does not wait on the terminal.
        Ok(convert(event::read()?))
    } else {
        Ok(RunEvent::Idle)
    }
}

fn modifiers(keys: event::KeyModifiers) -> Modifiers {
    Modifiers {
        ctrl: keys.contains(event::KeyModifiers::CONTROL),
        alt: keys.contains(event::KeyModifiers::ALT),
        shift: keys.contains(event::KeyModifiers::SHIFT),
        cmd: keys.contains(event::KeyModifiers::SUPER),
    }
}

fn button(button: event::MouseButton) -> MouseButton {
    match button {
        event::MouseButton::Left => MouseButton::Left,
        event::MouseButton::Right => MouseButton::Right,
        event::MouseButton::Middle => MouseButton::Middle,
    }
}

/// Converts host transport events; terminal resize is a redraw, never view input.
pub fn convert(event: event::Event) -> RunEvent {
    match event {
        event::Event::Resize(..) => RunEvent::Redraw,
        event::Event::FocusGained => RunEvent::Input(Input::Focus(true)),
        event::Event::FocusLost => RunEvent::Input(Input::Focus(false)),
        event::Event::Paste(text) => RunEvent::Input(Input::Paste(text)),
        event::Event::Mouse(mouse) => {
            let mut input = MouseInput::default();
            input.column = mouse.column;
            input.row = mouse.row;
            input.modifiers = modifiers(mouse.modifiers);
            input.kind = match mouse.kind {
                event::MouseEventKind::Down(b) => MouseKind::Down(button(b)),
                event::MouseEventKind::Up(b) => MouseKind::Up(button(b)),
                event::MouseEventKind::Moved | event::MouseEventKind::Drag(_) => MouseKind::Move,
                event::MouseEventKind::ScrollUp => MouseKind::Wheel { x: 0, y: -1 },
                event::MouseEventKind::ScrollDown => MouseKind::Wheel { x: 0, y: 1 },
                event::MouseEventKind::ScrollLeft => MouseKind::Wheel { x: -1, y: 0 },
                event::MouseEventKind::ScrollRight => MouseKind::Wheel { x: 1, y: 0 },
            };
            RunEvent::Input(Input::Mouse(input))
        }
        event::Event::Key(key) => {
            // Ctrl+C reaches the surface: it copies a selection there, else
            // the terminal Key scheme quits.
            let release = key.kind == event::KeyEventKind::Release;
            let name = match key.code {
                event::KeyCode::Char(c) => c.to_string(),
                event::KeyCode::Esc => "Escape".into(),
                event::KeyCode::BackTab => "Tab".into(),
                event::KeyCode::F(number) => format!("F{number}"),
                other => format!("{other:?}"),
            };
            let mut modifiers = modifiers(key.modifiers);
            if key.code == event::KeyCode::BackTab {
                modifiers.shift = true;
            }
            if key.kind == event::KeyEventKind::Repeat {
                RunEvent::Input(Input::KeyRepeat {
                    key: name,
                    modifiers,
                })
            } else {
                RunEvent::Input(Input::Key {
                    key: name,
                    modifiers,
                    release,
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mouse_conversion_keeps_absolute_coordinates_and_modifiers() {
        let event = event::Event::Mouse(event::MouseEvent {
            kind: event::MouseEventKind::Down(event::MouseButton::Left),
            column: 17,
            row: 9,
            modifiers: event::KeyModifiers::SHIFT,
        });
        let RunEvent::Input(Input::Mouse(mouse)) = convert(event) else {
            panic!("expected mouse");
        };
        assert_eq!((mouse.column, mouse.row), (17, 9));
        assert!(mouse.modifiers.shift);
        assert_eq!(mouse.kind, MouseKind::Down(MouseButton::Left));
    }

    #[test]
    fn resize_is_a_redraw_and_control_c_reaches_the_surface() {
        assert!(matches!(
            convert(event::Event::Resize(80, 24)),
            RunEvent::Redraw
        ));
        let mut key = event::KeyEvent::new(event::KeyCode::Char('c'), event::KeyModifiers::CONTROL);
        assert!(matches!(
            convert(event::Event::Key(key)),
            RunEvent::Input(Input::Key { release: false, ref key, modifiers, .. })
                if key == "c" && modifiers.ctrl
        ));
        key.kind = event::KeyEventKind::Release;
        assert!(matches!(
            convert(event::Event::Key(key)),
            RunEvent::Input(Input::Key { release: true, .. })
        ));
    }

    #[test]
    fn control_meta_and_navigation_keys_keep_their_identity() {
        for (code, held, name) in [
            (event::KeyCode::Char('n'), event::KeyModifiers::CONTROL, "n"),
            (event::KeyCode::Char('v'), event::KeyModifiers::ALT, "v"),
            (event::KeyCode::Char('<'), event::KeyModifiers::ALT, "<"),
            (
                event::KeyCode::PageDown,
                event::KeyModifiers::NONE,
                "PageDown",
            ),
            (event::KeyCode::BackTab, event::KeyModifiers::NONE, "Tab"),
        ] {
            let RunEvent::Input(Input::Key {
                key,
                modifiers,
                release,
            }) = convert(event::Event::Key(event::KeyEvent::new(code, held)))
            else {
                panic!("key input");
            };
            assert_eq!(key, name);
            assert_eq!(modifiers.ctrl, held.contains(event::KeyModifiers::CONTROL));
            assert_eq!(modifiers.alt, held.contains(event::KeyModifiers::ALT));
            assert_eq!(modifiers.shift, code == event::KeyCode::BackTab);
            assert!(!release);
        }
        let key = event::KeyEvent::new_with_kind(
            event::KeyCode::Char('n'),
            event::KeyModifiers::CONTROL,
            event::KeyEventKind::Repeat,
        );
        assert!(matches!(
            convert(event::Event::Key(key)),
            RunEvent::Input(Input::KeyRepeat { .. })
        ));
    }

    #[test]
    fn startup_replies_give_the_default_colors_and_keyboard_protocol() {
        let replies = parse_replies(
            b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\\x1b]11;rgb:1e1e/2020/3030\x07\x1b[?1u\x1b[?62;22c",
        );
        assert_eq!(replies.foreground, Some([255, 255, 255]));
        assert_eq!(replies.background, Some([0x1e, 0x20, 0x30]));
        assert!(replies.keyboard && replies.complete);
        // Short channels scale to eight bits; a terminal answering only DA1 has neither.
        assert_eq!(parse_color("rgb:f/8/0"), Some([255, 136, 0]));
        assert_eq!(
            parse_replies(b"\x1b[?1;2c"),
            Replies {
                complete: true,
                ..Default::default()
            }
        );
        assert!(!parse_replies(b"\x1b]11;rgb:00").complete);
    }

    /// An environment of `pairs`.
    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name: &str| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.to_string())
        }
    }

    #[test]
    fn capabilities_follow_the_background_and_the_environment() {
        let light = Replies {
            background: Some([0xfd, 0xf6, 0xe3]),
            ..Default::default()
        };
        let found = capabilities(&light, env(&[("COLORTERM", "truecolor")]));
        assert_eq!(found.background, nsh_core::platform::ColorScheme::Light);
        assert_eq!(found.background_color, Some([0xfd, 0xf6, 0xe3]));
        assert_eq!(found.colors, ColorDepth::TrueColor);
        let dark = capabilities(&Replies::default(), env(&[("TERM", "xterm-256color")]));
        assert_eq!(dark.background, nsh_core::platform::ColorScheme::Dark);
        assert_eq!(dark.colors, ColorDepth::Ansi256);
        assert!(dark.hyperlinks);
        assert!(!capabilities(&Replies::default(), env(&[("TERM", "linux")])).hyperlinks);
        assert_eq!(
            capabilities(&Replies::default(), env(&[("TERM", "xterm")])).colors,
            ColorDepth::Ansi16
        );
        assert_eq!(
            capabilities(
                &Replies::default(),
                env(&[("COLORTERM", "truecolor"), ("NSH_TUI_COLORS", "16")])
            )
            .colors,
            ColorDepth::Ansi16
        );
        // NO_COLOR takes every color away, whatever the terminal draws;
        // NSH_TUI_COLORS still names a depth.
        assert_eq!(
            capabilities(
                &Replies::default(),
                env(&[("COLORTERM", "truecolor"), ("NO_COLOR", "1")])
            )
            .colors,
            ColorDepth::Monochrome
        );
        assert_eq!(
            capabilities(
                &Replies::default(),
                env(&[("NO_COLOR", "1"), ("NSH_TUI_COLORS", "256")])
            )
            .colors,
            ColorDepth::Ansi256
        );
        assert_eq!(
            capabilities(
                &Replies::default(),
                env(&[("NO_COLOR", ""), ("TERM", "xterm")])
            )
            .colors,
            ColorDepth::Ansi16
        );
        // tmux and SSH drop COLORTERM; the terminal's own markers remain.
        for vars in [
            &[("TERM_PROGRAM", "ghostty"), ("TERM", "xterm-256color")][..],
            &[("KITTY_WINDOW_ID", "1"), ("TERM", "tmux-256color")],
            &[("TERM", "xterm-kitty")],
            &[("WT_SESSION", "abc")],
        ] {
            assert_eq!(
                capabilities(&Replies::default(), env(vars)).colors,
                ColorDepth::TrueColor,
                "{vars:?}"
            );
        }
        assert_eq!(
            capabilities(
                &Replies::default(),
                env(&[("TERM_PROGRAM", "Apple_Terminal")])
            )
            .colors,
            ColorDepth::Ansi16
        );
    }

    #[test]
    fn the_keyboard_protocol_is_pushed_where_its_answer_holds() {
        let answered = Replies {
            keyboard: true,
            ..Replies::default()
        };
        assert!(keyboard_protocol(
            &answered,
            env(&[("TERM_PROGRAM", "kitty")])
        ));
        assert!(!keyboard_protocol(&Replies::default(), env(&[])));
        for vars in [
            &[("TERM_PROGRAM", "Apple_Terminal")][..],
            &[("TERM_PROGRAM", "vscode")],
            &[("VTE_VERSION", "7600")],
            &[("TERM_PROGRAM", "tmux"), ("TERM_PROGRAM_VERSION", "3.2a")],
        ] {
            assert!(!keyboard_protocol(&answered, env(vars)), "{vars:?}");
        }
        assert!(keyboard_protocol(
            &answered,
            env(&[("TERM_PROGRAM", "tmux"), ("TERM_PROGRAM_VERSION", "3.4")])
        ));
    }

    #[test]
    fn each_frame_is_one_synchronized_update_and_unchanged_frames_write_nothing() {
        let (mut frames, mut writer) = Frames::new(Vec::new(), true);
        writer.write_all(b"\x1b[1;1Hab").unwrap();
        writer.flush().unwrap();
        writer.write_all(b"\x1b[?25l").unwrap();
        frames.commit().unwrap();
        assert_eq!(frames.inner, b"\x1b[?2026h\x1b[1;1Hab\x1b[?25l\x1b[?2026l");
        // A frame with no Cell changed repeats the last cursor commands: nothing is written.
        frames.inner.clear();
        writer.write_all(b"\x1b[?25l").unwrap();
        frames.commit().unwrap();
        frames.commit().unwrap();
        assert!(frames.inner.is_empty());
        // A changed cursor is written.
        writer.write_all(b"\x1b[?25h\x1b[2;3H").unwrap();
        frames.commit().unwrap();
        assert_eq!(frames.inner, b"\x1b[?2026h\x1b[?25h\x1b[2;3H\x1b[?2026l");
        let (mut plain, mut writer) = Frames::new(Vec::new(), false);
        writer.write_all(b"abc").unwrap();
        plain.commit().unwrap();
        assert_eq!(plain.inner, b"abc");
    }

    #[test]
    fn tmux_gets_synchronized_output_only_when_it_reports_the_mode() {
        let tmux = env(&[("TMUX", "/tmp/tmux-1/default,1,0")]);
        assert!(synchronized_output(&Replies::default(), env(&[])));
        assert!(!synchronized_output(&Replies::default(), &tmux));
        let replies = parse_replies(b"\x1b[?2026;2$y\x1b[?1;2c");
        assert!(replies.synchronized && replies.complete);
        assert!(synchronized_output(&replies, &tmux));
        assert!(!parse_replies(b"\x1b[?2026;0$y").synchronized);
    }

    #[test]
    #[ignore = "requires an interactive terminal"]
    fn normal_exit_restores_raw_mode() {
        assert!(!terminal::is_raw_mode_enabled().unwrap());
        let session = Session::enter(false).unwrap();
        assert!(terminal::is_raw_mode_enabled().unwrap());
        drop(session);
        assert!(!terminal::is_raw_mode_enabled().unwrap());
    }

    #[test]
    #[ignore = "requires an interactive terminal"]
    fn panic_restores_raw_mode() {
        assert!(!terminal::is_raw_mode_enabled().unwrap());
        let result = std::panic::catch_unwind(|| {
            let _session = Session::enter(false).unwrap();
            panic!("terminal restoration test");
        });
        assert!(result.is_err());
        assert!(!terminal::is_raw_mode_enabled().unwrap());
    }
}
