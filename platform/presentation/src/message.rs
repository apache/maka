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
use maka_agent_facts::durable::{AgentStepLink, ModelAttemptId, RunId, StepId};
use maka_agent_facts::event::RunOutcome;
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
        run: RunId,
    ) -> Result<Self, crate::ProjectionError> {
        match origin {
            ToolOrigin::Provider { link } if link.run != run => Err(
                crate::ProjectionError::Invalid("tool origin belongs to another Run"),
            ),
            ToolOrigin::Provider { .. } => Ok(Self::Provider {
                model_visibility: Visible::Visible,
            }),
            ToolOrigin::CodeMode {
                cell,
                owner,
                parent_operation_id,
                ..
            } => {
                match owner {
                    maka_agent_facts::cells::CellOwner::Agent { link, .. } if link.run == run => {}
                    _ => {
                        return Err(crate::ProjectionError::Invalid(
                            "cell origin does not belong to this Agent Run",
                        ));
                    }
                }
                Ok(Self::CodeMode {
                    cell: *cell,
                    owner: owner.clone(),
                    model_visibility: Hidden::Hidden,
                    parent_tool_call_id: tool_message_id(run, parent_operation_id),
                    parent_operation_id: parent_operation_id.clone(),
                })
            }
            ToolOrigin::CodeCell {
                cell,
                owner,
                parent_operation_id,
                ..
            } => {
                match owner {
                    maka_agent_facts::cells::CellOwner::Agent { link, .. } if link.run == run => {}
                    _ => {
                        return Err(crate::ProjectionError::Invalid(
                            "cell origin does not belong to this Agent Run",
                        ));
                    }
                }
                Ok(Self::CodeCell {
                    cell: *cell,
                    owner: owner.clone(),
                    model_visibility: Hidden::Hidden,
                    parent_tool_call_id: tool_message_id(run, parent_operation_id),
                    parent_operation_id: parent_operation_id.clone(),
                })
            }
            ToolOrigin::External {
                task,
                operation,
                package_id,
                entry_id,
                activation,
            } => Ok(Self::External {
                task: *task,
                operation: *operation,
                package_id: package_id.clone(),
                entry_id: entry_id.clone(),
                activation: activation.clone(),
                model_visibility: Hidden::Hidden,
            }),
            ToolOrigin::HostSdk { parent, .. } => Ok(Self::HostSdk {
                model_visibility: Hidden::Hidden,
                parent_tool_call_id: parent
                    .as_ref()
                    .map(|parent| tool_message_id(run, parent.operation_id())),
                parent_operation_id: parent
                    .as_ref()
                    .map(|parent| parent.operation_id().to_owned()),
            }),
            ToolOrigin::Standalone => Ok(Self::Standalone {
                model_visibility: Hidden::Hidden,
            }),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelIdentity {
    pub step_id: StepId,
    pub attempt_id: ModelAttemptId,
}
impl From<AgentStepLink> for ModelIdentity {
    fn from(link: AgentStepLink) -> Self {
        Self {
            step_id: link.step,
            attempt_id: link.attempt,
        }
    }
}

/// Outbound core StoredMessage vocabulary currently produced by the text runtime.
/// This is a presentation value, never a model-history or execution authority.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub run_id: RunId,
    #[serde(flatten)]
    pub model: Option<ModelIdentity>,
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
        anchor_message_id: Option<String>,
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
        /// Images the model received beside non-image content, such as Computer
        /// Use screenshots, so the transcript can show what the model saw.
        #[serde(skip_serializing_if = "Vec::is_empty")]
        images: Vec<ToolImage>,
        #[serde(flatten)]
        metadata: ToolMetadata,
    },
    ToolOperationObserved {
        tool_use_id: String,
        observation: Box<maka_plugin_core::operation::OperationReply>,
    },
    ToolNotification {
        tool_use_id: String,
        text: String,
        model_text: String,
    },
    ToolYielded {
        tool_use_id: String,
    },
    RunState {
        #[serde(flatten)]
        state: RunState,
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
            ToolOutcome::Succeeded { is_error, .. } => (
                *is_error,
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
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ToolImage {
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(rename = "ref")]
    pub reference: maka_agent_facts::attachment::StorageRef,
}
impl ToolImage {
    /// The model projection's images this Session owns, other than the content image.
    /// Only those can be served by index, so the transcript never counts others.
    pub(crate) fn from_projection(
        session: &str,
        outcome: &maka_agent_facts::event::ToolOutcome,
        content: &ToolContent,
    ) -> Vec<Self> {
        use maka_agent_facts::attachment::StorageRef;
        use maka_agent_facts::event::ToolOutcome;
        use maka_agent_facts::tool_output::{DurableToolProjection, ProjectionPart};
        let ToolOutcome::Succeeded {
            model_projection: DurableToolProjection::Content { parts },
            ..
        } = outcome
        else {
            return Vec::new();
        };
        let shown = match content {
            ToolContent::Image { reference, .. } => Some(reference),
            _ => None,
        };
        parts
            .iter()
            .filter_map(|part| match part {
                ProjectionPart::Artifact { image }
                    if Some(&image.reference) != shown
                        && matches!(&image.reference,
                            StorageRef::SessionFile { session_id, .. } if session_id == session) =>
                {
                    Some(Self {
                        mime_type: image.mime_type.clone(),
                        reference: image.reference.clone(),
                    })
                }
                _ => None,
            })
            .collect()
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
        run_id: event.execution.run_id,
        model: None,
        turn_id: event.execution.turn_id.clone(),
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
    External {
        task: maka_agent_facts::durable::ExternalTaskId,
        operation: uuid::Uuid,
        package_id: String,
        entry_id: String,
        activation: String,
        model_visibility: Hidden,
    },
    Standalone {
        model_visibility: Hidden,
    },
    CodeCell {
        cell: maka_agent_facts::cells::CellId,
        owner: maka_agent_facts::cells::CellOwner,
        model_visibility: Hidden,
        parent_tool_call_id: String,
        parent_operation_id: String,
    },
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
        cell: maka_agent_facts::cells::CellId,
        owner: maka_agent_facts::cells::CellOwner,
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
pub enum RunState {
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
impl RunState {
    pub(crate) fn from_outcome(outcome: &RunOutcome, timestamp: u64) -> Option<Self> {
        Some(match outcome {
            RunOutcome::Completed | RunOutcome::ContextCompactFinished { .. } => Self::Completed,
            RunOutcome::Failed { class, message, .. } => Self::Failed {
                error_class: class.clone(),
                failure_message: message.as_ref().map(|text| {
                    let mut end = text.len().min(256);
                    while !text.is_char_boundary(end) {
                        end -= 1;
                    }
                    text[..end].to_owned()
                }),
            },
            RunOutcome::Cancelled { source } => Self::Aborted {
                abort_source: source.clone(),
                aborted_at: timestamp,
            },
        })
    }
}
