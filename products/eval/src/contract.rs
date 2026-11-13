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
//! projections, and run fingerprinting.

use crate::measurement::{NormalizedUsage, decode_usage};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fmt;

pub type JsonObject = Map<String, Value>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContractError(String);

impl ContractError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ContractError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ContractError {}

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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

pub fn expand_experiment(spec: &ExperimentSpec) -> Vec<ExperimentCell> {
    let mut cells =
        Vec::with_capacity(spec.tasks.len() * (spec.repetitions as usize) * spec.subjects.len());
    for task in &spec.tasks {
        for repetition in 1..=spec.repetitions {
            for subject in &spec.subjects {
                cells.push(ExperimentCell {
                    id: format!("{}::{repetition}::{}", task.id, subject.id),
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

fn parse_experiment_spec(value: &Value) -> Result<ExperimentSpec, ContractError> {
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
            return Err(ContractError::new("unsupported experiment schema"));
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
        .ok_or_else(|| ContractError::new("subjects must be an array"))?;
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
                return Err(ContractError::new(format!("{where_label}.kind is invalid")));
            }
        };
        subjects.push(SubjectSpec {
            id: identifier(sub_obj.get("id").unwrap(), &format!("{where_label}.id"))?,
            kind,
            credentials: unique_strings(
                sub_obj.get("credentials").unwrap(),
                &format!("{where_label}.credentials"),
            )?,
            config: json_object(
                sub_obj.get("config").unwrap(),
                &format!("{where_label}.config"),
            )?,
        });
    }

    let tasks_arr = root
        .get("tasks")
        .and_then(Value::as_array)
        .ok_or_else(|| ContractError::new("tasks must be an array"))?;
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
            config: json_object(
                task_obj.get("config").unwrap(),
                &format!("{where_label}.config"),
            )?,
        });
    }

    if subjects.is_empty() || tasks.is_empty() {
        return Err(ContractError::new("experiment arms are empty"));
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
            config: json_object(benchmark_obj.get("config").unwrap(), "benchmark.config")?,
        },
        executor: ExecutorSpec {
            kind: identifier(executor_obj.get("kind").unwrap(), "executor.kind")?,
            config: json_object(executor_obj.get("config").unwrap(), "executor.config")?,
        },
        execution: ExecutionSpec {
            max_concurrent_task_groups,
        },
        subjects,
        tasks,
        repetitions,
        budget: json_object(root.get("budget").unwrap(), "budget")?,
        verifier: json_object(root.get("verifier").unwrap(), "verifier")?,
    })
}

fn canonical_sha256_hex(value: &Value) -> String {
    let mut buf = Vec::with_capacity(256);
    write_canonical_json(value, &mut buf);
    let mut hasher = Sha256::new();
    hasher.update(&buf);
    hex::encode(hasher.finalize())
}

fn write_canonical_json(value: &Value, out: &mut Vec<u8>) {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => {
            serde_json::to_writer(&mut *out, value)
                .expect("canonical JSON value serialization cannot fail");
        }
        Value::Number(n) => {
            if n.is_u64() || n.is_i64() {
                serde_json::to_writer(&mut *out, n)
                    .expect("canonical integer serialization cannot fail");
            } else if let Some(f) = n.as_f64() {
                if f == 0.0 {
                    out.extend_from_slice(b"0");
                } else if f.is_finite()
                    && f.fract() == 0.0
                    && (-9_007_199_254_740_991.0..=9_007_199_254_740_991.0).contains(&f)
                {
                    if f >= 0.0 {
                        serde_json::to_writer(&mut *out, &(f as u64))
                            .expect("canonical float->u64 serialization cannot fail");
                    } else {
                        serde_json::to_writer(&mut *out, &(f as i64))
                            .expect("canonical float->i64 serialization cannot fail");
                    }
                } else {
                    serde_json::to_writer(&mut *out, n)
                        .expect("canonical float serialization cannot fail");
                }
            } else {
                serde_json::to_writer(&mut *out, n)
                    .expect("canonical number serialization cannot fail");
            }
        }
        Value::Array(items) => {
            out.push(b'[');
            for (idx, item) in items.iter().enumerate() {
                if idx > 0 {
                    out.push(b',');
                }
                write_canonical_json(item, out);
            }
            out.push(b']');
        }
        Value::Object(map) => {
            // Explicit key sorting is required because workspace feature unification
            // enables serde_json/preserve_order.
            let mut sorted: Vec<(&String, &Value)> = map.iter().collect();
            sorted.sort_by_key(|(k, _)| *k);
            out.push(b'{');
            for (idx, (k, v)) in sorted.into_iter().enumerate() {
                if idx > 0 {
                    out.push(b',');
                }
                serde_json::to_writer(&mut *out, k)
                    .expect("canonical object key serialization cannot fail");
                out.push(b':');
                write_canonical_json(v, out);
            }
            out.push(b'}');
        }
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
            semantic_sha256: canonical_sha256_hex(&semantic_payload),
            execution_sha256: canonical_sha256_hex(&execution_payload),
        }
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

