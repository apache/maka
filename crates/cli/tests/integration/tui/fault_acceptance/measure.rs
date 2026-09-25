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
use sha2::{Digest, Sha256};

pub(crate) struct Log {
    file: Option<File>,
    pub smoke: bool,
    pub failures: usize,
    pub context: Value,
}

impl Log {
    pub fn new(suite: &str) -> Self {
        let smoke = match std::env::var("MAKA_TUI_ACCEPTANCE_MODE").as_deref() {
            Ok("smoke") => true,
            Err(std::env::VarError::NotPresent) | Ok("formal") => false,
            other => panic!("MAKA_TUI_ACCEPTANCE_MODE must be smoke or formal: {other:?}"),
        };
        assert!(
            smoke || !cfg!(debug_assertions),
            "formal acceptance requires release"
        );
        let file = std::env::var_os("MAKA_TUI_ACCEPTANCE_OUTPUT").map(|path| {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .unwrap()
        });
        let mut log = Self {
            file,
            smoke,
            failures: 0,
            context: json!({}),
        };
        let binary = std::fs::read(env!("CARGO_BIN_EXE_maka")).unwrap();
        let cpu = std::fs::read_to_string("/proc/cpuinfo")
            .ok()
            .and_then(|value| {
                value
                    .lines()
                    .find(|line| line.starts_with("model name"))
                    .map(str::to_owned)
            });
        log.emit(json!({"kind":"metadata", "suite":suite, "schema":1,
            "mode":if smoke {"smoke"} else {"formal"},
            "profile":if cfg!(debug_assertions) {"debug"} else {"release"},
            "binary_sha256":format!("{:x}", Sha256::digest(binary)),
            "cpu":cpu, "os":std::env::consts::OS, "arch":std::env::consts::ARCH,
            "viewport":{"columns":120,"rows":40},
            "clock":"std::time::Instant; ns relative to each case",
            "metric":"input_to_complete_pty_frame_parsed_upper_bound",
            "window_present_measured":false,
            "cache_condition":"OS page cache uncontrolled; no drop_caches"}));
        log
    }

    pub fn emit(&mut self, mut row: Value) {
        row["case"] = self.context.clone();
        let line = serde_json::to_string(&row).unwrap();
        println!("{line}");
        if let Some(file) = &mut self.file {
            writeln!(file, "{line}").unwrap();
            file.flush().unwrap();
        }
    }

    pub fn sample(&mut self, operation: &str, mut row: Value) {
        self.failures += usize::from(!row["error"].is_null());
        row["kind"] = json!("sample");
        row["operation"] = json!(operation);
        self.emit(row);
    }

    pub fn rss(&mut self, stage: &str, process: &str, pid: u32) {
        let result = std::fs::read_to_string(format!("/proc/{pid}/status"));
        let value = match result {
            Ok(text) => {
                let read = |name: &str| {
                    text.lines()
                        .find(|line| line.starts_with(name))
                        .and_then(|line| line.split_whitespace().nth(1))
                        .and_then(|value| value.parse::<u64>().ok())
                };
                json!({"rss_kib":read("VmRSS:"),"hwm_kib":read("VmHWM:")})
            }
            Err(error) => json!({"error":error.to_string()}),
        };
        self.emit(
            json!({"kind":"memory", "stage":stage, "process":process, "pid":pid,
            "value":value,"scope":"point RSS and process-lifetime HWM"}),
        );
    }
}

/// Reuse the production PTY fixture's parser and synchronized-frame tracking.
/// The timestamp follows parsing, so it bounds receipt rather than window paint.
pub(crate) struct Meter {
    pub origin: Instant,
    tail: [u8; 8],
    drawing: bool,
    pub sequence: u64,
    completed_ns: u64,
    chunks: Vec<Value>,
}

impl Meter {
    pub fn new(origin: Instant) -> Self {
        Self {
            origin,
            tail: [0; 8],
            drawing: false,
            sequence: 0,
            completed_ns: 0,
            chunks: Vec::new(),
        }
    }

    pub fn now(&self) -> u64 {
        self.origin.elapsed().as_nanos() as u64
    }

    pub fn read(&mut self, tui: &mut Pty) {
        tui.output.clear();
        tui.read();
        let parsed_ns = self.now();
        for &byte in &tui.output {
            self.tail.copy_within(1.., 0);
            self.tail[7] = byte;
            if &self.tail == b"\x1b[?2026h" {
                self.drawing = true;
            } else if &self.tail == b"\x1b[?2026l" && self.drawing {
                self.drawing = false;
                self.sequence += 1;
                self.completed_ns = parsed_ns;
            }
        }
        if !tui.output.is_empty() {
            self.chunks
                .push(json!({"bytes":tui.output.len(),"parsed_ns":parsed_ns,
                "frame_seq":self.sequence}));
        }
    }

    pub fn input(&mut self, tui: &mut Pty, bytes: &[u8], ready: impl Fn(&str) -> bool) -> Value {
        self.chunks.clear();
        let before = self.sequence;
        let start = self.now();
        tui.send(bytes);
        self.wait(tui, start, before, ready)
    }

    pub fn wait(
        &mut self,
        tui: &mut Pty,
        start: u64,
        before: u64,
        ready: impl Fn(&str) -> bool,
    ) -> Value {
        let deadline = Instant::now() + Duration::from_secs(10);
        let error = loop {
            self.read(tui);
            let screen = tui.screen.snapshot().unwrap().screen;
            if self.sequence > before && tui.frames.ready() && ready(&screen) {
                break None;
            }
            if tui.child.try_wait().unwrap().is_some() {
                break Some("TUI exited".to_owned());
            }
            if Instant::now() >= deadline {
                break Some("complete frame timeout".to_owned());
            }
        };
        json!({"start_ns":start, "complete_frame_parsed_ns":self.completed_ns,
            "observed_end_ns":self.now(), "frame_seq_before":before,"frame_seq_after":self.sequence,
            "duration_ns":error.is_none().then(|| self.completed_ns.saturating_sub(start)),
            "error":error, "frame":tui.screen.snapshot().unwrap().screen,
            "chunks":std::mem::take(&mut self.chunks)})
    }
}
