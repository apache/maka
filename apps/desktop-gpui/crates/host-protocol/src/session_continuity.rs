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

//! Session subscriptions: `subscription.open`, `subscription.ready`,
//! `subscription.close`, `subscription.pty_interest.set`, the continuity
//! snapshot, and every `subscription.*` push frame.
//!
//! Source: `packages/runtime-host/src/protocol/session-continuity.ts`
//! (`SESSION_CONTINUITY_OPERATION_SPECS`, `decodeSubscriptionOpenResult`,
//! `decodeSessionContinuitySnapshot`, `decodeSubscriptionFrame`,
//! `decodeAssistantDelta`, `decodeSessionToolEvent`,
//! `decodeSessionSteeringEvent`). Client-side ordering rules come from
//! `ClientSessionSubscription.accept` in
//! `packages/runtime-host/src/client/session-subscription.ts`.
//!
//! Lifecycle: `subscription.open` answers with a snapshot, `nextSequence`, and
//! an optional transcript tail. The Host holds the subscription's frames
//! until the client sends `subscription.ready`. Every frame except
//! `subscription.runtime_resource_pty_data` then carries `sequence`, starting
//! at `nextSequence` and increasing by one; a gap or a different `hostEpoch`
//! means the subscription must be reopened.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::serde_util::{is_false, present};
use crate::{
    MessageContent, Operation, RuntimeResourceInputError, SessionInteractionProjection,
    SessionMessageQueueProjection, SessionStatus, SessionTranscriptBootstrap, TurnSnapshot,
};

/// `SESSION_CONTINUITY_SCHEMA_VERSION`.
pub const SESSION_CONTINUITY_SCHEMA_VERSION: u32 = 5;

/// `SESSION_RUNTIME_RESOURCE_PTY_DATA_MAX_BYTES`: output the Host puts in one
/// PTY data frame. A larger chunk arrives as an empty frame with `reset`.
pub const SESSION_RUNTIME_RESOURCE_PTY_DATA_MAX_BYTES: usize = 48 * 1024;

/// The refs one `subscription.pty_interest.set` may name.
pub const PTY_INTEREST_MAX_REFS: usize = 16;

/// `SubscriptionOpenInput.transcript`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
pub enum TranscriptPolicy {
    /// No transcript access; `session.transcript.page` is refused.
    None,
    /// The newest rows up to `max_bytes` (2 to
    /// [`crate::SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES`]).
    #[serde(rename_all = "camelCase")]
    Tail { max_bytes: u64 },
}

/// `SubscriptionOpenInput` (`decodeSubscriptionOpenInput`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SubscriptionOpenInput {
    pub session_id: String,
    pub transcript: TranscriptPolicy,
}

impl SubscriptionOpenInput {
    /// Opens `session_id` with the largest transcript tail.
    pub fn with_tail(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            transcript: TranscriptPolicy::Tail {
                max_bytes: crate::SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
            },
        }
    }
}

/// `SubscriptionOpenResult` (`decodeSubscriptionOpenResult`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SubscriptionOpenResult {
    pub host_epoch: String,
    pub subscription_id: String,
    /// The `sequence` of the first frame this subscription will send.
    pub next_sequence: u64,
    pub snapshot: SessionContinuitySnapshot,
    /// Assistant messages of the live root Turn that are still streaming.
    pub active_assistant_streams: Vec<SessionAssistantStreamIdentity>,
    /// Present exactly when the input asked for `tail`.
    pub transcript: Option<SessionTranscriptBootstrap>,
}

/// `SubscriptionCloseInput`; also the input of `subscription.ready`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SubscriptionIdInput {
    pub subscription_id: String,
}

impl SubscriptionIdInput {
    /// Names `subscription_id`.
    pub fn new(subscription_id: impl Into<String>) -> Self {
        Self { subscription_id: subscription_id.into() }
    }
}

/// `SubscriptionCloseResult`; also the result of `subscription.ready`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SubscriptionIdResult {
    pub subscription_id: String,
}

/// `subscription.open` (mode `control`).
#[derive(Debug)]
pub enum SubscriptionOpen {}

impl Operation for SubscriptionOpen {
    const NAME: &'static str = "subscription.open";
    type Input = SubscriptionOpenInput;
    type Output = SubscriptionOpenResult;
}

