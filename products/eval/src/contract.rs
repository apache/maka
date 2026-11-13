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

//! Experiment specifications, immutable `v2` attempt records with 3-gate
//! causal adjudication, strict `v1` leaf projections, and spec fingerprinting.

use crate::measurement::{NormalizedUsage, PricingRates, decode_usage};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fmt;
use std::num::NonZeroU32;

pub type JsonObject = Map<String, Value>;

pub const EGRESS_AUDIT_ARTIFACT_PATH: &str = "artifacts/egress-hits.jsonl";

const MAX_SAFE_INTEGER_F64: f64 = 9_007_199_254_740_991.0;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionSpec {
    pub max_concurrent_task_groups: NonZeroU32,
}

impl Default for ExecutionSpec {
    fn default() -> Self {
        Self {
            max_concurrent_task_groups: NonZeroU32::MIN,
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
    pub repetitions: NonZeroU32,
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
    pub repetition: NonZeroU32,
    pub budget: JsonObject,
    pub verifier: JsonObject,
}

pub fn expand_experiment(spec: &ExperimentSpec) -> Vec<ExperimentCell> {
    let mut cells = Vec::with_capacity(
        spec.tasks.len() * (spec.repetitions.get() as usize) * spec.subjects.len(),
    );
    for task in &spec.tasks {
        for r in 1..=spec.repetitions.get() {
            let repetition = NonZeroU32::new(r).expect("range starts at 1");
            for subject in &spec.subjects {
                cells.push(ExperimentCell {
                    id: format!("{}::{r}::{}", task.id, subject.id),
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
        None => NonZeroU32::MIN,
        Some(exec_val) => {
            let exec_obj = exact_object(exec_val, "execution", &["maxConcurrentTaskGroups"], &[])?;
            positive_nonzero_u32(
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

    let repetitions = positive_nonzero_u32(root.get("repetitions").unwrap(), "repetitions")?;

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
                    && (-MAX_SAFE_INTEGER_F64..=MAX_SAFE_INTEGER_F64).contains(&f)
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

/// Canonical digests of declared `ExperimentSpec` semantic and execution parameters.
///
/// Fingerprints cover only the declared experiment specification; they do not capture
/// host/runtime binaries, prompt or tool schemas, container image digests, or product parity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpecFingerprint {
    /// Digest over schema version, benchmark, executor kind, subjects, tasks, repetitions, budget, and verifier.
    pub semantic_sha256: String,
    /// Digest over execution-only spec parameters (e.g. `maxConcurrentTaskGroups`, `executor.config`).
    pub execution_sha256: String,
}

impl SpecFingerprint {
    pub fn compute(spec: &ExperimentSpec) -> Self {
        let semantic_payload = serde_json::json!({
            "schemaVersion": spec.schema_version,
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
    pub sequence: NonZeroU32,
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

/// Legacy `v1` cell result selector for frozen oracle compatibility: picks the earliest
/// attempt by sequence whose status is `completed` or `subject_failed`.
pub fn select_cell_result(attempts: &[V1CellAttempt]) -> Option<&V1CellAttempt> {
    attempts
        .iter()
        .filter(|a| a.result.status.is_selectable())
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
    let duration_ms = safe_u64(
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
        sequence: positive_nonzero_u32(obj.get("sequence").unwrap(), "attempt.sequence")?,
        started_at: safe_u64(obj.get("startedAt").unwrap(), "attempt.startedAt")?,
        completed_at: safe_u64(obj.get("completedAt").unwrap(), "attempt.completedAt")?,
        result: decode_eval_result(obj.get("result").unwrap(), "attempt.result")?,
    })
}

/// Monotonic phase durations (in milliseconds) recorded on native `v2` attempts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhaseDurationsMs {
    pub queue_wait_ms: u64,
    pub prepare_ms: u64,
    pub subject_ms: u64,
    pub verify_ms: u64,
    pub cleanup_ms: u64,
    pub total_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SubjectOutcome {
    Completed {},
    Failed {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    Timeout {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum VerifierOutcome {
    Verified {
        score: f64,
    },
    SubjectFailed {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        score: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// Missing reward file or empty verifier payload: never defaults to `0.0`.
    MissingReward {
        reason: String,
    },
    InfraFailed {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "stage",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TrialOutcome {
    InfraFailed {
        reason: String,
    },
    Indeterminate {
        reason: String,
    },
    CancelledBeforeVerification {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    Evaluated {
        subject: SubjectOutcome,
        verifier: VerifierOutcome,
        #[serde(default)]
        cancelled_after_verification: bool,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
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
                let obj = exact_object(&value, "metering", &["state", "usage"], &["model"])
                    .map_err(serde::de::Error::custom)?;
                let model = match obj.get("model") {
                    None | Some(Value::Null) => None,
                    Some(m) => Some(
                        nonempty_string(m, "metering.model").map_err(serde::de::Error::custom)?,
                    ),
                };
                Self::Complete {
                    usage: decode_usage(obj.get("usage").unwrap(), "metering.usage")
                        .map_err(serde::de::Error::custom)?,
                    model,
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

    /// Standardized USD cost derived strictly from `PricingRates::for_model` on `Complete` metering.
    pub fn cost_usd(&self) -> Option<f64> {
        match self {
            Self::Complete {
                usage,
                model: Some(model),
            } => PricingRates::for_model(model).map(|rates| rates.cost_usd(usage)),
            Self::Unknown | Self::LowerBound { .. } | Self::Complete { model: None, .. } => None,
        }
    }

    pub fn validate(&self) -> Result<(), ContractError> {
        if let Self::Complete {
            model: Some(model), ..
        } = self
            && model.is_empty()
        {
            return Err(ContractError::new("metering.model must not be empty"));
        }
        Ok(())
    }

    fn rank(&self) -> u8 {
        match self {
            Self::Unknown => 0,
            Self::LowerBound { .. } => 1,
            Self::Complete { .. } => 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CleanupState {
    Confirmed {},
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
    NotRequired {},
    Recorded {
        bytes: u64,
        sha256: String,
        #[serde(default)]
        truncated: bool,
        #[serde(default)]
        policy_error_count: u64,
        #[serde(default)]
        malformed_line_count: u64,
    },
    Missing {},
    Unreadable {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CriticalArtifactsState {
    Present {},
    Missing { paths: Vec<String> },
}

#[derive(Debug, Clone, PartialEq)]
pub struct V2AttemptParts {
    pub cell_id: String,
    pub sequence: NonZeroU32,
    pub started_at: u64,
    pub completed_at: u64,
    pub durations: PhaseDurationsMs,
    pub trial_outcome: TrialOutcome,
    pub metering: AttemptMetering,
    pub cleanup_state: CleanupState,
    pub audit_state: EgressAuditState,
    pub critical_artifacts_state: CriticalArtifactsState,
    pub artifacts: Vec<JsonObject>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct V2AttemptWire {
    schema_version: SchemaVersion,
    cell_id: String,
    sequence: NonZeroU32,
    started_at: u64,
    completed_at: u64,
    durations: PhaseDurationsMs,
    trial_outcome: TrialOutcome,
    metering: AttemptMetering,
    cleanup_state: CleanupState,
    audit_state: EgressAuditState,
    critical_artifacts_state: CriticalArtifactsState,
    artifacts: Vec<JsonObject>,
}

/// Immutable, validated `maka.eval.v2` attempt record.
#[derive(Debug, Clone, PartialEq)]
pub struct V2AttemptRecord(V2AttemptParts);

impl V2AttemptRecord {
    pub fn try_new(parts: V2AttemptParts) -> Result<Self, ContractError> {
        if parts.cell_id.is_empty() {
            return Err(ContractError::new("v2 attempt record cellId is required"));
        }
        if parts.completed_at < parts.started_at {
            return Err(ContractError::new(
                "v2 attempt record completedAt must not precede startedAt",
            ));
        }
        validate_trial_outcome(&parts.trial_outcome)?;
        parts.metering.validate()?;
        validate_cleanup_state(&parts.cleanup_state)?;
        validate_audit_state(&parts.audit_state)?;
        validate_critical_artifacts_state(&parts.critical_artifacts_state)?;
        Ok(Self(parts))
    }

    pub fn cell_id(&self) -> &str {
        &self.0.cell_id
    }

    pub fn sequence(&self) -> NonZeroU32 {
        self.0.sequence
    }

    pub fn started_at(&self) -> u64 {
        self.0.started_at
    }

    pub fn completed_at(&self) -> u64 {
        self.0.completed_at
    }

    pub fn durations(&self) -> &PhaseDurationsMs {
        &self.0.durations
    }

    pub fn trial_outcome(&self) -> &TrialOutcome {
        &self.0.trial_outcome
    }

    pub fn metering(&self) -> &AttemptMetering {
        &self.0.metering
    }

    pub fn cleanup_state(&self) -> &CleanupState {
        &self.0.cleanup_state
    }

    pub fn audit_state(&self) -> &EgressAuditState {
        &self.0.audit_state
    }

    pub fn critical_artifacts_state(&self) -> &CriticalArtifactsState {
        &self.0.critical_artifacts_state
    }

    pub fn artifacts(&self) -> &[JsonObject] {
        &self.0.artifacts
    }

    pub fn into_parts(self) -> V2AttemptParts {
        self.0
    }

    pub fn disposition(&self) -> V2Disposition {
        self.disposition_with_recovery(&[])
    }

    pub fn disposition_with_recovery(&self, recoveries: &[PostHocRecovery]) -> V2Disposition {
        let (effective_cleanup, effective_metering) = self.effective_evidence(recoveries);
        self.adjudicate(effective_cleanup, effective_metering)
    }

    /// Projects this `maka.eval.v2` record into a strict `maka.eval.v1` `V1CellAttempt`.
    pub fn project_v1(&self) -> V1CellAttempt {
        self.project_v1_with_recovery(&[])
    }

    /// Projects this `maka.eval.v2` record plus appended post-hoc recovery entries
    /// into a strict `maka.eval.v1` `V1CellAttempt` without mutating the record.
    pub fn project_v1_with_recovery(&self, recoveries: &[PostHocRecovery]) -> V1CellAttempt {
        let (effective_cleanup, effective_metering) = self.effective_evidence(recoveries);
        let disposition = self.adjudicate(effective_cleanup, effective_metering);

        let mut artifacts = self.0.artifacts.clone();
        if matches!(
            self.0.trial_outcome,
            TrialOutcome::Evaluated {
                cancelled_after_verification: true,
                ..
            }
        ) {
            push_artifact_marker(&mut artifacts, "cancelled-after-verification");
        }
        if !recoveries.is_empty() {
            push_artifact_marker(&mut artifacts, "post-hoc-evidence-recovery");
        }
        append_egress_audit_artifact(&mut artifacts, &self.0.audit_state);

        let (status, score, failure_reason) = match disposition {
            V2Disposition::Selected {
                status: SelectedStatus::Completed,
                score,
                failure_reason,
            } => (EvalResultStatus::Completed, score, failure_reason),
            V2Disposition::Selected {
                status: SelectedStatus::SubjectFailed,
                score,
                failure_reason,
            } => (EvalResultStatus::SubjectFailed, score, failure_reason),
            V2Disposition::RetryableInfra { failure_reason } => {
                (EvalResultStatus::InfraFailed, None, Some(failure_reason))
            }
            V2Disposition::BlockedIndeterminate { failure_reason } => {
                (EvalResultStatus::Indeterminate, None, Some(failure_reason))
            }
        };

        V1CellAttempt {
            cell_id: self.0.cell_id.clone(),
            sequence: self.0.sequence,
            started_at: self.0.started_at,
            completed_at: self.0.completed_at,
            result: EvalResult {
                score,
                usage: effective_metering.usage().cloned(),
                cost_usd: effective_metering.cost_usd(),
                duration_ms: self.0.durations.subject_ms,
                status,
                failure_reason,
                artifacts,
            },
        }
    }

    fn effective_evidence<'a>(
        &'a self,
        recoveries: &'a [PostHocRecovery],
    ) -> (&'a CleanupState, &'a AttemptMetering) {
        let mut cleanup = &self.0.cleanup_state;
        let mut metering = &self.0.metering;
        for recovery in recoveries {
            if let Some(next_cleanup) = recovery.cleanup_state()
                && matches!(cleanup, CleanupState::Unconfirmed { .. })
                && matches!(next_cleanup, CleanupState::Confirmed {})
            {
                cleanup = next_cleanup;
            }
            if let Some(next_metering) = recovery.metering()
                && next_metering.rank() > metering.rank()
            {
                metering = next_metering;
            }
        }
        (cleanup, metering)
    }

    fn adjudicate(
        &self,
        effective_cleanup: &CleanupState,
        effective_metering: &AttemptMetering,
    ) -> V2Disposition {
        // Gate 1: Epistemic certainty — unresolved cleanup, pre-verification cancellation,
        // indeterminate execution, or unknown metering on an evaluated trial block retry.
        if let CleanupState::Unconfirmed { reason } = effective_cleanup {
            return V2Disposition::BlockedIndeterminate {
                failure_reason: reason.clone(),
            };
        }
        match &self.0.trial_outcome {
            TrialOutcome::CancelledBeforeVerification { reason } => {
                return V2Disposition::BlockedIndeterminate {
                    failure_reason: reason.clone().unwrap_or_else(|| {
                        "executor cancelled before verification completed".into()
                    }),
                };
            }
            TrialOutcome::Indeterminate { reason } => {
                return V2Disposition::BlockedIndeterminate {
                    failure_reason: reason.clone(),
                };
            }
            TrialOutcome::Evaluated { .. }
                if matches!(effective_metering, AttemptMetering::Unknown) =>
            {
                return V2Disposition::BlockedIndeterminate {
                    failure_reason: "metering state unknown".into(),
                };
            }
            TrialOutcome::InfraFailed { .. } | TrialOutcome::Evaluated { .. } => {}
        }

        // Gate 2: Infrastructure & evidence integrity — preserve root infra failures before
        // checking downstream artifacts/audit, and reject LowerBound metering on Completed runs.
        match &self.0.trial_outcome {
            TrialOutcome::InfraFailed { reason } => {
                return V2Disposition::RetryableInfra {
                    failure_reason: reason.clone(),
                };
            }
            TrialOutcome::Evaluated {
                verifier:
                    VerifierOutcome::InfraFailed { reason } | VerifierOutcome::MissingReward { reason },
                ..
            } => {
                return V2Disposition::RetryableInfra {
                    failure_reason: reason.clone(),
                };
            }
            TrialOutcome::Evaluated { .. } => {}
            TrialOutcome::Indeterminate { .. }
            | TrialOutcome::CancelledBeforeVerification { .. } => {
                unreachable!("handled in Gate 1");
            }
        }
        if let CriticalArtifactsState::Missing { paths } = &self.0.critical_artifacts_state {
            return V2Disposition::RetryableInfra {
                failure_reason: format!("critical artifacts missing: {}", paths.join(", ")),
            };
        }
        match &self.0.audit_state {
            EgressAuditState::Missing {} => {
                return V2Disposition::RetryableInfra {
                    failure_reason: "egress audit log missing".into(),
                };
            }
            EgressAuditState::Unreadable { reason } => {
                return V2Disposition::RetryableInfra {
                    failure_reason: reason.clone(),
                };
            }
            EgressAuditState::NotRequired {} | EgressAuditState::Recorded { .. } => {}
        }
        if matches!(
            self.0.trial_outcome,
            TrialOutcome::Evaluated {
                subject: SubjectOutcome::Completed {},
                ..
            }
        ) && matches!(effective_metering, AttemptMetering::LowerBound { .. })
        {
            return V2Disposition::RetryableInfra {
                failure_reason: "incomplete lower-bound metering on completed subject".into(),
            };
        }

        // Gate 3: Capability settlement — permanent selection, never resampled.
        let TrialOutcome::Evaluated {
            subject, verifier, ..
        } = &self.0.trial_outcome
        else {
            unreachable!("non-evaluated outcomes handled in Gates 1 and 2");
        };
        match (subject, verifier) {
            (SubjectOutcome::Completed {}, VerifierOutcome::Verified { score }) => {
                V2Disposition::Selected {
                    status: SelectedStatus::Completed,
                    score: Some(*score),
                    failure_reason: None,
                }
            }
            (SubjectOutcome::Completed {}, VerifierOutcome::SubjectFailed { score, reason }) => {
                V2Disposition::Selected {
                    status: SelectedStatus::SubjectFailed,
                    score: *score,
                    failure_reason: reason.clone(),
                }
            }
            (SubjectOutcome::Timeout { reason }, VerifierOutcome::Verified { score }) => {
                V2Disposition::Selected {
                    status: SelectedStatus::SubjectFailed,
                    score: Some(*score),
                    failure_reason: Some(
                        reason
                            .clone()
                            .unwrap_or_else(|| "subject exceeded the framework timeout".into()),
                    ),
                }
            }
            (
                SubjectOutcome::Timeout { reason },
                VerifierOutcome::SubjectFailed {
                    score,
                    reason: v_reason,
                },
            ) => V2Disposition::Selected {
                status: SelectedStatus::SubjectFailed,
                score: *score,
                failure_reason: Some(
                    reason
                        .clone()
                        .or_else(|| v_reason.clone())
                        .unwrap_or_else(|| "subject exceeded the framework timeout".into()),
                ),
            },
            (SubjectOutcome::Failed { reason }, VerifierOutcome::Verified { score }) => {
                V2Disposition::Selected {
                    status: SelectedStatus::SubjectFailed,
                    score: Some(*score),
                    failure_reason: reason.clone(),
                }
            }
            (
                SubjectOutcome::Failed { reason },
                VerifierOutcome::SubjectFailed {
                    score,
                    reason: v_reason,
                },
            ) => V2Disposition::Selected {
                status: SelectedStatus::SubjectFailed,
                score: *score,
                failure_reason: reason.clone().or_else(|| v_reason.clone()),
            },
            (_, VerifierOutcome::MissingReward { .. } | VerifierOutcome::InfraFailed { .. }) => {
                unreachable!("handled in Gate 2")
            }
        }
    }
}

impl Serialize for V2AttemptRecord {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let wire = V2AttemptWire {
            schema_version: SchemaVersion::V2,
            cell_id: self.0.cell_id.clone(),
            sequence: self.0.sequence,
            started_at: self.0.started_at,
            completed_at: self.0.completed_at,
            durations: self.0.durations,
            trial_outcome: self.0.trial_outcome.clone(),
            metering: self.0.metering.clone(),
            cleanup_state: self.0.cleanup_state.clone(),
            audit_state: self.0.audit_state.clone(),
            critical_artifacts_state: self.0.critical_artifacts_state.clone(),
            artifacts: self.0.artifacts.clone(),
        };
        wire.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for V2AttemptRecord {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = V2AttemptWire::deserialize(deserializer)?;
        if wire.schema_version != SchemaVersion::V2 {
            return Err(serde::de::Error::custom(
                "v2 attempt record requires schemaVersion maka.eval.v2",
            ));
        }
        Self::try_new(V2AttemptParts {
            cell_id: wire.cell_id,
            sequence: wire.sequence,
            started_at: wire.started_at,
            completed_at: wire.completed_at,
            durations: wire.durations,
            trial_outcome: wire.trial_outcome,
            metering: wire.metering,
            cleanup_state: wire.cleanup_state,
            audit_state: wire.audit_state,
            critical_artifacts_state: wire.critical_artifacts_state,
            artifacts: wire.artifacts,
        })
        .map_err(serde::de::Error::custom)
    }
}

/// Append-only post-hoc evidence recovery event applied on top of an immutable `V2AttemptRecord`.
#[derive(Debug, Clone, PartialEq)]
pub struct PostHocRecovery {
    recovered_at: u64,
    metering: Option<AttemptMetering>,
    cleanup_state: Option<CleanupState>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PostHocRecoveryWire {
    recovered_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    metering: Option<AttemptMetering>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cleanup_state: Option<CleanupState>,
}

impl PostHocRecovery {
    pub fn try_new(
        recovered_at: u64,
        metering: Option<AttemptMetering>,
        cleanup_state: Option<CleanupState>,
    ) -> Result<Self, ContractError> {
        if metering.is_none() && cleanup_state.is_none() {
            return Err(ContractError::new(
                "post-hoc recovery must provide metering or cleanupState",
            ));
        }
        if let Some(m) = &metering {
            m.validate()?;
        }
        if let Some(c) = &cleanup_state {
            validate_cleanup_state(c)?;
        }
        Ok(Self {
            recovered_at,
            metering,
            cleanup_state,
        })
    }

    pub fn recovered_at(&self) -> u64 {
        self.recovered_at
    }

    pub fn metering(&self) -> Option<&AttemptMetering> {
        self.metering.as_ref()
    }

    pub fn cleanup_state(&self) -> Option<&CleanupState> {
        self.cleanup_state.as_ref()
    }
}

impl Serialize for PostHocRecovery {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        PostHocRecoveryWire {
            recovered_at: self.recovered_at,
            metering: self.metering.clone(),
            cleanup_state: self.cleanup_state.clone(),
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for PostHocRecovery {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = PostHocRecoveryWire::deserialize(deserializer)?;
        Self::try_new(wire.recovered_at, wire.metering, wire.cleanup_state)
            .map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectedStatus {
    Completed,
    SubjectFailed,
}

#[derive(Debug, Clone, PartialEq)]
pub enum V2Disposition {
    Selected {
        status: SelectedStatus,
        score: Option<f64>,
        failure_reason: Option<String>,
    },
    RetryableInfra {
        failure_reason: String,
    },
    BlockedIndeterminate {
        failure_reason: String,
    },
}

/// Authoritative `v2` cell result selector: picks the earliest attempt by sequence
/// whose `V2Disposition` is `Selected`.
pub fn select_v2_cell_result(attempts: &[V2AttemptRecord]) -> Option<&V2AttemptRecord> {
    attempts
        .iter()
        .filter(|a| matches!(a.disposition(), V2Disposition::Selected { .. }))
        .min_by_key(|a| a.sequence())
}

/// Authoritative `v2` retry admission check: returns `false` if any attempt is already
/// `Selected` or `BlockedIndeterminate`, or if `attempts.len() > max_infra_retries as usize`.
pub fn can_admit_v2_attempt(attempts: &[V2AttemptRecord], max_infra_retries: u32) -> bool {
    !attempts.iter().any(|a| {
        matches!(
            a.disposition(),
            V2Disposition::Selected { .. } | V2Disposition::BlockedIndeterminate { .. }
        )
    }) && attempts.len() <= max_infra_retries as usize
}

fn validate_trial_outcome(outcome: &TrialOutcome) -> Result<(), ContractError> {
    match outcome {
        TrialOutcome::InfraFailed { reason } | TrialOutcome::Indeterminate { reason } => {
            if reason.is_empty() {
                return Err(ContractError::new("trialOutcome.reason must not be empty"));
            }
        }
        TrialOutcome::CancelledBeforeVerification { reason: Some(r) } => {
            if r.is_empty() {
                return Err(ContractError::new("trialOutcome.reason must not be empty"));
            }
        }
        TrialOutcome::CancelledBeforeVerification { reason: None } => {}
        TrialOutcome::Evaluated {
            subject, verifier, ..
        } => {
            match subject {
                SubjectOutcome::Completed {} => {}
                SubjectOutcome::Failed { reason: Some(r) }
                | SubjectOutcome::Timeout { reason: Some(r) } => {
                    if r.is_empty() {
                        return Err(ContractError::new("subject.reason must not be empty"));
                    }
                }
                SubjectOutcome::Failed { reason: None }
                | SubjectOutcome::Timeout { reason: None } => {}
            }
            match verifier {
                VerifierOutcome::Verified { score } => {
                    if !score.is_finite() {
                        return Err(ContractError::new("verifier score must be finite"));
                    }
                }
                VerifierOutcome::SubjectFailed { score, reason } => {
                    if score.is_some_and(|s| !s.is_finite()) {
                        return Err(ContractError::new("verifier score must be finite"));
                    }
                    if reason.as_deref().is_some_and(str::is_empty) {
                        return Err(ContractError::new("verifier.reason must not be empty"));
                    }
                }
                VerifierOutcome::MissingReward { reason }
                | VerifierOutcome::InfraFailed { reason } => {
                    if reason.is_empty() {
                        return Err(ContractError::new("verifier.reason must not be empty"));
                    }
                }
            }
        }
    }
    Ok(())
}

fn validate_cleanup_state(state: &CleanupState) -> Result<(), ContractError> {
    if let CleanupState::Unconfirmed { reason } = state
        && reason.is_empty()
    {
        return Err(ContractError::new("cleanupState.reason must not be empty"));
    }
    Ok(())
}

fn validate_audit_state(state: &EgressAuditState) -> Result<(), ContractError> {
    match state {
        EgressAuditState::NotRequired {} | EgressAuditState::Missing {} => {}
        EgressAuditState::Recorded { sha256, .. } => {
            if !is_lower_hex_sha256(sha256) {
                return Err(ContractError::new(
                    "auditState.sha256 must be 64 lowercase hex characters",
                ));
            }
        }
        EgressAuditState::Unreadable { reason } => {
            if reason.is_empty() {
                return Err(ContractError::new("auditState.reason must not be empty"));
            }
        }
    }
    Ok(())
}

fn validate_critical_artifacts_state(state: &CriticalArtifactsState) -> Result<(), ContractError> {
    if let CriticalArtifactsState::Missing { paths } = state
        && (paths.is_empty() || paths.iter().any(String::is_empty))
    {
        return Err(ContractError::new(
            "criticalArtifactsState.paths must be non-empty strings",
        ));
    }
    Ok(())
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

fn append_egress_audit_artifact(artifacts: &mut Vec<JsonObject>, audit_state: &EgressAuditState) {
    match audit_state {
        EgressAuditState::NotRequired {} => {}
        EgressAuditState::Recorded {
            bytes,
            sha256,
            truncated,
            policy_error_count,
            malformed_line_count,
        } => {
            if !artifacts
                .iter()
                .any(|a| a.get("kind").and_then(Value::as_str) == Some("egress-audit"))
            {
                let mut audit_obj = Map::new();
                audit_obj.insert("kind".into(), Value::String("egress-audit".into()));
                audit_obj.insert(
                    "path".into(),
                    Value::String(EGRESS_AUDIT_ARTIFACT_PATH.into()),
                );
                audit_obj.insert("bytes".into(), Value::from(*bytes));
                audit_obj.insert("sha256".into(), Value::String(format!("sha256:{sha256}")));
                audit_obj.insert("truncated".into(), Value::Bool(*truncated));
                audit_obj.insert("policyErrorCount".into(), Value::from(*policy_error_count));
                audit_obj.insert(
                    "malformedLineCount".into(),
                    Value::from(*malformed_line_count),
                );
                artifacts.push(audit_obj);
            }
        }
        EgressAuditState::Missing {} => {
            push_path_artifact(
                artifacts,
                "egress-audit-missing",
                EGRESS_AUDIT_ARTIFACT_PATH,
            );
        }
        EgressAuditState::Unreadable { .. } => {
            push_path_artifact(
                artifacts,
                "egress-audit-unreadable",
                EGRESS_AUDIT_ARTIFACT_PATH,
            );
        }
    }
}

fn push_path_artifact(artifacts: &mut Vec<JsonObject>, kind: &str, path: &str) {
    if !artifacts
        .iter()
        .any(|a| a.get("kind").and_then(Value::as_str) == Some(kind))
    {
        let mut obj = Map::new();
        obj.insert("kind".into(), Value::String(kind.into()));
        obj.insert("path".into(), Value::String(path.into()));
        artifacts.push(obj);
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

fn is_lower_hex_sha256(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub(crate) fn safe_u64(value: &Value, where_label: &str) -> Result<u64, ContractError> {
    if let Some(n) = value.as_u64() {
        return Ok(n);
    }
    match value.as_f64() {
        Some(f)
            if f.is_finite() && (0.0..=MAX_SAFE_INTEGER_F64).contains(&f) && f.fract() == 0.0 =>
        {
            Ok(f as u64)
        }
        _ => Err(ContractError::new(format!("{where_label} is invalid"))),
    }
}

fn positive_nonzero_u32(value: &Value, where_label: &str) -> Result<NonZeroU32, ContractError> {
    let n = safe_u64(value, where_label)?;
    let raw = u32::try_from(n)
        .ok()
        .and_then(NonZeroU32::new)
        .ok_or_else(|| ContractError::new(format!("{where_label} must be positive")))?;
    Ok(raw)
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
