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
use std::ffi::{OsStr, OsString};
use std::num::{NonZeroU32, NonZeroU64};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use maka_agent_api::contract::{
    BackendPreference, Created, DeliveryFact, DeliveryPage, Execution, ExecutionResult,
    ExecutionState, HistoryPage, HistoryPosition, SendResult, Stopped, Work, WorkTarget,
    WorkspaceSelection,
};
use maka_agent_facts::accounting::{
    Activity, ActivityKind, ActivityStatus, Group, ModelTotals, Origin, Pending, Selection,
};
use maka_agent_facts::configuration::policy::ChatDefaults;
use maka_agent_facts::configuration::validation::MAX_SAFE_INTEGER;
use maka_agent_facts::durable::{RunId, StepId};
use maka_agent_facts::execution::ThinkingLevel;
use maka_agent_ports::session::history::Role;
use maka_agent_state::usage::{UsageActivityCursor, UsageFence};
use maka_app_client::{Client, Journal, Mutation, Subscription, SubscriptionEvent};
use maka_capabilities::call::Attachments;
use maka_host_runtime::DirectoryRootSpec;
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

const EVAL_CONNECTION_SLUG: &str = "eval-target";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GuestRunRequest {
    instruction: String,
    artifacts_dir: PathBuf,
    #[serde(default)]
    base_url: Option<String>,
    api_key: String,
    provider: String,
    model_id: String,
    #[serde(default)]
    thinking_level: Option<ThinkingLevel>,
    sandbox_mode: SandboxMode,
    #[serde(default)]
    max_steps: Option<NonZeroU32>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuestEvidence {
    pub steps_observed: u32,
    pub execution: Execution,
    pub host_usage: UsageReport,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", rename_all_fields = "camelCase")]
pub(crate) enum Metering {
    Complete {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cost_usd: Option<f64>,
    },
    LowerBound,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageSettlement {
    pub metering: Metering,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum GuestRunResult {
    Completed {
        evidence: Box<GuestEvidence>,
        settlement: UsageSettlement,
    },
    SubjectStopped {
        stop_reason: String,
        evidence: Box<GuestEvidence>,
        settlement: UsageSettlement,
    },
    InfraFailed {
        infra_error: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        evidence: Option<Box<GuestEvidence>>,
    },
}

fn is_terminal_execution_state(state: &ExecutionState) -> bool {
    matches!(
        state,
        ExecutionState::Completed | ExecutionState::Failed { .. } | ExecutionState::Cancelled
    )
}

impl GuestRunResult {
    pub(crate) fn infra_error(message: impl Into<String>) -> Self {
        Self::InfraFailed {
            infra_error: message.into(),
            evidence: None,
        }
    }

    fn into_evidence(self) -> Option<Box<GuestEvidence>> {
        match self {
            Self::Completed { evidence, .. } | Self::SubjectStopped { evidence, .. } => {
                Some(evidence)
            }
            Self::InfraFailed { evidence, .. } => evidence,
        }
    }
}

#[derive(Clone, Copy)]
struct Deadline {
    at: tokio::time::Instant,
    budget_ms: NonZeroU64,
}

impl Deadline {
    fn from_timeout_ms(timeout_ms: Option<NonZeroU64>) -> Result<Option<Self>, String> {
        timeout_ms
            .map(|budget_ms| {
                tokio::time::Instant::now()
                    .checked_add(Duration::from_millis(budget_ms.get()))
                    .map(|at| Self { at, budget_ms })
                    .ok_or_else(|| format!("timeoutMs ({budget_ms}) overflows runtime clock"))
            })
            .transpose()
    }

    fn remaining(self, stage: &str) -> Result<Duration, String> {
        self.at
            .checked_duration_since(tokio::time::Instant::now())
            .filter(|rem| !rem.is_zero())
            .ok_or_else(|| {
                format!(
                    "agent timeout budget ({} ms) exhausted before {stage}",
                    self.budget_ms
                )
            })
    }

    async fn run<T>(
        self,
        stage: &str,
        fut: impl std::future::Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        let rem = self.remaining(stage)?;
        tokio::time::timeout(rem, fut).await.map_err(|_| {
            format!(
                "agent timeout budget ({} ms) exhausted during {stage}",
                self.budget_ms
            )
        })?
    }
}

fn check_deadline(deadline: Option<Deadline>, stage: &str) -> Result<(), String> {
    if let Some(d) = deadline {
        d.remaining(stage)?;
    }
    Ok(())
}

async fn run_before_deadline<T>(
    deadline: Option<Deadline>,
    stage: &str,
    fut: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    match deadline {
        Some(d) => d.run(stage, fut).await,
        None => fut.await,
    }
}

async fn sleep_deadline(deadline: Option<Deadline>) -> NonZeroU64 {
    match deadline {
        Some(d) => {
            tokio::time::sleep_until(d.at).await;
            d.budget_ms
        }
        None => std::future::pending().await,
    }
}

fn merge_teardown(
    inner: Result<GuestRunResult, String>,
    stage: &str,
    teardown: Result<(), String>,
) -> Result<GuestRunResult, String> {
    match (inner, teardown) {
        (res, Ok(())) => res,
        (Err(err), Err(td_err)) => Err(format!("{err}; {stage} failed: {td_err}")),
        (
            Ok(GuestRunResult::InfraFailed {
                infra_error,
                evidence,
            }),
            Err(td_err),
        ) => Ok(GuestRunResult::InfraFailed {
            infra_error: format!("{infra_error}; {stage} failed: {td_err}"),
            evidence,
        }),
        (Ok(res), Err(td_err)) => Ok(GuestRunResult::InfraFailed {
            infra_error: format!("{stage} failed: {td_err}"),
            evidence: res.into_evidence(),
        }),
    }
}

pub(crate) async fn run_from_files(
    request_file: &Path,
    result_file: &Path,
    timeout_ms: Option<NonZeroU64>,
) -> Result<(), String> {
    let raw = tokio::fs::read_to_string(request_file)
        .await
        .map_err(|e| format!("failed to read {}: {e}", request_file.display()))?;
    // Delete the request file immediately so the container workspace cannot inspect the API key.
    let result = match tokio::fs::remove_file(request_file).await {
        Ok(()) => match serde_json::from_str::<GuestRunRequest>(&raw) {
            Ok(request) => execute(request, timeout_ms)
                .await
                .unwrap_or_else(GuestRunResult::infra_error),
            Err(e) => GuestRunResult::infra_error(format!(
                "invalid guest request JSON {}: {e}",
                request_file.display()
            )),
        },
        Err(e) => GuestRunResult::infra_error(format!(
            "failed to remove secret request file {}: {e}",
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

async fn execute(
    req: GuestRunRequest,
    timeout_ms: Option<NonZeroU64>,
) -> Result<GuestRunResult, String> {
    let deadline = Deadline::from_timeout_ms(timeout_ms)?;
    let workspace_dir = std::env::current_dir()
        .map_err(|e| format!("failed to resolve current working directory: {e}"))?;
    let canonical_workspace = tokio::fs::canonicalize(&workspace_dir).await.map_err(|e| {
        format!(
            "failed to canonicalize workspace {}: {e}",
            workspace_dir.display()
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
    let command_path = prepend_binary_dir_to_path(&maka_bin)?;

    let result = async {
        run_before_deadline(
            deadline,
            "host init",
            init_host(
                &maka_bin,
                &command_path,
                &state_root,
                &canonical_workspace,
                &req,
            ),
        )
        .await?;
        let mut host_proc = spawn_host_serve(
            &maka_bin,
            &command_path,
            &state_root,
            &req.artifacts_dir,
            deadline,
        )
        .await?;

        let inner = run_session(
            &req,
            &canonical_workspace_str,
            &journal_path,
            &host_proc,
            deadline,
        )
        .await;
        if matches!(inner, Ok(GuestRunResult::Completed { .. })) {
            host_proc.detach();
            return inner;
        }
        let shutdown = host_proc.shutdown().await;
        merge_teardown(inner, "host shutdown", shutdown)
    }
    .await;

    if !matches!(result, Ok(GuestRunResult::Completed { .. })) {
        let _ = tokio::fs::remove_dir_all(&run_dir).await;
    }
    result
}

async fn run_session(
    req: &GuestRunRequest,
    canonical_workspace_str: &str,
    journal_path: &Path,
    host_proc: &HostServerProcess,
    deadline: Option<Deadline>,
) -> Result<GuestRunResult, String> {
    let host_client = run_before_deadline(deadline, "host readiness", async {
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
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .map_err(|_| "timed out waiting for Host readiness".to_owned())??;

        Ok(host_client)
    })
    .await?;

    let journal = Journal::open(journal_path)
        .await
        .map_err(|e| format!("failed to open client journal: {e}"))?;
    let client = Client::new(host_client, journal, "receipts".into())
        .map_err(|e| format!("failed to create maka app client: {e}"))?;

    let outcome = run_session_with_client(req, canonical_workspace_str, &client, deadline).await;
    let close_res = client.close().await.map_err(|e| e.to_string());
    merge_teardown(outcome, "client close", close_res)
}

async fn run_session_with_client(
    req: &GuestRunRequest,
    canonical_workspace_str: &str,
    client: &Client,
    deadline: Option<Deadline>,
) -> Result<GuestRunResult, String> {
    let (session_id, watch) = run_before_deadline(deadline, "session setup", async {
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
                        "workspace": WorkspaceSelection::Directory {
                            path: canonical_workspace_str.to_owned(),
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

        Ok((session_id, watch))
    })
    .await?;

    let run_outcome = async {
        let send_result = run_before_deadline(deadline, "agent.send", async {
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
            commit_typed::<SendResult>("agent.send", send).await
        })
        .await?;
        let run_id = match send_result {
            SendResult::Started { run_id, .. } => run_id,
            SendResult::Queued { message_id, .. } => {
                resolve_queued_run_id(client, &session_id, &message_id, deadline).await?
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

        let execution = await_terminal_execution(client, &session_id, run_id).await?;

        let (transcript, failure_diagnostic) = export_history(client, &session_id, run_id).await?;
        let transcript_file = req.artifacts_dir.join("transcript.json");
        let transcript_json = serde_json::to_string_pretty(&transcript)
            .map_err(|e| format!("failed to serialize transcript: {e}"))?;
        tokio::fs::write(&transcript_file, format!("{transcript_json}\n"))
            .await
            .map_err(|e| format!("failed to write transcript: {e}"))?;

        let is_completed =
            run_error.is_none() && matches!(execution.state, ExecutionState::Completed);
        let settle_timeout = if is_completed {
            Duration::from_secs(5)
        } else {
            Duration::from_millis(250)
        };
        let host_usage = query_settled_usage_summary(client, settle_timeout).await?;
        let missing_success_usage =
            scan_success_usage_attempts(client, run_id, &host_usage.through, &mut step_ids).await?;
        let evidence = Box::new(GuestEvidence {
            steps_observed: u32::try_from(step_ids.len()).unwrap_or(u32::MAX),
            execution,
            host_usage,
        });
        match (&evidence.execution.state, run_error) {
            (ExecutionState::Failed { reason }, _) => {
                let detail = failure_diagnostic
                    .or_else(|| reason.as_ref().and_then(|r| serde_json::to_string(r).ok()))
                    .unwrap_or_else(|| "unknown failure".into());
                Ok(GuestRunResult::InfraFailed {
                    infra_error: format!("execution failed: {detail}"),
                    evidence: Some(evidence),
                })
            }
            (ExecutionState::Cancelled, None) => Ok(GuestRunResult::InfraFailed {
                infra_error: "execution cancelled unexpectedly".into(),
                evidence: Some(evidence),
            }),
            (state, None) if !matches!(state, ExecutionState::Completed) => {
                let encoded = serde_json::to_string(state).unwrap_or_else(|_| "unknown".into());
                Ok(GuestRunResult::InfraFailed {
                    infra_error: format!("execution ended in unexpected state: {encoded}"),
                    evidence: Some(evidence),
                })
            }
            (_, stop_reason) => {
                let settlement = match settle_usage(
                    &evidence.host_usage.summary.models,
                    &evidence.host_usage.summary.pending,
                    missing_success_usage,
                    stop_reason.is_none(),
                ) {
                    Ok(settlement) => settlement,
                    Err(infra_error) => {
                        return Ok(GuestRunResult::InfraFailed {
                            infra_error,
                            evidence: Some(evidence),
                        });
                    }
                };
                match stop_reason {
                    None => Ok(GuestRunResult::Completed {
                        evidence,
                        settlement,
                    }),
                    Some(stop_reason) => Ok(GuestRunResult::SubjectStopped {
                        stop_reason,
                        evidence,
                        settlement,
                    }),
                }
            }
        }
    }
    .await;

    let close_watch = watch.close().await.map_err(|e| e.to_string());
    merge_teardown(run_outcome, "watch close", close_watch)
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
    deadline: Option<Deadline>,
) -> Result<(Option<String>, BTreeSet<StepId>), String> {
    let mut step_ids = BTreeSet::<StepId>::new();
    loop {
        let next_ev = tokio::select! {
            biased;
            ms = sleep_deadline(deadline) => {
                let reason = stop_with_reason(
                    client,
                    session_id,
                    run_id,
                    format!("execution timed out after {ms} ms"),
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
                            if let Some(step_id) = delivery_fact_step_id(&ev.fact)
                                && !step_ids.contains(&step_id)
                            {
                                if let Some(max_steps) = req.max_steps
                                    && step_ids.len() >= max_steps.get() as usize
                                {
                                    let reason = stop_with_reason(
                                        client,
                                        session_id,
                                        run_id,
                                        format!("exceeded maxSteps ({max_steps})"),
                                    )
                                    .await;
                                    return Ok((Some(reason), step_ids));
                                }
                                step_ids.insert(step_id);
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
    deadline: Option<Deadline>,
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
            ms = sleep_deadline(deadline) => {
                return Err(format!(
                    "queued message '{message_id}' did not start execution before timeout ({ms} ms)"
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
            "default target '{EVAL_CONNECTION_SLUG}/{}' is unavailable after host init",
            req.model_id
        ));
    };
    if choice.selection.model_id != req.model_id {
        return Err(format!(
            "resolved default model '{}' does not match requested '{}'",
            choice.selection.model_id, req.model_id
        ));
    }
    Ok(BackendPreference::Model {
        service_tier: None,
        connection_id: choice.selection.connection_id,
        model_id: choice.selection.model_id,
        thinking_level: req.thinking_level,
    })
}

async fn await_terminal_execution(
    client: &Client,
    session_id: &str,
    run_id: RunId,
) -> Result<Execution, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut poll = tokio::time::interval(Duration::from_millis(50));
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_state: Option<String> = None;
    loop {
        if let ExecutionResult::Found { execution } = query_typed(
            client,
            "agent",
            "execution",
            json!({ "sessionId": session_id, "runId": run_id }),
        )
        .await?
        {
            if is_terminal_execution_state(&execution.state) {
                return Ok(execution);
            }
            last_state = serde_json::to_string(&execution.state).ok();
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "timed out waiting for terminal execution state (last_state={})",
                last_state.as_deref().unwrap_or("missing")
            ));
        }
        poll.tick().await;
    }
}

async fn query_settled_usage_summary(
    client: &Client,
    settle_timeout: Duration,
) -> Result<UsageReport, String> {
    let deadline = tokio::time::Instant::now() + settle_timeout;
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
                    "to": MAX_SAFE_INTEGER as f64,
                    "sessionId": Value::Null,
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

async fn scan_success_usage_attempts(
    client: &Client,
    run_id: RunId,
    through_fence: &UsageFence,
    step_ids: &mut BTreeSet<StepId>,
) -> Result<(u64, u64), String> {
    let mut cursor: Option<UsageActivityCursor> = None;
    let mut input_missing = 0u64;
    let mut output_missing = 0u64;
    loop {
        let page: UsagePage = query_typed(
            client,
            "settings",
            "usage",
            json!({
                "range": {
                    "from": 0.0,
                    "to": MAX_SAFE_INTEGER as f64,
                    "sessionId": Value::Null,
                    "through": through_fence,
                },
                "selection": Selection {
                    kind: Some(ActivityKind::Model),
                    status: Some(ActivityStatus::Success),
                    search: String::new(),
                },
                "cursor": cursor,
            }),
        )
        .await?;
        for item in &page.attempts {
            if let Activity::Model(attempt) = item {
                if attempt.usage.input_tokens.is_none() {
                    input_missing += 1;
                }
                if attempt.usage.output_tokens.is_none() {
                    output_missing += 1;
                }
                if let Origin::Agent {
                    execution, link, ..
                } = &attempt.origin
                    && execution.run_id == run_id
                {
                    step_ids.insert(link.step);
                }
            }
        }
        if page.next_cursor.is_none() {
            return Ok((input_missing, output_missing));
        }
        cursor = page.next_cursor;
    }
}

fn settle_usage(
    models: &ModelTotals,
    pending: &Pending,
    (input_missing, output_missing): (u64, u64),
    is_completed: bool,
) -> Result<UsageSettlement, String> {
    if is_completed {
        if pending.models != 0 || pending.tools != 0 {
            return Err(format!(
                "incomplete host usage accounting: pending_models={}, pending_tools={}",
                pending.models, pending.tools
            ));
        }
        if models.success == 0 {
            return Err(
                "incomplete host usage accounting: completed run recorded 0 successful model calls"
                    .into(),
            );
        }
    }

    if input_missing != 0 || output_missing != 0 {
        return Err(format!(
            "incomplete token usage on successful model call(s) ({} total): input_missing={input_missing}, output_missing={output_missing}",
            models.success
        ));
    }

    let settled_all = pending.models == 0 && models.aborted == 0 && models.unknown == 0;
    let lower_bound = !settled_all
        || models.input.missing > 0
        || models.output.missing > 0
        || models.cost.unvalued > models.cost.unpriced;
    let metering = if lower_bound {
        Metering::LowerBound
    } else {
        Metering::Complete {
            cost_usd: (models.cost.unvalued == 0).then_some(models.cost.known_usd),
        }
    };

    Ok(UsageSettlement {
        metering,
        input_tokens: (settled_all && models.input.missing == 0).then_some(models.input.known),
        cache_tokens: (settled_all && models.cache_read.missing == 0)
            .then_some(models.cache_read.known),
        output_tokens: (settled_all && models.output.missing == 0).then_some(models.output.known),
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

fn latest_failure_diagnostic(pages: &[HistoryPage], run_id: RunId) -> Option<String> {
    pages.iter().rev().find_map(|page| {
        let HistoryPage::Ready { chunks, .. } = page else {
            return None;
        };
        chunks.iter().rev().find_map(|chunk| {
            (chunk.role == Role::Failure && chunk.run_id == Some(run_id))
                .then_some(chunk.text.trim())
                .filter(|text| !text.is_empty())
                .map(str::to_owned)
        })
    })
}

async fn export_history(
    client: &Client,
    session_id: &str,
    run_id: RunId,
) -> Result<(Value, Option<String>), String> {
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
            let failure_diagnostic = latest_failure_diagnostic(&pages, run_id);
            return Ok((
                json!({
                    "sessionId": session_id,
                    "through": through,
                    "pages": pages,
                }),
                failure_diagnostic,
            ));
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
    let name = format!("maka{}", std::env::consts::EXE_SUFFIX);
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        let sibling = dir.join(&name);
        if sibling.is_file() {
            return sibling;
        }
    }
    PathBuf::from(name)
}

fn prepend_binary_dir_to_path(bin: &Path) -> Result<OsString, String> {
    let existing = std::env::var_os("PATH");
    let Some(dir) = bin.parent().filter(|p| !p.as_os_str().is_empty()) else {
        return Ok(existing.unwrap_or_default());
    };
    crate::harbor::prepend_search_path(dir, existing.as_deref())
}

fn build_init_settings(req: &GuestRunRequest, canonical_workspace: &Path) -> Value {
    let mut connection = json!({
        "slug": EVAL_CONNECTION_SLUG,
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
        "chatDefaults": ChatDefaults {
            sandbox_mode: req.sandbox_mode,
        },
        "projectDirectoryRoots": [DirectoryRootSpec {
            label: "Harbor Workspace".into(),
            path: canonical_workspace.to_path_buf(),
        }],
        "connections": [connection],
        "defaultTarget": {
            "slug": EVAL_CONNECTION_SLUG,
            "modelId": req.model_id,
        }
    })
}

async fn init_host(
    maka_bin: &Path,
    command_path: &OsStr,
    state_root: &Path,
    canonical_workspace: &Path,
    req: &GuestRunRequest,
) -> Result<(), String> {
    let settings = build_init_settings(req, canonical_workspace);
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
        .kill_on_drop(true)
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
    command_path: &OsStr,
    state_root: &Path,
    artifacts_dir: &Path,
    deadline: Option<Deadline>,
) -> Result<HostServerProcess, String> {
    check_deadline(deadline, "host startup")?;
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
    let handshake: Result<(tokio::task::JoinHandle<()>, String, Uuid), String> =
        run_before_deadline(deadline, "host startup", async {
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
                tokio::spawn(
                    async move { while let Ok(Some(_)) = stdout_lines.next_line().await {} },
                );

            Ok((stdout_drain, socket_path, host_epoch))
        })
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
mod tests {
    use super::*;
    use maka_agent_facts::accounting::{Cost, Tokens};

    fn sample_models() -> ModelTotals {
        ModelTotals {
            calls: 1,
            success: 1,
            error: 0,
            aborted: 0,
            unknown: 0,
            duration_ms: 10.0,
            input: Tokens {
                known: 100,
                missing: 0,
            },
            output: Tokens {
                known: 20,
                missing: 0,
            },
            cache_read: Tokens {
                known: 10,
                missing: 0,
            },
            cache_write: Tokens {
                known: 0,
                missing: 1,
            },
            reasoning: Tokens {
                known: 0,
                missing: 1,
            },
            cost: Cost {
                known_usd: 0.001,
                unvalued: 0,
                unpriced: 0,
            },
        }
    }

    #[test]
    fn settle_usage_enforces_completeness_and_gates_agent_context_tokens() {
        let settled = Pending {
            models: 0,
            tools: 0,
        };

        // Aborted or unknown calls force LowerBound and suppress token totals even if missing == 0.
        let mut aborted = sample_models();
        aborted.calls = 2;
        aborted.aborted = 1;
        assert_eq!(
            settle_usage(&aborted, &settled, (0, 0), false).unwrap(),
            UsageSettlement {
                metering: Metering::LowerBound,
                input_tokens: None,
                cache_tokens: None,
                output_tokens: None,
            }
        );

        let mut unknown = sample_models();
        unknown.calls = 2;
        unknown.unknown = 1;
        assert_eq!(
            settle_usage(&unknown, &settled, (0, 0), false).unwrap(),
            UsageSettlement {
                metering: Metering::LowerBound,
                input_tokens: None,
                cache_tokens: None,
                output_tokens: None,
            }
        );

        // Completed runs must fail when calls are still pending or no successful call occurred.
        assert!(
            settle_usage(
                &sample_models(),
                &Pending {
                    models: 1,
                    tools: 0
                },
                (0, 0),
                true
            )
            .unwrap_err()
            .contains("pending_models=1")
        );
        let mut zero_success = sample_models();
        zero_success.success = 0;
        zero_success.error = 1;
        assert!(
            settle_usage(&zero_success, &settled, (0, 0), true)
                .unwrap_err()
                .contains("0 successful model calls")
        );

        // Successful calls without input/output token counts fail as infra error.
        assert!(
            settle_usage(&sample_models(), &settled, (1, 0), true)
                .unwrap_err()
                .contains("input_missing=1")
        );

        // Unpriced model completes with cost_usd: None while preserving settled tokens.
        let mut unpriced = sample_models();
        unpriced.cost = Cost {
            known_usd: 0.0,
            unvalued: 1,
            unpriced: 1,
        };
        assert_eq!(
            settle_usage(&unpriced, &settled, (0, 0), true).unwrap(),
            UsageSettlement {
                metering: Metering::Complete { cost_usd: None },
                input_tokens: Some(100),
                cache_tokens: Some(10),
                output_tokens: Some(20),
            }
        );
    }
}
