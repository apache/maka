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

//! Session history is a scoped read of canonical Agent facts, not a second
//! event sink. A captured prefix is immutable even when old work settles late.
use maka_agent_facts::durable::*;
use maka_event_log::{
    StoreError,
    connection::Query,
    root_store::DataWriter,
    writeback::{Notification, Prepared, Statement},
};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

mod continuation;
pub mod evidence;
mod fork;
pub mod inspection;
mod metrics;
pub mod navigation;
pub mod snapshot;
pub mod source_tree;
mod sql;
pub mod tool_result_source;
pub use continuation::ContinuationSource;
pub(crate) use continuation::admit_continuation;
#[cfg(test)]
pub(crate) use sql::recovery_diagnostic;
pub(crate) use sql::{capture_at, captured_tool_call, source_content_at, sources_at, validate_cut};
pub(crate) use sql::{index, index_queue, index_retained};

pub use maka_agent_facts::history_snapshot::HistoryCut;
pub use metrics::{
    CurrentModelContext, ModelCalibrationSample, ModelRequestRetry, SessionModelMetrics,
};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryScope {
    pub step: Option<StepId>,
    pub attempt: Option<ModelAttemptId>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryItem {
    pub sequence: u64,
    pub admission_sequence: u64,
    pub scope: HistoryScope,
    /// Complete model items, result/projection refs, control and late evidence
    /// retain their original typed Run/attempt identity without reinterpretation.
    pub recorded: RecordedFact,
}

pub struct ToolResultMetadata {
    pub is_error: bool,
    pub image: bool,
    pub images: u32,
    pub external_settlement: Option<maka_agent_facts::tool_call::ToolSettlement>,
}
/// Read-time projection of native assistant text at a captured history cut.
#[derive(Default)]
pub struct ExecutorTranscript {
    messages: std::collections::BTreeMap<(String, bool), ExecutorText>,
}

pub struct ExecutorText {
    pub sequence: u64,
    pub fact: FactId,
    pub body: maka_agent_facts::model::body::TextBody,
}

impl ExecutorTranscript {
    pub fn text(&self, id: &str, thinking: bool) -> Option<&ExecutorText> {
        self.messages.get(&(id.to_owned(), thinking))
    }

    pub fn thinking_at(
        &self,
        sequence: u64,
        fact: FactId,
    ) -> Option<&maka_agent_facts::model::body::TextBody> {
        self.messages.iter().find_map(|((_, thinking), entry)| {
            (*thinking && entry.sequence == sequence && entry.fact == fact).then_some(&entry.body)
        })
    }

    fn observe(
        &mut self,
        sequence: u64,
        record: &RecordedFact,
        pieces: &mut Option<Vec<(FactId, FactId, u64, usize, usize)>>,
    ) {
        use maka_agent_facts::executor::Output;
        let Fact::ExternalTaskObserved { output, .. } = &record.fact else {
            return;
        };
        let (id, text, thinking) = match output {
            Output::OutputDelta { message_id, text } => (message_id, text, false),
            Output::ThinkingDelta { message_id, text } => (message_id, text, true),
            _ => return,
        };
        let message = self
            .messages
            .entry((id.clone(), thinking))
            .or_insert_with(|| ExecutorText {
                sequence,
                fact: record.id,
                body: Default::default(),
            });
        let piece_start = message.body.len_bytes();
        message.body = message
            .body
            .inserted(piece_start, text)
            .expect("append at text end");
        let piece_end = message.body.len_bytes();
        if let Some(pieces) = pieces {
            pieces.push((record.id, message.fact, sequence, piece_start, piece_end));
        }
    }
    fn mask_pieces(
        &mut self,
        c: &Connection,
        owner: &RunOwner,
        snapshot: Option<maka_agent_facts::history_snapshot::SnapshotId>,
        pieces: Option<Vec<(FactId, FactId, u64, usize, usize)>>,
    ) -> Result<(), StoreError> {
        let Some(pieces) = pieces else { return Ok(()) };
        let namespace = serde_json::to_string(owner)?;
        let mut hidden = std::collections::BTreeMap::<FactId, Vec<(u64, u64)>>::new();
        let mut statement = c.prepare_cached(
            "SELECT p.value->>0, p.value->>1, CAST(p.value->>2 AS INTEGER),
                    CAST(p.value->>3 AS INTEGER), CAST(p.value->>4 AS INTEGER),
                    s.start, s.end,
                    (SELECT octet_length(m.body)
                     FROM agent_session_history h
                     JOIN agent_recall_messages m
                       ON m.owner = h.owner AND m.session = h.session
                      AND m.sequence = h.sequence AND m.ordinal = s.ordinal
                     WHERE h.owner = s.namespace AND h.fact_id = s.fact
                     LIMIT 1)
             FROM json_each(?1) p CROSS JOIN agent_memory_hidden_spans s
             WHERE s.namespace=?2 AND s.fact=p.value->>0 AND s.ordinal=0",
        )?;
        for page in pieces.chunks(256) {
            let mut rows =
                statement.query(rusqlite::params![serde_json::to_string(page)?, namespace])?;
            while let Some(row) = rows.next()? {
                let piece_fact = sql::identity(row.get(0)?)?;
                let message_fact = sql::identity(row.get(1)?)?;
                let sequence = sql::read_u64(row, 2)?;
                let piece_start = sql::read_u64(row, 3)?;
                let piece_end = sql::read_u64(row, 4)?;
                let span_start = sql::read_u64(row, 5)?;
                let span_end = sql::read_u64(row, 6)?;
                let indexed_body_len: Option<u64> = row
                    .get::<_, Option<i64>>(7)?
                    .map(|v| {
                        u64::try_from(v)
                            .map_err(|_| crate::store::invalid("negative recall body length"))
                    })
                    .transpose()?;
                let base = if let Some(body_len) = indexed_body_len {
                    // For legacy single-delta rows body_len == piece_end - piece_start, so base == piece_start.
                    // For v60 sealed S_last rows (d_1..d_last), piece_end - body_len aligns to d_1's start.
                    piece_end.saturating_sub(body_len)
                } else if let Some(snap_id) = snapshot {
                    let compact: Option<bool> = c
                        .prepare_cached(
                            "SELECT compact FROM agent_history_snapshot_positions
                             WHERE snapshot=?1 AND kind='canonical' AND major=?2 AND minor=0",
                        )?
                        .query_row(
                            rusqlite::params![
                                snap_id.to_string(),
                                i64::try_from(sequence).map_err(|_| crate::store::invalid(
                                    "snapshot sequence overflow"
                                ))?
                            ],
                            |r| r.get(0),
                        )
                        .optional()?;
                    if compact == Some(true) {
                        let mut seg_start = piece_start;
                        let mut pos_check = c.prepare_cached(
                            "SELECT EXISTS(SELECT 1 FROM agent_history_snapshot_positions
                             WHERE snapshot=?1 AND kind='canonical' AND major=?2 AND minor=0)",
                        )?;
                        if let Some(idx) = pieces
                            .iter()
                            .position(|p| p.0 == piece_fact && p.2 == sequence)
                        {
                            for prev in pieces[..idx].iter().rev() {
                                if prev.1 != message_fact {
                                    continue;
                                }
                                let has_pos: bool = pos_check.query_row(
                                    rusqlite::params![
                                        snap_id.to_string(),
                                        i64::try_from(prev.2).map_err(
                                            |_| crate::store::invalid("snapshot sequence overflow")
                                        )?
                                    ],
                                    |r| r.get(0),
                                )?;
                                if has_pos {
                                    break;
                                }
                                seg_start = prev.3 as u64;
                            }
                        }
                        seg_start
                    } else {
                        piece_start
                    }
                } else {
                    piece_start
                };
                hidden.entry(message_fact).or_default().push((
                    base.saturating_add(span_start),
                    base.saturating_add(span_end),
                ));
            }
        }
        // When a live historical cut straddles an already-sealed coalesced segment
        // (tail_start_sequence <= cut < tail_end_sequence), hidden spans captured after
        // sealing are keyed on tail_end_fact rather than the cut's pieces; anchor them at
        // tail_start_sequence's piece_start (the exact d_1 offset).
        if snapshot.is_none() && !pieces.is_empty() {
            let max_seq = pieces.iter().map(|p| p.2).max().unwrap_or(0);
            let mut straddle = c.prepare_cached(
                "SELECT p.value->>1, CAST(p.value->>3 AS INTEGER), s.start, s.end
                 FROM json_each(?1) p
                 JOIN agent_session_history h
                   ON h.owner = ?2 AND h.fact_id = p.value->>0
                 JOIN agent_recall_external_segments seg
                   ON seg.owner = h.owner AND seg.session = h.session AND seg.run = h.run
                  AND seg.sealed = 1
                  AND seg.tail_end_sequence IS NOT NULL
                  AND seg.tail_end_sequence > ?3
                  AND seg.tail_start_sequence = CAST(p.value->>2 AS INTEGER)
                 JOIN agent_memory_hidden_spans s
                   ON s.namespace = seg.owner AND s.fact = seg.tail_end_fact AND s.ordinal = 0",
            )?;
            let max_seq_i64 = sql::bind_u64(max_seq)?;
            for page in pieces.chunks(256) {
                let mut rows = straddle.query(rusqlite::params![
                    serde_json::to_string(page)?,
                    namespace,
                    max_seq_i64
                ])?;
                while let Some(row) = rows.next()? {
                    let message_fact = sql::identity(row.get(0)?)?;
                    let base = sql::read_u64(row, 1)?;
                    let span_start = sql::read_u64(row, 2)?;
                    let span_end = sql::read_u64(row, 3)?;
                    hidden.entry(message_fact).or_default().push((
                        base.saturating_add(span_start),
                        base.saturating_add(span_end),
                    ));
                }
            }
        }
        for message in self.messages.values_mut() {
            if let Some(spans) = hidden.get(&message.fact) {
                let mut body = message.body.to_string();
                crate::memory::recall::mask(&mut body, 0, spans);
                message.body = body.into();
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolResultSource {
    pub item: HistoryItem,
    pub tool_name: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryPage {
    pub items: Vec<HistoryItem>,
    pub next: Option<u64>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunSource {
    pub run: RunId,
    pub admission_sequence: u64,
    pub spec: RunSpec,
    pub spec_ref: ContentRef,
    pub admission: RecordedFact,
}
impl RunSource {
    pub fn execution(&self) -> ExecutionIdentity {
        ExecutionIdentity {
            session_id: self.spec.session_id.clone(),
            turn_id: self.spec.turn_id.clone(),
            run_id: self.run,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueSource {
    pub position: u64,
    pub queue_revision: u64,
    pub request: crate::queue::PreparedRequest,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueSourcePage {
    pub sources: Vec<QueueSource>,
    pub next: Option<u64>,
}

/// The live native owner supplies this same-Root ingress and namespace. A
/// deserialized HistoryCut alone cannot create this handle or access a Root.
#[derive(Clone)]
pub struct SessionHistory {
    data: DataWriter,
    namespace: HistoryNamespace,
}
#[derive(Clone)]
struct HistoryNamespace {
    owner: RunOwner,
    session: String,
}

pub struct LiveObservation {
    pub cut: HistoryCut,
    pub latest: Option<LiveRunObservation>,
}
pub struct LiveRunObservation {
    pub source: RunSource,
    pub pending_interactions: u64,
}

struct FactBodyRestrictions(RunOwner, Vec<FactId>);

impl Query for FactBodyRestrictions {
    type Output = std::collections::BTreeMap<usize, Vec<(u64, u64)>>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let keys = self
            .1
            .into_iter()
            .enumerate()
            .map(|(i, fact)| (i, fact, 0, None))
            .collect::<Vec<_>>();
        crate::memory::recall::indexed_spans(c, &self.0, &keys, &[])
    }
}

struct ModelRecoveryDiagnostic(HistoryNamespace, RunId);
impl Query for ModelRecoveryDiagnostic {
    type Output = Option<String>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let view = crate::sql::load(c, self.1, &[], false)?;
        if view.spec.owner != self.0.owner || view.spec.session_id != self.0.session {
            return Ok(None);
        }
        let Some(mut reason) = sql::recovery_diagnostic(c, &view, true)? else {
            return Ok(None);
        };
        if let Some(maka_agent_facts::durable::BlockerKind::ToolCleanupUnconfirmed {
            diagnostic,
            ..
        }) = view.recovery_failure()
        {
            let masked = MaskTerminalDiagnostic(self.0, self.1, diagnostic.clone()).execute(c)?;
            reason = reason.replace(diagnostic, &masked);
            return Ok(Some(reason));
        }
        MaskTerminalDiagnostic(self.0, self.1, reason)
            .execute(c)
            .map(Some)
    }
}

struct MaskTerminalDiagnostic(HistoryNamespace, RunId, String);

impl Query for MaskTerminalDiagnostic {
    type Output = String;
    fn execute(self, c: &Connection) -> Result<String, StoreError> {
        use rusqlite::{OptionalExtension, params};
        let Self(namespace, run, mut diagnostic) = self;
        // A recovery reason and the terminal row share byte offsets only when the
        // engine persisted that diagnostic verbatim for this Run.
        let terminal = c
            .query_row(
                "SELECT h.fact_id FROM agent_session_history h
             JOIN agent_facts f ON f.sequence=h.sequence JOIN contents b ON b.id=f.body_content_id
             WHERE h.run=?1 AND h.kind='run_terminated' AND h.owner=?2 AND h.session=?3
               AND CAST(b.payload AS TEXT)->>'$.fact.diagnostic'=?4",
                params![
                    run.to_string(),
                    serde_json::to_string(&namespace.owner)?,
                    namespace.session,
                    diagnostic
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(fact) = terminal {
            let spans = crate::memory::recall::indexed_spans(
                c,
                &namespace.owner,
                &[(0, sql::identity(fact)?, 0, None)],
                &[],
            )?;
            if let Some(spans) = spans.get(&0) {
                crate::memory::recall::mask(&mut diagnostic, 0, spans);
            }
        }
        Ok(diagnostic)
    }
}

/// Check whether a request or checkpoint may be replayed by `target`.
/// Shared records are always reusable; Run-scoped or legacy unrecorded ones
/// check whether the producer actually consumed any memory facts and whether
/// those facts remain active and authorized for `target`.
pub async fn permits_memory_replay(
    live: Option<&SessionHistory>,
    recorded: maka_agent_facts::memory::MemoryReplay,
    producer: RunId,
    target: Option<RunId>,
) -> Result<bool, StoreError> {
    use maka_agent_facts::memory::MemoryReplay;
    match recorded {
        MemoryReplay::Shared => Ok(true),
        MemoryReplay::Run(owner) => {
            if Some(owner) == target {
                return Ok(true);
            }
            let Some(history) = live else {
                return Ok(false);
            };
            history
                .data
                .query(crate::memory::reads::PermitsReplay {
                    producer: owner,
                    target,
                })
                .await
        }
        MemoryReplay::Unrecorded => {
            let Some(history) = live else {
                return Ok(false);
            };
            if Some(producer) == target {
                return Ok(true);
            }
            history
                .data
                .query(crate::memory::reads::PermitsReplay { producer, target })
                .await
        }
    }
}

impl SessionHistory {
    pub async fn has_memory_reads(&self, run: RunId) -> Result<bool, StoreError> {
        self.data.query(crate::memory::reads::HasReads(run)).await
    }

    pub fn new(data: DataWriter, owner: RunOwner, session: String) -> Self {
        Self {
            data,
            namespace: HistoryNamespace { owner, session },
        }
    }
    pub async fn read_restrictions(
        &self,
        addresses: Vec<maka_agent_facts::history::HistoryRowAddress>,
    ) -> Result<crate::memory::recall::RestrictionMap, StoreError> {
        self.data
            .query(crate::memory::recall::ReadRestrictions {
                owner: self.namespace.owner.clone(),
                addresses,
            })
            .await
    }
    pub async fn fact_body_restrictions(
        &self,
        facts: Vec<FactId>,
    ) -> Result<std::collections::BTreeMap<usize, Vec<(u64, u64)>>, StoreError> {
        self.data
            .query(FactBodyRestrictions(self.namespace.owner.clone(), facts))
            .await
    }

    pub async fn model_recovery_diagnostic(
        &self,
        run: RunId,
    ) -> Result<Option<String>, StoreError> {
        self.data
            .query(ModelRecoveryDiagnostic(self.namespace.clone(), run))
            .await
    }
    pub async fn mask_terminal_diagnostic(
        &self,
        run: RunId,
        diagnostic: String,
    ) -> Result<String, StoreError> {
        self.data
            .query(MaskTerminalDiagnostic(
                self.namespace.clone(),
                run,
                diagnostic,
            ))
            .await
    }
    pub async fn restricted_archives(
        &self,
        facts: Vec<FactId>,
    ) -> Result<
        std::collections::BTreeMap<FactId, crate::memory::recall::ArchiveRestriction>,
        StoreError,
    > {
        self.archive_restrictions(facts, None).await
    }

    pub async fn archive_restrictions(
        &self,
        facts: Vec<FactId>,
        snapshot: Option<&snapshot::Snapshot>,
    ) -> Result<
        std::collections::BTreeMap<FactId, crate::memory::recall::ArchiveRestriction>,
        StoreError,
    > {
        if facts.is_empty() {
            return Ok(Default::default());
        }
        self.data
            .query(crate::memory::recall::RestrictedArchives {
                owner: self.namespace.owner.clone(),
                facts,
                snapshot: snapshot.map(snapshot::Snapshot::id),
            })
            .await
    }

    pub async fn resolve_tool_result(
        &self,
        cut: &HistoryCut,
        locator: &str,
    ) -> Result<Option<ToolResultSource>, StoreError> {
        self.data
            .query(ResolveToolResult(
                self.clone(),
                cut.clone(),
                locator.to_owned(),
            ))
            .await
    }
    /// Read a sparse window of original facts within the captured session.
    pub async fn items(
        &self,
        cut: &HistoryCut,
        sequences: Vec<u64>,
    ) -> Result<std::collections::BTreeMap<u64, HistoryItem>, StoreError> {
        self.data
            .query(WindowItems(self.namespace.clone(), cut.clone(), sequences))
            .await
    }
    pub async fn tool_result_metadata(
        &self,
        cut: &HistoryCut,
        sequence: u64,
    ) -> Result<Option<ToolResultMetadata>, StoreError> {
        self.data
            .query(ReadToolResultMetadata(
                self.namespace.clone(),
                cut.clone(),
                sequence,
            ))
            .await
    }
    pub async fn capture(&self) -> Result<HistoryCut, StoreError> {
        self.data.query(Capture(self.clone(), None)).await
    }
    /// Current pending requests and the latest original Run share one read snapshot.
    pub async fn live_observation(&self) -> Result<LiveObservation, StoreError> {
        self.data.query(ReadLiveObservation(self.clone())).await
    }
    /// Ordinary next-message context ends before this Run's original admission,
    /// never at today's latest sequence and never at a UUID/clock approximation.
    pub async fn chunk(
        &self,
        cut: &HistoryCut,
        run: RunId,
        reference: &ContentRef,
        offset: u64,
        limit: u32,
    ) -> Result<Vec<u8>, StoreError> {
        self.data
            .query(Chunk(
                self.clone(),
                cut.clone(),
                run,
                reference.clone(),
                offset,
                limit,
            ))
            .await
    }
    pub async fn capture_at(&self, through: u64) -> Result<HistoryCut, StoreError> {
        self.data.query(CaptureAt(self.clone(), through)).await
    }
    pub async fn fact_sequence(
        &self,
        cut: &HistoryCut,
        run: RunId,
        fact: FactId,
    ) -> Result<Option<u64>, StoreError> {
        self.data
            .query(FactSequence(self.clone(), cut.clone(), run, fact))
            .await
    }
    pub async fn item(
        &self,
        cut: &HistoryCut,
        sequence: u64,
    ) -> Result<Option<HistoryItem>, StoreError> {
        self.data
            .query(Item(self.clone(), cut.clone(), sequence))
            .await
    }
    pub async fn first_message(&self, cut: &HistoryCut) -> Result<Option<RunSource>, StoreError> {
        self.data
            .query(FirstMessage(self.clone(), cut.clone()))
            .await
    }
    pub async fn latest(&self, cut: &HistoryCut) -> Result<Option<RunSource>, StoreError> {
        self.data.query(Latest(self.clone(), cut.clone())).await
    }
    pub async fn view_at(
        &self,
        cut: &HistoryCut,
        run: RunId,
    ) -> Result<crate::fold::RunView, StoreError> {
        self.data
            .query(ViewAt(self.clone(), cut.clone(), run))
            .await
    }
    pub async fn tool_call(
        &self,
        cut: &HistoryCut,
        run: RunId,
        key: &ToolKey,
    ) -> Result<maka_agent_facts::model::ModelToolCall, StoreError> {
        self.data
            .query(ToolCall(self.clone(), cut.clone(), run, key.clone()))
            .await
    }
    pub async fn tool_position(
        &self,
        cut: &HistoryCut,
        id: &str,
    ) -> Result<Option<maka_agent_facts::history::RowPosition>, StoreError> {
        self.data
            .query(ToolPosition(self.clone(), cut.clone(), id.into()))
            .await
    }
    pub async fn tool_page(
        &self,
        cut: &HistoryCut,
        id: &str,
        after: u64,
        limit: u32,
    ) -> Result<HistoryPage, StoreError> {
        self.data
            .query(ToolPage(self.clone(), cut.clone(), id.into(), after, limit))
            .await
    }
    pub async fn capture_before(&self, run: RunId) -> Result<HistoryCut, StoreError> {
        self.data.query(Capture(self.clone(), Some(run))).await
    }
    pub async fn page(
        &self,
        cut: &HistoryCut,
        after_sequence: u64,
        limit: u32,
    ) -> Result<HistoryPage, StoreError> {
        self.data
            .query(Page(self.clone(), cut.clone(), after_sequence, limit))
            .await
    }
    pub async fn run_source(&self, run: RunId) -> Result<RunSource, StoreError> {
        self.data.query(Source(self.clone(), run)).await
    }
    pub async fn request(
        &self,
        cut: &HistoryCut,
        run: RunId,
        step: StepId,
    ) -> Result<RequestSpec, StoreError> {
        self.request_preparation(cut, run, step)
            .await
            .map(|(request, _)| request)
    }
    pub async fn request_preparation(
        &self,
        cut: &HistoryCut,
        run: RunId,
        step: StepId,
    ) -> Result<(RequestSpec, UnixMillis), StoreError> {
        self.data
            .query(Request(self.clone(), cut.clone(), run, step))
            .await
    }
    pub async fn content(&self, run: RunId, reference: &ContentRef) -> Result<Vec<u8>, StoreError> {
        self.data
            .query(Content(self.clone(), run, reference.clone()))
            .await
    }
    /// Runs on the original Root's blocking read lane. The reader cannot escape
    /// the snapshot. Only immutable-source materialization into already owned
    /// temporary prepared backing is allowed: no network, arbitrary user-file
    /// writes, runtime effects, async work or re-entry into the writer.
    pub async fn with_content<T: Send + 'static>(
        &self,
        cut: &HistoryCut,
        run: RunId,
        reference: &ContentRef,
        consume: impl FnOnce(&mut dyn std::io::Read) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        self.data
            .query(StreamContent(
                self.clone(),
                cut.clone(),
                run,
                reference.clone(),
                consume,
            ))
            .await
    }
    /// Newest-first keyset selection, returned in ascending canonical order.
    /// `next` is an exclusive before-sequence for the next older page.
    pub async fn previous_page(
        &self,
        cut: &HistoryCut,
        before_sequence: Option<u64>,
        limit: u32,
    ) -> Result<HistoryPage, StoreError> {
        self.data
            .query(Previous(self.clone(), cut.clone(), before_sequence, limit))
            .await
    }
    pub async fn run_revision_through(
        &self,
        cut: &HistoryCut,
        run: RunId,
        through_sequence: u64,
    ) -> Result<u64, StoreError> {
        self.data
            .query(RunRevisionThrough(
                self.clone(),
                cut.clone(),
                run,
                through_sequence,
            ))
            .await
    }
    /// Exact queue snapshots consumed by the fact at sequence, in original
    /// source order. Pending/unconsumed follow-ups are never historical input.
    pub async fn sources(
        &self,
        cut: &HistoryCut,
        sequence: u64,
        after_position: Option<u64>,
        limit: u32,
    ) -> Result<QueueSourcePage, StoreError> {
        self.data
            .query(Sources(
                self.clone(),
                cut.clone(),
                sequence,
                after_position,
                limit,
            ))
            .await
    }
    pub async fn source_content(
        &self,
        cut: &HistoryCut,
        sequence: u64,
        position: u64,
        reference: &ContentRef,
    ) -> Result<Vec<u8>, StoreError> {
        self.data
            .query(SourceContent(
                self.clone(),
                cut.clone(),
                sequence,
                position,
                reference.clone(),
            ))
            .await
    }
    /// Uses the same blocking read lane and callback restrictions as `with_content`.
    pub async fn with_source<T: Send + 'static>(
        &self,
        cut: &HistoryCut,
        sequence: u64,
        position: u64,
        reference: &ContentRef,
        consume: impl FnOnce(&mut dyn std::io::Read) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        self.data
            .query(StreamSourceContent(
                self.clone(),
                cut.clone(),
                sequence,
                position,
                reference.clone(),
                consume,
            ))
            .await
    }
    /// Explicit repair on the original writer; canonical facts and pins remain.
    pub async fn rebuild(&self) -> Result<HistoryCut, StoreError> {
        self.data.write(Rebuild(self.clone())).await
    }
}

struct ReadToolResultMetadata(HistoryNamespace, HistoryCut, u64);

impl Query for ReadToolResultMetadata {
    type Output = Option<ToolResultMetadata>;

    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::tool_result_metadata(c, &self.0, &self.1, self.2)
    }
}
struct Capture(SessionHistory, Option<RunId>);
impl Query for Capture {
    type Output = HistoryCut;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::capture(c, &self.0.namespace, self.1)
    }
}
pub(crate) fn pending_interaction_count(
    c: &Connection,
    run: RunId,
    session: &str,
) -> Result<u64, StoreError> {
    Ok(c.query_row(
        "SELECT count(*) FROM agent_interaction_pending p JOIN agent_interaction_requests r ON r.request=p.request JOIN agent_runs ar ON ar.run=r.run WHERE p.session=?1 AND r.run=?2 AND ar.local=1 AND ar.stopped=0 AND ar.terminal IS NULL",
        rusqlite::params![session, run.to_string()],
        |row| sql::read_u64(row, 0),
    )?)
}
struct ReadLiveObservation(SessionHistory);
impl Query for ReadLiveObservation {
    type Output = LiveObservation;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let cut = sql::capture(c, &self.0.namespace, None)?;
        let latest = sql::latest(c, &self.0.namespace, &cut)?
            .map(|source| -> Result<_, StoreError> {
                let pending_interactions =
                    pending_interaction_count(c, source.run, &self.0.namespace.session)?;
                Ok(LiveRunObservation {
                    source,
                    pending_interactions,
                })
            })
            .transpose()?;
        Ok(LiveObservation { cut, latest })
    }
}
struct Page(SessionHistory, HistoryCut, u64, u32);
impl Query for Page {
    type Output = HistoryPage;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::page(c, &self.0.namespace, &self.1, self.2, self.3)
    }
}
struct Source(SessionHistory, RunId);
impl Query for Source {
    type Output = RunSource;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::run_source(c, &self.0.namespace, self.1)
    }
}
struct Request(SessionHistory, HistoryCut, RunId, StepId);
impl Query for Request {
    type Output = (RequestSpec, UnixMillis);
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::request_preparation(c, &self.0.namespace, &self.1, self.2, self.3)
    }
}
struct Content(SessionHistory, RunId, ContentRef);
impl Query for Content {
    type Output = Vec<u8>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::content(c, &self.0.namespace, self.1, &self.2)
    }
}
struct StreamContent<F>(SessionHistory, HistoryCut, RunId, ContentRef, F);
impl<T: Send + 'static, F> Query for StreamContent<F>
where
    F: FnOnce(&mut dyn std::io::Read) -> Result<T, StoreError> + Send + 'static,
{
    type Output = T;
    fn execute(self, c: &Connection) -> Result<T, StoreError> {
        sql::with_content(c, &self.0.namespace, &self.1, self.2, &self.3, |blob| {
            (self.4)(blob)
        })
    }
}
struct Previous(SessionHistory, HistoryCut, Option<u64>, u32);
impl Query for Previous {
    type Output = HistoryPage;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::previous(c, &self.0.namespace, &self.1, self.2, self.3)
    }
}
struct Sources(SessionHistory, HistoryCut, u64, Option<u64>, u32);
impl Query for Sources {
    type Output = QueueSourcePage;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::sources(c, &self.0.namespace, &self.1, self.2, self.3, self.4)
    }
}
struct SourceContent(SessionHistory, HistoryCut, u64, u64, ContentRef);
impl Query for SourceContent {
    type Output = Vec<u8>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::source_content(c, &self.0.namespace, &self.1, self.2, self.3, &self.4)
    }
}
struct StreamSourceContent<F>(SessionHistory, HistoryCut, u64, u64, ContentRef, F);
impl<T: Send + 'static, F> Query for StreamSourceContent<F>
where
    F: FnOnce(&mut dyn std::io::Read) -> Result<T, StoreError> + Send + 'static,
{
    type Output = T;
    fn execute(self, c: &Connection) -> Result<T, StoreError> {
        sql::with_source(
            c,
            &self.0.namespace,
            &self.1,
            self.2,
            self.3,
            &self.4,
            |blob| (self.5)(blob),
        )
    }
}
struct Rebuild(SessionHistory);
impl Statement for Rebuild {
    type Value = HistoryCut;
    type Output = HistoryCut;
    fn execute(self, c: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        let value = sql::rebuild(c, &self.0.namespace)?;
        Ok(Prepared {
            value,
            changed: true,
            notification: Notification::METADATA.with_sessions([self.0.namespace.session]),
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::InvalidTransition(_) | StoreError::EventConflict
        )
    }
}

struct CaptureAt(SessionHistory, u64);
impl Query for CaptureAt {
    type Output = HistoryCut;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::capture_at(
            c,
            &self.0.namespace.owner,
            &self.0.namespace.session,
            Some(self.1),
        )
    }
}
struct WindowItems(HistoryNamespace, HistoryCut, Vec<u64>);
impl Query for WindowItems {
    type Output = std::collections::BTreeMap<u64, HistoryItem>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::window_items(c, &self.0, &self.1, &self.2)
    }
}
struct Item(SessionHistory, HistoryCut, u64);
impl Query for Item {
    type Output = Option<HistoryItem>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::item(c, &self.0.namespace, &self.1, self.2)
    }
}
struct Latest(SessionHistory, HistoryCut);
impl Query for Latest {
    type Output = Option<RunSource>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::latest(c, &self.0.namespace, &self.1)
    }
}
struct ViewAt(SessionHistory, HistoryCut, RunId);
impl Query for ViewAt {
    type Output = crate::fold::RunView;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::view_at(c, &self.0.namespace, &self.1, self.2, |_, _| {})
    }
}
struct ExecutorViewAt(SessionHistory, HistoryCut, RunId, bool);
impl Query for ExecutorViewAt {
    type Output = (crate::fold::RunView, ExecutorTranscript);
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let mut transcript = ExecutorTranscript::default();
        let mut pieces = self.3.then(Vec::new);
        let view = sql::view_at(c, &self.0.namespace, &self.1, self.2, |sequence, record| {
            transcript.observe(sequence, record, &mut pieces);
        })?;
        transcript.mask_pieces(c, &view.spec.owner, None, pieces)?;
        Ok((view, transcript))
    }
}
struct ToolCall(SessionHistory, HistoryCut, RunId, ToolKey);
impl Query for ToolCall {
    type Output = maka_agent_facts::model::ModelToolCall;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::tool_call(c, &self.0.namespace, &self.1, self.2, &self.3)
    }
}
struct ToolPosition(SessionHistory, HistoryCut, String);
impl Query for ToolPosition {
    type Output = Option<maka_agent_facts::history::RowPosition>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::tool_position(c, &self.0.namespace, &self.1, &self.2)
    }
}
struct ToolPage(SessionHistory, HistoryCut, String, u64, u32);
impl Query for ToolPage {
    type Output = HistoryPage;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::tool_page(c, &self.0.namespace, &self.1, &self.2, self.3, self.4)
    }
}

