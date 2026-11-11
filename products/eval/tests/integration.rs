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
    AttemptPhase, CleanupState, CriticalArtifactsState, DifferenceRegistry, DifferenceScenarioId,
    EgressAuditState, EvalResult, EvalResultStatus, ExecutionOutcome, ExperimentCell,
    RunFingerprint, SchemaVersion, V1CellAttempt, V2AttemptRecord, VerifierOutcome,
    decode_v1_cell_attempt, expand_experiment, parse_experiment_spec, select_cell_result,
};
use maka_eval::environment::{
    ActiveTrialAttempt, BoxFuture, CommandRunner, EgressAuditEvidence, ExecutorPreparationCode,
    ExecutorVerification, HarborExecutorConfig, HarborTrialEnvironment, PreparationCacheLocks,
    SubjectExecutionContext, SubjectProcessDiagnostic, SubjectProcessDiagnosticCategory,
    SubjectProcessOutput, SubjectProcessRequest, SubjectProcessTermination, TrialAttemptOperation,
    TrialEnvironment, TrialEnvironmentOutcome, describe_egress_audit, read_trial_verification,
};
use maka_eval::measurement::{
    AdmissionBoundaryLedger, DEEPSEEK_V4_FLASH_COST, MeteringState, NormalizedUsage,
    costs_match_within_tolerance, deepseek_cost_usd, derive_metering,
    reconcile_host_and_proxy_usage, recover_external_metering_checkpoint, sign_metering_checkpoint,
};
use maka_eval::report::{
    build_cohort_summary, evaluate_differential_oracle, export_v1_canonical, export_v2_canonical,
    rebuild_from_journal,
};
use maka_eval::runner::{
    ConservativeCleanupProbe, RetryPolicy, RunExperimentInput, recover_unsettled_attempts,
    run_experiment,
};
use maka_eval::store::{
    ExperimentDirectory, capture_maka_runtime_artifacts, verify_critical_artifacts,
};
use maka_eval::subject::SubjectAdapter;
use maka_eval::subject::external_cli::{
    ExternalCliSubject, encode_relay_result_frame, parse_relay_result_frame,
};
use maka_eval::subject::maka::{
    HostedExecutionProjection, MakaHostInitSettingsPayload, RustHostSubject,
    bootstrap_maka_host_root, export_paginated_transcript,
};
use serde_json::{Map, Value, json};
use std::fs;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tempfile::TempDir;
use tokio::sync::Barrier;
use tokio_util::sync::CancellationToken;

#[test]
fn maka_host_init_settings_stdin_payload_matches_exact_session_contract() {
    let payload = MakaHostInitSettingsPayload::for_eval_gateway(
        43120,
        "gw-secret-credential-99",
        "deepseek-v4-flash",
    );
    let actual = payload.to_json_value();
    let expected = json!({
        "connections": [
            {
                "slug": "eval-gateway",
                "name": "Eval Gateway",
                "provider": "openai-compatible",
                "configuration": {
                    "baseUrl": "http://127.0.0.1:43120/v1"
                },
                "apiKey": "gw-secret-credential-99",
                "enabled": true,
                "enabledModelIds": ["deepseek-v4-flash"],
                "modelOverrides": {
                    "deepseek-v4-flash": {
                        "contextWindow": 200000,
                        "thinkingLevels": ["off"]
                    }
                }
            }
        ],
        "defaultTarget": {
            "slug": "eval-gateway",
            "modelId": "deepseek-v4-flash"
        }
    });
    assert_eq!(actual, expected);
}