/// `subscription.ready` (mode `control`): the client can take frames now.
/// Until it arrives the Host holds the subscription's frames, including an
/// in-flight answer of any size.
#[derive(Debug)]
pub enum SubscriptionReady {}

impl Operation for SubscriptionReady {
    const NAME: &'static str = "subscription.ready";
    type Input = SubscriptionIdInput;
    type Output = SubscriptionIdResult;
}

/// `subscription.close` (mode `control`).
#[derive(Debug)]
pub enum SubscriptionClose {}

impl Operation for SubscriptionClose {
    const NAME: &'static str = "subscription.close";
    type Input = SubscriptionIdInput;
    type Output = SubscriptionIdResult;
}

/// `subscription.pty_interest.set` input: the refs whose terminal output
/// this subscription receives as [`SessionRuntimeResourcePtyDataFrame`]s.
/// Each call replaces the whole set, and the Host drops queued output of refs
/// that left it (`SessionContinuityCoordinator`, `pty_interest.set` handler).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct PtyInterestInput {
    pub subscription_id: String,
    /// At most [`PTY_INTEREST_MAX_REFS`], no ref twice.
    pub refs: Vec<String>,
}

impl PtyInterestInput {
    /// Interest in `refs`; refused when there are more than
    /// [`PTY_INTEREST_MAX_REFS`] or one repeats.
    pub fn new(
        subscription_id: impl Into<String>,
        refs: Vec<String>,
    ) -> Result<Self, RuntimeResourceInputError> {
        let distinct = refs.iter().collect::<std::collections::HashSet<_>>().len();
        if refs.len() > PTY_INTEREST_MAX_REFS || distinct != refs.len() {
            return Err(RuntimeResourceInputError::PtyInterest);
        }
        Ok(Self { subscription_id: subscription_id.into(), refs })
    }
}

/// `subscription.pty_interest.set` (mode `control`). Answers
/// [`SubscriptionIdResult`]; `not_found` when the subscription is not this
/// connection's.
#[derive(Debug)]
pub enum SubscriptionPtyInterestSet {}

impl Operation for SubscriptionPtyInterestSet {
    const NAME: &'static str = "subscription.pty_interest.set";
    type Input = PtyInterestInput;
    type Output = SubscriptionIdResult;
}

/// `SessionContinuitySnapshot` (`decodeSessionContinuitySnapshot`), at most
/// 56 KiB encoded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionContinuitySnapshot {
    /// [`SESSION_CONTINUITY_SCHEMA_VERSION`].
    pub schema_version: u32,
    pub session: SessionContinuityIdentity,
    /// Positive; strictly increases with every projection frame.
    pub projection_revision: u64,
    /// The Session's latest root Turn, live or terminal; `null` before the
    /// first Turn.
    pub root_turn: Option<TurnSnapshot>,
    /// `GoalProjection` (`protocol/goal.ts`).
    pub goal: Option<Value>,
    pub queue: SessionMessageQueueProjection,
    pub interactions: SessionInteractionProjection,
}

/// `SessionContinuityIdentity` (`decodeSessionContinuityIdentity`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionContinuityIdentity {
    pub session_id: String,
    pub metadata_revision: u64,
    pub status: SessionStatus,
    pub created_at: u64,
    pub is_archived: bool,
}

wire_enum! {
    /// `SessionAssistantDelta.kind` / `SessionAssistantStreamIdentity.kind`.
    pub enum AssistantStreamKind {
        Text = "text",
        Thinking = "thinking",
    }
}

/// `SessionAssistantStreamIdentity`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionAssistantStreamIdentity {
    pub kind: AssistantStreamKind,
    pub turn_id: String,
    pub message_id: String,
}

