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
    binary: String,
    phases: Vec<(u64, String, u64)>,
    pub context: Value,
    pub smoke: bool,
    pub failures: usize,
}
impl Report {
    pub fn new() -> Self {
        let smoke = match std::env::var("MAKA_TUI_ACCEPTANCE_MODE").as_deref() {
            Ok("smoke") => true,
            Ok("formal") | Err(std::env::VarError::NotPresent) => false,
            value => panic!("invalid MAKA_TUI_ACCEPTANCE_MODE: {value:?}"),
        };
        assert!(
            smoke || !cfg!(debug_assertions),
            "formal measurement requires release"
        );
        let file = std::env::var_os("MAKA_TUI_ACCEPTANCE_OUTPUT").map(|path| {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .unwrap()
        });
        let mut result = Self {
            file,
            binary: hash(),
            phases: Vec::new(),
            context: json!({}),
            smoke,
            failures: 0,
        };
        result.emit(json!({"kind":"metadata","suite":"transcript_process_rss","schema":1,
            "binary_sha256":result.binary,"mode":if smoke {"smoke"} else {"formal"},
            "profile":if cfg!(debug_assertions) {"debug"} else {"release"},
            "os":std::env::consts::OS,"arch":std::env::consts::ARCH,
            "kernel":std::fs::read_to_string("/proc/sys/kernel/osrelease").ok(),
            "cpu":std::fs::read_to_string("/proc/cpuinfo").ok().and_then(|text| text.lines().find(|line| line.starts_with("model name")).map(str::to_owned)),
            "initial_source":{"blocks":1000,"logical_lines_per_block":10,"logical_lines":10000},
            "cycles_per_viewport":if smoke {2} else {100},"appends_per_cycle":3,
            "reopen_rounds_per_viewport":if smoke {2} else {10},
            "page_capacity":{"sample_pages":64,"connections":1,"streams_per_page":2},
            "sampler_period_ms":10,"clock":"Instant ns from each case origin; actual sample timestamps retained",
            "rss_scope":"Host process includes business source and page VMs; TUI process includes kernel/cache; observer excluded",
            "wire_scope":"zero-delay proxy observes TUI and capacity probe clients; independent append/stats control client is excluded",
            "hwm_scope":"process-lifetime peak, not per-phase peak; sampled RSS can miss shorter peaks",
            "native_baseline":"Settings shell with same binary/viewport; not an equivalent 10k Chat source",
            "visual_lines_measured":false,"tui_cache_bytes_measured":false,
            "absolute_rss_threshold":null,"cache_condition":"OS and allocator caches uncontrolled"}));
        result
    }
    pub fn emit(&mut self, mut value: Value) {
        value["case"] = self.context.clone();
        let line = serde_json::to_string(&value).unwrap();
        println!("{line}");
        if let Some(file) = &mut self.file {
            writeln!(file, "{line}").unwrap();
            file.flush().unwrap();
        }
    }
    pub fn caught(&mut self, phase: &str, outcome: std::thread::Result<()>) {
        if let Err(error) = outcome {
            self.failures += 1;
            let error = error
                .downcast_ref::<String>()
                .map(String::as_str)
                .or_else(|| error.downcast_ref::<&str>().copied())
                .unwrap_or("non-string panic");
            self.emit(json!({"kind":"failure","phase":phase,"error":error,"fallback_cleanup_possible":true}));
        }
    }
    pub fn memory(&mut self, rows: Vec<Value>) {
        let mut groups: BTreeMap<(String, String, u64), Vec<u64>> = BTreeMap::new();
        let mut baseline = BTreeMap::new();
        for row in rows {
            if !row["error"].is_null() {
                self.failures += 1;
            }
            if row["sample_kind"] == "checkpoint" {
                self.phases.push((
                    row["at_ns"].as_u64().unwrap(),
                    row["phase"].as_str().unwrap().into(),
                    row["iteration"].as_u64().unwrap(),
                ));
            }
            if let Some(rss) = row["rss_kib"].as_u64() {
                let process = row["process"].as_str().unwrap().to_owned();
                let phase = row["phase"].as_str().unwrap().to_owned();
                if phase == "native_settings_after_install" {
                    baseline.insert(process.clone(), rss);
                }
                groups
                    .entry((process, phase, row["iteration"].as_u64().unwrap()))
                    .or_default()
                    .push(rss);
            } else if row["error"].is_null() {
                self.failures += 1;
            }
            self.emit(row);
        }
        for ((process, phase, iteration), values) in groups {
            let base = baseline.get(&process).copied();
            self.emit(json!({"kind":"rss_summary","process":process,"phase":phase,"iteration":iteration,
                "samples":values.len(),"first_kib":values.first(),"last_kib":values.last(),
                "sampled_peak_kib":values.iter().max(),"native_settings_baseline_kib":base,
                "last_minus_baseline_kib":base.map(|base| *values.last().unwrap() as i64-base as i64)}));
        }
    }
    pub fn wire(&mut self, rows: Vec<Value>) {
        self.phases.sort_by_key(|entry| entry.0);
        let mut methods = BTreeMap::new();
        let mut totals: BTreeMap<(String, String, String), (u64, u64)> = BTreeMap::new();
        for mut row in rows {
            let at = row["received_ns"].as_u64().unwrap_or(0);
            if let Some((_, phase, iteration)) =
                self.phases.iter().rev().find(|entry| entry.0 <= at)
            {
                row["phase"] = json!(phase);
                row["iteration"] = json!(iteration);
            } else {
                row["phase"] = json!("host_startup");
            }
            let id = (row["connection"].to_string(), row["request_id"].to_string());
            if row["direction"] == "client_to_host" {
                methods.insert(
                    id.clone(),
                    (row["remote_kind"].to_string(), row["method"].to_string()),
                );
            }
            if row["kind"] == "proxy_error" || row["kind"] == "wire_received" {
                self.failures += 1;
            }
            if row["kind"] == "wire" {
                let (operation, method) = methods.get(&id).cloned().unwrap_or_default();
                let total = totals
                    .entry((row["direction"].to_string(), operation, method))
                    .or_default();
                total.0 += 1;
                total.1 += row["wire_bytes"].as_u64().unwrap();
            }
            self.emit(row);
        }
        for ((direction, operation, method), (frames, bytes)) in totals {
            self.emit(json!({"kind":"wire_summary","direction":direction,"remote_kind":operation,"method":method,"frames":frames,"wire_bytes":bytes}));
        }
        self.phases.clear();
    }
    pub fn finish(&mut self) {
        let after = hash();
        if after != self.binary {
            self.failures += 1;
        }
        self.context = json!({});
        self.emit(
            json!({"kind":"suite_end","failures":self.failures,"binary_sha256_before":self.binary,
            "binary_sha256_after":after,"rss_pass_threshold":null}),
        );
    }
}
fn hash() -> String {
    format!(
        "{:x}",
        Sha256::digest(std::fs::read(env!("CARGO_BIN_EXE_maka")).unwrap())
    )
}
