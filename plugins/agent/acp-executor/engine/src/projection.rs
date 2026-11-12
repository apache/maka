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

use agent_client_protocol::v1::schema as acp;
use maka_agent_facts::executor::Output;
use maka_agent_ports::executor::Error;
use maka_agent_ports::executor::OutputSink;
use std::collections::BTreeMap;

pub(crate) mod v2;

// JSON escaping expands each byte at most sixfold; leave room for identities.
const CHUNK_BYTES: usize = 8 * 1024;

#[derive(Default)]
struct Tool {
    text: String,
    done: bool,
    closure_error: Option<&'static str>,
}

struct TextSpan {
    id: String,
    has_body: bool,
}

/// Projects one ACP prompt turn into committed public executor observations.
pub struct Projection {
    session_id: String,
    invocation_id: String,
    tools: BTreeMap<String, Tool>,
    span: Option<TextSpan>,
    next_span: u64,
    last_body: Option<String>,
    config_options: Option<Vec<acp::SessionConfigOption>>,
    finished: bool,
}

impl Projection {
    pub(crate) fn session_id(&self) -> &str {
        &self.session_id
    }
    pub fn new(session_id: String, invocation_id: String) -> Self {
        Self {
            session_id,
            invocation_id,
            tools: BTreeMap::new(),
            span: None,
            next_span: 0,
            last_body: None,
            config_options: None,
            finished: false,
        }
    }

    pub fn last_body_message_id(&self) -> Option<String> {
        self.last_body.clone()
    }

    async fn text(
        &mut self,
        text: &str,
        thought: bool,
        sink: &dyn OutputSink,
    ) -> Result<(), Error> {
        if text.is_empty() {
            return Ok(());
        }
        if self.span.is_none() {
            let id = format!(
                "{}:{}:message:{}",
                self.invocation_id.len(),
                self.invocation_id,
                self.next_span
            );
            emit(
                sink,
                Output::MessageStart {
                    message_id: id.clone(),
                },
            )
            .await?;
            self.next_span += 1;
            self.span = Some(TextSpan {
                id,
                has_body: false,
            });
        }
        let span = self.span.as_mut().expect("message start was committed");
        emit_text(text, sink, |text| {
            if thought {
                Output::ThinkingDelta {
                    message_id: span.id.clone(),
                    text,
                }
            } else {
                Output::OutputDelta {
                    message_id: span.id.clone(),
                    text,
                }
            }
        })
        .await?;
        span.has_body |= !thought;
        Ok(())
    }

    pub async fn close_message(&mut self, sink: &dyn OutputSink) -> Result<(), Error> {
        if let Some(span) = &self.span {
            emit(
                sink,
                Output::MessageEnd {
                    message_id: span.id.clone(),
                },
            )
            .await?;
            if span.has_body {
                self.last_body = Some(span.id.clone());
            }
            self.span = None;
        }
        Ok(())
    }

    pub(crate) fn take_config_options(&mut self) -> Option<Vec<acp::SessionConfigOption>> {
        self.config_options.take()
    }

    pub async fn update_json(
        &mut self,
        notification: serde_json::Value,
        sink: &dyn OutputSink,
    ) -> Result<(), Error> {
        let notification = serde_json::from_value(notification)
            .map_err(|error| Error::Invalid(format!("Invalid ACP session update: {error}")))?;
        self.update(notification, sink).await
    }

