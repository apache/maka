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

use futures_util::future::BoxFuture;
use maka_agent_facts::attachment::AttachmentRef;
pub use maka_agent_facts::history::HistoryRowAddress as RowPosition;
pub use maka_agent_facts::history::{HistoryOrder, HistoryRowAddress};
use maka_capabilities::authorization::CommandError;
use maka_capabilities::call::Scope;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub use maka_agent_facts::message::EditableMessage;
pub use maka_agent_facts::session::CopyPurpose;

/// A bounded presentation preview; the original message remains in history.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentHistoryPrompt")]
pub struct Prompt {
    pub position: RowPosition,
    #[schemars(length(max = 4096))]
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CopySource {
    pub session_id: String,
    pub expected_revision: u64,
    pub purpose: CopyPurpose,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CopySession {
    pub source: CopySource,
    pub root: crate::execution::CreateRoot,
}
impl CopySession {
    pub fn validate(&self) -> Result<(), CommandError> {
        self.root
            .validate()
            .map_err(|error| CommandError::Invalid(error.to_string()))?;
        crate::name(&self.source.session_id)
            .map_err(|error| CommandError::Invalid(error.to_string()))?;
        if self.source.expected_revision == 0 || self.source.expected_revision >= 1 << 53 {
            return Err(CommandError::Invalid(
                "invalid source Session revision".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CopyResult {
    Committed {
        session: crate::execution::ChildSession,
    },
    SourceRevisionConflict {
        expected_revision: u64,
        actual_revision: u64,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourcesRead {
    pub session_id: String,
    pub turn_id: String,
}
impl SourcesRead {
    pub fn validate(&self) -> Result<(), CommandError> {
        for id in [&self.session_id, &self.turn_id] {
            crate::name(id).map_err(|_| CommandError::Invalid("invalid message source".into()))?;
        }
        Ok(())
    }
}

/// Copy an uploaded historical material into an independently authorized Session.
/// Identifiers locate content; the history call and destination capability grant access.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CopyMaterial {
    pub session_id: String,
    pub artifact_id: String,
    pub target_session_id: String,
}
impl CopyMaterial {
    pub fn validate(&self) -> Result<(), CommandError> {
        for id in [&self.session_id, &self.artifact_id, &self.target_session_id] {
            crate::name(id)
                .map_err(|_| CommandError::Invalid("invalid history material".into()))?;
        }
        Ok(())
    }
}

/// Tool output is available through source reads in both views. Conversation
/// windows carry tool metadata only, keeping large results out of chat paging.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HistoryView {
    #[default]
    Text,
    Conversation,
    /// Visible chat rows. Completed work can be read separately at the same fence.
    Chat,
    /// All conversation rows belonging to the live history Run at the anchor.
    Turn,
}

/// A readable field in a conversation window, in presentation order.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HistoryField {
    Thinking,
    #[default]
    Body,
}

/// Byte offset in one message field's UTF-8 text, not a bearer capability.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cursor {
    #[serde(default)]
    pub field: HistoryField,
    pub position: RowPosition,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub offset: u64,
}

/// Row reveals an exact field; Before/After continue at byte boundaries and
/// Event addresses the raw event log. Returned chunks retain ascending presentation
/// order, including a reverse window.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "HistoryPosition")]
pub enum Position {
    Start,
    Tail,
    /// Reveal this exact row field from its beginning, including empty tool rows.
    Row {
        position: RowPosition,
        field: HistoryField,
    },
    Before {
        cursor: Cursor,
    },
    After {
        cursor: Cursor,
    },
    /// Locate canonical output at an execution event, including sparse rows.
    Event {
        #[schemars(range(min = 1, max = 9_007_199_254_740_991u64))]
        sequence: u64,
    },
}

/// A stable raw-event fence prevents a window from chasing appended messages.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Read {
    pub session_id: String,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub through: Option<u64>,
    pub position: Position,
    #[serde(default)]
    pub include_thinking: bool,
}
impl Read {
    pub fn validate(&self) -> Result<(), CommandError> {
        let invalid = || CommandError::Invalid("invalid history read".into());
        crate::name(&self.session_id).map_err(|_| invalid())?;
        const MAX: u64 = 9_007_199_254_740_991;
        if self.through.is_some_and(|value| value > MAX) {
            return Err(invalid());
        }
        match &self.position {
            Position::Row { position, field } => {
                if self.through.is_none()
                    || position.validate().is_err()
                    || matches!(position, HistoryRowAddress::Live { sequence, .. } if self.through.is_some_and(|through| *sequence > through))
                    || (!self.include_thinking && *field == HistoryField::Thinking)
                {
                    return Err(invalid());
                }
            }
            Position::Before { cursor } | Position::After { cursor } => {
                if self.through.is_none()
                    || cursor.position.validate().is_err()
                    || matches!(&cursor.position, HistoryRowAddress::Live { sequence, .. } if self.through.is_some_and(|through| *sequence > through))
                    || cursor.offset > MAX
                    || (!self.include_thinking && cursor.field == HistoryField::Thinking)
                {
                    return Err(invalid());
                }
            }
            Position::Event { sequence }
                if *sequence == 0
                    || *sequence > MAX
                    || self.through.is_some_and(|through| *sequence > through) =>
            {
                return Err(invalid());
            }
            _ => {}
        }
        Ok(())
    }
}

/// Canonical message author/kind; the field identifies body versus thinking.
/// Tool body JSON contributes string values, never its keys.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    System,
    Context,
    Tool,
    Compaction,
    Failure,
    User,
    Assistant,
    ToolCall,
    ToolResult,
}
/// Canonical references at the requested fence, never execution authority.
/// Both references are present only for a unique same-Turn call/result pair
/// with matching origin and parentage. An unpaired row retains its own reference.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "HistoryTool")]
pub struct Tool {
    pub tool_use_id: String,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<ToolCall>")]
    pub call: Option<ToolCall>,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<ToolResult>")]
    pub result: Option<ToolResult>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "HistoryToolCall")]
pub struct ToolCall {
    /// Recorded ancestors in this Turn, nearest first; display references only.
    pub ancestor_tool_use_ids: Vec<String>,
    pub origin: ToolCallOrigin,
    /// Opaque display contract captured at dispatch; no execution authority.
    #[serde(default)]
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
    pub presentation: Option<Box<str>>,
    pub position: RowPosition,
    pub name: String,
    #[schemars(
        with = "maka_plugin_core::wire_schema::RequiredNullable<maka_agent_facts::display::Text>"
    )]
    pub title: Option<Box<maka_agent_facts::display::Text>>,
    /// This native Turn is still open at the history fence; not execution authority.
    pub pending: bool,
    /// A unique original Host dispatch is recorded at this fence; not liveness.
    pub dispatched: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_target: Option<Box<ExternalToolTarget>>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ExternalToolTarget {
    Command {
        command: String,
        cwd: Option<String>,
    },
    File {
        path: String,
    },
    Search {
        query: String,
    },
}
/// Who made a call: a model step, a script the model wrote, a tool's own work
/// through the Host SDK, or a foreign record.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "HistoryToolCallOrigin")]
pub enum ToolCallOrigin {
    Provider,
    Executor,
    CodeMode,
    HostSdk,
    Imported,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "HistoryToolResult")]
