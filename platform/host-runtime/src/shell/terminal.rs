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

use super::{
    Result, ShellError,
    control::{ControlError, WriteReceipt},
    output::Output,
};
use maka_agent_facts::terminal::TerminalSize;
use maka_agent_facts::terminal::{PREVIEW_BYTES, TerminalScreen, display::Display};
use maka_process::pty::PtyIo;
use maka_process::terminal::Screen;
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

pub(super) struct Terminal {
    screen: Option<Screen>,
    pub preview: Arc<TerminalScreen>,
    frozen: Option<Arc<Display>>,
    incomplete: bool,
    decoder: Decoder,
    pub writes: VecDeque<PendingWrite>,
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
            writes: VecDeque::new(),
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
                if !replies.is_empty() {
                    let pending: usize = self
                        .writes
                        .iter()
                        // Accepted user controls own independent queued custody;
                        // their extent is not an automatic parser reply budget.
                        .filter(|write| write.reply.is_none())
                        .map(|write| write.remaining().len())
                        .sum();
                    if pending.saturating_add(replies.len()) > 1024 * 1024 {
                        self.freeze();
                        return Err(ShellError::Rejected("terminal reply queue exceeds 1 MiB"));
                    }
                    self.writes
                        .push_back(PendingWrite::new(replies, None, false, false));
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

    pub fn fail_writes(&mut self, message: &str) {
        for mut pending in self.writes.drain(..) {
            if let Some(reply) = pending.reply.take() {
                let _ = reply.send(Err(ControlError::new(message, pending.accepted)
                    .after_resize(pending.resized, pending.resize_changed)));
            }
        }
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

pub(super) struct PendingWrite {
    bytes: Vec<u8>,
    pub accepted: usize,
    reply: Option<oneshot::Sender<std::result::Result<WriteReceipt, ControlError>>>,
    resized: bool,
    resize_changed: bool,
}
impl PendingWrite {
    pub fn new(
        text: String,
        reply: Option<oneshot::Sender<std::result::Result<WriteReceipt, ControlError>>>,
        resized: bool,
        resize_changed: bool,
    ) -> Self {
        Self {
            bytes: text.into_bytes(),
            accepted: 0,
            reply,
            resized,
            resize_changed,
        }
    }
    pub fn remaining(&self) -> &[u8] {
        &self.bytes[self.accepted..]
    }
    pub fn advance(&mut self, count: usize) -> bool {
        self.accepted += count;
        self.accepted == self.bytes.len()
    }

    pub fn finish(mut self, record: std::sync::Arc<maka_agent_facts::shell_run::ShellObservation>) {
        if let Some(reply) = self.reply.take() {
            let _ = reply.send(Ok(WriteReceipt {
                accepted_bytes: self.accepted,
                resized: self.resized,
                resize_changed: self.resize_changed,
                record,
            }));
        }
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
        terminal.fail_writes("PTY root exited");
        if count == 0 {
            return failure.map_or(Ok(()), Err);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Decoder;

    #[tokio::test]
    async fn raw_output_preserves_native_bytes_before_screen_decoding() {
        use super::{Output, Terminal};
        use maka_agent_facts::terminal::TerminalSize;

        let size = TerminalSize::new(80, 24).unwrap();
        let output = Output::new(size).unwrap();
        let mut terminal = Terminal::new(size, output.clone());
        // Exercise the actual Host decoder/parser/replay path. These supplied
        // native-byte cuts are not a claim of OS PTY transport verification.
        terminal.output(b"\xff\0\x1b[31m\xe4", false).unwrap();
        terminal.output(b"\xb8\xad\x1b[0m", false).unwrap();
        terminal.output(b"\xe2\x82", true).unwrap();
        let mut stream = output.stream(0).unwrap();
        let mut raw = Vec::new();
        while let super::super::output::PtyStreamEvent::Data { bytes, .. } =
            stream.read(16 * 1024).await.unwrap()
        {
            raw.extend_from_slice(&bytes);
        }
        assert_eq!(
            raw.as_slice(),
            b"\xff\0\x1b[31m\xe4\xb8\xad\x1b[0m\xe2\x82",
            "the raw replay must preserve invalid bytes, NUL, ANSI and incomplete EOF independently of the screen decoder"
        );
    }

    #[tokio::test]
    async fn parser_failure_and_later_drain_preserve_original_raw_bytes() {
        use super::super::output::PtyStreamEvent;
        use super::{Output, Terminal};
        use maka_agent_facts::terminal::TerminalSize;

        let size = TerminalSize::new(80, 24).unwrap();
        let output = Output::new(size).unwrap();
        let mut terminal = Terminal::new(size, output.clone());
        terminal.output(b"\x1b]0;", false).unwrap();
        let chunk = vec![b'x'; 16 * 1024];
        for _ in 0..3 {
            terminal.output(&chunk, false).unwrap();
        }
        assert!(terminal.output(&chunk, false).is_err());
        assert!(terminal.screen.is_none());
        terminal.output(b"final-drain\xff", true).unwrap();
        let mut expected = b"\x1b]0;".to_vec();
        expected.extend_from_slice(&chunk.repeat(4));
        expected.extend_from_slice(b"final-drain\xff");
        let mut stream = output.stream(0).unwrap();
        let mut raw = Vec::new();
        while let PtyStreamEvent::Data { bytes, .. } = stream.read(16 * 1024).await.unwrap() {
            raw.extend_from_slice(&bytes);
        }
        assert_eq!(raw, expected);
    }

    #[test]
    fn large_user_control_does_not_consume_automatic_reply_capacity() {
        use super::{Output, PendingWrite, Terminal};
        use maka_agent_facts::terminal::TerminalSize;
        let size = TerminalSize::new(80, 24).unwrap();
        let output = Output::new(size).unwrap();
        let mut terminal = Terminal::new(size, output);
        let (reply, mut receipt) = tokio::sync::oneshot::channel();
        let input = "x".repeat(1024 * 1024 + 1);
        terminal
            .writes
            .push_back(PendingWrite::new(input.clone(), Some(reply), false, false));
        terminal.output(b"\x1b[6n", false).unwrap();
        assert!(terminal.screen.is_some());
        assert_eq!(terminal.writes.len(), 2);
        assert_eq!(terminal.writes[0].remaining(), input.as_bytes());
        assert!(terminal.writes[0].reply.is_some());
        assert!(terminal.writes[1].reply.is_none());
        assert_eq!(terminal.writes[1].remaining(), b"\x1b[1;1R");
        assert!(matches!(
            receipt.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
    }

    #[test]
    fn every_utf8_cut_matches_lossy_eof_without_losing_terminal_controls() {
        let bytes = b"\x1b[31m\xe4\xb8\xad\xf0\x9f\x98\x80\xff\xe2\x82";
        for first in 0..=bytes.len() {
            for second in first..=bytes.len() {
                let mut decoder = Decoder::default();
                let actual = decoder.decode(&bytes[..first], false)
                    + &decoder.decode(&bytes[first..second], false)
                    + &decoder.decode(&bytes[second..], true);
                assert_eq!(actual, String::from_utf8_lossy(bytes));
                assert!(decoder.pending.is_empty());
            }
        }
    }
}
