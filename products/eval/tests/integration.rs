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

use maka_eval::contract::{
    EvalResult, EvalResultStatus, RunFingerprint, V1CellAttempt, expand_experiment,
    parse_experiment_spec, select_cell_result,
};
use maka_eval::measurement::{
    AdmissionBoundaryLedger, DEEPSEEK_V4_FLASH_COST, MeteringState, NormalizedUsage,
    costs_match_within_tolerance, deepseek_cost_usd, derive_metering,
    reconcile_host_and_proxy_usage, recover_external_metering_checkpoint, sign_metering_checkpoint,
};
use maka_eval::store::capture_maka_runtime_artifacts;
use serde_json::{Value, json};
use std::fs;
use tempfile::TempDir;

#[test]
fn experiment_spec_validation_and_cell_expansion_match_v1_contract() {
    let spec_json = sample_two_arm_spec_json();
    let spec = parse_experiment_spec(&spec_json).unwrap();
    let cells = expand_experiment(&spec);

    assert_eq!(cells.len(), 4);
    assert_eq!(cells[0].id, "task-alpha::1::maka");
    assert_eq!(cells[1].id, "task-alpha::1::external-cli");
    assert_eq!(cells[2].id, "task-beta::1::maka");
    assert_eq!(cells[3].id, "task-beta::1::external-cli");

    // Unknown top-level field must be rejected.
    let mut invalid = spec_json.clone();
    invalid
        .as_object_mut()
        .unwrap()
        .insert("unknownField".into(), json!(123));
    assert!(parse_experiment_spec(&invalid).is_err());

    // Concurrency changes execution fingerprint but preserves semantic fingerprint.
    let mut higher_concurrency_json = spec_json;
    higher_concurrency_json["execution"]["maxConcurrentTaskGroups"] = json!(16);
    let higher_spec = parse_experiment_spec(&higher_concurrency_json).unwrap();

    let fp1 = RunFingerprint::compute(&spec);
    let fp2 = RunFingerprint::compute(&higher_spec);
    assert!(fp1.is_semantically_comparable(&fp2));
    assert_ne!(fp1.execution_sha256, fp2.execution_sha256);
}

#[test]
fn six_counter_usage_never_sums_total_tokens_and_deepseek_pricing_matches_within_1e9() {
    // Provider reports a totalTokens value distinct from the arithmetic sum of the 5 fields.
    let u1 = NormalizedUsage {
        input_tokens: 1000,
        output_tokens: 250,
        cache_read_tokens: 400,
        cache_write_tokens: 100,
        reasoning_tokens: 80,
        total_tokens: 9999,
    };
    let u2 = NormalizedUsage {
        input_tokens: 500,
        output_tokens: 150,
        cache_read_tokens: 200,
        cache_write_tokens: 0,
        reasoning_tokens: 20,
        total_tokens: 7777,
    };
    let mut combined = u1.clone();
    combined.accumulate_exact(&u2);
    assert_eq!(combined.input_tokens, 1500);
    assert_eq!(combined.output_tokens, 400);
    assert_eq!(combined.cache_read_tokens, 600);
    assert_eq!(combined.cache_write_tokens, 100);
    assert_eq!(combined.reasoning_tokens, 100);
    // Must equal 9999 + 7777 = 17776, never the sum of the other 5 counters!
    assert_eq!(combined.total_tokens, 17776);

    // Verify DEEPSEEK_V4_FLASH_COST formula:
    // uncached = 1000 - 400 - 100 = 500
    // (500 * 0.22 + 400 * 0.007 + 100 * 0.22 + 250 * 0.66) / 1_000_000
    // = (110 + 2.8 + 22 + 165) / 1_000_000 = 299.8 / 1_000_000 = 0.0002998
    let cost = deepseek_cost_usd(&u1);
    assert_eq!(DEEPSEEK_V4_FLASH_COST.input_per_million, 0.22);
    assert_eq!(DEEPSEEK_V4_FLASH_COST.output_per_million, 0.66);
    assert_eq!(DEEPSEEK_V4_FLASH_COST.cache_read_per_million, 0.007);
    assert_eq!(DEEPSEEK_V4_FLASH_COST.cache_write_per_million, 0.22);
    assert!(costs_match_within_tolerance(Some(cost), Some(0.0002998)));
    assert!(!costs_match_within_tolerance(
        Some(cost),
        Some(0.0002998 + 1e-8)
    ));
}

