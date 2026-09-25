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
use super::*;
use maka_protocol::{
    Operation,
    plugin::{RemoteBinding, RemoteRequest, RemoteResult},
};
use serde_json::{Value, json};
use tokio::runtime::Runtime;

mod cases;
pub(super) mod fixture;
pub(super) mod measure;
mod mutation;

/// Run serially against one fixed binary. Smoke validates the harness only.
#[test]
#[ignore = "real Host+PTY fault matrix; serial; emits raw JSONL"]
fn presenter_faults_preserve_shell_and_report_actual_vm_scope() {
    let mut log = measure::Log::new("fault");
    let modes: &[&str] = if log.smoke {
        &[
            "duplicate",
            "oversized",
            "cooperative_pending",
            "runaway_read",
        ]
    } else {
        &[
            "runaway_read",
            "runaway_submit",
            "cooperative_pending",
            "never_settle",
            "invalid",
            "duplicate",
            "oversized",
            "overflow",
        ]
    };
    for vm in ["shared", "dedicated"] {
        for mode in modes {
            cases::run(vm, mode, &mut log);
        }
    }
    log.emit(json!({"kind":"suite_end", "failures":log.failures,
        "page_only_isolation":"not inferred; inspect witness results",
        "retirement_evidence":"tui::board::activity; plugin_remote::javascript; apps::io::transcript::runner"}));
    assert_eq!(
        log.failures, 0,
        "raw JSONL retains observed harness/shell/drain failures"
    );
}
