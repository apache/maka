// Licensed to the Apache Software Foundation (ASF) under one
// or more contributor license agreements. See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership. The ASF licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License. You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

use super::{emit, emit_result, emit_text};
use crate::Error;
use agent_client_protocol::schema::{MaybeUndefined, v2 as acp};
use maka_plugins::executor::OutputSink;
use maka_runtime::executor::Output;
use std::collections::BTreeMap;
mod messages;
mod tools;

#[derive(Default)]
struct Message {
    id: String,
    text: String,
    thought: bool,
}

#[derive(Default)]
struct Tool {
    snapshot: serde_json::Map<String, serde_json::Value>,
    done: bool,
}

/// V2 message upserts can replace already streamed text. The Host has append-only
/// deltas, so commit message text only after idle, retaining stable IDs until then.
pub(crate) struct Projection {
    pub session_id: String,
    invocation_id: String,
    messages: Vec<Message>,
    tools: BTreeMap<String, Tool>,
    users: Vec<String>,
    accepted: Option<String>,
    running: bool,
    idle: bool,
    pub(crate) stop_reason: Option<acp::StopReason>,
    pub(crate) options: Option<Vec<acp::SessionConfigOption>>,
}

impl Projection {
    pub(crate) fn new(session_id: String, invocation_id: String) -> Self {
        Self {
            session_id,
            invocation_id,
            messages: vec![],
            tools: BTreeMap::new(),
            users: vec![],
            accepted: None,
            running: false,
            idle: false,
            stop_reason: None,
            options: None,
        }
    }
    pub(crate) fn accept(&mut self, id: String) -> Result<(), Error> {
        identity(&id)?;
        self.accepted = Some(id);
        Ok(())
    }
    pub(crate) fn completed(&self) -> bool {
        self.idle
            && self
                .accepted
                .as_ref()
                .is_some_and(|id| self.users.contains(id))
    }
    pub(crate) fn text(&self) -> String {
        self.messages
            .iter()
            .filter(|message| !message.thought)
            .map(|message| message.text.as_str())
            .collect()
    }

    pub(crate) async fn update(
        &mut self,
        notification: acp::UpdateSessionNotification,
        sink: &dyn OutputSink,
        replay: bool,
    ) -> Result<(), Error> {
        if notification.session_id.to_string() != self.session_id {
            return Err(Error::Invalid("ACP update belongs to another session"));
        }
        if replay {
            return Ok(());
        }
        match notification.update {
            acp::SessionUpdate::AgentMessageChunk(chunk) => self.message(
                chunk.message_id.to_string(),
                MaybeUndefined::Value(vec![chunk.content]),
                true,
                false,
            )?,
            acp::SessionUpdate::AgentMessage(message) => self.message(
                message.message_id.to_string(),
                message.content,
                false,
                false,
            )?,
            acp::SessionUpdate::AgentThoughtChunk(chunk) => self.message(
                chunk.message_id.to_string(),
                MaybeUndefined::Value(vec![chunk.content]),
                true,
                true,
            )?,
            acp::SessionUpdate::AgentThought(message) => {
                self.message(message.message_id.to_string(), message.content, false, true)?
            }
            acp::SessionUpdate::UserMessage(message) => {
                self.user(message.message_id.to_string())?
            }
            acp::SessionUpdate::UserMessageChunk(chunk) => {
                self.user(chunk.message_id.to_string())?
            }
            acp::SessionUpdate::StateUpdate(state) => match state {
                acp::StateUpdate::Running(_) | acp::StateUpdate::RequiresAction(_) => {
                    self.running = true;
                    self.idle = false;
                }
                acp::StateUpdate::Idle(idle) if self.running => {
                    self.idle = true;
                    self.stop_reason = idle.stop_reason;
                }
                acp::StateUpdate::Idle(_) => {}
                _ => return Err(Error::Invalid("unsupported ACP foreground state")),
            },
            acp::SessionUpdate::ConfigOptionUpdate(update) => {
                self.options = Some(update.config_options)
            }
            acp::SessionUpdate::ToolCallUpdate(update) => self.tool(update, None, sink).await?,
            acp::SessionUpdate::ToolCallContentChunk(chunk) => {
                self.tool(
                    acp::ToolCallUpdate::new(chunk.tool_call_id),
                    Some(chunk.content),
                    sink,
                )
                .await?
            }
            acp::SessionUpdate::PlanUpdate(plan) => {
                emit_text(&serde_json::to_string(&plan)?, sink, |text| {
                    Output::ThinkingDelta { text }
                })
                .await?
            }
            acp::SessionUpdate::TerminalUpdate(terminal) => {
                emit_text(&serde_json::to_string(&terminal)?, sink, |text| {
                    Output::ThinkingDelta { text }
                })
                .await?
            }
            acp::SessionUpdate::TerminalOutputChunk(chunk) => {
                emit_text(&serde_json::to_string(&chunk)?, sink, |text| {
                    Output::ThinkingDelta { text }
                })
                .await?
            }
            acp::SessionUpdate::AvailableCommandsUpdate(_)
            | acp::SessionUpdate::SessionInfoUpdate(_)
            | acp::SessionUpdate::UsageUpdate(_) => {}
            other => {
                emit_text(&serde_json::to_string(&other)?, sink, |text| {
                    Output::ThinkingDelta { text }
                })
                .await?
            }
        }
        Ok(())
    }

