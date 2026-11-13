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

//! Per-attempt trial environment abstraction, shared preparation cache boundary
//! locking, egress audit verification, and version-pinned Harbor/Pier bridge.

pub mod harbor_relay;

pub use harbor_relay::*;

use crate::contract::{
    ContractError, EgressAuditState, EvalResultStatus, ExperimentCell, JsonObject, VerifierOutcome,
    exact_object, nonempty_string, sha256_hex,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

pub const EGRESS_AUDIT_DESTINATION: &str = "egress-hits.jsonl";
pub const EGRESS_AUDIT_ARTIFACT_PATH: &str = "artifacts/egress-hits.jsonl";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubjectProcessTermination {
    Exited,
    FrameworkTimeout,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SubjectProcessDiagnosticCategory {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "unstructured-output")]
    UnstructuredOutput,
    #[serde(rename = "result-frame-missing")]
    ResultFrameMissing,
    #[serde(rename = "result-frame-invalid")]
    ResultFrameInvalid,
    #[serde(rename = "result-frame-ambiguous")]
    ResultFrameAmbiguous,
    #[serde(rename = "result-frame-oversize")]
    ResultFrameOversize,
    #[serde(rename = "execution-scope-unavailable")]
    ExecutionScopeUnavailable,
}

impl SubjectProcessDiagnosticCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::UnstructuredOutput => "unstructured-output",
            Self::ResultFrameMissing => "result-frame-missing",
            Self::ResultFrameInvalid => "result-frame-invalid",
            Self::ResultFrameAmbiguous => "result-frame-ambiguous",
            Self::ResultFrameOversize => "result-frame-oversize",
            Self::ExecutionScopeUnavailable => "execution-scope-unavailable",
        }
    }

    pub fn is_result_frame_error(self) -> bool {
        matches!(
            self,
            Self::ResultFrameMissing
                | Self::ResultFrameInvalid
                | Self::ResultFrameAmbiguous
                | Self::ResultFrameOversize
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubjectProcessDiagnostic {
    pub category: SubjectProcessDiagnosticCategory,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubjectProcessRequest {
    pub command: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub environment: HashMap<String, String>,
    #[serde(default)]
    pub credential_environment: HashMap<String, String>,
    #[serde(default = "default_capture_stdout")]
    pub capture_stdout: bool,
}

fn default_capture_stdout() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubjectProcessOutput {
    pub termination: SubjectProcessTermination,
    pub exit_code: i32,
    pub stdout: String,
    #[serde(default)]
    pub stderr: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<SubjectProcessDiagnostic>,
}

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait CommandRunner: Send + Sync {
    fn execute<'a>(
        &'a self,
        request: SubjectProcessRequest,
    ) -> BoxFuture<'a, Result<SubjectProcessOutput, String>>;
}

#[derive(Clone)]
pub struct SubjectExecutionContext {
    pub cwd: String,
    pub task_input: String,
    pub metadata: JsonObject,
    pub cancel: CancellationToken,
    pub runner: Arc<dyn CommandRunner>,
}

impl SubjectExecutionContext {
    pub async fn execute(
        &self,
        request: SubjectProcessRequest,
    ) -> Result<SubjectProcessOutput, String> {
        self.runner.execute(request).await
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutorVerification {
    pub status: EvalResultStatus,
    pub score: Option<f64>,
    pub failure_reason: Option<String>,
    pub artifacts: Vec<JsonObject>,
    /// Explicitly flags when the verifier reward file or reward key was missing,
    /// ensuring missing rewards never default to `0.0`.
    #[serde(default)]
    pub missing_reward: bool,
}

impl ExecutorVerification {
    pub fn to_verifier_outcome(&self) -> VerifierOutcome {
        if self.missing_reward {
            return VerifierOutcome::MissingReward {
                reason: self
                    .failure_reason
                    .clone()
                    .unwrap_or_else(|| "verifier reward missing".into()),
            };
        }
        match (self.status, self.score) {
            (EvalResultStatus::InfraFailed, _) => VerifierOutcome::VerifierInfraFailed {
                reason: self
                    .failure_reason
                    .clone()
                    .unwrap_or_else(|| "verification failed".into()),
            },
            (EvalResultStatus::Completed, Some(score)) => VerifierOutcome::Verified { score },
            (EvalResultStatus::Completed, None) => VerifierOutcome::MissingReward {
                reason: self
                    .failure_reason
                    .clone()
                    .unwrap_or_else(|| "verifier completed without a numeric reward".into()),
            },
            (EvalResultStatus::SubjectFailed, score) => VerifierOutcome::SubjectFailed {
                score,
                reason: self
                    .failure_reason
                    .clone()
                    .unwrap_or_else(|| "verifier marked subject failed".into()),
            },
            (EvalResultStatus::Indeterminate, _) => VerifierOutcome::VerifierInfraFailed {
                reason: self
                    .failure_reason
                    .clone()
                    .unwrap_or_else(|| "verification indeterminate".into()),
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExecutorPreparationCode {
    Cancelled,
    PreparationFailed,
    SpawnFailed,
    ExitBeforeReady,
    InvalidReady,
    FrameworkVersionMismatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IndeterminateCause {
    HostCancelled,
    CleanupUnconfirmed,
}

/// Active per-attempt trial environment provided to the runner during a single attempt.
pub trait ActiveTrialAttempt: Send + Sync {
    fn context(&self) -> SubjectExecutionContext;
    fn verify(&self) -> BoxFuture<'_, Result<ExecutorVerification, String>>;
    fn read_audit(&self) -> BoxFuture<'_, (EgressAuditState, EgressAuditEvidence)> {
        Box::pin(async {
            (
                EgressAuditState::NotRequired,
                EgressAuditEvidence {
                    failure_reason: None,
                    artifacts: Vec::new(),
                },
            )
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum TrialEnvironmentOutcome<T> {
    Settled(T),
    Indeterminate {
        cause: IndeterminateCause,
        partial: Option<T>,
    },
    NotStarted {
        code: ExecutorPreparationCode,
        artifacts: Vec<JsonObject>,
    },
}

pub type TrialAttemptOperation<'a> = Box<
    dyn for<'b> FnOnce(
            &'b dyn ActiveTrialAttempt,
        ) -> BoxFuture<'b, crate::contract::V2AttemptRecord>
        + Send
        + 'a,
>;

pub trait TrialEnvironment: Send + Sync {
    fn kind(&self) -> &str;

    fn validate(&self, _cell: &ExperimentCell) -> Result<(), ContractError> {
        Ok(())
    }

    fn preflight(
        &self,
        _subject_credential_names: &[String],
        _cancel: CancellationToken,
    ) -> BoxFuture<'_, Result<(), ContractError>> {
        Box::pin(async { Ok(()) })
    }

    fn run_attempt<'a>(
        &'a self,
        cell: &'a ExperimentCell,
        sequence: u32,
        subject_credential_names: &'a [String],
        cancel: CancellationToken,
        operation: TrialAttemptOperation<'a>,
    ) -> BoxFuture<'a, Result<TrialEnvironmentOutcome<crate::contract::V2AttemptRecord>, String>>;
}

/// Synchronizes task preparation across the entire cache-check + cache-build
/// boundary so concurrent arms in a task group never race on shared task assets.
#[derive(Debug, Default, Clone)]
pub struct PreparationCacheLocks {
    locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

impl PreparationCacheLocks {
    pub fn new() -> Self {
        Self::default()
    }

    /// Holds an exclusive per-key async lock across the entire `prepare_fn` future.
    pub async fn with_task_lock<F, Fut, T>(&self, task_key: &str, prepare_fn: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let key_mutex = {
            let mut map = self.locks.lock().await;
            map.entry(task_key.to_owned())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _guard = key_mutex.lock().await;
        prepare_fn().await
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EgressAuditEvidence {
    pub failure_reason: Option<String>,
    pub artifacts: Vec<JsonObject>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EgressAuditSummary {
    pub truncated: bool,
    pub policy_error_count: u64,
    pub malformed_line_count: u64,
}

pub fn describe_egress_audit(
    bytes: Option<&[u8]>,
    required: bool,
) -> (EgressAuditState, EgressAuditEvidence) {
    if !required {
        return (
            EgressAuditState::NotRequired,
            EgressAuditEvidence {
                failure_reason: None,
                artifacts: Vec::new(),
            },
        );
    }
    let Some(bytes) = bytes else {
        let mut missing_art = Map::new();
        missing_art.insert("kind".into(), Value::String("egress-audit-missing".into()));
        missing_art.insert(
            "path".into(),
            Value::String(EGRESS_AUDIT_ARTIFACT_PATH.into()),
        );
        return (
            EgressAuditState::Missing,
            EgressAuditEvidence {
                failure_reason: Some("egress audit log missing".into()),
                artifacts: vec![missing_art],
            },
        );
    };

    let summary = summarize_egress_audit_bytes(bytes);
    let mut artifact = Map::new();
    artifact.insert("kind".into(), Value::String("egress-audit".into()));
    artifact.insert(
        "path".into(),
        Value::String(EGRESS_AUDIT_ARTIFACT_PATH.into()),
    );
    artifact.insert("bytes".into(), Value::from(bytes.len() as u64));
    artifact.insert(
        "sha256".into(),
        Value::String(format!("sha256:{}", sha256_hex(bytes))),
    );
    artifact.insert("truncated".into(), Value::Bool(summary.truncated));
    artifact.insert(
        "policyErrorCount".into(),
        Value::from(summary.policy_error_count),
    );
    artifact.insert(
        "malformedLineCount".into(),
        Value::from(summary.malformed_line_count),
    );

    let state = if summary.truncated {
        EgressAuditState::Truncated
    } else if summary.policy_error_count > 0 {
        EgressAuditState::PolicyError {
            count: summary.policy_error_count,
        }
    } else {
        EgressAuditState::Clean
    };

    (
        state,
        EgressAuditEvidence {
            failure_reason: None,
            artifacts: vec![artifact],
        },
    )
}

pub fn read_egress_audit_evidence(
    trial_path: &Path,
    required: bool,
) -> (EgressAuditState, EgressAuditEvidence) {
    if !required {
        return describe_egress_audit(None, false);
    }
    let audit_path = trial_path.join(EGRESS_AUDIT_ARTIFACT_PATH);
    match std::fs::read(&audit_path) {
        Ok(bytes) => describe_egress_audit(Some(&bytes), true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => describe_egress_audit(None, true),
        Err(err) => {
            let reason = format!(
                "failed to read egress audit log {} ({err})",
                audit_path.display()
            );
            let mut art = Map::new();
            art.insert(
                "kind".into(),
                Value::String("egress-audit-unreadable".into()),
            );
            art.insert(
                "path".into(),
                Value::String(EGRESS_AUDIT_ARTIFACT_PATH.into()),
            );
            (
                EgressAuditState::Unreadable {
                    reason: reason.clone(),
                },
                EgressAuditEvidence {
                    failure_reason: Some(reason),
                    artifacts: vec![art],
                },
            )
        }
    }
}

fn summarize_egress_audit_bytes(bytes: &[u8]) -> EgressAuditSummary {
    let mut summary = EgressAuditSummary::default();
    for line in bytes.split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(text) = std::str::from_utf8(line) else {
            summary.malformed_line_count += 1;
            continue;
        };
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(trimmed) else {
            summary.malformed_line_count += 1;
            continue;
        };
        match obj.get("ruleId").and_then(Value::as_str) {
            Some("audit_truncated") => summary.truncated = true,
            Some("policy_error") => summary.policy_error_count += 1,
            _ => {}
        }
    }
    summary
}

/// Computes the deterministic 1:1 Harbor trial identifier for an Eval cell attempt.
pub fn harbor_trial_name_for_attempt(cell_id: &str, sequence: u32) -> String {
    let digest = &sha256_hex(cell_id.as_bytes())[..16];
    let safe_prefix: String = cell_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .take(32)
        .collect();
    format!("maka-eval-{safe_prefix}-{digest}-seq-{sequence:06}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarborExecutorConfig {
    pub framework: String,
    pub framework_version: String,
    pub python_path_env: String,
    pub trials_root_env: String,
    pub egress_proxy_required: bool,
}

impl HarborExecutorConfig {
    pub fn decode(framework: &str, config: &JsonObject) -> Result<Self, ContractError> {
        let val = Value::Object(config.clone());
        let obj = exact_object(
            &val,
            "executor.config",
            &[
                "frameworkVersion",
                "pythonPathEnv",
                "trialsRootEnv",
                "environment",
            ],
            &["preparationEnvironment", "egressProxy", "mounts"],
        )?;
        let framework_version =
            nonempty_string(obj.get("frameworkVersion").unwrap(), "frameworkVersion")?;
        let python_path_env = nonempty_string(obj.get("pythonPathEnv").unwrap(), "pythonPathEnv")?;
        let trials_root_env = nonempty_string(obj.get("trialsRootEnv").unwrap(), "trialsRootEnv")?;
        let egress_proxy_required = obj.contains_key("egressProxy");
        Ok(Self {
            framework: framework.to_owned(),
            framework_version,
            python_path_env,
            trials_root_env,
            egress_proxy_required,
        })
    }

    pub fn validate_task(&self, cell: &ExperimentCell) -> Result<PathBuf, ContractError> {
        let task_cfg = Value::Object(cell.task.config.clone());
        let obj = exact_object(&task_cfg, "task.config", &[&self.framework], &[])?;
        let fw_obj = exact_object(
            obj.get(&self.framework).unwrap(),
            &format!("task.config.{}", self.framework),
            &["path"],
            &[],
        )?;
        let path_str = nonempty_string(fw_obj.get("path").unwrap(), "path")?;
        Ok(PathBuf::from(path_str))
    }
}
