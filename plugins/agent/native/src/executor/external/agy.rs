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

use super::*;
use maka_agent_facts::{
    executor::{Output, ToolResultDetails, TurnUsage},
    model::ModelUsage,
};
#[cfg(unix)]
use runtime::task_interruptible_pipe as native_pipe;
#[cfg(not(unix))]
use runtime::task_pipe as native_pipe;
use runtime::{Pipe, string};

#[expect(
    clippy::too_many_arguments,
    reason = "one invocation owns native custody, protocol and Host tool settlement"
)]
pub(super) async fn execute(
    config: &NativeCommand,
    cwd: &str,
    request: &Value,
    journal: &mut journal::ProtocolSession,
    output: Arc<dyn OutputSink>,
    bridge: Arc<mcp::Bridge>,
    cancellation: CancellationToken,
    _steering: &mut steering::Steering,
    owner: maka_process::isolated::TaskOwner,
) -> Result<Outcome, Error> {
    let mut submitted = false;
    let result = prepare(
        config,
        cwd,
        request,
        journal,
        output.as_ref(),
        &bridge,
        cancellation,
        &mut submitted,
        owner,
    )
    .await;
    let result = if submitted
        && matches!(
            result,
            Err(Error::Provider(_) | Error::Invalid(_) | Error::Cancelled)
        ) {
        Err(Error::Unknown)
    } else {
        result
    };
    bridge.close_admission();
    if matches!(
        result,
        Err(Error::CleanupUnconfirmed | Error::ObservationRetired | Error::Persistence(_))
    ) {
        return result;
    }
    if !submitted && let Err(error) = &result {
        match error {
            Error::Unknown
            | Error::ObservationRetired
            | Error::CleanupUnconfirmed
            | Error::Persistence(_)
            | Error::IsolationUnavailable(_) => return result,
            _ => {}
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
    reason = "native resources have one physical settlement owner"
)]
async fn prepare(
    config: &NativeCommand,
    cwd: &str,
    request: &Value,
    journal: &mut journal::ProtocolSession,
    output: &dyn OutputSink,
    bridge: &Arc<mcp::Bridge>,
    cancellation: CancellationToken,
    submitted: &mut bool,
    owner: maka_process::isolated::TaskOwner,
) -> Result<Outcome, Error> {
    if cancellation.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let directory = bridge.directory();
    let plugin = directory.join(".agents/plugins/maka");
    #[cfg(target_os = "macos")]
    let hook_path = plugin.join("hooks.json");
    #[cfg(target_os = "macos")]
    let (owner, hook) = {
        let mut owner = owner;
        let tmp = owner.tmp();
        let executable = owner
            .record_step_annotations(&hook_path)
            .map_err(|error| Error::Provider(error.to_string()))?;
        let hook = super::super::agy_hook::configuration(executable, &tmp)
            .map_err(|error| Error::Provider(error.to_string()))?;
        (owner, hook)
    };
    tokio::fs::create_dir_all(&plugin)
        .await
        .map_err(|e| Error::Provider(e.to_string()))?;
    tokio::fs::write(plugin.join("plugin.json"), b"{\"name\":\"maka\"}")
        .await
        .map_err(|e| Error::Provider(e.to_string()))?;
    let mcp = serde_json::json!({"mcpServers":{"maka":{"url":bridge.url,"headers":{"Authorization":format!("Bearer {}",bridge.bearer())}}}});
    tokio::fs::write(
        plugin.join("mcp_config.next"),
        serde_json::to_vec(&mcp).expect("MCP config is JSON"),
    )
    .await
    .map_err(|e| Error::Provider(e.to_string()))?;
    tokio::fs::rename(
        plugin.join("mcp_config.next"),
        plugin.join("mcp_config.json"),
    )
    .await
    .map_err(|e| Error::Provider(e.to_string()))?;
    let settings = directory.join("settings.json");
    tokio::fs::write(&settings, b"{\"queuedMessages\":\"send-immediately\"}")
        .await
        .map_err(|e| Error::Provider(e.to_string()))?;
    let mut plan = runtime::command(config, cwd).await?;
    plan.arg("--print=")
        .arg("--input-format")
        .arg("stream-json")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--disable-slash-commands")
        .arg("--dangerously-skip-permissions")
        .arg("--add-dir")
        .arg(directory)
        .arg("--settings")
        .arg(&settings);
    let mut image_directories = std::collections::BTreeSet::new();
    for image in request
        .get("images")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let path = std::path::Path::new(string(image, "/path")?);
        let parent = path
            .parent()
            .ok_or_else(|| Error::Invalid("agy image path has no parent".into()))?;
        if image_directories.insert(parent) {
            plan.arg("--add-dir").arg(parent);
        }
    }
    if let Some(session) = journal.native_session() {
        plan.arg("--conversation").arg(session);
    }
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
    #[cfg(target_os = "macos")]
    tokio::fs::write(&hook_path, hook)
        .await
        .map_err(|error| Error::Provider(format!("Antigravity tool hook installation: {error}")))?;
    let host = bridge.clone();
    let result = native_pipe(
        owner,
        journal.observation(),
        plan,
        runtime::Transport::JsonLines,
        Some(bridge.clone()),
        cancellation,
        Protocol {
            request,
            journal,
            output,
            bridge: host,
            submitted,
        },
    )
    .await;
    #[cfg(target_os = "macos")]
    if !matches!(
        &result,
        Err(Error::ObservationRetired | Error::CleanupUnconfirmed)
    ) && let Err(error) = tokio::fs::remove_file(hook_path).await
        && error.kind() != std::io::ErrorKind::NotFound
    {
        tracing::error!(%error, "Antigravity private tool hook cleanup failed");
    }
    result
}

