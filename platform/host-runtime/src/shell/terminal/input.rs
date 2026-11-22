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

use crate::shell::{
    ShellError,
    control::{ControlError, WriteReceipt},
};
use maka_plugin_core::shell_run::{InitialCommandDelivery, ShellObservation};
use maka_plugin_core::terminal::TerminalScreen;
use maka_plugin_core::terminal::input::{InputAction, encode_actions};
use maka_process::pty::PtyIo;
use std::{collections::VecDeque, future::pending, io, sync::Arc};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

const REPLY_BUDGET: usize = 1024 * 1024;

#[derive(Default)]
pub(in crate::shell) struct TerminalInput {
    queued: VecDeque<PendingWrite>,
    initial: Option<WriteBuffer>,
}

impl TerminalInput {
    pub fn start(
        &mut self,
        source: String,
        screen: &TerminalScreen,
    ) -> Option<InitialCommandDelivery> {
        // The editor's modes are unknown at spawn. Send plain terminal input and Enter.
        let Ok(mut input) =
            encode_actions(&[InputAction::Paste(source)], screen.input, screen.size)
        else {
            return Some(InitialCommandDelivery::NotSubmitted);
        };
        input.push('\r');
        self.initial = Some(WriteBuffer::new(input));
        None
    }

    pub fn enqueue_control(
        &mut self,
        text: String,
        reply: oneshot::Sender<Result<WriteReceipt, ControlError>>,
        resized: bool,
        resize_changed: bool,
    ) {
        self.queued.push_back(PendingWrite {
            buffer: WriteBuffer::new(text),
            reply: Some(ControlReply {
                sender: reply,
                resized,
                resize_changed,
            }),
        });
    }

    pub fn enqueue_replies(&mut self, replies: String) -> Result<(), ShellError> {
        if replies.is_empty() {
            return Ok(());
        }
        // Controller writes have their own custody and do not count toward the reply budget.
        let pending: usize = self
            .queued
            .iter()
            .filter(|write| write.reply.is_none())
            .map(|write| write.buffer.remaining().len())
            .sum();
        if pending.saturating_add(replies.len()) > REPLY_BUDGET {
            return Err(ShellError::Rejected("terminal reply queue exceeds 1 MiB"));
        }
        self.queued.push_back(PendingWrite {
            buffer: WriteBuffer::new(replies),
            reply: None,
        });
        Ok(())
    }

    pub fn controls_ready(&self) -> bool {
        self.queued.is_empty() && self.initial.is_none()
    }

    pub async fn write(
        &self,
        io: &PtyIo,
        cancelled: &CancellationToken,
        eof: bool,
    ) -> io::Result<usize> {
        let Some(bytes) = self.next_write(eof) else {
            return pending().await;
        };
        if self.initial.is_some() {
            // The worker handles cancellation before any further initial input.
            tokio::select! { biased;
                _ = cancelled.cancelled() => pending().await,
                result = io.write(bytes) => result,
            }
        } else {
            io.write(bytes).await
        }
    }

    fn next_write(&self, eof: bool) -> Option<&[u8]> {
        if let Some(buffer) = &self.initial {
            return (!eof).then_some(buffer.remaining());
        }
        self.queued.front().map(|write| write.buffer.remaining())
    }

    pub fn accept(
        &mut self,
        count: usize,
        current_cut: impl FnOnce() -> Arc<ShellObservation>,
    ) -> io::Result<Option<InitialCommandDelivery>> {
        if count == 0 {
            return Err(io::ErrorKind::WriteZero.into());
        }
        if let Some(buffer) = &mut self.initial {
            return Ok(if buffer.advance(count) {
                self.initial = None;
                Some(InitialCommandDelivery::Submitted)
            } else {
                None
            });
        }
        let write = self.queued.front_mut().expect("queued PTY write");
        if write.buffer.advance(count) {
            let write = self.queued.pop_front().expect("completed PTY write");
            if let Some(reply) = write.reply {
                let _ = reply.sender.send(Ok(WriteReceipt {
                    accepted_bytes: write.buffer.accepted,
                    resized: reply.resized,
                    resize_changed: reply.resize_changed,
                    record: current_cut(),
                }));
            }
        }
        Ok(None)
    }

    pub fn interrupt(&mut self) -> Option<InitialCommandDelivery> {
        let initial = self.initial.take()?;
        Some(if initial.accepted > 0 {
            InitialCommandDelivery::Unknown
        } else {
            InitialCommandDelivery::NotSubmitted
        })
    }

    pub fn fail_queued(&mut self, message: &str) {
        for write in self.queued.drain(..) {
            if let Some(reply) = write.reply {
                let _ = reply
                    .sender
                    .send(Err(ControlError::new(message, write.buffer.accepted)
                        .after_resize(reply.resized, reply.resize_changed)));
            }
        }
    }
}

struct PendingWrite {
    buffer: WriteBuffer,
    reply: Option<ControlReply>,
}

struct ControlReply {
    sender: oneshot::Sender<Result<WriteReceipt, ControlError>>,
    resized: bool,
    resize_changed: bool,
}

struct WriteBuffer {
    bytes: Vec<u8>,
    accepted: usize,
}

impl WriteBuffer {
    fn new(text: String) -> Self {
        Self {
            bytes: text.into_bytes(),
            accepted: 0,
        }
    }

    fn remaining(&self) -> &[u8] {
        &self.bytes[self.accepted..]
    }

    fn advance(&mut self, count: usize) -> bool {
        self.accepted += count;
        self.accepted == self.bytes.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_plugin_core::terminal::TerminalSize;

    #[test]
    fn interrupting_a_partial_initial_write_discards_its_remainder() {
        let mut input = TerminalInput::default();
        let screen = TerminalScreen::new(TerminalSize::new(80, 24).unwrap());
        assert_eq!(input.start("echo action".into(), &screen), None);
        input.enqueue_replies("reply".into()).unwrap();

        assert_eq!(input.next_write(false).unwrap(), b"echo action\r");
        assert_eq!(input.accept(5, || unreachable!()).unwrap(), None);
        assert_eq!(input.next_write(false).unwrap(), b"action\r");
        assert!(!input.controls_ready());
        assert!(input.next_write(true).is_none());

        assert_eq!(input.interrupt(), Some(InitialCommandDelivery::Unknown));
        assert_eq!(input.next_write(false).unwrap(), b"reply");
        assert_eq!(input.accept(5, || unreachable!()).unwrap(), None);
        assert!(input.controls_ready());
        assert!(input.next_write(false).is_none());
        assert_eq!(input.interrupt(), None);
    }
}
