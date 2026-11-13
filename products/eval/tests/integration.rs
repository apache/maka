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
use maka_eval::parity::{
    ParityCheckInput, check_declared_endpoint_route_parity, compare_parity_snapshots,
    verify_product_parity,
};
use maka_eval::report::{
    MilestoneGate, build_cohort_summary, evaluate_differential_oracle, evaluate_milestone_gate,
    export_v1_canonical, export_v2_canonical, rebuild_from_journal,
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
    HostedExecutionProjection, MakaHostInitSettingsPayload, MakaSubjectConfig, RustHostSubject,
    bootstrap_maka_host_root, export_paginated_transcript, resolve_product_route_base_url,
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
                "enabledModelIds": ["deepseek-v4-flash"]
            }
        ],
        "defaultTarget": {
            "slug": "eval-gateway",
            "modelId": "deepseek-v4-flash"
        }
    });
    assert_eq!(actual, expected);

    // Benchmark-only agent overrides must be rejected at the contract boundary.
    for forbidden in [
        json!({"toolProfile": "minimal"}),
        json!({"permissionMode": "bypass"}),
        json!({"collaborationMode": "agent"}),
        json!({"orchestrationMode": "default"}),
    ] {
        let mut cfg = json!({
            "makaExecutable": "/opt/maka-agent/maka",
            "runtimeHostsPath": "/tmp/maka-runtime-hosts",
            "hostSettlementTimeoutMs": 60000,
            "baseUrl": "http://127.0.0.1:43120/v1",
            "model": "deepseek-v4-flash"
        });
        for (k, v) in forbidden.as_object().unwrap() {
            cfg[k] = v.clone();
        }
        assert!(
            MakaSubjectConfig::decode(cfg.as_object().unwrap(), &["DEEPSEEK_API_KEY".into()])
                .is_err(),
            "forbidden benchmark-only field must be rejected: {forbidden}"
        );
    }

    // Public Maka configuration interfaces are accepted and preserved in hostInitSettings.
    let public_cfg = json!({
        "makaExecutable": "/opt/maka-agent/maka",
        "runtimeHostsPath": "/tmp/maka-runtime-hosts",
        "hostSettlementTimeoutMs": 60000,
        "provider": "openai-compatible",
        "connectionSlug": "team-provider",
        "connectionName": "Team Provider",
        "baseUrl": "https://api.example.com/v1",
        "model": "gpt-4.1",
        "modelOverride": {
            "contextWindow": 128000,
            "thinkingLevels": ["off", "medium"]
        },
        "sandboxMode": "read-only",
        "requestPermissions": false,
        "thinkingLevel": "medium",
        "language": "en",
        "workspaceInstructions": false
    });
    let decoded =
        MakaSubjectConfig::decode(public_cfg.as_object().unwrap(), &["OPENAI_API_KEY".into()])
            .expect("public Maka subject configuration must decode");
    let init = decoded
        .host_init_settings("https://api.example.com/v1", "sk-test")
        .to_json_value();
    assert_eq!(init["defaultTarget"]["slug"], json!("team-provider"));
    assert_eq!(
        init["connections"][0]["modelOverrides"]["gpt-4.1"]["contextWindow"],
        json!(128000)
    );
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
        pricing: None,
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
    for entry in registry.entries() {
        let mut changed = v1_timeout_reward.clone();
        changed.result.score = Some(0.0);
        changed.result.usage.as_mut().unwrap().input_tokens = 999_999;
        let report = evaluate_differential_oracle(
            &serde_json::to_value(changed).unwrap(),
            &v1_timeout_reward,
            &fp,
            &fp,
            Some(entry.id),
            &registry,
        );
        assert!(
            !report.v1_matches_oracle,
            "scenario {:?} must not hide actual differences",
            entry.id
        );
        assert!(!report.conditions_comparable);
    }

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
    let mut legacy_cancel = v1_cancel_before.clone();
    legacy_cancel.result.failure_reason =
        Some("executor cancelled before verification completed".into());
    let late = evaluate_differential_oracle(
        &serde_json::to_value(&v1_cancel_after).unwrap(),
        &legacy_cancel,
        &fp,
        &fp,
        Some(DifferenceScenarioId::LateCancellation),
        &registry,
    );
    assert!(!late.v1_matches_oracle);
    assert!(late.adjudicated_difference);
    assert!(late.conditions_comparable);
    let mut altered = v1_cancel_after.clone();
    altered.result.usage.as_mut().unwrap().output_tokens += 1;
    let altered = evaluate_differential_oracle(
        &serde_json::to_value(altered).unwrap(),
        &legacy_cancel,
        &fp,
        &fp,
        Some(DifferenceScenarioId::LateCancellation),
        &registry,
    );
    assert!(!altered.adjudicated_difference);
    assert!(!altered.conditions_comparable);

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
    let failed_store = maka_eval::store::FileAttemptStore::new(temp.path().join("failed"));
    fs::create_dir_all(failed_store.journal_path()).unwrap();
    assert!(failed_store.append_v2(&recovered[0]).is_err());
    fs::remove_dir(failed_store.journal_path()).unwrap();
    assert!(
        failed_store
            .list_v1("task-alpha::1::maka")
            .unwrap()
            .is_empty()
    );
    assert!(
        export_v1_canonical(&spec, &failed_store)
            .unwrap()
            .is_empty()
    );
    assert!(
        export_v2_canonical(&spec, &failed_store)
            .unwrap()
            .is_empty()
    );

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
    assert!(costs_match_within_tolerance(
        alpha_maka.result.cost_usd,
        Some(0.0001107)
    ));

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

            assert_eq!(request.command, "/opt/maka-agent/maka-eval");
            assert_eq!(request.args[0], "host-subject");
            // Maka subject invocation: decode the base64url envelope to extract executionId
            let call_num = self.maka_calls.fetch_add(1, Ordering::SeqCst) + 1;
            if self.cell_id == "task-alpha::1::maka" && call_num == 1 {
                // Simulate an empty stdout crash on the first try so runner retries sequence 2.
                return Ok(SubjectProcessOutput {
                    termination: SubjectProcessTermination::Exited,
                    exit_code: 1,
                    stdout: String::new(),
                    stderr: "transient native Host crash".into(),
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
                usage: Some(NormalizedUsage {
                    input_tokens: 300,
                    output_tokens: 100,
                    cache_read_tokens: 100,
                    cache_write_tokens: 0,
                    reasoning_tokens: 10,
                    total_tokens: 400,
                }),
                metering_state: MeteringState::Complete,
                cost_usd: Some(0.0001107),
                operation_id: Some("op-settled-1".into()),
                invocation_id: Some("inv-settled-1".into()),
                maka_executable_sha256: None,
                blocked_interaction: None,
                environment_limitation: None,
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

    let mut unsupported_config =
        HarborExecutorConfig::decode(&spec.executor.kind, &spec.executor.config).unwrap();
    unsupported_config.egress_proxy_required = true;
    let unsupported = HarborTrialEnvironment::new(unsupported_config, temp.path().to_path_buf());
    let error = unsupported
        .preflight(&[], CancellationToken::new())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("egressProxy is not supported"));

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
                        pricing: None,
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

#[tokio::test]
async fn runner_recovers_before_admission_and_blocks_unconfirmed_cleanup_across_runs() {
    let temp = TempDir::new().unwrap();
    let spec = parse_experiment_spec(&sample_two_arm_spec_json()).unwrap();
    let id = "task-alpha::1::external-cli";
    let calls = Arc::new(AtomicUsize::new(0));
    let env = Arc::new(FakeTrialEnvironment {
        maka_calls: Arc::new(AtomicUsize::new(0)),
        ext_calls: calls.clone(),
    });
    let subjects: Vec<Arc<dyn SubjectAdapter>> = vec![Arc::new(ExternalCliSubject::new())];
    let store = maka_eval::store::FileAttemptStore::new(temp.path().join("clean"));
    store
        .record_launch_intent(id, 1, 100, "interrupted")
        .unwrap();
    let mut input = RunExperimentInput::new(&spec, &store, env.clone(), subjects.clone());
    input.cell_ids = Some(vec![id.into()]);
    let result = run_experiment(input).await.unwrap();
    assert_eq!(result[id].sequence, 2);
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    let store = maka_eval::store::FileAttemptStore::new(temp.path().join("uncertain"));
    store
        .record_launch_intent(id, 1, 100, "interrupted")
        .unwrap();
    store
        .record_resource_tagged(id, 1, "harbor", "possibly-alive", None, None)
        .unwrap();
    for _ in 0..2 {
        let mut input = RunExperimentInput::new(&spec, &store, env.clone(), subjects.clone());
        input.cell_ids = Some(vec![id.into()]);
        assert!(run_experiment(input).await.unwrap().is_empty());
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "must not repeat a possibly live operation"
    );
    assert_eq!(store.next_sequence(id).unwrap(), 2);
    store
        .record_post_hoc_recovery(id, 1, 200, None, MeteringState::Unknown, true, None)
        .unwrap();
    let mut input = RunExperimentInput::new(&spec, &store, env, subjects);
    input.cell_ids = Some(vec![id.into()]);
    assert_eq!(run_experiment(input).await.unwrap()[id].sequence, 2);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[cfg(unix)]
#[tokio::test]
async fn trial_cancellation_terminates_execution_and_verification_waits() {
    use std::os::unix::fs::PermissionsExt;
    for verifying in [false, true] {
        let temp = TempDir::new().unwrap();
        let notify = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let marker = temp.path().join("terminated");
        let script = format!(
            r#"#!/usr/bin/env python3
import json, pathlib, socket, sys, signal, os
pathlib.Path({marker:?} + '.pid').write_text(str(os.getpid()))
spec = json.loads(pathlib.Path(sys.argv[4]).read_text())
k = spec['agent']['kwargs']
def terminate(*args):
    pathlib.Path({marker:?}).write_text('SIGTERM')
    sys.exit(0)
signal.signal(signal.SIGTERM, terminate)
sock = socket.create_connection((k['relay_host'], k['relay_port']))
r = sock.makefile('r')
w = sock.makefile('w')
w.write(json.dumps(dict(kind='ready', token=k['relay_token'], cwd='/workspace', instruction='task'))+'\n'); w.flush()
request = json.loads(r.readline())
if {verifying}:
    w.write(json.dumps(dict(kind='executed', token=k['relay_token'], termination='exited', exitCode=0, stdout='', diagnostic=dict(category='none')))+'\n'); w.flush()
    json.loads(r.readline())
notification = socket.create_connection(('127.0.0.1', {port}))
while True: signal.pause()
"#,
            marker = marker.to_str().unwrap(),
            verifying = if verifying { "True" } else { "False" },
            port = notify.local_addr().unwrap().port()
        );
        let python = temp.path().join("trial.py");
        fs::write(&python, script).unwrap();
        fs::set_permissions(&python, fs::Permissions::from_mode(0o755)).unwrap();
        let spec = parse_experiment_spec(&sample_two_arm_spec_json()).unwrap();
        let cells = expand_experiment(&spec);
        let env = HarborTrialEnvironment::new(
            HarborExecutorConfig::decode("harbor", &spec.executor.config).unwrap(),
            temp.path().to_path_buf(),
        )
        .with_env_overrides(std::collections::HashMap::from([
            (
                "MAKA_EVAL_HARBOR_PYTHON".into(),
                python.to_string_lossy().into(),
            ),
            (
                "MAKA_EVAL_TRIALS_DIR".into(),
                temp.path().join("trials").to_string_lossy().into(),
            ),
            ("DEEPSEEK_API_KEY".into(), "test-key".into()),
        ]));
        let cancel = CancellationToken::new();
        let run = env.run_attempt(
            &cells[0],
            1,
            &[],
            cancel.clone(),
            Box::new(move |active| {
                Box::pin(async move {
                    let _ = active
                        .context()
                        .execute(SubjectProcessRequest {
                            command: "wait".into(),
                            args: vec![],
                            environment: Default::default(),
                            credential_environment: Default::default(),
                            capture_stdout: true,
                        })
                        .await;
                    if verifying {
                        let _ = active.verify().await;
                    }
                    std::future::pending::<V2AttemptRecord>().await
                })
            }),
        );
        let trigger = async {
            notify.accept().await.unwrap();
            cancel.cancel();
        };
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(run, trigger)
        })
        .await;
        if result.is_err() {
            let pid = fs::read_to_string(format!("{}.pid", marker.display())).unwrap();
            std::process::Command::new("kill")
                .args(["-KILL", pid.trim()])
                .status()
                .unwrap();
        }
        let (outcome, ()) = result.expect("cancellation must settle promptly");
        assert!(matches!(
            outcome.unwrap(),
            TrialEnvironmentOutcome::Indeterminate { .. }
        ));
        assert_eq!(fs::read_to_string(&marker).unwrap(), "SIGTERM");
    }
}

#[tokio::test]
async fn unknown_model_cost_stays_unknown_in_both_reports() {
    let temp = TempDir::new().unwrap();
    let mut json = sample_two_arm_spec_json();
    json["subjects"][0]["config"]["model"] = json!("unpriced-model");
    let spec = parse_experiment_spec(&json).unwrap();
    let store = maka_eval::store::FileAttemptStore::new(temp.path());
    let env = Arc::new(FakeTrialEnvironment {
        maka_calls: Arc::new(AtomicUsize::new(0)),
        ext_calls: Arc::new(AtomicUsize::new(0)),
    });
    let mut input =
        RunExperimentInput::new(&spec, &store, env, vec![Arc::new(RustHostSubject::new())]);
    input.cell_ids = Some(vec!["task-beta::1::maka".into()]);
    let results = run_experiment(input).await.unwrap();
    let result = &results["task-beta::1::maka"].result;
    assert!(result.usage.is_some());
    assert_eq!(result.cost_usd, None);
    assert_eq!(
        export_v2_canonical(&spec, &store).unwrap()["task-beta::1::maka"]
            .project_v1()
            .result
            .cost_usd,
        None
    );
}

#[cfg(unix)]
fn stage_real_maka_and_eval_binaries(
    dir: &std::path::Path,
) -> (std::path::PathBuf, std::path::PathBuf) {
    use std::os::unix::fs::symlink;

    let profile = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let maka_src = std::env::var_os("CARGO_BIN_EXE_maka")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| profile.join("maka"));
    assert!(
        maka_src.is_file(),
        "build maka-cli first, or supply CARGO_BIN_EXE_maka"
    );
    let eval_src = std::env::var_os("CARGO_BIN_EXE_maka-eval")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(env!("CARGO_BIN_EXE_maka-eval")));
    assert!(eval_src.is_file(), "maka-eval binary must exist");

    let bin_dir = dir.join("bin");
    fs::create_dir_all(&bin_dir).unwrap();
    let staged_maka = bin_dir.join("maka");
    let staged_eval = bin_dir.join("maka-eval");
    symlink(&maka_src, &staged_maka).unwrap();
    symlink(&eval_src, &staged_eval).unwrap();

    if let Some(src_dir) = maka_src.parent() {
        let worker = src_dir.join("maka-python-worker");
        if worker.is_file() {
            let _ = symlink(&worker, bin_dir.join("maka-python-worker"));
        }
    }
    let profile_worker = profile.join("maka-python-worker");
    if profile_worker.is_file() && !bin_dir.join("maka-python-worker").exists() {
        let _ = symlink(&profile_worker, bin_dir.join("maka-python-worker"));
    }

    (staged_maka, staged_eval)
}

