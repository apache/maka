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

//! The original CLI's stream-json stdout is the only business-terminal source.
use super::*;
use maka_agent_facts::executor::Output;
use runtime::Pipe;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

#[expect(
    clippy::too_many_arguments,
    reason = "one original private CLI owns its protocol and observation ports"
)]
pub(super) async fn execute(
    config: &NativeCommand,
    cwd: &str,
    request: &Value,
    journal: &mut journal::ProtocolSession,
    output: Arc<dyn OutputSink>,
    bridge: Arc<mcp::Bridge>,
    cancellation: CancellationToken,
    steering: &mut steering::Steering,
    owner: maka_process::isolated::TaskOwner,
) -> Result<Outcome, Error> {
    let session = Uuid::new_v4().to_string();
    let input = Uuid::new_v4().to_string();
    let path = bridge.directory().join("mcp.json");
    tokio::fs::write(
        &path,
        serde_json::to_vec(&bridge.claude()).expect("MCP configuration is JSON"),
    )
    .await
    .map_err(|e| Error::Provider(format!("Claude MCP configuration failed: {e}")))?;
    let mut command = runtime::command(config, cwd).await?;
    command.args([
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--replay-user-messages",
        "--dangerously-skip-permissions",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--session-id",
        &session,
        "--mcp-config",
    ]);
    command.arg(&path);
    if let Some(model) = request
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| *model != "default")
    {
        command.arg("--model").arg(model);
    }
    if let Some(effort) = request.get("effort").and_then(Value::as_str) {
        command.arg("--effort").arg(effort);
    }
    if let Some(instructions) = request.get("instructions").and_then(Value::as_str) {
        command.arg("--append-system-prompt").arg(instructions);
    }
    journal.opened(session.clone())?;
    let observation = journal.observation();
    runtime::task_pipe(
        owner,
        observation,
        command,
        runtime::Transport::JsonLines,
        Some(bridge.clone()),
        cancellation,
        Protocol {
            request,
            session,
            input,
            journal,
            output,
            bridge,
            steering,
        },
    )
    .await
}

struct Protocol<'a> {
    request: &'a Value,
    session: String,
    input: String,
    journal: &'a mut journal::ProtocolSession,
    output: Arc<dyn OutputSink>,
    bridge: Arc<mcp::Bridge>,
    steering: &'a mut steering::Steering,
}
impl runtime::PipeProtocol for Protocol<'_> {
    type Output = Outcome;
    fn run<'io>(self, io: &'io mut Pipe) -> BoxFuture<'io, Result<Outcome, Error>>
    where
        Self: 'io,
    {
        Box::pin(async move {
            let result = run(
                io,
                self.request,
                &self.session,
                &self.input,
                self.journal,
                self.output.as_ref(),
                &self.bridge,
                self.steering,
            )
            .await;
            match result {
                Err(Error::Invalid(_) | Error::Provider(_) | Error::Cancelled) => {
                    Err(Error::Unknown)
                }
                result => result,
            }
        })
    }
}

fn user_input(
    request: &Value,
    session: &str,
    id: &str,
) -> BoxFuture<'static, Result<Value, Error>> {
    let text = runtime::string(request, "/message").map(str::to_owned);
    let images = request
        .get("images")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let session = session.to_owned();
    let id = id.to_owned();
    Box::pin(async move {
        let text = text?;
        let content = tokio::task::spawn_blocking(move || {
        use base64::Engine as _;
        if images.is_empty() { return Ok::<_, Error>(Value::String(text)); }
        let mut blocks = vec![serde_json::json!({"type":"text","text":text})];
        for image in images {
            let path = runtime::string(&image, "/path")?;
            let bytes = std::fs::read(path).map_err(|e| Error::Provider(format!("Claude private image read failed: {e}")))?;
            let media = runtime::string(&image, "/mediaType")?;
            blocks.push(serde_json::json!({"type":"image","source":{"type":"base64","media_type":media,"data":base64::engine::general_purpose::STANDARD.encode(bytes)}}));
        }
        Ok(Value::Array(blocks))
    }).await.map_err(|e| Error::Provider(format!("Claude input encoding failed: {e}")))??;
        Ok(
            serde_json::json!({"type":"user","session_id":session,"uuid":id,"parent_tool_use_id":null,"message":{"role":"user","content":content}}),
        )
    })
}