struct Protocol<'a> {
    request: &'a Value,
    journal: &'a mut journal::ProtocolSession,
    output: &'a dyn OutputSink,
    bridge: Arc<mcp::Bridge>,
    submitted: &'a mut bool,
}
impl runtime::PipeProtocol for Protocol<'_> {
    type Output = Outcome;
    fn run<'io>(self, io: &'io mut Pipe) -> BoxFuture<'io, Result<Outcome, Error>>
    where
        Self: 'io,
    {
        Box::pin(async move {
            converse(
                io,
                self.request,
                self.journal,
                self.output,
                &self.bridge,
                self.submitted,
            )
            .await
        })
    }
}

async fn converse(
    io: &mut Pipe,
    request: &Value,
    journal: &mut journal::ProtocolSession,
    output: &dyn OutputSink,
    bridge: &mcp::Bridge,
    submitted: &mut bool,
) -> Result<Outcome, Error> {
    let stop = io.stop.clone();
    let init = tokio::select! {
        biased;
        () = stop.cancelled() => return Err(Error::Cancelled),
        init = tokio::time::timeout(runtime::SETUP_TIMEOUT, io.next()) =>
            init.map_err(|_| Error::Provider("agy initialization timed out".into()))??,
    };
    if init.get("event").and_then(Value::as_str) != Some("init") {
        return Err(Error::Invalid(
            "agy did not emit its native init event".into(),
        ));
    }
    if init
        .pointer("/init/permission_mode")
        .and_then(Value::as_str)
        != Some("always-proceed")
    {
        return Err(Error::Invalid(
            "agy did not confirm always-proceed permission mode".into(),
        ));
    }
    let session = string(&init, "/conversation_id")?.to_owned();
    if let Some(model) = request
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| *model != "default")
        && init.pointer("/init/model").and_then(Value::as_str) != Some(model)
    {
        return Err(Error::Invalid(
            "agy did not select the requested model".into(),
        ));
    }
    journal.opened(session.clone())?;
    bridge.admit()?;
    let work = async {
        if stop.is_cancelled() {
            return Err(Error::Cancelled);
        }
        *submitted = true;
        let mut cursor = TurnCursor::default();
        let update =
            journal.instruction_update(request.get("instructions").and_then(Value::as_str));
        if !journal.bootstrap_completed() || update.is_some() {
            let bootstrap =
                runtime::bootstrap_message(update.as_ref().map(|update| update.text.as_str()));
            io.turn_started();
            io.send(user_message(&bootstrap)).await?;
            let bootstrap = observe(io, &session, &mut cursor, output, false, None).await?;
            io.turn_finished();
            if !matches!(bootstrap, Outcome::Completed { .. }) {
                return Ok(bootstrap);
            }
            if stop.is_cancelled() {
                return Err(Error::Cancelled);
            }
            if !bridge.listed.is_cancelled() {
                return Ok(Outcome::Failed {
                    message: "agy did not confirm the captured Host MCP tool catalog".into(),
                    code: Some("native_mcp_setup_failed".into()),
                    recoverable: false,
                });
            }
            journal.confirm_instructions(update).await?;
        }
        let prompt = user_message(&native_prompt(request)?);
        io.turn_started();
        io.send(prompt).await?;
        observe(io, &session, &mut cursor, output, true, Some(journal)).await
    };
    work.await
}

fn native_prompt(request: &Value) -> Result<String, Error> {
    let message = request
        .get("message")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Invalid("agy request has no user message".into()))?;
    let images = request
        .get("images")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    if images.is_empty() {
        return Ok(message.into());
    }
    let manifest = serde_json::to_string(images).expect("validated image paths are JSON");
    Ok(format!(
        "{message}\n\n<maka_image_attachments>\n{manifest}\n</maka_image_attachments>"
    ))
}

