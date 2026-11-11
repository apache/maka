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

//! External CLI subject adapter (`exit-code` and `protocol-v1` bounded result frames,
//! placeholder expansion, and checkpoint metering recovery).

use crate::contract::{
    ContractError, ExecutionOutcome, ExperimentCell, JsonObject, SubjectKind, exact_object,
    nonempty_string, nullable_nonnegative_f64, sha256_hex,
};
use crate::environment::{
    BoxFuture, SubjectExecutionContext, SubjectProcessDiagnostic, SubjectProcessDiagnosticCategory,
    SubjectProcessRequest, SubjectProcessTermination,
};
use crate::measurement::{
    MeteringState, NormalizedUsage, RecoveredExternalMetering, recover_external_metering_checkpoint,
};
use crate::subject::{SubjectAdapter, SubjectExecutionResult};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

pub const RESULT_FRAME_PREFIX: &str = "MAKA-EVAL-RESULT-V1";
pub const RESULT_PAYLOAD_LIMIT_BYTES: usize = 2 * 1024;
pub const RESULT_CARRIER_LIMIT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExternalResultMode {
    #[serde(rename = "protocol-v1")]
    ProtocolV1,
    #[serde(rename = "exit-code")]
    ExitCode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalSubjectConfig {
    pub command: String,
    pub args: Vec<String>,
    pub environment: HashMap<String, String>,
    pub credential_environment: HashMap<String, String>,
    pub result_mode: ExternalResultMode,
}

impl ExternalSubjectConfig {
    pub fn decode(
        config: &JsonObject,
        declared_credentials: &[String],
    ) -> Result<Self, ContractError> {
        let val = Value::Object(config.clone());
        let obj = exact_object(
            &val,
            "external subject config",
            &["command", "args"],
            &["environment", "credentialEnvironment", "result"],
        )?;
        let command = nonempty_string(obj.get("command").unwrap(), "external subject command")?;
        let args_arr = obj
            .get("args")
            .and_then(Value::as_array)
            .ok_or_else(|| ContractError::Invalid("external subject args are invalid".into()))?;
        let mut args = Vec::with_capacity(args_arr.len());
        for item in args_arr {
            let Some(s) = item.as_str() else {
                return Err(ContractError::Invalid(
                    "external subject args are invalid".into(),
                ));
            };
            args.push(s.to_owned());
        }

        let environment = match obj.get("environment") {
            None => HashMap::new(),
            Some(env_val) => decode_env_map(env_val, "environment")?,
        };

        let credential_environment = match obj.get("credentialEnvironment") {
            None => declared_credentials
                .iter()
                .map(|c| (c.clone(), c.clone()))
                .collect(),
            Some(cred_val) => decode_env_map(cred_val, "credentialEnvironment")?,
        };
        for (target, source) in &credential_environment {
            if !declared_credentials.iter().any(|c| c == source) {
                return Err(ContractError::Invalid(format!(
                    "credentialEnvironment.{target} must reference a declared credential"
                )));
            }
            if environment.contains_key(target) {
                return Err(ContractError::Invalid(format!(
                    "environment and credentialEnvironment overlap at {target}"
                )));
            }
        }

        let result_mode = match obj.get("result").and_then(Value::as_str) {
            None | Some("protocol-v1") => ExternalResultMode::ProtocolV1,
            Some("exit-code") => ExternalResultMode::ExitCode,
            Some(_) => {
                return Err(ContractError::Invalid(
                    "external subject result is invalid".into(),
                ));
            }
        };

        Ok(Self {
            command,
            args,
            environment,
            credential_environment,
            result_mode,
        })
    }
}

/// Encodes a bounded `MAKA-EVAL-RESULT-V1` frame matching `relay-result-frame.ts`.
pub fn encode_relay_result_frame(token: &str, value: &Value) -> Result<String, ContractError> {
    if token.len() != 32
        || !token
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(ContractError::Invalid(
            "relay result token is invalid".into(),
        ));
    }
    let payload = serde_json::to_vec(value).map_err(|e| ContractError::Invalid(e.to_string()))?;
    if payload.len() > RESULT_PAYLOAD_LIMIT_BYTES {
        return Err(ContractError::Invalid(
            "relay result exceeds the payload limit".into(),
        ));
    }
    let digest = sha256_hex(&payload);
    let encoded = URL_SAFE_NO_PAD.encode(&payload);
    Ok(format!(
        "{RESULT_FRAME_PREFIX} {token} {} {digest} {encoded}\n",
        payload.len()
    ))
}

