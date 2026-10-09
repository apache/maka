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

//! Durable transcript rows (`StoredMessage`).
//!
//! `session.transcript.page` fragments reassemble into one JSON document per
//! row, and each row is a `StoredMessage` from `packages/core/src/session.ts`.
//! The Desktop decodes them with `decodeStoredMessage` (session.ts, via
//! `decodeMessage` and the `*_MESSAGE_SHAPE` field lists); the TS client
//! passes that decoder to `decodeTranscriptPage` in
//! `packages/runtime-host/src/client/session-subscription.ts`.
//!
//! The MVP models user, assistant, tool call, tool result, permission
//! decision, and turn state rows. Token usage, system notes, and WorkHub
//! coordination rows stay JSON in [`StoredMessage::Other`].

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use crate::serde_util::{is_false, present};
use crate::{MessageContent, PermissionDecision};

/// One durable transcript row.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum StoredMessage {
    User(UserMessage),
    Assistant(AssistantMessage),
    ToolCall(ToolCallMessage),
    ToolResult(ToolResultMessage),
    PermissionDecision(PermissionDecisionMessage),
    TurnState(TurnStateMessage),
    /// `token_usage`, `system_note`, `workhub_coordination`, or a row type
    /// this client does not know, kept verbatim.
    Other(Value),
}

impl StoredMessage {
    /// The row's `type` literal.
    pub fn message_type(&self) -> &str {
        match self {
            Self::User(_) => "user",
            Self::Assistant(_) => "assistant",
            Self::ToolCall(_) => "tool_call",
            Self::ToolResult(_) => "tool_result",
            Self::PermissionDecision(_) => "permission_decision",
            Self::TurnState(_) => "turn_state",
            Self::Other(value) => value.get("type").and_then(Value::as_str).unwrap_or_default(),
        }
    }

    /// The row id (for a tool call, the `toolUseId`).
    pub fn id(&self) -> &str {
        match self {
            Self::User(message) => &message.id,
            Self::Assistant(message) => &message.id,
            Self::ToolCall(message) => &message.id,
            Self::ToolResult(message) => &message.id,
            Self::PermissionDecision(message) => &message.id,
            Self::TurnState(message) => &message.id,
            Self::Other(value) => value.get("id").and_then(Value::as_str).unwrap_or_default(),
        }
    }

    /// The Turn the row belongs to. Every current row type carries one.
    pub fn turn_id(&self) -> Option<&str> {
        match self {
            Self::User(message) => Some(&message.turn_id),
            Self::Assistant(message) => Some(&message.turn_id),
            Self::ToolCall(message) => Some(&message.turn_id),
            Self::ToolResult(message) => Some(&message.turn_id),
            Self::PermissionDecision(message) => Some(&message.turn_id),
            Self::TurnState(message) => Some(&message.turn_id),
            Self::Other(value) => value.get("turnId").and_then(Value::as_str),
        }
    }

    /// Wall-clock milliseconds on the Host.
    pub fn ts(&self) -> Option<u64> {
        match self {
            Self::User(message) => Some(message.ts),
            Self::Assistant(message) => Some(message.ts),
            Self::ToolCall(message) => Some(message.ts),
            Self::ToolResult(message) => Some(message.ts),
            Self::PermissionDecision(message) => Some(message.ts),
            Self::TurnState(message) => Some(message.ts),
            Self::Other(value) => value.get("ts").and_then(Value::as_u64),
        }
    }
}

impl Serialize for StoredMessage {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::Error as _;
        let payload = match self {
            Self::User(message) => serde_json::to_value(message),
            Self::Assistant(message) => serde_json::to_value(message),
            Self::ToolCall(message) => serde_json::to_value(message),
            Self::ToolResult(message) => serde_json::to_value(message),
            Self::PermissionDecision(message) => serde_json::to_value(message),
            Self::TurnState(message) => serde_json::to_value(message),
            Self::Other(value) => return value.serialize(serializer),
        }
        .map_err(S::Error::custom)?;
        let Value::Object(fields) = payload else {
            return Err(S::Error::custom("stored message did not encode as an object"));
        };
        let mut tagged = serde_json::Map::new();
        tagged.insert("type".to_owned(), Value::from(self.message_type()));
        tagged.extend(fields);
        tagged.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for StoredMessage {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut value = Value::deserialize(deserializer)?;
        let Some(kind) = value.get("type").and_then(Value::as_str).map(str::to_owned) else {
            return Err(D::Error::custom("stored message has no string `type`"));
        };
        fn payload<T: for<'a> Deserialize<'a>, E: serde::de::Error>(
            mut value: Value,
            kind: &str,
        ) -> Result<T, E> {
            if let Some(fields) = value.as_object_mut() {
                fields.remove("type");
            }
            serde_json::from_value(value)
                .map_err(|error| E::custom(format!("stored `{kind}` message: {error}")))
        }
        Ok(match kind.as_str() {
            "user" => Self::User(payload(value, &kind)?),
            "assistant" => Self::Assistant(payload(value, &kind)?),
            "tool_call" => Self::ToolCall(payload(value, &kind)?),
            "tool_result" => Self::ToolResult(payload(value, &kind)?),
            "permission_decision" => Self::PermissionDecision(payload(value, &kind)?),
            "turn_state" => Self::TurnState(payload(value, &kind)?),
            _ => {
                // Keep unknown rows intact, including their `type`.
                if let Some(fields) = value.as_object_mut() {
                    fields.entry("type").or_insert_with(|| Value::from(kind));
                }
                Self::Other(value)
            }
        })
    }
}

