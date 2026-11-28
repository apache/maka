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
use super::document::{self, Rule, cell_text, field, input_message, json_text, projection};
use super::*;
use maka_agent_facts::{
    artifact::ToolReturn,
    cells::{CellEvent, CellId, CellReturnedResult, StoredCellReturn},
    executor::Output,
    input::RunInput,
    model::{ModelPart, TextKind, ToolInput},
    tool_output::{
        AcceptedToolResult, CellFinalEvidence, DurableToolProjection, ReturnedToolResult,
        StoredToolResult, ToolOutput,
    },
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

fn body_digest(body: &str) -> [u8; 32] {
    Sha256::digest(body.as_bytes()).into()
}

fn with_owned_bytes<T>(
    c: &Connection,
    run: RunId,
    reference: &ContentRef,
    layout: MessageLayout,
    consume: impl FnOnce(&[u8]) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    if layout == MessageLayout::Current {
        crate::sql::with_owned_content(c, run, reference, consume)
    } else {
        crate::sql::with_owned_content_legacy(c, run, reference, consume)
    }
}

fn exact(
    c: &Connection,
    run: RunId,
    reference: &ContentRef,
    layout: MessageLayout,
) -> Result<Vec<u8>, StoreError> {
    let mut out = None;
    with_owned_bytes(c, run, reference, layout, |bytes| {
        out = Some(bytes.to_vec());
        Ok(())
    })?;
    out.ok_or_else(|| invalid("missing Recall content"))
}

fn tool_return(
    c: &Connection,
    run: RunId,
    reference: &ContentRef,
    layout: MessageLayout,
) -> Result<ToolReturn<ReturnedToolResult>, StoreError> {
    let returned: ToolReturn<StoredToolResult> =
        serde_json::from_slice(&exact(c, run, reference, layout)?)?;
    returned.validate().map_err(invalid)?;
    let body = match returned.body {
        StoredToolResult::Inline(body) => *body,
        StoredToolResult::Operation(body) => {
            let reply = crate::operation::read_reply_with_encoding(
                c,
                run,
                &body.operation,
                layout == MessageLayout::Current,
            )?;
            body.resolve(reply).map_err(invalid)?
        }
        StoredToolResult::CellCompleted(body) => {
            let result_ref = body
                .result_ref()
                .ok_or_else(|| invalid("shared cell projection missing completed result ref"))?
                .clone();
            let obs: maka_agent_facts::cells::CellObservation =
                serde_json::from_slice(&exact(c, run, &result_ref, layout)?)?;
            body.resolve(&obs).map_err(invalid)?
        }
    };
    Ok(ToolReturn {
        schema_version: returned.schema_version,
        artifacts: returned.artifacts,
        body,
    })
}

fn cell_final(
    c: &Connection,
    run: RunId,
    cell: CellId,
    evidence: CellFinalEvidence,
    message: &mut Message,
    omit_empty_fields: bool,
    layout: MessageLayout,
) -> Result<(), StoreError> {
    match evidence {
        CellFinalEvidence::Completed { result } => {
            let observation: maka_agent_facts::cells::CellObservation =
                serde_json::from_slice(&exact(c, run, &result, layout)?)?;
            let maka_agent_facts::cells::CellObservation::Completed {
                cell_id,
                content,
                result,
            } = observation
            else {
                return Err(invalid(
                    "Cell completed reference is not its complete result",
                ));
            };
            if cell_id != cell {
                return Err(StoreError::EventConflict);
            }
            let text = cell_text(content);
            let result_text = json_text(&result);
            if !omit_empty_fields || !text.is_empty() {
                field(message, Field::Result, &text, false);
            }
            if !omit_empty_fields || !result_text.is_empty() {
                field(message, Field::Result, &result_text, false);
            }
        }
        CellFinalEvidence::Interrupted { report } => {
            let report: maka_agent_facts::cells::CellInterruption =
                serde_json::from_slice(&exact(c, run, &report, layout)?)?;
            if report.cell != cell {
                return Err(StoreError::EventConflict);
            }
            field(message, Field::Result, &report.diagnostic, false);
            if let Some(prior) = report.prior_output {
                let prior_text = cell_text(prior.content);
                if !omit_empty_fields || !prior_text.is_empty() {
                    field(message, Field::Result, &prior_text, false);
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn compact_operation_receipt(r: &maka_plugin_core::operation::RecoveryRef) -> String {
    let mut out = r.contract.name.clone();
    let call = format!("{}.{}", r.export, r.method);
    if !r.export.is_empty() && !r.method.is_empty() && !out.contains(&call) {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&call);
    }
    if out.is_empty() {
        out.push_str("child_result_recorded");
    }
    out
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum MessageLayout {
    /// Current schema (v61+): `namespace_id` surrogate key, no `folded`.
    Current,
    /// Historical v59/v60 schema: `(owner, session)` text columns, no `folded`.
    LegacyV58OwnerSession,
    /// Historical v55 schema (v11..=v58): `(owner, session)` with `folded TEXT NOT NULL`
    /// while migration 55 runs ahead of migrations 59–61 on multi-hop upgrades.
    LegacyV55Folded,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ProjectionMode {
    /// v58+ compact indexing: deduplicates tool/cell results, strips UUID/SHA JSON receipt
    /// shells, and coalesces external streaming deltas.
    CompactV58,
    /// Pre-v58 layout preserved strictly for historical facts referenced by pre-v58
    /// Memory evidence (and for historical migration 55 multi-hop runs).
    LegacyV57,
}

struct PendingContinuation {
    start_sequence: u64,
    sequence: u64,
    start_timestamp: u64,
    timestamp: u64,
    fact_id: FactId,
    run: RunId,
    turn_id: String,
    reference: ContentRef,
    is_thinking: bool,
    body: String,
}

struct OpenDeltaSegment {
    admission_sequence: u64,
    s0_sequence: u64,
    turn_id: String,
    continuation: Option<PendingContinuation>,
}

type DeltaKey = (RunId, ExternalTaskId, String, bool);
type CompletedCellKey = (RunId, CellId, String);
type LocalReturnMeta = (i64, u64, String, usize, [u8; 32]);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum FtsMode {
    Immediate,
    /// Defer `agent_recall_terms` writes to a single bulk `INSERT ... SELECT` after
    /// message rows settle. Inside a migration `SAVEPOINT`, interleaving FTS5 writes
    /// with `INSERT ... ON CONFLICT` / `UPDATE` / `DELETE` forces SQLite's
    /// `fts5SavepointMethod` to flush and merge the FTS5 hash table on every row.
    Deferred,
}

/// In-memory session state during rebuild / migration 60 with bounded RAM:
/// - `completed_cells` and `local_returns` keep only compact metadata (no full body strings)
///   and remove entries as soon as settled.
/// - `open_deltas` buffers only currently active streaming continuations and flushes + drops
///   each segment on `MessageEnd`, non-delta task events, `ExternalTaskClosed`, or `RunTerminated`.
pub(super) struct RebuildState {
    legacy_evidenced: HashSet<String>,
    evidenced: HashSet<String>,
    fts_mode: FtsMode,
    completed_cells: HashMap<CompletedCellKey, (i64, String, usize)>,
    local_returns: HashMap<(RunId, String), LocalReturnMeta>,
    open_deltas: HashMap<DeltaKey, OpenDeltaSegment>,
}

#[expect(
    clippy::too_many_arguments,
    reason = "segment upsert writes all explicit columns of agent_recall_external_segments"
)]
fn upsert_external_segment(
    c: &Connection,
    owner_json: &str,
    session: &str,
    run: RunId,
    admission_sequence: u64,
    turn_id: &str,
    task: ExternalTaskId,
    message_id: &str,
    is_thinking: bool,
    s0_sequence: u64,
    cont: Option<&PendingContinuation>,
    sealed: bool,
    layout: MessageLayout,
) -> Result<(), StoreError> {
    let (tail_start_seq, tail_end_seq, tail_start_at, tail_end_at, tail_end_fact, tail_bytes) =
        match cont {
            Some(cont) => (
                Some(number(cont.start_sequence)?),
                Some(number(cont.sequence)?),
                Some(number(cont.start_timestamp)?),
                Some(number(cont.timestamp)?),
                Some(cont.fact_id.to_string()),
                i64::try_from(cont.body.len())
                    .map_err(|_| invalid("external delta tail exceeds SQLite range"))?,
            ),
            None => (None, None, None, None, None, 0i64),
        };
    match layout {
        MessageLayout::Current => {
            let ns_id = crate::namespace::ensure_id(c, owner_json, session)?;
            c.prepare_cached(
                "INSERT INTO agent_recall_external_segments(
                    namespace_id, run, admission_sequence, turn, task, message_id, is_thinking,
                    s0_sequence, tail_start_sequence, tail_end_sequence, tail_start_at, tail_end_at,
                    tail_end_fact, tail_bytes, sealed
                 )
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
                 ON CONFLICT(namespace_id, run, task, message_id, is_thinking, s0_sequence)
                 DO UPDATE SET
                    admission_sequence = excluded.admission_sequence,
                    turn = excluded.turn,
                    tail_start_sequence = excluded.tail_start_sequence,
                    tail_end_sequence = excluded.tail_end_sequence,
                    tail_start_at = excluded.tail_start_at,
                    tail_end_at = excluded.tail_end_at,
                    tail_end_fact = excluded.tail_end_fact,
                    tail_bytes = excluded.tail_bytes,
                    sealed = excluded.sealed",
            )?
            .execute(params![
                ns_id,
                run.to_string(),
                number(admission_sequence)?,
                turn_id,
                task.to_string(),
                message_id,
                i64::from(is_thinking),
                number(s0_sequence)?,
                tail_start_seq,
                tail_end_seq,
                tail_start_at,
                tail_end_at,
                tail_end_fact,
                tail_bytes,
                i64::from(sealed),
            ])?;
        }
        MessageLayout::LegacyV58OwnerSession => {
            c.prepare_cached(
                "INSERT INTO agent_recall_external_segments(
                    owner, session, run, admission_sequence, turn, task, message_id, is_thinking,
                    s0_sequence, tail_start_sequence, tail_end_sequence, tail_start_at, tail_end_at,
                    tail_end_fact, tail_bytes, sealed
                 )
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
                 ON CONFLICT(owner, session, run, task, message_id, is_thinking, s0_sequence)
                 DO UPDATE SET
                    admission_sequence = excluded.admission_sequence,
                    turn = excluded.turn,
                    tail_start_sequence = excluded.tail_start_sequence,
                    tail_end_sequence = excluded.tail_end_sequence,
                    tail_start_at = excluded.tail_start_at,
                    tail_end_at = excluded.tail_end_at,
                    tail_end_fact = excluded.tail_end_fact,
                    tail_bytes = excluded.tail_bytes,
                    sealed = excluded.sealed",
            )?
            .execute(params![
                owner_json,
                session,
                run.to_string(),
                number(admission_sequence)?,
                turn_id,
                task.to_string(),
                message_id,
                i64::from(is_thinking),
                number(s0_sequence)?,
                tail_start_seq,
                tail_end_seq,
                tail_start_at,
                tail_end_at,
                tail_end_fact,
                tail_bytes,
                i64::from(sealed),
            ])?;
        }
        MessageLayout::LegacyV55Folded => {}
    }
    Ok(())
}

fn admission_sequence_for(
    c: &Connection,
    owner_json: &str,
    session: &str,
    sequence: u64,
    layout: MessageLayout,
) -> Result<u64, StoreError> {
    let adm: i64 = match layout {
        MessageLayout::Current => {
            let ns_id = crate::namespace::ensure_id(c, owner_json, session)?;
            c.prepare_cached(
                "SELECT admission_sequence FROM agent_session_history
                 WHERE namespace_id = ?1 AND sequence = ?2",
            )?
            .query_row(params![ns_id, number(sequence)?], |r| r.get(0))?
        }
        MessageLayout::LegacyV58OwnerSession | MessageLayout::LegacyV55Folded => c
            .prepare_cached(
                "SELECT admission_sequence FROM agent_session_history
                 WHERE owner = ?1 AND session = ?2 AND sequence = ?3",
            )?
            .query_row(params![owner_json, session, number(sequence)?], |r| {
                r.get(0)
            })?,
    };
    unsigned(adm)
}

impl RebuildState {
    pub(super) fn new(
        legacy_evidenced: HashSet<String>,
        active_evidenced: HashSet<String>,
    ) -> Self {
        Self::with_fts_mode(legacy_evidenced, active_evidenced, FtsMode::Immediate)
    }

    pub(super) fn new_deferred_fts(
        legacy_evidenced: HashSet<String>,
        active_evidenced: HashSet<String>,
    ) -> Self {
        Self::with_fts_mode(legacy_evidenced, active_evidenced, FtsMode::Deferred)
    }

    fn with_fts_mode(
        legacy_evidenced: HashSet<String>,
        active_evidenced: HashSet<String>,
        fts_mode: FtsMode,
    ) -> Self {
        let mut evidenced = legacy_evidenced.clone();
        evidenced.extend(active_evidenced);
        Self {
            legacy_evidenced,
            evidenced,
            fts_mode,
            completed_cells: HashMap::new(),
            local_returns: HashMap::new(),
            open_deltas: HashMap::new(),
        }
    }

    fn fts_mode(&self) -> FtsMode {
        self.fts_mode
    }

    pub(super) fn reset_session(&mut self) {
        self.completed_cells.clear();
        self.local_returns.clear();
        self.open_deltas.clear();
    }

    fn emit_sealed_segment(
        &self,
        c: &Connection,
        owner: &RunOwner,
        session: &str,
        key: DeltaKey,
        seg: OpenDeltaSegment,
        layout: MessageLayout,
    ) -> Result<(), StoreError> {
        let Some(delta) = seg.continuation else {
            return Ok(());
        };
        let (run, task, message_id, is_thinking) = key;
        let owner_json = serde_json::to_string(owner)?;
        upsert_external_segment(
            c,
            &owner_json,
            session,
            run,
            seg.admission_sequence,
            &seg.turn_id,
            task,
            &message_id,
            is_thinking,
            seg.s0_sequence,
            Some(&delta),
            true,
            layout,
        )?;
        let end = delta.body.len();
        let message = Message {
            fact: delta.fact_id,
            message_id: delta.fact_id.to_string(),
            position: RowPosition {
                source_sequence: delta.sequence,
                item_index: 0,
            },
            run: delta.run,
            turn_id: delta.turn_id,
            timestamp: delta.timestamp,
            role: Role::Assistant,
            body: delta.body,
            attachments: vec![],
            references: vec![delta.reference],
            fields: vec![FieldSpan {
                field: if delta.is_thinking {
                    Field::Thinking
                } else {
                    Field::Body
                },
                start: 0,
                end,
                internal: delta.is_thinking,
            }],
            origin: None,
        };
        insert_raw(c, owner, session, message, layout, self.fts_mode)?;
        Ok(())
    }

    /// Record a delta under 2-tier immutable sealing:
    /// - First delta `S0` of an open segment is NOT buffered here; returns `false` so caller
    ///   inserts immutable `S0` immediately while marking the segment open.
    /// - Subsequent deltas `S1..S_last` append to `continuation` and return `true`, to be
    ///   flushed once as an immutable row at `S_last` when the segment seals.
    #[expect(
        clippy::too_many_arguments,
        reason = "delta coalescing tracks segment key and latest continuation coordinates"
    )]
    fn push_continuation_if_open(
        &mut self,
        c: &Connection,
        spec: &RunSpec,
        fact: &RecordedFact,
        sequence: u64,
        reference: ContentRef,
        task: ExternalTaskId,
        message_id: String,
        is_thinking: bool,
        text: &str,
        layout: MessageLayout,
    ) -> Result<bool, StoreError> {
        let key = (fact.run, task, message_id, is_thinking);
        if let Some(seg) = self.open_deltas.get_mut(&key) {
            let timestamp = unsigned(fact.at.0)?;
            if let Some(cont) = seg.continuation.as_mut() {
                cont.body.push_str(text);
                cont.sequence = sequence;
                cont.fact_id = fact.id;
                cont.timestamp = timestamp;
                cont.reference = reference;
            } else {
                seg.continuation = Some(PendingContinuation {
                    start_sequence: sequence,
                    sequence,
                    start_timestamp: timestamp,
                    timestamp,
                    fact_id: fact.id,
                    run: fact.run,
                    turn_id: spec.turn_id.clone(),
                    reference,
                    is_thinking,
                    body: text.to_owned(),
                });
            }
            Ok(true)
        } else {
            let owner_json = serde_json::to_string(&spec.owner)?;
            let admission_sequence =
                admission_sequence_for(c, &owner_json, &spec.session_id, sequence, layout)?;
            self.open_deltas.insert(
                key,
                OpenDeltaSegment {
                    admission_sequence,
                    s0_sequence: sequence,
                    turn_id: spec.turn_id.clone(),
                    continuation: None,
                },
            );
            Ok(false)
        }
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "seals both output and thinking continuations for one (run, task, message_id)"
    )]
    fn seal_message(
        &mut self,
        c: &Connection,
        owner: &RunOwner,
        session: &str,
        run: RunId,
        task: ExternalTaskId,
        message_id: &str,
        layout: MessageLayout,
    ) -> Result<(), StoreError> {
        let mut to_emit = Vec::new();
        for is_thinking in [false, true] {
            let key = (run, task, message_id.to_owned(), is_thinking);
            if let Some(seg) = self.open_deltas.remove(&key)
                && seg.continuation.is_some()
            {
                to_emit.push((key, seg));
            }
        }
        to_emit.sort_by_key(|(_, seg)| seg.continuation.as_ref().map_or(0, |d| d.sequence));
        for (key, seg) in to_emit {
            self.emit_sealed_segment(c, owner, session, key, seg, layout)?;
        }
        Ok(())
    }

    fn seal_key(
        &mut self,
        c: &Connection,
        owner: &RunOwner,
        session: &str,
        key: &DeltaKey,
        layout: MessageLayout,
    ) -> Result<(), StoreError> {
        if let Some((key, seg)) = self.open_deltas.remove_entry(key)
            && seg.continuation.is_some()
        {
            self.emit_sealed_segment(c, owner, session, key, seg, layout)?;
        }
        Ok(())
    }

    fn seal_task(
        &mut self,
        c: &Connection,
        owner: &RunOwner,
        session: &str,
        run: RunId,
        task: ExternalTaskId,
        layout: MessageLayout,
    ) -> Result<(), StoreError> {
        let keys: Vec<DeltaKey> = self
            .open_deltas
            .keys()
            .filter(|(r, t, _, _)| *r == run && *t == task)
            .cloned()
            .collect();
        let mut to_emit = Vec::new();
        for key in keys {
            if let Some((k, seg)) = self.open_deltas.remove_entry(&key)
                && seg.continuation.is_some()
            {
                to_emit.push((k, seg));
            }
        }
        to_emit.sort_by_key(|(_, seg)| seg.continuation.as_ref().map_or(0, |d| d.sequence));
        for (key, seg) in to_emit {
            self.emit_sealed_segment(c, owner, session, key, seg, layout)?;
        }
        Ok(())
    }

    fn seal_run(
        &mut self,
        c: &Connection,
        owner: &RunOwner,
        session: &str,
        run: RunId,
        layout: MessageLayout,
    ) -> Result<(), StoreError> {
        let keys: Vec<DeltaKey> = self
            .open_deltas
            .keys()
            .filter(|(r, _, _, _)| *r == run)
            .cloned()
            .collect();
        let mut to_emit = Vec::new();
        for key in keys {
            if let Some((k, seg)) = self.open_deltas.remove_entry(&key)
                && seg.continuation.is_some()
            {
                to_emit.push((k, seg));
            }
        }
        to_emit.sort_by_key(|(_, seg)| seg.continuation.as_ref().map_or(0, |d| d.sequence));
        for (key, seg) in to_emit {
            self.emit_sealed_segment(c, owner, session, key, seg, layout)?;
        }
        Ok(())
    }

    /// Persist any still-open streaming segments as `sealed = 0` in
    /// `agent_recall_external_segments` so rebuilt state matches live ingestion identically.
    pub(super) fn flush_open_deltas(
        &mut self,
        c: &Connection,
        owner: &RunOwner,
        session: &str,
        layout: MessageLayout,
    ) -> Result<(), StoreError> {
        if layout == MessageLayout::LegacyV55Folded {
            self.open_deltas.clear();
            return Ok(());
        }
        let owner_json = serde_json::to_string(owner)?;
        let remaining = std::mem::take(&mut self.open_deltas);
        for ((run, task, message_id, is_thinking), seg) in remaining {
            upsert_external_segment(
                c,
                &owner_json,
                session,
                run,
                seg.admission_sequence,
                &seg.turn_id,
                task,
                &message_id,
                is_thinking,
                seg.s0_sequence,
                seg.continuation.as_ref(),
                false,
                layout,
            )?;
        }
        Ok(())
    }
}