fn user_message(text: &str) -> Value {
    serde_json::json!({"event":"user","message":{"content":text}})
}

#[derive(Default)]
struct TurnCursor {
    highest_step: Option<u64>,
}
async fn observe(
    io: &mut Pipe,
    session: &str,
    cursor: &mut TurnCursor,
    output: &dyn OutputSink,
    show_text: bool,
    journal: Option<&journal::ProtocolSession>,
) -> Result<Outcome, Error> {
    let mut turn = NativeTurn::new(
        cursor.highest_step,
        show_text,
        cfg!(target_os = "macos"),
        true,
    );
    let deadline = tokio::time::Instant::now() + runtime::SETUP_TIMEOUT;
    loop {
        let event = if turn.user.is_none() {
            tokio::time::timeout_at(deadline, io.next())
                .await
                .map_err(|_| Error::Provider("agy user input admission timed out".into()))??
        } else {
            io.next().await?
        };
        if let Some(outcome) = turn.event(event, session, cursor, output, journal).await? {
            if let Some(journal) = journal {
                journal.closed(outcome.clone()).await?;
            }
            return Ok(outcome);
        }
    }
}
struct NativeTurn {
    previous_step: Option<u64>,
    user: Option<u64>,
    user_done: bool,
    tools: std::collections::BTreeSet<u64>,
    commands: std::collections::BTreeMap<u64, PendingCommand>,
    messages: AgentMessages,
    show_text: bool,
    step_annotations: bool,
    presentation: bool,
}
enum PendingCommand {
    Step(Value),
    Title(Option<String>),
}
impl NativeTurn {
    fn new(
        previous_step: Option<u64>,
        show_text: bool,
        step_annotations: bool,
        presentation: bool,
    ) -> Self {
        Self {
            previous_step,
            user: None,
            user_done: false,
            tools: Default::default(),
            commands: Default::default(),
            messages: Default::default(),
            show_text,
            step_annotations,
            presentation,
        }
    }
    async fn event(
        &mut self,
        event: Value,
        session: &str,
        cursor: &mut TurnCursor,
        output: &dyn OutputSink,
        journal: Option<&journal::ProtocolSession>,
    ) -> Result<Option<Outcome>, Error> {
        match event.get("event").and_then(Value::as_str) {
            Some("step_update") => {
                let step = &event["step_update"];
                if string(step, "/conversation_id")? != session {
                    return Err(Error::Invalid("agy step conversation mismatch".into()));
                }
                let index = step
                    .get("step_index")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| Error::Invalid("agy step has no index".into()))?;
                let kind = string(step, "/step_type")?;
                let state = string(step, "/state")?;
                if kind == "user_input" {
                    if self.previous_step.is_some_and(|previous| index <= previous)
                        || self.user.is_some_and(|user| user != index)
                    {
                        return Err(Error::Invalid(
                            "agy did not correlate the submitted user turn".into(),
                        ));
                    }
                    if self.user.is_none()
                        && let Some(journal) = journal
                    {
                        journal
                            .bind_task(NativeTask::Antigravity {
                                conversation: session.into(),
                                user_step: index,
                                step_annotations: self.step_annotations,
                            })
                            .await?;
                    }
                    self.user = Some(index);
                    self.user_done |= state == "DONE";
                } else if !self.user.is_some_and(|user| index > user) {
                    return Err(Error::Invalid(
                        "agy emitted activity before the submitted user input".into(),
                    ));
                }
                cursor.highest_step = Some(
                    cursor
                        .highest_step
                        .map_or(index, |previous| previous.max(index)),
                );
                if kind == "agent_response" {
                    self.messages
                        .step(step, index, state, output, self.show_text)
                        .await?;
                }
                if kind == "tool" {
                    let mut title = None;
                    if self.step_annotations && step["tool_name"] == "run_command" {
                        match self.commands.remove(&index) {
                            Some(PendingCommand::Title(observed)) => title = observed,
                            _ if !self.tools.contains(&index)
                                && !matches!(state, "DONE" | "ERROR") =>
                            {
                                self.commands
                                    .insert(index, PendingCommand::Step(step.clone()));
                                return Ok(None);
                            }
                            _ => {}
                        }
                    }
                    self.emit_tool(step, session, index, state, title, output)
                        .await?;
                }
                Ok(None)
            }
            Some("maka_step_annotation") if self.step_annotations => {
                let annotation = &event["annotation"];
                let index = annotation["step"].as_u64().ok_or(Error::Unknown)?;
                if annotation["session"] != session || !self.user.is_some_and(|user| index > user) {
                    tracing::warn!(
                        index,
                        "Antigravity tool annotation does not match the current turn"
                    );
                    return Ok(None);
                }
                let title = annotation["title"]
                    .as_str()
                    .and_then(maka_agent_facts::display::Text::single_line)
                    .map(|title| title.fallback);
                if let Some(PendingCommand::Step(step)) = self.commands.remove(&index) {
                    let state = string(&step, "/state")?;
                    self.emit_tool(&step, session, index, state, title, output)
                        .await?;
                } else if !self.tools.contains(&index) {
                    self.commands.insert(index, PendingCommand::Title(title));
                }
                Ok(None)
            }
            Some("result") => {
                let result = &event["result"];
                if string(result, "/conversation_id")? != session || !self.user_done {
                    return Err(Error::Invalid(
                        "agy terminal did not correlate to this user input".into(),
                    ));
                }
                for (index, command) in std::mem::take(&mut self.commands) {
                    if let PendingCommand::Step(step) = command {
                        let state = string(&step, "/state")?;
                        self.emit_tool(&step, session, index, state, None, output)
                            .await?;
                    }
                }
                let outcome = terminal(result, self.messages.final_message_id.clone())?;
                if matches!(outcome, Outcome::Completed { .. })
                    && self.messages.steps.values().any(|message| !message.ended)
                {
                    return Err(Error::Invalid(
                        "agy succeeded with an unfinished assistant message".into(),
                    ));
                }
                if self.presentation
                    && self.show_text
                    && let Some(usage) = result_usage(result)
                {
                    output.emit(Output::TurnUsage { usage }).await?;
                }
                Ok(Some(outcome))
            }
            _ => Err(Error::Invalid("Unsupported agy stream event".into())),
        }
    }
    async fn emit_tool(
        &mut self,
        step: &Value,
        session: &str,
        index: u64,
        state: &str,
        title: Option<String>,
        output: &dyn OutputSink,
    ) -> Result<(), Error> {
        let name = string(step, "/tool_name")?;
        // Only Maka's MCP calls already own canonical Host T1/T2.
        if name == "call_mcp_tool"
            && step
                .pointer("/tool_info/parameters/ServerName")
                .and_then(Value::as_str)
                == Some("maka_maka")
        {
            return Ok(());
        }
        let tool_call_id = format!("{session}:{index}");
        if self.tools.insert(index) {
            let mut input = step
                .pointer("/tool_info/parameters")
                .cloned()
                .unwrap_or(Value::Null);
            if let Some(title) = title
                && (input.is_object() || input.is_null())
            {
                input["toolSummary"] = title.into();
            }
            output
                .emit(Output::ToolStart {
                    tool_call_id: tool_call_id.clone(),
                    name: name.into(),
                    input,
                })
                .await?;
        }
        if matches!(state, "DONE" | "ERROR") {
            self.tools.remove(&index);
            let info = &step["tool_info"];
            let mut is_error =
                state == "ERROR" || info.get("error").is_some_and(|error| !error.is_null());
            let (text, details) = if self.presentation {
                let body = info["output"].as_str().unwrap_or_default();
                let (body, exit_code) = if name == "run_command" {
                    command_output(body)
                } else {
                    (body, None)
                };
                is_error |= exit_code.is_some_and(|code| code != 0);
                let duration_ms = milliseconds(&step["duration_seconds"]);
                let details =
                    (exit_code.is_some() || duration_ms.is_some()).then_some(ToolResultDetails {
                        exit_code,
                        duration_ms,
                    });
                let error = info["error"]["message"]
                    .as_str()
                    .or_else(|| info["error"].as_str());
                let text = match error {
                    Some(error) if body.is_empty() => error.to_owned(),
                    Some(error) => format!("{error}\n\n{body}"),
                    None => body.to_owned(),
                };
                (text.replace('\0', "\\0"), details)
            } else {
                (
                    serde_json::to_string(info).expect("native tool info is JSON"),
                    None,
                )
            };
            output
                .emit(Output::ToolResult {
                    tool_call_id,
                    text,
                    is_error,
                    details,
                })
                .await?;
        }
        Ok(())
    }
}
#[derive(Default)]
struct AgentMessages {
    steps: std::collections::BTreeMap<u64, AgentMessage>,
    final_message_id: Option<String>,
}
#[derive(Default)]
struct AgentMessage {
    ended: bool,
    has_body: bool,
}
impl AgentMessages {
    async fn step(
        &mut self,
        step: &Value,
        index: u64,
        state: &str,
        output: &dyn OutputSink,
        show_text: bool,
    ) -> Result<(), Error> {
        let id = index.to_string();
        match self.steps.entry(index) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(AgentMessage::default());
                if show_text {
                    output
                        .emit(Output::MessageStart {
                            message_id: id.clone(),
                        })
                        .await?;
                }
            }
            std::collections::btree_map::Entry::Occupied(entry) if entry.get().ended => {
                return Err(Error::Invalid(
                    "agy emitted an already completed assistant step".into(),
                ));
            }
            _ => {}
        }
        let message = self.steps.get_mut(&index).expect("started native step");
        if let Some(text) = step.get("text_delta").and_then(Value::as_str) {
            message.has_body |= !text.is_empty();
            if show_text {
                output
                    .emit(Output::OutputDelta {
                        message_id: id.clone(),
                        text: text.into(),
                    })
                    .await?;
            }
        }
        if state == "DONE" {
            if show_text {
                output
                    .emit(Output::MessageEnd {
                        message_id: id.clone(),
                    })
                    .await?;
            }
            message.ended = true;
            if message.has_body {
                self.final_message_id = Some(id);
            }
        }
        Ok(())
    }
}
fn terminal(result: &Value, message_id: Option<String>) -> Result<Outcome, Error> {
    let status = string(result, "/status").map_err(|_| Error::Unknown)?;
    let reason = match result.get("finished_reason") {
        None => None,
        Some(Value::String(reason))
            if matches!(reason.as_str(), "interrupted" | "error" | "print_timeout") =>
        {
            Some(reason.as_str())
        }
        _ => return Err(Error::Unknown),
    };
    match (status, reason) {
        ("SUCCESS", None) => {
            let text = result
                .get("response")
                .and_then(Value::as_str)
                .ok_or(Error::Unknown)?;
            if !text.is_empty() && message_id.is_none() {
                return Err(Error::Invalid(
                    "agy terminal response has no native assistant step identity".into(),
                ));
            }
            Ok(Outcome::Completed { message_id })
        }
        ("ERROR", Some("interrupted")) | ("CANCELED" | "INTERRUPTED", _) => {
            Ok(Outcome::Cancelled {
                reason: Some("native_interrupted".into()),
            })
        }
        ("SUCCESS" | "ERROR" | "INVALID", _) => Ok(Outcome::Failed {
            message: result
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("agy turn ended before normal completion")
                .into(),
            code: Some("native_turn_failed".into()),
            recoverable: false,
        }),
        // RUNNING and WAITING do not prove that native work has settled.
        _ => Err(Error::Unknown),
    }
}
fn milliseconds(value: &Value) -> Option<u64> {
    let seconds = value.as_f64()?;
    (seconds.is_finite() && seconds >= 0.0 && seconds * 1000.0 <= 9_007_199_254_740_991.0)
        .then(|| (seconds * 1000.0).round() as u64)
}