wire_union! {
    /// `SubscriptionFrame`, decoded by `kind` (`decodeSubscriptionFrame`).
    /// Obtain one with [`crate::SubscriptionFrame::decode`].
    pub enum SessionFrame in "kind" {
        /// A new continuity snapshot. Boxed: it is much larger than the rest.
        Projection(Box<SessionProjectionFrame>) = "subscription.session_projection",
        /// Assistant text or reasoning streamed by the live root Turn.
        Delta(SessionDeltaFrame) = "subscription.session_delta",
        /// A Tool event or a steering message of the live root Turn. Boxed:
        /// Tool events are large.
        Event(Box<SessionEventFrame>) = "subscription.session_event",
        /// Durable transcript rows through a new watermark exist.
        TranscriptAdvanced(SessionTranscriptAdvancedFrame) = "subscription.transcript_advanced",
        /// A side domain (todo, plan, usage, runtime resource) changed.
        DomainChanged(SessionDomainChangedFrame) = "subscription.session_domain_changed",
        /// Terminal bytes. Unordered: carries no `sequence`.
        RuntimeResourcePtyData(SessionRuntimeResourcePtyDataFrame) = "subscription.runtime_resource_pty_data",
        /// The agent graph rooted at this Session changed.
        AgentGraphChanged(AgentGraphChangedFrame) = "subscription.agent_graph_changed",
        /// The Host ended the subscription.
        Closed(SubscriptionClosedFrame) = "subscription.closed",
    }
}

impl SessionFrame {
    /// The ordering sequence. `None` for PTY data, which is unordered, and
    /// for a frame kind this client does not know.
    pub fn sequence(&self) -> Option<u64> {
        match self {
            Self::Projection(frame) => Some(frame.sequence),
            Self::Delta(frame) => Some(frame.sequence),
            Self::Event(frame) => Some(frame.sequence),
            Self::TranscriptAdvanced(frame) => Some(frame.sequence),
            Self::DomainChanged(frame) => Some(frame.sequence),
            Self::AgentGraphChanged(frame) => Some(frame.sequence),
            Self::Closed(frame) => Some(frame.sequence),
            Self::RuntimeResourcePtyData(_) => None,
            Self::Unknown(value) => value.get("sequence").and_then(Value::as_u64),
        }
    }

    /// The Host epoch the frame belongs to.
    pub fn host_epoch(&self) -> Option<&str> {
        match self {
            Self::Projection(frame) => Some(&frame.host_epoch),
            Self::Delta(frame) => Some(&frame.host_epoch),
            Self::Event(frame) => Some(&frame.host_epoch),
            Self::TranscriptAdvanced(frame) => Some(&frame.host_epoch),
            Self::DomainChanged(frame) => Some(&frame.host_epoch),
            Self::RuntimeResourcePtyData(frame) => Some(&frame.host_epoch),
            Self::AgentGraphChanged(frame) => Some(&frame.host_epoch),
            Self::Closed(frame) => Some(&frame.host_epoch),
            Self::Unknown(value) => value.get("hostEpoch").and_then(Value::as_str),
        }
    }

    /// The subscription the frame belongs to.
    pub fn subscription_id(&self) -> Option<&str> {
        match self {
            Self::Projection(frame) => Some(&frame.subscription_id),
            Self::Delta(frame) => Some(&frame.subscription_id),
            Self::Event(frame) => Some(&frame.subscription_id),
            Self::TranscriptAdvanced(frame) => Some(&frame.subscription_id),
            Self::DomainChanged(frame) => Some(&frame.subscription_id),
            Self::RuntimeResourcePtyData(frame) => Some(&frame.subscription_id),
            Self::AgentGraphChanged(frame) => Some(&frame.subscription_id),
            Self::Closed(frame) => Some(&frame.subscription_id),
            Self::Unknown(value) => value.get("subscriptionId").and_then(Value::as_str),
        }
    }
}

/// `SessionProjectionFrame`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionProjectionFrame {
    pub host_epoch: String,
    pub subscription_id: String,
    pub sequence: u64,
    pub snapshot: SessionContinuitySnapshot,
}

/// `SessionDeltaFrame`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionDeltaFrame {
    pub host_epoch: String,
    pub subscription_id: String,
    pub sequence: u64,
    pub session_id: String,
    pub delta: SessionAssistantDelta,
}

/// `SessionAssistantDelta` (`decodeAssistantDelta`).
///
/// Offsets count UTF-16 code units, because the Host measures with
/// JavaScript string lengths. `text` is the slice starting at `start_offset`;
/// it may overlap text already received. `reset` restarts the message at
/// offset 0; `complete` closes it, possibly with empty `text`; `interrupted`
/// appears only together with `complete`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionAssistantDelta {
    pub kind: AssistantStreamKind,
    pub turn_id: String,
    pub run_id: String,
    pub message_id: String,
    pub start_offset: u64,
    /// At most 16 KiB of UTF-8 (`SESSION_LIVE_DELTA_MAX_BYTES`).
    pub text: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub reset: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub complete: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub interrupted: bool,
}

