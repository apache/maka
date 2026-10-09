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

//! `usage.query`: the Usage screen (a headline summary, the breakdowns by
//! provider, model and tool, the pricing in effect, and the first page of
//! activity) and its activity continuation, plus the model-call log rows
//! the Health page reads a connection's last run from.
//!
//! Source: `packages/runtime-host/src/protocol/usage-pricing.ts`
//! (`USAGE_PRICING_OPERATION_SPECS`, `decodeUsageQueryInput`,
//! `decodeUsageQueryResult`, `decodeUsageProvenance`, `decodeLlmUsageLog`)
//! and `usage-screen.ts` (`decodeUsageScreenRequest`,
//! `decodeUsageScreenResult`, `assertUsageScreenResult`), with the domain
//! types of `packages/core/src/settings.ts` (`UsageScreenQuery`,
//! `UsageScreen`, `UsageRequestLog`, `UsageSummary`) and
//! `packages/core/src/usage-ledger-merge.ts` (`UsageProvenance`).
//!
//! Numbers the decoders read as non-negative finite amounts (timestamps,
//! costs, latencies, the breakdowns' figures) are `f64`; counts are `u64`.
//! A screen answers one fixed query: the activity filters never change the
//! headline figures, and a continuation carries the screen's `revision` and
//! `queryIdentity` back. Errors: `host_not_ready`, `host_draining`,
//! `operation_unavailable`, `persistence_failed`, `internal_failure`,
//! `invalid_request` (`USAGE_QUERY_ERRORS`).

use serde::{Deserialize, Serialize};

use crate::Operation;

/// `USAGE_PAGE_MAX_ITEMS`: rows a log page holds at most.
pub const USAGE_PAGE_MAX_ITEMS: u64 = 100;
/// `USAGE_SCREEN_SEARCH_MAX_BYTES`: the longest activity search, in UTF-8.
pub const USAGE_SCREEN_SEARCH_MAX_BYTES: usize = 1024;

wire_enum! {
    /// `UsageScreenQuery.status` and `UsageQuery.status`: which activity
    /// rows the screen lists.
    pub enum UsageStatusFilter {
        All = "all",
        Success = "success",
        Error = "error",
        Aborted = "aborted",
    }
}

wire_enum! {
    /// A row's outcome (`decodeUsageLogStatus`).
    pub enum UsageOutcome {
        Success = "success",
        Error = "error",
        Aborted = "aborted",
    }
}

wire_enum! {
    /// `UsageRequestLog.kind`.
    pub enum UsageRowKind {
        Model = "model",
        Tool = "tool",
    }
}

/// `UsageScreenQuery.range`: epoch milliseconds, `from` at most `to`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct UsageRangeBounds {
    pub from: f64,
    pub to: f64,
}

impl UsageRangeBounds {
    pub fn new(from_ms: u64, to_ms: u64) -> Self {
        Self { from: from_ms as f64, to: to_ms as f64 }
    }
}

/// `UsageScreenQuery`: the time range and the activity filters (the search
/// trimmed and lowercased, as Desktop sends it).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct UsageScreenQuery {
    pub range: UsageRangeBounds,
    pub search: String,
    pub status: UsageStatusFilter,
}

impl UsageScreenQuery {
    pub fn new(
        range: UsageRangeBounds,
        search: impl Into<String>,
        status: UsageStatusFilter,
    ) -> Self {
        Self { range, search: search.into(), status }
    }
}

/// `LlmUsageQuery` (`decodeLlmUsageQuery`) as the Health page sends it: all
/// time, one connection, optionally one model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct LlmUsageQuery {
    /// `'24h' | '7d' | '30d' | 'all'`.
    pub range: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
}

impl LlmUsageQuery {
    /// Every call on the connection `slug` (and `model`, when given).
    pub fn connection(slug: impl Into<String>, model: Option<String>) -> Self {
        Self { range: "all".to_owned(), connection_slug: Some(slug.into()), model_id: model }
    }
}

