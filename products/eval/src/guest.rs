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
use std::sync::{Arc, Mutex};
use std::time::Duration;

use maka_app_client::{Client, Journal, Mutation, SubscriptionEvent};
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
    let request: GuestRunRequest = serde_json::from_str(&raw)
        .map_err(|e| format!("invalid guest request JSON {}: {e}", request_file.display()))?;

    let result = match execute(request).await {
        Ok(res) => res,
        Err(err) => GuestRunResult::infra_error(err),
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
    let state_root = run_dir.join("root");
    let journal_path = run_dir.join("journal.sqlite");
    tokio::fs::create_dir_all(&state_root)
        .await
        .map_err(|e| format!("failed to create state root dir: {e}"))?;

    let maka_bin = resolve_maka_binary()?;
    let command_path = prepend_binary_dir_to_path(&maka_bin);

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

    Ok(result)
}

async fn run_session(
    req: &GuestRunRequest,
    canonical_workspace_str: &str,
    journal_path: &Path,
    host_proc: &HostServerProcess,
) -> Result<GuestRunResult, String> {
    let socket_path = Path::new(&host_proc.socket_path);
    let mut host_client = HostClient::connect(socket_path, Some(host_proc.host_epoch))
        .await
        .map_err(|e| {
            format!(
                "failed to connect to maka host socket {}: {e} (stderr: {})",
                host_proc.socket_path,
                host_proc.stderr_summary()
            )
        })?;
    let status = HostClient::status(socket_path, Some(host_proc.host_epoch))
        .await
        .map_err(|e| format!("Host status failed: {e}"))?;
    if Some(status.pid.get()) != host_proc.child.id() {
        return Err("ready endpoint does not belong to the held Host child".into());
    }
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
    .map_err(|_| {
        format!(
            "timed out waiting for Host readiness (stderr: {})",
            host_proc.stderr_summary()
        )
    })??;
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

    let draft = client
        .save_draft(
            "agent",
            &session_id,
            "composer",
            None,
            req.instruction.clone().into(),
        )
        .await
        .map_err(|e| format!("save_draft failed: {e}"))?;

    let watch = client
        .subscribe(
            "agent",
            "watch",
            json!({ "sessionId": session_id, "after": 0 }),
        )
        .await
        .map_err(|e| format!("subscribe watch failed: {e}"))?;

    let run_outcome = async {
        let mutation = client
            .reserve_send_draft(
                Uuid::new_v4(),
                "agent",
                &session_id,
                "composer",
                draft.revision,
                json!({ "backend": backend }),
            )
            .await
            .map_err(|e| format!("reserve_send_draft failed: {e}"))?
            .open()
            .await
            .map_err(|e| format!("reserve_send_draft open failed: {e}"))?;
        let deadline = tokio::time::Instant::now() + Duration::from_millis(req.timeout_ms);
        let accepted = commit(mutation).await?;
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
            _ => return Err(format!("send did not start or queue run: {accepted}")),
        };

        let mut poll = tokio::time::interval(Duration::from_millis(200));
        poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut step_ids = BTreeSet::<String>::new();
        let mut final_execution: Option<Value> = None;
        let mut run_error: Option<String> = None;

        'observe: loop {
            let next = watch.next();
            tokio::pin!(next);
            let next_ev = loop {
                if tokio::time::Instant::now() >= deadline {
                    run_error = Some(
                        stop_with_reason(
                            client,
                            &session_id,
                            &run_id,
                            format!("execution timed out after {} ms", req.timeout_ms),
                        )
                        .await,
                    );
                    break 'observe;
                }
                tokio::select! {
                    biased;
                    _ = tokio::time::sleep_until(deadline) => {
                        run_error = Some(
                            stop_with_reason(
                                client,
                                &session_id,
                                &run_id,
                                format!("execution timed out after {} ms", req.timeout_ms),
                            )
                            .await,
                        );
                        break 'observe;
                    }
                    res = &mut next => break res,
                    _ = poll.tick() => {
                        if let Some(pending_err) = check_pending_interactions(client, &session_id).await? {
                            run_error = Some(
                                stop_with_reason(client, &session_id, &run_id, pending_err).await,
                            );
                            break 'observe;
                        }
                        if let Some(exec) = poll_terminal_execution(client, &session_id, &run_id).await? {
                            final_execution = Some(exec);
                            break 'observe;
                        }
                    }
                }
            };
            match next_ev {
                Ok(Some(SubscriptionEvent::Item(page))) => {
                    let mut ended_seen = false;
                    if let Some(events) = page["events"].as_array() {
                        for ev in events {
                            if ev["runId"].as_str() != Some(run_id.as_str()) {
                                continue;
                            }
                            if let Some(step_id) = ev["fact"]["stepId"].as_str() {
                                step_ids.insert(step_id.to_owned());
                                if step_ids.len() > req.max_steps as usize {
                                    run_error = Some(
                                        stop_with_reason(
                                            client,
                                            &session_id,
                                            &run_id,
                                            format!("exceeded maxSteps ({})", req.max_steps),
                                        )
                                        .await,
                                    );
                                    break;
                                }
                            }
                            if ev["fact"]["kind"].as_str() == Some("ended") {
                                ended_seen = true;
                            }
                        }
                    }
                    if run_error.is_some() {
                        break 'observe;
                    }
                    if ended_seen
                        && let Some(exec) =
                            poll_terminal_execution(client, &session_id, &run_id).await?
                    {
                        final_execution = Some(exec);
                        break 'observe;
                    }
                }
                Ok(Some(_)) | Ok(None) => {
                    if let Some(exec) = poll_terminal_execution(client, &session_id, &run_id).await? {
                        final_execution = Some(exec);
                        break 'observe;
                    }
                    return Err("watch stream closed before run settled".into());
                }
                Err(e) => {
                    return Err(format!("watch stream error: {e}"));
                }
            }
        }

        if final_execution.is_none() {
            final_execution = wait_for_terminal_execution(client, &session_id, &run_id).await?;
        }
        if final_execution.is_none() {
            final_execution = query_execution(client, &session_id, &run_id).await?;
        }

        let transcript = export_history(client, &session_id).await?;
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
            query_all_usage_attempts(client, &session_id, through_fence).await?,
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