fn result_usage(result: &Value) -> Option<TurnUsage> {
    let usage = result.get("usage")?.as_object()?;
    let counter = |key| usage.get(key).and_then(Value::as_u64);
    Some(TurnUsage {
        tokens: ModelUsage {
            input_tokens: counter("input_tokens"),
            output_tokens: counter("output_tokens"),
            reasoning_tokens: counter("thinking_tokens"),
            cache_read_tokens: counter("cache_read_tokens"),
            cache_write_tokens: None,
        },
        total_tokens: counter("total_tokens"),
        duration_ms: milliseconds(&result["duration_seconds"]),
    })
}

fn command_output(raw: &str) -> (&str, Option<i32>) {
    let mut body = raw;
    for label in ["Created At: ", "Completed At: "] {
        if body.starts_with(label) {
            let Some((_, rest)) = body.split_once('\n') else {
                return (raw, None);
            };
            body = rest;
        }
    }
    let (status, rest) = body.split_once('\n').unwrap_or((body, ""));
    let code = status
        .strip_prefix("Command exited with code ")
        .and_then(|code| code.trim_end_matches('\r').strip_suffix('.'))
        .and_then(|code| code.parse::<i32>().ok());
    match (code, rest.trim_start_matches(['\r', '\n'])) {
        (Some(code), "") => ("", Some(code)),
        (Some(code), rest)
            if let Some(output) = rest
                .strip_prefix("Command output:\n")
                .or_else(|| rest.strip_prefix("Command output:\r\n")) =>
        {
            (output, Some(code))
        }
        _ => (raw, None),
    }
}

