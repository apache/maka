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

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use maka_app_client::{Client, Journal, Mutation, Subscription, SubscriptionEvent};
use maka_capabilities::call::Attachments;
use maka_host_runtime::application::host::Client as HostClient;
use maka_plugin_core::operation::{OperationCleanup, OperationOutcome, OperationReply, Receipt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxMode {
    ReadOnly,
    WorkspaceWrite,
    #[default]
    DangerFullAccess,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuestRunRequest {
    pub instruction: String,
    pub workspace_dir: PathBuf,
    pub artifacts_dir: PathBuf,
    #[serde(default)]
    pub base_url: Option<String>,
    pub api_key: String,
    pub provider: String,
    pub connection_slug: String,
    pub model_id: String,
    pub sandbox_mode: SandboxMode,
    pub max_steps: u32,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GuestRunStatus {
    Completed,
    SubjectStopped,
    InfraFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuestRunResult {
    pub status: GuestRunStatus,
    pub steps_observed: u32,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    pub execution: Option<Value>,
    pub host_usage: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_usage_attempts: Option<Value>,
    pub transcript_file: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub infra_error: Option<String>,
}

impl GuestRunResult {
    fn infra_error(message: impl Into<String>) -> Self {
        Self {
            status: GuestRunStatus::InfraFailed,
            steps_observed: 0,
            session_id: None,
            run_id: None,
            execution: None,
            host_usage: None,
            host_usage_attempts: None,
            transcript_file: None,
            stop_reason: None,
            infra_error: Some(message.into()),
        }
    }
}

pub async fn run_from_files(request_file: &Path, result_file: &Path) -> Result<(), String> {
    let raw = tokio::fs::read_to_string(request_file)
        .await
        .map_err(|e| format!("failed to read {}: {e}", request_file.display()))?;
    // Delete the request file immediately so the container workspace cannot inspect the API key.
    let _ = tokio::fs::remove_file(request_file).await;

    let result = match serde_json::from_str::<GuestRunRequest>(&raw) {
        Ok(request) => execute(request)
            .await
            .unwrap_or_else(GuestRunResult::infra_error),
        Err(e) => GuestRunResult::infra_error(format!(
            "invalid guest request JSON {}: {e}",
            request_file.display()
        )),
    };

    if let Some(parent) = result_file.parent().filter(|p| !p.as_os_str().is_empty()) {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    }
    let encoded = serde_json::to_string_pretty(&result)
        .map_err(|e| format!("failed to serialize guest result: {e}"))?;
    tokio::fs::write(result_file, format!("{encoded}\n"))
        .await
        .map_err(|e| format!("failed to write {}: {e}", result_file.display()))?;

    if result.status == GuestRunStatus::InfraFailed {
        return Err(result
            .infra_error
            .unwrap_or_else(|| "maka host guest infrastructure failed".into()));
    }
    Ok(())
}

async fn execute(req: GuestRunRequest) -> Result<GuestRunResult, String> {
    if req.max_steps == 0 || req.timeout_ms == 0 {
        return Err("maxSteps and timeoutMs must be > 0".into());
    }
    let canonical_workspace = tokio::fs::canonicalize(&req.workspace_dir)
        .await
        .map_err(|e| {
            format!(
                "failed to canonicalize workspace {}: {e}",
                req.workspace_dir.display()
            )
        })?;
    let canonical_workspace_str = canonical_workspace.to_string_lossy().into_owned();
    tokio::fs::create_dir_all(&req.artifacts_dir)
        .await
        .map_err(|e| {
            format!(
                "failed to create artifacts dir {}: {e}",
                req.artifacts_dir.display()
            )
        })?;

    let run_dir = std::env::temp_dir().join(format!("maka-eval-host-{}", Uuid::new_v4()));
    tokio::fs::create_dir_all(&run_dir)
        .await
        .map_err(|e| format!("failed to create temp run dir: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&run_dir, std::fs::Permissions::from_mode(0o700))
            .await
            .map_err(|e| format!("failed to chmod temp run dir: {e}"))?;
    }
    let state_root = run_dir.join("root");
    let journal_path = run_dir.join("journal.sqlite");
    tokio::fs::create_dir_all(&state_root)
        .await
        .map_err(|e| format!("failed to create state root dir: {e}"))?;

    let maka_bin = resolve_maka_binary();
    let command_path = prepend_binary_dir_to_path(&maka_bin);

    let result = async {
        init_host(
            &maka_bin,
            &command_path,
            &state_root,
            &canonical_workspace_str,
            &req,
        )
        .await?;
        let mut host_proc = spawn_host_serve(&maka_bin, &command_path, &state_root).await?;

        let inner = run_session(&req, &canonical_workspace_str, &journal_path, &host_proc).await;
        let shutdown = host_proc.shutdown().await;

        let (mut result, session_err) = match inner {
            Ok(res) => (res, None),
            Err(err) => (GuestRunResult::infra_error(err.clone()), Some(err)),
        };
        if let Err(err) = shutdown {
            let combined = match session_err.or_else(|| result.infra_error.take()) {
                Some(existing) => format!("{existing}; host shutdown failed: {err}"),
                None => format!("host shutdown failed: {err}"),
            };
            result.status = GuestRunStatus::InfraFailed;
            result.infra_error = Some(combined);
        }
        Ok::<GuestRunResult, String>(result)
    }
    .await;

    let _ = tokio::fs::remove_dir_all(&run_dir).await;
    result
}

async fn run_session(
    req: &GuestRunRequest,
    canonical_workspace_str: &str,
    journal_path: &Path,
    host_proc: &HostServerProcess,
) -> Result<GuestRunResult, String> {
    let mut host_client = HostClient::connect(
        Path::new(&host_proc.socket_path),
        Some(host_proc.host_epoch),
    )
    .await
    .map_err(|e| {
        format!(
            "failed to connect to maka host socket {}: {e}",
            host_proc.socket_path
        )
    })?;

    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if let Some(error) = host_client.catalogue().startup_error() {
                return Err(format!("Host startup: {error:?}"));
            }
            let mut registered = true;
            for endpoint in ["agent", "settings", "receipts"] {
                registered &= host_client
                    .catalogue()
                    .describe(endpoint)
                    .map_err(|e| format!("describe {endpoint} failed: {e}"))?
                    .registration_epoch
                    .is_some();
            }
            if registered {
                return Ok::<(), String>(());
            }
            host_client
                .refresh()
                .await
                .map_err(|e| format!("Host refresh failed: {e}"))?;
            tokio::task::yield_now().await;
        }
    })
    .await
    .map_err(|_| "timed out waiting for Host readiness".to_owned())??;

    let journal = Journal::open(journal_path)
        .await
        .map_err(|e| format!("failed to open client journal: {e}"))?;
    let client = Client::new(host_client, journal, "receipts".into())
        .map_err(|e| format!("failed to create maka app client: {e}"))?;

    let outcome = run_session_with_client(req, canonical_workspace_str, &client).await;
    let close_res = client.close().await;
    match (outcome, close_res) {
        (Ok(res), Ok(())) => Ok(res),
        (Err(err), _) => Err(err),
        (Ok(_), Err(close_err)) => Err(format!("client close failed: {close_err}")),
    }
}

async fn run_session_with_client(
    req: &GuestRunRequest,
    canonical_workspace_str: &str,
    client: &Client,
) -> Result<GuestRunResult, String> {
    let connection_id = find_connection_id(client, &req.connection_slug).await?;
    let backend = json!({
        "kind": "model",
        "connectionId": connection_id,
        "modelId": req.model_id,
    });

    let created = commit(
        client
            .control(
                Uuid::new_v4(),
                "create",
                json!({
                    "title": "Eval Task",
                    "automaticTitle": false,
                    "labels": [],
                    "backend": backend,
                    "workspace": {
                        "kind": "directory",
                        "path": canonical_workspace_str,
                    },
                    "tools": Value::Null,
                }),
            )
            .await
            .map_err(|e| format!("create control open failed: {e}"))?,
    )
    .await?;

    if created["kind"] != "created" {
        return Err(format!("session creation rejected: {created}"));
    }
    let session_id = created["session"]["id"]
        .as_str()
        .ok_or_else(|| format!("created session missing id: {created}"))?
        .to_owned();

    let watch = client
        .subscribe(
            "agent",
            "watch",
            json!({ "sessionId": session_id, "after": 0 }),
        )
        .await
        .map_err(|e| format!("subscribe watch failed: {e}"))?;

    let run_outcome = async {
        let send = client
            .mutation(
                Uuid::new_v4(),
                "agent",
                "send",
                json!({
                    "sessionId": session_id,
                    "delivery": "steer",
                    "message": req.instruction,
                    "attachments": [],
                    "backend": backend,
                }),
                Attachments::new(),
                Some(session_id.clone()),
                Value::Null,
            )
            .await
            .map_err(|e| format!("agent.send open failed: {e}"))?;
        let deadline = tokio::time::Instant::now() + Duration::from_millis(req.timeout_ms);
        let accepted = commit(send).await?;
        let run_id = match accepted["kind"].as_str() {
            Some("started") => accepted["runId"]
                .as_str()
                .ok_or_else(|| format!("started response missing runId: {accepted}"))?
                .to_owned(),
            Some("queued") => {
                let message_id = accepted["messageId"]
                    .as_str()
                    .ok_or_else(|| format!("queued response missing messageId: {accepted}"))?;
                resolve_queued_run_id(client, &session_id, message_id, deadline, req.timeout_ms)
                    .await?
            }
            _ => return Err(format!("agent.send did not start or queue run: {accepted}")),
        };

        let (run_error, mut step_ids) =
            observe_run(client, &watch, &session_id, &run_id, req, deadline).await?;

        let final_execution = await_terminal_execution(client, &session_id, &run_id).await?;

        let transcript = export_history(client, &session_id, &run_id, &mut step_ids).await?;
        let transcript_file = req.artifacts_dir.join("transcript.json");
        let transcript_json = serde_json::to_string_pretty(&transcript)
            .map_err(|e| format!("failed to serialize transcript: {e}"))?;
        tokio::fs::write(&transcript_file, format!("{transcript_json}\n"))
            .await
            .map_err(|e| format!("failed to write transcript: {e}"))?;

        let host_usage = query_settled_usage_summary(client, &session_id).await?;
        let through_fence = host_usage
            .as_ref()
            .and_then(|u| u.get("through"))
            .cloned()
            .unwrap_or(Value::Null);
        let host_usage_attempts = Some(
            query_all_usage_attempts(client, &session_id, &run_id, through_fence, &mut step_ids)
                .await?,
        );

        let state_kind = final_execution
            .as_ref()
            .and_then(|e| e["state"]["kind"].as_str());
        let (status, stop_reason) = if run_error.is_none() && state_kind == Some("completed") {
            (GuestRunStatus::Completed, None)
        } else {
            let reason = run_error.unwrap_or_else(|| {
                format!(
                    "execution ended in state '{}': {}",
                    state_kind.unwrap_or("unknown"),
                    final_execution
                        .as_ref()
                        .map(|e| e["state"].to_string())
                        .unwrap_or_default()
                )
            });
            (GuestRunStatus::SubjectStopped, Some(reason))
        };

        Ok(GuestRunResult {
            status,
            steps_observed: u32::try_from(step_ids.len()).unwrap_or(u32::MAX),
            session_id: Some(session_id.clone()),
            run_id: Some(run_id),
            execution: final_execution,
            host_usage,
            host_usage_attempts,
            transcript_file: Some(transcript_file),
            stop_reason,
            infra_error: None,
        })
    }
    .await;

    let close_watch = watch.close().await;
    match (run_outcome, close_watch) {
        (Ok(res), Ok(())) => Ok(res),
        (Err(err), _) => Err(err),
        (Ok(_), Err(close_err)) => Err(format!("watch close failed: {close_err}")),
    }
}

async fn observe_run(
    client: &Client,
    watch: &Subscription,
    session_id: &str,
    run_id: &str,
    req: &GuestRunRequest,
    deadline: tokio::time::Instant,
) -> Result<(Option<String>, BTreeSet<String>), String> {
    let mut step_ids = BTreeSet::<String>::new();
    loop {
        let next_ev = tokio::select! {
            biased;
            _ = tokio::time::sleep_until(deadline) => {
                let reason = stop_with_reason(
                    client,
                    session_id,
                    run_id,
                    format!("execution timed out after {} ms", req.timeout_ms),
                )
                .await;
                return Ok((Some(reason), step_ids));
            }
            res = watch.next() => res,
        };
        match next_ev {
            Ok(Some(SubscriptionEvent::Item(page))) => match page["kind"].as_str() {
                Some("interactions") => {
                    if page["pending"]["entries"]
                        .as_array()
                        .is_some_and(|entries| !entries.is_empty())
                    {
                        let reason = stop_with_reason(
                            client,
                            session_id,
                            run_id,
                            format!(
                                "execution blocked by pending interaction: {}",
                                page["pending"]["entries"]
                            ),
                        )
                        .await;
                        return Ok((Some(reason), step_ids));
                    }
                }
                Some("events") => {
                    if let Some(events) = page["events"].as_array() {
                        for ev in events {
                            if ev["runId"].as_str() != Some(run_id) {
                                continue;
                            }
                            if let Some(step_id) = ev["fact"]["stepId"].as_str() {
                                step_ids.insert(step_id.to_owned());
                                if step_ids.len() > req.max_steps as usize {
                                    let reason = stop_with_reason(
                                        client,
                                        session_id,
                                        run_id,
                                        format!("exceeded maxSteps ({})", req.max_steps),
                                    )
                                    .await;
                                    return Ok((Some(reason), step_ids));
                                }
                            }
                            if ev["fact"]["kind"].as_str() == Some("ended") {
                                return Ok((None, step_ids));
                            }
                        }
                    }
                }
                _ => {}
            },
            Ok(Some(_)) | Ok(None) => return Err("watch stream closed before run settled".into()),
            Err(e) => return Err(format!("watch stream error: {e}")),
        }
    }
}

async fn resolve_queued_run_id(
    client: &Client,
    session_id: &str,
    message_id: &str,
    deadline: tokio::time::Instant,
    timeout_ms: u64,
) -> Result<String, String> {
    let input = json!({
        "sessionId": session_id,
        "target": { "kind": "message", "messageId": message_id },
        "cursor": Value::Null,
    });
    let mut poll = tokio::time::interval(Duration::from_millis(25));
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(deadline) => {
                return Err(format!(
                    "queued message '{message_id}' did not start execution before timeout ({timeout_ms} ms)"
                ));
            }
            _ = poll.tick() => {
                let work = client
                    .query("agent", "work", input.clone())
                    .await
                    .map_err(|e| format!("agent.work query failed: {e}"))?;
                match work["kind"].as_str() {
                    Some("delivered") => {
                        return work["execution"]["runId"]
                            .as_str()
                            .map(str::to_owned)
                            .ok_or_else(|| format!("agent.work delivered missing runId: {work}"));
                    }
                    Some("pending") => {}
                    _ => return Err(format!("queued send ended before execution: {work}")),
                }
            }
        }
    }
}