#[test]
fn admission_cutoff_checkpoint_deduplication_and_receipt_proxy_reconciliation() {
    let mut ledger = AdmissionBoundaryLedger::new();
    assert!(ledger.record_request_start("req-1"));
    assert!(ledger.record_request_start("req-2"));

    ledger.close_admission();
    assert!(ledger.is_admission_closed());
    // Request arriving after cutoff is rejected.
    assert!(!ledger.record_request_start("req-after-cutoff"));

    let u1 = NormalizedUsage {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 20,
        cache_write_tokens: 0,
        reasoning_tokens: 10,
        total_tokens: 150,
    };
    // Both Host receipt and proxy log settle req-1; idempotent settlement must not double-count.
    ledger
        .settle_request("req-1", Some(u1.clone()), Some("deepseek-v4-flash".into()))
        .unwrap();
    ledger
        .settle_request("req-1", Some(u1.clone()), Some("deepseek-v4-flash".into()))
        .unwrap();

    // While req-2 is still in flight, snapshot is lower-bound (`settled == false`).
    let mid_snapshot = ledger.snapshot();
    let mid_derived = derive_metering(&mid_snapshot);
    assert!(!mid_derived.usage_complete);
    assert_eq!(mid_derived.metering_state, MeteringState::LowerBound);
    assert_eq!(mid_derived.cost_usd, None);

    // Duplicate checkpoint ingestion is deduplicated.
    assert!(ledger.ingest_checkpoint(mid_snapshot.clone()));
    assert!(!ledger.ingest_checkpoint(mid_snapshot));

    // Once req-2 drains and proxy settles, metering becomes Complete with costUsd populated.
    ledger
        .settle_request("req-2", Some(u1.clone()), Some("deepseek-v4-flash".into()))
        .unwrap();
    ledger.mark_proxy_settled();
    let final_snapshot = ledger.snapshot();
    let final_derived = derive_metering(&final_snapshot);
    assert!(final_derived.usage_complete);
    assert_eq!(final_derived.metering_state, MeteringState::Complete);
    assert_eq!(final_snapshot.usage.as_ref().unwrap().total_tokens, 300);
    assert!(final_derived.cost_usd.is_some());

    // Reconciling matching Host and proxy usage yields Complete without double-counting.
    let (reconciled, state, cost) =
        reconcile_host_and_proxy_usage(final_snapshot.usage.as_ref(), true, Some(&final_snapshot));
    assert_eq!(state, MeteringState::Complete);
    assert_eq!(reconciled.unwrap().total_tokens, 300);
    assert!(cost.is_some());
}

#[test]
fn canonical_selector_picks_earliest_valid_attempt_and_treats_zero_score_as_terminal() {
    let attempts = vec![
        V1CellAttempt {
            cell_id: "t1::1::maka".into(),
            sequence: 1,
            started_at: 10,
            completed_at: 20,
            result: EvalResult {
                score: None,
                usage: None,
                cost_usd: None,
                duration_ms: 10,
                status: EvalResultStatus::InfraFailed,
                failure_reason: Some("docker pull failed".into()),
                artifacts: Vec::new(),
            },
        },
        V1CellAttempt {
            cell_id: "t1::1::maka".into(),
            sequence: 2,
            started_at: 30,
            completed_at: 40,
            result: EvalResult {
                score: Some(0.0),
                usage: None,
                cost_usd: None,
                duration_ms: 10,
                status: EvalResultStatus::Completed,
                failure_reason: None,
                artifacts: Vec::new(),
            },
        },
        V1CellAttempt {
            cell_id: "t1::1::maka".into(),
            sequence: 3,
            started_at: 50,
            completed_at: 60,
            result: EvalResult {
                score: Some(1.0),
                usage: None,
                cost_usd: None,
                duration_ms: 10,
                status: EvalResultStatus::Completed,
                failure_reason: None,
                artifacts: Vec::new(),
            },
        },
    ];

    let selected = select_cell_result(&attempts).unwrap();
    // Sequence 2 (Completed with score 0.0) is valid and earlier than sequence 3!
    assert_eq!(selected.sequence, 2);
    assert_eq!(selected.result.score, Some(0.0));
}

