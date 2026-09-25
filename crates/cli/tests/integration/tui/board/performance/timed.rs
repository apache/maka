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

use super::*;

/// PTY receipt is observable; terminal-window presentation is not measured here.
pub(super) struct Timed {
    pub tui: Pty,
    pub visual: Option<visual::Visual>,
    origin: Instant,
    tail: [u8; 8],
    drawing: bool,
    sequence: u64,
    completed_ns: u64,
    parsed_ns: u64,
    chunks: Vec<Value>,
}

impl Timed {
    pub fn new(tui: Pty, origin: Instant) -> Self {
        Self {
            tui,
            visual: None,
            origin,
            tail: [0; 8],
            drawing: false,
            sequence: 0,
            completed_ns: 0,
            parsed_ns: 0,
            chunks: Vec::new(),
        }
    }

    pub fn screen(&self) -> String {
        self.tui.screen.snapshot().unwrap().screen
    }

    pub fn find(&mut self, text: &str) {
        let bytes = format!("\x06\x1b[200~{text}\x1b[201~");
        assert!(self.input(bytes.as_bytes(), |s| s.contains("1/1"))["error"].is_null());
        assert!(self.input(b"\x1b", |s| !s.contains("1/1") && s.contains(text))["error"].is_null());
    }

    pub fn settled(&mut self, proxy: &proxy::DelayProxy, after_watch: bool) -> Value {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            self.read().expect("PTY while settling finite Remote work");
            let mut fence = proxy.fence();
            fence["observed_ns"] = json!(self.origin.elapsed().as_nanos() as u64);
            fence["complete_frame_ns"] = json!(self.completed_ns);
            fence["frame_seq"] = json!(self.sequence);
            if fence["pending_finite_requests"] == 0
                && fence["unowned_documents"] == 0
                && (!after_watch || fence["watch_refresh_settled"] == true)
                && self.completed_ns >= fence["latest_call_reply_ns"].as_u64().unwrap()
                && self.tui.frames.ready()
                && !self.screen().contains("Loading…")
            {
                return fence;
            }
            assert!(
                Instant::now() < deadline,
                "Remote work did not settle: {fence}; screen={}",
                self.screen()
            );
        }
    }

    pub fn source(
        &mut self,
        runtime: &Runtime,
        client: &maka_client::Client,
        proxy: &proxy::DelayProxy,
    ) -> Value {
        let fence = self.settled(proxy, true);
        let stats = runtime.block_on(remote(client, "activity-stats", Value::Null));
        json!({"stats":stats,"fence":fence})
    }

    pub fn input(&mut self, bytes: &[u8], ready: impl Fn(&str) -> bool) -> Value {
        self.observed(bytes, |timed| ready(&timed.screen()))
    }

    pub fn observed(&mut self, bytes: &[u8], ready: impl Fn(&Self) -> bool) -> Value {
        let before = self.sequence;
        self.chunks.clear();
        let start = self.origin.elapsed().as_nanos() as u64;
        self.tui.send(bytes);
        let deadline = Instant::now() + Duration::from_secs(10);
        let error = loop {
            if let Err(error) = self.read() {
                break Some(error);
            }
            if self.sequence > before && self.tui.frames.ready() && ready(self) {
                break None;
            }
            if self.tui.child.try_wait().unwrap().is_some() {
                break Some("TUI exited before expected complete frame".into());
            }
            if Instant::now() >= deadline {
                break Some("expected complete frame timed out after 10 seconds".into());
            }
        };
        json!({"metric":"input_to_complete_pty_frame", "start_ns":start,
            "observed_end_ns":self.origin.elapsed().as_nanos() as u64,
            "complete_frame_ns":self.completed_ns, "parsed_ns":self.parsed_ns,
            "frame_seq_before":before, "frame_seq_after":self.sequence,
            "duration_ns":error.is_none().then(|| self.completed_ns.saturating_sub(start)),
            "error":error, "chunks":std::mem::take(&mut self.chunks)})
    }

    pub fn read(&mut self) -> Result<(), String> {
        let mut poll = libc::pollfd {
            fd: self.tui.master.as_ref().unwrap().as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // poll wakes on readable bytes; 50 ms is a maximum idle wait, not a sleep.
        let available = unsafe { libc::poll(&mut poll, 1, 50) };
        if available < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        if available == 0 {
            return Ok(());
        }
        let mut bytes = [0; 8192];
        let length = self
            .tui
            .master
            .as_mut()
            .unwrap()
            .read(&mut bytes)
            .map_err(|error| error.to_string())?;
        if length == 0 {
            return Err("PTY EOF".into());
        }
        let received_ns = self.origin.elapsed().as_nanos() as u64;
        self.tui.frames.feed(&bytes[..length]);
        for &byte in &bytes[..length] {
            self.tail.copy_within(1.., 0);
            self.tail[7] = byte;
            if &self.tail == b"\x1b[?2026h" {
                self.drawing = true;
            } else if &self.tail == b"\x1b[?2026l" && self.drawing {
                self.drawing = false;
                self.sequence += 1;
                self.completed_ns = received_ns;
            }
        }
        self.tui.pending.extend_from_slice(&bytes[..length]);
        let end = match std::str::from_utf8(&self.tui.pending) {
            Ok(_) => self.tui.pending.len(),
            Err(error) if error.error_len().is_none() => error.valid_up_to(),
            Err(error) => return Err(format!("invalid terminal UTF-8: {error}")),
        };
        let text = std::str::from_utf8(&self.tui.pending[..end]).unwrap();
        if let Some(visual) = &mut self.visual {
            visual.write(text, self.tui.screen.size());
        }
        let reply = self
            .tui
            .screen
            .write(text)
            .map_err(|error| error.to_string())?;
        self.tui.pending.drain(..end);
        self.parsed_ns = self.origin.elapsed().as_nanos() as u64;
        self.chunks
            .push(json!({"bytes":length, "received_ns":received_ns,
            "parsed_ns":self.parsed_ns, "frame_seq":self.sequence}));
        if !reply.is_empty() {
            self.tui.send(reply.as_bytes());
        }
        Ok(())
    }
}

pub(super) fn field_character(screen: &str, row: usize, col: usize, expected: char) -> bool {
    screen.lines().nth(row).is_some_and(|line| {
        line.char_indices()
            .find(|(byte, _)| line[..*byte].width() == col)
            .is_some_and(|(_, character)| character == expected)
    })
}

pub(super) fn position(screen: &str, text: &str) -> (usize, usize) {
    screen
        .lines()
        .enumerate()
        .find_map(|(row, line)| line.find(text).map(|byte| (row, line[..byte].width())))
        .unwrap_or_else(|| panic!("missing {text:?}\n{screen}"))
}

pub(super) fn click(screen: &str, text: &str) -> Vec<u8> {
    let (row, col) = position(screen, text);
    format!(
        "\x1b[<0;{};{}M\x1b[<0;{};{}m",
        col + 1,
        row + 1,
        col + 1,
        row + 1
    )
    .into_bytes()
}
