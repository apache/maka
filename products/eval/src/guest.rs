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

use maka_agent_api::contract::{
    BackendPreference, Created, DeliveryFact, DeliveryPage, Execution, ExecutionResult,
    ExecutionState, HistoryPage, HistoryPosition, SendResult, Stopped, Work, WorkTarget,
};
use maka_agent_facts::accounting::{Activity, ActivityKind, Group, Origin, Selection};
use maka_agent_facts::durable::{RunId, StepId};
use maka_agent_state::usage::{UsageActivityCursor, UsageFence};
use maka_app_client::{Client, Journal, Mutation, Subscription, SubscriptionEvent};
use maka_capabilities::call::Attachments;
use maka_host_runtime::application::host::Client as HostClient;
use maka_plugin_core::operation::{OperationCleanup, OperationOutcome, OperationReply, Receipt};
use maka_sandbox::Mode as SandboxMode;
use maka_settings_native::contract::{DefaultModel, ModelsPage};
use maka_settings_native::usage::{Page as UsagePage, Report as UsageReport};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
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

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuestEvidence {
    pub steps_observed: u32,
    pub session_id: String,
    pub run_id: RunId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<Execution>,
    pub host_usage: UsageReport,
    pub host_usage_attempts: UsagePage,
}

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GuestRunResult {
    Completed {
        evidence: Box<GuestEvidence>,
    },
    SubjectStopped {
        stop_reason: String,
        evidence: Box<GuestEvidence>,
    },
    InfraFailed {
        infra_error: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        evidence: Option<Box<GuestEvidence>>,
    },
}

pub(crate) fn is_terminal_execution_state(state: &ExecutionState) -> bool {
    matches!(
        state,
        ExecutionState::Completed | ExecutionState::Failed { .. } | ExecutionState::Cancelled
    )
}

impl GuestRunResult {
    pub fn infra_error(message: impl Into<String>) -> Self {
        Self::InfraFailed {
            infra_error: message.into(),
            evidence: None,
        }
    }

    fn into_evidence(self) -> Option<Box<GuestEvidence>> {
        match self {
            Self::Completed { evidence } | Self::SubjectStopped { evidence, .. } => Some(evidence),
            Self::InfraFailed { evidence, .. } => evidence,
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

    if let GuestRunResult::InfraFailed { infra_error, .. } = result {
        return Err(infra_error);
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
        let mut host_proc =
            spawn_host_serve(&maka_bin, &command_path, &state_root, &req.artifacts_dir).await?;

        let inner = run_session(&req, &canonical_workspace_str, &journal_path, &host_proc).await;
        if matches!(inner, Ok(GuestRunResult::Completed { .. })) {
            host_proc.detach();
            return inner;
        }
        let shutdown = host_proc.shutdown().await;
        Ok::<GuestRunResult, String>(finalize_run_result(inner, shutdown))
    }
    .await;

    if !matches!(result, Ok(GuestRunResult::Completed { .. })) {
        let _ = tokio::fs::remove_dir_all(&run_dir).await;
    }
    result
}

fn finalize_run_result(
    inner: Result<GuestRunResult, String>,
    shutdown: Result<(), String>,
) -> GuestRunResult {
    match (inner, shutdown) {
        (Ok(res), Ok(())) => res,
        (Err(err), Ok(())) => GuestRunResult::infra_error(err),
        (Err(err), Err(shut_err)) => {
            GuestRunResult::infra_error(format!("{err}; host shutdown failed: {shut_err}"))
        }
        (Ok(res), Err(shut_err)) => GuestRunResult::InfraFailed {
            infra_error: format!("host shutdown failed: {shut_err}"),
            evidence: res.into_evidence(),
        },
    }
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
    let backend = resolve_backend(client, req).await?;

    let created: Created = commit_typed(
        "agent.create",
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

    let session_id = match created {
        Created::Created { session } => session.id,
        Created::Rejected { reason } => {
            return Err(format!(
                "session creation rejected: {}",
                serde_json::to_string(&reason).unwrap_or_default()
            ));
        }
    };

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
                }),
                Attachments::new(),
                Some(session_id.clone()),
                Value::Null,
            )
            .await
            .map_err(|e| format!("agent.send open failed: {e}"))?;
        let deadline = tokio::time::Instant::now() + Duration::from_millis(req.timeout_ms);
        let run_id = match commit_typed::<SendResult>("agent.send", send).await? {
            SendResult::Started { run_id, .. } => run_id,
            SendResult::Queued { message_id, .. } => {
                resolve_queued_run_id(client, &session_id, &message_id, deadline, req.timeout_ms)
                    .await?
            }
            SendResult::Rejected { reason, .. } => {
                return Err(format!(
                    "agent.send rejected: {}",
                    serde_json::to_string(&reason).unwrap_or_default()
                ));
            }
            SendResult::Posted { .. } | SendResult::NotYourWorker { .. } => {
                return Err("agent.send did not target an owned agent session".into());
            }
        };

