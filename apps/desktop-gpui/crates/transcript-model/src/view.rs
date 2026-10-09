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

//! What the UI renders: turns and their items.
//!
//! These mirror `TurnViewModel` and `TurnTimelineItem` in
//! `packages/ui/src/materialize.ts`, reduced to the MVP. Two deliberate
//! differences: the Turn's opening user message is the first item (TS keeps
//! it in a separate `user` field), and Tool items are never grouped (TS
//! merges adjacent Tools into one `tools` entry; grouping is presentation).

use std::fmt;

use host_protocol::{
    InteractionClosureReason, InteractionRequest, MessageContent, PermissionDecision,
    SandboxBoundaryStatus, TurnProviderRetry,
};
use serde_json::Value;

/// One Turn of the transcript.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct TurnView {
    pub turn_id: String,
    pub status: TurnViewStatus,
    /// Present for a failed Turn.
    pub failure: Option<TurnFailure>,
    /// Ordered, each with a stable [`ItemKey`].
    pub items: Vec<TurnItem>,
    /// Host wall-clock milliseconds of the Turn's earliest row.
    pub started_at: u64,
    /// The model of the Turn's latest assistant step.
    pub model_id: Option<String>,
    /// The provider request the live root Turn retries, from the continuity
    /// snapshot; the Host clears it once the Turn produces content again.
    pub provider_retry: Option<TurnProviderRetry>,
}

impl TurnView {
    /// The item with `key`.
    pub fn item(&self, key: &ItemKey) -> Option<&TurnItem> {
        self.items.iter().find(|item| &item.key() == key)
    }

    /// Whether the Turn has ended.
    pub fn is_finished(&self) -> bool {
        self.status.is_terminal()
    }
}

/// A Turn's status. The live root Turn's status comes from the continuity
/// snapshot (`TurnRunStatus`); any other Turn's from its latest durable
/// `turn_state` row (`TurnStatus`), as `deriveTurnRecords` reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum TurnViewStatus {
    /// Admitted, created, or running.
    Running,
    /// Blocked on an interaction.
    WaitingForUser,
    Completed,
    Failed,
    /// Stopped (`cancelled` live, `aborted` durable).
    Cancelled,
}

impl TurnViewStatus {
    /// Completed, failed, or cancelled.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

/// Why a Turn failed.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct TurnFailure {
    /// For example `auth`.
    pub class: String,
    /// Host-redacted, at most 256 bytes.
    pub message: Option<String>,
}

/// The stable identity of an item within its Turn. Derive element ids from
/// this, never from the item's position.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[non_exhaustive]
pub enum ItemKey {
    /// A user message, by message id.
    User(String),
    /// An assistant step's text, by step (message) id.
    Text(String),
    /// An assistant step's reasoning, by step (message) id.
    Thinking(String),
    /// A Tool invocation, by `toolUseId`.
    Tool(String),
    /// An interaction, by interaction id.
    Interaction(String),
}

impl ItemKey {
    /// The id without its kind.
    pub fn id(&self) -> &str {
        match self {
            Self::User(id)
            | Self::Text(id)
            | Self::Thinking(id)
            | Self::Tool(id)
            | Self::Interaction(id) => id,
        }
    }
}

impl fmt::Display for ItemKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let kind = match self {
            Self::User(_) => "user",
            Self::Text(_) => "text",
            Self::Thinking(_) => "thinking",
            Self::Tool(_) => "tool",
            Self::Interaction(_) => "interaction",
        };
        write!(f, "{kind}:{}", self.id())
    }
}

/// One entry of a Turn.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum TurnItem {
    User(UserItem),
    Text(TextItem),
    Thinking(ThinkingItem),
    Tool(ToolItem),
    Interaction(InteractionItem),
}

impl TurnItem {
    /// The item's stable key.
    pub fn key(&self) -> ItemKey {
        match self {
            Self::User(item) => ItemKey::User(item.message_id.clone()),
            Self::Text(item) => ItemKey::Text(item.message_id.clone()),
            Self::Thinking(item) => ItemKey::Thinking(item.message_id.clone()),
            Self::Tool(item) => ItemKey::Tool(item.tool_use_id.clone()),
            Self::Interaction(item) => ItemKey::Interaction(item.interaction_id.clone()),
        }
    }
}

/// A user message: the Turn's prompt, or a steering message sent mid-Turn.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct UserItem {
    pub message_id: String,
    pub content: MessageContent,
    pub ts: Option<u64>,
    /// Set by the Host when it, not a person, authored the message (`TurnOrigin`).
    pub host_origin: Option<Value>,
}

impl UserItem {
    /// The text to show (`displayText ?? text`).
    pub fn text(&self) -> &str {
        self.content.user_facing_text()
    }
}

