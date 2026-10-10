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

//! What the Trace face shows, worked out from what the Host answered: the
//! trace's pages merged, the timeline's rows, the overview's figures, and
//! how each is written. Pure, as Desktop's models are
//! (`session-inspector-panel-model.ts`, `session-inspector-overview-model.ts`
//! in `apps/desktop/src/renderer/application/contracts/session-inspector/`),
//! so every judgement about what a number means is tested without a window,
//! and the view only lays the result out.
//!
//! Nothing is derived that the Host's answers do not carry: a cost nobody
//! could price is absent, never zero; a split of zero tokens is no split;
//! a rate over nothing is unknown.

use std::collections::BTreeMap;

use host_protocol::{
    ContextComposition, ContextDiagnostics, ContextDiagnosticsResult, ContextSegmentKind,
    CostBasis, ModelCallCoverage, ModelCallKind, SessionTraceCoverage, SessionTracePage,
    ToolRecoveryDisposition, ToolStepStatus, TraceModelCallStep, TraceStep, TraceTurnIdentity,
    TurnTrace, UsageProvenance, UsageSummaryV2,
};

/// A Session's trace over the pages read: its Turns oldest first, one per
/// run and Turn, and what the pages could not see.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct Trace {
    pub turns: Vec<TurnTrace>,
    pub coverage: SessionTraceCoverage,
}

/// The pages of one Session's trace as one trace: `mergeSessionTraces` and
/// `mergeDisjointTraceCoverage` in `packages/core/src/session-trace.ts`.
/// Page boundaries are transport detail: a Turn read on two pages is kept
/// once (the later page's), the Turns are ordered by start, then run, then
/// Turn, and each page's coverage adds to the rest, the pages being
/// disjoint. `None` for no page.
pub fn merge_pages(pages: &[SessionTracePage]) -> Option<Trace> {
    let (first, rest) = pages.split_first()?;
    let mut turns: BTreeMap<(String, String), TurnTrace> = BTreeMap::new();
    let mut coverage = first.coverage.clone();
    for turn in &first.turns {
        turns.insert((turn.run_id.clone(), turn.turn_id.clone()), turn.clone());
    }
    for page in rest {
        for turn in &page.turns {
            turns.insert((turn.run_id.clone(), turn.turn_id.clone()), turn.clone());
        }
        coverage = merge_coverage(&coverage, &page.coverage);
    }
    let mut turns: Vec<TurnTrace> = turns.into_values().collect();
    turns.sort_by(|left, right| {
        left.started_at
            .total_cmp(&right.started_at)
            .then_with(|| left.run_id.cmp(&right.run_id))
            .then_with(|| left.turn_id.cmp(&right.turn_id))
    });
    Some(Trace { turns, coverage })
}

fn merge_coverage(
    base: &SessionTraceCoverage,
    next: &SessionTraceCoverage,
) -> SessionTraceCoverage {
    use ModelCallCoverage::{Absent, NoActivity, NoKnownGap, Partial};
    let model_calls = match (&base.model_calls, &next.model_calls) {
        (NoActivity, other) | (other, NoActivity) => other.clone(),
        (Absent, Absent) => Absent,
        (NoKnownGap, NoKnownGap) => NoKnownGap,
        _ => Partial,
    };
    let identities = |left: &[TraceTurnIdentity], right: &[TraceTurnIdentity]| {
        let mut merged: Vec<TraceTurnIdentity> = Vec::new();
        for identity in left.iter().chain(right) {
            if !merged.contains(identity) {
                merged.push(identity.clone());
            }
        }
        merged
    };
    let mut merged = base.clone();
    merged.model_calls = model_calls;
    merged.turns_missing_model_calls =
        identities(&base.turns_missing_model_calls, &next.turns_missing_model_calls);
    merged.turns_with_fewer_model_calls_than_steps = identities(
        &base.turns_with_fewer_model_calls_than_steps,
        &next.turns_with_fewer_model_calls_than_steps,
    );
    merged.unreadable_records = base.unreadable_records + next.unreadable_records;
    merged.oversized_runs = base.oversized_runs + next.oversized_runs;
    merged
}

// The timeline.

/// What the timeline draws: its Turns newest first, the coverage notice
/// when the trace reports a gap, and whether there is nothing to draw
/// (`deriveInspectorPanelModel`).
#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct PanelModel {
    pub turns: Vec<TurnRow>,
    /// Present only when the trace itself reports a gap: a notice that
    /// always shows is a notice nobody reads.
    pub coverage: Option<CoverageNotice>,
    /// Nothing to draw, which a reported gap never is.
    pub empty: bool,
}

