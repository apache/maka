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

use maka_agent_facts::attachment::AttachmentRef;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::input::DirectoryReference;
use maka_agent_facts::input::InlineReference;
use maka_agent_facts::input::QuoteRef;
use maka_agent_facts::tool_call::ToolOrigin;
pub use maka_agent_facts::tool_call::tool_use_id as tool_message_id;
use serde::Serialize;
use serde_json::Value;
pub(crate) fn timestamp(
    event: &maka_agent_facts::event::RuntimeEvent,
) -> Result<u64, crate::ProjectionError> {
    capture_time(event.recorded_at)
}

pub(crate) fn capture_time(
    recorded_at: std::time::SystemTime,
) -> Result<u64, crate::ProjectionError> {
    recorded_at
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|time| u64::try_from(time.as_millis()).ok())
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or(crate::ProjectionError::OutOfRange)
}
impl ToolMetadata {
    pub(crate) fn from_origin(
        origin: &ToolOrigin,
        invocation: &str,
    ) -> Result<Self, crate::ProjectionError> {
        match origin {
            ToolOrigin::Provider { .. } => Ok(Self::Provider {
                model_visibility: Visible::Visible,
            }),
            ToolOrigin::CodeMode {
                parent_operation_id,
                ..
            }
            | ToolOrigin::CodeCell {
                parent_operation_id,
                ..
            } => Ok(Self::CodeMode {
                model_visibility: Hidden::Hidden,
                parent_tool_call_id: tool_message_id(invocation, parent_operation_id),
                parent_operation_id: parent_operation_id.clone(),
            }),
            ToolOrigin::HostSdk { parent, .. } => Ok(Self::HostSdk {
                model_visibility: Hidden::Hidden,
                parent_tool_call_id: parent
                    .as_ref()
                    .map(|parent| tool_message_id(invocation, parent.operation_id())),
                parent_operation_id: parent
                    .as_ref()
                    .map(|parent| parent.operation_id().to_owned()),
            }),
            ToolOrigin::Standalone => Err(crate::ProjectionError::Unsupported(
                "standalone tool presentation",
            )),
        }
    }
}

/// Outbound core StoredMessage vocabulary currently produced by the text runtime.
/// This is a presentation value, never a model-history or execution authority.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub turn_id: String,
    pub ts: u64,
    #[serde(flatten)]
    pub content: Content,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Content {
    ContextCompacted {
        duration_ms: u64,
    },
    ModelInterruption {
        message: String,
    },
    SystemNote {
        kind: ImportedNoteKind,
        data: ImportedNote,
    },
    User {
        #[serde(skip_serializing_if = "Option::is_none")]
        origin: Option<maka_agent_facts::message::MessageOrigin>,
        text: String,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        imported: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        display_text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        attachments: Option<Vec<AttachmentRef>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        quotes: Option<Vec<QuoteRef>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        directory_references: Option<Vec<DirectoryReference>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        inline_references: Option<Vec<InlineReference>>,
    },
    Assistant {
        text: String,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        imported: bool,
        model_id: String,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        interrupted: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        thinking: Option<Thinking>,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider_options: Option<Value>,
    },
    TokenUsage {
        input: u64,
        output: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        cache_read: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cache_creation: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reasoning: Option<u64>,
    },
    ToolCall {
        tool_name: String,
        args: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        step_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider_options: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider_executed: Option<bool>,
        #[serde(flatten)]
        metadata: ToolMetadata,
    },
    /// Display metadata admitted with a call whose model acceptance may already
    /// have produced its immutable tool_call row.
    ToolActivity {
        tool_use_id: String,
        tool_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<maka_agent_facts::display::Text>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        presentation: Option<String>,
    },
    ToolResult {
        tool_use_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        settlement: Option<maka_agent_facts::tool_call::ToolSettlement>,
        is_error: bool,
        content: ToolContent,
        #[serde(flatten)]
        metadata: ToolMetadata,
    },
    TurnState {
        #[serde(flatten)]
        state: TurnState,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ToolContent {
    Text {
        text: String,
    },
    Json {
        value: Value,
    },
    Operation {
        reply: Box<maka_agent_facts::tool_output::OperationReply>,
    },
    Image {
        #[serde(rename = "mimeType")]
        mime_type: String,
        #[serde(rename = "ref")]
        reference: maka_agent_facts::attachment::StorageRef,
    },
}
impl ToolContent {
    pub(crate) fn from_outcome(
        outcome: &maka_agent_facts::event::ToolOutcome,
        resolved: Option<&maka_agent_facts::tool_output::ToolOutput>,
    ) -> Result<(bool, Self), crate::ProjectionError> {
        use maka_agent_facts::event::ToolOutcome;
        use maka_agent_facts::tool_output::ToolOutput;
        Ok(match outcome {
            ToolOutcome::Succeeded { .. } => (
                false,
                match resolved.ok_or(crate::ProjectionError::Invalid(
                    "missing resolved tool output",
                ))? {
                    ToolOutput::Image(image) => Self::Image {
                        mime_type: image.mime_type.clone(),
                        reference: image.reference.clone(),
                    },
                    ToolOutput::Text(text) => Self::Text { text: text.clone() },
                    ToolOutput::Operation(reply) => Self::Operation {
                        reply: reply.clone(),
                    },
                    value => Self::Json {
                        value: value.to_json(),
                    },
                },
            ),
            ToolOutcome::Failed { message } | ToolOutcome::Unknown { message, .. } => (
                true,
                Self::Text {
                    text: message.clone(),
                },
            ),
        })
    }
}
pub(crate) fn message(
    event: &maka_agent_facts::event::RuntimeEvent,
    ts: u64,
    id: String,
    content: Content,
) -> Message {
    Message {
        id,
        turn_id: event.invocation.turn_id.clone(),
        ts,
        content,
    }
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "origin",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ToolMetadata {
    Imported {
        model_visibility: Hidden,
    },
    HostSdk {
        model_visibility: Hidden,
        #[serde(skip_serializing_if = "Option::is_none")]
        parent_tool_call_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        parent_operation_id: Option<String>,
    },
    Provider {
        model_visibility: Visible,
    },
    CodeMode {
        model_visibility: Hidden,
        parent_tool_call_id: String,
        parent_operation_id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportedNoteKind {
    Imported,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ImportedNote {
    pub text: String,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Visible {
    Visible,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Hidden {
    Hidden,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thinking {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<Value>,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum TurnState {
    Running,
    Completed,
    Failed {
        error_class: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        failure_message: Option<String>,
    },
    Aborted {
        abort_source: String,
        aborted_at: u64,
    },
}
impl TurnState {
    pub(crate) fn from_outcome(outcome: &InvocationOutcome, timestamp: u64) -> Option<Self> {
        Some(match outcome {
            InvocationOutcome::HandoffPaused { .. } => return None,
            InvocationOutcome::Completed | InvocationOutcome::ContextCompactFinished { .. } => {
                Self::Completed
            }
            InvocationOutcome::Failed { class, message, .. } => Self::Failed {
                error_class: class.clone(),
                failure_message: message.as_ref().map(|text| {
                    let mut end = text.len().min(256);
                    while !text.is_char_boundary(end) {
                        end -= 1;
                    }
                    text[..end].to_owned()
                }),
            },
            InvocationOutcome::Cancelled { source } => Self::Aborted {
                abort_source: source.clone(),
                aborted_at: timestamp,
            },
        })
    }
}
