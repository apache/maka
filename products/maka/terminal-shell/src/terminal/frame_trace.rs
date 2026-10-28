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

//! Opt-in measurements under the existing presentation lock. Nothing is
//! formatted or written until terminal restoration has finished.

use nsh_gpui_terminal::FrameToken;
use serde_json::{Value, json};
use std::{io::Write, path::PathBuf, time::Instant};

pub(super) struct Trace {
    path: PathBuf,
    started: Instant,
    environment: Value,
    samples: Vec<Sample>,
    inputs: Vec<InputSample>,
    input_pumps: Vec<InputPumpSample>,
    pub gpu: Option<Value>,
    pub protocol: Option<&'static str>,
}

pub(super) struct Sample {
    frame: u64,
    viewport_generation: u64,
    geometry: u64,
    stage: &'static str,
    start: Instant,
    end: Instant,
    pub bytes: Option<usize>,
    pub pixel_size: Option<(i32, i32)>,
    pub image: Option<u32>,
    pub outcome: &'static str,
    /// Candidate present at the sink before admitting this frame. The outcome
    /// distinguishes a discarded new frame from replacing that old candidate.
    /// For stage `superseded`, the newer same-geometry replacement sequence.
    pub pending_frame: Option<u64>,
}

pub(super) struct InputSample {
    /// Most recent writer receipt at dispatch, for diagnostics only.
    /// Physical input is not bound to this output frame.
    pub frame: Option<u64>,
    pub viewport_generation: Option<u64>,
    pub geometry: u64,
    pub kind: &'static str,
    pub queued: Instant,
    pub dispatch_start: Instant,
    pub dispatch_end: Option<Instant>,
    pub queue_len: usize,
    pub outcome: &'static str,
}

pub(super) struct InputPumpSample {
    pub frame: Option<u64>,
    pub geometry: u64,
    pub start: Instant,
    pub end: Instant,
    pub queue_before: usize,
    pub queue_after: usize,
}

impl Trace {
    pub fn from_env() -> Option<Self> {
        let path = std::env::var_os("MAKA_TERMINAL_FRAME_TRACE")?;
        Some(Self {
            path: path.into(),
            started: Instant::now(),
            environment: json!({
                "TERM": std::env::var("TERM").ok(),
                "TERM_PROGRAM": std::env::var("TERM_PROGRAM").ok(),
                "DISPLAY": std::env::var("DISPLAY").ok(),
                "WAYLAND_DISPLAY": std::env::var("WAYLAND_DISPLAY").ok(),
            }),
            // Preallocate a minute at the target 120 Hz and fifteen Kitty
            // stages. This avoids growth during short measurements, not a cap.
            samples: Vec::with_capacity(60 * 120 * 15),
            inputs: Vec::with_capacity(60 * 120),
            input_pumps: Vec::with_capacity(60 * 120),
            gpu: None,
            protocol: None,
        })
    }

    pub fn record(
        &mut self,
        token: &FrameToken,
        geometry: u64,
        stage: &'static str,
        start: Instant,
        end: Instant,
    ) -> &mut Sample {
        self.samples.push(Sample {
            frame: token.sequence(),
            viewport_generation: token.viewport_generation(),
            geometry,
            stage,
            start,
            end,
            bytes: None,
            pixel_size: None,
            image: None,
            outcome: "ok",
            pending_frame: None,
        });
        self.samples.last_mut().unwrap()
    }

    pub fn record_input(&mut self, sample: InputSample) -> usize {
        let index = self.inputs.len();
        self.inputs.push(sample);
        index
    }

    /// A real owner revoked further presentation, not the worker's execution.
    /// Shutdown can race a late completion; retain one explicit terminal reason
    /// in the existing trace rather than inventing another lifecycle ledger.
    pub fn discard(&mut self, token: &FrameToken, geometry: u64, outcome: &'static str) {
        if self.samples.iter().rev().any(|sample| {
            sample.frame == token.sequence()
                && sample.viewport_generation == token.viewport_generation()
                && sample.geometry == geometry
                && matches!(sample.stage, "published" | "superseded" | "discarded")
        }) {
            return;
        }
        let at = Instant::now();
        self.record(token, geometry, "discarded", at, at).outcome = outcome;
    }

    pub fn finish_input(&mut self, index: usize, end: Instant, outcome: &'static str) {
        let sample = &mut self.inputs[index];
        sample.dispatch_end = Some(end);
        sample.outcome = outcome;
    }

    pub fn record_input_pump(&mut self, sample: InputPumpSample) {
        self.input_pumps.push(sample);
    }

    pub fn write(self, result: &Result<(), String>) -> Result<(), String> {
        let stopped = Instant::now();
        let samples: Vec<_> = self
            .samples
            .into_iter()
            .map(|sample| {
                json!({
                    "frame": sample.frame,
                    "viewport_generation": sample.viewport_generation,
                    "geometry": sample.geometry,
                    "stage": sample.stage,
                    "start_us": sample.start.saturating_duration_since(self.started).as_micros(),
                    "end_us": sample.end.saturating_duration_since(self.started).as_micros(),
                    "bytes": sample.bytes,
                    "pixel_size": sample.pixel_size,
                    "image": sample.image,
                    "outcome": sample.outcome,
                    "pending_frame": sample.pending_frame,
                })
            })
            .collect();
        let inputs: Vec<_> = self
            .inputs
            .into_iter()
            .map(|sample| {
                json!({
                    "frame": sample.frame,
                    "viewport_generation": sample.viewport_generation,
                    "geometry": sample.geometry,
                    "kind": sample.kind,
                    "queued_us": sample.queued.saturating_duration_since(self.started).as_micros(),
                    "dispatch_start_us": sample.dispatch_start.saturating_duration_since(self.started).as_micros(),
                    "dispatch_end_us": sample.dispatch_end.map(|end| end.saturating_duration_since(self.started).as_micros()),
                    "queue_len_before_pop": sample.queue_len,
                    "outcome": sample.outcome,
                })
            })
            .collect();
        let input_pumps: Vec<_> = self
            .input_pumps
            .into_iter()
            .map(|sample| {
                json!({
                    "frame": sample.frame,
                    "geometry": sample.geometry,
                    "start_us": sample.start.saturating_duration_since(self.started).as_micros(),
                    "end_us": sample.end.saturating_duration_since(self.started).as_micros(),
                    "queue_before": sample.queue_before,
                    "queue_after": sample.queue_after,
                })
            })
            .collect();
        let data = json!({
            "format": "maka-terminal-frame-trace-v1",
            "version": env!("CARGO_PKG_VERSION"),
            "debug_assertions": cfg!(debug_assertions),
            "pid": std::process::id(),
            "environment": self.environment,
            "gpu": self.gpu,
            "protocol": self.protocol,
            "stopped_us": stopped.saturating_duration_since(self.started).as_micros(),
            "terminal_result": result.as_ref().err(),
            "samples": samples,
            "inputs": inputs,
            "input_pumps": input_pumps,
        });
        let write = || -> Result<(), Box<dyn std::error::Error>> {
            let mut output = std::io::BufWriter::new(std::fs::File::create(&self.path)?);
            serde_json::to_writer(&mut output, &data)?;
            output.write_all(b"\n")?;
            output.flush()?;
            Ok(())
        };
        write().map_err(|error| format!("terminal frame trace {}: {error}", self.path.display()))
    }
}