async fn find_connection_id(client: &Client, slug: &str) -> Result<String, String> {
    let page = client
        .query("settings", "connections", json!({ "kind": "start" }))
        .await
        .map_err(|e| format!("settings.connections query failed: {e}"))?;
    if page["kind"].as_str() != Some("ready") {
        return Err(format!("unexpected settings.connections response: {page}"));
    }
    page["connections"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|c| c["slug"].as_str() == Some(slug))
                .and_then(|c| c["basis"]["connectionId"].as_str())
                .map(str::to_owned)
        })
        .ok_or_else(|| format!("connection '{slug}' not found after host init"))
}

async fn await_terminal_execution(
    client: &Client,
    session_id: &str,
    run_id: &str,
) -> Result<Option<Value>, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut poll = tokio::time::interval(Duration::from_millis(50));
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let resp = client
            .query(
                "agent",
                "execution",
                json!({ "sessionId": session_id, "runId": run_id }),
            )
            .await
            .map_err(|e| format!("agent.execution query failed: {e}"))?;
        if resp["kind"].as_str() == Some("found") {
            let exec = &resp["execution"];
            if matches!(
                exec["state"]["kind"].as_str(),
                Some("completed" | "failed" | "cancelled")
            ) {
                return Ok(Some(exec.clone()));
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(None);
        }
        poll.tick().await;
    }
}