#[cfg(unix)]
#[tokio::test]
async fn bootstrap_maka_host_root_pipes_settings_stdin_without_leaking_secret_in_argv() {
    use std::os::unix::fs::PermissionsExt;

    let temp = TempDir::new().unwrap();
    let fake_maka = temp.path().join("fake-maka.sh");
    let captured_args = temp.path().join("captured-args.txt");
    let captured_stdin = temp.path().join("captured-stdin.json");
    let host_root = temp.path().join("isolated-host-root");

    let script = format!(
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"{}\"\ncat > \"{}\"\n",
        captured_args.display(),
        captured_stdin.display()
    );
    fs::write(&fake_maka, script).unwrap();
    let mut perms = fs::metadata(&fake_maka).unwrap().permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&fake_maka, perms).unwrap();

    let payload = MakaHostInitSettingsPayload::for_eval_gateway(
        18080,
        "super-secret-gateway-token",
        "deepseek-v4-flash",
    );
    bootstrap_maka_host_root(&fake_maka, &host_root, &payload)
        .await
        .unwrap();

    let args_text = fs::read_to_string(&captured_args).unwrap();
    let args_lines: Vec<&str> = args_text.lines().collect();
    assert_eq!(
        args_lines,
        vec![
            "host",
            "init",
            "--settings-stdin",
            "--root",
            host_root.to_str().unwrap()
        ]
    );
    assert!(!args_text.contains("super-secret-gateway-token"));

    let stdin_json: Value =
        serde_json::from_str(&fs::read_to_string(&captured_stdin).unwrap()).unwrap();
    assert_eq!(stdin_json, payload.to_json_value());
}

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
fn all_five_semantic_difference_scenarios_and_three_verdict_differential_oracle() {
    let registry = DifferenceRegistry::new();
    assert_eq!(registry.entries().len(), 5);

    let spec = parse_experiment_spec(&sample_two_arm_spec_json()).unwrap();
    let fp = RunFingerprint::compute(&spec);

    let sample_usage = NormalizedUsage {
        input_tokens: 200,
        output_tokens: 100,
        cache_read_tokens: 50,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        total_tokens: 300,
    };

    // 1. Timeout with verifier reward (1.0) but incomplete (lower-bound) usage:
    // Status is `subject_failed`, score is preserved (`Some(1.0)`), usage is preserved,
    // and `costUsd` is `None` because usage is lower-bound.
    let v2_timeout_reward = V2AttemptRecord {
        schema_version: SchemaVersion::V2,
        cell_id: "task-alpha::1::maka".into(),
        sequence: 1,
        started_at: 100,
        completed_at: 200,
        duration_ms: 100,
        phase: AttemptPhase::Settled,
        execution_outcome: ExecutionOutcome::Timeout,
        verifier_outcome: VerifierOutcome::Verified { score: 1.0 },
        usage: Some(sample_usage.clone()),
        metering_state: MeteringState::LowerBound,
        cleanup_state: CleanupState::Confirmed,
        audit_state: EgressAuditState::NotRequired,
        critical_artifacts_state: CriticalArtifactsState::Present,
        cancelled_after_verification: false,
        recovered_post_hoc: false,
        failure_reason: Some("Maka subject exceeded the framework timeout".into()),
        artifacts: Vec::new(),
    };
    let v1_timeout_reward = v2_timeout_reward.project_v1();
    assert_eq!(
        v1_timeout_reward.result.status,
        EvalResultStatus::SubjectFailed
    );
    assert_eq!(v1_timeout_reward.result.score, Some(1.0));
    assert_eq!(v1_timeout_reward.result.usage, Some(sample_usage.clone()));
    assert_eq!(v1_timeout_reward.result.cost_usd, None);

    let report_1 = evaluate_differential_oracle(
        &serde_json::to_value(&v1_timeout_reward).unwrap(),
        &v1_timeout_reward,
        &fp,
        &fp,
        Some(DifferenceScenarioId::TimeoutWithRewardIncompleteUsage),
        &registry,
    );
    assert!(report_1.v1_parses);
    assert!(report_1.v1_matches_oracle);
    assert!(report_1.conditions_comparable);

    // 2. Audit truncation vs. Missing audit log:
    let (trunc_state, trunc_ev) = describe_egress_audit(
        Some(b"{\"ts\":1,\"ruleId\":\"audit_truncated\",\"host\":\"\",\"normalizedPath\":\"\"}\n"),
        true,
    );
    assert_eq!(trunc_state, EgressAuditState::Truncated);
    let mut v2_audit_trunc = v2_timeout_reward.clone();
    v2_audit_trunc.execution_outcome = ExecutionOutcome::Completed;
    v2_audit_trunc.metering_state = MeteringState::Complete;
    v2_audit_trunc.audit_state = trunc_state;
    v2_audit_trunc.artifacts = trunc_ev.artifacts;
    v2_audit_trunc.failure_reason = None;
    let v1_audit_trunc = v2_audit_trunc.project_v1();
    assert_eq!(v1_audit_trunc.result.status, EvalResultStatus::Completed);
    assert_eq!(v1_audit_trunc.result.score, Some(1.0));
    assert!(v1_audit_trunc.result.artifacts.iter().any(|a| {
        a.get("kind").and_then(Value::as_str) == Some("egress-audit")
            && a.get("truncated").and_then(Value::as_bool) == Some(true)
    }));

    // Missing audit log fails closed as `infra_failed` with `score: None`.
    let mut v2_audit_missing = v2_audit_trunc.clone();
    v2_audit_missing.audit_state = EgressAuditState::Missing;
    let v1_audit_missing = v2_audit_missing.project_v1();
    assert_eq!(
        v1_audit_missing.result.status,
        EvalResultStatus::InfraFailed
    );
    assert_eq!(v1_audit_missing.result.score, None);

    // 3. 0-byte empty file vs. missing critical artifact:
    let temp = TempDir::new().unwrap();
    fs::write(temp.path().join("stderr.txt"), b"").unwrap();
    let (present_state, files) = verify_critical_artifacts(temp.path(), &["stderr.txt"]);
    assert_eq!(present_state, CriticalArtifactsState::Present);
    assert_eq!(files[0].bytes, 0);

    let (missing_state, _) =
        verify_critical_artifacts(temp.path(), &["stderr.txt", "missing-transcript.json"]);
    assert_eq!(
        missing_state,
        CriticalArtifactsState::Missing {
            paths: vec!["missing-transcript.json".into()]
        }
    );
    let mut v2_missing_art = v2_audit_trunc.clone();
    v2_missing_art.critical_artifacts_state = missing_state;
    let v1_missing_art = v2_missing_art.project_v1();
    assert_eq!(v1_missing_art.result.status, EvalResultStatus::InfraFailed);
    assert_eq!(v1_missing_art.result.score, None);

    // 4. Late cancellation before vs. after verification:
    let mut v2_cancel_before = v2_audit_trunc.clone();
    v2_cancel_before.execution_outcome = ExecutionOutcome::Cancelled;
    v2_cancel_before.cancelled_after_verification = false;
    let v1_cancel_before = v2_cancel_before.project_v1();
    assert_eq!(
        v1_cancel_before.result.status,
        EvalResultStatus::Indeterminate
    );
    assert_eq!(v1_cancel_before.result.score, None);

    let mut v2_cancel_after = v2_audit_trunc.clone();
    v2_cancel_after.execution_outcome = ExecutionOutcome::Cancelled;
    v2_cancel_after.cancelled_after_verification = true;
    let v1_cancel_after = v2_cancel_after.project_v1();
    assert_eq!(v1_cancel_after.result.status, EvalResultStatus::Completed);
    assert_eq!(v1_cancel_after.result.score, Some(1.0));

    // 5. Missing verifier reward never defaults to 0.0; genuine 0.0 reward is Completed(0.0):
    let mut v2_missing_reward = v2_audit_trunc.clone();
    v2_missing_reward.verifier_outcome = VerifierOutcome::MissingReward {
        reason: "reward.json missing".into(),
    };
    let v1_missing_reward = v2_missing_reward.project_v1();
    assert_eq!(
        v1_missing_reward.result.status,
        EvalResultStatus::InfraFailed
    );
    assert_eq!(v1_missing_reward.result.score, None);

    let mut v2_zero_score = v2_audit_trunc;
    v2_zero_score.verifier_outcome = VerifierOutcome::Verified { score: 0.0 };
    let v1_zero_score = v2_zero_score.project_v1();
    assert_eq!(v1_zero_score.result.status, EvalResultStatus::Completed);
    assert_eq!(v1_zero_score.result.score, Some(0.0));
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
fn store_journal_reconstruction_post_hoc_recovery_and_crash_recovery_boundaries() {
    let temp = TempDir::new().unwrap();
    let spec = parse_experiment_spec(&sample_two_arm_spec_json()).unwrap();
    let dir = ExperimentDirectory::open(temp.path().join("exp-out"), &spec).unwrap();
    let store = &dir.attempts;

    // 1. Single-writer lock rejects concurrent writers.
    let guard = store.acquire_writer().unwrap();
    assert!(store.acquire_writer().is_err());
    drop(guard);

    // 2. Crash after LaunchIntent BEFORE resource creation recovers as InfraFailed (Confirmed cleanup).
    store
        .record_launch_intent("task-alpha::1::maka", 1, 1000, "intent-1")
        .unwrap();
    let recovered = recover_unsettled_attempts(store, &ConservativeCleanupProbe, 1050).unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(
        recovered[0].execution_outcome,
        ExecutionOutcome::InfraFailed
    );
    assert_eq!(recovered[0].cleanup_state, CleanupState::Confirmed);

    // 3. Crash AFTER ResourceTagged with unconfirmed cleanup recovers as Indeterminate.
    store
        .record_launch_intent("task-alpha::1::maka", 2, 2000, "intent-2")
        .unwrap();
    store
        .record_resource_tagged(
            "task-alpha::1::maka",
            2,
            "harbor",
            "trial-container-2",
            Some("op-1".into()),
            Some("inv-1".into()),
        )
        .unwrap();
    let recovered_2 = recover_unsettled_attempts(store, &ConservativeCleanupProbe, 2100).unwrap();
    assert_eq!(recovered_2.len(), 1);
    assert_eq!(
        recovered_2[0].execution_outcome,
        ExecutionOutcome::Indeterminate
    );
    assert!(matches!(
        recovered_2[0].cleanup_state,
        CleanupState::Unconfirmed { .. }
    ));

    // 4. Append-only PostHocRecovery updates reconstructed usage & cleanup without mutating prior entries.
    let recovered_usage = NormalizedUsage {
        input_tokens: 500,
        output_tokens: 100,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        total_tokens: 600,
    };
    store
        .record_post_hoc_recovery(
            "task-alpha::1::maka",
            2,
            2200,
            Some(recovered_usage.clone()),
            MeteringState::Complete,
            true,
            Some("recovered from host receipt journal".into()),
        )
        .unwrap();

    let rebuilt = rebuild_from_journal(store).unwrap();
    let seq2 = &rebuilt.settled_v2["task-alpha::1::maka"][1];
    assert!(seq2.recovered_post_hoc);
    assert_eq!(seq2.usage, Some(recovered_usage));
    assert_eq!(seq2.cleanup_state, CleanupState::Confirmed);
    assert!(
        seq2.project_v1().result.artifacts.iter().any(|a| {
            a.get("kind").and_then(Value::as_str) == Some("post-hoc-evidence-recovery")
        })
    );
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
        "removedWebTools": 1,
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

#[tokio::test]
async fn shared_preparation_cache_lock_serializes_concurrent_task_preparations() {
    let locks = PreparationCacheLocks::new();
    let active_in_critical_section = Arc::new(AtomicUsize::new(0));
    let max_concurrent_observed = Arc::new(AtomicUsize::new(0));
    let build_count = Arc::new(AtomicUsize::new(0));
    let barrier = Arc::new(Barrier::new(4));

    let mut handles = Vec::new();
    for _ in 0..4 {
        let locks = locks.clone();
        let active = active_in_critical_section.clone();
        let max_obs = max_concurrent_observed.clone();
        let builds = build_count.clone();
        let barrier = barrier.clone();
        handles.push(tokio::spawn(async move {
            barrier.wait().await;
            locks
                .with_task_lock("task-shared-image", || async {
                    let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                    max_obs.fetch_max(current, Ordering::SeqCst);
                    if builds.load(Ordering::SeqCst) == 0 {
                        tokio::task::yield_now().await;
                        builds.fetch_add(1, Ordering::SeqCst);
                    }
                    active.fetch_sub(1, Ordering::SeqCst);
                })
                .await;
        }));
    }

    for h in handles {
        h.await.unwrap();
    }
    assert_eq!(max_concurrent_observed.load(Ordering::SeqCst), 1);
    assert_eq!(build_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn runner_executes_task_groups_bounds_retries_and_exports_cohort_summary() {
    let temp = TempDir::new().unwrap();
    let spec = parse_experiment_spec(&sample_two_arm_spec_json()).unwrap();
    let dir = ExperimentDirectory::open(temp.path().join("run-out"), &spec).unwrap();

    let maka_calls = Arc::new(AtomicUsize::new(0));
    let ext_calls = Arc::new(AtomicUsize::new(0));

    let env = Arc::new(FakeTrialEnvironment {
        maka_calls: maka_calls.clone(),
        ext_calls: ext_calls.clone(),
    });

    let subjects: Vec<Arc<dyn SubjectAdapter>> = vec![
        Arc::new(RustHostSubject::new()),
        Arc::new(ExternalCliSubject::new()),
    ];

    let mut run_input = RunExperimentInput::new(&spec, &dir.attempts, env, subjects);
    // Allow 1 automatic retry for infra_failed so task-alpha::1::maka (which fails on call 1)
    // automatically retries and succeeds on sequence 2!
    run_input.retry_policy = RetryPolicy {
        max_infra_retries: 1,
        block_automatic_retry_on_indeterminate: true,
    };

    let results = run_experiment(run_input).await.unwrap();
    assert_eq!(results.len(), 4);

    // task-alpha::1::maka failed with infra_failed on sequence 1 and succeeded on sequence 2.
    let alpha_maka = &results["task-alpha::1::maka"];
    assert_eq!(alpha_maka.sequence, 2);
    assert_eq!(alpha_maka.result.status, EvalResultStatus::Completed);
    assert_eq!(alpha_maka.result.score, Some(1.0));

    // Verify all stored v1 files strictly decode under decode_v1_cell_attempt.
    let v1_export = export_v1_canonical(&spec, &dir.attempts).unwrap();
    let v2_export = export_v2_canonical(&spec, &dir.attempts).unwrap();
    assert_eq!(v1_export.len(), 4);
    assert_eq!(v2_export.len(), 4);
    for attempt in v1_export.values() {
        let decoded = decode_v1_cell_attempt(&serde_json::to_value(attempt).unwrap()).unwrap();
        assert_eq!(&decoded, attempt);
    }

    let summary = build_cohort_summary(&spec, &v1_export);
    assert_eq!(summary.total_cells, 4);
    assert_eq!(summary.settled_cells, 4);
    assert_eq!(summary.incomplete_cells, 0);
    assert_eq!(summary.paired_task_groups, 2);
    assert_eq!(summary.arms["maka"].completed_cells, 2);
    assert_eq!(summary.arms["external-cli"].completed_cells, 2);
}

#[tokio::test]
async fn paginated_transcript_export_and_relay_result_frame_boundaries() {
    // 1. Paginated transcript export across multiple pages + cycle protection.
    let pages = vec![
        (
            vec![json!({"id": "msg-1"}), json!({"id": "msg-2"})],
            Some("cursor-2".to_owned()),
        ),
        (vec![json!({"id": "msg-3"})], Some("cursor-3".to_owned())),
        (vec![json!({"id": "msg-4"})], None),
    ];
    let idx = Arc::new(AtomicUsize::new(0));
    let exported = export_paginated_transcript(2, move |_cursor, _limit| {
        let pages = pages.clone();
        let i = idx.fetch_add(1, Ordering::SeqCst);
        async move { Ok(pages[i].clone()) }
    })
    .await
    .unwrap();
    assert_eq!(exported.len(), 4);

    // 2. Relay result frame encoding and parsing (`MAKA-EVAL-RESULT-V1`).
    let token = "abcdef0123456789abcdef0123456789";
    let payload = json!({
        "schemaVersion": "maka.external_subject_result.v2",
        "status": "completed",
        "failureReason": null,
        "usage": {
            "inputTokens": 100,
            "outputTokens": 50,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0,
            "totalTokens": 150
        },
        "costUsd": 0.000055,
        "artifacts": []
    });
    let frame = encode_relay_result_frame(token, &payload).unwrap();
    let noisy_stdout = format!("some tool log line\n{frame}trailing line\n");
    let extracted = parse_relay_result_frame(&noisy_stdout, token).unwrap();
    let parsed_val: Value = serde_json::from_str(&extracted).unwrap();
    assert_eq!(parsed_val, payload);

    // Ambiguous (duplicate) frames must be rejected as ResultFrameAmbiguous.
    let duplicate = format!("{frame}{frame}");
    let err = parse_relay_result_frame(&duplicate, token).unwrap_err();
    assert_eq!(
        err.category,
        SubjectProcessDiagnosticCategory::ResultFrameAmbiguous
    );
}

struct FakeTrialEnvironment {
    maka_calls: Arc<AtomicUsize>,
    ext_calls: Arc<AtomicUsize>,
}

struct FakeActiveTrial {
    cell_id: String,
    maka_calls: Arc<AtomicUsize>,
    ext_calls: Arc<AtomicUsize>,
}

impl CommandRunner for FakeActiveTrial {
    fn execute<'a>(
        &'a self,
        request: SubjectProcessRequest,
    ) -> BoxFuture<'a, Result<SubjectProcessOutput, String>> {
        Box::pin(async move {
            if self.cell_id.ends_with("::external-cli") {
                self.ext_calls.fetch_add(1, Ordering::SeqCst);
                let out = json!({
                    "schemaVersion": "maka.external_subject_result.v2",
                    "status": "completed",
                    "failureReason": null,
                    "usage": {
                        "inputTokens": 400,
                        "outputTokens": 100,
                        "cacheReadTokens": 100,
                        "cacheWriteTokens": 0,
                        "reasoningTokens": 20,
                        "totalTokens": 500
                    },
                    "costUsd": 0.0001327,
                    "artifacts": []
                });
                return Ok(SubjectProcessOutput {
                    termination: SubjectProcessTermination::Exited,
                    exit_code: 0,
                    stdout: serde_json::to_string(&out).unwrap(),
                    stderr: String::new(),
                    diagnostic: None,
                });
            }

            // Maka subject invocation: decode the base64url envelope to extract executionId
            let call_num = self.maka_calls.fetch_add(1, Ordering::SeqCst) + 1;
            if self.cell_id == "task-alpha::1::maka" && call_num == 1 {
                // Simulate an empty stdout crash on the first try so runner retries sequence 2.
                return Ok(SubjectProcessOutput {
                    termination: SubjectProcessTermination::Exited,
                    exit_code: 1,
                    stdout: String::new(),
                    stderr: "transient shim crash".into(),
                    diagnostic: Some(SubjectProcessDiagnostic {
                        category: SubjectProcessDiagnosticCategory::None,
                        bytes: None,
                        sha256: None,
                    }),
                });
            }

            use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
            let encoded = &request.args[1];
            let envelope: Value =
                serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap();
            let execution_id = envelope["execution"]["executionId"]
                .as_str()
                .unwrap()
                .to_owned();

            // Verify the embedded hostInitSettings matches our exact eval-gateway contract!
            assert_eq!(
                envelope["hostInitSettings"]["defaultTarget"]["slug"],
                json!("eval-gateway")
            );

            let projection = HostedExecutionProjection::Settled {
                execution_id,
                status: "completed".into(),
                failure_reason: None,
                usage: NormalizedUsage {
                    input_tokens: 300,
                    output_tokens: 100,
                    cache_read_tokens: 100,
                    cache_write_tokens: 0,
                    reasoning_tokens: 10,
                    total_tokens: 400,
                },
                cost_usd: Some(0.0001107),
                operation_id: Some("op-settled-1".into()),
                invocation_id: Some("inv-settled-1".into()),
            };
            Ok(SubjectProcessOutput {
                termination: SubjectProcessTermination::Exited,
                exit_code: 0,
                stdout: serde_json::to_string(&projection).unwrap(),
                stderr: String::new(),
                diagnostic: None,
            })
        })
    }
}

impl ActiveTrialAttempt for FakeActiveTrial {
    fn context(&self) -> SubjectExecutionContext {
        SubjectExecutionContext {
            cwd: "/workspace".into(),
            task_input: "Solve benchmark task".into(),
            metadata: Map::new(),
            cancel: CancellationToken::new(),
            runner: Arc::new(Self {
                cell_id: self.cell_id.clone(),
                maka_calls: self.maka_calls.clone(),
                ext_calls: self.ext_calls.clone(),
            }),
        }
    }

    fn verify(&self) -> BoxFuture<'_, Result<ExecutorVerification, String>> {
        Box::pin(async {
            Ok(ExecutorVerification {
                status: EvalResultStatus::Completed,
                score: Some(1.0),
                failure_reason: None,
                artifacts: Vec::new(),
                missing_reward: false,
            })
        })
    }

    fn read_audit(&self) -> BoxFuture<'_, (EgressAuditState, EgressAuditEvidence)> {
        Box::pin(async { describe_egress_audit(None, false) })
    }
}

