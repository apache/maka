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
use maka_agent_facts::executor::Output;
use runtime::{Pipe, string};

pub(super) async fn proxy(
    config: &NativeCommand,
    cwd: &str,
    cancellation: CancellationToken,
) -> Result<maka_process::Command, Error> {
    let resolved = runtime::resolve(config, cwd).await.require()?;
    proxy_resolved(&resolved, cwd, cancellation).await
}

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

pub(super) async fn execute(
    mut io: Pipe,
    request: &Value,
    storage: &Storage,
    journal: &mut journal::Journal,
    output: Arc<dyn OutputSink>,
    bridge: Arc<mcp::Bridge>,
    steering: &mut steering::Steering,
) -> (Result<Outcome, Error>, Pipe) {
    let mut custody = Custody::Preparing;
    let result = run(
        &mut io,
        request,
        storage,
        journal,
        output.as_ref(),
        &bridge,
        &mut custody,
        steering,
    )
    .await;
    bridge.close_admission();
    let result = match custody {
        Custody::Active { thread, turn }
            if io.buffered().any(|event| terminal(event, &thread, &turn)) =>
        {
            result
        }
        Custody::Active { thread, turn } => {
            // Proxy exit cannot settle daemon work. Interrupt only our turn and await its terminal.
            io.cancellation = CancellationToken::new();
            io.failed = CancellationToken::new();
            io.control(
                "turn/interrupt",
                serde_json::json!({"threadId":thread,"turnId":turn}),
            )
            .await;
            let drained = tokio::time::timeout(Duration::from_secs(30), async {
                loop {
                    if terminal(&io.next().await?, &thread, &turn) {
                        return Ok::<_, Error>(());
                    }
                }
            })
            .await;
            match drained {
                Ok(Ok(())) => result,
                _ => Err(Error::CleanupUnconfirmed),
            }
        }
        // A partially delivered turn/start without an acknowledgement must never be replayed.
        Custody::Submitted => Err(Error::Unknown),
        Custody::Preparing | Custody::Settled => result,
    };
    (result, io)
}
enum Custody {
    Preparing,
    Submitted,
    Active { thread: String, turn: String },
    Settled,
}
#[expect(
    clippy::too_many_arguments,
    reason = "native turn custody retains the original invocation and steering owner"
)]
async fn run(
    io: &mut Pipe,
    request: &Value,
    storage: &Storage,
    journal: &mut journal::Journal,
    output: &dyn OutputSink,
    bridge: &mcp::Bridge,
    custody: &mut Custody,
    steering: &mut steering::Steering,
) -> Result<Outcome, Error> {
    io.request("initialize", serde_json::json!({"clientInfo":{"name":"maka","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}})).await?;
    io.notify("initialized", serde_json::json!({})).await?;
    let resume = journal.native_session();
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
    journal.opened(storage, thread.clone()).await?;
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
        journal.confirm_instructions(storage, update).await?;
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
    let started = io.request("turn/start", params).await?;
    let turn = string(&started, "/turn/id")?.to_owned();
    *custody = Custody::Active {
        thread: thread.clone(),
        turn: turn.clone(),
    };
    let mut state = Turn {
        thread,
        turn,
        messages: Default::default(),
        final_message_id: None,
    };
    loop {
        let event = {
            tokio::select! {
                () = cancellation.cancelled() => return Err(Error::Cancelled),
                () = failed.cancelled() => return Err(Error::Unknown),
                event = io.next() => event?,
                ready = steering.ready() => {
                    ready?;
                    if let Some(input) = steering.take().await? {
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
                                    if terminal(&event, &state.thread, &state.turn) { *custody = Custody::Settled; }
                                    state.event(event, output).await?;
                                }
                                return Ok(Outcome::Failed {
                                    message, code: Some("native_steering_rejected".into()), recoverable: false,
                                });
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
        if terminal(&event, &state.thread, &state.turn) {
            *custody = Custody::Settled;
        }
        if event.get("method").is_some() && event.get("id").is_some() {
            return io.unsupported(event).await;
        }
        if let Some(outcome) = state.event(event, output).await? {
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
                        output
                            .emit(Output::ToolResult {
                                tool_call_id,
                                text: serde_json::to_string(item).expect("native item is JSON"),
                                is_error: item.get("status").and_then(Value::as_str)
                                    == Some("failed"),
                            })
                            .await?;
                    }
                }
            }
            "turn/completed" => {
                return Ok(Some(
                    match p.pointer("/turn/status").and_then(Value::as_str) {
                        Some("completed") => {
                            if self.messages.values().any(|message| !message.ended) {
                                return Err(Error::Invalid(
                                    "Codex succeeded with an unfinished assistant item".into(),
                                ));
                            }
                            Outcome::Completed {
                                message_id: self.final_message_id.clone(),
                            }
                        }
                        Some("interrupted") => return Err(Error::Cancelled),
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
                    },
                ));
            }
            _ => {}
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Collect(std::sync::Mutex<Vec<Output>>);
    impl OutputSink for Collect {
        fn emit(&self, event: Output) -> BoxFuture<'_, Result<(), Error>> {
            Box::pin(async move {
                self.0.lock().unwrap().push(event);
                Ok(())
            })
        }
    }
    fn turn() -> Turn {
        Turn {
            thread: "thread".into(),
            turn: "turn".into(),
            messages: Default::default(),
            final_message_id: None,
        }
    }
    fn event(method: &str, mut params: Value) -> Value {
        params["threadId"] = "thread".into();
        params["turnId"] = "turn".into();
        serde_json::json!({"method":method,"params":params})
    }
    #[tokio::test]
    async fn reasoning_snapshots_reconcile_each_native_part_without_replaying_streamed_summary() {
        let sink = Collect(Default::default());
        let mut turn = turn();
        for (method, params) in [
            (
                "item/reasoning/summaryTextDelta",
                serde_json::json!({"itemId":"r","summaryIndex":0,"delta":"first "}),
            ),
            (
                "item/reasoning/summaryTextDelta",
                serde_json::json!({"itemId":"r","summaryIndex":0,"delta":"summary"}),
            ),
            (
                "item/reasoning/summaryTextDelta",
                serde_json::json!({"itemId":"r","summaryIndex":1,"delta":"next"}),
            ),
            (
                "item/reasoning/textDelta",
                serde_json::json!({"itemId":"r","contentIndex":0,"delta":"raw"}),
            ),
            (
                "item/completed",
                serde_json::json!({"item":{"id":"r","type":"reasoning","summary":["first summary","next","snapshot only"],"content":["raw content","extra content"]}}),
            ),
        ] {
            turn.event(event(method, params), &sink).await.unwrap();
        }
        assert!(matches!(
            turn.event(
                event(
                    "turn/completed",
                    serde_json::json!({"turn":{"id":"turn","status":"completed"}})
                ),
                &sink
            )
            .await
            .unwrap(),
            Some(Outcome::Completed { message_id: None })
        ));
        assert_eq!(
            serde_json::to_value(&*sink.0.lock().unwrap()).unwrap(),
            serde_json::json!([
                {"type":"message_start","messageId":"r"},
                {"type":"thinking_delta","messageId":"r","text":"first "},
                {"type":"thinking_delta","messageId":"r","text":"summary"},
                {"type":"thinking_delta","messageId":"r","text":"\n\nnext"},
                {"type":"thinking_delta","messageId":"r","text":"\n\nraw"},
                {"type":"thinking_delta","messageId":"r","text":" content"},
                {"type":"thinking_delta","messageId":"r","text":"\n\nsnapshot only"},
                {"type":"thinking_delta","messageId":"r","text":"\n\nextra content"},
                {"type":"message_end","messageId":"r"}
            ])
        );
        let mut failed_turn = super::tests::turn();
        assert!(matches!(
            failed_turn
                .event(
                    event(
                        "turn/completed",
                        serde_json::json!({"turn":{"id":"turn","status":"failed","error":{"message":"rate limit exceeded"}}})
                    ),
                    &sink
                )
                .await
                .unwrap(),
            Some(Outcome::Failed { message, .. }) if message == "rate limit exceeded"
        ));
        let mut turn = super::tests::turn();
        turn.event(
            event(
                "item/reasoning/summaryTextDelta",
                serde_json::json!({"itemId":"bad","summaryIndex":0,"delta":"streamed"}),
            ),
            &sink,
        )
        .await
        .unwrap();
        assert!(turn.event(event("item/completed", serde_json::json!({"item":{"id":"bad","type":"reasoning","summary":["different"],"content":[]}})), &sink).await.is_err());
    }
    #[tokio::test]
    async fn native_items_preserve_chunks_and_text_tool_text_order_without_aggregate_answer() {
        let sink = Collect(Default::default());
        let mut turn = turn();
        for (method, params) in [
            (
                "item/started",
                serde_json::json!({"item":{"id":"m1","type":"agentMessage","text":""}}),
            ),
            (
                "item/agentMessage/delta",
                serde_json::json!({"itemId":"m1","delta":"before "}),
            ),
            (
                "item/agentMessage/delta",
                serde_json::json!({"itemId":"m1","delta":"tool"}),
            ),
            (
                "item/completed",
                serde_json::json!({"item":{"id":"m1","type":"agentMessage","text":"before tool"}}),
            ),
            (
                "item/started",
                serde_json::json!({"item":{"id":"t1","type":"commandExecution","command":"true"}}),
            ),
            (
                "item/completed",
                serde_json::json!({"item":{"id":"t1","type":"commandExecution","status":"completed"}}),
            ),
            (
                "item/completed",
                serde_json::json!({"item":{"id":"m2","type":"agentMessage","text":"after tool"}}),
            ),
            (
                "item/completed",
                serde_json::json!({"item":{"id":"reasoning","type":"reasoning","summary":[],"content":[]}}),
            ),
        ] {
            assert!(
                turn.event(event(method, params), &sink)
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        assert!(
            matches!(turn.event(event("turn/completed", serde_json::json!({"turn":{"id":"turn","status":"completed"}})), &sink).await.unwrap(), Some(Outcome::Completed { message_id: Some(id) }) if id == "m2")
        );
        let mut events = serde_json::to_value(&*sink.0.lock().unwrap()).unwrap();
        events[5]["text"] = serde_json::from_str(events[5]["text"].as_str().unwrap()).unwrap();
        assert_eq!(
            events,
            serde_json::json!([
                {"type":"message_start","messageId":"m1"},
                {"type":"output_delta","messageId":"m1","text":"before "},
                {"type":"output_delta","messageId":"m1","text":"tool"},
                {"type":"message_end","messageId":"m1"},
                {"type":"tool_start","toolCallId":"thread:turn:t1","name":"commandExecution","input":{"id":"t1","type":"commandExecution","command":"true"}},
                {"type":"tool_result","toolCallId":"thread:turn:t1","text":{"id":"t1","status":"completed","type":"commandExecution"},"isError":false},
                {"type":"message_start","messageId":"m2"},
                {"type":"output_delta","messageId":"m2","text":"after tool"},
                {"type":"message_end","messageId":"m2"},
                {"type":"message_start","messageId":"reasoning"},
                {"type":"message_end","messageId":"reasoning"}
            ])
        );
    }
    #[tokio::test]
    async fn completed_item_emits_only_unstreamed_suffix_and_interrupt_does_not_end_open_item() {
        let sink = Collect(Default::default());
        let mut turn = turn();
        turn.event(
            event(
                "item/agentMessage/delta",
                serde_json::json!({"itemId":"m","delta":"partial"}),
            ),
            &sink,
        )
        .await
        .unwrap();
        turn.event(
            event(
                "item/completed",
                serde_json::json!({"item":{"id":"m","type":"agentMessage","text":"partial final"}}),
            ),
            &sink,
        )
        .await
        .unwrap();
        turn.event(
            event(
                "item/reasoning/textDelta",
                serde_json::json!({"itemId":"thinking","contentIndex":0,"delta":"unfinished"}),
            ),
            &sink,
        )
        .await
        .unwrap();
        assert!(matches!(
            turn.event(
                event(
                    "turn/completed",
                    serde_json::json!({"turn":{"id":"turn","status":"interrupted"}})
                ),
                &sink
            )
            .await,
            Err(Error::Cancelled)
        ));
        assert_eq!(
            serde_json::to_value(&*sink.0.lock().unwrap()).unwrap(),
            serde_json::json!([
                {"type":"message_start","messageId":"m"},
                {"type":"output_delta","messageId":"m","text":"partial"},
                {"type":"output_delta","messageId":"m","text":" final"},
                {"type":"message_end","messageId":"m"},
                {"type":"message_start","messageId":"thinking"},
                {"type":"thinking_delta","messageId":"thinking","text":"unfinished"}
            ])
        );
    }
}