/// `SessionEventFrame`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionEventFrame {
    pub host_epoch: String,
    pub subscription_id: String,
    pub sequence: u64,
    pub session_id: String,
    pub run_id: String,
    pub event: SessionFrameEvent,
}

wire_union! {
    /// `SessionToolEvent | SessionSteeringEvent` (`decodeSessionFrameEvent`).
    pub enum SessionFrameEvent in "type" {
        ToolStart(SessionToolStart) = "tool_start",
        ToolOutputDelta(SessionToolOutputDelta) = "tool_output_delta",
        ToolProgress(SessionToolProgress) = "tool_progress",
        ToolResult(SessionToolResult) = "tool_result",
        ToolResultPreview(SessionToolResultPreview) = "tool_result_preview",
        /// A durable mid-Turn user message.
        SteeringMessage(SessionSteeringEvent) = "steering_message",
    }
}

impl SessionFrameEvent {
    /// The Turn the event belongs to.
    pub fn turn_id(&self) -> Option<&str> {
        match self {
            Self::ToolStart(event) => Some(&event.turn_id),
            Self::ToolOutputDelta(event) => Some(&event.turn_id),
            Self::ToolProgress(event) => Some(&event.turn_id),
            Self::ToolResult(event) => Some(&event.turn_id),
            Self::ToolResultPreview(event) => Some(&event.turn_id),
            Self::SteeringMessage(event) => Some(&event.turn_id),
            Self::Unknown(value) => value.get("turnId").and_then(Value::as_str),
        }
    }

    /// The Tool invocation a Tool event is about.
    pub fn tool_use_id(&self) -> Option<&str> {
        match self {
            Self::ToolStart(event) => Some(&event.tool_use_id),
            Self::ToolOutputDelta(event) => Some(&event.tool_use_id),
            Self::ToolProgress(event) => Some(&event.tool_use_id),
            Self::ToolResult(event) => Some(&event.tool_use_id),
            Self::ToolResultPreview(event) => Some(&event.tool_use_id),
            Self::SteeringMessage(_) => None,
            Self::Unknown(value) => value.get("toolUseId").and_then(Value::as_str),
        }
    }
}

/// `SessionToolEvent` of type `tool_start`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionToolStart {
    pub id: String,
    pub turn_id: String,
    pub ts: u64,
    pub tool_use_id: String,
    pub tool_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    /// `ToolActivityKind`: `read`, `edit`, `command`, `search`, …
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Model-authored call intent, at most 512 UTF-8 bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
    /// A bounded, redacted subset of the arguments (at most 8 KiB). The full
    /// arguments arrive with the durable `tool_call` row.
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub args_preview: Option<Value>,
    /// The assistant step this call belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_run_ref: Option<String>,
}

wire_enum! {
    /// `SessionToolEvent.stream` of `tool_output_delta`.
    pub enum ToolOutputStream {
        Stdout = "stdout",
        Stderr = "stderr",
    }
}

/// `SessionToolEvent` of type `tool_output_delta`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionToolOutputDelta {
    pub id: String,
    pub turn_id: String,
    pub ts: u64,
    pub tool_use_id: String,
    /// Monotonic per `tool_use_id`.
    pub seq: u64,
    pub stream: ToolOutputStream,
    pub chunk: String,
    /// The runtime suppressed a secret in this chunk.
    pub redacted: bool,
    pub created_at: u64,
}

/// `SessionToolEvent` of type `tool_progress`. `chunk` is an encoded
/// `ToolStepProgress` (`decodeToolStepProgress` in `packages/core/src/events.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionToolProgress {
    pub id: String,
    pub turn_id: String,
    pub ts: u64,
    pub tool_use_id: String,
    pub chunk: String,
}

wire_enum! {
    /// `SessionToolEvent.status` of `tool_result`.
    pub enum SessionToolResultStatus {
        Completed = "completed",
        Errored = "errored",
    }
}

/// `SessionToolEvent` of type `tool_result`. Carries no content: the result
/// body arrives with the durable `tool_result` row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionToolResult {
    pub id: String,
    pub turn_id: String,
    pub ts: u64,
    pub tool_use_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    pub status: SessionToolResultStatus,
    /// `sandbox_boundary_required` or `requires_bypass`; only when errored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_failure_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

