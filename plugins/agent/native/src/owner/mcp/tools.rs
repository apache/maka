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

//! Agent-facing MCP management tools (list, install, update, uninstall).
//!
//! All four tools stay deferred so they never bloat eager tool definitions or
//! disturb the prompt prefix cache. Mutations require explicit human approval
//! outside DangerFullAccess, refuse ReadOnly sessions, validate and live-verify
//! enabled servers before writing, and take effect on the next Run.

use super::management::Location;
use crate::{mcp::files, owner::Owner, owner::ResolvedConfiguration, owner::access::RunAccess};
use maka_agent_api::contract::{Workspace, WorkspaceAccess};
use maka_agent_authority::permissions::Access;
use maka_agent_facts::{
    configuration::mcp::ServerConfiguration,
    durable::{ApprovalId, AuthorizationObligation},
    tool_call::ToolRejection,
    tool_output::ToolSuccess,
    tools::{
        PreparationFuture, PreparedEffect, ToolCallContext, ToolDefinition, ToolError, ToolHandler,
        ToolNesting, ToolPreparer, ToolRegistration, ToolSemantics,
    },
};
use maka_skills::LocationId;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{collections::BTreeMap, sync::Arc};
use tokio_util::sync::CancellationToken;

pub(crate) const LIST: &str = "McpList";
pub(crate) const INSTALL: &str = "McpInstall";
pub(crate) const UPDATE: &str = "McpUpdate";
pub(crate) const UNINSTALL: &str = "McpUninstall";
pub(crate) const NAMES: &[&str] = &[LIST, INSTALL, UPDATE, UNINSTALL];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
enum McpScope {
    User,
    Project,
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListInput {}

#[derive(Clone, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallInput {
    /// Unique MCP server name (ASCII letters, digits, underscores, hyphens).
    name: String,
    /// Where to save the server: "user" (~/.maka/mcp.json, default) or "project" (<workspace>/.maka/mcp.json).
    #[serde(default)]
    scope: Option<McpScope>,
    /// Exact config file location ("user:maka", "user:agents", "project:maka", "project:agents"). Overrides scope.
    #[serde(default)]
    location: Option<LocationId>,
    /// Optional transport type ("stdio" or "http"); inferred automatically from command vs url when omitted.
    #[serde(rename = "type", default)]
    transport: Option<String>,
    /// Executable for a stdio MCP server (for example "npx", "uvx", or an absolute binary path).
    #[serde(default)]
    command: Option<String>,
    /// Command-line arguments for a stdio MCP server.
    #[serde(default)]
    args: Vec<String>,
    /// Working directory for a stdio MCP server.
    #[serde(default)]
    cwd: Option<String>,
    /// Environment variables passed to a stdio MCP server.
    #[serde(default)]
    env: BTreeMap<String, String>,
    /// Host environment variable names forwarded to a stdio MCP server.
    #[serde(default)]
    pass_env: Vec<String>,
    /// Streamable HTTP endpoint URL for a remote MCP server.
    #[serde(default)]
    url: Option<String>,
    /// Static HTTP headers for a Streamable HTTP MCP server.
    #[serde(default)]
    headers: BTreeMap<String, String>,
    /// Map of HTTP header name to Host environment variable name.
    #[serde(default)]
    header_env: BTreeMap<String, String>,
    /// Save the server disabled without starting it.
    #[serde(default)]
    disabled: bool,
    /// Optional allowlist of remote tool names to expose from this server.
    #[serde(default)]
    tools: Option<Vec<String>>,
    /// Startup timeout in milliseconds (default 10000).
    #[serde(default)]
    startup_timeout_ms: Option<u64>,
    /// Per-call timeout in milliseconds (default 120000).
    #[serde(default)]
    call_timeout_ms: Option<u64>,
    /// Set true to overwrite an existing server with the same name at the target location.
    #[serde(default)]
    overwrite: bool,
    /// Set true to skip live startup verification before saving.
    #[serde(default)]
    skip_verify: bool,
}

#[derive(Clone, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateInput {
    /// Existing MCP server name to update.
    name: String,
    /// Optional scope ("user" or "project") when disambiguating servers with the same name.
    #[serde(default)]
    scope: Option<McpScope>,
    /// Optional exact location ("user:maka", "user:agents", "project:maka", "project:agents").
    #[serde(default)]
    location: Option<LocationId>,
    /// Optional transport type ("stdio" or "http").
    #[serde(rename = "type", default)]
    transport: Option<String>,
    /// Replacement executable for a stdio MCP server.
    #[serde(default)]
    command: Option<String>,
    /// Replacement arguments for a stdio MCP server.
    #[serde(default)]
    args: Option<Vec<String>>,
    /// Replacement working directory for a stdio MCP server.
    #[serde(default)]
    cwd: Option<String>,
    /// Environment variables to add or overwrite (existing unmentioned keys are preserved).
    #[serde(default)]
    env: BTreeMap<String, String>,
    /// Environment variable keys to remove.
    #[serde(default)]
    remove_env: Vec<String>,
    /// Replacement list of Host environment variable names to forward.
    #[serde(default)]
    pass_env: Option<Vec<String>>,
    /// Replacement URL for a Streamable HTTP MCP server.
    #[serde(default)]
    url: Option<String>,
    /// HTTP headers to add or overwrite (existing unmentioned keys are preserved).
    #[serde(default)]
    headers: BTreeMap<String, String>,
    /// HTTP header names to remove.
    #[serde(default)]
    remove_headers: Vec<String>,
    /// Replacement map of HTTP header name to Host environment variable name.
    #[serde(default)]
    header_env: Option<BTreeMap<String, String>>,
    /// Enable (false) or disable (true) this server.
    #[serde(default)]
    disabled: Option<bool>,
    /// Replacement allowlist of remote tool names.
    #[serde(default)]
    tools: Option<Vec<String>>,
    /// Set true to clear any remote tool allowlist and expose all discovered tools.
    #[serde(default)]
    clear_tools: bool,
    /// Replacement startup timeout in milliseconds.
    #[serde(default)]
    startup_timeout_ms: Option<u64>,
    /// Replacement per-call timeout in milliseconds.
    #[serde(default)]
    call_timeout_ms: Option<u64>,
    /// Set true to skip live startup verification before saving.
    #[serde(default)]
    skip_verify: bool,
}

#[derive(Clone, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UninstallInput {
    /// MCP server name to uninstall.
    name: String,
    /// Optional scope ("user" or "project") when disambiguating servers with the same name.
    #[serde(default)]
    scope: Option<McpScope>,
    /// Optional exact location ("user:maka", "user:agents", "project:maka", "project:agents").
    #[serde(default)]
    location: Option<LocationId>,
}