struct Chunk(SessionHistory, HistoryCut, RunId, ContentRef, u64, u32);
impl Query for Chunk {
    type Output = Vec<u8>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::chunk(
            c,
            &self.0.namespace,
            &self.1,
            self.2,
            &self.3,
            self.4,
            self.5,
        )
    }
}

struct FirstMessage(SessionHistory, HistoryCut);
impl Query for FirstMessage {
    type Output = Option<RunSource>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::first_message(c, &self.0.namespace, &self.1)
    }
}

struct FactSequence(SessionHistory, HistoryCut, RunId, FactId);
impl Query for FactSequence {
    type Output = Option<u64>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::fact_sequence(c, &self.0.namespace, &self.1, self.2, self.3)
    }
}
struct RunRevisionThrough(SessionHistory, HistoryCut, RunId, u64);
impl Query for RunRevisionThrough {
    type Output = u64;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::run_revision_through(c, &self.0.namespace, &self.1, self.2, self.3)
    }
}

struct ResolveToolResult(SessionHistory, HistoryCut, String);
impl Query for ResolveToolResult {
    type Output = Option<ToolResultSource>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::resolve_tool_result(c, &self.0, &self.1, &self.2)
    }
}

#[cfg(test)]
mod executor_tests {
    use super::*;
    use maka_agent_facts::executor::Output;