pub struct ToolResult {
    #[schemars(
        with = "maka_plugin_core::wire_schema::RequiredNullable<maka_agent_facts::tool_call::ToolSettlement>"
    )]
    pub settlement: Option<maka_agent_facts::tool_call::ToolSettlement>,
    pub position: RowPosition,
    /// A failed or unknown effect, or a returned result that reports failure.
    pub is_error: bool,
    /// Canonical content is an image; this does not grant artifact reads.
    pub image: bool,
    /// Images the model received beside non-image content, readable by index.
    pub images: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<maka_agent_facts::executor::ToolResultDetails>,
}

/// An explicitly selected canonical transcript field, never an execution grant.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceField {
    Body,
    Thinking,
    ToolName,
    FailureMessage,
    ErrorClass,
    Arguments,
    Result,
    /// The original service operation observation, separate from its returned value.
    Receipt,
    /// Immutable adapter metadata; never active model options or a grant.
    ProviderMetadata,
    /// Original imported producer record, not the public display/context projection.
    Original,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SourcePosition {
    Start,
    Tail,
    Before {
        #[schemars(range(max = 9_007_199_254_740_991u64))]
        offset: u64,
    },
    After {
        #[schemars(range(max = 9_007_199_254_740_991u64))]
        offset: u64,
    },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceFormat {
    Text,
    Json,
    ImageDescriptor,
}
/// Presentation role of the exact row. This carries no execution authority.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "HistorySourceRole")]
pub enum SourceRole {
    System,
    Context,
    Tool,
    User,
    Assistant,
    ToolCall,
    ToolResult,
    Failure,
}
/// A structural selector into an original JSON field. Keys and array indices
/// remain distinct; neither locates a filesystem resource nor grants access.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
#[schemars(rename = "HistorySourceSegment")]
pub enum SourceSegment {
    Key(String),
    Index(u32),
}

/// Model identity recorded for the exact historical assistant step.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HistoryModel {
    Native {
        requested_model_id: String,
        #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
        reported_model_id: Option<String>,
    },
    Imported {
        model_id: String,
    },
}

/// One literal UTF-8 excerpt of an immutable field. JSON excerpts need not be
/// standalone JSON. Image descriptors carry no artifact read authorization.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistorySource {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<HistoryModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<maka_agent_facts::message::MessageOrigin>,
    pub position: RowPosition,
    /// Host-recorded milliseconds of this immutable row; not a client clock.
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub timestamp: Option<u64>,
    pub role: SourceRole,
    /// Readable canonical fields of this same immutable row, in display order.
    #[schemars(length(min = 1))]
    pub fields: Vec<SourceField>,
    pub field: SourceField,
    /// Omission reads the encoded field. A selected JSON string is literal text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<Vec<SourceSegment>>,
    pub format: SourceFormat,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub offset: u64,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub total_bytes: u64,
    pub text: String,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<Tool>")]
    pub tool: Option<Tool>,
}
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelPartIdentity {
    pub step_id: maka_agent_facts::durable::StepId,
    pub attempt_id: maka_agent_facts::durable::ModelAttemptId,
    pub ordinal: u64,
}