/// `UsageQueryInput`: the kinds this client sends.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum UsageQueryInput {
    /// The whole screen for `query`.
    Screen { query: UsageScreenQuery },
    /// The next activity page of the screen identified by `revision` and
    /// `query_identity`, from `cursor`.
    #[serde(rename_all = "camelCase")]
    Activity { query: UsageScreenQuery, revision: String, query_identity: String, cursor: String },
    /// Model-call log rows (`source: "llm"`), newest first.
    Logs {
        source: UsageLogSource,
        query: LlmUsageQuery,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        offset: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        limit: Option<u64>,
    },
}

impl UsageQueryInput {
    /// The newest model call matching `query`.
    pub fn latest_llm_log(query: LlmUsageQuery) -> Self {
        Self::Logs { source: UsageLogSource::Llm, query, offset: Some(0), limit: Some(1) }
    }
}

wire_enum! {
    /// Which ledger a log page reads.
    pub enum UsageLogSource {
        Llm = "llm",
        Tool = "tool",
    }
}

/// `UsageSummary`: the range's headline figures.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct UsageSummary {
    pub total_requests: u64,
    pub total_cost_usd: f64,
    pub total_tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_tokens: u64,
    pub cache_miss: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
    pub reasoning: u64,
}

/// `ModelCallCoverage`: how the canonical records behind a figure were
/// priced and reported.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct UsageCoverage {
    pub attempts: u64,
    pub priced_attempts: u64,
    pub unpriced_attempts: u64,
    pub usage_reported_attempts: u64,
    pub usage_partial_attempts: u64,
    pub usage_missing_attempts: u64,
}

/// `UsageProvenance` (`decodeUsageProvenance`): what the totals rest on.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct UsageProvenance {
    pub coverage: UsageCoverage,
    /// Records from the frozen table, whose cost basis was never recorded.
    pub legacy_records: u64,
    /// Stored records that failed to decode: real spend now unknown.
    pub unreadable_records: u64,
    /// Runs not yet folded into the read model.
    pub pending_repairs: u64,
}

impl UsageProvenance {
    /// `estimatedUsageCost`: the total cost when some of it is priced (or
    /// legacy records carry a positive one), else unknown.
    pub fn estimated_cost(&self, total_cost_usd: f64) -> Option<f64> {
        if self.coverage.priced_attempts > 0 {
            return Some(total_cost_usd);
        }
        (self.legacy_records > 0 && total_cost_usd > 0.).then_some(total_cost_usd)
    }

    /// `hasUnavailableUsage`: real spend is missing from the totals.
    pub fn has_unavailable_usage(&self) -> bool {
        self.unreadable_records > 0 || self.pending_repairs > 0
    }
}

/// `UsageRequestLog`: one row of activity, a model call or a tool call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct UsageRequestLog {
    pub id: String,
    /// Epoch milliseconds.
    pub ts: f64,
    pub kind: UsageRowKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// The task's title, when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub provider: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_miss: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_creation: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<f64>,
    pub status: UsageOutcome,
}

/// A `byProvider` row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct UsageProviderRow {
    pub provider: String,
    pub requests: f64,
    pub tokens: f64,
    pub cost_usd: f64,
}

/// A `byModel` row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct UsageModelRow {
    pub model: String,
    pub requests: f64,
    pub tokens: f64,
    pub cost_usd: f64,
}

/// A `byTool` row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct UsageToolRow {
    pub tool: String,
    pub calls: f64,
    pub success: f64,
    pub errors: f64,
    pub avg_duration_ms: f64,
}

/// A `pricing` row: the price per million tokens in effect.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct UsagePricingRow {
    pub provider: String,
    pub model: String,
    pub input_per_m_tok_usd: f64,
    pub output_per_m_tok_usd: f64,
}

/// `UsageScreen`: the screen for one query, with the first activity page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct UsageScreen {
    pub revision: String,
    pub query_identity: String,
    pub logs: Vec<UsageRequestLog>,
    /// `None` on the last page.
    pub next_cursor: Option<String>,
    pub query: UsageScreenQuery,
    /// How many activity rows the query matches in all.
    pub activity_total: u64,
    pub summary: UsageSummary,
    pub by_provider: Vec<UsageProviderRow>,
    pub by_model: Vec<UsageModelRow>,
    pub by_tool: Vec<UsageToolRow>,
    pub pricing: Vec<UsagePricingRow>,
    pub provenance: UsageProvenance,
}

