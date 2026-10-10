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

//! The face's derivations against Desktop's own cases: each test below
//! named after one of `session-inspector-usage-stats.test.ts`,
//! `session-inspector-panel-model.test.ts` and
//! `session-inspector-pricing-key.test.ts` (in
//! `apps/desktop/src/main/__tests__/`) has its input and its expected
//! figures; the rest pin the merge of pages (`mergeSessionTraces`), the
//! context bar and composition rules, and the figures' formats.

use host_protocol::{
    ContextDiagnosticsResult, ModelCallCoverage, ModelCallKind, SessionTracePage, UsageProvenance,
    UsageSummaryV2,
};
use serde_json::{Value, json};

use crate::model::{
    CompositionState, ContextBand, ContextLevel, CoverageKind, DurationKind, SessionUsage,
    StepKind, TokenKind, Trace, compact_tokens, format_cost, format_duration, format_percent,
    group_digits, merge_pages, overview_model, panel_model,
};

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).expect("decodes")
}

/// Desktop's `usageSummary(overrides)`: three requests, 4M input mostly
/// served from the cache.
fn summary(overrides: Value) -> UsageSummaryV2 {
    let mut base = json!({
        "range": {"from": 0.0, "to": 1.0}, "totalRequests": 3, "totalCostUsd": 0.02,
        "totalTokens": {"input": 4_000_000, "output": 60_300, "cacheMiss": 100_000,
                        "cacheRead": 3_900_000, "cacheWrite": 0, "reasoning": 12_000,
                        "total": 4_060_300},
        "cacheHitRequests": 2, "cacheCreateRequests": 0, "errorRequests": 0,
        "totalDurationMs": 0
    });
    for (key, value) in overrides.as_object().expect("overrides") {
        base[key] = value.clone();
    }
    decode(base)
}

fn tokens(input: u64, output: u64, cache_miss: u64, cache_read: u64) -> Value {
    json!({"input": input, "output": output, "cacheMiss": cache_miss, "cacheRead": cache_read,
           "cacheWrite": 0, "reasoning": 0, "total": input + output})
}

fn provenance(priced: u64, partial: u64, legacy: u64, unreadable: u64) -> UsageProvenance {
    decode(json!({"coverage": {"attempts": priced + partial, "pricedAttempts": priced,
        "unpricedAttempts": 0, "usageReportedAttempts": priced, "usagePartialAttempts": partial,
        "usageMissingAttempts": 0}, "legacyRecords": legacy, "unreadableRecords": unreadable,
        "pendingRepairs": 0}))
}

fn usage(summary: UsageSummaryV2) -> SessionUsage {
    SessionUsage::new(summary, provenance(3, 0, 0, 0))
}

fn token_rows(usage: &SessionUsage) -> Option<Vec<(TokenKind, u64)>> {
    overview_model(None, Some(usage)).token_usage.map(|split| split.segments)
}

fn duration_rows(usage: &SessionUsage) -> Option<Vec<(DurationKind, u64, f64)>> {
    overview_model(None, Some(usage)).duration_usage.map(|split| {
        split
            .segments
            .iter()
            .map(|segment| (segment.kind, segment.count, segment.duration_ms))
            .collect()
    })
}

#[test]
fn splits_the_session_metered_tokens_the_way_a_bill_reads() {
    let split = overview_model(None, Some(&usage(summary(json!({"totalDurationMs": 1_885_000})))))
        .token_usage
        .expect("a split");
    assert_eq!(
        split.segments,
        [
            (TokenKind::CacheRead, 3_900_000),
            (TokenKind::CacheMiss, 100_000),
            (TokenKind::Output, 60_300)
        ]
    );
    // The readout is the sum of the drawn rows.
    assert_eq!(split.total, split.segments.iter().map(|(_, tokens)| tokens).sum::<u64>());
}

#[test]
fn derives_uncached_input_as_the_prompt_residual_when_a_provider_reports_only_its_cache() {
    let usage = usage(summary(json!({"totalTokens": tokens(260_500, 60_300, 0, 200_000)})));
    assert_eq!(
        token_rows(&usage),
        Some(vec![
            (TokenKind::CacheRead, 200_000),
            (TokenKind::CacheMiss, 60_500),
            (TokenKind::Output, 60_300)
        ])
    );
}

