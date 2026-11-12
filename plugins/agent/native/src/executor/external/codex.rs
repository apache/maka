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
use runtime::{Pipe, RpcError, string};

pub(super) async fn proxy_resolved(
    config: &runtime::ResolvedCommand<'_>,
    cwd: &str,
    cancellation: CancellationToken,
) -> Result<maka_process::Command, Error> {
    let mut start = config.command(cwd);
    start.args(["app-server", "daemon", "start"]);
    let mut observed = start
        .observe(
            Some(runtime::SETUP_TIMEOUT.as_secs() * 1000),
            cancellation.clone(),
        )
        .map_err(runtime::process_error)?;
    let drain = async { while observed.events.recv().await.is_some() {} };
    let (captured, ()) = tokio::join!(observed.completion, drain);
    let captured = captured.map_err(runtime::process_error)?;
    match captured.outcome {
        maka_process::ProcessOutcome::Exited(status) if status.success() => {}
        maka_process::ProcessOutcome::Interrupted {
            reason: maka_process::Termination::Cancelled,
            ..
        } => return Err(Error::Cancelled),
        _ => {
            return Err(Error::Provider(
                "Codex managed daemon start failed; a CLI with daemon/proxy support is required"
                    .into(),
            ));
        }
    }
    if cancellation.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let mut proxy = config.command(cwd);
    proxy.args(["app-server", "proxy"]);
    Ok(proxy)
}

pub(super) struct Protocol<'a> {
    pub(super) request: &'a Value,
    pub(super) journal: &'a mut journal::ProtocolSession,
    pub(super) output: Arc<dyn OutputSink>,
    pub(super) bridge: Arc<mcp::Bridge>,
    pub(super) steering: &'a mut steering::Steering,
}
impl runtime::PipeProtocol for Protocol<'_> {
    type Output = Outcome;
    fn run<'io>(self, io: &'io mut Pipe) -> BoxFuture<'io, Result<Outcome, Error>>
    where
        Self: 'io,
    {
        Box::pin(async move {
            execute(
                io,
                self.request,
                self.journal,
                self.output,
                self.bridge,
                self.steering,
            )
            .await
        })
    }
}