/// One Turn of the timeline.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct TurnRow {
    pub run_id: String,
    pub turn_id: String,
    /// Epoch milliseconds.
    pub started_at: f64,
    pub duration_ms: f64,
    /// The priced model calls' costs summed; absent when none is priced.
    pub cost_usd: Option<f64>,
    pub failed: bool,
    pub failure_code: Option<String>,
    pub steps: Vec<StepRow>,
}

impl TurnRow {
    /// The Turn's identity among every Turn of the trace (Desktop's
    /// `traceTurnIdentityKey`), for element ids and the open set.
    pub fn key(&self) -> String {
        turn_key(&self.run_id, &self.turn_id)
    }
}

/// A Turn's identity as a key: its run, then itself.
pub fn turn_key(run_id: &str, turn_id: &str) -> String {
    format!("{run_id}/{turn_id}")
}

/// What a step is, as the timeline names it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum StepKind {
    ModelCall,
    Tool,
    Permission,
    Compaction,
    Error,
    /// A step kind this client does not know, by its wire name.
    Other(String),
}

/// One step of a Turn.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct StepRow {
    pub id: String,
    pub kind: StepKind,
    /// The identifier the row is about (a model, a tool); absent when the
    /// kind is the name, which the view words in the reader's language.
    pub label: Option<String>,
    /// Supporting detail: an error's message, or a failed history
    /// compaction's provider facts.
    pub detail: Option<String>,
    /// Why the model was called, when not for the Turn itself.
    pub call_kind: Option<ModelCallKind>,
    /// How a permission request was answered.
    pub decision: Option<String>,
    pub duration_ms: Option<f64>,
    /// Attempts beyond the first.
    pub retries: Option<u64>,
    /// The pricing key (`provider:model`), only when an attempt was
    /// unpriced.
    pub unpriced_pricing_key: Option<String>,
    /// The recovery actually recorded, never the policy.
    pub recovered: Option<ToolRecoveryDisposition>,
    pub failed: bool,
}

impl StepRow {
    fn new(id: String, kind: StepKind) -> Self {
        Self {
            id,
            kind,
            label: None,
            detail: None,
            call_kind: None,
            decision: None,
            duration_ms: None,
            retries: None,
            unpriced_pricing_key: None,
            recovered: None,
            failed: false,
        }
    }
}

/// Whether the backend records no per-call detail at all, or only part.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum CoverageKind {
    Partial,
    Absent,
}

/// What the coverage notice says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct CoverageNotice {
    pub kind: CoverageKind,
    pub turns_missing: u64,
    pub turns_short: u64,
    pub unreadable_records: u64,
    pub oversized_runs: u64,
}

/// The timeline of `trace` (`deriveInspectorPanelModel`).
pub fn panel_model(trace: Option<&Trace>) -> PanelModel {
    let Some(trace) = trace else {
        return PanelModel { turns: Vec::new(), coverage: None, empty: true };
    };
    let turns: Vec<TurnRow> = trace
        .turns
        .iter()
        .rev()
        .map(|turn| {
            let attributed = turn.failure.as_ref().and_then(|f| f.attributed_to_step_id.as_deref());
            TurnRow {
                run_id: turn.run_id.clone(),
                turn_id: turn.turn_id.clone(),
                started_at: turn.started_at,
                duration_ms: turn.duration_ms,
                cost_usd: turn_cost(&turn.steps),
                failed: turn.failure.is_some(),
                failure_code: turn.failure.as_ref().map(|failure| failure.code.clone()),
                steps: turn
                    .steps
                    .iter()
                    .enumerate()
                    .map(|(ix, step)| step_row(ix, step, attributed))
                    .collect(),
            }
        })
        .collect();
    let coverage = coverage_notice(&trace.coverage);
    // A Session whose every record failed to decode has no Turns and a gap
    // to report: calling that empty would hide what the face is for.
    let empty = turns.is_empty() && coverage.is_none();
    PanelModel { turns, coverage, empty }
}

fn turn_cost(steps: &[TraceStep]) -> Option<f64> {
    steps.iter().fold(None, |total, step| match step {
        TraceStep::ModelCall(call) => match call.cost_usd {
            Some(cost) => Some(total.unwrap_or(0.) + cost),
            None => total,
        },
        _ => total,
    })
}