/// Parses and validates a `MAKA-EVAL-RESULT-V1` frame from raw process stdout.
pub fn parse_relay_result_frame(
    carrier: &str,
    expected_token: &str,
) -> Result<String, SubjectProcessDiagnostic> {
    if carrier.len() > RESULT_CARRIER_LIMIT_BYTES {
        return Err(SubjectProcessDiagnostic {
            category: SubjectProcessDiagnosticCategory::ResultFrameOversize,
            bytes: Some(carrier.len() as u64),
            sha256: Some(sha256_hex(carrier.as_bytes())),
        });
    }
    let matching_lines: Vec<&str> = carrier
        .lines()
        .filter(|line| {
            line.starts_with(RESULT_FRAME_PREFIX)
                && line
                    .split_whitespace()
                    .nth(1)
                    .is_some_and(|tok| tok == expected_token)
        })
        .collect();

    if matching_lines.is_empty() {
        return Err(SubjectProcessDiagnostic {
            category: SubjectProcessDiagnosticCategory::ResultFrameMissing,
            bytes: Some(carrier.len() as u64),
            sha256: Some(sha256_hex(carrier.as_bytes())),
        });
    }
    if matching_lines.len() > 1 {
        return Err(SubjectProcessDiagnostic {
            category: SubjectProcessDiagnosticCategory::ResultFrameAmbiguous,
            bytes: Some(carrier.len() as u64),
            sha256: Some(sha256_hex(carrier.as_bytes())),
        });
    }

    let parts: Vec<&str> = matching_lines[0].split_whitespace().collect();
    if parts.len() != 5 {
        return Err(SubjectProcessDiagnostic {
            category: SubjectProcessDiagnosticCategory::ResultFrameInvalid,
            bytes: Some(carrier.len() as u64),
            sha256: Some(sha256_hex(carrier.as_bytes())),
        });
    }
    let Ok(expected_len) = parts[2].parse::<usize>() else {
        return Err(SubjectProcessDiagnostic {
            category: SubjectProcessDiagnosticCategory::ResultFrameInvalid,
            bytes: None,
            sha256: None,
        });
    };
    if expected_len > RESULT_PAYLOAD_LIMIT_BYTES {
        return Err(SubjectProcessDiagnostic {
            category: SubjectProcessDiagnosticCategory::ResultFrameOversize,
            bytes: Some(expected_len as u64),
            sha256: None,
        });
    }
    let expected_digest = parts[3];
    let Ok(decoded_bytes) = URL_SAFE_NO_PAD.decode(parts[4]) else {
        return Err(SubjectProcessDiagnostic {
            category: SubjectProcessDiagnosticCategory::ResultFrameInvalid,
            bytes: None,
            sha256: None,
        });
    };
    if decoded_bytes.len() != expected_len || sha256_hex(&decoded_bytes) != expected_digest {
        return Err(SubjectProcessDiagnostic {
            category: SubjectProcessDiagnosticCategory::ResultFrameInvalid,
            bytes: Some(decoded_bytes.len() as u64),
            sha256: Some(sha256_hex(&decoded_bytes)),
        });
    }
    String::from_utf8(decoded_bytes).map_err(|_| SubjectProcessDiagnostic {
        category: SubjectProcessDiagnosticCategory::ResultFrameInvalid,
        bytes: None,
        sha256: None,
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct DecodedExternalResult {
    pub output: Option<String>,
    pub usage: Option<NormalizedUsage>,
    pub cost_usd: Option<f64>,
    pub status: Option<String>,
    pub failure_reason: Option<String>,
    pub artifacts: Vec<JsonObject>,
}

pub fn decode_external_result_json(stdout: &str) -> Result<DecodedExternalResult, ContractError> {
    let parsed: Value = serde_json::from_str(stdout)
        .map_err(|_| ContractError::Invalid("external result must be valid JSON".into()))?;
    let obj = exact_object(
        &parsed,
        "external result",
        &["schemaVersion", "usage", "costUsd", "artifacts"],
        &["output", "status", "failureReason"],
    )?;
    let schema_version = obj.get("schemaVersion").and_then(Value::as_str);
    if !matches!(
        schema_version,
        Some("maka.external_subject_result.v1" | "maka.external_subject_result.v2")
    ) {
        return Err(ContractError::Invalid(
            "external result schema is invalid".into(),
        ));
    }
    if schema_version == Some("maka.external_subject_result.v2")
        && (!obj.contains_key("status") || !obj.contains_key("failureReason"))
    {
        return Err(ContractError::Invalid(
            "external result v2 fields are invalid".into(),
        ));
    }
    let output = match obj.get("output") {
        None => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => {
            return Err(ContractError::Invalid(
                "external result output is invalid".into(),
            ));
        }
    };
    let status = match obj.get("status") {
        None => None,
        Some(Value::String(s))
            if matches!(
                s.as_str(),
                "completed" | "failed" | "infra_failed" | "indeterminate"
            ) =>
        {
            Some(s.clone())
        }
        Some(_) => {
            return Err(ContractError::Invalid(
                "external result status is invalid".into(),
            ));
        }
    };
    let failure_reason = match obj.get("failureReason") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => {
            return Err(ContractError::Invalid(
                "external result failureReason is invalid".into(),
            ));
        }
    };
    let usage = match obj.get("usage").unwrap() {
        Value::Null => None,
        u => Some(NormalizedUsage::decode(u, "external usage")?),
    };
    let cost_usd = nullable_nonnegative_f64(obj.get("costUsd").unwrap(), "external result cost")?;
    let artifacts_arr = obj
        .get("artifacts")
        .and_then(Value::as_array)
        .ok_or_else(|| ContractError::Invalid("external result artifacts are invalid".into()))?;
    let mut artifacts = Vec::with_capacity(artifacts_arr.len());
    for item in artifacts_arr {
        let Some(map) = item.as_object() else {
            return Err(ContractError::Invalid(
                "external result artifacts are invalid".into(),
            ));
        };
        artifacts.push(map.clone());
    }

    Ok(DecodedExternalResult {
        output,
        usage,
        cost_usd,
        status,
        failure_reason,
        artifacts,
    })
}

#[derive(Debug, Default, Clone)]
pub struct ExternalCliSubject;

impl ExternalCliSubject {
    pub fn new() -> Self {
        Self
    }
}

impl SubjectAdapter for ExternalCliSubject {
    fn kind(&self) -> SubjectKind {
        SubjectKind::External
    }

    fn validate(&self, cell: &ExperimentCell) -> Result<(), ContractError> {
        let _ = ExternalSubjectConfig::decode(&cell.subject.config, &cell.subject.credentials)?;
        Ok(())
    }

    fn execute<'a>(
        &'a self,
        cell: &'a ExperimentCell,
        context: SubjectExecutionContext,
    ) -> BoxFuture<'a, SubjectExecutionResult> {
        Box::pin(async move {
            let started = Instant::now();
            let Ok(config) =
                ExternalSubjectConfig::decode(&cell.subject.config, &cell.subject.credentials)
            else {
                return SubjectExecutionResult {
                    output: None,
                    usage: None,
                    metering_state: MeteringState::Unknown,
                    cost_usd: None,
                    duration_ms: 0,
                    outcome: ExecutionOutcome::InfraFailed,
                    failure_reason: Some("external subject config invalid".into()),
                    artifacts: Vec::new(),
                    operation_id: None,
                    invocation_id: None,
                };
            };

            let profile = Some(cell.subject.id.as_str());
            let args: Vec<String> = config
                .args
                .iter()
                .map(|arg| {
                    arg.replace("{{task.input}}", &context.task_input)
                        .replace("{{task.id}}", &cell.task.id)
                        .replace("{{task.cwd}}", &context.cwd)
                })
                .collect();

            let execution = match context
                .execute(SubjectProcessRequest {
                    command: config.command,
                    args,
                    environment: config.environment,
                    credential_environment: config.credential_environment,
                    capture_stdout: config.result_mode != ExternalResultMode::ExitCode,
                })
                .await
            {
                Ok(exec) => exec,
                Err(_) => {
                    let recovered = recover_from_metadata(&context.metadata, profile);
                    let cancelled = context.cancel.is_cancelled();
                    return SubjectExecutionResult {
                        output: None,
                        usage: recovered.as_ref().and_then(|r| r.usage.clone()),
                        metering_state: recovered
                            .as_ref()
                            .map_or(MeteringState::Unknown, |r| r.metering_state),
                        cost_usd: recovered.as_ref().and_then(|r| r.cost_usd),
                        duration_ms: started.elapsed().as_millis() as u64,
                        outcome: if cancelled {
                            ExecutionOutcome::Indeterminate
                        } else {
                            ExecutionOutcome::InfraFailed
                        },
                        failure_reason: Some(if cancelled {
                            "external subject cancelled".into()
                        } else {
                            "external subject execution failed".into()
                        }),
                        artifacts: recovered.into_iter().map(|r| r.artifact).collect(),
                        operation_id: None,
                        invocation_id: None,
                    };
                }
            };

            let duration_ms = started.elapsed().as_millis() as u64;
            let decoded = if execution.stdout.is_empty() {
                None
            } else {
                decode_external_result_json(&execution.stdout).ok()
            };
            let recovered = recover_from_metadata(&context.metadata, profile);

            let mut process_art = Map::new();
            process_art.insert("kind".into(), Value::String("external_process".into()));
            process_art.insert("exitCode".into(), Value::from(execution.exit_code));

            if execution.termination == SubjectProcessTermination::FrameworkTimeout {
                let usage = decoded
                    .as_ref()
                    .and_then(|d| d.usage.clone())
                    .or_else(|| recovered.as_ref().and_then(|r| r.usage.clone()));
                let cost_usd = decoded
                    .as_ref()
                    .and_then(|d| d.cost_usd)
                    .or_else(|| recovered.as_ref().and_then(|r| r.cost_usd));
                let metering_state = match (&usage, cost_usd) {
                    (Some(_), Some(_)) => MeteringState::Complete,
                    (Some(_), None) => MeteringState::LowerBound,
                    (None, _) => MeteringState::Unknown,
                };
                let mut artifacts = match &decoded {
                    Some(d) => d.artifacts.clone(),
                    None => recovered.iter().map(|r| r.artifact.clone()).collect(),
                };
                if decoded.as_ref().is_some_and(|d| d.usage.is_none())
                    && let Some(rec) = &recovered
                {
                    artifacts.push(rec.artifact.clone());
                }
                artifacts.push(process_art);
                return SubjectExecutionResult {
                    output: None,
                    usage,
                    metering_state,
                    cost_usd,
                    duration_ms,
                    outcome: ExecutionOutcome::Timeout,
                    failure_reason: Some("external subject exceeded the framework timeout".into()),
                    artifacts,
                    operation_id: None,
                    invocation_id: None,
                };
            }

            if execution.diagnostic.as_ref().map(|d| d.category)
                == Some(SubjectProcessDiagnosticCategory::ExecutionScopeUnavailable)
            {
                let mut artifacts: Vec<JsonObject> =
                    recovered.iter().map(|r| r.artifact.clone()).collect();
                artifacts.push(process_art);
                return SubjectExecutionResult {
                    output: None,
                    usage: recovered.as_ref().and_then(|r| r.usage.clone()),
                    metering_state: recovered
                        .as_ref()
                        .map_or(MeteringState::Unknown, |r| r.metering_state),
                    cost_usd: recovered.as_ref().and_then(|r| r.cost_usd),
                    duration_ms,
                    outcome: if context.cancel.is_cancelled() {
                        ExecutionOutcome::Indeterminate
                    } else {
                        ExecutionOutcome::InfraFailed
                    },
                    failure_reason: Some("external subject execution scope was unavailable".into()),
                    artifacts,
                    operation_id: None,
                    invocation_id: None,
                };
            }

            if config.result_mode == ExternalResultMode::ExitCode {
                let outcome = if execution.exit_code == 0 {
                    ExecutionOutcome::Completed
                } else if context.cancel.is_cancelled() {
                    ExecutionOutcome::Indeterminate
                } else {
                    ExecutionOutcome::SubjectFailed
                };
                return SubjectExecutionResult {
                    output: None,
                    usage: None,
                    metering_state: MeteringState::Unknown,
                    cost_usd: None,
                    duration_ms,
                    outcome,
                    failure_reason: (execution.exit_code != 0)
                        .then(|| format!("external subject exited {}", execution.exit_code)),
                    artifacts: vec![process_art],
                    operation_id: None,
                    invocation_id: None,
                };
            }

            if execution
                .diagnostic
                .as_ref()
                .is_some_and(|d| d.category.is_result_frame_error())
            {
                let outcome = if context.cancel.is_cancelled() {
                    ExecutionOutcome::Indeterminate
                } else if recovered.as_ref().is_some_and(|r| r.admitted_requests > 0) {
                    ExecutionOutcome::SubjectFailed
                } else {
                    ExecutionOutcome::InfraFailed
                };
                let mut artifacts: Vec<JsonObject> =
                    recovered.iter().map(|r| r.artifact.clone()).collect();
                artifacts.push(process_art);
                return SubjectExecutionResult {
                    output: None,
                    usage: recovered.as_ref().and_then(|r| r.usage.clone()),
                    metering_state: recovered
                        .as_ref()
                        .map_or(MeteringState::Unknown, |r| r.metering_state),
                    cost_usd: recovered.as_ref().and_then(|r| r.cost_usd),
                    duration_ms,
                    outcome,
                    failure_reason: Some("external subject result transport failed".into()),
                    artifacts,
                    operation_id: None,
                    invocation_id: None,
                };
            }

            let Some(decoded) = decoded else {
                let outcome = if context.cancel.is_cancelled() {
                    ExecutionOutcome::Indeterminate
                } else if recovered.as_ref().is_some_and(|r| r.admitted_requests > 0) {
                    ExecutionOutcome::SubjectFailed
                } else {
                    ExecutionOutcome::InfraFailed
                };
                let mut artifacts: Vec<JsonObject> =
                    recovered.iter().map(|r| r.artifact.clone()).collect();
                artifacts.push(process_art);
                return SubjectExecutionResult {
                    output: None,
                    usage: recovered.as_ref().and_then(|r| r.usage.clone()),
                    metering_state: recovered
                        .as_ref()
                        .map_or(MeteringState::Unknown, |r| r.metering_state),
                    cost_usd: recovered.as_ref().and_then(|r| r.cost_usd),
                    duration_ms,
                    outcome,
                    failure_reason: Some("external subject returned no result".into()),
                    artifacts,
                    operation_id: None,
                    invocation_id: None,
                };
            };

            let outcome = match decoded.status.as_deref() {
                Some("completed") => ExecutionOutcome::Completed,
                Some("failed") => ExecutionOutcome::SubjectFailed,
                Some("infra_failed") => ExecutionOutcome::InfraFailed,
                Some("indeterminate") => ExecutionOutcome::Indeterminate,
                None if execution.exit_code == 0 => ExecutionOutcome::Completed,
                None => ExecutionOutcome::SubjectFailed,
                Some(_) => ExecutionOutcome::InfraFailed,
            };
            let metering_state = match (&decoded.usage, decoded.cost_usd) {
                (Some(_), Some(_)) => MeteringState::Complete,
                (Some(_), None) => MeteringState::LowerBound,
                (None, _) => MeteringState::Unknown,
            };
            let failure_reason = decoded.failure_reason.or_else(|| {
                (execution.exit_code != 0 && outcome != ExecutionOutcome::Completed)
                    .then(|| format!("external subject exited {}", execution.exit_code))
            });

            SubjectExecutionResult {
                output: decoded.output,
                usage: decoded.usage,
                metering_state,
                cost_usd: decoded.cost_usd,
                duration_ms,
                outcome,
                failure_reason,
                artifacts: decoded.artifacts,
                operation_id: None,
                invocation_id: None,
            }
        })
    }
}

fn recover_from_metadata(
    metadata: &JsonObject,
    profile: Option<&str>,
) -> Option<RecoveredExternalMetering> {
    let profile = profile?;
    let trial_path = metadata.get("trialPath")?.as_str()?;
    let secret = metadata.get("meteringSecret")?.as_str()?;
    recover_external_metering_checkpoint(Path::new(trial_path), profile, secret)
}

fn decode_env_map(
    value: &Value,
    where_label: &str,
) -> Result<HashMap<String, String>, ContractError> {
    let obj = value
        .as_object()
        .ok_or_else(|| ContractError::Invalid(format!("{where_label} must be an object")))?;
    let mut map = HashMap::with_capacity(obj.len());
    for (name, item) in obj {
        let mut chars = name.chars();
        let valid_name = chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
        let Some(val_str) = item.as_str() else {
            return Err(ContractError::Invalid(format!(
                "{where_label}.{name} is invalid"
            )));
        };
        if !valid_name {
            return Err(ContractError::Invalid(format!(
                "{where_label}.{name} is invalid"
            )));
        }
        map.insert(name.clone(), val_str.to_owned());
    }
    Ok(map)
}