fn schema_for<T: schemars::JsonSchema>() -> Value {
    maka_tool_catalog::input::inline_refs(
        serde_json::to_value(schemars::schema_for!(T)).expect("MCP management tool schema"),
    )
}

pub(in crate::owner) fn declarations() -> Vec<ToolRegistration> {
    [
        (
            LIST,
            "List configured MCP servers across user and project mcp.json files, including masked secret keys, shadowing, project consent status, and currently connected tools.",
            schema_for::<ListInput>(),
            ToolSemantics::Parallel,
        ),
        (
            INSTALL,
            "Install a new MCP server into user (~/.maka/mcp.json) or project (<workspace>/.maka/mcp.json) configuration. Verifies the server starts cleanly before saving (unless disabled or skipVerify is true). Requires user approval outside Full Access; new MCP tools become callable starting on the next turn.",
            schema_for::<InstallInput>(),
            ToolSemantics::ExclusiveStep,
        ),
        (
            UPDATE,
            "Update an existing MCP server configuration (patch fields, toggle disabled, or add/remove env/headers while preserving unmentioned secrets; changing url clears inherited headers/headerEnv and changing command clears inherited env/passEnv). Verifies enabled servers before saving unless skipVerify is true. Requires user approval outside Full Access; changes take effect on the next turn.",
            schema_for::<UpdateInput>(),
            ToolSemantics::ExclusiveStep,
        ),
        (
            UNINSTALL,
            "Remove an MCP server from user or project mcp.json configuration and stop idle connections. Requires user approval outside Full Access; tool removal takes effect on the next turn.",
            schema_for::<UninstallInput>(),
            ToolSemantics::ExclusiveStep,
        ),
    ]
    .into_iter()
    .map(|(name, description, input_schema, semantics)| ToolRegistration {
        definition: ToolDefinition {
            provider: None,
            name: name.into(),
            description: description.into(),
            input_schema,
            output_schema: None,
            freeform: None,
        },
        nesting: ToolNesting::Nestable,
        semantics,
        handler: ToolHandler::Declaration(name.into()),
    })
    .collect()
}

pub(in crate::owner) fn bind_for_run(
    owner: Arc<Owner>,
    access: Arc<RunAccess>,
    declarations: &crate::tools::Declarations,
    tools: maka_tools::ToolCatalog,
) -> Result<maka_tools::ToolCatalog, String> {
    let present: Vec<&str> = NAMES
        .iter()
        .copied()
        .filter(|name| tools.contains(name))
        .collect();
    if present.is_empty() {
        return Ok(tools);
    }
    let preparer: Arc<dyn ToolPreparer> = Arc::new(McpTools { owner, access });
    let handlers: Vec<_> = present
        .iter()
        .map(|name| ((*name).to_owned(), ToolHandler::Prepared(preparer.clone())))
        .collect();
    tools
        .excluding(&present)
        .with_rebound_from(declarations.as_catalog(), handlers)
        .map_err(|error| error.to_string())
}

struct McpTools {
    owner: Arc<Owner>,
    access: Arc<RunAccess>,
}

impl ToolPreparer for McpTools {
    fn names(&self) -> Vec<String> {
        NAMES.iter().map(|name| (*name).to_owned()).collect()
    }

    fn prepare(
        &self,
        name: String,
        input: Value,
        context: ToolCallContext,
        cancellation: CancellationToken,
    ) -> PreparationFuture {
        let owner = self.owner.clone();
        let access = self.access.clone();
        Box::pin(async move {
            access.target_for_context(&context).await.map_err(|error| {
                ToolRejection::PreparationFailed {
                    message: error.to_string(),
                }
            })?;
            if cancellation.is_cancelled() {
                return Err(ToolRejection::Cancelled);
            }
            match name.as_str() {
                LIST => {
                    serde_json::from_value::<ListInput>(input).map_err(|error| {
                        ToolRejection::InvalidInput {
                            message: format!("Invalid McpList arguments: {error}"),
                        }
                    })?;
                    Ok(PreparedEffect::new(move |cancel| {
                        Box::pin(async move { execute_list(owner, access, cancel).await })
                    }))
                }
                INSTALL => {
                    let confirmation_input = input.clone();
                    let parsed: InstallInput = serde_json::from_value(input).map_err(|error| {
                        ToolRejection::InvalidInput {
                            message: format!("Invalid McpInstall arguments: {error}"),
                        }
                    })?;
                    prepare_install(
                        owner,
                        access,
                        parsed,
                        confirmation_input,
                        context,
                        cancellation,
                    )
                    .await
                }
                UPDATE => {
                    let confirmation_input = input.clone();
                    let parsed: UpdateInput = serde_json::from_value(input).map_err(|error| {
                        ToolRejection::InvalidInput {
                            message: format!("Invalid McpUpdate arguments: {error}"),
                        }
                    })?;
                    prepare_update(
                        owner,
                        access,
                        parsed,
                        confirmation_input,
                        context,
                        cancellation,
                    )
                    .await
                }
                UNINSTALL => {
                    let confirmation_input = input.clone();
                    let parsed: UninstallInput =
                        serde_json::from_value(input).map_err(|error| {
                            ToolRejection::InvalidInput {
                                message: format!("Invalid McpUninstall arguments: {error}"),
                            }
                        })?;
                    prepare_uninstall(
                        owner,
                        access,
                        parsed,
                        confirmation_input,
                        context,
                        cancellation,
                    )
                    .await
                }
                _ => Err(ToolRejection::Unavailable),
            }
        })
    }
}

fn scope_of(id: LocationId) -> McpScope {
    match id {
        LocationId::ProjectMaka | LocationId::ProjectAgents => McpScope::Project,
        LocationId::UserMaka | LocationId::UserAgents => McpScope::User,
    }
}

fn default_location(scope: Option<McpScope>) -> LocationId {
    match scope.unwrap_or(McpScope::User) {
        McpScope::User => LocationId::UserMaka,
        McpScope::Project => LocationId::ProjectMaka,
    }
}

