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

//! Headless single-shot Agent prompt execution over the public Host client.

use std::{
    borrow::Cow,
    io::{IsTerminal, Read, Write},
    path::PathBuf,
    time::Duration,
};

use maka_agent_api::contract::{
    BackendPreference, Created, DeliveryFact, DeliveryPage, ExecutionState, HistoryPage,
    HistoryPosition, HistoryRowAddress, InteractionKind, Queue, QueueAction, QueueMutationResult,
    QueueRejection, Rejection, SendRejection, SendResult, Stopped, Work, WorkReadiness, WorkTarget,
};
use maka_agent_facts::durable::BlockerKind;
use maka_agent_ports::session::history::Role;
use maka_host_runtime::{
    HostError,
    application::{
        host::{Client as HostClient, LocalCall},
        transport::Reply,
    },
};
use maka_plugin_core::operation::{OperationCleanup, OperationOutcome, OperationResult, Receipt};
use maka_settings_native::contract::{DefaultModel, ModelsPage};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

#[derive(clap::Args)]
pub(super) struct Args {
    /// Business Host Root (default: ~/.maka/application/host).
    #[arg(long, value_name = "DIRECTORY")]
    root: Option<PathBuf>,
    /// Workspace directory for the session (default: current directory).
    #[arg(long, value_name = "DIRECTORY")]
    workspace: Option<PathBuf>,
    /// Prompt text; reads UTF-8 text from stdin when omitted.
    #[arg(value_name = "PROMPT")]
    prompt: Option<String>,
}

enum WatchOutcome {
    Ended { sequence: u64 },
    CancelledExternally,
    Interrupted(String),
}

enum MutationError {
    Rejected(String),
    Other(HostError),
}

impl From<MutationError> for HostError {
    fn from(error: MutationError) -> Self {
        match error {
            MutationError::Rejected(diagnostic) => diagnostic.into(),
            MutationError::Other(err) => err,
        }
    }
}

fn other_mutation_error<E: Into<HostError>>(error: E) -> MutationError {
    MutationError::Other(error.into())
}

impl Args {
    pub(super) async fn run(self) -> Result<(), HostError> {
        let stop = CancellationToken::new();
        let _signals = crate::signals::watch(stop.clone())?;

        let workspace_path = resolve_workspace(self.workspace).await?;
        let prompt = read_prompt(self.prompt, &stop).await?;
        let root = crate::application::root_path(self.root)?;

        let mut host_client = tokio::select! {
            biased;
            _ = stop.cancelled() => return Err("run cancelled before connecting to Host".into()),
            result = crate::deployment::connect_local(root) => result?,
        };

        let turn_result = async {
            if let Some(error) = host_client.catalogue().startup_error() {
                return Err(format!("Host startup failed: {error}").into());
            }
            let backend = default_backend(&host_client).await?;
            execute_turn(&host_client, &workspace_path, backend, prompt, &stop).await
        }
        .await;

        // Both paths detach with `close()` so an ephemeral Host retires after
        // idle grace when no background services remain active, without killing
        // background services left running by other or prior runs on the Root.
        match (turn_result, host_client.close().await) {
            (Ok(answer), Ok(())) => {
                if let Some(answer) = answer
                    && !answer.is_empty()
                {
                    write_answer(answer, &stop).await?;
                }
                Ok(())
            }
            (Ok(_), Err(cleanup_err)) => Err(cleanup_err.into()),
            (Err(err), Ok(())) => Err(err),
            (Err(err), Err(cleanup_err)) => {
                Err(format!("{err}; Host cleanup failed: {cleanup_err}").into())
            }
        }
    }
}

async fn resolve_workspace(workspace: Option<PathBuf>) -> Result<String, HostError> {
    let workspace = match workspace {
        Some(path) => path,
        None => std::env::current_dir()?,
    };
    let metadata = tokio::fs::metadata(&workspace).await.map_err(|error| {
        HostError::from(format!(
            "workspace '{}' is unavailable: {error}",
            workspace.display()
        ))
    })?;
    if !metadata.is_dir() {
        return Err(format!("workspace '{}' is not a directory", workspace.display()).into());
    }
    let canonical = tokio::fs::canonicalize(&workspace).await?;
    Ok(maka_fs_tools::workspace::project::host_path(&canonical)?.to_owned())
}