#[cfg(unix)]
#[tokio::test]
async fn native_host_executes_with_public_client_and_returns_authenticated_relay_frame() {
    let temp = TempDir::new().unwrap();
    let (maka, eval) = stage_real_maka_and_eval_binaries(temp.path());
    let script = temp.path().join("native_host.py");
    fs::write(&script, include_str!("support/native_host.py")).unwrap();
    let output = tokio::process::Command::new("python3")
        .arg(script)
        .env("MAKA_TEST_MAKA", maka)
        .env("MAKA_TEST_EVAL", eval)
        .kill_on_drop(true)
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(unix)]
#[tokio::test]
async fn real_maka_product_parity_gate_verifies_instructions_tools_and_policies_for_m3_and_m5() {
    let temp = TempDir::new().unwrap();
    let (maka, eval) = stage_real_maka_and_eval_binaries(temp.path());
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    fs::write(
        workspace.join("AGENTS.md"),
        "Follow workspace engineering standards.\n",
    )
    .unwrap();

    // 1. Default released product composition parity (zero session overrides, full tool catalog).
    let default_cfg_json = json!({
        "makaExecutable": maka.to_string_lossy(),
        "runtimeHostsPath": temp.path().join("hosts-default").to_string_lossy(),
        "hostSettlementTimeoutMs": 30000,
        "provider": "openai-compatible",
        "connectionSlug": "eval-gateway",
        "baseUrl": "https://api.openai.com/v1",
        "model": "gpt-4.1"
    });
    let default_report = verify_product_parity(&ParityCheckInput {
        subject_id: "maka".into(),
        subject_config: default_cfg_json.as_object().unwrap().clone(),
        subject_credentials: vec!["OPENAI_API_KEY".into()],
        workspace_source: Some(workspace.clone()),
        task_input: "Inspect the repository layout and reply Done.".into(),
        max_steps: 10,
    })
    .await
    .expect("live parity verification against real Maka must succeed");
    assert!(
        default_report.passed,
        "default Maka composition parity failed: {:?}",
        default_report.mismatches
    );
    assert!(default_report.mismatches.is_empty());
    assert_eq!(
        default_report.normal_tool_catalog_digest,
        default_report.eval_tool_catalog_digest
    );
    assert!(
        !default_report.exposed_tool_names.is_empty(),
        "released Maka composition must expose product tools without pruning"
    );
    assert!(
        default_report
            .exposed_tool_names
            .iter()
            .any(|name| name == "AskUserQuestion"),
        "interactive product tools must not be pruned: {:?}",
        default_report.exposed_tool_names
    );

    // 2. Explicit public user configuration parity (read-only sandbox, disabled permission prompts,
    //    explicit reasoning level and modelOverride).
    let configured_spec_json = json!({
        "schemaVersion": "maka.eval.v2",
        "id": "parity-gated-exp",
        "benchmark": { "id": "tb", "version": "1.0", "config": {} },
        "executor": { "kind": "harbor", "config": {} },
        "subjects": [
            {
                "id": "maka",
                "kind": "maka",
                "credentials": ["OPENAI_API_KEY"],
                "config": {
                    "makaExecutable": maka.to_string_lossy(),
                    "runtimeHostsPath": temp.path().join("hosts-configured").to_string_lossy(),
                    "hostSettlementTimeoutMs": 30000,
                    "provider": "openai-compatible",
                    "connectionSlug": "team-openai",
                    "connectionName": "Team OpenAI",
                    "baseUrl": "https://api.example.com/v1",
                    "model": "gpt-4.1",
                    "modelOverride": {
                        "contextWindow": 128000,
                        "thinkingLevels": ["off", "medium"]
                    },
                    "sandboxMode": "read-only",
                    "requestPermissions": false,
                    "thinkingLevel": "medium",
                    "language": "en",
                    "workspaceInstructions": false
                }
            }
        ],
        "tasks": [
            { "id": "task-1", "input": "Verify parity.", "config": {} }
        ],
        "repetitions": 1,
        "budget": { "maxSteps": 10 },
        "verifier": {}
    });
    let spec_file = temp.path().join("spec.json");
    let parity_out = temp.path().join("parity-report.json");
    fs::write(
        &spec_file,
        serde_json::to_vec_pretty(&configured_spec_json).unwrap(),
    )
    .unwrap();

    // Exercise the `maka-eval parity` CLI subcommand end-to-end.
    let cli_out = tokio::process::Command::new(&eval)
        .args([
            "parity",
            spec_file.to_str().unwrap(),
            "--out",
            parity_out.to_str().unwrap(),
        ])
        .kill_on_drop(true)
        .output()
        .await
        .unwrap();
    assert!(
        cli_out.status.success(),
        "maka-eval parity CLI failed: stdout={} stderr={}",
        String::from_utf8_lossy(&cli_out.stdout),
        String::from_utf8_lossy(&cli_out.stderr)
    );
    let reports: Vec<maka_eval::parity::ParityVerificationReport> =
        serde_json::from_slice(&fs::read(&parity_out).unwrap()).unwrap();
    assert_eq!(reports.len(), 1);
    assert!(reports[0].passed);

    // 3. M3 and M5 milestone acceptance gates.
    let spec = parse_experiment_spec(&configured_spec_json).unwrap();
    let empty_canonical = std::collections::BTreeMap::new();

    // Without a parity report, RunFingerprint alone MUST NOT pass M3 or M5.
    let m3_missing =
        evaluate_milestone_gate(MilestoneGate::M3Acceptance, &spec, &empty_canonical, &[]);
    assert!(!m3_missing.passed);
    assert!(
        m3_missing.violations[0].contains("RunFingerprint documents conditions only"),
        "unexpected violation: {:?}",
        m3_missing.violations
    );

    // Without settled runtime execution evidence, even a valid parity report MUST NOT pass M3.
    let m3_without_runtime = evaluate_milestone_gate(
        MilestoneGate::M3Acceptance,
        &spec,
        &empty_canonical,
        &reports,
    );
    assert!(!m3_without_runtime.passed);
    assert!(
        m3_without_runtime
            .violations
            .iter()
            .any(|v| v.contains("no settled runtime execution evidence")),
        "expected missing runtime evidence violation, got {:?}",
        m3_without_runtime.violations
    );

    let m5_incomplete = evaluate_milestone_gate(
        MilestoneGate::M5ProductionDelivery,
        &spec,
        &empty_canonical,
        &reports,
    );
    assert!(!m5_incomplete.passed);
    assert!(
        m5_incomplete
            .violations
            .iter()
            .any(|v| v.contains("incomplete"))
    );

    // Mutating public subject settings after parity verification invalidates the gate.
    let mut drifted_spec_json = configured_spec_json.clone();
    drifted_spec_json["subjects"][0]["config"]["sandboxMode"] = json!("danger-full-access");
    let drifted_spec = parse_experiment_spec(&drifted_spec_json).unwrap();
    let m3_drifted = evaluate_milestone_gate(
        MilestoneGate::M3Acceptance,
        &drifted_spec,
        &empty_canonical,
        &reports,
    );
    assert!(!m3_drifted.passed);
    assert!(
        m3_drifted
            .violations
            .iter()
            .any(|v| v.contains("does not match declared public configuration"))
    );

    // With runtime execution evidence confirming binary identity AND parity verified, M3 and M5 pass.
    let mut settled_canonical = std::collections::BTreeMap::new();
    settled_canonical.insert(
        "task-1::1::maka".to_owned(),
        V1CellAttempt {
            cell_id: "task-1::1::maka".into(),
            sequence: 1,
            started_at: 100,
            completed_at: 200,
            result: EvalResult {
                status: EvalResultStatus::Completed,
                score: Some(1.0),
                duration_ms: 100,
                usage: Some(NormalizedUsage {
                    input_tokens: 50,
                    output_tokens: 10,
                    cache_read_tokens: 0,
                    cache_write_tokens: 0,
                    reasoning_tokens: 0,
                    total_tokens: 60,
                }),
                cost_usd: None,
                failure_reason: None,
                artifacts: vec![
                    json!({
                        "kind": "maka-runtime-state",
                        "makaExecutable": maka.to_string_lossy(),
                        "makaExecutableSha256": reports[0].maka_executable_sha256,
                    })
                    .as_object()
                    .unwrap()
                    .clone(),
                ],
            },
        },
    );
    let m3_passed = evaluate_milestone_gate(
        MilestoneGate::M3Acceptance,
        &spec,
        &settled_canonical,
        &reports,
    );
    assert!(m3_passed.passed, "{:?}", m3_passed.violations);
    assert_eq!(m3_passed.parity_verified_subjects, vec!["maka".to_owned()]);

    let m5_passed = evaluate_milestone_gate(
        MilestoneGate::M5ProductionDelivery,
        &spec,
        &settled_canonical,
        &reports,
    );
    assert!(m5_passed.passed, "{:?}", m5_passed.violations);
}

