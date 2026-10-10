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

//! `execution.inspect.query`, read as Maka Desktop's Inspector reads it: a
//! Session's causal trace (what its Turns did, step by step, with the
//! latency and cost of the model calls that drove them), a page at a time.
//!
//! Sources: `ExecutionInspectQueryInput`, `ExecutionInspectQueryResult`,
//! `decodeExecutionInspectQueryInput`, `decodeExecutionInspectQueryResult`
//! and `requireTraceCursor` in
//! `packages/runtime-host/src/protocol/execution-inspect.ts`; the trace
//! itself in `packages/core/src/session-trace.ts` (`SessionTrace`,
//! `TurnTrace`, `TraceStep` and its five kinds, `TraceModelAttempt`,
//! `TraceFailureAttribution`, `SessionTraceCoverage`, `isSessionTrace`);
//! the model-call vocabularies in `packages/core/src/model-call-attempt.ts`
//! and `packages/core/src/usage-stats/types.ts` (`MODEL_CALL_KINDS`). The
//! Host side is `#inspectSessionTracePage` in
//! `packages/runtime-host/src/server/execution-inspect-coordinator.ts`.
//!
//! The trace is a projection, not a record: it joins the runtime events
//! (causal structure) with the model-call attempts (metering, the cost
//! frozen at call time) and says what it could not see
//! ([`SessionTraceCoverage`]). A cost or a token count it does not carry is
//! absent, never zero.
//!
//! `session_trace_start` answers the newest runs, at most
//! [`EXECUTION_INSPECT_TRACE_PAGE_MAX_TURNS`] Turns in at most
//! [`EXECUTION_INSPECT_RESULT_MAX_BYTES`]; `session_trace_continue` with a
//! page's `nextCursor` answers the runs before it, until `nextCursor` is
//! `null`. Each page's Turns are oldest first. A run too large for the
//! online view answers a page with no Turns, `oversizedRuns: 1` and a
//! cursor past it. The query's other kinds (`session`, `agent_run`,
//! `turn_trace`) are not modelled: nothing here reads them.
//!
//! Numbers the core reads as non-negative finite amounts (times,
//! latencies, token counts, costs) are `f64`; the ones it requires to be
//! integers (an attempt's ordinal, a step's index, the coverage counts)
//! are integers. Errors: `host_not_ready`, `host_draining`,
//! `operation_unavailable`, `not_found` (no such Session),
//! `invalid_request` (a cursor the Host cannot read), `persistence_failed`,
//! `internal_failure`.

use serde::{Deserialize, Serialize};

use crate::Operation;

/// `EXECUTION_INSPECT_TRACE_PAGE_MAX_TURNS`: Turns one trace page holds.
pub const EXECUTION_INSPECT_TRACE_PAGE_MAX_TURNS: usize = 16;
/// `EXECUTION_INSPECT_RESULT_MAX_BYTES`: one encoded result.
pub const EXECUTION_INSPECT_RESULT_MAX_BYTES: usize = 48 * 1024;
/// `requireTraceCursor`: a cursor's UTF-8 bytes at most (`A-Z a-z 0-9 _ -`).
pub const EXECUTION_INSPECT_CURSOR_MAX_BYTES: usize = 512;
/// `SESSION_TRACE_SCHEMA_VERSION`.
pub const SESSION_TRACE_SCHEMA_VERSION: u32 = 1;

/// `ExecutionInspectQueryInput`: the kinds the Inspector sends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ExecutionInspectQueryInput {
    /// The newest page of the Session's trace.
    #[serde(rename_all = "camelCase")]
    SessionTraceStart { session_id: String },
    /// The page before the one whose `nextCursor` is `cursor`.
    #[serde(rename_all = "camelCase")]
    SessionTraceContinue { session_id: String, cursor: String },
}