async fn read_prompt(
    prompt: Option<String>,
    stop: &CancellationToken,
) -> Result<String, HostError> {
    let prompt = match prompt {
        Some(prompt) => prompt,
        None => {
            if std::io::stdin().is_terminal() {
                return Err("prompt is required (pass a prompt argument or pipe stdin)".into());
            }
            let (tx, rx) = tokio::sync::oneshot::channel();
            // Dedicated OS thread so Ctrl-C exits without blocking Tokio's shutdown pool.
            std::thread::Builder::new()
                .name("maka-run-stdin".into())
                .spawn(move || {
                    let mut buf = String::new();
                    let res = std::io::stdin()
                        .lock()
                        .read_to_string(&mut buf)
                        .map(|_| buf);
                    let _ = tx.send(res);
                })?;
            tokio::select! {
                biased;
                _ = stop.cancelled() => return Err("run cancelled while reading stdin".into()),
                res = rx => res.map_err(|_| HostError::from("stdin reader closed unexpectedly"))??,
            }
        }
    };
    if prompt.trim().is_empty() {
        return Err("prompt must not be empty".into());
    }
    Ok(prompt)
}

async fn default_backend(host: &HostClient) -> Result<BackendPreference, HostError> {
    let ModelsPage::Ready { default_model, .. } =
        query(host, "settings", "models", json!({ "kind": "start" })).await?
    else {
        return Err("unexpected settings.models response".into());
    };
    match *default_model {
        DefaultModel::Ready { choice, .. } => Ok(BackendPreference::model(choice.selection, None)),
        DefaultModel::None => Err(
            "no default model configured; configure a default model in Host settings (or initialize a new Root with `maka host init --settings-stdin`)"
                .into(),
        ),
        DefaultModel::Unavailable { target } => Err(format!(
            "configured default model '{}/{}' is unavailable",
            target.connection_id, target.model_id
        )
        .into()),
    }
}

async fn execute_turn(
    host: &HostClient,
    workspace_path: &str,
    backend: BackendPreference,
    prompt: String,
    stop: &CancellationToken,
) -> Result<Option<String>, HostError> {
    let created: Created = mutate(
        host,
        "agent",
        "create",
        json!({
            "title": "CLI Run",
            "labels": [],
            "backend": backend,
            "workspace": { "kind": "directory", "path": workspace_path },
        }),
    )
    .await?;

    let session_id = match created {
        Created::Created { session } => session.id,
        Created::Rejected { reason } => {
            return Err(format!("session creation rejected: {}", format_rejection(&reason)).into());
        }
    };

    if stop.is_cancelled() {
        return Err("interrupted by signal".into());
    }

    let send_result: SendResult = mutate(
        host,
        "agent",
        "send",
        json!({
            "sessionId": session_id,
            "message": prompt,
            "delivery": "queue",
        }),
    )
    .await?;

    let (message_id, revision) = match send_result {
        SendResult::Queued {
            message_id,
            revision,
            ..
        } => (message_id, revision),
        SendResult::Rejected { reason, .. } => {
            return Err(format!("agent.send rejected: {}", format_send_rejection(&reason)).into());
        }
        SendResult::Started { .. }
        | SendResult::Posted { .. }
        | SendResult::NotYourWorker { .. } => {
            return Err("unexpected agent.send result".into());
        }
    };

    if stop.is_cancelled() {
        return Err(cancel_with_reason(
            host,
            &session_id,
            &message_id,
            revision,
            "interrupted by signal",
        )
        .await);
    }

    let mut watch = match subscribe(
        host,
        "agent",
        "watch",
        json!({ "sessionId": session_id, "after": 0 }),
    )
    .await
    {
        Ok(watch) => watch,
        Err(err) => {
            return Err(cancel_with_reason(
                host,
                &session_id,
                &message_id,
                revision,
                &err.to_string(),
            )
            .await);
        }
    };

    let outcome = match observe_run(host, &session_id, &message_id, &mut watch, stop).await {
        Ok(WatchOutcome::Ended { sequence }) => tokio::select! {
            biased;
            _ = stop.cancelled() => Err("interrupted by signal".into()),
            res = read_completed_answer(host, &session_id, &message_id, sequence) => res,
        },
        Ok(WatchOutcome::CancelledExternally) => {
            Err("queued message was cancelled before execution".into())
        }
        Ok(WatchOutcome::Interrupted(reason)) => {
            Err(cancel_with_reason(host, &session_id, &message_id, revision, &reason).await)
        }
        Err(err) => {
            Err(
                cancel_with_reason(host, &session_id, &message_id, revision, &err.to_string())
                    .await,
            )
        }
    };

    let close_watch = watch.close().await;
    match (outcome, close_watch) {
        (Ok(answer), Ok(())) => Ok(answer),
        (Err(err), _) => Err(err),
        (Ok(_), Err(close_err)) => Err(format!("watch close failed: {close_err}").into()),
    }
}