/// `UsageActivityPage`: a continuation's rows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct UsageActivityPage {
    pub revision: String,
    pub query_identity: String,
    pub logs: Vec<UsageRequestLog>,
    pub next_cursor: Option<String>,
}

/// `LlmUsageLogProjection` (`decodeLlmUsageLog`): one model call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct LlmUsageLog {
    pub source: UsageLogSource,
    pub id: String,
    pub ts: f64,
    /// `ModelCallKind` (`MODEL_CALL_KINDS`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_slug: Option<String>,
    pub provider_id: String,
    pub model_id: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_miss_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// `'explicit' | 'derived'`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_miss_input_source: Option<String>,
    pub reasoning_tokens: u64,
    pub total_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    /// `'priced' | 'unpriced'`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_basis: Option<String>,
    pub latency_ms: f64,
    pub status: UsageOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_class: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

/// `UsageQueryResult`: the kinds answering this client's inputs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum UsageQueryResult {
    Screen {
        screen: Box<UsageScreen>,
    },
    Activity {
        page: UsageActivityPage,
    },
    /// The data moved since the screen: a continuation cannot follow it;
    /// read the screen again.
    RevisionChanged,
    /// A part of the answer would outgrow its wire budget: `section` names
    /// it (`provider_breakdown`, `model_breakdown`, `tool_breakdown`,
    /// `pricing`, `activity_page`, `screen`, `message`).
    ScreenResponseTooLarge {
        section: String,
    },
    /// A model-call log page.
    #[serde(rename_all = "camelCase")]
    Logs {
        source: UsageLogSource,
        rows: Vec<LlmUsageLog>,
        offset: u64,
        total: u64,
        next_offset: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provenance: Option<UsageProvenance>,
    },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `usage.query` (mode `query`, available when the Host is ready).
#[derive(Debug)]
pub enum UsageQuery {}

impl Operation for UsageQuery {
    const NAME: &'static str = "usage.query";
    type Input = UsageQueryInput;
    type Output = UsageQueryResult;
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

    fn query() -> Value {
        json!({"range": {"from": 1.0, "to": 86_400_001.0}, "search": "", "status": "all"})
    }

    #[test]
    fn inputs_encode_as_the_host_decodes_them() {
        let screen = UsageQueryInput::Screen {
            query: UsageScreenQuery::new(
                UsageRangeBounds::new(1, 86_400_001),
                "",
                UsageStatusFilter::All,
            ),
        };
        assert_eq!(
            serde_json::to_value(&screen).expect("encode"),
            json!({"kind": "screen", "query": query()})
        );
        round_trip::<UsageQueryInput>(&json!({"kind": "activity", "query": query(),
            "revision": "r1", "queryIdentity": "q1", "cursor": "c1"}));
        let latest = UsageQueryInput::latest_llm_log(LlmUsageQuery::connection(
            "ollama-local",
            Some("qwen2.5:7b".into()),
        ));
        assert_eq!(
            serde_json::to_value(latest).expect("encode"),
            json!({"kind": "logs", "source": "llm", "query": {"range": "all",
                   "connectionSlug": "ollama-local", "modelId": "qwen2.5:7b"},
                   "offset": 0, "limit": 1})
        );
    }