    pub(crate) async fn update(
        &mut self,
        notification: acp::SessionNotification,
        sink: &dyn OutputSink,
    ) -> Result<(), Error> {
        if notification.session_id.to_string() != self.session_id || self.finished {
            return Err(invalid("ACP update belongs to another or finished turn"));
        }
        match notification.update {
            acp::SessionUpdate::AgentMessageChunk(chunk) => {
                let text = content_text(chunk.content)?;
                self.text(&text, false, sink).await?;
            }
            acp::SessionUpdate::AgentThoughtChunk(chunk) => {
                self.text(&content_text(chunk.content)?, true, sink).await?;
            }
            acp::SessionUpdate::ToolCall(call) => {
                let fields = acp::ToolCallUpdateFields::new()
                    .title(call.title)
                    .name(call.name)
                    .status(call.status)
                    .content(call.content)
                    .raw_input(call.raw_input)
                    .raw_output(call.raw_output);
                self.tool(call.tool_call_id.to_string(), fields, sink)
                    .await?;
            }
            acp::SessionUpdate::ToolCallUpdate(call) => {
                self.tool(call.tool_call_id.to_string(), call.fields, sink)
                    .await?;
            }
            acp::SessionUpdate::Plan(plan) => {
                self.text(&json(&plan)?, true, sink).await?;
            }
            acp::SessionUpdate::ConfigOptionUpdate(update) => {
                self.config_options = Some(update.config_options);
            }
            // User echoes and session metadata do not form assistant output.
            acp::SessionUpdate::UserMessageChunk(_)
            | acp::SessionUpdate::AvailableCommandsUpdate(_)
            | acp::SessionUpdate::CurrentModeUpdate(_)
            | acp::SessionUpdate::SessionInfoUpdate(_)
            | acp::SessionUpdate::UsageUpdate(_) => {}
            _ => return Err(invalid("unsupported ACP session update")),
        }
        Ok(())
    }

    fn tool_id(&self, id: &str) -> String {
        format!("{}:{}:{id}", self.invocation_id.len(), self.invocation_id)
    }

    async fn tool(
        &mut self,
        id: String,
        fields: acp::ToolCallUpdateFields,
        sink: &dyn OutputSink,
    ) -> Result<(), Error> {
        if id.is_empty() {
            return Err(invalid("ACP tool call ID is empty"));
        }
        // Keep terminal tombstones for this turn: late updates cannot reopen tools.
        if self.tools.get(&id).is_some_and(|tool| tool.done) {
            return Err(invalid("ACP updated a completed tool call"));
        }
        let status = fields.status.unwrap_or_default();
        let done = match status {
            acp::ToolCallStatus::Completed | acp::ToolCallStatus::Failed => true,
            acp::ToolCallStatus::Pending | acp::ToolCallStatus::InProgress => false,
            _ => return Err(invalid("unsupported ACP tool status")),
        };
        let text = match fields.content {
            Some(content) if !content.is_empty() => Some(tool_text(content)?),
            Some(_) => Some(
                fields
                    .raw_output
                    .as_ref()
                    .map(json)
                    .transpose()?
                    .unwrap_or_default(),
            ),
            None => fields.raw_output.as_ref().map(json).transpose()?,
        };
        self.close_message(sink).await?;
        let tool_call_id = self.tool_id(&id);
        if !self.tools.contains_key(&id) {
            emit(
                sink,
                Output::ToolStart {
                    tool_call_id: tool_call_id.clone(),
                    name: fields
                        .name
                        .or(fields.title)
                        .unwrap_or_else(|| "ACP tool".into()),
                    input: fields.raw_input.unwrap_or(serde_json::Value::Null),
                },
            )
            .await?;
            self.tools.insert(id.clone(), Tool::default());
        }
        let tool = self.tools.get_mut(&id).expect("tool start was committed");
        if let Some(text) = text {
            // ACP replaces content snapshots; avoid repeating an unchanged prefix.
            if !done && text != tool.text {
                let delta = text
                    .strip_prefix(&tool.text)
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("\nUpdated tool output:\n{text}"));
                emit_text(&delta, sink, |text| Output::ToolProgress {
                    tool_call_id: tool_call_id.clone(),
                    text,
                })
                .await?;
            }
            tool.text = text;
        }
        if done {
            if let Err(error) = emit_result(
                sink,
                tool_call_id,
                &tool.text,
                status == acp::ToolCallStatus::Failed,
            )
            .await
            {
                tool.closure_error = Some(match &error {
                    Error::Invalid(_) => "ACP tool result contains invalid text",
                    _ => "ACP tool result could not be recorded",
                });
                return Err(error);
            }
            tool.text.clear();
            tool.done = true;
        }
        Ok(())
    }

    /// Only a confirmed normal finish completes the open text span.
    pub async fn finish(&mut self, sink: &dyn OutputSink, completed: bool) -> Result<(), Error> {
        self.finished = true;
        if completed {
            self.close_message(sink).await?;
        }
        let invocation_id = &self.invocation_id;
        for (id, tool) in &mut self.tools {
            if !tool.done {
                emit_result(
                    sink,
                    format!("{}:{invocation_id}:{id}", invocation_id.len()),
                    tool.closure_error
                        .unwrap_or("ACP turn ended before the tool reported completion"),
                    true,
                )
                .await?;
                tool.text.clear();
                tool.done = true;
            }
        }
        Ok(())
    }
}

fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}

fn json(value: &impl serde::Serialize) -> Result<String, Error> {
    serde_json::to_string(value).map_err(|error| invalid(&error.to_string()))
}

fn content_text(content: acp::ContentBlock) -> Result<String, Error> {
    match content {
        acp::ContentBlock::Text(text) => Ok(text.text),
        _ => Err(invalid("ACP sent unsupported non-text content")),
    }
}

fn tool_text(content: Vec<acp::ToolCallContent>) -> Result<String, Error> {
    let mut text = String::new();
    for part in content {
        let part = match part {
            acp::ToolCallContent::Content(content) => content_text(content.content)?,
            acp::ToolCallContent::Diff(diff) => format!(
                "File: {}\nBefore:\n{}\nAfter:\n{}",
                diff.path.display(),
                diff.old_text.as_deref().unwrap_or(""),
                diff.new_text
            ),
            _ => return Err(invalid("ACP sent unsupported tool content")),
        };
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&part);
    }
    Ok(text)
}

pub(crate) async fn emit(sink: &dyn OutputSink, output: Output) -> Result<(), Error> {
    output.validate().map_err(invalid)?;
    sink.emit(output).await
}

pub(crate) async fn emit_text(
    mut text: &str,
    sink: &dyn OutputSink,
    output: impl Fn(String) -> Output,
) -> Result<(), Error> {
    if text.contains('\0') {
        return Err(invalid("ACP text contains NUL"));
    }
    while !text.is_empty() {
        let mut end = CHUNK_BYTES.min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        emit(sink, output(text[..end].into())).await?;
        text = &text[end..];
    }
    Ok(())
}