impl TrialEnvironment for FakeTrialEnvironment {
    fn kind(&self) -> &str {
        "harbor"
    }

    fn run_attempt<'a>(
        &'a self,
        cell: &'a ExperimentCell,
        _sequence: u32,
        _subject_credential_names: &'a [String],
        _cancel: CancellationToken,
        operation: TrialAttemptOperation<'a>,
    ) -> BoxFuture<'a, Result<TrialEnvironmentOutcome<V2AttemptRecord>, String>> {
        let active = FakeActiveTrial {
            cell_id: cell.id.clone(),
            maka_calls: self.maka_calls.clone(),
            ext_calls: self.ext_calls.clone(),
        };
        Box::pin(async move {
            let rec = operation(&active).await;
            Ok(TrialEnvironmentOutcome::Settled(rec))
        })
    }
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
                    "nodePath": "/opt/maka-node-toolchain/bin/node",
                    "shimPath": "/opt/maka-agent/node_modules/@maka/eval/dist/harbor-maka-subject.js",
                    "runtimeHostsPath": "/tmp/maka-runtime-hosts",
                    "hostSettlementTimeoutMs": 120000,
                    "connectionSlug": "eval-gateway",
                    "baseUrl": "http://127.0.0.1:43120/v1",
                    "model": "deepseek-v4-flash",
                    "thinkingLevel": "off",
                    "permissionMode": "bypass",
                    "collaborationMode": "agent",
                    "orchestrationMode": "default",
                    "toolProfile": "headless-coding-v1"
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