impl ExecutionInspectQueryInput {
    /// The newest page of `session_id`'s trace, or the page before the one
    /// that answered `cursor`.
    pub fn session_trace(session_id: impl Into<String>, cursor: Option<String>) -> Self {
        let session_id = session_id.into();
        match cursor {
            Some(cursor) => Self::SessionTraceContinue { session_id, cursor },
            None => Self::SessionTraceStart { session_id },
        }
    }
}

wire_union! {
    /// `ExecutionInspectQueryResult`, by `kind`: the kind answering the
    /// inputs above, or one this client does not read.
    pub enum ExecutionInspectQueryResult in "kind" {
        SessionTracePage(SessionTracePage) = "session_trace_page",
    }
}

/// The `session_trace_page` result: one page of a Session's trace.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionTracePage {
    /// [`SESSION_TRACE_SCHEMA_VERSION`].
    pub schema_version: u32,
    pub session_id: String,
    /// Oldest first, at most [`EXECUTION_INSPECT_TRACE_PAGE_MAX_TURNS`].
    pub turns: Vec<TurnTrace>,
    pub coverage: SessionTraceCoverage,
    /// The cursor of the page before this one; `None` on the oldest.
    pub next_cursor: Option<String>,
}

/// `TurnTrace`: one Turn of a run, its steps in order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct TurnTrace {
    pub turn_id: String,
    pub run_id: String,
    /// Epoch milliseconds.
    pub started_at: f64,
    pub ended_at: f64,
    pub duration_ms: f64,
    pub steps: Vec<TraceStep>,
    /// What ended the Turn badly, when something did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<TraceFailureAttribution>,
}

/// `TraceFailureAttribution`: what ended a Turn badly and the step the
/// trace saw fail first (a claim about sequence, not a diagnosis).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct TraceFailureAttribution {
    /// `tool_failed`, `model_call_failed`, `turn_aborted`,
    /// `turn_cancelled`, `turn_failed`, `error`, or one not named yet.
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attributed_to_step_id: Option<String>,
}

wire_union! {
    /// `TraceStep`, by `kind`: why a step exists, in the causal vocabulary
    /// a reader thinks in. A kind this client does not know is kept.
    pub enum TraceStep in "kind" {
        ModelCall(TraceModelCallStep) = "model_call",
        Tool(TraceToolStep) = "tool",
        Permission(TracePermissionStep) = "permission",
        Compaction(TraceCompactionStep) = "compaction",
        Error(TraceErrorStep) = "error",
    }
}

impl TraceStep {
    /// The step's id, unique in its Turn (`None` for an unknown kind
    /// without one).
    pub fn id(&self) -> Option<&str> {
        match self {
            Self::ModelCall(step) => Some(&step.id),
            Self::Tool(step) => Some(&step.id),
            Self::Permission(step) => Some(&step.id),
            Self::Compaction(step) => Some(&step.id),
            Self::Error(step) => Some(&step.id),
            Self::Unknown(value) => value.get("id").and_then(serde_json::Value::as_str),
        }
    }
}

wire_enum! {
    /// `ModelCallKind` (`MODEL_CALL_KINDS`): why a model was called.
    /// `semantic_compact` is decode-only history; the Runtime no longer
    /// makes such calls.
    pub enum ModelCallKind {
        Main = "main",
        SemanticCompact = "semantic_compact",
        HistoryCompact = "history_compact",
        GoalEvaluation = "goal_evaluation",
        SessionTitle = "session_title",
        SessionRecap = "session_recap",
        PromptSuggestion = "prompt_suggestion",
        DailyReview = "daily_review",
        MemoryExtraction = "memory_extraction",
        WorkhubIntent = "workhub_intent",
        WorkhubRecall = "workhub_recall",
    }
}

wire_enum! {
    /// `ModelCallAttemptStatus` (`MODEL_CALL_ATTEMPT_STATUSES`).
    pub enum ModelCallStatus {
        Completed = "completed",
        Failed = "failed",
        Interrupted = "interrupted",
        Aborted = "aborted",
    }
}