async fn cancel_with_reason(
    host: &HostClient,
    session_id: &str,
    message_id: &str,
    revision: u64,
    reason: &str,
) -> HostError {
    if let Err(cancel_err) = cancel_work(host, session_id, message_id, revision).await {
        format!("{reason}; cancel failed: {cancel_err}").into()
    } else {
        reason.into()
    }
}

async fn write_answer(mut answer: String, stop: &CancellationToken) -> Result<(), HostError> {
    if stop.is_cancelled() {
        return Err("interrupted by signal".into());
    }
    if !answer.ends_with('\n') {
        answer.push('\n');
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    // Dedicated OS thread so a signal exits promptly even when stdout's pipe is full,
    // without blocking Tokio's shutdown pool.
    std::thread::Builder::new()
        .name("maka-run-stdout".into())
        .spawn(move || {
            let mut stdout = std::io::stdout().lock();
            let res = stdout
                .write_all(answer.as_bytes())
                .and_then(|()| stdout.flush());
            let _ = tx.send(res);
        })?;
    tokio::select! {
        biased;
        _ = stop.cancelled() => Err("interrupted by signal".into()),
        res = rx => {
            res.map_err(|_| HostError::from("stdout writer closed unexpectedly"))??;
            Ok(())
        }
    }
}

async fn observe_run(
    host: &HostClient,
    session_id: &str,
    message_id: &str,
    watch: &mut Subscription,
    stop: &CancellationToken,
) -> Result<WatchOutcome, HostError> {
    let mut delivered = false;
    loop {
        tokio::select! {
            biased;
            _ = stop.cancelled() => return Ok(WatchOutcome::Interrupted("interrupted by signal".into())),
            page = watch.next::<DeliveryPage>() => match page? {
                DeliveryPage::Queue { queue }
                    if !delivered
                        && !queue.entries.iter().any(|entry| entry.message_id == message_id) =>
                {
                    match query::<Work>(
                        host,
                        "agent",
                        "work",
                        json!({
                            "sessionId": session_id,
                            "target": WorkTarget::Message { message_id: message_id.to_owned() },
                            "cursor": Value::Null,
                        }),
                    )
                    .await?
                    {
                        Work::Cancelled | Work::Missing => {
                            return Ok(WatchOutcome::CancelledExternally);
                        }
                        Work::Delivered { .. } => {
                            delivered = true;
                        }
                        Work::Pending | Work::Changed => {}
                    }
                }
                DeliveryPage::Interactions { pending } if !pending.entries.is_empty() => {
                    let items: Vec<String> = pending
                        .entries
                        .iter()
                        .map(|entry| {
                            format!(
                                "{}({})",
                                format_interaction_kind(&entry.kind),
                                entry.request_id
                            )
                        })
                        .collect();
                    return Ok(WatchOutcome::Interrupted(format!(
                        "execution blocked by pending interaction(s): {}",
                        items.join(", ")
                    )));
                }
                DeliveryPage::Events { events, .. } => {
                    if let Some(ended) = events
                        .iter()
                        .find(|ev| matches!(ev.fact, DeliveryFact::Ended { .. }))
                    {
                        return Ok(WatchOutcome::Ended {
                            sequence: ended.sequence,
                        });
                    }
                }
                _ => {}
            }
        }
    }
}

async fn read_completed_answer(
    host: &HostClient,
    session_id: &str,
    message_id: &str,
    ended_sequence: u64,
) -> Result<Option<String>, HostError> {
    let work: Work = query(
        host,
        "agent",
        "work",
        json!({
            "sessionId": session_id,
            "target": WorkTarget::Message { message_id: message_id.to_owned() },
            "cursor": Value::Null,
        }),
    )
    .await?;
    let Work::Delivered {
        execution, answer, ..
    } = work
    else {
        return Err("agent.work did not return delivered execution".into());
    };
    match &execution.state {
        ExecutionState::Completed => {}
        ExecutionState::Failed { reason } => {
            if let Some(diag) = read_failure_diagnostic(host, session_id, ended_sequence).await {
                return Err(format!("run failed: {diag}").into());
            }
            if let Some(blocker) = reason {
                return Err(format!("run failed: {}", format_blocker_kind(blocker)).into());
            }
            return Err("run failed".into());
        }
        ExecutionState::Cancelled => return Err("run cancelled".into()),
        ExecutionState::Admitted | ExecutionState::Running | ExecutionState::Waiting { .. } => {
            return Err("execution was not terminal after Ended".into());
        }
    }

    let Some(mut page) = answer else {
        return Ok(None);
    };
    let mut text = page.text;
    let mut prev_offset = 0;
    while let Some(next) = page.next {
        if next.run_id != execution.run_id || next.offset <= prev_offset {
            return Err("agent.work answer pagination did not advance".into());
        }
        prev_offset = next.offset;
        let next_page = match query::<Work>(
            host,
            "agent",
            "work",
            json!({
                "sessionId": session_id,
                "target": WorkTarget::Message { message_id: message_id.to_owned() },
                "cursor": next,
            }),
        )
        .await?
        {
            Work::Delivered {
                answer: Some(next_page),
                ..
            } => next_page,
            Work::Delivered { answer: None, .. } => {
                return Err("agent.work answer pagination missing subsequent page".into());
            }
            Work::Changed => {
                return Err("agent.work answer changed during pagination".into());
            }
            Work::Missing => {
                return Err("agent.work execution missing during pagination".into());
            }
            Work::Pending | Work::Cancelled => {
                return Err("unexpected non-delivered agent.work state during pagination".into());
            }
        };
        text.push_str(&next_page.text);
        page = next_page;
    }
    Ok(Some(text))
}

async fn read_failure_diagnostic(
    host: &HostClient,
    session_id: &str,
    ended_sequence: u64,
) -> Option<String> {
    let Ok(HistoryPage::Ready { chunks, .. }) = query::<HistoryPage>(
        host,
        "agent",
        "history",
        json!({
            "sessionId": session_id,
            "through": ended_sequence,
            "position": HistoryPosition::Event {
                sequence: ended_sequence,
            },
        }),
    )
    .await
    else {
        return None;
    };
    chunks.into_iter().find_map(|chunk| {
        (chunk.role == Role::Failure
            && matches!(
                chunk.position,
                HistoryRowAddress::Live { sequence, .. } if sequence == ended_sequence
            ))
        .then_some(chunk.text)
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty())
    })
}

