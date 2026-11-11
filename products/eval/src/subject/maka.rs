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

//! Rust Maka Host subject adapter (`maka host init --settings-stdin --root <ROOT_DIR>`,
//! durable operation/invocation receipt tracking, disconnect re-observation,
//! paginated transcript export, and usage settlement reconciliation).

use crate::contract::{
    ContractError, ExecutionOutcome, ExperimentCell, JsonObject, SubjectKind, exact_object,
    nonempty_string, positive_u32,
};
use crate::environment::{
    BoxFuture, SubjectExecutionContext, SubjectProcessOutput, SubjectProcessRequest,
    SubjectProcessTermination,
};
use crate::measurement::{
    MeteringState, NormalizedUsage, ProviderMeteringCounts, deepseek_cost_usd,
    reconcile_host_and_proxy_usage,
};
use crate::store::{
    MAKA_RUNTIME_ARTIFACT_PATH, MAKA_SUBJECT_STDERR_PATH, MAKA_SUBJECT_STDOUT_PATH,
};
use crate::subject::{SubjectAdapter, SubjectExecutionResult};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::process::Stdio;
use std::time::Instant;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use uuid::Uuid;

pub const DEFAULT_EVAL_GATEWAY_SLUG: &str = "eval-gateway";
pub const DEFAULT_EVAL_GATEWAY_NAME: &str = "Eval Gateway";
pub const DEFAULT_EVAL_GATEWAY_PROVIDER: &str = "openai-compatible";
pub const DEFAULT_EVAL_CONTEXT_WINDOW: u64 = 200_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MakaGatewayConfiguration {
    pub base_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MakaModelOverride {
    pub context_window: u64,
    pub thinking_levels: Vec<String>,
}

impl Default for MakaModelOverride {
    fn default() -> Self {
        Self {
            context_window: DEFAULT_EVAL_CONTEXT_WINDOW,
            thinking_levels: vec!["off".into()],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MakaConnectionInit {
    pub slug: String,
    pub name: String,
    pub provider: String,
    pub configuration: MakaGatewayConfiguration,
    pub api_key: String,
    pub enabled: bool,
    pub enabled_model_ids: Vec<String>,
    pub model_overrides: BTreeMap<String, MakaModelOverride>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MakaDefaultTargetInit {
    pub slug: String,
    pub model_id: String,
}

/// Exact stdin JSON payload accepted by `maka host init --settings-stdin --root <ROOT_DIR>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MakaHostInitSettingsPayload {
    pub connections: Vec<MakaConnectionInit>,
    pub default_target: MakaDefaultTargetInit,
}

impl MakaHostInitSettingsPayload {
    /// Constructs the canonical `eval-gateway` settings payload for a local metering gateway
    /// port, credential, and model ID.
    pub fn for_eval_gateway(
        port: u16,
        gateway_credential: impl Into<String>,
        model_id: impl Into<String>,
    ) -> Self {
        Self::for_eval_gateway_base_url(
            format!("http://127.0.0.1:{port}/v1"),
            gateway_credential,
            model_id,
        )
    }

    pub fn for_eval_gateway_base_url(
        base_url: impl Into<String>,
        gateway_credential: impl Into<String>,
        model_id: impl Into<String>,
    ) -> Self {
        let model_id = model_id.into();
        let mut model_overrides = BTreeMap::new();
        model_overrides.insert(model_id.clone(), MakaModelOverride::default());

        Self {
            connections: vec![MakaConnectionInit {
                slug: DEFAULT_EVAL_GATEWAY_SLUG.into(),
                name: DEFAULT_EVAL_GATEWAY_NAME.into(),
                provider: DEFAULT_EVAL_GATEWAY_PROVIDER.into(),
                configuration: MakaGatewayConfiguration {
                    base_url: base_url.into(),
                },
                api_key: gateway_credential.into(),
                enabled: true,
                enabled_model_ids: vec![model_id.clone()],
                model_overrides,
            }],
            default_target: MakaDefaultTargetInit {
                slug: DEFAULT_EVAL_GATEWAY_SLUG.into(),
                model_id,
            },
        }
    }

    pub fn to_json_value(&self) -> Value {
        serde_json::to_value(self).expect("MakaHostInitSettingsPayload serialization cannot fail")
    }
}

/// Bootstraps an isolated Maka Host Root by invoking:
/// `maka host init --settings-stdin --root <root_dir>`
/// and piping `payload` as JSON over `stdin` so credentials never appear in argv or env.
pub async fn bootstrap_maka_host_root(
    maka_executable: &Path,
    root_dir: &Path,
    payload: &MakaHostInitSettingsPayload,
) -> Result<(), String> {
    let mut child = Command::new(maka_executable)
        .arg("host")
        .arg("init")
        .arg("--settings-stdin")
        .arg("--root")
        .arg(root_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("failed to spawn maka host init: {err}"))?;

    let json_bytes = serde_json::to_vec(payload)
        .map_err(|err| format!("failed to serialize init settings: {err}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(&json_bytes)
            .await
            .map_err(|err| format!("failed writing settings to maka host init stdin: {err}"))?;
        stdin
            .shutdown()
            .await
            .map_err(|err| format!("failed closing maka host init stdin: {err}"))?;
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|err| format!("failed waiting for maka host init: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(format!(
            "maka host init exited with {}: {}",
            output.status, stderr
        ));
    }
    Ok(())
}

/// Durable receipt identifying an admitted Host operation and Agent invocation across reconnects.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostExecutionReceipt {
    pub execution_id: String,
    pub operation_id: String,
    pub invocation_id: String,
}

/// Paginated transcript history exporter that drains all pages until `next_cursor` is `None`.
pub async fn export_paginated_transcript<F, Fut>(
    page_limit: usize,
    mut fetch_page: F,
) -> Result<Vec<Value>, String>
where
    F: FnMut(Option<String>, usize) -> Fut,
    Fut: std::future::Future<Output = Result<(Vec<Value>, Option<String>), String>>,
{
    let limit = page_limit.max(1);
    let mut cursor: Option<String> = None;
    let mut items = Vec::new();
    let mut visited_cursors = std::collections::BTreeSet::new();

    loop {
        let (page, next) = fetch_page(cursor.clone(), limit).await?;
        items.extend(page);
        match next {
            None => break,
            Some(next_cursor) => {
                if !visited_cursors.insert(next_cursor.clone()) {
                    return Err(format!(
                        "transcript pagination cycle detected at cursor {next_cursor}"
                    ));
                }
                cursor = Some(next_cursor);
            }
        }
    }
    Ok(items)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HostedExecutionProjection {
    Settled {
        #[serde(rename = "executionId")]
        execution_id: String,
        status: String,
        #[serde(rename = "failureReason")]
        failure_reason: Option<String>,
        usage: NormalizedUsage,
        #[serde(rename = "costUsd")]
        cost_usd: Option<f64>,
        #[serde(rename = "operationId", default)]
        operation_id: Option<String>,
        #[serde(rename = "invocationId", default)]
        invocation_id: Option<String>,
    },
    Indeterminate {
        #[serde(rename = "executionId")]
        execution_id: String,
        #[serde(rename = "failureReason")]
        failure_reason: String,
        #[serde(rename = "operationId", default)]
        operation_id: Option<String>,
        #[serde(rename = "invocationId", default)]
        invocation_id: Option<String>,
    },
}

impl HostedExecutionProjection {
    pub fn execution_id(&self) -> &str {
        match self {
            Self::Settled { execution_id, .. } | Self::Indeterminate { execution_id, .. } => {
                execution_id
            }
        }
    }

    pub fn operation_id(&self) -> Option<&str> {
        match self {
            Self::Settled { operation_id, .. } | Self::Indeterminate { operation_id, .. } => {
                operation_id.as_deref()
            }
        }
    }

    pub fn invocation_id(&self) -> Option<&str> {
        match self {
            Self::Settled { invocation_id, .. } | Self::Indeterminate { invocation_id, .. } => {
                invocation_id.as_deref()
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MakaSubjectConfig {
    pub maka_executable: Option<String>,
    pub node_path: String,
    pub shim_path: String,
    pub runtime_hosts_path: String,
    pub host_settlement_timeout_ms: u32,
    pub base_url: String,
    pub connection_slug: String,
    pub model: String,
    pub provider_type: Option<String>,
    pub default_api_protocol: Option<String>,
    pub api_key_environment: Option<String>,
    pub thinking_level: Option<String>,
    pub permission_mode: String,
    pub collaboration_mode: String,
    pub orchestration_mode: String,
    pub tool_profile: String,
}

impl MakaSubjectConfig {
    pub fn decode(
        config: &JsonObject,
        declared_credentials: &[String],
    ) -> Result<Self, ContractError> {
        let val = Value::Object(config.clone());
        let mut required = vec![
            "runtimeHostsPath",
            "baseUrl",
            "connectionSlug",
            "model",
            "permissionMode",
            "collaborationMode",
            "orchestrationMode",
            "hostSettlementTimeoutMs",
            "toolProfile",
        ];
        if config.contains_key("makaExecutable") {
            required.push("makaExecutable");
            if config.contains_key("nodePath") {
                required.push("nodePath");
            }
            if config.contains_key("shimPath") {
                required.push("shimPath");
            }
        } else {
            required.push("nodePath");
            required.push("shimPath");
        }
        if config.contains_key("providerType") {
            required.push("providerType");
            required.push("apiKeyEnvironment");
        }
        if config.get("providerType").and_then(Value::as_str) == Some("custom") {
            required.push("defaultApiProtocol");
        }
        if config.contains_key("thinkingLevel") {
            required.push("thinkingLevel");
        }

        let obj = exact_object(&val, "Maka config", &required, &[])?;
        for field in &required {
            if *field == "hostSettlementTimeoutMs" {
                continue;
            }
            let _ = nonempty_string(obj.get(*field).unwrap(), &format!("Maka config.{field}"))?;
        }

        let base_url = nonempty_string(obj.get("baseUrl").unwrap(), "Maka config.baseUrl")?;
        if url::Url::parse(&base_url).is_err() {
            return Err(ContractError::Invalid("Maka baseUrl is invalid".into()));
        }

        let host_settlement_timeout_ms = positive_u32(
            obj.get("hostSettlementTimeoutMs").unwrap(),
            "Maka config.hostSettlementTimeoutMs",
        )?;

        let api_key_environment = obj
            .get("apiKeyEnvironment")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let Some(env_name) = &api_key_environment
            && !declared_credentials.iter().any(|c| c == env_name)
        {
            return Err(ContractError::Invalid(
                "Maka apiKeyEnvironment must name a declared subject credential".into(),
            ));
        }

        let thinking_level = obj
            .get("thinkingLevel")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let Some(level) = &thinking_level
            && !matches!(
                level.as_str(),
                "off" | "minimal" | "low" | "medium" | "high" | "max"
            )
        {
            return Err(ContractError::Invalid(
                "Maka config.thinkingLevel is invalid".into(),
            ));
        }

        let tool_profile =
            nonempty_string(obj.get("toolProfile").unwrap(), "Maka config.toolProfile")?;
        if !matches!(
            tool_profile.as_str(),
            "default" | "headless-coding-v1" | "minimal"
        ) {
            return Err(ContractError::Invalid(
                "Maka config.toolProfile is invalid".into(),
            ));
        }

        let maka_executable = obj
            .get("makaExecutable")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let node_path = obj
            .get("nodePath")
            .and_then(Value::as_str)
            .unwrap_or("node")
            .to_owned();
        let shim_path = obj
            .get("shimPath")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();

        Ok(Self {
            maka_executable,
            node_path,
            shim_path,
            runtime_hosts_path: nonempty_string(
                obj.get("runtimeHostsPath").unwrap(),
                "Maka config.runtimeHostsPath",
            )?,
            host_settlement_timeout_ms,
            base_url,
            connection_slug: nonempty_string(
                obj.get("connectionSlug").unwrap(),
                "Maka config.connectionSlug",
            )?,
            model: nonempty_string(obj.get("model").unwrap(), "Maka config.model")?,
            provider_type: obj
                .get("providerType")
                .and_then(Value::as_str)
                .map(str::to_owned),
            default_api_protocol: obj
                .get("defaultApiProtocol")
                .and_then(Value::as_str)
                .map(str::to_owned),
            api_key_environment,
            thinking_level,
            permission_mode: nonempty_string(
                obj.get("permissionMode").unwrap(),
                "Maka config.permissionMode",
            )?,
            collaboration_mode: nonempty_string(
                obj.get("collaborationMode").unwrap(),
                "Maka config.collaborationMode",
            )?,
            orchestration_mode: nonempty_string(
                obj.get("orchestrationMode").unwrap(),
                "Maka config.orchestrationMode",
            )?,
            tool_profile,
        })
    }
}

#[derive(Debug, Default, Clone)]
pub struct RustHostSubject;

impl RustHostSubject {
    pub fn new() -> Self {
        Self
    }
}

impl SubjectAdapter for RustHostSubject {
    fn kind(&self) -> SubjectKind {
        SubjectKind::Maka
    }

    fn validate(&self, cell: &ExperimentCell) -> Result<(), ContractError> {
        let _ = MakaSubjectConfig::decode(&cell.subject.config, &cell.subject.credentials)?;
        let max_steps = cell
            .budget
            .get("maxSteps")
            .ok_or_else(|| ContractError::Invalid("budget.maxSteps is invalid".into()))?;
        let _ = positive_u32(max_steps, "budget.maxSteps")?;
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
                MakaSubjectConfig::decode(&cell.subject.config, &cell.subject.credentials)
            else {
                return subject_failure("config-decode", 0, context.cancel.is_cancelled(), None);
            };
            let Ok(max_steps) = cell
                .budget
                .get("maxSteps")
                .ok_or_else(|| ContractError::Invalid("budget.maxSteps is invalid".into()))
                .and_then(|v| positive_u32(v, "budget.maxSteps"))
            else {
                return subject_failure("budget-decode", 0, context.cancel.is_cancelled(), None);
            };

            let execution_id = Uuid::new_v4().to_string();
            let root_path = format!("{}/{execution_id}", config.runtime_hosts_path);

            let gateway_settings = MakaHostInitSettingsPayload::for_eval_gateway_base_url(
                &config.base_url,
                config
                    .api_key_environment
                    .as_deref()
                    .unwrap_or("EVAL_GATEWAY_API_KEY"),
                &config.model,
            );

            let mut session_obj = serde_json::json!({
                "workspace": { "kind": "host_path", "path": context.cwd },
                "modelTarget": {
                    "kind": "explicit",
                    "connectionSlug": config.connection_slug,
                    "model": config.model,
                },
                "permissionMode": config.permission_mode,
                "collaborationMode": config.collaboration_mode,
                "orchestrationMode": config.orchestration_mode,
                "toolProfile": config.tool_profile,
            });
            if let Some(level) = &config.thinking_level {
                session_obj
                    .as_object_mut()
                    .unwrap()
                    .insert("thinkingLevel".into(), Value::String(level.clone()));
            }

            let mut envelope = serde_json::json!({
                "rootPath": root_path,
                "artifactRoot": MAKA_RUNTIME_ARTIFACT_PATH,
                "baseUrl": config.base_url,
                "hostSettlementTimeoutMs": config.host_settlement_timeout_ms,
                "hostInitSettings": gateway_settings,
                "execution": {
                    "executionId": execution_id,
                    "session": session_obj,
                    "content": { "text": context.task_input },
                    "maxSteps": max_steps,
                }
            });
            if let Some(provider_type) = &config.provider_type {
                let mut conn = serde_json::json!({
                    "providerType": provider_type,
                    "apiKeyEnvironment": config.api_key_environment,
                });
                if let Some(proto) = &config.default_api_protocol {
                    conn.as_object_mut()
                        .unwrap()
                        .insert("defaultApiProtocol".into(), Value::String(proto.clone()));
                }
                envelope
                    .as_object_mut()
                    .unwrap()
                    .insert("connection".into(), conn);
            }

            let encoded_payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).unwrap());
            let credential_environment: HashMap<String, String> = cell
                .subject
                .credentials
                .iter()
                .map(|c| (c.clone(), c.clone()))
                .collect();

            let process = match context
                .execute(SubjectProcessRequest {
                    command: config.node_path.clone(),
                    args: vec![config.shim_path.clone(), encoded_payload],
                    environment: HashMap::new(),
                    credential_environment,
                    capture_stdout: true,
                })
                .await
            {
                Ok(p) => p,
                Err(_) => {
                    return subject_failure(
                        "relay-execute",
                        started.elapsed().as_millis() as u64,
                        context.cancel.is_cancelled(),
                        None,
                    );
                }
            };

            let duration_ms = started.elapsed().as_millis() as u64;

            if process.termination != SubjectProcessTermination::Exited {
                let projection = try_decode_matching_projection(&process.stdout, &execution_id);
                let (usage, metering_state, cost_usd, subject_reported_cost, op_id, inv_id) =
                    match projection {
                        Some(HostedExecutionProjection::Settled {
                            usage,
                            cost_usd,
                            operation_id,
                            invocation_id,
                            ..
                        }) => (
                            Some(usage.clone()),
                            MeteringState::Complete,
                            estimate_deepseek_cost(&usage, &config.model),
                            cost_usd,
                            operation_id,
                            invocation_id,
                        ),
                        _ => (None, MeteringState::Unknown, None, None, None, None),
                    };
                return SubjectExecutionResult {
                    output: None,
                    usage,
                    metering_state,
                    cost_usd,
                    duration_ms,
                    outcome: ExecutionOutcome::Timeout,
                    failure_reason: Some("Maka subject exceeded the framework timeout".into()),
                    artifacts: maka_artifacts(
                        Some(&execution_id),
                        Some(&process),
                        subject_reported_cost,
                    ),
                    operation_id: op_id,
                    invocation_id: inv_id,
                };
            }

            if process.stdout.is_empty() {
                return subject_failure(
                    "empty-output",
                    duration_ms,
                    context.cancel.is_cancelled(),
                    Some(&process),
                );
            }

            let Ok(parsed) = serde_json::from_str::<Value>(&process.stdout) else {
                return subject_failure(
                    "json-parse",
                    duration_ms,
                    context.cancel.is_cancelled(),
                    Some(&process),
                );
            };

            let Ok(projection) = serde_json::from_value::<HostedExecutionProjection>(parsed) else {
                return subject_failure(
                    "result-decode",
                    duration_ms,
                    context.cancel.is_cancelled(),
                    Some(&process),
                );
            };

            if projection.execution_id() != execution_id {
                return subject_failure(
                    "identity-check",
                    duration_ms,
                    context.cancel.is_cancelled(),
                    Some(&process),
                );
            }

            let proxy_counts = context
                .metadata
                .get("proxyMeteringCounts")
                .and_then(|v| serde_json::from_value::<ProviderMeteringCounts>(v.clone()).ok());
            project_into_execution_result(
                projection,
                None,
                proxy_counts.as_ref(),
                &config,
                &execution_id,
                duration_ms,
                Some(&process),
            )
        })
    }
}

fn project_into_execution_result(
    projection: HostedExecutionProjection,
    output: Option<String>,
    proxy_counts: Option<&ProviderMeteringCounts>,
    config: &MakaSubjectConfig,
    execution_id: &str,
    duration_ms: u64,
    process: Option<&SubjectProcessOutput>,
) -> SubjectExecutionResult {
    match projection {
        HostedExecutionProjection::Indeterminate {
            failure_reason,
            operation_id,
            invocation_id,
            ..
        } => SubjectExecutionResult {
            output,
            usage: None,
            metering_state: MeteringState::Unknown,
            cost_usd: None,
            duration_ms,
            outcome: ExecutionOutcome::Indeterminate,
            failure_reason: Some(safe_maka_failure_reason(
                &failure_reason,
                "Maka execution did not settle",
            )),
            artifacts: maka_artifacts(Some(execution_id), process, None),
            operation_id,
            invocation_id,
        },
        HostedExecutionProjection::Settled {
            status,
            failure_reason,
            usage,
            cost_usd: subject_cost,
            operation_id,
            invocation_id,
            ..
        } => {
            let (reconciled_usage, metering_state, _) =
                reconcile_host_and_proxy_usage(Some(&usage), true, proxy_counts);
            let final_usage = reconciled_usage.unwrap_or(usage);
            let cost_usd = if metering_state == MeteringState::Complete {
                estimate_deepseek_cost(&final_usage, &config.model)
            } else {
                None
            };

            if status == "cancelled" {
                return SubjectExecutionResult {
                    output,
                    usage: Some(final_usage),
                    metering_state,
                    cost_usd,
                    duration_ms,
                    outcome: ExecutionOutcome::Indeterminate,
                    failure_reason: Some("Maka subject cancelled".into()),
                    artifacts: maka_artifacts(Some(execution_id), process, subject_cost),
                    operation_id,
                    invocation_id,
                };
            }

            let outcome = if status == "completed" {
                ExecutionOutcome::Completed
            } else {
                ExecutionOutcome::SubjectFailed
            };
            let reason = if status == "completed" {
                None
            } else {
                failure_reason
                    .as_deref()
                    .map(|r| safe_maka_failure_reason(r, "Maka execution failed"))
            };

            SubjectExecutionResult {
                output,
                usage: Some(final_usage),
                metering_state,
                cost_usd,
                duration_ms,
                outcome,
                failure_reason: reason,
                artifacts: maka_artifacts(Some(execution_id), process, subject_cost),
                operation_id,
                invocation_id,
            }
        }
    }
}

fn try_decode_matching_projection(
    stdout: &str,
    expected_execution_id: &str,
) -> Option<HostedExecutionProjection> {
    if stdout.is_empty() {
        return None;
    }
    let proj: HostedExecutionProjection = serde_json::from_str(stdout).ok()?;
    (proj.execution_id() == expected_execution_id).then_some(proj)
}

fn estimate_deepseek_cost(usage: &NormalizedUsage, model: &str) -> Option<f64> {
    (model == "deepseek-v4-flash").then(|| deepseek_cost_usd(usage))
}

pub fn safe_maka_failure_reason(value: &str, fallback: &str) -> String {
    const SAFE_REASONS: &[&str] = &[
        "Hosted execution is not active",
        "Hosted execution was cancelled",
        "Hosted execution was cancelled before admission",
        "Runtime Host connection failed before execution settlement",
        "Runtime Host could not settle execution",
        "Runtime Host did not exit cleanly",
    ];
    if SAFE_REASONS.contains(&value) {
        return value.to_owned();
    }
    if let Some(rest) = value.strip_prefix("Runtime Host did not start: ")
        && matches!(
            rest,
            "composition_mismatch"
                | "existing_host"
                | "host_unresponsive"
                | "incompatible"
                | "startup_timeout"
                | "upgrade_required"
        )
    {
        return value.to_owned();
    }
    if let Some(rest) = value.strip_prefix("Runtime Host usage did not settle: ")
        && matches!(
            rest,
            "missing_attempt_usage"
                | "partial_attempt_usage"
                | "pending_usage_repair"
                | "unreadable_usage_record"
        )
    {
        return value.to_owned();
    }
    fallback.to_owned()
}

pub fn maka_artifacts(
    execution_id: Option<&str>,
    process: Option<&SubjectProcessOutput>,
    subject_reported_cost_usd: Option<f64>,
) -> Vec<JsonObject> {
    let mut out = Vec::new();
    if let Some(cost) = subject_reported_cost_usd {
        let mut obj = Map::new();
        obj.insert("kind".into(), Value::String("subject-reported-cost".into()));
        obj.insert("costUsd".into(), Value::from(cost));
        out.push(obj);
    }
    let mut runtime_state = Map::new();
    runtime_state.insert("kind".into(), Value::String("maka-runtime-state".into()));
    runtime_state.insert(
        "path".into(),
        Value::String(MAKA_RUNTIME_ARTIFACT_PATH.into()),
    );
    if let Some(id) = execution_id {
        runtime_state.insert("executionId".into(), Value::String(id.into()));
    }
    out.push(runtime_state);

    let mut stdout_art = Map::new();
    stdout_art.insert("kind".into(), Value::String("subject-stdout".into()));
    stdout_art.insert(
        "path".into(),
        Value::String(MAKA_SUBJECT_STDOUT_PATH.into()),
    );
    if let Some(proc) = process {
        stdout_art.insert("bytes".into(), Value::from(proc.stdout.len() as u64));
    }
    out.push(stdout_art);

    let mut stderr_art = Map::new();
    stderr_art.insert("kind".into(), Value::String("subject-stderr".into()));
    stderr_art.insert(
        "path".into(),
        Value::String(MAKA_SUBJECT_STDERR_PATH.into()),
    );
    out.push(stderr_art);
    out
}

fn subject_failure(
    stage: &str,
    duration_ms: u64,
    cancelled: bool,
    process: Option<&SubjectProcessOutput>,
) -> SubjectExecutionResult {
    let mut artifacts = maka_artifacts(None, process, None);
    let mut failure_art = Map::new();
    failure_art.insert("kind".into(), Value::String("subject-failure".into()));
    failure_art.insert("stage".into(), Value::String(stage.into()));
    if let Some(proc) = process {
        failure_art.insert(
            "termination".into(),
            serde_json::to_value(proc.termination).unwrap_or(Value::Null),
        );
        failure_art.insert("exitCode".into(), Value::from(proc.exit_code));
        failure_art.insert("stdoutBytes".into(), Value::from(proc.stdout.len() as u64));
        if let Some(diag) = &proc.diagnostic {
            failure_art.insert(
                "diagnostic".into(),
                serde_json::to_value(diag).unwrap_or(Value::Null),
            );
        }
    }
    artifacts.push(failure_art);

    SubjectExecutionResult {
        output: None,
        usage: None,
        metering_state: MeteringState::Unknown,
        cost_usd: None,
        duration_ms,
        outcome: if cancelled {
            ExecutionOutcome::Indeterminate
        } else {
            ExecutionOutcome::InfraFailed
        },
        failure_reason: Some(if cancelled {
            "Maka subject cancelled".into()
        } else {
            format!("Maka subject failed during {stage}")
        }),
        artifacts,
        operation_id: None,
        invocation_id: None,
    }
}
