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
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU32, Ordering},
};

struct State {
    phase: &'static str,
    iteration: usize,
    rows: Vec<Value>,
    exhausted: bool,
}

pub(super) struct Sampler {
    host: u32,
    tui: Arc<AtomicU32>,
    origin: Instant,
    state: Arc<Mutex<State>>,
    stop: Arc<AtomicBool>,
    task: Option<std::thread::JoinHandle<()>>,
}
impl Sampler {
    pub fn new(host: u32, origin: Instant) -> Self {
        let state = Arc::new(Mutex::new(State {
            phase: "host_startup",
            iteration: 0,
            rows: Vec::new(),
            exhausted: false,
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let tui = Arc::new(AtomicU32::new(0));
        let (reading, stopped, terminal) = (state.clone(), stop.clone(), tui.clone());
        let task = std::thread::spawn(move || {
            while !stopped.load(Ordering::Acquire) {
                capture(
                    host,
                    terminal.load(Ordering::Acquire),
                    origin,
                    &reading,
                    "periodic",
                );
                std::thread::park_timeout(Duration::from_millis(10));
            }
        });
        Self {
            host,
            tui,
            origin,
            state,
            stop,
            task: Some(task),
        }
    }
    pub fn set_tui(&self, pid: u32) {
        self.tui.store(pid, Ordering::Release);
        self.mark("tui_startup", 0);
    }
    pub fn mark(&self, phase: &'static str, iteration: usize) {
        {
            let mut state = self.state.lock().unwrap();
            state.phase = phase;
            state.iteration = iteration;
        }
        capture(
            self.host,
            self.tui.load(Ordering::Acquire),
            self.origin,
            &self.state,
            "checkpoint",
        );
    }
    pub fn stop(&mut self) -> Vec<Value> {
        self.join();
        std::mem::take(&mut self.state.lock().unwrap().rows)
    }
    fn join(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(task) = self.task.take() {
            task.thread().unpark();
            task.join().expect("RSS sampler thread");
        }
    }
}
impl Drop for Sampler {
    fn drop(&mut self) {
        self.join();
    }
}

fn capture(host: u32, tui: u32, origin: Instant, state: &Mutex<State>, kind: &str) {
    let mut state = state.lock().unwrap();
    if state.rows.len() >= 200_000 {
        if !state.exhausted {
            state.exhausted = true;
            state.rows.push(
                json!({"kind":"rss_sampler_error", "error":"200000 sample evidence limit reached"}),
            );
        }
        return;
    }
    for (process, pid) in [("host", host), ("tui", tui)] {
        if pid == 0 {
            continue;
        }
        let mut row = json!({"kind":"rss","sample_kind":kind,"at_ns":origin.elapsed().as_nanos() as u64,
            "process":process,"pid":pid,"phase":state.phase,"iteration":state.iteration});
        match std::fs::read_to_string(format!("/proc/{pid}/status")) {
            Ok(text) => {
                for (field, name) in [("rss_kib", "VmRSS:"), ("hwm_kib", "VmHWM:")] {
                    row[field] = text
                        .lines()
                        .find(|line| line.starts_with(name))
                        .and_then(|line| line.split_whitespace().nth(1))
                        .and_then(|v| v.parse::<u64>().ok())
                        .map_or(Value::Null, Value::from);
                }
                if row["rss_kib"].is_null() || row["hwm_kib"].is_null() {
                    row["error"] = json!("missing VmRSS/VmHWM");
                }
            }
            Err(error) => row["error"] = json!(error.to_string()),
        }
        state.rows.push(row);
    }
}
