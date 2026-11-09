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
use crate::fold::RunView;
use maka_agent_facts::{
    artifact::content_digest,
    model::{ModelPart, TextKind},
};
use maka_plugin_core::operation::{OperationCleanup, OperationOutcome, Receipt};
use rusqlite::{OptionalExtension, params};

pub(crate) fn index_fact(
    c: &Connection,
    spec: &RunSpec,
    fact: &RecordedFact,
    sequence: u64,
) -> Result<(), StoreError> {
    if fact.schema_version != SCHEMA_VERSION
        || spec.schema_version != SCHEMA_VERSION
        || fact.at.0 < 0
    {
        return Err(invalid("unsupported or invalid catalog fact"));
    }
    let sequence = sqlite_integer(sequence)?;
    if sequence == 0 {
        return Err(invalid("invalid zero catalog fact sequence"));
    }
    let historical = matches!(spec.backend, BackendSpec::Historical {});
    let owner = serde_json::to_string(&spec.owner)?;
    c.execute("INSERT INTO agent_catalog_sessions(owner,session,last_sequence,terminal_sequence) VALUES(?,?,?,?) ON CONFLICT(owner,session) DO UPDATE SET last_sequence=max(last_sequence,excluded.last_sequence),terminal_sequence=max(terminal_sequence,excluded.terminal_sequence)",
        params![owner,spec.session_id,sequence,if !historical && matches!(fact.fact,Fact::RunTerminated{..}) { sequence } else { 0 }])?;
    let admission: i64 = c.query_row(
        "SELECT sequence FROM agent_facts WHERE run=? AND revision=1",
        [fact.run.to_string()],
        |r| r.get(0),
    )?;
    if admission <= 0 {
        return Err(invalid("invalid catalog Run admission sequence"));
    }
    c.execute("INSERT INTO agent_catalog_runs(run,owner,session,admission_sequence) VALUES(?,?,?,?) ON CONFLICT(run) DO NOTHING",params![fact.run.to_string(),owner,spec.session_id,admission])?;
    if !historical && matches!(fact.fact, Fact::RunTerminated { .. }) {
        c.execute(
            "UPDATE agent_catalog_runs SET terminal_sequence=? WHERE run=?",
            params![sequence, fact.run.to_string()],
        )?;
    } else if !historical && fact.fact.is_late() {
        c.execute("UPDATE agent_catalog_runs SET late_sequence=max(late_sequence,?) WHERE run=? AND terminal_sequence>0 AND terminal_sequence<?",params![sequence,fact.run.to_string(),sequence])?;
    }
    let message = fact_message(spec, fact);
    if let Some((message, preview)) = message {
        c.execute("INSERT INTO agent_catalog_messages(owner,session,sequence,message,at,preview) VALUES(?,?,?,?,?,?) ON CONFLICT(owner,session,sequence) DO NOTHING",params![owner,spec.session_id,sequence,message,fact.at.0,preview])?;
    }
    Ok(())
}

pub(crate) fn fact_message(
    spec: &RunSpec,
    fact: &RecordedFact,
) -> Option<(String, Option<String>)> {
    if matches!(spec.backend, BackendSpec::Historical {}) {
        return None;
    }
    match &fact.fact {
        Fact::RunAdmitted { .. } => match &spec.trigger {
            Trigger::Message { message_id } => Some((message_id.clone(), None)),
            _ => None,
        },
        Fact::ModelObserved {
            part:
                ModelPart::Text {
                    text_kind: TextKind::Text,
                    text,
                    ..
                },
            ..
        } if !text.is_empty() => Some((
            fact.id.to_string(),
            Some(
                text.chunks()
                    .flat_map(str::chars)
                    .take(160)
                    .collect::<String>(),
            ),
        )),
        _ => None,
    }
}