#[test]
fn sqlite_runtime_artifact_capture_and_external_checkpoint_hmac_verification() {
    let temp = TempDir::new().unwrap();
    let state_root = temp.path().join("host-state");
    fs::create_dir_all(&state_root).unwrap();

    // Create a real SQLite database at state_root/runtime.sqlite
    let db_path = state_root.join("runtime.sqlite");
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    conn.execute("CREATE TABLE receipts (id TEXT PRIMARY KEY)", [])
        .unwrap();
    conn.execute("INSERT INTO receipts (id) VALUES ('op-123')", [])
        .unwrap();
    drop(conn);
    fs::write(
        state_root.join("runtime-policy.json"),
        b"{\"mode\":\"eval\"}\n",
    )
    .unwrap();

    let dest_root = temp.path().join("captured-artifacts");
    let manifest =
        capture_maka_runtime_artifacts(&state_root, &dest_root, "settled", 123456).unwrap();
    assert_eq!(manifest.schema_version, "maka.eval.runtime_artifacts.v1");
    assert_eq!(manifest.files.len(), 2);
    assert!(dest_root.join("runtime.sqlite").is_file());
    assert!(dest_root.join("manifest.json").is_file());

    // Verify external metering checkpoint HMAC signing & recovery.
    let trial_path = temp.path().join("trial-1");
    fs::create_dir_all(trial_path.join("agent")).unwrap();
    let secret = "0123456789abcdef0123456789abcdef";
    let body = json!({
        "schemaVersion": "maka.external_provider_usage.v2",
        "profile": "deepseek-harness",
        "usage": {
            "inputTokens": 1000,
            "outputTokens": 200,
            "cacheReadTokens": 100,
            "cacheWriteTokens": 0,
            "reasoningTokens": 50,
            "totalTokens": 1200
        },
        "settled": true,
        "requests": 2,
        "inFlightRequests": 0,
        "admittedRequests": 2,
        "usageRequests": 2,
        "models": ["deepseek-v4-flash"],
        "toolNames": ["bash"]
    });
    let signed = sign_metering_checkpoint(body.as_object().unwrap(), secret);
    let cp_path = trial_path
        .join("agent")
        .join("deepseek-harness.provider-usage.json");
    fs::write(&cp_path, serde_json::to_vec(&signed).unwrap()).unwrap();

    let recovered =
        recover_external_metering_checkpoint(&trial_path, "deepseek-harness", secret).unwrap();
    assert_eq!(recovered.metering_state, MeteringState::Complete);
    assert_eq!(recovered.usage.unwrap().total_tokens, 1200);
    assert!(recovered.cost_usd.is_some());

    // Wrong secret must be rejected.
    assert!(
        recover_external_metering_checkpoint(&trial_path, "deepseek-harness", "wrong-secret")
            .is_none()
    );
}

fn sample_two_arm_spec_json() -> Value {
    json!({
        "schemaVersion": "maka.eval.v1",
        "id": "tb21-deepseek-v4-flash-two-arm",
        "benchmark": {
            "id": "terminal-bench-2.1",
            "version": "d49e28f1e4ddd13d289e85a5f312a66750951932",
            "config": {
                "repository": "https://github.com/harbor-framework/terminal-bench-2-1"
            }
        },
        "executor": {
            "kind": "harbor",
            "config": {
                "frameworkVersion": "0.20.0",
                "pythonPathEnv": "MAKA_EVAL_HARBOR_PYTHON",
                "trialsRootEnv": "MAKA_EVAL_TRIALS_DIR",
                "environment": { "type": "docker", "delete": true }
            }
        },
        "execution": {
            "maxConcurrentTaskGroups": 2
        },
        "subjects": [
            {
                "id": "maka",
                "kind": "maka",
                "credentials": ["DEEPSEEK_API_KEY"],
                "config": {
                    "makaExecutable": "/opt/maka-agent/maka",
                    "runtimeHostsPath": "/tmp/maka-runtime-hosts",
                    "hostSettlementTimeoutMs": 120000,
                    "connectionSlug": "eval-gateway",
                    "baseUrl": "http://127.0.0.1:43120/v1",
                    "model": "deepseek-v4-flash",
                    "sandboxMode": "workspace-write"
                }
            },
            {
                "id": "external-cli",
                "kind": "external",
                "credentials": ["DEEPSEEK_API_KEY"],
                "config": {
                    "command": "/opt/maka-node-toolchain/bin/node",
                    "credentialEnvironment": {
                        "DEEPSEEK_API_KEY": "DEEPSEEK_API_KEY"
                    },
                    "args": [
                        "/opt/maka-agent/node_modules/@maka/eval/dist/harbor-external-subject.js",
                        "deepseek-harness",
                        "http://127.0.0.1:43120/v1",
                        "/",
                        "dsh",
                        "{{task.input}}"
                    ]
                }
            }
        ],
        "tasks": [
            {
                "id": "task-alpha",
                "input": "Fix alpha",
                "config": { "harbor": { "path": "tasks/task-alpha" } }
            },
            {
                "id": "task-beta",
                "input": "Fix beta",
                "config": { "harbor": { "path": "tasks/task-beta" } }
            }
        ],
        "repetitions": 1,
        "budget": {
            "timeoutMultiplier": 1,
            "maxSteps": 100
        },
        "verifier": {
            "reward": "reward"
        }
    })
}

#[test]
fn writer_lock_is_released_after_process_exit() {
    const KEY: &str = "MAKA_EVAL_TEST_CRASH_LOCK";
    if let Some(path) = std::env::var_os(KEY) {
        let store = maka_eval::store::FileAttemptStore::new(path);
        let _guard = store.acquire_writer().unwrap();
        std::process::exit(0);
    }
    let temp = TempDir::new().unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "writer_lock_is_released_after_process_exit"])
        .env(KEY, temp.path())
        .status()
        .unwrap();
    assert!(status.success());
    let store = maka_eval::store::FileAttemptStore::new(temp.path());
    let _guard = store
        .acquire_writer()
        .expect("crashed writer must release lock");
    assert!(store.acquire_writer().is_err());
}
