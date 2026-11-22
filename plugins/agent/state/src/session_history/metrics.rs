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

use super::*;
use maka_agent_facts::{
    execution::ModelBinding,
    model::{ModelUsage, PromptCacheUsage},
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionModelMetrics {
    pub run: RunId,
    pub step: StepId,
    pub attempt: ModelAttemptId,
    pub model_id: String,
    pub binding: ModelBinding,
    pub requested_at: Option<UnixMillis>,
    pub finished_at: Option<UnixMillis>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_time_ms: Option<u64>,
    pub usage: ModelUsage,
    pub context_tokens: Option<u64>,
    pub context_window: Option<u64>,
    pub context_last_known: bool,
    pub provenance: ContentRef,
}

use super::{
    snapshot::{
        IndexedRead, IndexedReadError, Snapshot,
        metrics_metadata::{self, ModelMetadata},
        run_with_snapshot_rebuild,
    },
    source_tree::{HistoryDataSource, Segment, SourceTree},
};
use crate::store::invalid;
use maka_agent_facts::{
    accounting::{ModelEvidence, Origin, Outcome},
    context::{ModelPurpose, RequestContextEvidence},
    history_snapshot::{Entry, Origin as SnapshotOrigin},
};
use rusqlite::{OptionalExtension, params};
use serde::de::DeserializeOwned;
use std::io::Read;
use tokio_util::sync::CancellationToken;

mod request_outcome;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelCalibrationSample {
    pub binding: ModelBinding,
    pub model_id: String,
    pub input_tokens: u64,
    pub original_estimate: u64,
    pub route_identity: String,
    pub previous_checkpoint_id: Option<String>,
}

pub struct CurrentModelContext {
    pub source: HistoryDataSource,
    pub path: Vec<RunId>,
    pub run: RunId,
    pub step: StepId,
    pub tokens: Option<u64>,
    pub continuation: Option<maka_agent_facts::context::CodexContinuation>,
}

impl SessionHistory {
    pub async fn current_model_context(
        &self,
        cut: &HistoryCut,
        stop: Option<&CancellationToken>,
    ) -> Result<Option<CurrentModelContext>, StoreError> {
        run_with_snapshot_rebuild(stop, || {
            self.data
                .query(ReadCurrentContext(self.clone(), cut.clone()))
        })
        .await
    }

    pub async fn metrics(
        &self,
        cut: &HistoryCut,
        stop: Option<&CancellationToken>,
    ) -> Result<Option<SessionModelMetrics>, StoreError> {
        run_with_snapshot_rebuild(stop, || {
            self.data.query(ReadMetrics(self.clone(), cut.clone()))
        })
        .await
    }
    pub async fn calibration_sample(
        &self,
        cut: &HistoryCut,
        stop: Option<&CancellationToken>,
    ) -> Result<Option<ModelCalibrationSample>, StoreError> {
        run_with_snapshot_rebuild(stop, || {
            self.data.query(ReadCalibration(self.clone(), cut.clone()))
        })
        .await
    }
}

#[derive(Debug)]
pub struct ModelRequestTrace {
    pub sequence: u64,
    pub step: StepId,
    pub attempt: ModelAttemptId,
    pub model_id: String,
    pub purpose: ModelPurpose,
    pub started_at: Option<UnixMillis>,
    pub first_token_at: Option<UnixMillis>,
    pub finished: Option<ModelRequestTraceFinished>,
    pub retry: Option<ModelRequestRetry>,
    pub context: ModelRequestContextTrace,
}

pub struct ModelRequestTracePage {
    pub requests: Vec<ModelRequestTrace>,
    pub run_terminated: bool,
}

#[derive(Debug)]
pub struct ModelRequestTraceFinished {
    evidence: DiagnosticEvidence,
    pub at: UnixMillis,
    pub outcome: Outcome,
    pub usage: ModelUsage,
    pub diagnostic: Option<String>,
}

#[derive(Debug)]
pub enum ModelRequestRetry {
    Scheduled { at: UnixMillis },
    Started,
    Cancelled,
}

fn trace_diagnostic(
    c: &Connection,
    fact: RecordedFact,
    attempt: ModelAttemptId,
) -> Result<(Option<String>, DiagnosticEvidence), StoreError> {
    let Fact::ModelClosed {
        attempt: original,
        outcome,
        diagnostic,
        ..
    } = fact.fact
    else {
        return Err(invalid("request trace closure is not its original fact"));
    };
    if original != attempt {
        return Err(invalid("request trace closure has another attempt"));
    }
    let Some(text) = diagnostic else {
        return Ok((None, DiagnosticEvidence::default()));
    };
    let sources = if outcome == Outcome::Error {
        related_diagnostics(c, fact.id, &text)?
    } else {
        vec![fact.id]
    };
    Ok(diagnostic_preview(Some(&text), sources))
}

// A historical cut freezes the trace. Evidence may be attached later to the
// same diagnostic on the final Run or the original attempt's interruption.
fn related_diagnostics(
    c: &Connection,
    fact: FactId,
    text: &str,
) -> Result<Vec<FactId>, StoreError> {
    let mut stmt = c.prepare_cached(
        "WITH origin AS MATERIALIZED (
            SELECT run,step,attempt,sequence,kind FROM agent_session_history WHERE fact_id=?1
         ), related(sequence,fact_id) AS (
            SELECT t.sequence,t.fact_id FROM origin o
            JOIN agent_runs r ON r.run=o.run AND r.current_step=o.step AND r.current_attempt=o.attempt
            JOIN agent_session_history t ON t.run=r.run AND t.kind='run_terminated' AND t.sequence>o.sequence
            WHERE o.kind='model_closed' AND r.terminal=json_quote('failed')
            UNION ALL
            SELECT i.sequence,i.fact_id FROM origin o
            CROSS JOIN agent_session_history i INDEXED BY agent_memory_interruption_attempt
            ON i.run=o.run AND i.step=o.step AND i.attempt=o.attempt
              AND i.kind='model_interrupted' AND i.sequence>o.sequence
            WHERE o.kind='model_source_failure_captured'
         )
         SELECT r.fact_id FROM related r JOIN agent_facts f ON f.sequence=r.sequence
         JOIN contents b ON b.id=f.body_content_id WHERE CAST(b.payload AS TEXT)->>'$.fact.diagnostic'=?2",
    )?;
    let mut sources = vec![fact];
    for row in stmt.query_map(params![fact.to_string(), text], |r| r.get::<_, String>(0))? {
        sources.push(sql::identity(row?)?);
    }
    Ok(sources)
}

#[derive(Debug, Default)]
struct DiagnosticEvidence {
    facts: Vec<FactId>,
    offset: u64,
    prefix_bytes: usize,
}

fn diagnostic_preview(
    text: Option<&str>,
    facts: Vec<FactId>,
) -> (Option<String>, DiagnosticEvidence) {
    let Some(text) = text else {
        return (None, DiagnosticEvidence::default());
    };
    const LIMIT: usize = 512;
    let trimmed = text.trim_start();
    let offset = (text.len() - trimmed.len()) as u64;
    let mut chars = trimmed.trim_end().chars();
    let mut preview: String = chars.by_ref().take(LIMIT).collect();
    let prefix_bytes = preview.len();
    if chars.next().is_some() {
        preview.push('…');
    }
    (
        Some(preview),
        DiagnosticEvidence {
            facts,
            offset,
            prefix_bytes,
        },
    )
}

