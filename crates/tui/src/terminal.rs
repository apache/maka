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
    SynchronizedUpdate,
    cursor::Show,
    event::{
        DisableBracketedPaste, DisableFocusChange, DisableMouseCapture, EnableBracketedPaste,
        EnableFocusChange, EnableMouseCapture,
    },
    execute,
    terminal::{
        EndSynchronizedUpdate, EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode,
        enable_raw_mode,
    },
};
// Native Windows already reports modifiers and key event kinds through WinAPI.
// Crossterm's keyboard enhancement commands are unsupported on that backend.
#[cfg(unix)]
use crossterm::event::{
    KeyboardEnhancementFlags, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use ratatui::{Terminal, backend::CrosstermBackend};
use std::io::{self, IsTerminal, Stdout};

pub const MAX_CLIPBOARD_BYTES: usize = 64 * 1024;

/// OSC 52 is a write request, not confirmation that the terminal accepted it.
/// Never queries clipboard contents or invokes an external clipboard process.
pub fn copy(writer: &mut impl io::Write, text: &str) -> io::Result<()> {
    if text.is_empty() || text.len() > MAX_CLIPBOARD_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid clipboard payload size",
        ));
    }
    write!(writer, "\x1b]52;c;{}\x07", STANDARD.encode(text))?;
    writer.flush()
}

pub type Screen = Terminal<CrosstermBackend<Stdout>>;

/// Publish a whole frame together on terminals with synchronized-output support.
/// Others ignore the mode and retain the usual incremental rendering. End the
/// update even when drawing fails; the terminal guard also ends it after panic.
pub fn draw(screen: &mut Screen, render: impl FnOnce(&mut ratatui::Frame<'_>)) -> io::Result<()> {
    io::stdout().sync_update(|_| screen.draw(render).map(|_| ()))?
}

/// Installed before the first terminal mutation, including partial setup errors.
pub struct Guard;
impl Guard {
    pub fn enter(i18n: &crate::i18n::I18n) -> io::Result<(Self, Screen)> {
        if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
            return Err(io::Error::other(i18n.text("terminal-required")));
        }
        let guard = Self;
        enable_raw_mode()?;
        execute!(
            io::stdout(),
            EnterAlternateScreen,
            EnableMouseCapture,
            EnableFocusChange,
            EnableBracketedPaste
        )?;
        #[cfg(unix)]
        execute!(
            io::stdout(),
            PushKeyboardEnhancementFlags(
                KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
                    | KeyboardEnhancementFlags::REPORT_EVENT_TYPES
            )
        )?;
        let screen = Terminal::new(CrosstermBackend::new(io::stdout()))?;
        Ok((guard, screen))
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        restore();
    }
}
pub fn restore() {
    #[cfg(unix)]
    let _ = execute!(io::stdout(), PopKeyboardEnhancementFlags);
    let _ = execute!(
        io::stdout(),
        EndSynchronizedUpdate,
        DisableBracketedPaste,
        DisableFocusChange,
        DisableMouseCapture,
        LeaveAlternateScreen,
        Show
    );
    let _ = disable_raw_mode();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clipboard_only_writes_bounded_encoded_payloads_and_propagates_writer_failure() {
        let input = "中文 e\u{301} 👩‍💻\n\x1b]52;c;hostile\x07";
        let mut output = vec![];
        copy(&mut output, input).unwrap();
        let encoded = output
            .strip_prefix(b"\x1b]52;c;")
            .unwrap()
            .strip_suffix(b"\x07")
            .unwrap();
        assert_eq!(STANDARD.decode(encoded).unwrap(), input.as_bytes());
        assert!(!encoded.contains(&b'\x1b'));
        for input in [String::new(), "x".repeat(MAX_CLIPBOARD_BYTES + 1)] {
            let mut output = vec![];
            assert!(copy(&mut output, &input).is_err());
            assert!(output.is_empty());
        }
        assert!(copy(&mut io::sink(), &"x".repeat(MAX_CLIPBOARD_BYTES)).is_ok());
        assert!(copy(&mut &mut [0u8; 1][..], "text").is_err());
    }
}