fn is_project_location(id: LocationId) -> bool {
    matches!(id, LocationId::ProjectMaka | LocationId::ProjectAgents)
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum McpMutationPolicy {
    Denied(String),
    RequireApproval,
    AllowDirect,
}

async fn mcp_mutation_policy(
    access: &RunAccess,
) -> Result<(McpMutationPolicy, ResolvedConfiguration), String> {
    let live = access
        .live_configuration()
        .await
        .map_err(|error| error.to_string())?;
    let spec_sandbox = &access.spec().permission_ceiling.sandbox;
    let policy = if !crate::mcp::floor_allows_mcp(spec_sandbox) {
        McpMutationPolicy::Denied("MCP configuration cannot be modified in a read-only run.".into())
    } else if live.permissions.access == WorkspaceAccess::ReadOnly {
        McpMutationPolicy::Denied("MCP configuration cannot be modified in read-only mode.".into())
    } else if matches!(spec_sandbox, maka_sandbox::Sandbox::Disabled)
        && live.permissions.access == WorkspaceAccess::DangerFullAccess
    {
        McpMutationPolicy::AllowDirect
    } else {
        McpMutationPolicy::RequireApproval
    };
    Ok((policy, live))
}

async fn request_write_approval(
    access: &Arc<RunAccess>,
    policy: &McpMutationPolicy,
    context: &ToolCallContext,
    tool_name: &str,
    method: &str,
    binding: &str,
    confirmation_input: &Value,
    cancellation: &CancellationToken,
) -> Result<Option<ApprovalId>, ToolRejection> {
    match policy {
        McpMutationPolicy::Denied(message) => {
            return Err(ToolRejection::PolicyDenied {
                message: message.clone(),
            });
        }
        McpMutationPolicy::AllowDirect => return Ok(None),
        McpMutationPolicy::RequireApproval => {}
    }
    access
        .require_execution()
        .await
        .map_err(|error| ToolRejection::PreparationFailed {
            message: error.to_string(),
        })?;
    let target = access.target_for_context(context).await.map_err(|error| {
        ToolRejection::PreparationFailed {
            message: error.to_string(),
        }
    })?;
    let approval = if matches!(target, AuthorizationObligation::Tool { .. }) {
        access
            .establish_service(
                context,
                tool_name,
                method,
                binding,
                "mcp",
                confirmation_input,
                cancellation,
            )
            .await
            .map(|(_, approval)| approval)
    } else {
        access
            .confirm_service(
                context,
                tool_name,
                method,
                binding,
                "mcp",
                confirmation_input,
                cancellation,
            )
            .await
    }
    .map_err(|error| ToolRejection::PreparationFailed {
        message: error.to_string(),
    })?;
    Ok(Some(approval))
}

fn build_install_entry(input: &InstallInput) -> Result<Value, String> {
    let mut map = Map::new();
    if let Some(transport) = &input.transport {
        map.insert("type".into(), Value::String(transport.clone()));
    }
    if let Some(command) = &input.command {
        map.insert("command".into(), Value::String(command.clone()));
    }
    if !input.args.is_empty() {
        map.insert("args".into(), json!(input.args));
    }
    if let Some(cwd) = &input.cwd {
        map.insert("cwd".into(), Value::String(cwd.clone()));
    }
    if !input.env.is_empty() {
        map.insert("env".into(), json!(input.env));
    }
    if !input.pass_env.is_empty() {
        map.insert("passEnv".into(), json!(input.pass_env));
    }
    if let Some(url) = &input.url {
        map.insert("url".into(), Value::String(url.clone()));
    }
    if !input.headers.is_empty() {
        map.insert("headers".into(), json!(input.headers));
    }
    if !input.header_env.is_empty() {
        map.insert("headerEnv".into(), json!(input.header_env));
    }
    if input.disabled {
        map.insert("disabled".into(), Value::Bool(true));
    }
    if let Some(tools) = &input.tools {
        map.insert("tools".into(), json!(tools));
    }
    if let Some(timeout) = input.startup_timeout_ms {
        map.insert("startupTimeoutMs".into(), json!(timeout));
    }
    if let Some(timeout) = input.call_timeout_ms {
        map.insert("callTimeoutMs".into(), json!(timeout));
    }
    Ok(Value::Object(map))
}

fn collect_credential_keys(entry: &Value) -> Vec<String> {
    let mut keys = std::collections::BTreeSet::new();
    let Some(obj) = entry.as_object() else {
        return Vec::new();
    };
    for field in ["env", "headers", "headerEnv"] {
        if let Some(map) = obj.get(field).and_then(Value::as_object) {
            keys.extend(map.keys().cloned());
        }
    }
    if let Some(list) = obj.get("passEnv").and_then(Value::as_array) {
        keys.extend(list.iter().filter_map(Value::as_str).map(ToOwned::to_owned));
    }
    keys.into_iter().collect()
}

fn inherited_credential_keys(existing: &Value, patched: &Value) -> Vec<String> {
    let before: std::collections::BTreeSet<String> =
        collect_credential_keys(existing).into_iter().collect();
    collect_credential_keys(patched)
        .into_iter()
        .filter(|key| before.contains(key))
        .collect()
}

fn approval_method(
    action: &str,
    target_id: LocationId,
    entry: Option<&Value>,
    will_verify: Option<bool>,
    inherited_credentials: &[String],
) -> String {
    let mut details = vec![target_id.reference().to_owned()];
    if let Some(verify) = will_verify {
        details.push(if verify { "verify" } else { "no-verify" }.to_owned());
    }
    if let Some(obj) = entry.and_then(Value::as_object) {
        if let Some(url) = obj.get("url").and_then(Value::as_str) {
            details.push(format!("target: {}", masked_url_origin(url)));
        } else if let Some(command) = obj.get("command").and_then(Value::as_str) {
            details.push(format!("target: {command}"));
        }
    }
    if !inherited_credentials.is_empty() {
        details.push(format!("inherits: {}", inherited_credentials.join(", ")));
    }
    format!("{action}[{}]", details.join(", "))
}

fn apply_update_patch(
    existing: &Value,
    input: &UpdateInput,
) -> Result<(Value, Vec<String>), String> {
    let mut map = existing
        .as_object()
        .cloned()
        .ok_or("Existing MCP server configuration must be an object")?;
    let switching_to_http = input.url.is_some() && input.command.is_none()
        || input
            .transport
            .as_deref()
            .is_some_and(|kind| matches!(kind, "http" | "streamable-http" | "streamable_http"));
    let switching_to_stdio = input.command.is_some() && input.url.is_none()
        || input.transport.as_deref() == Some("stdio");
    let url_changed = input
        .url
        .as_deref()
        .is_some_and(|next| map.get("url").and_then(Value::as_str) != Some(next));
    let command_changed = input
        .command
        .as_deref()
        .is_some_and(|next| map.get("command").and_then(Value::as_str) != Some(next));
    let mut cleared = std::collections::BTreeSet::new();
    let record_removed =
        |map: &mut Map<String, Value>,
         key: &str,
         cleared: &mut std::collections::BTreeSet<String>| {
            if let Some(removed) = map.remove(key) {
                match removed {
                    Value::Object(entries) => {
                        cleared.extend(entries.into_iter().map(|(key, _)| key))
                    }
                    Value::Array(items) => {
                        cleared.extend(
                            items
                                .into_iter()
                                .filter_map(|v| v.as_str().map(str::to_owned)),
                        );
                    }
                    _ => {}
                }
            }
        };
    if switching_to_http {
        for key in ["command", "args", "cwd"] {
            map.remove(key);
        }
        record_removed(&mut map, "env", &mut cleared);
        record_removed(&mut map, "passEnv", &mut cleared);
    } else if switching_to_stdio {
        map.remove("url");
        record_removed(&mut map, "headers", &mut cleared);
        record_removed(&mut map, "headerEnv", &mut cleared);
    }
    // Changing the endpoint URL or executable command must not silently forward
    // previously stored secrets to a different target.
    if url_changed {
        record_removed(&mut map, "headers", &mut cleared);
        record_removed(&mut map, "headerEnv", &mut cleared);
    }
    if command_changed {
        record_removed(&mut map, "env", &mut cleared);
        record_removed(&mut map, "passEnv", &mut cleared);
    }
    if let Some(transport) = &input.transport {
        map.insert("type".into(), Value::String(transport.clone()));
    } else if switching_to_http || switching_to_stdio {
        map.remove("type");
    }
    if let Some(command) = &input.command {
        map.insert("command".into(), Value::String(command.clone()));
    }
    if let Some(args) = &input.args {
        if args.is_empty() {
            map.remove("args");
        } else {
            map.insert("args".into(), json!(args));
        }
    }
    if let Some(cwd) = &input.cwd {
        if cwd.is_empty() {
            map.remove("cwd");
        } else {
            map.insert("cwd".into(), Value::String(cwd.clone()));
        }
    }
    if !input.env.is_empty() || !input.remove_env.is_empty() {
        let mut env = map
            .get("env")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for key in &input.remove_env {
            env.remove(key);
        }
        for (key, value) in &input.env {
            env.insert(key.clone(), Value::String(value.clone()));
        }
        if env.is_empty() {
            map.remove("env");
        } else {
            map.insert("env".into(), Value::Object(env));
        }
    }
    if let Some(pass_env) = &input.pass_env {
        if pass_env.is_empty() {
            map.remove("passEnv");
        } else {
            map.insert("passEnv".into(), json!(pass_env));
        }
    }
    if let Some(url) = &input.url {
        map.insert("url".into(), Value::String(url.clone()));
    }
    if !input.headers.is_empty() || !input.remove_headers.is_empty() {
        let mut headers = map
            .get("headers")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for key in &input.remove_headers {
            headers.remove(key);
        }
        for (key, value) in &input.headers {
            headers.insert(key.clone(), Value::String(value.clone()));
        }
        if headers.is_empty() {
            map.remove("headers");
        } else {
            map.insert("headers".into(), Value::Object(headers));
        }
    }
    if let Some(header_env) = &input.header_env {
        if header_env.is_empty() {
            map.remove("headerEnv");
        } else {
            map.insert("headerEnv".into(), json!(header_env));
        }
    }
    if let Some(disabled) = input.disabled {
        if disabled {
            map.insert("disabled".into(), Value::Bool(true));
        } else {
            map.remove("disabled");
        }
    }
    if input.clear_tools {
        map.remove("tools");
    } else if let Some(tools) = &input.tools {
        map.insert("tools".into(), json!(tools));
    }
    if let Some(timeout) = input.startup_timeout_ms {
        map.insert("startupTimeoutMs".into(), json!(timeout));
    }
    if let Some(timeout) = input.call_timeout_ms {
        map.insert("callTimeoutMs".into(), json!(timeout));
    }
    Ok((Value::Object(map), cleared.into_iter().collect()))
}

fn masked_url_origin(raw: &str) -> String {
    match reqwest::Url::parse(raw) {
        Ok(parsed) => {
            let origin = parsed.origin().ascii_serialization();
            if origin == "null" {
                "[redacted url]".into()
            } else {
                origin
            }
        }
        Err(_) => "[invalid url]".into(),
    }
}

fn summarize_entry_masked(entry: &Value) -> Value {
    let Some(obj) = entry.as_object() else {
        return json!({ "invalid": true });
    };
    let mut summary = Map::new();
    let is_http = obj.get("url").is_some();
    summary.insert(
        "type".into(),
        Value::String(if is_http { "http" } else { "stdio" }.into()),
    );
    if let Some(command) = obj.get("command").and_then(Value::as_str) {
        summary.insert("command".into(), Value::String(command.into()));
    }
    if let Some(args) = obj.get("args").and_then(Value::as_array) {
        summary.insert("argCount".into(), json!(args.len()));
    }
    if let Some(cwd) = obj.get("cwd").and_then(Value::as_str) {
        summary.insert("cwd".into(), Value::String(cwd.into()));
    }
    if let Some(env) = obj.get("env").and_then(Value::as_object) {
        let keys: Vec<Value> = env.keys().map(|k| Value::String(k.clone())).collect();
        if !keys.is_empty() {
            summary.insert("envKeys".into(), Value::Array(keys));
        }
    }
    if let Some(pass_env) = obj.get("passEnv").and_then(Value::as_array)
        && !pass_env.is_empty()
    {
        summary.insert("passEnv".into(), Value::Array(pass_env.clone()));
    }
    if let Some(url) = obj.get("url").and_then(Value::as_str) {
        summary.insert("origin".into(), Value::String(masked_url_origin(url)));
    }
    if let Some(headers) = obj.get("headers").and_then(Value::as_object) {
        let keys: Vec<Value> = headers.keys().map(|k| Value::String(k.clone())).collect();
        if !keys.is_empty() {
            summary.insert("headerKeys".into(), Value::Array(keys));
        }
    }
    if let Some(header_env) = obj.get("headerEnv").and_then(Value::as_object)
        && !header_env.is_empty()
    {
        summary.insert("headerEnv".into(), Value::Object(header_env.clone()));
    }
    Value::Object(summary)
}

async fn verify_server(
    owner: &Owner,
    location: &Location,
    config: ServerConfiguration,
    cancellation: CancellationToken,
) -> Result<Vec<String>, ToolError> {
    let uses_default_dir = matches!(
        &config.transport,
        maka_agent_facts::configuration::mcp::Transport::Stdio { cwd, .. }
            if cwd == &location.path.to_string_lossy()
    );
    let created_dir = if uses_default_dir {
        location.ensure_dir().map_err(ToolError::Failed)?
    } else {
        false
    };
    let result = async {
        let network = owner
            .configuration
            .network_configuration()
            .await
            .map_err(|_| ToolError::Failed("MCP network settings are unavailable".into()))?;
        let policy =
            maka_network::Policy::from_host_settings(&network.proxy, network.password.as_deref())
                .map_err(|_| ToolError::Failed("MCP network settings are invalid".into()))?;
        let connection = maka_mcp::Connection::connect_cancellable(config, policy, cancellation)
            .await
            .map_err(|error| {
                ToolError::Failed(format!(
                    "MCP server verification failed (not saved): {}. Fix the configuration or pass skipVerify: true to save anyway.",
                    error.message
                ))
            })?;
        let tools: Vec<String> = connection
            .tools()
            .iter()
            .map(|tool| tool.definition.name.clone())
            .collect();
        if let Err(error) = connection.close().await {
            tracing::warn!(error = %error.message, "MCP verification connection did not close cleanly");
        }
        Ok(tools)
    }
    .await;
    if result.is_err() && created_dir {
        location.remove_dir_if_empty();
    }
    result
}

fn find_existing_location(
    locations: &[Location],
    name: &str,
    scope: Option<McpScope>,
    exact: Option<LocationId>,
) -> Result<Option<(LocationId, String, String, Value)>, String> {
    let mut matches = Vec::new();
    for location in locations {
        if let Some(exact) = exact
            && location.id != exact
        {
            continue;
        }
        if let Some(scope) = scope
            && scope_of(location.id) != scope
        {
            continue;
        }
        let doc = location.read()?;
        if let Some(entry) = doc
            .value
            .get("mcpServers")
            .and_then(Value::as_object)
            .and_then(|entries| entries.get(name))
        {
            matches.push((
                location.id,
                location.file_path(),
                doc.revision,
                entry.clone(),
            ));
        }
    }
    match matches.len() {
        0 => Ok(None),
        1 => Ok(matches.into_iter().next()),
        _ => {
            let ids: Vec<_> = matches.iter().map(|(id, _, _, _)| id.reference()).collect();
            Err(format!(
                "MCP server '{name}' exists in multiple locations ({}). Specify location (or scope if unique within that scope) to disambiguate.",
                ids.join(", ")
            ))
        }
    }
}

async fn execute_list(
    owner: Arc<Owner>,
    access: Arc<RunAccess>,
    cancellation: CancellationToken,
) -> Result<ToolSuccess, ToolError> {
    if cancellation.is_cancelled() {
        return Err(ToolError::Failed("McpList cancelled".into()));
    }
    let live = access.live_configuration().await?;
    let floor_allowed = crate::mcp::floor_allows_mcp(&access.spec().permission_ceiling.sandbox);
    let effective_access = if floor_allowed {
        live.permissions.access
    } else {
        WorkspaceAccess::ReadOnly
    };
    let live_servers = access
        .current_model_tools(&live.workspace)
        .map(|(catalog, _)| catalog.mcp_server_tools_by_origin())
        .map_err(|error| {
            ToolError::Failed(format!("Unable to inspect live MCP connections: {error}"))
        })?;
    let file_connected_tools: BTreeMap<String, (LocationId, String, Vec<String>)> = live_servers
        .iter()
        .filter_map(|(name, (origin, tools))| match origin {
            crate::mcp::McpLayerOrigin::File {
                location,
                config_digest,
            } => Some((
                name.clone(),
                (*location, config_digest.clone(), tools.clone()),
            )),
            crate::mcp::McpLayerOrigin::Installation | crate::mcp::McpLayerOrigin::Client => None,
        })
        .collect();
    let project_status = if effective_access == WorkspaceAccess::ReadOnly {
        "disabled_in_read_only"
    } else {
        let proposal = owner
            .mcp_projects
            .proposal(&live.workspace)
            .await
            .map_err(ToolError::Failed)?;
        if !proposal.has_project_file() {
            "absent"
        } else {
            match owner
                .mcp_projects
                .decision(&proposal)
                .await
                .map_err(ToolError::Failed)?
            {
                Some(maka_config::ProjectMcpDecision::Trusted) => "trusted",
                Some(maka_config::ProjectMcpDecision::Declined) => "declined",
                None => "undecided",
            }
        }
    };
    let user_layer_active = effective_access != WorkspaceAccess::ReadOnly;
    let project_layer_active = user_layer_active && project_status == "trusted";
    let locations = owner
        .mcp_locations(
            (effective_access != WorkspaceAccess::ReadOnly).then_some(live.workspace.clone()),
        )
        .await
        .map_err(ToolError::Failed)?;
    let (servers, matched_file_servers) = tokio::task::spawn_blocking(move || {
        let mut selected: BTreeMap<String, LocationId> = BTreeMap::new();
        let mut matched_file_servers: std::collections::BTreeSet<String> =
            std::collections::BTreeSet::new();
        let mut servers = Vec::new();
        for location in locations {
            let doc = location.read()?;
            let file_path = location.file_path();
            let layer_active = if is_project_location(location.id) {
                project_layer_active
            } else {
                user_layer_active
            };
            if let Some(entries) = doc.value.get("mcpServers").and_then(Value::as_object) {
                for (name, config) in entries {
                    let disabled = config
                        .get("disabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let shadowed_by = if layer_active {
                        let existing = selected.get(name).copied();
                        selected.entry(name.clone()).or_insert(location.id);
                        existing
                    } else {
                        None
                    };
                    let active = layer_active && !disabled && shadowed_by.is_none();
                    let active_tools = if active {
                        let disk_digest =
                            files::normalize_server(name, config.clone(), &location.path)
                                .ok()
                                .flatten()
                                .map(|normalized| files::server_config_digest(&normalized));
                        file_connected_tools
                            .get(name)
                            .filter(|(origin, live_digest, _)| {
                                *origin == location.id
                                    && disk_digest.as_deref() == Some(live_digest.as_str())
                            })
                            .map(|(_, _, tools)| {
                                matched_file_servers.insert(name.clone());
                                tools.clone()
                            })
                    } else {
                        None
                    };
                    servers.push(json!({
                        "name": name,
                        "scope": scope_of(location.id),
                        "location": location.id,
                        "path": file_path,
                        "active": active,
                        "disabled": disabled,
                        "shadowedBy": shadowed_by,
                        "transport": summarize_entry_masked(config),
                        "connected": active_tools.is_some(),
                        "tools": active_tools.unwrap_or_default(),
                    }));
                }
            }
        }
        Ok::<_, String>((servers, matched_file_servers))
    })
    .await
    .map_err(|error| ToolError::Failed(error.to_string()))?
    .map_err(ToolError::Failed)?;

    let mut installation_servers = Vec::new();
    let mut client_servers = Vec::new();
    let mut retiring_servers = Vec::new();
    for (name, (origin, tools)) in live_servers {
        match origin {
            crate::mcp::McpLayerOrigin::Installation => {
                installation_servers.push(json!({
                    "name": name,
                    "scope": "installation",
                    "connected": true,
                    "tools": tools,
                }));
            }
            crate::mcp::McpLayerOrigin::Client => {
                client_servers.push(json!({
                    "name": name,
                    "scope": "client",
                    "connected": true,
                    "tools": tools,
                }));
            }
            crate::mcp::McpLayerOrigin::File { location, .. }
                if !matched_file_servers.contains(&name) =>
            {
                retiring_servers.push(json!({
                    "name": name,
                    "scope": scope_of(location),
                    "location": location,
                    "connected": true,
                    "retiring": true,
                    "tools": tools,
                }));
            }
            crate::mcp::McpLayerOrigin::File { .. } => {}
        }
    }

    Ok(ToolSuccess::from(json!({
        "permissionMode": effective_access,
        "projectMcpStatus": project_status,
        "servers": servers,
        "installationServers": installation_servers,
        "clientServers": client_servers,
        "retiringServers": retiring_servers,
    })))
}

/// Post-write trust transition derived inside the file lock.
/// Existing project configs advance trust atomically in SQLite only if the exact
/// pre-write revision is still `Trusted`; revoked, declined, or undecided revisions
/// are never overwritten.
enum PostWriteTrust {
    None,
    BrandNew(String),
    Advance { previous: String, next: String },
}

fn compute_post_write_trust(
    previous: Option<String>,
    next: Option<String>,
    allow_brand_new: bool,
) -> PostWriteTrust {
    match (previous, next) {
        (None, Some(next)) if allow_brand_new => PostWriteTrust::BrandNew(next),
        (Some(previous), Some(next)) if previous != next => {
            PostWriteTrust::Advance { previous, next }
        }
        _ => PostWriteTrust::None,
    }
}

async fn apply_post_write_trust(
    owner: &Owner,
    workspace: &Workspace,
    transition: PostWriteTrust,
) -> Result<(), ToolError> {
    let changed = match transition {
        PostWriteTrust::None => false,
        PostWriteTrust::BrandNew(revision) => {
            owner
                .mcp_projects
                .trust_project_revision(workspace, revision)
                .await
                .map_err(ToolError::Failed)?;
            true
        }
        PostWriteTrust::Advance { previous, next } => owner
            .mcp_projects
            .advance_project_trust(workspace, previous, next)
            .await
            .map_err(ToolError::Failed)?,
    };
    if changed && let Ok(root) = owner.store.owned_root() {
        root.capability_source_changed();
    }
    Ok(())
}

async fn verify_execution_policy(access: &RunAccess, approved: bool) -> Result<(), ToolError> {
    if approved {
        access.require_execution().await?;
    }
    let (policy, _) = mcp_mutation_policy(access)
        .await
        .map_err(ToolError::Failed)?;
    match policy {
        McpMutationPolicy::Denied(message) => Err(ToolError::Failed(message)),
        McpMutationPolicy::RequireApproval if !approved => Err(ToolError::Failed(
            "MCP configuration modification requires explicit approval.".into(),
        )),
        McpMutationPolicy::RequireApproval | McpMutationPolicy::AllowDirect => Ok(()),
    }
}

async fn resolve_location(
    owner: &Owner,
    workspace: &Workspace,
    target_id: LocationId,
) -> Result<Location, ToolError> {
    owner
        .mcp_locations(Some(workspace.clone()))
        .await
        .map_err(ToolError::Failed)?
        .into_iter()
        .find(|location| location.id == target_id)
        .ok_or_else(|| ToolError::Failed("MCP configuration location unavailable".into()))
}

/// Pre-probe CAS check without holding the file lock across network/process verification.
async fn verify_expected_revision(
    location: Location,
    tool_name: &'static str,
    expected_doc_revision: String,
) -> Result<(), ToolError> {
    tokio::task::spawn_blocking(move || {
        let document = location.read()?;
        if document.revision != expected_doc_revision {
            return Err(format!(
                "MCP configuration at {} changed on disk since {tool_name} was prepared; retry {tool_name}.",
                location.file_path()
            ));
        }
        Ok::<_, String>(())
    })
    .await
    .map_err(|error| ToolError::Failed(error.to_string()))?
    .map_err(ToolError::Failed)
}

/// Acquires `mcp-management.lock`, verifies `expected_doc_revision` CAS and cancellation, runs
/// `mutate` on `mcpServers`, writes atomically, advances project trust if still `Trusted`, and
/// retires superseded runtime snapshots.
#[allow(clippy::too_many_arguments)]
async fn commit_mcp_change<T, F>(
    owner: &Owner,
    workspace: &Workspace,
    location: Location,
    tool_name: &'static str,
    expected_doc_revision: String,
    allow_brand_new: bool,
    cancellation: CancellationToken,
    mutate: F,
) -> Result<(String, T), ToolError>
where
    T: Send + 'static,
    F: FnOnce(&Location, &mut Map<String, Value>) -> Result<T, String> + Send + 'static,
{
    let root = owner
        .store
        .owned_root()
        .map_err(|error| ToolError::Failed(error.to_string()))?;
    let target_id = location.id;
    let write_workspace = workspace.clone();
    let (path, output, post_trust) = tokio::task::spawn_blocking(move || {
        if cancellation.is_cancelled() {
            return Err(format!("{tool_name} cancelled"));
        }
        root.validate_current().map_err(|error| error.to_string())?;
        let _lease = maka_event_log::root::FileLease::acquire(
            &root.canonical_path().join("mcp-management.lock"),
        )
        .map_err(|error| error.to_string())?;
        if cancellation.is_cancelled() {
            return Err(format!("{tool_name} cancelled"));
        }
        let document = location.read()?;
        if document.revision != expected_doc_revision {
            return Err(format!(
                "MCP configuration at {} changed on disk since {tool_name} was prepared; retry {tool_name}.",
                location.file_path()
            ));
        }
        let pre_project_revision = if is_project_location(target_id) {
            crate::mcp::Projects::project_revision_blocking(&write_workspace)?
        } else {
            None
        };
        let mut value = document.value;
        let entries = value
            .as_object_mut()
            .ok_or("MCP configuration must be an object")?
            .entry("mcpServers")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or("mcpServers must be an object")?;
        let output = mutate(&location, entries)?;
        location.write(&value)?;
        let post_project_revision = if is_project_location(target_id) {
            crate::mcp::Projects::project_revision_blocking(&write_workspace)?
        } else {
            None
        };
        let post_trust =
            compute_post_write_trust(pre_project_revision, post_project_revision, allow_brand_new);
        root.capability_source_changed();
        Ok::<_, String>((location.file_path(), output, post_trust))
    })
    .await
    .map_err(|error| ToolError::Failed(error.to_string()))?
    .map_err(ToolError::Failed)?;

    apply_post_write_trust(owner, workspace, post_trust).await?;
    let retire_workspace = is_project_location(target_id).then_some(workspace);
    if let Err(error) = owner
        .mcp_projects
        .drop_stale_for_scope(retire_workspace)
        .await
    {
        tracing::warn!(error = %error, tool = tool_name, "MCP stale snapshot retirement failed after write");
    }
    Ok((path, output))
}

async fn prepare_install(
    owner: Arc<Owner>,
    access: Arc<RunAccess>,
    input: InstallInput,
    confirmation_input: Value,
    context: ToolCallContext,
    cancellation: CancellationToken,
) -> Result<PreparedEffect, ToolRejection> {
    let (policy, live) = mcp_mutation_policy(&access)
        .await
        .map_err(|message| ToolRejection::PreparationFailed { message })?;
    if let McpMutationPolicy::Denied(message) = policy {
        return Err(ToolRejection::PolicyDenied { message });
    }
    let target_id = input
        .location
        .unwrap_or_else(|| default_location(input.scope));
    let entry =
        build_install_entry(&input).map_err(|message| ToolRejection::InvalidInput { message })?;
    let locations = owner
        .mcp_locations(Some(live.workspace.clone()))
        .await
        .map_err(|message| ToolRejection::PreparationFailed { message })?;
    let location = locations
        .into_iter()
        .find(|location| location.id == target_id)
        .ok_or_else(|| ToolRejection::InvalidInput {
            message: format!("MCP configuration location {target_id:?} is unavailable."),
        })?;
    // Validate config and check overwrite conflict before bothering the user with an approval prompt.
    let precheck_name = input.name.clone();
    let precheck_entry = entry.clone();
    let overwrite = input.overwrite;
    let (normalized, expected_doc_revision) = tokio::task::spawn_blocking(move || {
        let normalized = files::normalize_server(&precheck_name, precheck_entry, &location.path)?;
        let doc = location.read()?;
        if !overwrite
            && doc
                .value
                .get("mcpServers")
                .and_then(Value::as_object)
                .is_some_and(|entries| entries.contains_key(&precheck_name))
        {
            return Err(format!(
                "MCP server '{precheck_name}' already exists at {}. Use McpUpdate to modify it or pass overwrite: true.",
                location.file_path()
            ));
        }
        Ok::<_, String>((normalized, doc.revision))
    })
    .await
    .map_err(|error| ToolRejection::PreparationFailed {
        message: error.to_string(),
    })?
    .map_err(|message| ToolRejection::InvalidInput { message })?;

    let binding = format!(
        "mcp:install:{}:{expected_doc_revision}",
        target_id.reference()
    );
    let method = approval_method(
        "install",
        target_id,
        Some(&entry),
        Some(normalized.is_some() && !input.skip_verify),
        &[],
    );
    let approval = request_write_approval(
        &access,
        &policy,
        &context,
        INSTALL,
        &method,
        &binding,
        &confirmation_input,
        &cancellation,
    )
    .await?;
    let approved = approval.is_some();
    let workspace = live.workspace;
    let prepared = PreparedEffect::new(move |cancel| {
        Box::pin(async move {
            execute_install(
                owner,
                access,
                workspace,
                target_id,
                input,
                entry,
                normalized,
                expected_doc_revision,
                approved,
                cancel,
            )
            .await
        })
    });
    Ok(match approval {
        Some(id) => prepared.requiring_approval(id),
        None => prepared,
    })
}

#[allow(clippy::too_many_arguments)]
async fn execute_install(
    owner: Arc<Owner>,
    access: Arc<RunAccess>,
    workspace: Workspace,
    target_id: LocationId,
    input: InstallInput,
    entry: Value,
    normalized: Option<ServerConfiguration>,
    expected_doc_revision: String,
    approved: bool,
    cancellation: CancellationToken,
) -> Result<ToolSuccess, ToolError> {
    if cancellation.is_cancelled() {
        return Err(ToolError::Failed("McpInstall cancelled".into()));
    }
    verify_execution_policy(&access, approved).await?;
    let location = resolve_location(&owner, &workspace, target_id).await?;
    verify_expected_revision(location.clone(), INSTALL, expected_doc_revision.clone()).await?;
    let (verified, tools) = match (normalized, input.skip_verify) {
        (Some(config), false) => (
            true,
            verify_server(&owner, &location, config, cancellation.clone()).await?,
        ),
        _ => (false, Vec::new()),
    };
    if cancellation.is_cancelled() {
        return Err(ToolError::Failed("McpInstall cancelled".into()));
    }
    verify_execution_policy(&access, approved).await?;
    let server_name = input.name.clone();
    let overwrite = input.overwrite;
    let (path, ()) = commit_mcp_change(
        &owner,
        &workspace,
        location,
        INSTALL,
        expected_doc_revision,
        true,
        cancellation,
        move |location, entries| {
            if !overwrite && entries.contains_key(&server_name) {
                return Err(format!(
                    "MCP server '{server_name}' already exists at {}. Use McpUpdate or pass overwrite: true.",
                    location.file_path()
                ));
            }
            files::validate_server(&server_name, entry.clone(), &location.path)?;
            entries.insert(server_name, entry);
            Ok(())
        },
    )
    .await?;

    Ok(ToolSuccess::from(json!({
        "status": "installed",
        "name": input.name,
        "scope": scope_of(target_id),
        "location": target_id,
        "path": path,
        "disabled": input.disabled,
        "verified": verified,
        "tools": tools,
        "effectiveFrom": "next_turn",
    })))
}

async fn prepare_update(
    owner: Arc<Owner>,
    access: Arc<RunAccess>,
    input: UpdateInput,
    confirmation_input: Value,
    context: ToolCallContext,
    cancellation: CancellationToken,
) -> Result<PreparedEffect, ToolRejection> {
    let (policy, live) = mcp_mutation_policy(&access)
        .await
        .map_err(|message| ToolRejection::PreparationFailed { message })?;
    if let McpMutationPolicy::Denied(message) = policy {
        return Err(ToolRejection::PolicyDenied { message });
    }
    let locations = owner
        .mcp_locations(Some(live.workspace.clone()))
        .await
        .map_err(|message| ToolRejection::PreparationFailed { message })?;
    let precheck_input = input.clone();
    let (
        target_id,
        expected_doc_revision,
        patched_entry,
        normalized,
        inherited_credentials,
        cleared_credentials,
    ) = tokio::task::spawn_blocking(move || {
        let Some((target_id, _, doc_revision, existing)) = find_existing_location(
            &locations,
            &precheck_input.name,
            precheck_input.scope,
            precheck_input.location,
        )?
        else {
            return Err(format!(
                "MCP server '{}' was not found. Use McpList to inspect configured servers or McpInstall to add it.",
                precheck_input.name
            ));
        };
        let location = locations
            .into_iter()
            .find(|location| location.id == target_id)
            .ok_or("MCP configuration location unavailable")?;
        let (patched, cleared) = apply_update_patch(&existing, &precheck_input)?;
        let inherited = inherited_credential_keys(&existing, &patched);
        let normalized =
            files::normalize_server(&precheck_input.name, patched.clone(), &location.path)?;
        Ok::<_, String>((
            target_id,
            doc_revision,
            patched,
            normalized,
            inherited,
            cleared,
        ))
    })
    .await
    .map_err(|error| ToolRejection::PreparationFailed {
        message: error.to_string(),
    })?
    .map_err(|message| ToolRejection::InvalidInput { message })?;

    let binding = format!(
        "mcp:update:{}:{expected_doc_revision}",
        target_id.reference()
    );
    let method = approval_method(
        "update",
        target_id,
        Some(&patched_entry),
        Some(normalized.is_some() && !input.skip_verify),
        &inherited_credentials,
    );
    let approval = request_write_approval(
        &access,
        &policy,
        &context,
        UPDATE,
        &method,
        &binding,
        &confirmation_input,
        &cancellation,
    )
    .await?;
    let approved = approval.is_some();
    let workspace = live.workspace;
    let prepared = PreparedEffect::new(move |cancel| {
        Box::pin(async move {
            execute_update(
                owner,
                access,
                workspace,
                target_id,
                input,
                expected_doc_revision,
                patched_entry,
                normalized,
                cleared_credentials,
                approved,
                cancel,
            )
            .await
        })
    });
    Ok(match approval {
        Some(id) => prepared.requiring_approval(id),
        None => prepared,
    })
}

#[allow(clippy::too_many_arguments)]
async fn execute_update(
    owner: Arc<Owner>,
    access: Arc<RunAccess>,
    workspace: Workspace,
    target_id: LocationId,
    input: UpdateInput,
    expected_doc_revision: String,
    patched_entry: Value,
    normalized: Option<ServerConfiguration>,
    cleared_credentials: Vec<String>,
    approved: bool,
    cancellation: CancellationToken,
) -> Result<ToolSuccess, ToolError> {
    if cancellation.is_cancelled() {
        return Err(ToolError::Failed("McpUpdate cancelled".into()));
    }
    verify_execution_policy(&access, approved).await?;
    let location = resolve_location(&owner, &workspace, target_id).await?;
    verify_expected_revision(location.clone(), UPDATE, expected_doc_revision.clone()).await?;
    let (verified, tools) = match (normalized, input.skip_verify) {
        (Some(config), false) => (
            true,
            verify_server(&owner, &location, config, cancellation.clone()).await?,
        ),
        _ => (false, Vec::new()),
    };
    if cancellation.is_cancelled() {
        return Err(ToolError::Failed("McpUpdate cancelled".into()));
    }
    verify_execution_policy(&access, approved).await?;
    let server_name = input.name.clone();
    let (path, disabled) = commit_mcp_change(
        &owner,
        &workspace,
        location,
        UPDATE,
        expected_doc_revision,
        false,
        cancellation,
        move |location, entries| {
            if !entries.contains_key(&server_name) {
                return Err(format!(
                    "MCP server '{server_name}' no longer exists at {}.",
                    location.file_path()
                ));
            }
            files::validate_server(&server_name, patched_entry.clone(), &location.path)?;
            let disabled = patched_entry
                .get("disabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            entries.insert(server_name, patched_entry);
            Ok(disabled)
        },
    )
    .await?;

    let mut payload = json!({
        "status": "updated",
        "name": input.name,
        "scope": scope_of(target_id),
        "location": target_id,
        "path": path,
        "disabled": disabled,
        "verified": verified,
        "tools": tools,
        "effectiveFrom": "next_turn",
    });
    if !cleared_credentials.is_empty() {
        payload["clearedCredentials"] = json!(cleared_credentials);
    }
    Ok(ToolSuccess::from(payload))
}

async fn prepare_uninstall(
    owner: Arc<Owner>,
    access: Arc<RunAccess>,
    input: UninstallInput,
    confirmation_input: Value,
    context: ToolCallContext,
    cancellation: CancellationToken,
) -> Result<PreparedEffect, ToolRejection> {
    let (policy, live) = mcp_mutation_policy(&access)
        .await
        .map_err(|message| ToolRejection::PreparationFailed { message })?;
    if let McpMutationPolicy::Denied(message) = policy {
        return Err(ToolRejection::PolicyDenied { message });
    }
    let locations = owner
        .mcp_locations(Some(live.workspace.clone()))
        .await
        .map_err(|message| ToolRejection::PreparationFailed { message })?;
    let precheck_input = input.clone();
    let (target_id, expected_doc_revision) = tokio::task::spawn_blocking(move || {
        find_existing_location(
            &locations,
            &precheck_input.name,
            precheck_input.scope,
            precheck_input.location,
        )?
        .map(|(id, _, rev, _)| (id, rev))
        .ok_or_else(|| {
            format!(
                "MCP server '{}' was not found. Use McpList to inspect configured servers.",
                precheck_input.name
            )
        })
    })
    .await
    .map_err(|error| ToolRejection::PreparationFailed {
        message: error.to_string(),
    })?
    .map_err(|message| ToolRejection::InvalidInput { message })?;

    let binding = format!(
        "mcp:uninstall:{}:{expected_doc_revision}",
        target_id.reference()
    );
    let method = approval_method("uninstall", target_id, None, None, &[]);
    let approval = request_write_approval(
        &access,
        &policy,
        &context,
        UNINSTALL,
        &method,
        &binding,
        &confirmation_input,
        &cancellation,
    )
    .await?;
    let approved = approval.is_some();
    let workspace = live.workspace;
    let prepared = PreparedEffect::new(move |cancel| {
        Box::pin(async move {
            execute_uninstall(
                owner,
                access,
                workspace,
                target_id,
                input,
                expected_doc_revision,
                approved,
                cancel,
            )
            .await
        })
    });
    Ok(match approval {
        Some(id) => prepared.requiring_approval(id),
        None => prepared,
    })
}

#[allow(clippy::too_many_arguments)]
async fn execute_uninstall(
    owner: Arc<Owner>,
    access: Arc<RunAccess>,
    workspace: Workspace,
    target_id: LocationId,
    input: UninstallInput,
    expected_doc_revision: String,
    approved: bool,
    cancellation: CancellationToken,
) -> Result<ToolSuccess, ToolError> {
    if cancellation.is_cancelled() {
        return Err(ToolError::Failed("McpUninstall cancelled".into()));
    }
    verify_execution_policy(&access, approved).await?;
    let location = resolve_location(&owner, &workspace, target_id).await?;
    let server_name = input.name.clone();
    let (path, ()) = commit_mcp_change(
        &owner,
        &workspace,
        location,
        UNINSTALL,
        expected_doc_revision,
        false,
        cancellation,
        move |location, entries| {
            if entries.remove(&server_name).is_none() {
                return Err(format!(
                    "MCP server '{server_name}' no longer exists at {}.",
                    location.file_path()
                ));
            }
            Ok(())
        },
    )
    .await?;

    Ok(ToolSuccess::from(json!({
        "status": "uninstalled",
        "name": input.name,
        "scope": scope_of(target_id),
        "location": target_id,
        "path": path,
        "effectiveFrom": "next_turn",
    })))
}
