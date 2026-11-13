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

use crate::support::sample_two_arm_spec_json;
use maka_eval::contract::{
    AttemptCancellation, AttemptMetering, AttemptPhase, CleanupState, CriticalArtifactsState,
    DifferenceRegistry, EgressAuditState, EvalResult, EvalResultStatus, ExecutionOutcome,
    ExperimentSpec, PricingEvidence, RunFingerprint, SchemaVersion, V1CellAttempt, V2AttemptRecord,
    VerifierOutcome, decode_v1_cell_attempt, expand_experiment, parse_experiment_spec,
    select_cell_result,
};
use maka_eval::measurement::{NormalizedUsage, costs_match_within_tolerance, deepseek_cost_usd};
use serde_json::{Value, json};

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

    // Unknown top-level field must be rejected both by parse_experiment_spec and serde Deserialize.
    let mut invalid = spec_json.clone();
    invalid
        .as_object_mut()
        .unwrap()
        .insert("unknownField".into(), json!(123));
    assert!(parse_experiment_spec(&invalid).is_err());
    assert!(serde_json::from_value::<ExperimentSpec>(invalid).is_err());

    // Concurrency changes execution fingerprint but preserves semantic fingerprint.
    let mut higher_concurrency_json = spec_json.clone();
    higher_concurrency_json["execution"]["maxConcurrentTaskGroups"] = json!(16);
    let higher_spec = parse_experiment_spec(&higher_concurrency_json).unwrap();

    let fp1 = RunFingerprint::compute(&spec);
    let fp2 = RunFingerprint::compute(&higher_spec);
    assert!(fp1.is_semantically_comparable(&fp2));
    assert_ne!(fp1.execution_sha256, fp2.execution_sha256);

    // Changing experiment.id or float vs integer representation (1.0 vs 1) preserves semantic fingerprint.
    let mut renamed_json = spec_json;
    renamed_json["id"] = json!("tb21-deepseek-v4-flash-rerun");
    renamed_json["budget"]["timeoutMultiplier"] = json!(1.0);
    let renamed_spec = serde_json::from_value::<ExperimentSpec>(renamed_json).unwrap();
    let fp3 = RunFingerprint::compute(&renamed_spec);
    assert!(fp1.is_semantically_comparable(&fp3));
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
    assert!(costs_match_within_tolerance(Some(cost), Some(0.0002998)));
    assert!(!costs_match_within_tolerance(
        Some(cost),
        Some(0.0002998 + 1e-8)
    ));
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
fn contract_deserialization_rejects_illegal_states_and_v1_round_trips_losslessly() {
    // V1CellAttempt rejects sequence == 0, Completed with failureReason, and costUsd without usage.
    let valid_v1 = json!({
        "cellId": "t1::1::maka",
        "sequence": 1,
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
    assert!(serde_json::from_value::<V1CellAttempt>(valid_v1.clone()).is_ok());

    let mut zero_seq = valid_v1.clone();
    zero_seq["sequence"] = json!(0);
    assert!(serde_json::from_value::<V1CellAttempt>(zero_seq).is_err());

    let mut cost_without_usage = valid_v1.clone();
    cost_without_usage["result"]["costUsd"] = json!(0.01);
    assert!(serde_json::from_value::<V1CellAttempt>(cost_without_usage).is_err());

    let mut completed_with_reason = valid_v1.clone();
    completed_with_reason["result"]["status"] = json!("completed");
    completed_with_reason["result"]["failureReason"] = json!("unexpected");
    assert!(serde_json::from_value::<V1CellAttempt>(completed_with_reason).is_err());

    // V2AttemptRecord rejects schemaVersion != maka.eval.v2 and invalid metering combinations.
    let v2_wrong_schema = json!({
        "schemaVersion": "maka.eval.v1",
        "cellId": "t1::1::maka",
        "sequence": 1,
        "startedAt": 10,
        "completedAt": 20,
        "durationMs": 10,
        "phase": "settled",
        "executionOutcome": "completed",
        "verifierOutcome": { "kind": "skipped" },
        "metering": { "state": "unknown" },
        "cleanupState": { "kind": "confirmed" },
        "auditState": { "kind": "not_required" },
        "criticalArtifactsState": { "kind": "present" },
        "cancellation": "none",
        "recoveredPostHoc": false,
        "failureReason": null,
        "artifacts": []
    });
    assert!(serde_json::from_value::<V2AttemptRecord>(v2_wrong_schema.clone()).is_err());

    let mut complete_without_usage = v2_wrong_schema.clone();
    complete_without_usage["schemaVersion"] = json!("maka.eval.v2");
    complete_without_usage["metering"] = json!({ "state": "complete", "usage": null });
    assert!(serde_json::from_value::<V2AttemptRecord>(complete_without_usage).is_err());

    let mut negative_cost = v2_wrong_schema;
    negative_cost["schemaVersion"] = json!("maka.eval.v2");
    negative_cost["metering"] = json!({
        "state": "complete",
        "usage": {
            "inputTokens": 10,
            "outputTokens": 5,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0,
            "totalTokens": 15
        },
        "pricing": { "kind": "subject_reported", "costUsd": -0.5 }
    });
    assert!(serde_json::from_value::<V2AttemptRecord>(negative_cost).is_err());

    // Lossless V1 serde -> decode_v1_cell_attempt round-trip when SubjectFailed has failureReason: null.
    let parsed_v1: V1CellAttempt = serde_json::from_value(valid_v1).unwrap();
    let encoded = serde_json::to_value(&parsed_v1).unwrap();
    assert_eq!(decode_v1_cell_attempt(&encoded).unwrap(), parsed_v1);
}

#[test]
fn v2_to_v1_projections_cover_all_five_semantic_difference_scenarios() {
    let registry = DifferenceRegistry::new();
    assert_eq!(registry.entries().len(), 5);

    let usage = NormalizedUsage {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        total_tokens: 120,
    };

    // 1. Timeout + Verified(0.75) + LowerBound retains score and usage with costUsd == None;
    //    with Complete + AfterVerification + Recorded audit, preserves markers as SubjectFailed.
    let base_v2 = V2AttemptRecord {
        schema_version: SchemaVersion::V2,
        cell_id: "t1::1::maka".into(),
        sequence: 1,
        started_at: 10,
        completed_at: 20,
        duration_ms: 10,
        phase: AttemptPhase::Settled,
        execution_outcome: ExecutionOutcome::Timeout,
        verifier_outcome: VerifierOutcome::Verified { score: 0.75 },
        metering: AttemptMetering::LowerBound {
            usage: usage.clone(),
        },
        cleanup_state: CleanupState::Confirmed,
        audit_state: EgressAuditState::NotRequired,
        critical_artifacts_state: CriticalArtifactsState::Present,
        cancellation: AttemptCancellation::None,
        recovered_post_hoc: false,
        failure_reason: Some("timed out".into()),
        artifacts: Vec::new(),
    };
    let v1_timeout_lb = base_v2.project_v1();
    assert_eq!(v1_timeout_lb.result.status, EvalResultStatus::SubjectFailed);
    assert_eq!(v1_timeout_lb.result.score, Some(0.75));
    assert_eq!(v1_timeout_lb.result.usage, Some(usage.clone()));
    assert_eq!(v1_timeout_lb.result.cost_usd, None);

    let mut v2_timeout_complete = base_v2.clone();
    v2_timeout_complete.metering = AttemptMetering::Complete {
        usage: usage.clone(),
        pricing: Some(PricingEvidence::Model {
            model: "deepseek-v4-flash".into(),
            cost_usd: Some(0.0000352),
        }),
    };
    v2_timeout_complete.audit_state = EgressAuditState::Recorded {
        truncated: true,
        policy_error_count: 2,
    };
    v2_timeout_complete.cancellation = AttemptCancellation::AfterVerification;
    let v1_timeout_complete = v2_timeout_complete.project_v1();
    assert_eq!(
        v1_timeout_complete.result.status,
        EvalResultStatus::SubjectFailed
    );
    assert_eq!(v1_timeout_complete.result.score, Some(0.75));
    assert_eq!(v1_timeout_complete.result.cost_usd, Some(0.0000352));
    assert!(
        v1_timeout_complete
            .result
            .artifacts
            .iter()
            .any(|a| a.get("kind").and_then(Value::as_str) == Some("cancelled-after-verification"))
    );
    let audit_art = v1_timeout_complete
        .result
        .artifacts
        .iter()
        .find(|a| a.get("kind").and_then(Value::as_str) == Some("egress-audit"))
        .unwrap();
    assert_eq!(
        audit_art.get("truncated").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        audit_art.get("policyErrorCount").and_then(Value::as_u64),
        Some(2)
    );

    // 2. Egress audit truncation preserves Completed + reward, whereas Missing fails closed.
    let completed_base = V2AttemptRecord {
        execution_outcome: ExecutionOutcome::Completed,
        verifier_outcome: VerifierOutcome::Verified { score: 1.0 },
        metering: AttemptMetering::Complete {
            usage,
            pricing: Some(PricingEvidence::Model {
                model: "deepseek-v4-flash".into(),
                cost_usd: Some(0.0000352),
            }),
        },
        audit_state: EgressAuditState::truncated(),
        failure_reason: None,
        ..base_v2
    };
    let v1_audit_trunc = completed_base.project_v1();
    assert_eq!(v1_audit_trunc.result.status, EvalResultStatus::Completed);
    assert_eq!(v1_audit_trunc.result.score, Some(1.0));
    assert!(v1_audit_trunc.result.artifacts.iter().any(|a| {
        a.get("kind").and_then(Value::as_str) == Some("egress-audit")
            && a.get("truncated").and_then(Value::as_bool) == Some(true)
    }));

    let mut v2_audit_missing = completed_base.clone();
    v2_audit_missing.audit_state = EgressAuditState::Missing;
    let v1_audit_missing = v2_audit_missing.project_v1();
    assert_eq!(
        v1_audit_missing.result.status,
        EvalResultStatus::InfraFailed
    );
    assert_eq!(v1_audit_missing.result.score, None);

    // 3. CriticalArtifactsState::Present keeps Completed, whereas Missing fails closed.
    assert_eq!(
        completed_base.project_v1().result.status,
        EvalResultStatus::Completed
    );
    let mut v2_missing_art = completed_base.clone();
    v2_missing_art.critical_artifacts_state = CriticalArtifactsState::Missing {
        paths: vec!["transcript.json".into()],
    };
    let v1_missing_art = v2_missing_art.project_v1();
    assert_eq!(v1_missing_art.result.status, EvalResultStatus::InfraFailed);
    assert_eq!(v1_missing_art.result.score, None);

    // 4. Late cancellation: BeforeVerification -> Indeterminate(None), AfterVerification -> Completed(score).
    let mut v2_cancel_before = completed_base.clone();
    v2_cancel_before.cancellation = AttemptCancellation::BeforeVerification;
    let v1_cancel_before = v2_cancel_before.project_v1();
    assert_eq!(
        v1_cancel_before.result.status,
        EvalResultStatus::Indeterminate
    );
    assert_eq!(v1_cancel_before.result.score, None);

    let mut v2_cancel_after = completed_base.clone();
    v2_cancel_after.cancellation = AttemptCancellation::AfterVerification;
    let v1_cancel_after = v2_cancel_after.project_v1();
    assert_eq!(v1_cancel_after.result.status, EvalResultStatus::Completed);
    assert_eq!(v1_cancel_after.result.score, Some(1.0));
    assert!(
        v1_cancel_after
            .result
            .artifacts
            .iter()
            .any(|a| a.get("kind").and_then(Value::as_str) == Some("cancelled-after-verification"))
    );

    // 5. Missing verifier reward never defaults to 0.0; genuine 0.0 reward is Completed(0.0).
    let mut v2_missing_reward = completed_base.clone();
    v2_missing_reward.verifier_outcome = VerifierOutcome::MissingReward {
        reason: "reward.json missing".into(),
    };
    let v1_missing_reward = v2_missing_reward.project_v1();
    assert_eq!(
        v1_missing_reward.result.status,
        EvalResultStatus::InfraFailed
    );
    assert_eq!(v1_missing_reward.result.score, None);

    let mut v2_zero_score = completed_base;
    v2_zero_score.verifier_outcome = VerifierOutcome::Verified { score: 0.0 };
    let v1_zero_score = v2_zero_score.project_v1();
    assert_eq!(v1_zero_score.result.status, EvalResultStatus::Completed);
    assert_eq!(v1_zero_score.result.score, Some(0.0));
}