pub(super) async fn replay(
    request: &Request,
    binding: &NativeBinding,
    input: &mut replay::Stream,
    stream: &mut replay::Stream,
    output: &dyn OutputSink,
) -> Result<Outcome, Error> {
    let NativeTask::Antigravity {
        conversation,
        user_step,
        step_annotations,
    } = &binding.task
    else {
        return Err(Error::Unknown);
    };
    let instructions = request
        .instructions
        .as_deref()
        .map(|text| journal::instruction_text(Some(text)));
    let first = input.required().await?;
    let (bootstrap_input, actual_input) = match input.next().await? {
        Some(actual) => (Some(first), actual),
        None => (None, first),
    };
    if let Some(bootstrap_input) = &bootstrap_input {
        let instruction = runtime::bootstrap_message(instructions.as_deref());
        let setup_only = runtime::bootstrap_message(None);
        let clear = runtime::bootstrap_message(Some(&journal::instruction_text(None)));
        if ![instruction, setup_only, clear]
            .iter()
            .any(|message| *bootstrap_input == user_message(message))
        {
            return Err(Error::Unknown);
        }
    }
    if actual_input["event"] != "user"
        || actual_input
            .pointer("/message/content")
            .and_then(Value::as_str)
            .is_none()
        || input.next().await?.is_some()
    {
        return Err(Error::Unknown);
    }
    let init = stream.required().await?;
    if init["event"] != "init"
        || init["conversation_id"] != *conversation
        || init["init"]["permission_mode"] != "always-proceed"
    {
        return Err(Error::Unknown);
    }
    if let Some(model) = request
        .settings
        .model
        .as_deref()
        .filter(|model| *model != "default")
        && init.pointer("/init/model").and_then(Value::as_str) != Some(model)
    {
        return Err(Error::Unknown);
    }
    let mut cursor = TurnCursor::default();
    if bootstrap_input.is_some() {
        let mut bootstrap = NativeTurn::new(
            None,
            false,
            *step_annotations,
            binding.adapter_version >= PRESENTATION_VERSION,
        );
        loop {
            let event = stream.required().await?;
            if let Some(outcome) = bootstrap
                .event(event, conversation, &mut cursor, output, None)
                .await?
            {
                if !matches!(outcome, Outcome::Completed { .. }) {
                    return Err(Error::Unknown);
                }
                break;
            }
        }
        if cursor
            .highest_step
            .is_some_and(|previous| previous >= *user_step)
        {
            return Err(Error::Unknown);
        }
    }
    let mut turn = NativeTurn::new(
        cursor.highest_step,
        true,
        *step_annotations,
        binding.adapter_version >= PRESENTATION_VERSION,
    );
    let outcome = loop {
        let event = stream.required().await?;
        if event["event"] == "step_update"
            && event["step_update"]["step_type"] == "user_input"
            && event["step_update"]["step_index"].as_u64() != Some(*user_step)
        {
            return Err(Error::Unknown);
        }
        if let Some(outcome) = turn
            .event(event, conversation, &mut cursor, output, None)
            .await?
        {
            break outcome;
        }
    };
    if turn.user != Some(*user_step) || stream.next().await?.is_some() {
        return Err(Error::Unknown);
    }
    Ok(outcome)
}

