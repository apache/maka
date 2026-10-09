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

//! Turns: `turn.start`, `turn.query`, `turn.stop`, `turn.interrupt`, and the
//! Turn snapshot the continuity snapshot carries.
//!
//! Sources: `packages/runtime-host/src/protocol/turn.ts` (`TurnStartInput`,
//! `decodeTurnStartInput`, `decodeTurnStartResult`, `decodeTurnSnapshot`,
//! `decodeTurnQueryInput`, `decodeTurnStopInput`),
//! `packages/runtime-host/src/protocol/turn-provider-retry.ts`
//! (`decodeTurnProviderRetry`), and
//! `packages/runtime-host/src/protocol/message.ts` (`TurnInterruptInput`,
//! `decodeTurnInterruptResult`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{MessageContent, MessageQueueEntrySnapshot, Operation, OrchestrationMode};

wire_enum! {
    /// `TurnRunStatus` (`requireTurnRunStatus`).
    pub enum TurnRunStatus {
        Admitted = "admitted",
        Created = "created",
        Running = "running",
        WaitingForUser = "waiting_for_user",
        Completed = "completed",
        Failed = "failed",
        Cancelled = "cancelled",
    }
}

impl TurnRunStatus {
    /// `completed`, `failed`, or `cancelled` (`isRuntimeHostTerminalTurn` in
    /// `packages/runtime-host/src/adapter/session-projector.ts`).
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

/// `TurnSnapshot` (`decodeTurnSnapshot`).
///
/// The TS type is a union discriminated by `status`; it is flattened here so
/// an unknown status still decodes. Which optional fields are present depends
/// on `status`:
///
/// - live (`admitted`, `created`, `running`, `waiting_for_user`):
///   `provider_retry`, `root_execution_kind`;
/// - `completed`: `terminal_event_id`, `context_compaction_outcome`;
/// - `failed`: `terminal_event_id`, `failure_class`, `failure_message`;
/// - `cancelled`: `terminal_event_id`, `abort_source`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct TurnSnapshot {
    pub session_id: String,
    pub turn_id: String,
    pub run_id: String,
    pub status: TurnRunStatus,
    /// A provider request the Runtime retries: waiting for it, or making
    /// it. The Host clears it when the Turn produces content again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_retry: Option<TurnProviderRetry>,
    /// Currently only `context_compact`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_execution_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_event_id: Option<String>,
    /// `ContextCompactionOutcome`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_compaction_outcome: Option<Value>,
    /// At most 128 characters, for example `auth`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_class: Option<String>,
    /// At most 256 UTF-8 bytes; the Host redacts credentials in it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_message: Option<String>,
    /// For example `renderer.stop_button` after `turn.stop`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub abort_source: Option<String>,
}

wire_enum! {
    /// Where a provider retry is (`TurnProviderRetry`'s `phase`).
    pub enum ProviderRetryPhase {
        /// Waiting `delay_ms` before the attempt.
        Scheduled = "scheduled",
        /// The attempt's request is under way.
        Started = "started",
    }
}

wire_enum! {
    /// Why the Runtime retries a provider request (`ProviderRetryReason` in
    /// `packages/core/src/events.ts`; `RETRY_REASONS`).
    pub enum ProviderRetryReason {
        StreamTruncated = "stream_truncated",
        Network = "network",
        ProviderCapacity = "provider_capacity",
        ProviderUnavailable = "provider_unavailable",
        RateLimit = "rate_limit",
        Timeout = "timeout",
        Unknown = "unknown",
    }
}

/// `TurnProviderRetry` (`decodeTurnProviderRetry`): the provider request a
/// live Turn retries.
///
/// The TS type is a union discriminated by `phase`; it is flattened here so
/// an unknown phase still decodes. `delay_ms` and `ts` belong to
/// `scheduled` (`ts` may be absent there too).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct TurnProviderRetry {
    pub phase: ProviderRetryPhase,
    /// The request being retried, counting the first: 2 for the first
    /// retry. Positive, at most `max_attempts`.
    pub attempt: u64,
    /// Every request the Runtime makes, the first included.
    pub max_attempts: u64,
    pub reason: ProviderRetryReason,
    /// `scheduled`: how long the Runtime waits before the attempt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay_ms: Option<u64>,
    /// `scheduled`: Host wall-clock milliseconds when the wait began.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
}