wire_enum! {
    /// `HistoryCompactRoute` (`HISTORY_COMPACT_ROUTES`): how a
    /// history-compaction call reduced the conversation.
    pub enum HistoryCompactRoute {
        TextSummary = "text_summary",
        ProviderNative = "provider_native",
    }
}

wire_enum! {
    /// `TraceModelAttempt.costBasis` (`MODEL_CALL_COST_BASES`): whether a
    /// price could be resolved for the attempt when it was recorded.
    pub enum CostBasis {
        Priced = "priced",
        Unpriced = "unpriced",
    }
}

wire_enum! {
    /// `TraceModelAttempt.usageBasis` (`MODEL_CALL_USAGE_BASES`): whether
    /// the provider reported the attempt's tokens.
    pub enum UsageBasis {
        Reported = "reported",
        Partial = "partial",
        Missing = "missing",
    }
}

/// `TraceModelCallStep`: one logical model call and every attempt of it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct TraceModelCallStep {
    pub id: String,
    pub turn_id: String,
    pub run_id: String,
    pub started_at: f64,
    pub ended_at: f64,
    pub duration_ms: f64,
    pub call_kind: ModelCallKind,
    /// Only on a `history_compact` call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_compact_route: Option<HistoryCompactRoute>,
    /// The canonical provider (the pricing key's first half), not the
    /// connection.
    pub provider_id: String,
    pub model_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_slug: Option<String>,
    /// The runtime tool-loop step index within the Turn.
    pub step: u64,
    pub attempts: Vec<TraceModelAttempt>,
    /// The last attempt's status.
    pub status: ModelCallStatus,
    /// The sum over the attempts that carry a price; absent when none do.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

/// `TraceModelAttempt`: one physical provider request, as metered.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct TraceModelAttempt {
    pub attempt_id: String,
    /// The retry ordinal in the logical call; 0 is the first dispatch.
    pub attempt: u64,
    pub status: ModelCallStatus,
    pub started_at: f64,
    pub completed_at: f64,
    pub latency_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_to_first_token_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_class: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<f64>,
    /// The window the call was metered against, frozen at call time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<f64>,
    /// Absent when the attempt carries no price: never zero for that.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    pub cost_basis: CostBasis,
    pub usage_basis: UsageBasis,
}

wire_enum! {
    /// `TraceToolStep.status`.
    pub enum ToolStepStatus {
        Completed = "completed",
        Failed = "failed",
        InFlight = "in_flight",
    }
}

wire_enum! {
    /// `TraceToolRecovery.disposition`: what a recovered tool became.
    pub enum ToolRecoveryDisposition {
        Completed = "completed",
        Parked = "parked",
    }
}

/// `TraceToolStep`: one tool dispatch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct TraceToolStep {
    pub id: String,
    pub turn_id: String,
    pub run_id: String,
    pub started_at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
    pub tool_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    pub status: ToolStepStatus,
    /// What the dispatch declared safe on resume: a policy every dispatch
    /// carries, not evidence of a recovery.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_policy: Option<String>,
    /// Present only when a recovery decision was durably recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovered: Option<TraceToolRecovery>,
}

/// `TraceToolRecovery`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct TraceToolRecovery {
    pub disposition: ToolRecoveryDisposition,
    pub reason_code: String,
}

/// `TracePermissionStep`: a permission request and its answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct TracePermissionStep {
    pub id: String,
    pub turn_id: String,
    pub run_id: String,
    pub started_at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// `allow`, `deny`, or another the Runtime records.
    pub decision: String,
}

/// `TraceCompactionStep`: a compaction boundary durably written.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct TraceCompactionStep {
    pub id: String,
    pub turn_id: String,
    pub run_id: String,
    pub started_at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_id: Option<String>,
}

