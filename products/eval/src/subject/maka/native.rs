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

//! Trial-local native Host launcher using Maka's public Settings, Session, and Draft/Receipt APIs.
//!
//! Preserves product parity by invoking the released `maka` composition without benchmark-specific
//! instructions, tool narrowing, synthetic model overrides, or silent approval bypasses.

use super::{
    EnvironmentLimitation, HostedExecutionProjection, MakaHostInitSettingsPayload,
    MakaPublicSessionSettings, UnattendedInteractionBlock, bootstrap_maka_host_root,
};
use crate::measurement::{EvalMeteringGateway, GatewayConfig, MeteringState, derive_metering};
use crate::store::write_atomic_bytes;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use maka_app_client::{Client, Journal, Mutation, SubscriptionEvent};
use maka_host_runtime::application::host::Client as HostClient;
use maka_plugin_core::operation::OperationResult;
use maka_plugin_core::operation::{OperationCleanup, OperationOutcome, Receipt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;

/// Standard editor draft key used by the normal Maka Workbench composer.
const COMPOSER_DRAFT_KEY: &str = "composer";
/// Standard user-created conversation placeholder title before task input.
const DEFAULT_SESSION_TITLE: &str = "Task";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    maka_executable: PathBuf,
    root_path: PathBuf,
    artifact_root: PathBuf,
    base_url: String,
    host_settlement_timeout_ms: u64,
    host_init_settings: MakaHostInitSettingsPayload,
    execution: Execution,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Execution {
    execution_id: String,
    workspace_path: String,
    #[serde(default)]
    session_settings: MakaPublicSessionSettings,
    content: Content,
    max_steps: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Content {
    text: String,
}

struct SessionOutcome {
    status: String,
    failure_reason: Option<String>,
    operation_id: String,
    run_id: String,
    blocked_interaction: Option<UnattendedInteractionBlock>,
    environment_limitation: Option<EnvironmentLimitation>,
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("native Host reply is missing {key}"))
}

pub(crate) async fn commit_client_mutation(mutation: Mutation) -> Result<Value> {
    mutation.prepare().await?;
    match mutation.confirm().await?.receipt {
        Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: OperationResult::Success { value },
                },
            cleanup: OperationCleanup::Confirmed,
        } => Ok(value),
        Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: OperationResult::Failure { diagnostic },
                },
            cleanup: OperationCleanup::Confirmed,
        } => Err(diagnostic),
        _ => Err("native Host mutation did not produce a confirmed receipt".into()),
    }
}

pub(crate) async fn start_host_client(
    maka_executable: &Path,
    root_path: &Path,
    settlement_timeout_ms: u64,
    journal: Journal,
) -> Result<(Child, Client)> {
    let mut child = Command::new(maka_executable)
        .args(["host", "serve", "--root"])
        .arg(root_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("native Host spawn failed: {e}"))?;
    let mut stdout = BufReader::new(
        child
            .stdout
            .take()
            .ok_or("native Host stdout unavailable")?,
    );
    let mut ready = String::new();
    tokio::time::timeout(
        Duration::from_millis(settlement_timeout_ms),
        stdout.read_line(&mut ready),
    )
    .await
    .map_err(|_| "native Host startup timed out")?
    .map_err(|e| e.to_string())?;
    let ready: Value = serde_json::from_str(&ready)
        .map_err(|e| format!("invalid native Host ready message: {e}"))?;
    if ready["kind"] != "ready" {
        return Err("native Host did not become ready".into());
    }
    let epoch = text(&ready, "hostEpoch")?
        .parse()
        .map_err(|_| "invalid native Host epoch")?;
    let host = HostClient::connect(Path::new(text(&ready, "socketPath")?), Some(epoch)).await?;
    let client = Client::new(host, journal, "receipts".into())?;
    Ok((child, client))
}