#[test]
fn keeps_the_ledger_cache_miss_as_a_floor_for_records_that_reported_no_prompt_total() {
    let usage = usage(summary(json!({"totalTokens": tokens(0, 100, 500, 0)})));
    assert_eq!(
        token_rows(&usage),
        Some(vec![(TokenKind::CacheMiss, 500), (TokenKind::Output, 100)])
    );
}

#[test]
fn a_session_with_nothing_metered_has_no_token_split_to_show() {
    let usage = usage(summary(json!({"totalTokens": tokens(0, 0, 0, 0)})));
    assert_eq!(token_rows(&usage), None);
    assert_eq!(overview_model(None, None).token_usage, None);
}

#[test]
fn shows_the_token_split_even_when_usage_coverage_is_partial() {
    let usage = SessionUsage::new(summary(json!({})), provenance(3, 1, 0, 0));
    let overview = overview_model(None, Some(&usage));
    assert!(overview.token_usage.is_some(), "the rows are what ran");
    assert_eq!(overview.cache_hit_rate, None, "a rate over a part is not a rate");
}

#[test]
fn splits_recorded_time_between_model_calls_and_tool_executions() {
    let usage = usage(summary(
        json!({"totalDurationMs": 1_873_000, "toolUsage": {"requests": 78, "durationMs": 78_000}}),
    ));
    assert_eq!(
        duration_rows(&usage),
        Some(vec![(DurationKind::Model, 3, 1_873_000.), (DurationKind::Tool, 78, 78_000.)])
    );
    let split = overview_model(None, Some(&usage)).duration_usage.expect("a split");
    assert_eq!(split.total_duration_ms, 1_873_000. + 78_000.);
}

#[test]
fn keeps_a_cache_read_share_the_provider_reported_without_a_prompt_total() {
    let usage = usage(summary(json!({"totalTokens": tokens(0, 100, 60_000, 200_000)})));
    let split = overview_model(None, Some(&usage)).token_usage.expect("a split");
    assert_eq!(
        split.segments,
        [(TokenKind::CacheRead, 200_000), (TokenKind::CacheMiss, 60_000), (TokenKind::Output, 100)]
    );
    assert_eq!(split.total, 260_100);
}

#[test]
fn a_host_that_measured_zero_model_time_keeps_its_row_and_its_call_count() {
    let usage = usage(summary(json!({"totalDurationMs": 0})));
    assert_eq!(duration_rows(&usage), Some(vec![(DurationKind::Model, 3, 0.)]));
}

#[test]
fn a_row_with_neither_a_clock_nor_a_count_is_dropped() {
    let usage = usage(summary(json!({"totalRequests": 0, "totalDurationMs": 0})));
    assert_eq!(duration_rows(&usage), None);
}

#[test]
fn a_tool_row_without_a_recorded_duration_still_reports_its_count() {
    let usage = usage(summary(json!({"totalRequests": 0, "totalDurationMs": 0,
                                      "toolUsage": {"requests": 4, "durationMs": 0}})));
    assert_eq!(duration_rows(&usage), Some(vec![(DurationKind::Tool, 4, 0.)]));
}

#[test]
fn model_time_without_tool_usage_reads_as_a_single_segment_split() {
    let usage = usage(summary(json!({"totalRequests": 5, "totalDurationMs": 2_500})));
    assert_eq!(duration_rows(&usage), Some(vec![(DurationKind::Model, 5, 2_500.)]));
}

#[test]
fn does_not_render_legacy_zero_cost_as_a_known_free_session() {
    let base = json!({"totalRequests": 1, "totalCostUsd": 0, "totalTokens": tokens(1, 1, 1, 0)});
    let legacy = SessionUsage::new(summary(base.clone()), provenance(0, 0, 1, 0));
    assert_eq!(legacy.estimated_cost(), None);
    let mut paid = base;
    paid["totalCostUsd"] = json!(0.01);
    let paid = SessionUsage::new(summary(paid), provenance(0, 0, 1, 0));
    assert_eq!(paid.estimated_cost(), Some(0.01));
}