/// `UserMessage` (`USER_MESSAGE_SHAPE`). The content fields are inlined on the
/// wire; [`UserMessage::content`] reassembles them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct UserMessage {
    /// For the message that opened a Turn through `turn.start`, the Turn id.
    pub id: String,
    pub turn_id: String,
    pub ts: u64,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory_references: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quotes: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inline_references: Option<Vec<Value>>,
    /// Set on a mid-Turn steering message: the RuntimeEvent that admitted it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steering_event_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordination_action_id: Option<String>,
    /// `TurnOrigin`: set when the Host, not a person, authored the message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<Value>,
}

impl UserMessage {
    /// The message content.
    pub fn content(&self) -> MessageContent {
        let mut content = MessageContent::text(self.text.clone());
        content.display_text = self.display_text.clone();
        content.attachments = self.attachments.clone();
        content.directory_references = self.directory_references.clone();
        content.quotes = self.quotes.clone();
        content.inline_references = self.inline_references.clone();
        content
    }

    /// `userFacingText`.
    pub fn user_facing_text(&self) -> &str {
        self.display_text.as_deref().unwrap_or(&self.text)
    }
}

wire_enum! {
    /// `AssistantStepContentKind`.
    pub enum AssistantStepContentKind {
        Thinking = "thinking",
        Text = "text",
        Tools = "tools",
    }
}

/// `AssistantMessage` (`ASSISTANT_MESSAGE_SHAPE`): one assistant step.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct AssistantMessage {
    /// The step id; tool calls of this step carry it as `stepId`.
    pub id: String,
    pub turn_id: String,
    pub ts: u64,
    pub text: String,
    /// `interrupted?: true`: the step was cut off by a stop.
    #[serde(default, skip_serializing_if = "is_false")]
    pub interrupted: bool,
    /// `AssistantThinking`: `{"text": …}` as a real Host writes it (see
    /// `fixtures/sequences/reasoning.jsonl`); read it with
    /// [`AssistantMessage::thinking_text`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<Value>,
    /// First-observed order of this step's content. Absent on legacy rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_order: Option<Vec<AssistantStepContentKind>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<Value>,
    pub model_id: String,
}

impl AssistantMessage {
    /// The reasoning text, when the step has one.
    pub fn thinking_text(&self) -> Option<&str> {
        self.thinking.as_ref()?.get("text")?.as_str().filter(|text| !text.is_empty())
    }
}

/// `ToolCallMessage` (`TOOL_CALL_MESSAGE_SHAPE`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ToolCallMessage {
    /// Equals the `toolUseId`.
    pub id: String,
    pub turn_id: String,
    pub ts: u64,
    pub tool_name: String,
    /// `ToolActivityKind` (`TOOL_ACTIVITY_KINDS` in `packages/core/src/events.ts`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
    /// The full call arguments. Required by the TS shape but typed `unknown`,
    /// so an explicit `null` is preserved.
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub args: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_executed: Option<bool>,
    /// The assistant step (an `AssistantMessage.id`) this call belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
    /// `provider` or `code_mode`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    /// `visible` or `hidden`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_visibility: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_operation_id: Option<String>,
}

/// `ToolResultMessage` (`TOOL_RESULT_MESSAGE_SHAPE`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ToolResultMessage {
    /// The row's own id, not the Tool's.
    pub id: String,
    pub turn_id: String,
    pub ts: u64,
    /// Matches [`ToolCallMessage::id`].
    pub tool_use_id: String,
    pub is_error: bool,
    /// `ToolResultContent` (`packages/core/src/events.ts`), discriminated by
    /// `kind`: `text`, `json`, `file_diff`, `file_write`, `shell_run`, …
    pub content: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_executed: Option<bool>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub provider_output: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_visibility: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_operation_id: Option<String>,
}

