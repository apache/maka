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

//! `context.diagnostics.query`: what a Session's context holds right now,
//! from the latest settled provider request, as Maka Desktop's Inspector
//! (and `/context`) reads it.
//!
//! Sources: `ContextDiagnosticsQueryInput`, `ContextDiagnosticsResult`,
//! `ContextDiagnosticsComposition`, `decodeContextDiagnosticsResult` and the
//! decoders under it in `packages/runtime-host/src/protocol/context.ts`.
//!
//! The snapshot names the request's provider and model, its prompt
//! (`inputTokens`, provider-reported) and the cache share of it, and the
//! window the call was metered against, frozen at call time. Its
//! composition is in bytes of the serialized request, never tokens: the
//! four-bytes-per-token estimate is a display rule, made where it is shown.
//! A request the durable record names but no capture explains has no
//! composition rather than an older request's. Errors: `host_not_ready`,
//! `host_draining`, `operation_unavailable`, `not_found`,
//! `internal_failure`.

use serde::{Deserialize, Serialize};

use crate::Operation;

/// `MAX_COMPOSITION_TOOLS`: per-tool rows a composition carries at most;
/// the Host folds the rest into `remainingTools`.
pub const CONTEXT_COMPOSITION_MAX_TOOLS: usize = 256;

/// `ContextDiagnosticsQueryInput`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ContextDiagnosticsQueryInput {
    pub session_id: String,
}

impl ContextDiagnosticsQueryInput {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self { session_id: session_id.into() }
    }
}

wire_union! {
    /// `ContextDiagnosticsResult`, by `status`.
    pub enum ContextDiagnosticsResult in "status" {
        Unavailable(ContextDiagnosticsUnavailable) = "unavailable",
        Available(ContextDiagnostics) = "available",
    }
}

wire_enum! {
    /// Why there is no snapshot.
    pub enum ContextUnavailableReason {
        /// The Session has not settled a provider request yet.
        NoCompletedRequest = "no_completed_request",
        TraceUnavailable = "trace_unavailable",
    }
}

/// The `unavailable` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ContextDiagnosticsUnavailable {
    pub reason: ContextUnavailableReason,
}

/// The `available` result: the latest settled request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ContextDiagnostics {
    pub provider_id: String,
    pub model_id: String,
    /// Epoch milliseconds.
    pub completed_at: u64,
    /// The request's prompt, as the provider counted it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    /// The provider-reported cache read of the same request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<u64>,
    /// The window the request was metered against; positive when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub composition: Option<ContextComposition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction: Option<ContextCompaction>,
}

/// `ContextDiagnosticsComposition`: what the request was made of.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ContextComposition {
    /// At most four, one per kind.
    pub segments: Vec<ContextSegment>,
    /// The largest tool schemas first, at most
    /// [`CONTEXT_COMPOSITION_MAX_TOOLS`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ContextTool>>,
    /// The tools past the Host's cap, folded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remaining_tools: Option<ContextToolRemainder>,
    /// Tool schemas the request did not name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unlabelled_tool_bytes: Option<u64>,
}

wire_enum! {
    /// `ContextDiagnosticsSegment.kind`. The wire's `other` (request
    /// options) is [`Self::Options`] (`Other` holds a kind this client
    /// does not know).
    pub enum ContextSegmentKind {
        SystemInstructions = "system_instructions",
        ToolDefinitions = "tool_definitions",
        Messages = "messages",
        Options = "other",
    }
}

/// `ContextDiagnosticsSegment`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ContextSegment {
    pub kind: ContextSegmentKind,
    pub bytes: u64,
}

/// `ContextDiagnosticsTool`: one tool's schema, sized on its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ContextTool {
    pub name: String,
    pub bytes: u64,
}

/// `remainingTools`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ContextToolRemainder {
    pub count: u64,
    pub bytes: u64,
}

wire_enum! {
    /// `compaction.kind`.
    pub enum ContextCompactionKind {
        History = "history",
    }
}

wire_enum! {
    /// `compaction.phase`.
    pub enum ContextCompactionPhase {
        PreTurn = "pre_turn",
        MidTurn = "mid_turn",
    }
}

/// `compaction`: the history compaction the request replayed from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ContextCompaction {
    pub kind: ContextCompactionKind,
    pub phase: ContextCompactionPhase,
    pub event_count: u64,
    pub turn_count: u64,
    pub estimated_tokens: u64,
}

/// `context.diagnostics.query` (mode `query`, available when the Host is
/// ready).
#[derive(Debug)]
pub enum ContextDiagnosticsQuery {}

impl Operation for ContextDiagnosticsQuery {
    const NAME: &'static str = "context.diagnostics.query";
    type Input = ContextDiagnosticsQueryInput;
    type Output = ContextDiagnosticsResult;
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

    /// Every optional field present (hand-built: the demo Host's requests
    /// carry no window, cache share or compaction).
    #[test]
    fn a_full_snapshot_and_the_unavailable_answer_decode() {
        assert_eq!(
            serde_json::to_value(ContextDiagnosticsQueryInput::new("s1")).expect("encode"),
            json!({"sessionId": "s1"})
        );
        let full = json!({"status": "available", "providerId": "anthropic",
            "modelId": "claude-sonnet", "completedAt": 1_790_000_000_000u64,
            "inputTokens": 42_000, "cacheReadInputTokens": 30_000, "contextWindow": 200_000,
            "composition": {"segments": [
                {"kind": "system_instructions", "bytes": 8000},
                {"kind": "tool_definitions", "bytes": 40_000},
                {"kind": "messages", "bytes": 100_000},
                {"kind": "other", "bytes": 400}],
              "tools": [{"name": "Bash", "bytes": 6000}],
              "remainingTools": {"count": 3, "bytes": 900}, "unlabelledToolBytes": 120},
            "compaction": {"kind": "history", "phase": "pre_turn", "eventCount": 40,
                           "turnCount": 6, "estimatedTokens": 9000}});
        let ContextDiagnosticsResult::Available(snapshot) = round_trip(&full) else {
            panic!("a snapshot");
        };
        assert_eq!(snapshot.context_window, Some(200_000));
        let composition = snapshot.composition.expect("a composition");
        assert_eq!(composition.segments[3].kind, ContextSegmentKind::Options);
        let none = json!({"status": "unavailable", "reason": "no_completed_request"});
        let ContextDiagnosticsResult::Unavailable(unavailable) = round_trip(&none) else {
            panic!("unavailable");
        };
        assert_eq!(unavailable.reason, ContextUnavailableReason::NoCompletedRequest);
        assert!(matches!(
            round_trip::<ContextDiagnosticsResult>(&json!({"status": "estimating"})),
            ContextDiagnosticsResult::Unknown(_)
        ));
    }
}
