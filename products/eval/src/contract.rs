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

//! Experiment specifications, orthogonal `v2` attempt records, strict `v1`
//! projections, run fingerprinting, and the semantic difference registry.

use crate::measurement::{MeteringState, NormalizedUsage};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use thiserror::Error;

pub type JsonObject = Map<String, Value>;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ContractError {
    #[error("{0}")]
    Invalid(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SchemaVersion {
    #[serde(rename = "maka.eval.v1")]
    V1,
    #[serde(rename = "maka.eval.v2")]
    V2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubjectKind {
    Maka,
    External,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BenchmarkSpec {
    pub id: String,
    pub version: String,
    pub config: JsonObject,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutorSpec {
    pub kind: String,
    pub config: JsonObject,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionSpec {
    pub max_concurrent_task_groups: usize,
}

impl Default for ExecutionSpec {
    fn default() -> Self {
        Self {
            max_concurrent_task_groups: 1,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubjectSpec {
    pub id: String,
    pub kind: SubjectKind,
    pub credentials: Vec<String>,
    pub config: JsonObject,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskSpec {
    pub id: String,
    pub input: String,
    pub config: JsonObject,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExperimentSpec {
    pub schema_version: SchemaVersion,
    pub id: String,
    pub benchmark: BenchmarkSpec,
    pub executor: ExecutorSpec,
    #[serde(default)]
    pub execution: ExecutionSpec,
    pub subjects: Vec<SubjectSpec>,
    pub tasks: Vec<TaskSpec>,
    pub repetitions: u32,
    pub budget: JsonObject,
    pub verifier: JsonObject,
}

impl<'de> Deserialize<'de> for ExperimentSpec {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        parse_experiment_spec(&value).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExperimentCell {
    pub id: String,
    pub experiment_id: String,
    pub benchmark: BenchmarkSpec,
    pub executor: ExecutorSpec,
    pub subject: SubjectSpec,
    pub task: TaskSpec,
    pub repetition: u32,
    pub budget: JsonObject,
    pub verifier: JsonObject,
}

pub fn format_cell_id(task_id: &str, repetition: u32, subject_id: &str) -> String {
    format!("{task_id}::{repetition}::{subject_id}")
}

pub fn expand_experiment(spec: &ExperimentSpec) -> Vec<ExperimentCell> {
    let mut cells =
        Vec::with_capacity(spec.tasks.len() * (spec.repetitions as usize) * spec.subjects.len());
    for task in &spec.tasks {
        for repetition in 1..=spec.repetitions {
            for subject in &spec.subjects {
                cells.push(ExperimentCell {
                    id: format_cell_id(&task.id, repetition, &subject.id),
                    experiment_id: spec.id.clone(),
                    benchmark: spec.benchmark.clone(),
                    executor: spec.executor.clone(),
                    subject: subject.clone(),
                    task: task.clone(),
                    repetition,
                    budget: spec.budget.clone(),
                    verifier: spec.verifier.clone(),
                });
            }
        }
    }
    cells
}

pub fn parse_experiment_spec(value: &Value) -> Result<ExperimentSpec, ContractError> {
    let root = exact_object(
        value,
        "experiment",
        &[
            "schemaVersion",
            "id",
            "benchmark",
            "executor",
            "subjects",
            "tasks",
            "repetitions",
            "budget",
            "verifier",
        ],
        &["execution"],
    )?;

    let schema_version = match root.get("schemaVersion").and_then(Value::as_str) {
        Some("maka.eval.v1") => SchemaVersion::V1,
        Some("maka.eval.v2") => SchemaVersion::V2,
        _ => {
            return Err(ContractError::Invalid(
                "unsupported experiment schema".into(),
            ));
        }
    };

    let benchmark_obj = exact_object(
        root.get("benchmark").unwrap(),
        "benchmark",
        &["id", "version", "config"],
        &[],
    )?;
    let executor_obj = exact_object(
        root.get("executor").unwrap(),
        "executor",
        &["kind", "config"],
        &[],
    )?;

    let max_concurrent_task_groups = match root.get("execution") {
        None => 1,
        Some(exec_val) => {
            let exec_obj = exact_object(exec_val, "execution", &["maxConcurrentTaskGroups"], &[])?;
            positive_usize(
                exec_obj.get("maxConcurrentTaskGroups").unwrap(),
                "execution.maxConcurrentTaskGroups",
            )?
        }
    };

    let subjects_arr = root
        .get("subjects")
        .and_then(Value::as_array)
        .ok_or_else(|| ContractError::Invalid("subjects must be an array".into()))?;
    let mut subjects = Vec::with_capacity(subjects_arr.len());
    for (idx, item) in subjects_arr.iter().enumerate() {
        let where_label = format!("subjects[{idx}]");
        let sub_obj = exact_object(
            item,
            &where_label,
            &["id", "kind", "credentials", "config"],
            &[],
        )?;
        let kind = match sub_obj.get("kind").and_then(Value::as_str) {
            Some("maka") => SubjectKind::Maka,
            Some("external") => SubjectKind::External,
            _ => {
                return Err(ContractError::Invalid(format!(
                    "{where_label}.kind is invalid"
                )));
            }
        };
        subjects.push(SubjectSpec {
            id: identifier(sub_obj.get("id").unwrap(), &format!("{where_label}.id"))?,
            kind,
            credentials: unique_strings(
                sub_obj.get("credentials").unwrap(),
                &format!("{where_label}.credentials"),
            )?,
            config: decode_json_object(
                sub_obj.get("config").unwrap(),
                &format!("{where_label}.config"),
            )?,
        });
    }

    let tasks_arr = root
        .get("tasks")
        .and_then(Value::as_array)
        .ok_or_else(|| ContractError::Invalid("tasks must be an array".into()))?;
    let mut tasks = Vec::with_capacity(tasks_arr.len());
    for (idx, item) in tasks_arr.iter().enumerate() {
        let where_label = format!("tasks[{idx}]");
        let task_obj = exact_object(item, &where_label, &["id", "input", "config"], &[])?;
        tasks.push(TaskSpec {
            id: identifier(task_obj.get("id").unwrap(), &format!("{where_label}.id"))?,
            input: nonempty_string(
                task_obj.get("input").unwrap(),
                &format!("{where_label}.input"),
            )?,
            config: decode_json_object(
                task_obj.get("config").unwrap(),
                &format!("{where_label}.config"),
            )?,
        });
    }

    if subjects.is_empty() || tasks.is_empty() {
        return Err(ContractError::Invalid("experiment arms are empty".into()));
    }
    ensure_unique_ids(subjects.iter().map(|s| s.id.as_str()), "subject")?;
    ensure_unique_ids(tasks.iter().map(|t| t.id.as_str()), "task")?;

    let repetitions = positive_u32(root.get("repetitions").unwrap(), "repetitions")?;

    Ok(ExperimentSpec {
        schema_version,
        id: identifier(root.get("id").unwrap(), "experiment.id")?,
        benchmark: BenchmarkSpec {
            id: identifier(benchmark_obj.get("id").unwrap(), "benchmark.id")?,
            version: nonempty_string(benchmark_obj.get("version").unwrap(), "benchmark.version")?,
            config: decode_json_object(benchmark_obj.get("config").unwrap(), "benchmark.config")?,
        },
        executor: ExecutorSpec {
            kind: identifier(executor_obj.get("kind").unwrap(), "executor.kind")?,
            config: decode_json_object(executor_obj.get("config").unwrap(), "executor.config")?,
        },
        execution: ExecutionSpec {
            max_concurrent_task_groups,
        },
        subjects,
        tasks,
        repetitions,
        budget: decode_json_object(root.get("budget").unwrap(), "budget")?,
        verifier: decode_json_object(root.get("verifier").unwrap(), "verifier")?,
    })
}

/// Canonical JSON serialization with lexicographically sorted object keys.
pub fn canonical_json_string(value: &Value) -> String {
    let normalized = canonicalize_value(value);
    serde_json::to_string(&normalized).expect("canonical Value serialization cannot fail")
}

fn canonicalize_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut sorted: Vec<(&String, &Value)> = map.iter().collect();
            sorted.sort_by_key(|(a, _)| *a);
            let mut out = Map::with_capacity(sorted.len());
            for (k, v) in sorted {
                out.insert(k.clone(), canonicalize_value(v));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonicalize_value).collect()),
        Value::Number(n) => {
            if n.is_u64() || n.is_i64() {
                Value::Number(n.clone())
            } else if let Some(f) = n.as_f64() {
                if f == 0.0 {
                    Value::Number(0.into())
                } else if f.is_finite()
                    && f.fract() == 0.0
                    && (-9_007_199_254_740_991.0..=9_007_199_254_740_991.0).contains(&f)
                {
                    if f >= 0.0 {
                        Value::Number((f as u64).into())
                    } else {
                        Value::Number((f as i64).into())
                    }
                } else {
                    Value::Number(n.clone())
                }
            } else {
                Value::Number(n.clone())
            }
        }
        other => other.clone(),
    }
}

/// Documents experimental and execution conditions for comparability checks.
///
/// Fingerprints record the declared configuration and parameters of a run; freezing an
/// eval-only fingerprint does not establish product parity. M3 acceptance and M5 production
/// delivery require a verified `ParityVerificationReport` alongside the run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunFingerprint {
    /// Digest over benchmark, executor kind, subjects, tasks, repetitions, budget, and verifier.
    pub semantic_sha256: String,
    /// Digest over execution-only parameters (e.g. `maxConcurrentTaskGroups`).
    pub execution_sha256: String,
}

impl RunFingerprint {
    pub fn compute(spec: &ExperimentSpec) -> Self {
        let semantic_payload = serde_json::json!({
            "benchmark": spec.benchmark,
            "executorKind": spec.executor.kind,
            "subjects": spec.subjects,
            "tasks": spec.tasks,
            "repetitions": spec.repetitions,
            "budget": spec.budget,
            "verifier": spec.verifier,
        });
        let execution_payload = serde_json::json!({
            "maxConcurrentTaskGroups": spec.execution.max_concurrent_task_groups,
            "executorConfig": spec.executor.config,
        });
        Self {
            semantic_sha256: sha256_hex(canonical_json_string(&semantic_payload).as_bytes()),
            execution_sha256: sha256_hex(canonical_json_string(&execution_payload).as_bytes()),
        }
    }

    pub fn is_semantically_comparable(&self, other: &Self) -> bool {
        self.semantic_sha256 == other.semantic_sha256
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvalResultStatus {
    Completed,
    SubjectFailed,
    InfraFailed,
    Indeterminate,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvalResult {
    pub score: Option<f64>,
    pub usage: Option<NormalizedUsage>,
    pub cost_usd: Option<f64>,
    pub duration_ms: u64,
    pub status: EvalResultStatus,
    pub failure_reason: Option<String>,
    pub artifacts: Vec<JsonObject>,
}

impl<'de> Deserialize<'de> for EvalResult {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        decode_eval_result(&value, "result").map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V1CellAttempt {
    pub cell_id: String,
    pub sequence: u32,
    pub started_at: u64,
    pub completed_at: u64,
    pub result: EvalResult,
}

impl<'de> Deserialize<'de> for V1CellAttempt {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        decode_v1_cell_attempt(&value).map_err(serde::de::Error::custom)
    }
}

pub fn is_replaceable_attempt(attempt: &V1CellAttempt) -> bool {
    matches!(
        attempt.result.status,
        EvalResultStatus::InfraFailed | EvalResultStatus::Indeterminate
    )
}

/// Canonical cell result selector: selects the earliest valid attempt by sequence (`sequence >= 1`)
/// whose status is neither `infra_failed` nor `indeterminate`. A `completed` attempt with score `0.0`
/// or a `subject_failed` attempt is terminal and never replaced.
pub fn select_cell_result(attempts: &[V1CellAttempt]) -> Option<&V1CellAttempt> {
    let mut sorted: Vec<&V1CellAttempt> = attempts.iter().filter(|a| a.sequence >= 1).collect();
    sorted.sort_by_key(|a| a.sequence);
    sorted
        .into_iter()
        .find(|attempt| !is_replaceable_attempt(attempt))
}

pub fn decode_eval_result(value: &Value, where_label: &str) -> Result<EvalResult, ContractError> {
    let obj = exact_object(
        value,
        where_label,
        &[
            "score",
            "usage",
            "costUsd",
            "durationMs",
            "status",
            "failureReason",
            "artifacts",
        ],
        &[],
    )?;
    let status = match obj.get("status").and_then(Value::as_str) {
        Some("completed") => EvalResultStatus::Completed,
        Some("subject_failed") => EvalResultStatus::SubjectFailed,
        Some("infra_failed") => EvalResultStatus::InfraFailed,
        Some("indeterminate") => EvalResultStatus::Indeterminate,
        _ => {
            return Err(ContractError::Invalid(format!(
                "{where_label}.status is invalid"
            )));
        }
    };
    let failure_reason = match obj.get("failureReason").unwrap() {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        _ => {
            return Err(ContractError::Invalid(format!(
                "{where_label}.failureReason is invalid"
            )));
        }
    };
    if status == EvalResultStatus::Completed && failure_reason.is_some() {
        return Err(ContractError::Invalid(format!(
            "{where_label}.failureReason must be null when completed"
        )));
    }
    let score = nullable_f64(obj.get("score").unwrap(), &format!("{where_label}.score"))?;
    let usage = match obj.get("usage").unwrap() {
        Value::Null => None,
        u => Some(NormalizedUsage::decode(u, &format!("{where_label}.usage"))?),
    };
    let cost_usd = nullable_nonnegative_f64(
        obj.get("costUsd").unwrap(),
        &format!("{where_label}.costUsd"),
    )?;
    if cost_usd.is_some() && usage.is_none() {
        return Err(ContractError::Invalid(format!(
            "{where_label}.costUsd requires usage"
        )));
    }
    let duration_ms = nonnegative_u64(
        obj.get("durationMs").unwrap(),
        &format!("{where_label}.durationMs"),
    )?;
    let artifacts_arr = obj
        .get("artifacts")
        .and_then(Value::as_array)
        .ok_or_else(|| ContractError::Invalid(format!("{where_label}.artifacts is invalid")))?;
    let mut artifacts = Vec::with_capacity(artifacts_arr.len());
    for (idx, item) in artifacts_arr.iter().enumerate() {
        artifacts.push(decode_json_object(
            item,
            &format!("{where_label}.artifacts[{idx}]"),
        )?);
    }
    Ok(EvalResult {
        score,
        usage,
        cost_usd,
        duration_ms,
        status,
        failure_reason,
        artifacts,
    })
}

pub fn decode_v1_cell_attempt(value: &Value) -> Result<V1CellAttempt, ContractError> {
    let obj = exact_object(
        value,
        "attempt",
        &["cellId", "sequence", "startedAt", "completedAt", "result"],
        &[],
    )?;
    Ok(V1CellAttempt {
        cell_id: nonempty_string(obj.get("cellId").unwrap(), "attempt.cellId")?,
        sequence: positive_u32(obj.get("sequence").unwrap(), "attempt.sequence")?,
        started_at: nonnegative_u64(obj.get("startedAt").unwrap(), "attempt.startedAt")?,
        completed_at: nonnegative_u64(obj.get("completedAt").unwrap(), "attempt.completedAt")?,
        result: decode_eval_result(obj.get("result").unwrap(), "attempt.result")?,
    })
}

/// Orthogonal dimensions for native `maka.eval.v2` attempt records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptPhase {
    Prepared,
    Dispatched,
    AgentFinished,
    Verified,
    Settled,
    Recovered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionOutcome {
    Completed,
    SubjectFailed,
    Timeout,
    InfraFailed,
    Indeterminate,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptCancellation {
    #[default]
    None,
    BeforeVerification,
    AfterVerification,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VerifierOutcome {
    Verified {
        score: f64,
    },
    SubjectFailed {
        score: Option<f64>,
        reason: Option<String>,
    },
    /// Missing reward file or empty verifier payload: never defaults to `0.0`.
    MissingReward {
        reason: String,
    },
    VerifierInfraFailed {
        reason: String,
    },
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CleanupState {
    Confirmed,
    Unconfirmed { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum EgressAuditState {
    NotRequired,
    Recorded {
        #[serde(default)]
        truncated: bool,
        #[serde(default)]
        policy_error_count: u64,
    },
    Missing,
    Unreadable {
        reason: String,
    },
}

impl EgressAuditState {
    pub fn clean() -> Self {
        Self::Recorded {
            truncated: false,
            policy_error_count: 0,
        }
    }

    pub fn truncated() -> Self {
        Self::Recorded {
            truncated: true,
            policy_error_count: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CriticalArtifactsState {
    Present,
    Missing { paths: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PricingEvidence {
    Model {
        model: String,
        cost_usd: Option<f64>,
    },
    SubjectReported {
        cost_usd: f64,
    },
}

impl PricingEvidence {
    pub fn cost_usd(&self) -> Option<f64> {
        match self {
            Self::Model { cost_usd, .. } => *cost_usd,
            Self::SubjectReported { cost_usd } => Some(*cost_usd),
        }
    }

    pub fn validate(&self) -> Result<(), ContractError> {
        match self {
            Self::Model { model, cost_usd } => {
                if model.is_empty() {
                    return Err(ContractError::Invalid(
                        "pricing.model must not be empty".into(),
                    ));
                }
                if let Some(c) = cost_usd
                    && (!c.is_finite() || *c < 0.0)
                {
                    return Err(ContractError::Invalid(
                        "pricing.costUsd must be finite and non-negative".into(),
                    ));
                }
            }
            Self::SubjectReported { cost_usd } => {
                if !cost_usd.is_finite() || *cost_usd < 0.0 {
                    return Err(ContractError::Invalid(
                        "pricing.costUsd must be finite and non-negative".into(),
                    ));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AttemptMetering {
    #[default]
    Unknown,
    LowerBound {
        usage: NormalizedUsage,
    },
    Complete {
        usage: NormalizedUsage,
        #[serde(default)]
        pricing: Option<PricingEvidence>,
    },
}

impl AttemptMetering {
    pub fn state(&self) -> MeteringState {
        match self {
            Self::Unknown => MeteringState::Unknown,
            Self::LowerBound { .. } => MeteringState::LowerBound,
            Self::Complete { .. } => MeteringState::Complete,
        }
    }

    pub fn usage(&self) -> Option<&NormalizedUsage> {
        match self {
            Self::Unknown => None,
            Self::LowerBound { usage } | Self::Complete { usage, .. } => Some(usage),
        }
    }

    pub fn pricing(&self) -> Option<&PricingEvidence> {
        match self {
            Self::Complete { pricing, .. } => pricing.as_ref(),
            Self::Unknown | Self::LowerBound { .. } => None,
        }
    }

    pub fn cost_usd(&self) -> Option<f64> {
        self.pricing().and_then(PricingEvidence::cost_usd)
    }

    pub fn validate(&self) -> Result<(), ContractError> {
        if let Self::Complete {
            pricing: Some(p), ..
        } = self
        {
            p.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct V2AttemptRecord {
    pub schema_version: SchemaVersion,
    pub cell_id: String,
    pub sequence: u32,
    pub started_at: u64,
    pub completed_at: u64,
    pub duration_ms: u64,
    pub phase: AttemptPhase,
    pub execution_outcome: ExecutionOutcome,
    pub verifier_outcome: VerifierOutcome,
    pub metering: AttemptMetering,
    pub cleanup_state: CleanupState,
    pub audit_state: EgressAuditState,
    pub critical_artifacts_state: CriticalArtifactsState,
    #[serde(default)]
    pub cancellation: AttemptCancellation,
    pub recovered_post_hoc: bool,
    pub failure_reason: Option<String>,
    pub artifacts: Vec<JsonObject>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawV2AttemptRecord {
    schema_version: SchemaVersion,
    cell_id: String,
    sequence: u32,
    started_at: u64,
    completed_at: u64,
    duration_ms: u64,
    phase: AttemptPhase,
    execution_outcome: ExecutionOutcome,
    verifier_outcome: VerifierOutcome,
    metering: AttemptMetering,
    cleanup_state: CleanupState,
    audit_state: EgressAuditState,
    critical_artifacts_state: CriticalArtifactsState,
    #[serde(default)]
    cancellation: AttemptCancellation,
    recovered_post_hoc: bool,
    failure_reason: Option<String>,
    artifacts: Vec<JsonObject>,
}

impl<'de> Deserialize<'de> for V2AttemptRecord {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawV2AttemptRecord::deserialize(deserializer)?;
        let record = Self {
            schema_version: raw.schema_version,
            cell_id: raw.cell_id,
            sequence: raw.sequence,
            started_at: raw.started_at,
            completed_at: raw.completed_at,
            duration_ms: raw.duration_ms,
            phase: raw.phase,
            execution_outcome: raw.execution_outcome,
            verifier_outcome: raw.verifier_outcome,
            metering: raw.metering,
            cleanup_state: raw.cleanup_state,
            audit_state: raw.audit_state,
            critical_artifacts_state: raw.critical_artifacts_state,
            cancellation: raw.cancellation,
            recovered_post_hoc: raw.recovered_post_hoc,
            failure_reason: raw.failure_reason,
            artifacts: raw.artifacts,
        };
        record.validate().map_err(serde::de::Error::custom)?;
        Ok(record)
    }
}

impl V2AttemptRecord {
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.schema_version != SchemaVersion::V2 {
            return Err(ContractError::Invalid(
                "v2 attempt record requires schemaVersion maka.eval.v2".into(),
            ));
        }
        if self.cell_id.is_empty() {
            return Err(ContractError::Invalid(
                "v2 attempt record cellId is required".into(),
            ));
        }
        if self.sequence < 1 {
            return Err(ContractError::Invalid(
                "v2 attempt record sequence must be positive".into(),
            ));
        }
        match &self.verifier_outcome {
            VerifierOutcome::Verified { score } if !score.is_finite() => {
                return Err(ContractError::Invalid(
                    "verifier score must be finite".into(),
                ));
            }
            VerifierOutcome::SubjectFailed {
                score: Some(score), ..
            } if !score.is_finite() => {
                return Err(ContractError::Invalid(
                    "verifier score must be finite".into(),
                ));
            }
            _ => {}
        }
        self.metering.validate()?;
        Ok(())
    }

    /// Projects a native `maka.eval.v2` record into a strict `maka.eval.v1` `V1CellAttempt`
    /// while enforcing all 5 Semantic Difference Registry adjudications.
    pub fn project_v1(&self) -> V1CellAttempt {
        let mut artifacts = self.artifacts.clone();

        let usage = self.metering.usage().cloned();
        let cost_usd = self.metering.cost_usd();

        if self.cancellation == AttemptCancellation::AfterVerification
            && !artifacts.iter().any(|a| {
                a.get("kind").and_then(Value::as_str) == Some("cancelled-after-verification")
            })
        {
            artifacts.push(
                serde_json::json!({"kind": "cancelled-after-verification"})
                    .as_object()
                    .unwrap()
                    .clone(),
            );
        }

        if self.recovered_post_hoc
            && !artifacts.iter().any(|a| {
                a.get("kind").and_then(Value::as_str) == Some("post-hoc-evidence-recovery")
            })
        {
            let mut marker = Map::new();
            marker.insert(
                "kind".into(),
                Value::String("post-hoc-evidence-recovery".into()),
            );
            artifacts.push(marker);
        }

        // Unconfirmed cleanup always resolves to `indeterminate` with `score: null`.
        if let CleanupState::Unconfirmed { reason } = &self.cleanup_state {
            return V1CellAttempt {
                cell_id: self.cell_id.clone(),
                sequence: self.sequence,
                started_at: self.started_at,
                completed_at: self.completed_at,
                result: EvalResult {
                    score: None,
                    usage,
                    cost_usd,
                    duration_ms: self.duration_ms,
                    status: EvalResultStatus::Indeterminate,
                    failure_reason: Some(reason.clone()),
                    artifacts,
                },
            };
        }

        // Adjudication #4: Late cancellation BEFORE verification completes resolves to
        // `indeterminate`, whereas late cancellation AFTER verification and settlement
        // preserves the verified result and records the late cancellation signal.
        if self.cancellation == AttemptCancellation::BeforeVerification {
            return V1CellAttempt {
                cell_id: self.cell_id.clone(),
                sequence: self.sequence,
                started_at: self.started_at,
                completed_at: self.completed_at,
                result: EvalResult {
                    score: None,
                    usage,
                    cost_usd,
                    duration_ms: self.duration_ms,
                    status: EvalResultStatus::Indeterminate,
                    failure_reason: Some(self.failure_reason.clone().unwrap_or_else(|| {
                        "executor cancelled before verification completed".into()
                    })),
                    artifacts,
                },
            };
        }

        // Adjudication #3: Missing or unreadable critical artifacts downgrade to `infra_failed`.
        if let CriticalArtifactsState::Missing { paths } = &self.critical_artifacts_state {
            return V1CellAttempt {
                cell_id: self.cell_id.clone(),
                sequence: self.sequence,
                started_at: self.started_at,
                completed_at: self.completed_at,
                result: EvalResult {
                    score: None,
                    usage,
                    cost_usd,
                    duration_ms: self.duration_ms,
                    status: EvalResultStatus::InfraFailed,
                    failure_reason: Some(format!(
                        "critical artifacts missing: {}",
                        paths.join(", ")
                    )),
                    artifacts,
                },
            };
        }

        // Adjudication #2: Egress audit missing or unreadable fails closed (`infra_failed`),
        // whereas `Recorded { truncated: true, .. }` (`ruleId == "audit_truncated"`) is preserved
        // as a structured artifact flag without discarding a settled verification result.
        match &self.audit_state {
            EgressAuditState::Missing => {
                return V1CellAttempt {
                    cell_id: self.cell_id.clone(),
                    sequence: self.sequence,
                    started_at: self.started_at,
                    completed_at: self.completed_at,
                    result: EvalResult {
                        score: None,
                        usage,
                        cost_usd,
                        duration_ms: self.duration_ms,
                        status: EvalResultStatus::InfraFailed,
                        failure_reason: Some("egress audit log missing".into()),
                        artifacts,
                    },
                };
            }
            EgressAuditState::Unreadable { reason } => {
                return V1CellAttempt {
                    cell_id: self.cell_id.clone(),
                    sequence: self.sequence,
                    started_at: self.started_at,
                    completed_at: self.completed_at,
                    result: EvalResult {
                        score: None,
                        usage,
                        cost_usd,
                        duration_ms: self.duration_ms,
                        status: EvalResultStatus::InfraFailed,
                        failure_reason: Some(reason.clone()),
                        artifacts,
                    },
                };
            }
            EgressAuditState::Recorded {
                truncated,
                policy_error_count,
            } => {
                if *truncated || *policy_error_count > 0 {
                    if let Some(existing) = artifacts
                        .iter_mut()
                        .find(|a| a.get("kind").and_then(Value::as_str) == Some("egress-audit"))
                    {
                        if *truncated {
                            existing.insert("truncated".into(), Value::Bool(true));
                        }
                        if *policy_error_count > 0 {
                            existing.insert(
                                "policyErrorCount".into(),
                                Value::from(*policy_error_count),
                            );
                        }
                    } else {
                        let mut audit_obj = Map::new();
                        audit_obj.insert("kind".into(), Value::String("egress-audit".into()));
                        audit_obj.insert("truncated".into(), Value::Bool(*truncated));
                        if *policy_error_count > 0 {
                            audit_obj.insert(
                                "policyErrorCount".into(),
                                Value::from(*policy_error_count),
                            );
                        }
                        artifacts.push(audit_obj);
                    }
                }
            }
            EgressAuditState::NotRequired => {}
        }

        let (status, score, failure_reason) =
            match (&self.execution_outcome, &self.verifier_outcome) {
                (ExecutionOutcome::InfraFailed, _) => (
                    EvalResultStatus::InfraFailed,
                    None,
                    Some(
                        self.failure_reason
                            .clone()
                            .unwrap_or_else(|| "subject infrastructure failed".into()),
                    ),
                ),
                (ExecutionOutcome::Indeterminate, _) => (
                    EvalResultStatus::Indeterminate,
                    None,
                    Some(
                        self.failure_reason
                            .clone()
                            .unwrap_or_else(|| "subject execution indeterminate".into()),
                    ),
                ),
                (_, VerifierOutcome::VerifierInfraFailed { reason })
                | (_, VerifierOutcome::MissingReward { reason }) => {
                    // Missing verifier reward never defaults to 0.0!
                    (EvalResultStatus::InfraFailed, None, Some(reason.clone()))
                }
                (ExecutionOutcome::Timeout, VerifierOutcome::Verified { score }) => (
                    // Adjudication #1: Agent timed out, verifier still ran and produced a valid
                    // reward; v1 status is `subject_failed` with the verified `score` preserved.
                    EvalResultStatus::SubjectFailed,
                    Some(*score),
                    Some(
                        self.failure_reason
                            .clone()
                            .unwrap_or_else(|| "subject exceeded the framework timeout".into()),
                    ),
                ),
                (ExecutionOutcome::SubjectFailed, VerifierOutcome::Verified { score }) => (
                    EvalResultStatus::SubjectFailed,
                    Some(*score),
                    self.failure_reason.clone(),
                ),
                (
                    ExecutionOutcome::Completed
                    | ExecutionOutcome::SubjectFailed
                    | ExecutionOutcome::Timeout,
                    VerifierOutcome::SubjectFailed { score, reason },
                ) => (
                    EvalResultStatus::SubjectFailed,
                    *score,
                    self.failure_reason.clone().or_else(|| reason.clone()),
                ),
                (ExecutionOutcome::Completed, VerifierOutcome::Verified { score }) => {
                    (EvalResultStatus::Completed, Some(*score), None)
                }
                (ExecutionOutcome::Timeout, VerifierOutcome::Skipped) => (
                    EvalResultStatus::SubjectFailed,
                    None,
                    Some(
                        self.failure_reason
                            .clone()
                            .unwrap_or_else(|| "subject exceeded the framework timeout".into()),
                    ),
                ),
                (ExecutionOutcome::SubjectFailed, VerifierOutcome::Skipped) => (
                    EvalResultStatus::SubjectFailed,
                    None,
                    self.failure_reason.clone(),
                ),
                (ExecutionOutcome::Completed, VerifierOutcome::Skipped) => {
                    (EvalResultStatus::Completed, None, None)
                }
            };

        V1CellAttempt {
            cell_id: self.cell_id.clone(),
            sequence: self.sequence,
            started_at: self.started_at,
            completed_at: self.completed_at,
            result: EvalResult {
                score,
                usage,
                cost_usd,
                duration_ms: self.duration_ms,
                status,
                failure_reason,
                artifacts,
            },
        }
    }
}

/// The 5 explicit semantic difference scenarios between Legacy TS `v1` and Native Rust `v2`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DifferenceScenarioId {
    TimeoutWithRewardIncompleteUsage,
    AuditTruncation,
    MissingCriticalArtifacts,
    LateCancellation,
    EvidenceRecoveredLater,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DifferenceAdjudication {
    pub id: DifferenceScenarioId,
    pub title: String,
    pub legacy_v1_behavior: String,
    pub rust_v2_behavior: String,
    pub v1_projection_rule: String,
    pub conditions_comparable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DifferenceRegistry {
    entries: Vec<DifferenceAdjudication>,
}

impl Default for DifferenceRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl DifferenceRegistry {
    pub fn new() -> Self {
        Self {
            entries: vec![
                DifferenceAdjudication {
                    id: DifferenceScenarioId::TimeoutWithRewardIncompleteUsage,
                    title: "Timeout with verifier reward but incomplete usage".into(),
                    legacy_v1_behavior: "Projects status='subject_failed', preserves verifier score, records recovered lower-bound usage, and sets costUsd=null because metering did not settle.".into(),
                    rust_v2_behavior: "Records ExecutionOutcome::Timeout, VerifierOutcome::Verified { score }, and MeteringState::LowerBound orthogonally without conflating execution timeout and metering completeness.".into(),
                    v1_projection_rule: "Projects status='subject_failed', score=Some(score), usage=Some(lower_bound_usage), costUsd=None.".into(),
                    conditions_comparable: true,
                },
                DifferenceAdjudication {
                    id: DifferenceScenarioId::AuditTruncation,
                    title: "Egress audit log truncation at byte cap".into(),
                    legacy_v1_behavior: "Appends ruleId='audit_truncated' marker to hits.jsonl and sets truncated=true in the egress-audit artifact while keeping the attempt status unchanged.".into(),
                    rust_v2_behavior: "Captures EgressAuditState::Recorded { truncated, policy_error_count } as an explicit dimension while distinguishing it from Missing or Unreadable audit logs (which fail closed as infra_failed).".into(),
                    v1_projection_rule: "Preserves completed/subject_failed status and emits the egress-audit artifact with truncated=true and policyErrorCount when nonzero; Missing or Unreadable audit logs project to status='infra_failed'.".into(),
                    conditions_comparable: true,
                },
                DifferenceAdjudication {
                    id: DifferenceScenarioId::MissingCriticalArtifacts,
                    title: "0-byte empty file vs. missing or unreadable critical artifact".into(),
                    legacy_v1_behavior: "Treats a present 0-byte regular file (e.g. empty stderr) as valid with bytes=0, while missing/unreadable required evidence fails the attempt.".into(),
                    rust_v2_behavior: "Tracks CriticalArtifactsState::Present (including 0-byte regular files verified by inode/stat) separately from CriticalArtifactsState::Missing.".into(),
                    v1_projection_rule: "0-byte regular files remain valid artifacts with bytes=0; Missing critical artifacts project to status='infra_failed' with score=None.".into(),
                    conditions_comparable: true,
                },
                DifferenceAdjudication {
                    id: DifferenceScenarioId::LateCancellation,
                    title: "Cancellation signal before vs. after verification and settlement".into(),
                    legacy_v1_behavior: "An abort signal observed before attempt append could overwrite a verified result with indeterminate.".into(),
                    rust_v2_behavior: "Separates AttemptCancellation::BeforeVerification from AttemptCancellation::AfterVerification orthogonally from ExecutionOutcome.".into(),
                    v1_projection_rule: "Pre-verification cancellation projects to status='indeterminate' with score=None; post-verification cancellation preserves the verified terminal result and emits cancelled-after-verification.".into(),
                    conditions_comparable: true,
                },
                DifferenceAdjudication {
                    id: DifferenceScenarioId::EvidenceRecoveredLater,
                    title: "Post-hoc evidence recovered from checkpoint or host journal after crash".into(),
                    legacy_v1_behavior: "Mutated or re-ran the attempt when the process died before writing the final cell JSON.".into(),
                    rust_v2_behavior: "Appends a PostHocRecovery journal entry referencing the original attempt sequence and reconstructs V2AttemptRecord with AttemptMetering and recovered_post_hoc=true without mutating prior entries.".into(),
                    v1_projection_rule: "Projects recovered usage/cost and appends a post-hoc-evidence-recovery artifact while preserving immutable sequence numbering.".into(),
                    conditions_comparable: true,
                },
            ],
        }
    }

    pub fn entries(&self) -> &[DifferenceAdjudication] {
        &self.entries
    }

    pub fn get(&self, id: DifferenceScenarioId) -> Option<&DifferenceAdjudication> {
        self.entries.iter().find(|entry| entry.id == id)
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

pub(crate) fn exact_object<'a>(
    value: &'a Value,
    where_label: &str,
    required: &[&str],
    optional: &[&str],
) -> Result<&'a JsonObject, ContractError> {
    let obj = value
        .as_object()
        .ok_or_else(|| ContractError::Invalid(format!("{where_label} must be an object")))?;
    for key in obj.keys() {
        if !required.contains(&key.as_str()) && !optional.contains(&key.as_str()) {
            return Err(ContractError::Invalid(format!(
                "{where_label} has unsupported fields"
            )));
        }
    }
    for req in required {
        if !obj.contains_key(*req) {
            return Err(ContractError::Invalid(format!(
                "{where_label}.{req} is required"
            )));
        }
    }
    Ok(obj)
}

pub(crate) fn decode_json_object(
    value: &Value,
    where_label: &str,
) -> Result<JsonObject, ContractError> {
    let obj = value
        .as_object()
        .ok_or_else(|| ContractError::Invalid(format!("{where_label} must be an object")))?;
    for (k, v) in obj {
        validate_json_value(v, &format!("{where_label}.{k}"))?;
    }
    Ok(obj.clone())
}

fn validate_json_value(value: &Value, where_label: &str) -> Result<(), ContractError> {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => Ok(()),
        Value::Number(n) => {
            if n.as_f64().is_some_and(f64::is_finite) {
                Ok(())
            } else {
                Err(ContractError::Invalid(format!(
                    "{where_label} must be JSON"
                )))
            }
        }
        Value::Array(arr) => {
            for (idx, item) in arr.iter().enumerate() {
                validate_json_value(item, &format!("{where_label}[{idx}]"))?;
            }
            Ok(())
        }
        Value::Object(map) => {
            for (k, v) in map {
                validate_json_value(v, &format!("{where_label}.{k}"))?;
            }
            Ok(())
        }
    }
}

pub(crate) fn identifier(value: &Value, where_label: &str) -> Result<String, ContractError> {
    let text = nonempty_string(value, where_label)?;
    let mut chars = text.chars();
    let Some(first) = chars.next() else {
        return Err(ContractError::Invalid(format!("{where_label} is required")));
    };
    if !first.is_ascii_alphanumeric()
        || !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(ContractError::Invalid(format!("{where_label} is invalid")));
    }
    Ok(text)
}

pub(crate) fn nonempty_string(value: &Value, where_label: &str) -> Result<String, ContractError> {
    match value.as_str() {
        Some(s) if !s.is_empty() => Ok(s.to_owned()),
        _ => Err(ContractError::Invalid(format!("{where_label} is required"))),
    }
}

fn unique_strings(value: &Value, where_label: &str) -> Result<Vec<String>, ContractError> {
    let arr = value
        .as_array()
        .ok_or_else(|| ContractError::Invalid(format!("{where_label} must be an array")))?;
    let mut seen = BTreeSet::new();
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let s = nonempty_string(item, where_label)?;
        if !seen.insert(s.clone()) {
            return Err(ContractError::Invalid(format!(
                "{where_label} contains duplicates"
            )));
        }
        out.push(s);
    }
    Ok(out)
}

fn ensure_unique_ids<'a>(
    ids: impl Iterator<Item = &'a str>,
    label: &str,
) -> Result<(), ContractError> {
    let mut seen = BTreeSet::new();
    for id in ids {
        if !seen.insert(id) {
            return Err(ContractError::Invalid(format!("duplicate {label} id")));
        }
    }
    Ok(())
}

pub(crate) fn positive_u32(value: &Value, where_label: &str) -> Result<u32, ContractError> {
    match value.as_u64() {
        Some(n) if n >= 1 && n <= u64::from(u32::MAX) => Ok(n as u32),
        _ => Err(ContractError::Invalid(format!(
            "{where_label} must be positive"
        ))),
    }
}

pub(crate) fn positive_usize(value: &Value, where_label: &str) -> Result<usize, ContractError> {
    match value.as_u64() {
        Some(n) if n >= 1 => usize::try_from(n)
            .map_err(|_| ContractError::Invalid(format!("{where_label} must be positive"))),
        _ => Err(ContractError::Invalid(format!(
            "{where_label} must be positive"
        ))),
    }
}

pub(crate) fn nonnegative_u64(value: &Value, where_label: &str) -> Result<u64, ContractError> {
    match value.as_u64() {
        Some(n) => Ok(n),
        None => match value.as_f64() {
            Some(f) if f.is_finite() && f >= 0.0 && f.fract() == 0.0 => Ok(f as u64),
            _ => Err(ContractError::Invalid(format!("{where_label} is invalid"))),
        },
    }
}

pub(crate) fn nullable_f64(value: &Value, where_label: &str) -> Result<Option<f64>, ContractError> {
    if value.is_null() {
        return Ok(None);
    }
    match value.as_f64() {
        Some(f) if f.is_finite() => Ok(Some(f)),
        _ => Err(ContractError::Invalid(format!("{where_label} is invalid"))),
    }
}

pub(crate) fn nullable_nonnegative_f64(
    value: &Value,
    where_label: &str,
) -> Result<Option<f64>, ContractError> {
    if value.is_null() {
        return Ok(None);
    }
    match value.as_f64() {
        Some(f) if f.is_finite() && f >= 0.0 => Ok(Some(f)),
        _ => Err(ContractError::Invalid(format!("{where_label} is invalid"))),
    }
}