        let (run_error, mut step_ids) =
            observe_run(client, &watch, &session_id, run_id, req, deadline).await?;

        let final_execution = await_terminal_execution(client, &session_id, run_id).await?;

        let transcript = export_history(client, &session_id).await?;
        let transcript_file = req.artifacts_dir.join("transcript.json");
        let transcript_json = serde_json::to_string_pretty(&transcript)
            .map_err(|e| format!("failed to serialize transcript: {e}"))?;
        tokio::fs::write(&transcript_file, format!("{transcript_json}\n"))
            .await
            .map_err(|e| format!("failed to write transcript: {e}"))?;

        let host_usage = query_settled_usage_summary(client, &session_id).await?;
        let host_usage_attempts = query_all_usage_attempts(
            client,
            &session_id,
            run_id,
            host_usage.through.clone(),
            &mut step_ids,
        )
        .await?;

        let evidence = GuestEvidence {
            steps_observed: u32::try_from(step_ids.len()).unwrap_or(u32::MAX),
            session_id: session_id.clone(),
            run_id,
            execution: final_execution,
            host_usage,
            host_usage_attempts,
        };
        if run_error.is_none()
            && matches!(
                evidence.execution.as_ref().map(|e| &e.state),
                Some(ExecutionState::Completed)
            )
        {
            Ok(GuestRunResult::Completed {
                evidence: Box::new(evidence),
            })
        } else {
            let stop_reason = run_error.unwrap_or_else(|| {
                let state = evidence
                    .execution
                    .as_ref()
                    .and_then(|e| serde_json::to_string(&e.state).ok())
                    .unwrap_or_else(|| "missing".into());
                format!("execution ended in non-completed state: {state}")
            });
            Ok(GuestRunResult::SubjectStopped {
                stop_reason,
                evidence: Box::new(evidence),
            })
        }
    }
    .await;

    let close_watch = watch.close().await;
    match (run_outcome, close_watch) {
        (Ok(res), Ok(())) => Ok(res),
        (Err(err), _) => Err(err),
        (Ok(_), Err(close_err)) => Err(format!("watch close failed: {close_err}")),
    }
}

fn delivery_fact_step_id(fact: &DeliveryFact) -> Option<StepId> {
    match fact {
        DeliveryFact::ExecutorMessageStarted { step_id, .. }
        | DeliveryFact::StepEnded { step_id, .. }
        | DeliveryFact::PartCommitted { step_id, .. }
        | DeliveryFact::Delta { step_id, .. }
        | DeliveryFact::ToolInputReady { step_id, .. } => Some(*step_id),
        _ => None,
    }
}

async fn observe_run(
    client: &Client,
    watch: &Subscription,
    session_id: &str,
    run_id: RunId,
    req: &GuestRunRequest,
    deadline: tokio::time::Instant,
) -> Result<(Option<String>, BTreeSet<StepId>), String> {
    let mut step_ids = BTreeSet::<StepId>::new();
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
            Ok(Some(SubscriptionEvent::Item(raw))) => {
                let page: DeliveryPage = serde_json::from_value(raw)
                    .map_err(|e| format!("watch page decode failed: {e}"))?;
                match page {
                    DeliveryPage::Interactions { pending } if !pending.entries.is_empty() => {
                        let request_ids: Vec<&str> = pending
                            .entries
                            .iter()
                            .map(|entry| entry.request_id.as_str())
                            .collect();
                        let reason = stop_with_reason(
                            client,
                            session_id,
                            run_id,
                            format!("execution blocked by pending interaction(s): {request_ids:?}"),
                        )
                        .await;
                        return Ok((Some(reason), step_ids));
                    }
                    DeliveryPage::Events { events, .. } => {
                        for ev in events {
                            if ev.run_id != run_id {
                                continue;
                            }
                            if let Some(step_id) = delivery_fact_step_id(&ev.fact) {
                                step_ids.insert(step_id);
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
                            if matches!(ev.fact, DeliveryFact::Ended { .. }) {
                                return Ok((None, step_ids));
                            }
                        }
                    }
                    _ => {}
                }
            }
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
) -> Result<RunId, String> {
    let input = json!({
        "sessionId": session_id,
        "target": WorkTarget::Message { message_id: message_id.to_owned() },
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
                match query_typed::<Work>(client, "agent", "work", input.clone()).await? {
                    Work::Delivered { execution, .. } => return Ok(execution.run_id),
                    Work::Pending => {}
                    other => {
                        let encoded = serde_json::to_string(&other).unwrap_or_default();
                        return Err(format!("queued send ended before execution: {encoded}"));
                    }
                }
            }
        }
    }
}