fn step_row(ix: usize, step: &TraceStep, attributed: Option<&str>) -> StepRow {
    let id = step.id().map_or_else(|| format!("step-{ix}"), str::to_owned);
    let blamed = attributed.is_some_and(|attributed| attributed == id);
    match step {
        TraceStep::ModelCall(call) => {
            let mut row = StepRow::new(id, StepKind::ModelCall);
            row.label = Some(call.model_id.clone());
            // `main` is what nearly every call is; a compaction or a title
            // call beside it is the fact worth printing.
            row.call_kind = (call.call_kind != ModelCallKind::Main).then(|| call.call_kind.clone());
            row.detail = history_compact_detail(call);
            row.duration_ms = Some(call.duration_ms);
            row.retries = (call.attempts.len() > 1).then(|| call.attempts.len() as u64 - 1);
            row.unpriced_pricing_key = call
                .attempts
                .iter()
                .any(|attempt| attempt.cost_basis == CostBasis::Unpriced)
                .then(|| pricing_key(&call.provider_id, &call.model_id));
            row.failed = blamed || call.status == host_protocol::ModelCallStatus::Failed;
            row
        }
        TraceStep::Tool(tool) => {
            let mut row = StepRow::new(id, StepKind::Tool);
            row.label = Some(tool.tool_name.clone());
            row.recovered = tool.recovered.as_ref().map(|recovered| recovered.disposition.clone());
            row.duration_ms = tool.duration_ms;
            row.failed = blamed || tool.status == ToolStepStatus::Failed;
            row
        }
        TraceStep::Permission(permission) => {
            let mut row = StepRow::new(id, StepKind::Permission);
            row.label = permission.tool_name.clone();
            row.decision = Some(permission.decision.clone());
            row
        }
        // No label and no detail: the kind is the whole fact. The
        // checkpoint id is a handle a reader cannot act on.
        TraceStep::Compaction(_) => StepRow::new(id, StepKind::Compaction),
        TraceStep::Error(error) => {
            let mut row = StepRow::new(id, StepKind::Error);
            row.detail = Some(error.message.clone());
            row.failed = true;
            row
        }
        _ => {
            let mut row = StepRow::new(id, StepKind::Other(step.tag().to_owned()));
            row.failed = blamed;
            row
        }
    }
}

/// `pricingModelKey` (`packages/core/src/usage-stats/pricing.ts`): the
/// canonical provider and the model, never the connection.
pub fn pricing_key(provider_id: &str, model_id: &str) -> String {
    format!("{provider_id}:{model_id}")
}

/// Compact, body-free provider facts for the one auxiliary call that needs
/// diagnosis (`historyCompactDiagnosticDetail`).
fn history_compact_detail(call: &TraceModelCallStep) -> Option<String> {
    if call.call_kind != ModelCallKind::HistoryCompact {
        return None;
    }
    let settled = call.attempts.last();
    let route =
        call.history_compact_route.as_ref().map(|route| format!("route={}", route.as_str()));
    let parts: Vec<String> = [
        route,
        settled.and_then(|a| a.error_class.as_ref()).map(|class| format!("error={class}")),
        settled.and_then(|a| a.http_status).map(|status| format!("HTTP {status}")),
        settled.and_then(|a| a.provider_code.as_ref()).map(|code| format!("code={code}")),
        settled.and_then(|a| a.provider_request_id.as_ref()).map(|id| format!("request={id}")),
        settled.and_then(|a| a.retryable).map(|retryable| format!("retryable={retryable}")),
    ]
    .into_iter()
    .flatten()
    .collect();
    (!parts.is_empty()).then(|| parts.join(" · "))
}

fn coverage_notice(coverage: &SessionTraceCoverage) -> Option<CoverageNotice> {
    let kind = match &coverage.model_calls {
        ModelCallCoverage::NoActivity | ModelCallCoverage::NoKnownGap => return None,
        ModelCallCoverage::Absent => CoverageKind::Absent,
        // A level this client cannot name still reports a gap; the safe
        // reading of it is that the figures undercount.
        _ => CoverageKind::Partial,
    };
    Some(CoverageNotice {
        kind,
        turns_missing: coverage.turns_missing_model_calls.len() as u64,
        turns_short: coverage.turns_with_fewer_model_calls_than_steps.len() as u64,
        unreadable_records: coverage.unreadable_records,
        oversized_runs: coverage.oversized_runs,
    })
}

