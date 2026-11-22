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

mod input;

use super::{Result, ShellError, output::Output};
use input::TerminalInput;
use maka_plugin_core::terminal::TerminalSize;
use maka_plugin_core::terminal::{PREVIEW_BYTES, TerminalScreen, display::Display};
use maka_process::pty::PtyIo;
use maka_process::terminal::Screen;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub(super) struct Terminal {
    screen: Option<Screen>,
    pub preview: Arc<TerminalScreen>,
    frozen: Option<Arc<Display>>,
    incomplete: bool,
    decoder: Decoder,
    pub input: TerminalInput,
    output: Output,
}
impl Terminal {
    pub fn new(size: TerminalSize, output: Output) -> Self {
        Self {
            screen: Some(Screen::new(size)),
            preview: Arc::new(TerminalScreen::new(size)),
            frozen: None,
            incomplete: false,
            decoder: Decoder::default(),
            input: TerminalInput::default(),
            output,
        }
    }

    pub fn output(&mut self, bytes: &[u8], eof: bool) -> Result<()> {
        // Native bytes remain observable even when decoding replaces invalid
        // text or the parser has failed and final native output is draining.
        self.output.publish(bytes)?;
        let text = self.decoder.decode(bytes, eof);
        let Some(screen) = &mut self.screen else {
            return Ok(());
        };
        match screen.write(&text) {
            Ok(replies) => {
                self.preview = Arc::new(screen.preview(PREVIEW_BYTES)?);
                if let Err(error) = self.input.enqueue_replies(replies) {
                    self.freeze();
                    return Err(error);
                }
                Ok(())
            }
            Err(error) => {
                // Freeze the applied prefix once, mark it incomplete, then release the parser.
                self.freeze();
                Err(error.into())
            }
        }
    }

    pub fn bracketed_paste(&self) -> bool {
        self.screen.as_ref().is_some_and(Screen::bracketed_paste)
    }

    pub fn resize(&mut self, size: TerminalSize) -> Result<()> {
        let screen = self
            .screen
            .as_mut()
            .ok_or(ShellError::Rejected("terminal parser unavailable"))?;
        screen.resize(size)?;
        self.preview = Arc::new(screen.preview(PREVIEW_BYTES)?);
        Ok(())
    }

    pub fn display(&self) -> Arc<Display> {
        if let Some(screen) = &self.screen {
            let mut display = screen.display();
            display.metadata.truncated |= self.incomplete;
            Arc::new(display)
        } else {
            self.frozen
                .as_ref()
                .expect("failed parser froze its display")
                .clone()
        }
    }

    fn freeze(&mut self) {
        if let Some(screen) = self.screen.take() {
            let mut display = screen.display();
            display.metadata.truncated = true;
            self.frozen = Some(Arc::new(display));
            let mut preview = screen.text_preview(PREVIEW_BYTES);
            preview.truncated = true;
            self.preview = Arc::new(preview);
        }
    }

    pub fn close(&mut self) {
        self.screen = None;
    }
}

/// Retains only the incomplete UTF-8 suffix (at most three bytes). Malformed
/// bytes and a genuinely incomplete EOF use replacement characters, like xterm.
#[derive(Default)]
pub(super) struct Decoder {
    pending: Vec<u8>,
}
impl Decoder {
    pub(super) fn decode(&mut self, bytes: &[u8], eof: bool) -> String {
        self.pending.extend_from_slice(bytes);
        let mut text = String::new();
        let mut consumed = 0;
        while consumed < self.pending.len() {
            match std::str::from_utf8(&self.pending[consumed..]) {
                Ok(valid) => {
                    text.push_str(valid);
                    consumed = self.pending.len();
                }
                Err(error) => {
                    let end = consumed + error.valid_up_to();
                    text.push_str(std::str::from_utf8(&self.pending[consumed..end]).unwrap());
                    consumed = end;
                    match error.error_len() {
                        Some(length) => {
                            text.push('\u{fffd}');
                            consumed += length;
                        }
                        None if eof => {
                            text.push('\u{fffd}');
                            consumed = self.pending.len();
                        }
                        None => break,
                    }
                }
            }
        }
        self.pending.drain(..consumed);
        text
    }
}

pub(super) async fn drain(
    terminal: &mut Terminal,
    io: &PtyIo,
    exited: &CancellationToken,
) -> Result<()> {
    let deadline = async {
        exited.cancelled().await;
        tokio::time::sleep(Duration::from_secs(2)).await;
    };
    tokio::pin!(deadline);
    let mut buffer = [0; 16 * 1024];
    let mut failure = None;
    loop {
        let count = tokio::select! {
            _ = &mut deadline => {
                io.discard_output()?;
                terminal.incomplete = true;
                Arc::make_mut(&mut terminal.preview).truncated = true;
                if let Some(display) = &mut terminal.frozen { Arc::make_mut(display).metadata.truncated = true; }
                return Err(ShellError::Rejected("PTY output did not drain after root exit"));
            }
            read = io.read(&mut buffer) => match read {
                Ok(count) => count,
                Err(error) => { io.discard_output()?; return Err(error.into()); }
            }
        };
        if let Err(error) = terminal.output(&buffer[..count], count == 0) {
            failure.get_or_insert(error);
        }
        // After root exit replies have no consumer and are not input effects.
        terminal.input.fail_queued("PTY root exited");
        if count == 0 {
            return failure.map_or(Ok(()), Err);
        }
    }
}