pub(crate) async fn emit_result(
    sink: &dyn OutputSink,
    id: String,
    text: &str,
    is_error: bool,
) -> Result<(), Error> {
    // Reloaded tool cards use the complete terminal fact, not transient progress.
    emit(
        sink,
        Output::ToolResult {
            tool_call_id: id,
            text: text.into(),
            is_error,
            details: None,
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{future::Future, pin::Pin, sync::Mutex};

    #[derive(Default)]
    struct Sink(Mutex<Vec<Output>>);
    impl OutputSink for Sink {
        fn emit(
            &self,
            output: Output,
        ) -> Pin<Box<dyn Future<Output = Result<(), Error>> + Send + '_>> {
            Box::pin(async move {
                self.0.lock().unwrap().push(output);
                Ok(())
            })
        }
    }

    fn update(value: serde_json::Value) -> acp::SessionNotification {
        serde_json::from_value(serde_json::json!({ "sessionId": "s", "update": value })).unwrap()
    }

    #[tokio::test]
    async fn text_spans_close_at_tools_and_final_pointer_skips_thought_only_spans() {
        let sink = Sink::default();
        let mut projection = Projection::new("s".into(), "turn".into());
        for value in [
            serde_json::json!({"sessionUpdate":"agent_message_chunk", "content":{"type":"text","text":"checking"}}),
            serde_json::json!({"sessionUpdate":"tool_call_update", "toolCallId":"a", "status":"completed"}),
            serde_json::json!({"sessionUpdate":"agent_message_chunk", "content":{"type":"text","text":"answer"}}),
            serde_json::json!({"sessionUpdate":"tool_call_update", "toolCallId":"b", "status":"completed"}),
            serde_json::json!({"sessionUpdate":"agent_thought_chunk", "content":{"type":"text","text":"done"}}),
        ] {
            projection.update(update(value), &sink).await.unwrap();
        }
        projection.finish(&sink, true).await.unwrap();
        assert_eq!(
            projection.last_body_message_id().as_deref(),
            Some("4:turn:message:1")
        );
        let events = sink.0.lock().unwrap();
        let messages: Vec<_> = events
            .iter()
            .filter(|event| {
                !matches!(
                    event,
                    Output::ToolStart { .. }
                        | Output::ToolProgress { .. }
                        | Output::ToolResult { .. }
                )
            })
            .collect();
        assert_eq!(
            serde_json::to_value(messages).unwrap(),
            serde_json::json!([
                {"type":"message_start", "messageId":"4:turn:message:0"},
                {"type":"output_delta", "messageId":"4:turn:message:0", "text":"checking"},
                {"type":"message_end", "messageId":"4:turn:message:0"},
                {"type":"message_start", "messageId":"4:turn:message:1"},
                {"type":"output_delta", "messageId":"4:turn:message:1", "text":"answer"},
                {"type":"message_end", "messageId":"4:turn:message:1"},
                {"type":"message_start", "messageId":"4:turn:message:2"},
                {"type":"thinking_delta", "messageId":"4:turn:message:2", "text":"done"},
                {"type":"message_end", "messageId":"4:turn:message:2"}
            ])
        );
        assert!(matches!(&events[3], Output::ToolStart { .. }));
        assert!(matches!(&events[8], Output::ToolStart { .. }));
    }

    #[tokio::test]
    async fn unconfirmed_text_remains_open_and_empty_or_thought_only_output_has_no_final_body() {
        for completed in [false, true] {
            let sink = Sink::default();
            let mut projection = Projection::new("s".into(), "turn".into());
            projection.finish(&sink, completed).await.unwrap();
            assert_eq!(projection.last_body_message_id(), None);
            assert!(sink.0.lock().unwrap().is_empty());

            let sink = Sink::default();
            let mut projection = Projection::new("s".into(), "turn".into());
            projection.update(update(serde_json::json!({"sessionUpdate":"agent_thought_chunk", "content":{"type":"text","text":"thinking"}})), &sink).await.unwrap();
            projection.finish(&sink, completed).await.unwrap();
            assert_eq!(projection.last_body_message_id(), None);
            let events = sink.0.lock().unwrap();
            assert!(
                matches!(&events[0], Output::MessageStart { message_id } if message_id == "4:turn:message:0")
            );
            assert!(
                matches!(&events[1], Output::ThinkingDelta { message_id, text } if message_id == "4:turn:message:0" && text == "thinking")
            );
            assert_eq!(events.len(), if completed { 3 } else { 2 });
            if completed {
                assert!(
                    matches!(&events[2], Output::MessageEnd { message_id } if message_id == "4:turn:message:0")
                );
            }
        }
    }

    #[tokio::test]
    async fn cancelled_body_span_is_not_a_completed_answer() {
        let sink = Sink::default();
        let mut projection = Projection::new("s".into(), "turn".into());
        projection.update(update(serde_json::json!({"sessionUpdate":"agent_message_chunk", "content":{"type":"text","text":"partial"}})), &sink).await.unwrap();
        projection.finish(&sink, false).await.unwrap();
        assert_eq!(projection.last_body_message_id(), None);
        assert_eq!(
            serde_json::to_value(&*sink.0.lock().unwrap()).unwrap(),
            serde_json::json!([
                {"type":"message_start", "messageId":"4:turn:message:0"},
                {"type":"output_delta", "messageId":"4:turn:message:0", "text":"partial"}
            ])
        );
    }

    #[tokio::test]
    async fn update_before_start_and_eof_close_only_unfinished_tools() {
        let sink = Sink::default();
        let mut projection = Projection::new("s".into(), "turn".into());
        for value in [
            serde_json::json!({"sessionUpdate":"tool_call_update","toolCallId":"a","status":"completed"}),
            serde_json::json!({"sessionUpdate":"tool_call","toolCallId":"b","title":"running"}),
        ] {
            projection.update(update(value), &sink).await.unwrap();
        }
        projection.finish(&sink, true).await.unwrap();
        projection.finish(&sink, true).await.unwrap();
        let events = sink.0.lock().unwrap();
        assert_eq!(events.len(), 4);
        assert!(
            matches!(&events[0], Output::ToolStart { tool_call_id, .. } if tool_call_id == "4:turn:a")
        );
        assert!(matches!(
            &events[1],
            Output::ToolResult {
                is_error: false,
                ..
            }
        ));
        assert!(matches!(&events[2], Output::ToolStart { .. }));
        assert!(matches!(
            &events[3],
            Output::ToolResult { is_error: true, .. }
        ));
    }

    #[tokio::test]
    async fn unicode_chunks_round_trip_and_foreign_sessions_fail() {
        let sink = Sink::default();
        let mut projection = Projection::new("s".into(), "turn".into());
        let text = "界\n".repeat(400_000);
        let notification = update(
            serde_json::json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}),
        );
        projection
            .update(notification.clone(), &sink)
            .await
            .unwrap();
        assert_eq!(projection.last_body_message_id(), None);
        let mut actual = String::new();
        {
            let events = sink.0.lock().unwrap();
            for event in events.iter() {
                assert!(json(event).unwrap().len() <= 64 * 1024);
                if let Output::OutputDelta { text, .. } = event {
                    actual.push_str(text);
                }
            }
        }
        assert_eq!(actual, text);
        let mut foreign = notification;
        foreign.session_id = "other".into();
        assert!(projection.update(foreign, &sink).await.is_err());
    }

    #[tokio::test]
    async fn complete_large_output_keeps_late_completion_refusal() {
        let sink = Sink::default();
        let mut projection = Projection::new("s".into(), "turn".into());
        let oversized = update(serde_json::json!({
            "sessionUpdate":"agent_message_chunk",
            "content":{"type":"text","text":"\n".repeat(1024 * 1024 / 2)}
        }));
        projection.update(oversized, &sink).await.unwrap();

        let emitted = sink.0.lock().unwrap().len();
        let terminal = update(serde_json::json!({
            "sessionUpdate":"tool_call_update","toolCallId":"a","status":"completed"
        }));
        projection.update(terminal.clone(), &sink).await.unwrap();
        assert!(projection.update(terminal, &sink).await.is_err());
        projection.finish(&sink, true).await.unwrap();
        assert_eq!(sink.0.lock().unwrap().len(), emitted + 3);
    }

    #[tokio::test]
    async fn terminal_text_is_complete_and_durable() {
        let sink = Sink::default();
        let mut projection = Projection::new("s".into(), "turn".into());
        let terminal = |id: &str, text: String| {
            update(serde_json::json!({
                "sessionUpdate":"tool_call_update","toolCallId":id,"status":"completed",
                "content":[{"type":"content","content":{"type":"text","text":text}}]
            }))
        };
        let text = "x".repeat(9 * 1024);
        projection
            .update(terminal("a", text.clone()), &sink)
            .await
            .unwrap();
        let oversized = terminal("b", "x".repeat(64 * 1024));
        projection.update(oversized, &sink).await.unwrap();
        projection.finish(&sink, true).await.unwrap();
        let events = sink.0.lock().unwrap();
        assert_eq!(events.len(), 4);
        assert!(
            matches!(&events[1], Output::ToolResult { text: actual, is_error: false, .. } if actual == &text)
        );
        assert!(
            matches!(&events[3], Output::ToolResult { text, is_error: false, .. } if text == &"x".repeat(64 * 1024))
        );
    }
}