#[expect(
    clippy::too_many_arguments,
    reason = "the original wire and canonical witnesses must remain together"
)]
async fn run(
    io: &mut Pipe,
    request: &Value,
    session: &str,
    input: &str,
    journal: &journal::ProtocolSession,
    output: &dyn OutputSink,
    bridge: &mcp::Bridge,
    steering: &mut steering::Steering,
) -> Result<Outcome, Error> {
    io.cancellation = CancellationToken::new();
    let mut turn = StreamTurn::new(session.to_owned());
    turn.sent(input.to_owned());
    bridge.admit()?;
    let wire_input = io
        .prepare_input(user_input(request, session, input))
        .await?;
    io.turn_started();
    io.send(wire_input).await?;
    let retired = io.retired.clone();
    let stop = io.stop.clone();
    let failed = bridge.failed.clone();
    let mut stop_deadline = None;
    let mut bound = false;
    loop {
        let row = tokio::select! {
            biased;
            () = retired.cancelled() => return Err(Error::ObservationRetired),
            () = stop.cancelled(), if stop_deadline.is_none() => {
                bridge.close_admission();
                if !bound {
                    return Err(Error::Unknown);
                }
                let id = Uuid::new_v4().to_string();
                turn.control(id.clone());
                io.control_message(serde_json::json!({"type":"control_request","request_id":id,"request":{"subtype":"interrupt"}})).await;
                stop_deadline = Some(tokio::time::Instant::now() + runtime::INTERRUPT_TIMEOUT);
                continue;
            }
            () = async { match stop_deadline { Some(at) => tokio::time::sleep_until(at).await, None => std::future::pending().await } } => return Err(Error::Unknown),
            () = failed.cancelled() => return Err(Error::Unknown),
            row = io.next() => row?,
            ready = steering.ready(), if stop_deadline.is_none() => {
                ready?;
                let next = match steering.take().await {
                    Err(Error::Cancelled) => {
                        journal.observation().control_allowed(&io.stop).await?;
                        None
                    }
                    result => result?,
                };
                if let Some(next) = next {
                    let id = Uuid::new_v4().to_string();
                    let message = io.prepare_input(user_input(&next, session, &id)).await?;
                    turn.sent(id);
                    io.send(message).await?;
                }
                continue;
            }
        };
        if !bound && turn.is_ack(&row, input) {
            journal
                .bind_task(NativeTask::ClaudeStream {
                    session: session.to_owned(),
                    input: input.to_owned(),
                })
                .await?;
            bound = true;
        }
        if let Some(outcome) = turn.row(row, output).await? {
            if !bound {
                return Err(Error::Unknown);
            }
            journal.closed(outcome.clone()).await?;
            return Ok(outcome);
        }
    }
}