async fn query_settled_usage_summary(
    client: &Client,
    session_id: &str,
) -> Result<Option<Value>, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    let mut poll = tokio::time::interval(Duration::from_millis(50));
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let usage = client
            .query(
                "settings",
                "usageSummary",
                json!({
                    "range": {
                        "from": 0.0,
                        "to": 9_007_199_254_740_991.0,
                        "sessionId": session_id,
                        "through": null
                    },
                    "group": "byModel",
                    "cursor": null
                }),
            )
            .await
            .map_err(|e| format!("settings.usageSummary query failed: {e}"))?;
        if (usage["summary"]["pending"]["models"].as_u64() == Some(0)
            && usage["summary"]["pending"]["tools"].as_u64() == Some(0))
            || tokio::time::Instant::now() >= deadline
        {
            return Ok(Some(usage));
        }
        poll.tick().await;
    }
}

async fn query_all_usage_attempts(
    client: &Client,
    session_id: &str,
    run_id: &str,
    through_fence: Value,
    step_ids: &mut BTreeSet<String>,
) -> Result<Value, String> {
    let mut expected_fence = through_fence;
    let mut cursor = Value::Null;
    let mut attempts = Vec::<Value>::new();
    let total;
    loop {
        let page = client
            .query(
                "settings",
                "usage",
                json!({
                    "range": {
                        "from": 0.0,
                        "to": 9_007_199_254_740_991.0,
                        "sessionId": session_id,
                        "through": expected_fence,
                    },
                    "selection": {
                        "kind": "model",
                        "status": Value::Null,
                        "search": "",
                    },
                    "cursor": cursor,
                }),
            )
            .await
            .map_err(|e| format!("settings.usage query failed: {e}"))?;
        expected_fence = page
            .get("through")
            .ok_or("usage page missing through fence")?
            .clone();
        if let Some(page_attempts) = page["attempts"].as_array() {
            for item in page_attempts {
                if item["attempt"]["origin"]["execution"]["runId"].as_str() == Some(run_id)
                    && let Some(step) = item["attempt"]["origin"]["link"]["step"].as_str()
                {
                    step_ids.insert(step.to_owned());
                }
            }
            attempts.extend(page_attempts.iter().cloned());
        }
        let next = page
            .get("nextCursor")
            .ok_or("usage page missing nextCursor")?
            .clone();
        if next.is_null() {
            total = page["total"].as_u64().unwrap_or(attempts.len() as u64);
            break;
        }
        cursor = next;
    }
    Ok(json!({
        "through": expected_fence,
        "attempts": attempts,
        "total": total,
        "nextCursor": Value::Null,
    }))
}

