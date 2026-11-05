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
) -> Result<Outcome, Error> {
    let result = prepare(
        config,
        cwd,
        request,
        storage,
        journal,
        output,
        bridge.clone(),
        cancellation,
    )
    .await;
    // Preparation can fail before a PTY exists; credentials are still revoked.
    let closed = bridge.close().await;
    if matches!(result, Err(Error::CleanupUnconfirmed)) {
        return result;
    }
    closed?;
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
) -> Result<Outcome, Error> {
    if request
        .get("images")
        .and_then(Value::as_array)
        .is_some_and(|images| !images.is_empty())
    {
        return Err(Error::Invalid(
            "Claude interactive image attachment submission is unsupported".into(),
        ));
    }
    let resume = journal.native_session().map(str::to_owned);
    let session = resume.clone().unwrap_or_else(|| Uuid::new_v4().to_string());
    Uuid::parse_str(&session)
        .map_err(|_| Error::Invalid("Claude native session ID must be a UUID".into()))?;
    let cwd = tokio::fs::canonicalize(cwd)
        .await
        .map_err(|e| Error::Provider(e.to_string()))?;
    let transcript = transcript(config, &cwd, &session)?;
    let mut cursor = Cursor::fence(transcript, resume.is_some()).await?;
    // Claude accepts a caller-selected UUID. Commit it before the positional prompt can cause effects.
    journal.opened(storage, session.clone()).await?;
    if cancellation.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let directory = tempfile::Builder::new()
        .prefix("maka-native-claude-")
        .tempdir()
        .map_err(|e| Error::Provider(e.to_string()))?;
    let mcp_config = directory.path().join("mcp.json");
    tokio::fs::write(
        &mcp_config,
        serde_json::to_vec(&bridge.claude()).expect("MCP config is JSON"),
    )
    .await
    .map_err(|e| Error::Provider(e.to_string()))?;
    let mut plan = runtime::command(
        config,
        cwd.to_str()
            .ok_or_else(|| Error::Invalid("Claude cwd must be UTF-8".into()))?,
    )
    .await?;
    plan.arg("--dangerously-skip-permissions")
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
    if let Some(instructions) = request.get("instructions").and_then(Value::as_str) {
        plan.arg("--append-system-prompt").arg(instructions);
    }
    let prompt = runtime::string(request, "/message")?;
    plan.arg("--").arg(prompt);
    bridge.admit()?;
    let (mut child, io) = maka_process::pty::spawn(
        plan,
        maka_agent_facts::terminal::TerminalSize::new(120, 40).expect("fixed native terminal size"),
    )
    .await
    .map_err(runtime::process_error)?;
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
    let terminal_stop = CancellationToken::new();
    let terminal_done = CancellationToken::new();
    let terminal = async {
        let result = async {
        let mut buffer = [0u8; 8192];
        let mut startup = Vec::new();
        loop {
            let read = tokio::select! {
                biased;
                () = exited.cancelled() => {
                    return tokio::time::timeout(Duration::from_secs(1), async {
                        loop { if io.read(&mut buffer).await.map_err(|_| Error::CleanupUnconfirmed)? == 0 { return Ok::<(), Error>(()); } }
                    }).await.map_err(|_| Error::CleanupUnconfirmed)?;
                }
                read = io.read(&mut buffer) => read.map_err(|_| Error::CleanupUnconfirmed)?,
            };
            if read == 0 {
                return Ok(());
            }
            // Bounded detection only: terminal text never proves prompt admission or completion.
            startup.extend_from_slice(&buffer[..read]);
            if startup.len() > 32 * 1024 {
                startup.drain(..startup.len() - 32 * 1024);
            }
            let text = String::from_utf8_lossy(&startup).to_lowercase();
            if text.contains("bypass permissions mode") && text.contains("yes, i accept")
                || text.contains("choose the text style")
                || text.contains("do you trust the files in this folder")
                || text.contains("select login method")
            {
                terminal_stop.cancel();
            }
        }
        }.await;
        terminal_done.cancel();
        result
    };
    let business = async {
        let work = observe(&mut cursor, &session, prompt, output.as_ref());
        tokio::pin!(work);
        let result = tokio::select! { biased;
            () = cancellation.cancelled() => Err(Error::Cancelled),
            () = bridge.failed.cancelled() => Err(Error::Unknown),
            () = terminal_stop.cancelled() => Err(Error::Invalid("Claude interactive setup is required; initialize and accept bypass permissions in the native CLI first".into())),
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
        let _retained = directory.keep();
        return Err(Error::CleanupUnconfirmed);
    }
    result
}
fn transcript(config: &NativeCommand, cwd: &Path, session: &str) -> Result<PathBuf, Error> {
    let root = config
        .env
        .get("CLAUDE_CONFIG_DIR")
        .cloned()
        .or_else(|| std::env::var("CLAUDE_CONFIG_DIR").ok())
        .map(PathBuf::from)
        .or_else(|| {
            config
                .env
                .get("HOME")
                .cloned()
                .or_else(|| std::env::var("HOME").ok())
                .map(|home| PathBuf::from(home).join(".claude"))
        })
        .ok_or_else(|| Error::Invalid("Claude configuration directory is unavailable".into()))?;
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
                return serde_json::from_slice(&line)
                    .map(Some)
                    .map_err(|_| Error::Invalid("Malformed complete Claude JSONL line".into()));
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
            if self.pending.len() > 8 * 1024 * 1024 {
                return Err(Error::Invalid(
                    "Claude live JSONL line exceeds 8 MiB".into(),
                ));
            }
        }
    }
}
async fn observe(
    cursor: &mut Cursor,
    session: &str,
    prompt: &str,
    output: &dyn OutputSink,
) -> Result<Outcome, Error> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
    let mut turn = LiveTurn {
        session,
        prompt,
        admitted: false,
        assistant: false,
        text: String::new(),
        message_ids: std::collections::BTreeSet::new(),
        host_tool_calls: Default::default(),
    };
    loop {
        match cursor.next().await? {
            Some(row) => {
                if let Some(outcome) = turn.row(row, output).await? {
                    return Ok(outcome);
                }
            }
            None => {
                if !turn.admitted && tokio::time::Instant::now() >= deadline {
                    return Err(Error::Invalid(
                        "Claude interactive setup or prompt admission was not confirmed".into(),
                    ));
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
}
struct LiveTurn<'a> {
    session: &'a str,
    prompt: &'a str,
    admitted: bool,
    assistant: bool,
    text: String,
    message_ids: std::collections::BTreeSet<String>,
    host_tool_calls: std::collections::BTreeSet<String>,
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
                    .is_some_and(|v| content_text(v) == self.prompt)
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
        if kind == "assistant" {
            if row.get("isApiErrorMessage").and_then(Value::as_bool) == Some(true) {
                return Err(Error::Provider(format!(
                    "Claude API request failed: {}",
                    content_text(&row["message"]["content"])
                )));
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
            if !self.assistant || row.get("sessionId").and_then(Value::as_str) != Some(self.session)
            {
                return Err(Error::Invalid(
                    "Claude terminal lacks current assistant/session correlation".into(),
                ));
            }
            return Ok(Some(Outcome::Completed {
                text: std::mem::take(&mut self.text),
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
            admitted: false,
            assistant: false,
            text: String::new(),
            message_ids: Default::default(),
            host_tool_calls: Default::default(),
        }
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
        let error = turn.row(serde_json::json!({"type":"assistant","sessionId":"session","uuid":"api-error","isApiErrorMessage":true,"error":"unknown","message":{"model":"<synthetic>","content":[{"type":"text","text":"API Error: 400 PTY_ERROR_SENTINEL"}]}}), &sink).await.unwrap_err();
        assert!(
            matches!(error, Error::Provider(ref reason) if reason.contains("PTY_ERROR_SENTINEL"))
        );
        assert!(turn.row(serde_json::json!({"type":"system","subtype":"turn_duration","sessionId":"session"}),&sink).await.is_err());
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
