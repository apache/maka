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

//! Interactive execution and replay of previously admitted stream-JSON tasks.
use super::*;
use maka_agent_facts::executor::Output;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

mod input;
mod interactive;
pub(super) use interactive::execute;

#[derive(Clone, Copy, PartialEq)]
enum Start {
    Interactive,
    Submitted,
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
    presentation: bool,
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
    fn new(session: String, presentation: bool) -> Self {
        Self {
            presentation,
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
            "system" | "assistant" | "user" | "result" | "stream_event" | "command_lifecycle"
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
            "command_lifecycle" => {}
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
                                        details: None,
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
                    if self.presentation
                        && let Some(usage) = result_usage(&row)
                    {
                        output.emit(Output::TurnUsage { usage }).await?;
                    }
                    return Ok(Some(self.first_failure.take().unwrap_or(outcome)));
                }
                self.final_message = None;
            }
            _ => return Err(Error::Unknown),
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[derive(Default)]
    struct Sink(std::sync::Mutex<String>);

    impl OutputSink for Sink {
        fn emit(&self, output: Output) -> BoxFuture<'_, Result<(), Error>> {
            Box::pin(async move {
                if let Output::OutputDelta { text, .. } = output {
                    self.0.lock().unwrap().push_str(&text);
                }
                Ok(())
            })
        }
    }

    #[tokio::test]
    async fn command_lifecycle_can_precede_claude_initialization() {
        let output = Sink::default();
        let mut turn = StreamTurn::new("session".into(), true);
        turn.sent("input".into());
        for row in [
            json!({"type":"command_lifecycle","stage":"started","session_id":"session","uuid":"input"}),
            json!({"type":"system","subtype":"init","session_id":"session"}),
            json!({"type":"user","isReplay":true,"session_id":"session","uuid":"input","parent_tool_use_id":null}),
            json!({"type":"assistant","session_id":"session","uuid":"output","message":{"id":"message","content":[{"type":"text","text":"Hello"}]}}),
        ] {
            assert!(turn.row(row, &output).await.unwrap().is_none());
        }
        let outcome = turn
            .row(json!({"type":"result","session_id":"session","subtype":"success","is_error":false}), &output)
            .await
            .unwrap();
        assert!(
            matches!(outcome, Some(Outcome::Completed { message_id: Some(id) }) if id == "message")
        );
        assert_eq!(*output.0.lock().unwrap(), "Hello");
    }
}

fn result_usage(row: &Value) -> Option<maka_agent_facts::executor::TurnUsage> {
    let usage = row.get("usage")?.as_object()?;
    let counter = |key| usage.get(key).and_then(Value::as_u64);
    Some(maka_agent_facts::executor::TurnUsage {
        tokens: maka_agent_facts::model::ModelUsage {
            input_tokens: counter("input_tokens"),
            output_tokens: counter("output_tokens"),
            reasoning_tokens: usage
                .get("output_tokens_details")
                .and_then(|details| details["thinking_tokens"].as_u64()),
            cache_read_tokens: counter("cache_read_input_tokens"),
            cache_write_tokens: counter("cache_creation_input_tokens"),
        },
        total_tokens: None,
        duration_ms: row["duration_ms"].as_u64(),
    })
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
    let mut turn = StreamTurn::new(
        session.clone(),
        binding.adapter_version >= PRESENTATION_VERSION,
    );
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
        if let Some(done) = turn.row(row, output).await?
            && outcome.replace(done).is_some()
        {
            return Err(Error::Unknown);
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