    fn user(&mut self, id: String) -> Result<(), Error> {
        identity(&id)?;
        if !self.users.contains(&id) {
            if self.users.len() >= 1024 {
                return Err(Error::Invalid("ACP turn exceeds 1024 user messages"));
            }
            self.users.push(id);
        }
        Ok(())
    }

    pub(crate) async fn finish(
        &mut self,
        sink: &dyn OutputSink,
        confirmed: bool,
    ) -> Result<(), Error> {
        for (id, tool) in &mut self.tools {
            if !tool.done {
                let status = tool
                    .snapshot
                    .get("status")
                    .and_then(serde_json::Value::as_str);
                let terminal = matches!(status, Some("completed" | "failed" | "cancelled"));
                let text = if terminal {
                    serde_json::to_string(&tool.snapshot)?
                } else {
                    format!(
                        "ACP turn ended before the tool reported completion\n{}",
                        serde_json::to_string(&tool.snapshot)?
                    )
                };
                // Tool upserts may still patch a completed call before idle.
                // Commit the final snapshot once rather than dropping those patches.
                emit_result(
                    sink,
                    format!("{}:{}:{id}", self.invocation_id.len(), self.invocation_id),
                    &text,
                    status != Some("completed"),
                )
                .await?;
                tool.done = true;
                tool.snapshot.clear();
            }
        }
        if confirmed {
            for message in &self.messages {
                emit_text(&message.text, sink, |text| {
                    if message.thought {
                        Output::ThinkingDelta { text }
                    } else {
                        Output::OutputDelta { text }
                    }
                })
                .await?;
            }
        }
        Ok(())
    }
}

pub(crate) fn identity(id: &str) -> Result<(), Error> {
    if id.is_empty() || id.len() > 1024 || id.chars().any(char::is_control) {
        return Err(Error::Invalid("invalid ACP identity"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_plugins::executor;
    use std::sync::Mutex;

    #[derive(Default)]
    pub(super) struct Sink(pub(super) Mutex<Vec<Output>>);
    impl OutputSink for Sink {
        fn emit(
            &self,
            output: Output,
        ) -> futures_util::future::BoxFuture<'_, Result<(), executor::Error>> {
            Box::pin(async move {
                self.0.lock().unwrap().push(output);
                Ok(())
            })
        }
    }

    pub(super) async fn update(projection: &mut Projection, sink: &Sink, value: serde_json::Value) {
        projection
            .update(
                serde_json::from_value(serde_json::json!({"sessionId":"s", "update":value}))
                    .unwrap(),
                sink,
                false,
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn acknowledgement_requires_echo_and_foreground_idle_even_when_idle_precedes_ack() {
        let sink = Sink::default();
        let mut projection = Projection::new("s".into(), "turn".into());
        update(
            &mut projection,
            &sink,
            serde_json::json!({"sessionUpdate":"state_update", "state":"idle"}),
        )
        .await;
        projection.accept("user".into()).unwrap();
        assert!(!projection.completed());
        update(
            &mut projection,
            &sink,
            serde_json::json!({"sessionUpdate":"user_message", "messageId":"user"}),
        )
        .await;
        assert!(!projection.completed());
        update(
            &mut projection,
            &sink,
            serde_json::json!({"sessionUpdate":"state_update", "state":"running"}),
        )
        .await;
        assert!(!projection.completed());
        update(&mut projection, &sink, serde_json::json!({"sessionUpdate":"state_update", "state":"idle", "stopReason":"end_turn"})).await;
        assert!(projection.completed());
        projection.accepted = None;
        assert!(!projection.completed());
        projection.accept("user".into()).unwrap();
        assert!(projection.completed());
    }
}
