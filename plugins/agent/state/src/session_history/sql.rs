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
use crate::{
    queue::{DeliveryTarget, Event, QueueEdit},
    store::invalid,
};
use maka_agent_facts::artifact::content_digest;
use rusqlite::{OptionalExtension, params};
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom};

pub(super) fn bind_u64(value: u64) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|_| invalid("SQLite integer exceeds signed 64-bit range"))
}
pub(super) fn read_u64(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(column)?;
    u64::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Integer,
            Box::new(error),
        )
    })
}

fn encode<T: Serialize>(value: &T) -> Result<String, StoreError> {
    Ok(serde_json::to_string(value)?)
}
pub(super) fn identity<T: DeserializeOwned>(value: String) -> Result<T, StoreError> {
    Ok(serde_json::from_value(serde_json::Value::String(value))?)
}
pub(super) fn limit(value: u32) -> Result<u32, StoreError> {
    if !(1..=256).contains(&value) {
        return Err(invalid("history page size must be 1..=256"));
    }
    Ok(value)
}
fn scope_key(history: &HistoryNamespace) -> Result<String, StoreError> {
    maka_agent_facts::interaction::entity_id(&history.session).map_err(invalid)?;
    if history.owner.deployment.is_nil() {
        return Err(invalid("nil history deployment"));
    }
    encode(&history.owner)
}
pub(super) fn seed(owner: &RunOwner, session: &str) -> Result<String, StoreError> {
    Ok(content_digest(&serde_json::to_vec(&(
        "maka.session-history.v1",
        owner,
        session,
    ))?))
}
pub(super) fn chain(previous: &str, sequence: u64, digest: &str) -> Result<String, StoreError> {
    Ok(content_digest(&serde_json::to_vec(&(
        "maka.session-history.fact.v1",
        previous,
        sequence,
        digest,
    ))?))
}