async fn resolve_backend(
    client: &Client,
    req: &GuestRunRequest,
) -> Result<BackendPreference, String> {
    let page: ModelsPage =
        query_typed(client, "settings", "models", json!({ "kind": "start" })).await?;
    let ModelsPage::Ready { default_model, .. } = page else {
        return Err("settings.models changed during host startup".into());
    };
    let DefaultModel::Ready { choice, .. } = *default_model else {
        return Err(format!(
            "default target '{}/{}' is unavailable after host init",
            req.connection_slug, req.model_id
        ));
    };
    if choice.selection.model_id != req.model_id {
        return Err(format!(
            "resolved default model '{}' does not match requested '{}'",
            choice.selection.model_id, req.model_id
        ));
    }
    Ok(BackendPreference::Model {
        connection_id: choice.selection.connection_id,
        model_id: choice.selection.model_id,
        thinking_level: None,
    })
}

async fn await_terminal_execution(
    client: &Client,
    session_id: &str,
    run_id: RunId,
) -> Result<Option<Execution>, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut poll = tokio::time::interval(Duration::from_millis(50));
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        if let ExecutionResult::Found { execution } = query_typed(
            client,
            "agent",
            "execution",
            json!({ "sessionId": session_id, "runId": run_id }),
        )
        .await?
            && is_terminal_execution_state(&execution.state)
        {
            return Ok(Some(execution));
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
) -> Result<UsageReport, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    let mut poll = tokio::time::interval(Duration::from_millis(50));
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let report: UsageReport = query_typed(
            client,
            "settings",
            "usageSummary",
            json!({
                "range": {
                    "from": 0.0,
                    "to": 9_007_199_254_740_991.0,
                    "sessionId": session_id,
                    "through": Value::Null,
                },
                "group": Group::ByModel,
                "cursor": Value::Null,
            }),
        )
        .await?;
        if (report.summary.pending.models == 0 && report.summary.pending.tools == 0)
            || tokio::time::Instant::now() >= deadline
        {
            return Ok(report);
        }
        poll.tick().await;
    }
}

async fn query_all_usage_attempts(
    client: &Client,
    session_id: &str,
    run_id: RunId,
    through_fence: UsageFence,
    step_ids: &mut BTreeSet<StepId>,
) -> Result<UsagePage, String> {
    let mut expected_fence = through_fence;
    let mut cursor: Option<UsageActivityCursor> = None;
    let mut attempts = Vec::<Activity>::new();
    let total;
    loop {
        let page: UsagePage = query_typed(
            client,
            "settings",
            "usage",
            json!({
                "range": {
                    "from": 0.0,
                    "to": 9_007_199_254_740_991.0,
                    "sessionId": session_id,
                    "through": expected_fence,
                },
                "selection": Selection {
                    kind: Some(ActivityKind::Model),
                    status: None,
                    search: String::new(),
                },
                "cursor": cursor,
            }),
        )
        .await?;
        expected_fence = page.through;
        for item in &page.attempts {
            if let Activity::Model(attempt) = item
                && let Origin::Agent {
                    execution, link, ..
                } = &attempt.origin
                && execution.run_id == run_id
            {
                step_ids.insert(link.step);
            }
        }
        attempts.extend(page.attempts);
        if page.next_cursor.is_none() {
            total = page.total;
            break;
        }
        cursor = page.next_cursor;
    }
    Ok(UsagePage {
        through: expected_fence,
        attempts,
        total,
        next_cursor: None,
    })
}