#[test]
fn reports_incomplete_provenance_as_unavailable_regardless_of_recorded_request_count() {
    for requests in [0, 1] {
        let usage = SessionUsage::new(
            summary(json!({"totalRequests": requests, "totalTokens": tokens(0, 0, 0, 0)})),
            provenance(0, 0, 0, 1),
        );
        assert!(usage.has_unavailable_usage());
    }
}

#[test]
fn does_not_estimate_a_cache_hit_ratio_from_partial_usage() {
    let usage = SessionUsage::new(
        summary(json!({"totalRequests": 1, "totalTokens": tokens(10, 0, 0, 10)})),
        provenance(1, 1, 0, 0),
    );
    assert_eq!(overview_model(None, Some(&usage)).cache_hit_rate, None);
    let reported = SessionUsage::new(
        summary(json!({"totalRequests": 1, "totalTokens": tokens(10, 0, 0, 4)})),
        provenance(1, 0, 0, 0),
    );
    assert_eq!(overview_model(None, Some(&reported)).cache_hit_rate, Some(0.4));
}

// The timeline.

fn attempt(attempt: u64, cost: Option<f64>) -> Value {
    let mut value = json!({"attemptId": format!("attempt-{attempt}"), "attempt": attempt,
        "status": "completed", "startedAt": 1.0, "completedAt": 10.0, "latencyMs": 9.0,
        "costBasis": if cost.is_some() { "priced" } else { "unpriced" }, "usageBasis": "reported"});
    if let Some(cost) = cost {
        value["costUsd"] = json!(cost);
    }
    value
}

fn model_call(id: &str, cost: Option<f64>, attempts: Vec<Value>) -> Value {
    let mut value = json!({"kind": "model_call", "id": id, "turnId": "turn-1", "runId": "run-1",
        "startedAt": 1.0, "endedAt": 10.0, "durationMs": 9.0, "callKind": "main",
        "providerId": "provider-1", "modelId": "model-1", "step": 0, "attempts": attempts,
        "status": "completed"});
    if let Some(cost) = cost {
        value["costUsd"] = json!(cost);
    }
    value
}

fn coverage(level: &str, unreadable: u64, oversized: u64) -> Value {
    json!({"modelCalls": level, "turnsMissingModelCalls": [], "unreadableRecords": unreadable,
           "oversizedRuns": oversized, "turnsWithFewerModelCallsThanSteps": []})
}

fn page(turns: Vec<Value>, coverage: Value, next_cursor: Option<&str>) -> SessionTracePage {
    decode(json!({"schemaVersion": 1, "sessionId": "session-1", "turns": turns,
                  "coverage": coverage, "nextCursor": next_cursor}))
}

fn turn(run: &str, started_at: f64, steps: Vec<Value>) -> Value {
    json!({"turnId": format!("turn-{run}"), "runId": run, "startedAt": started_at,
           "endedAt": started_at + 9.0, "durationMs": 9.0, "steps": steps})
}

/// Desktop's `traceWithSteps`: one Turn from 1 to 10 holding `steps`.
fn trace_with_steps(steps: Vec<Value>) -> Trace {
    let mut one = turn("run-1", 1.0, steps);
    one["turnId"] = json!("turn-1");
    merge_pages(&[page(vec![one], coverage("no_known_gap", 0, 0), None)]).expect("a trace")
}