async fn stop_with_reason(
    client: &Client,
    session_id: &str,
    run_id: &str,
    reason: String,
) -> String {
    match client
        .control(
            Uuid::new_v4(),
            "stop",
            json!({ "sessionId": session_id, "runId": run_id }),
        )
        .await
    {
        Ok(mutation) => match commit(mutation).await {
            Ok(_) => reason,
            Err(err) => format!("{reason}; stop failed: {err}"),
        },
        Err(err) => format!("{reason}; stop control open failed: {err}"),
    }
}

async fn export_history(
    client: &Client,
    session_id: &str,
    run_id: &str,
    step_ids: &mut BTreeSet<String>,
) -> Result<Value, String> {
    let mut through = Value::Null;
    let mut position = json!({ "kind": "start" });
    let mut pages = Vec::new();
    loop {
        let page = client
            .query(
                "agent",
                "history",
                json!({
                    "sessionId": session_id,
                    "through": through,
                    "position": position,
                    "includeThinking": true,
                }),
            )
            .await
            .map_err(|e| format!("agent.history query failed: {e}"))?;
        through = page
            .get("through")
            .ok_or("history page missing through fence")?
            .clone();
        if let Some(chunks) = page["chunks"].as_array() {
            for chunk in chunks {
                if chunk["runId"].as_str() == Some(run_id)
                    && let Some(step) = chunk["modelPart"]["stepId"].as_str()
                {
                    step_ids.insert(step.to_owned());
                }
            }
        }
        let after = page
            .get("after")
            .ok_or("history page missing after cursor")?
            .clone();
        pages.push(page);
        if after.is_null() {
            return Ok(json!({
                "sessionId": session_id,
                "through": through,
                "pages": pages,
            }));
        }
        position = json!({ "kind": "after", "cursor": after });
    }
}