/// `SessionToolEvent` of type `tool_result_preview`: live-only facts about a
/// running subagent (`ToolResultPreviewContent`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionToolResultPreview {
    pub id: String,
    pub turn_id: String,
    pub ts: u64,
    pub tool_use_id: String,
    pub is_error: bool,
    pub content: Value,
}

/// `SessionSteeringEvent`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionSteeringEvent {
    pub id: String,
    pub turn_id: String,
    pub ts: u64,
    pub message_id: String,
    pub content: MessageContent,
}

/// `SessionTranscriptAdvancedFrame`: rows through `through_sequence` can be
/// read with `session.transcript.page`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionTranscriptAdvancedFrame {
    pub host_epoch: String,
    pub subscription_id: String,
    pub sequence: u64,
    pub session_id: String,
    /// Strictly increases.
    pub through_sequence: u64,
}

wire_enum! {
    /// `SESSION_DOMAINS`.
    pub enum SessionDomain {
        Todo = "todo",
        Plan = "plan",
        Usage = "usage",
        RuntimeResource = "runtime_resource",
    }
}

/// `SessionDomainChangedFrame`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionDomainChangedFrame {
    pub host_epoch: String,
    pub subscription_id: String,
    pub sequence: u64,
    pub session_id: String,
    pub domain: SessionDomain,
    /// Present exactly for `runtime_resource`: 1 to 64 changes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resources: Option<Vec<SessionRuntimeResourceChange>>,
}

/// `SessionRuntimeResourceChange`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionRuntimeResourceChange {
    pub source_session_id: String,
    #[serde(rename = "ref")]
    pub resource_ref: String,
}

/// `SessionRuntimeResourcePtyDataFrame`: terminal output for a ref named in
/// `subscription.pty_interest.set`, outside the sequence order. `pty_sequence`
/// rises by one per chunk of the resource's output; chunks at or below a
/// [`crate::PtySnapshot`]'s `sequence` are already in its buffer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionRuntimeResourcePtyDataFrame {
    pub host_epoch: String,
    pub subscription_id: String,
    pub session_id: String,
    #[serde(rename = "ref")]
    pub resource_ref: String,
    pub pty_sequence: u64,
    /// UTF-8 text, at most [`SESSION_RUNTIME_RESOURCE_PTY_DATA_MAX_BYTES`].
    pub data: String,
    /// The chunk was too large and is missing (`data` is empty); acquire the
    /// terminal again for a fresh snapshot before showing more.
    #[serde(default, skip_serializing_if = "is_false")]
    pub reset: bool,
}

wire_enum! {
    /// `AgentGraphChangedReason`.
    pub enum AgentGraphChangedReason {
        Observation = "observation",
        RuntimeActivity = "runtime_activity",
        Reconciled = "reconciled",
        Stopped = "stopped",
    }
}

/// `AgentGraphChangedFrame`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct AgentGraphChangedFrame {
    pub host_epoch: String,
    pub subscription_id: String,
    pub sequence: u64,
    pub root_session_id: String,
    pub graph_id: String,
    pub reason: AgentGraphChangedReason,
}

wire_enum! {
    /// `SubscriptionClosedFrame.reason`.
    pub enum SubscriptionClosedReason {
        SlowConsumer = "slow_consumer",
        SessionRemoved = "session_removed",
        AccessRevoked = "access_revoked",
    }
}