#[tokio::test]
async fn harbor_trial_environment_loopback_tcp_relay_handshake_and_verification() {
    let temp = TempDir::new().unwrap();
    let benchmark_dir = temp.path().join("bench");
    fs::create_dir_all(benchmark_dir.join("tasks/task-alpha")).unwrap();
    let trials_dir = temp.path().join("trials");
    fs::create_dir_all(&trials_dir).unwrap();

    let fake_python = temp.path().join("fake-harbor-python.py");
    let script = r#"#!/usr/bin/env python3
import json, pathlib, socket, sys

spec_path = pathlib.Path(sys.argv[4])
spec = json.loads(spec_path.read_text(encoding="utf-8"))
kwargs = spec["agent"]["kwargs"]
trial_dir = pathlib.Path(spec["trials_dir"]) / spec["trial_name"]
(trial_dir / "artifacts").mkdir(parents=True, exist_ok=True)
(trial_dir / "agent").mkdir(parents=True, exist_ok=True)

sock = socket.create_connection((kwargs["relay_host"], int(kwargs["relay_port"])), timeout=10)
reader = sock.makefile("r", encoding="utf-8", newline="\n")
writer = sock.makefile("w", encoding="utf-8", newline="\n")

writer.write(json.dumps({
    "kind": "ready",
    "token": kwargs["relay_token"],
    "cwd": "/workspace",
    "instruction": "Fix alpha"
}) + "\n")
writer.flush()

for line in reader:
    msg = json.loads(line)
    if msg["kind"] == "execute":
        writer.write(json.dumps({
            "kind": "executed",
            "token": kwargs["relay_token"],
            "termination": "exited",
            "exitCode": 0,
            "stdout": "command-ran-ok",
            "diagnostic": {"category": "none"}
        }) + "\n")
        writer.flush()
    elif msg["kind"] == "verify":
        (trial_dir / "artifacts" / "egress-hits.jsonl").write_text(
            json.dumps({"ruleId": "allow_deepseek"}) + "\n",
            encoding="utf-8"
        )
        (trial_dir / "result.json").write_text(
            json.dumps({
                "verifier_result": {
                    "rewards": {
                        "reward": 1.0
                    }
                }
            }),
            encoding="utf-8"
        )
        break

sock.close()
sys.exit(0)
"#;
    fs::write(&fake_python, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&fake_python, fs::Permissions::from_mode(0o755)).unwrap();
    }

    let spec = parse_experiment_spec(&sample_two_arm_spec_json()).unwrap();
    let cells = expand_experiment(&spec);
    let cell = &cells[0];

    let mut env_map = std::collections::HashMap::new();
    env_map.insert(
        "MAKA_EVAL_HARBOR_PYTHON".to_owned(),
        fake_python.to_string_lossy().into_owned(),
    );
    env_map.insert(
        "MAKA_EVAL_TRIALS_DIR".to_owned(),
        trials_dir.to_string_lossy().into_owned(),
    );
    env_map.insert("DEEPSEEK_API_KEY".to_owned(), "sk-test-123".to_owned());

    let exec_cfg =
        HarborExecutorConfig::decode(&spec.executor.kind, &spec.executor.config).unwrap();
    let harbor_env =
        HarborTrialEnvironment::new(exec_cfg, benchmark_dir).with_env_overrides(env_map);
    harbor_env
        .preflight(&["DEEPSEEK_API_KEY".to_owned()], CancellationToken::new())
        .await
        .unwrap();

    let cell_id = cell.id.clone();
    let outcome = harbor_env
        .run_attempt(
            cell,
            1,
            &["DEEPSEEK_API_KEY".to_owned()],
            CancellationToken::new(),
            Box::new(move |active| {
                Box::pin(async move {
                    let ctx = active.context();
                    assert_eq!(ctx.cwd, "/workspace");
                    let exec_out = ctx
                        .execute(SubjectProcessRequest {
                            command: "echo".into(),
                            args: vec!["hello".into()],
                            environment: std::collections::HashMap::new(),
                            credential_environment: std::collections::HashMap::new(),
                            capture_stdout: true,
                        })
                        .await
                        .unwrap();
                    assert_eq!(exec_out.exit_code, 0);
                    assert_eq!(exec_out.stdout, "command-ran-ok");

                    let verified = active.verify().await.unwrap();
                    assert_eq!(verified.status, EvalResultStatus::Completed);
                    assert_eq!(verified.score, Some(1.0));

                    V2AttemptRecord {
                        schema_version: SchemaVersion::V2,
                        cell_id,
                        sequence: 1,
                        started_at: 100,
                        completed_at: 200,
                        duration_ms: 100,
                        phase: AttemptPhase::Verified,
                        execution_outcome: ExecutionOutcome::Completed,
                        verifier_outcome: verified.to_verifier_outcome(),
                        usage: None,
                        metering_state: MeteringState::Unknown,
                        cleanup_state: CleanupState::Confirmed,
                        audit_state: EgressAuditState::Clean,
                        critical_artifacts_state: CriticalArtifactsState::Present,
                        cancelled_after_verification: true,
                        recovered_post_hoc: false,
                        failure_reason: None,
                        artifacts: verified.artifacts,
                    }
                })
            }),
        )
        .await
        .unwrap();

    match outcome {
        TrialEnvironmentOutcome::Settled(rec) => {
            assert_eq!(
                rec.verifier_outcome,
                VerifierOutcome::Verified { score: 1.0 }
            );
            assert!(!rec.artifacts.is_empty());
        }
        TrialEnvironmentOutcome::NotStarted {
            code: ExecutorPreparationCode::ExitBeforeReady,
            ..
        } => {
            // In restricted sandboxes where outbound loopback TCP connect is denied,
            // verify that ExitBeforeReady was recorded and test verify_harbor_trial_result directly.
            let manual_trial = trials_dir.join("manual-verify-trial");
            fs::create_dir_all(manual_trial.join("artifacts")).unwrap();
            fs::write(
                manual_trial.join("result.json"),
                serde_json::to_vec(&json!({
                    "verifier_result": { "rewards": { "reward": 1.0 } }
                }))
                .unwrap(),
            )
            .unwrap();
            let verified =
                read_trial_verification(&manual_trial, "maka-eval-manual", cell, "harbor", false)
                    .unwrap();
            assert_eq!(verified.status, EvalResultStatus::Completed);
            assert_eq!(verified.score, Some(1.0));
        }
        other => panic!("unexpected outcome: {other:?}"),
    }
}