pub(super) async fn models(
    config: &runtime::ResolvedCommand<'_>,
    cwd: &str,
    cancellation: CancellationToken,
) -> Result<Value, Error> {
    let stdout = read_command(config, cwd, &["models"], cancellation).await?;
    let models = tokio::task::spawn_blocking(move || parse_models(&stdout))
        .await
        .map_err(|_| Error::Provider("agy model parser task failed".into()))??;
    Ok(serde_json::json!({
        "installation":{"kind":"available"},
        "authentication":{"kind":"unknown","source":"agy models"},
        "models":{"kind":"ok","models":models}
    }))
}

pub(super) async fn usage_limits(
    config: &runtime::ResolvedCommand<'_>,
    cwd: &str,
    cancellation: CancellationToken,
) -> Result<Value, Error> {
    let stdout = read_command(
        config,
        cwd,
        &["-p", "/usage", "--output-format", "stream-json"],
        cancellation,
    )
    .await?;
    tokio::task::spawn_blocking(move || parse_usage(&stdout))
        .await
        .map_err(|_| Error::Provider("agy usage parser task failed".into()))?
}

fn parse_usage(stdout: &[u8]) -> Result<Value, Error> {
    use maka_agent_api::external::ExternalUsageLimits;
    use maka_agent_ports::provider::{UsageLimit, UsagePeriod};

    #[derive(Deserialize)]
    struct ResultEnvelope {
        status: String,
        num_turns: u64,
        command: UsageCommand,
    }
    #[derive(Deserialize)]
    struct UsageCommand {
        name: String,
        data: Groups,
    }
    #[derive(Deserialize)]
    struct Groups {
        groups: Vec<Group>,
    }
    #[derive(Deserialize)]
    struct Group {
        name: String,
        buckets: Vec<Bucket>,
    }
    #[derive(Deserialize)]
    struct Bucket {
        window: Window,
        remaining_fraction: f64,
        reset_time: Option<String>,
        #[serde(default)]
        disabled: bool,
    }
    #[derive(Deserialize)]
    enum Window {
        #[serde(rename = "weekly")]
        Weekly,
        #[serde(rename = "5h")]
        FiveHours,
    }
    let invalid = || Error::Invalid("agy returned invalid usage limits".into());
    let output = std::str::from_utf8(stdout).map_err(|_| invalid())?;
    let mut result = None;
    for line in output.lines() {
        let mut event: Value = serde_json::from_str(line).map_err(|_| invalid())?;
        if event["event"] == "result" {
            if result.is_some() {
                return Err(invalid());
            }
            result = Some(
                serde_json::from_value::<ResultEnvelope>(event["result"].take())
                    .map_err(|_| invalid())?,
            );
        }
    }
    let result = result.ok_or_else(invalid)?;
    if result.status != "SUCCESS" || result.num_turns != 0 || result.command.name != "usage" {
        return Err(invalid());
    }
    let mut limits = Vec::new();
    for group in result.command.data.groups {
        let label = group.name.trim();
        if label.is_empty() || label.chars().any(char::is_control) {
            return Err(invalid());
        }
        for bucket in group.buckets {
            let period = UsagePeriod::Duration {
                seconds: match bucket.window {
                    Window::Weekly => 7 * 24 * 3600,
                    Window::FiveHours => 5 * 3600,
                },
            };
            if bucket.disabled {
                limits.push(UsageLimit::Disabled {
                    label: label.into(),
                    period,
                });
            } else {
                if !(0.0..=1.0).contains(&bucket.remaining_fraction) {
                    return Err(invalid());
                }
                let resets_at = bucket
                    .reset_time
                    .map(|reset| {
                        let timestamp: jiff::Timestamp = reset.parse().map_err(|_| invalid())?;
                        u64::try_from(timestamp.as_second()).map_err(|_| invalid())
                    })
                    .transpose()?;
                limits.push(UsageLimit::Window {
                    label: Some(label.into()),
                    period: Some(period),
                    resets_at,
                    used_percent: (1.0 - bucket.remaining_fraction) * 100.0,
                    quantity: None,
                });
            }
        }
    }
    serde_json::to_value(ExternalUsageLimits::Ready { limits }).map_err(|_| invalid())
}