#[test]
fn parity_gate_detects_instruction_tool_pruning_and_policy_drift() {
    let baseline = maka_eval::parity::ParitySnapshot {
        system_prompt_text: "You are Maka.".into(),
        request_system_prompt: Some("You are Maka.".into()),
        compaction_prompt: Some("Compact context.".into()),
        language: json!("auto"),
        dynamic_context: vec!["AGENTS.md".into()],
        composition_sources: vec![json!({"plugin": "maka.agent.agent", "version": "1.0.0"})],
        allowed_tools: None,
        tool_discovery: true,
        tool_selection: json!({"mode": "all"}),
        tool_mode: json!("code_mode"),
        code_language: json!("python"),
        editing_tools: json!("replace"),
        tool_catalog_digest: "digest-full".into(),
        tools: vec![
            json!({"name": "AskUserQuestion"}),
            json!({"name": "WebSearch"}),
        ],
        collaboration: json!("agent"),
        approval_policy: json!("ask"),
        sandbox_policy: json!({"access": "workspace-write"}),
        thinking_level: json!(null),
        provider_options: json!({}),
        max_output_tokens: json!(16384),
        context_policy: json!({"contextWindow": 200000}),
        wire_path: "/v1/chat/completions".into(),
        upstream_target_url: Some("https://api.openai.com/v1/chat/completions".into()),
        wire_model: Some("gpt-4.1".into()),
        wire_messages: json!([
            {"role": "system", "content": "You are Maka."},
            {"role": "user", "content": "Fix the bug."}
        ]),
        wire_tools: json!([
            {"type": "function", "function": {"name": "AskUserQuestion"}},
            {"type": "function", "function": {"name": "WebSearch"}}
        ]),
        wire_options: json!({"stream": true}),
    };

    let ok_report = compare_parity_snapshots(
        "maka",
        "0.2.0",
        "exe-sha",
        "cfg-sha",
        &baseline,
        &baseline,
        vec![],
    );
    assert!(ok_report.passed);
    assert!(ok_report.checks.iter().all(|c| c.passed));
    assert!(ok_report.mismatches.is_empty());

    // Injecting benchmark hints into prompts fails effective_instructions.
    let mut injected = baseline.clone();
    injected.wire_messages = json!([
        {"role": "system", "content": "You are Maka. Extra benchmark hint: run pytest first."},
        {"role": "user", "content": "Fix the bug."}
    ]);
    let report = compare_parity_snapshots(
        "maka",
        "0.2.0",
        "exe-sha",
        "cfg-sha",
        &baseline,
        &injected,
        vec![],
    );
    assert!(!report.passed);
    assert!(
        report
            .mismatches
            .iter()
            .any(|m| m.dimension == "effective_instructions")
    );

    // Pruning web or interactive tools fails tool_exposure.
    let mut pruned = baseline.clone();
    pruned.allowed_tools = Some(vec!["AskUserQuestion".into()]);
    pruned.wire_tools = json!([
        {"type": "function", "function": {"name": "AskUserQuestion"}}
    ]);
    let report = compare_parity_snapshots(
        "maka",
        "0.2.0",
        "exe-sha",
        "cfg-sha",
        &baseline,
        &pruned,
        vec![],
    );
    assert!(!report.passed);
    assert!(
        report
            .mismatches
            .iter()
            .any(|m| m.dimension == "tool_exposure" && m.field == "evalAllowedToolsUnpruned")
    );
    assert!(
        report
            .mismatches
            .iter()
            .any(|m| m.dimension == "tool_exposure" && m.field == "wireTools")
    );

    // Silently bypassing approvals or changing sandbox/context policy fails execution_policies.
    let mut bypassed = baseline.clone();
    bypassed.approval_policy = json!("never");
    bypassed.sandbox_policy = json!({"access": "danger-full-access"});
    let report = compare_parity_snapshots(
        "maka",
        "0.2.0",
        "exe-sha",
        "cfg-sha",
        &baseline,
        &bypassed,
        vec![],
    );
    assert!(!report.passed);
    assert!(
        report
            .mismatches
            .iter()
            .any(|m| m.dimension == "execution_policies" && m.field == "approvalPolicy")
    );

    // Changing bundled plugin composition fails product_composition.
    let mut custom_bundle = baseline.clone();
    custom_bundle.composition_sources = vec![json!({"plugin": "eval.custom.agent"})];
    let report = compare_parity_snapshots(
        "maka",
        "0.2.0",
        "exe-sha",
        "cfg-sha",
        &baseline,
        &custom_bundle,
        vec![],
    );
    assert!(!report.passed);
    assert!(
        report
            .mismatches
            .iter()
            .any(|m| m.dimension == "product_composition")
    );

    // Declared endpoint route parity: DeepSeek host with custom model alias lacking "deepseek"
    // must declare explicit applyPatch override so loopback metering gateway does not alter EditingTools.
    let ambiguous_deepseek = MakaSubjectConfig::decode(
        json!({
            "makaExecutable": "/opt/maka-agent/maka",
            "runtimeHostsPath": "/tmp/maka-runtime-hosts",
            "hostSettlementTimeoutMs": 60000,
            "baseUrl": "https://api.deepseek.com/v1",
            "model": "custom-coder-alias"
        })
        .as_object()
        .unwrap(),
        &["DEEPSEEK_API_KEY".into()],
    )
    .unwrap();
    let route_mismatches = check_declared_endpoint_route_parity(&ambiguous_deepseek);
    assert_eq!(route_mismatches.len(), 1);
    assert_eq!(route_mismatches[0].dimension, "tool_exposure");

    let explicit_deepseek = MakaSubjectConfig::decode(
        json!({
            "makaExecutable": "/opt/maka-agent/maka",
            "runtimeHostsPath": "/tmp/maka-runtime-hosts",
            "hostSettlementTimeoutMs": 60000,
            "baseUrl": "https://api.deepseek.com/v1",
            "model": "custom-coder-alias",
            "modelOverride": { "applyPatch": true }
        })
        .as_object()
        .unwrap(),
        &["DEEPSEEK_API_KEY".into()],
    )
    .unwrap();
    assert!(check_declared_endpoint_route_parity(&explicit_deepseek).is_empty());

    // Endpoint replacement that alters model-specific upstream routing fails execution_policies.
    let mut zenmux_normal = baseline.clone();
    zenmux_normal.wire_path = "/api/anthropic/v1/messages".into();
    zenmux_normal.upstream_target_url = Some("https://zenmux.ai/api/anthropic/v1/messages".into());
    let mut zenmux_drifted = zenmux_normal.clone();
    zenmux_drifted.wire_path = "/api/v1/messages".into();
    zenmux_drifted.upstream_target_url = Some("https://zenmux.ai/api/v1/messages".into());
    let route_report = compare_parity_snapshots(
        "maka",
        "0.2.0",
        "exe-sha",
        "cfg-sha",
        &zenmux_normal,
        &zenmux_drifted,
        vec![],
    );
    assert!(!route_report.passed);
    assert!(
        route_report
            .mismatches
            .iter()
            .any(|m| m.dimension == "execution_policies" && m.field == "wirePath")
    );
    assert!(
        route_report
            .mismatches
            .iter()
            .any(|m| m.dimension == "execution_policies" && m.field == "upstreamTargetUrl")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn unattended_maka_execution_preserves_interaction_semantics_without_silent_bypass() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct LocalCommandRunner(std::collections::HashMap<String, String>);
    impl CommandRunner for LocalCommandRunner {
        fn execute<'a>(
            &'a self,
            request: SubjectProcessRequest,
        ) -> BoxFuture<'a, Result<SubjectProcessOutput, String>> {
            Box::pin(async move {
                let mut cmd = tokio::process::Command::new(&request.command);
                cmd.args(&request.args)
                    .env_remove("MAKA_EVAL_RESULT_TOKEN")
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .kill_on_drop(true);
                for (k, v) in &request.environment {
                    cmd.env(k, v);
                }
                for (target, source) in &request.credential_environment {
                    if let Some(val) = self.0.get(source) {
                        cmd.env(target, val);
                    }
                }
                let out = cmd.output().await.map_err(|e| e.to_string())?;
                Ok(SubjectProcessOutput {
                    termination: SubjectProcessTermination::Exited,
                    exit_code: out.status.code().unwrap_or(1),
                    stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
                    stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
                    diagnostic: None,
                })
            })
        }
    }

    let temp = TempDir::new().unwrap();
    let (maka, _eval) = stage_real_maka_and_eval_binaries(temp.path());
    let workspace = temp.path().join("workspace");
    let artifact_root = temp.path().join("artifacts");
    fs::create_dir_all(&workspace).unwrap();

    // Start a local OpenAI-compatible SSE server that instructs Maka to invoke `AskUserQuestion`.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let shutdown = CancellationToken::new();
    let shutdown_bg = shutdown.clone();
    let server_task = tokio::spawn(async move {
        loop {
            let accepted = tokio::select! {
                _ = shutdown_bg.cancelled() => break,
                res = listener.accept() => match res {
                    Ok(v) => v,
                    Err(_) => break,
                }
            };
            let (mut stream, _) = accepted;
            tokio::spawn(async move {
                let mut buf = vec![0u8; 65536];
                let _ = stream.read(&mut buf).await;
                let args_str = serde_json::to_string(&json!({
                    "questions": [
                        {
                            "question": "Should we deploy to production?",
                            "options": [
                                { "label": "Yes" },
                                { "label": "No" }
                            ]
                        }
                    ]
                }))
                .unwrap();
                let chunk1 = json!({
                    "id": "chatcmpl-interact-1",
                    "object": "chat.completion.chunk",
                    "created": 1,
                    "model": "gpt-4.1",
                    "choices": [{
                        "index": 0,
                        "delta": {
                            "role": "assistant",
                            "tool_calls": [{
                                "index": 0,
                                "id": "call_question_1",
                                "type": "function",
                                "function": {
                                    "name": "AskUserQuestion",
                                    "arguments": args_str
                                }
                            }]
                        },
                        "finish_reason": null
                    }]
                });
                let chunk2 = json!({
                    "id": "chatcmpl-interact-1",
                    "object": "chat.completion.chunk",
                    "created": 1,
                    "model": "gpt-4.1",
                    "choices": [{
                        "index": 0,
                        "delta": {},
                        "finish_reason": "tool_calls"
                    }],
                    "usage": {
                        "prompt_tokens": 25,
                        "completion_tokens": 12,
                        "total_tokens": 37
                    }
                });
                let body = format!("data: {chunk1}\n\ndata: {chunk2}\n\ndata: [DONE]\n\n");
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes()).await;
            });
        }
    });

    let spec = parse_experiment_spec(&json!({
        "schemaVersion": "maka.eval.v2",
        "id": "unattended-interaction-test",
        "benchmark": { "id": "tb", "version": "1.0", "config": {} },
        "executor": { "kind": "harbor", "config": {} },
        "subjects": [{
            "id": "maka",
            "kind": "maka",
            "credentials": ["OPENAI_API_KEY"],
            "config": {
                "makaExecutable": maka.to_string_lossy(),
                "runtimeHostsPath": temp.path().join("hosts").to_string_lossy(),
                "hostSettlementTimeoutMs": 20000,
                "baseUrl": format!("http://127.0.0.1:{port}/v1"),
                "model": "gpt-4.1"
            }
        }],
        "tasks": [{ "id": "t1", "input": "Deploy the service.", "config": {} }],
        "repetitions": 1,
        "budget": { "maxSteps": 5 },
        "verifier": {}
    }))
    .unwrap();
    let cell = &expand_experiment(&spec)[0];

    let mut metadata = Map::new();
    metadata.insert(
        "artifactRoot".into(),
        Value::String(artifact_root.to_string_lossy().into_owned()),
    );
    let result = RustHostSubject::new()
        .execute(
            cell,
            SubjectExecutionContext {
                cwd: workspace.to_string_lossy().into_owned(),
                task_input: cell.task.input.clone(),
                metadata,
                cancel: CancellationToken::new(),
                runner: Arc::new(LocalCommandRunner(std::collections::HashMap::from([(
                    "OPENAI_API_KEY".into(),
                    "sk-test-unattended".into(),
                )]))),
            },
        )
        .await;

    shutdown.cancel();
    let _ = server_task.await;

    assert_eq!(result.outcome, ExecutionOutcome::SubjectFailed);
    assert_eq!(
        result.failure_reason.as_deref(),
        Some("Unattended execution blocked on required interaction: question")
    );
    assert!(
        result.artifacts.iter().any(|a| {
            a.get("kind").and_then(Value::as_str) == Some("unattended-interaction-blocked")
                && a.get("interactionKind").and_then(Value::as_str) == Some("question")
        }),
        "expected structured unattended-interaction-blocked artifact, got {:?}",
        result.artifacts
    );
    let recorded_interactions: Value = serde_json::from_slice(
        &fs::read(artifact_root.join("unattended-interactions.json"))
            .expect("unattended-interactions.json artifact must be written"),
    )
    .unwrap();
    assert_eq!(
        recorded_interactions["entries"][0]["kind"],
        json!("question")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn zenmux_and_cohere_model_route_overrides_preserve_product_routing_under_eval_and_parity() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let zenmux_resolved = resolve_product_route_base_url(
        "zenmux",
        "zenmux-main",
        "https://zenmux.ai/api/v1",
        "anthropic/claude-3.5-haiku",
        None,
        None,
    )
    .await
    .expect("zenmux claude route resolution must succeed");
    assert_eq!(zenmux_resolved, "https://zenmux.ai/api/anthropic/v1");

    let cohere_resolved = resolve_product_route_base_url(
        "cohere",
        "cohere-main",
        "https://api.cohere.com/v2",
        "north-mini-code-1-0",
        None,
        None,
    )
    .await
    .expect("cohere north-mini-code-1-0 route resolution must succeed");
    assert_eq!(cohere_resolved, "https://api.cohere.ai/compatibility/v1");

    let temp = TempDir::new().unwrap();
    let (maka, _eval) = stage_real_maka_and_eval_binaries(temp.path());
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    fs::write(workspace.join("README.md"), "# Zenmux Route Test\n").unwrap();

    // Offline proxy so RuntimeCatalog inside `maka host serve` never touches external network.
    let offline_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let offline_addr = offline_listener.local_addr().unwrap();
    let offline_shutdown = CancellationToken::new();
    let offline_shutdown_clone = offline_shutdown.clone();
    let offline_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = offline_shutdown_clone.cancelled() => break,
                accepted = offline_listener.accept() => {
                    let Ok((mut s, _)) = accepted else { break; };
                    tokio::spawn(async move {
                        let mut b = [0u8; 2048];
                        let _ = tokio::time::timeout(
                            std::time::Duration::from_millis(100),
                            s.read(&mut b),
                        ).await;
                        let _ = s.write_all(
                            b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        ).await;
                    });
                }
            }
        }
    });

    // Local Anthropic SSE probe capturing exact request path and upstream target header.
    let probe_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let probe_addr = probe_listener.local_addr().unwrap();
    let observed = Arc::new(tokio::sync::Mutex::new(
        Vec::<(String, Option<String>)>::new(),
    ));
    let observed_clone = observed.clone();
    let probe_shutdown = CancellationToken::new();
    let probe_shutdown_clone = probe_shutdown.clone();
    let probe_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = probe_shutdown_clone.cancelled() => break,
                accepted = probe_listener.accept() => {
                    let Ok((mut stream, _)) = accepted else { break; };
                    let store = observed_clone.clone();
                    tokio::spawn(async move {
                        let mut buf = Vec::new();
                        let mut chunk = [0u8; 4096];
                        let header_end = loop {
                            let Ok(n) = stream.read(&mut chunk).await else { return; };
                            if n == 0 { return; }
                            buf.extend_from_slice(&chunk[..n]);
                            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                                break pos + 4;
                            }
                        };
                        let headers_str = String::from_utf8_lossy(&buf[..header_end]).into_owned();
                        let mut lines = headers_str.lines();
                        let req_line = lines.next().unwrap_or_default();
                        let path = req_line.split_whitespace().nth(1).unwrap_or_default().to_owned();
                        let mut target_hdr = None;
                        let mut content_len = 0usize;
                        for line in lines {
                            if let Some((k, v)) = line.split_once(':') {
                                if k.eq_ignore_ascii_case(maka_eval::measurement::UPSTREAM_TARGET_HEADER) {
                                    target_hdr = Some(v.trim().to_owned());
                                } else if k.eq_ignore_ascii_case("content-length") {
                                    content_len = v.trim().parse().unwrap_or(0);
                                }
                            }
                        }
                        while buf.len() < header_end + content_len {
                            let Ok(n) = stream.read(&mut chunk).await else { break; };
                            if n == 0 { break; }
                            buf.extend_from_slice(&chunk[..n]);
                        }
                        store.lock().await.push((path, target_hdr));
                        let sse = concat!(
                            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_z\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"anthropic/claude-3.5-haiku\",\"content\":[],\"stop_reason\":null,\"stop_sequence\":null,\"usage\":{\"input_tokens\":15,\"output_tokens\":0}}}\n\n",
                            "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"OK\"}}\n\n",
                            "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                            "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":3}}\n\n",
                            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
                        );
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            sse.len(),
                            sse
                        );
                        let _ = stream.write_all(resp.as_bytes()).await;
                    });
                }
            }
        }
    });

    struct EnvLocalRunner(Vec<(String, String)>);
    impl CommandRunner for EnvLocalRunner {
        fn execute<'a>(
            &'a self,
            request: SubjectProcessRequest,
        ) -> BoxFuture<'a, Result<SubjectProcessOutput, String>> {
            Box::pin(async move {
                let mut cmd = tokio::process::Command::new(&request.command);
                cmd.args(&request.args)
                    .env_remove("MAKA_EVAL_RESULT_TOKEN")
                    .env_remove("REQUEST_METHOD")
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .kill_on_drop(true);
                for (k, v) in &self.0 {
                    cmd.env(k, v);
                }
                for (k, v) in &request.environment {
                    cmd.env(k, v);
                }
                for target in request.credential_environment.keys() {
                    cmd.env(target, "sk-zenmux-test");
                }
                let out = cmd.output().await.map_err(|e| e.to_string())?;
                Ok(SubjectProcessOutput {
                    termination: SubjectProcessTermination::Exited,
                    exit_code: out.status.code().unwrap_or(1),
                    stdout: if request.capture_stdout {
                        String::from_utf8_lossy(&out.stdout).into_owned()
                    } else {
                        String::new()
                    },
                    stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
                    diagnostic: None,
                })
            })
        }
    }

    // 1. Live `RustHostSubject` execution with official Zenmux baseUrl + Claude model.
    let spec_json = json!({
        "schemaVersion": "maka.eval.v2",
        "id": "zenmux-route-exp",
        "benchmark": { "id": "tb", "version": "1.0", "config": {} },
        "executor": { "kind": "local", "config": {} },
        "subjects": [
            {
                "id": "maka-zenmux",
                "kind": "maka",
                "credentials": ["ZENMUX_API_KEY"],
                "config": {
                    "makaExecutable": maka.to_string_lossy(),
                    "runtimeHostsPath": temp.path().join("hosts-eval").to_string_lossy(),
                    "hostSettlementTimeoutMs": 30000,
                    "provider": "zenmux",
                    "connectionSlug": "zenmux",
                    "baseUrl": "https://zenmux.ai/api/v1",
                    "model": "anthropic/claude-3.5-haiku"
                }
            }
        ],
        "tasks": [
            { "id": "t1", "input": "Reply with OK.", "config": {} }
        ],
        "repetitions": 1,
        "budget": { "maxSteps": 5 },
        "verifier": {}
    });
    let spec = parse_experiment_spec(&spec_json).unwrap();
    let cells = expand_experiment(&spec);
    let artifact_root = temp.path().join("eval-artifacts");
    let mut metadata = Map::new();
    metadata.insert(
        "artifactRoot".into(),
        Value::String(artifact_root.to_string_lossy().into_owned()),
    );
    let offline_url = format!("http://{offline_addr}");
    let exec_res = RustHostSubject::new()
        .execute(
            &cells[0],
            SubjectExecutionContext {
                cwd: workspace.to_string_lossy().into_owned(),
                task_input: cells[0].task.input.clone(),
                metadata,
                cancel: CancellationToken::new(),
                runner: Arc::new(EnvLocalRunner(vec![
                    (
                        "MAKA_EVAL_GATEWAY_TRANSPORT_ORIGIN".into(),
                        format!("http://{probe_addr}"),
                    ),
                    ("ALL_PROXY".into(), offline_url.clone()),
                    ("HTTP_PROXY".into(), offline_url.clone()),
                    ("HTTPS_PROXY".into(), offline_url.clone()),
                    ("NO_PROXY".into(), "127.0.0.1,localhost".into()),
                ])),
            },
        )
        .await;

    probe_shutdown.cancel();
    offline_shutdown.cancel();
    let _ = probe_task.await;
    let _ = offline_task.await;

    assert_eq!(
        exec_res.outcome,
        ExecutionOutcome::Completed,
        "zenmux claude Eval execution failed: {:?}",
        exec_res.failure_reason
    );
    let reqs = observed.lock().await.clone();
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].0, "/api/anthropic/v1/messages");
    assert_eq!(
        reqs[0].1.as_deref(),
        Some("https://zenmux.ai/api/anthropic/v1/messages")
    );

    // 2. End-to-end `verify_product_parity` on the exact reviewer scenario:
    //    `zenmux` + `anthropic/claude-3.5-haiku` + `https://zenmux.ai/api/v1`.
    let parity_report = verify_product_parity(&ParityCheckInput {
        subject_id: "maka-zenmux".into(),
        subject_config: spec.subjects[0].config.clone(),
        subject_credentials: spec.subjects[0].credentials.clone(),
        workspace_source: Some(workspace),
        task_input: "Reply with OK.".into(),
        max_steps: 5,
    })
    .await
    .expect("zenmux claude parity verification must succeed");
    assert!(
        parity_report.passed,
        "zenmux claude parity failed: {:?}",
        parity_report.mismatches
    );
    assert!(parity_report.mismatches.is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn milestone_m3_cli_enforces_runtime_binary_identity_for_local_and_container_paths() {
    let temp = TempDir::new().unwrap();
    let (maka, eval) = stage_real_maka_and_eval_binaries(temp.path());

    let spec_json = json!({
        "schemaVersion": "maka.eval.v2",
        "id": "m3-binary-identity-exp",
        "benchmark": { "id": "tb", "version": "1.0", "config": {} },
        "executor": { "kind": "harbor", "config": {} },
        "subjects": [
            {
                "id": "maka",
                "kind": "maka",
                "credentials": ["OPENAI_API_KEY"],
                "config": {
                    "makaExecutable": maka.to_string_lossy(),
                    "runtimeHostsPath": temp.path().join("hosts").to_string_lossy(),
                    "hostSettlementTimeoutMs": 30000,
                    "provider": "openai-compatible",
                    "connectionSlug": "eval-gateway",
                    "baseUrl": "https://api.openai.com/v1",
                    "model": "gpt-4.1"
                }
            }
        ],
        "tasks": [
            { "id": "task-1", "input": "Reply with OK.", "config": {} }
        ],
        "repetitions": 1,
        "budget": { "maxSteps": 5 },
        "verifier": {}
    });

    let parity_out = temp.path().join("parity.json");
    let orig_spec_path = temp.path().join("spec-orig.json");
    fs::write(
        &orig_spec_path,
        serde_json::to_vec_pretty(&spec_json).unwrap(),
    )
    .unwrap();

    let parity_cli = tokio::process::Command::new(&eval)
        .args([
            "parity",
            orig_spec_path.to_str().unwrap(),
            "--out",
            parity_out.to_str().unwrap(),
        ])
        .kill_on_drop(true)
        .output()
        .await
        .unwrap();
    assert!(
        parity_cli.status.success(),
        "parity CLI failed: {}",
        String::from_utf8_lossy(&parity_cli.stderr)
    );
    let parity_reports: Vec<maka_eval::parity::ParityVerificationReport> =
        serde_json::from_slice(&fs::read(&parity_out).unwrap()).unwrap();
    let verified_exe_sha = parity_reports[0].maka_executable_sha256.clone();

    // Reviewer reproduction: mutate `makaExecutable` to a nonexistent path and run
    // `report --milestone m3 --format v1` with no runtime execution evidence -> MUST fail!
    let mut nonexistent_spec_json = spec_json.clone();
    nonexistent_spec_json["subjects"][0]["config"]["makaExecutable"] =
        json!("/opt/isolated-container/maka");
    let nonexistent_spec_path = temp.path().join("spec-container.json");
    fs::write(
        &nonexistent_spec_path,
        serde_json::to_vec_pretty(&nonexistent_spec_json).unwrap(),
    )
    .unwrap();

    let empty_out_dir = temp.path().join("out-empty");
    let empty_m3 = tokio::process::Command::new(&eval)
        .args([
            "report",
            nonexistent_spec_path.to_str().unwrap(),
            "--out",
            empty_out_dir.to_str().unwrap(),
            "--milestone",
            "m3",
            "--format",
            "v1",
            "--parity-report",
            parity_out.to_str().unwrap(),
        ])
        .kill_on_drop(true)
        .output()
        .await
        .unwrap();
    assert!(
        !empty_m3.status.success(),
        "report --milestone m3 --format v1 must fail when runtime binary identity evidence is absent"
    );
    assert!(
        String::from_utf8_lossy(&empty_m3.stderr).contains("no settled runtime execution evidence"),
        "unexpected stderr: {}",
        String::from_utf8_lossy(&empty_m3.stderr)
    );

    // Legitimate isolated container path: `/opt/isolated-container/maka` does not exist on the
    // reporting host, but settled journal runtime evidence confirms both path and SHA-256 -> PASSES!
    let container_spec = parse_experiment_spec(&nonexistent_spec_json).unwrap();
    let valid_container_out = temp.path().join("out-container-valid");
    let valid_dir = ExperimentDirectory::open(&valid_container_out, &container_spec).unwrap();
    valid_dir
        .attempts
        .append_v1(&V1CellAttempt {
            cell_id: "task-1::1::maka".into(),
            sequence: 1,
            started_at: 10,
            completed_at: 20,
            result: EvalResult {
                status: EvalResultStatus::Completed,
                score: Some(1.0),
                duration_ms: 10,
                usage: None,
                cost_usd: None,
                failure_reason: None,
                artifacts: vec![
                    json!({
                        "kind": "maka-runtime-state",
                        "makaExecutable": "/opt/isolated-container/maka",
                        "makaExecutableSha256": verified_exe_sha,
                    })
                    .as_object()
                    .unwrap()
                    .clone(),
                ],
            },
        })
        .unwrap();

    let valid_m3 = tokio::process::Command::new(&eval)
        .args([
            "report",
            nonexistent_spec_path.to_str().unwrap(),
            "--out",
            valid_container_out.to_str().unwrap(),
            "--milestone",
            "m3",
            "--format",
            "v1",
            "--parity-report",
            parity_out.to_str().unwrap(),
        ])
        .kill_on_drop(true)
        .output()
        .await
        .unwrap();
    assert!(
        valid_m3.status.success(),
        "isolated container path with matching runtime binary digest must pass M3: {}",
        String::from_utf8_lossy(&valid_m3.stderr)
    );

    // Tampering `spec.json`'s `makaExecutable` to a different nonexistent path after trials ran
    // MUST fail M3 because runtime evidence recorded `/opt/isolated-container/maka`!
    let mut tampered_path_spec = nonexistent_spec_json.clone();
    tampered_path_spec["subjects"][0]["config"]["makaExecutable"] =
        json!("/opt/other-unverified/maka");
    let tampered_spec_path = temp.path().join("spec-tampered-path.json");
    fs::write(
        &tampered_spec_path,
        serde_json::to_vec_pretty(&tampered_path_spec).unwrap(),
    )
    .unwrap();
    // Note: ExperimentDirectory verifies `experiment.json` matches `spec`, so evaluate against a
    // store opened for `tampered_path_spec` carrying the runtime receipt from `/opt/isolated-container/maka`
    // as well as one with a mismatched digest.
    let mismatch_spec = parse_experiment_spec(&tampered_path_spec).unwrap();
    let mismatch_out = temp.path().join("out-container-mismatch");
    let mismatch_dir = ExperimentDirectory::open(&mismatch_out, &mismatch_spec).unwrap();
    mismatch_dir
        .attempts
        .append_v1(&V1CellAttempt {
            cell_id: "task-1::1::maka".into(),
            sequence: 1,
            started_at: 10,
            completed_at: 20,
            result: EvalResult {
                status: EvalResultStatus::Completed,
                score: Some(1.0),
                duration_ms: 10,
                usage: None,
                cost_usd: None,
                failure_reason: None,
                artifacts: vec![
                    json!({
                        "kind": "maka-runtime-state",
                        "makaExecutable": "/opt/other-unverified/maka",
                        "makaExecutableSha256": "0000000000000000000000000000000000000000000000000000000000000000",
                    })
                    .as_object()
                    .unwrap()
                    .clone(),
                ],
            },
        })
        .unwrap();

    let mismatch_m3 = tokio::process::Command::new(&eval)
        .args([
            "report",
            tampered_spec_path.to_str().unwrap(),
            "--out",
            mismatch_out.to_str().unwrap(),
            "--milestone",
            "m3",
            "--format",
            "v1",
            "--parity-report",
            parity_out.to_str().unwrap(),
        ])
        .kill_on_drop(true)
        .output()
        .await
        .unwrap();
    assert!(
        !mismatch_m3.status.success(),
        "mismatched runtime binary digest must fail M3"
    );
    assert!(
        String::from_utf8_lossy(&mismatch_m3.stderr)
            .contains("differs from parity-verified binary"),
        "unexpected stderr: {}",
        String::from_utf8_lossy(&mismatch_m3.stderr)
    );
}