// The overview.

/// A Session's usage summary and what it rests on, as `usage.query`'s
/// `summary` answers it.
#[derive(Debug, Clone, Copy, PartialEq)]
#[non_exhaustive]
pub struct SessionUsage {
    pub summary: UsageSummaryV2,
    pub provenance: UsageProvenance,
}

impl SessionUsage {
    pub fn new(summary: UsageSummaryV2, provenance: UsageProvenance) -> Self {
        Self { summary, provenance }
    }

    /// `estimatedSessionCost`: the total when some call was priced (or
    /// legacy records carry a positive amount), else unknown, never `$0`.
    pub fn estimated_cost(&self) -> Option<f64> {
        self.provenance.estimated_cost(self.summary.total_cost_usd)
    }

    /// `hasUnavailableSessionUsage`: real spend is missing from the totals.
    pub fn has_unavailable_usage(&self) -> bool {
        self.provenance.has_unavailable_usage()
    }
}

/// A band of the context window: the prompt split by what the provider's
/// cache served (`CacheRead` and `Fresh`), the prompt whole when it
/// reported no cache figure (`Used`, an unsplit band, not a zero cache),
/// and the headroom (`Free`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextBand {
    CacheRead,
    Fresh,
    Used,
    Free,
}

/// The latest settled request's prompt against the window it ran under
/// (`InspectorContextBudget`). "Used" is the request's `inputTokens`, not
/// input and output: the snapshot carries no output, and the prompt is what
/// the next request starts from, as Desktop's `live-context-usage` reads it.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct ContextBudget {
    pub used_tokens: u64,
    /// The window the request was metered against, frozen at call time.
    pub window_tokens: u64,
    /// `used / window`, clamped only for drawing.
    pub ratio: f64,
    /// In reading order, empty bands dropped, so a bar and its legend
    /// cannot disagree.
    pub segments: Vec<(ContextBand, u64)>,
}

/// How full the window is, by Desktop's tiers: a warning from 70 %, an
/// error from 90 %.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextLevel {
    Normal,
    Warning,
    Error,
}

impl ContextBudget {
    pub fn level(&self) -> ContextLevel {
        if self.ratio >= 0.9 {
            ContextLevel::Error
        } else if self.ratio >= 0.7 {
            ContextLevel::Warning
        } else {
            ContextLevel::Normal
        }
    }
}

/// A row of what the request was made of, its tokens estimated from bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct CompositionPart {
    pub kind: ContextSegmentKind,
    pub estimated_tokens: u64,
}

/// What the request was made of (`InspectorComposition`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct Composition {
    pub parts: Vec<CompositionPart>,
    /// The largest tool schemas, largest first: the ones worth removing.
    pub tools: Vec<(String, u64)>,
    /// Everything below the visible tools, folded rather than dropped:
    /// how many, and their estimate.
    pub remaining_tools: Option<(u64, u64)>,
    /// Tool schemas the request did not name, counted, never attributed.
    pub unlabelled_tools: Option<u64>,
}

/// The composition of the request the bar measures, or why there is none:
/// a request the durable record names with no capture behind it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum CompositionState {
    Available(Composition),
    Unrecorded,
}

/// A band of the token split, in the order a bill reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenKind {
    CacheRead,
    CacheMiss,
    Output,
}

/// The Session's metered tokens split the way a bill reads
/// (`InspectorTokenUsage`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct TokenUsage {
    /// The sum of what is drawn, so the rows and their total agree.
    pub total: u64,
    pub segments: Vec<(TokenKind, u64)>,
}

impl TokenUsage {
    /// The share that dominates the bill, which the section's figure names.
    pub fn dominant(&self) -> Option<(TokenKind, u64)> {
        self.segments
            .iter()
            .copied()
            .reduce(|left, right| if right.1 > left.1 { right } else { left })
    }
}

/// A band of the time split.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurationKind {
    Model,
    Tool,
}

/// One band of the time split: how many ran, and their recorded time.
#[derive(Debug, Clone, Copy, PartialEq)]
#[non_exhaustive]
pub struct DurationSegment {
    pub kind: DurationKind,
    pub count: u64,
    pub duration_ms: f64,
}

/// Where the Session's recorded time went (`InspectorDurationUsage`): a sum
/// of per-call durations, not wall-clock.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct DurationUsage {
    pub total_duration_ms: f64,
    pub segments: Vec<DurationSegment>,
}