pub(crate) async fn shutdown_host_client(
    child: &mut Child,
    client: &Client,
    deadline: Duration,
) -> Result<()> {
    tokio::time::timeout(deadline, async {
        client.close().await?;
        #[cfg(unix)]
        if let Some(pid) = child.id() {
            // Child retains the process handle and has not been reaped, so its PID
            // cannot identify a replacement process during this signal delivery.
            if unsafe { libc::kill(pid as i32, libc::SIGTERM) } != 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        #[cfg(not(unix))]
        child.start_kill().map_err(|e| e.to_string())?;
        let status = child.wait().await.map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("native Host did not shut down cleanly".into());
        }
        Ok(())
    })
    .await
    .map_err(|_| "native Host cleanup timed out".to_owned())?
}

async fn settings(client: &Client, method: &str, input: Value) -> Result<Value> {
    commit_client_mutation(
        client
            .settings_mutation(
                Uuid::new_v4(),
                "settings",
                method,
                input,
                Default::default(),
            )
            .await?,
    )
    .await
}

/// Applies workspace root registration and any explicitly declared public Assistant Preferences.
pub(crate) async fn apply_public_host_preferences(
    workspace_path: &str,
    session_settings: &MakaPublicSessionSettings,
    client: &Client,
) -> Result<()> {
    let current = client
        .query("settings", "workspaceLocations", json!({}))
        .await?;
    let source = current
        .get("source")
        .ok_or("native Host workspace source unavailable")?;
    let changed = settings(
        client,
        "updateWorkspaceLocations",
        json!({
            "source": source,
            "roots": [{"label": "Workspace", "path": workspace_path}]
        }),
    )
    .await?;
    if changed["status"] != "committed" {
        return Err("native Host workspace configuration was not committed".into());
    }

    let mut mutations = Vec::new();
    if let Some(mode) = &session_settings.sandbox_mode {
        mutations.push(json!({"kind": "default_sandbox", "mode": mode}));
    }
    if let Some(language) = &session_settings.language {
        mutations.push(json!({"kind": "language", "preference": language}));
    }
    if let Some(enabled) = session_settings.workspace_instructions {
        mutations.push(json!({"kind": "workspace_instructions", "enabled": enabled}));
    }

    for mutation in mutations {
        let preferences = client
            .query("settings", "assistantPreferences", json!({}))
            .await?;
        let changed = settings(
            client,
            "updateAssistantPreferences",
            json!({
                "expectedRevision": preferences["revision"],
                "mutation": mutation,
            }),
        )
        .await?;
        if changed["kind"] != "committed" {
            return Err("native Host preferences were not committed".into());
        }
    }
    Ok(())
}

pub(crate) fn sandbox_mode_to_workspace_access(mode: &str) -> Result<&'static str> {
    match mode {
        "read-only" => Ok("read_only"),
        "workspace-write" => Ok("workspace_write"),
        "danger-full-access" => Ok("danger_full_access"),
        _ => Err(format!("unsupported sandboxMode: {mode}")),
    }
}

async fn export_history(client: &Client, session: &str, path: &Path) -> Result<()> {
    let mut through = Value::Null;
    let mut position = json!({"kind":"start"});
    let mut cursors = std::collections::BTreeSet::new();
    let mut pages = Vec::new();
    loop {
        let page = client
            .query(
                "agent",
                "history",
                json!({"sessionId":session,"through":through,"position":position}),
            )
            .await?;
        let fence = page
            .get("through")
            .ok_or("history fence unavailable")?
            .clone();
        if !through.is_null() && through != fence {
            return Err("history fence changed".into());
        }
        through = fence;
        let after = page
            .get("after")
            .ok_or("history continuation unavailable")?
            .clone();
        pages.push(page);
        if after.is_null() {
            break;
        }
        if !cursors.insert(after.to_string()) {
            return Err("history pagination cycle".into());
        }
        position = json!({"kind":"after", "cursor":after});
    }
    let bytes = serde_json::to_vec(&pages).map_err(|e| e.to_string())?;
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || write_atomic_bytes(&path, &bytes))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