impl ToolResultMessage {
    /// The `kind` of the result content.
    pub fn content_kind(&self) -> Option<&str> {
        self.content.get("kind").and_then(Value::as_str)
    }

    /// The text of a `text` result.
    pub fn text(&self) -> Option<&str> {
        (self.content_kind() == Some("text")).then(|| self.content.get("text")?.as_str())?
    }
}

/// `PermissionDecisionMessage` (`PERMISSION_DECISION_MESSAGE_SHAPE`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct PermissionDecisionMessage {
    /// The permission request id; for a Host interaction, the interaction id.
    pub id: String,
    pub turn_id: String,
    pub ts: u64,
    pub tool_use_id: String,
    pub tool_name: String,
    pub decision: PermissionDecision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remember_for_turn: Option<bool>,
    /// `user` or `auto_review`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

wire_enum! {
    /// `TURN_STATUSES` (`packages/core/src/session.ts`): the durable Turn
    /// status, which differs from the live [`crate::TurnRunStatus`].
    pub enum TurnStatus {
        Running = "running",
        Completed = "completed",
        Aborted = "aborted",
        Failed = "failed",
    }
}

/// `TurnStateMessage` (`TURN_STATE_MESSAGE_SHAPE`). The latest one of a Turn
/// is its recorded status (`deriveTurnRecords` in session.ts).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct TurnStateMessage {
    /// For a terminal state, the Turn snapshot's `terminalEventId`.
    pub id: String,
    pub turn_id: String,
    pub ts: u64,
    pub status: TurnStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retried_from_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub regenerated_from_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_of_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aborted_at: Option<u64>,
    /// For example `renderer.stop_button`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub abort_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_class: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_message: Option<String>,
    /// `ModelRetryDecision`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn round_trip(value: Value) -> StoredMessage {
        let message: StoredMessage = serde_json::from_value(value.clone()).expect("decode");
        assert_eq!(serde_json::to_value(&message).expect("encode"), value);
        message
    }

    #[test]
    fn user_rows_reassemble_content() {
        let message = round_trip(json!({
            "type": "user", "id": "t1", "turnId": "t1", "ts": 1, "text": "hi", "displayText": "Hi!"
        }));
        let StoredMessage::User(user) = message else { panic!("expected user") };
        assert_eq!(user.user_facing_text(), "Hi!");
        assert_eq!(user.content().text, "hi");
    }

    #[test]
    fn tool_rows_decode() {
        let call = round_trip(json!({
            "type": "tool_call", "id": "call_1", "turnId": "t", "ts": 2, "toolName": "Bash",
            "args": {"command": "ls"}, "stepId": "step-1"
        }));
        assert_eq!(call.id(), "call_1");
        let result = round_trip(json!({
            "type": "tool_result", "id": "r1", "turnId": "t", "ts": 3, "toolUseId": "call_1",
            "isError": false, "content": {"kind": "text", "text": "a\nb"}, "durationMs": 7
        }));
        let StoredMessage::ToolResult(result) = result else { panic!("expected result") };
        assert_eq!(result.text(), Some("a\nb"));
    }

    #[test]
    fn explicit_null_args_survive() {
        round_trip(json!({
            "type": "tool_call", "id": "c", "turnId": "t", "ts": 2, "toolName": "X", "args": null
        }));
    }

    #[test]
    fn assistant_and_turn_state_rows_decode() {
        let assistant = round_trip(json!({
            "type": "assistant", "id": "a1", "turnId": "t", "ts": 4, "text": "done",
            "interrupted": true, "contentOrder": ["text", "tools"], "modelId": "m"
        }));
        assert!(matches!(assistant, StoredMessage::Assistant(ref a) if a.interrupted));
        let state = round_trip(json!({
            "type": "turn_state", "id": "e1", "turnId": "t", "ts": 5, "status": "aborted",
            "abortSource": "renderer.stop_button"
        }));
        assert!(
            matches!(state, StoredMessage::TurnState(ref s) if s.status == TurnStatus::Aborted)
        );
    }

    #[test]
    fn other_rows_are_kept() {
        let message = round_trip(json!({
            "type": "token_usage", "id": "u", "turnId": "t", "ts": 6, "input": 1, "output": 2
        }));
        assert_eq!(message.message_type(), "token_usage");
        assert_eq!(message.turn_id(), Some("t"));
        assert_eq!(message.ts(), Some(6));
    }
}