async fn commit(mutation: Mutation) -> Result<Value, String> {
    mutation
        .prepare()
        .await
        .map_err(|e| format!("mutation prepare failed: {e}"))?;
    let reply = mutation
        .confirm()
        .await
        .map_err(|e| format!("mutation confirm failed: {e}"))?;
    returned(reply)
}

fn returned(reply: OperationReply) -> Result<Value, String> {
    match reply.receipt {
        Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: maka_plugin_core::operation::OperationResult::Success { value },
                },
            cleanup: OperationCleanup::Confirmed,
        } => Ok(value),
        Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: maka_plugin_core::operation::OperationResult::Failure { diagnostic },
                },
            cleanup: OperationCleanup::Confirmed,
        } => Err(diagnostic),
        Receipt::Recorded {
            outcome: OperationOutcome::NotExecuted { .. },
            cleanup: OperationCleanup::Confirmed,
        } => Err("mutation was prevented before execution".into()),
        other => Err(format!(
            "mutation did not return a confirmed outcome: {}",
            serde_json::to_string(&other).unwrap_or_default()
        )),
    }
}

fn resolve_maka_binary() -> PathBuf {
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        let sibling = dir.join("maka");
        if sibling.is_file() {
            return sibling;
        }
    }
    PathBuf::from("maka")
}