/// An assistant step's text.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct TextItem {
    /// The step (assistant message) id.
    pub message_id: String,
    /// Markdown.
    pub text: String,
    /// Still streaming: more text may arrive.
    pub streaming: bool,
    /// The step was cut off by a stop; show an interruption divider.
    pub interrupted: bool,
    /// The display was capped (`ASSISTANT_MAX_TOTAL_CHARS` or a per-delta cap).
    pub truncated: bool,
    /// Host wall-clock milliseconds of the durable row.
    pub ts: Option<u64>,
}

/// An assistant step's reasoning (a `thinking` timeline entry in
/// `materialize.ts`), never mixed into its text. Adjacent blocks are not
/// merged (TS joins them with a blank line); each keeps its step's key.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ThinkingItem {
    /// The step (assistant message) id.
    pub message_id: String,
    /// Plain text.
    pub text: String,
    /// Still streaming: more reasoning may arrive.
    pub streaming: bool,
    /// The earliest reasoning was cut to keep the most recent
    /// ([`crate::THINKING_MAX_TOTAL_UNITS`]).
    pub truncated: bool,
}

/// `ToolActivityStatus` (`packages/core/src/tool-result-status.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum ToolStatus {
    Running,
    Completed,
    Errored,
    /// Stopped by the user or the system; not a Tool failure.
    Interrupted,
}

impl ToolStatus {
    /// `isInFlightToolStatus`.
    pub fn is_in_flight(self) -> bool {
        self == Self::Running
    }
}

/// A Tool invocation (`ToolActivityItem`).
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct ToolItem {
    pub tool_use_id: String,
    /// `Tool` when only a live event without a name has been seen.
    pub tool_name: String,
    pub display_name: Option<String>,
    /// `ToolActivityKind`: `read`, `edit`, `command`, …
    pub activity_kind: Option<String>,
    /// Model-authored intent.
    pub intent: Option<String>,
    /// Full arguments, from the durable `tool_call` row.
    pub args: Option<Value>,
    /// Bounded live preview of the arguments; show `args` when present.
    pub args_preview: Option<Value>,
    /// The assistant step the call belongs to.
    pub step_id: Option<String>,
    pub status: ToolStatus,
    /// `ToolResultContent` from the durable `tool_result` row; live results
    /// carry no content.
    pub result: Option<Value>,
    pub duration_ms: Option<u64>,
    /// Live output, ordered by `seq`, duplicates dropped.
    pub output: Vec<ToolOutputChunk>,
}

impl ToolItem {
    /// The arguments to display: the full ones when known, else the preview.
    pub fn display_args(&self) -> Option<&Value> {
        self.args.as_ref().or(self.args_preview.as_ref())
    }

    /// The text of a `text` result.
    pub fn result_text(&self) -> Option<&str> {
        let result = self.result.as_ref()?;
        (result.get("kind")?.as_str()? == "text").then(|| result.get("text")?.as_str())?
    }
}

/// One live output chunk (`ToolOutputChunk` in `materialize.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ToolOutputChunk {
    pub seq: u64,
    /// `stdout` or `stderr`.
    pub stream: String,
    pub text: String,
    /// The runtime suppressed a secret in this chunk.
    pub redacted: bool,
}

/// A prompt the Turn raised: a permission request, a question, a sandbox
/// boundary, or a kind the MVP does not render. Placed right after the Tool
/// it is about, or at the end of the Turn when it names none.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct InteractionItem {
    pub interaction_id: String,
    pub tool_use_id: Option<String>,
    /// The Tool the prompt is about, when known.
    pub tool_name: Option<String>,
    /// The request, when this client saw it pending. History rows
    /// (`permission_decision`) carry only the decision.
    pub request: Option<InteractionRequest>,
    pub state: InteractionState,
}

impl InteractionItem {
    /// Whether the prompt still waits for an answer.
    pub fn is_pending(&self) -> bool {
        self.state == InteractionState::Pending
    }
}

/// Where an interaction stands.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum InteractionState {
    /// Waiting for an answer; answer it with `interaction.answer`.
    Pending,
    Resolved(Resolution),
}

/// How an interaction ended.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum Resolution {
    Permission {
        decision: PermissionDecision,
        remember_for_turn: bool,
    },
    Question {
        answers: Vec<Option<String>>,
    },
    /// `InteractionCanonicalSandboxBoundaryOutcome`: `status` says whether an
    /// allowed expansion was applied (`approved`) or not (`conflict`).
    SandboxBoundary {
        decision: PermissionDecision,
        status: SandboxBoundaryStatus,
    },
    Closed(InteractionClosureReason),
    /// An outcome kind the MVP does not render (form, client capability).
    Other,
    /// It left the pending set, but this client has not seen the outcome
    /// (another client answered, or the Turn ended).
    Unknown,
}