async fn stop_with_reason(
    client: &Client,
    session_id: &str,
    run_id: RunId,
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
        Ok(mutation) => match commit_typed::<Stopped>("agent.stop", mutation).await {
            Ok(_) => reason,
            Err(err) => format!("{reason}; stop failed: {err}"),
        },
        Err(err) => format!("{reason}; stop control open failed: {err}"),
    }
}

async fn export_history(client: &Client, session_id: &str) -> Result<Value, String> {
    let mut through = None;
    let mut position = HistoryPosition::Start;
    let mut pages = Vec::<HistoryPage>::new();
    loop {
        let page: HistoryPage = query_typed(
            client,
            "agent",
            "history",
            json!({
                "sessionId": session_id,
                "through": through,
                "position": position,
                "includeThinking": true,
            }),
        )
        .await?;
        let HistoryPage::Ready {
            through: page_through,
            after,
            ..
        } = &page
        else {
            return Err("unexpected room history page for agent session".into());
        };
        through = *page_through;
        let next_after = after.clone();
        pages.push(page);
        let Some(cursor) = next_after else {
            return Ok(json!({
                "sessionId": session_id,
                "through": through,
                "pages": pages,
            }));
        };
        position = HistoryPosition::After { cursor };
    }
}

async fn query_typed<T: DeserializeOwned>(
    client: &Client,
    endpoint: &str,
    method: &str,
    input: Value,
) -> Result<T, String> {
    let raw = client
        .query(endpoint, method, input)
        .await
        .map_err(|e| format!("{endpoint}.{method} query failed: {e}"))?;
    serde_json::from_value(raw)
        .map_err(|e| format!("{endpoint}.{method} response decode failed: {e}"))
}

async fn commit_typed<T: DeserializeOwned>(label: &str, mutation: Mutation) -> Result<T, String> {
    mutation
        .prepare()
        .await
        .map_err(|e| format!("{label} prepare failed: {e}"))?;
    let reply = mutation
        .confirm()
        .await
        .map_err(|e| format!("{label} confirm failed: {e}"))?;
    let raw = returned(reply)?;
    serde_json::from_value(raw).map_err(|e| format!("{label} receipt decode failed: {e}"))
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
    stdout_drain: tokio::task::JoinHandle<()>,
}

impl HostServerProcess {
    fn detach(self) {
        self.stdout_drain.abort();
    }

    async fn shutdown(&mut self) -> Result<(), String> {
        let retire_res = HostClient::retire_with_options(
            Path::new(&self.socket_path),
            self.host_epoch,
            true,
            true,
        )
        .await;
        let outcome = match tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await {
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
        };
        self.stdout_drain.abort();
        outcome
    }
}