async fn find_connection_id(client: &Client, slug: &str) -> Result<String, String> {
    let mut input = json!({ "kind": "start" });
    loop {
        let page = client
            .query("settings", "connections", input)
            .await
            .map_err(|e| format!("settings.connections query failed: {e}"))?;
        match page["kind"].as_str() {
            Some("ready") => {
                if let Some(connections) = page["connections"].as_array()
                    && let Some(row) = connections
                        .iter()
                        .find(|c| c["slug"].as_str() == Some(slug))
                    && let Some(id) = row["basis"]["connectionId"].as_str()
                {
                    return Ok(id.to_owned());
                }
                if page["next"].is_null() {
                    return Err(format!("connection '{slug}' not found after host init"));
                }
                input = json!({
                    "kind": "continue",
                    "revision": page["revision"],
                    "offset": page["next"],
                });
            }
            Some("changed") => {
                input = json!({ "kind": "start" });
            }
            _ => {
                return Err(format!("unexpected settings.connections response: {page}"));
            }
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
    let target = json!({
        "kind": "message",
        "messageId": message_id,
    });
    let mut poll = tokio::time::interval(Duration::from_millis(50));
    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "queued message '{message_id}' did not start execution before timeout ({timeout_ms} ms)"
            ));
        }
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => {
                return Err(format!(
                    "queued message '{message_id}' did not start execution before timeout ({timeout_ms} ms)"
                ));
            }
            _ = poll.tick() => {
                let work = client
                    .query(
                        "agent",
                        "work",
                        json!({
                            "sessionId": session_id,
                            "target": target,
                            "cursor": Value::Null,
                        }),
                    )
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
                    Some("cancelled" | "missing" | "changed") => {
                        return Err(format!("queued send ended before execution: {work}"));
                    }
                    _ => {
                        return Err(format!("unexpected agent.work response: {work}"));
                    }
                }
            }
        }
    }
}

async fn check_pending_interactions(
    client: &Client,
    session_id: &str,
) -> Result<Option<String>, String> {
    let pending = client
        .query(
            "agent",
            "pendingInteractions",
            json!({ "sessionId": session_id }),
        )
        .await
        .map_err(|e| format!("pendingInteractions query failed: {e}"))?;
    if pending["entries"]
        .as_array()
        .is_some_and(|entries| !entries.is_empty())
    {
        return Ok(Some(format!(
            "execution blocked by pending interaction: {}",
            pending["entries"]
        )));
    }
    Ok(None)
}

async fn query_execution(
    client: &Client,
    session_id: &str,
    run_id: &str,
) -> Result<Option<Value>, String> {
    let resp = client
        .query(
            "agent",
            "execution",
            json!({ "sessionId": session_id, "runId": run_id }),
        )
        .await
        .map_err(|e| format!("agent.execution query failed: {e}"))?;
    if resp["kind"].as_str() == Some("found") {
        Ok(Some(resp["execution"].clone()))
    } else {
        Ok(None)
    }
}

