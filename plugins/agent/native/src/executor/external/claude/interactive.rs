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

//! Interactive Claude PTY input and native transcript observation.
use super::content_text;
use super::*;
use maka_plugin_core::{operation::OperationCleanup, terminal::TerminalSize};
use std::{path::Path, time::Duration};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

#[expect(
    clippy::too_many_arguments,
    reason = "one terminal owns the native session, tool bridge and active user input"
)]
pub(in crate::executor::external) async fn execute(
    config: &NativeCommand,
    cwd: &str,
    request: &Value,
    journal: &mut journal::ProtocolSession,
    output: Arc<dyn OutputSink>,
    bridge: Arc<mcp::Bridge>,
    stop: CancellationToken,
    steering: &mut steering::Steering,
    owner: maka_process::isolated::TaskOwner,
) -> Result<Outcome, Error> {
    let resume = journal.native_session().is_some();
    let session = journal
        .native_session()
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let cwd_path = tokio::fs::canonicalize(cwd)
        .await
        .map_err(|error| Error::Provider(error.to_string()))?;
    let cwd = cwd_path
        .to_str()
        .ok_or_else(|| Error::Invalid("Claude cwd must be UTF-8".into()))?;
    let mut cursor = Cursor::fence(transcript(config, &cwd_path, &session)?, resume).await?;
    let mcp_path = bridge.directory().join("mcp.json");
    tokio::fs::write(
        &mcp_path,
        serde_json::to_vec(&bridge.claude()).expect("MCP configuration is JSON"),
    )
    .await
    .map_err(|error| Error::Provider(format!("Claude MCP configuration failed: {error}")))?;
    let mut command = runtime::command(config, cwd).await?;
    command
        .arg("--dangerously-skip-permissions")
        .arg("--ax-screen-reader")
        .arg(if resume { "--resume" } else { "--session-id" })
        .arg(&session)
        .arg("--mcp-config")
        .arg(mcp_path);
    if let Some(model) = request["model"]
        .as_str()
        .filter(|model| *model != "default")
    {
        command.arg("--model").arg(model);
    }
    if let Some(effort) = request["effort"].as_str() {
        command.arg("--effort").arg(effort);
    }
    journal.opened(session.clone())?;
    let observation = journal.observation();
    let mut ticket = observation
        .resources
        .reserve()
        .map_err(|_| Error::ObservationRetired)?;
    ticket.start();
    let process = match owner
        .spawn_pty(
            command,
            TerminalSize::new(120, 40).expect("fixed terminal dimensions"),
        )
        .await
    {
        Ok(process) => process,
        Err(maka_process::isolated::SpawnError::Closed(error)) => {
            ticket.complete(Ok(()));
            return Err(runtime::isolation_error(error));
        }
        Err(maka_process::isolated::SpawnError::Unconfirmed(failure)) => {
            ticket.unconfirmed(failure.to_string(), failure);
            return Err(Error::CleanupUnconfirmed);
        }
    };
    let maka_process::pipe::Spawned {
        mut child,
        mut stdin,
        mut stdout,
        mut stderr,
    } = process;
    let (screen_sender, mut screen) = tokio::sync::watch::channel(input::Screen::default());
    let terminal_done = CancellationToken::new();
    let settled = CancellationToken::new();
    let terminal = {
        let terminal_done = terminal_done.clone();
        tokio::spawn(async move {
            let result = async {
                let mut decoder = input::Decoder::default();
                let mut buffer = [0; 8192];
                loop {
                    let count = stdout.read(&mut buffer).await?;
                    if count == 0 {
                        return Ok::<_, std::io::Error>(());
                    }
                    screen_sender.send_modify(|screen| decoder.push(screen, &buffer[..count]));
                }
            }
            .await;
            terminal_done.cancel();
            (result, stdout)
        })
    };
    let physical = {
        let observation = observation.clone();
        let stop = stop.clone();
        let settled = settled.clone();
        tokio::spawn(async move {
            let process =
                runtime::settle_original_child(&mut child, &observation, &stop, &settled).await;
            if process.is_ok()
                && let Err(error) = observation
                    .binding
                    .cleanup(OperationCleanup::Confirmed)
                    .await
            {
                tracing::error!(%error, "Claude PTY cleanup ACK remains pending");
            }
            (process, child)
        })
    };
    let diagnostic =
        tokio::spawn(async move { tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await });
    let mut start = Start::Interactive;
    let result = {
        let work = async {
            let prompt = input::text(runtime::string(request, "/message")?);
            let images = request["images"].as_array().expect("canonical images");
            let update = journal.instruction_update(request["instructions"].as_str());
            let prompt = if let Some(update) = update {
                let bootstrap = input::text(&runtime::bootstrap_message(&update.text));
                let sent = input::submit(
                    &mut stdin,
                    &mut screen,
                    cwd,
                    &bootstrap,
                    &[],
                    &bridge,
                    &mut start,
                )
                .await?;
                let outcome = observe(
                    &mut cursor,
                    &session,
                    &sent,
                    0,
                    &BootstrapOutput(output.as_ref()),
                    &mut stdin,
                    &mut screen,
                    &mut start,
                    None,
                )
                .await?;
                if !matches!(outcome, Outcome::Completed { .. }) {
                    return Ok(outcome);
                }
                journal.confirm_instructions(update).await?;
                input::send(&mut stdin, &mut screen, &prompt, images, &mut start).await?
            } else {
                input::submit(
                    &mut stdin,
                    &mut screen,
                    cwd,
                    &prompt,
                    images,
                    &bridge,
                    &mut start,
                )
                .await?
            };
            observe(
                &mut cursor,
                &session,
                &prompt,
                images.len(),
                output.as_ref(),
                &mut stdin,
                &mut screen,
                &mut start,
                Some((journal, steering)),
            )
            .await
        };
        tokio::select! {
            biased;
            () = observation.retired.cancelled() => Err(Error::ObservationRetired),
            () = stop.cancelled() => Err(Error::Cancelled),
            () = bridge.failed.cancelled() => Err(Error::Unknown),
            result = work => result,
            () = terminal_done.cancelled() => Err(Error::Unknown),
        }
    };
    let result = match result {
        Ok(outcome) => journal.closed(outcome.clone()).await.map(|()| outcome),
        Err(Error::Cancelled) if stop.is_cancelled() => {
            if start == Start::Submitted {
                let _ =
                    tokio::time::timeout(Duration::from_secs(1), input::write(&mut stdin, b"\x1b"))
                        .await;
            }
            let outcome = Outcome::Cancelled { reason: None };
            journal.closed(outcome.clone()).await.map(|()| outcome)
        }
        Err(error @ (Error::Provider(_) | Error::Invalid(_))) if start == Start::Interactive => {
            let outcome = Outcome::Failed {
                message: error.to_string(),
                code: Some("native_preparation_failed".into()),
                recoverable: false,
            };
            journal.closed(outcome.clone()).await.map(|()| outcome)
        }
        Err(error) => Err(error),
    };
    bridge.close_admission();
    settled.cancel();
    let (finished, finish) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        use maka_agent_ports::executor::RootSettlementOwner;
        let host = async {
            if let Err(error) = bridge.close().await {
                tracing::error!(%error, "Claude bridge settlement remains pending");
            }
            bridge.clone().original_root_cleanup_signal().await;
        };
        let (physical, terminal, diagnostic, ()) =
            tokio::join!(physical, terminal, diagnostic, host);
        let cleanup = match (&physical, &terminal, &diagnostic) {
            (Ok((Ok(()), _)), Ok((Ok(()), _)), Ok(Ok(_))) => Ok(()),
            _ => Err("Claude PTY cleanup could not be confirmed"),
        };
        match cleanup {
            Ok(()) => ticket.complete(Ok(())),
            Err(reason) => ticket.unconfirmed(
                reason.into(),
                (physical, terminal, diagnostic, stdin, bridge),
            ),
        }
        let _ = finished.send(cleanup);
    });
    if !matches!(
        tokio::time::timeout(Duration::from_secs(6), finish).await,
        Ok(Ok(Ok(())))
    ) {
        tracing::warn!("Claude PTY cleanup retained beyond the observer drain budget");
    }
    result
}