/// `TraceErrorStep`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct TraceErrorStep {
    pub id: String,
    pub turn_id: String,
    pub run_id: String,
    pub started_at: f64,
    pub message: String,
}

wire_enum! {
    /// `SessionTraceCoverage.modelCalls`: `no_known_gap` (nothing detectably
    /// missing; not a proof of completeness), `partial` (a shortfall is
    /// detectable), `absent` (model activity with no canonical record: a
    /// backend outside canonical accounting), `none` (no model activity).
    pub enum ModelCallCoverage {
        NoKnownGap = "no_known_gap",
        Partial = "partial",
        Absent = "absent",
        NoActivity = "none",
    }
}

/// `TraceTurnIdentity`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct TraceTurnIdentity {
    pub run_id: String,
    pub turn_id: String,
}

/// `SessionTraceCoverage`: what the trace could not see, stated rather than
/// left to look like an idle Session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionTraceCoverage {
    pub model_calls: ModelCallCoverage,
    /// Turns with aggregate usage but no canonical record behind them.
    pub turns_missing_model_calls: Vec<TraceTurnIdentity>,
    /// Records that could not be read or decoded (a floor).
    pub unreadable_records: u64,
    /// Runs whose evidence exceeds the bounded online view.
    pub oversized_runs: u64,
    /// Turns whose aggregate usage stands for more steps than there are
    /// main model calls on record.
    pub turns_with_fewer_model_calls_than_steps: Vec<TraceTurnIdentity>,
}

/// `execution.inspect.query` (mode `query`, available when the Host is
/// ready).
#[derive(Debug)]
pub enum ExecutionInspectQuery {}

impl Operation for ExecutionInspectQuery {
    const NAME: &'static str = "execution.inspect.query";
    type Input = ExecutionInspectQueryInput;
    type Output = ExecutionInspectQueryResult;
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn round_trip<T: Serialize + serde::de::DeserializeOwned>(wire: &Value) -> T {
        let decoded: T = serde_json::from_value(wire.clone()).expect("decode");
        assert_eq!(&serde_json::to_value(&decoded).expect("encode"), wire);
        decoded
    }

    #[test]
    fn the_two_trace_reads_encode_as_the_host_decodes_them() {
        assert_eq!(
            serde_json::to_value(ExecutionInspectQueryInput::session_trace("s1", None))
                .expect("encode"),
            json!({"kind": "session_trace_start", "sessionId": "s1"})
        );
        assert_eq!(
            serde_json::to_value(ExecutionInspectQueryInput::session_trace(
                "s1",
                Some("eyJ2IjoxfQ".into())
            ))
            .expect("encode"),
            json!({"kind": "session_trace_continue", "sessionId": "s1", "cursor": "eyJ2IjoxfQ"})
        );
    }