async fn cancel_work(
    host: &HostClient,
    session_id: &str,
    message_id: &str,
    mut queue_revision: u64,
) -> Result<(), HostError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let mut poll = tokio::time::interval(Duration::from_millis(25));
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let run_id = loop {
        match query::<Work>(
            host,
            "agent",
            "work",
            json!({
                "sessionId": session_id,
                "target": WorkTarget::Message { message_id: message_id.to_owned() },
                "cursor": Value::Null,
            }),
        )
        .await?
        {
            Work::Pending => {
                match mutate_checked::<QueueMutationResult>(
                    host,
                    "agent",
                    "editQueue",
                    json!({
                        "sessionId": session_id,
                        "expectedRevision": queue_revision,
                        "edit": QueueAction::Retract {
                            message_id: message_id.to_owned(),
                        },
                    }),
                )
                .await
                {
                    Ok(
                        QueueMutationResult::Committed { .. }
                        | QueueMutationResult::Rejected {
                            reason: QueueRejection::Closed,
                        },
                    ) => return Ok(()),
                    Ok(QueueMutationResult::RevisionConflict { actual, .. }) => {
                        queue_revision = actual;
                    }
                    Ok(QueueMutationResult::Rejected { reason }) => {
                        return Err(format!(
                            "queue retract rejected: {}",
                            format_queue_rejection(&reason)
                        )
                        .into());
                    }
                    Err(MutationError::Other(err)) => return Err(err),
                    Err(MutationError::Rejected(diagnostic)) => {
                        // A scheduler consume between `editQueue` prepare and SQLite commit surfaces
                        // as `OperationResult::Failure` instead of `RevisionConflict`. Check
                        // `agent.queue` before retrying so persistent errors fail immediately.
                        let queue: Queue =
                            query(host, "agent", "queue", json!({ "sessionId": session_id }))
                                .await?;
                        let still_pending = queue
                            .entries
                            .iter()
                            .any(|entry| entry.message_id == message_id);
                        if !still_pending {
                            if tokio::time::Instant::now() >= deadline {
                                return Err(
                                    "timed out waiting for cancelled execution to settle".into()
                                );
                            }
                            continue;
                        }
                        if queue.revision != queue_revision {
                            queue_revision = queue.revision;
                        } else {
                            return Err(diagnostic.into());
                        }
                    }
                }
            }
            Work::Delivered { execution, .. } => {
                if !matches!(
                    execution.state,
                    ExecutionState::Completed
                        | ExecutionState::Failed { .. }
                        | ExecutionState::Cancelled
                ) {
                    let _: Stopped = mutate(
                        host,
                        "agent",
                        "stop",
                        json!({ "sessionId": session_id, "runId": execution.run_id }),
                    )
                    .await?;
                }
                break execution.run_id;
            }
            Work::Cancelled | Work::Missing => return Ok(()),
            Work::Changed => {
                return Err("unexpected agent.work Changed without cursor".into());
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("timed out waiting for cancelled execution to settle".into());
        }
        poll.tick().await;
    };

    loop {
        match query::<WorkReadiness>(
            host,
            "agent",
            "workReadiness",
            json!({
                "sessionId": session_id,
                "target": WorkTarget::Run { run_id },
                "cursor": Value::Null,
            }),
        )
        .await?
        {
            WorkReadiness::Ready => return Ok(()),
            WorkReadiness::Unavailable => {
                return Err("cancelled execution became unavailable before settling".into());
            }
            WorkReadiness::Pending => {}
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("timed out waiting for cancelled execution to settle".into());
        }
        poll.tick().await;
    }
}