pub(super) fn load_legacy_evidenced(c: &Connection) -> Result<HashSet<String>, StoreError> {
    let exists: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_recall_legacy_evidenced')",
        [],
        |r| r.get(0),
    )?;
    if !exists {
        return Ok(HashSet::new());
    }
    let mut stmt = c.prepare_cached("SELECT fact_id FROM agent_recall_legacy_evidenced")?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<HashSet<_>, _>>()?;
    Ok(rows)
}

pub(super) fn load_active_evidenced(c: &Connection) -> Result<HashSet<String>, StoreError> {
    let exists: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_memory_evidence')",
        [],
        |r| r.get(0),
    )?;
    if !exists {
        return Ok(HashSet::new());
    }
    let mut stmt = c.prepare_cached(
        "SELECT DISTINCT CAST(json_extract(source, '$.reference.factId') AS TEXT)
         FROM agent_memory_evidence
         WHERE json_extract(source, '$.kind') = 'conversation'
           AND json_extract(source, '$.reference.factId') IS NOT NULL",
    )?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<HashSet<_>, _>>()?;
    Ok(rows)
}

fn is_protected_from_pruning(
    c: &Connection,
    owner_json: &str,
    row_id: i64,
    fact_id: &str,
    state: Option<&RebuildState>,
) -> Result<bool, StoreError> {
    if let Some(state) = state {
        if state.evidenced.contains(fact_id) {
            return Ok(true);
        }
    } else {
        let legacy: bool = c
            .prepare_cached(
                "SELECT EXISTS(SELECT 1 FROM agent_recall_legacy_evidenced WHERE fact_id = ?1)",
            )?
            .query_row([fact_id], |r| r.get(0))?;
        if legacy {
            return Ok(true);
        }
        let evidenced: bool = c
            .prepare_cached(
                "SELECT EXISTS(
                   SELECT 1 FROM agent_memory_evidence
                   WHERE namespace = ?1
                     AND json_extract(source, '$.kind') = 'conversation'
                     AND CAST(json_extract(source, '$.reference.factId') AS TEXT) = ?2
                 )",
            )?
            .query_row(params![owner_json, fact_id], |r| r.get(0))?;
        if evidenced {
            return Ok(true);
        }
    }
    let shared: bool = c
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM agent_memory_shared_fields WHERE message = ?1)",
        )?
        .query_row([row_id], |r| r.get(0))?;
    Ok(shared)
}

