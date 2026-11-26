/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

use base64::{Engine, engine::general_purpose::STANDARD};
use crossterm::{
    cursor,
    event::{
        self, DisableBracketedPaste, DisableFocusChange, DisableMouseCapture, EnableBracketedPaste,
        EnableFocusChange, EnableMouseCapture, Event, KeyCode, KeyEventKind, KeyModifiers,
        MouseButton as CtMouseButton, MouseEventKind,
    },
    execute,
    terminal::{self, EnterAlternateScreen, LeaveAlternateScreen},
};
use nsh_core::clipboard::ClipboardBackend;
use nsh_platform_tui::{
    App, AppOptions, AppView, ColorDepth, Input, Modifiers, MouseButton, MouseInput, MouseKind,
    RunEvent, TerminalCapabilities, run_app,
};
use ratatui::{Terminal, backend::CrosstermBackend};
use std::{
    io::{self, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

struct Osc52Clipboard {
    pending: Mutex<Vec<u8>>,
    in_tmux: bool,
}

impl Osc52Clipboard {
    fn new() -> Self {
        Self {
            pending: Mutex::new(Vec::new()),
            in_tmux: std::env::var_os("TMUX").is_some(),
        }
    }

    fn flush_to(&self, out: &mut impl Write) -> io::Result<()> {
        let bytes = {
            let mut guard = self.pending.lock().unwrap();
            if guard.is_empty() {
                return Ok(());
            }
            std::mem::take(&mut *guard)
        };
        out.write_all(&bytes)?;
        out.flush()
    }
}

impl ClipboardBackend for Osc52Clipboard {
    fn text(&self) -> Option<String> {
        None
    }

    fn set_text(&self, text: Option<String>) {
        if let Some(text) = text {
            let encoded = STANDARD.encode(text.as_bytes());
            let seq = if self.in_tmux {
                format!("\x1bPtmux;\x1b\x1b]52;c;{encoded}\x07\x1b\\")
            } else {
                format!("\x1b]52;c;{encoded}\x07")
            };
            self.pending
                .lock()
                .unwrap()
                .extend_from_slice(seq.as_bytes());
        }
    }
}

struct TerminalGuard {
    mouse: bool,
    active: Arc<AtomicBool>,
}

impl TerminalGuard {
    fn enter(mouse: bool) -> io::Result<Self> {
        terminal::enable_raw_mode()?;
        let mut stdout = io::stdout();
        execute!(
            stdout,
            EnterAlternateScreen,
            EnableBracketedPaste,
            EnableFocusChange
        )?;
        if mouse {
            execute!(stdout, EnableMouseCapture)?;
        }
        let active = Arc::new(AtomicBool::new(true));
        let hook_active = active.clone();
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if hook_active.swap(false, Ordering::SeqCst) {
                let _ = restore_terminal(mouse);
            }
            prev(info);
        }));
        Ok(Self { mouse, active })
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        if self.active.swap(false, Ordering::SeqCst) {
            let _ = restore_terminal(self.mouse);
        }
    }
}

fn restore_terminal(mouse: bool) -> io::Result<()> {
    let mut stdout = io::stdout();
    if mouse {
        let _ = execute!(stdout, DisableMouseCapture);
    }
    let _ = execute!(
        stdout,
        DisableFocusChange,
        DisableBracketedPaste,
        cursor::Show,
        LeaveAlternateScreen
    );
    terminal::disable_raw_mode()
}

fn detect_capabilities() -> TerminalCapabilities {
    let mut caps = TerminalCapabilities::default();
    if std::env::var_os("NO_COLOR").is_some() {
        caps.colors = ColorDepth::Monochrome;
        return caps;
    }
    let colorterm = std::env::var("COLORTERM")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let term = std::env::var("TERM")
        .unwrap_or_default()
        .to_ascii_lowercase();
    caps.colors = if colorterm.contains("truecolor") || colorterm.contains("24bit") {
        ColorDepth::TrueColor
    } else if term.contains("256color") {
        ColorDepth::Ansi256
    } else {
        ColorDepth::Ansi16
    };
    caps
}