fn run_flags(view: &RunView) -> (bool, bool, bool) {
    let blocked = view
        .blockers
        .values()
        .any(|b| b.decision.is_none() && b.resolved_by.is_none());
    let unknown = view.tools.values().any(|t| {
        matches!(
            &t.receipt,
            Some(
                Receipt::Recorded {
                    outcome: OperationOutcome::Unknown { .. },
                    ..
                } | Receipt::Unavailable { .. }
            )
        )
    }) || view.blockers.values().any(|b| {
        b.resolved_by.is_none()
            && b.decision.is_none()
            && matches!(
                b.reason,
                BlockerKind::OperationUnknown { .. }
                    | BlockerKind::ProviderEffectUnknown { .. }
                    | BlockerKind::OriginalAdmissionUnknown { .. }
                    | BlockerKind::ExternalTaskUnobservable { .. }
            )
    });
    let cleanup = view.tools.values().any(|t| {
        t.original.is_some()
            && !matches!(
                &t.receipt,
                Some(Receipt::Recorded {
                    cleanup: OperationCleanup::Confirmed,
                    ..
                })
            )
    });
    (blocked, unknown, cleanup)
}

pub(crate) fn run_status(view: &RunView, late_sequence: u64) -> RunStatus {
    let (blocked, unknown_effects, cleanup_pending) = run_flags(view);
    RunStatus {
        run: view.run,
        terminal: view.terminal.clone(),
        stopped: view.stopped,
        blocked,
        unknown_effects,
        cleanup_pending,
        late_sequence,
    }
}

pub(crate) fn index_run(c: &Connection, view: &RunView) -> Result<(), StoreError> {
    let (blocked, unknown, cleanup) = run_flags(view);
    let changed = c.execute("UPDATE agent_catalog_runs SET live=?,terminal=?,stopped=?,blocked=?,unknown_effects=?,cleanup_pending=? WHERE run=?",
        params![view.terminal.is_none(),view.terminal.as_ref().map(serde_json::to_string).transpose()?,view.stopped,blocked,unknown,cleanup,view.run.to_string()])?;
    if changed != 1 {
        return Err(invalid(
            "catalog Run fact index is absent; rebuild required",
        ));
    }
    Ok(())
}

fn fold_event(
    c: &Connection,
    owner: &str,
    session: &str,
    revision: u64,
    event: &Event,
) -> Result<(), StoreError> {
    c.execute("INSERT INTO agent_catalog_controls(owner,session,revision) VALUES(?,?,0) ON CONFLICT DO NOTHING",params![owner,session])?;
    match event {
        Event::ReadThrough {
            message_id,
            through_sequence,
        } => {
            c.execute("UPDATE agent_catalog_controls SET revision=?,read_through=max(read_through,?),read_message=? WHERE owner=? AND session=?",params![sqlite_integer(revision)?,sqlite_integer(*through_sequence)?,message_id,owner,session])?;
        }
        Event::LineageEstablished { lineage, .. } => {
            c.execute("UPDATE agent_catalog_controls SET revision=?,lineage=? WHERE owner=? AND session=?",params![sqlite_integer(revision)?,serde_json::to_string(lineage)?,owner,session])?;
        }
    }
    Ok(())
}

fn check_source(
    c: &Connection,
    catalog: &SessionCatalog,
    session: &str,
    lineage: &Lineage,
    source: &HistoryCut,
) -> Result<(), StoreError> {
    catalog.check_session(&source.session)?;
    if source.owner != catalog.owner || source.session == session {
        return Err(invalid("foreign lineage source"));
    }
    let parent = match lineage {
        Lineage::Branch { origin } => &origin.parent_session_id,
        Lineage::Revision {
            parent_session_id, ..
        } => parent_session_id,
    };
    if parent != &source.session {
        return Err(invalid("lineage parent differs from exact source cut"));
    }
    let digest = if source.through_sequence == 0 {
        content_digest(&serde_json::to_vec(&(
            "maka.session-history.v1",
            &source.owner,
            &source.session,
        ))?)
    } else {
        c.query_row("SELECT prefix_digest FROM agent_session_history WHERE owner=? AND session=? AND sequence=?",params![catalog.owner_key()?,source.session,sqlite_integer(source.through_sequence)?],|r|r.get::<_,String>(0)).optional()?.ok_or_else(||invalid("lineage canonical source cut unavailable"))?
    };
    if digest != source.digest {
        return Err(StoreError::EventConflict);
    }
    Ok(())
}