/// `TurnOrchestration` (`decodeTurnOrchestration`; `packages/core/src/orchestration.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct TurnOrchestration {
    pub mode: OrchestrationMode,
    /// `TURN_ORCHESTRATION_SOURCES`: `slash_command` or `host_api`.
    pub source: String,
}

/// `TurnStartInput` (`decodeTurnStartInput`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct TurnStartInput {
    pub session_id: String,
    /// Client-chosen entity id (`^[A-Za-z0-9_-]{1,128}$`). The durable user
    /// message the Host writes for this Turn uses the same id.
    pub turn_id: String,
    pub content: MessageContent,
    /// At most 50 Skill ids; omitted when empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_orchestration: Option<TurnOrchestration>,
    /// Positive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_steps: Option<u64>,
}

impl TurnStartInput {
    /// A Turn with `content` and no Skills, orchestration, or step limit.
    pub fn new(
        session_id: impl Into<String>,
        turn_id: impl Into<String>,
        content: MessageContent,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            turn_id: turn_id.into(),
            content,
            skill_ids: None,
            turn_orchestration: None,
            max_steps: None,
        }
    }
}

/// `TurnStartResult` (`decodeTurnStartResult`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum TurnStartResult {
    /// The Turn was admitted. `skill_invocation` is a `SkillInvocationResult`
    /// (`packages/core/src/skill-invocation.ts`).
    #[serde(rename_all = "camelCase")]
    Started { turn: Box<TurnSnapshot>, skill_invocation: Value },
    /// Every requested Skill failed to load; no Turn exists.
    #[serde(rename_all = "camelCase")]
    Blocked { skill_invocation: Value },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `TurnQueryInput` (`decodeTurnQueryInput`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct TurnQueryInput {
    pub session_id: String,
    pub turn_id: String,
}

impl TurnQueryInput {
    /// Queries `turn_id` in `session_id`.
    pub fn new(session_id: impl Into<String>, turn_id: impl Into<String>) -> Self {
        Self { session_id: session_id.into(), turn_id: turn_id.into() }
    }
}

/// `TurnStopInput` (`decodeTurnStopInput`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct TurnStopInput {
    pub session_id: String,
    pub turn_id: String,
    /// The run to stop, from the Turn snapshot.
    pub run_id: String,
}

impl TurnStopInput {
    /// Stops `run_id` of `turn_id`.
    pub fn new(
        session_id: impl Into<String>,
        turn_id: impl Into<String>,
        run_id: impl Into<String>,
    ) -> Self {
        Self { session_id: session_id.into(), turn_id: turn_id.into(), run_id: run_id.into() }
    }
}

/// `TurnInterruptInput` (`decodeTurnInterruptInput` in `protocol/message.ts`):
/// stop the running Turn and retract its queued steering messages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct TurnInterruptInput {
    /// The Host epoch the client observed the queue under.
    pub origin_host_epoch: String,
    pub session_id: String,
    /// Client-chosen idempotency id.
    pub interrupt_id: String,
    pub turn_id: String,
    pub run_id: String,
}

/// `TurnInterruptResult` (`decodeTurnInterruptResult`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct TurnInterruptResult {
    pub queue_revision: u64,
    /// Entries in state `retracted`.
    pub retracted: Vec<MessageQueueEntrySnapshot>,
    pub turn: TurnSnapshot,
}

/// `turn.start` (mode `command`).
#[derive(Debug)]
pub enum TurnStart {}

impl Operation for TurnStart {
    const NAME: &'static str = "turn.start";
    type Input = TurnStartInput;
    type Output = TurnStartResult;
}

/// `turn.query` (mode `query`).
#[derive(Debug)]
pub enum TurnQuery {}

impl Operation for TurnQuery {
    const NAME: &'static str = "turn.query";
    type Input = TurnQueryInput;
    type Output = TurnSnapshot;
}

/// `turn.stop` (mode `control`). Answers with the Turn snapshot after the stop,
/// normally `cancelled`.
#[derive(Debug)]
pub enum TurnStop {}

impl Operation for TurnStop {
    const NAME: &'static str = "turn.stop";
    type Input = TurnStopInput;
    type Output = TurnSnapshot;
}

