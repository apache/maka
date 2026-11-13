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
//! public Maka settings/session contracts, durable operation/invocation receipt tracking,
//! unattended interaction preservation, paginated transcript export, and usage settlement).

use crate::contract::{
    ContractError, ExecutionOutcome, ExperimentCell, JsonObject, SubjectKind,
    canonical_json_string, decode_json_object, exact_object, nonempty_string, positive_u32,
    sha256_hex,
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
use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::Instant;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use uuid::Uuid;

pub mod native;

pub const DEFAULT_EVAL_GATEWAY_SLUG: &str = "eval-gateway";
pub const DEFAULT_EVAL_GATEWAY_NAME: &str = "Eval Gateway";
pub const DEFAULT_EVAL_GATEWAY_PROVIDER: &str = "openai-compatible";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MakaGatewayConfiguration {
    pub base_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MakaConnectionInit {
    pub slug: String,
    pub name: String,
    pub provider: String,
    pub configuration: MakaGatewayConfiguration,
    pub api_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_headers: Option<BTreeMap<String, String>>,
    pub enabled: bool,
    pub enabled_model_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_overrides: Option<BTreeMap<String, JsonObject>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_body_overlay: Option<JsonObject>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MakaDefaultTargetInit {
    pub slug: String,
    pub model_id: String,
}

/// Exact public stdin JSON payload accepted by `maka host init --settings-stdin --root <ROOT_DIR>`.
///
/// Only user-declared connection settings and optional public `modelOverrides` are included;
/// Eval never synthesizes hidden context-window, thinking-level, or tool overrides.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MakaHostInitSettingsPayload {
    pub connections: Vec<MakaConnectionInit>,
    pub default_target: MakaDefaultTargetInit,
}

impl MakaHostInitSettingsPayload {
    /// Constructs a default `openai-compatible` settings payload for a local metering gateway
    /// port, credential, and model ID with Maka's unmodified product model defaults.
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
        Self {
            connections: vec![MakaConnectionInit {
                slug: DEFAULT_EVAL_GATEWAY_SLUG.into(),
                name: DEFAULT_EVAL_GATEWAY_NAME.into(),
                provider: DEFAULT_EVAL_GATEWAY_PROVIDER.into(),
                configuration: MakaGatewayConfiguration {
                    base_url: base_url.into(),
                },
                api_key: gateway_credential.into(),
                request_headers: None,
                enabled: true,
                enabled_model_ids: vec![model_id.clone()],
                model_overrides: None,
                request_body_overlay: None,
            }],
            default_target: MakaDefaultTargetInit {
                slug: DEFAULT_EVAL_GATEWAY_SLUG.into(),
                model_id,
            },
        }
    }

    pub fn with_endpoint_and_credential(
        &self,
        base_url: impl Into<String>,
        api_key: impl Into<String>,
    ) -> Self {
        let mut cloned = self.clone();
        if let Some(conn) = cloned.connections.first_mut() {
            conn.configuration.base_url = base_url.into();
            conn.api_key = api_key.into();
        }
        cloned
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
        .kill_on_drop(true)
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnattendedInteractionBlock {
    pub kind: String,
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentLimitation {
    pub category: String,
    pub detail: String,
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
        usage: Option<NormalizedUsage>,
        #[serde(rename = "meteringState")]
        metering_state: MeteringState,
        #[serde(rename = "costUsd")]
        cost_usd: Option<f64>,
        #[serde(rename = "operationId", default)]
        operation_id: Option<String>,
        #[serde(rename = "invocationId", default)]
        invocation_id: Option<String>,
        #[serde(
            rename = "makaExecutableSha256",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        maka_executable_sha256: Option<String>,
        #[serde(
            rename = "blockedInteraction",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        blocked_interaction: Option<Box<UnattendedInteractionBlock>>,
        #[serde(
            rename = "environmentLimitation",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        environment_limitation: Option<Box<EnvironmentLimitation>>,
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
        #[serde(
            rename = "makaExecutableSha256",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        maka_executable_sha256: Option<String>,
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

/// Public Maka subject configuration declared in an experiment specification.
///
/// Every agent-facing setting maps 1:1 to a public Maka user interface (`maka host init`,
/// `settings.updateAssistantPreferences`, `agent.create`, and `agent.metadata`).
/// Benchmark-only profiles (`toolProfile`, `permissionMode: "bypass"`, synthetic model
/// overrides) are rejected at the contract boundary.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MakaPublicSessionSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_permissions: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_instructions: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MakaSubjectConfig {
    pub maka_executable: String,
    pub runtime_hosts_path: String,
    pub host_settlement_timeout_ms: u32,
    pub provider: String,
    pub connection_slug: String,
    pub connection_name: String,
    pub base_url: String,
    pub model: String,
    pub api_key_environment: String,
    pub model_override: Option<JsonObject>,
    pub request_headers: Option<BTreeMap<String, String>>,
    pub request_body_overlay: Option<JsonObject>,
    pub session_settings: MakaPublicSessionSettings,
}

impl MakaSubjectConfig {
    pub fn decode(
        config: &JsonObject,
        declared_credentials: &[String],
    ) -> Result<Self, ContractError> {
        let val = Value::Object(config.clone());
        let obj = exact_object(
            &val,
            "Maka config",
            &[
                "makaExecutable",
                "runtimeHostsPath",
                "hostSettlementTimeoutMs",
                "baseUrl",
                "model",
            ],
            &[
                "provider",
                "connectionSlug",
                "connectionName",
                "apiKeyEnvironment",
                "modelOverride",
                "requestHeaders",
                "requestBodyOverlay",
                "sandboxMode",
                "requestPermissions",
                "thinkingLevel",
                "language",
                "workspaceInstructions",
            ],
        )?;

        let maka_executable = nonempty_string(
            obj.get("makaExecutable").unwrap(),
            "Maka config.makaExecutable",
        )?;
        let runtime_hosts_path = nonempty_string(
            obj.get("runtimeHostsPath").unwrap(),
            "Maka config.runtimeHostsPath",
        )?;
        let host_settlement_timeout_ms = positive_u32(
            obj.get("hostSettlementTimeoutMs").unwrap(),
            "Maka config.hostSettlementTimeoutMs",
        )?;

        let base_url = nonempty_string(obj.get("baseUrl").unwrap(), "Maka config.baseUrl")?;
        let parsed_url = url::Url::parse(&base_url)
            .map_err(|_| ContractError::Invalid("Maka baseUrl is invalid".into()))?;
        if !matches!(parsed_url.scheme(), "http" | "https") || parsed_url.host_str().is_none() {
            return Err(ContractError::Invalid("Maka baseUrl is invalid".into()));
        }

        let model = nonempty_string(obj.get("model").unwrap(), "Maka config.model")?;

        let provider = match obj.get("provider") {
            Some(v) => nonempty_string(v, "Maka config.provider")?,
            None => DEFAULT_EVAL_GATEWAY_PROVIDER.into(),
        };

        let connection_slug = match obj.get("connectionSlug") {
            Some(v) => {
                let s = nonempty_string(v, "Maka config.connectionSlug")?;
                validate_connection_slug(&s)?;
                s
            }
            None => DEFAULT_EVAL_GATEWAY_SLUG.into(),
        };

        let connection_name = match obj.get("connectionName") {
            Some(v) => nonempty_string(v, "Maka config.connectionName")?,
            None => DEFAULT_EVAL_GATEWAY_NAME.into(),
        };

        let explicit_api_key_env = match obj.get("apiKeyEnvironment") {
            Some(v) => Some(nonempty_string(v, "Maka config.apiKeyEnvironment")?),
            None => None,
        };
        if let Some(env_name) = &explicit_api_key_env
            && !declared_credentials.iter().any(|c| c == env_name)
        {
            return Err(ContractError::Invalid(
                "Maka apiKeyEnvironment must name a declared subject credential".into(),
            ));
        }
        let api_key_environment = match explicit_api_key_env {
            Some(name) => name,
            None if declared_credentials.len() == 1 => declared_credentials[0].clone(),
            None => {
                return Err(ContractError::Invalid(
                    "native Maka requires one credential or an explicit apiKeyEnvironment".into(),
                ));
            }
        };

        let model_override = match obj.get("modelOverride") {
            Some(v) => Some(decode_json_object(v, "Maka config.modelOverride")?),
            None => None,
        };

        let request_headers = match obj.get("requestHeaders") {
            Some(v) => {
                let map = v.as_object().ok_or_else(|| {
                    ContractError::Invalid("Maka config.requestHeaders must be an object".into())
                })?;
                let mut headers = BTreeMap::new();
                for (k, hv) in map {
                    if k.trim().is_empty() {
                        return Err(ContractError::Invalid(
                            "Maka config.requestHeaders key must be non-empty".into(),
                        ));
                    }
                    let val_str = hv.as_str().ok_or_else(|| {
                        ContractError::Invalid(
                            "Maka config.requestHeaders values must be strings".into(),
                        )
                    })?;
                    headers.insert(k.clone(), val_str.to_owned());
                }
                Some(headers)
            }
            None => None,
        };

        let request_body_overlay = match obj.get("requestBodyOverlay") {
            Some(v) => Some(decode_json_object(v, "Maka config.requestBodyOverlay")?),
            None => None,
        };

        let sandbox_mode = match obj.get("sandboxMode") {
            Some(v) => {
                let mode = nonempty_string(v, "Maka config.sandboxMode")?;
                if !matches!(
                    mode.as_str(),
                    "read-only" | "workspace-write" | "danger-full-access"
                ) {
                    return Err(ContractError::Invalid(
                        "Maka config.sandboxMode must be read-only, workspace-write, or danger-full-access".into(),
                    ));
                }
                Some(mode)
            }
            None => None,
        };

        let request_permissions = match obj.get("requestPermissions") {
            Some(v) => Some(v.as_bool().ok_or_else(|| {
                ContractError::Invalid("Maka config.requestPermissions must be a boolean".into())
            })?),
            None => None,
        };

        let thinking_level = match obj.get("thinkingLevel") {
            Some(v) => {
                let level = nonempty_string(v, "Maka config.thinkingLevel")?;
                if !matches!(
                    level.as_str(),
                    "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
                ) {
                    return Err(ContractError::Invalid(
                        "Maka config.thinkingLevel is invalid".into(),
                    ));
                }
                Some(level)
            }
            None => None,
        };

        let language = match obj.get("language") {
            Some(v) => {
                let lang = nonempty_string(v, "Maka config.language")?;
                if !matches!(lang.as_str(), "auto" | "en" | "zh-CN" | "zh-TW") {
                    return Err(ContractError::Invalid(
                        "Maka config.language must be auto, en, zh-CN, or zh-TW".into(),
                    ));
                }
                Some(lang)
            }
            None => None,
        };

        let workspace_instructions = match obj.get("workspaceInstructions") {
            Some(v) => Some(v.as_bool().ok_or_else(|| {
                ContractError::Invalid("Maka config.workspaceInstructions must be a boolean".into())
            })?),
            None => None,
        };

        Ok(Self {
            maka_executable,
            runtime_hosts_path,
            host_settlement_timeout_ms,
            provider,
            connection_slug,
            connection_name,
            base_url,
            model,
            api_key_environment,
            model_override,
            request_headers,
            request_body_overlay,
            session_settings: MakaPublicSessionSettings {
                sandbox_mode,
                request_permissions,
                thinking_level,
                language,
                workspace_instructions,
            },
        })
    }

    pub fn host_init_settings(
        &self,
        base_url: impl Into<String>,
        api_key: impl Into<String>,
    ) -> MakaHostInitSettingsPayload {
        let model_overrides = self.model_override.as_ref().map(|ov| {
            let mut map = BTreeMap::new();
            map.insert(self.model.clone(), ov.clone());
            map
        });
        MakaHostInitSettingsPayload {
            connections: vec![MakaConnectionInit {
                slug: self.connection_slug.clone(),
                name: self.connection_name.clone(),
                provider: self.provider.clone(),
                configuration: MakaGatewayConfiguration {
                    base_url: base_url.into(),
                },
                api_key: api_key.into(),
                request_headers: self.request_headers.clone(),
                enabled: true,
                enabled_model_ids: vec![self.model.clone()],
                model_overrides,
                request_body_overlay: self.request_body_overlay.clone(),
            }],
            default_target: MakaDefaultTargetInit {
                slug: self.connection_slug.clone(),
                model_id: self.model.clone(),
            },
        }
    }

    /// Canonical digest over all public Maka settings that govern effective instructions,
    /// model routing, tool exposure, and execution policies.
    ///
    /// Ephemeral loopback port numbers (`127.0.0.1:<port>`, `localhost:<port>`) are normalized
    /// while canonical provider hosts and paths are preserved verbatim.
    pub fn parity_config_sha256(&self) -> String {
        let payload = serde_json::json!({
            "provider": self.provider,
            "connectionSlug": self.connection_slug,
            "connectionName": self.connection_name,
            "routeSignature": url_route_signature(&self.base_url),
            "model": self.model,
            "modelOverride": self.model_override,
            "requestHeaders": self.request_headers,
            "requestBodyOverlay": self.request_body_overlay,
            "sessionSettings": self.session_settings,
        });
        sha256_hex(canonical_json_string(&payload).as_bytes())
    }
}

fn validate_connection_slug(value: &str) -> Result<(), ContractError> {
    let valid = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    let b = value.as_bytes();
    if b.is_empty()
        || !valid(b[0])
        || !valid(b[b.len() - 1])
        || !b.iter().all(|c| valid(*c) || *c == b'-')
        || b.windows(2).any(|pair| pair == b"--")
    {
        return Err(ContractError::Invalid(
            "Maka config.connectionSlug must be lowercase alphanumeric hyphen-separated".into(),
        ));
    }
    Ok(())
}

pub fn url_route_signature(raw_url: &str) -> String {
    let Ok(mut parsed) = url::Url::parse(raw_url) else {
        return raw_url.to_owned();
    };
    if matches!(parsed.host_str(), Some("127.0.0.1" | "localhost")) {
        let _ = parsed.set_port(None);
    }
    let trimmed_path = parsed.path().trim_end_matches('/').to_owned();
    parsed.set_path(&trimmed_path);
    parsed.to_string()
}

/// Resolves the actual outbound model route (`base_url`) using Maka's provider policy
/// against the declared connection endpoint before attaching local metering forwarding.
pub async fn resolve_product_route_base_url(
    provider_name: &str,
    connection_slug: &str,
    declared_base_url: &str,
    model_id: &str,
    model_override: Option<&JsonObject>,
    thinking_level: Option<&str>,
) -> Result<String, String> {
    static BUNDLED_CATALOG: OnceLock<Result<Arc<maka_providers::catalog::Snapshot>, String>> =
        OnceLock::new();
    let snapshot = BUNDLED_CATALOG
        .get_or_init(|| maka_providers::catalog::Snapshot::bundled().map(Arc::new))
        .as_ref()
        .map_err(Clone::clone)?;

    let package = if provider_name == "chatgpt" {
        maka_providers::codex::ID
    } else {
        maka_providers::api::ID
    };
    let identity = maka_agent_facts::provider::Identity {
        package_id: package.into(),
        entry_id: package.into(),
        scope: Default::default(),
        name: provider_name.to_owned(),
    };
    let definition = maka_providers::definition(&identity, snapshot.clone())
        .map_err(|e| format!("unavailable Maka provider '{provider_name}': {e}"))?;
    let configuration = definition
        .configure(serde_json::json!({ "baseUrl": declared_base_url }))
        .map_err(|e| format!("invalid Maka provider configuration for '{provider_name}': {e}"))?;

    let overrides = model_override
        .map(|ov| {
            serde_json::from_value::<maka_agent_facts::configuration::ModelOverride>(Value::Object(
                ov.clone(),
            ))
        })
        .transpose()
        .map_err(|e| format!("invalid Maka modelOverride for '{model_id}': {e}"))?;
    let thinking = thinking_level
        .map(|lvl| {
            serde_json::from_value::<maka_agent_facts::execution::ThinkingLevel>(Value::String(
                lvl.to_owned(),
            ))
        })
        .transpose()
        .map_err(|e| format!("invalid Maka thinkingLevel '{thinking_level:?}': {e}"))?;

    let reference = overrides.as_ref().and_then(|v| v.catalog_model.as_ref());
    let public_model = snapshot
        .model_base(provider_name, model_id, reference)
        .map(Cow::into_owned);
    let model_snapshot = Arc::new(
        maka_providers::catalog::Snapshot::for_model(provider_name, model_id, public_model)
            .map_err(|e| format!("invalid Maka catalog snapshot for '{model_id}': {e}"))?,
    );
    let model_definition = maka_providers::definition(&identity, model_snapshot)
        .map_err(|e| format!("unavailable Maka provider '{provider_name}': {e}"))?;
    let resolved = model_definition
        .prepare(maka_agent_ports::provider::Resolve {
            connection: maka_agent_ports::provider::Connection {
                id: connection_slug.to_owned(),
                revision: 0,
                configuration,
            },
            model: maka_agent_facts::configuration::ModelInfo::new(model_id),
            overrides,
            thinking_level: thinking,
        })
        .await
        .map_err(|e| {
            format!("failed resolving Maka model route for '{provider_name}/{model_id}': {e}")
        })?;

    Ok(resolved.base_url)
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

            let host_init_settings =
                config.host_init_settings(&config.base_url, &config.api_key_environment);
            let artifact_root = context
                .metadata
                .get("artifactRoot")
                .and_then(Value::as_str)
                .unwrap_or(MAKA_RUNTIME_ARTIFACT_PATH);

            let envelope = serde_json::json!({
                "makaExecutable": config.maka_executable,
                "rootPath": root_path,
                "artifactRoot": artifact_root,
                "baseUrl": config.base_url,
                "hostSettlementTimeoutMs": config.host_settlement_timeout_ms,
                "hostInitSettings": host_init_settings,
                "execution": {
                    "executionId": execution_id,
                    "workspacePath": context.cwd,
                    "sessionSettings": config.session_settings,
                    "content": { "text": context.task_input },
                    "maxSteps": max_steps,
                }
            });
            let encoded_payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).unwrap());
            let credential_environment: HashMap<String, String> = cell
                .subject
                .credentials
                .iter()
                .map(|c| (c.clone(), c.clone()))
                .collect();

            let process = match context
                .execute(SubjectProcessRequest {
                    command: resolve_maka_eval_executable(&config.maka_executable),
                    args: vec!["host-subject".into(), encoded_payload],
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
                let (
                    usage,
                    metering_state,
                    cost_usd,
                    subject_reported_cost,
                    op_id,
                    inv_id,
                    exe_sha,
                ) = match projection {
                    Some(HostedExecutionProjection::Settled {
                        usage,
                        metering_state,
                        cost_usd,
                        operation_id,
                        invocation_id,
                        maka_executable_sha256,
                        ..
                    }) => (
                        usage.clone(),
                        metering_state,
                        usage
                            .as_ref()
                            .filter(|_| metering_state == MeteringState::Complete)
                            .and_then(|u| estimate_deepseek_cost(u, &config.model)),
                        cost_usd,
                        operation_id,
                        invocation_id,
                        maka_executable_sha256,
                    ),
                    Some(HostedExecutionProjection::Indeterminate {
                        operation_id,
                        invocation_id,
                        maka_executable_sha256,
                        ..
                    }) => (
                        None,
                        MeteringState::Unknown,
                        None,
                        None,
                        operation_id,
                        invocation_id,
                        maka_executable_sha256,
                    ),
                    None => (None, MeteringState::Unknown, None, None, None, None, None),
                };
                let binary_identity = exe_sha
                    .as_deref()
                    .map(|sha| (config.maka_executable.as_str(), sha));
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
                        binary_identity,
                        Some(&process),
                        subject_reported_cost,
                        None,
                        None,
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

fn resolve_maka_eval_executable(maka_executable: &str) -> String {
    let eval_name = if cfg!(windows) {
        "maka-eval.exe"
    } else {
        "maka-eval"
    };
    let maka_path = Path::new(maka_executable);
    let sibling = maka_path.with_file_name(eval_name);
    if !maka_path.exists() || sibling.exists() {
        return sibling.to_string_lossy().into_owned();
    }
    if let Ok(current) = std::env::current_exe()
        && current
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n == eval_name)
    {
        return current.to_string_lossy().into_owned();
    }
    sibling.to_string_lossy().into_owned()
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
            maka_executable_sha256,
            ..
        } => {
            let binary_identity = maka_executable_sha256
                .as_deref()
                .map(|sha| (config.maka_executable.as_str(), sha));
            SubjectExecutionResult {
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
                artifacts: maka_artifacts(
                    Some(execution_id),
                    binary_identity,
                    process,
                    None,
                    None,
                    None,
                ),
                operation_id,
                invocation_id,
            }
        }
        HostedExecutionProjection::Settled {
            status,
            failure_reason,
            usage,
            metering_state: receipt_metering_state,
            cost_usd: subject_cost,
            operation_id,
            invocation_id,
            maka_executable_sha256,
            blocked_interaction,
            environment_limitation,
            ..
        } => {
            let (final_usage, metering_state, _) = if let Some(proxy) = proxy_counts {
                reconcile_host_and_proxy_usage(
                    usage.as_ref(),
                    receipt_metering_state == MeteringState::Complete,
                    Some(proxy),
                )
            } else {
                (usage, receipt_metering_state, None)
            };
            let cost_usd = final_usage
                .as_ref()
                .filter(|_| metering_state == MeteringState::Complete)
                .and_then(|u| estimate_deepseek_cost(u, &config.model));

            let binary_identity = maka_executable_sha256
                .as_deref()
                .map(|sha| (config.maka_executable.as_str(), sha));
            let artifacts = maka_artifacts(
                Some(execution_id),
                binary_identity,
                process,
                subject_cost,
                blocked_interaction.as_deref(),
                environment_limitation.as_deref(),
            );

            if status == "cancelled" {
                return SubjectExecutionResult {
                    output,
                    usage: final_usage,
                    metering_state,
                    cost_usd,
                    duration_ms,
                    outcome: ExecutionOutcome::Indeterminate,
                    failure_reason: Some("Maka subject cancelled".into()),
                    artifacts,
                    operation_id,
                    invocation_id,
                };
            }

            let outcome = if status == "completed" {
                ExecutionOutcome::Completed
            } else if environment_limitation.is_some() {
                ExecutionOutcome::InfraFailed
            } else {
                ExecutionOutcome::SubjectFailed
            };
            let reason = if status == "completed" {
                None
            } else {
                Some(
                    failure_reason
                        .as_deref()
                        .map(|r| safe_maka_failure_reason(r, "Maka execution failed"))
                        .unwrap_or_else(|| "Maka execution failed".into()),
                )
            };

            SubjectExecutionResult {
                output,
                usage: final_usage,
                metering_state,
                cost_usd,
                duration_ms,
                outcome,
                failure_reason: reason,
                artifacts,
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
        "Maka execution failed",
        "Maka step budget exhausted",
    ];
    if SAFE_REASONS.contains(&value) {
        return value.to_owned();
    }
    if let Some(rest) = value.strip_prefix("Unattended execution blocked on required interaction: ")
        && matches!(
            rest,
            "session_approval"
                | "service_approval"
                | "question"
                | "permissions"
                | "form"
                | "client_capability"
                | "computer_app"
                | "system_permission"
        )
    {
        return value.to_owned();
    }
    if let Some(rest) = value.strip_prefix("Environment limitation: ")
        && matches!(
            rest,
            "authority_unavailable"
                | "sandbox_unavailable"
                | "workspace_unavailable"
                | "host_startup_failed"
        )
    {
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
    binary_identity: Option<(&str, &str)>,
    process: Option<&SubjectProcessOutput>,
    subject_reported_cost_usd: Option<f64>,
    blocked_interaction: Option<&UnattendedInteractionBlock>,
    environment_limitation: Option<&EnvironmentLimitation>,
) -> Vec<JsonObject> {
    let mut out = Vec::new();
    if let Some(cost) = subject_reported_cost_usd {
        let mut obj = Map::new();
        obj.insert("kind".into(), Value::String("subject-reported-cost".into()));
        obj.insert("costUsd".into(), Value::from(cost));
        out.push(obj);
    }
    if let Some(block) = blocked_interaction {
        let mut obj = Map::new();
        obj.insert(
            "kind".into(),
            Value::String("unattended-interaction-blocked".into()),
        );
        obj.insert("interactionKind".into(), Value::String(block.kind.clone()));
        obj.insert("requestId".into(), Value::String(block.request_id.clone()));
        if let Some(tool_use_id) = &block.tool_use_id {
            obj.insert("toolUseId".into(), Value::String(tool_use_id.clone()));
        }
        out.push(obj);
    }
    if let Some(limitation) = environment_limitation {
        let mut obj = Map::new();
        obj.insert(
            "kind".into(),
            Value::String("environment-limitation".into()),
        );
        obj.insert(
            "category".into(),
            Value::String(limitation.category.clone()),
        );
        obj.insert("detail".into(), Value::String(limitation.detail.clone()));
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
    if let Some((exe, sha)) = binary_identity {
        runtime_state.insert("makaExecutable".into(), Value::String(exe.into()));
        runtime_state.insert("makaExecutableSha256".into(), Value::String(sha.into()));
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
    let mut artifacts = maka_artifacts(None, None, process, None, None, None);
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