pub(super) fn control(
    c: &Connection,
    catalog: &SessionCatalog,
    session: &str,
    command: ControlCommand,
) -> Result<(u64, bool), StoreError> {
    catalog.check_session(session)?;
    sqlite_integer(command.expected_revision)?;
    if command.at.0 < 0 {
        return Err(invalid("invalid catalog decision timestamp"));
    }
    let owner = catalog.owner_key()?;
    let encoded = serde_json::to_string(&command)?;
    let previous:Option<(u32,i64,String)> = c.query_row("SELECT schema_version,revision,command_json FROM agent_catalog_events WHERE owner=? AND session=? AND id=?",params![owner,session,command.id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    if let Some((version, revision, original)) = previous {
        if version != CATALOG_SCHEMA_VERSION {
            return Err(invalid("unsupported catalog decision schema"));
        }
        if original != encoded {
            return Err(StoreError::EventConflict);
        }
        return Ok((unsigned_integer(revision)?, false));
    }
    let visible:bool = c.query_row("SELECT EXISTS(SELECT 1 FROM session_control s JOIN session_creations r ON r.session_id=s.id WHERE s.id=? AND r.ready=1 AND r.visible=1 AND NOT EXISTS(SELECT 1 FROM session_retirements d WHERE d.session_id=s.id AND d.remove_session=1))",[session],|r|r.get(0))?;
    if !visible {
        return Err(StoreError::SessionNotFound);
    }
    let current: Option<(i64, Option<String>)> = c
        .query_row(
            "SELECT revision,lineage FROM agent_catalog_controls WHERE owner=? AND session=?",
            params![owner, session],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (revision, lineage) = current.unwrap_or((0, None));
    let revision = unsigned_integer(revision)?;
    let canonical_revision: i64 = c.query_row(
        "SELECT COALESCE(MAX(revision),0) FROM agent_catalog_events WHERE owner=? AND session=?",
        params![owner, session],
        |r| r.get(0),
    )?;
    if unsigned_integer(canonical_revision)? != revision {
        return Err(invalid(
            "catalog decision index absent; explicit rebuild required",
        ));
    }
    if command.expected_revision != revision {
        return Err(StoreError::RevisionConflict {
            expected: command.expected_revision.to_string(),
            actual: revision.to_string(),
        });
    }
    let event = match &command.edit {
        ControlEdit::MarkRead { message_id } => {
            let tail = query::records_in_snapshot(c, catalog, &[session.to_owned()])?
                .into_iter()
                .next()
                .and_then(|record| record.last_message)
                .map(|message| message.tail_message_id);
            if tail.as_deref() != Some(message_id) {
                return Err(invalid(
                    "read marker must name the current durable message tail",
                ));
            }
            let through_sequence: i64 = c.query_row(
                "SELECT last_sequence FROM agent_catalog_sessions WHERE owner=? AND session=?",
                params![owner, session],
                |r| r.get(0),
            )?;
            Event::ReadThrough {
                message_id: message_id.clone(),
                through_sequence: unsigned_integer(through_sequence)?,
            }
        }
        ControlEdit::EstablishLineage {
            lineage: requested,
            source,
        } => {
            check_source(c, catalog, session, requested, source)?;
            if lineage.is_some() {
                return Err(StoreError::EventConflict);
            }
            Event::LineageEstablished {
                lineage: requested.clone(),
                source: source.clone(),
            }
        }
    };
    let next = revision
        .checked_add(1)
        .filter(|r| *r <= 9_007_199_254_740_991)
        .ok_or_else(|| invalid("catalog decision revision exhausted"))?;
    c.execute("INSERT INTO agent_catalog_events(owner,session,revision,id,at,schema_version,command_json,event_json) VALUES(?,?,?,?,?,?,?,?)",params![owner,session,sqlite_integer(next)?,command.id.to_string(),command.at.0,CATALOG_SCHEMA_VERSION,encoded,serde_json::to_string(&event)?])?;
    fold_event(c, &owner, session, next, &event)?;
    Ok((next, true))
}

pub(super) fn rebuild(
    c: &Connection,
    catalog: &SessionCatalog,
    session: &str,
) -> Result<(), StoreError> {
    catalog.check_session(session)?;
    let owner = catalog.owner_key()?;
    for table in [
        "agent_catalog_controls",
        "agent_catalog_sessions",
        "agent_catalog_messages",
        "agent_catalog_runs",
    ] {
        c.execute(
            &format!("DELETE FROM {table} WHERE owner=? AND session=?"),
            params![owner, session],
        )?;
    }
    // Explicit repair reads canonical facts in bounded pages, never the former
    // Root runtime_events or a disposable Run/catalog projection.
    let mut run_cursor = String::new();
    loop {
        let runs:Vec<(String,u32,Vec<u8>)> = c.prepare_cached("SELECT r.run,r.schema_version,b.payload FROM agent_run_specs r JOIN contents b ON b.id=r.spec_content_id WHERE r.owner=? AND r.session=? AND r.run>? ORDER BY r.run LIMIT 32")?.query_map(params![owner,session,run_cursor],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect::<Result<_,_>>()?;
        if runs.is_empty() {
            break;
        }
        for (run, version, bytes) in runs {
            if version != SCHEMA_VERSION {
                return Err(invalid("unsupported catalog Run schema"));
            }
            let spec: RunSpec = serde_json::from_slice(&bytes)?;
            let run_id: RunId = serde_json::from_value(serde_json::Value::String(run.clone()))?;
            if spec.owner != catalog.owner
                || spec.session_id != session
                || spec.schema_version != SCHEMA_VERSION
            {
                return Err(StoreError::EventConflict);
            }
            let mut view = RunView::admitted(run_id, spec.clone())?;
            let mut sequence = 0;
            loop {
                let facts:Vec<(i64,u32,Vec<u8>)> = c.prepare_cached("SELECT f.sequence,f.schema_version,b.payload FROM agent_facts f JOIN contents b ON b.id=f.body_content_id WHERE f.run=? AND f.sequence>? ORDER BY f.sequence LIMIT 128")?.query_map(params![run,sequence],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect::<Result<_,_>>()?;
                if facts.is_empty() {
                    break;
                }
                for (seq, version, bytes) in facts {
                    if version != SCHEMA_VERSION {
                        return Err(invalid("unsupported catalog fact schema"));
                    }
                    let fact: RecordedFact = serde_json::from_slice(&bytes)?;
                    if fact.run != run_id {
                        return Err(StoreError::EventConflict);
                    }
                    view.apply(&fact)?;
                    index_fact(c, &spec, &fact, unsigned_integer(seq)?)?;
                    sequence = seq;
                }
            }
            index_run(c, &view)?;
            run_cursor = run;
        }
    }
    let mut revision = 0;
    loop {
        let events:Vec<(i64,u32,String)> = c.prepare_cached("SELECT revision,schema_version,event_json FROM agent_catalog_events WHERE owner=? AND session=? AND revision>? ORDER BY revision LIMIT 128")?.query_map(params![owner,session,revision],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect::<Result<_,_>>()?;
        if events.is_empty() {
            break;
        }
        for (rev, version, json) in events {
            if version != CATALOG_SCHEMA_VERSION || rev != revision + 1 {
                return Err(invalid("unsupported or discontinuous catalog journal"));
            }
            fold_event(
                c,
                &owner,
                session,
                unsigned_integer(rev)?,
                &serde_json::from_str(&json)?,
            )?;
            revision = rev;
        }
    }
    c.execute(
        "UPDATE agent_catalog_revision SET revision=revision+1 WHERE singleton=1",
        [],
    )?;
    Ok(())
}