fn spec(
    c: &Connection,
    history: &HistoryNamespace,
    run: RunId,
) -> Result<(RunSpec, ContentRef), StoreError> {
    let row:Option<(u32,String,Vec<u8>)>=c.query_row("SELECT s.schema_version,b.content_sha256,b.payload FROM agent_run_specs s JOIN contents b ON b.id=s.spec_content_id WHERE s.owner=? AND s.session=? AND s.run=?",params![scope_key(history)?,history.session,run.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let (version, digest, bytes) =
        row.ok_or_else(|| invalid("Run is not owned by this session namespace"))?;
    let value: RunSpec = serde_json::from_slice(&bytes)?;
    if version != SCHEMA_VERSION || value.schema_version != SCHEMA_VERSION {
        return Err(invalid("unsupported history Run schema"));
    }
    if value.owner != history.owner
        || value.session_id != history.session
        || content_digest(&bytes) != digest
    {
        return Err(invalid("history Run source corrupt"));
    }
    Ok((
        value,
        ContentRef {
            digest,
            bytes: u64::try_from(bytes.len()).map_err(|_| invalid("content length overflow"))?,
        },
    ))
}
pub(super) fn historical_backend(spec: &RunSpec) -> Result<bool, StoreError> {
    if spec.schema_version != SCHEMA_VERSION {
        return Err(invalid("unsupported history Run schema"));
    }
    Ok(matches!(spec.backend, BackendSpec::Historical {}))
}
fn admission_sequence(c: &Connection, run: RunId) -> Result<u64, StoreError> {
    c.query_row(
        "SELECT sequence FROM agent_facts WHERE run=? AND revision=1",
        [run.to_string()],
        |r| read_u64(r, 0),
    )
    .optional()?
    .ok_or_else(|| invalid("Run admission fact missing"))
}
pub(super) fn decode_record(version: u32, bytes: &[u8]) -> Result<RecordedFact, StoreError> {
    let fact: RecordedFact = serde_json::from_slice(bytes)?;
    if version != SCHEMA_VERSION || fact.schema_version != SCHEMA_VERSION {
        return Err(invalid("unsupported history fact schema"));
    }
    Ok(fact)
}
pub(super) fn run_source(
    c: &Connection,
    history: &HistoryNamespace,
    run: RunId,
) -> Result<RunSource, StoreError> {
    let (spec, spec_ref) = spec(c, history, run)?;
    let (sequence,version,bytes,digest,id):(u64,u32,Vec<u8>,String,String)=c.query_row("SELECT f.sequence,f.schema_version,b.payload,b.content_sha256,f.id FROM agent_facts f JOIN contents b ON b.id=f.body_content_id WHERE f.run=? AND f.revision=1",[run.to_string()],|r|Ok((read_u64(r,0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
    check_bytes(&bytes, &digest)?;
    let admission = decode_record(version, &bytes)?;
    if admission.run != run
        || admission.revision != 1
        || admission.id.to_string() != id
        || !matches!(&admission.fact,Fact::RunAdmitted{spec} if spec==&spec_ref)
    {
        return Err(invalid("Run admission source differs from canonical spec"));
    }
    Ok(RunSource {
        run,
        admission_sequence: sequence,
        spec,
        spec_ref,
        admission,
    })
}
pub(super) fn content(
    c: &Connection,
    history: &HistoryNamespace,
    run: RunId,
    reference: &ContentRef,
) -> Result<Vec<u8>, StoreError> {
    spec(c, history, run)?;
    crate::sql::owned_content(c, run, reference)
}
fn canonical_tail(
    c: &Connection,
    history: &HistoryNamespace,
    bound: u64,
) -> Result<u64, StoreError> {
    let mut statement = c.prepare_cached("SELECT s.run FROM agent_run_specs s JOIN agent_facts admission ON admission.run=s.run AND admission.revision=1 WHERE s.owner=? AND s.session=? AND admission.sequence<=?")?;
    let mut rows = statement.query(params![
        scope_key(history)?,
        history.session,
        bind_u64(bound)?
    ])?;
    let mut tail = 0;
    let mut seek = c.prepare_cached("SELECT sequence,revision FROM agent_facts INDEXED BY agent_facts_diagnostics_tail WHERE run=? ORDER BY revision DESC LIMIT 1")?;
    let mut point =
        c.prepare_cached("SELECT sequence FROM agent_facts WHERE run=? AND revision=?")?;
    while let Some(row) = rows.next()? {
        let run: String = row.get(0)?;
        let (sequence, revision) =
            seek.query_row([&run], |row| Ok((read_u64(row, 0)?, read_u64(row, 1)?)))?;
        if sequence <= bound {
            tail = tail.max(sequence);
            continue;
        }
        // Revisions are contiguous and their canonical sequences increase.
        // Old cuts must not scan an arbitrarily long future tail of this Run.
        let (mut low, mut high, mut selected) = (1, revision, 0);
        while low <= high {
            let middle = low + (high - low) / 2;
            let sequence =
                point.query_row(params![run, bind_u64(middle)?], |row| read_u64(row, 0))?;
            if sequence <= bound {
                selected = sequence;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }
        tail = tail.max(selected);
    }
    Ok(tail)
}
fn validate_tail(
    c: &Connection,
    history: &HistoryNamespace,
    bound: u64,
    cached: u64,
) -> Result<(), StoreError> {
    if canonical_tail(c, history, bound)? != cached {
        return Err(invalid(
            "session history index missing canonical tail; explicit rebuild required",
        ));
    }
    Ok(())
}
pub(super) fn check_bytes(bytes: &[u8], digest: &str) -> Result<(), StoreError> {
    if content_digest(bytes) != digest {
        return Err(invalid("canonical history bytes corrupt"));
    }
    Ok(())
}
pub(super) fn capture(
    c: &Connection,
    history: &HistoryNamespace,
    before: Option<RunId>,
) -> Result<HistoryCut, StoreError> {
    let owner = scope_key(history)?;
    let bound = if let Some(run) = before {
        spec(c, history, run)?;
        admission_sequence(c, run)?
            .checked_sub(1)
            .ok_or_else(|| invalid("invalid admission sequence"))?
    } else {
        i64::MAX as u64
    };
    let row:Option<(u64,String)>=c.query_row("SELECT sequence,prefix_digest FROM agent_session_history WHERE owner=? AND session=? AND sequence<=? ORDER BY sequence DESC LIMIT 1",params![owner,history.session,bind_u64(bound)?],|r|Ok((read_u64(r,0)?,r.get(1)?))).optional()?;
    validate_tail(c, history, bound, row.as_ref().map_or(0, |row| row.0))?;
    let (through_sequence, digest) = match row {
        Some(row) => row,
        None => (0, seed(&history.owner, &history.session)?),
    };
    Ok(HistoryCut {
        owner: history.owner.clone(),
        session: history.session.clone(),
        through_sequence,
        digest,
    })
}
fn check_cut(
    c: &Connection,
    history: &HistoryNamespace,
    cut: &HistoryCut,
) -> Result<String, StoreError> {
    let owner = scope_key(history)?;
    if cut.owner != history.owner
        || cut.session != history.session
        || cut.through_sequence > i64::MAX as u64
    {
        return Err(invalid("foreign or invalid history cut"));
    }
    let expected = if cut.through_sequence == 0 {
        seed(&history.owner, &history.session)?
    } else {
        c.query_row("SELECT prefix_digest FROM agent_session_history WHERE owner=? AND session=? AND sequence=?",params![owner,history.session,bind_u64(cut.through_sequence)?],|r|r.get(0)).optional()?.ok_or_else(||invalid("history cut is not retained; explicit rebuild required"))?
    };
    if cut.digest != expected {
        return Err(StoreError::EventConflict);
    }
    Ok(owner)
}
pub(super) fn page(
    c: &Connection,
    history: &HistoryNamespace,
    cut: &HistoryCut,
    after: u64,
    size: u32,
) -> Result<HistoryPage, StoreError> {
    let owner = check_cut(c, history, cut)?;
    let size = limit(size)?;
    if after > cut.through_sequence {
        return Err(invalid("history cursor exceeds captured cut"));
    }
    type HistoryRow = (
        u64,
        u64,
        Option<String>,
        Option<String>,
        u32,
        Vec<u8>,
        String,
        String,
        String,
        String,
    );
    let rows: Vec<HistoryRow> = c.prepare_cached("SELECT h.sequence,h.admission_sequence,h.step,h.attempt,f.schema_version,b.payload,b.content_sha256,h.prefix_digest,h.run,h.fact_id FROM agent_session_history h LEFT JOIN agent_facts f ON f.sequence=h.sequence LEFT JOIN contents b ON b.id=f.body_content_id WHERE h.owner=? AND h.session=? AND h.sequence>? AND h.sequence<=? ORDER BY h.sequence LIMIT ?")?.query_map(params![owner,history.session,bind_u64(after)?,bind_u64(cut.through_sequence)?,size+1], |r| Ok((read_u64(r,0)?,read_u64(r,1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?)))?.collect::<Result<_,_>>()?;
    let more = rows.len() > size as usize;
    let prior: Option<String> = c.query_row("SELECT prefix_digest FROM agent_session_history WHERE owner=? AND session=? AND sequence<=? ORDER BY sequence DESC LIMIT 1", params![owner,history.session,bind_u64(after)?], |r|r.get(0)).optional()?;
    let mut prefix = match prior {
        Some(prior) => prior,
        None => seed(&history.owner, &history.session)?,
    };
    let mut items = Vec::with_capacity(rows.len().min(size as usize));
    for (
        sequence,
        admission_sequence,
        step,
        attempt,
        version,
        bytes,
        digest,
        expected,
        run,
        fact,
    ) in rows.into_iter().take(size as usize)
    {
        if content_digest(&bytes) != digest {
            return Err(invalid("canonical history bytes corrupt"));
        }
        prefix = chain(&prefix, sequence, &digest)?;
        if prefix != expected {
            return Err(invalid(
                "history projection has a missing or reordered fact; explicit rebuild required",
            ));
        }
        let scope = HistoryScope {
            step: step.map(identity).transpose()?,
            attempt: attempt.map(identity).transpose()?,
        };
        let recorded = decode_record(version, &bytes)?;
        validate_source_record(
            c,
            identity(run)?,
            identity(fact)?,
            admission_sequence,
            &scope,
            &recorded,
        )?;
        items.push(HistoryItem {
            sequence,
            admission_sequence,
            scope,
            recorded,
        });
    }
    if !more
        && after < cut.through_sequence
        && items.last().map(|item| item.sequence) != Some(cut.through_sequence)
    {
        return Err(invalid("history projection is missing the captured tail"));
    }
    let next = if more {
        items.last().map(|i| i.sequence)
    } else {
        None
    };
    Ok(HistoryPage { items, next })
}

pub(super) fn request_preparation(
    c: &Connection,
    history: &HistoryNamespace,
    cut: &HistoryCut,
    run: RunId,
    step: StepId,
) -> Result<(RequestSpec, UnixMillis), StoreError> {
    let owner = check_cut(c, history, cut)?;
    spec(c, history, run)?;
    let sequence:Option<u64>=c.query_row("SELECT sequence FROM agent_session_history WHERE owner=? AND session=? AND run=? AND step=? AND kind='step_prepared' AND sequence<=? ORDER BY sequence LIMIT 1",params![owner,history.session,run.to_string(),step.to_string(),bind_u64(cut.through_sequence)?],|r|read_u64(r,0)).optional()?;
    let sequence =
        sequence.ok_or_else(|| invalid("request Step is outside captured source cut"))?;
    let original = item(c, history, cut, sequence)?
        .ok_or_else(|| invalid("original StepPrepared source missing"))?;
    let Fact::StepPrepared {
        step: actual,
        request,
        ..
    } = original.recorded.fact
    else {
        return Err(invalid("request source is not its original StepPrepared"));
    };
    if original.recorded.run != run || actual != step {
        return Err(invalid("request original Step identity differs"));
    }
    let request: RequestSpec = owned_metadata(c, run, &request)?;
    if request.schema_version != SCHEMA_VERSION || request.step != step {
        return Err(invalid("request original schema/Step differs"));
    }
    Ok((request, original.recorded.at))
}
pub(super) fn validate_source_record(
    c: &Connection,
    run: RunId,
    fact: FactId,
    admission: u64,
    scope: &HistoryScope,
    record: &RecordedFact,
) -> Result<(), StoreError> {
    if record.run != run || record.id != fact || record.schema_version != SCHEMA_VERSION {
        return Err(invalid(
            "canonical history header identity differs from its original fact",
        ));
    }
    if admission_sequence(c, run)? != admission || fact_scope(c, record)? != *scope {
        return Err(invalid(
            "canonical history header scope differs from its original fact",
        ));
    }
    let (owner,session,actual_owner,actual_session,kind,actual_kind,locator):(String,String,String,String,String,String,Option<String>)=c.query_row("SELECT h.owner,h.session,s.owner,s.session,h.kind,json_extract(b.payload,'$.fact.kind'),h.tool_use_id FROM agent_facts f JOIN agent_session_history h ON h.sequence=f.sequence JOIN agent_run_specs s ON s.run=f.run JOIN contents b ON b.id=f.body_content_id WHERE f.id=? AND f.run=?",params![record.id.to_string(),record.run.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?)))?;
    if owner != actual_owner
        || session != actual_session
        || kind != actual_kind
        || locator != tool_locator(c, record)?.map(|value| value.0)
    {
        return Err(invalid(
            "canonical history header kind/locator/namespace differs from its original fact",
        ));
    }
    Ok(())
}
fn attempt_scope(
    c: &Connection,
    run: RunId,
    attempt: ModelAttemptId,
) -> Result<HistoryScope, StoreError> {
    let step: String = c
        .query_row(
            "SELECT step FROM agent_attempt_ids WHERE run=? AND attempt=?",
            params![run.to_string(), attempt.to_string()],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| invalid("history attempt has no original Step"))?;
    Ok(HistoryScope {
        step: Some(identity(step)?),
        attempt: Some(attempt),
    })
}
fn blocker_attempt(reason: &BlockerKind) -> Option<ModelAttemptId> {
    match reason {
        BlockerKind::OperationUnknown { tool, .. }
        | BlockerKind::OriginalAdmissionUnknown { tool }
        | BlockerKind::ToolCleanupUnconfirmed { tool, .. }
        | BlockerKind::ResourcesUnavailable { tool } => Some(tool.attempt),
        BlockerKind::ProviderEffectUnknown { attempt, .. }
        | BlockerKind::ModelCleanupUnconfirmed { attempt, .. } => Some(*attempt),
        _ => None,
    }
}
fn fact_scope(c: &Connection, record: &RecordedFact) -> Result<HistoryScope, StoreError> {
    let attempt = match &record.fact {
        Fact::Cell { event } => {
            use maka_agent_facts::cells::{CellEvent, CellOwner};
            let owner = match event {
                CellEvent::Started { owner, .. } => owner.clone(),
                _ => crate::cells::read_cell(c, record.run, event.cell())?.owner,
            };
            let CellOwner::Agent { link, .. } = owner else {
                return Err(invalid("standalone Cell cannot claim Agent Run history"));
            };
            if link.run != record.run {
                return Err(invalid("Cell history belongs to another Run"));
            }
            return Ok(HistoryScope {
                step: Some(link.step),
                attempt: Some(link.attempt),
            });
        }
        Fact::StepPrepared { step, .. } => {
            return Ok(HistoryScope {
                step: Some(*step),
                attempt: None,
            });
        }
        Fact::ModelAttemptPrepared { attempt, step } => {
            return Ok(HistoryScope {
                step: Some(*step),
                attempt: Some(*attempt),
            });
        }
        Fact::ModelAttemptAdmitted { attempt, .. }
        | Fact::ModelTransportSelected { attempt, .. }
        | Fact::ModelPrivatePartialCaptured { attempt, .. }
        | Fact::ModelSourceFailureCaptured { attempt, .. }
        | Fact::ModelInterrupted { attempt, .. }
        | Fact::ModelObserved { attempt, .. }
        | Fact::AttemptRecoveryRecorded { attempt, .. }
        | Fact::ModelClosed { attempt, .. }
        | Fact::RetryCharged { attempt, .. } => Some(*attempt),
        Fact::ToolDecided { tool, .. }
        | Fact::ToolsLoaded { tool, .. }
        | Fact::ToolOriginalBound { tool, .. }
        | Fact::ToolAdmitted { tool }
        | Fact::ToolPreventedBeforeHostAdmission { tool, .. }
        | Fact::HostToolResultRecorded { tool, .. }
        | Fact::LocalToolReturned { tool, .. }
        | Fact::ToolResultAccepted { tool, .. }
        | Fact::OperationObserved { tool, .. }
        | Fact::ApprovalRecorded { tool, .. }
        | Fact::ApprovalRefused { tool, .. }
        | Fact::ApprovalConsumed { tool, .. } => Some(tool.attempt),
        Fact::Blocked { reason, .. } => blocker_attempt(reason),
        Fact::WaitRegistered { reason, .. } => match reason {
            WaitReason::Model { attempt } | WaitReason::Retry { attempt } => Some(*attempt),
            WaitReason::Operation { tool } => Some(tool.attempt),
            _ => None,
        },
        _ => None,
    };
    attempt
        .map(|a| attempt_scope(c, record.run, a))
        .transpose()
        .map(|s| s.unwrap_or_default())
}
/// Called after canonical insertion and immutable Step/attempt registration in
/// the same transaction. Only index data is written; no new semantic fact.
pub(crate) fn index(c: &Connection, record: &RecordedFact) -> Result<(), StoreError> {
    let (sequence,owner,session,digest,kind):(u64,String,String,String,String)=c.query_row("SELECT f.sequence,s.owner,s.session,b.content_sha256,json_extract(b.payload,'$.fact.kind') FROM agent_facts f JOIN agent_run_specs s ON s.run=f.run JOIN contents b ON b.id=f.body_content_id WHERE f.id=? AND f.run=?",params![record.id.to_string(),record.run.to_string()],|r|Ok((read_u64(r,0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
    type IndexedHistoryRow = (
        String,
        String,
        String,
        String,
        u64,
        Option<String>,
        Option<String>,
    );
    let existing: Option<IndexedHistoryRow> = c.query_row(
        "SELECT owner,session,run,fact_id,admission_sequence,step,attempt FROM agent_session_history WHERE sequence=?",
        [bind_u64(sequence)?],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,read_u64(r,4)?,r.get(5)?,r.get(6)?)),
    ).optional()?;
    if let Some((cached_owner, cached_session, run, fact, admission, step, attempt)) = existing {
        if cached_owner != owner || cached_session != session {
            return Err(invalid(
                "existing history index belongs to another namespace",
            ));
        }
        validate_source_record(
            c,
            identity(run)?,
            identity(fact)?,
            admission,
            &HistoryScope {
                step: step.map(identity).transpose()?,
                attempt: attempt.map(identity).transpose()?,
            },
            record,
        )?;
        return Ok(());
    }
    let owner_value: RunOwner = serde_json::from_str(&owner)?;
    let previous:Option<(u64,String)>=c.query_row("SELECT sequence,prefix_digest FROM agent_session_history WHERE owner=? AND session=? ORDER BY sequence DESC LIMIT 1",params![owner,session],|r|Ok((read_u64(r,0)?,r.get(1)?))).optional()?;
    let previous = match previous {
        Some((prior, digest)) if prior < sequence => digest,
        Some(_) => return Err(invalid("history index requires canonical commit order")),
        None => {
            let earlier: bool = c.query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_run_specs s JOIN agent_facts f ON f.run=s.run WHERE s.owner=? AND s.session=? AND f.sequence<? LIMIT 1)",
                params![owner, session, bind_u64(sequence)?], |row| row.get(0))?;
            if earlier {
                return Err(invalid(
                    "session history prefix index missing; explicit rebuild required",
                ));
            }
            seed(&owner_value, &session)?
        }
    };
    // Canonical stored bytes, including typed ids, revision, schema and timestamp,
    // are hashed rather than today's reserialized/redacted semantic projection.
    let prefix = chain(&previous, sequence, &digest)?;
    let scope = fact_scope(c, record)?;
    let locator = tool_locator(c, record)?;
    let historical = if let Fact::RunAdmitted { spec: expected } = &record.fact {
        let (value, reference) = spec(
            c,
            &HistoryNamespace {
                owner: owner_value,
                session: session.clone(),
            },
            record.run,
        )?;
        if &reference != expected {
            return Err(invalid("history admission names another Run specification"));
        }
        historical_backend(&value)?
    } else {
        false
    };
    c.execute(
        "INSERT INTO agent_session_history(owner,session,sequence,run,admission_sequence,step,attempt,kind,prefix_digest,tool_use_id,tool_start,opening_message,fact_id,result_source,tool_name,historical) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        params![
            owner,
            session,
            bind_u64(sequence)?,
            record.run.to_string(),
            bind_u64(admission_sequence(c, record.run)?)?,
            scope.step.map(|v| v.to_string()),
            scope.attempt.map(|v| v.to_string()),
            kind,
            prefix,
            locator.as_ref().map(|value| value.0.as_str()),
            locator.as_ref().is_some_and(|value| value.1),
            false,
            record.id.to_string(),
            result_source(&record.fact),
            match &record.fact {
                Fact::ModelObserved {
                    part: maka_agent_facts::model::ModelPart::ToolCall { call },
                    ..
                } => Some(call.name.as_str()),
                Fact::Cell {
                    event: maka_agent_facts::cells::CellEvent::ChildPrepared { name, .. },
                } | Fact::ExternalTaskObserved {
                    output: maka_agent_facts::executor::Output::ToolStart { name, .. }, ..
                } => Some(name.as_str()),
                _ => None,
            },
            historical,
        ],
    )?;
    Ok(())
}
pub(crate) fn index_retained(c: &Connection, record: &RecordedFact) -> Result<(), StoreError> {
    let (sequence,owner,session):(u64,String,String)=c.query_row("SELECT h.sequence,h.owner,h.session FROM agent_session_history h JOIN agent_facts f ON f.sequence=h.sequence WHERE f.id=? AND h.run=?",params![record.id.to_string(),record.run.to_string()],|r|Ok((read_u64(r,0)?,r.get(1)?,r.get(2)?)))?;
    index_refs(
        c,
        &serde_json::from_str(&owner)?,
        &session,
        record,
        sequence,
    )
}
fn index_refs(
    c: &Connection,
    owner: &RunOwner,
    session: &str,
    record: &RecordedFact,
    sequence: u64,
) -> Result<(), StoreError> {
    let mut references = record
        .fact
        .content_refs()
        .into_iter()
        .cloned()
        .collect::<Vec<_>>();
    match &record.fact {
        Fact::RunAdmitted { .. } => {
            let (spec, _) = spec(
                c,
                &HistoryNamespace {
                    owner: owner.clone(),
                    session: session.into(),
                },
                record.run,
            )?;
            references.extend(spec.content_refs().into_iter().cloned());
            let adoption: Option<(String, String)> = c
                .query_row(
                    "SELECT snapshot,fact FROM agent_history_snapshot_adoptions WHERE run=?",
                    [record.run.to_string()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if let Some((snapshot, fact)) = adoption {
                let original = match &spec.origin {
                    RunOrigin::Forked { source, .. } | RunOrigin::Imported { source } => source,
                    RunOrigin::Local => {
                        return Err(invalid("local Run has a historical adoption receipt"));
                    }
                };
                let reference:ContentRef=c.query_row("SELECT b.content_sha256,length(b.payload) FROM agent_history_snapshots s JOIN contents b ON b.id=s.manifest_content_id WHERE s.snapshot=?",[&snapshot],|row|Ok(ContentRef {digest:row.get(0)?,bytes:read_u64(row,1)?}))?;
                if fact != record.id.to_string()
                    || original != &reference
                    || !historical_backend(&spec)?
                {
                    return Err(invalid(
                        "historical adoption differs from its original Run admission",
                    ));
                }
                let manifest: maka_agent_facts::history_snapshot::Manifest =
                    owned_metadata(c, record.run, original)?;
                manifest.validate().map_err(invalid)?;
                let count: u64 = c.query_row(
                    "SELECT count(*) FROM agent_history_snapshot_pins WHERE snapshot=?",
                    [&snapshot],
                    |row| read_u64(row, 0),
                )?;
                let manifest_pinned:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshots s JOIN agent_history_snapshot_pins p ON p.snapshot=s.snapshot AND p.content_id=s.manifest_content_id WHERE s.snapshot=?)",[&snapshot],|row|row.get(0))?;
                if manifest.id.to_string() != snapshot
                    || manifest.objects != count
                    || !manifest_pinned
                {
                    return Err(invalid(
                        "historical adoption original snapshot closure is incomplete",
                    ));
                }
            }
        }
        Fact::StepPrepared { step, request, .. } => {
            let request: RequestSpec = owned_metadata(c, record.run, request)?;
            if request.schema_version != SCHEMA_VERSION || request.step != *step {
                return Err(invalid("original Step request schema/identity differs"));
            }
            references.extend(request.content_refs().into_iter().cloned());
        }
        Fact::ExternalSteering {
            event:
                maka_agent_facts::external_steering::ExternalSteeringEvent::Prepared { key, descriptor },
        } => {
            let original = crate::external_steering::read_spec(c, record.run, key, descriptor)?;
            references.extend(original.content_refs().into_iter().cloned());
        }
        Fact::ExternalEffect {
            event:
                maka_agent_facts::external_effects::ExternalEffectEvent::Prepared { key, descriptor },
        } => {
            let original =
                crate::external_effects::read_descriptor(c, record.run, key, descriptor)?;
            references.extend(original.resources.into_iter().filter_map(
                |resource| match resource {
                    ResourceRecovery::Reference { descriptor } => Some(descriptor),
                    _ => None,
                },
            ));
        }
        _ => {}
    }
    let owner = encode(owner)?;
    for reference in references {
        let content_id: i64 = c.query_row("SELECT b.id FROM agent_run_content p JOIN contents b ON b.id=p.content_id WHERE p.run=? AND b.content_sha256=? AND length(b.payload)=?", params![record.run.to_string(),reference.digest,bind_u64(reference.bytes)?], |r|r.get(0)).optional()?.ok_or_else(||invalid("canonical history content is not retained by its original Run"))?;
        c.execute(
            "INSERT OR IGNORE INTO agent_history_content_refs VALUES(?,?,?,?,?)",
            params![
                owner,
                session,
                record.run.to_string(),
                content_id,
                bind_u64(sequence)?
            ],
        )?;
    }
    c.execute("INSERT OR IGNORE INTO agent_history_content_refs(owner,session,run,content_id,first_sequence) SELECT ?1,?2,?3,a.content_id,?4 FROM agent_artifact_run_bindings r JOIN agent_artifacts a ON a.session=r.session AND a.artifact=r.artifact JOIN agent_run_content p ON p.run=r.run AND p.content_id=a.content_id WHERE r.run=?3 AND r.fact=?5 AND r.revision=?6 AND a.owner=?1 AND a.session=?2",params![owner,session,record.run.to_string(),bind_u64(sequence)?,record.id.to_string(),bind_u64(record.revision)?])?;
    Ok(())
}
pub(crate) fn index_queue(c: &Connection, session: &str, revision: u64) -> Result<(), StoreError> {
    let (id,bytes,digest):(String,Vec<u8>,String)=c.query_row("SELECT e.id,b.payload,b.content_sha256 FROM agent_queue_events e JOIN contents b ON b.id=e.body_content_id WHERE e.session=? AND e.revision=?",params![session,bind_u64(revision)?],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    check_bytes(&bytes, &digest)?;
    let event: Event = serde_json::from_slice(&bytes)?;
    if let Event::Consumed {
        cut,
        run,
        target: DeliveryTarget::Run,
    } = &event
    {
        if cut.session != session || cut.requests.is_empty() {
            return Err(invalid("invalid opening message consumption"));
        }
        mark_message(c, session, *run, &id)?;
    }
    if let Event::Command {
        edit: QueueEdit::Enqueue { request, .. } | QueueEdit::Update { request },
        ..
    } = event
    {
        if request.spec.session_id != session {
            return Err(invalid(
                "canonical queue request belongs to another session",
            ));
        }
        c.execute(
            "INSERT OR IGNORE INTO agent_history_queue_requests VALUES(?,?,?,?)",
            params![session, request.id.0, bind_u64(revision)?, id],
        )?;
    }
    Ok(())
}
type ConsumedEvent = (RunId, FactId, u64, crate::queue::Consume, DeliveryTarget);

fn consumed(
    c: &Connection,
    history: &HistoryNamespace,
    cut: &HistoryCut,
    sequence: u64,
) -> Result<Option<ConsumedEvent>, StoreError> {
    check_cut(c, history, cut)?;
    if sequence == 0 || sequence > cut.through_sequence {
        return Err(invalid("source sequence exceeds captured history"));
    }
    let original = item(c, history, cut, sequence)?
        .ok_or_else(|| invalid("source fact outside session namespace"))?;
    let run = original.recorded.run;
    let fact = original.recorded.id;
    let event:Option<(u64,Vec<u8>,String)>=c.query_row("SELECT e.revision,b.payload,b.content_sha256 FROM agent_queue_events e JOIN contents b ON b.id=e.body_content_id WHERE e.session=? AND e.id=?",params![history.session,fact.to_string()],|r|Ok((read_u64(r,0)?,r.get(1)?,r.get(2)?))).optional()?;
    let Some((revision, bytes, digest)) = event else {
        return Ok(None);
    };
    check_bytes(&bytes, &digest)?;
    let event: Event = serde_json::from_slice(&bytes)?;
    let Event::Consumed {
        cut,
        run: consumed_run,
        target,
    } = event
    else {
        return Err(invalid(
            "source fact references a non-consumption queue event",
        ));
    };
    if consumed_run != run || cut.session != history.session {
        return Err(invalid("queue source consumption changed ownership"));
    }
    Ok(Some((run, fact, revision, cut, target)))
}
pub(super) fn sources(
    c: &Connection,
    history: &HistoryNamespace,
    cut: &HistoryCut,
    sequence: u64,
    after: Option<u64>,
    size: u32,
) -> Result<QueueSourcePage, StoreError> {
    let size = limit(size)?;
    let Some((run, _, consumed_revision, consumption, delivery)) =
        consumed(c, history, cut, sequence)?
    else {
        return Ok(QueueSourcePage {
            sources: vec![],
            next: None,
        });
    };
    let start = after
        .map(|p| {
            p.checked_add(1)
                .ok_or_else(|| invalid("source position overflow"))
        })
        .transpose()?
        .unwrap_or(0);
    let count = u64::try_from(consumption.requests.len())
        .map_err(|_| invalid("queue source count overflow"))?;
    if start > count {
        return Err(invalid("source cursor exceeds consumed requests"));
    }
    let end = start.saturating_add(size as u64).min(count);
    let mut sources = Vec::with_capacity((end - start) as usize);
    for position in start..end {
        let id = &consumption.requests[position as usize];
        let row:Option<(u64,Vec<u8>,String)>=c.query_row("SELECT q.revision,b.payload,b.content_sha256 FROM agent_history_queue_requests q JOIN agent_queue_events e ON e.session=q.session AND e.revision=q.revision JOIN contents b ON b.id=e.body_content_id WHERE q.session=? AND q.request=? AND q.revision<? ORDER BY q.revision DESC LIMIT 1",params![history.session,id.0,bind_u64(consumed_revision)?],|r|Ok((read_u64(r,0)?,r.get(1)?,r.get(2)?))).optional()?;
        let (revision, bytes, digest) = row.ok_or_else(|| {
            invalid("consumed queue snapshot index missing; explicit rebuild required")
        })?;
        check_bytes(&bytes, &digest)?;
        let event: Event = serde_json::from_slice(&bytes)?;
        let Event::Command {
            edit:
                QueueEdit::Enqueue {
                    request: frozen, ..
                }
                | QueueEdit::Update { request: frozen },
            ..
        } = event
        else {
            return Err(invalid(
                "history queue index does not address an immutable request snapshot",
            ));
        };
        if frozen.id != *id
            || frozen.spec.owner != history.owner
            || frozen.spec.session_id != history.session
        {
            return Err(invalid("consumed source belongs to another namespace"));
        }
        match &delivery {
            DeliveryTarget::Run => {
                let (spec, _) = spec(c, history, run)?;
                if frozen.spec != spec {
                    return Err(invalid("original Run input differs from consumed request"));
                }
            }
            DeliveryTarget::Step { step } => {
                let (request_spec, _) = request_preparation(c, history, cut, run, *step)?;
                if request_spec.steering.get(position as usize) != Some(&frozen.source) {
                    return Err(invalid(
                        "Step steering differs from original consumed source order",
                    ));
                }
            }
            DeliveryTarget::External {
                task,
                steering,
                descriptor,
            } => {
                let key = maka_agent_facts::external_steering::ExternalSteeringKey {
                    task: *task,
                    steering: *steering,
                };
                let original = crate::external_steering::read_spec(c, run, &key, descriptor)?;
                if original.consume != consumption
                    || original.sources.len() != consumption.requests.len()
                {
                    return Err(invalid(
                        "External steering differs from original queue prefix",
                    ));
                }
                let source = original
                    .sources
                    .get(position as usize)
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
        sources.push(QueueSource {
            position,
            queue_revision: revision,
            request: *frozen,
        });
    }
    Ok(QueueSourcePage {
        next: if end < count { Some(end - 1) } else { None },
        sources,
    })
}
pub(super) fn source_content(
    c: &Connection,
    history: &HistoryNamespace,
    cut: &HistoryCut,
    sequence: u64,
    position: u64,
    reference: &ContentRef,
) -> Result<Vec<u8>, StoreError> {
    with_source(c, history, cut, sequence, position, reference, |reader| {
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes)?;
        Ok(bytes)
    })
}
pub(super) fn with_source<T>(
    c: &Connection,
    history: &HistoryNamespace,
    cut: &HistoryCut,
    sequence: u64,
    position: u64,
    reference: &ContentRef,
    consume: impl FnOnce(&mut CheckedBlob<'_, '_>) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    reference.validate().map_err(invalid)?;
    let page = sources(c, history, cut, sequence, position.checked_sub(1), 1)?;
    let source = page
        .sources
        .first()
        .filter(|s| s.position == position)
        .ok_or_else(|| invalid("queue source position missing"))?;
    if reference != &source.request.source && reference != &source.request.resources {
        return Err(invalid(
            "content is not the original source at this position",
        ));
    }
    let row: Option<i64> = c.query_row(
        "SELECT b.id FROM agent_queue_content_pins p JOIN contents b ON b.id=p.content_id WHERE p.session=? AND p.request=? AND b.content_sha256=? AND length(b.payload)=?",
        params![history.session, source.request.id.0, reference.digest, bind_u64(reference.bytes)?],
        |row| row.get(0),
    ).optional()?;
    let row =
        row.ok_or_else(|| invalid("content is not retained by this original queue source"))?;
    read_blob(c, row, reference, consume)
}
pub(super) fn rebuild(
    c: &Connection,
    history: &HistoryNamespace,
) -> Result<HistoryCut, StoreError> {
    let owner = scope_key(history)?;
    c.execute(
        "DELETE FROM agent_session_history WHERE owner=? AND session=?",
        params![owner, history.session],
    )?;
    {
        let mut runs =
            c.prepare_cached("SELECT run FROM agent_run_specs WHERE owner=? AND session=?")?;
        let mut rows = runs.query(params![owner, history.session])?;
        while let Some(row) = rows.next()? {
            let run: String = row.get(0)?;
            c.execute("DELETE FROM agent_session_history WHERE sequence IN(SELECT sequence FROM agent_facts WHERE run=?)",[run])?;
        }
    }
    c.execute(
        "DELETE FROM agent_history_content_refs WHERE owner=? AND session=?",
        params![owner, history.session],
    )?;
    c.execute("DELETE FROM agent_continuation_successors WHERE run IN(SELECT run FROM agent_run_specs WHERE owner=? AND session=?)",params![owner,history.session])?;
    {
        // One ordered cursor over only this namespace; do not repeatedly scan
        // every Run for each repair page or retain the complete history in RAM.
        let mut statement = c.prepare_cached("SELECT f.schema_version,b.payload,b.content_sha256 FROM agent_run_specs s JOIN agent_facts f ON f.run=s.run JOIN contents b ON b.id=f.body_content_id WHERE s.owner=? AND s.session=? ORDER BY f.sequence")?;
        let mut rows = statement.query(params![owner, history.session])?;
        while let Some(row) = rows.next()? {
            let bytes: Vec<u8> = row.get(1)?;
            if content_digest(&bytes) != row.get::<_, String>(2)? {
                return Err(invalid("canonical history bytes corrupt"));
            }
            let record = decode_record(row.get(0)?, &bytes)?;
            index(c, &record)?;
            index_retained(c, &record)?;
            super::continuation::rebuild_record(c, history, &record)?;
        }
    }
    c.execute(
        "DELETE FROM agent_history_queue_requests WHERE session=?",
        [&history.session],
    )?;
    {
        let mut statement = c.prepare_cached(
            "SELECT revision FROM agent_queue_events WHERE session=? ORDER BY revision",
        )?;
        let mut rows = statement.query([&history.session])?;
        while let Some(row) = rows.next()? {
            index_queue(c, &history.session, read_u64(row, 0)?)?;
        }
    }
    capture(c, history, None)
}
pub(super) fn with_content<T>(
    c: &Connection,
    history: &HistoryNamespace,
    cut: &HistoryCut,
    run: RunId,
    reference: &ContentRef,
    consume: impl FnOnce(&mut CheckedBlob<'_, '_>) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    let owner = check_cut(c, history, cut)?;
    reference.validate().map_err(invalid)?;
    let row: Option<i64> = c.prepare_cached("SELECT b.id FROM contents b WHERE b.content_sha256=?5 AND length(b.payload)=?6 AND EXISTS(SELECT 1 FROM agent_history_content h WHERE h.owner=?1 AND h.session=?2 AND h.run=?3 AND h.content_id=b.id AND h.first_sequence<=?4 AND (h.inherited=1 OR EXISTS(SELECT 1 FROM agent_run_content p WHERE p.run=h.run AND p.content_id=b.id)))")?.query_row(params![owner,history.session,run.to_string(),bind_u64(cut.through_sequence)?,reference.digest,bind_u64(reference.bytes)?], |r|r.get(0)).optional()?;
    let row = row.ok_or_else(|| {
        invalid("content is not owned by this Run within the captured source cut")
    })?;
    read_blob(c, row, reference, consume)
}
pub(super) struct CheckedBlob<'a, 'c> {
    blob: &'a mut rusqlite::blob::Blob<'c>,
    reference: &'a ContentRef,
    hash: Option<Sha256>,
    position: u64,
    corrupt: bool,
}
impl CheckedBlob<'_, '_> {
    fn finish_hash(&mut self) -> std::io::Result<()> {
        if let Some(hash) = self.hash.take()
            && (self.position != self.reference.bytes
                || format!("sha256:{}", hex::encode(hash.finalize())) != self.reference.digest)
        {
            self.corrupt = true;
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "canonical source Blob hash differs",
            ));
        }
        Ok(())
    }
}
impl Read for CheckedBlob<'_, '_> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if self.corrupt {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "canonical source Blob hash differs",
            ));
        }
        let count = self.blob.read(buffer)?;
        self.position += count as u64;
        if let Some(hash) = &mut self.hash {
            hash.update(&buffer[..count]);
        }
        if count == 0 || self.position == self.reference.bytes {
            self.finish_hash()?;
        }
        Ok(count)
    }
}
impl Seek for CheckedBlob<'_, '_> {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        let next = self.blob.seek(position)?;
        if next != self.position {
            // A random range is not a complete content authentication.
            self.hash = if next == 0 { Some(Sha256::new()) } else { None };
            self.position = next;
        }
        Ok(next)
    }
}
pub(super) fn read_blob<T>(
    c: &Connection,
    row: i64,
    reference: &ContentRef,
    consume: impl FnOnce(&mut CheckedBlob<'_, '_>) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    let mut blob = c.blob_open("main", "contents", "payload", row, true)?;
    let result = if u64::try_from(blob.len()).map_err(|_| invalid("Blob length overflow"))?
        != reference.bytes
    {
        Err(invalid("canonical source Blob length changed"))
    } else {
        let mut checked = CheckedBlob {
            blob: &mut blob,
            reference,
            hash: Some(Sha256::new()),
            position: 0,
            corrupt: false,
        };
        let value = consume(&mut checked);
        if checked.corrupt {
            Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "canonical source Blob hash differs",
            )
            .into())
        } else {
            value
        }
    };
    match (result, blob.close()) {
        (result, Ok(())) => result,
        (Ok(_), Err(close)) => Err(close.into()),
        (Err(read), Err(close)) => Err(std::io::Error::other(ReadAndClose { read, close }).into()),
    }
}
#[derive(Debug)]
struct ReadAndClose {
    read: StoreError,
    close: rusqlite::Error,
}
impl std::fmt::Display for ReadAndClose {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "source read failed: {}; closing its Blob also failed: {}",
            self.read, self.close
        )
    }
}
impl std::error::Error for ReadAndClose {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.read)
    }
}
pub(super) fn previous(
    c: &Connection,
    history: &HistoryNamespace,
    cut: &HistoryCut,
    before: Option<u64>,
    size: u32,
) -> Result<HistoryPage, StoreError> {
    let owner = check_cut(c, history, cut)?;
    let size = limit(size)?;
    let bound = match before {
        Some(0) => {
            return Ok(HistoryPage {
                items: vec![],
                next: None,
            });
        }
        Some(before) if before <= cut.through_sequence => before - 1,
        Some(_) => return Err(invalid("reverse history cursor exceeds captured cut")),
        None => cut.through_sequence,
    };
    let mut positions:Vec<u64>=c.prepare_cached("SELECT sequence FROM agent_session_history WHERE owner=? AND session=? AND sequence<=? ORDER BY sequence DESC LIMIT ?")?
        .query_map(params![owner,history.session,bind_u64(bound)?,size+1],|row|read_u64(row,0))?
        .collect::<Result<_,_>>()?;
    if before.is_none() {
        validate_tail(c, history, bound, positions.first().copied().unwrap_or(0))?;
    }
    let more = positions.len() > size as usize;
    positions.truncate(size as usize);
    let Some(&last) = positions.first() else {
        return Ok(HistoryPage {
            items: vec![],
            next: None,
        });
    };
    let first = *positions.last().unwrap();
    let digest=c.query_row("SELECT prefix_digest FROM agent_session_history WHERE owner=? AND session=? AND sequence=?",params![owner,history.session,bind_u64(last)?],|row|row.get(0))?;
    let selected = HistoryCut {
        through_sequence: last,
        digest,
        ..cut.clone()
    };
    let items = page(c, history, &selected, first - 1, size)?.items;
    if items.len() != positions.len() {
        return Err(invalid("reverse history source is incomplete"));
    }
    Ok(HistoryPage {
        items,
        next: if more { Some(first) } else { None },
    })
}