async fn open_call(
    host: &HostClient,
    endpoint: &str,
    method: &str,
    input: Value,
) -> Result<LocalCall, HostError> {
    let mut call = host
        .call(endpoint, method.into(), input, Default::default())
        .await?;
    call.start().await?;
    Ok(call)
}

async fn query<T: DeserializeOwned>(
    host: &HostClient,
    endpoint: &str,
    method: &str,
    input: Value,
) -> Result<T, HostError> {
    let mut call = open_call(host, endpoint, method, input).await?;
    match call.receive().await? {
        Reply::Finished { result, cleanup } => {
            cleanup?;
            Ok(serde_json::from_value(result?)?)
        }
        Reply::Aborted { reason, cleanup } => {
            cleanup?;
            Err(reason.into())
        }
        _ => {
            let _ = call.close().await;
            Err(format!("unexpected reply for {endpoint}.{method} query").into())
        }
    }
}

async fn mutate<T: DeserializeOwned>(
    host: &HostClient,
    endpoint: &str,
    method: &str,
    input: Value,
) -> Result<T, HostError> {
    mutate_checked(host, endpoint, method, input)
        .await
        .map_err(HostError::from)
}

async fn mutate_checked<T: DeserializeOwned>(
    host: &HostClient,
    endpoint: &str,
    method: &str,
    input: Value,
) -> Result<T, MutationError> {
    let mut call = open_call(host, endpoint, method, input)
        .await
        .map_err(MutationError::Other)?;
    match call.receive().await.map_err(other_mutation_error)? {
        Reply::Prepared { .. } => {}
        Reply::Aborted { reason, cleanup } => {
            cleanup.map_err(other_mutation_error)?;
            return Err(MutationError::Other(reason.into()));
        }
        _ => {
            let _ = call.close().await;
            return Err(MutationError::Other(
                format!("expected preparation for {endpoint}.{method}").into(),
            ));
        }
    }
    let mut reply = call
        .confirm(Value::Null)
        .await
        .map_err(other_mutation_error)?;
    loop {
        match reply {
            Reply::Mutation { reply, cleanup } => {
                cleanup.map_err(other_mutation_error)?;
                return match reply.receipt {
                    Receipt::Recorded {
                        outcome:
                            OperationOutcome::Returned {
                                result: OperationResult::Success { value },
                            },
                        cleanup: OperationCleanup::Confirmed,
                    } => serde_json::from_value(value).map_err(other_mutation_error),
                    Receipt::Recorded {
                        outcome:
                            OperationOutcome::Returned {
                                result: OperationResult::Failure { diagnostic },
                            },
                        cleanup: OperationCleanup::Confirmed,
                    } => Err(MutationError::Rejected(diagnostic)),
                    Receipt::Recorded {
                        outcome: OperationOutcome::NotExecuted { .. },
                        cleanup: OperationCleanup::Confirmed,
                    } => Err(MutationError::Other(
                        format!("{endpoint}.{method} prevented before execution").into(),
                    )),
                    other => Err(MutationError::Other(
                        format!(
                            "{endpoint}.{method} unconfirmed receipt: {}",
                            format_unconfirmed_receipt(&other)
                        )
                        .into(),
                    )),
                };
            }
            Reply::Progress { .. } => reply = call.receive().await.map_err(other_mutation_error)?,
            Reply::Aborted { reason, cleanup } => {
                cleanup.map_err(other_mutation_error)?;
                return Err(MutationError::Other(reason.into()));
            }
            _ => {
                let _ = call.close().await;
                return Err(MutationError::Other(
                    format!("expected mutation receipt for {endpoint}.{method}").into(),
                ));
            }
        }
    }
}