/// The overview's figures (`InspectorOverviewModel`). The two owners stay
/// apart: the context snapshot answers what the context holds now, the
/// usage summary what every recorded call cost; one unavailable cannot
/// falsify the other.
#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct OverviewModel {
    /// Absent when the snapshot reports no prompt or no window to measure
    /// it against: a bar with no denominator is not a bar.
    pub context: Option<ContextBudget>,
    pub composition: Option<CompositionState>,
    /// Cache read over input, Session-wide; absent when nothing was metered
    /// or usage is partial: a rate over a part is not a rate.
    pub cache_hit_rate: Option<f64>,
    pub token_usage: Option<TokenUsage>,
    pub duration_usage: Option<DurationUsage>,
}

/// The overview of `context` and `usage` (`deriveInspectorOverviewModel`).
pub fn overview_model(
    context: Option<&ContextDiagnosticsResult>,
    usage: Option<&SessionUsage>,
) -> OverviewModel {
    let snapshot = match context {
        Some(ContextDiagnosticsResult::Available(snapshot)) => Some(snapshot),
        _ => None,
    };
    OverviewModel {
        context: snapshot.and_then(context_budget),
        composition: snapshot.map(|snapshot| composition_state(snapshot.composition.as_ref())),
        cache_hit_rate: usage.and_then(cache_hit_rate),
        token_usage: usage.and_then(token_split),
        duration_usage: usage.and_then(duration_split),
    }
}

fn context_budget(snapshot: &ContextDiagnostics) -> Option<ContextBudget> {
    let used = snapshot.input_tokens?;
    let window = snapshot.context_window.filter(|window| *window > 0)?;
    // A cache figure larger than its prompt is not a fact about the window.
    let prompt = match snapshot.cache_read_input_tokens.map(|cache| cache.min(used)) {
        Some(cache) => {
            vec![(ContextBand::CacheRead, cache), (ContextBand::Fresh, used - cache)]
        }
        None => vec![(ContextBand::Used, used)],
    };
    let segments = prompt
        .into_iter()
        .chain([(ContextBand::Free, window.saturating_sub(used))])
        .filter(|(_, tokens)| *tokens > 0)
        .collect();
    Some(ContextBudget {
        used_tokens: used,
        window_tokens: window,
        ratio: used as f64 / window as f64,
        segments,
    })
}

/// How many tool rows are shown: the decision to remove a tool is made off
/// the biggest few.
pub const VISIBLE_TOOL_ROWS: usize = 5;

fn composition_state(composition: Option<&ContextComposition>) -> CompositionState {
    let Some(composition) = composition else {
        return CompositionState::Unrecorded;
    };
    let tools = composition.tools.as_deref().unwrap_or_default();
    let (visible, hidden) = tools.split_at(tools.len().min(VISIBLE_TOOL_ROWS));
    // The Host already folded what is past its own cap; the face's
    // remainder is its hidden rows plus that fold.
    let producer = composition.remaining_tools.as_ref();
    let remaining_count = hidden.len() as u64 + producer.map_or(0, |fold| fold.count);
    let remaining_bytes =
        hidden.iter().map(|tool| tool.bytes).sum::<u64>() + producer.map_or(0, |fold| fold.bytes);
    CompositionState::Available(Composition {
        parts: composition
            .segments
            .iter()
            .map(|segment| CompositionPart {
                kind: segment.kind.clone(),
                estimated_tokens: estimate_tokens(segment.bytes),
            })
            .collect(),
        tools: visible
            .iter()
            .map(|tool| (tool.name.clone(), estimate_tokens(tool.bytes)))
            .collect(),
        remaining_tools: (remaining_count > 0)
            .then(|| (remaining_count, estimate_tokens(remaining_bytes))),
        unlabelled_tools: composition.unlabelled_tool_bytes.map(estimate_tokens),
    })
}

/// The four-bytes-per-token rule `/context` prints, at the display layer
/// only, and always shown with `≈`.
pub fn estimate_tokens(bytes: u64) -> u64 {
    bytes.div_ceil(4)
}

fn cache_hit_rate(usage: &SessionUsage) -> Option<f64> {
    let tokens = usage.summary.total_tokens;
    let coverage = usage.provenance.coverage;
    if tokens.input == 0
        || coverage.usage_partial_attempts > 0
        || coverage.usage_missing_attempts > 0
    {
        return None;
    }
    Some(tokens.cache_read as f64 / tokens.input as f64)
}