fn prepend_binary_dir_to_path(bin: &Path) -> String {
    let existing = std::env::var("PATH").unwrap_or_default();
    let Some(dir) = bin.parent().filter(|p| !p.as_os_str().is_empty()) else {
        return existing;
    };
    if existing.is_empty() {
        dir.to_string_lossy().into_owned()
    } else {
        format!("{}:{existing}", dir.display())
    }
}

fn build_init_settings(req: &GuestRunRequest, canonical_workspace_str: &str) -> Value {
    let mut connection = json!({
        "slug": req.connection_slug,
        "name": "Eval Target",
        "provider": req.provider,
        "apiKey": req.api_key,
        "enabled": true,
        "enabledModelIds": [req.model_id],
    });
    if let Some(base_url) = req.base_url.as_deref().filter(|s| !s.trim().is_empty()) {
        connection["configuration"] = json!({ "baseUrl": base_url });
    }
    json!({
        "chatDefaults": {
            "sandboxMode": req.sandbox_mode,
        },
        "projectDirectoryRoots": [{
            "label": "Harbor Workspace",
            "path": canonical_workspace_str,
        }],
        "connections": [connection],
        "defaultTarget": {
            "slug": req.connection_slug,
            "modelId": req.model_id,
        }
    })
}

async fn init_host(
    maka_bin: &Path,
    command_path: &str,
    state_root: &Path,
    canonical_workspace_str: &str,
    req: &GuestRunRequest,
) -> Result<(), String> {
    let settings = build_init_settings(req, canonical_workspace_str);
    let payload = serde_json::to_vec(&settings).map_err(|e| e.to_string())?;

    let mut child = Command::new(maka_bin)
        .args([
            "host",
            "init",
            "--settings-stdin",
            "--timeout-ms",
            "15000",
            "--root",
        ])
        .arg(state_root)
        .env("PATH", command_path)
        .env("NO_PROXY", "localhost,127.0.0.1,::1,host.docker.internal")
        .env("no_proxy", "localhost,127.0.0.1,::1,host.docker.internal")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn {}: {e}", maka_bin.display()))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(&payload)
            .await
            .map_err(|e| format!("failed writing init settings stdin: {e}"))?;
        stdin
            .shutdown()
            .await
            .map_err(|e| format!("failed closing init settings stdin: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("failed waiting for maka host init: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "maka host init failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

struct HostServerProcess {
    child: Child,
    socket_path: String,
    host_epoch: Uuid,
}

impl HostServerProcess {
    async fn shutdown(&mut self) -> Result<(), String> {
        let retire_res = HostClient::retire_with_options(
            Path::new(&self.socket_path),
            self.host_epoch,
            true,
            true,
        )
        .await;
        match tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await {
            Ok(Ok(_)) => match retire_res {
                Ok(true) => Ok(()),
                Ok(false) => Err("maka host serve declined retirement".into()),
                Err(e) => Err(format!("maka host retire failed: {e}")),
            },
            Ok(Err(e)) => Err(format!("wait failed: {e}")),
            Err(_) => {
                let _ = self.child.kill().await;
                let _ = self.child.wait().await;
                match retire_res {
                    Err(e) => Err(format!("maka host retire failed ({e}); process killed")),
                    Ok(_) => Err("maka host serve ignored retire and was killed".into()),
                }
            }
        }
    }
}

async fn spawn_host_serve(
    maka_bin: &Path,
    command_path: &str,
    state_root: &Path,
) -> Result<HostServerProcess, String> {
    let mut child = Command::new(maka_bin)
        .args(["host", "serve", "--root"])
        .arg(state_root)
        .env("PATH", command_path)
        .env("NO_PROXY", "localhost,127.0.0.1,::1,host.docker.internal")
        .env("no_proxy", "localhost,127.0.0.1,::1,host.docker.internal")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("failed to spawn maka host serve: {e}"))?;

    let stdout = child.stdout.take().ok_or("missing host stdout pipe")?;
    let mut stdout_lines = BufReader::new(stdout).lines();
    let ready_line = tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(line) = stdout_lines
            .next_line()
            .await
            .map_err(|e| format!("failed reading host stdout: {e}"))?
        {
            if let Ok(parsed) = serde_json::from_str::<Value>(&line)
                && parsed["kind"].as_str() == Some("ready")
            {
                return Ok::<Value, String>(parsed);
            }
        }
        Err("maka host serve exited before printing ready line".into())
    })
    .await
    .map_err(|_| "timed out waiting for maka host serve ready line".to_owned())??;

    // Keep draining remaining stdout lines so pipe never fills.
    tokio::spawn(async move { while let Ok(Some(_)) = stdout_lines.next_line().await {} });

    let socket_path = ready_line["socketPath"]
        .as_str()
        .ok_or_else(|| format!("ready line missing socketPath: {ready_line}"))?
        .to_owned();
    let epoch_str = ready_line["hostEpoch"]
        .as_str()
        .ok_or_else(|| format!("ready line missing hostEpoch: {ready_line}"))?;
    let host_epoch =
        Uuid::parse_str(epoch_str).map_err(|e| format!("invalid hostEpoch '{epoch_str}': {e}"))?;

    Ok(HostServerProcess {
        child,
        socket_path,
        host_epoch,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_request(base_url: Option<&str>) -> GuestRunRequest {
        GuestRunRequest {
            instruction: "Summarize logs".into(),
            workspace_dir: PathBuf::from("/app"),
            artifacts_dir: PathBuf::from("/tmp/artifacts"),
            base_url: base_url.map(str::to_owned),
            api_key: "sk-test".into(),
            provider: "deepseek".into(),
            connection_slug: "eval-target".into(),
            model_id: "deepseek-flash".into(),
            sandbox_mode: SandboxMode::DangerFullAccess,
            max_steps: 16,
            timeout_ms: 180_000,
        }
    }

    #[test]
    fn sandbox_mode_kebab_case_roundtrip_and_default() {
        assert_eq!(SandboxMode::default(), SandboxMode::DangerFullAccess);
        for (mode, expected) in [
            (SandboxMode::ReadOnly, "\"read-only\""),
            (SandboxMode::WorkspaceWrite, "\"workspace-write\""),
            (SandboxMode::DangerFullAccess, "\"danger-full-access\""),
        ] {
            let encoded = serde_json::to_string(&mode).unwrap();
            assert_eq!(encoded, expected);
            let decoded: SandboxMode = serde_json::from_str(&encoded).unwrap();
            assert_eq!(decoded, mode);
        }
    }

    #[test]
    fn build_init_settings_includes_chat_defaults_and_workspace_root() {
        let without_base = build_init_settings(&sample_request(None), "/app");
        assert_eq!(
            without_base["chatDefaults"]["sandboxMode"],
            json!("danger-full-access")
        );
        assert_eq!(
            without_base["projectDirectoryRoots"],
            json!([{ "label": "Harbor Workspace", "path": "/app" }])
        );
        assert!(
            without_base["connections"][0]
                .get("configuration")
                .is_none()
        );

        let with_base =
            build_init_settings(&sample_request(Some("https://example.invalid/v1")), "/app");
        assert_eq!(
            with_base["connections"][0]["configuration"],
            json!({ "baseUrl": "https://example.invalid/v1" })
        );
        assert_eq!(
            with_base["defaultTarget"],
            json!({ "slug": "eval-target", "modelId": "deepseek-flash" })
        );
    }

    #[tokio::test]
    async fn run_from_files_removes_request_file_immediately() {
        let dir = tempfile::tempdir().unwrap();
        let req_path = dir.path().join("request.json");
        let res_path = dir.path().join("result.json");
        tokio::fs::write(&req_path, r#"{"apiKey":"sk-secret-value","bad":true}"#)
            .await
            .unwrap();

        let err = run_from_files(&req_path, &res_path).await.unwrap_err();
        assert!(err.contains("invalid guest request JSON"));
        assert!(!req_path.exists());
        let saved: GuestRunResult =
            serde_json::from_str(&tokio::fs::read_to_string(&res_path).await.unwrap()).unwrap();
        assert_eq!(saved.status, GuestRunStatus::InfraFailed);
    }
}