/// Display preview only; the original input retains complete text and provenance.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryQuote {
    pub text: String,
    pub label: Option<String>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Chunk {
    pub imported_turn: Option<maka_agent_facts::history_snapshot::ImportedTurnOrdinal>,
    /// Chronological display anchor; position remains the source/read address.
    pub order: HistoryOrder,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_part: Option<ModelPartIdentity>,
    /// The original user input has quotes, directory references or inline references.
    /// Present only on the first fragment; display text cannot reconstruct these references.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub has_references: bool,
    /// Bounded quote display, present only on the first message fragment.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub quotes: Vec<HistoryQuote>,
    /// This body belongs to the final output of a successfully completed native
    /// Turn at the page's fence. Includes body text and source citations;
    /// absence does not establish liveness or identify an imported final answer.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub final_output: bool,
    /// The provider identified this text as final before the Turn completed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub final_answer: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<HistoryModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<maka_agent_facts::message::MessageOrigin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction: Option<Compaction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timing: Option<TurnTiming>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folded_work: Option<FoldedWork>,
    pub field: HistoryField,
    pub message_id: Option<String>,
    pub run_id: Option<maka_agent_facts::durable::RunId>,
    pub turn_id: Option<String>,
    pub timestamp: Option<u64>,
    pub role: Role,
    pub position: RowPosition,
    pub offset: u64,
    pub total_bytes: u64,
    pub text: String,
    /// Present on every tool fragment, including tools with no projected text.
    pub tool: Option<Tool>,
    /// User attachment descriptors, present only on the first chunk of a message.
    pub attachments: Vec<AttachmentRef>,
}

/// Completed activity available on demand at the same history fence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "HistoryFoldedWork")]
pub struct FoldedWork {
    pub thoughts: u64,
    pub tools: u64,
    pub messages: u64,
    pub image_count: u64,
    pub images: Vec<WorkImage>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "HistoryWorkImage")]
pub struct WorkImage {
    pub position: HistoryRowAddress,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<u32>,
}

/// Duration of a successfully adopted context checkpoint, in recorded milliseconds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "HistoryCompaction")]
pub struct Compaction {
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub duration_ms: u64,
}

/// Recorded logical Turn boundaries at the same history fence. An unfinished
/// historical boundary alone does not establish that execution is still live.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "HistoryTurnTiming")]
pub struct TurnTiming {
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub started_at: u64,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<TurnFinished>")]
    pub finished: Option<TurnFinished>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor_usage: Option<Box<maka_agent_facts::executor::TurnUsage>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_cache: Option<maka_agent_facts::model::PromptCacheUsage>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "HistoryTurnFinished")]
pub struct TurnFinished {
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub at: u64,
    pub outcome: TurnOutcome,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "HistoryTurnOutcome")]
pub enum TurnOutcome {
    Completed,
    Failed,
    Aborted,
}

/// Bounded windows expose exact byte boundaries in both directions.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Page {
    Ready {
        through: Option<u64>,
        chunks: Vec<Chunk>,
        before: Option<Cursor>,
        after: Option<Cursor>,
    },
}

/// Admitted Agent tools can recall this trusted Host profile's history.
/// Remote/background calls retain their actual principal's ReadHistory scope.
/// Every page rechecks current access and Session existence, including old fences.
pub trait History: Send + Sync {
    /// A new root with owned immutable history. Source read access does not grant
    /// destination creation; both capabilities and the source workspace are checked.
    fn copy_session(
        &self,
        call: Scope,
        target: Arc<dyn crate::execution::Commands>,
        input: CopySession,
    ) -> BoxFuture<'_, Result<CopyResult, CommandError>>;
    /// Ordered preparation-free opening sources of a Turn, not its aggregated UI row.
    /// Their identities and intent grant no execution authority.
    fn sources(
        &self,
        call: Scope,
        input: SourcesRead,
    ) -> BoxFuture<'_, Result<Vec<EditableMessage>, CommandError>>;
    fn list(
        &self,
        call: Scope,
        input: super::catalog::List,
    ) -> BoxFuture<'_, Result<super::catalog::Page, CommandError>>;
    fn read(&self, call: Scope, input: Read) -> BoxFuture<'_, Result<Page, CommandError>>;
    fn copy_material(
        &self,
        call: Scope,
        target: Arc<dyn crate::execution::Commands>,
        input: CopyMaterial,
    ) -> BoxFuture<'_, Result<AttachmentRef, CommandError>>;
}