struct Subscription(LocalCall);

async fn subscribe(
    host: &HostClient,
    endpoint: &str,
    method: &str,
    input: Value,
) -> Result<Subscription, HostError> {
    let mut call = open_call(host, endpoint, method, input).await?;
    match call.receive().await? {
        Reply::Subscribed => Ok(Subscription(call)),
        Reply::Aborted { reason, cleanup } => {
            cleanup?;
            Err(reason.into())
        }
        _ => {
            let _ = call.close().await;
            Err(format!("expected subscription acceptance for {endpoint}.{method}").into())
        }
    }
}

impl Subscription {
    async fn next<T: DeserializeOwned>(&mut self) -> Result<T, HostError> {
        match self.0.pull().await? {
            Reply::Item { value } => Ok(serde_json::from_value(value)?),
            Reply::Aborted { reason, cleanup } => {
                cleanup?;
                Err(reason.into())
            }
            Reply::Finished { result, cleanup } => {
                cleanup?;
                result?;
                Err("application subscription ended".into())
            }
            _ => Err("unexpected application subscription reply".into()),
        }
    }

    async fn close(mut self) -> Result<(), HostError> {
        self.0.close().await.map_err(Into::into)
    }
}

fn format_rejection(reason: &Rejection) -> &'static str {
    match reason {
        Rejection::PresetNotFound => "preset not found",
        Rejection::PresetDisabled => "preset disabled",
        Rejection::PresetConflict => "preset conflict",
        Rejection::PresetModelUnavailable => "preset model unavailable",
        Rejection::PresetThinkingLevelUnavailable => "preset thinking level unavailable",
        Rejection::PresetBackendConflict => "preset backend conflict",
        Rejection::PermissionChangeRequiresUser => "permission change requires user approval",
        Rejection::TitleInvalid => "title is invalid",
        Rejection::LabelsInvalid => "labels are invalid",
        Rejection::ToolsUnavailable => "tools unavailable",
        Rejection::Busy => "session is busy",
        Rejection::WorkspaceUnavailable => "workspace unavailable",
        Rejection::SessionUnavailable => "session unavailable",
        Rejection::HistoryUnavailable => "history unavailable",
        Rejection::Closed => "session is closed",
    }
}

fn format_send_rejection(reason: &SendRejection) -> &'static str {
    match reason {
        SendRejection::ModelUnavailable => "model unavailable",
        SendRejection::WorkspaceUnavailable => "workspace unavailable",
        SendRejection::SkillsUnavailable => "skills unavailable",
        SendRejection::TurnStopped => "turn stopped",
        SendRejection::OriginalOperationUnsettled => "original operation unsettled",
    }
}

fn format_queue_rejection(reason: &QueueRejection) -> &'static str {
    match reason {
        QueueRejection::NotYourMessage => "not your message",
        QueueRejection::Closed => "session is closed",
        QueueRejection::Missing => "queued message missing",
        QueueRejection::InFlight => "message is already in flight",
        QueueRejection::InvalidEdit => "invalid queue edit",
        QueueRejection::ExecutionChanged => "execution changed",
        QueueRejection::NotRunning => "execution is not running",
    }
}

