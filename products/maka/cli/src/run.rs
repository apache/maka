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

//! Headless Agent prompt execution and Session follow-up over the public Host client.

use std::{
    borrow::Cow,
    io::{IsTerminal, Read, Write},
    path::PathBuf,
    process::ExitCode,
    time::Duration,
};

use maka_agent_api::contract::{
    AnswerCursor, BackendPreference, Created, DeliveryFact, DeliveryPage, ExecutionState,
    HistoryPage, HistoryPosition, InteractionKind, InteractionRejection, InteractionResult,
    Observation, PendingInteractions, Queue, QueueAction, QueueKind, QueueMutationResult,
    QueueRejection, Rejection, SendRejection, SendResult, Stopped, Work, WorkReadiness, WorkTarget,
};
use maka_agent_facts::{
    durable::{BlockerKind, RunId},
    interaction::{InteractionAnswer, InteractionQuestion, InteractionRecord, InteractionRequest},
};
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
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

#[derive(clap::Args)]
pub(super) struct Args {
    /// Business Host Root (default: ~/.maka/application/host).
    #[arg(long, value_name = "DIRECTORY")]
    root: Option<PathBuf>,
    /// Workspace directory for a new session (default: current directory).
    #[arg(long, value_name = "DIRECTORY", conflicts_with = "session")]
    workspace: Option<PathBuf>,
    /// Continue this session instead of creating one; exits 3 when it then waits for a decision.
    #[arg(long, value_name = "ID")]
    session: Option<String>,
    /// Wait for the session's current work and print its result without sending a prompt.
    #[arg(long, requires = "session", conflicts_with_all = ["prompt", "answer", "no_wait"])]
    wait: bool,
    /// Answer the session's pending question with a JSON array holding a string or null per question.
    #[arg(
        long,
        value_name = "JSON",
        requires = "session",
        conflicts_with = "prompt",
        value_parser = parse_answers
    )]
    answer: Option<Answers>,
    /// Print a JSON receipt once the prompt or answer is accepted instead of waiting for the result.
    #[arg(long)]
    no_wait: bool,
    /// Stop the session's active run and wait until it settles.
    #[arg(
        long = "stop",
        requires = "session",
        conflicts_with_all = ["prompt", "answer", "wait", "no_wait"]
    )]
    stop_run: bool,
    /// Prompt text; reads UTF-8 text from stdin when omitted.
    #[arg(value_name = "PROMPT")]
    prompt: Option<String>,
}

#[derive(Clone)]
struct Answers(Vec<Option<String>>);

fn parse_answers(value: &str) -> Result<Answers, String> {
    serde_json::from_str(value)
        .map(Answers)
        .map_err(|error| format!("expected a JSON array of strings or nulls: {error}"))
}

enum Action {
    Start {
        workspace: String,
        prompt: String,
    },
    Send {
        session_id: String,
        prompt: String,
    },
    Answer {
        session_id: String,
        answers: Vec<Option<String>>,
    },
    Wait {
        session_id: String,
    },
    Stop {
        session_id: String,
    },
}

enum Target {
    /// A message this invocation queued; interrupting the wait withdraws it.
    Submitted {
        message_id: String,
        revision: u64,
    },
    /// Work queued or started elsewhere; interrupting only stops observing it.
    Message(String),
    Run(RunId),
}

/// What a wait does when the Session stops on a pending interaction.
#[derive(Clone, Copy)]
enum OnPending {
    /// A single-shot run cancels its work and fails, as scripts and CI expect.
    Fail,
    /// A Session follow-up leaves the Run waiting and reports what it needs.
    Report,
}

/// What a `--wait` finds in the Session.
enum Current {
    Unfinished { target: Target, through: u64 },
    Ended(RunId),
}

enum Followed {
    Finished {
        run_id: RunId,
        ended: Option<u64>,
        delivered: Option<Box<Work>>,
    },
    Waiting(Vec<Pending>),
    Blocked(String),
    Cancelled,
    Interrupted,
}

