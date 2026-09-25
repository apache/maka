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

use super::super::candidate::CandidateFixture;
use super::fault_acceptance::{fixture, measure};
use super::*;
use maka_protocol::Operation;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::runtime::Runtime;

mod cases;
mod lifecycle;
mod page;

const PACKAGE: &str = "example.acceptance-startup";
const TITLE: &str = "Startup lab";
const METRICS: [&str; 5] = [
    "first_shell_frame_ns",
    "host_ready_observed_ns",
    "target_content_frame_ns",
    "target_interactive_frame_ns",
    "tui_attachment_observed_ns",
];

/// Process startup, with the OS page cache deliberately uncontrolled.
#[test]
#[ignore = "real Host+PTY process startup; serial fixed release binary; raw JSONL"]
fn process_startup_reports_attach_on_demand_native_and_installed_js() {
    assert!(
        std::path::Path::new("/proc/self/status").is_file(),
        "this observer requires Linux /proc"
    );
    let mut log = measure::Log::new("process_startup");
    let hash = || {
        format!(
            "{:x}",
            Sha256::digest(std::fs::read(env!("CARGO_BIN_EXE_maka")).unwrap())
        )
    };
    let before = hash();
    let count = if log.smoke { 2 } else { 20 };
    let groups = [
        ("attach", "native"),
        ("on_demand", "native"),
        ("attach", "installed_js"),
        ("on_demand", "installed_js"),
        ("attach", "empty"),
        ("on_demand", "empty"),
    ];
    log.emit(json!({"kind":"startup_contract", "samples_per_group":count,
        "metric":"Pty::spawn call to complete parsed synchronized frame; upper bound",
        "origin":"immediately before Pty::spawn, including openpty and Command setup",
        "host_ready":"independent HostStatus observation; attach is a reobservation of preexisting readiness",
        "target_interactive":"target content followed by a demonstrated local control change",
        "tui_attachment":"separate loaded-catalog frame observation when available; native local interaction may precede attachment; no attachment wait before early detach",
        "checkpoint":"four restored-route groups; two empty controls without a fake JS-empty duplicate",
        "comparison":"restored native and JS both preinstall the same Shared JS fixture",
        "data":{"sessions":0,"js_blocks":1,"js_logical_lines":60},
        "preparation":"plugin installation and checkpoint seeding precede t0",
        "os_release":std::fs::read_to_string("/proc/sys/kernel/osrelease").ok(),
        "disk_cache_cold":false,"window_present_measured":false}));
    let mut samples: Vec<Vec<Value>> = groups.iter().map(|_| Vec::new()).collect();
    // Interleave groups to avoid assigning every late-run cache condition to JS.
    for iteration in 0..count {
        for (index, (host, target)) in groups.iter().enumerate() {
            log.context = json!({"host":host,"target":target,"iteration":iteration,
                "checkpoint":if *target == "empty" {"empty"} else {"restored_route"}});
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                cases::run(host, target, &mut log)
            }));
            let mut row = match result {
                Ok(value) => value,
                Err(error) => {
                    log.failures += 1;
                    let message = error
                        .downcast_ref::<String>()
                        .map(String::as_str)
                        .or_else(|| error.downcast_ref::<&str>().copied())
                        .unwrap_or("non-string panic");
                    json!({"error":message,"normal_cleanup":false,
                        "fallback_cleanup_possible":true})
                }
            };
            row["kind"] = json!("startup_sample");
            for metric in METRICS {
                if row.get(metric).is_none() {
                    row[metric] = Value::Null;
                }
            }
            log.emit(row.clone());
            samples[index].push(row);
        }
    }
    for ((host, target), rows) in groups.iter().zip(samples) {
        log.context = json!({"host":host,"target":target,
            "checkpoint":if *target == "empty" {"empty"} else {"restored_route"}});
        for metric in METRICS {
            let mut values: Vec<u64> = rows.iter().filter_map(|row| row[metric].as_u64()).collect();
            values.sort_unstable();
            let percentile = |percent: usize| {
                values
                    .get((values.len() * percent).div_ceil(100).saturating_sub(1))
                    .copied()
            };
            log.emit(json!({"kind":"startup_summary","metric":metric,"total":rows.len(),
                "measured":values.len(),"missing":rows.len()-values.len(),
                "failed_cases":rows.iter().filter(|row| !row["error"].is_null()).count(),
                "p50_ns":percentile(50),"p95_ns":percentile(95),"max_ns":values.last(),
                "percentile":"nearest-rank over observed durations; all missing/failed cases retained"}));
        }
    }
    log.context = json!({});
    let after = hash();
    if before != after {
        log.failures += 1;
    }
    log.emit(json!({"kind":"suite_end","failures":log.failures,
        "binary_sha256_before":before,"binary_sha256_after":after,
        "absolute_startup_threshold":"not specified by the design; descriptive measurement"}));
    assert_eq!(
        log.failures, 0,
        "startup, interaction and normal drain must all succeed"
    );
}
