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

//! Deterministic journal projection (`v1` and `v2`), paired cohort comparison
//! summaries, and 3-verdict differential oracle evaluation.

use crate::contract::{
    DifferenceRegistry, DifferenceScenarioId, EvalResultStatus, ExperimentSpec, RunFingerprint,
    V1CellAttempt, V2AttemptRecord, decode_v1_cell_attempt, expand_experiment, format_cell_id,
    is_replaceable_attempt, select_cell_result,
};
use crate::measurement::{NormalizedUsage, costs_match_within_tolerance};
use crate::store::{FileAttemptStore, ReconstructedStoreState, StoreError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// Reconstructs all `v1` and `v2` attempt records deterministically from the append-only journal.
pub fn rebuild_from_journal(
    store: &FileAttemptStore,
) -> Result<ReconstructedStoreState, StoreError> {
    store.reconstruct_state()
}

/// Exports the canonical `maka.eval.v1` attempt for each cell in `spec` using
/// earliest-valid-attempt selection (`sequence >= 1`).
pub fn export_v1_canonical(
    spec: &ExperimentSpec,
    store: &FileAttemptStore,
) -> Result<BTreeMap<String, V1CellAttempt>, StoreError> {
    let cells = expand_experiment(spec);
    let mut out = BTreeMap::new();
    for cell in cells {
        let attempts = store.list_v1(&cell.id)?;
        if let Some(selected) = select_cell_result(&attempts) {
            out.insert(cell.id, selected.clone());
        }
    }
    Ok(out)
}

/// Exports the canonical `maka.eval.v2` record for each cell in `spec` from the journal.
pub fn export_v2_canonical(
    spec: &ExperimentSpec,
    store: &FileAttemptStore,
) -> Result<BTreeMap<String, V2AttemptRecord>, StoreError> {
    let state = store.reconstruct_state()?;
    let cells = expand_experiment(spec);
    let mut out = BTreeMap::new();
    for cell in cells {
        if let Some(records) = state.settled_v2.get(&cell.id) {
            let mut sorted: Vec<&V2AttemptRecord> =
                records.iter().filter(|r| r.sequence >= 1).collect();
            sorted.sort_by_key(|r| r.sequence);
            for rec in sorted {
                let projected = rec.project_v1();
                if !is_replaceable_attempt(&projected) {
                    out.insert(cell.id, rec.clone());
                    break;
                }
            }
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubjectArmSummary {
    pub subject_id: String,
    pub total_cells: usize,
    pub settled_cells: usize,
    pub completed_cells: usize,
    pub subject_failed_cells: usize,
    pub total_score: f64,
    pub mean_score: Option<f64>,
    pub total_usage: NormalizedUsage,
    pub total_cost_usd: f64,
    pub mean_duration_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CohortSummary {
    pub experiment_id: String,
    pub total_cells: usize,
    pub settled_cells: usize,
    pub incomplete_cells: usize,
    pub paired_task_groups: usize,
    pub arms: BTreeMap<String, SubjectArmSummary>,
}

pub fn build_cohort_summary(
    spec: &ExperimentSpec,
    canonical_v1: &BTreeMap<String, V1CellAttempt>,
) -> CohortSummary {
    let cells = expand_experiment(spec);
    let total_cells = cells.len();
    let total_cells_per_arm = spec.tasks.len() * (spec.repetitions as usize);

    let mut arms = BTreeMap::new();
    for subject in &spec.subjects {
        let mut settled_cells = 0usize;
        let mut completed_cells = 0usize;
        let mut subject_failed_cells = 0usize;
        let mut total_score = 0.0f64;
        let mut scored_count = 0usize;
        let mut total_usage = NormalizedUsage::default();
        let mut total_cost_usd = 0.0f64;
        let mut total_duration_ms = 0u64;

        for task in &spec.tasks {
            for rep in 1..=spec.repetitions {
                let cell_id = format_cell_id(&task.id, rep, &subject.id);
                if let Some(attempt) = canonical_v1.get(&cell_id) {
                    settled_cells += 1;
                    total_duration_ms =
                        total_duration_ms.saturating_add(attempt.result.duration_ms);
                    match attempt.result.status {
                        EvalResultStatus::Completed => completed_cells += 1,
                        EvalResultStatus::SubjectFailed => subject_failed_cells += 1,
                        EvalResultStatus::InfraFailed | EvalResultStatus::Indeterminate => {}
                    }
                    if let Some(score) = attempt.result.score {
                        total_score += score;
                        scored_count += 1;
                    }
                    if let Some(u) = &attempt.result.usage {
                        total_usage.accumulate_exact(u);
                    }
                    if let Some(cost) = attempt.result.cost_usd {
                        total_cost_usd += cost;
                    }
                }
            }
        }

        arms.insert(
            subject.id.clone(),
            SubjectArmSummary {
                subject_id: subject.id.clone(),
                total_cells: total_cells_per_arm,
                settled_cells,
                completed_cells,
                subject_failed_cells,
                total_score,
                mean_score: (scored_count > 0).then(|| total_score / (scored_count as f64)),
                total_usage,
                total_cost_usd,
                mean_duration_ms: (settled_cells > 0)
                    .then(|| (total_duration_ms as f64) / (settled_cells as f64)),
            },
        );
    }

    let mut paired_task_groups = 0usize;
    for task in &spec.tasks {
        for rep in 1..=spec.repetitions {
            let all_arms_settled = spec.subjects.iter().all(|s| {
                let id = format_cell_id(&task.id, rep, &s.id);
                canonical_v1.contains_key(&id)
            });
            if all_arms_settled {
                paired_task_groups += 1;
            }
        }
    }

    let settled_cells = canonical_v1.len();
    CohortSummary {
        experiment_id: spec.id.clone(),
        total_cells,
        settled_cells,
        incomplete_cells: total_cells.saturating_sub(settled_cells),
        paired_task_groups,
        arms,
    }
}

/// 3-verdict differential report comparing a candidate `maka.eval.v1` projection
/// against a reference baseline oracle and the Semantic Difference Registry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DifferentialReport {
    /// 1. Whether the candidate JSON parses strictly as a valid `maka.eval.v1` attempt.
    pub v1_parses: bool,
    /// 2. Whether the candidate actually matches the oracle on compared result fields.
    pub v1_matches_oracle: bool,
    pub adjudicated_difference: bool,
    /// 3. Whether the experimental conditions (semantic fingerprint and any adjudicated difference) remain comparable.
    pub conditions_comparable: bool,
    pub adjudicated_scenario: Option<DifferenceScenarioId>,
    pub diagnostics: Vec<String>,
}

pub fn evaluate_differential_oracle(
    candidate_v1_json: &Value,
    oracle: &V1CellAttempt,
    candidate_fingerprint: &RunFingerprint,
    oracle_fingerprint: &RunFingerprint,
    adjudicated_scenario: Option<DifferenceScenarioId>,
    registry: &DifferenceRegistry,
) -> DifferentialReport {
    let mut diagnostics = Vec::new();
    let candidate = match decode_v1_cell_attempt(candidate_v1_json) {
        Ok(c) => c,
        Err(err) => {
            diagnostics.push(format!("v1 schema validation failed: {err}"));
            return DifferentialReport {
                v1_parses: false,
                v1_matches_oracle: false,
                adjudicated_difference: false,
                conditions_comparable: false,
                adjudicated_scenario,
                diagnostics,
            };
        }
    };

    let fingerprint_comparable =
        candidate_fingerprint.is_semantically_comparable(oracle_fingerprint);
    if !fingerprint_comparable {
        diagnostics.push("semantic run fingerprint differs from oracle".into());
    }

    let scenario_entry = adjudicated_scenario.and_then(|id| registry.get(id));
    if adjudicated_scenario.is_some() && scenario_entry.is_none() {
        diagnostics.push("unregistered semantic difference scenario".into());
    }

    let direct_match = attempts_equivalent(&candidate, oracle, &mut diagnostics);
    let applicable = adjudicated_scenario.is_none_or(|id| scenario_applies(id, &candidate));
    if !applicable {
        diagnostics
            .push("candidate does not establish the selected scenario's prerequisites".into());
    }
    let adjudicated_difference = !direct_match
        && applicable
        && scenario_entry.is_some()
        && allowed_scenario_difference(adjudicated_scenario.unwrap(), &candidate, oracle);
    let conditions_comparable = fingerprint_comparable
        && applicable
        && (direct_match || adjudicated_difference)
        && scenario_entry.is_none_or(|entry| entry.conditions_comparable);

    DifferentialReport {
        v1_parses: true,
        v1_matches_oracle: direct_match,
        adjudicated_difference,
        conditions_comparable,
        adjudicated_scenario,
        diagnostics,
    }
}

fn has_artifact(attempt: &V1CellAttempt, kind: &str) -> bool {
    attempt
        .result
        .artifacts
        .iter()
        .any(|a| a.get("kind").and_then(Value::as_str) == Some(kind))
}

fn scenario_applies(id: DifferenceScenarioId, candidate: &V1CellAttempt) -> bool {
    let result = &candidate.result;
    match id {
        DifferenceScenarioId::TimeoutWithRewardIncompleteUsage => {
            result.status == EvalResultStatus::SubjectFailed
                && result.score.is_some()
                && result.usage.is_some()
                && result.cost_usd.is_none()
                && result
                    .failure_reason
                    .as_deref()
                    .is_some_and(|r| r.contains("timeout"))
        }
        DifferenceScenarioId::AuditTruncation => result.artifacts.iter().any(|a| {
            a.get("kind").and_then(Value::as_str) == Some("egress-audit")
                && a.get("truncated").and_then(Value::as_bool) == Some(true)
        }),
        DifferenceScenarioId::MissingCriticalArtifacts => {
            result.status == EvalResultStatus::InfraFailed
                && result.score.is_none()
                && result
                    .failure_reason
                    .as_deref()
                    .is_some_and(|r| r.starts_with("critical artifacts missing: "))
        }
        DifferenceScenarioId::LateCancellation => {
            has_artifact(candidate, "cancelled-after-verification")
                && matches!(
                    result.status,
                    EvalResultStatus::Completed | EvalResultStatus::SubjectFailed
                )
                && result.score.is_some()
        }
        DifferenceScenarioId::EvidenceRecoveredLater => {
            has_artifact(candidate, "post-hoc-evidence-recovery")
        }
    }
}

fn allowed_scenario_difference(
    id: DifferenceScenarioId,
    candidate: &V1CellAttempt,
    oracle: &V1CellAttempt,
) -> bool {
    // The first three scenarios preserve v1 result semantics. Post-hoc numeric
    // changes require original checkpoint evidence, which this v1-only API lacks.
    if id != DifferenceScenarioId::LateCancellation
        || oracle.result.status != EvalResultStatus::Indeterminate
        || oracle.result.score.is_some()
        || oracle.result.failure_reason.as_deref()
            != Some("executor cancelled before verification completed")
    {
        return false;
    }
    let mut expected = oracle.clone();
    expected.result.status = candidate.result.status;
    expected.result.score = candidate.result.score;
    expected.result.failure_reason = candidate.result.failure_reason.clone();
    let mut actual = candidate.clone();
    actual
        .result
        .artifacts
        .retain(|a| a.get("kind").and_then(Value::as_str) != Some("cancelled-after-verification"));
    attempts_equivalent(&actual, &expected, &mut Vec::new())
}

fn attempts_equivalent(
    candidate: &V1CellAttempt,
    oracle: &V1CellAttempt,
    diagnostics: &mut Vec<String>,
) -> bool {
    let mut ok = true;
    if candidate.cell_id != oracle.cell_id {
        diagnostics.push(format!(
            "cellId mismatch: {} != {}",
            candidate.cell_id, oracle.cell_id
        ));
        ok = false;
    }
    if candidate.sequence != oracle.sequence {
        diagnostics.push(format!(
            "sequence mismatch: {} != {}",
            candidate.sequence, oracle.sequence
        ));
        ok = false;
    }
    if candidate.result.status != oracle.result.status {
        diagnostics.push(format!(
            "status mismatch: {:?} != {:?}",
            candidate.result.status, oracle.result.status
        ));
        ok = false;
    }
    if candidate.result.score != oracle.result.score {
        diagnostics.push(format!(
            "score mismatch: {:?} != {:?}",
            candidate.result.score, oracle.result.score
        ));
        ok = false;
    }
    if candidate.result.usage != oracle.result.usage {
        diagnostics.push("usage counters mismatch".into());
        ok = false;
    }
    if !costs_match_within_tolerance(candidate.result.cost_usd, oracle.result.cost_usd) {
        diagnostics.push(format!(
            "costUsd mismatch beyond 1e-9 tolerance: {:?} != {:?}",
            candidate.result.cost_usd, oracle.result.cost_usd
        ));
        ok = false;
    }
    if candidate.result.artifacts != oracle.result.artifacts {
        diagnostics.push("artifacts mismatch".into());
        ok = false;
    }
    if candidate.result.failure_reason != oracle.result.failure_reason {
        diagnostics.push(format!(
            "failureReason mismatch: {:?} != {:?}",
            candidate.result.failure_reason, oracle.result.failure_reason
        ));
        ok = false;
    }
    ok
}