enum Outcome {
    Answer(Option<String>),
    Report(Report),
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum Report {
    Submitted {
        session_id: String,
    },
    Waiting {
        session_id: String,
        interactions: Vec<Pending>,
    },
    Stopped {
        session_id: String,
    },
}

impl Report {
    /// Waiting exits with 3 so scripts need not parse stdout; clap uses 2 for usage errors.
    fn exit_code(&self) -> ExitCode {
        match self {
            Self::Waiting { .. } => ExitCode::from(3),
            Self::Submitted { .. } | Self::Stopped { .. } => ExitCode::SUCCESS,
        }
    }
}

#[derive(Serialize)]
struct Pending {
    kind: InteractionKind,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    questions: Vec<InteractionQuestion>,
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
    pub(super) async fn run(self) -> Result<ExitCode, HostError> {
        let stop = CancellationToken::new();
        let _signals = crate::signals::watch(stop.clone())?;

        let wait = !self.no_wait;
        let action = match (self.session, self.answer) {
            (None, _) => Action::Start {
                workspace: resolve_workspace(self.workspace).await?,
                prompt: read_prompt(self.prompt, &stop).await?,
            },
            (Some(session_id), Some(Answers(answers))) => Action::Answer {
                session_id,
                answers,
            },
            (Some(session_id), None) if self.wait => Action::Wait { session_id },
            (Some(session_id), None) if self.stop_run => Action::Stop { session_id },
            (Some(session_id), None) => Action::Send {
                session_id,
                prompt: read_prompt(self.prompt, &stop).await?,
            },
        };
        let root = crate::application::root_path(self.root)?;

        let mut host_client = tokio::select! {
            biased;
            _ = stop.cancelled() => return Err("run cancelled before connecting to Host".into()),
            result = crate::deployment::connect_local(root) => result?,
        };

        let outcome = async {
            if let Some(error) = host_client.catalogue().startup_error() {
                return Err(format!("Host startup failed: {error}").into());
            }
            execute(&host_client, action, wait, &stop).await
        }
        .await;

        // Both paths detach with `close()` so an ephemeral Host retires after
        // idle grace when no background services remain active, without killing
        // background services left running by other or prior runs on the Root.
        match (outcome, host_client.close().await) {
            (Ok(outcome), Ok(())) => match outcome {
                Outcome::Answer(Some(answer)) if !answer.is_empty() => {
                    write_stdout(answer, &stop).await?;
                    Ok(ExitCode::SUCCESS)
                }
                Outcome::Answer(_) => Ok(ExitCode::SUCCESS),
                Outcome::Report(report) => {
                    write_stdout(serde_json::to_string(&report)?, &stop).await?;
                    Ok(report.exit_code())
                }
            },
            (Ok(_), Err(cleanup_err)) => Err(cleanup_err.into()),
            (Err(err), Ok(())) => Err(err),
            (Err(err), Err(cleanup_err)) => {
                Err(format!("{err}; Host cleanup failed: {cleanup_err}").into())
            }
        }
    }
}

async fn execute(
    host: &HostClient,
    action: Action,
    wait: bool,
    stop: &CancellationToken,
) -> Result<Outcome, HostError> {
    match action {
        Action::Start { workspace, prompt } => {
            let backend = default_backend(host).await?;
            let session_id = create_session(host, &workspace, backend).await?;
            // A new Session has no earlier history to skip.
            let after = wait.then_some(0);
            submit(host, session_id, prompt, after, OnPending::Fail, stop).await
        }
        Action::Send { session_id, prompt } => {
            let after = if wait {
                Some(observe(host, &session_id).await?.through)
            } else {
                None
            };
            submit(host, session_id, prompt, after, OnPending::Report, stop).await
        }
        Action::Answer {
            session_id,
            answers,
        } => {
            let run_id = answer_question(host, &session_id, answers).await?;
            if !wait {
                return Ok(Outcome::Report(Report::Submitted { session_id }));
            }
            let through = observe(host, &session_id).await?.through;
            let target = Target::Run(run_id);
            follow_target(host, &session_id, target, through, OnPending::Report, stop).await
        }
        Action::Wait { session_id } => match current_work(host, &session_id).await? {
            Current::Unfinished { target, through } => {
                follow_target(host, &session_id, target, through, OnPending::Report, stop).await
            }
            Current::Ended(run_id) => {
                report_result(host, &session_id, run_id, None, None, stop).await
            }
        },
        Action::Stop { session_id } => {
            let run = observe(host, &session_id)
                .await?
                .run
                .ok_or("session has no active run")?;
            let stopped: Stopped = mutate(
                host,
                "agent",
                "stop",
                json!({ "sessionId": session_id, "runId": run.run_id }),
            )
            .await?;
            // The Run ended before the stop reached it.
            if !stopped.requested {
                return Err("session has no active run".into());
            }
            tokio::select! {
                biased;
                _ = stop.cancelled() => return Err("interrupted by signal".into()),
                res = settle(host, &session_id, run.run_id) => res?,
            }
            Ok(Outcome::Report(Report::Stopped { session_id }))
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

async fn create_session(
    host: &HostClient,
    workspace_path: &str,
    backend: BackendPreference,
) -> Result<String, HostError> {
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
    match created {
        Created::Created { session } => Ok(session.id),
        Created::Rejected { reason } => {
            Err(format!("session creation rejected: {}", format_rejection(&reason)).into())
        }
    }
}

async fn observe(host: &HostClient, session_id: &str) -> Result<Observation, HostError> {
    query(host, "agent", "observe", json!({ "sessionId": session_id })).await
}

/// Queues `prompt`; with `after`, follows it from that history cut.
async fn submit(
    host: &HostClient,
    session_id: String,
    prompt: String,
    after: Option<u64>,
    on_pending: OnPending,
    stop: &CancellationToken,
) -> Result<Outcome, HostError> {
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

    let Some(after) = after else {
        return Ok(Outcome::Report(Report::Submitted { session_id }));
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
    follow_target(
        host,
        &session_id,
        Target::Submitted {
            message_id,
            revision,
        },
        after,
        on_pending,
        stop,
    )
    .await
}

async fn answer_question(
    host: &HostClient,
    session_id: &str,
    answers: Vec<Option<String>>,
) -> Result<RunId, HostError> {
    let pending: PendingInteractions = query(
        host,
        "agent",
        "pendingInteractions",
        json!({ "sessionId": session_id }),
    )
    .await?;
    let questions: Vec<_> = pending
        .entries
        .iter()
        .filter(|entry| matches!(entry.kind, InteractionKind::Question))
        .collect();
    let request_id = match questions.as_slice() {
        [entry] => &entry.request_id,
        [] => return Err("session has no pending question".into()),
        _ => return Err("session has more than one pending question".into()),
    };
    let answer = InteractionAnswer::Question { answers };
    let result: InteractionResult = mutate(
        host,
        "agent",
        "respond",
        json!({
            "sessionId": session_id,
            "requestId": request_id,
            "answer": answer,
        }),
    )
    .await?;
    match result {
        InteractionResult::Recorded { record } => match &record.outcome {
            Some(outcome) if answer.matches_outcome(outcome) => Ok(record.execution.run_id),
            _ => Err("question was already answered or closed".into()),
        },
        InteractionResult::Rejected { reason } => {
            Err(format!("answer rejected: {}", format_interaction_rejection(&reason)).into())
        }
    }
}

/// The latest unfinished work: the last runnable queued message or the active
/// Run. An idle Session reports its most recent Run.
async fn current_work(host: &HostClient, session_id: &str) -> Result<Current, HostError> {
    // Read the queue first: a message admitted between the two reads is then
    // visible as the observed Run instead of being skipped.
    let queue: Queue = query(host, "agent", "queue", json!({ "sessionId": session_id })).await?;
    let observation = observe(host, session_id).await?;
    let unfinished = queue
        .entries
        .into_iter()
        .rev()
        .find(|entry| !matches!(entry.kind, QueueKind::Held))
        .map(|entry| Target::Message(entry.message_id))
        .or_else(|| observation.run.map(|run| Target::Run(run.run_id)));
    match (unfinished, observation.latest_run_id) {
        (Some(target), _) => Ok(Current::Unfinished {
            target,
            through: observation.through,
        }),
        (None, Some(run_id)) => Ok(Current::Ended(run_id)),
        (None, None) => Err("session has no work to wait for".into()),
    }
}

async fn follow_target(
    host: &HostClient,
    session_id: &str,
    target: Target,
    after: u64,
    on_pending: OnPending,
    stop: &CancellationToken,
) -> Result<Outcome, HostError> {
    let mut watch = match subscribe(
        host,
        "agent",
        "watch",
        json!({ "sessionId": session_id, "after": after }),
    )
    .await
    {
        Ok(watch) => watch,
        Err(err) => return Err(withdraw(host, session_id, &target, err.to_string()).await),
    };

    let outcome = match follow(host, session_id, &target, &mut watch, on_pending, stop).await {
        Ok(Followed::Finished {
            run_id,
            ended,
            delivered,
        }) => report_result(host, session_id, run_id, ended, delivered, stop).await,
        Ok(Followed::Waiting(interactions)) => Ok(Outcome::Report(Report::Waiting {
            session_id: session_id.to_owned(),
            interactions,
        })),
        Ok(Followed::Blocked(reason)) => Err(withdraw(host, session_id, &target, reason).await),
        Ok(Followed::Cancelled) => Err("queued message was cancelled before execution".into()),
        Ok(Followed::Interrupted) => {
            Err(withdraw(host, session_id, &target, "interrupted by signal".into()).await)
        }
        Err(err) => Err(withdraw(host, session_id, &target, err.to_string()).await),
    };

    let close_watch = watch.close().await;
    match (outcome, close_watch) {
        (Ok(outcome), Ok(())) => Ok(outcome),
        (Err(err), _) => Err(err),
        (Ok(_), Err(close_err)) => Err(format!("watch close failed: {close_err}").into()),
    }
}

async fn withdraw(
    host: &HostClient,
    session_id: &str,
    target: &Target,
    reason: String,
) -> HostError {
    match target {
        Target::Submitted {
            message_id,
            revision,
        } => cancel_with_reason(host, session_id, message_id, *revision, &reason).await,
        Target::Message(_) | Target::Run(_) => reason.into(),
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

async fn write_stdout(mut text: String, stop: &CancellationToken) -> Result<(), HostError> {
    if stop.is_cancelled() {
        return Err("interrupted by signal".into());
    }
    if !text.ends_with('\n') {
        text.push('\n');
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    // Dedicated OS thread so a signal exits promptly even when stdout's pipe is full,
    // without blocking Tokio's shutdown pool.
    std::thread::Builder::new()
        .name("maka-run-stdout".into())
        .spawn(move || {
            let mut stdout = std::io::stdout().lock();
            let res = stdout
                .write_all(text.as_bytes())
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

/// Follows `target` until its Run ends or the Session needs a decision.
async fn follow(
    host: &HostClient,
    session_id: &str,
    target: &Target,
    watch: &mut Subscription,
    on_pending: OnPending,
    stop: &CancellationToken,
) -> Result<Followed, HostError> {
    let (message_id, mut run_id) = match target {
        Target::Submitted { message_id, .. } | Target::Message(message_id) => {
            (Some(message_id.as_str()), None)
        }
        Target::Run(run_id) => (None, Some(*run_id)),
    };
    // Checked after subscribing: a Run that ends later still delivers Ended.
    if let Some(run_id) = run_id {
        let delivered = work(host, session_id, WorkTarget::Run { run_id }, None).await?;
        let Work::Delivered { execution, .. } = &delivered else {
            return Err("agent.work did not return delivered execution".into());
        };
        if is_terminal(&execution.state) {
            return Ok(Followed::Finished {
                run_id,
                ended: None,
                delivered: Some(Box::new(delivered)),
            });
        }
    }
    let mut queued = true;
    loop {
        let page = tokio::select! {
            biased;
            _ = stop.cancelled() => return Ok(Followed::Interrupted),
            page = watch.next::<DeliveryPage>() => page?,
        };
        match page {
            DeliveryPage::Queue { queue } => {
                if let Some(message_id) = message_id {
                    queued = queue
                        .entries
                        .iter()
                        .any(|entry| entry.message_id == message_id);
                }
            }
            DeliveryPage::Interactions { pending } if !pending.entries.is_empty() => {
                if let OnPending::Fail = on_pending {
                    return Ok(Followed::Blocked(blocked_by(&pending)));
                }
                let interactions = tokio::select! {
                    biased;
                    _ = stop.cancelled() => return Ok(Followed::Interrupted),
                    interactions = describe_interactions(host, session_id, pending) => interactions?,
                };
                // Empty when every question was answered or closed since this page.
                if !interactions.is_empty() {
                    return Ok(Followed::Waiting(interactions));
                }
            }
            DeliveryPage::Events { events, .. } => {
                if let Some(run_id) = run_id
                    && let Some(ended) = events.iter().find(|event| {
                        event.run_id == run_id && matches!(event.fact, DeliveryFact::Ended { .. })
                    })
                {
                    return Ok(Followed::Finished {
                        run_id,
                        ended: Some(ended.sequence),
                        delivered: None,
                    });
                }
            }
            _ => {}
        }
        if run_id.is_none()
            && !queued
            && let Some(message_id) = message_id
        {
            let target = WorkTarget::Message {
                message_id: message_id.to_owned(),
            };
            let delivered = work(host, session_id, target, None).await?;
            match &delivered {
                Work::Cancelled | Work::Missing => return Ok(Followed::Cancelled),
                Work::Delivered { execution, .. } if is_terminal(&execution.state) => {
                    return Ok(Followed::Finished {
                        run_id: execution.run_id,
                        ended: None,
                        delivered: Some(Box::new(delivered)),
                    });
                }
                Work::Delivered { execution, .. } => run_id = Some(execution.run_id),
                Work::Pending | Work::Changed => {}
            }
        }
    }
}

fn blocked_by(pending: &PendingInteractions) -> String {
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
    format!(
        "execution blocked by pending interaction(s): {}",
        items.join(", ")
    )
}

/// Pending interactions with their question text, skipping questions already closed.
async fn describe_interactions(
    host: &HostClient,
    session_id: &str,
    pending: PendingInteractions,
) -> Result<Vec<Pending>, HostError> {
    let mut interactions = Vec::with_capacity(pending.entries.len());
    for entry in pending.entries {
        let questions = if matches!(entry.kind, InteractionKind::Question) {
            let record: InteractionRecord = query(
                host,
                "agent",
                "interaction",
                json!({ "sessionId": session_id, "requestId": entry.request_id }),
            )
            .await?;
            if record.outcome.is_some() {
                continue;
            }
            let InteractionRequest::Question { questions, .. } = record.request else {
                return Err("pending question has a non-question request".into());
            };
            questions
        } else {
            Vec::new()
        };
        interactions.push(Pending {
            kind: entry.kind,
            questions,
        });
    }
    Ok(interactions)
}

async fn report_result(
    host: &HostClient,
    session_id: &str,
    run_id: RunId,
    ended: Option<u64>,
    delivered: Option<Box<Work>>,
    stop: &CancellationToken,
) -> Result<Outcome, HostError> {
    tokio::select! {
        biased;
        _ = stop.cancelled() => Err("interrupted by signal".into()),
        res = read_result(host, session_id, run_id, ended, delivered) => res.map(Outcome::Answer),
    }
}

/// Reads the ended Run's answer, starting from `delivered` when it was already fetched.
async fn read_result(
    host: &HostClient,
    session_id: &str,
    run_id: RunId,
    ended: Option<u64>,
    delivered: Option<Box<Work>>,
) -> Result<Option<String>, HostError> {
    let delivered = match delivered {
        Some(delivered) => *delivered,
        None => work(host, session_id, WorkTarget::Run { run_id }, None).await?,
    };
    let Work::Delivered {
        execution, answer, ..
    } = delivered
    else {
        return Err("agent.work did not return delivered execution".into());
    };
    match &execution.state {
        ExecutionState::Completed => {}
        ExecutionState::Failed { reason } => {
            if let Some(diag) = read_failure_diagnostic(host, session_id, run_id, ended).await {
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
        let next_page = match work(host, session_id, WorkTarget::Run { run_id }, Some(next)).await?
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

/// The Run's failure row, read at its Ended sequence when known.
async fn read_failure_diagnostic(
    host: &HostClient,
    session_id: &str,
    run_id: RunId,
    ended: Option<u64>,
) -> Option<String> {
    let Ok(HistoryPage::Ready { chunks, .. }) = query::<HistoryPage>(
        host,
        "agent",
        "history",
        json!({
            "sessionId": session_id,
            "through": ended,
            "position": HistoryPosition::Tail,
        }),
    )
    .await
    else {
        return None;
    };
    chunks.into_iter().rev().find_map(|chunk| {
        (chunk.role == Role::Failure && chunk.run_id == Some(run_id))
            .then_some(chunk.text)
            .map(|text| text.trim().to_owned())
            .filter(|text| !text.is_empty())
    })
}

async fn work(
    host: &HostClient,
    session_id: &str,
    target: WorkTarget,
    cursor: Option<AnswerCursor>,
) -> Result<Work, HostError> {
    query(
        host,
        "agent",
        "work",
        json!({ "sessionId": session_id, "target": target, "cursor": cursor }),
    )
    .await
}

fn is_terminal(state: &ExecutionState) -> bool {
    matches!(
        state,
        ExecutionState::Completed | ExecutionState::Failed { .. } | ExecutionState::Cancelled
    )
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
        let target = WorkTarget::Message {
            message_id: message_id.to_owned(),
        };
        match work(host, session_id, target, None).await? {
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
                if !is_terminal(&execution.state) {
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
    settle_until(host, session_id, run_id, deadline).await
}

async fn settle(host: &HostClient, session_id: &str, run_id: RunId) -> Result<(), HostError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    settle_until(host, session_id, run_id, deadline).await
}

async fn settle_until(
    host: &HostClient,
    session_id: &str,
    run_id: RunId,
    deadline: tokio::time::Instant,
) -> Result<(), HostError> {
    let mut poll = tokio::time::interval(Duration::from_millis(25));
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
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

fn format_interaction_rejection(reason: &InteractionRejection) -> &'static str {
    match reason {
        InteractionRejection::NotYourChild => "not your child session",
        InteractionRejection::HumanActionRequired => "human action required",
        InteractionRejection::AuthorizationChanged => "authorization changed",
        InteractionRejection::PermissionRequestsDisabled => "permission requests disabled",
        InteractionRejection::Closed => "question is closed",
        InteractionRejection::Unavailable => "question unavailable",
        InteractionRejection::InvalidAnswer => "invalid answer",
        InteractionRejection::Unsupported => "unsupported answer",
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
