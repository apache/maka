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
    io::{IsTerminal, Read},
    path::PathBuf,
    time::Duration,
};

use maka_agent_api::contract::{
    BackendPreference, Created, DeliveryFact, DeliveryPage, ExecutionState, HistoryPage,
    HistoryPosition, SendResult, Stopped, Work, WorkTarget,
};
use maka_agent_facts::durable::RunId;
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
    Ended,
    Interrupted(String),
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
                    if answer.ends_with('\n') {
                        print!("{answer}");
                    } else {
                        println!("{answer}");
                    }
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
        DefaultModel::Ready { choice, .. } => Ok(BackendPreference::Model {
            connection_id: choice.selection.connection_id,
            model_id: choice.selection.model_id,
            service_tier: None,
            thinking_level: None,
        }),
        DefaultModel::None => Err(
            "no default model configured; set defaultTarget via `maka host init --settings-stdin`"
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
            return Err(format!(
                "session creation rejected: {}",
                serde_json::to_string(&reason).unwrap_or_default()
            )
            .into());
        }
    };

    let mut watch = subscribe(
        host,
        "agent",
        "watch",
        json!({ "sessionId": session_id, "after": 0 }),
    )
    .await?;

    let outcome = async {
        let send_result: SendResult = mutate(
            host,
            "agent",
            "send",
            json!({
                "sessionId": session_id,
                "message": prompt,
            }),
        )
        .await?;

        let message_id = match send_result {
            SendResult::Queued { message_id, .. } => message_id,
            SendResult::Rejected { reason, .. } => {
                return Err(format!(
                    "agent.send rejected: {}",
                    serde_json::to_string(&reason).unwrap_or_default()
                )
                .into());
            }
            SendResult::Started { .. }
            | SendResult::Posted { .. }
            | SendResult::NotYourWorker { .. } => {
                return Err("unexpected agent.send result".into());
            }
        };

        let watched = observe_run(host, &session_id, &message_id, &mut watch, stop).await?;
        Ok::<_, HostError>((message_id, watched))
    }
    .await;

    let close_watch = watch.close().await;
    let (message_id, watched) = match (outcome, close_watch) {
        (Ok(pair), Ok(())) => pair,
        (Err(err), _) => return Err(err),
        (Ok(_), Err(close_err)) => return Err(format!("watch close failed: {close_err}").into()),
    };

    match watched {
        WatchOutcome::Ended => read_completed_answer(host, &session_id, &message_id).await,
        WatchOutcome::Interrupted(reason) => {
            if let Err(cancel_err) = cancel_work(host, &session_id, &message_id).await {
                return Err(format!("{reason}; cancel failed: {cancel_err}").into());
            }
            Err(reason.into())
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
    loop {
        tokio::select! {
            biased;
            _ = stop.cancelled() => return Ok(WatchOutcome::Interrupted("interrupted by signal".into())),
            page = watch.next::<DeliveryPage>() => match page? {
                DeliveryPage::Queue { queue }
                    if !queue.entries.iter().any(|entry| entry.message_id == message_id) =>
                {
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
                    if matches!(work, Work::Cancelled | Work::Missing) {
                        return Err("queued message was cancelled before execution".into());
                    }
                }
                DeliveryPage::Interactions { pending } if !pending.entries.is_empty() => {
                    let items: Vec<String> = pending
                        .entries
                        .iter()
                        .map(|entry| {
                            let kind = serde_json::to_string(&entry.kind).unwrap_or_default();
                            format!("{}({})", kind.trim_matches('"'), entry.request_id)
                        })
                        .collect();
                    return Ok(WatchOutcome::Interrupted(format!(
                        "execution blocked by pending interaction(s): {}",
                        items.join(", ")
                    )));
                }
                DeliveryPage::Events { events, .. }
                    if events.iter().any(|ev| matches!(ev.fact, DeliveryFact::Ended { .. })) =>
                {
                    return Ok(WatchOutcome::Ended);
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
            if let Some(diag) = read_failure_diagnostic(host, session_id, execution.run_id).await {
                return Err(format!("run failed: {diag}").into());
            }
            if let Some(blocker) = reason {
                return Err(format!(
                    "run failed: {}",
                    serde_json::to_string(blocker).unwrap_or_default()
                )
                .into());
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
        let Work::Delivered {
            answer: Some(next_page),
            ..
        } = query::<Work>(
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
        else {
            break;
        };
        text.push_str(&next_page.text);
        page = next_page;
    }
    Ok(Some(text))
}

async fn read_failure_diagnostic(
    host: &HostClient,
    session_id: &str,
    run_id: RunId,
) -> Option<String> {
    let Ok(HistoryPage::Ready {
        through: Some(through),
        chunks,
        ..
    }) = query::<HistoryPage>(
        host,
        "agent",
        "history",
        json!({
            "sessionId": session_id,
            "through": Value::Null,
            "position": HistoryPosition::Tail,
        }),
    )
    .await
    else {
        return None;
    };
    let position = chunks
        .into_iter()
        .rev()
        .find(|chunk| chunk.run_id == Some(run_id))?
        .position;

    let mut after: Option<u64> = None;
    let mut latest = None;
    loop {
        let Ok(page) = query::<Value>(
            host,
            "agent",
            "historyRequests",
            json!({
                "sessionId": session_id,
                "through": through,
                "position": &position,
                "after": after,
            }),
        )
        .await
        else {
            break;
        };
        if let Some(requests) = page["requests"].as_array() {
            for req in requests {
                if let Some(diag) = req["finished"]["diagnostic"]
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    latest = Some(diag.to_owned());
                }
            }
        }
        match page["next"].as_u64() {
            Some(next) if after.is_none_or(|prev| next > prev) => after = Some(next),
            _ => break,
        }
    }
    latest
}

async fn cancel_work(
    host: &HostClient,
    session_id: &str,
    message_id: &str,
) -> Result<(), HostError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let mut poll = tokio::time::interval(Duration::from_millis(50));
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut stopped_run: Option<RunId> = None;
    loop {
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
            Work::Delivered { execution, .. }
                if matches!(
                    execution.state,
                    ExecutionState::Completed
                        | ExecutionState::Failed { .. }
                        | ExecutionState::Cancelled
                ) =>
            {
                return Ok(());
            }
            Work::Delivered { execution, .. } => {
                if stopped_run != Some(execution.run_id) {
                    let _: Stopped = mutate(
                        host,
                        "agent",
                        "stop",
                        json!({ "sessionId": session_id, "runId": execution.run_id }),
                    )
                    .await?;
                    stopped_run = Some(execution.run_id);
                }
            }
            Work::Cancelled | Work::Missing => return Ok(()),
            Work::Pending | Work::Changed => {}
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
    let mut call = open_call(host, endpoint, method, input).await?;
    match call.receive().await? {
        Reply::Prepared { .. } => {}
        Reply::Aborted { reason, cleanup } => {
            cleanup?;
            return Err(reason.into());
        }
        _ => {
            let _ = call.close().await;
            return Err(format!("expected preparation for {endpoint}.{method}").into());
        }
    }
    let mut reply = call.confirm(Value::Null).await?;
    loop {
        match reply {
            Reply::Mutation { reply, cleanup } => {
                cleanup?;
                return match reply.receipt {
                    Receipt::Recorded {
                        outcome:
                            OperationOutcome::Returned {
                                result: OperationResult::Success { value },
                            },
                        cleanup: OperationCleanup::Confirmed,
                    } => Ok(serde_json::from_value(value)?),
                    Receipt::Recorded {
                        outcome:
                            OperationOutcome::Returned {
                                result: OperationResult::Failure { diagnostic },
                            },
                        cleanup: OperationCleanup::Confirmed,
                    } => Err(diagnostic.into()),
                    Receipt::Recorded {
                        outcome: OperationOutcome::NotExecuted { .. },
                        cleanup: OperationCleanup::Confirmed,
                    } => Err(format!("{endpoint}.{method} prevented before execution").into()),
                    other => Err(format!(
                        "{endpoint}.{method} unconfirmed receipt: {}",
                        serde_json::to_string(&other).unwrap_or_default()
                    )
                    .into()),
                };
            }
            Reply::Progress { .. } => reply = call.receive().await?,
            Reply::Aborted { reason, cleanup } => {
                cleanup?;
                return Err(reason.into());
            }
            _ => {
                let _ = call.close().await;
                return Err(format!("expected mutation receipt for {endpoint}.{method}").into());
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
