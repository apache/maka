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
use std::collections::BTreeMap;

pub(super) struct Report {
    file: Option<File>,
    samples: Vec<Value>,
    operations: &'static [&'static str],
    pub smoke: bool,
    pub failures: usize,
}

impl Report {
    pub fn new() -> Self {
        Self::scenario(
            "idle Board; loaded transcript; no semantic RPC held pending",
            &[
                "input_insert",
                "input_backspace",
                "loaded_scroll_up",
                "loaded_scroll_down",
                "disclosure_open",
                "disclosure_close",
            ],
        )
    }

    pub fn scenario(scenario: &str, operations: &'static [&'static str]) -> Self {
        let smoke = match std::env::var("MAKA_TUI_PERF_MODE").as_deref() {
            Err(std::env::VarError::NotPresent) | Ok("formal") => false,
            Ok("smoke") => true,
            other => panic!("MAKA_TUI_PERF_MODE must be formal or smoke: {other:?}"),
        };
        assert!(
            smoke || !cfg!(debug_assertions),
            "formal measurements require --release"
        );
        let file = std::env::var_os("MAKA_TUI_PERF_OUTPUT").map(|path| {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .expect("create a new raw performance JSONL file")
        });
        let mut report = Self {
            file,
            samples: Vec::new(),
            operations,
            smoke,
            failures: 0,
        };
        let binary = std::fs::read(env!("CARGO_BIN_EXE_maka")).unwrap();
        let cpu = std::fs::read_to_string("/proc/cpuinfo")
            .ok()
            .and_then(|text| {
                text.lines()
                    .find(|line| line.starts_with("model name"))
                    .map(str::to_owned)
            });
        report.emit(json!({"kind":"metadata", "schema":3,
            "mode":if smoke {"smoke"} else {"formal"},
            "profile":if cfg!(debug_assertions) {"debug"} else {"release"},
            "binary_sha256":format!("{:x}", Sha256::digest(&binary)),
            "os":std::env::consts::OS, "arch":std::env::consts::ARCH, "cpu":cpu,
            "viewport":{"columns":170,"rows":40},
            "terminal":{"term":"xterm-256color","no_color":false},
            "document_lifetime":"page; finite replies keep the document open",
            "warmup_per_operation":report.warmup(), "samples_per_operation":report.count(),
            "metric":"input_to_complete_pty_frame", "window_present_measured":false,
            "scenario":scenario,
            "data":{"history_blocks":300,"oversized_report_repetitions":1800},
            "clock":"std::time::Instant; ns from per-case origin; process-local",
            "cache_condition":"OS page cache uncontrolled; no drop_caches"}));
        report
    }

    pub fn warmup(&self) -> usize {
        if self.smoke { 2 } else { 20 }
    }
    pub fn count(&self) -> usize {
        if self.smoke { 8 } else { 200 }
    }

    pub fn emit(&mut self, value: Value) {
        let line = serde_json::to_string(&value).unwrap();
        println!("{line}");
        if let Some(file) = &mut self.file {
            writeln!(file, "{line}").unwrap();
            file.flush().unwrap();
        }
    }

    pub fn sample(&mut self, rtt: u64, operation: &str, index: usize, mut sample: Value) -> bool {
        sample["kind"] = json!("sample");
        sample["added_rtt_ms"] = json!(rtt);
        sample["operation"] = json!(operation);
        sample["index"] = json!(index);
        sample["warmup"] = json!(index < self.warmup());
        let ok = sample["error"].is_null();
        self.failures += usize::from(!ok);
        self.emit(sample.clone());
        self.samples.push(sample);
        ok
    }

    pub fn rss(&mut self, rtt: u64, stage: &str, host_pid: u32, tui_pid: u32) {
        for (process, pid) in [("host", host_pid), ("tui", tui_pid)] {
            let status = std::fs::read_to_string(format!("/proc/{pid}/status"));
            let value = match status {
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
            self.emit(json!({"kind":"memory", "added_rtt_ms":rtt, "stage":stage,
                "process":process,"pid":pid,"value":value,
                "scope":"point RSS and process-lifetime HWM; not a peak RSS sampler"}));
        }
    }

    pub fn source(&mut self, rtt: u64, operation: &str, before: &Value, after: Value) {
        let unchanged = ["viewReads", "activityViewReads", "pageReads", "updates"]
            .into_iter()
            .all(|key| before["stats"][key] == after["stats"][key]);
        let no_rpc = ["remote_requests_excluding_next", "semantic_calls"]
            .into_iter()
            .all(|key| before["fence"][key] == after["fence"][key]);
        self.emit(json!({"kind":"source_counts","added_rtt_ms":rtt,"operation":operation,
            "before":before,"after":after,"local_counts_unchanged":unchanged,"no_local_rpc":no_rpc}));
        if !unchanged || !no_rpc {
            self.failures += 1;
        }
    }

    pub fn wire(&mut self, rtt: u64, mut records: Vec<Value>) {
        let mut requests = BTreeMap::new();
        let mut calls = 0;
        records.sort_by_key(|record| record["received_ns"].as_u64().unwrap_or(u64::MAX));
        for mut record in records {
            record["added_rtt_ms"] = json!(rtt);
            if record["kind"] == "proxy_error" {
                self.failures += 1;
            } else if record["kind"] == "wire" {
                let id = (
                    record["connection"].to_string(),
                    record["request_id"].to_string(),
                );
                if !record["request_id"].is_null() {
                    if record["direction"] == "client_to_host" {
                        requests.insert(id, record.clone());
                    } else if let Some(request) = requests.remove(&id) {
                        let ns = |value: &Value, key: &str| value[key].as_u64().unwrap();
                        let up = ns(&request, "forwarded_ns") - ns(&request, "received_ns");
                        let down = ns(&record, "forwarded_ns") - ns(&record, "received_ns");
                        self.emit(json!({"kind":"rpc_rtt", "added_rtt_ms":rtt,
                            "connection":record["connection"], "request_id":record["request_id"],
                            "operation":request["operation"], "remote_kind":request["remote_kind"],
                            "method":request["method"], "up_queue_ns":up, "down_queue_ns":down,
                            "observed_rtt_ns":ns(&record,"forwarded_ns") - ns(&request,"received_ns"),
                            "host_interval_ns":ns(&record,"received_ns") as i64 - ns(&request,"forwarded_ns") as i64}));
                        if up < rtt * 500_000 || down < rtt * 500_000 {
                            self.failures += 1;
                        }
                        if request["operation"] == "plugin.remote"
                            && request["remote_kind"] == "call"
                        {
                            calls += 1;
                        }
                    }
                }
            }
            self.emit(record);
        }
        if calls == 0 {
            self.failures += 1;
        }
        self.emit(
            json!({"kind":"wire_summary","added_rtt_ms":rtt,"completed_remote_calls":calls,
            "unreplied_requests_at_disconnect":requests.len()}),
        );
    }

    pub fn finish(&mut self) {
        let mut groups: BTreeMap<(u64, String), Vec<Value>> = BTreeMap::new();
        for rtt in [0, 200] {
            for &operation in self.operations {
                groups.insert((rtt, operation.into()), Vec::new());
            }
        }
        for sample in &self.samples {
            if sample["warmup"] == false {
                groups
                    .entry((
                        sample["added_rtt_ms"].as_u64().unwrap(),
                        sample["operation"].as_str().unwrap().into(),
                    ))
                    .or_default()
                    .push(sample.clone());
            }
        }
        for ((rtt, operation), samples) in groups {
            let mut durations: Vec<_> = samples
                .iter()
                .filter_map(|sample| sample["duration_ns"].as_u64())
                .collect();
            durations.sort_unstable();
            let rank = |percent: usize| {
                durations
                    .get((percent * durations.len()).div_ceil(100).saturating_sub(1))
                    .copied()
            };
            let failures = samples.len() - durations.len();
            let complete = samples.len() == self.count() && failures == 0;
            let pass = complete && rank(95).is_some_and(|ns| ns <= 50_000_000);
            if !complete || (!self.smoke && !pass) {
                self.failures += 1;
            }
            self.emit(json!({"kind":"summary", "metric":"input_to_complete_pty_frame",
                "added_rtt_ms":rtt,"operation":operation,"attempted":samples.len(),
                "expected":self.count(),"failed":failures,"unattempted":self.count()-samples.len(),
                "successful_p50_ns":rank(50),"successful_p95_ns":rank(95),"successful_max_ns":durations.last(),
                "quantile":"nearest-rank ceil(p*n)-1; failed attempts retained above",
                "acceptance_pass":!self.smoke && pass}));
        }
        self.emit(json!({"kind":"result","failures":self.failures,"smoke":self.smoke,
            "cold_start_measured":false,"fault_matrix_measured":false,"window_present_measured":false}));
    }
}