fn format_interaction_kind(kind: &InteractionKind) -> &'static str {
    match kind {
        InteractionKind::SessionApproval => "session_approval",
        InteractionKind::ServiceApproval => "service_approval",
        InteractionKind::Question => "question",
        InteractionKind::Permissions => "permissions",
        InteractionKind::Form => "form",
        InteractionKind::ClientCapability => "client_capability",
        InteractionKind::ComputerApp => "computer_app",
        InteractionKind::SystemPermission => "system_permission",
    }
}

fn format_blocker_kind(blocker: &BlockerKind) -> Cow<'_, str> {
    match blocker {
        BlockerKind::ExternalPublicationUnavailable { diagnostic, .. }
        | BlockerKind::CurrentAuthorityUnavailable { diagnostic, .. }
        | BlockerKind::ToolCleanupUnconfirmed { diagnostic, .. }
        | BlockerKind::ModelCleanupUnconfirmed { diagnostic, .. }
            if !diagnostic.trim().is_empty() =>
        {
            Cow::Borrowed(diagnostic.trim())
        }
        BlockerKind::ExternalPublicationUnavailable { .. } => {
            Cow::Borrowed("external publication unavailable")
        }
        BlockerKind::ExternalPublicationItem { .. } => {
            Cow::Borrowed("external publication item blocked")
        }
        BlockerKind::CurrentAuthorityUnavailable { .. } => {
            Cow::Borrowed("current authority unavailable")
        }
        BlockerKind::ExternalEffectUnknown { .. } => {
            Cow::Borrowed("external effect outcome unknown")
        }
        BlockerKind::OperationUnknown { .. } => Cow::Borrowed("operation outcome unknown"),
        BlockerKind::ProviderEffectUnknown { .. } => Cow::Borrowed("provider tool effect unknown"),
        BlockerKind::OriginalAdmissionUnknown { .. } => {
            Cow::Borrowed("original tool admission unknown")
        }
        BlockerKind::CodeCellRecoveryUnavailable { .. } => {
            Cow::Borrowed("code cell recovery unavailable")
        }
        BlockerKind::UnsupportedProtocol { .. } => Cow::Borrowed("unsupported protocol"),
        BlockerKind::ToolCleanupUnconfirmed { .. } => Cow::Borrowed("tool cleanup unconfirmed"),
        BlockerKind::ModelCleanupUnconfirmed { .. } => Cow::Borrowed("model cleanup unconfirmed"),
        BlockerKind::CleanupUnconfirmed { .. } => Cow::Borrowed("operation cleanup unconfirmed"),
        BlockerKind::ResourcesUnavailable { .. } => {
            Cow::Borrowed("operation resources unavailable")
        }
        BlockerKind::ExternalTaskUnobservable { .. } => Cow::Borrowed("external task unobservable"),
    }
}

fn format_unconfirmed_receipt(receipt: &Receipt) -> String {
    match receipt {
        Receipt::NotRecorded => "receipt not recorded".into(),
        Receipt::Unavailable { diagnostic } => match diagnostic.trim() {
            "" => "receipt unavailable".into(),
            diag => format!("receipt unavailable: {diag}"),
        },
        Receipt::Recorded { outcome, cleanup } => {
            let outcome_desc = match outcome {
                OperationOutcome::Unresolved => Cow::Borrowed("outcome unresolved"),
                OperationOutcome::Returned { .. } => Cow::Borrowed("outcome recorded"),
                OperationOutcome::NotExecuted { .. } => Cow::Borrowed("not executed"),
                OperationOutcome::Unknown { diagnostic } => match diagnostic.trim() {
                    "" => Cow::Borrowed("outcome unknown"),
                    diag => Cow::Owned(format!("outcome unknown: {diag}")),
                },
            };
            let cleanup_desc = match cleanup {
                OperationCleanup::Confirmed => Cow::Borrowed("cleanup confirmed"),
                OperationCleanup::Unconfirmed => Cow::Borrowed("cleanup unconfirmed"),
                OperationCleanup::Failed { diagnostic } => match diagnostic.trim() {
                    "" => Cow::Borrowed("cleanup failed"),
                    diag => Cow::Owned(format!("cleanup failed: {diag}")),
                },
            };
            format!("{outcome_desc}; {cleanup_desc}")
        }
    }
}