async fn observe_pending_interaction(
    client: &Client,
    session: &str,
    run: &str,
    artifact_root: &Path,
) -> Result<Option<UnattendedInteractionBlock>> {
    let pending = client
        .query(
            "agent",
            "pendingInteractions",
            json!({"sessionId": session}),
        )
        .await?;
    let Some(entries) = pending.get("entries").and_then(Value::as_array) else {
        return Ok(None);
    };
    let Some(first) = entries.first() else {
        return Ok(None);
    };
    let request_id = text(first, "requestId")?.to_owned();
    let kind = text(first, "kind")?.to_owned();
    let tool_use_id = first
        .get("toolUseId")
        .and_then(Value::as_str)
        .map(str::to_owned);

    let detail = client
        .query(
            "agent",
            "interaction",
            json!({"sessionId": session, "requestId": request_id}),
        )
        .await
        .unwrap_or(Value::Null);

    let evidence = json!({
        "sessionId": session,
        "runId": run,
        "entries": entries,
        "firstInteraction": detail,
    });
    if let Ok(bytes) = serde_json::to_vec(&evidence) {
        let _ = write_atomic_bytes(&artifact_root.join("unattended-interactions.json"), &bytes);
    }

    Ok(Some(UnattendedInteractionBlock {
        kind,
        request_id,
        tool_use_id,
    }))
}