impl DiagnosticEvidence {
    fn mask(&self, diagnostic: &mut Option<String>, spans: &[(u64, u64)]) {
        let Some(preview) = diagnostic else {
            return;
        };
        let end = self.offset + self.prefix_bytes as u64;
        // The ellipsis is generated by the preview; evidence indexes original bytes.
        if spans
            .iter()
            .any(|&(start, stop)| start <= self.offset && stop >= end)
        {
            *diagnostic = None;
            return;
        }
        let truncated = preview.len() > self.prefix_bytes;
        preview.truncate(self.prefix_bytes);
        crate::memory::recall::mask(preview, self.offset, spans);
        if truncated {
            preview.push('…');
        }
    }
}

fn mask_request_diagnostics(
    c: &Connection,
    snapshot: Option<maka_agent_facts::history_snapshot::SnapshotId>,
    owner: &RunOwner,
    traces: &mut [ModelRequestTrace],
) -> Result<(), StoreError> {
    let keys: Vec<_> = traces
        .iter()
        .enumerate()
        .filter_map(|(i, t)| t.finished.as_ref().map(|f| (i, f)))
        .flat_map(|(i, f)| f.evidence.facts.iter().map(move |id| (i, *id, 0, snapshot)))
        .collect();
    if keys.is_empty() {
        return Ok(());
    }
    for (i, spans) in crate::memory::recall::indexed_spans(c, owner, &keys, &[])? {
        let finished = traces[i]
            .finished
            .as_mut()
            .expect("queried a finished trace");
        finished.evidence.mask(&mut finished.diagnostic, &spans);
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequestContextTrace {
    pub estimated_input_tokens: u64,
    pub model_context: Option<maka_agent_facts::context::ModelRequestContext>,
}

impl HistoryDataSource {
    /// Usage of the main model attempts in a single live-history Run.
    pub async fn main_model_usage(
        &self,
        run: RunId,
    ) -> Result<(Option<ModelUsage>, Option<PromptCacheUsage>), StoreError> {
        match self {
            Self::Live { history, cut } => {
                history
                    .data
                    .query(ReadMainModelUsage(
                        history.namespace.clone(),
                        cut.clone(),
                        run,
                    ))
                    .await
            }
            Self::Snapshot(_) => Ok((None, None)),
        }
    }

    /// A bounded page of original model attempts for one already scoped Run.
    pub async fn model_request_traces(
        &self,
        run: RunId,
        after: u64,
        limit: u32,
    ) -> Result<ModelRequestTracePage, StoreError> {
        self.model_request_traces_for_reader(run, after, limit, false, None)
            .await
    }

    pub async fn model_request_traces_for_reader(
        &self,
        run: RunId,
        after: u64,
        limit: u32,
        mask_evidence: bool,
        stop: Option<&CancellationToken>,
    ) -> Result<ModelRequestTracePage, StoreError> {
        let query = ReadRequestTraces(self.clone(), run, after, limit, mask_evidence);
        match self {
            Self::Live { history, .. } => match history.data.query(query).await? {
                IndexedRead::Ready(page) => Ok(page),
                IndexedRead::NeedsRebuild(_) => Err(invalid(
                    "live request traces unexpectedly requested snapshot rebuild",
                )),
            },
            Self::Snapshot(snapshot) => snapshot.query_request_traces(query, stop).await,
        }
    }
}

struct ReadMainModelUsage(HistoryNamespace, HistoryCut, RunId);
impl Query for ReadMainModelUsage {
    type Output = (Option<ModelUsage>, Option<PromptCacheUsage>);
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let Self(history, cut, run) = self;
        sql::validate_cut(c, &history.owner, &history.session, &cut)?;
        let mut statement = c.prepare_cached(
            "SELECT r.input,r.cache_read,
                json_extract(CAST(b.payload AS TEXT),'$.fact.protocol.cacheReadReported'), r.output
             FROM agent_session_history h INDEXED BY agent_session_history_run
             JOIN agent_usage_calls u ON u.request='model:'||h.run||':'||h.attempt
                  AND u.admission_sequence=h.sequence
             LEFT JOIN agent_usage_results r ON r.request=u.request AND r.sequence=(
                  SELECT v.sequence FROM agent_usage_results v
                  WHERE v.request=u.request AND v.sequence<=?4 ORDER BY v.sequence DESC LIMIT 1)
             LEFT JOIN agent_facts f ON r.cache_read=0 AND f.sequence=r.sequence
             LEFT JOIN contents b ON b.id=f.body_content_id
             WHERE h.owner=?1 AND h.session=?2 AND h.run=?3 AND h.sequence<=?4
               AND h.kind='model_attempt_prepared' AND u.purpose=?5",
        )?;
        let mut rows = statement.query(params![
            serde_json::to_string(&history.owner)?,
            history.session,
            run.to_string(),
            sql::bind_u64(cut.through_sequence)?,
            serde_json::to_string(&ModelPurpose::Main)?,
        ])?;
        let (mut input, mut output, mut read) = (Some(0u64), Some(0u64), Some(0u64));
        let mut seen = false;
        while let Some(row) = rows.next()? {
            seen = true;
            let attempt_input = counter(row.get(0)?)?;
            let attempt_read = counter(row.get(1)?)?;
            let attempt_output = counter(row.get(3)?)?;
            let sum =
                |total: Option<u64>, next| total.zip(next).and_then(|(a, b)| a.checked_add(b));
            input = sum(input, attempt_input);
            output = sum(output, attempt_output);
            read = sum(
                read,
                attempt_read.filter(|value| Some(*value) <= attempt_input),
            );
            if attempt_read == Some(0) && row.get::<_, Option<bool>>(2)? != Some(true) {
                read = None;
            }
        }
        let cache = input
            .zip(read)
            .and_then(|(i, r)| PromptCacheUsage::new(i, r));
        let tokens = (seen && (input.is_some() || output.is_some())).then_some(ModelUsage {
            input_tokens: input,
            output_tokens: output,
            ..Default::default()
        });
        Ok((tokens, cache))
    }
}

#[derive(Clone)]
pub(super) struct ReadRequestTraces(HistoryDataSource, RunId, u64, u32, bool);
impl Query for ReadRequestTraces {
    type Output = IndexedRead<ModelRequestTracePage>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let Self(source, run, after, limit, mask_evidence) = self;
        let mut traces = Vec::new();
        let mut contexts = std::collections::BTreeMap::<StepId, ModelRequestContextTrace>::new();
        let through = match &source {
            HistoryDataSource::Live { history, cut } => {
                sql::validate_cut(c, &history.namespace.owner, &history.namespace.session, cut)?;
                cut.through_sequence
            }
            HistoryDataSource::Snapshot(snapshot) => match snapshot_bound(c, snapshot) {
                Ok(bound) => bound,
                Err(IndexedReadError::NeedsRebuild(snapshots)) => {
                    return Ok(IndexedRead::NeedsRebuild(snapshots));
                }
                Err(IndexedReadError::Store(error)) => return Err(error),
            },
        };
        let end = request_outcome::run_end(c, &source, run, through)?;
        match &source {
            HistoryDataSource::Live { history, cut } => {
                let mut statement = c.prepare_cached(
                    "SELECT h.sequence,h.step,h.attempt,u.request,u.model_id,u.purpose
                     FROM agent_session_history h INDEXED BY agent_session_history_run
                     JOIN agent_usage_calls u ON u.request='model:'||h.run||':'||h.attempt
                          AND u.source='fact' AND u.owner=h.owner AND u.session=h.session
                          AND u.run=h.run AND u.admission_sequence=h.sequence
                     WHERE h.owner=? AND h.session=? AND h.run=?
                       AND h.kind IN ('model_attempt_prepared','proactive_summary_prepared')
                       AND h.sequence>? AND h.sequence<=? ORDER BY h.sequence LIMIT ?",
                )?;
                let mut rows = statement.query(params![
                    serde_json::to_string(&history.namespace.owner)?,
                    history.namespace.session,
                    run.to_string(),
                    sql::bind_u64(after)?,
                    sql::bind_u64(cut.through_sequence)?,
                    limit,
                ])?;
                while let Some(row) = rows.next()? {
                    let step = sql::identity(row.get(1)?)?;
                    let attempt = sql::identity(row.get(2)?)?;
                    let request: String = row.get(3)?;
                    if let std::collections::btree_map::Entry::Vacant(entry) = contexts.entry(step)
                    {
                        let (spec, _) =
                            sql::request_preparation(c, &history.namespace, cut, run, step)?;
                        entry.insert(metadata(c, &source, run, &spec.provenance)?);
                    }
                    let finished = live_closed(c, history, cut, run, step, attempt, &request)?
                        .map(|closed| {
                            let (diagnostic, evidence) = if closed.outcome == Outcome::Success {
                                (None, DiagnosticEvidence::default())
                            } else {
                                let item = sql::item(c, &history.namespace, cut, closed.sequence)?
                                    .ok_or_else(|| invalid("request trace closure is absent"))?;
                                trace_diagnostic(c, item.recorded, attempt)?
                            };
                            Ok::<_, StoreError>(ModelRequestTraceFinished {
                                evidence,
                                at: closed.at,
                                outcome: closed.outcome,
                                usage: closed.usage,
                                diagnostic,
                            })
                        })
                        .transpose()?;
                    let (finished, retry) =
                        request_outcome::read(c, &source, run, step, attempt, finished, &end)?;
                    traces.push(ModelRequestTrace {
                        sequence: sql::read_u64(row, 0)?,
                        step,
                        attempt,
                        model_id: row.get(4)?,
                        purpose: serde_json::from_str(&row.get::<_, String>(5)?)?,
                        started_at: live_time(c, history, cut, run, step, attempt)?,
                        first_token_at: live_model_time(
                            c,
                            history,
                            cut,
                            run,
                            step,
                            attempt,
                            "model_first_token_observed",
                        )?,
                        finished,
                        retry,
                        context: contexts[&step].clone(),
                    });
                }
            }
            HistoryDataSource::Snapshot(snapshot) => {
                let bound = through;
                let mut statement = c.prepare_cached(
                    "SELECT entry_json FROM agent_history_snapshot_entries
                     WHERE snapshot=? AND kind='fact' AND run=?
                       AND fact_kind IN ('model_attempt_prepared','proactive_summary_prepared')
                       AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?",
                )?;
                let mut rows = statement.query(params![
                    snapshot.id().to_string(),
                    run.to_string(),
                    sql::bind_u64(after)?,
                    sql::bind_u64(bound)?,
                    limit,
                ])?;
                while let Some(row) = rows.next()? {
                    let original = copied_fact(c, snapshot, &row.get::<_, String>(0)?, bound)?;
                    let step = original
                        .step
                        .ok_or_else(|| invalid("request trace missing Step"))?;
                    let attempt = original
                        .attempt
                        .ok_or_else(|| invalid("request trace missing attempt"))?;
                    let raw: String = c.query_row(
                        "SELECT model_json FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_step
                         WHERE snapshot=? AND kind='fact' AND run=? AND json_extract(entry_json,'$.step')=?
                           AND fact_kind IN ('step_prepared','proactive_summary_prepared')
                           AND sequence<=? ORDER BY sequence LIMIT 1",
                        params![snapshot.id().to_string(), run.to_string(), step.to_string(), sql::bind_u64(original.sequence)?],
                        |row| row.get(0),
                    )?;
                    let ModelMetadata::Prepared {
                        accounting,
                        provenance,
                    } = serde_json::from_str(&raw)?
                    else {
                        return Err(invalid("request trace missing copied preparation"));
                    };
                    if let std::collections::btree_map::Entry::Vacant(entry) = contexts.entry(step)
                    {
                        entry.insert(metadata(c, &source, run, &provenance)?);
                    }
                    let started_at =
                        copied_closed(c, snapshot, bound, &original, "model_attempt_admitted")?
                            .map(|(_, metadata)| match metadata {
                                ModelMetadata::Admitted { at } => Ok(at),
                                _ => Err(invalid("request trace invalid copied admission")),
                            })
                            .transpose()?;
                    let first_token_at =
                        copied_closed(c, snapshot, bound, &original, "model_first_token_observed")?
                            .map(|(_, metadata)| match metadata {
                                ModelMetadata::FirstToken { at } => Ok(at),
                                _ => Err(invalid("request trace invalid copied first token")),
                            })
                            .transpose()?;
                    let finished = copied_closed(c, snapshot, bound, &original, "model_closed")?
                        .map(|(closed, evidence)| {
                            let ModelMetadata::Closed {
                                at, outcome, usage, ..
                            } = evidence
                            else {
                                return Err(invalid("request trace invalid copied closure"));
                            };
                            let (diagnostic, evidence) = if outcome == Outcome::Success {
                                (None, DiagnosticEvidence::default())
                            } else {
                                trace_diagnostic(
                                    c,
                                    metadata(c, &source, run, &closed.body)?,
                                    attempt,
                                )?
                            };
                            Ok(ModelRequestTraceFinished {
                                evidence,
                                at,
                                outcome,
                                usage,
                                diagnostic,
                            })
                        })
                        .transpose()?;
                    let (finished, retry) =
                        request_outcome::read(c, &source, run, step, attempt, finished, &end)?;
                    traces.push(ModelRequestTrace {
                        sequence: original.sequence,
                        step,
                        attempt,
                        model_id: accounting.model_id,
                        purpose: accounting.purpose,
                        started_at,
                        first_token_at,
                        finished,
                        retry,
                        context: contexts[&step].clone(),
                    });
                }
            }
        }
        if mask_evidence {
            let (owner, snapshot) = match &source {
                HistoryDataSource::Live { history, .. } => (&history.namespace.owner, None),
                HistoryDataSource::Snapshot(snapshot) => (snapshot.owner(), Some(snapshot.id())),
            };
            mask_request_diagnostics(c, snapshot, owner, &mut traces)?;
        }
        Ok(IndexedRead::Ready(ModelRequestTracePage {
            requests: traces,
            run_terminated: end.terminated(),
        }))
    }
}