async fn read_command(
    config: &runtime::ResolvedCommand<'_>,
    cwd: &str,
    args: &[&str],
    cancellation: CancellationToken,
) -> Result<Vec<u8>, Error> {
    use tokio::io::AsyncWriteExt;
    if cancellation.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let mut command = config.command(cwd);
    command.args(args);
    let mut process = maka_process::pipe::spawn(command)
        .await
        .map_err(runtime::process_error)?;
    let observed = async {
        process
            .stdin
            .shutdown()
            .await
            .map_err(|_| Error::Provider("Could not close agy query input".into()))?;
        let status = async {
            process
                .child
                .wait()
                .await
                .map_err(|_| Error::CleanupUnconfirmed)
        };
        tokio::try_join!(
            status,
            query_output(&mut process.stdout, true),
            query_output(&mut process.stderr, false),
        )
    };
    let observed = tokio::select! {
        biased;
        () = cancellation.cancelled() => Err(Error::Cancelled),
        result = tokio::time::timeout(runtime::SETUP_TIMEOUT, observed) => {
            result.unwrap_or_else(|_| Err(Error::Provider("agy query timed out".into())))
        }
    };
    let (status, stdout, _) = match observed {
        Ok(value) => value,
        Err(error) => {
            process
                .child
                .terminate()
                .await
                .map_err(|_| Error::CleanupUnconfirmed)?;
            tokio::time::timeout(std::time::Duration::from_secs(4), process.child.wait())
                .await
                .map_err(|_| Error::CleanupUnconfirmed)?
                .map_err(|_| Error::CleanupUnconfirmed)?;
            let drain = async {
                let mut stdout_sink = tokio::io::sink();
                let mut stderr_sink = tokio::io::sink();
                tokio::try_join!(
                    tokio::io::copy(&mut process.stdout, &mut stdout_sink),
                    tokio::io::copy(&mut process.stderr, &mut stderr_sink),
                )
            };
            tokio::time::timeout(std::time::Duration::from_secs(1), drain)
                .await
                .map_err(|_| Error::CleanupUnconfirmed)?
                .map_err(|_| Error::CleanupUnconfirmed)?;
            return Err(error);
        }
    };
    if !status.success() {
        // Native diagnostics may contain account information; they are never surfaced.
        return Err(Error::Provider("agy query failed".into()));
    }
    Ok(stdout)
}