pub fn run_tui(mut options: AppOptions, no_mouse: bool) -> io::Result<()> {
    let clipboard = Arc::new(Osc52Clipboard::new());
    if options.clipboard.is_none() {
        options.clipboard = Some(clipboard.clone());
    }
    options.capabilities = detect_capabilities();

    let _guard = TerminalGuard::enter(!no_mouse)?;
    let mut view = AppView::new(options);
    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = Terminal::new(backend)?;

    // Prime initial area so Taffy lays out at the actual terminal size.
    terminal.draw(|frame| view.render(frame, frame.area()))?;
    view.load(App::Rust(crate::admin_root()))?;

    run_app(&mut terminal, &mut view, |timeout| {
        clipboard.flush_to(&mut io::stdout())?;
        poll_event(timeout)
    })
}

fn poll_event(timeout: Duration) -> io::Result<RunEvent> {
    let wait = timeout.min(Duration::from_millis(50));
    if !event::poll(wait)? {
        return Ok(RunEvent::Idle);
    }
    match event::read()? {
        Event::Key(key) => {
            if key.modifiers.contains(KeyModifiers::CONTROL)
                && matches!(key.code, KeyCode::Char('c') | KeyCode::Char('C'))
                && key.kind != KeyEventKind::Release
            {
                return Ok(RunEvent::Exit);
            }
            let Some(name) = key_code_name(key.code) else {
                return Ok(RunEvent::Idle);
            };
            let modifiers = map_modifiers(key.modifiers);
            let input = match key.kind {
                KeyEventKind::Repeat => Input::KeyRepeat {
                    key: name,
                    modifiers,
                },
                KeyEventKind::Release => Input::Key {
                    key: name,
                    modifiers,
                    release: true,
                },
                KeyEventKind::Press => Input::Key {
                    key: name,
                    modifiers,
                    release: false,
                },
            };
            Ok(RunEvent::Input(input))
        }
        Event::Mouse(mouse) => {
            let mut input = MouseInput::default();
            input.column = mouse.column;
            input.row = mouse.row;
            input.modifiers = map_modifiers(mouse.modifiers);
            input.kind = match mouse.kind {
                MouseEventKind::Down(btn) => MouseKind::Down(map_button(btn)),
                MouseEventKind::Up(btn) => MouseKind::Up(map_button(btn)),
                MouseEventKind::Drag(_) | MouseEventKind::Moved => MouseKind::Move,
                MouseEventKind::ScrollUp => MouseKind::Wheel { x: 0, y: -1 },
                MouseEventKind::ScrollDown => MouseKind::Wheel { x: 0, y: 1 },
                MouseEventKind::ScrollLeft => MouseKind::Wheel { x: -1, y: 0 },
                MouseEventKind::ScrollRight => MouseKind::Wheel { x: 1, y: 0 },
            };
            Ok(RunEvent::Input(Input::Mouse(input)))
        }
        Event::Paste(text) => Ok(RunEvent::Input(Input::Paste(text))),
        Event::FocusGained => Ok(RunEvent::Input(Input::Focus(true))),
        Event::FocusLost => Ok(RunEvent::Input(Input::Focus(false))),
        Event::Resize(_, _) => Ok(RunEvent::Redraw),
    }
}

fn map_modifiers(mods: KeyModifiers) -> Modifiers {
    Modifiers {
        ctrl: mods.contains(KeyModifiers::CONTROL),
        alt: mods.contains(KeyModifiers::ALT),
        shift: mods.contains(KeyModifiers::SHIFT),
        cmd: mods.contains(KeyModifiers::SUPER),
        alt_graph: false,
    }
}

fn map_button(btn: CtMouseButton) -> MouseButton {
    match btn {
        CtMouseButton::Left => MouseButton::Left,
        CtMouseButton::Right => MouseButton::Right,
        CtMouseButton::Middle => MouseButton::Middle,
    }
}

fn key_code_name(code: KeyCode) -> Option<String> {
    let s = match code {
        KeyCode::Char(c) => return Some(c.to_string()),
        KeyCode::Enter => "Enter",
        KeyCode::Esc => "Escape",
        KeyCode::Tab | KeyCode::BackTab => "Tab",
        KeyCode::Backspace => "Backspace",
        KeyCode::Delete => "Delete",
        KeyCode::Insert => "Insert",
        KeyCode::Up => "ArrowUp",
        KeyCode::Down => "ArrowDown",
        KeyCode::Left => "ArrowLeft",
        KeyCode::Right => "ArrowRight",
        KeyCode::Home => "Home",
        KeyCode::End => "End",
        KeyCode::PageUp => "PageUp",
        KeyCode::PageDown => "PageDown",
        KeyCode::F(n) => return Some(format!("F{n}")),
        _ => return None,
    };
    Some(s.to_owned())
}