/// `SubscriptionClosedFrame`: the last frame of a subscription.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SubscriptionClosedFrame {
    pub host_epoch: String,
    pub subscription_id: String,
    pub sequence: u64,
    pub reason: SubscriptionClosedReason,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn round_trip(value: Value) -> SessionFrame {
        let frame: SessionFrame = serde_json::from_value(value.clone()).expect("decode");
        assert_eq!(serde_json::to_value(&frame).expect("encode"), value);
        frame
    }

    fn envelope(kind: &str, sequence: u64) -> Value {
        json!({"kind": kind, "hostEpoch": "e", "subscriptionId": "sub", "sequence": sequence})
    }

    #[test]
    fn delta_frames_decode_flags() {
        let mut value = envelope("subscription.session_delta", 3);
        value["sessionId"] = json!("s");
        value["delta"] = json!({
            "kind": "text", "turnId": "t", "runId": "r", "messageId": "m",
            "startOffset": 0, "text": "", "complete": true, "interrupted": true
        });
        let SessionFrame::Delta(frame) = round_trip(value) else { panic!("expected delta") };
        assert!(frame.delta.complete && frame.delta.interrupted && !frame.delta.reset);
    }

    #[test]
    fn tool_events_decode() {
        let mut value = envelope("subscription.session_event", 4);
        value["sessionId"] = json!("s");
        value["runId"] = json!("r");
        value["event"] = json!({
            "type": "tool_start", "id": "ev1", "turnId": "t", "ts": 1, "toolUseId": "call_1",
            "toolName": "Bash", "activityKind": "command", "argsPreview": {"command": "ls"},
            "stepId": "step"
        });
        let frame = round_trip(value);
        assert_eq!(frame.sequence(), Some(4));
        let SessionFrame::Event(event) = frame else { panic!("expected event") };
        assert_eq!(event.event.tool_use_id(), Some("call_1"));

        let mut value = envelope("subscription.session_event", 5);
        value["sessionId"] = json!("s");
        value["runId"] = json!("r");
        value["event"] = json!({
            "type": "tool_result", "id": "ev2", "turnId": "t", "ts": 2, "toolUseId": "call_1",
            "status": "errored", "sandboxFailureReason": "requires_bypass", "durationMs": 3
        });
        round_trip(value);
    }

    #[test]
    fn domain_pty_graph_and_closed_frames_decode() {
        let mut domain = envelope("subscription.session_domain_changed", 6);
        domain["sessionId"] = json!("s");
        domain["domain"] = json!("runtime_resource");
        domain["resources"] = json!([{"sourceSessionId": "s", "ref": "shell:1"}]);
        round_trip(domain);

        let pty = json!({
            "kind": "subscription.runtime_resource_pty_data", "hostEpoch": "e",
            "subscriptionId": "sub", "sessionId": "s", "ref": "shell:1", "ptySequence": 1,
            "data": "x", "reset": true
        });
        assert_eq!(round_trip(pty).sequence(), None);

        let mut graph = envelope("subscription.agent_graph_changed", 7);
        graph["rootSessionId"] = json!("s");
        graph["graphId"] = json!("g");
        graph["reason"] = json!("stopped");
        round_trip(graph);

        let mut closed = envelope("subscription.closed", 8);
        closed["reason"] = json!("slow_consumer");
        let SessionFrame::Closed(closed) = round_trip(closed) else { panic!("expected closed") };
        assert_eq!(closed.reason, SubscriptionClosedReason::SlowConsumer);
    }

    #[test]
    fn unknown_frame_kinds_keep_their_envelope() {
        let value = envelope("subscription.future", 9);
        let frame = round_trip(value);
        assert_eq!(frame.sequence(), Some(9));
        assert_eq!(frame.host_epoch(), Some("e"));
        assert!(matches!(frame, SessionFrame::Unknown(_)));
    }

    #[test]
    fn pty_interest_names_at_most_sixteen_distinct_refs() {
        let refs: Vec<String> = (0..PTY_INTEREST_MAX_REFS).map(|n| format!("r{n}")).collect();
        let input = PtyInterestInput::new("sub", refs.clone()).expect("sixteen refs");
        assert_eq!(serde_json::to_value(&input).expect("encode")["refs"], json!(refs));
        let mut more = refs;
        more.push("r16".into());
        assert!(PtyInterestInput::new("sub", more).is_err());
        assert!(PtyInterestInput::new("sub", vec!["a".into(), "a".into()]).is_err());
        assert!(PtyInterestInput::new("sub", Vec::new()).is_ok(), "an empty set stops output");
    }

    #[test]
    fn open_input_encodes_policies() {
        assert_eq!(
            serde_json::to_value(SubscriptionOpenInput::with_tail("s")).expect("encode"),
            json!({"sessionId": "s", "transcript": {"kind": "tail", "maxBytes": 16384}})
        );
        let none =
            SubscriptionOpenInput { session_id: "s".into(), transcript: TranscriptPolicy::None };
        assert_eq!(
            serde_json::to_value(none).expect("encode")["transcript"],
            json!({"kind": "none"})
        );
    }
}