async fn poll_terminal_execution(
    client: &Client,
    session_id: &str,
    run_id: &str,
) -> Result<Option<Value>, String> {
    let Some(exec) = query_execution(client, session_id, run_id).await? else {
        return Ok(None);
    };
    if matches!(
        exec["state"]["kind"].as_str(),
        Some("completed" | "failed" | "cancelled")
    ) {
        return Ok(Some(exec));
    }
    Ok(None)
}

async fn wait_for_terminal_execution(
    client: &Client,
    session_id: &str,
    run_id: &str,
) -> Result<Option<Value>, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut poll = tokio::time::interval(Duration::from_millis(50));
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        if let Some(exec) = poll_terminal_execution(client, session_id, run_id).await? {
            return Ok(Some(exec));
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
        let pending_models = usage["summary"]["pending"]["models"].as_u64();
        if pending_models == Some(0) || tokio::time::Instant::now() >= deadline {
            return Ok(Some(usage));
        }
        poll.tick().await;
    }
}

async fn query_all_usage_attempts(
    client: &Client,
    session_id: &str,
    through_fence: Value,
) -> Result<Value, String> {
    collect_usage_attempt_pages(through_fence, |fence, cursor| async move {
        client
            .query(
                "settings",
                "usage",
                json!({
                    "range": {
                        "from": 0.0,
                        "to": 9_007_199_254_740_991.0,
                        "sessionId": session_id,
                        "through": fence,
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
            .map_err(|e| format!("settings.usage query failed: {e}"))
    })
    .await
}

async fn collect_usage_attempt_pages<F, Fut>(
    through_fence: Value,
    mut fetch_page: F,
) -> Result<Value, String>
where
    F: FnMut(Value, Value) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let mut expected_fence = through_fence;
    let mut cursor = Value::Null;
    let mut seen_cursors = BTreeSet::<String>::new();
    let mut attempts = Vec::<Value>::new();
    loop {
        let page = fetch_page(expected_fence.clone(), cursor).await?;
        let fence = page
            .get("through")
            .ok_or("usage page missing through fence")?
            .clone();
        if !expected_fence.is_null() && expected_fence != fence {
            return Err("usage fence changed during attempt pagination".into());
        }
        expected_fence = fence;
        let page_attempts = page["attempts"]
            .as_array()
            .ok_or("usage page missing attempts array")?;
        attempts.extend(page_attempts.iter().cloned());
        let total = page["total"]
            .as_u64()
            .ok_or("usage page missing numeric total")?;
        let next = page
            .get("nextCursor")
            .ok_or("usage page missing nextCursor")?
            .clone();
        if next.is_null() {
            if usize::try_from(total).ok() != Some(attempts.len()) {
                return Err(format!(
                    "usage attempt count mismatch: collected {}, total {total}",
                    attempts.len()
                ));
            }
            return Ok(json!({
                "through": expected_fence,
                "attempts": attempts,
                "total": total,
                "nextCursor": Value::Null,
            }));
        }
        let next_key = serde_json::to_string(&next).map_err(|e| e.to_string())?;
        if !seen_cursors.insert(next_key) {
            return Err("usage pagination cursor repeated".into());
        }
        cursor = next;
    }
}

async fn stop_with_reason(
    client: &Client,
    session_id: &str,
    run_id: &str,
    reason: String,
) -> String {
    match stop_run(client, session_id, run_id).await {
        Ok(()) => reason,
        Err(err) => format!("{reason}; stop failed: {err}"),
    }
}

async fn stop_run(client: &Client, session_id: &str, run_id: &str) -> Result<(), String> {
    let mutation = client
        .control(
            Uuid::new_v4(),
            "stop",
            json!({ "sessionId": session_id, "runId": run_id }),
        )
        .await
        .map_err(|e| format!("stop control open failed: {e}"))?;
    let _ = commit(mutation).await?;
    Ok(())
}

async fn export_history(client: &Client, session_id: &str) -> Result<Value, String> {
    let mut through = Value::Null;
    let mut position = json!({ "kind": "start" });
    let mut seen_cursors = BTreeSet::<String>::new();
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
        let fence = page
            .get("through")
            .ok_or("history page missing through fence")?
            .clone();
        if !through.is_null() && through != fence {
            return Err("history fence changed during export".into());
        }
        through = fence;
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
        if !seen_cursors.insert(after.to_string()) {
            return Err("history pagination cursor repeated".into());
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

fn resolve_maka_binary() -> Result<PathBuf, String> {
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        let sibling = dir.join("maka");
        if sibling.is_file() {
            return Ok(sibling);
        }
    }
    Ok(PathBuf::from("maka"))
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
    stderr_lines: Arc<Mutex<Vec<String>>>,
}

impl HostServerProcess {
    fn stderr_summary(&self) -> String {
        self.stderr_lines
            .lock()
            .map(|lines| lines.join(" | "))
            .unwrap_or_default()
    }

    async fn shutdown(&mut self) -> Result<(), String> {
        #[cfg(unix)]
        if let Some(pid) = self.child.id() {
            // SAFETY: self.child has not been waited yet, so its OS PID is live and owned by this Child handle.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
        }
        #[cfg(not(unix))]
        {
            let _ = self.child.start_kill();
        }
        match tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) => Err(format!("wait failed: {e}")),
            Err(_) => {
                let _ = self.child.kill().await;
                let _ = self.child.wait().await;
                Err("maka host serve ignored SIGTERM and was killed".into())
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
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn maka host serve: {e}"))?;

    let stdout = child.stdout.take().ok_or("missing host stdout pipe")?;
    let stderr = child.stderr.take().ok_or("missing host stderr pipe")?;

    let stderr_lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let stderr_buf = Arc::clone(&stderr_lines);
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(mut guard) = stderr_buf.lock() {
                if guard.len() >= 64 {
                    guard.remove(0);
                }
                guard.push(line);
            }
        }
    });

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
        stderr_lines,
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

    #[test]
    fn collect_usage_attempt_pages_merges_multi_page_and_guards_invariants() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        let mut seen_cursors = Vec::new();
        let merged = rt
            .block_on(collect_usage_attempt_pages(
                json!({ "sequence": 10 }),
                |fence, cursor| {
                    assert_eq!(fence, json!({ "sequence": 10 }));
                    seen_cursors.push(cursor.clone());
                    let page = if cursor.is_null() {
                        json!({
                            "through": fence,
                            "attempts": (0..32).map(|i| json!({ "id": i })).collect::<Vec<_>>(),
                            "total": 37,
                            "nextCursor": { "offset": 32 },
                        })
                    } else {
                        assert_eq!(cursor, json!({ "offset": 32 }));
                        json!({
                            "through": fence,
                            "attempts": (32..37).map(|i| json!({ "id": i })).collect::<Vec<_>>(),
                            "total": 37,
                            "nextCursor": Value::Null,
                        })
                    };
                    std::future::ready(Ok(page))
                },
            ))
            .unwrap();
        assert_eq!(seen_cursors, vec![Value::Null, json!({ "offset": 32 })]);
        assert_eq!(merged["total"], json!(37));
        assert_eq!(merged["attempts"].as_array().unwrap().len(), 37);
        assert_eq!(merged["attempts"][0]["id"], json!(0));
        assert_eq!(merged["attempts"][36]["id"], json!(36));
        assert!(merged["nextCursor"].is_null());

        let fence_drift = rt
            .block_on(collect_usage_attempt_pages(
                json!({ "sequence": 10 }),
                |_fence, _cursor| {
                    std::future::ready(Ok(json!({
                        "through": { "sequence": 11 },
                        "attempts": [],
                        "total": 0,
                        "nextCursor": Value::Null,
                    })))
                },
            ))
            .unwrap_err();
        assert!(fence_drift.contains("fence changed"));

        let count_mismatch = rt
            .block_on(collect_usage_attempt_pages(
                json!({ "sequence": 10 }),
                |fence, _cursor| {
                    std::future::ready(Ok(json!({
                        "through": fence,
                        "attempts": [{ "id": 0 }],
                        "total": 2,
                        "nextCursor": Value::Null,
                    })))
                },
            ))
            .unwrap_err();
        assert!(count_mismatch.contains("count mismatch"));

        let repeated_cursor = rt
            .block_on(collect_usage_attempt_pages(
                json!({ "sequence": 10 }),
                |fence, _cursor| {
                    std::future::ready(Ok(json!({
                        "through": fence,
                        "attempts": [{ "id": 0 }],
                        "total": 2,
                        "nextCursor": { "offset": 1 },
                    })))
                },
            ))
            .unwrap_err();
        assert!(repeated_cursor.contains("cursor repeated"));
    }
}