    /// A screen as `usage-screen-protocol.test.ts` builds one: every
    /// section present, one model row and one tool row.
    #[test]
    fn a_screen_its_continuation_and_its_failures_decode() {
        let screen = json!({"kind": "screen", "screen": {
            "revision": "r1", "queryIdentity": "q1", "nextCursor": "c1",
            "query": query(), "activityTotal": 2,
            "logs": [
                {"id": "m1", "ts": 10.0, "kind": "model", "sessionId": "s1",
                 "sessionName": "Refactor", "turnId": "t1", "provider": "openai",
                 "model": "gpt-5", "inputTokens": 1200, "outputTokens": 300, "cacheMiss": 200,
                 "cacheRead": 1000, "cacheCreation": 0, "reasoning": 40, "costUsd": 0.25,
                 "latencyMs": 1834.0, "status": "success"},
                {"id": "t1", "ts": 11.5, "kind": "tool", "provider": "", "model": "",
                 "toolName": "Read", "inputTokens": 0, "outputTokens": 0, "latencyMs": 12.0,
                 "status": "error"}
            ],
            "summary": {"totalRequests": 1, "totalCostUsd": 0.25, "totalTokens": 1500,
                        "inputTokens": 1200, "outputTokens": 300, "cacheTokens": 1200,
                        "cacheMiss": 200, "cacheRead": 1000, "cacheCreation": 0,
                        "reasoning": 40},
            "byProvider": [{"provider": "openai", "requests": 1.0, "tokens": 1500.0,
                            "costUsd": 0.25}],
            "byModel": [{"model": "gpt-5", "requests": 1.0, "tokens": 1500.0, "costUsd": 0.25}],
            "byTool": [{"tool": "Read", "calls": 1.0, "success": 0.0, "errors": 1.0,
                        "avgDurationMs": 12.0}],
            "pricing": [{"provider": "openai", "model": "gpt-5", "inputPerMTokUsd": 1.25,
                         "outputPerMTokUsd": 10.0}],
            "provenance": {"coverage": {"attempts": 1, "pricedAttempts": 1,
                "unpricedAttempts": 0, "usageReportedAttempts": 1, "usagePartialAttempts": 0,
                "usageMissingAttempts": 0}, "legacyRecords": 0, "unreadableRecords": 0,
                "pendingRepairs": 0}
        }});
        let UsageQueryResult::Screen { screen } = round_trip(&screen) else {
            panic!("a screen");
        };
        assert_eq!(screen.logs[1].kind, UsageRowKind::Tool);
        assert_eq!(screen.logs[1].status, UsageOutcome::Error);
        assert_eq!(screen.summary.total_tokens, 1500);
        assert_eq!(screen.provenance.estimated_cost(0.25), Some(0.25));
        assert!(!screen.provenance.has_unavailable_usage());

        let page = json!({"kind": "activity", "page": {"revision": "r1", "queryIdentity": "q1",
            "logs": [], "nextCursor": null}});
        let UsageQueryResult::Activity { page } = round_trip(&page) else {
            panic!("a page");
        };
        assert_eq!(page.next_cursor, None);
        assert_eq!(
            round_trip::<UsageQueryResult>(&json!({"kind": "revision_changed"})),
            UsageQueryResult::RevisionChanged
        );
        assert_eq!(
            round_trip::<UsageQueryResult>(
                &json!({"kind": "screen_response_too_large", "section": "activity_page"})
            ),
            UsageQueryResult::ScreenResponseTooLarge { section: "activity_page".into() }
        );
    }

    #[test]
    fn an_llm_log_page_decodes() {
        let page = json!({"kind": "logs", "source": "llm", "offset": 0, "total": 3,
            "nextOffset": 1, "rows": [{"source": "llm", "id": "a1", "ts": 1790.0,
            "callKind": "main", "connectionSlug": "ollama-local", "providerId": "custom",
            "modelId": "qwen2.5:7b", "inputTokens": 10, "outputTokens": 2,
            "cacheMissTokens": 10, "cacheReadTokens": 0, "cacheWriteTokens": 0,
            "reasoningTokens": 0, "totalTokens": 12, "costBasis": "unpriced",
            "latencyMs": 820.0, "status": "error", "errorClass": "timeout"}],
            "provenance": {"coverage": {"attempts": 3, "pricedAttempts": 0,
                "unpricedAttempts": 3, "usageReportedAttempts": 3, "usagePartialAttempts": 0,
                "usageMissingAttempts": 0}, "legacyRecords": 0, "unreadableRecords": 0,
                "pendingRepairs": 1}});
        let UsageQueryResult::Logs { rows, provenance, .. } = round_trip(&page) else {
            panic!("a log page");
        };
        assert_eq!(rows[0].error_class.as_deref(), Some("timeout"));
        assert_eq!(rows[0].status, UsageOutcome::Error);
        let provenance = provenance.expect("llm logs carry provenance");
        assert_eq!(provenance.estimated_cost(0.), None, "nothing priced");
        assert!(provenance.has_unavailable_usage());
    }
}