async fn spawn_host_serve(
    maka_bin: &Path,
    command_path: &str,
    state_root: &Path,
    artifacts_dir: &Path,
) -> Result<HostServerProcess, String> {
    let stderr_path = artifacts_dir.join("host-serve.stderr.log");
    let stderr_file = std::fs::File::create(&stderr_path)
        .map_err(|e| format!("failed creating {}: {e}", stderr_path.display()))?;

    let mut cmd = Command::new(maka_bin);
    cmd.args(["host", "serve", "--root"])
        .arg(state_root)
        .env("PATH", command_path)
        .env("NO_PROXY", "localhost,127.0.0.1,::1,host.docker.internal")
        .env("no_proxy", "localhost,127.0.0.1,::1,host.docker.internal")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(stderr_file))
        .kill_on_drop(false);
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn maka host serve: {e}"))?;

    let stdout = child.stdout.take().ok_or("missing host stdout pipe")?;
    let handshake: Result<(tokio::task::JoinHandle<()>, String, Uuid), String> = async {
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
            let stderr_text = tokio::fs::read_to_string(&stderr_path)
                .await
                .unwrap_or_default();
            let trimmed = stderr_text.trim();
            if trimmed.is_empty() {
                Err("maka host serve exited before printing ready line".into())
            } else {
                Err(format!(
                    "maka host serve exited before printing ready line: {trimmed}"
                ))
            }
        })
        .await
        .map_err(|_| "timed out waiting for maka host serve ready line".to_owned())??;

        let socket_path = ready_line["socketPath"]
            .as_str()
            .ok_or_else(|| format!("ready line missing socketPath: {ready_line}"))?
            .to_owned();
        let epoch_str = ready_line["hostEpoch"]
            .as_str()
            .ok_or_else(|| format!("ready line missing hostEpoch: {ready_line}"))?;
        let host_epoch = Uuid::parse_str(epoch_str)
            .map_err(|e| format!("invalid hostEpoch '{epoch_str}': {e}"))?;

        // Keep draining remaining stdout lines so pipe never fills.
        let stdout_drain =
            tokio::spawn(async move { while let Ok(Some(_)) = stdout_lines.next_line().await {} });

        Ok((stdout_drain, socket_path, host_epoch))
    }
    .await;

    match handshake {
        Ok((stdout_drain, socket_path, host_epoch)) => Ok(HostServerProcess {
            child,
            socket_path,
            host_epoch,
            stdout_drain,
        }),
        Err(err) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(err)
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use maka_agent_facts::accounting::{Cost, ModelTotals, Pending, Tokens, ToolTotals};
    use maka_settings_native::usage::Totals;

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

    pub(crate) fn sample_evidence(
        state: ExecutionState,
        pending_models: u64,
        pending_tools: u64,
        calls: u64,
        input_missing: u64,
        output_missing: u64,
    ) -> GuestEvidence {
        let run_id = RunId::new();
        let tok = |known, missing| Tokens { known, missing };
        let through = UsageFence {
            schema_version: 1,
            state_domain: "domain-1".into(),
            sequence: 12,
            auxiliary_sequence: 0,
            cell_sequence: 0,
            query_digest: "sha256:00".into(),
        };
        let summary = Totals {
            models: ModelTotals {
                calls,
                success: calls,
                error: 0,
                aborted: 0,
                unknown: 0,
                duration_ms: 10.0,
                input: tok(100, input_missing),
                output: tok(20, output_missing),
                cache_read: tok(0, 0),
                cache_write: tok(0, 0),
                reasoning: tok(0, 0),
                cost: Cost {
                    known_usd: 0.0,
                    unvalued: 0,
                    unpriced: 0,
                },
            },
            tools: ToolTotals {
                calls: 0,
                success: 0,
                error: 0,
                unknown: 0,
                rejected: 0,
                duration_ms: 0.0,
                mean_latency_ms: None,
            },
            pending: Pending {
                models: pending_models,
                tools: pending_tools,
            },
            by_provider: Vec::new(),
            by_model: Vec::new(),
            by_tool: Vec::new(),
        };
        GuestEvidence {
            steps_observed: 2,
            session_id: "sess-1".into(),
            run_id,
            execution: Some(Execution {
                session_id: "sess-1".into(),
                turn_id: "turn-1".into(),
                run_id,
                high_water: 12,
                state,
            }),
            host_usage: UsageReport {
                through: through.clone(),
                summary,
                next_cursor: None,
            },
            host_usage_attempts: UsagePage {
                through,
                attempts: Vec::new(),
                total: 0,
                next_cursor: None,
            },
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

        let err = match run_from_files(&req_path, &res_path).await {
            Ok(()) => panic!("expected invalid JSON to fail"),
            Err(err) => err,
        };
        assert!(err.contains("invalid guest request JSON"));
        assert!(!req_path.exists());
        let saved: GuestRunResult =
            serde_json::from_str(&tokio::fs::read_to_string(&res_path).await.unwrap()).unwrap();
        assert!(matches!(
            saved,
            GuestRunResult::InfraFailed { evidence: None, .. }
        ));
    }

    #[test]
    fn finalize_run_result_preserves_evidence_when_shutdown_fails() {
        let stopped = || GuestRunResult::SubjectStopped {
            stop_reason: "exceeded maxSteps".into(),
            evidence: Box::new(sample_evidence(ExecutionState::Cancelled, 0, 0, 1, 0, 0)),
        };

        assert!(matches!(
            finalize_run_result(Ok(stopped()), Ok(())),
            GuestRunResult::SubjectStopped { .. }
        ));
        assert!(matches!(
            finalize_run_result(Err("session broke".into()), Ok(())),
            GuestRunResult::InfraFailed { ref infra_error, evidence: None }
                if infra_error == "session broke"
        ));
        assert!(matches!(
            finalize_run_result(Err("session broke".into()), Err("cleanup broke".into())),
            GuestRunResult::InfraFailed { ref infra_error, evidence: None }
                if infra_error == "session broke; host shutdown failed: cleanup broke"
        ));
        assert!(matches!(
            finalize_run_result(Ok(stopped()), Err("cleanup broke".into())),
            GuestRunResult::InfraFailed { ref infra_error, evidence: Some(_) }
                if infra_error == "host shutdown failed: cleanup broke"
        ));
    }
}