pub(crate) fn capture_at(
    c: &Connection,
    owner: &RunOwner,
    session: &str,
    through: Option<u64>,
) -> Result<HistoryCut, StoreError> {
    let history = HistoryNamespace {
        owner: owner.clone(),
        session: session.into(),
    };
    let Some(through) = through else {
        return capture(c, &history, None);
    };
    let key = scope_key(&history)?;
    let digest = if through == 0 {
        seed(owner, session)?
    } else {
        c.query_row("SELECT prefix_digest FROM agent_session_history WHERE owner=? AND session=? AND sequence=?",params![key,session,bind_u64(through)?],|r|r.get(0)).optional()?.ok_or_else(||invalid("history cut is not an exact boundary in this namespace"))?
    };
    let cut = HistoryCut {
        owner: owner.clone(),
        session: session.into(),
        through_sequence: through,
        digest,
    };
    check_cut(c, &history, &cut)?;
    validate_tail(c, &history, through, through)?;
    Ok(cut)
}
pub(crate) fn validate_cut(
    c: &Connection,
    owner: &RunOwner,
    session: &str,
    cut: &HistoryCut,
) -> Result<(), StoreError> {
    check_cut(
        c,
        &HistoryNamespace {
            owner: owner.clone(),
            session: session.into(),
        },
        cut,
    )
    .map(|_| ())
}
pub(crate) fn sources_at(
    c: &Connection,
    owner: &RunOwner,
    session: &str,
    cut: &HistoryCut,
    sequence: u64,
    after: Option<u64>,
    size: u32,
) -> Result<QueueSourcePage, StoreError> {
    sources(
        c,
        &HistoryNamespace {
            owner: owner.clone(),
            session: session.into(),
        },
        cut,
        sequence,
        after,
        size,
    )
}
pub(crate) fn source_content_at(
    c: &Connection,
    owner: &RunOwner,
    session: &str,
    cut: &HistoryCut,
    sequence: u64,
    position: u64,
    reference: &ContentRef,
) -> Result<Vec<u8>, StoreError> {
    source_content(
        c,
        &HistoryNamespace {
            owner: owner.clone(),
            session: session.into(),
        },
        cut,
        sequence,
        position,
        reference,
    )
}
pub(super) fn item(
    c: &Connection,
    history: &HistoryNamespace,
    cut: &HistoryCut,
    sequence: u64,
) -> Result<Option<HistoryItem>, StoreError> {
    if sequence == 0 || sequence > cut.through_sequence {
        check_cut(c, history, cut)?;
        return Ok(None);
    }
    Ok(page(c, history, cut, sequence - 1, 1)?
        .items
        .into_iter()
        .find(|item| item.sequence == sequence))
}
pub(super) fn latest(
    c: &Connection,
    history: &HistoryNamespace,
    cut: &HistoryCut,
) -> Result<Option<RunSource>, StoreError> {
    let owner = check_cut(c, history, cut)?;
    let run:Option<String>=c.query_row("SELECT run FROM agent_session_history WHERE owner=? AND session=? AND kind='run_admitted' AND sequence<=? ORDER BY sequence DESC LIMIT 1",params![owner,history.session,bind_u64(cut.through_sequence)?],|r|r.get(0)).optional()?;
    run.map(|run| run_source(c, history, identity(run)?))
        .transpose()
}
pub(super) fn view_at(
    c: &Connection,
    history: &HistoryNamespace,
    cut: &HistoryCut,
    run: RunId,
) -> Result<crate::fold::RunView, StoreError> {
    check_cut(c, history, cut)?;
    let source = run_source(c, history, run)?;
    if source.admission_sequence > cut.through_sequence {
        return Err(invalid("Run was not admitted within the captured cut"));
    }
    let mut view = crate::fold::RunView::admitted(run, source.spec)?;
    let mut statement=c.prepare_cached("SELECT f.schema_version,b.payload,b.content_sha256 FROM agent_facts f JOIN contents b ON b.id=f.body_content_id WHERE f.run=? AND f.sequence<=? ORDER BY f.revision")?;
    let mut rows = statement.query(params![run.to_string(), bind_u64(cut.through_sequence)?])?;
    while let Some(row) = rows.next()? {
        let bytes: Vec<u8> = row.get(1)?;
        let digest: String = row.get(2)?;
        if content_digest(&bytes) != digest {
            return Err(invalid("canonical history bytes corrupt"));
        }
        view.apply(&decode_record(row.get(0)?, &bytes)?)?;
    }
    Ok(view)
}
fn tool_locator(
    c: &Connection,
    record: &RecordedFact,
) -> Result<Option<(String, bool)>, StoreError> {
    use maka_agent_facts::{
        cells::CellEvent, external_effects::ExternalEffectEvent, model::ModelPart,
    };
    let (operation, start) = match &record.fact {
        Fact::ModelObserved {
            attempt,
            part: ModelPart::ToolCall { call },
            ..
        } => (format!("{attempt}:{}", call.id), true),
        Fact::ModelObserved {
            attempt,
            part: ModelPart::ToolResult { id, .. },
            ..
        } => (format!("{attempt}:{id}"), false),
        Fact::ToolsLoaded { tool, .. }
        | Fact::HostToolResultRecorded { tool, .. }
        | Fact::ToolDecided { tool, .. }
        | Fact::ToolAdmitted { tool, .. }
        | Fact::ToolPreventedBeforeHostAdmission { tool, .. }
        | Fact::ApprovalConsumed { tool, .. }
        | Fact::ToolOriginalBound { tool, .. }
        | Fact::LocalToolReturned { tool, .. }
        | Fact::OperationObserved { tool, .. }
        | Fact::ToolResultAccepted { tool, .. }
        | Fact::ApprovalRecorded { tool, .. }
        | Fact::ApprovalRefused { tool, .. } => (crate::fold::tool_key(tool), false),
        Fact::Cell { event } => match event {
            CellEvent::ChildPrepared {
                cell, operation, ..
            } => (format!("cell:{cell}:{operation}"), true),
            CellEvent::ChildDisplayRecorded {
                cell, operation, ..
            }
            | CellEvent::ChildRejected {
                cell, operation, ..
            }
            | CellEvent::ChildApprovalRecorded {
                cell, operation, ..
            }
            | CellEvent::ChildApprovalConsumed {
                cell, operation, ..
            }
            | CellEvent::ChildAdmitted {
                cell, operation, ..
            }
            | CellEvent::ChildBound {
                cell, operation, ..
            }
            | CellEvent::ChildResultRecorded {
                cell, operation, ..
            }
            | CellEvent::LocalChildReturned {
                cell, operation, ..
            }
            | CellEvent::ChildObserved {
                cell, operation, ..
            } => (format!("cell:{cell}:{operation}"), false),
            _ => return Ok(None),
        },
        Fact::ExternalTaskObserved { task, output, .. } => {
            use maka_agent_facts::executor::Output;
            match output {
                Output::ToolStart { tool_call_id, .. } => (format!("{task}:{tool_call_id}"), true),
                Output::ToolProgress { tool_call_id, .. }
                | Output::ToolResult { tool_call_id, .. } => {
                    (format!("{task}:{tool_call_id}"), false)
                }
                _ => return Ok(None),
            }
        }
        Fact::ExternalEffect { event } => {
            let key = event.key();
            let original = match event {
                ExternalEffectEvent::Prepared { descriptor, .. } => descriptor.clone(),
                _ => crate::external_effects::read_original(c, record.run, &key)?.descriptor,
            };
            let descriptor =
                crate::external_effects::read_descriptor(c, record.run, &key, &original)?;
            (
                descriptor.operation_id,
                matches!(event, ExternalEffectEvent::Prepared { .. }),
            )
        }
        _ => return Ok(None),
    };
    Ok(Some((
        maka_agent_facts::tool_call::tool_use_id(record.run, &operation),
        start,
    )))
}
pub(super) fn tool_call(
    c: &Connection,
    history: &HistoryNamespace,
    cut: &HistoryCut,
    run: RunId,
    key: &ToolKey,
) -> Result<maka_agent_facts::model::ModelToolCall, StoreError> {
    use maka_agent_facts::model::ModelPart;
    let owner = check_cut(c, history, cut)?;
    let use_id = maka_agent_facts::tool_call::tool_use_id(run, &crate::fold::tool_key(key));
    let mut rows: Vec<(u32, Vec<u8>, String, String)> = c.prepare_cached("SELECT f.schema_version,b.payload,b.content_sha256,f.id FROM agent_session_history h INDEXED BY agent_session_history_tool JOIN agent_facts f ON f.id=h.fact_id AND f.sequence=h.sequence AND f.run=h.run JOIN contents b ON b.id=f.body_content_id WHERE h.owner=? AND h.session=? AND h.tool_use_id=? AND h.run=? AND h.attempt=? AND h.tool_start=1 AND h.sequence<=? ORDER BY h.sequence LIMIT 2")?.query_map(params![owner,history.session,use_id,run.to_string(),key.attempt.to_string(),bind_u64(cut.through_sequence)?],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?.collect::<Result<_,_>>()?;
    if rows.len() != 1 {
        return Err(invalid(
            "original model tool call missing or ambiguous in captured cut",
        ));
    }
    let (version, bytes, digest, id) = rows.remove(0);
    check_bytes(&bytes, &digest)?;
    let recorded = decode_record(version, &bytes)?;
    if recorded.run != run || recorded.id.to_string() != id {
        return Err(invalid("original model tool call fact identity differs"));
    }
    match recorded.fact {
        Fact::ModelObserved {
            attempt,
            part: ModelPart::ToolCall { call },
            ..
        } if attempt == key.attempt && call.id == key.call => Ok(call),
        _ => Err(invalid("original model tool call source identity differs")),
    }
}
pub(super) fn tool_position(
    c: &Connection,
    history: &HistoryNamespace,
    cut: &HistoryCut,
    id: &str,
) -> Result<Option<maka_agent_facts::history::RowPosition>, StoreError> {
    let owner = check_cut(c, history, cut)?;
    let rows:Vec<u64>=c.prepare_cached("SELECT sequence FROM agent_session_history WHERE owner=? AND session=? AND tool_use_id=? AND tool_start=1 AND sequence<=? ORDER BY sequence LIMIT 2")?.query_map(params![owner,history.session,id,bind_u64(cut.through_sequence)?],|r|read_u64(r,0))?.collect::<Result<_,_>>()?;
    if rows.len() > 1 {
        return Err(invalid(
            "tool display identity has multiple original call sources",
        ));
    }
    Ok(rows
        .first()
        .map(|sequence| maka_agent_facts::history::RowPosition {
            source_sequence: *sequence,
            item_index: 0,
        }))
}
pub(super) fn tool_page(
    c: &Connection,
    history: &HistoryNamespace,
    cut: &HistoryCut,
    id: &str,
    after: u64,
    size: u32,
) -> Result<HistoryPage, StoreError> {
    let owner = check_cut(c, history, cut)?;
    let size = limit(size)?;
    if after > cut.through_sequence {
        return Err(invalid("tool history cursor exceeds captured cut"));
    }
    let mut positions:Vec<u64>=c.prepare_cached("SELECT sequence FROM agent_session_history WHERE owner=? AND session=? AND tool_use_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?")?.query_map(params![owner,history.session,id,bind_u64(after)?,bind_u64(cut.through_sequence)?,size+1],|r|read_u64(r,0))?.collect::<Result<_,_>>()?;
    let more = positions.len() > size as usize;
    positions.truncate(size as usize);
    let next = if more {
        positions.last().copied()
    } else {
        None
    };
    let mut items = Vec::with_capacity(positions.len());
    for sequence in positions {
        items.push(
            item(c, history, cut, sequence)?
                .ok_or_else(|| invalid("tool source index missing canonical fact"))?,
        );
    }
    Ok(HistoryPage { items, next })
}
pub(super) fn chunk(
    c: &Connection,
    history: &HistoryNamespace,
    cut: &HistoryCut,
    run: RunId,
    reference: &ContentRef,
    offset: u64,
    size: u32,
) -> Result<Vec<u8>, StoreError> {
    use std::io::{Read, Seek, SeekFrom};
    if offset > reference.bytes {
        return Err(invalid("invalid source chunk range"));
    }
    with_content(c, history, cut, run, reference, |blob| {
        blob.seek(SeekFrom::Start(offset))?;
        let amount = u64::from(size).min(reference.bytes - offset);
        let mut bytes = Vec::with_capacity(
            usize::try_from(amount).map_err(|_| invalid("source chunk size overflow"))?,
        );
        blob.take(amount).read_to_end(&mut bytes)?;
        if bytes.len() as u64 != amount {
            return Err(invalid("canonical source chunk truncated"));
        }
        Ok(bytes)
    })
}

fn mark_message(c: &Connection, session: &str, run: RunId, fact: &str) -> Result<(), StoreError> {
    let (version,bytes):(u32,Vec<u8>)=c.query_row("SELECT s.schema_version,b.payload FROM agent_run_specs s JOIN contents b ON b.id=s.spec_content_id WHERE s.run=? AND s.session=?",params![run.to_string(),session],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let spec: RunSpec = serde_json::from_slice(&bytes)?;
    if version != SCHEMA_VERSION || spec.schema_version != SCHEMA_VERSION {
        return Err(invalid("unsupported message Run schema"));
    }
    if !matches!(spec.trigger, Trigger::Message { .. }) {
        return Ok(());
    }
    let is_message:bool=c.query_row("SELECT json_extract(b.payload,'$.kind')='message' FROM agent_run_content p JOIN contents b ON b.id=p.content_id WHERE p.run=? AND b.content_sha256=? AND length(b.payload)=?",params![run.to_string(),spec.input.digest,bind_u64(spec.input.bytes)?],|r|r.get(0))?;
    if is_message {
        let changed=c.execute("UPDATE agent_session_history SET opening_message=1 WHERE owner=? AND session=? AND run=? AND kind='run_admitted' AND sequence=(SELECT sequence FROM agent_facts WHERE id=? AND run=? AND revision=1)",params![serde_json::to_string(&spec.owner)?,session,run.to_string(),fact,run.to_string()])?;
        if changed != 1 {
            return Err(invalid(
                "opening consumption has no original indexed Run admission",
            ));
        }
    }
    Ok(())
}
pub(super) fn first_message(
    c: &Connection,
    history: &HistoryNamespace,
    cut: &HistoryCut,
) -> Result<Option<RunSource>, StoreError> {
    let owner = check_cut(c, history, cut)?;
    let run:Option<String>=c.query_row("SELECT run FROM agent_session_history WHERE owner=? AND session=? AND opening_message=1 AND sequence<=? ORDER BY sequence LIMIT 1",params![owner,history.session,bind_u64(cut.through_sequence)?],|r|r.get(0)).optional()?;
    run.map(|run| run_source(c, history, identity(run)?))
        .transpose()
}

fn owned_metadata<T: DeserializeOwned>(
    c: &Connection,
    run: RunId,
    reference: &ContentRef,
) -> Result<T, StoreError> {
    reference.validate().map_err(invalid)?;
    let row:i64=c.query_row("SELECT b.id FROM agent_run_content p JOIN contents b ON b.id=p.content_id WHERE p.run=? AND b.content_sha256=? AND length(b.payload)=?",params![run.to_string(),reference.digest,bind_u64(reference.bytes)?],|r|r.get(0))?;
    decode_original(c, row, reference)
}
pub(super) fn decode_original<T: DeserializeOwned>(
    c: &Connection,
    row: i64,
    reference: &ContentRef,
) -> Result<T, StoreError> {
    read_blob(c, row, reference, |blob| {
        let mut reader = std::io::BufReader::new(blob);
        let value = serde_json::from_reader(&mut reader)?;
        std::io::copy(&mut reader, &mut std::io::sink())?;
        Ok(value)
    })
}

pub(super) fn fact_sequence(
    c: &Connection,
    history: &HistoryNamespace,
    cut: &HistoryCut,
    run: RunId,
    fact: FactId,
) -> Result<Option<u64>, StoreError> {
    let owner = check_cut(c, history, cut)?;
    let sequence:Option<u64>=c.query_row("SELECT h.sequence FROM agent_facts f JOIN agent_session_history h ON h.sequence=f.sequence WHERE f.id=? AND f.run=? AND h.owner=? AND h.session=? AND h.sequence<=?",params![fact.to_string(),run.to_string(),owner,history.session,bind_u64(cut.through_sequence)?],|r|read_u64(r,0)).optional()?;
    let Some(sequence) = sequence else {
        return Ok(None);
    };
    let item =
        item(c, history, cut, sequence)?.ok_or_else(|| invalid("fact source index missing"))?;
    if item.recorded.run != run || item.recorded.id != fact {
        return Err(invalid("fact source identity corrupt"));
    }
    Ok(Some(sequence))
}

fn result_source(fact: &Fact) -> bool {
    matches!(
        fact,
        Fact::ToolResultAccepted { .. }
            | Fact::LocalToolReturned { .. }
            | Fact::HostToolResultRecorded { .. }
            | Fact::ExternalEffect {
                event: maka_agent_facts::external_effects::ExternalEffectEvent::Returned { .. },
            }
            | Fact::Cell {
                event: maka_agent_facts::cells::CellEvent::ChildResultRecorded { .. }
                    | maka_agent_facts::cells::CellEvent::LocalChildReturned { .. }
            }
    )
}
pub(super) fn resolve_tool_result(
    c: &Connection,
    scope: &SessionHistory,
    cut: &HistoryCut,
    locator: &str,
) -> Result<Option<ToolResultSource>, StoreError> {
    validate_cut(c, &scope.namespace.owner, &scope.namespace.session, cut)?;
    if locator.is_empty() || locator.contains('\0') {
        return Err(invalid("invalid opaque tool result locator"));
    }
    let owner = serde_json::to_string(&scope.namespace.owner)?;
    let exact:Option<u64>=c.query_row("SELECT sequence FROM agent_session_history WHERE owner=? AND session=? AND result_source=1 AND fact_id=? AND sequence<=?",params![owner,scope.namespace.session,locator,bind_u64(cut.through_sequence)?],|r|read_u64(r,0)).optional()?;
    let sequence = if let Some(exact) = exact {
        exact
    } else {
        let upper = locator.char_indices().rev().find_map(|(offset, last)| {
            let mut next = last as u32 + 1;
            while next <= 0x10ffff && char::from_u32(next).is_none() {
                next += 1;
            }
            char::from_u32(next).map(|next| {
                let mut bound = locator[..offset].to_owned();
                bound.push(next);
                bound
            })
        });
        let rows:Vec<u64>=c.prepare_cached("SELECT sequence FROM agent_session_history WHERE owner=? AND session=? AND result_source=1 AND fact_id>=? AND (?4 IS NULL OR fact_id<?4) AND sequence<=?5 ORDER BY fact_id LIMIT 2")?.query_map(params![owner,scope.namespace.session,locator,upper,bind_u64(cut.through_sequence)?],|r|read_u64(r,0))?.collect::<Result<_,_>>()?;
        match rows.as_slice() {
            [] => return Ok(None),
            [only] => *only,
            _ => {
                return Err(invalid(
                    "ambiguous tool result locator in this fixed session cut",
                ));
            }
        }
    };
    let item = item(c, &scope.namespace, cut, sequence)?.ok_or_else(|| {
        invalid("tool result source index missing; explicit history rebuild required")
    })?;
    if !result_source(&item.recorded.fact) {
        return Err(invalid(
            "tool result index does not reference an original retained result fact",
        ));
    }
    let (use_id, _) = tool_locator(c, &item.recorded)?
        .ok_or_else(|| invalid("tool result has no original tool identity"))?;
    let names:Vec<String>=c.prepare_cached("SELECT tool_name FROM agent_session_history WHERE owner=? AND session=? AND run=? AND attempt IS ? AND tool_use_id=? AND tool_start=1 AND sequence<=? AND tool_name IS NOT NULL LIMIT 2")?.query_map(params![owner,scope.namespace.session,item.recorded.run.to_string(),item.scope.attempt.map(|id|id.to_string()),use_id,bind_u64(cut.through_sequence)?],|r|r.get(0))?.collect::<Result<_,_>>()?;
    match names.as_slice() {
        [name] => Ok(Some(ToolResultSource {
            item,
            tool_name: name.clone(),
        })),
        [] => Err(invalid(
            "original tool name source index missing; explicit history rebuild required",
        )),
        _ => Err(invalid("conflicting original tool name sources")),
    }
}