#[test]
fn derives_per_turn_cost_only_from_priced_model_call_step_totals() {
    let tool = json!({"kind": "tool", "id": "tool-1", "turnId": "turn-1", "runId": "run-1",
        "startedAt": 1.0, "endedAt": 2.0, "durationMs": 1.0, "toolName": "Read",
        "status": "completed"});
    let priced = |id: &str, cost: f64| model_call(id, Some(cost), vec![attempt(0, Some(cost))]);
    let unpriced = |id: &str| model_call(id, None, vec![attempt(0, None)]);
    let cases: Vec<(&str, Vec<Value>, Option<f64>)> = vec![
        ("empty", vec![], None),
        ("tool-only", vec![tool], None),
        ("unpriced", vec![unpriced("unpriced")], None),
        ("priced", vec![priced("priced", 0.01)], Some(0.01)),
        ("mixed", vec![priced("priced", 0.01), unpriced("unpriced")], Some(0.01)),
        ("multiple calls", vec![priced("first", 0.01), priced("second", 0.02)], Some(0.03)),
        ("zero-priced", vec![priced("free", 0.)], Some(0.)),
        // The nested attempts disagree on purpose: the display trusts the
        // logical call's already-aggregated price.
        (
            "retried logical call",
            vec![model_call(
                "retry",
                Some(0.04),
                vec![attempt(0, Some(0.01)), attempt(1, Some(0.02))],
            )],
            Some(0.04),
        ),
    ];
    for (name, steps, expected) in cases {
        let model = panel_model(Some(&trace_with_steps(steps)));
        let row = &model.turns[0];
        match (row.cost_usd, expected) {
            (Some(cost), Some(expected)) => assert!((cost - expected).abs() < 1e-12, "{name}"),
            (cost, expected) => assert_eq!(cost, expected, "{name}"),
        }
        assert_eq!(row.duration_ms, 9., "{name} duration");
    }
}

#[test]
fn shows_one_compact_diagnostic_line_for_a_failed_history_compaction_call() {
    let mut call = model_call(
        "call-compact-1",
        None,
        vec![json!({"attemptId": "attempt-compact-1", "attempt": 0, "status": "failed",
            "startedAt": 1.0, "completedAt": 10.0, "latencyMs": 9.0,
            "errorClass": "RequestRejected", "httpStatus": 400,
            "providerCode": "invalid_request_error", "providerRequestId": "req-compact-1",
            "retryable": false, "costBasis": "unpriced", "usageBasis": "missing"})],
    );
    call["callKind"] = json!("history_compact");
    call["historyCompactRoute"] = json!("provider_native");
    call["providerId"] = json!("openai-codex");
    call["modelId"] = json!("gpt-5.6-luna");
    call["status"] = json!("failed");
    let model = panel_model(Some(&trace_with_steps(vec![call])));
    let row = &model.turns[0].steps[0];
    assert_eq!(row.call_kind, Some(ModelCallKind::HistoryCompact));
    assert_eq!(
        row.detail.as_deref(),
        Some(
            "route=provider_native · error=RequestRejected · HTTP 400 · \
             code=invalid_request_error · request=req-compact-1 · retryable=false"
        )
    );
    assert!(row.failed);
    assert_eq!(model.turns[0].started_at, 1.);
}

#[test]
fn reports_runs_omitted_only_by_the_bounded_online_view_separately() {
    let trace =
        merge_pages(&[page(vec![], coverage("partial", 0, 1), Some("next"))]).expect("a trace");
    let model = panel_model(Some(&trace));
    let notice = model.coverage.expect("a notice");
    assert_eq!(notice.kind, CoverageKind::Partial);
    assert_eq!((notice.turns_missing, notice.turns_short), (0, 0));
    assert_eq!((notice.unreadable_records, notice.oversized_runs), (0, 1));
    assert!(!model.empty, "a reported gap is never nothing to trace");
}

#[test]
fn uses_the_canonical_provider_rather_than_the_connection_slug_for_an_unpriced_call() {
    let mut call = model_call("call-1", None, vec![attempt(0, None)]);
    call["connectionSlug"] = json!("my-deepinfra-account");
    call["providerId"] = json!("DeepInfra");
    call["modelId"] = json!("org/Model:Preview");
    let model = panel_model(Some(&trace_with_steps(vec![call])));
    assert_eq!(
        model.turns[0].steps[0].unpriced_pricing_key.as_deref(),
        Some("DeepInfra:org/Model:Preview")
    );
    let priced = model_call("call-1", Some(0.01), vec![attempt(0, Some(0.01))]);
    let model = panel_model(Some(&trace_with_steps(vec![priced])));
    assert_eq!(model.turns[0].steps[0].unpriced_pricing_key, None, "priced: no key");
}

