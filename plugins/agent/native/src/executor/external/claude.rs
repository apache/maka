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

//! The interactive PTY owns execution; append-only JSONL supplies correlated observations.
use super::*;
mod input;

#[derive(Clone, Copy)]
enum Start {
    Unspawned,
    Interactive,
    Submitted,
}
use maka_agent_facts::executor::Output;
use std::{path::Path, time::Duration};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

#[expect(
    clippy::too_many_arguments,
    reason = "interactive execution retains all invocation resources until settlement"
)]
pub(super) async fn execute(
    config: &NativeCommand,
    cwd: &str,
    request: &Value,
    storage: &Storage,
    journal: &mut journal::Journal,
    output: Arc<dyn OutputSink>,
    bridge: Arc<mcp::Bridge>,
    cancellation: CancellationToken,
    steering: &mut steering::Steering,
) -> Result<Outcome, Error> {
    let provisional = journal.native_session().is_none();
    let mut start = Start::Unspawned;
    let result = prepare(
        config,
        cwd,
        request,
        storage,
        journal,
        output,
        bridge.clone(),
        cancellation,
        steering,
        &mut start,
    )
    .await;
    // Preparation can fail before a PTY exists; credentials are still revoked.
    let closed = bridge.close().await;
    if matches!(result, Err(Error::CleanupUnconfirmed)) {
        return result;
    }
    closed?;
    settle_preparation(storage, journal, provisional, start, result).await
}
async fn settle_preparation(
    storage: &Storage,
    journal: &mut journal::Journal,
    provisional: bool,
    start: Start,
    result: Result<Outcome, Error>,
) -> Result<Outcome, Error> {
    if !matches!(start, Start::Submitted)
        && let Err(error) = &result
    {
        match error {
            Error::Unknown | Error::CleanupUnconfirmed | Error::Persistence(_) => return result,
            _ => {}
        }
        if provisional {
            journal.revoke_unsubmitted(storage).await?;
        }
        if !matches!(error, Error::Cancelled) {
            return Ok(Outcome::Failed {
                message: error.to_string(),
                code: Some("native_preparation_failed".into()),
                recoverable: false,
            });
        }
    }
    result
}
#[expect(
    clippy::too_many_arguments,
    reason = "one PTY invocation owns its native identity and transcript cursor"
)]
async fn prepare(
    config: &NativeCommand,
    cwd: &str,
    request: &Value,
    storage: &Storage,
    journal: &mut journal::Journal,
    output: Arc<dyn OutputSink>,
    bridge: Arc<mcp::Bridge>,
    cancellation: CancellationToken,
    steering: &mut steering::Steering,
    start: &mut Start,
) -> Result<Outcome, Error> {
    let images = request
        .get("images")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let resume = journal.native_session().map(str::to_owned);
    let session = resume.clone().unwrap_or_else(|| Uuid::new_v4().to_string());
    Uuid::parse_str(&session)
        .map_err(|_| Error::Invalid("Claude native session ID must be a UUID".into()))?;
    let cwd = tokio::fs::canonicalize(cwd)
        .await
        .map_err(|e| Error::Provider(e.to_string()))?;
    let cwd = dunce::simplified(&cwd).to_owned();
    let transcript = transcript(config, &cwd, &session)?;
    let mut cursor = Cursor::fence(transcript, resume.is_some()).await?;
    // Commit the caller-selected UUID before native startup and any interactive submission.
    journal.opened(storage, session.clone()).await?;
    if cancellation.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let directory = bridge.directory();
    let mcp_config = directory.join("mcp.json");
    let pending_config = directory.join("mcp.next");
    tokio::fs::write(
        &pending_config,
        serde_json::to_vec(&bridge.claude()).expect("MCP config is JSON"),
    )
    .await
    .map_err(|e| Error::Provider(e.to_string()))?;
    tokio::fs::rename(&pending_config, &mcp_config)
        .await
        .map_err(|e| Error::Provider(e.to_string()))?;
    let mut plan = runtime::command(
        config,
        cwd.to_str()
            .ok_or_else(|| Error::Invalid("Claude cwd must be UTF-8".into()))?,
    )
    .await?;
    plan.arg("--dangerously-skip-permissions")
        .arg("--ax-screen-reader")
        .arg(if resume.is_some() {
            "--resume"
        } else {
            "--session-id"
        })
        .arg(&session)
        .arg("--mcp-config")
        .arg(&mcp_config);
    if let Some(model) = request
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| *model != "default")
    {
        plan.arg("--model").arg(model);
    }
    if let Some(effort) = request.get("effort").and_then(Value::as_str) {
        plan.arg("--effort").arg(effort);
    }
    let prompt = input::text(runtime::string(request, "/message")?);
    let (mut child, io) = maka_process::pty::spawn(
        plan,
        maka_agent_facts::terminal::TerminalSize::new(120, 40).expect("fixed native terminal size"),
    )
    .await
    .map_err(runtime::process_error)?;
    *start = Start::Interactive;
    let exited = CancellationToken::new();
    let settle = CancellationToken::new();
    let lifecycle = async {
        let result = async {
        let status = tokio::select! { status = child.wait() => status, () = settle.cancelled() => {
            child.terminate().map_err(|_| Error::CleanupUnconfirmed)?;
            tokio::time::timeout(Duration::from_secs(4), child.wait()).await.map_err(|_| Error::CleanupUnconfirmed)?
        }};
        status.map_err(|_| Error::CleanupUnconfirmed)?;
        child.close().await.map_err(|_| Error::CleanupUnconfirmed)
        }.await;
        bridge.close_admission();
        exited.cancel();
        result
    };
    let terminal_done = CancellationToken::new();
    let (screen_send, mut screen) = tokio::sync::watch::channel(input::Screen::default());
    let terminal = async {
        let result = async {
            let mut buffer = [0u8;8192];
            let mut decoder=input::Decoder::default();
            loop {
                let read=tokio::select! {
                    biased;
                    ()=exited.cancelled() => {
                        return tokio::time::timeout(Duration::from_secs(1),async {
                            loop {if io.read(&mut buffer).await.map_err(|_|Error::CleanupUnconfirmed)?==0 {return Ok::<(),Error>(());}}
                        }).await.map_err(|_|Error::CleanupUnconfirmed)?;
                    }
                    read=io.read(&mut buffer)=>read.map_err(|_|Error::CleanupUnconfirmed)?,
                };
                if read==0 {return Ok(());}
                screen_send.send_modify(|s|decoder.push(s,&buffer[..read]));
            }
        }.await;
        terminal_done.cancel();
        result
    };
    let business = async {
        let work = async {
            let native_prompt = if let Some(update) =
                journal.instruction_update(request.get("instructions").and_then(Value::as_str))
            {
                let instructions = input::text(&runtime::bootstrap_message(Some(&update.text)));
                let native_instructions = input::submit(
                    &io,
                    &mut screen,
                    cwd.to_str().expect("validated UTF-8 cwd"),
                    &instructions,
                    &[],
                    &bridge,
                    start,
                )
                .await?;
                let bootstrap_output = BootstrapOutput(output.as_ref());
                let outcome = observe(
                    &mut cursor,
                    &session,
                    &native_instructions,
                    0,
                    &bootstrap_output,
                    &io,
                    &mut screen,
                    start,
                    None,
                )
                .await?;
                if !matches!(outcome, Outcome::Completed { .. }) {
                    return Ok(outcome);
                }
                journal.confirm_instructions(storage, update).await?;
                input::send(&io, &mut screen, &prompt, images, start).await?
            } else {
                input::submit(
                    &io,
                    &mut screen,
                    cwd.to_str().expect("validated UTF-8 cwd"),
                    &prompt,
                    images,
                    &bridge,
                    start,
                )
                .await?
            };
            observe(
                &mut cursor,
                &session,
                &native_prompt,
                images.len(),
                output.as_ref(),
                &io,
                &mut screen,
                start,
                Some(steering),
            )
            .await
        };
        tokio::pin!(work);
        let result = tokio::select! { biased;
            () = cancellation.cancelled() => Err(Error::Cancelled),
            () = bridge.failed.cancelled() => Err(Error::Unknown),
            result = &mut work => result,
            () = exited.cancelled() => Err(Error::Unknown),
            () = terminal_done.cancelled() => Err(Error::Unknown),
        };
        bridge.close_admission();
        // Esc requests the CLI's native interruption before we settle its whole process group.
        if result.is_err() {
            let _ = tokio::time::timeout(Duration::from_secs(1), io.write(b"\x1b")).await;
        }
        let host = bridge.close().await;
        settle.cancel();
        host?;
        result
    };
    let (physical, result, drain) = tokio::join!(lifecycle, business, terminal);
    if physical.is_err() || drain.is_err() {
        return Err(Error::CleanupUnconfirmed);
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
    file: Option<tokio::fs::File>,
    identity: Option<std::fs::Metadata>,
    offset: u64,
    pending: Vec<u8>,
    scanned: usize,
}
impl Cursor {
    async fn fence(path: PathBuf, resume: bool) -> Result<Self, Error> {
        let file = match tokio::fs::File::open(&path).await {
            Ok(mut file) => {
                file.seek(std::io::SeekFrom::End(0))
                    .await
                    .map_err(|e| Error::Provider(e.to_string()))?;
                Some(file)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && !resume => None,
            Err(error) => {
                return Err(Error::Invalid(format!(
                    "Claude original transcript unavailable: {error}"
                )));
            }
        };
        let identity = match &file {
            Some(file) => Some(
                file.metadata()
                    .await
                    .map_err(|e| Error::Provider(e.to_string()))?,
            ),
            None => None,
        };
        let offset = identity.as_ref().map_or(0, |m| m.len());
        Ok(Self {
            path,
            file,
            identity,
            offset,
            pending: Vec::new(),
            scanned: 0,
        })
    }
    async fn next(&mut self) -> Result<Option<Value>, Error> {
        let metadata = match tokio::fs::metadata(&self.path).await {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && self.file.is_none() => {
                return Ok(None);
            }
            Err(_) => return Err(Error::Invalid("Claude live transcript disappeared".into())),
        };
        if let Some(identity) = &self.identity {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if metadata.dev() != identity.dev() || metadata.ino() != identity.ino() {
                    return Err(Error::Invalid("Claude live transcript rotated".into()));
                }
            }
            #[cfg(not(unix))]
            if metadata.created().ok() != identity.created().ok() {
                return Err(Error::Invalid("Claude live transcript rotated".into()));
            }
        }
        if metadata.len() < self.offset {
            return Err(Error::Invalid("Claude live transcript truncated".into()));
        }
        if self.file.is_none() {
            let file = tokio::fs::File::open(&self.path)
                .await
                .map_err(|e| Error::Provider(e.to_string()))?;
            self.identity = Some(
                file.metadata()
                    .await
                    .map_err(|e| Error::Provider(e.to_string()))?,
            );
            self.file = Some(file);
        }
        loop {
            if let Some(relative) = self.pending[self.scanned..]
                .iter()
                .position(|b| *b == b'\n')
            {
                let end = self.scanned + relative;
                self.scanned = 0;
                let line = self.pending.drain(..=end).collect::<Vec<_>>();
                return runtime::parse_json(line, "complete Claude JSONL line")
                    .await
                    .map(Some);
            }
            self.scanned = self.pending.len();
            let mut bytes = [0u8; 8192];
            let count = self
                .file
                .as_mut()
                .expect("live transcript opened")
                .read(&mut bytes)
                .await
                .map_err(|e| Error::Provider(e.to_string()))?;
            if count == 0 {
                return Ok(None);
            }
            self.offset += count as u64;
            self.pending.extend_from_slice(&bytes[..count]);
            if self.pending.len() > runtime::MAX_MESSAGE_BYTES {
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
            Output::OutputDelta { .. } | Output::ThinkingDelta { .. } => Box::pin(async { Ok(()) }),
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
    io: &maka_process::pty::PtyIo,
    screen: &mut tokio::sync::watch::Receiver<input::Screen>,
    start: &mut Start,
    mut steering: Option<&mut steering::Steering>,
) -> Result<Outcome, Error> {
    let mut deadline = Some(input_deadline(prompt));
    let mut turn = LiveTurn {
        session,
        prompt,
        images,
        admitted: false,
        pending: Default::default(),
        assistant: false,
        text: String::new(),
        message_ids: std::collections::BTreeSet::new(),
        host_tool_calls: Default::default(),
        api_failure: None,
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
    text: String,
    message_ids: std::collections::BTreeSet<String>,
    host_tool_calls: std::collections::BTreeSet<String>,
    api_failure: Option<String>,
}
impl LiveTurn<'_> {
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
            self.assistant = true;
            let content = &row["message"]["content"];
            if let Some(blocks) = content.as_array() {
                for block in blocks {
                    match block.get("type").and_then(Value::as_str) {
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
                            if let Some(text) = block.get("thinking").and_then(Value::as_str) {
                                output
                                    .emit(Output::ThinkingDelta { text: text.into() })
                                    .await?;
                            }
                        }
                        _ => {}
                    }
                }
            }
            let text = content_text(content);
            if !text.is_empty() {
                // Claude can write multiple assistant records for one API message. UUID is the row identity.
                let id = runtime::string(&row, "/uuid")?;
                if self.message_ids.insert(id.into()) {
                    self.text.push_str(&text);
                    output.emit(Output::OutputDelta { text }).await?;
                }
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
            // The old native turn can finish after the next input was journaled.
            // Neither an unconsumed input nor one without its own assistant may settle.
            if !self.pending.is_empty() || !self.assistant {
                return Ok(None);
            }
            return Ok(Some(match self.api_failure.take() {
                Some(message) => Outcome::Failed {
                    message,
                    code: Some("native_api_failed".into()),
                    recoverable: false,
                },
                None => Outcome::Completed {
                    text: std::mem::take(&mut self.text),
                },
            }));
        }
        Ok(None)
    }
}
fn content_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.into();
    }
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configuration_directory_uses_userprofile_after_home_and_keeps_explicit_override() {
        for (entries, expected) in [
            (vec![("USERPROFILE", "/profile")], "/profile/.claude"),
            (
                vec![("HOME", "/home"), ("USERPROFILE", "/profile")],
                "/home/.claude",
            ),
            (
                vec![
                    ("CLAUDE_CONFIG_DIR", "/config"),
                    ("HOME", "/home"),
                    ("USERPROFILE", "/profile"),
                ],
                "/config",
            ),
        ] {
            let actual = configuration_directory(|key| {
                entries
                    .iter()
                    .find(|(name, _)| *name == key)
                    .map(|(_, value)| (*value).to_owned())
            })
            .unwrap();
            assert_eq!(actual, PathBuf::from(expected));
        }
        assert!(matches!(
            configuration_directory(|_| None),
            Err(Error::Invalid(_))
        ));
    }
    struct Sink;
    impl OutputSink for Sink {
        fn emit(&self, _: Output) -> BoxFuture<'_, Result<(), Error>> {
            Box::pin(async { Ok(()) })
        }
    }
    fn turn() -> LiveTurn<'static> {
        LiveTurn {
            session: "session",
            prompt: "current prompt",
            images: 0,
            admitted: false,
            pending: Default::default(),
            assistant: false,
            text: String::new(),
            message_ids: Default::default(),
            host_tool_calls: Default::default(),
            api_failure: None,
        }
    }
    #[tokio::test]
    async fn cancellation_before_submission_revokes_only_a_new_uuid() {
        let directory = tempfile::tempdir().unwrap();
        let root = maka_event_log::root::RootOwner::create(
            &directory.path().join("root"),
            &maka_event_log::root::RootNamespaces {
                ownership: directory.path().join("owners"),
                control: directory.path().join("control"),
            },
        )
        .unwrap();
        let storage = Storage::new(
            Arc::new(RootStore::open(Arc::new(root)).await.unwrap()),
            String::new(),
            maka_capabilities::storage::Namespace::new(
                "maka.agent.oar",
                maka_plugin_core::scope::Scope::Profile,
            )
            .unwrap(),
        );
        let request = Request {
            language: maka_agent_facts::language::Language::En,
            invocation: maka_agent_facts::event::Invocation {
                session_id: "session".into(),
                turn_id: "turn".into(),
                run_id: "run".into(),
                invocation_id: "invocation".into(),
            },
            conversation_key: "session".into(),
            cwd: directory.path().to_str().unwrap().into(),
            content: serde_json::from_value(serde_json::json!({"text":"prompt"})).unwrap(),
            instructions: None,
            settings: maka_agent_facts::executor::Settings {
                runtime: Some("claude".into()),
                ..Default::default()
            },
        };
        let mut journal = journal::Journal::load(&storage, &request).await.unwrap();
        journal.start(&storage, "first").await.unwrap();
        let cancellation = CancellationToken::new();
        let allocated = Uuid::new_v4().to_string();
        let (committed, ()) = tokio::join!(journal.opened(&storage, allocated.clone()), async {
            cancellation.cancel();
        });
        committed.unwrap();
        assert!(cancellation.is_cancelled());
        assert_eq!(journal.native_session(), Some(allocated.as_str()));
        assert!(matches!(
            settle_preparation(
                &storage,
                &mut journal,
                true,
                Start::Unspawned,
                Err(Error::Cancelled)
            )
            .await,
            Err(Error::Cancelled)
        ));
        journal.ready(&storage).await.unwrap();
        let mut journal = journal::Journal::load(&storage, &request).await.unwrap();
        assert!(
            journal.native_session().is_none(),
            "the next turn must allocate, rather than resume a UUID with no transcript"
        );
        let established = Uuid::new_v4().to_string();
        journal.start(&storage, "followup").await.unwrap();
        journal.opened(&storage, established.clone()).await.unwrap();
        assert!(matches!(
            settle_preparation(
                &storage,
                &mut journal,
                false,
                Start::Unspawned,
                Err(Error::Cancelled)
            )
            .await,
            Err(Error::Cancelled)
        ));
        journal.ready(&storage).await.unwrap();
        let mut journal = journal::Journal::load(&storage, &request).await.unwrap();
        assert_eq!(
            journal.native_session(),
            Some(established.as_str()),
            "pre-spawn cancellation must preserve an established resume identity"
        );
        journal.start(&storage, "post-spawn").await.unwrap();
        assert!(matches!(
            settle_preparation(
                &storage,
                &mut journal,
                false,
                Start::Submitted,
                Err(Error::Provider("post-prompt uncertainty".into()))
            )
            .await,
            Err(Error::Provider(_))
        ));
        assert!(matches!(
            journal::Journal::load(&storage, &request).await,
            Err(Error::Unknown)
        ));
        for (index, error) in [
            Error::Unknown,
            Error::CleanupUnconfirmed,
            Error::Persistence("unconfirmed commit".into()),
        ]
        .into_iter()
        .enumerate()
        {
            let mut request = request.clone();
            request.conversation_key = format!("uncertain-{index}");
            let mut journal = journal::Journal::load(&storage, &request).await.unwrap();
            journal.start(&storage, "uncertain").await.unwrap();
            journal.opened(&storage, allocated.clone()).await.unwrap();
            assert!(
                settle_preparation(&storage, &mut journal, true, Start::Unspawned, Err(error))
                    .await
                    .is_err()
            );
            assert_eq!(journal.native_session(), Some(allocated.as_str()));
            assert!(matches!(
                journal::Journal::load(&storage, &request).await,
                Err(Error::Unknown)
            ));
        }
        storage.finish().await.unwrap();
    }
    #[tokio::test]
    async fn blocked_stop_attempts_wait_for_final_turn_duration_after_current_prompt() {
        let mut turn = turn();
        let sink = Sink;
        for row in [
            serde_json::json!({"type":"system","subtype":"turn_duration","sessionId":"session"}),
            serde_json::json!({"type":"user","sessionId":"session","message":{"content":"current prompt"}}),
            serde_json::json!({"type":"assistant","uuid":"a1","sessionId":"session","message":{"content":[{"type":"text","text":"first"}]}}),
            serde_json::json!({"type":"system","subtype":"stop_hook_summary","sessionId":"session","preventedContinuation":false,"hasOutput":true,"hookErrors":["continue once"]}),
            serde_json::json!({"type":"assistant","uuid":"a2","sessionId":"session","message":{"content":[{"type":"text","text":"then final"}]}}),
            serde_json::json!({"type":"system","subtype":"stop_hook_summary","sessionId":"session"}),
        ] {
            assert!(turn.row(row, &sink).await.unwrap().is_none());
        }
        assert!(
            matches!(turn.row(serde_json::json!({"type":"system","subtype":"turn_duration","sessionId":"session"}),&sink).await.unwrap(),Some(Outcome::Completed{text}) if text=="firstthen final")
        );
        assert!(turn.row(serde_json::json!({"type":"system","subtype":"turn_duration","sessionId":"different"}),&sink).await.is_err());
    }
    #[tokio::test]
    async fn native_image_placeholders_alone_do_not_admit_missing_image_blocks() {
        let mut turn = turn();
        turn.prompt = "[Image #1] [Image #2]current prompt";
        turn.images = 2;
        let sink = Sink;
        for count in [0, 1, 2] {
            let mut blocks = vec![serde_json::json!({"type":"text","text":turn.prompt})];
            blocks.extend((0..count).map(
                |_| serde_json::json!({"type":"image","source":{"type":"base64","data":"fixture"}}),
            ));
            turn.row(serde_json::json!({"type":"user","sessionId":"session","message":{"content":blocks}}),&sink).await.unwrap();
            assert_eq!(turn.admitted, count == 2);
        }
    }
    #[tokio::test]
    async fn queued_steering_survives_intermediate_native_turn_completion() {
        let mut turn = turn();
        let sink = Sink;
        turn.row(serde_json::json!({"type":"user","sessionId":"session","message":{"content":"current prompt"}}), &sink).await.unwrap();
        turn.pending.push_back(SubmittedInput {
            prompt: "next".into(),
            images: 0,
        });
        turn.pending.push_back(SubmittedInput {
            prompt: "[Image #7]last".into(),
            images: 1,
        });
        for row in [
            serde_json::json!({"type":"assistant","uuid":"old","sessionId":"session","message":{"content":"first"}}),
            serde_json::json!({"type":"system","subtype":"turn_duration","sessionId":"session"}),
            serde_json::json!({"type":"user","sessionId":"session","message":{"content":"next"}}),
            serde_json::json!({"type":"assistant","uuid":"next","sessionId":"session","message":{"content":"second"}}),
            serde_json::json!({"type":"system","subtype":"turn_duration","sessionId":"session"}),
            serde_json::json!({"type":"user","sessionId":"session","message":{"content":[{"type":"text","text":"[Image #7]last"},{"type":"image"}]}}),
            serde_json::json!({"type":"assistant","uuid":"last","sessionId":"session","message":{"content":"third"}}),
            serde_json::json!({"type":"system","subtype":"stop_hook_summary","sessionId":"session"}),
        ] {
            assert!(turn.row(row, &sink).await.unwrap().is_none());
        }
        assert!(
            matches!(turn.row(serde_json::json!({"type":"system","subtype":"turn_duration","sessionId":"session"}), &sink).await.unwrap(), Some(Outcome::Completed { text }) if text == "firstsecondthird")
        );
    }
    #[tokio::test]
    async fn steering_needs_exact_input_not_tool_results_and_a_new_assistant() {
        let mut turn = turn();
        let sink = Sink;
        turn.row(serde_json::json!({"type":"user","sessionId":"session","message":{"content":"current prompt"}}), &sink).await.unwrap();
        turn.pending.push_back(SubmittedInput {
            prompt: "next".into(),
            images: 0,
        });
        for row in [
            serde_json::json!({"type":"assistant","uuid":"old","sessionId":"session","message":{"content":"old"}}),
            serde_json::json!({"type":"user","sessionId":"session","message":{"content":[{"type":"text","text":"next"},{"type":"tool_result","tool_use_id":"native","content":"result"}]}}),
            serde_json::json!({"type":"user","sessionId":"session","isSidechain":true,"message":{"content":"next"}}),
            serde_json::json!({"type":"user","sessionId":"session","message":{"content":"different"}}),
        ] {
            assert!(turn.row(row, &sink).await.unwrap().is_none());
        }
        assert_eq!(turn.pending.len(), 1);
        turn.row(
            serde_json::json!({"type":"user","sessionId":"session","message":{"content":"next"}}),
            &sink,
        )
        .await
        .unwrap();
        assert!(turn.pending.is_empty());
        assert!(turn.row(serde_json::json!({"type":"system","subtype":"turn_duration","sessionId":"session"}), &sink).await.unwrap().is_none());
        turn.row(serde_json::json!({"type":"assistant","uuid":"new","sessionId":"session","message":{"content":"new"}}), &sink).await.unwrap();
        assert!(
            matches!(turn.row(serde_json::json!({"type":"system","subtype":"turn_duration","sessionId":"session"}), &sink).await.unwrap(), Some(Outcome::Completed { text }) if text == "oldnew")
        );
    }
    #[tokio::test]
    async fn steering_cannot_hide_an_api_failure_before_an_intermediate_duration() {
        let mut turn = turn();
        let sink = Sink;
        turn.row(serde_json::json!({"type":"user","sessionId":"session","message":{"content":"current prompt"}}), &sink).await.unwrap();
        turn.pending.push_back(SubmittedInput {
            prompt: "next".into(),
            images: 0,
        });
        for row in [
            serde_json::json!({"type":"assistant","uuid":"error","sessionId":"session","isApiErrorMessage":true,"message":{"content":"failed"}}),
            serde_json::json!({"type":"system","subtype":"turn_duration","sessionId":"session"}),
            serde_json::json!({"type":"user","sessionId":"session","message":{"content":"next"}}),
            serde_json::json!({"type":"assistant","uuid":"answer","sessionId":"session","message":{"content":"later"}}),
        ] {
            assert!(turn.row(row, &sink).await.unwrap().is_none());
        }
        assert!(
            matches!(turn.row(serde_json::json!({"type":"system","subtype":"turn_duration","sessionId":"session"}), &sink).await.unwrap(), Some(Outcome::Failed { code: Some(code), .. }) if code == "native_api_failed")
        );
    }
    #[tokio::test]
    async fn host_mcp_results_are_not_orphan_native_tool_activities() {
        struct Collect(std::sync::Mutex<Vec<Output>>);
        impl OutputSink for Collect {
            fn emit(&self, event: Output) -> BoxFuture<'_, Result<(), Error>> {
                Box::pin(async move {
                    self.0.lock().unwrap().push(event);
                    Ok(())
                })
            }
        }
        let mut turn = turn();
        let sink = Collect(Default::default());
        for row in [
            serde_json::json!({"type":"user","sessionId":"session","message":{"content":"current prompt"}}),
            serde_json::json!({"type":"assistant","uuid":"host-call","sessionId":"session","message":{"content":[{"type":"tool_use","id":"mcp-call","name":"mcp__maka__SessionRead","input":{"sessionId":"maka-session"}}]}}),
            serde_json::json!({"type":"user","sessionId":"session","message":{"content":[{"type":"tool_result","tool_use_id":"mcp-call","content":"Host owns this receipt"}]}}),
        ] {
            turn.row(row, &sink).await.unwrap();
        }
        assert!(sink.0.lock().unwrap().is_empty());
        for row in [
            serde_json::json!({"type":"assistant","uuid":"native-call","sessionId":"session","message":{"content":[{"type":"tool_use","id":"native-call","name":"Bash","input":{"command":"true"}}]}}),
            serde_json::json!({"type":"user","sessionId":"session","message":{"content":[{"type":"tool_result","tool_use_id":"native-call","content":"done"}]}}),
        ] {
            turn.row(row, &sink).await.unwrap();
        }
        let events = sink.0.lock().unwrap();
        assert!(
            matches!(&events[..], [Output::ToolStart{tool_call_id:start,..},Output::ToolResult{tool_call_id:end,..}] if start=="native-call" && end==start)
        );
    }
    #[tokio::test]
    async fn api_failure_is_not_success_even_when_claude_also_writes_turn_duration() {
        let mut turn = turn();
        let sink = Sink;
        turn.row(serde_json::json!({"type":"user","sessionId":"session","message":{"content":"current prompt"}}), &sink).await.unwrap();
        assert!(turn.row(serde_json::json!({"type":"assistant","sessionId":"session","uuid":"api-error","isApiErrorMessage":true,"message":{"content":[{"type":"text","text":"API Error: 400 PTY_ERROR_SENTINEL"}]}}), &sink).await.unwrap().is_none());
        assert!(
            matches!(turn.row(serde_json::json!({"type":"system","subtype":"turn_duration","sessionId":"session"}),&sink).await.unwrap(),Some(Outcome::Failed{message,..}) if message=="Claude API request failed: API Error: 400 PTY_ERROR_SENTINEL")
        );
    }
    #[tokio::test]
    async fn recoverable_tool_failure_does_not_turn_an_assistant_reply_into_api_failure() {
        let mut turn = turn();
        let sink = Sink;
        for row in [
            serde_json::json!({"type":"user","sessionId":"session","message":{"content":"current prompt"}}),
            serde_json::json!({"type":"user","sessionId":"session","message":{"content":[{"type":"tool_result","tool_use_id":"native-call","is_error":true,"content":"file missing"}]}}),
            serde_json::json!({"type":"assistant","sessionId":"session","uuid":"answer","message":{"content":[{"type":"text","text":"Explained the missing file"}]}}),
        ] {
            turn.row(row, &sink).await.unwrap();
        }
        assert!(
            matches!(turn.row(serde_json::json!({"type":"system","subtype":"turn_duration","sessionId":"session"}),&sink).await.unwrap(),Some(Outcome::Completed{text}) if text=="Explained the missing file")
        );
    }
    #[tokio::test]
    async fn live_cursor_fences_history_waits_for_partial_lines_and_rejects_truncation() {
        use tokio::io::AsyncWriteExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.jsonl");
        tokio::fs::write(
            &path,
            b"{\"type\":\"system\",\"subtype\":\"turn_duration\"}\n",
        )
        .await
        .unwrap();
        let mut cursor = Cursor::fence(path.clone(), true).await.unwrap();
        assert!(cursor.next().await.unwrap().is_none());
        let mut file = tokio::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .await
            .unwrap();
        file.write_all(b"{\"type\":\"system\",\"subtype\":\"turn_")
            .await
            .unwrap();
        file.flush().await.unwrap();
        assert!(cursor.next().await.unwrap().is_none());
        file.write_all(b"duration\"}").await.unwrap();
        file.flush().await.unwrap();
        assert!(
            cursor.next().await.unwrap().is_none(),
            "a final JSON object without newline is still a partial JSONL record"
        );
        file.write_all(b"\n").await.unwrap();
        file.flush().await.unwrap();
        assert_eq!(
            cursor.next().await.unwrap().unwrap()["subtype"],
            "turn_duration"
        );
        tokio::fs::write(&path, b"{}\n").await.unwrap();
        assert!(
            matches!(cursor.next().await,Err(Error::Invalid(message)) if message.contains("truncated"))
        );
    }
    #[tokio::test]
    async fn live_cursor_rejects_rotation_and_complete_malformed_lines() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.jsonl");
        tokio::fs::write(&path, b"{}\n").await.unwrap();
        let mut cursor = Cursor::fence(path.clone(), true).await.unwrap();
        tokio::fs::rename(&path, directory.path().join("old.jsonl"))
            .await
            .unwrap();
        tokio::fs::write(&path, b"bad json\n").await.unwrap();
        assert!(
            matches!(cursor.next().await,Err(Error::Invalid(message)) if message.contains("rotated"))
        );
        let mut cursor = Cursor::fence(directory.path().join("new.jsonl"), false)
            .await
            .unwrap();
        tokio::fs::write(&cursor.path, b"bad json\n").await.unwrap();
        assert!(cursor.next().await.is_err());
    }
}