impl EvalResultStatus {
    pub fn is_selectable(self) -> bool {
        matches!(self, Self::Completed | Self::SubjectFailed)
    }
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

/// Canonical cell result selector: selects the earliest valid attempt by sequence (`sequence >= 1`)
/// whose status is neither `infra_failed` nor `indeterminate`. A `completed` attempt with score `0.0`
/// or a `subject_failed` attempt is terminal and never replaced.
pub fn select_cell_result(attempts: &[V1CellAttempt]) -> Option<&V1CellAttempt> {
    attempts
        .iter()
        .filter(|a| a.sequence >= 1 && a.result.status.is_selectable())
        .min_by_key(|a| a.sequence)
}

fn decode_eval_result(value: &Value, where_label: &str) -> Result<EvalResult, ContractError> {
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
            return Err(ContractError::new(format!(
                "{where_label}.status is invalid"
            )));
        }
    };
    let failure_reason = match obj.get("failureReason").unwrap() {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        _ => {
            return Err(ContractError::new(format!(
                "{where_label}.failureReason is invalid"
            )));
        }
    };
    let score = nullable_f64(obj.get("score").unwrap(), &format!("{where_label}.score"))?;
    let usage = match obj.get("usage").unwrap() {
        Value::Null => None,
        u => Some(decode_usage(u, &format!("{where_label}.usage"))?),
    };
    let cost_usd = nullable_nonnegative_f64(
        obj.get("costUsd").unwrap(),
        &format!("{where_label}.costUsd"),
    )?;
    let duration_ms = nonnegative_u64(
        obj.get("durationMs").unwrap(),
        &format!("{where_label}.durationMs"),
    )?;
    let artifacts_arr = obj
        .get("artifacts")
        .and_then(Value::as_array)
        .ok_or_else(|| ContractError::new(format!("{where_label}.artifacts is invalid")))?;
    let mut artifacts = Vec::with_capacity(artifacts_arr.len());
    for (idx, item) in artifacts_arr.iter().enumerate() {
        artifacts.push(json_object(
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

fn decode_v1_cell_attempt(value: &Value) -> Result<V1CellAttempt, ContractError> {
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
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
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
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CleanupState {
    Confirmed,
    Unconfirmed { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CriticalArtifactsState {
    Present,
    Missing { paths: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    remote = "Self",
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
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

impl Serialize for PricingEvidence {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        Self::serialize(self, serializer)
    }
}

impl<'de> Deserialize<'de> for PricingEvidence {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Self::deserialize(deserializer)?;
        value.validate().map_err(serde::de::Error::custom)?;
        Ok(value)
    }
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
                    return Err(ContractError::new("pricing.model must not be empty"));
                }
                if let Some(c) = cost_usd
                    && (!c.is_finite() || *c < 0.0)
                {
                    return Err(ContractError::new(
                        "pricing.costUsd must be finite and non-negative",
                    ));
                }
            }
            Self::SubjectReported { cost_usd } => {
                if !cost_usd.is_finite() || *cost_usd < 0.0 {
                    return Err(ContractError::new(
                        "pricing.costUsd must be finite and non-negative",
                    ));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
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

impl<'de> Deserialize<'de> for AttemptMetering {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        let state = value
            .as_object()
            .and_then(|obj| obj.get("state"))
            .and_then(Value::as_str)
            .ok_or_else(|| serde::de::Error::custom("metering.state is required"))?;
        let metering = match state {
            "unknown" => {
                exact_object(&value, "metering", &["state"], &[])
                    .map_err(serde::de::Error::custom)?;
                Self::Unknown
            }
            "lower_bound" => {
                let obj = exact_object(&value, "metering", &["state", "usage"], &[])
                    .map_err(serde::de::Error::custom)?;
                Self::LowerBound {
                    usage: decode_usage(obj.get("usage").unwrap(), "metering.usage")
                        .map_err(serde::de::Error::custom)?,
                }
            }
            "complete" => {
                let obj = exact_object(&value, "metering", &["state", "usage"], &["pricing"])
                    .map_err(serde::de::Error::custom)?;
                let pricing = match obj.get("pricing") {
                    None | Some(Value::Null) => None,
                    Some(p) => {
                        Some(serde_json::from_value(p.clone()).map_err(serde::de::Error::custom)?)
                    }
                };
                Self::Complete {
                    usage: decode_usage(obj.get("usage").unwrap(), "metering.usage")
                        .map_err(serde::de::Error::custom)?,
                    pricing,
                }
            }
            _ => return Err(serde::de::Error::custom("metering.state is invalid")),
        };
        metering.validate().map_err(serde::de::Error::custom)?;
        Ok(metering)
    }
}

impl AttemptMetering {
    pub fn usage(&self) -> Option<&NormalizedUsage> {
        match self {
            Self::Unknown => None,
            Self::LowerBound { usage } | Self::Complete { usage, .. } => Some(usage),
        }
    }

    pub fn cost_usd(&self) -> Option<f64> {
        match self {
            Self::Complete {
                pricing: Some(pricing),
                ..
            } => pricing.cost_usd(),
            Self::Unknown | Self::LowerBound { .. } | Self::Complete { pricing: None, .. } => None,
        }
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub struct V2AttemptRecord {
    pub schema_version: SchemaVersion,
    pub cell_id: String,
    pub sequence: u32,
    pub started_at: u64,
    pub completed_at: u64,
    pub duration_ms: u64,
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

impl Serialize for V2AttemptRecord {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        Self::serialize(self, serializer)
    }
}

impl<'de> Deserialize<'de> for V2AttemptRecord {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let record = Self::deserialize(deserializer)?;
        record.validate().map_err(serde::de::Error::custom)?;
        Ok(record)
    }
}

impl V2AttemptRecord {
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.schema_version != SchemaVersion::V2 {
            return Err(ContractError::new(
                "v2 attempt record requires schemaVersion maka.eval.v2",
            ));
        }
        if self.cell_id.is_empty() {
            return Err(ContractError::new("v2 attempt record cellId is required"));
        }
        if self.sequence < 1 {
            return Err(ContractError::new(
                "v2 attempt record sequence must be positive",
            ));
        }
        match &self.verifier_outcome {
            VerifierOutcome::Verified { score } if !score.is_finite() => {
                return Err(ContractError::new("verifier score must be finite"));
            }
            VerifierOutcome::SubjectFailed {
                score: Some(score), ..
            } if !score.is_finite() => {
                return Err(ContractError::new("verifier score must be finite"));
            }
            _ => {}
        }
        if self.resolve_outcome().0 == EvalResultStatus::Completed && self.failure_reason.is_some()
        {
            return Err(ContractError::new(
                "v2 completed attempt record must not set failureReason",
            ));
        }
        self.metering.validate()?;
        Ok(())
    }

    fn resolve_outcome(&self) -> (EvalResultStatus, Option<f64>, Option<String>) {
        // Unconfirmed cleanup always resolves to `indeterminate` with `score: null`.
        if let CleanupState::Unconfirmed { reason } = &self.cleanup_state {
            return (EvalResultStatus::Indeterminate, None, Some(reason.clone()));
        }

        // Late cancellation before verification completes resolves to `indeterminate`.
        if self.cancellation == AttemptCancellation::BeforeVerification {
            return (
                EvalResultStatus::Indeterminate,
                None,
                Some(
                    self.failure_reason.clone().unwrap_or_else(|| {
                        "executor cancelled before verification completed".into()
                    }),
                ),
            );
        }

        if let CriticalArtifactsState::Missing { paths } = &self.critical_artifacts_state {
            return (
                EvalResultStatus::InfraFailed,
                None,
                Some(format!("critical artifacts missing: {}", paths.join(", "))),
            );
        }

        match &self.audit_state {
            EgressAuditState::Missing => {
                return (
                    EvalResultStatus::InfraFailed,
                    None,
                    Some("egress audit log missing".into()),
                );
            }
            EgressAuditState::Unreadable { reason } => {
                return (EvalResultStatus::InfraFailed, None, Some(reason.clone()));
            }
            EgressAuditState::NotRequired | EgressAuditState::Recorded { .. } => {}
        }

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
        }
    }

    /// Projects a native `maka.eval.v2` record into a strict `maka.eval.v1` `V1CellAttempt`.
    pub fn project_v1(&self) -> V1CellAttempt {
        let mut artifacts = self.artifacts.clone();
        if self.cancellation == AttemptCancellation::AfterVerification {
            push_artifact_marker(&mut artifacts, "cancelled-after-verification");
        }
        if self.recovered_post_hoc {
            push_artifact_marker(&mut artifacts, "post-hoc-evidence-recovery");
        }
        if let EgressAuditState::Recorded {
            truncated,
            policy_error_count,
        } = &self.audit_state
            && (*truncated || *policy_error_count > 0)
        {
            record_audit_artifact(&mut artifacts, *truncated, *policy_error_count);
        }

        let (status, score, failure_reason) = self.resolve_outcome();
        V1CellAttempt {
            cell_id: self.cell_id.clone(),
            sequence: self.sequence,
            started_at: self.started_at,
            completed_at: self.completed_at,
            result: EvalResult {
                score,
                usage: self.metering.usage().cloned(),
                cost_usd: self.metering.cost_usd(),
                duration_ms: self.duration_ms,
                status,
                failure_reason,
                artifacts,
            },
        }
    }
}

fn push_artifact_marker(artifacts: &mut Vec<JsonObject>, kind: &str) {
    if !artifacts
        .iter()
        .any(|a| a.get("kind").and_then(Value::as_str) == Some(kind))
    {
        let mut marker = Map::new();
        marker.insert("kind".into(), Value::String(kind.into()));
        artifacts.push(marker);
    }
}

fn record_audit_artifact(
    artifacts: &mut Vec<JsonObject>,
    truncated: bool,
    policy_error_count: u64,
) {
    if let Some(existing) = artifacts
        .iter_mut()
        .find(|a| a.get("kind").and_then(Value::as_str) == Some("egress-audit"))
    {
        if truncated {
            existing.insert("truncated".into(), Value::Bool(true));
        }
        if policy_error_count > 0 {
            existing.insert("policyErrorCount".into(), Value::from(policy_error_count));
        }
    } else {
        let mut audit_obj = Map::new();
        audit_obj.insert("kind".into(), Value::String("egress-audit".into()));
        audit_obj.insert("truncated".into(), Value::Bool(truncated));
        if policy_error_count > 0 {
            audit_obj.insert("policyErrorCount".into(), Value::from(policy_error_count));
        }
        artifacts.push(audit_obj);
    }
}

pub(crate) fn exact_object<'a>(
    value: &'a Value,
    where_label: &str,
    required: &[&str],
    optional: &[&str],
) -> Result<&'a JsonObject, ContractError> {
    let obj = value
        .as_object()
        .ok_or_else(|| ContractError::new(format!("{where_label} must be an object")))?;
    for key in obj.keys() {
        if !required.contains(&key.as_str()) && !optional.contains(&key.as_str()) {
            return Err(ContractError::new(format!(
                "{where_label} has unsupported fields"
            )));
        }
    }
    for req in required {
        if !obj.contains_key(*req) {
            return Err(ContractError::new(format!(
                "{where_label}.{req} is required"
            )));
        }
    }
    Ok(obj)
}

fn json_object(value: &Value, where_label: &str) -> Result<JsonObject, ContractError> {
    value
        .as_object()
        .cloned()
        .ok_or_else(|| ContractError::new(format!("{where_label} must be an object")))
}

fn identifier(value: &Value, where_label: &str) -> Result<String, ContractError> {
    let text = nonempty_string(value, where_label)?;
    let mut chars = text.chars();
    let Some(first) = chars.next() else {
        return Err(ContractError::new(format!("{where_label} is required")));
    };
    if !first.is_ascii_alphanumeric()
        || !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(ContractError::new(format!("{where_label} is invalid")));
    }
    Ok(text)
}

fn nonempty_string(value: &Value, where_label: &str) -> Result<String, ContractError> {
    match value.as_str() {
        Some(s) if !s.is_empty() => Ok(s.to_owned()),
        _ => Err(ContractError::new(format!("{where_label} is required"))),
    }
}

fn unique_strings(value: &Value, where_label: &str) -> Result<Vec<String>, ContractError> {
    let arr = value
        .as_array()
        .ok_or_else(|| ContractError::new(format!("{where_label} must be an array")))?;
    let mut seen = BTreeSet::new();
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let s = nonempty_string(item, where_label)?;
        if !seen.insert(s.clone()) {
            return Err(ContractError::new(format!(
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
            return Err(ContractError::new(format!("duplicate {label} id")));
        }
    }
    Ok(())
}

fn positive_u32(value: &Value, where_label: &str) -> Result<u32, ContractError> {
    match value.as_u64() {
        Some(n) if n >= 1 && n <= u64::from(u32::MAX) => Ok(n as u32),
        _ => Err(ContractError::new(format!(
            "{where_label} must be positive"
        ))),
    }
}

fn positive_usize(value: &Value, where_label: &str) -> Result<usize, ContractError> {
    match value.as_u64() {
        Some(n) if n >= 1 => usize::try_from(n)
            .map_err(|_| ContractError::new(format!("{where_label} must be positive"))),
        _ => Err(ContractError::new(format!(
            "{where_label} must be positive"
        ))),
    }
}

pub(crate) fn nonnegative_u64(value: &Value, where_label: &str) -> Result<u64, ContractError> {
    match value.as_u64() {
        Some(n) => Ok(n),
        None => match value.as_f64() {
            Some(f) if f.is_finite() && f >= 0.0 && f.fract() == 0.0 => Ok(f as u64),
            _ => Err(ContractError::new(format!("{where_label} is invalid"))),
        },
    }
}

fn nullable_f64(value: &Value, where_label: &str) -> Result<Option<f64>, ContractError> {
    if value.is_null() {
        return Ok(None);
    }
    match value.as_f64() {
        Some(f) if f.is_finite() => Ok(Some(f)),
        _ => Err(ContractError::new(format!("{where_label} is invalid"))),
    }
}

fn nullable_nonnegative_f64(
    value: &Value,
    where_label: &str,
) -> Result<Option<f64>, ContractError> {
    if value.is_null() {
        return Ok(None);
    }
    match value.as_f64() {
        Some(f) if f.is_finite() && f >= 0.0 => Ok(Some(f)),
        _ => Err(ContractError::new(format!("{where_label} is invalid"))),
    }
}