/// `turn.interrupt` (mode `control`, `MESSAGE_OPERATION_SPECS`).
#[derive(Debug)]
pub enum TurnInterrupt {}

impl Operation for TurnInterrupt {
    const NAME: &'static str = "turn.interrupt";
    type Input = TurnInterruptInput;
    type Output = TurnInterruptResult;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn start_input_encodes_minimal_shape() {
        let input = TurnStartInput::new("s1", "t1", MessageContent::text("hello"));
        assert_eq!(
            serde_json::to_value(input).expect("encode"),
            json!({"sessionId": "s1", "turnId": "t1", "content": {"text": "hello"}})
        );
    }

    #[test]
    fn snapshots_decode_per_status() {
        let failed: TurnSnapshot = serde_json::from_value(json!({
            "sessionId": "s", "turnId": "t", "runId": "r", "status": "failed",
            "terminalEventId": "e", "failureClass": "auth", "failureMessage": "bad key"
        }))
        .expect("decode");
        assert!(failed.status.is_terminal());
        assert_eq!(failed.failure_class.as_deref(), Some("auth"));
        let running: TurnSnapshot = serde_json::from_value(json!({
            "sessionId": "s", "turnId": "t", "runId": "r", "status": "waiting_for_user"
        }))
        .expect("decode");
        assert!(!running.status.is_terminal());
        let future: TurnSnapshot = serde_json::from_value(json!({
            "sessionId": "s", "turnId": "t", "runId": "r", "status": "paused"
        }))
        .expect("decode");
        assert_eq!(future.status, TurnRunStatus::Other("paused".into()));
    }

    #[test]
    fn a_live_snapshot_carries_its_provider_retry() {
        let scheduled = json!({
            "sessionId": "s", "turnId": "t", "runId": "r", "status": "running",
            "providerRetry": {"phase": "scheduled", "attempt": 2, "maxAttempts": 5,
                              "delayMs": 4000, "reason": "rate_limit", "ts": 1_790_000_000_000u64}
        });
        let turn: TurnSnapshot = serde_json::from_value(scheduled.clone()).expect("decode");
        let retry = turn.provider_retry.as_ref().expect("retry");
        assert_eq!(retry.phase, ProviderRetryPhase::Scheduled);
        assert_eq!((retry.attempt, retry.max_attempts), (2, 5));
        assert_eq!(retry.reason, ProviderRetryReason::RateLimit);
        assert_eq!((retry.delay_ms, retry.ts), (Some(4000), Some(1_790_000_000_000)));
        assert_eq!(serde_json::to_value(&turn).expect("encode"), scheduled);

        let started = json!({"phase": "started", "attempt": 3, "maxAttempts": 5,
                             "reason": "stream_truncated"});
        let retry: TurnProviderRetry = serde_json::from_value(started.clone()).expect("decode");
        assert_eq!(retry.phase, ProviderRetryPhase::Started);
        assert_eq!(retry.delay_ms, None);
        assert_eq!(serde_json::to_value(&retry).expect("encode"), started);

        let future: TurnProviderRetry = serde_json::from_value(json!({
            "phase": "paused", "attempt": 2, "maxAttempts": 2, "reason": "solar_flare"
        }))
        .expect("an unknown phase and reason still decode");
        assert_eq!(future.phase, ProviderRetryPhase::Other("paused".into()));
        assert_eq!(future.reason, ProviderRetryReason::Other("solar_flare".into()));
    }

    #[test]
    fn start_result_decodes_started_and_blocked() {
        let started: TurnStartResult = serde_json::from_value(json!({
            "kind": "started",
            "turn": {"sessionId": "s", "turnId": "t", "runId": "r", "status": "running"},
            "skillInvocation": {"loaded": [], "failed": [], "receipts": []}
        }))
        .expect("decode");
        assert!(matches!(started, TurnStartResult::Started { ref turn, .. } if turn.run_id == "r"));
        let blocked: TurnStartResult = serde_json::from_value(json!({
            "kind": "blocked", "skillInvocation": {"loaded": [], "failed": [{}], "receipts": []}
        }))
        .expect("decode");
        assert!(matches!(blocked, TurnStartResult::Blocked { .. }));
    }
}