#[derive(Clone, Copy)]
enum Selection {
    LatestSuccess,
    LatestRequest,
}
struct ReadMetrics(SessionHistory, HistoryCut);
struct ReadCalibration(SessionHistory, HistoryCut);
struct Closed {
    model_time_ms: Option<u64>,
    sequence: u64,
    at: UnixMillis,
    outcome: Outcome,
    usage: ModelUsage,
}
struct Sample {
    run: RunId,
    step: StepId,
    attempt: ModelAttemptId,
    prepared: u64,
    accounting: ModelEvidence,
    provenance: ContentRef,
    requested_at: Option<UnixMillis>,
    closed: Option<Closed>,
    context: Option<Provenance>,
    changed: bool,
    reset: bool,
}
struct Provenance {
    context: RequestContextEvidence,
    route_identity: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestMetadata {
    schema_version: u32,
    step: StepId,
    accounting: ModelEvidence,
    provenance: ContentRef,
}
impl Query for ReadMetrics {
    type Output = IndexedRead<Option<SessionModelMetrics>>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        IndexedRead::from_result(read_metrics(c, &self.0, &self.1))
    }
}
fn read_metrics(
    c: &Connection,
    history: &SessionHistory,
    cut: &HistoryCut,
) -> Result<Option<SessionModelMetrics>, IndexedReadError> {
    let Some(sample) = select(c, history, cut, Selection::LatestSuccess)? else {
        return Ok(None);
    };
    let closed = sample
        .closed
        .ok_or_else(|| invalid("successful metrics have no original closure"))?;
    let context = sample
        .context
        .ok_or_else(|| invalid("successful metrics have no original provenance"))?;
    let context_tokens = if sample.reset {
        None
    } else {
        closed
            .usage
            .input_tokens
            .zip(closed.usage.output_tokens)
            .and_then(|(input, output)| input.checked_add(output))
    };
    Ok(Some(SessionModelMetrics {
        run: sample.run,
        step: sample.step,
        attempt: sample.attempt,
        model_id: sample.accounting.model_id,
        binding: sample.accounting.binding,
        requested_at: sample.requested_at,
        finished_at: Some(closed.at),
        model_time_ms: closed.model_time_ms,
        usage: closed.usage,
        context_tokens,
        context_window: context
            .context
            .model_context
            .and_then(|context| context.model_context_window),
        context_last_known: sample.changed,
        provenance: sample.provenance,
    }))
}
impl Query for ReadCalibration {
    type Output = IndexedRead<Option<ModelCalibrationSample>>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        IndexedRead::from_result(read_calibration(c, &self.0, &self.1))
    }
}
fn read_calibration(
    c: &Connection,
    history: &SessionHistory,
    cut: &HistoryCut,
) -> Result<Option<ModelCalibrationSample>, IndexedReadError> {
    let Some(sample) = select(c, history, cut, Selection::LatestRequest)? else {
        return Ok(None);
    };
    let Some(closed) = sample
        .closed
        .filter(|closed| closed.outcome == Outcome::Success)
    else {
        return Ok(None);
    };
    let Some(input_tokens) = closed.usage.input_tokens.filter(|input| *input > 0) else {
        return Ok(None);
    };
    let Some(context) = sample.context else {
        return Ok(None);
    };
    let Some(route_identity) = context.route_identity else {
        return Ok(None);
    };
    Ok(Some(ModelCalibrationSample {
        binding: sample.accounting.binding,
        model_id: sample.accounting.model_id,
        input_tokens,
        original_estimate: context.context.breakdown.estimated_tokens(),
        route_identity,
        previous_checkpoint_id: context.context.previous_checkpoint_id,
    }))
}
fn select(
    c: &Connection,
    history: &SessionHistory,
    cut: &HistoryCut,
    selection: Selection,
) -> Result<Option<Sample>, IndexedReadError> {
    sql::validate_cut(c, &history.namespace.owner, &history.namespace.session, cut)?;
    let tree = SourceTree::build_in_snapshot(
        c,
        HistoryDataSource::Live {
            history: history.clone(),
            cut: cut.clone(),
        },
    )?;
    let mut changed = false;
    let mut reset = false;
    for segment in tree.sections().iter().rev() {
        let selected = match &segment.source {
            HistoryDataSource::Live { history, cut } => {
                live(c, history, cut, segment.after_admission, selection)?
            }
            HistoryDataSource::Snapshot(snapshot) => {
                copied(c, snapshot, segment.after_admission, selection)?
            }
        };
        if let Some(mut sample) = selected {
            if sample
                .closed
                .as_ref()
                .is_some_and(|closed| closed.outcome == Outcome::Success)
            {
                let raw: serde_json::Value =
                    metadata(c, &segment.source, sample.run, &sample.provenance)?;
                if raw.get("breakdown").is_none_or(|value| value.is_null()) {
                    if matches!(selection, Selection::LatestRequest) {
                        return Ok(Some(sample));
                    }
                    return Err(
                        invalid("metrics original request context breakdown is missing").into(),
                    );
                }
                let route_identity = raw
                    .get("routeIdentity")
                    .filter(|value| !value.is_null())
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()?;
                let context: RequestContextEvidence = serde_json::from_value(raw)?;
                context.breakdown.validate().map_err(invalid)?;
                if let Some(model) = &context.model_context {
                    model.validate().map_err(invalid)?;
                }
                sample.context = Some(Provenance {
                    context,
                    route_identity,
                });
            }
            if matches!(selection, Selection::LatestSuccess) {
                let additions = changes(c, segment, Some(&sample))?;
                sample.changed = changed || additions.0;
                sample.reset = reset || additions.1;
            }
            return Ok(Some(sample));
        }
        if matches!(selection, Selection::LatestSuccess) {
            let additions = changes(c, segment, None)?;
            changed |= additions.0;
            reset |= additions.1;
        }
    }
    Ok(None)
}
fn accepted(selection: Selection, closed: &Option<Closed>) -> bool {
    matches!(selection, Selection::LatestRequest)
        || closed
            .as_ref()
            .is_some_and(|closed| closed.outcome == Outcome::Success)
}
fn live(
    c: &Connection,
    history: &SessionHistory,
    cut: &HistoryCut,
    floor: u64,
    selection: Selection,
) -> Result<Option<Sample>, StoreError> {
    sql::validate_cut(c, &history.namespace.owner, &history.namespace.session, cut)?;
    let owner = serde_json::to_string(&history.namespace.owner)?;
    let kind = match selection {
        Selection::LatestSuccess => "model_closed",
        Selection::LatestRequest => "model_attempt_prepared",
    };
    let mut statement = c.prepare_cached("SELECT c.admission_sequence,h.run,h.step,h.attempt,(SELECT p.fact_id FROM agent_session_history p WHERE p.owner=h.owner AND p.session=h.session AND p.sequence=c.admission_sequence AND p.run=h.run AND p.step=h.step AND p.attempt=h.attempt AND p.kind IN ('model_attempt_prepared','proactive_summary_prepared')),c.request,c.source,c.kind,c.owner,c.session,c.run,c.purpose,c.origin_json FROM agent_session_history h INDEXED BY agent_session_history_kind LEFT JOIN agent_usage_calls c ON c.request='model:'||h.run||':'||h.attempt WHERE h.owner=? AND h.session=? AND h.kind=? AND h.sequence<=? AND h.admission_sequence>? ORDER BY h.sequence DESC")?;
    let mut rows = statement.query(params![
        owner,
        history.namespace.session,
        kind,
        sql::bind_u64(cut.through_sequence)?,
        sql::bind_u64(floor)?
    ])?;
    while let Some(row) = rows.next()? {
        let prepared = sql::read_u64(row, 0)?;
        let run: RunId = sql::identity(row.get(1)?)?;
        let step: StepId = sql::identity(row.get(2)?)?;
        let attempt: ModelAttemptId = sql::identity(row.get(3)?)?;
        let fact: FactId = sql::identity(row.get(4)?)?;
        if row.get::<_, Option<String>>(6)?.as_deref() != Some("fact")
            || row.get::<_, Option<String>>(7)?.as_deref() != Some("model")
            || row.get::<_, Option<String>>(8)?.as_deref() != Some(owner.as_str())
            || row.get::<_, Option<String>>(9)?.as_deref()
                != Some(history.namespace.session.as_str())
            || row.get::<_, Option<String>>(10)?.as_deref() != Some(run.to_string().as_str())
        {
            return Err(invalid(
                "metrics model request has no exact original accounting source",
            ));
        }
        let origin: Origin = serde_json::from_str(&row.get::<_, String>(12)?)?;
        let Origin::Agent {
            execution,
            link,
            purpose,
        } = origin
        else {
            return Err(invalid(
                "metrics model request is not native Agent evidence",
            ));
        };
        if link != (AgentStepLink { run, step, attempt })
            || execution.run_id != run
            || execution.session_id != history.namespace.session
        {
            return Err(invalid("metrics model request identity differs"));
        }
        let indexed_purpose: ModelPurpose = serde_json::from_str(&row.get::<_, String>(11)?)?;
        if purpose != indexed_purpose {
            return Err(invalid("metrics model request purpose differs"));
        }
        if purpose != ModelPurpose::Main {
            continue;
        }
        let original = crate::sql::fact(c, run, fact)?
            .ok_or_else(|| invalid("metrics original model request disappeared"))?;
        if !matches!(original.fact,Fact::ModelAttemptPrepared{attempt:actual,step:original_step} if actual==attempt && original_step==step)
        {
            return Err(invalid(
                "metrics request index differs from its canonical fact",
            ));
        }
        let source = sql::run_source(c, &history.namespace, run)?;
        if source.execution() != execution {
            return Err(invalid("metrics original execution changed"));
        }
        let closed = live_closed(
            c,
            history,
            cut,
            run,
            step,
            attempt,
            &row.get::<_, String>(5)?,
        )?;
        if closed
            .as_ref()
            .is_some_and(|closed| closed.sequence <= prepared)
        {
            return Err(invalid("metrics closure precedes its original request"));
        }
        if !accepted(selection, &closed) {
            continue;
        }
        let step_sequence: u64 = c.query_row("SELECT sequence FROM agent_session_history INDEXED BY agent_session_history_run WHERE owner=? AND session=? AND run=? AND step=? AND kind='step_prepared' AND sequence<=? ORDER BY sequence LIMIT 1",params![owner,history.namespace.session,run.to_string(),step.to_string(),sql::bind_u64(prepared)?],|r|sql::read_u64(r,0))?;
        let item = sql::item(c, &history.namespace, cut, step_sequence)?
            .ok_or_else(|| invalid("metrics original StepPrepared is missing"))?;
        let Fact::StepPrepared {
            step: actual,
            request,
            ..
        } = item.recorded.fact
        else {
            return Err(invalid("metrics request has no canonical StepPrepared"));
        };
        if actual != step || item.recorded.run != run {
            return Err(invalid("metrics original Step belongs to another request"));
        }
        let request: RequestMetadata = metadata(
            c,
            &HistoryDataSource::Live {
                history: history.clone(),
                cut: cut.clone(),
            },
            run,
            &request,
        )?;
        if request.schema_version != SCHEMA_VERSION
            || request.step != step
            || request.accounting.purpose != ModelPurpose::Main
        {
            return Err(invalid("metrics original request schema/purpose differs"));
        }
        request.accounting.validate().map_err(invalid)?;
        let requested_at = live_time(c, history, cut, run, step, attempt)?;
        return Ok(Some(Sample {
            run,
            step,
            attempt,
            prepared: step_sequence,
            accounting: request.accounting,
            provenance: request.provenance,
            requested_at,
            closed,
            context: None,
            changed: false,
            reset: false,
        }));
    }
    Ok(None)
}
fn live_closed(
    c: &Connection,
    history: &SessionHistory,
    cut: &HistoryCut,
    run: RunId,
    step: StepId,
    attempt: ModelAttemptId,
    request: &str,
) -> Result<Option<Closed>, StoreError> {
    type ClosedModelRow = (
        u64,
        String,
        u32,
        i64,
        String,
        Option<i64>,
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        Option<i64>,
    );
    let row: Option<ClosedModelRow> = c
        .query_row(
            "SELECT h.sequence, f.id, f.schema_version, f.at, f.run, r.completed_at, r.outcome,
                r.input, r.output, r.cache_read, r.cache_write, r.reasoning,
                json_extract(CAST(b.payload AS TEXT), '$.fact.protocol.modelTimeMs')
         FROM agent_session_history h INDEXED BY agent_session_history_run
         LEFT JOIN agent_facts f ON f.sequence=h.sequence AND f.id=h.fact_id
         LEFT JOIN contents b ON b.id=f.body_content_id
         LEFT JOIN agent_usage_results r ON r.request=?1 AND r.sequence=h.sequence
         WHERE h.owner=?2 AND h.session=?3 AND h.run=?4 AND h.step=?5
           AND h.kind='model_closed' AND h.attempt=?6 AND h.sequence<=?7
         ORDER BY h.sequence DESC LIMIT 1",
            params![
                request,
                serde_json::to_string(&history.namespace.owner)?,
                history.namespace.session,
                run.to_string(),
                step.to_string(),
                attempt.to_string(),
                sql::bind_u64(cut.through_sequence)?
            ],
            |r| {
                Ok((
                    sql::read_u64(r, 0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                    r.get(9)?,
                    r.get(10)?,
                    r.get(11)?,
                    r.get(12)?,
                ))
            },
        )
        .optional()?;
    let Some((
        sequence,
        id,
        schema,
        at,
        actual_run,
        completed,
        outcome,
        input,
        output,
        cache_read,
        cache_write,
        reasoning,
        model_time_ms,
    )) = row
    else {
        return Ok(None);
    };
    let _: FactId = sql::identity(id)?;
    if schema != SCHEMA_VERSION || at < 0 || actual_run != run.to_string() || completed != Some(at)
    {
        return Err(invalid(
            "metrics closure differs from its canonical accounting source",
        ));
    }
    let outcome: Outcome = sql::identity(
        outcome.ok_or_else(|| invalid("metrics closure accounting outcome is missing"))?,
    )?;
    Ok(Some(Closed {
        model_time_ms: counter(model_time_ms)?,
        sequence,
        at: UnixMillis(at),
        outcome,
        usage: ModelUsage {
            input_tokens: counter(input)?,
            output_tokens: counter(output)?,
            cache_read_tokens: counter(cache_read)?,
            cache_write_tokens: counter(cache_write)?,
            reasoning_tokens: counter(reasoning)?,
        },
    }))
}
fn live_time(
    c: &Connection,
    history: &SessionHistory,
    cut: &HistoryCut,
    run: RunId,
    step: StepId,
    attempt: ModelAttemptId,
) -> Result<Option<UnixMillis>, StoreError> {
    live_model_time(
        c,
        history,
        cut,
        run,
        step,
        attempt,
        "model_attempt_admitted",
    )
}

fn live_model_time(
    c: &Connection,
    history: &SessionHistory,
    cut: &HistoryCut,
    run: RunId,
    step: StepId,
    attempt: ModelAttemptId,
    kind: &str,
) -> Result<Option<UnixMillis>, StoreError> {
    let row:Option<(String,u32,i64)>=c.query_row("SELECT f.id,f.schema_version,f.at FROM agent_session_history h INDEXED BY agent_session_history_run LEFT JOIN agent_facts f ON f.sequence=h.sequence AND f.id=h.fact_id AND f.run=h.run WHERE h.owner=? AND h.session=? AND h.run=? AND h.step=? AND h.kind=? AND h.attempt=? AND h.sequence<=? ORDER BY h.sequence LIMIT 1",params![serde_json::to_string(&history.namespace.owner)?,history.namespace.session,run.to_string(),step.to_string(),kind,attempt.to_string(),sql::bind_u64(cut.through_sequence)?],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    row.map(|(id, schema, at)| {
        let _: FactId = sql::identity(id)?;
        if schema != SCHEMA_VERSION || at < 0 {
            return Err(invalid("metrics original model timing metadata differs"));
        }
        Ok(UnixMillis(at))
    })
    .transpose()
}
fn counter(value: Option<i64>) -> Result<Option<u64>, StoreError> {
    value
        .map(|value| {
            u64::try_from(value).map_err(|_| invalid("negative original model usage counter"))
        })
        .transpose()
}
fn snapshot_bound(c: &Connection, snapshot: &Snapshot) -> Result<u64, IndexedReadError> {
    metrics_metadata::require_ready(c, snapshot)?;
    let manifest = snapshot.manifest_in_snapshot(c)?;
    match manifest.origin {
        SnapshotOrigin::Canonical { cut } => Ok(cut.through_sequence),
        SnapshotOrigin::Imported { .. } => c
            .query_row(
                "SELECT coalesce(max(sequence),0) FROM agent_history_snapshot_entries WHERE snapshot=?",
                [snapshot.id().to_string()],
                |r| sql::read_u64(r, 0),
            )
            .map_err(IndexedReadError::from),
    }
}
struct CopiedFact {
    run: RunId,
    sequence: u64,
    admission: u64,
    step: Option<StepId>,
    attempt: Option<ModelAttemptId>,
    body: ContentRef,
}
fn copied_fact(
    c: &Connection,
    snapshot: &Snapshot,
    raw: &str,
    bound: u64,
) -> Result<CopiedFact, StoreError> {
    let Entry::Fact {
        run,
        sequence,
        admission_sequence,
        revision,
        step,
        attempt,
        id,
        body,
        ..
    } = serde_json::from_str(raw)?
    else {
        return Err(invalid("metrics snapshot source is not an original fact"));
    };
    if sequence == 0
        || sequence > bound
        || revision == 0
        || admission_sequence == 0
        || admission_sequence > sequence
    {
        return Err(invalid(
            "metrics snapshot fact is outside its actual source cut",
        ));
    }
    let pinned:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshot_entries e JOIN agent_history_snapshot_run_refs r ON r.snapshot=e.snapshot AND r.run=e.run JOIN agent_history_snapshot_pins p ON p.snapshot=r.snapshot AND p.content_id=r.content_id JOIN contents b ON b.id=p.content_id WHERE e.snapshot=? AND e.kind='fact' AND e.run=? AND e.sequence=? AND json_extract(e.entry_json,'$.id')=? AND b.content_sha256=? AND length(b.payload)=?)",params![snapshot.id().to_string(),run.to_string(),sql::bind_u64(sequence)?,id.to_string(),body.digest,sql::bind_u64(body.bytes)?],|r|r.get(0))?;
    if !pinned {
        return Err(invalid(
            "metrics snapshot fact lost its original PK/pinned body proof",
        ));
    }
    Ok(CopiedFact {
        run,
        sequence,
        admission: admission_sequence,
        step,
        attempt,
        body,
    })
}
fn copied(
    c: &Connection,
    snapshot: &Snapshot,
    floor: u64,
    selection: Selection,
) -> Result<Option<Sample>, IndexedReadError> {
    let bound = snapshot_bound(c, snapshot)?;
    let query = match selection {
        Selection::LatestRequest => {
            "SELECT entry_json,model_json FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_metrics_prepared WHERE snapshot=? AND kind='fact' AND fact_kind='model_attempt_prepared' AND sequence<=? AND json_extract(entry_json,'$.admission_sequence')>? ORDER BY sequence DESC"
        }
        Selection::LatestSuccess => {
            "SELECT entry_json,model_json FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_fact WHERE snapshot=? AND kind='fact' AND fact_kind='model_closed' AND sequence<=? AND json_extract(entry_json,'$.admission_sequence')>? ORDER BY sequence DESC"
        }
    };
    let mut statement = c.prepare_cached(query)?;
    let mut rows = statement.query(params![
        snapshot.id().to_string(),
        sql::bind_u64(bound)?,
        sql::bind_u64(floor)?
    ])?;
    while let Some(row) = rows.next()? {
        let observed = copied_fact(c, snapshot, &row.get::<_, String>(0)?, bound)?;
        let original = if matches!(selection, Selection::LatestSuccess) {
            let metadata: ModelMetadata = serde_json::from_str(
                &row.get::<_, Option<String>>(1)?
                    .ok_or_else(|| invalid("metrics copied closure metadata is missing"))?,
            )?;
            let ModelMetadata::Closed { outcome, at, .. } = metadata else {
                return Err(invalid("metrics copied closure metadata has another kind").into());
            };
            if at.0 < 0 {
                return Err(invalid("negative original model closure time").into());
            }
            if outcome != Outcome::Success {
                continue;
            }
            let raw: String=c.query_row("SELECT entry_json FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_metrics_attempt WHERE snapshot=? AND kind='fact' AND run=? AND json_extract(entry_json,'$.attempt')=? AND fact_kind IN ('model_attempt_prepared','proactive_summary_prepared') AND sequence<=? ORDER BY sequence LIMIT 1",params![snapshot.id().to_string(),observed.run.to_string(),observed.attempt.map(|id|id.to_string()),sql::bind_u64(observed.sequence)?],|r|r.get(0))?;
            let prepared = copied_fact(c, snapshot, &raw, bound)?;
            if prepared.run != observed.run
                || prepared.step != observed.step
                || prepared.attempt != observed.attempt
                || prepared.admission != observed.admission
            {
                return Err(invalid("metrics copied closure has another original request").into());
            }
            prepared
        } else {
            observed
        };
        let step = original
            .step
            .ok_or_else(|| invalid("metrics copied model request has no original Step"))?;
        let attempt = original
            .attempt
            .ok_or_else(|| invalid("metrics copied model request has no original attempt"))?;
        let (raw,model):(String,Option<String>)=c.query_row("SELECT entry_json,model_json FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_step WHERE snapshot=? AND kind='fact' AND run=? AND json_extract(entry_json,'$.step')=? AND fact_kind IN ('step_prepared','proactive_summary_prepared') AND sequence<=? ORDER BY sequence LIMIT 1",params![snapshot.id().to_string(),original.run.to_string(),step.to_string(),sql::bind_u64(original.sequence)?],|r|Ok((r.get(0)?,r.get(1)?)))?;
        let prepared = copied_fact(c, snapshot, &raw, bound)?;
        if prepared.run != original.run
            || prepared.step != Some(step)
            || prepared.admission != original.admission
        {
            return Err(invalid("metrics copied request preparation membership differs").into());
        }
        let ModelMetadata::Prepared {
            accounting,
            provenance,
        } = serde_json::from_str(
            &model.ok_or_else(|| invalid("metrics copied request metadata is not complete"))?,
        )?
        else {
            return Err(invalid("metrics copied request metadata has another kind").into());
        };
        accounting.validate().map_err(invalid)?;
        if accounting.purpose != ModelPurpose::Main {
            continue;
        }
        let closed = copied_closed(c, snapshot, bound, &original, "model_closed")?;
        let closed = closed
            .map(|(key, model)| match model {
                ModelMetadata::Closed {
                    outcome,
                    at,
                    usage,
                    model_time_ms,
                } if at.0 >= 0 => Ok(Closed {
                    model_time_ms,
                    sequence: key.sequence,
                    at,
                    outcome,
                    usage,
                }),
                _ => Err(invalid("metrics copied closure metadata has another kind")),
            })
            .transpose()?;
        if !accepted(selection, &closed) {
            continue;
        }
        let requested_at = copied_closed(c, snapshot, bound, &original, "model_attempt_admitted")?
            .map(|(_, model)| match model {
                ModelMetadata::Admitted { at } if at.0 >= 0 => Ok(at),
                _ => Err(invalid(
                    "metrics copied admission metadata has another kind",
                )),
            })
            .transpose()?;
        let source = snapshot.run_in_snapshot(c, original.run)?;
        if source.admission_sequence != original.admission {
            return Err(invalid("metrics copied model request has another original Run").into());
        }
        return Ok(Some(Sample {
            run: original.run,
            step,
            attempt,
            prepared: prepared.sequence,
            accounting,
            provenance,
            requested_at,
            closed,
            context: None,
            changed: false,
            reset: false,
        }));
    }
    Ok(None)
}
fn copied_closed(
    c: &Connection,
    snapshot: &Snapshot,
    bound: u64,
    original: &CopiedFact,
    kind: &str,
) -> Result<Option<(CopiedFact, ModelMetadata)>, StoreError> {
    let row:Option<(String,Option<String>)>=c.query_row("SELECT entry_json,model_json FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_metrics_attempt WHERE snapshot=? AND kind='fact' AND run=? AND json_extract(entry_json,'$.attempt')=? AND fact_kind=? AND sequence<=? ORDER BY sequence DESC LIMIT 1",params![snapshot.id().to_string(),original.run.to_string(),original.attempt.map(|id|id.to_string()),kind,sql::bind_u64(bound)?],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    row.map(|(raw, metadata)| {
        let key = copied_fact(c, snapshot, &raw, bound)?;
        if key.run != original.run
            || key.step != original.step
            || key.attempt != original.attempt
            || key.admission != original.admission
            || key.sequence < original.sequence
        {
            return Err(invalid(
                "metrics copied model event differs from its original attempt",
            ));
        }
        Ok((
            key,
            serde_json::from_str(
                &metadata
                    .ok_or_else(|| invalid("metrics copied model event metadata is missing"))?,
            )?,
        ))
    })
    .transpose()
}
fn metadata<T: DeserializeOwned>(
    c: &Connection,
    source: &HistoryDataSource,
    run: RunId,
    reference: &ContentRef,
) -> Result<T, StoreError> {
    match source {
        HistoryDataSource::Live { history, cut } => {
            sql::with_content(c, &history.namespace, cut, run, reference, |blob| {
                let mut bytes = Vec::new();
                blob.read_to_end(&mut bytes)?;
                if maka_agent_facts::artifact::content_digest(&bytes) != reference.digest {
                    return Err(invalid("metrics original metadata content hash differs"));
                }
                Ok(serde_json::from_slice(&bytes)?)
            })
        }
        HistoryDataSource::Snapshot(snapshot) => snapshot.metadata_in_snapshot(c, run, reference),
    }
}
fn changes(
    c: &Connection,
    segment: &Segment,
    sample: Option<&Sample>,
) -> Result<(bool, bool), IndexedReadError> {
    let after = sample.map_or(0, |sample| sample.prepared);
    let run = sample.map(|sample| sample.run.to_string());
    let step = sample.map(|sample| sample.step.to_string());
    let attempt = sample.map(|sample| sample.attempt.to_string());
    let (changed,reset):(bool,bool)=match &segment.source {
        HistoryDataSource::Live{history,cut}=>c.query_row("SELECT coalesce(max(CASE WHEN h.kind='context_compacted' OR (h.kind='run_admitted' AND h.run IS NOT ?6) OR (h.kind='step_prepared' AND h.step IS NOT ?7) OR (h.kind IN ('model_attempt_prepared','model_attempt_admitted','model_observed') AND h.attempt IS NOT ?8
       AND NOT (h.kind='model_attempt_admitted' AND EXISTS(
           SELECT 1 FROM agent_session_history p INDEXED BY agent_session_history_run
           WHERE p.owner=h.owner AND p.session=h.session AND p.run=h.run AND p.step=h.step
             AND p.attempt=h.attempt AND p.kind='proactive_summary_prepared'))) OR h.kind IN ('tool_result_accepted','local_tool_returned','host_tool_result_recorded','external_task_observed','external_effect','cell','tools_loaded') THEN 1 ELSE 0 END),0),coalesce(max(h.kind='context_compacted'),0) FROM agent_session_history h WHERE h.owner=?1 AND h.session=?2 AND h.sequence>?3 AND h.sequence<=?4 AND h.admission_sequence>?5",params![serde_json::to_string(&history.namespace.owner)?,history.namespace.session,sql::bind_u64(after)?,sql::bind_u64(cut.through_sequence)?,sql::bind_u64(segment.after_admission)?,run,step,attempt],|r|Ok((r.get(0)?,r.get(1)?)))?,
        HistoryDataSource::Snapshot(snapshot)=>{
            let bound=snapshot_bound(c,snapshot)?;
            c.query_row("SELECT coalesce(max(CASE WHEN fact_kind='context_compacted' OR (fact_kind='run_admitted' AND run IS NOT ?5) OR (fact_kind='step_prepared' AND json_extract(entry_json,'$.step') IS NOT ?6) OR (e.fact_kind IN ('model_attempt_prepared','model_attempt_admitted','model_observed') AND json_extract(e.entry_json,'$.attempt') IS NOT ?7
       AND NOT (e.fact_kind='model_attempt_admitted' AND EXISTS(
           SELECT 1 FROM agent_history_snapshot_entries p INDEXED BY agent_history_snapshot_metrics_attempt
           WHERE p.snapshot=e.snapshot AND p.run=e.run AND p.kind='fact'
             AND json_extract(p.entry_json,'$.attempt')=json_extract(e.entry_json,'$.attempt')
             AND p.fact_kind='proactive_summary_prepared'))) OR fact_kind IN ('tool_result_accepted','local_tool_returned','host_tool_result_recorded','external_task_observed','external_effect','cell','tools_loaded') THEN 1 ELSE 0 END),0),coalesce(max(fact_kind='context_compacted'),0) FROM agent_history_snapshot_entries e WHERE e.snapshot=?1 AND e.kind='fact' AND e.sequence>?2 AND e.sequence<=?3 AND json_extract(e.entry_json,'$.admission_sequence')>?4",params![snapshot.id().to_string(),sql::bind_u64(after)?,sql::bind_u64(bound)?,sql::bind_u64(segment.after_admission)?,run,step,attempt],|r|Ok((r.get(0)?,r.get(1)?)))?
        }
    };
    Ok((changed, reset))
}