struct PendingInput {
    id: String,
    accepted: bool,
}
struct OpenMessage {
    id: String,
    rows: BTreeSet<String>,
    body: bool,
    thinking: bool,
}
struct StreamTurn {
    session: String,
    initialized: bool,
    pending: VecDeque<PendingInput>,
    controls: BTreeSet<String>,
    tools: BTreeMap<String, bool>,
    message: Option<OpenMessage>,
    final_message: Option<String>,
    first_failure: Option<Outcome>,
}
impl StreamTurn {
    fn new(session: String) -> Self {
        Self {
            session,
            initialized: false,
            pending: VecDeque::new(),
            controls: BTreeSet::new(),
            tools: BTreeMap::new(),
            message: None,
            final_message: None,
            first_failure: None,
        }
    }
    fn sent(&mut self, id: String) {
        self.pending.push_back(PendingInput {
            id,
            accepted: false,
        });
    }
    fn control(&mut self, id: String) {
        self.controls.insert(id);
    }
    fn is_ack(&self, row: &Value, id: &str) -> bool {
        row["type"] == "user"
            && row["isReplay"] == true
            && row["uuid"] == id
            && row["session_id"] == self.session
            && row["parent_tool_use_id"].is_null()
    }
    async fn end_message(&mut self, output: &dyn OutputSink) -> Result<(), Error> {
        if let Some(message) = self.message.take() {
            output
                .emit(Output::MessageEnd {
                    message_id: message.id.clone(),
                })
                .await?;
            if message.body {
                self.final_message = Some(message.id);
            }
        }
        Ok(())
    }
    async fn row(
        &mut self,
        mut row: Value,
        output: &dyn OutputSink,
    ) -> Result<Option<Outcome>, Error> {
        let kind = runtime::string(&row, "/type")?.to_owned();
        if kind == "control_response" {
            let id = runtime::string(&row, "/response/request_id")?;
            if !self.controls.remove(id) {
                return Err(Error::Unknown);
            }
            return Ok(None);
        }
        if matches!(
            kind.as_str(),
            "system" | "assistant" | "user" | "result" | "stream_event"
        ) && row["session_id"] != self.session
        {
            return Err(Error::Unknown);
        }
        if !row["parent_tool_use_id"].is_null() {
            return Ok(None);
        }
        match kind.as_str() {
            "system" => {
                if row["subtype"] == "init" {
                    self.initialized = true;
                }
            }
            "stream_event" => {} // Whole assistant blocks are the canonical output; never emit both forms.
            "user" if row["isReplay"] == true => {
                if !self.initialized {
                    return Err(Error::Unknown);
                }
                let id = runtime::string(&row, "/uuid")?;
                let pending = self
                    .pending
                    .iter_mut()
                    .find(|input| !input.accepted)
                    .ok_or(Error::Unknown)?;
                if pending.id != id {
                    return Err(Error::Unknown);
                }
                pending.accepted = true;
            }
            "assistant" => {
                if !self.pending.front().is_some_and(|input| input.accepted) {
                    return Err(Error::Unknown);
                }
                let id = runtime::string(&row, "/message/id")?.to_owned();
                let row_id = runtime::string(&row, "/uuid")?.to_owned();
                if self.message.as_ref().map(|m| &m.id) != Some(&id) {
                    self.end_message(output).await?;
                    output
                        .emit(Output::MessageStart {
                            message_id: id.clone(),
                        })
                        .await?;
                    self.message = Some(OpenMessage {
                        id: id.clone(),
                        rows: BTreeSet::new(),
                        body: false,
                        thinking: false,
                    });
                }
                if !self
                    .message
                    .as_mut()
                    .expect("started message")
                    .rows
                    .insert(row_id)
                {
                    return Err(Error::Unknown);
                }
                let Value::Array(blocks) = row["message"]["content"].take() else {
                    return Err(Error::Unknown);
                };
                for mut block in blocks {
                    match block["type"].as_str() {
                        Some("text") => {
                            let text = runtime::string(&block, "/text")?;
                            if !text.is_empty() {
                                let message = self.message.as_mut().expect("started message");
                                let text = if message.body {
                                    format!("\n\n{text}")
                                } else {
                                    text.to_owned()
                                };
                                message.body = true;
                                output
                                    .emit(Output::OutputDelta {
                                        message_id: id.clone(),
                                        text,
                                    })
                                    .await?;
                            }
                        }
                        Some("thinking") => {
                            let text = runtime::string(&block, "/thinking")?;
                            if !text.is_empty() {
                                let message = self.message.as_mut().expect("started message");
                                let text = if message.thinking {
                                    format!("\n\n{text}")
                                } else {
                                    text.to_owned()
                                };
                                message.thinking = true;
                                output
                                    .emit(Output::ThinkingDelta {
                                        message_id: id.clone(),
                                        text,
                                    })
                                    .await?;
                            }
                        }
                        Some("tool_use") => {
                            let tool = runtime::string(&block, "/id")?.to_owned();
                            let name = runtime::string(&block, "/name")?.to_owned();
                            if matches!(
                                name.as_str(),
                                "AskUserQuestion" | "EnterPlanMode" | "ExitPlanMode"
                            ) {
                                return Err(Error::Unknown);
                            }
                            let host = name.starts_with("mcp__maka__");
                            if self.tools.insert(tool.clone(), host).is_some() {
                                return Err(Error::Unknown);
                            }
                            if !host {
                                output
                                    .emit(Output::ToolStart {
                                        tool_call_id: tool,
                                        name,
                                        input: block["input"].take(),
                                    })
                                    .await?;
                            }
                        }
                        Some("redacted_thinking") => {}
                        _ => return Err(Error::Unknown),
                    }
                }
            }
            "user" => {
                if let Some(blocks) = row.pointer("/message/content").and_then(Value::as_array) {
                    for block in blocks {
                        if block["type"] == "tool_result" {
                            let id = runtime::string(block, "/tool_use_id")?;
                            let host = self.tools.remove(id).ok_or(Error::Unknown)?;
                            if !host {
                                output
                                    .emit(Output::ToolResult {
                                        tool_call_id: id.to_owned(),
                                        text: content_text(&block["content"]),
                                        is_error: block["is_error"] == true,
                                    })
                                    .await?;
                            }
                        }
                    }
                }
            }
            "result" => {
                if !self.initialized
                    || !self.pending.front().is_some_and(|input| input.accepted)
                    || !row["deferred_tool_use"].is_null()
                {
                    return Err(Error::Unknown);
                }
                self.end_message(output).await?;
                let subtype = runtime::string(&row, "/subtype")?;
                let error = row["is_error"].as_bool().ok_or(Error::Unknown)?;
                if subtype == "success" && !error && !self.tools.is_empty() {
                    return Err(Error::Unknown);
                }
                let outcome = match (subtype, error) {
                    ("success", false) => Outcome::Completed {
                        message_id: self.final_message.clone(),
                    },
                    ("success", true) | ("error_during_execution" | "error_max_turns", _) => {
                        Outcome::Failed {
                            message: row
                                .get("result")
                                .and_then(Value::as_str)
                                .map(str::to_owned)
                                .unwrap_or_else(|| {
                                    format!(
                                        "Claude native result {subtype}: {}",
                                        row.get("errors").unwrap_or(&Value::Null)
                                    )
                                }),
                            code: Some(format!("native_{subtype}")),
                            recoverable: false,
                        }
                    }
                    _ => return Err(Error::Unknown),
                };
                if matches!(outcome, Outcome::Failed { .. }) && self.first_failure.is_none() {
                    self.first_failure = Some(outcome.clone());
                }
                self.pending.pop_front();
                if self.pending.is_empty() {
                    return Ok(Some(self.first_failure.take().unwrap_or(outcome)));
                }
                self.final_message = None;
            }
            _ => return Err(Error::Unknown),
        }
        Ok(None)
    }
}
fn content_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_owned();
    }
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| b["type"] == "text")
        .filter_map(|b| b["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) async fn replay(
    binding: &NativeBinding,
    admitted_steering_batches: u64,
    input: &mut replay::Stream,
    stream: &mut replay::Stream,
    output: &dyn OutputSink,
) -> Result<Outcome, Error> {
    let NativeTask::ClaudeStream {
        session,
        input: initial,
    } = &binding.task
    else {
        return Err(Error::Unknown);
    };
    let mut turn = StreamTurn::new(session.clone());
    let mut first = true;
    let mut user_frames = 0_u64;
    while let Some(row) = input.next().await? {
        match row["type"].as_str() {
            Some("user")
                if row["session_id"] == *session
                    && row["parent_tool_use_id"].is_null()
                    && row["message"]["role"] == "user" =>
            {
                let id = runtime::string(&row, "/uuid")?;
                Uuid::parse_str(id).map_err(|_| Error::Unknown)?;
                if first && id != initial {
                    return Err(Error::Unknown);
                }
                first = false;
                user_frames = user_frames.checked_add(1).ok_or(Error::Unknown)?;
                turn.sent(id.to_owned());
            }
            Some("control_request") if row["request"]["subtype"] == "interrupt" => {
                turn.control(runtime::string(&row, "/request_id")?.to_owned());
            }
            _ => return Err(Error::Unknown),
        }
    }
    if first {
        return Err(Error::Unknown);
    }
    let mut outcome = None;
    while let Some(row) = stream.next().await? {
        if let Some(done) = turn.row(row, output).await? {
            if outcome.replace(done).is_some() {
                return Err(Error::Unknown);
            }
        }
    }
    if !turn.pending.is_empty() {
        return Err(Error::Unknown);
    }
    let outcome = outcome.ok_or(Error::Unknown)?;
    if matches!(outcome, Outcome::Completed { .. })
        && user_frames
            != admitted_steering_batches
                .checked_add(1)
                .ok_or(Error::Unknown)?
    {
        return Err(Error::Unknown);
    }
    Ok(outcome)
}
#[cfg(test)]
#[path = "claude/input.rs"]
mod input;

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;
    #[derive(Default)]
    struct Collect(std::sync::Mutex<Vec<Output>>);
    impl OutputSink for Collect {
        fn emit(&self, event: Output) -> BoxFuture<'_, Result<(), Error>> {
            Box::pin(async move {
                self.0.lock().unwrap().push(event);
                Ok(())
            })
        }
    }
    fn row(mut value: Value) -> Value {
        value["session_id"] = "session".into();
        value
    }
    fn ack(id: &str) -> Value {
        row(
            serde_json::json!({"type":"user","uuid":id,"isReplay":true,"parent_tool_use_id":null,"message":{"role":"user","content":"current prompt"}}),
        )
    }
    fn assistant(id: &str, uuid: &str, blocks: Value) -> Value {
        row(
            serde_json::json!({"type":"assistant","uuid":uuid,"message":{"id":id,"role":"assistant","content":blocks}}),
        )
    }
    fn result(subtype: &str, error: bool) -> Value {
        row(
            serde_json::json!({"type":"result","subtype":subtype,"is_error":error,"errors":["native failure"]}),
        )
    }
    async fn turn(sink: &dyn OutputSink) -> StreamTurn {
        let mut turn = StreamTurn::new("session".into());
        turn.sent("input".into());
        assert!(
            turn.row(
                row(serde_json::json!({"type":"system","subtype":"init"})),
                sink
            )
            .await
            .unwrap()
            .is_none()
        );
        assert!(turn.row(ack("input"), sink).await.unwrap().is_none());
        turn
    }
    fn spool(file: &std::path::Path) -> replay::Stream {
        replay::Stream::new(
            std::fs::File::open(file).unwrap(),
            CancellationToken::new(),
            CancellationToken::new(),
        )
    }
    fn actual_maka_helper() -> PathBuf {
        let test = std::env::current_exe().unwrap();
        let profile = test.parent().unwrap().parent().unwrap();
        let helper = profile.join(if cfg!(windows) { "maka.exe" } else { "maka" });
        assert!(
            helper.is_file(),
            "native fixture requires the archived actual Maka CLI helper: {}",
            helper.display()
        );
        helper
    }
    #[tokio::test]
    async fn configuration_directory_is_private_not_inherited_from_home_or_userprofile() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        let root = directory.path().join("root");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        let prepared = maka_process::isolated::TaskOwner::prepare(
            &source,
            &root,
            &actual_maka_helper(),
            &maka_sandbox::Sandbox::Disabled,
            &maka_sandbox::filesystem::Policy::uniform(maka_sandbox::filesystem::Access::Write),
            CancellationToken::new(),
        )
        .await;
        if !cfg!(target_os = "macos") {
            assert!(matches!(
                prepared,
                Err(maka_process::isolated::Error::IsolationUnavailable(_))
            ));
            return;
        }
        let owner = prepared.unwrap();
        assert!(owner.claude_config_dir().is_absolute());
        assert!(owner.claude_config_dir().starts_with(owner.home()));
        assert_ne!(owner.home(), source);
        assert_ne!(owner.claude_config_dir(), root);
    }
    #[tokio::test]
    async fn api_message_id_groups_rows_joins_blocks_and_survives_interleaved_tool_results() {
        let sink = Collect::default();
        let mut turn = turn(&sink).await;
        for value in [
            assistant(
                "api-1",
                "r1",
                serde_json::json!([{"type":"thinking","thinking":"first thought"},{"type":"text","text":"before"}]),
            ),
            assistant(
                "api-1",
                "r2",
                serde_json::json!([{"type":"thinking","thinking":"second thought"},{"type":"text","text":"tool"},{"type":"tool_use","id":"call-1","name":"Read","input":{"path":"a"}}]),
            ),
            row(
                serde_json::json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call-1","content":"ok-1"}]}}),
            ),
            assistant(
                "api-1",
                "r3",
                serde_json::json!([{"type":"tool_use","id":"call-2","name":"Read","input":{"path":"b"}}]),
            ),
        ] {
            assert!(turn.row(value, &sink).await.unwrap().is_none());
        }
        let count = sink.0.lock().unwrap().len();
        let duplicate = assistant(
            "api-1",
            "r3",
            serde_json::json!([{"type":"tool_use","id":"call-2","name":"Read","input":{"path":"b"}}]),
        );
        assert!(matches!(
            turn.row(duplicate, &sink).await,
            Err(Error::Unknown)
        ));
        assert_eq!(
            sink.0.lock().unwrap().len(),
            count,
            "duplicate native rows cannot duplicate canonical outputs"
        );
        assert!(
            !sink
                .0
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, Output::MessageEnd { .. }))
        );
        for value in [
            row(
                serde_json::json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call-2","content":"ok-2"}]}}),
            ),
            assistant(
                "api-2",
                "r4",
                serde_json::json!([{"type":"text","text":"after tool"}]),
            ),
            assistant(
                "api-thinking",
                "r5",
                serde_json::json!([{"type":"thinking","thinking":"not the answer"}]),
            ),
        ] {
            assert!(turn.row(value, &sink).await.unwrap().is_none());
        }
        assert!(
            matches!(turn.row(result("success",false),&sink).await.unwrap(),Some(Outcome::Completed{message_id:Some(id)}) if id=="api-2")
        );
        assert_eq!(
            serde_json::to_value(&*sink.0.lock().unwrap()).unwrap(),
            serde_json::json!([
                {"type":"message_start","messageId":"api-1"},{"type":"thinking_delta","messageId":"api-1","text":"first thought"},{"type":"output_delta","messageId":"api-1","text":"before"},{"type":"thinking_delta","messageId":"api-1","text":"\n\nsecond thought"},{"type":"output_delta","messageId":"api-1","text":"\n\ntool"},{"type":"tool_start","toolCallId":"call-1","name":"Read","input":{"path":"a"}},{"type":"tool_result","toolCallId":"call-1","text":"ok-1","isError":false},{"type":"tool_start","toolCallId":"call-2","name":"Read","input":{"path":"b"}},{"type":"tool_result","toolCallId":"call-2","text":"ok-2","isError":false},{"type":"message_end","messageId":"api-1"},{"type":"message_start","messageId":"api-2"},{"type":"output_delta","messageId":"api-2","text":"after tool"},{"type":"message_end","messageId":"api-2"},{"type":"message_start","messageId":"api-thinking"},{"type":"thinking_delta","messageId":"api-thinking","text":"not the answer"},{"type":"message_end","messageId":"api-thinking"}
            ])
        );
    }
    #[tokio::test]
    async fn setup_and_partial_events_are_suppressed_and_native_api_identity_is_required() {
        let sink = Collect::default();
        let mut turn = turn(&sink).await;
        for value in [
            row(
                serde_json::json!({"type":"system","subtype":"hook_response","stdout":"fake result"}),
            ),
            row(
                serde_json::json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"not canonical twice"}}}),
            ),
        ] {
            assert!(turn.row(value, &sink).await.unwrap().is_none());
        }
        assert!(sink.0.lock().unwrap().is_empty());
        assert!(turn.row(row(serde_json::json!({"type":"assistant","uuid":"not-an-api-id","message":{"content":[]}})),&sink).await.is_err());
    }
    #[tokio::test]
    async fn cancellation_before_submission_does_not_create_or_reuse_native_acceptance() {
        struct Source {
            retired: CancellationToken,
            writes: std::sync::atomic::AtomicUsize,
        }
        impl TaskBinding for Source {
            fn observation_retired(&self) -> CancellationToken {
                self.retired.clone()
            }
            fn admitted_steering_batches(&self) -> BoxFuture<'_, Result<u64, Error>> {
                Box::pin(async { Err(Error::Unknown) })
            }
            fn stop_requested(&self) -> BoxFuture<'_, Result<bool, Error>> {
                Box::pin(async { Ok(false) })
            }
            fn bound(&self, _: NativeBinding) -> BoxFuture<'_, Result<(), Error>> {
                Box::pin(async move {
                    self.writes
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Err(Error::Persistence(
                        "original acknowledgement unconfirmed".into(),
                    ))
                })
            }
            fn closed(&self, _: Outcome) -> BoxFuture<'_, Result<(), Error>> {
                Box::pin(async { Err(Error::Persistence("original closure unconfirmed".into())) })
            }
            fn cleanup(&self, _: OperationCleanup) -> BoxFuture<'_, Result<(), Error>> {
                Box::pin(async { Ok(()) })
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        let root = directory.path().join("root");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        let prepared = maka_process::isolated::TaskOwner::prepare(
            &source,
            &root,
            &actual_maka_helper(),
            &maka_sandbox::Sandbox::Disabled,
            &maka_sandbox::filesystem::Policy::uniform(maka_sandbox::filesystem::Access::Write),
            CancellationToken::new(),
        )
        .await;
        if !cfg!(target_os = "macos") {
            assert!(matches!(
                prepared,
                Err(maka_process::isolated::Error::IsolationUnavailable(_))
            ));
            return;
        }
        let owner = prepared.unwrap();
        let binding = Arc::new(Source {
            retired: CancellationToken::new(),
            writes: Default::default(),
        });
        let raw = CancellationToken::new();
        let mut journal = journal::ProtocolSession::new(
            binding.clone(),
            "original-command".into(),
            &owner,
            raw.clone(),
        );
        assert!(
            matches!(
                journal
                    .observation()
                    .control_allowed(&CancellationToken::new())
                    .await,
                Err(Error::Unknown)
            ),
            "no canonical Stop means no native control even before raw cancellation"
        );
        journal.opened("unsubmitted".into()).unwrap();
        raw.cancel();
        journal.revoke_unsubmitted();
        assert!(journal.native_session().is_none());
        journal.opened("original".into()).unwrap();
        binding.retired.cancel();
        assert!(matches!(
            journal
                .bind_task(NativeTask::ClaudeStream {
                    session: "original".into(),
                    input: "input".into()
                })
                .await,
            Err(Error::Persistence(_))
        ));
        assert_eq!(
            binding.writes.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "uncertain acknowledgement cannot be submitted again"
        );
        assert_eq!(journal.native_session(), Some("original"));
        assert!(matches!(
            journal
                .closed(Outcome::Completed { message_id: None })
                .await,
            Err(Error::Persistence(_))
        ));
        assert!(matches!(
            journal.opened("replacement".into()),
            Err(Error::Invalid(_))
        ));
        assert_eq!(journal.native_session(), Some("original"));
        let sink = Collect::default();
        let mut protocol = StreamTurn::new("original".into());
        protocol.sent("input".into());
        assert!(matches!(
            protocol.row(result("success", false), &sink).await,
            Err(Error::Unknown)
        ));
        assert!(sink.0.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn blocked_stop_attempts_and_control_ack_wait_for_native_result() {
        let sink = Collect::default();
        let mut turn = turn(&sink).await;
        turn.control("interrupt".into());
        for value in [
            serde_json::json!({"type":"control_response","response":{"request_id":"interrupt","subtype":"success"}}),
            row(serde_json::json!({"type":"system","subtype":"turn_duration"})),
            row(serde_json::json!({"type":"system","subtype":"stop_hook_summary"})),
            assistant(
                "answer",
                "r",
                serde_json::json!([{"type":"text","text":"then final"}]),
            ),
        ] {
            assert!(turn.row(value, &sink).await.unwrap().is_none());
        }
        assert!(
            matches!(turn.row(result("error_during_execution",false),&sink).await.unwrap(),Some(Outcome::Failed{code:Some(code),..}) if code=="native_error_during_execution")
        );
        assert!(
            turn.row(
                serde_json::json!({"type":"system","session_id":"different"}),
                &sink
            )
            .await
            .is_err()
        );
    }
    #[tokio::test]
    async fn native_image_placeholders_do_not_ack_an_original_input() {
        let sink = Collect::default();
        let mut turn = StreamTurn::new("session".into());
        turn.sent("input".into());
        turn.row(
            row(serde_json::json!({"type":"system","subtype":"init"})),
            &sink,
        )
        .await
        .unwrap();
        for count in [0, 1, 2] {
            let mut blocks = vec![
                serde_json::json!({"type":"text","text":"[Image #1] [Image #2]current prompt"}),
            ];
            blocks.extend((0..count).map(
                |_| serde_json::json!({"type":"image","source":{"type":"base64","data":"fixture"}}),
            ));
            assert!(
                turn.row(
                    row(serde_json::json!({"type":"user","message":{"content":blocks}})),
                    &sink
                )
                .await
                .unwrap()
                .is_none()
            );
            assert!(!turn.pending.front().unwrap().accepted);
        }
        turn.row(ack("input"), &sink).await.unwrap();
        assert!(turn.pending.front().unwrap().accepted);
    }
    #[tokio::test]
    async fn queued_steering_survives_intermediate_native_results() {
        let sink = Collect::default();
        let mut turn = turn(&sink).await;
        turn.sent("next".into());
        turn.sent("last".into());
        for value in [
            assistant(
                "old",
                "r1",
                serde_json::json!([{"type":"text","text":"first"}]),
            ),
            result("success", false),
            ack("next"),
            assistant(
                "next",
                "r2",
                serde_json::json!([{"type":"text","text":"second"}]),
            ),
            result("success", false),
            ack("last"),
            assistant(
                "last",
                "r3",
                serde_json::json!([{"type":"text","text":"third"}]),
            ),
        ] {
            assert!(turn.row(value, &sink).await.unwrap().is_none());
        }
        assert!(
            matches!(turn.row(result("success",false),&sink).await.unwrap(),Some(Outcome::Completed{message_id:Some(id)}) if id=="last")
        );
        assert!(turn.pending.is_empty());
    }
    #[tokio::test]
    async fn steering_needs_exact_fifo_input_not_tool_results_or_subagent_echoes() {
        let sink = Collect::default();
        let mut turn = turn(&sink).await;
        turn.sent("next".into());
        let mut subagent = ack("next");
        subagent["parent_tool_use_id"] = "subagent".into();
        turn.row(subagent, &sink).await.unwrap();
        turn.row(
            row(serde_json::json!({"type":"user","message":{"content":"next"}})),
            &sink,
        )
        .await
        .unwrap();
        assert!(!turn.pending.back().unwrap().accepted);
        assert!(turn.row(ack("different"), &sink).await.is_err());
        assert!(
            turn.row(result("success", false), &sink)
                .await
                .unwrap()
                .is_none()
        );
        turn.row(ack("next"), &sink).await.unwrap();
        assert!(turn.row(ack("next"), &sink).await.is_err());
        assert!(matches!(
            turn.row(result("success", false), &sink).await.unwrap(),
            Some(Outcome::Completed { message_id: None })
        ));
    }
    #[tokio::test]
    async fn steering_cannot_hide_an_intermediate_native_failure() {
        let sink = Collect::default();
        let mut turn = turn(&sink).await;
        turn.sent("next".into());
        assert!(
            turn.row(result("error_max_turns", false), &sink)
                .await
                .unwrap()
                .is_none()
        );
        turn.row(ack("next"), &sink).await.unwrap();
        turn.row(
            assistant(
                "later",
                "r",
                serde_json::json!([{"type":"text","text":"later reply"}]),
            ),
            &sink,
        )
        .await
        .unwrap();
        assert!(
            matches!(turn.row(result("success",false),&sink).await.unwrap(),Some(Outcome::Failed{code:Some(code),..}) if code=="native_error_max_turns")
        );
    }
    #[tokio::test]
    async fn host_mcp_results_are_not_orphan_native_tool_activities() {
        let sink = Collect::default();
        let mut turn = turn(&sink).await;
        for value in [
            assistant(
                "host",
                "h",
                serde_json::json!([{"type":"tool_use","id":"host-call","name":"mcp__maka__SessionRead","input":{}}]),
            ),
            row(
                serde_json::json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"host-call","content":"Host owns this receipt"}]}}),
            ),
        ] {
            turn.row(value, &sink).await.unwrap();
        }
        assert!(
            matches!(&sink.0.lock().unwrap()[..],[Output::MessageStart{message_id}] if message_id=="host")
        );
        sink.0.lock().unwrap().clear();
        for value in [
            assistant(
                "native",
                "n",
                serde_json::json!([{"type":"tool_use","id":"native-call","name":"Bash","input":{"command":"true"}}]),
            ),
            row(
                serde_json::json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"native-call","content":"done"}]}}),
            ),
            result("success", false),
        ] {
            turn.row(value, &sink).await.unwrap();
        }
        assert!(
            matches!(&sink.0.lock().unwrap()[..],[Output::MessageEnd{message_id:a},Output::MessageStart{message_id:b},Output::ToolStart{tool_call_id:c,..},Output::ToolResult{tool_call_id:d,..},Output::MessageEnd{message_id:e}] if a=="host"&&b=="native"&&c=="native-call"&&c==d&&b==e)
        );
    }
    #[tokio::test]
    async fn api_failure_is_not_success_even_when_is_error_is_false() {
        let sink = Collect::default();
        let mut turn = turn(&sink).await;
        turn.row(
            assistant(
                "failure",
                "r",
                serde_json::json!([{"type":"text","text":"API Error: 400 FIXTURE_API_FAILURE"}]),
            ),
            &sink,
        )
        .await
        .unwrap();
        assert!(
            turn.row(
                row(serde_json::json!({"type":"system","subtype":"turn_duration"})),
                &sink
            )
            .await
            .unwrap()
            .is_none()
        );
        assert!(
            matches!(turn.row(result("error_during_execution",false),&sink).await.unwrap(),Some(Outcome::Failed{code:Some(code),..}) if code=="native_error_during_execution")
        );
    }
    #[tokio::test]
    async fn recoverable_tool_failure_does_not_turn_an_assistant_reply_into_api_failure() {
        let sink = Collect::default();
        let mut turn = turn(&sink).await;
        for value in [
            assistant(
                "call",
                "c",
                serde_json::json!([{"type":"tool_use","id":"native-call","name":"Read","input":{}}]),
            ),
            row(
                serde_json::json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"native-call","is_error":true,"content":"file missing"}]}}),
            ),
            assistant(
                "answer",
                "a",
                serde_json::json!([{"type":"text","text":"Explained the missing file"}]),
            ),
        ] {
            assert!(turn.row(value, &sink).await.unwrap().is_none());
        }
        assert!(
            matches!(turn.row(result("success",false),&sink).await.unwrap(),Some(Outcome::Completed{message_id:Some(id)}) if id=="answer")
        );
    }
    #[tokio::test]
    async fn original_spool_preserves_buffered_rows_and_rewinds_same_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("stdout");
        std::fs::write(&path, b"{\"row\":1}\n{\"row\":2}\n").unwrap();
        let mut stream = spool(&path);
        assert_eq!(
            stream.next().await.unwrap(),
            Some(serde_json::json!({"row":1}))
        );
        assert_eq!(
            stream.next().await.unwrap(),
            Some(serde_json::json!({"row":2}))
        );
        assert!(stream.next().await.unwrap().is_none());
        stream.rewind().await.unwrap();
        assert_eq!(
            stream.next().await.unwrap(),
            Some(serde_json::json!({"row":1}))
        );
    }
    #[tokio::test]
    async fn missing_original_stream_and_unacknowledged_result_are_unknown() {
        let directory = tempfile::tempdir().unwrap();
        assert!(std::fs::File::open(directory.path().join("missing")).is_err());
        let sink = Collect::default();
        let mut turn = StreamTurn::new("session".into());
        turn.sent("input".into());
        turn.row(
            row(serde_json::json!({"type":"system","subtype":"init"})),
            &sink,
        )
        .await
        .unwrap();
        assert!(turn.row(result("success", false), &sink).await.is_err());
        assert!(sink.0.lock().unwrap().is_empty());
        let old = serde_json::json!({"runtime":"claude","session":"session","transcript":"job-writable.jsonl","offset":0,"prompt":"text","images":0});
        assert!(matches!(
            serde_json::from_value::<NativeTask>(old).unwrap(),
            NativeTask::Claude { .. }
        ));
    }
    #[tokio::test]
    async fn original_stream_rejects_partial_terminal_and_eof_is_not_a_result() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("stdout");
        std::fs::write(&path, b"{\"type\":\"result\",\"subtype\":\"success\"").unwrap();
        assert!(matches!(spool(&path).next().await, Err(Error::Unknown)));
        std::fs::write(&path, b"{}").unwrap();
        assert!(matches!(spool(&path).next().await, Err(Error::Unknown)));
        std::fs::write(&path, b"{}\n").unwrap();
        let mut stream = spool(&path);
        assert_eq!(stream.next().await.unwrap(), Some(serde_json::json!({})));
        assert!(stream.next().await.unwrap().is_none());
        let sink = Collect::default();
        let mut turn = turn(&sink).await;
        assert!(
            turn.row(
                assistant(
                    "answer",
                    "r",
                    serde_json::json!([{"type":"text","text":"partial"}])
                ),
                &sink
            )
            .await
            .unwrap()
            .is_none()
        );
        assert_eq!(turn.pending.len(), 1);
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .await
            .unwrap();
        file.write_all(b"{bad\n").await.unwrap();
        file.flush().await.unwrap();
        assert!(spool(&path).next().await.is_err());
    }
    #[tokio::test]
    async fn pinned_original_stream_ignores_path_rotation_and_rejects_malformed_original() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("stdout");
        std::fs::write(&path, b"{\"original\":true}\n").unwrap();
        let mut stream = spool(&path);
        std::fs::rename(&path, directory.path().join("old")).unwrap();
        std::fs::write(&path, b"forged\n").unwrap();
        assert_eq!(
            stream.next().await.unwrap(),
            Some(serde_json::json!({"original":true}))
        );
        stream.rewind().await.unwrap();
        assert_eq!(
            stream.next().await.unwrap(),
            Some(serde_json::json!({"original":true}))
        );
        assert!(spool(&path).next().await.is_err());
    }
}