    /// Every step kind as `session-trace.ts` declares it, every optional
    /// field present (hand-built: the demo Host's recording has no
    /// permission, compaction, error, retry or recovery step).
    #[test]
    fn a_page_with_every_step_kind_decodes() {
        let attempt = |attempt: u64, status: &str| {
            json!({"attemptId": format!("a{attempt}"), "attempt": attempt, "status": status,
                   "startedAt": 1.0, "completedAt": 5.0, "latencyMs": 4.0,
                   "timeToFirstTokenMs": 1.5, "finishReason": "stop", "errorClass": "Timeout",
                   "httpStatus": 504, "providerCode": "gateway", "providerRequestId": "req-1",
                   "retryable": true, "inputTokens": 1200.0, "outputTokens": 80.0,
                   "cacheReadInputTokens": 1000.0, "reasoningTokens": 12.0,
                   "contextWindow": 200000.0, "costUsd": 0.002, "costBasis": "priced",
                   "usageBasis": "reported"})
        };
        let page = json!({"kind": "session_trace_page", "schemaVersion": 1, "sessionId": "s1",
            "turns": [{"turnId": "t1", "runId": "r1", "startedAt": 1.0, "endedAt": 30.0,
                "durationMs": 29.0,
                "failure": {"code": "tool_failed", "message": "boom", "attributedToStepId": "tool-1"},
                "steps": [
                    {"kind": "model_call", "id": "call-1", "turnId": "t1", "runId": "r1",
                     "startedAt": 1.0, "endedAt": 10.0, "durationMs": 9.0,
                     "callKind": "history_compact", "historyCompactRoute": "text_summary",
                     "providerId": "openai", "modelId": "gpt-5", "connectionSlug": "work",
                     "step": 0, "attempts": [attempt(0, "failed"), attempt(1, "completed")],
                     "status": "completed", "costUsd": 0.004},
                    {"kind": "tool", "id": "tool-1", "turnId": "t1", "runId": "r1",
                     "startedAt": 11.0, "endedAt": 12.0, "durationMs": 1.0, "toolName": "Bash",
                     "toolCallId": "call_1", "operationId": "op-1", "status": "failed",
                     "recoveryPolicy": "replay", "recovered": {"disposition": "parked",
                     "reasonCode": "host_restart"}},
                    {"kind": "permission", "id": "perm-1", "turnId": "t1", "runId": "r1",
                     "startedAt": 13.0, "toolName": "Write", "decision": "deny"},
                    {"kind": "compaction", "id": "cmp-1", "turnId": "t1", "runId": "r1",
                     "startedAt": 14.0, "checkpointId": "ck-1"},
                    {"kind": "error", "id": "err-1", "turnId": "t1", "runId": "r1",
                     "startedAt": 15.0, "message": "stream ended"},
                    {"kind": "handoff", "id": "h-1", "turnId": "t1", "runId": "r1",
                     "startedAt": 16.0}
                ]}],
            "coverage": {"modelCalls": "partial",
                "turnsMissingModelCalls": [{"runId": "r0", "turnId": "t0"}],
                "unreadableRecords": 1, "oversizedRuns": 0,
                "turnsWithFewerModelCallsThanSteps": []},
            "nextCursor": "eyJ2IjoxfQ"});
        let ExecutionInspectQueryResult::SessionTracePage(page) = round_trip(&page) else {
            panic!("a trace page");
        };
        assert_eq!(page.next_cursor.as_deref(), Some("eyJ2IjoxfQ"));
        assert_eq!(page.coverage.model_calls, ModelCallCoverage::Partial);
        let steps = &page.turns[0].steps;
        let TraceStep::ModelCall(call) = &steps[0] else { panic!("a model call") };
        assert_eq!(call.call_kind, ModelCallKind::HistoryCompact);
        assert_eq!(call.attempts[1].cost_basis, CostBasis::Priced);
        assert!(matches!(&steps[1], TraceStep::Tool(tool) if tool.recovered.is_some()));
        assert_eq!(steps[5].id(), Some("h-1"), "an unknown step kind is kept with its id");
        assert_eq!(steps[5].tag(), "handoff");
    }

    #[test]
    fn growing_vocabularies_and_result_kinds_are_kept() {
        let step = json!({"kind": "model_call", "id": "c", "turnId": "t", "runId": "r",
            "startedAt": 0.0, "endedAt": 0.0, "durationMs": 0.0, "callKind": "plan_review",
            "providerId": "p", "modelId": "m", "step": 0, "attempts": [], "status": "paused"});
        let TraceStep::ModelCall(call) = round_trip(&step) else { panic!("a model call") };
        assert_eq!(call.call_kind, ModelCallKind::Other("plan_review".into()));
        assert_eq!(call.status, ModelCallStatus::Other("paused".into()));
        let other = json!({"kind": "turn_trace", "sessionId": "s1", "turn": {}});
        assert!(matches!(
            round_trip::<ExecutionInspectQueryResult>(&other),
            ExecutionInspectQueryResult::Unknown(_)
        ));
    }
}