fn transcript(config: &NativeCommand, cwd: &Path, session: &str) -> Result<PathBuf, Error> {
    let root = configuration_directory(|key| {
        config
            .env
            .get(key)
            .cloned()
            .or_else(|| std::env::var(key).ok())
    })?;
    // Native Claude encodes each non-ASCII-alphanumeric UTF-16 code unit as '-'.
    let project: String = cwd
        .to_str()
        .ok_or_else(|| Error::Invalid("Claude cwd must be UTF-8".into()))?
        .encode_utf16()
        .map(|ch| {
            if ch <= 127 && (ch as u8).is_ascii_alphanumeric() {
                char::from(ch as u8)
            } else {
                '-'
            }
        })
        .collect();
    Ok(root
        .join("projects")
        .join(project)
        .join(format!("{session}.jsonl")))
}

fn configuration_directory(env: impl Fn(&str) -> Option<String>) -> Result<PathBuf, Error> {
    env("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            env("HOME")
                .or_else(|| env("USERPROFILE"))
                .map(|home| PathBuf::from(home).join(".claude"))
        })
        .ok_or_else(|| Error::Invalid("Claude configuration directory is unavailable".into()))
}

struct Cursor {
    path: PathBuf,
    opened: Option<OpenedTranscript>,
}
struct OpenedTranscript {
    file: tokio::fs::File,
    identity: std::fs::Metadata,
    offset: u64,
    pending: Vec<u8>,
    scanned: usize,
}
impl Cursor {
    async fn fence(path: PathBuf, resume: bool) -> Result<Self, Error> {
        let opened = match tokio::fs::File::open(&path).await {
            Ok(mut file) => {
                let offset = file
                    .seek(std::io::SeekFrom::End(0))
                    .await
                    .map_err(|e| Error::Provider(e.to_string()))?;
                let identity = file
                    .metadata()
                    .await
                    .map_err(|e| Error::Provider(e.to_string()))?;
                Some(OpenedTranscript {
                    file,
                    identity,
                    offset,
                    pending: Vec::new(),
                    scanned: 0,
                })
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && !resume => None,
            Err(error) => {
                return Err(Error::Invalid(format!(
                    "Claude original transcript unavailable: {error}"
                )));
            }
        };
        Ok(Self { path, opened })
    }
    async fn next(&mut self) -> Result<Option<Value>, Error> {
        let metadata = match tokio::fs::metadata(&self.path).await {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && self.opened.is_none() => {
                return Ok(None);
            }
            Err(_) => return Err(Error::Invalid("Claude live transcript disappeared".into())),
        };
        let opened = match &mut self.opened {
            Some(opened) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    if metadata.dev() != opened.identity.dev()
                        || metadata.ino() != opened.identity.ino()
                    {
                        return Err(Error::Invalid("Claude live transcript rotated".into()));
                    }
                }
                #[cfg(not(unix))]
                if metadata.created().ok() != opened.identity.created().ok() {
                    return Err(Error::Invalid("Claude live transcript rotated".into()));
                }
                if metadata.len() < opened.offset {
                    return Err(Error::Invalid("Claude live transcript truncated".into()));
                }
                opened
            }
            slot @ None => {
                let file = tokio::fs::File::open(&self.path)
                    .await
                    .map_err(|e| Error::Provider(e.to_string()))?;
                let identity = file
                    .metadata()
                    .await
                    .map_err(|e| Error::Provider(e.to_string()))?;
                slot.insert(OpenedTranscript {
                    file,
                    identity,
                    offset: 0,
                    pending: Vec::new(),
                    scanned: 0,
                })
            }
        };
        loop {
            if let Some(relative) = opened.pending[opened.scanned..]
                .iter()
                .position(|b| *b == b'\n')
            {
                let end = opened.scanned + relative;
                opened.scanned = 0;
                let line = opened.pending.drain(..=end).collect::<Vec<_>>();
                return runtime::parse_json(line, "complete Claude JSONL line")
                    .await
                    .map(Some);
            }
            opened.scanned = opened.pending.len();
            let mut bytes = [0u8; 8192];
            let count = opened
                .file
                .read(&mut bytes)
                .await
                .map_err(|e| Error::Provider(e.to_string()))?;
            if count == 0 {
                return Ok(None);
            }
            opened.offset += count as u64;
            opened.pending.extend_from_slice(&bytes[..count]);
            if opened.pending.len() > runtime::MAX_MESSAGE_BYTES {
                return Err(Error::Invalid(
                    "Claude live JSONL line exceeds 256 MiB".into(),
                ));
            }
        }
    }
}
struct BootstrapOutput<'a>(&'a dyn OutputSink);
impl OutputSink for BootstrapOutput<'_> {
    fn emit(&self, output: Output) -> BoxFuture<'_, Result<(), Error>> {
        match output {
            Output::MessageStart { .. }
            | Output::MessageEnd { .. }
            | Output::OutputDelta { .. }
            | Output::ThinkingDelta { .. }
            | Output::TurnUsage { .. } => Box::pin(async { Ok(()) }),
            output => self.0.emit(output),
        }
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "observations and additional input share the original PTY and invocation"
)]
async fn observe(
    cursor: &mut Cursor,
    session: &str,
    prompt: &str,
    images: usize,
    output: &dyn OutputSink,
    io: &mut (impl tokio::io::AsyncWrite + Unpin + Send),
    screen: &mut tokio::sync::watch::Receiver<input::Screen>,
    start: &mut Start,
    task: Option<(&journal::ProtocolSession, &mut steering::Steering)>,
) -> Result<Outcome, Error> {
    let (journal, mut steering) = match task {
        Some((journal, steering)) => (Some(journal), Some(steering)),
        None => (None, None),
    };
    let mut deadline = Some(input_deadline(prompt));
    let mut turn = LiveTurn {
        session,
        prompt,
        images,
        admitted: false,
        pending: Default::default(),
        assistant: false,
        open_message: None,
        final_message_id: None,
        closed_message_ids: Default::default(),
        row_ids: Default::default(),
        host_tool_calls: Default::default(),
        api_failure: None,
        usage: Default::default(),
        duration_ms: 0,
    };
    loop {
        // Keep this future across ready/take/paste. Dropping Cursor::next after it
        // drained a large row would also discard its in-flight blocking JSON parse.
        let next = async {
            loop {
                if let Some(row) = cursor.next().await? {
                    return Ok::<_, Error>(row);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        };
        tokio::pin!(next);
        let row = loop {
            tokio::select! {
                biased;
                row = &mut next => break row?,
                ready = async {
                    match steering.as_deref_mut() {
                        Some(steering) => steering.ready().await,
                        None => std::future::pending().await,
                    }
                }, if turn.admitted => {
                    ready?;
                }
                () = async {
                    match deadline {
                        Some(at) => tokio::time::sleep_until(at).await,
                        None => std::future::pending().await,
                    }
                } => {
                    return Err(Error::Invalid(
                        "Claude native JSONL did not confirm prompt admission within the input budget".into(),
                    ));
                }
            }
            // Commit only outside select: cancellation of ready cannot consume input.
            if let Some(steering) = steering.as_deref_mut()
                && let Some(request) = steering.take().await?
            {
                let images = request["images"]
                    .as_array()
                    .expect("canonical steering images");
                let prompt = input::text(runtime::string(&request, "/message")?);
                let prompt = input::send(io, screen, &prompt, images, start).await?;
                turn.pending.push_back(SubmittedInput {
                    prompt,
                    images: images.len(),
                });
            }
        };
        let terminal = row["type"] == "system"
            && row["subtype"] == "turn_duration"
            && row.get("isSidechain").and_then(Value::as_bool) != Some(true);
        // A ready batch at the final native boundary still belongs to this PTY.
        // Take it before row() can settle; an empty take does not create a new turn.
        if terminal
            && turn.admitted
            && row.get("sessionId").and_then(Value::as_str) == Some(session)
            && turn.pending.is_empty()
            && let Some(steering) = steering.as_deref_mut()
            && let Some(request) = steering.take().await?
        {
            let images = request["images"]
                .as_array()
                .expect("canonical steering images");
            let prompt = input::text(runtime::string(&request, "/message")?);
            let prompt = input::send(io, screen, &prompt, images, start).await?;
            turn.pending.push_back(SubmittedInput {
                prompt,
                images: images.len(),
            });
        }
        let pending = turn.pending.len();
        let admitted = turn.admitted;
        if let Some(outcome) = turn.row(row, output).await? {
            return Ok(outcome);
        }
        if !admitted
            && turn.admitted
            && let Some(journal) = journal
        {
            journal
                .bind_task(NativeTask::ClaudePty {
                    session: session.into(),
                })
                .await?;
        }
        if (!admitted && turn.admitted) || turn.pending.len() < pending {
            // A native busy queue can wait on arbitrarily long running tools.
            deadline = None;
        }
        if terminal
            && turn.admitted
            && deadline.is_none()
            && let Some(input) = turn.pending.front()
        {
            // Once a native turn ends, the queued input must be admitted, not lost.
            deadline = Some(input_deadline(&input.prompt));
        }
    }
}
fn input_deadline(prompt: &str) -> tokio::time::Instant {
    tokio::time::Instant::now()
        + runtime::SETUP_TIMEOUT
        + Duration::from_secs(prompt.len() as u64 / (32 * 1024))
}
struct SubmittedInput {
    prompt: String,
    images: usize,
}
fn matches_input(content: &Value, prompt: &str, images: usize) -> bool {
    content_text(content) == prompt
        && content.as_array().map_or(images == 0, |blocks| {
            !blocks.iter().any(|b| b["type"] == "tool_result")
                && blocks.iter().filter(|b| b["type"] == "image").count() == images
        })
}
struct LiveTurn<'a> {
    session: &'a str,
    prompt: &'a str,
    images: usize,
    admitted: bool,
    pending: std::collections::VecDeque<SubmittedInput>,
    assistant: bool,
    open_message: Option<AssistantMessage>,
    final_message_id: Option<String>,
    closed_message_ids: std::collections::BTreeSet<String>,
    row_ids: std::collections::BTreeSet<String>,
    host_tool_calls: std::collections::BTreeSet<String>,
    api_failure: Option<String>,
    usage: BTreeMap<String, maka_agent_facts::model::ModelUsage>,
    duration_ms: u64,
}
struct AssistantMessage {
    id: String,
    has_body: bool,
    has_thinking: bool,
}
impl LiveTurn<'_> {
    async fn end_message(&mut self, output: &dyn OutputSink) -> Result<(), Error> {
        if let Some(message) = self.open_message.take() {
            output
                .emit(Output::MessageEnd {
                    message_id: message.id.clone(),
                })
                .await?;
            self.closed_message_ids.insert(message.id.clone());
            if message.has_body {
                self.final_message_id = Some(message.id);
            }
        }
        Ok(())
    }
    async fn row(&mut self, row: Value, output: &dyn OutputSink) -> Result<Option<Outcome>, Error> {
        if row
            .get("sessionId")
            .and_then(Value::as_str)
            .is_some_and(|id| id != self.session)
        {
            return Err(Error::Invalid(
                "Claude live transcript session mismatch".into(),
            ));
        }
        let kind = row.get("type").and_then(Value::as_str).unwrap_or_default();
        if row.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            return Ok(None);
        }
        if !self.admitted {
            if kind == "user"
                && row
                    .pointer("/message/content")
                    .is_some_and(|v| matches_input(v, self.prompt, self.images))
            {
                if row.get("sessionId").and_then(Value::as_str) != Some(self.session) {
                    return Err(Error::Invalid(
                        "Claude prompt missing native session identity".into(),
                    ));
                }
                self.admitted = true;
            }
            return Ok(None);
        }
        if kind == "user"
            && let Some(input) = self.pending.front()
            && row
                .pointer("/message/content")
                .is_some_and(|v| matches_input(v, &input.prompt, input.images))
        {
            if row.get("sessionId").and_then(Value::as_str) != Some(self.session) {
                return Err(Error::Invalid(
                    "Claude steering missing native session identity".into(),
                ));
            }
            self.end_message(output).await?;
            self.pending.pop_front();
            // A previous assistant cannot prove that this additional input was answered.
            self.assistant = false;
            return Ok(None);
        }
        if kind == "assistant" {
            if row.get("isApiErrorMessage").and_then(Value::as_bool) == Some(true) {
                self.api_failure.get_or_insert_with(|| {
                    format!(
                        "Claude API request failed: {}",
                        content_text(&row["message"]["content"])
                    )
                });
                self.assistant = true;
                return Ok(None);
            }
            let content = &row["message"]["content"];
            let row_id = runtime::string(&row, "/uuid")?;
            if !self.row_ids.insert(row_id.into()) {
                return Ok(None);
            }
            self.assistant = true;
            let id = runtime::string(&row, "/message/id")?;
            if let Some(usage) = row.pointer("/message/usage") {
                let tokens = maka_agent_facts::model::ModelUsage {
                    input_tokens: usage["input_tokens"].as_u64(),
                    output_tokens: usage["output_tokens"].as_u64(),
                    cache_read_tokens: usage["cache_read_input_tokens"].as_u64(),
                    cache_write_tokens: usage["cache_creation_input_tokens"].as_u64(),
                    ..Default::default()
                };
                if tokens != Default::default() {
                    self.usage.insert(id.into(), tokens);
                }
            }
            if self
                .open_message
                .as_ref()
                .map(|message| message.id.as_str())
                != Some(id)
            {
                self.end_message(output).await?;
                if self.closed_message_ids.contains(id) {
                    return Ok(None);
                }
                output
                    .emit(Output::MessageStart {
                        message_id: id.into(),
                    })
                    .await?;
                self.open_message = Some(AssistantMessage {
                    id: id.into(),
                    has_body: false,
                    has_thinking: false,
                });
            }
            if let Some(blocks) = content.as_array() {
                for block in blocks {
                    match block.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            let text = runtime::string(block, "/text")?;
                            if !text.is_empty() {
                                let message =
                                    self.open_message.as_mut().expect("started API message");
                                let emitted = if message.has_body {
                                    format!("\n\n{text}")
                                } else {
                                    text.into()
                                };
                                message.has_body = true;
                                output
                                    .emit(Output::OutputDelta {
                                        message_id: id.into(),
                                        text: emitted,
                                    })
                                    .await?;
                            }
                        }
                        Some("tool_use") => {
                            let name = runtime::string(block, "/name")?;
                            if matches!(name, "AskUserQuestion" | "EnterPlanMode" | "ExitPlanMode")
                            {
                                return Err(Error::Invalid("Claude requested unsupported interactive question or plan UI; use Host tools".into()));
                            }
                            if name.starts_with("mcp__maka__") {
                                self.host_tool_calls
                                    .insert(runtime::string(block, "/id")?.into());
                            } else {
                                output
                                    .emit(Output::ToolStart {
                                        tool_call_id: runtime::string(block, "/id")?.into(),
                                        name: name.into(),
                                        input: block.get("input").cloned().unwrap_or(Value::Null),
                                    })
                                    .await?;
                            }
                        }
                        Some("thinking") => {
                            if let Some(text) = block.get("thinking").and_then(Value::as_str)
                                && !text.is_empty()
                            {
                                let message =
                                    self.open_message.as_mut().expect("started API message");
                                let emitted = if message.has_thinking {
                                    format!("\n\n{text}")
                                } else {
                                    text.into()
                                };
                                message.has_thinking = true;
                                output
                                    .emit(Output::ThinkingDelta {
                                        message_id: id.into(),
                                        text: emitted,
                                    })
                                    .await?;
                            }
                        }
                        _ => {}
                    }
                }
            } else if let Some(text) = content.as_str()
                && !text.is_empty()
            {
                let message = self.open_message.as_mut().expect("started API message");
                let emitted = if message.has_body {
                    format!("\n\n{text}")
                } else {
                    text.into()
                };
                message.has_body = true;
                output
                    .emit(Output::OutputDelta {
                        message_id: id.into(),
                        text: emitted,
                    })
                    .await?;
            }
        } else if kind == "user" {
            if let Some(blocks) = row.pointer("/message/content").and_then(Value::as_array) {
                for block in blocks {
                    if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                        if self
                            .host_tool_calls
                            .contains(runtime::string(block, "/tool_use_id")?)
                        {
                            continue;
                        }
                        output
                            .emit(Output::ToolResult {
                                tool_call_id: runtime::string(block, "/tool_use_id")?.into(),
                                text: content_text(&block["content"]),
                                is_error: block.get("is_error").and_then(Value::as_bool)
                                    == Some(true),
                                details: None,
                            })
                            .await?;
                    }
                }
            }
        } else if kind == "system"
            && row.get("subtype").and_then(Value::as_str) == Some("turn_duration")
        {
            if row.get("sessionId").and_then(Value::as_str) != Some(self.session) {
                return Err(Error::Invalid(
                    "Claude terminal lacks native session identity".into(),
                ));
            }
            if self.api_failure.is_none() {
                self.end_message(output).await?;
            }
            if let Some(duration) = row["durationMs"].as_u64() {
                self.duration_ms = self.duration_ms.saturating_add(duration);
            }
            // The old native turn can finish after the next input was journaled.
            // Neither an unconsumed input nor one without its own assistant may settle.
            if !self.pending.is_empty() || !self.assistant {
                return Ok(None);
            }
            if !self.usage.is_empty() || self.duration_ms != 0 {
                use maka_agent_facts::{executor::TurnUsage, model::ModelUsage};
                let sum = |get: fn(&ModelUsage) -> Option<u64>| {
                    let mut samples = self.usage.values();
                    let first = get(samples.next()?)?;
                    samples.try_fold(first, |total, next| total.checked_add(get(next)?))
                };
                output
                    .emit(Output::TurnUsage {
                        usage: TurnUsage {
                            tokens: ModelUsage {
                                input_tokens: sum(|usage| usage.input_tokens),
                                output_tokens: sum(|usage| usage.output_tokens),
                                cache_read_tokens: sum(|usage| usage.cache_read_tokens),
                                cache_write_tokens: sum(|usage| usage.cache_write_tokens),
                                ..Default::default()
                            },
                            total_tokens: None,
                            duration_ms: (self.duration_ms != 0).then_some(self.duration_ms),
                        },
                    })
                    .await?;
            }
            return Ok(Some(match self.api_failure.take() {
                Some(message) => Outcome::Failed {
                    message,
                    code: Some("native_api_failed".into()),
                    recoverable: false,
                },
                None => Outcome::Completed {
                    message_id: self.final_message_id.clone(),
                },
            }));
        }
        Ok(None)
    }
}