struct ReadCurrentContext(SessionHistory, HistoryCut);
impl Query for ReadCurrentContext {
    type Output = IndexedRead<Option<CurrentModelContext>>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        IndexedRead::from_result(read_current_context(c, self.0, self.1))
    }
}
fn read_current_context(
    c: &Connection,
    history: SessionHistory,
    cut: HistoryCut,
) -> Result<Option<CurrentModelContext>, IndexedReadError> {
    use maka_agent_facts::context::{CheckpointContent, CompactedContext};
    let tree = SourceTree::build_in_snapshot(c, HistoryDataSource::Live { history, cut })?;
    for segment in tree.sections().iter().rev() {
        let main = match &segment.source {
            HistoryDataSource::Live { history, cut } => live(
                c,
                history,
                cut,
                segment.after_admission,
                Selection::LatestRequest,
            )?,
            HistoryDataSource::Snapshot(snapshot) => copied(
                c,
                snapshot,
                segment.after_admission,
                Selection::LatestRequest,
            )?,
        };
        let checkpoint = latest_checkpoint(c, segment)?;
        if let Some(item) = checkpoint.filter(|item| {
            main.as_ref()
                .is_none_or(|main| item.sequence > main.prepared)
        }) {
            let Fact::ContextCompacted { baseline } = item.recorded.fact else {
                return Err(invalid("context marker kind").into());
            };
            let material: CompactedContext =
                metadata(c, &segment.source, item.recorded.run, &baseline)?;
            material.validate().map_err(invalid)?;
            let Some(native) = material.native else {
                return Ok(None);
            };
            let tokens = match material.checkpoint.summary {
                CheckpointContent::CodexNative {
                    estimated_tokens, ..
                } => Some(estimated_tokens),
                _ => None,
            };
            return Ok(Some(CurrentModelContext {
                source: segment.source.clone(),
                path: segment.path.clone(),
                run: material.summary_origin.map_or(item.recorded.run, |o| o.run),
                step: material.checkpoint.summary_step_id,
                tokens,
                continuation: native.continuation,
            }));
        }
        if let Some(main) = main {
            let tokens = main.closed.as_ref().and_then(|closed| {
                closed
                    .usage
                    .input_tokens
                    .zip(closed.usage.output_tokens)
                    .and_then(|(a, b)| a.checked_add(b))
            });
            return Ok(Some(CurrentModelContext {
                source: segment.source.clone(),
                path: segment.path.clone(),
                run: main.run,
                step: main.step,
                tokens,
                continuation: None,
            }));
        }
    }
    Ok(None)
}