#[test]
fn steps_name_what_they_are_and_a_failure_points_at_its_step() {
    let step = |kind: &str, id: &str, extra: Value| {
        let mut value = json!({"kind": kind, "id": id, "turnId": "turn-run-1",
                               "runId": "run-1", "startedAt": 2.0});
        for (key, field) in extra.as_object().expect("fields") {
            value[key] = field.clone();
        }
        value
    };
    let mut one = turn(
        "run-1",
        1.0,
        vec![
            step(
                "tool",
                "tool-1",
                json!({"toolName": "Bash", "status": "completed", "recoveryPolicy": "replay",
                       "recovered": {"disposition": "parked", "reasonCode": "host_restart"}}),
            ),
            step("permission", "perm-1", json!({"decision": "deny"})),
            step("compaction", "cmp-1", json!({"checkpointId": "ck"})),
            step("error", "err-1", json!({"message": "stream ended"})),
            step("handoff", "h-1", json!({})),
        ],
    );
    one["failure"] = json!({"code": "tool_failed", "attributedToStepId": "tool-1"});
    let trace =
        merge_pages(&[page(vec![one], coverage("no_known_gap", 0, 0), None)]).expect("a trace");
    let model = panel_model(Some(&trace));
    let row = &model.turns[0];
    assert!(row.failed);
    assert_eq!(row.failure_code.as_deref(), Some("tool_failed"));
    let steps = &row.steps;
    assert!(steps[0].failed, "the attributed step fails though it completed");
    assert_eq!(steps[0].duration_ms, None, "an unmeasured tool shows no time");
    assert!(steps[0].recovered.is_some(), "the recovery recorded, not the policy");
    assert_eq!((&steps[1].kind, &steps[1].label), (&StepKind::Permission, &None));
    assert_eq!(steps[1].decision.as_deref(), Some("deny"));
    assert!(!steps[1].failed);
    assert_eq!(steps[2].kind, StepKind::Compaction);
    assert_eq!(steps[2].detail, None, "a checkpoint id is not shown");
    assert!(steps[3].failed && steps[3].detail.as_deref() == Some("stream ended"));
    assert_eq!(steps[4].kind, StepKind::Other("handoff".into()));
}

#[test]
fn pages_merge_into_one_trace_ordered_once_per_turn_with_their_coverage() {
    let newest = page(
        vec![turn("run-3", 30.0, vec![]), turn("run-4", 40.0, vec![])],
        coverage("no_known_gap", 0, 0),
        Some("c1"),
    );
    // The older page repeats run-3 (a refresh moved the boundary) and has
    // an unreadable record.
    let older = page(
        vec![turn("run-1", 10.0, vec![]), turn("run-3", 30.0, vec![])],
        coverage("partial", 2, 0),
        None,
    );
    let trace = merge_pages(&[newest, older]).expect("a trace");
    let runs: Vec<&str> = trace.turns.iter().map(|turn| turn.run_id.as_str()).collect();
    assert_eq!(runs, ["run-1", "run-3", "run-4"]);
    assert_eq!(trace.coverage.model_calls, ModelCallCoverage::Partial);
    assert_eq!(trace.coverage.unreadable_records, 2);
    let model = panel_model(Some(&trace));
    let newest_first: Vec<&str> = model.turns.iter().map(|turn| turn.run_id.as_str()).collect();
    assert_eq!(newest_first, ["run-4", "run-3", "run-1"]);

    assert_eq!(merge_pages(&[]), None);
    let none = merge_pages(&[page(vec![], coverage("none", 0, 0), None)]).expect("a trace");
    let quiet = panel_model(Some(&none));
    assert!(quiet.empty && quiet.coverage.is_none());
    let mixed = [
        page(vec![], coverage("none", 0, 0), Some("c")),
        page(vec![], coverage("absent", 0, 0), None),
    ];
    let absent = merge_pages(&mixed).expect("a trace");
    assert_eq!(absent.coverage.model_calls, ModelCallCoverage::Absent);
    assert_eq!(panel_model(Some(&absent)).coverage.map(|c| c.kind), Some(CoverageKind::Absent));
}

// The context window and what filled it.

fn snapshot(fields: Value) -> ContextDiagnosticsResult {
    let mut value = json!({"status": "available", "providerId": "anthropic",
                           "modelId": "claude", "completedAt": 1});
    for (key, field) in fields.as_object().expect("fields") {
        value[key] = field.clone();
    }
    decode(value)
}