/// The bill-shaped split: the uncached input is the prompt's residual
/// (several providers report only the cached share), with the ledger's own
/// miss as a floor; the cached share as reported, even above the prompt.
fn token_split(usage: &SessionUsage) -> Option<TokenUsage> {
    let tokens = usage.summary.total_tokens;
    if tokens.input + tokens.output == 0 {
        return None;
    }
    let uncached = tokens.input.saturating_sub(tokens.cache_read).max(tokens.cache_miss);
    let segments: Vec<(TokenKind, u64)> = [
        (TokenKind::CacheRead, tokens.cache_read),
        (TokenKind::CacheMiss, uncached),
        (TokenKind::Output, tokens.output),
    ]
    .into_iter()
    .filter(|(_, tokens)| *tokens > 0)
    .collect();
    Some(TokenUsage { total: segments.iter().map(|(_, tokens)| tokens).sum(), segments })
}

/// Model-call time against tool time, each from its own ledger. A host
/// that measured zero model time keeps its row (the count is real); a row
/// with neither a clock nor a count is dropped.
fn duration_split(usage: &SessionUsage) -> Option<DurationUsage> {
    let summary = usage.summary;
    let segments: Vec<DurationSegment> = std::iter::once(DurationSegment {
        kind: DurationKind::Model,
        count: summary.total_requests,
        duration_ms: summary.total_duration_ms as f64,
    })
    .chain(summary.tool_usage.map(|tools| DurationSegment {
        kind: DurationKind::Tool,
        count: tools.requests,
        duration_ms: tools.duration_ms as f64,
    }))
    .filter(|segment| segment.duration_ms > 0. || segment.count > 0)
    .collect();
    if segments.is_empty() {
        return None;
    }
    Some(DurationUsage {
        total_duration_ms: segments.iter().map(|segment| segment.duration_ms).sum(),
        segments,
    })
}

// How figures are written.

/// `formatDuration`: "820ms", "8.6s", "1m31s". Minutes count the rounded
/// seconds, so 119.6 s reads "2m0s" (Desktop's rounds the seconds alone
/// and writes "1m60s").
pub fn format_duration(ms: f64) -> String {
    if ms < 1_000. {
        return format!("{}ms", ms.round());
    }
    if ms < 60_000. {
        return format!("{}s", fixed(ms / 1_000., 1));
    }
    let seconds = (ms / 1_000.).round() as u64;
    format!("{}m{}s", seconds / 60, seconds % 60)
}

/// `formatCost`: "$0.0012" under a cent, else "$0.25"; `None` (nobody could
/// price it) when absent, never "$0.00".
pub fn format_cost(cost: Option<f64>) -> Option<String> {
    let cost = cost?;
    Some(if cost < 0.01 { format!("${}", fixed(cost, 4)) } else { format!("${}", fixed(cost, 2)) })
}

/// `formatPercent`: "45.0%".
pub fn format_percent(ratio: f64) -> String {
    format!("{}%", fixed(ratio * 100., 1))
}

/// `formatCompactTokenCount`: "999", "1.2K", "3M", "1.5B".
pub fn compact_tokens(value: u64) -> String {
    const UNITS: [(u64, &str); 3] = [(1_000, "K"), (1_000_000, "M"), (1_000_000_000, "B")];
    if value < 1_000 {
        return value.to_string();
    }
    let mut unit = UNITS.len() - 1;
    while unit > 0 && value < UNITS[unit].0 {
        unit -= 1;
    }
    let mut compact = (value as f64 / UNITS[unit].0 as f64 * 10.).round() / 10.;
    if compact >= 1_000. && unit < UNITS.len() - 1 {
        unit += 1;
        compact = 1.;
    }
    format!("{compact}{}", UNITS[unit].1)
}

/// A whole figure with its thousands grouped, as `Intl.NumberFormat` writes
/// it in English and Chinese alike: "33,016".
pub fn group_digits(value: u64) -> String {
    let digits = value.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (ix, digit) in digits.chars().enumerate() {
        if ix > 0 && (digits.len() - ix).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

/// `value` with `digits` decimals, halves rounded away from zero as
/// `toFixed` writes the figures here.
fn fixed(value: f64, digits: usize) -> String {
    let scale = 10f64.powi(digits as i32);
    format!("{:.digits$}", (value * scale).round() / scale)
}