async fn execute(
    request: &Request,
    client: &Client,
    stop: CancellationToken,
) -> Result<SessionOutcome> {
    let connections = client
        .query("settings", "connections", json!({"kind":"start"}))
        .await?;
    let connection = connections["connections"]
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|c| c["slug"] == request.host_init_settings.default_target.slug)
        })
        .ok_or("native Host connection unavailable")?;
    let backend = json!({
        "kind": "model",
        "connectionId": connection["basis"]["connectionId"],
        "modelId": request.host_init_settings.default_target.model_id,
        "thinkingLevel": request.execution.session_settings.thinking_level,
    });
    let created = commit_client_mutation(
        client
            .control(
                Uuid::new_v4(),
                "create",
                json!({
                    "title": DEFAULT_SESSION_TITLE,
                    "automaticTitle": false,
                    "labels": [],
                    "backend": backend,
                    "workspace": {
                        "kind": "directory",
                        "path": request.execution.workspace_path,
                    },
                    "tools": Value::Null,
                }),
            )
            .await?,
    )
    .await?;
    if created["kind"] != "created" {
        let reason = created
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("rejected");
        if reason == "workspace_unavailable" {
            return Ok(SessionOutcome {
                status: "failed".into(),
                failure_reason: Some("Environment limitation: workspace_unavailable".into()),
                operation_id: String::new(),
                run_id: String::new(),
                blocked_interaction: None,
                environment_limitation: Some(EnvironmentLimitation {
                    category: "workspace_unavailable".into(),
                    detail: format!(
                        "Host rejected workspace directory {}",
                        request.execution.workspace_path
                    ),
                }),
            });
        }
        return Err(format!("native Host rejected session creation: {reason}"));
    }

    let mut session_obj = created["session"].clone();
    let session = text(&session_obj, "id")?.to_owned();

    if let Some(request_permissions) = request.execution.session_settings.request_permissions {
        let access = match &request.execution.session_settings.sandbox_mode {
            Some(mode) => sandbox_mode_to_workspace_access(mode)?.to_owned(),
            None => session_obj["permissions"]["access"]
                .as_str()
                .unwrap_or("workspace_write")
                .to_owned(),
        };
        let revision = session_obj["revision"]
            .as_u64()
            .ok_or("session revision unavailable")?;
        let updated = commit_client_mutation(
            client
                .control(
                    Uuid::new_v4(),
                    "metadata",
                    json!({
                        "sessionId": session,
                        "expectedRevision": revision,
                        "title": DEFAULT_SESSION_TITLE,
                        "labels": [],
                        "permissions": {
                            "settings": {
                                "access": access,
                                "requestPermissions": request_permissions,
                            },
                            "revokeGrants": false,
                        },
                    }),
                )
                .await?,
        )
        .await?;
        if updated["kind"] != "committed" {
            return Err("native Host rejected public session permission settings".into());
        }
        session_obj = updated["session"].clone();
        let _ = session_obj;
    }

    let draft = client
        .save_draft(
            "agent",
            &session,
            COMPOSER_DRAFT_KEY,
            None,
            request.execution.content.text.clone().into(),
        )
        .await?;
    let operation = Uuid::new_v4();
    let mutation = client
        .reserve_send_draft(
            operation,
            "agent",
            &session,
            COMPOSER_DRAFT_KEY,
            draft.revision,
            json!({"backend": backend}),
        )
        .await?
        .open()
        .await?;
    let watch = client
        .subscribe("agent", "watch", json!({"sessionId": session, "after": 0}))
        .await?;
    let accepted = commit_client_mutation(mutation).await?;
    let run = match accepted["kind"].as_str() {
        Some("started") => text(&accepted, "runId")?.to_owned(),
        Some("queued") => {
            let message = text(&accepted, "messageId")?;
            let mut interval = tokio::time::interval(Duration::from_millis(100));
            loop {
                tokio::select! {
                    _ = stop.cancelled() => return Err("native Host cancelled before Run admission".into()),
                    _ = interval.tick() => {
                        let work = client.query("agent", "work", json!({"sessionId": session,
                            "target": {"kind": "message", "messageId": message}, "cursor": null})).await?;
                        match work["kind"].as_str() {
                            Some("delivered") => break text(&work["execution"], "runId")?.to_owned(),
                            Some("pending") => {},
                            _ => return Err("native Host could not resolve the original queued message".into()),
                        }
                    }
                }
            }
        }
        _ => {
            return Err(format!(
                "native Host rejected send: {}",
                accepted.get("reason").unwrap_or(&Value::Null)
            ));
        }
    };

    let receipt = json!({
        "executionId": request.execution.execution_id,
        "operationId": operation,
        "runId": run,
        "sessionId": session,
        "rootPath": request.root_path,
    });
    let bytes = serde_json::to_vec(&receipt).map_err(|e| e.to_string())?;
    tokio::fs::write(request.artifact_root.join("execution-receipt.json"), bytes)
        .await
        .map_err(|e| e.to_string())?;

    let mut interval = tokio::time::interval(Duration::from_millis(100));
    let mut steps = std::collections::BTreeSet::new();
    let mut stopping = false;
    let mut budget_exhausted = false;
    let mut blocked_interaction: Option<UnattendedInteractionBlock> = None;
    let mut environment_limitation: Option<EnvironmentLimitation> = None;
    let mut next = Box::pin(watch.next());

    let raw_status = loop {
        tokio::select! {
            _ = stop.cancelled(), if !stopping => {
                commit_client_mutation(client.control(Uuid::new_v4(), "stop", json!({"sessionId": session, "runId": run})).await?).await?;
                stopping = true;
            }
            event = &mut next => {
                match event? {
                    Some(SubscriptionEvent::Item(page)) => {
                        if let Some(events) = page.get("events").and_then(Value::as_array) {
                            for event in events.iter().filter(|event| event["runId"] == run) {
                                if event["fact"]["kind"] == "step_ended" {
                                    steps.insert(text(&event["fact"], "stepId")?.to_owned());
                                }
                            }
                        }
                        if !stopping && steps.len() >= request.execution.max_steps as usize {
                            let execution = client.query("agent", "execution", json!({"sessionId": session, "runId": run})).await?;
                            if matches!(execution["execution"]["state"]["kind"].as_str(), Some("admitted" | "running" | "waiting")) {
                                commit_client_mutation(client.control(Uuid::new_v4(), "stop", json!({"sessionId": session, "runId": run})).await?).await?;
                                stopping = true;
                                budget_exhausted = true;
                            }
                        }
                    }
                    _ => return Err("native Host execution watch ended before settlement".into()),
                }
                next = Box::pin(watch.next());
            }
            _ = interval.tick() => {
                let execution = client.query("agent", "execution", json!({"sessionId": session, "runId": run})).await?;
                if execution["kind"] != "found" {
                    return Err("native Host Run receipt unavailable".into());
                }
                let state = &execution["execution"]["state"];
                match state["kind"].as_str() {
                    Some("completed") => break "completed",
                    Some("failed") => {
                        if let Some(reason_kind) = state.pointer("/reason/kind").and_then(Value::as_str)
                            && reason_kind == "current_authority_unavailable"
                        {
                            environment_limitation = Some(EnvironmentLimitation {
                                category: "authority_unavailable".into(),
                                detail: "Run failed because host execution authority became unavailable".into(),
                            });
                        }
                        break "failed";
                    }
                    Some("cancelled") => break "cancelled",
                    Some("waiting") => {
                        if !stopping {
                            if let Some(interaction) = observe_pending_interaction(
                                client,
                                &session,
                                &run,
                                &request.artifact_root,
                            )
                            .await?
                            {
                                blocked_interaction = Some(interaction);
                                commit_client_mutation(
                                    client
                                        .control(
                                            Uuid::new_v4(),
                                            "stop",
                                            json!({"sessionId": session, "runId": run}),
                                        )
                                        .await?,
                                )
                                .await?;
                                stopping = true;
                            } else if state["authorityUnavailable"].as_bool() == Some(true) {
                                environment_limitation = Some(EnvironmentLimitation {
                                    category: "authority_unavailable".into(),
                                    detail: "Run waiting on unavailable host authority in headless environment".into(),
                                });
                                commit_client_mutation(
                                    client
                                        .control(
                                            Uuid::new_v4(),
                                            "stop",
                                            json!({"sessionId": session, "runId": run}),
                                        )
                                        .await?,
                                )
                                .await?;
                                stopping = true;
                            }
                        }
                    }
                    Some("admitted" | "running") => {
                        if !stopping
                            && let Some(interaction) = observe_pending_interaction(
                                client,
                                &session,
                                &run,
                                &request.artifact_root,
                            )
                            .await?
                        {
                            blocked_interaction = Some(interaction);
                            commit_client_mutation(
                                client
                                    .control(
                                        Uuid::new_v4(),
                                        "stop",
                                        json!({"sessionId": session, "runId": run}),
                                    )
                                    .await?,
                            )
                            .await?;
                            stopping = true;
                        }
                    }
                    _ => return Err("native Host returned an unknown Run state".into()),
                }
            }
        }
    };
    drop(next);
    watch.close().await?;

    let (status, failure_reason) = if let Some(block) = &blocked_interaction {
        (
            "failed".to_owned(),
            Some(format!(
                "Unattended execution blocked on required interaction: {}",
                block.kind
            )),
        )
    } else if let Some(limitation) = &environment_limitation {
        (
            "failed".to_owned(),
            Some(format!("Environment limitation: {}", limitation.category)),
        )
    } else if budget_exhausted {
        (
            "failed".to_owned(),
            Some("Maka step budget exhausted".into()),
        )
    } else if raw_status != "completed" {
        (
            raw_status.to_owned(),
            (raw_status == "failed").then(|| "Maka execution failed".into()),
        )
    } else {
        ("completed".to_owned(), None)
    };

    export_history(
        client,
        &session,
        &request.artifact_root.join("transcript.json"),
    )
    .await?;

    Ok(SessionOutcome {
        status,
        failure_reason,
        operation_id: operation.to_string(),
        run_id: run,
        blocked_interaction,
        environment_limitation,
    })
}