/// Supersede an earlier same-run internal `CellEvent::Completed` Recall row when the outer
/// transcript return (`LocalToolReturned`, `ToolResultAccepted`, or `ExternalEffect::Returned`)
/// is non-failure and provably covers every searchable byte of the completed cell's body.
///
/// The `Completed` row is NEVER physically deleted: its duplicate body and FTS5 postings are
/// cleared and replaced with explicit single-hop `body_ref_sequence` / `body_ref_start` /
/// `body_ref_end` metadata pointing to `outer_sequence`, so fixed historical cuts prior to
/// `outer_sequence` remain searchable and accurately billed against `FindWork`.
#[expect(
    clippy::too_many_arguments,
    reason = "superseding resolves owner/session/run/cell/digest and verifies verbatim coverage"
)]
fn supersede_completed_cell(
    c: &Connection,
    spec: &RunSpec,
    run: RunId,
    cell: CellId,
    result_digest: &str,
    outer_sequence: u64,
    outer_body: &str,
    outer_is_failure: bool,
    state: Option<&mut RebuildState>,
    layout: MessageLayout,
) -> Result<(), StoreError> {
    if outer_is_failure || outer_body.is_empty() {
        return Ok(());
    }
    let owner_json = serde_json::to_string(&spec.owner)?;
    let coverage_span = |completed_body: &str,
                         fields_json: &str|
     -> Result<Option<(Option<usize>, usize)>, StoreError> {
        if completed_body.is_empty() || completed_body.len() > outer_body.len() {
            return Ok(None);
        }
        if let Some(start) = outer_body.find(completed_body) {
            return Ok(Some((Some(start), start + completed_body.len())));
        }
        let span_covered = |slice: &str| -> bool {
            if outer_body.contains(slice) {
                return true;
            }
            let mut had_line = false;
            for line in slice.lines() {
                if line.is_empty() {
                    continue;
                }
                had_line = true;
                if !outer_body.contains(line) {
                    return false;
                }
            }
            had_line
        };
        let fields: Vec<FieldSpan> = serde_json::from_str(fields_json)?;
        if fields.is_empty() {
            return Ok(span_covered(completed_body).then_some((None, completed_body.len())));
        }
        let mut checked_any = false;
        for span in fields {
            if span.start >= span.end {
                continue;
            }
            let Some(slice) = completed_body.get(span.start..span.end) else {
                return Ok(None);
            };
            if !span_covered(slice) {
                return Ok(None);
            }
            checked_any = true;
        }
        Ok(checked_any.then_some((None, completed_body.len())))
    };

    let apply_supersede = |row_id: i64,
                           ref_start: Option<usize>,
                           ref_end: usize,
                           immediate_fts: bool|
     -> Result<(), StoreError> {
        if immediate_fts {
            c.prepare_cached("DELETE FROM agent_recall_terms WHERE rowid = ?1")?
                .execute([row_id])?;
        }
        let start_i64 = ref_start
            .map(|s| i64::try_from(s).map_err(|_| invalid("body_ref_start overflow")))
            .transpose()?;
        let end_i64 = i64::try_from(ref_end).map_err(|_| invalid("body_ref_end overflow"))?;
        c.prepare_cached(
            "UPDATE agent_recall_messages
             SET body = '', body_ref_sequence = ?2, body_ref_start = ?3, body_ref_end = ?4
             WHERE id = ?1",
        )?
        .execute(params![row_id, number(outer_sequence)?, start_i64, end_i64])?;
        Ok(())
    };

    if let Some(state) = state {
        let Some((row_id, fact_id, completed_len)) =
            state
                .completed_cells
                .remove(&(run, cell, result_digest.to_owned()))
        else {
            return Ok(());
        };
        if completed_len == 0 || completed_len > outer_body.len() {
            return Ok(());
        }
        let completed: Option<(String, String)> = c
            .prepare_cached("SELECT body, fields_json FROM agent_recall_messages WHERE id = ?1")?
            .query_row([row_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        if let Some((completed_body, fields_json)) = completed
            && let Some((ref_start, ref_end)) = coverage_span(&completed_body, &fields_json)?
            && !is_protected_from_pruning(c, &owner_json, row_id, &fact_id, Some(state))?
        {
            apply_supersede(
                row_id,
                ref_start,
                ref_end,
                state.fts_mode == FtsMode::Immediate,
            )?;
        }
        return Ok(());
    }
    let rows: Vec<(i64, String, String, String)> = match layout {
        MessageLayout::Current => {
            let Some(ns_id) = crate::namespace::find_id(c, &owner_json, &spec.session_id)? else {
                return Ok(());
            };
            c.prepare_cached(
                "SELECT d.id, h.fact_id, d.body, d.fields_json
                 FROM agent_recall_messages d
                 JOIN agent_session_history h
                   ON h.namespace_id = d.namespace_id AND h.sequence = d.sequence
                 WHERE d.namespace_id = ?1 AND d.run = ?2
                   AND h.kind = 'cell' AND h.tool_use_id IS NULL
                   AND d.sequence < ?3 AND d.ordinal = 0
                   AND d.body_ref_sequence IS NULL
                   AND d.references_json->>'$[1].digest' = ?4",
            )?
            .query_map(
                params![
                    ns_id,
                    run.to_string(),
                    number(outer_sequence)?,
                    result_digest
                ],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )?
            .collect::<Result<_, _>>()?
        }
        MessageLayout::LegacyV58OwnerSession | MessageLayout::LegacyV55Folded => c
            .prepare_cached(
                "SELECT d.id, h.fact_id, d.body, d.fields_json
                 FROM agent_recall_messages d
                 JOIN agent_session_history h
                   ON h.owner = d.owner AND h.session = d.session AND h.sequence = d.sequence
                 WHERE d.owner = ?1 AND d.session = ?2 AND d.run = ?3
                   AND h.kind = 'cell' AND h.tool_use_id IS NULL
                   AND d.sequence < ?4 AND d.ordinal = 0
                   AND d.body_ref_sequence IS NULL
                   AND d.references_json->>'$[1].digest' = ?5",
            )?
            .query_map(
                params![
                    owner_json,
                    spec.session_id,
                    run.to_string(),
                    number(outer_sequence)?,
                    result_digest
                ],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )?
            .collect::<Result<_, _>>()?,
    };
    for (row_id, fact_id, completed_body, fields_json) in rows {
        if let Some((ref_start, ref_end)) = coverage_span(&completed_body, &fields_json)?
            && !is_protected_from_pruning(c, &owner_json, row_id, &fact_id, None)?
        {
            apply_supersede(row_id, ref_start, ref_end, true)?;
        }
    }
    Ok(())
}

/// Clear duplicate body and FTS5 postings on an earlier `LocalToolReturned` row once
/// `ToolResultAccepted::Local` indexes the exact same body for the same tool call, and
/// transitively repoint any `CellEvent::Completed` rows that referenced `LocalToolReturned`
/// so every `body_ref_sequence` remains strictly single-hop.
#[expect(
    clippy::too_many_arguments,
    reason = "clearing resolves owner/session/run/tool/body across both live and rebuild paths"
)]
fn clear_superseded_local_return(
    c: &Connection,
    spec: &RunSpec,
    run: RunId,
    tool: &ToolKey,
    acc_sequence: u64,
    body: &str,
    state: Option<&mut RebuildState>,
    layout: MessageLayout,
) -> Result<(), StoreError> {
    if body.is_empty() {
        return Ok(());
    }
    let owner_json = serde_json::to_string(&spec.owner)?;
    let tool_id = maka_agent_facts::tool_call::tool_use_id(run, &crate::fold::tool_key(tool));
    let acc_seq_i64 = number(acc_sequence)?;
    let body_len_i64 = i64::try_from(body.len()).map_err(|_| invalid("body_ref_end overflow"))?;

    let clear_and_repoint = |row_id: i64,
                             loc_seq: u64,
                             immediate_fts: bool|
     -> Result<(), StoreError> {
        if immediate_fts {
            c.prepare_cached("DELETE FROM agent_recall_terms WHERE rowid = ?1")?
                .execute([row_id])?;
        }
        c.prepare_cached(
            "UPDATE agent_recall_messages
                 SET body = '', body_ref_sequence = ?2, body_ref_start = 0, body_ref_end = ?3
                 WHERE id = ?1",
        )?
        .execute(params![row_id, acc_seq_i64, body_len_i64])?;
        match layout {
            MessageLayout::Current => {
                if let Some(ns_id) = crate::namespace::find_id(c, &owner_json, &spec.session_id)? {
                    c.prepare_cached(
                        "UPDATE agent_recall_messages
                             SET body_ref_sequence = ?1
                             WHERE namespace_id = ?2 AND body_ref_sequence = ?3",
                    )?
                    .execute(params![acc_seq_i64, ns_id, number(loc_seq)?])?;
                }
            }
            MessageLayout::LegacyV58OwnerSession | MessageLayout::LegacyV55Folded => {
                c.prepare_cached(
                    "UPDATE agent_recall_messages
                         SET body_ref_sequence = ?1
                         WHERE owner = ?2 AND session = ?3 AND body_ref_sequence = ?4",
                )?
                .execute(params![
                    acc_seq_i64,
                    owner_json,
                    spec.session_id,
                    number(loc_seq)?
                ])?;
            }
        }
        Ok(())
    };

    if let Some(state) = state {
        let Some((row_id, loc_seq, fact_id, prior_len, prior_hash)) =
            state.local_returns.remove(&(run, tool_id))
        else {
            return Ok(());
        };
        if prior_len == body.len()
            && prior_hash == body_digest(body)
            && !is_protected_from_pruning(c, &owner_json, row_id, &fact_id, Some(state))?
        {
            clear_and_repoint(row_id, loc_seq, state.fts_mode == FtsMode::Immediate)?;
        }
        return Ok(());
    }
    let rows: Vec<(i64, i64, String)> = match layout {
        MessageLayout::Current => {
            let Some(ns_id) = crate::namespace::find_id(c, &owner_json, &spec.session_id)? else {
                return Ok(());
            };
            c.prepare_cached(
                "SELECT d.id, d.sequence, h.fact_id
                 FROM agent_session_history h
                 JOIN agent_recall_messages d
                   ON d.namespace_id = h.namespace_id AND d.sequence = h.sequence AND d.ordinal = 0
                 WHERE h.namespace_id = ?1 AND h.tool_use_id = ?2
                   AND h.run = ?3 AND h.kind = 'local_tool_returned' AND h.sequence < ?4
                   AND d.body_ref_sequence IS NULL AND d.body = ?5",
            )?
            .query_map(
                params![ns_id, tool_id, run.to_string(), acc_seq_i64, body],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?
            .collect::<Result<_, _>>()?
        }
        MessageLayout::LegacyV58OwnerSession | MessageLayout::LegacyV55Folded => c
            .prepare_cached(
                "SELECT d.id, d.sequence, h.fact_id
                 FROM agent_session_history h
                 JOIN agent_recall_messages d
                   ON d.owner = h.owner AND d.session = h.session AND d.sequence = h.sequence AND d.ordinal = 0
                 WHERE h.owner = ?1 AND h.session = ?2 AND h.tool_use_id = ?3
                   AND h.run = ?4 AND h.kind = 'local_tool_returned' AND h.sequence < ?5
                   AND d.body_ref_sequence IS NULL AND d.body = ?6",
            )?
            .query_map(
                params![
                    owner_json,
                    spec.session_id,
                    tool_id,
                    run.to_string(),
                    acc_seq_i64,
                    body
                ],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?
            .collect::<Result<_, _>>()?,
    };
    for (row_id, loc_seq_i64, fact_id) in rows {
        if !is_protected_from_pruning(c, &owner_json, row_id, &fact_id, None)? {
            clear_and_repoint(row_id, unsigned(loc_seq_i64)?, true)?;
        }
    }
    Ok(())
}

/// O(1) update of `agent_recall_external_segments` for a live incoming external delta.
#[expect(
    clippy::too_many_arguments,
    reason = "live delta tracking updates explicit segment metadata without payload scans"
)]
fn record_live_external_delta(
    c: &Connection,
    spec: &RunSpec,
    fact: &RecordedFact,
    sequence: u64,
    task: ExternalTaskId,
    message_id: &str,
    is_thinking: bool,
    text: &str,
    layout: MessageLayout,
) -> Result<bool, StoreError> {
    let owner_json = serde_json::to_string(&spec.owner)?;
    let run_str = fact.run.to_string();
    let task_str = task.to_string();
    let seq_i64 = number(sequence)?;
    let ts_i64 = fact.at.0;
    let bytes_i64 = i64::try_from(text.len())
        .map_err(|_| invalid("external delta chunk exceeds SQLite range"))?;

    match layout {
        MessageLayout::Current => {
            let ns_id = crate::namespace::ensure_id(c, &owner_json, &spec.session_id)?;
            let open_s0: Option<i64> = c
                .prepare_cached(
                    "SELECT s0_sequence
                     FROM agent_recall_external_segments
                     WHERE namespace_id = ?1 AND run = ?2
                       AND task = ?3 AND message_id = ?4 AND is_thinking = ?5
                       AND sealed = 0",
                )?
                .query_row(
                    params![ns_id, run_str, task_str, message_id, i64::from(is_thinking)],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(s0_seq) = open_s0 {
                c.prepare_cached(
                    "UPDATE agent_recall_external_segments
                     SET tail_start_sequence = COALESCE(tail_start_sequence, ?6),
                         tail_end_sequence = ?6,
                         tail_start_at = COALESCE(tail_start_at, ?7),
                         tail_end_at = ?7,
                         tail_end_fact = ?8,
                         tail_bytes = tail_bytes + ?9
                     WHERE namespace_id = ?1 AND run = ?2
                       AND task = ?3 AND message_id = ?4 AND is_thinking = ?5
                       AND s0_sequence = ?10",
                )?
                .execute(params![
                    ns_id,
                    run_str,
                    task_str,
                    message_id,
                    i64::from(is_thinking),
                    seq_i64,
                    ts_i64,
                    fact.id.to_string(),
                    bytes_i64,
                    s0_seq
                ])?;
                return Ok(true);
            }
        }
        MessageLayout::LegacyV58OwnerSession => {
            let open_s0: Option<i64> = c
                .prepare_cached(
                    "SELECT s0_sequence
                     FROM agent_recall_external_segments
                     WHERE owner = ?1 AND session = ?2 AND run = ?3
                       AND task = ?4 AND message_id = ?5 AND is_thinking = ?6
                       AND sealed = 0",
                )?
                .query_row(
                    params![
                        owner_json,
                        spec.session_id,
                        run_str,
                        task_str,
                        message_id,
                        i64::from(is_thinking)
                    ],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(s0_seq) = open_s0 {
                c.prepare_cached(
                    "UPDATE agent_recall_external_segments
                     SET tail_start_sequence = COALESCE(tail_start_sequence, ?7),
                         tail_end_sequence = ?7,
                         tail_start_at = COALESCE(tail_start_at, ?8),
                         tail_end_at = ?8,
                         tail_end_fact = ?9,
                         tail_bytes = tail_bytes + ?10
                     WHERE owner = ?1 AND session = ?2 AND run = ?3
                       AND task = ?4 AND message_id = ?5 AND is_thinking = ?6
                       AND s0_sequence = ?11",
                )?
                .execute(params![
                    owner_json,
                    spec.session_id,
                    run_str,
                    task_str,
                    message_id,
                    i64::from(is_thinking),
                    seq_i64,
                    ts_i64,
                    fact.id.to_string(),
                    bytes_i64,
                    s0_seq
                ])?;
                return Ok(true);
            }
        }
        MessageLayout::LegacyV55Folded => return Ok(false),
    }
    let admission_sequence =
        admission_sequence_for(c, &owner_json, &spec.session_id, sequence, layout)?;
    upsert_external_segment(
        c,
        &owner_json,
        &spec.session_id,
        fact.run,
        admission_sequence,
        &spec.turn_id,
        task,
        message_id,
        is_thinking,
        sequence,
        None,
        false,
        layout,
    )?;
    Ok(false)
}

/// Seal open live external delta segments matching `(run, filter_task, filter_message_id)`.
fn seal_live_external_segments(
    c: &Connection,
    spec: &RunSpec,
    run: RunId,
    filter_task: Option<ExternalTaskId>,
    filter_message_id: Option<&str>,
    layout: MessageLayout,
) -> Result<(), StoreError> {
    let owner_json = serde_json::to_string(&spec.owner)?;
    let run_str = run.to_string();
    let task_filter = filter_task.map(|t| t.to_string());
    let current_ns = match layout {
        MessageLayout::Current => {
            match crate::namespace::find_id(c, &owner_json, &spec.session_id)? {
                Some(id) => Some(id),
                None => return Ok(()),
            }
        }
        MessageLayout::LegacyV58OwnerSession => None,
        MessageLayout::LegacyV55Folded => return Ok(()),
    };
    type OpenRow = (
        String,
        String,
        bool,
        i64,
        Option<i64>,
        Option<i64>,
        i64,
        String,
    );
    let open_rows: Vec<OpenRow> = match current_ns {
        Some(ns_id) => c
            .prepare_cached(
                "SELECT task, message_id, is_thinking, s0_sequence,
                        tail_start_sequence, tail_end_sequence, tail_bytes, turn
                 FROM agent_recall_external_segments
                 WHERE namespace_id = ?1 AND run = ?2 AND sealed = 0
                   AND (?3 IS NULL OR task = ?3)
                   AND (?4 IS NULL OR message_id = ?4)
                 ORDER BY COALESCE(tail_end_sequence, s0_sequence)",
            )?
            .query_map(
                params![ns_id, run_str, task_filter, filter_message_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                    ))
                },
            )?
            .collect::<Result<_, _>>()?,
        None => c
            .prepare_cached(
                "SELECT task, message_id, is_thinking, s0_sequence,
                        tail_start_sequence, tail_end_sequence, tail_bytes, turn
                 FROM agent_recall_external_segments
                 WHERE owner = ?1 AND session = ?2 AND run = ?3 AND sealed = 0
                   AND (?4 IS NULL OR task = ?4)
                   AND (?5 IS NULL OR message_id = ?5)
                 ORDER BY COALESCE(tail_end_sequence, s0_sequence)",
            )?
            .query_map(
                params![
                    owner_json,
                    spec.session_id,
                    run_str,
                    task_filter,
                    filter_message_id
                ],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                    ))
                },
            )?
            .collect::<Result<_, _>>()?,
    };
    if open_rows.is_empty() {
        return Ok(());
    }

    for (task_str, mid, is_thinking, s0_seq, tail_start, tail_end, tail_bytes, turn_id) in open_rows
    {
        let (Some(start_seq), Some(end_seq)) = (tail_start, tail_end) else {
            match current_ns {
                Some(ns_id) => {
                    c.prepare_cached(
                        "DELETE FROM agent_recall_external_segments
                         WHERE namespace_id = ?1 AND run = ?2
                           AND task = ?3 AND message_id = ?4 AND is_thinking = ?5
                           AND s0_sequence = ?6",
                    )?
                    .execute(params![
                        ns_id,
                        run_str,
                        task_str,
                        mid,
                        i64::from(is_thinking),
                        s0_seq
                    ])?;
                }
                None => {
                    c.prepare_cached(
                        "DELETE FROM agent_recall_external_segments
                         WHERE owner = ?1 AND session = ?2 AND run = ?3
                           AND task = ?4 AND message_id = ?5 AND is_thinking = ?6
                           AND s0_sequence = ?7",
                    )?
                    .execute(params![
                        owner_json,
                        spec.session_id,
                        run_str,
                        task_str,
                        mid,
                        i64::from(is_thinking),
                        s0_seq
                    ])?;
                }
            }
            continue;
        };
        let target_task: ExternalTaskId = crate::sql::identity(task_str.clone())?;
        let mut body = String::with_capacity(usize::try_from(tail_bytes.max(0)).unwrap_or(0));
        let mut last_meta: Option<(u64, FactId, u64, ContentRef)> = None;
        let deltas: Vec<(i64, String, Vec<u8>)> = match current_ns {
            Some(ns_id) => c
                .prepare_cached(
                    "SELECT h.sequence, b.content_sha256, maka_content_bytes(b.payload, b.encoding)
                     FROM agent_session_history h
                     JOIN agent_facts f ON f.sequence = h.sequence
                     JOIN contents b ON b.id = f.body_content_id
                     WHERE h.namespace_id = ?1 AND h.run = ?2
                       AND h.kind = 'external_task_observed'
                       AND h.sequence BETWEEN ?3 AND ?4
                     ORDER BY h.sequence ASC",
                )?
                .query_map(params![ns_id, run_str, start_seq, end_seq], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })?
                .collect::<Result<_, _>>()?,
            None => c
                .prepare_cached(
                    "SELECT h.sequence, b.content_sha256, b.payload
                     FROM agent_session_history h
                     JOIN agent_facts f ON f.sequence = h.sequence
                     JOIN contents b ON b.id = f.body_content_id
                     WHERE h.owner = ?1 AND h.session = ?2 AND h.run = ?3
                       AND h.kind = 'external_task_observed'
                       AND h.sequence BETWEEN ?4 AND ?5
                     ORDER BY h.sequence ASC",
                )?
                .query_map(
                    params![owner_json, spec.session_id, run_str, start_seq, end_seq],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?
                .collect::<Result<_, _>>()?,
        };
        for (seq_i64, digest, bytes) in deltas {
            let seq = unsigned(seq_i64)?;
            let byte_len = u64::try_from(bytes.len())
                .map_err(|_| invalid("Recall fact payload exceeds u64"))?;
            let recorded: RecordedFact = serde_json::from_slice(&bytes)?;
            if let Fact::ExternalTaskObserved { task, output, .. } = recorded.fact
                && task == target_task
            {
                let matched = match output {
                    Output::OutputDelta { message_id, text }
                        if !is_thinking && message_id == mid =>
                    {
                        Some(text)
                    }
                    Output::ThinkingDelta { message_id, text }
                        if is_thinking && message_id == mid =>
                    {
                        Some(text)
                    }
                    _ => None,
                };
                if let Some(text) = matched {
                    body.push_str(&text);
                    last_meta = Some((
                        seq,
                        recorded.id,
                        unsigned(recorded.at.0)?,
                        ContentRef {
                            digest,
                            bytes: byte_len,
                        },
                    ));
                }
            }
        }
        let Some((last_seq, last_fact, last_ts, last_ref)) = last_meta else {
            return Err(invalid(
                "open external delta segment missing continuation facts",
            ));
        };
        let end = body.len();
        let message = Message {
            fact: last_fact,
            message_id: last_fact.to_string(),
            position: RowPosition {
                source_sequence: last_seq,
                item_index: 0,
            },
            run,
            turn_id,
            timestamp: last_ts,
            role: Role::Assistant,
            body,
            attachments: vec![],
            references: vec![last_ref],
            fields: vec![FieldSpan {
                field: if is_thinking {
                    Field::Thinking
                } else {
                    Field::Body
                },
                start: 0,
                end,
                internal: is_thinking,
            }],
            origin: None,
        };
        insert_raw(
            c,
            &spec.owner,
            &spec.session_id,
            message,
            layout,
            FtsMode::Immediate,
        )?;
        match current_ns {
            Some(ns_id) => {
                c.prepare_cached(
                    "UPDATE agent_recall_external_segments
                     SET sealed = 1
                     WHERE namespace_id = ?1 AND run = ?2
                       AND task = ?3 AND message_id = ?4 AND is_thinking = ?5
                       AND s0_sequence = ?6",
                )?
                .execute(params![
                    ns_id,
                    run_str,
                    task_str,
                    mid,
                    i64::from(is_thinking),
                    s0_seq
                ])?;
            }
            None => {
                c.prepare_cached(
                    "UPDATE agent_recall_external_segments
                     SET sealed = 1
                     WHERE owner = ?1 AND session = ?2 AND run = ?3
                       AND task = ?4 AND message_id = ?5 AND is_thinking = ?6
                       AND s0_sequence = ?7",
                )?
                .execute(params![
                    owner_json,
                    spec.session_id,
                    run_str,
                    task_str,
                    mid,
                    i64::from(is_thinking),
                    s0_seq
                ])?;
            }
        }
    }
    Ok(())
}