pub(super) async fn execute(
    io: &mut Pipe,
    request: &Value,
    journal: &mut journal::ProtocolSession,
    output: Arc<dyn OutputSink>,
    bridge: Arc<mcp::Bridge>,
    steering: &mut steering::Steering,
) -> Result<Outcome, Error> {
    let mut custody = Custody::Preparing;
    let result = run(
        io,
        request,
        journal,
        output.as_ref(),
        &bridge,
        &mut custody,
        steering,
    )
    .await;
    // Once turn/start may have reached the app-server, a transport/protocol failure
    // is not a native failed outcome, even if app-server cleanup later succeeds.
    let result = if !matches!(custody, Custody::Preparing)
        && matches!(result, Err(Error::Provider(_) | Error::Invalid(_)))
    {
        Err(Error::Unknown)
    } else {
        result
    };
    bridge.close_admission();
    if io.retired.is_cancelled() {
        let result = match result {
            Err(error @ Error::Persistence(_)) => Err(error),
            _ => Err(Error::ObservationRetired),
        };
        return result;
    }
    match custody {
        Custody::Active(mut state) => {
            io.cancellation = CancellationToken::new();
            io.failed = CancellationToken::new();
            if !io
                .buffered()
                .any(|event| terminal(event, &state.thread, &state.turn))
            {
                io.control(
                    "turn/interrupt",
                    serde_json::json!({"threadId":state.thread,"turnId":state.turn}),
                )
                .await;
            }
            // Only wire reads are cancellable. A terminal record's acknowledgement
            // is awaited after the timeout scope and cannot be dropped on retirement.
            let deadline = tokio::time::Instant::now() + runtime::INTERRUPT_TIMEOUT;
            loop {
                let event = match tokio::time::timeout_at(deadline, io.next()).await {
                    Ok(Ok(event)) => event,
                    _ => {
                        break Err(if io.retired.is_cancelled() {
                            Error::ObservationRetired
                        } else {
                            Error::CleanupUnconfirmed
                        });
                    }
                };
                match state.event(event, output.as_ref()).await {
                    Ok(Some(outcome)) => {
                        break journal.closed(outcome.clone()).await.map(|()| outcome);
                    }
                    Ok(None) => {}
                    Err(Error::Invalid(_) | Error::Provider(_)) => break Err(Error::Unknown),
                    Err(error) => break Err(error),
                }
            }
        }
        Custody::Submitted => Err(Error::Unknown),
        Custody::Preparing | Custody::Settled => result,
    }
}
enum Custody {
    Preparing,
    Submitted,
    Active(Turn),
    Settled,
}
async fn run(
    io: &mut Pipe,
    request: &Value,
    journal: &mut journal::ProtocolSession,
    output: &dyn OutputSink,
    bridge: &mcp::Bridge,
    custody: &mut Custody,
    steering: &mut steering::Steering,
) -> Result<Outcome, Error> {
    io.request("initialize", serde_json::json!({"clientInfo":{"name":"maka","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}})).await?;
    io.notify("initialized", serde_json::json!({})).await?;
    let resume = journal.native_session();
    let fresh_thread = resume.is_none();
    let mut params = serde_json::json!({"cwd":request["cwd"],"approvalPolicy":"never","sandbox":"danger-full-access","config":{"mcp_servers":{"maka":{"url":bridge.url,"http_headers":{"Authorization":format!("Bearer {}",bridge.bearer())},"enabled":true}}}});
    if let Some(model) = request.get("model") {
        params["model"] = model.clone();
    }
    if let Some(resume) = resume {
        params["threadId"] = resume.into();
        params["excludeTurns"] = true.into();
    }
    let opened = io
        .request(
            if resume.is_some() {
                "thread/resume"
            } else {
                "thread/start"
            },
            params,
        )
        .await?;
    let thread = string(&opened, "/thread/id")?.to_owned();
    if opened.get("approvalPolicy").and_then(Value::as_str) != Some("never")
        || opened.pointer("/sandbox/type").and_then(Value::as_str) != Some("dangerFullAccess")
    {
        return Err(Error::Invalid(
            "Codex did not confirm never approval and danger-full-access".into(),
        ));
    }
    if let Some(model) = request.get("model")
        && opened.get("model") != Some(model)
    {
        return Err(Error::Invalid(
            "Codex did not confirm requested model".into(),
        ));
    }
    journal.opened(thread.clone())?;
    if let Some(update) =
        journal.instruction_update(request.get("instructions").and_then(Value::as_str))
    {
        let injected = io
            .request(
                "thread/inject_items",
                serde_json::json!({
                    "threadId":thread,
                    "items":[{"type":"message","role":"user","content":[{
                        "type":"input_text","text":runtime::instruction_message(&update.text)
                    }]}]
                }),
            )
            .await?;
        if !injected.is_object() {
            return Err(Error::Invalid(
                "Codex instruction-message injection has no acknowledgement".into(),
            ));
        }
        journal.confirm_instructions(update).await?;
    }
    bridge.admit()?;
    let mut input = vec![serde_json::json!({"type":"text","text":request["message"]})];
    for image in request
        .get("images")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        input.push(serde_json::json!({"type":"localImage","path":image["path"]}));
    }
    let mut params = serde_json::json!({"threadId":thread,"input":input,"approvalPolicy":"never","sandboxPolicy":{"type":"dangerFullAccess"}});
    if let Some(effort) = request.get("effort") {
        params["effort"] = effort.clone();
    }
    if io.cancellation.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let cancellation = std::mem::replace(&mut io.cancellation, CancellationToken::new());
    let failed = std::mem::replace(&mut io.failed, CancellationToken::new());
    *custody = Custody::Submitted;
    io.turn_started();
    let started = match io.request("turn/start", params).await {
        Ok(started) => started,
        Err(RpcError::Rejected(message)) => {
            io.turn_finished();
            return Err(Error::Provider(message));
        }
        Err(error) => return Err(error.into()),
    };
    let turn = string(&started, "/turn/id")?.to_owned();
    *custody = Custody::Active(Turn {
        thread: thread.clone(),
        turn: turn.clone(),
        messages: Default::default(),
        final_message_id: None,
        presentation: true,
        fresh_thread,
        usage_baseline: None,
        usage: None,
    });
    journal
        .bind_task(NativeTask::Codex {
            thread: thread.clone(),
            turn: turn.clone(),
        })
        .await?;
    let Custody::Active(state) = custody else {
        unreachable!("submitted native turn")
    };
    let retired = io.retired.clone();
    let mut stop_deadline = None;
    loop {
        let event = {
            tokio::select! {
                () = retired.cancelled() => return Err(Error::ObservationRetired),
                () = cancellation.cancelled(), if stop_deadline.is_none() => {
                    bridge.close_admission();
                    io.control("turn/interrupt", serde_json::json!({"threadId":state.thread,"turnId":state.turn})).await;
                    stop_deadline = Some(tokio::time::Instant::now() + runtime::INTERRUPT_TIMEOUT);
                    continue;
                }
                () = async { match stop_deadline { Some(at) => tokio::time::sleep_until(at).await, None => std::future::pending().await } } => return Err(Error::CleanupUnconfirmed),
                () = failed.cancelled() => return Err(Error::Unknown),
                event = io.next() => event?,
                ready = steering.ready(), if stop_deadline.is_none() => {
                    ready?;
                    let next = match steering.take().await {
                        Err(Error::Cancelled) => {
                            journal.observation().control_allowed(&io.stop).await?;
                            None
                        }
                        result => result?,
                    };
                    if let Some(input) = next {
                        let mut content = vec![serde_json::json!({"type":"text","text":input["message"]})];
                        for image in input["images"].as_array().into_iter().flatten() {
                            content.push(serde_json::json!({"type":"localImage","path":image["path"]}));
                        }
                        let params = serde_json::json!({
                            "threadId":state.thread, "expectedTurnId":state.turn, "input":content
                        });
                        let accepted = tokio::select! {
                            biased;
                            () = cancellation.cancelled() => return Err(Error::Cancelled),
                            () = failed.cancelled() => return Err(Error::Unknown),
                            result = io.request("turn/steer", params) => result,
                        };
                        let accepted = match accepted {
                            Ok(accepted) => accepted,
                            Err(runtime::RpcError::Rejected(message)) => {
                                while let Some(event) = io.pop_buffered() {
                                    if let Some(outcome) = state.event(event, output).await? {
                                        *custody = Custody::Settled;
                                        journal.closed(outcome.clone()).await?;
                                        return Ok(outcome);
                                    }
                                }
                                tracing::warn!(%message, "Codex steering rejected; settling the original active turn");
                                return Err(Error::Provider(message));
                            }
                            Err(error) => return Err(error.into()),
                        };
                        if accepted.get("turnId").and_then(Value::as_str) != Some(state.turn.as_str()) {
                            return Err(Error::Invalid("Codex steering acknowledged a different turn".into()));
                        }
                    }
                    continue;
                }
            }
        };
        if event.get("method").is_some() && event.get("id").is_some() {
            return io.unsupported(event).await;
        }
        if let Some(outcome) = state.event(event, output).await? {
            *custody = Custody::Settled;
            journal.closed(outcome.clone()).await?;
            return Ok(outcome);
        }
    }
}

fn terminal(event: &Value, thread: &str, turn: &str) -> bool {
    event["method"] == "turn/completed"
        && event["params"]["threadId"] == thread
        && event["params"]["turn"]["id"] == turn
        && matches!(
            event["params"]["turn"]["status"].as_str(),
            Some("completed" | "failed" | "interrupted")
        )
}
struct Turn {
    thread: String,
    turn: String,
    messages: std::collections::BTreeMap<String, Message>,
    final_message_id: Option<String>,
    presentation: bool,
    fresh_thread: bool,
    usage_baseline: Option<Value>,
    usage: Option<TurnUsage>,
}
#[derive(Default)]
struct Message {
    text: String,
    summary: std::collections::BTreeMap<u64, String>,
    reasoning: std::collections::BTreeMap<u64, String>,
    active_thinking: Option<(bool, u64)>,
    ended: bool,
}
impl Turn {
    async fn start_message(&mut self, id: &str, output: &dyn OutputSink) -> Result<(), Error> {
        match self.messages.entry(id.into()) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(Message::default());
                output
                    .emit(Output::MessageStart {
                        message_id: id.into(),
                    })
                    .await?;
            }
            std::collections::btree_map::Entry::Occupied(entry) if entry.get().ended => {
                return Err(Error::Invalid(
                    "Codex emitted activity after message completion".into(),
                ));
            }
            _ => {}
        }
        Ok(())
    }
    async fn event(
        &mut self,
        event: Value,
        output: &dyn OutputSink,
    ) -> Result<Option<Outcome>, Error> {
        let method = event
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let p = &event["params"];
        if p.get("threadId").and_then(Value::as_str) != Some(self.thread.as_str()) {
            return Ok(None);
        }
        let turn = p
            .get("turnId")
            .or_else(|| p.pointer("/turn/id"))
            .and_then(Value::as_str);
        if turn != Some(self.turn.as_str()) {
            // Resume emits the previous turn's cumulative usage before the new
            // turn starts. Retain it to report this turn's difference.
            if self.presentation
                && !self.fresh_thread
                && self.usage.is_none()
                && method == "thread/tokenUsage/updated"
                && let Some(total) = p
                    .pointer("/tokenUsage/total")
                    .filter(|total| total.is_object())
            {
                self.usage_baseline = Some(total.clone());
            }
            return Ok(None);
        }
        match method {
            "item/agentMessage/delta"
            | "item/reasoning/summaryTextDelta"
            | "item/reasoning/textDelta" => {
                let id = string(p, "/itemId")?;
                self.start_message(id, output).await?;
                let text = string(p, "/delta")?;
                let message = self.messages.get_mut(id).expect("started native message");
                let delta = if method == "item/agentMessage/delta" {
                    message.text.push_str(text);
                    if text.is_empty() {
                        return Ok(None);
                    }
                    Output::OutputDelta {
                        message_id: id.into(),
                        text: text.into(),
                    }
                } else {
                    let (field, is_content, parts) = if method == "item/reasoning/summaryTextDelta"
                    {
                        ("summaryIndex", false, &mut message.summary)
                    } else {
                        ("contentIndex", true, &mut message.reasoning)
                    };
                    let index = p.get(field).and_then(Value::as_u64).ok_or_else(|| {
                        Error::Invalid("Codex reasoning delta has no nonnegative part index".into())
                    })?;
                    parts.entry(index).or_default().push_str(text);
                    if text.is_empty() {
                        return Ok(None);
                    }
                    let key = (is_content, index);
                    let emitted = if message.active_thinking.is_some_and(|active| active != key) {
                        format!("\n\n{text}")
                    } else {
                        text.into()
                    };
                    message.active_thinking = Some(key);
                    Output::ThinkingDelta {
                        message_id: id.into(),
                        text: emitted,
                    }
                };
                output.emit(delta).await?;
            }
            "item/started" | "item/completed" => {
                let item = &p["item"];
                let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
                let id = string(item, "/id")?.to_owned();
                if matches!(kind, "agentMessage" | "reasoning") {
                    self.start_message(&id, output).await?;
                    if method == "item/completed" {
                        if kind == "agentMessage" {
                            let text = string(item, "/text")?;
                            let message =
                                self.messages.get_mut(&id).expect("started native message");
                            let suffix = text.strip_prefix(&message.text).ok_or_else(|| {
                                Error::Invalid(
                                    "Codex completed message differs from its streamed text".into(),
                                )
                            })?;
                            if !suffix.is_empty() {
                                output
                                    .emit(Output::OutputDelta {
                                        message_id: id.clone(),
                                        text: suffix.into(),
                                    })
                                    .await?;
                            }
                        }
                        if kind == "reasoning" {
                            let message =
                                self.messages.get_mut(&id).expect("started native message");
                            let mut suffixes = Vec::new();
                            for (field, is_content, streamed) in [
                                ("summary", false, &mut message.summary),
                                ("content", true, &mut message.reasoning),
                            ] {
                                let parts = match item.get(field) {
                                    None => &[][..],
                                    Some(parts) => {
                                        parts.as_array().map(Vec::as_slice).ok_or_else(|| {
                                            Error::Invalid(
                                                "Codex reasoning snapshot parts must be arrays"
                                                    .into(),
                                            )
                                        })?
                                    }
                                };
                                for (index, part) in parts.iter().enumerate() {
                                    let text = part.as_str().ok_or_else(|| {
                                        Error::Invalid(
                                            "Codex reasoning snapshot part is not text".into(),
                                        )
                                    })?;
                                    let key = (is_content, index as u64);
                                    let prefix = streamed.remove(&key.1).unwrap_or_default();
                                    let suffix = text.strip_prefix(&prefix).ok_or_else(|| {
                                        Error::Invalid(
                                            "Codex reasoning snapshot differs from its streamed part"
                                                .into(),
                                        )
                                    })?;
                                    if !suffix.is_empty() {
                                        suffixes.push((key, suffix.to_owned()));
                                    }
                                }
                                if !streamed.is_empty() {
                                    return Err(Error::Invalid(
                                        "Codex reasoning snapshot omitted streamed parts".into(),
                                    ));
                                }
                            }
                            if let Some(active) = message.active_thinking
                                && let Some(pos) = suffixes.iter().position(|(k, _)| *k == active)
                            {
                                let (_, suffix) = suffixes.remove(pos);
                                output
                                    .emit(Output::ThinkingDelta {
                                        message_id: id.clone(),
                                        text: suffix,
                                    })
                                    .await?;
                            }
                            for (key, suffix) in suffixes {
                                let emitted = if message.active_thinking.is_some() {
                                    format!("\n\n{suffix}")
                                } else {
                                    suffix
                                };
                                message.active_thinking = Some(key);
                                output
                                    .emit(Output::ThinkingDelta {
                                        message_id: id.clone(),
                                        text: emitted,
                                    })
                                    .await?;
                            }
                        }
                        output
                            .emit(Output::MessageEnd {
                                message_id: id.clone(),
                            })
                            .await?;
                        let message = self.messages.get_mut(&id).expect("started native message");
                        *message = Message {
                            ended: true,
                            ..Message::default()
                        };
                        if kind == "agentMessage"
                            && item["text"].as_str().is_some_and(|text| !text.is_empty())
                        {
                            self.final_message_id = Some(id);
                        }
                    }
                } else if matches!(
                    kind,
                    "commandExecution"
                        | "fileChange"
                        | "webSearch"
                        | "imageView"
                        | "collabAgentToolCall"
                ) {
                    let tool_call_id = format!("{}:{}:{id}", self.thread, self.turn);
                    if method == "item/started" {
                        output
                            .emit(Output::ToolStart {
                                tool_call_id,
                                name: kind.into(),
                                input: item.clone(),
                            })
                            .await?;
                    } else {
                        let status = item["status"].as_str();
                        let exit_code = item["exitCode"]
                            .as_i64()
                            .and_then(|code| i32::try_from(code).ok());
                        let duration_ms = item["durationMs"].as_u64();
                        let details = (self.presentation
                            && (exit_code.is_some() || duration_ms.is_some()))
                        .then_some(ToolResultDetails {
                            exit_code,
                            duration_ms,
                        });
                        let text = if self.presentation && kind == "commandExecution" {
                            item["aggregatedOutput"]
                                .as_str()
                                .unwrap_or_default()
                                .replace('\0', "\\0")
                        } else {
                            serde_json::to_string(item).expect("native item is JSON")
                        };
                        output
                            .emit(Output::ToolResult {
                                tool_call_id,
                                text,
                                details,
                                is_error: status == Some("failed")
                                    || (self.presentation
                                        && exit_code.is_some_and(|code| code != 0)),
                            })
                            .await?;
                    }
                }
            }
            "thread/tokenUsage/updated" if self.presentation => {
                if let Some(total) = p.pointer("/tokenUsage/total").and_then(Value::as_object)
                    && (self.fresh_thread || self.usage_baseline.is_some())
                {
                    let counter = |key| {
                        let value = total.get(key).and_then(Value::as_u64)?;
                        match &self.usage_baseline {
                            Some(baseline) => value.checked_sub(baseline.get(key)?.as_u64()?),
                            None => Some(value),
                        }
                    };
                    self.usage = Some(TurnUsage {
                        tokens: ModelUsage {
                            input_tokens: counter("inputTokens"),
                            output_tokens: counter("outputTokens"),
                            reasoning_tokens: counter("reasoningOutputTokens"),
                            cache_read_tokens: counter("cachedInputTokens"),
                            cache_write_tokens: counter("cacheWriteInputTokens"),
                        },
                        total_tokens: counter("totalTokens"),
                        duration_ms: None,
                    });
                }
            }
            "turn/completed" => {
                let outcome = match p.pointer("/turn/status").and_then(Value::as_str) {
                    Some("completed") => Outcome::Completed {
                        message_id: self.final_message_id.clone(),
                    },
                    Some("interrupted") => Outcome::Cancelled {
                        reason: Some("native_interrupted".into()),
                    },
                    Some("failed") => Outcome::Failed {
                        code: Some("native_turn_failed".into()),
                        message: p
                            .pointer("/turn/error/message")
                            .and_then(Value::as_str)
                            .filter(|message| !message.is_empty())
                            .unwrap_or("Codex turn failed")
                            .into(),
                        recoverable: false,
                    },
                    _ => {
                        return Err(Error::Invalid(
                            "Codex terminal has no recognized status".into(),
                        ));
                    }
                };
                if let Some(mut usage) = self.usage.take() {
                    usage.duration_ms = p["turn"]["durationMs"].as_u64();
                    output.emit(Output::TurnUsage { usage }).await?;
                }
                return Ok(Some(outcome));
            }
            _ => {}
        }
        Ok(None)
    }
}
struct Sent {
    initialize: u64,
    thread: u64,
    turn: u64,
    injected: Option<u64>,
    interrupted: Option<u64>,
    fresh_thread: bool,
}
impl Sent {
    async fn read(
        input: &mut replay::Stream,
        binding: &NativeBinding,
        request: &Request,
    ) -> Result<Self, Error> {
        let NativeTask::Codex { thread, turn } = &binding.task else {
            return Err(Error::Unknown);
        };
        let initialize = request_id(&input.required().await?, "initialize")?;
        let initialized = input.required().await?;
        if initialized["method"] != "initialized" || initialized.get("id").is_some() {
            return Err(Error::Unknown);
        }
        let opened = input.required().await?;
        let fresh_thread = opened["method"] == "thread/start";
        let thread_request = if fresh_thread {
            request_id(&opened, "thread/start")?
        } else {
            if opened["params"]["threadId"] != *thread {
                return Err(Error::Unknown);
            }
            request_id(&opened, "thread/resume")?
        };
        let cwd = runtime::string(&opened, "/params/cwd")?;
        let expected_cwd = if binding.snapshot.is_some() {
            binding.resource.resource_ref.join("workspace")
        } else {
            PathBuf::from(&request.cwd)
        };
        if std::path::Path::new(cwd) != expected_cwd
            || opened["params"]["approvalPolicy"] != "never"
            || opened["params"]["sandbox"] != "danger-full-access"
        {
            return Err(Error::Unknown);
        }
        let mut started = input.required().await?;
        let injected = if started["method"] == "thread/inject_items" {
            if started["params"]["threadId"] != *thread {
                return Err(Error::Unknown);
            }
            let id = request_id(&started, "thread/inject_items")?;
            started = input.required().await?;
            Some(id)
        } else {
            None
        };
        let start = request_id(&started, "turn/start")?;
        if started["params"]["threadId"] != *thread
            || started["params"]["approvalPolicy"] != "never"
            || started["params"]["sandboxPolicy"]["type"] != "dangerFullAccess"
            || !started["params"]["input"].is_array()
        {
            return Err(Error::Unknown);
        }
        let mut interrupted = None;
        while let Some(control) = input.next().await? {
            if control["method"] == "turn/steer" {
                return Err(Error::Invalid(
                    "Original Codex steering response-buffer recovery is unsupported".into(),
                ));
            }
            if interrupted.is_some()
                || control["params"]["threadId"] != *thread
                || control["params"]["turnId"] != *turn
            {
                return Err(Error::Unknown);
            }
            interrupted = Some(request_id(&control, "turn/interrupt")?);
        }
        let mut ids = vec![initialize, thread_request, start];
        ids.extend(injected);
        ids.extend(interrupted);
        if ids
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != ids.len()
        {
            return Err(Error::Unknown);
        }
        Ok(Self {
            initialize,
            thread: thread_request,
            turn: start,
            injected,
            interrupted,
            fresh_thread,
        })
    }
}
fn request_id(value: &Value, method: &str) -> Result<u64, Error> {
    if value["jsonrpc"] != "2.0" || value["method"] != method {
        return Err(Error::Unknown);
    }
    value
        .get("id")
        .and_then(Value::as_u64)
        .ok_or(Error::Unknown)
}
pub(super) async fn replay(
    request: &Request,
    binding: &NativeBinding,
    input: &mut replay::Stream,
    stream: &mut replay::Stream,
    output: &dyn OutputSink,
) -> Result<Outcome, Error> {
    let NativeTask::Codex { thread, turn } = &binding.task else {
        return Err(Error::Unknown);
    };
    let sent = Sent::read(input, binding, request).await?;
    let mut state = Turn {
        thread: thread.clone(),
        turn: turn.clone(),
        messages: Default::default(),
        final_message_id: None,
        presentation: binding.adapter_version >= PRESENTATION_VERSION,
        fresh_thread: sent.fresh_thread,
        usage_baseline: None,
        usage: None,
    };
    let mut acknowledged = std::collections::BTreeSet::new();
    let mut outcome = None;
    while let Some(event) = stream.next().await? {
        if event.get("id").is_some() {
            if event.get("method").is_some() {
                return Err(Error::Invalid(
                    "Original Codex server-request recovery is unsupported".into(),
                ));
            }
            let id = event
                .get("id")
                .and_then(Value::as_u64)
                .ok_or(Error::Unknown)?;
            if ![
                Some(sent.initialize),
                Some(sent.thread),
                Some(sent.turn),
                sent.injected,
                sent.interrupted,
            ]
            .contains(&Some(id))
                || !acknowledged.insert(id)
            {
                return Err(Error::Unknown);
            }
            if id == sent.initialize
                || id == sent.thread
                || id == sent.turn
                || Some(id) == sent.injected
            {
                let result = event.get("result").ok_or(Error::Unknown)?;
                if event.get("error").is_some() {
                    return Err(Error::Unknown);
                }
                if id == sent.thread {
                    if result["thread"]["id"] != *thread
                        || result["approvalPolicy"] != "never"
                        || result["sandbox"]["type"] != "dangerFullAccess"
                    {
                        return Err(Error::Unknown);
                    }
                    if let Some(model) = &request.settings.model
                        && result.get("model").and_then(Value::as_str) != Some(model.as_str())
                    {
                        return Err(Error::Unknown);
                    }
                }
                if id == sent.turn && result["turn"]["id"] != *turn {
                    return Err(Error::Unknown);
                }
            }
            continue;
        }
        if !event.is_object() || event.get("method").and_then(Value::as_str).is_none() {
            return Err(Error::Unknown);
        }
        if outcome.is_some() {
            // The live parser returns at terminal. Ignore only unrelated metadata,
            // never a second terminal or more activity for this original turn.
            if event["params"]["threadId"] == *thread
                && (event["params"]["turnId"] == *turn || event["params"]["turn"]["id"] == *turn)
                && matches!(
                    event["method"].as_str(),
                    Some(
                        "turn/completed"
                            | "item/agentMessage/delta"
                            | "item/reasoning/summaryTextDelta"
                            | "item/reasoning/textDelta"
                            | "item/started"
                            | "item/completed"
                    )
                )
            {
                return Err(Error::Unknown);
            }
            continue;
        }
        match state.event(event, output).await {
            Ok(Some(result)) => outcome = Some(result),
            Ok(None) => {}
            Err(error) => return Err(error),
        }
    }
    if !acknowledged.contains(&sent.initialize)
        || !acknowledged.contains(&sent.thread)
        || !acknowledged.contains(&sent.turn)
        || sent.injected.is_some_and(|id| !acknowledged.contains(&id))
    {
        return Err(Error::Unknown);
    }
    outcome.ok_or(Error::Unknown)
}