pub async fn run(payload: &str, stop: CancellationToken) -> Result<HostedExecutionProjection> {
    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| "invalid native Host payload")?;
    let request: Request = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let deadline = Duration::from_millis(request.host_settlement_timeout_ms);
    tokio::fs::create_dir_all(&request.artifact_root)
        .await
        .map_err(|e| e.to_string())?;
    let credential_name = &request
        .host_init_settings
        .connections
        .first()
        .ok_or("Eval connection missing")?
        .api_key;
    let key = std::env::var(credential_name).map_err(|_| "Eval provider credential unavailable")?;
    let credential = Uuid::new_v4().to_string();
    let gateway = EvalMeteringGateway::start(GatewayConfig {
        upstream_base_url: request.base_url.clone(),
        upstream_api_key: key,
        profile: "maka".into(),
        gateway_credential: credential.clone(),
        checkpoint_path: Some(request.artifact_root.join("metering-checkpoint.json")),
        checkpoint_secret: std::env::var("MAKA_EVAL_RESULT_TOKEN")
            .unwrap_or_else(|_| Uuid::new_v4().to_string()),
    })
    .await?;
    let settings = request.host_init_settings.with_endpoint_and_credential(
        gateway.base_url_matching_upstream(&request.base_url),
        credential,
    );
    tokio::time::timeout(
        deadline,
        bootstrap_maka_host_root(&request.maka_executable, &request.root_path, &settings),
    )
    .await
    .map_err(|_| "native Host initialization timed out")??;
    let journal = Journal::open(&request.artifact_root.join("client-journal.sqlite")).await?;
    let (mut child, client) = match start_host_client(
        &request.maka_executable,
        &request.root_path,
        request.host_settlement_timeout_ms,
        journal.clone(),
    )
    .await
    {
        Ok(pair) => pair,
        Err(err) => {
            gateway.stop_accepting();
            let _ = gateway.close().await;
            return Ok(HostedExecutionProjection::Settled {
                execution_id: request.execution.execution_id,
                status: "failed".into(),
                failure_reason: Some("Environment limitation: host_startup_failed".into()),
                usage: None,
                metering_state: MeteringState::Unknown,
                cost_usd: None,
                operation_id: None,
                invocation_id: None,
                blocked_interaction: None,
                environment_limitation: Some(Box::new(EnvironmentLimitation {
                    category: "host_startup_failed".into(),
                    detail: err,
                })),
            });
        }
    };
    let configured = apply_public_host_preferences(
        &request.execution.workspace_path,
        &request.execution.session_settings,
        &client,
    )
    .await;
    let cleanup = shutdown_host_client(&mut child, &client, deadline).await;
    configured?;
    cleanup?;
    let (mut child, client) = start_host_client(
        &request.maka_executable,
        &request.root_path,
        request.host_settlement_timeout_ms,
        journal,
    )
    .await?;
    let result = {
        let work = execute(&request, &client, stop.clone());
        tokio::pin!(work);
        tokio::select! {
            result = &mut work => result,
            _ = stop.cancelled() => tokio::time::timeout(deadline, &mut work).await
                .map_err(|_| "native Host cancellation did not settle".to_owned()).and_then(|result| result),
        }
    };
    gateway.stop_accepting();
    let cleanup = shutdown_host_client(&mut child, &client, deadline).await;
    let counts = tokio::time::timeout(deadline, gateway.close())
        .await
        .map_err(|_| "native Host metering did not settle")?;
    cleanup?;
    let outcome = result?;
    let metering = derive_metering(&counts);
    Ok(HostedExecutionProjection::Settled {
        execution_id: request.execution.execution_id,
        failure_reason: outcome.failure_reason,
        status: outcome.status,
        usage: counts.usage,
        metering_state: metering.metering_state,
        cost_usd: if metering.metering_state == MeteringState::Complete
            && request.host_init_settings.default_target.model_id == "deepseek-v4-flash"
        {
            metering.cost_usd
        } else {
            None
        },
        operation_id: (!outcome.operation_id.is_empty()).then_some(outcome.operation_id),
        invocation_id: (!outcome.run_id.is_empty()).then_some(outcome.run_id),
        blocked_interaction: outcome.blocked_interaction.map(Box::new),
        environment_limitation: outcome.environment_limitation.map(Box::new),
    })
}