fn latest_checkpoint(
    c: &Connection,
    segment: &super::source_tree::Segment,
) -> Result<Option<HistoryItem>, IndexedReadError> {
    match &segment.source {
        HistoryDataSource::Live { history, cut } => {
            let sequence: Option<u64> = c.query_row("SELECT sequence FROM agent_session_history INDEXED BY agent_session_history_kind WHERE owner=? AND session=? AND kind='context_compacted' AND sequence<=? AND admission_sequence>? ORDER BY sequence DESC LIMIT 1", params![serde_json::to_string(&history.namespace.owner)?, history.namespace.session, sql::bind_u64(cut.through_sequence)?, sql::bind_u64(segment.after_admission)?], |row| sql::read_u64(row, 0)).optional()?;
            sequence
                .map(|sequence| sql::item(c, &history.namespace, cut, sequence))
                .transpose()
                .map(Option::flatten)
                .map_err(Into::into)
        }
        HistoryDataSource::Snapshot(snapshot) => {
            let raw: Option<String> = c.query_row("SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='fact' AND fact_kind='context_compacted' AND json_extract(entry_json,'$.admission_sequence')>? AND sequence<=? ORDER BY sequence DESC LIMIT 1", params![snapshot.id().to_string(),sql::bind_u64(segment.after_admission)?,sql::bind_u64(snapshot_bound(c, snapshot)?)?], |row| row.get(0)).optional()?;
            let Some(raw) = raw else { return Ok(None) };
            let maka_agent_facts::history_snapshot::Entry::Fact {
                run,
                sequence,
                admission_sequence,
                step,
                attempt,
                body,
                ..
            } = serde_json::from_str(&raw)?
            else {
                return Err(invalid("context marker entry kind").into());
            };
            let recorded = snapshot.metadata_in_snapshot(c, run, &body)?;
            Ok(Some(HistoryItem {
                sequence,
                admission_sequence,
                scope: HistoryScope { step, attempt },
                recorded,
            }))
        }
    }
}

#[cfg(test)]
mod diagnostic_tests {
    use super::*;

    #[test]
    fn masks_original_bytes_across_trimmed_and_truncated_preview_edges() {
        let text = format!("　{}界外", "a".repeat(511));
        let (mut preview, evidence) = diagnostic_preview(Some(&text), Vec::new());
        evidence.mask(
            &mut preview,
            &[(0, 4), ((3 + 511) as u64, text.len() as u64)],
        );
        assert_eq!(preview.unwrap(), format!("*{}***…", "a".repeat(510)));
    }
}