    #[test]
    fn model_transcript_masks_evidence_in_coalesced_multi_delta_segment_at_d1_offset() {
        let c = Connection::open_in_memory().unwrap();
        // Match real migrated table columns: agent_recall_messages has NO fact_id column.
        c.execute_batch(
            "CREATE TABLE agent_memory_hidden_spans(namespace,fact,ordinal,start,end,session,sequence);
             CREATE TABLE agent_session_history(owner,session,sequence,run,fact_id);
             CREATE TABLE agent_recall_messages(owner,session,sequence,ordinal,body);
             CREATE TABLE agent_recall_external_segments(owner,session,run,sealed,tail_start_sequence,tail_end_sequence,tail_end_fact);",
        )
        .unwrap();
        let owner = RunOwner {
            deployment: uuid::Uuid::new_v4(),
            namespace: maka_plugin_core::composition::InstanceId(vec![uuid::Uuid::new_v4()]),
        };
        let owner_json = serde_json::to_string(&owner).unwrap();
        let mut transcript = ExecutorTranscript::default();
        let mut pieces = Some(Vec::new());
        let run = RunId::new();
        let task = ExternalTaskId::new();
        // 4 deltas: d0="开头 ", d1="secret-", d2="mid ", d3="visible".
        // Under v60 sealing, S_last (seq=4, fact=F_3) indexes d1..d3 = "secret-mid visible" (18 bytes),
        // so hiding bytes [0..10) ("secret-mid") on F_3 must mask d1..d2, NOT shift right into d3!
        for (index, text) in ["开头 ", "secret-", "mid ", "visible"]
            .into_iter()
            .enumerate()
        {
            let id = FactId::new();
            let sequence = index as u64 + 1;
            let record = RecordedFact {
                schema_version: SCHEMA_VERSION,
                id,
                run,
                revision: sequence,
                at: UnixMillis(0),
                fact: Fact::ExternalTaskObserved {
                    task,
                    model_time_ms: None,
                    index: index as u64,
                    output: Output::OutputDelta {
                        message_id: "m".into(),
                        text: text.into(),
                    },
                },
            };
            transcript.observe(sequence, &record, &mut pieces);
            c.execute(
                "INSERT INTO agent_session_history VALUES(?1,'s',?2,?3,?4)",
                rusqlite::params![owner_json, sequence as i64, run.to_string(), id.to_string()],
            )
            .unwrap();
            if index == 3 {
                c.execute(
                    "INSERT INTO agent_recall_messages VALUES(?1,'s',4,0,'secret-mid visible')",
                    rusqlite::params![owner_json],
                )
                .unwrap();
                c.execute(
                    "INSERT INTO agent_recall_external_segments VALUES(?1,'s',?2,1,2,4,?3)",
                    rusqlite::params![owner_json, run.to_string(), id.to_string()],
                )
                .unwrap();
                c.execute(
                    "INSERT INTO agent_memory_hidden_spans VALUES(?1,?2,0,0,10,'s',4)",
                    rusqlite::params![owner_json, id.to_string()],
                )
                .unwrap();
            }
        }
        transcript.mask_pieces(&c, &owner, None, pieces).unwrap();
        assert_eq!(
            transcript.text("m", false).unwrap().body.to_string(),
            "开头 ********** visible"
        );
    }
}