#[test]
fn the_context_bar_reads_the_latest_request_against_its_own_window() {
    let full = snapshot(
        json!({"inputTokens": 150_000, "cacheReadInputTokens": 200_000, "contextWindow": 200_000}),
    );
    let budget = overview_model(Some(&full), None).context.expect("a bar");
    assert_eq!(budget.ratio, 0.75);
    assert_eq!(budget.level(), ContextLevel::Warning);
    assert_eq!(
        budget.segments,
        [(ContextBand::CacheRead, 150_000), (ContextBand::Free, 50_000)],
        "a cache share larger than its prompt is clamped; the empty fresh band is dropped"
    );
    let unsplit = snapshot(json!({"inputTokens": 190_000, "contextWindow": 200_000}));
    let budget = overview_model(Some(&unsplit), None).context.expect("a bar");
    assert_eq!(budget.segments, [(ContextBand::Used, 190_000), (ContextBand::Free, 10_000)]);
    assert_eq!(budget.level(), ContextLevel::Error);
    let overrun = snapshot(json!({"inputTokens": 210_000, "contextWindow": 200_000}));
    let budget = overview_model(Some(&overrun), None).context.expect("a bar");
    assert_eq!(budget.segments, [(ContextBand::Used, 210_000)], "no negative headroom");
    let no_window = snapshot(json!({"inputTokens": 120}));
    let overview = overview_model(Some(&no_window), None);
    assert_eq!(overview.context, None, "no denominator, no bar");
    assert_eq!(overview.composition, Some(CompositionState::Unrecorded), "it still answers");
    let none: ContextDiagnosticsResult =
        decode(json!({"status": "unavailable", "reason": "no_completed_request"}));
    let overview = overview_model(Some(&none), None);
    assert_eq!((overview.context, overview.composition), (None, None));
}

#[test]
fn the_composition_folds_the_tools_past_the_visible_ones_with_the_hosts_own_fold() {
    let tools: Vec<Value> = (0..7)
        .map(|ix: u64| json!({"name": format!("tool-{ix}"), "bytes": 4000 - ix * 100}))
        .collect();
    let snapshot = snapshot(json!({"composition": {
        "segments": [{"kind": "system_instructions", "bytes": 33_016},
                     {"kind": "other", "bytes": 2}],
        "tools": tools, "remainingTools": {"count": 236, "bytes": 9_000},
        "unlabelledToolBytes": 10}}));
    let Some(CompositionState::Available(composition)) =
        overview_model(Some(&snapshot), None).composition
    else {
        panic!("a composition");
    };
    assert_eq!(composition.parts[0].estimated_tokens, 8_254);
    assert_eq!(composition.parts[1].estimated_tokens, 1, "rounded up");
    assert_eq!(composition.tools.len(), 5);
    assert_eq!(composition.tools[0], ("tool-0".to_owned(), 1_000));
    // Two hidden here (3500 and 3400 bytes) and the Host's 236 (9000).
    assert_eq!(composition.remaining_tools, Some((238, (3_500_u64 + 3_400 + 9_000).div_ceil(4))));
    assert_eq!(composition.unlabelled_tools, Some(3));
}

#[test]
fn figures_are_written_as_desktop_writes_them() {
    assert_eq!(format_duration(820.4), "820ms");
    assert_eq!(format_duration(8_637.), "8.6s");
    assert_eq!(format_duration(91_000.), "1m31s");
    assert_eq!(format_duration(119_600.), "2m0s", "the seconds carry into the minutes");
    assert_eq!(format_cost(None), None, "unpriced is not $0.00");
    assert_eq!(format_cost(Some(0.0012)).as_deref(), Some("$0.0012"));
    assert_eq!(format_cost(Some(0.25)).as_deref(), Some("$0.25"));
    assert_eq!(format_percent(601. / 1002.), "60.0%");
    assert_eq!(compact_tokens(999), "999");
    assert_eq!(compact_tokens(1_234), "1.2K");
    assert_eq!(compact_tokens(200_000), "200K");
    assert_eq!(compact_tokens(999_960), "1M");
    assert_eq!(group_digits(33_016), "33,016");
    assert_eq!(group_digits(1_000_000), "1,000,000");
    assert_eq!(group_digits(12), "12");
}
