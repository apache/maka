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
    AttemptMetering, CleanupState, CriticalArtifactsState, EGRESS_AUDIT_ARTIFACT_PATH,
    EgressAuditState, EvalResultStatus, ExperimentSpec, PhaseDurationsMs, PostHocRecovery,
    SelectedStatus, SpecFingerprint, SubjectOutcome, TrialOutcome, V1CellAttempt, V2AttemptParts,
    V2AttemptRecord, V2Disposition, VerifierOutcome, can_admit_v2_attempt, expand_experiment,
    select_cell_result, select_v2_cell_result,
};
use maka_eval::measurement::{NormalizedUsage, PricingRates, costs_match_within_tolerance};
use serde_json::{Map, Value, json};
use std::num::NonZeroU32;

const SAMPLE_SHA256: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn nz(v: u32) -> NonZeroU32 {
    NonZeroU32::new(v).unwrap()
}

fn sample_usage() -> NormalizedUsage {
    NormalizedUsage {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        total_tokens: 120,
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
                    "args": ["harbor-external-subject.js", "{{task.input}}"]
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

fn base_v2_parts() -> V2AttemptParts {
    V2AttemptParts {
        cell_id: "t1::1::maka".into(),
        sequence: nz(1),
        started_at: 10,
        completed_at: 20,
        durations: PhaseDurationsMs {
            queue_wait_ms: 1,
            prepare_ms: 2,
            subject_ms: 5,
            verify_ms: 1,
            cleanup_ms: 1,
            total_ms: 10,
        },
        trial_outcome: TrialOutcome::Evaluated {
            subject: SubjectOutcome::Completed {},
            verifier: VerifierOutcome::Verified { score: 1.0 },
            cancelled_after_verification: false,
        },
        metering: AttemptMetering::Complete {
            usage: sample_usage(),
            model: Some("deepseek-v4-flash".into()),
        },
        cleanup_state: CleanupState::Confirmed {},
        audit_state: EgressAuditState::NotRequired {},
        critical_artifacts_state: CriticalArtifactsState::Present {},
        artifacts: Vec::new(),
    }
}

#[test]
fn experiment_spec_validation_and_cell_expansion_match_v1_contract() {
    let spec_json = sample_two_arm_spec_json();
    let spec: ExperimentSpec = serde_json::from_value(spec_json.clone()).unwrap();
    let cells = expand_experiment(&spec);

    assert_eq!(cells.len(), 4);
    assert_eq!(cells[0].id, "task-alpha::1::maka");
    assert_eq!(cells[1].id, "task-alpha::1::external-cli");
    assert_eq!(cells[2].id, "task-beta::1::maka");
    assert_eq!(cells[3].id, "task-beta::1::external-cli");

    // Frozen TS safe-integer parity: 1.0 is accepted for integer counts.
    let mut float_int_spec = spec_json.clone();
    float_int_spec["repetitions"] = json!(1.0);
    float_int_spec["execution"]["maxConcurrentTaskGroups"] = json!(1.0);
    let parsed_float_int: ExperimentSpec = serde_json::from_value(float_int_spec).unwrap();
    assert_eq!(parsed_float_int.repetitions, nz(1));
    assert_eq!(parsed_float_int.execution.max_concurrent_task_groups, nz(1));

    // Reject v2 schemaVersion on ExperimentSpec, unknown fields, 0, fractional, and oversized floats.
    let mut v2_spec = spec_json.clone();
    v2_spec["schemaVersion"] = json!("maka.eval.v2");
    assert!(serde_json::from_value::<ExperimentSpec>(v2_spec).is_err());

    let mut unknown = spec_json.clone();
    unknown
        .as_object_mut()
        .unwrap()
        .insert("unknownField".into(), json!(123));
    assert!(serde_json::from_value::<ExperimentSpec>(unknown).is_err());

    for bad_num in [json!(0), json!(1.5), json!(1e30)] {
        let mut bad_rep = spec_json.clone();
        bad_rep["repetitions"] = bad_num.clone();
        assert!(serde_json::from_value::<ExperimentSpec>(bad_rep).is_err());

        let mut bad_conc = spec_json.clone();
        bad_conc["execution"]["maxConcurrentTaskGroups"] = bad_num;
        assert!(serde_json::from_value::<ExperimentSpec>(bad_conc).is_err());
    }

    // Concurrency changes execution fingerprint but preserves semantic fingerprint.
    let mut higher_concurrency_json = spec_json.clone();
    higher_concurrency_json["execution"]["maxConcurrentTaskGroups"] = json!(16);
    let higher_spec: ExperimentSpec = serde_json::from_value(higher_concurrency_json).unwrap();

    let fp1 = SpecFingerprint::compute(&spec);
    let fp2 = SpecFingerprint::compute(&higher_spec);
    assert_eq!(fp1.semantic_sha256, fp2.semantic_sha256);
    assert_ne!(fp1.execution_sha256, fp2.execution_sha256);

    // Changing experiment.id, float/integer equivalence (1.0 vs 1), and nested object
    // key insertion order preserve semantic_sha256 even under preserve_order.
    let mut reordered_json = spec_json;
    reordered_json["id"] = json!("tb21-deepseek-v4-flash-rerun");
    let mut reordered_budget = Map::new();
    reordered_budget.insert("maxSteps".into(), json!(100));
    reordered_budget.insert("timeoutMultiplier".into(), json!(1.0));
    reordered_json["budget"] = Value::Object(reordered_budget);
    let reordered_spec: ExperimentSpec = serde_json::from_value(reordered_json).unwrap();
    let fp3 = SpecFingerprint::compute(&reordered_spec);
    assert_eq!(fp1.semantic_sha256, fp3.semantic_sha256);
}

#[test]
fn six_counter_usage_and_authoritative_model_pricing() {
    let u1: NormalizedUsage = serde_json::from_value(json!({
        "inputTokens": 1000.0,
        "outputTokens": 250,
        "cacheReadTokens": 400,
        "cacheWriteTokens": 100,
        "reasoningTokens": 80,
        "totalTokens": 9999
    }))
    .unwrap();
    let u2 = NormalizedUsage {
        input_tokens: 500,
        output_tokens: 150,
        cache_read_tokens: 200,
        cache_write_tokens: 0,
        reasoning_tokens: 20,
        total_tokens: 7777,
    };

    for invalid in [
        json!({
            "inputTokens": 10,
            "outputTokens": 5,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0
        }),
        json!({
            "inputTokens": -1,
            "outputTokens": 5,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0,
            "totalTokens": 4
        }),
        json!({
            "inputTokens": 1e30,
            "outputTokens": 5,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0,
            "totalTokens": 15
        }),
        json!({
            "inputTokens": 10,
            "outputTokens": 5,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0,
            "totalTokens": 15,
            "extra": 1
        }),
    ] {
        assert!(serde_json::from_value::<NormalizedUsage>(invalid).is_err());
    }

    let mut combined = u1.clone();
    combined.accumulate_exact(&u2);
    assert_eq!(combined.input_tokens, 1500);
    assert_eq!(combined.output_tokens, 400);
    assert_eq!(combined.cache_read_tokens, 600);
    assert_eq!(combined.cache_write_tokens, 100);
    assert_eq!(combined.reasoning_tokens, 100);
    assert_eq!(combined.total_tokens, 17776);

    // uncached = 1000 - 400 - 100 = 500
    // (500 * 0.22 + 400 * 0.007 + 100 * 0.22 + 250 * 0.66) / 1_000_000 = 0.0002998
    let rates = PricingRates::for_model("deepseek-v4-flash").unwrap();
    let cost = rates.cost_usd(&u1);
    assert!(costs_match_within_tolerance(Some(cost), Some(0.0002998)));
    assert!(!costs_match_within_tolerance(
        Some(cost),
        Some(0.0002998 + 1e-8)
    ));
    assert!(PricingRates::for_model("custom-local").is_none());
}

#[test]
fn strict_boundary_decoding_rejects_unknown_fields_and_illegal_states() {
    let v2_base = json!({
        "schemaVersion": "maka.eval.v2",
        "cellId": "t1::1::maka",
        "sequence": 1,
        "startedAt": 10,
        "completedAt": 20,
        "durations": {
            "queueWaitMs": 1,
            "prepareMs": 2,
            "subjectMs": 5,
            "verifyMs": 1,
            "cleanupMs": 1,
            "totalMs": 10
        },
        "trialOutcome": {
            "stage": "evaluated",
            "subject": { "kind": "completed" },
            "verifier": { "kind": "verified", "score": 1.0 },
            "cancelledAfterVerification": false
        },
        "metering": {
            "state": "complete",
            "usage": {
                "inputTokens": 10,
                "outputTokens": 5,
                "cacheReadTokens": 0,
                "cacheWriteTokens": 0,
                "reasoningTokens": 0,
                "totalTokens": 15
            },
            "model": "deepseek-v4-flash"
        },
        "cleanupState": { "kind": "confirmed" },
        "auditState": { "kind": "not_required" },
        "criticalArtifactsState": { "kind": "present" },
        "artifacts": []
    });
    let parsed_v2: V2AttemptRecord = serde_json::from_value(v2_base.clone()).unwrap();
    let encoded_v2 = serde_json::to_value(&parsed_v2).unwrap();
    assert_eq!(
        serde_json::from_value::<V2AttemptRecord>(encoded_v2).unwrap(),
        parsed_v2
    );

    // Every empty-struct tagged variant and metering.unknown must reject extra fields.
    let mut bad_subject = v2_base.clone();
    bad_subject["trialOutcome"]["subject"] = json!({ "kind": "completed", "extra": 1 });
    assert!(serde_json::from_value::<V2AttemptRecord>(bad_subject).is_err());

    let mut bad_cleanup = v2_base.clone();
    bad_cleanup["cleanupState"] = json!({ "kind": "confirmed", "extra": true });
    assert!(serde_json::from_value::<V2AttemptRecord>(bad_cleanup).is_err());

    let mut bad_audit_nr = v2_base.clone();
    bad_audit_nr["auditState"] = json!({ "kind": "not_required", "extra": "x" });
    assert!(serde_json::from_value::<V2AttemptRecord>(bad_audit_nr).is_err());

    let mut bad_audit_missing = v2_base.clone();
    bad_audit_missing["auditState"] = json!({ "kind": "missing", "extra": "x" });
    assert!(serde_json::from_value::<V2AttemptRecord>(bad_audit_missing).is_err());

    let mut bad_artifacts = v2_base.clone();
    bad_artifacts["criticalArtifactsState"] = json!({ "kind": "present", "extra": 1 });
    assert!(serde_json::from_value::<V2AttemptRecord>(bad_artifacts).is_err());

    let mut bad_metering_unknown = v2_base.clone();
    bad_metering_unknown["metering"] = json!({ "state": "unknown", "model": "deepseek-v4-flash" });
    assert!(serde_json::from_value::<V2AttemptRecord>(bad_metering_unknown).is_err());

    // Illegal v2 invariants on wire & Rust boundary.
    let mut wrong_schema = v2_base.clone();
    wrong_schema["schemaVersion"] = json!("maka.eval.v1");
    assert!(serde_json::from_value::<V2AttemptRecord>(wrong_schema).is_err());

    let mut reversed_times = v2_base.clone();
    reversed_times["completedAt"] = json!(5);
    assert!(serde_json::from_value::<V2AttemptRecord>(reversed_times).is_err());

    let mut empty_missing_paths = v2_base.clone();
    empty_missing_paths["criticalArtifactsState"] = json!({ "kind": "missing", "paths": [] });
    assert!(serde_json::from_value::<V2AttemptRecord>(empty_missing_paths).is_err());

    let mut empty_reason = v2_base.clone();
    empty_reason["trialOutcome"] = json!({ "stage": "infra_failed", "reason": "" });
    assert!(serde_json::from_value::<V2AttemptRecord>(empty_reason).is_err());

    let mut bad_sha = v2_base;
    bad_sha["auditState"] = json!({ "kind": "recorded", "bytes": 12, "sha256": "NOT-HEX" });
    assert!(serde_json::from_value::<V2AttemptRecord>(bad_sha).is_err());

    let mut non_finite = base_v2_parts();
    non_finite.trial_outcome = TrialOutcome::Evaluated {
        subject: SubjectOutcome::Completed {},
        verifier: VerifierOutcome::Verified { score: f64::NAN },
        cancelled_after_verification: false,
    };
    assert!(V2AttemptRecord::try_new(non_finite).is_err());

    // V1CellAttempt: safe integer parity (1.0 ok, 1e30 & 0 rejected), lossless round-trip.
    let valid_v1 = json!({
        "cellId": "t1::1::maka",
        "sequence": 1.0,
        "startedAt": 10,
        "completedAt": 20,
        "result": {
            "score": null,
            "usage": null,
            "costUsd": null,
            "durationMs": 10,
            "status": "subject_failed",
            "failureReason": null,
            "artifacts": []
        }
    });
    let parsed_v1: V1CellAttempt = serde_json::from_value(valid_v1.clone()).unwrap();
    assert_eq!(parsed_v1.sequence, nz(1));
    let encoded_v1 = serde_json::to_value(&parsed_v1).unwrap();
    assert_eq!(
        serde_json::from_value::<V1CellAttempt>(encoded_v1).unwrap(),
        parsed_v1
    );

    let mut zero_seq = valid_v1.clone();
    zero_seq["sequence"] = json!(0);
    assert!(serde_json::from_value::<V1CellAttempt>(zero_seq).is_err());

    let mut saturated_ts = valid_v1;
    saturated_ts["startedAt"] = json!(1e30);
    assert!(serde_json::from_value::<V1CellAttempt>(saturated_ts).is_err());
}

#[test]
fn three_gate_v2_funnel_selection_and_v1_projections() {
    // Gate 1 dominance: Indeterminate overrides missing critical artifacts and missing audit.
    let mut indet_parts = base_v2_parts();
    indet_parts.trial_outcome = TrialOutcome::Indeterminate {
        reason: "relay disconnected".into(),
    };
    indet_parts.metering = AttemptMetering::Unknown;
    indet_parts.critical_artifacts_state = CriticalArtifactsState::Missing {
        paths: vec!["transcript.json".into()],
    };
    indet_parts.audit_state = EgressAuditState::Missing {};
    let indet_rec = V2AttemptRecord::try_new(indet_parts).unwrap();
    assert_eq!(
        indet_rec.disposition(),
        V2Disposition::BlockedIndeterminate {
            failure_reason: "relay disconnected".into(),
        }
    );
    assert_eq!(
        indet_rec.project_v1().result.status,
        EvalResultStatus::Indeterminate
    );
    assert!(!can_admit_v2_attempt(&[indet_rec], 3));

    // Gate 2 root-cause preservation: pre-verification InfraFailed keeps its own reason
    // even with Unknown metering and missing artifacts, and admits retries within budget.
    let mut infra_parts = base_v2_parts();
    infra_parts.trial_outcome = TrialOutcome::InfraFailed {
        reason: "docker pull failed".into(),
    };
    infra_parts.metering = AttemptMetering::Unknown;
    infra_parts.critical_artifacts_state = CriticalArtifactsState::Missing {
        paths: vec!["transcript.json".into()],
    };
    let infra_rec = V2AttemptRecord::try_new(infra_parts).unwrap();
    assert_eq!(
        infra_rec.disposition(),
        V2Disposition::RetryableInfra {
            failure_reason: "docker pull failed".into(),
        }
    );
    assert!(!can_admit_v2_attempt(std::slice::from_ref(&infra_rec), 0));
    assert!(can_admit_v2_attempt(std::slice::from_ref(&infra_rec), 1));

    // Metering gates on Completed: Unknown -> BlockedIndeterminate; LowerBound -> RetryableInfra.
    let mut completed_unknown = base_v2_parts();
    completed_unknown.metering = AttemptMetering::Unknown;
    let completed_unknown_rec = V2AttemptRecord::try_new(completed_unknown).unwrap();
    assert!(matches!(
        completed_unknown_rec.disposition(),
        V2Disposition::BlockedIndeterminate { .. }
    ));

    let mut completed_lb = base_v2_parts();
    completed_lb.metering = AttemptMetering::LowerBound {
        usage: sample_usage(),
    };
    let completed_lb_rec = V2AttemptRecord::try_new(completed_lb).unwrap();
    assert!(matches!(
        completed_lb_rec.disposition(),
        V2Disposition::RetryableInfra { .. }
    ));

    // Scenario 1: Timeout + Verified(0.75) + LowerBound -> Selected(SubjectFailed, Some(0.75)),
    // costUsd == None, blocks resampling; Complete derives standardized cost via PricingRates.
    let mut timeout_lb_parts = base_v2_parts();
    timeout_lb_parts.trial_outcome = TrialOutcome::Evaluated {
        subject: SubjectOutcome::Timeout {
            reason: Some("timed out".into()),
        },
        verifier: VerifierOutcome::Verified { score: 0.75 },
        cancelled_after_verification: false,
    };
    timeout_lb_parts.metering = AttemptMetering::LowerBound {
        usage: sample_usage(),
    };
    let timeout_lb_rec = V2AttemptRecord::try_new(timeout_lb_parts.clone()).unwrap();
    assert_eq!(
        timeout_lb_rec.disposition(),
        V2Disposition::Selected {
            status: SelectedStatus::SubjectFailed,
            score: Some(0.75),
            failure_reason: Some("timed out".into()),
        }
    );
    assert!(!can_admit_v2_attempt(
        std::slice::from_ref(&timeout_lb_rec),
        3
    ));
    let timeout_lb_v1 = timeout_lb_rec.project_v1();
    assert_eq!(timeout_lb_v1.result.status, EvalResultStatus::SubjectFailed);
    assert_eq!(timeout_lb_v1.result.score, Some(0.75));
    assert_eq!(timeout_lb_v1.result.usage, Some(sample_usage()));
    assert_eq!(timeout_lb_v1.result.cost_usd, None);

    timeout_lb_parts.metering = AttemptMetering::Complete {
        usage: sample_usage(),
        model: Some("deepseek-v4-flash".into()),
    };
    let timeout_complete_v1 = V2AttemptRecord::try_new(timeout_lb_parts)
        .unwrap()
        .project_v1();
    assert!(costs_match_within_tolerance(
        timeout_complete_v1.result.cost_usd,
        Some(0.0000352)
    ));

    // Scenario 2: EgressAuditState::Recorded keeps Completed(1.0) and projects full audit fields;
    // Missing -> RetryableInfra + egress-audit-missing artifact.
    let mut audit_parts = base_v2_parts();
    audit_parts.audit_state = EgressAuditState::Recorded {
        bytes: 512,
        sha256: SAMPLE_SHA256.into(),
        truncated: true,
        policy_error_count: 2,
        malformed_line_count: 1,
    };
    let audit_v1 = V2AttemptRecord::try_new(audit_parts.clone())
        .unwrap()
        .project_v1();
    assert_eq!(audit_v1.result.status, EvalResultStatus::Completed);
    assert_eq!(audit_v1.result.score, Some(1.0));
    let audit_art = audit_v1
        .result
        .artifacts
        .iter()
        .find(|a| a.get("kind").and_then(Value::as_str) == Some("egress-audit"))
        .unwrap();
    assert_eq!(
        audit_art.get("path").and_then(Value::as_str),
        Some(EGRESS_AUDIT_ARTIFACT_PATH)
    );
    assert_eq!(audit_art.get("bytes").and_then(Value::as_u64), Some(512));
    assert_eq!(
        audit_art.get("sha256").and_then(Value::as_str),
        Some(format!("sha256:{SAMPLE_SHA256}").as_str())
    );
    assert_eq!(
        audit_art.get("truncated").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        audit_art.get("policyErrorCount").and_then(Value::as_u64),
        Some(2)
    );
    assert_eq!(
        audit_art.get("malformedLineCount").and_then(Value::as_u64),
        Some(1)
    );

    audit_parts.audit_state = EgressAuditState::Missing {};
    let missing_audit_v1 = V2AttemptRecord::try_new(audit_parts).unwrap().project_v1();
    assert_eq!(
        missing_audit_v1.result.status,
        EvalResultStatus::InfraFailed
    );
    assert_eq!(missing_audit_v1.result.score, None);
    assert!(missing_audit_v1.result.artifacts.iter().any(|a| {
        a.get("kind").and_then(Value::as_str) == Some("egress-audit-missing")
            && a.get("path").and_then(Value::as_str) == Some(EGRESS_AUDIT_ARTIFACT_PATH)
    }));

    // Scenario 3: CriticalArtifactsState::Missing -> RetryableInfra (score: None).
    let mut missing_art_parts = base_v2_parts();
    missing_art_parts.critical_artifacts_state = CriticalArtifactsState::Missing {
        paths: vec!["transcript.json".into()],
    };
    let missing_art_v1 = V2AttemptRecord::try_new(missing_art_parts)
        .unwrap()
        .project_v1();
    assert_eq!(missing_art_v1.result.status, EvalResultStatus::InfraFailed);
    assert_eq!(missing_art_v1.result.score, None);

    // Scenario 4: CancelledBeforeVerification -> BlockedIndeterminate;
    // Evaluated { cancelled_after_verification: true } -> Selected(Completed) + marker.
    let mut cancel_before_parts = base_v2_parts();
    cancel_before_parts.trial_outcome = TrialOutcome::CancelledBeforeVerification { reason: None };
    let cancel_before_v1 = V2AttemptRecord::try_new(cancel_before_parts)
        .unwrap()
        .project_v1();
    assert_eq!(
        cancel_before_v1.result.status,
        EvalResultStatus::Indeterminate
    );
    assert_eq!(cancel_before_v1.result.score, None);

    let mut cancel_after_parts = base_v2_parts();
    cancel_after_parts.trial_outcome = TrialOutcome::Evaluated {
        subject: SubjectOutcome::Completed {},
        verifier: VerifierOutcome::Verified { score: 1.0 },
        cancelled_after_verification: true,
    };
    let cancel_after_v1 = V2AttemptRecord::try_new(cancel_after_parts)
        .unwrap()
        .project_v1();
    assert_eq!(cancel_after_v1.result.status, EvalResultStatus::Completed);
    assert_eq!(cancel_after_v1.result.score, Some(1.0));
    assert!(
        cancel_after_v1
            .result
            .artifacts
            .iter()
            .any(|a| a.get("kind").and_then(Value::as_str) == Some("cancelled-after-verification"))
    );

    // Scenario 5: PostHocRecovery upgrades immutable record monotonically via projection;
    // MissingReward -> RetryableInfra (score: None); genuine 0.0 is terminal and earliest-selected.
    let mut unrecovered_parts = base_v2_parts();
    unrecovered_parts.sequence = nz(2);
    unrecovered_parts.cleanup_state = CleanupState::Unconfirmed {
        reason: "cleanup pending".into(),
    };
    unrecovered_parts.metering = AttemptMetering::Unknown;
    let unrecovered_rec = V2AttemptRecord::try_new(unrecovered_parts).unwrap();
    assert!(matches!(
        unrecovered_rec.disposition(),
        V2Disposition::BlockedIndeterminate { .. }
    ));

    let recovery = PostHocRecovery::try_new(
        30,
        Some(AttemptMetering::Complete {
            usage: sample_usage(),
            model: Some("deepseek-v4-flash".into()),
        }),
        Some(CleanupState::Confirmed {}),
    )
    .unwrap();
    let recovered_disp = unrecovered_rec.disposition_with_recovery(std::slice::from_ref(&recovery));
    assert_eq!(
        recovered_disp,
        V2Disposition::Selected {
            status: SelectedStatus::Completed,
            score: Some(1.0),
            failure_reason: None,
        }
    );
    let recovered_v1 = unrecovered_rec.project_v1_with_recovery(&[recovery]);
    assert_eq!(recovered_v1.sequence, nz(2));
    assert_eq!(recovered_v1.result.status, EvalResultStatus::Completed);
    assert_eq!(recovered_v1.result.usage, Some(sample_usage()));
    assert!(costs_match_within_tolerance(
        recovered_v1.result.cost_usd,
        Some(0.0000352)
    ));
    assert!(
        recovered_v1
            .result
            .artifacts
            .iter()
            .any(|a| a.get("kind").and_then(Value::as_str) == Some("post-hoc-evidence-recovery"))
    );
    // Original record stays immutable.
    assert!(matches!(
        unrecovered_rec.cleanup_state(),
        CleanupState::Unconfirmed { .. }
    ));

    let mut missing_reward_parts = base_v2_parts();
    missing_reward_parts.trial_outcome = TrialOutcome::Evaluated {
        subject: SubjectOutcome::Completed {},
        verifier: VerifierOutcome::MissingReward {
            reason: "reward.json missing".into(),
        },
        cancelled_after_verification: false,
    };
    let missing_reward_v1 = V2AttemptRecord::try_new(missing_reward_parts)
        .unwrap()
        .project_v1();
    assert_eq!(
        missing_reward_v1.result.status,
        EvalResultStatus::InfraFailed
    );
    assert_eq!(missing_reward_v1.result.score, None);

    // Selection picks earliest valid attempt (sequence 2, score 0.0) over sequence 1 (InfraFailed)
    // and sequence 3 (Completed, score 1.0) in both v2 and v1.
    let mut zero_seq2_parts = base_v2_parts();
    zero_seq2_parts.sequence = nz(2);
    zero_seq2_parts.trial_outcome = TrialOutcome::Evaluated {
        subject: SubjectOutcome::Completed {},
        verifier: VerifierOutcome::Verified { score: 0.0 },
        cancelled_after_verification: false,
    };
    let zero_seq2 = V2AttemptRecord::try_new(zero_seq2_parts).unwrap();

    let mut win_seq3_parts = base_v2_parts();
    win_seq3_parts.sequence = nz(3);
    let win_seq3 = V2AttemptRecord::try_new(win_seq3_parts).unwrap();

    let v2_attempts = [win_seq3.clone(), infra_rec.clone(), zero_seq2.clone()];
    let selected_v2 = select_v2_cell_result(&v2_attempts).unwrap();
    assert_eq!(selected_v2.sequence(), nz(2));
    assert_eq!(
        selected_v2.disposition(),
        V2Disposition::Selected {
            status: SelectedStatus::Completed,
            score: Some(0.0),
            failure_reason: None,
        }
    );

    let v1_attempts = [
        win_seq3.project_v1(),
        infra_rec.project_v1(),
        zero_seq2.project_v1(),
    ];
    let selected_v1 = select_cell_result(&v1_attempts).unwrap();
    assert_eq!(selected_v1.sequence, nz(2));
    assert_eq!(selected_v1.result.score, Some(0.0));
}