/// Resolve the target rowid for a single-hop `body_ref_sequence`.
pub(crate) fn resolve_body_ref_target_id(
    c: &Connection,
    ns_id: crate::namespace::NamespaceId,
    ref_sequence: i64,
) -> Result<i64, StoreError> {
    c.prepare_cached(
        "SELECT id FROM agent_recall_messages
         WHERE namespace_id = ?1 AND sequence = ?2 AND ordinal = 0",
    )?
    .query_row(params![ns_id, ref_sequence], |r| r.get(0))
    .optional()?
    .ok_or_else(|| invalid("body_ref target row missing; explicit rebuild required"))
}

/// Hydrate a superseded Recall row's exact original body using explicit `body_ref_*` metadata.
pub(crate) fn resolve_body_ref(
    c: &Connection,
    ns_id: crate::namespace::NamespaceId,
    source_sequence: u64,
    ref_sequence: i64,
    ref_start: Option<i64>,
    ref_end: Option<i64>,
) -> Result<String, StoreError> {
    let end =
        usize::try_from(ref_end.ok_or_else(|| invalid("corrupt body_ref missing end offset"))?)
            .map_err(|_| invalid("negative body_ref_end"))?;
    if let Some(start_i64) = ref_start {
        let start = usize::try_from(start_i64).map_err(|_| invalid("negative body_ref_start"))?;
        let len = end
            .checked_sub(start)
            .ok_or_else(|| invalid("corrupt body_ref span"))?;
        let start_1based =
            i64::try_from(start + 1).map_err(|_| invalid("body_ref_start exceeds SQLite range"))?;
        let len_i64 = i64::try_from(len).map_err(|_| invalid("body_ref length overflow"))?;
        let bytes: Vec<u8> = c
            .prepare_cached(
                "SELECT substr(CAST(body AS BLOB), ?3, ?4)
                 FROM agent_recall_messages
                 WHERE namespace_id = ?1 AND sequence = ?2 AND ordinal = 0",
            )?
            .query_row(params![ns_id, ref_sequence, start_1based, len_i64], |r| {
                r.get(0)
            })
            .optional()?
            .ok_or_else(|| invalid("body_ref target row missing; explicit rebuild required"))?;
        if bytes.len() != len {
            return Err(invalid(
                "body_ref slice length mismatch; explicit rebuild required",
            ));
        }
        return String::from_utf8(bytes)
            .map_err(|_| invalid("body_ref slice is not valid UTF-8; explicit rebuild required"));
    }
    let (run_str, fact_bytes): (String, Vec<u8>) = c
        .prepare_cached(
            "SELECT h.run, maka_content_bytes(b.payload, b.encoding)
             FROM agent_session_history h
             JOIN agent_facts f ON f.sequence = h.sequence
             JOIN contents b ON b.id = f.body_content_id
             WHERE h.namespace_id = ?1 AND h.sequence = ?2",
        )?
        .query_row(params![ns_id, number(source_sequence)?], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?
        .ok_or_else(|| invalid("body_ref source fact missing"))?;
    let recorded: RecordedFact = serde_json::from_slice(&fact_bytes)?;
    let Fact::Cell {
        event: CellEvent::Completed { cell, result, .. },
    } = recorded.fact
    else {
        return Err(invalid(
            "body_ref without slice start must belong to CellEvent::Completed",
        ));
    };
    let run: RunId = crate::sql::identity(run_str)?;
    let mut scratch = Message {
        fact: recorded.id,
        message_id: String::new(),
        position: RowPosition {
            source_sequence,
            item_index: 0,
        },
        run,
        turn_id: String::new(),
        timestamp: 0,
        role: Role::ToolResult,
        body: String::new(),
        attachments: vec![],
        references: vec![],
        fields: vec![],
        origin: None,
    };
    cell_final(
        c,
        run,
        cell,
        CellFinalEvidence::Completed { result },
        &mut scratch,
        true,
        MessageLayout::Current,
    )?;
    if scratch.body.len() != end {
        return Err(invalid(
            "reconstructed CellEvent::Completed length mismatch; explicit rebuild required",
        ));
    }
    Ok(scratch.body)
}

/// Given a sparse FTS5 candidate list, include any superseded row id within `<= max_sequence`
/// whose explicit `body_ref_sequence` target matched FTS5 at `sequence > max_sequence`.
pub(super) fn superseded_rows_for_targets(
    c: &Connection,
    ns_id: crate::namespace::NamespaceId,
    target_ids: &[i64],
    max_sequence: u64,
) -> Result<Vec<i64>, StoreError> {
    if target_ids.is_empty() {
        return Ok(Vec::new());
    }
    let encoded = serde_json::to_string(target_ids)?;
    let mut stmt = c.prepare_cached(
        "SELECT DISTINCT loc.id
         FROM json_each(?1) candidate
         CROSS JOIN agent_recall_messages target ON target.id = candidate.value
         JOIN agent_recall_messages loc
           ON loc.namespace_id = target.namespace_id
          AND loc.body_ref_sequence = target.sequence
         WHERE target.namespace_id = ?2 AND target.sequence > ?3
           AND loc.sequence <= ?3",
    )?;
    let rows = stmt
        .query_map(params![encoded, ns_id, number(max_sequence)?], |row| {
            row.get::<_, i64>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[derive(Clone)]
pub(crate) struct ExternalSegmentHeader {
    pub run: RunId,
    pub sequence: u64,
    pub admission_sequence: u64,
    pub turn_id: String,
    pub fact: FactId,
    /// Full segment end fact (S_last). Equals fact unless the cut straddles a sealed segment,
    /// in which case Memory hidden spans captured after sealing are still keyed on tail_end_fact.
    pub tail_end_fact: FactId,
    pub task: ExternalTaskId,
    pub message_id: String,
    pub is_thinking: bool,
    pub tail_start_sequence: u64,
    pub tail_start_at: u64,
    pub tail_end_at: u64,
    pub tail_bytes: u64,
}

pub(crate) struct UnsealedExternalDelta {
    pub sequence: u64,
    pub fact: FactId,
    pub run: RunId,
    pub turn_id: String,
    pub timestamp: u64,
    pub reference: ContentRef,
    pub is_thinking: bool,
    pub body: String,
}

pub(crate) struct SealedSegmentSpan {
    pub run: RunId,
    pub task: ExternalTaskId,
    pub message_id: String,
    pub is_thinking: bool,
    pub tail_start_sequence: u64,
    pub tail_end_sequence: u64,
}

#[expect(
    clippy::too_many_arguments,
    reason = "straddling segment lookup requires explicit namespace/run/segment bounds"
)]
fn resolve_straddling_tail_end(
    c: &Connection,
    ns_id: crate::namespace::NamespaceId,
    run_str: &str,
    target_task: ExternalTaskId,
    target_mid: &str,
    is_thinking: bool,
    tail_start_sequence: u64,
    through_sequence: u64,
) -> Result<Option<(u64, FactId, u64)>, StoreError> {
    let mut stmt = c.prepare_cached(
        "SELECT h.sequence, maka_content_bytes(b.payload, b.encoding)
         FROM agent_session_history h
         JOIN agent_facts f ON f.sequence = h.sequence
         JOIN contents b ON b.id = f.body_content_id
         WHERE h.namespace_id = ?1 AND h.run = ?2
           AND h.kind = 'external_task_observed'
           AND h.sequence BETWEEN ?3 AND ?4
         ORDER BY h.sequence DESC",
    )?;
    let mut rows = stmt.query(params![
        ns_id,
        run_str,
        number(tail_start_sequence)?,
        number(through_sequence)?
    ])?;
    while let Some(row) = rows.next()? {
        let seq = unsigned(row.get::<_, i64>(0)?)?;
        let bytes: Vec<u8> = row.get(1)?;
        let recorded: RecordedFact = serde_json::from_slice(&bytes)?;
        if let Fact::ExternalTaskObserved { task, output, .. } = recorded.fact
            && task == target_task
        {
            let matched = match output {
                Output::OutputDelta { message_id, .. }
                    if !is_thinking && message_id == target_mid =>
                {
                    true
                }
                Output::ThinkingDelta { message_id, .. }
                    if is_thinking && message_id == target_mid =>
                {
                    true
                }
                _ => false,
            };
            if matched {
                return Ok(Some((seq, recorded.id, unsigned(recorded.at.0)?)));
            }
        }
    }
    Ok(None)
}

/// Return metadata headers for every external delta tail visible at `through_sequence` that is
/// not yet sealed at `<= through_sequence` (either `sealed = 0` or `tail_end_sequence > cut`).
pub(crate) fn unsealed_external_segment_headers(
    c: &Connection,
    ns_id: crate::namespace::NamespaceId,
    through_sequence: u64,
    min_admission: u64,
) -> Result<Vec<ExternalSegmentHeader>, StoreError> {
    let through_i64 = number(through_sequence)?;
    let min_adm_i64 = number(min_admission)?;
    type RowTuple = (
        String,
        i64,
        String,
        String,
        String,
        bool,
        i64,
        i64,
        i64,
        i64,
        String,
        i64,
    );
    let rows: Vec<RowTuple> = c
        .prepare_cached(
            "SELECT run, admission_sequence, turn, task, message_id, is_thinking,
                    tail_start_sequence, tail_end_sequence, tail_start_at, tail_end_at,
                    tail_end_fact, tail_bytes
             FROM agent_recall_external_segments INDEXED BY agent_recall_external_segments_open
             WHERE namespace_id = ?1
               AND sealed = 0
               AND tail_start_sequence IS NOT NULL
               AND tail_start_sequence <= ?2
               AND admission_sequence > ?3
             UNION ALL
             SELECT run, admission_sequence, turn, task, message_id, is_thinking,
                    tail_start_sequence, tail_end_sequence, tail_start_at, tail_end_at,
                    tail_end_fact, tail_bytes
             FROM agent_recall_external_segments INDEXED BY agent_recall_external_segments_sealed_seq
             WHERE namespace_id = ?1
               AND sealed = 1
               AND tail_end_sequence IS NOT NULL
               AND tail_end_sequence > ?2
               AND tail_start_sequence IS NOT NULL
               AND tail_start_sequence <= ?2
               AND admission_sequence > ?3",
        )?
        .query_map(params![ns_id, through_i64, min_adm_i64], |r| {
            Ok((
                r.get(0)?,
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
            ))
        })?
        .collect::<Result<_, _>>()?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::with_capacity(rows.len());
    for (
        run_str,
        adm,
        turn_id,
        task_str,
        message_id,
        is_thinking,
        tail_start_seq,
        tail_end_seq,
        tail_start_at,
        tail_end_at,
        tail_end_fact,
        tail_bytes,
    ) in rows
    {
        let run: RunId = crate::sql::identity(run_str.clone())?;
        let task: ExternalTaskId = crate::sql::identity(task_str)?;
        let tail_start = unsigned(tail_start_seq)?;
        let tail_end = unsigned(tail_end_seq)?;
        let full_tail_end_fact: FactId = crate::sql::identity(tail_end_fact)?;
        let (eff_seq, eff_fact, eff_at) = if tail_end <= through_sequence {
            (tail_end, full_tail_end_fact, unsigned(tail_end_at)?)
        } else {
            let Some(resolved) = resolve_straddling_tail_end(
                c,
                ns_id,
                &run_str,
                task,
                &message_id,
                is_thinking,
                tail_start,
                through_sequence,
            )?
            else {
                continue;
            };
            resolved
        };
        out.push(ExternalSegmentHeader {
            run,
            sequence: eff_seq,
            admission_sequence: unsigned(adm)?,
            turn_id,
            fact: eff_fact,
            tail_end_fact: full_tail_end_fact,
            task,
            message_id,
            is_thinking,
            tail_start_sequence: tail_start,
            tail_start_at: unsigned(tail_start_at)?,
            tail_end_at: eff_at,
            tail_bytes: unsigned(tail_bytes)?,
        });
    }
    out.sort_by_key(|h| h.sequence);
    Ok(out)
}

/// Hydrate a single external delta segment bounded strictly to `[tail_start_sequence..=header.sequence]`.
pub(crate) fn hydrate_external_segment(
    c: &Connection,
    ns_id: crate::namespace::NamespaceId,
    header: &ExternalSegmentHeader,
    since: Option<u64>,
    until: Option<u64>,
    restrictions: &[(u64, u64)],
) -> Result<Option<UnsealedExternalDelta>, StoreError> {
    let run_str = header.run.to_string();
    let mut body = String::with_capacity(usize::try_from(header.tail_bytes).unwrap_or(0));
    let mut offset = 0u64;
    let mut kept_any = false;
    let mut last_ts = header.tail_end_at;
    let mut last_ref: Option<ContentRef> = None;

    let mut stmt = c.prepare_cached(
        "SELECT b.content_sha256, maka_content_bytes(b.payload, b.encoding)
         FROM agent_session_history h
         JOIN agent_facts f ON f.sequence = h.sequence
         JOIN contents b ON b.id = f.body_content_id
         WHERE h.namespace_id = ?1 AND h.run = ?2
           AND h.kind = 'external_task_observed'
           AND h.sequence BETWEEN ?3 AND ?4
         ORDER BY h.sequence ASC",
    )?;
    let mut rows = stmt.query(params![
        ns_id,
        run_str,
        number(header.tail_start_sequence)?,
        number(header.sequence)?
    ])?;
    while let Some(row) = rows.next()? {
        let digest: String = row.get(0)?;
        let bytes: Vec<u8> = row.get(1)?;
        let byte_len =
            u64::try_from(bytes.len()).map_err(|_| invalid("Recall fact payload exceeds u64"))?;
        let recorded: RecordedFact = serde_json::from_slice(&bytes)?;
        if let Fact::ExternalTaskObserved { task, output, .. } = recorded.fact
            && task == header.task
        {
            let matched = match output {
                Output::OutputDelta { message_id, text }
                    if !header.is_thinking && message_id == header.message_id =>
                {
                    Some(text)
                }
                Output::ThinkingDelta { message_id, text }
                    if header.is_thinking && message_id == header.message_id =>
                {
                    Some(text)
                }
                _ => None,
            };
            if let Some(mut text) = matched {
                let ts = unsigned(recorded.at.0)?;
                let chunk_len = text.len() as u64;
                if since.is_none_or(|s| ts >= s) && until.is_none_or(|u| ts <= u) {
                    if !restrictions.is_empty() {
                        crate::memory::recall::mask(&mut text, offset, restrictions);
                    }
                    body.push_str(&text);
                    kept_any = true;
                    last_ts = ts;
                    last_ref = Some(ContentRef {
                        digest,
                        bytes: byte_len,
                    });
                }
                offset = offset.saturating_add(chunk_len);
            }
        }
    }
    if !kept_any {
        return Ok(None);
    }
    let reference = last_ref.ok_or_else(|| invalid("missing external delta reference"))?;
    Ok(Some(UnsealedExternalDelta {
        sequence: header.sequence,
        fact: header.fact,
        run: header.run,
        turn_id: header.turn_id.clone(),
        timestamp: last_ts,
        reference,
        is_thinking: header.is_thinking,
        body,
    }))
}

/// Slice a sealed coalesced external delta row by per-delta timestamps when `since` or `until`
/// straddles `[tail_start_at, tail_end_at]`, preserving exact redaction span coordinates.
pub(crate) fn slice_sealed_external_segment(
    c: &Connection,
    ns_id: crate::namespace::NamespaceId,
    span: &SealedSegmentSpan,
    since: Option<u64>,
    until: Option<u64>,
    restrictions: &[(u64, u64)],
) -> Result<Option<(String, u64)>, StoreError> {
    let run_str = span.run.to_string();
    let mut body = String::new();
    let mut offset = 0u64;
    let mut last_kept_ts = None;

    let mut stmt = c.prepare_cached(
        "SELECT maka_content_bytes(b.payload, b.encoding)
         FROM agent_session_history h
         JOIN agent_facts f ON f.sequence = h.sequence
         JOIN contents b ON b.id = f.body_content_id
         WHERE h.namespace_id = ?1 AND h.run = ?2
           AND h.kind = 'external_task_observed'
           AND h.sequence BETWEEN ?3 AND ?4
         ORDER BY h.sequence ASC",
    )?;
    let mut rows = stmt.query(params![
        ns_id,
        run_str,
        number(span.tail_start_sequence)?,
        number(span.tail_end_sequence)?
    ])?;
    while let Some(row) = rows.next()? {
        let bytes: Vec<u8> = row.get(0)?;
        let recorded: RecordedFact = serde_json::from_slice(&bytes)?;
        if let Fact::ExternalTaskObserved { task, output, .. } = recorded.fact
            && task == span.task
        {
            let matched = match output {
                Output::OutputDelta { message_id, text }
                    if !span.is_thinking && message_id == span.message_id =>
                {
                    Some(text)
                }
                Output::ThinkingDelta { message_id, text }
                    if span.is_thinking && message_id == span.message_id =>
                {
                    Some(text)
                }
                _ => None,
            };
            if let Some(mut text) = matched {
                let ts = unsigned(recorded.at.0)?;
                let chunk_len = text.len() as u64;
                if since.is_none_or(|s| ts >= s) && until.is_none_or(|u| ts <= u) {
                    if !restrictions.is_empty() {
                        crate::memory::recall::mask(&mut text, offset, restrictions);
                    }
                    body.push_str(&text);
                    last_kept_ts = Some(ts);
                }
                offset = offset.saturating_add(chunk_len);
            }
        }
    }
    Ok(last_kept_ts.map(|ts| (body, ts)))
}

pub(super) fn populate_all_fts_terms(c: &Connection) -> Result<(), StoreError> {
    use rusqlite::functions::FunctionFlags;

    const FN_NAME: &str = "maka_v59_recall_grams";
    c.create_scalar_function(
        FN_NAME,
        1,
        FunctionFlags::SQLITE_UTF8
            | FunctionFlags::SQLITE_DETERMINISTIC
            | FunctionFlags::SQLITE_INNOCUOUS,
        |ctx| {
            let body = ctx.get_raw(0).as_str()?;
            let folded = fold(body);
            Ok(terms::grams(&folded))
        },
    )?;
    let insert_res = c.execute(
        "INSERT INTO agent_recall_terms(rowid, grams)
         SELECT id, maka_v59_recall_grams(body)
         FROM agent_recall_messages
         WHERE body != ''",
        [],
    );
    let remove_res = c.remove_function(FN_NAME, 1);
    insert_res?;
    remove_res?;
    Ok(())
}

fn insert(
    c: &Connection,
    spec: &RunSpec,
    message: Message,
    layout: MessageLayout,
    fts_mode: FtsMode,
) -> Result<i64, StoreError> {
    insert_raw(c, &spec.owner, &spec.session_id, message, layout, fts_mode)
}

fn insert_raw(
    c: &Connection,
    owner_val: &RunOwner,
    session_id: &str,
    mut message: Message,
    layout: MessageLayout,
    fts_mode: FtsMode,
) -> Result<i64, StoreError> {
    if message.fields.is_empty() {
        message.fields.push(FieldSpan {
            field: match message.role {
                Role::ToolResult => Field::Result,
                Role::Failure => Field::FailureMessage,
                _ => Field::Body,
            },
            start: 0,
            end: message.body.len(),
            internal: false,
        });
    }
    let owner = serde_json::to_string(owner_val)?;
    let seq = number(message.position.source_sequence)?;
    let ordinal = number(message.position.item_index)?;
    let current_ns = match layout {
        MessageLayout::Current => Some(crate::namespace::ensure_id(c, &owner, session_id)?),
        MessageLayout::LegacyV58OwnerSession | MessageLayout::LegacyV55Folded => None,
    };
    let folded = if fts_mode == FtsMode::Immediate || layout == MessageLayout::LegacyV55Folded {
        fold(&message.body)
    } else {
        String::new()
    };
    if fts_mode == FtsMode::Immediate {
        let previous: Option<i64> = match current_ns {
            Some(ns_id) => c
                .prepare_cached(
                    "SELECT id FROM agent_recall_messages WHERE namespace_id=? AND sequence=? AND ordinal=?",
                )?
                .query_row(params![ns_id, seq, ordinal], |r| r.get(0))
                .optional()?,
            None => c
                .prepare_cached(
                    "SELECT id FROM agent_recall_messages WHERE owner=? AND session=? AND sequence=? AND ordinal=?",
                )?
                .query_row(params![owner, session_id, seq, ordinal], |r| r.get(0))
                .optional()?,
        };
        if let Some(id) = previous {
            c.prepare_cached("DELETE FROM agent_recall_terms WHERE rowid=?")?
                .execute([id])?;
        }
    }
    let run = message.run.to_string();
    let timestamp = number(message.timestamp)?;
    let role = serde_json::to_string(&message.role)?;
    let attachments = serde_json::to_string(&message.attachments)?;
    let references = serde_json::to_string(&message.references)?;
    let fields = serde_json::to_string(&message.fields)?;
    let origin = message
        .origin
        .map(|o| serde_json::to_string(&o))
        .transpose()?;
    let internal = message.fields.iter().all(|f| f.internal);
    let id: i64 = match layout {
        MessageLayout::Current => c
            .prepare_cached(
                "INSERT INTO agent_recall_messages(namespace_id,sequence,ordinal,run,turn,message,at,role,body,attachments,references_json,fields_json,origin_json,internal)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(namespace_id,sequence,ordinal) DO UPDATE SET
                   message=excluded.message,body=excluded.body,attachments=excluded.attachments,
                   references_json=excluded.references_json,fields_json=excluded.fields_json,
                   origin_json=excluded.origin_json,internal=excluded.internal
                 RETURNING id",
            )?
            .query_row(
                params![
                    current_ns.expect("current layout namespace"),
                    seq,
                    ordinal,
                    run,
                    message.turn_id,
                    message.message_id,
                    timestamp,
                    role,
                    message.body,
                    attachments,
                    references,
                    fields,
                    origin,
                    internal,
                ],
                |r| r.get(0),
            )?,
        MessageLayout::LegacyV58OwnerSession => c
            .prepare_cached(
                "INSERT INTO agent_recall_messages(owner,session,sequence,ordinal,run,turn,message,at,role,body,attachments,references_json,fields_json,origin_json,internal)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(owner,session,sequence,ordinal) DO UPDATE SET
                   message=excluded.message,body=excluded.body,attachments=excluded.attachments,
                   references_json=excluded.references_json,fields_json=excluded.fields_json,
                   origin_json=excluded.origin_json,internal=excluded.internal
                 RETURNING id",
            )?
            .query_row(
                params![
                    owner,
                    session_id,
                    seq,
                    ordinal,
                    run,
                    message.turn_id,
                    message.message_id,
                    timestamp,
                    role,
                    message.body,
                    attachments,
                    references,
                    fields,
                    origin,
                    internal,
                ],
                |r| r.get(0),
            )?,
        MessageLayout::LegacyV55Folded => c
            .prepare_cached(
                "INSERT INTO agent_recall_messages(owner,session,sequence,ordinal,run,turn,message,at,role,body,folded,attachments,references_json,fields_json,origin_json,internal)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(owner,session,sequence,ordinal) DO UPDATE SET
                   message=excluded.message,body=excluded.body,folded=excluded.folded,
                   attachments=excluded.attachments,references_json=excluded.references_json,
                   fields_json=excluded.fields_json,origin_json=excluded.origin_json,
                   internal=excluded.internal
                 RETURNING id",
            )?
            .query_row(
                params![
                    owner,
                    session_id,
                    seq,
                    ordinal,
                    run,
                    message.turn_id,
                    message.message_id,
                    timestamp,
                    role,
                    message.body,
                    folded,
                    attachments,
                    references,
                    fields,
                    origin,
                    internal,
                ],
                |r| r.get(0),
            )?,
    };
    if fts_mode == FtsMode::Immediate && !folded.is_empty() {
        c.prepare_cached("INSERT INTO agent_recall_terms(rowid,grams) VALUES(?,?)")?
            .execute(params![id, terms::grams(&folded)])?;
    }
    Ok(id)
}

fn project(
    c: &Connection,
    spec: &RunSpec,
    fact: &RecordedFact,
    sequence: u64,
    preloaded_ref: Option<ContentRef>,
    layout: MessageLayout,
    mut state: Option<&mut RebuildState>,
) -> Result<(), StoreError> {
    if spec.schema_version != SCHEMA_VERSION
        || fact.schema_version != SCHEMA_VERSION
        || fact.at.0 < 0
    {
        return Err(invalid("unsupported Recall fact schema/time"));
    }
    let reference: ContentRef = match preloaded_ref {
        Some(r) => r,
        None => {
            let sql = if layout == MessageLayout::Current {
                "SELECT x.content_sha256,COALESCE(x.logical_bytes,length(x.payload)) FROM agent_facts f JOIN contents x ON x.id=f.body_content_id WHERE f.id=? AND f.run=?"
            } else {
                "SELECT x.content_sha256,length(x.payload) FROM agent_facts f JOIN contents x ON x.id=f.body_content_id WHERE f.id=? AND f.run=?"
            };
            c.query_row(
                sql,
                params![fact.id.to_string(), fact.run.to_string()],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
            )
            .map(|(digest, bytes)| {
                Ok::<_, StoreError>(ContentRef {
                    digest,
                    bytes: unsigned(bytes)?,
                })
            })??
        }
    };

    let mode = if layout == MessageLayout::LegacyV55Folded
        || state
            .as_deref()
            .is_some_and(|s| s.legacy_evidenced.contains(&fact.id.to_string()))
    {
        ProjectionMode::LegacyV57
    } else {
        ProjectionMode::CompactV58
    };

    if layout != MessageLayout::LegacyV55Folded {
        match &fact.fact {
            Fact::ExternalTaskObserved {
                task,
                output: Output::MessageEnd { message_id },
                ..
            } => {
                if let Some(rebuild_state) = state.as_deref_mut() {
                    rebuild_state.seal_message(
                        c,
                        &spec.owner,
                        &spec.session_id,
                        fact.run,
                        *task,
                        message_id,
                        layout,
                    )?;
                } else {
                    seal_live_external_segments(
                        c,
                        spec,
                        fact.run,
                        Some(*task),
                        Some(message_id),
                        layout,
                    )?;
                }
            }
            Fact::ExternalTaskObserved {
                task,
                output:
                    Output::OutputDelta { message_id, .. } | Output::ThinkingDelta { message_id, .. },
                ..
            } => {
                // If an individual delta fact was evidenced pre-v60 (legacy single-delta row),
                // flush any preceding open continuation so that legacy fact stays verbatim at its
                // own row. Active v60 evidence on S_last must remain coalesced (d_1..d_last).
                let is_thinking = matches!(
                    &fact.fact,
                    Fact::ExternalTaskObserved {
                        output: Output::ThinkingDelta { .. },
                        ..
                    }
                );
                if let Some(rebuild_state) = state.as_deref_mut()
                    && rebuild_state
                        .legacy_evidenced
                        .contains(&fact.id.to_string())
                {
                    let key = (fact.run, *task, message_id.clone(), is_thinking);
                    rebuild_state.seal_key(c, &spec.owner, &spec.session_id, &key, layout)?;
                }
            }
            Fact::ExternalTaskObserved { task, .. } | Fact::ExternalTaskClosed { task, .. } => {
                if let Some(rebuild_state) = state.as_deref_mut() {
                    rebuild_state.seal_task(
                        c,
                        &spec.owner,
                        &spec.session_id,
                        fact.run,
                        *task,
                        layout,
                    )?;
                } else {
                    seal_live_external_segments(c, spec, fact.run, Some(*task), None, layout)?;
                }
            }
            Fact::RunTerminated { .. } => {
                if let Some(rebuild_state) = state.as_deref_mut() {
                    rebuild_state.seal_run(c, &spec.owner, &spec.session_id, fact.run, layout)?;
                } else {
                    seal_live_external_segments(c, spec, fact.run, None, None, layout)?;
                }
            }
            _ => {}
        }
    }

    let rule = match mode {
        ProjectionMode::CompactV58 => document::rule(&fact.fact),
        ProjectionMode::LegacyV57 => document::rule_for_existing_position(&fact.fact),
    };
    let Some(rule) = rule else {
        return Ok(());
    };
    let fts_mode = state
        .as_deref()
        .map_or(FtsMode::Immediate, RebuildState::fts_mode);

    let mut message = Message {
        fact: fact.id,
        message_id: fact.id.to_string(),
        position: RowPosition {
            source_sequence: sequence,
            item_index: 0,
        },
        run: fact.run,
        turn_id: spec.turn_id.clone(),
        timestamp: unsigned(fact.at.0)?,
        role: Role::Assistant,
        body: String::new(),
        attachments: vec![],
        references: vec![reference.clone()],
        fields: vec![],
        origin: None,
    };

    match rule {
        Rule::Admission => {
            let input: RunInput =
                serde_json::from_slice(&exact(c, fact.run, &spec.input, layout)?)?;
            match input {
                RunInput::Message {
                    content,
                    source_messages,
                    ..
                } => {
                    if source_messages.is_empty() {
                        let message_id = match &spec.trigger {
                            Trigger::Message { message_id } => message_id.clone(),
                            _ => fact.id.to_string(),
                        };
                        insert(
                            c,
                            spec,
                            input_message(
                                spec,
                                fact,
                                sequence,
                                0,
                                message_id,
                                content,
                                spec.input.clone(),
                            ),
                            layout,
                            fts_mode,
                        )?;
                    } else {
                        for (ordinal, source) in source_messages.into_iter().enumerate() {
                            source.validate().map_err(invalid)?;
                            let mut indexed = input_message(
                                spec,
                                fact,
                                sequence,
                                u64::try_from(ordinal)
                                    .map_err(|_| invalid("Recall source ordinal overflow"))?,
                                source.message.message_id,
                                source.message.content,
                                spec.input.clone(),
                            );
                            indexed.origin = source.message.origin;
                            insert(c, spec, indexed, layout, fts_mode)?;
                        }
                    }
                }
                RunInput::Code { source } => {
                    let mut row = message;
                    row.role = Role::User;
                    row.body = source;
                    row.references.push(spec.input.clone());
                    insert(c, spec, row, layout, fts_mode)?;
                }
                RunInput::Continuation { .. }
                | RunInput::CheckpointHandoff { .. }
                | RunInput::ContextCompact { .. }
                | RunInput::HistorySource { .. } => {}
            }
            return Ok(());
        }
        Rule::QueueSources => return Ok(()),
        Rule::Model(part) => match part {
            ModelPart::Text {
                text_kind, text, ..
            } => {
                message.body = text.to_string();
                message.fields.push(FieldSpan {
                    field: if *text_kind == TextKind::Thinking {
                        Field::Thinking
                    } else {
                        Field::Body
                    },
                    start: 0,
                    end: message.body.len(),
                    internal: *text_kind == TextKind::Thinking,
                });
            }
            ModelPart::Source { source, .. } => {
                message.body = source.citation_text();
            }
            ModelPart::ToolCall { call } => {
                message.role = Role::ToolCall;
                field(&mut message, Field::ToolName, &call.name, false);
                let input = match &call.input {
                    ToolInput::Json(v) => serde_json::to_string(v)?,
                    ToolInput::InvalidJson { raw } => raw.clone(),
                };
                field(&mut message, Field::Arguments, &input, false);
            }
            ModelPart::ToolResult { output, .. } => {
                message.role = Role::ToolResult;
                message.body = serde_json::to_string(output)?
            }
        },
        Rule::ExternalPrepared { key, descriptor } => {
            message.role = Role::ToolCall;
            with_owned_bytes(c, fact.run, descriptor, layout, |bytes| {
                document::external_prepared(bytes, fact.run, key, &mut message)
            })?;
            message.references.push(descriptor.clone());
        }
        Rule::ExternalReturned(output) => {
            message.role = Role::ToolResult;
            let mut completed_cell = None;
            with_owned_bytes(c, fact.run, output, layout, |bytes| {
                completed_cell = document::external_returned(bytes, &mut message, &mut |r| {
                    exact(c, fact.run, r, layout)
                })?;
                Ok(())
            })?;
            message.references.push(output.clone());
            let body_copy = message.body.clone();
            insert(c, spec, message, layout, fts_mode)?;
            if mode == ProjectionMode::CompactV58
                && let Some((cell, cell_result_ref)) = completed_cell
            {
                supersede_completed_cell(
                    c,
                    spec,
                    fact.run,
                    cell,
                    &cell_result_ref.digest,
                    sequence,
                    &body_copy,
                    false,
                    state,
                    layout,
                )?;
            }
            return Ok(());
        }
        Rule::ExternalObserved(diagnostic) => {
            message.role = Role::ToolResult;
            field(
                &mut message,
                Field::Result,
                &maka_agent_facts::tool_output::ended_unknown_message(diagnostic),
                false,
            );
        }
        Rule::Returned { result, receipt } => {
            let returned = tool_return(c, fact.run, result, layout)?;
            let completed_cell = if receipt.is_none()
                && let ToolOutput::Cell(reply) = &returned.body.output
                && let maka_agent_facts::cells::CellReplyState::Completed { result: cell_res } =
                    &reply.state
            {
                Some((reply.cell, cell_res.digest.clone()))
            } else {
                None
            };
            message.role = Role::ToolResult;
            let outer_is_failure =
                matches!(returned.body.projection, DurableToolProjection::Failure);
            let text = projection(returned.body.projection);
            field(&mut message, Field::Result, &text, false);
            if let Some(reference) = receipt {
                field(
                    &mut message,
                    Field::Receipt,
                    &serde_json::to_string(reference)?,
                    false,
                );
            }
            message.references.push(result.clone());
            message
                .references
                .extend(returned.artifacts.into_iter().map(|a| a.payload));
            let body_copy = message.body.clone();
            let row_id = insert(c, spec, message, layout, fts_mode)?;
            if mode == ProjectionMode::CompactV58 {
                if let Some((cell, digest)) = completed_cell {
                    supersede_completed_cell(
                        c,
                        spec,
                        fact.run,
                        cell,
                        &digest,
                        sequence,
                        &body_copy,
                        outer_is_failure,
                        state.as_deref_mut(),
                        layout,
                    )?;
                }
                if let Some(rebuild_state) = state
                    && let Fact::LocalToolReturned { tool, .. } = &fact.fact
                {
                    let tool_id = maka_agent_facts::tool_call::tool_use_id(
                        fact.run,
                        &crate::fold::tool_key(tool),
                    );
                    rebuild_state.local_returns.insert(
                        (fact.run, tool_id),
                        (
                            row_id,
                            sequence,
                            fact.id.to_string(),
                            body_copy.len(),
                            body_digest(&body_copy),
                        ),
                    );
                }
            }
            return Ok(());
        }
        Rule::Accepted(result) => {
            message.role = Role::ToolResult;
            message.references.push(result.clone());
            let accepted: AcceptedToolResult =
                serde_json::from_slice(&exact(c, fact.run, result, layout)?)?;
            match accepted {
                AcceptedToolResult::RecoveredCell { cell, evidence } => {
                    let completed_digest = match &evidence {
                        CellFinalEvidence::Completed { result } => Some(result.digest.clone()),
                        CellFinalEvidence::Interrupted { .. } => None,
                    };
                    message.references.push(match &evidence {
                        CellFinalEvidence::Completed { result } => result.clone(),
                        CellFinalEvidence::Interrupted { report } => report.clone(),
                    });
                    cell_final(
                        c,
                        fact.run,
                        cell,
                        evidence,
                        &mut message,
                        mode == ProjectionMode::CompactV58,
                        layout,
                    )?;
                    let body_copy = message.body.clone();
                    insert(c, spec, message, layout, fts_mode)?;
                    if mode == ProjectionMode::CompactV58
                        && let Some(digest) = completed_digest
                    {
                        supersede_completed_cell(
                            c, spec, fact.run, cell, &digest, sequence, &body_copy, false, state,
                            layout,
                        )?;
                    }
                    return Ok(());
                }
                AcceptedToolResult::Local { result } => {
                    let returned = tool_return(c, fact.run, &result, layout)?;
                    returned
                        .body
                        .projection
                        .validate(&spec.session_id)
                        .map_err(invalid)?;
                    let outer_is_failure =
                        matches!(returned.body.projection, DurableToolProjection::Failure);
                    let completed_cell = if let ToolOutput::Cell(reply) = &returned.body.output
                        && let maka_agent_facts::cells::CellReplyState::Completed {
                            result: cell_res,
                        } = &reply.state
                    {
                        Some((reply.cell, cell_res.digest.clone()))
                    } else {
                        None
                    };
                    message.body = projection(returned.body.projection);
                    message.references.push(result);
                    message
                        .references
                        .extend(returned.artifacts.into_iter().map(|a| a.payload));
                    let body_copy = message.body.clone();
                    insert(c, spec, message, layout, fts_mode)?;
                    if mode == ProjectionMode::CompactV58 {
                        if let Some((cell, digest)) = completed_cell {
                            supersede_completed_cell(
                                c,
                                spec,
                                fact.run,
                                cell,
                                &digest,
                                sequence,
                                &body_copy,
                                outer_is_failure,
                                state.as_deref_mut(),
                                layout,
                            )?;
                        }
                        if let Fact::ToolResultAccepted { tool, .. } = &fact.fact {
                            clear_superseded_local_return(
                                c, spec, fact.run, tool, sequence, &body_copy, state, layout,
                            )?;
                        }
                    }
                    return Ok(());
                }
                AcceptedToolResult::ProviderOutcomeUnknown => {
                    message.body = "Provider tool outcome unknown".into()
                }
                AcceptedToolResult::Provider { output, .. } => {
                    message.body = serde_json::to_string(&output)?
                }
                AcceptedToolResult::Rejected { diagnostic }
                | AcceptedToolResult::OutcomeUnknown { diagnostic } => message.body = diagnostic,
                AcceptedToolResult::Host { result } => {
                    let returned = tool_return(c, fact.run, &result, layout)?;
                    let ToolOutput::Operation(reply) = returned.body.output else {
                        return Err(invalid(
                            "host tool result has no original operation receipt",
                        ));
                    };
                    returned
                        .body
                        .projection
                        .validate(&spec.session_id)
                        .map_err(invalid)?;
                    field(
                        &mut message,
                        Field::Result,
                        &serde_json::to_string(&reply)?,
                        false,
                    );
                    field(
                        &mut message,
                        Field::Result,
                        &projection(returned.body.projection),
                        false,
                    );
                    message.references.push(result);
                    message
                        .references
                        .extend(returned.artifacts.into_iter().map(|a| a.payload));
                }
                AcceptedToolResult::ObservedOperation { reply } => {
                    let reply = crate::operation::read_reply_with_encoding(
                        c,
                        fact.run,
                        &reply,
                        layout == MessageLayout::Current,
                    )?;
                    field(
                        &mut message,
                        Field::Result,
                        &serde_json::to_string(&reply)?,
                        false,
                    );
                }
                AcceptedToolResult::Operation { reply, result } => {
                    field(
                        &mut message,
                        Field::Result,
                        &serde_json::to_string(&reply)?,
                        false,
                    );
                    if let Some(result) = result {
                        let returned = tool_return(c, fact.run, &result, layout)?;
                        returned
                            .body
                            .projection
                            .validate(&spec.session_id)
                            .map_err(invalid)?;
                        field(
                            &mut message,
                            Field::Result,
                            &projection(returned.body.projection),
                            false,
                        );
                        message.references.push(result);
                        message
                            .references
                            .extend(returned.artifacts.into_iter().map(|a| a.payload));
                    }
                }
                AcceptedToolResult::RiskAdjudicated { .. } => {}
            }
        }
        Rule::External(output) => match output {
            Output::OutputDelta { message_id, text }
            | Output::ThinkingDelta { message_id, text } => {
                let thinking = matches!(output, Output::ThinkingDelta { .. });
                if mode == ProjectionMode::CompactV58
                    && let Fact::ExternalTaskObserved { task, .. } = &fact.fact
                {
                    if let Some(rebuild_state) = state {
                        if !rebuild_state
                            .legacy_evidenced
                            .contains(&fact.id.to_string())
                            && rebuild_state.push_continuation_if_open(
                                c,
                                spec,
                                fact,
                                sequence,
                                reference,
                                *task,
                                message_id.clone(),
                                thinking,
                                text,
                                layout,
                            )?
                        {
                            return Ok(());
                        }
                    } else if record_live_external_delta(
                        c, spec, fact, sequence, *task, message_id, thinking, text, layout,
                    )? {
                        return Ok(());
                    }
                }
                message.body = text.clone();
                message.fields.push(FieldSpan {
                    field: if thinking {
                        Field::Thinking
                    } else {
                        Field::Body
                    },
                    start: 0,
                    end: message.body.len(),
                    internal: thinking,
                });
            }
            Output::ToolStart { name, input, .. } => {
                message.role = Role::ToolCall;
                field(&mut message, Field::ToolName, name, false);
                field(
                    &mut message,
                    Field::Arguments,
                    &serde_json::to_string(input)?,
                    false,
                )
            }
            Output::ToolProgress { text, .. } | Output::ToolResult { text, .. } => {
                message.role = Role::ToolResult;
                message.body = text.clone()
            }
            _ => return Ok(()),
        },
        Rule::Cell(event) => {
            message.role = Role::ToolResult;
            message
                .references
                .extend(event.content_refs().into_iter().cloned());
            if mode == ProjectionMode::LegacyV57 {
                let receipt = if let CellEvent::ChildObserved {
                    cell,
                    operation,
                    reply,
                } = event
                    && maka_agent_facts::operation::result_reference(reply).is_some()
                {
                    let reply = crate::operation::read_reply_with_encoding(
                        c,
                        fact.run,
                        reply,
                        layout == MessageLayout::Current,
                    )?;
                    serde_json::to_string(&CellEvent::ChildObserved {
                        cell: *cell,
                        operation: *operation,
                        reply: maka_agent_facts::operation::inline_reply(reply),
                    })?
                } else {
                    serde_json::to_string(event)?
                };
                field(&mut message, Field::Receipt, &receipt, false);
            }
            match event {
                CellEvent::LocalChildReturned { result, .. }
                | CellEvent::ChildResultRecorded { result, .. } => {
                    let returned: ToolReturn<StoredCellReturn> =
                        serde_json::from_slice(&exact(c, fact.run, result, layout)?)?;
                    returned.validate().map_err(invalid)?;
                    let (compact_receipt, body) = match returned.body {
                        StoredCellReturn::Inline(body) => (
                            if matches!(event, CellEvent::LocalChildReturned { .. }) {
                                "local_child_returned".to_owned()
                            } else {
                                "child_result_recorded".to_owned()
                            },
                            body,
                        ),
                        StoredCellReturn::Operation(body) => {
                            let receipt = compact_operation_receipt(&body.operation.reference);
                            let reply = crate::operation::read_reply_with_encoding(
                                c,
                                fact.run,
                                &body.operation,
                                layout == MessageLayout::Current,
                            )?;
                            let body = body.resolve(reply).map_err(invalid)?;
                            (
                                receipt,
                                CellReturnedResult {
                                    output: body.output,
                                    projection: Some(body.projection),
                                    is_error: body.is_error,
                                },
                            )
                        }
                    };
                    if mode == ProjectionMode::CompactV58 {
                        // Keep Field::Receipt at field.key=0 so Field::Result stays at field.key=1
                        // for agent_memory_operation_field_source while preserving searchable
                        // contract/method names without UUID or SHA-256 trigram noise.
                        field(&mut message, Field::Receipt, &compact_receipt, false);
                    }
                    if let Some(value) = body.projection {
                        value.validate(&spec.session_id).map_err(invalid)?;
                        field(&mut message, Field::Result, &projection(value), false);
                    } else {
                        match body.output {
                            ToolOutput::Text(text) => {
                                field(&mut message, Field::Result, &text, false)
                            }
                            ToolOutput::Json(value) => field(
                                &mut message,
                                Field::Result,
                                &serde_json::to_string(&value)?,
                                false,
                            ),
                            _ => {}
                        }
                    }
                    message
                        .references
                        .extend(returned.artifacts.into_iter().map(|a| a.payload));
                }
                CellEvent::Started { source, .. } => {
                    let source = String::from_utf8(exact(c, fact.run, source, layout)?)
                        .map_err(|error| invalid(format!("Cell source is not UTF-8: {error}")))?;
                    field(&mut message, Field::Body, &source, false);
                }
                CellEvent::ChildPrepared { name, input, .. } => {
                    if mode == ProjectionMode::CompactV58 {
                        message.role = Role::ToolCall;
                        field(&mut message, Field::ToolName, name, false);
                    }
                    let input: Value = serde_json::from_slice(&exact(c, fact.run, input, layout)?)?;
                    field(&mut message, Field::Arguments, &json_text(&input), false);
                }
                CellEvent::ChildApprovalRecorded { input, .. } => {
                    if mode == ProjectionMode::CompactV58 {
                        field(
                            &mut message,
                            Field::Receipt,
                            "child_approval_recorded",
                            false,
                        );
                    }
                    let input: Value = serde_json::from_slice(&exact(c, fact.run, input, layout)?)?;
                    field(&mut message, Field::Arguments, &json_text(&input), false);
                }
                CellEvent::ChildDisplayRecorded { display, .. } => {
                    if mode == ProjectionMode::CompactV58
                        && let Some(title) = document::display_title(display)
                    {
                        field(&mut message, Field::Body, title, false);
                    }
                }
                CellEvent::Completed { cell, result, .. } => {
                    cell_final(
                        c,
                        fact.run,
                        *cell,
                        CellFinalEvidence::Completed {
                            result: result.clone(),
                        },
                        &mut message,
                        mode == ProjectionMode::CompactV58,
                        layout,
                    )?;
                    let body_len = message.body.len();
                    let row_id = insert(c, spec, message, layout, fts_mode)?;
                    if let Some(rebuild_state) = state {
                        rebuild_state.completed_cells.insert(
                            (fact.run, *cell, result.digest.clone()),
                            (row_id, fact.id.to_string(), body_len),
                        );
                    }
                    return Ok(());
                }
                CellEvent::Interrupted { cell, report } => {
                    cell_final(
                        c,
                        fact.run,
                        *cell,
                        CellFinalEvidence::Interrupted {
                            report: report.clone(),
                        },
                        &mut message,
                        mode == ProjectionMode::CompactV58,
                        layout,
                    )?;
                }
                CellEvent::SessionValuePublished { value, .. } => {
                    let value: Value = serde_json::from_slice(&exact(c, fact.run, value, layout)?)?;
                    field(&mut message, Field::Result, &json_text(&value), false);
                }
                CellEvent::NotificationQueued { content, .. } => {
                    let value: Value =
                        serde_json::from_slice(&exact(c, fact.run, content, layout)?)?;
                    field(&mut message, Field::Body, &json_text(&value), false);
                }
                CellEvent::ChildObserved { reply, .. } => {
                    if mode == ProjectionMode::CompactV58 {
                        // Ref-backed receipts store only compact contract/method names here so the
                        // row stays visible to live history and contract searches while the giant
                        // operation payload is indexed once by ChildResultRecorded.
                        let receipt =
                            if maka_agent_facts::operation::result_reference(reply).is_some() {
                                compact_operation_receipt(&reply.reference)
                            } else {
                                serde_json::to_string(event)?
                            };
                        field(&mut message, Field::Receipt, &receipt, false);
                    }
                }
                _ => {
                    // Any remaining compact CellEvent variant (e.g., ChildRejected) keeps its
                    // diagnostic JSON receipt.
                    if mode == ProjectionMode::CompactV58 {
                        let receipt = serde_json::to_string(event)?;
                        field(&mut message, Field::Receipt, &receipt, false);
                    }
                }
            }
        }
        Rule::Receipt(reply) => {
            message.role = Role::ToolResult;
            let reply = crate::operation::read_reply_with_encoding(
                c,
                fact.run,
                reply,
                layout == MessageLayout::Current,
            )?;
            field(
                &mut message,
                Field::Receipt,
                &serde_json::to_string(&reply)?,
                false,
            );
        }
        Rule::Failure(diagnostic) => {
            message.role = Role::Failure;
            message.body = diagnostic.to_owned()
        }
        Rule::Compaction(baseline) => {
            let compact: maka_agent_facts::context::CompactedContext =
                serde_json::from_slice(&exact(c, fact.run, baseline, layout)?)?;
            compact.validate().map_err(invalid)?;
            message.role = Role::Compaction;
            message.references.push(baseline.clone());
            message.references.push(compact.source_capture);
            if let maka_agent_facts::context::CheckpointContent::Text(text) =
                compact.checkpoint.summary
            {
                message.body = text;
            }
        }
    }
    insert(c, spec, message, layout, fts_mode)?;
    Ok(())
}

fn head(
    c: &Connection,
    spec: &RunSpec,
    sequence: u64,
    layout: MessageLayout,
) -> Result<(), StoreError> {
    let owner = serde_json::to_string(&spec.owner)?;
    let digest: String = match layout {
        MessageLayout::Current => {
            let ns_id = crate::namespace::find_id(c, &owner, &spec.session_id)?
                .ok_or(StoreError::EventConflict)?;
            c.query_row(
                "SELECT prefix_digest FROM agent_session_history WHERE namespace_id=? AND sequence=?",
                params![ns_id, number(sequence)?],
                |r| r.get(0),
            )?
        }
        MessageLayout::LegacyV58OwnerSession | MessageLayout::LegacyV55Folded => c.query_row(
            "SELECT prefix_digest FROM agent_session_history WHERE owner=? AND session=? AND sequence=?",
            params![owner, spec.session_id, number(sequence)?],
            |r| r.get(0),
        )?,
    };
    c.execute(
        "INSERT INTO agent_recall_heads(owner,session,sequence,digest) VALUES(?,?,?,?)
         ON CONFLICT(owner,session) DO UPDATE SET sequence=excluded.sequence,digest=excluded.digest
         WHERE excluded.sequence>=agent_recall_heads.sequence",
        params![owner, spec.session_id, number(sequence)?, digest],
    )?;
    Ok(())
}

pub(crate) fn index_fact(
    c: &Connection,
    spec: &RunSpec,
    fact: &RecordedFact,
    sequence: u64,
) -> Result<(), StoreError> {
    index_fact_with_state(c, spec, fact, sequence, None, MessageLayout::Current, None)
}

#[cfg(test)]
pub(crate) fn index_fact_v55(
    c: &Connection,
    spec: &RunSpec,
    fact: &RecordedFact,
    sequence: u64,
) -> Result<(), StoreError> {
    index_fact_with_state(
        c,
        spec,
        fact,
        sequence,
        None,
        MessageLayout::LegacyV55Folded,
        None,
    )
}

pub(super) fn index_fact_with_state(
    c: &Connection,
    spec: &RunSpec,
    fact: &RecordedFact,
    sequence: u64,
    preloaded_ref: Option<ContentRef>,
    layout: MessageLayout,
    state: Option<&mut RebuildState>,
) -> Result<(), StoreError> {
    match project(c, spec, fact, sequence, preloaded_ref, layout, state) {
        Ok(()) => {}
        Err(error)
            if matches!(
                error,
                StoreError::Json(_) | StoreError::InvalidTransition(_)
            ) =>
        {
            c.execute(
                "INSERT INTO agent_recall_gaps(owner,session,sequence,reason) VALUES(?,?,?,?)
                 ON CONFLICT(owner,session,sequence) DO UPDATE SET reason=excluded.reason",
                params![
                    serde_json::to_string(&spec.owner)?,
                    spec.session_id,
                    number(sequence)?,
                    error.to_string()
                ],
            )?;
        }
        Err(e) => return Err(e),
    }
    head(c, spec, sequence, layout)
}

pub(crate) fn index_sources(
    c: &Connection,
    spec: &RunSpec,
    sequence: u64,
) -> Result<(), StoreError> {
    index_sources_with_layout(
        c,
        spec,
        sequence,
        MessageLayout::Current,
        FtsMode::Immediate,
    )
}

pub(super) fn index_sources_with_layout(
    c: &Connection,
    spec: &RunSpec,
    sequence: u64,
    layout: MessageLayout,
    fts_mode: FtsMode,
) -> Result<(), StoreError> {
    let owner = serde_json::to_string(&spec.owner)?;
    let kind: String = match layout {
        MessageLayout::Current => {
            let ns_id = crate::namespace::find_id(c, &owner, &spec.session_id)?
                .ok_or(StoreError::EventConflict)?;
            c.query_row(
                "SELECT kind FROM agent_session_history WHERE namespace_id=? AND sequence=?",
                params![ns_id, number(sequence)?],
                |r| r.get(0),
            )?
        }
        MessageLayout::LegacyV58OwnerSession | MessageLayout::LegacyV55Folded => c.query_row(
            "SELECT kind FROM agent_session_history WHERE owner=? AND session=? AND sequence=?",
            params![owner, spec.session_id, number(sequence)?],
            |r| r.get(0),
        )?,
    };
    if !matches!(
        kind.as_str(),
        "run_admitted" | "step_prepared" | "external_task_prepared"
    ) {
        return Ok(());
    }
    let bytes: Vec<u8> = c.query_row(
        if layout == MessageLayout::Current {
            "SELECT maka_content_bytes(x.payload, x.encoding) FROM agent_facts f JOIN contents x ON x.id=f.body_content_id WHERE f.sequence=?"
        } else {
            "SELECT x.payload FROM agent_facts f JOIN contents x ON x.id=f.body_content_id WHERE f.sequence=?"
        },
        [number(sequence)?],
        |r| r.get(0),
    )?;
    let fact: RecordedFact = serde_json::from_slice(&bytes)?;
    // On legacy pre-v60 schemas (migrations 55/60, strictly pre-v62), resolve consumed queue
    // sources directly from agent_queue_events / agent_history_queue_requests / agent_queue_content_pins
    // with the exact same strict validation enforced by session_history::sql::sources.
    if layout != MessageLayout::Current {
        let consumed: Option<(i64, Vec<u8>, String)> = c
            .prepare_cached(
                "SELECT e.revision, b.payload, b.content_sha256
                 FROM agent_queue_events e
                 JOIN contents b ON b.id = e.body_content_id
                 WHERE e.session = ? AND e.id = ?",
            )?
            .query_row(params![spec.session_id, fact.id.to_string()], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .optional()?;
        if let Some((consumed_revision, ev_bytes, ev_digest)) = consumed {
            crate::session_history::check_bytes(&ev_bytes, &ev_digest)?;
            let event: crate::queue::Event = serde_json::from_slice(&ev_bytes)?;
            let crate::queue::Event::Consumed {
                cut,
                run: consumed_run,
                target,
            } = event
            else {
                return Err(invalid(
                    "source fact references a non-consumption queue event",
                ));
            };
            if consumed_run != fact.run || cut.session != spec.session_id {
                return Err(invalid("queue source consumption changed ownership"));
            }
            for (position, id) in cut.requests.iter().enumerate() {
                let row: Option<(Vec<u8>, String)> = c
                    .prepare_cached(
                        "SELECT b.payload, b.content_sha256
                         FROM agent_history_queue_requests q
                         JOIN agent_queue_events e ON e.session = q.session AND e.revision = q.revision
                         JOIN contents b ON b.id = e.body_content_id
                         WHERE q.session = ? AND q.request = ? AND q.revision < ?
                         ORDER BY q.revision DESC LIMIT 1",
                    )?
                    .query_row(params![spec.session_id, id.0, consumed_revision], |r| {
                        Ok((r.get(0)?, r.get(1)?))
                    })
                    .optional()?;
                let (cmd_bytes, cmd_digest) = row.ok_or_else(|| {
                    invalid("consumed queue snapshot index missing; explicit rebuild required")
                })?;
                crate::session_history::check_bytes(&cmd_bytes, &cmd_digest)?;
                let crate::queue::Event::Command {
                    edit:
                        crate::queue::QueueEdit::Enqueue {
                            request: frozen, ..
                        }
                        | crate::queue::QueueEdit::Update { request: frozen },
                    ..
                } = serde_json::from_slice(&cmd_bytes)?
                else {
                    return Err(invalid(
                        "history queue index does not address an immutable request snapshot",
                    ));
                };
                if frozen.id != *id
                    || frozen.spec.owner != spec.owner
                    || frozen.spec.session_id != spec.session_id
                {
                    return Err(invalid("consumed source belongs to another namespace"));
                }
                match &target {
                    crate::queue::DeliveryTarget::Run => {
                        if !frozen.matches_run_input(spec.clone()) {
                            return Err(invalid(
                                "original Run input differs from consumed request",
                            ));
                        }
                    }
                    crate::queue::DeliveryTarget::Step { step } => {
                        // Deserialize only `steering` so pre-#7115 RequestSpec payloads (whose
                        // `composition` used `systemPrompt`/`tools` instead of `surface`) still
                        // pass strict steering-order validation during cold migrations.
                        #[derive(serde::Deserialize)]
                        struct RequestSteeringOnly {
                            #[serde(default)]
                            steering: Vec<ContentRef>,
                        }
                        let req_bytes: Vec<u8> = c
                            .prepare_cached(
                                "SELECT b.payload
                                 FROM agent_request_specs r
                                 JOIN contents b ON b.id = r.content_id
                                 WHERE r.step = ?1 AND r.run = ?2",
                            )?
                            .query_row(params![step.to_string(), fact.run.to_string()], |r| {
                                r.get(0)
                            })?;
                        let request_spec: RequestSteeringOnly = serde_json::from_slice(&req_bytes)?;
                        if request_spec.steering.get(position) != Some(&frozen.source) {
                            return Err(invalid(
                                "Step steering differs from original consumed source order",
                            ));
                        }
                    }
                    crate::queue::DeliveryTarget::External {
                        task,
                        steering,
                        descriptor,
                    } => {
                        let key = maka_agent_facts::external_steering::ExternalSteeringKey {
                            task: *task,
                            steering: *steering,
                        };
                        let original = crate::external_steering::read_spec_legacy(
                            c, fact.run, &key, descriptor,
                        )?;
                        if original.consume != cut || original.sources.len() != cut.requests.len() {
                            return Err(invalid(
                                "External steering differs from original queue prefix",
                            ));
                        }
                        let source = original
                            .sources
                            .get(position)
                            .ok_or_else(|| invalid("External steering original source missing"))?;
                        if source.request != *id
                            || source.source != frozen.source
                            || source.resources != frozen.resources
                        {
                            return Err(invalid(
                                "External steering source/resources differ from original order",
                            ));
                        }
                    }
                }
                let reference = frozen.source;
                reference.validate().map_err(invalid)?;
                let payload: Option<Vec<u8>> = c
                    .prepare_cached(
                        "SELECT b.payload
                         FROM agent_queue_content_pins p
                         JOIN contents b ON b.id = p.content_id
                         WHERE p.session = ?1 AND p.request = ?2
                           AND b.content_sha256 = ?3 AND length(b.payload) = ?4",
                    )?
                    .query_row(
                        params![
                            spec.session_id,
                            frozen.id.0,
                            reference.digest,
                            number(reference.bytes)?
                        ],
                        |r| r.get(0),
                    )
                    .optional()?;
                let payload = payload.ok_or_else(|| {
                    invalid("content is not retained by this original queue source")
                })?;
                crate::session_history::check_bytes(&payload, &reference.digest)?;
                let message: maka_agent_facts::message::RootSourceMessage =
                    serde_json::from_slice(&payload)?;
                message.validate().map_err(invalid)?;
                let mut indexed = input_message(
                    spec,
                    &fact,
                    sequence,
                    position as u64,
                    message.message.message_id,
                    message.message.content,
                    reference,
                );
                indexed.origin = message.message.origin;
                insert(c, spec, indexed, layout, fts_mode)?;
            }
        }
        return head(c, spec, sequence, layout);
    }
    let cut = crate::session_history::capture_at(c, &spec.owner, &spec.session_id, Some(sequence))?;
    let mut after = None;
    loop {
        let page = crate::session_history::sources_at(
            c,
            &spec.owner,
            &spec.session_id,
            &cut,
            sequence,
            after,
            128,
        )?;
        for source in page.sources {
            let reference = source.request.source.clone();
            let bytes = crate::session_history::source_content_at(
                c,
                &spec.owner,
                &spec.session_id,
                &cut,
                sequence,
                source.position,
                &reference,
            )?;
            let message: maka_agent_facts::message::RootSourceMessage =
                serde_json::from_slice(&bytes)?;
            message.validate().map_err(invalid)?;
            let mut indexed = input_message(
                spec,
                &fact,
                sequence,
                source.position,
                message.message.message_id,
                message.message.content,
                reference,
            );
            indexed.origin = message.message.origin;
            insert(c, spec, indexed, layout, fts_mode)?;
        }
        if let Some(next) = page.next {
            after = Some(next);
        } else {
            break;
        }
    }
    head(c, spec, sequence, layout)
}

pub(super) fn rebuild(
    c: &Connection,
    store: &RecallStore,
    session: &str,
) -> Result<(), StoreError> {
    store.session(session)?;
    let owner = store.key()?;
    let legacy = load_legacy_evidenced(c)?;
    let active = load_active_evidenced(c)?;
    let mut state = RebuildState::new(legacy, active);
    rebuild_session(
        c,
        &store.owner,
        &owner,
        session,
        MessageLayout::Current,
        Some(&mut state),
    )
}

pub(crate) fn migrate_external_effect_observations(c: &Connection) -> Result<(), StoreError> {
    let sessions_sql = "SELECT DISTINCT r.owner, r.session
         FROM (SELECT DISTINCT run FROM agent_external_effects) e
         JOIN agent_run_specs r ON r.run = e.run
         WHERE EXISTS (
           SELECT 1
           FROM agent_session_history h
           JOIN agent_facts f ON f.sequence = h.sequence
           JOIN contents b ON b.id = f.body_content_id
           WHERE h.owner = r.owner
             AND h.session = r.session
             AND h.run = e.run
             AND h.kind = 'external_effect'
             AND h.tool_start = 0
             AND h.result_source = 0
             AND CAST(b.payload AS TEXT)->>'$.fact.event.kind' = 'observed'
             AND CAST(b.payload AS TEXT)->>'$.fact.event.observation.receipt.outcome.kind' = 'unknown'
             AND CAST(b.payload AS TEXT)->>'$.fact.event.observation.receipt.cleanup.kind' = 'confirmed'
         )";
    let sessions: Vec<(String, String)> = c
        .prepare_cached(sessions_sql)?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;
    for (owner_json, session) in sessions {
        let owner: RunOwner = serde_json::from_str(&owner_json)?;
        rebuild_session(
            c,
            &owner,
            &owner_json,
            &session,
            MessageLayout::LegacyV55Folded,
            None,
        )?;
    }
    Ok(())
}

pub(super) fn rebuild_session(
    c: &Connection,
    expected_owner: &RunOwner,
    owner: &str,
    session: &str,
    layout: MessageLayout,
    mut state: Option<&mut RebuildState>,
) -> Result<(), StoreError> {
    match layout {
        MessageLayout::Current => {
            if let Some(ns_id) = crate::namespace::find_id(c, owner, session)? {
                c.execute(
                    "DELETE FROM agent_recall_terms WHERE rowid IN(SELECT id FROM agent_recall_messages WHERE namespace_id=?)",
                    [ns_id],
                )?;
                c.execute(
                    "DELETE FROM agent_recall_messages WHERE namespace_id=?",
                    [ns_id],
                )?;
            }
        }
        MessageLayout::LegacyV58OwnerSession | MessageLayout::LegacyV55Folded => {
            c.execute(
                "DELETE FROM agent_recall_terms WHERE rowid IN(SELECT id FROM agent_recall_messages WHERE owner=? AND session=?)",
                params![owner, session],
            )?;
            c.execute(
                "DELETE FROM agent_recall_messages WHERE owner=? AND session=?",
                params![owner, session],
            )?;
        }
    }
    for table in ["agent_recall_heads", "agent_recall_gaps"] {
        c.execute(
            &format!("DELETE FROM {table} WHERE owner=? AND session=?"),
            params![owner, session],
        )?;
    }
    match layout {
        MessageLayout::Current => {
            if let Some(ns_id) = crate::namespace::find_id(c, owner, session)? {
                c.execute(
                    "DELETE FROM agent_recall_external_segments WHERE namespace_id=?",
                    [ns_id],
                )?;
            }
        }
        MessageLayout::LegacyV58OwnerSession => {
            c.execute(
                "DELETE FROM agent_recall_external_segments WHERE owner=? AND session=?",
                params![owner, session],
            )?;
        }
        MessageLayout::LegacyV55Folded => {}
    }
    if let Some(s) = state.as_deref_mut() {
        s.reset_session();
    }
    rebuild_session_rows(c, expected_owner, owner, session, layout, state)
}

/// Populate Recall rows for a single session whose prior Recall rows have already been cleared.
pub(super) fn rebuild_session_rows(
    c: &Connection,
    expected_owner: &RunOwner,
    owner: &str,
    session: &str,
    layout: MessageLayout,
    mut state: Option<&mut RebuildState>,
) -> Result<(), StoreError> {
    let current_ns = match layout {
        MessageLayout::Current => crate::namespace::find_id(c, owner, session)?,
        MessageLayout::LegacyV58OwnerSession | MessageLayout::LegacyV55Folded => None,
    };
    if layout == MessageLayout::Current && current_ns.is_none() {
        return Ok(());
    }
    let mut after = 0i64;
    let mut cached_spec: Option<(i64, RunSpec)> = None;
    loop {
        let headers: Vec<(i64, i64, String, Vec<u8>)> = match current_ns {
            Some(ns_id) => c
                .prepare_cached(
                    "SELECT h.sequence, r.spec_content_id, b.content_sha256, maka_content_bytes(b.payload, b.encoding)
                     FROM agent_session_history h
                     JOIN agent_facts f ON f.sequence = h.sequence
                     JOIN agent_run_specs r ON r.run = h.run
                     JOIN contents b ON b.id = f.body_content_id
                     WHERE h.namespace_id = ? AND h.sequence > ?
                     ORDER BY h.sequence
                     LIMIT 256",
                )?
                .query_map(params![ns_id, after], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })?
                .collect::<Result<_, _>>()?,
            None => c
                .prepare_cached(
                    "SELECT h.sequence, r.spec_content_id, b.content_sha256, b.payload
                     FROM agent_session_history h
                     JOIN agent_facts f ON f.sequence = h.sequence
                     JOIN agent_run_specs r ON r.run = h.run
                     JOIN contents b ON b.id = f.body_content_id
                     WHERE h.owner = ? AND h.session = ? AND h.sequence > ?
                     ORDER BY h.sequence
                     LIMIT 256",
                )?
                .query_map(params![owner, session, after], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })?
                .collect::<Result<_, _>>()?,
        };
        if headers.is_empty() {
            break;
        }
        for (sequence, spec_id, digest, bytes) in headers {
            if cached_spec.as_ref().is_none_or(|(id, _)| *id != spec_id) {
                let spec_bytes: Vec<u8> = c.query_row(
                    if layout == MessageLayout::Current {
                        "SELECT maka_content_bytes(payload, encoding) FROM contents WHERE id=?"
                    } else {
                        "SELECT payload FROM contents WHERE id=?"
                    },
                    [spec_id],
                    |r| r.get(0),
                )?;
                let spec: RunSpec = serde_json::from_slice(&spec_bytes)?;
                if &spec.owner != expected_owner || spec.session_id != session {
                    return Err(StoreError::EventConflict);
                }
                cached_spec = Some((spec_id, spec));
            }
            let spec = &cached_spec.as_ref().expect("loaded canonical RunSpec").1;
            let body_ref = ContentRef {
                digest,
                bytes: u64::try_from(bytes.len())
                    .map_err(|_| invalid("Recall fact payload exceeds u64"))?,
            };
            let fact: RecordedFact = serde_json::from_slice(&bytes)?;
            let seq_u64 = unsigned(sequence)?;
            let has_sources = matches!(
                fact.fact,
                Fact::RunAdmitted { .. }
                    | Fact::StepPrepared { .. }
                    | Fact::ExternalTaskPrepared { .. }
            );
            index_fact_with_state(
                c,
                spec,
                &fact,
                seq_u64,
                Some(body_ref),
                layout,
                state.as_deref_mut(),
            )?;
            if has_sources {
                let fts_mode = state
                    .as_deref()
                    .map_or(FtsMode::Immediate, RebuildState::fts_mode);
                index_sources_with_layout(c, spec, seq_u64, layout, fts_mode)?;
            }
            after = sequence;
        }
    }
    if let Some(rebuild_state) = state {
        rebuild_state.flush_open_deltas(c, expected_owner, session, layout)?;
    }
    Ok(())
}