async fn query_output(
    reader: &mut (impl tokio::io::AsyncRead + Unpin),
    retain: bool,
) -> Result<Vec<u8>, Error> {
    use tokio::io::AsyncReadExt;
    let mut result = Vec::new();
    let mut buffer = [0; 8192];
    let mut observed = 0usize;
    loop {
        let count = reader
            .read(&mut buffer)
            .await
            .map_err(|_| Error::Provider("Could not read agy query output".into()))?;
        if count == 0 {
            return Ok(result);
        }
        observed += count;
        if observed > runtime::MAX_MESSAGE_BYTES {
            return Err(Error::Invalid(
                "agy query output exceeds the 256 MiB observation budget".into(),
            ));
        }
        if retain {
            result.extend_from_slice(&buffer[..count]);
        }
    }
}

fn parse_models(bytes: &[u8]) -> Result<Vec<Value>, Error> {
    let catalog = std::str::from_utf8(bytes)
        .map_err(|_| Error::Invalid("agy models returned non-UTF-8 output".into()))?;
    let mut models = Vec::new();
    let mut ids = std::collections::BTreeSet::new();
    for row in catalog.lines() {
        let (id, name) = row
            .split_once('\t')
            .filter(|(id, name)| !id.is_empty() && !name.is_empty() && !name.contains('\t'))
            .ok_or_else(|| Error::Invalid("agy models returned a malformed TSV row".into()))?;
        if !ids.insert(id) {
            return Err(Error::Invalid("agy models returned duplicate IDs".into()));
        }
        models.push(serde_json::json!({"id":id,"displayName":name}));
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn headless_usage_keeps_account_groups_and_disabled_windows() {
        let output = br#"{"event":"command_result","command":{"name":"usage"}}
{"event":"result","result":{"status":"SUCCESS","num_turns":0,"command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"window":"weekly","remaining_fraction":0,"reset_time":"2026-11-12T00:00:00Z"},{"window":"5h","remaining_fraction":0,"disabled":true}]},{"name":"Claude and GPT models","buckets":[{"window":"5h","remaining_fraction":0.75}]}]}}}}
"#;
        assert_eq!(
            parse_usage(output).unwrap(),
            json!({"kind":"ready","limits":[
                {"kind":"window","label":"Gemini Models","period":{"kind":"duration","seconds":604800},"usedPercent":100.0,"resetsAt":1794441600u64},
                {"kind":"disabled","label":"Gemini Models","period":{"kind":"duration","seconds":18000}},
                {"kind":"window","label":"Claude and GPT models","period":{"kind":"duration","seconds":18000},"usedPercent":25.0}
            ]})
        );
    }

    #[derive(Default)]
    struct Sink(std::sync::Mutex<Vec<Output>>);
    impl OutputSink for Sink {
        fn emit(&self, output: Output) -> BoxFuture<'_, Result<(), Error>> {
            Box::pin(async move {
                self.0.lock().unwrap().push(output);
                Ok(())
            })
        }
    }

    #[tokio::test]
    async fn command_titles_follow_their_original_steps_in_either_arrival_order() {
        let output = Sink::default();
        let mut cursor = TurnCursor::default();
        let mut turn = NativeTurn::new(None, true, true, true);
        let update = |step: Value| json!({"event":"step_update","step_update":step});
        let command = |index, state, command| {
            update(json!({
                "conversation_id":"session","step_index":index,"step_type":"tool","state":state,
                "tool_name":"run_command","tool_info":{"parameters":{"CommandLine":command}},
            }))
        };
        let annotation = |step, title| {
            json!({
                "event":"maka_step_annotation","annotation":{"session":"session","step":step,"title":title},
            })
        };
        for event in [
            update(
                json!({"conversation_id":"session","step_index":0,"step_type":"user_input","state":"DONE"}),
            ),
            command(1, "ACTIVE", "printf first"),
            annotation(2, "Second command"),
            command(2, "ACTIVE", "printf second"),
            annotation(1, "First command"),
            command(3, "ERROR", "printf denied"),
        ] {
            assert!(
                turn.event(event, "session", &mut cursor, &output, None)
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        let events = output.0.lock().unwrap();
        let starts: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                Output::ToolStart {
                    tool_call_id,
                    input,
                    ..
                } => Some((
                    tool_call_id.as_str(),
                    input["CommandLine"].as_str().unwrap(),
                    input["toolSummary"].as_str(),
                )),
                _ => None,
            })
            .collect();
        assert_eq!(
            starts,
            [
                ("session:2", "printf second", Some("Second command")),
                ("session:1", "printf first", Some("First command")),
                ("session:3", "printf denied", None),
            ]
        );
    }
}
