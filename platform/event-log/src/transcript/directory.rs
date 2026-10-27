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

//! Complete metadata on the canonical writer; bodies are optional read caches.
use super::{emit, evidence, read};
use crate::StoreError;
use maka_agent_facts::{
    event::{Fact, RuntimeEvent},
    model::ModelEvent,
};
use maka_presentation::{ProjectionError, Row};
use rusqlite::{Connection as RawConnection, OptionalExtension, params};
use sqlx::SqliteConnection;
use std::collections::HashMap;

const COLUMNS: &str = "source_sequence,item_index,turn_id,message_id,timestamp,role,has_thinking,user_origin,state_status,tool_use_id,tool_name,tool_origin,parent_tool_call_id,parent_operation_id,has_args,result_valid,settlement,is_error,content_kind,tool_title,presentation,duration_ms";
pub(crate) const RECALL_BODY: &str = super::history::BODY;
const INSERT: &str = r#"WITH payload(value) AS (VALUES(?6)) INSERT INTO transcript_directory
 (session_id,source_sequence,item_index,turn_id,message_id,timestamp,role,has_thinking,user_origin,state_status,tool_use_id,tool_name,tool_origin,parent_tool_call_id,parent_operation_id,has_args,result_valid,settlement,is_error,content_kind,tool_title,presentation,duration_ms)
 SELECT ?1,?2,?3,?4,?5,json_extract(value,'$.ts'),json_extract(value,'$.type'),
 json_type(value,'$.thinking.text') IS 'text',
 CASE WHEN json_extract(value,'$.type')='user' THEN value -> '$.origin' END,
 CASE WHEN json_extract(value,'$.type')='turn_state' THEN json_extract(value,'$.status') END,
 CASE json_extract(value,'$.type') WHEN 'tool_call' THEN ?5 ELSE json_extract(value,'$.toolUseId') END,
 json_extract(value,'$.toolName'),
 CASE WHEN json_extract(value,'$.type') IN ('tool_call','tool_activity','tool_result') THEN json_extract(value,'$.origin') END,
 json_extract(value,'$.parentToolCallId'),json_extract(value,'$.parentOperationId'),
 CASE WHEN json_extract(value,'$.type')='tool_call' THEN json_type(value,'$.args') IS NOT NULL END,
 CASE WHEN json_extract(value,'$.type')='tool_result' THEN json_type(value,'$.isError') IN ('true','false') AND json_type(value,'$.content')='object' END,
 json_extract(value,'$.settlement'),json_extract(value,'$.isError'),json_extract(value,'$.content.kind'),
 json_extract(value,'$.title'),json_extract(value,'$.presentation'),json_extract(value,'$.durationMs') FROM payload"#;

/// No repair/replay here: absence is meaningful only after full installation.
pub(super) async fn check_read(
    connection: &mut SqliteConnection,
    session: &str,
    through: u64,
) -> Result<(), StoreError> {
    read::sql_number(through)?;
    evidence::fence(connection, through).await?;
    let failure: Option<(i64, String, Option<String>)> = sqlx::query_as("SELECT source_sequence,category,reason FROM transcript_failures WHERE session_id=?1 AND source_sequence<=?2 ORDER BY source_sequence LIMIT 1")
        .bind(session).bind(read::sql_number(through)?).fetch_optional(connection).await?;
    if let Some((source, category, reason)) = failure {
        if category == "namespace" {
            return Err(StoreError::TranscriptConflict);
        }
        let detail = format!(
            "history source {source}: {category}: {}",
            reason.as_deref().unwrap_or("source unavailable")
        );
        return Err(StoreError::InvalidTransition(detail));
    }
    Ok(())
}

fn optional_failure(error: &StoreError) -> Option<(&'static str, &str)> {
    match error {
        StoreError::Projection(ProjectionError::Invalid(reason)) => Some(("invalid", reason)),
        StoreError::Projection(ProjectionError::Unsupported(reason)) => {
            Some(("unsupported", reason))
        }
        StoreError::Projection(ProjectionError::TooLarge) | StoreError::PrefixTooLarge => {
            Some(("too_large", "presentation exceeds its byte limit"))
        }
        StoreError::Projection(ProjectionError::OutOfRange) => Some((
            "out_of_range",
            "presentation timestamp or sequence exceeds the wire range",
        )),
        StoreError::TranscriptConflict => Some((
            "reference",
            "derived transcript reference conflicts with immutable ownership",
        )),
        StoreError::InvalidTransition(reason)
            if reason == "missing or inconsistent durable tool payload" =>
        {
            Some(("raw_binding", reason))
        }
        // Storage errors, serde failures, unexpected invariants and panics are not view failures.
        _ => None,
    }
}

pub(crate) async fn record_source(
    connection: &mut SqliteConnection,
    session: &str,
    source: u64,
) -> Result<(), StoreError> {
    let sequence = read::sql_number(source)?;
    let session = session.to_owned();
    crate::connection::worker_query(connection, move |worker| Box::pin(async move {
        let done: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM transcript_directory WHERE session_id=?1 AND source_sequence=?2 UNION ALL SELECT 1 FROM transcript_failures WHERE session_id=?1 AND source_sequence=?2)")
            .bind(&session).bind(sequence).fetch_one(&mut *worker).await?;
        if done {
            return Ok(());
        }
        let rows = emit::source_on_worker(worker, &session, source).await;
        // SAFETY: exclusive worker-local borrow; the wrapper and statements end here.
        let db = unsafe { RawConnection::from_handle(worker.as_raw_handle().as_ptr()) }?;
        record_rows(&db, &session, sequence, rows)
    })).await
}

pub(crate) async fn record_event(
    connection: &mut SqliteConnection,
    event: &RuntimeEvent,
    source: u64,
) -> Result<(), StoreError> {
    let eligible = match &event.fact {
        Fact::MessageImported { .. }
        | Fact::InvocationOpened { .. }
        | Fact::MessageSteered { .. }
        | Fact::ModelCompleted { .. }
        | Fact::ModelInterrupted { .. }
        | Fact::InvocationEnded { .. }
        | Fact::ContextCheckpointRecorded { .. }
        | Fact::ToolDispatched { .. }
        | Fact::ToolRejected { .. }
        | Fact::ToolSettled { .. }
        | Fact::ExecutorCompleted { .. } => true,
        Fact::ModelObserved { event, .. } => match event {
            ModelEvent::PartFinished { .. }
            | ModelEvent::Source(_)
            | ModelEvent::ToolCall(_)
            | ModelEvent::ProviderToolResult { .. } => true,
            ModelEvent::PartStarted { .. }
            | ModelEvent::PartDelta { .. }
            | ModelEvent::ToolInputStarted { .. }
            | ModelEvent::ToolInputDelta { .. }
            | ModelEvent::ToolInputFinished { .. }
            | ModelEvent::ResponseMetadata { .. }
            | ModelEvent::Finished { .. } => false,
        },
        Fact::ExecutorObserved { output } => match output {
            maka_agent_facts::executor::Output::ToolStart { .. }
            | maka_agent_facts::executor::Output::ToolResult { .. } => true,
            maka_agent_facts::executor::Output::OutputDelta { .. }
            | maka_agent_facts::executor::Output::ThinkingDelta { .. }
            | maka_agent_facts::executor::Output::ToolProgress { .. } => false,
        },
        Fact::ExecutorStarted { .. }
        | Fact::ModelRequested { .. }
        | Fact::ContextCompactionWaiting
        | Fact::ToolResultArchived { .. }
        | Fact::ToolOperationObserved { .. }
        | Fact::ToolNotified { .. } => false,
    };
    if eligible {
        record_source(connection, &event.invocation.session_id, source).await?;
    }
    Ok(())
}

fn record_on_handle(db: &RawConnection, session: &str, source: i64) -> Result<(), StoreError> {
    let done: bool = db.prepare_cached("SELECT EXISTS(SELECT 1 FROM transcript_directory WHERE session_id=?1 AND source_sequence=?2 UNION ALL SELECT 1 FROM transcript_failures WHERE session_id=?1 AND source_sequence=?2)")?
        .query_row(params![session,source], |row| row.get(0))?;
    if done {
        return Ok(());
    }
    record_rows(
        db,
        session,
        source,
        emit::source_on_handle(db, session, source),
    )
}

fn record_rows(
    db: &RawConnection,
    session: &str,
    source: i64,
    rows: Result<Vec<Row>, StoreError>,
) -> Result<(), StoreError> {
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => {
            let Some((category, reason)) = optional_failure(&error) else {
                return Err(error);
            };
            db.prepare_cached("INSERT INTO transcript_failures(session_id,source_sequence,category,reason) VALUES(?1,?2,?3,?4)")?
                .execute(params![session,source,category,reason])?;
            return Ok(());
        }
    };
    let mut ids = HashMap::new();
    for row in &rows {
        let (sequence, item) = read::sql_position(row.position)?;
        let prior: Option<(i64,i64)> = db.prepare_cached("SELECT source_sequence,item_index FROM transcript_directory WHERE session_id=?1 AND message_id=?2")?
            .query_row(params![session,&row.message.id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
        let prior = prior.or_else(|| ids.insert(row.message.id.as_str(), (sequence, item)));
        if let Some((claimed_source, claimed_item)) = prior {
            db.prepare_cached("INSERT INTO transcript_failures(session_id,source_sequence,category,message_id,claimant_source_sequence,claimant_item_index,attempted_item_index,reason) VALUES(?1,?2,'namespace',?3,?4,?5,?6,'message identity is already claimed')")?
                .execute(params![session,source,&row.message.id,claimed_source,claimed_item,item])?;
            return Ok(());
        }
    }
    // Buffer all serialized values before any metadata write; failed sources publish no partial rows.
    let encoded = rows
        .iter()
        .map(|row| serde_json::to_vec(&row.message))
        .collect::<Result<Vec<_>, _>>()?;
    for (row, payload) in rows.iter().zip(encoded) {
        let (sequence, item) = read::sql_position(row.position)?;
        db.prepare_cached(INSERT)?.execute(params![
            session,
            sequence,
            item,
            &row.message.turn_id,
            &row.message.id,
            &payload
        ])?;
        crate::recall::maintenance::record(db, session, row.position, &payload)?;
    }
    Ok(())
}

fn index_session(db: &RawConnection, session: &str) -> Result<(), StoreError> {
    let sql = format!(
        "SELECT e.sequence FROM runtime_events e WHERE e.event_session=?1 AND e.sequence>?2 AND {} UNION SELECT e.sequence FROM session_history_members h JOIN runtime_events e ON e.sequence=h.sequence WHERE h.session_id=?1 AND e.sequence>?2 AND {} ORDER BY sequence LIMIT 1",
        emit::ELIGIBLE,
        emit::ELIGIBLE
    );
    let mut after = 0i64;
    loop {
        let source: Option<i64> = db
            .prepare_cached(&sql)?
            .query_row(params![session, after], |r| r.get(0))
            .optional()?;
        let Some(source) = source else { break };
        record_on_handle(db, session, source)?;
        after = source;
    }
    Ok(())
}

/// Membership and artifact retention are already frozen by the caller's copy transaction.
pub(crate) async fn copy(
    connection: &mut SqliteConnection,
    source: &str,
    target: &str,
    through: u64,
) -> Result<(), StoreError> {
    let through = read::sql_number(through)?;
    let (source, target) = (source.to_owned(), target.to_owned());
    connection
        .run_on_worker(move |handle| {
            // SAFETY: exclusive original-writer callback; temporary relations never escape.
            let db = unsafe { RawConnection::from_handle(handle.as_ptr()) }?;
            db.set_prepared_statement_cache_capacity(100);
            copy_on_handle(&db, &source, &target, through)?;
            rebuild_recall(&db, &target)
        })
        .await?
}

fn rebuild_recall(db: &RawConnection, session: &str) -> Result<(), StoreError> {
    db.execute(
        "DELETE FROM recall_documents WHERE session_id=?1",
        [session],
    )?;
    let mut after = 0i64;
    loop {
        let source: Option<i64> = db
            .prepare_cached("SELECT MIN(source_sequence) FROM transcript_directory WHERE session_id=?1 AND source_sequence>?2")?
            .query_row(params![session, after], |row| row.get(0))?;
        let Some(source) = source else { break };
        for row in emit::source_on_handle(db, session, source)? {
            let (sequence, item) = read::sql_position(row.position)?;
            let included: bool = db
                .prepare_cached("SELECT EXISTS(SELECT 1 FROM transcript_directory WHERE session_id=?1 AND source_sequence=?2 AND item_index=?3)")?
                .query_row(params![session, sequence, item], |row| row.get(0))?;
            if included {
                crate::recall::maintenance::record(
                    db,
                    session,
                    row.position,
                    &serde_json::to_vec(&row.message)?,
                )?;
            }
        }
        after = source;
    }
    Ok(())
}

fn copy_on_handle(
    db: &RawConnection,
    source: &str,
    target: &str,
    through: i64,
) -> Result<(), StoreError> {
    let occupied: bool = db.prepare_cached("SELECT EXISTS(SELECT 1 FROM transcript_directory WHERE session_id=?1 UNION ALL SELECT 1 FROM transcript_failures WHERE session_id=?1)")?.query_row([target],|row| row.get(0))?;
    let incoming_rows = format!(
        "SELECT ?1,{COLUMNS} FROM transcript_directory d WHERE d.session_id=?2 AND d.source_sequence<=?3 AND EXISTS(SELECT 1 FROM session_history_members h WHERE h.session_id=?1 AND h.sequence=d.source_sequence)"
    );
    let incoming_failures = "SELECT ?1,f.source_sequence,f.category,f.message_id,f.claimant_source_sequence,f.claimant_item_index,f.attempted_item_index,f.reason FROM transcript_failures f WHERE f.session_id=?2 AND f.source_sequence<=?3 AND EXISTS(SELECT 1 FROM session_history_members h WHERE h.session_id=?1 AND h.sequence=f.source_sequence)";
    if !occupied {
        db.prepare_cached(&format!("INSERT INTO transcript_directory {incoming_rows}"))?
            .execute(params![target, source, through])?;
        db.prepare_cached(&format!(
            "INSERT INTO transcript_failures {incoming_failures}"
        ))?
        .execute(params![target, source, through])?;
        return Ok(());
    }
    // Bare target facts need not have session_control. Merge metadata in source
    // order; a display conflict must not become a new canonical copy rejection.
    let (mut made_rows, mut made_failures) = (false, false);
    let result = (|| {
        db.execute(
            "CREATE TEMP TABLE transcript_copy_rows AS SELECT * FROM transcript_directory WHERE 0",
            [],
        )?;
        made_rows = true;
        db.execute("CREATE TEMP TABLE transcript_copy_failures AS SELECT * FROM transcript_failures WHERE 0",[])?;
        made_failures = true;
        db.execute("CREATE INDEX temp.transcript_copy_rows_position ON transcript_copy_rows(source_sequence,item_index)",[])?;
        db.execute("CREATE INDEX temp.transcript_copy_rows_message ON transcript_copy_rows(message_id,source_sequence,item_index)",[])?;
        db.execute("CREATE INDEX temp.transcript_copy_failures_source ON transcript_copy_failures(source_sequence,category)",[])?;
        db.execute("INSERT INTO temp.transcript_copy_rows SELECT * FROM transcript_directory WHERE session_id=?1",[target])?;
        db.prepare_cached(&format!(
            "INSERT INTO temp.transcript_copy_rows {incoming_rows}"
        ))?
        .execute(params![target, source, through])?;
        db.execute("INSERT INTO temp.transcript_copy_failures SELECT * FROM transcript_failures WHERE session_id=?1",[target])?;
        db.prepare_cached(&format!(
            "INSERT INTO temp.transcript_copy_failures {incoming_failures}"
        ))?
        .execute(params![target, source, through])?;
        // Only previously unpublished namespace-failure groups need full S
        // emission again. This bad-data work may grow with failed sources F.
        let temporary_insert = INSERT.replace(
            "INSERT INTO transcript_directory",
            "INSERT INTO temp.transcript_copy_rows",
        );
        let mut after = 0i64;
        loop {
            let failed: Option<i64> = db.prepare_cached("SELECT source_sequence FROM temp.transcript_copy_failures WHERE category='namespace' AND source_sequence>?1 ORDER BY source_sequence LIMIT 1")?.query_row([after],|r|r.get(0)).optional()?;
            let Some(sequence) = failed else { break };
            match emit::source_on_handle(db, target, sequence) {
                Ok(rows) if !rows.is_empty() => {
                    let encoded = rows
                        .iter()
                        .map(|r| serde_json::to_vec(&r.message))
                        .collect::<Result<Vec<_>, _>>()?;
                    db.execute(
                        "DELETE FROM temp.transcript_copy_rows WHERE source_sequence=?1",
                        [sequence],
                    )?;
                    for (row, payload) in rows.iter().zip(encoded) {
                        let (sequence, item) = read::sql_position(row.position)?;
                        db.prepare_cached(&temporary_insert)?.execute(params![
                            target,
                            sequence,
                            item,
                            &row.message.turn_id,
                            &row.message.id,
                            payload
                        ])?;
                    }
                    db.execute("DELETE FROM temp.transcript_copy_failures WHERE source_sequence=?1 AND category='namespace'",[sequence])?;
                }
                Ok(_) => {} // An unproved empty reconstruction cannot erase a known conflict.
                Err(error) => {
                    let Some((category, reason)) = optional_failure(&error) else {
                        return Err(error);
                    };
                    db.execute("UPDATE temp.transcript_copy_failures SET category=?2,reason=?3 WHERE source_sequence=?1 AND category='namespace'",params![sequence,category,reason])?;
                }
            }
            after = sequence;
        }
        db.execute(
            "DELETE FROM transcript_directory WHERE session_id=?1",
            [target],
        )?;
        db.execute(
            "DELETE FROM transcript_failures WHERE session_id=?1",
            [target],
        )?;
        // An earlier inherited ID may replace a later cached bare claimant.
        db.execute(
            "DELETE FROM transcript_cache.rows WHERE session_id=?1",
            [target],
        )?;
        db.execute(
            "DELETE FROM transcript_cache.text WHERE session_id=?1",
            [target],
        )?;
        let mut after = 0i64;
        loop {
            let next: Option<i64> = db.prepare_cached("SELECT source_sequence FROM (SELECT source_sequence FROM temp.transcript_copy_rows WHERE source_sequence>?1 UNION SELECT source_sequence FROM temp.transcript_copy_failures WHERE source_sequence>?1) ORDER BY source_sequence LIMIT 1")?.query_row([after],|r|r.get(0)).optional()?;
            let Some(sequence) = next else { break };
            let failed: bool = db.prepare_cached("SELECT EXISTS(SELECT 1 FROM temp.transcript_copy_failures WHERE source_sequence=?1)")?.query_row([sequence],|r|r.get(0))?;
            if failed {
                db.execute("INSERT INTO transcript_failures SELECT * FROM temp.transcript_copy_failures WHERE source_sequence=?1 ORDER BY rowid LIMIT 1",[sequence])?;
            } else {
                let collision: Option<(String,i64,i64,i64)> = db.prepare_cached("SELECT message_id,claimed_source,claimed_item,attempted_item FROM (SELECT a.message_id,b.source_sequence AS claimed_source,b.item_index AS claimed_item,a.item_index AS attempted_item FROM temp.transcript_copy_rows a JOIN transcript_directory b ON b.session_id=a.session_id AND b.message_id=a.message_id WHERE a.source_sequence=?1 UNION ALL SELECT a.message_id,b.source_sequence,b.item_index,a.item_index FROM temp.transcript_copy_rows a JOIN temp.transcript_copy_rows b ON a.source_sequence=b.source_sequence AND a.message_id=b.message_id AND b.item_index<a.item_index WHERE a.source_sequence=?1) ORDER BY attempted_item LIMIT 1")?.query_row([sequence],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
                if let Some((id, claim_source, claim_item, attempt_item)) = collision {
                    db.execute("INSERT INTO transcript_failures(session_id,source_sequence,category,message_id,claimant_source_sequence,claimant_item_index,attempted_item_index,reason) VALUES(?1,?2,'namespace',?3,?4,?5,?6,'message identity is already claimed')",params![target,sequence,id,claim_source,claim_item,attempt_item])?;
                } else {
                    db.execute("INSERT INTO transcript_directory SELECT DISTINCT * FROM temp.transcript_copy_rows WHERE source_sequence=?1 ORDER BY item_index",[sequence])?;
                }
            }
            after = sequence;
        }
        Ok(())
    })();
    // Attempt every cleanup even if another DROP fails. The caller's enclosing
    // transaction also rolls back both metadata and temporary DDL on error.
    let failures_cleanup = if made_failures {
        db.execute("DROP TABLE temp.transcript_copy_failures", [])
    } else {
        Ok(0)
    };
    let rows_cleanup = if made_rows {
        db.execute("DROP TABLE temp.transcript_copy_rows", [])
    } else {
        Ok(0)
    };
    failures_cleanup?;
    rows_cleanup?;
    result
}

/// Bundle facts, frozen memberships and raw/artifact materials must all be present first.
pub(crate) async fn index_imported_sessions(
    connection: &mut SqliteConnection,
    sessions: &[String],
) -> Result<(), StoreError> {
    let sessions = sessions.to_vec();
    connection.run_on_worker(move |handle| {
        // SAFETY: owned writer callback, with no borrowed SQLite state escaping.
        let db = unsafe { RawConnection::from_handle(handle.as_ptr()) }?;
        db.set_prepared_statement_cache_capacity(100);
        for session in sessions {
            let removed: bool = db.prepare_cached("SELECT EXISTS(SELECT 1 FROM session_retirements WHERE session_id=?1 AND remove_session=1 AND completed=1 UNION ALL SELECT 1 FROM session_history_copies WHERE session_id=?1 AND state='abandoned')")?.query_row([&session], |r| r.get(0))?;
            if !removed { index_session(&db,&session)?; }
        }
        Ok::<(),StoreError>(())
    }).await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EventLog;
    use maka_agent_facts::event::{
        EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent,
    };
    use sqlx::Connection;

    fn event(session: &str, invocation: &str, id: &str, fact: Fact) -> RuntimeEvent {
        let mut event = RuntimeEvent::new(
            Invocation {
                session_id: session.into(),
                turn_id: invocation.into(),
                run_id: invocation.into(),
                invocation_id: invocation.into(),
            },
            fact,
        );
        event.id = id.into();
        event.recorded_at = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1);
        event
    }

    #[tokio::test]
    async fn public_append_keeps_original_ordinals_and_reopen_needs_no_body_cache() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("directory.sqlite");
        let log = EventLog::open(&path).await.unwrap();
        let open = EventWrite::plain(event(
            "bare",
            "turn",
            "open",
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    source_messages: Vec::new(),
                    content: "literal user".into(),
                    request_fingerprint: None,
                },
            },
        ))
        .unwrap();
        let first = log.append(&open).await.unwrap();
        let end = log
            .append(
                &EventWrite::plain(event(
                    "bare",
                    "turn",
                    "end",
                    Fact::InvocationEnded {
                        outcome: InvocationOutcome::Completed,
                    },
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        log.connection.run(move |db| Box::pin(async move {
            check_read(db,"bare",end).await?;
            let rows: Vec<(i64,String)> = sqlx::query_as("SELECT item_index,role FROM transcript_directory WHERE session_id='bare' AND source_sequence=? ORDER BY item_index").bind(first as i64).fetch_all(&mut *db).await?;
            assert_eq!(rows,vec![(0,"user".into()),(1,"turn_state".into())]);
            assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM transcript_cache.rows").fetch_one(&mut *db).await?,0);
            Ok(())
        })).await.unwrap();
        log.close().await.unwrap();
        let log = EventLog::open(&path).await.unwrap();
        log.connection
            .run(move |db| {
                Box::pin(async move {
                    check_read(db, "bare", end).await?;
                    assert_eq!(
                        sqlx::query_scalar::<_, i64>(
                            "SELECT count(*) FROM transcript_directory WHERE session_id='bare'"
                        )
                        .fetch_one(&mut *db)
                        .await?,
                        3
                    );
                    assert_eq!(
                        sqlx::query_scalar::<_, String>(
                            "SELECT d.body FROM recall_terms JOIN recall_documents d ON d.id=recall_terms.rowid WHERE recall_terms MATCH ?1 AND d.session_id='bare'"
                        )
                        .bind(crate::recall::grams("literal"))
                        .fetch_all(&mut *db)
                        .await?,
                        ["literal user"]
                    );
                    assert_eq!(
                        sqlx::query_scalar::<_, i64>(
                            "SELECT count(*) FROM recall_documents WHERE session_id='bare'"
                        )
                        .fetch_one(&mut *db)
                        .await?,
                        3
                    );
                    let mut tx = db.begin().await?;
                    sqlx::query("DELETE FROM transcript_directory WHERE session_id='bare'")
                        .execute(&mut *tx)
                        .await?;
                    assert_eq!(
                        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM recall_terms")
                            .fetch_one(&mut *tx)
                            .await?,
                        0
                    );
                    tx.rollback().await?;
                    Ok(())
                })
            })
            .await
            .unwrap();
        log.close().await.unwrap();
    }

    #[tokio::test]
    async fn accepted_projection_error_is_recorded_without_rejecting_fact() {
        use maka_agent_facts::model::{
            ModelEvent, ModelFinishReason, ModelStep, ModelUsage, TextKind,
        };
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("view-failure.sqlite");
        let log = EventLog::open(&path).await.unwrap();
        let facts = vec![
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    source_messages: Vec::new(),
                    content: "literal".into(),
                    request_fingerprint: None,
                },
            },
            Fact::ModelRequested {
                context_breakdown: None,
                item_acceptance: false,
                purpose: maka_agent_facts::context::ModelPurpose::Main,
                context: None,
                checkpoint_event_id: None,
                step_id: "step".into(),
                model_id: "model".into(),
                source_scope: maka_agent_facts::event::LogScope::Root,
                source_high_water: 0,
                source_digest: "fixture".into(),
                effective_source_digest: None,
                input_digest: "input".into(),
                route_identity: "route".into(),
            },
            Fact::ModelObserved {
                step_id: "step".into(),
                event: ModelEvent::PartStarted {
                    id: "part".into(),
                    text_kind: TextKind::Text,
                    provider_options: None,
                },
            },
            Fact::ModelObserved {
                step_id: "step".into(),
                event: ModelEvent::PartDelta {
                    id: "part".into(),
                    text: "preserved observation".into(),
                    provider_options: None,
                },
            },
            Fact::ModelObserved {
                step_id: "step".into(),
                event: ModelEvent::PartFinished {
                    id: "part".into(),
                    provider_options: None,
                },
            },
            Fact::ModelCompleted {
                step_id: "step".into(),
                output: ModelStep {
                    parts: Vec::new(),
                    finish_reason: ModelFinishReason::Stop,
                    usage: ModelUsage::default(),
                    provider_options: None,
                    response_id: None,
                    model: None,
                    timestamp: None,
                },
            },
        ];
        let mut through = 0;
        for (i, fact) in facts.into_iter().enumerate() {
            through = log
                .append(
                    &EventWrite::plain(event("bare", "bad", &format!("bad-{i}"), fact)).unwrap(),
                )
                .await
                .unwrap();
        }
        assert_eq!(log.prefix(16, 65536).await.unwrap().events.len(), 6);
        log.connection.run(move |db| Box::pin(async move {
            assert_eq!(sqlx::query_as::<_,(i64,String)>("SELECT source_sequence,category FROM transcript_failures WHERE session_id='bare'").fetch_one(&mut *db).await?,(through as i64,"invalid".into()));
            assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM transcript_directory WHERE source_sequence=?").bind(through as i64).fetch_one(&mut *db).await?,0);
            check_read(db,"bare",through-1).await?;
            let error = check_read(db,"bare",through).await.unwrap_err().to_string();
            assert!(error.contains(&format!("history source {through}: invalid:")));
            assert!(error.contains("accepted model parts differ from observations"));
            Ok(())
        })).await.unwrap();
        log.close().await.unwrap();
        let log = EventLog::open(&path).await.unwrap();
        log.connection
            .run(move |db| {
                Box::pin(async move {
                    let detail = check_read(db, "bare", through)
                        .await
                        .unwrap_err()
                        .to_string();
                    assert!(detail.contains(&format!("history source {through}: invalid:")));
                    assert!(detail.contains("accepted model parts differ from observations"));
                    Ok(())
                })
            })
            .await
            .unwrap();
        log.close().await.unwrap();
    }

    #[tokio::test]
    async fn copy_temporary_metadata_is_dropped_before_error_returns() {
        let temp = tempfile::tempdir().unwrap();
        let log = EventLog::open(&temp.path().join("copy-cleanup.sqlite"))
            .await
            .unwrap();
        for session in ["source", "target"] {
            let write = EventWrite::plain(event(
                session,
                session,
                &format!("open-{session}"),
                Fact::InvocationOpened {
                    configuration: None,
                    input: InvocationInput::Message {
                        source_messages: Vec::new(),
                        content: "literal".into(),
                        request_fingerprint: None,
                    },
                },
            ))
            .unwrap();
            log.append(&write).await.unwrap();
        }
        log.connection.run(|db| Box::pin(async move {
            let mut tx = db.begin().await?;
            let request = maka_agent_facts::session::CopyRequest {source_session_id:"source".into(),target_session_id:"target".into(),expected_source_revision:1,purpose:maka_agent_facts::session::CopyPurpose::Branch {turn_id:None,side_conversation:false}};
            let lineage = maka_agent_facts::session::Lineage::Branch {origin:maka_agent_facts::session::BranchOrigin {parent_session_id:"source".into(),turn_id:None}};
            sqlx::query("INSERT INTO session_history_copies(session_id,source_session_id,source_revision,through_sequence,observed_through,request_json,lineage_json,state) VALUES('target','source',1,1,2,?,?,'committed')").bind(serde_json::to_string(&request)?).bind(serde_json::to_string(&lineage)?).execute(&mut *tx).await?;
            crate::connection::worker_query(&mut tx, |worker| Box::pin(async move {
                let sequence: i64 = sqlx::query_scalar("INSERT INTO session_history_members SELECT 'target',sequence,NULL FROM runtime_events WHERE event_session='source' RETURNING sequence").fetch_one(&mut *worker).await?;
                crate::context::semantic::copy_member(worker, "target", sequence, None).await
            })).await?;
            sqlx::query("CREATE TEMP TRIGGER fail_copy BEFORE INSERT ON main.transcript_directory WHEN NEW.session_id='target' BEGIN SELECT RAISE(ABORT,'copy write failed'); END").execute(&mut *tx).await?;
            assert!(matches!(copy(&mut tx,"source","target",2).await,Err(StoreError::Sqlite(_))));
            // Inspect the actual original writer, before outer rollback or a next job.
            assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM sqlite_temp_schema WHERE name IN ('transcript_copy_rows','transcript_copy_failures','transcript_copy_rows_position','transcript_copy_rows_message','transcript_copy_failures_source')").fetch_one(&mut *tx).await?,0);
            tx.rollback().await?;
            assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM transcript_directory WHERE session_id='target'").fetch_one(db).await?,2);
            Ok(())
        })).await.unwrap();
        log.close().await.unwrap();
    }

    #[tokio::test]
    async fn metadata_write_failure_rolls_back_canonical_append_and_notice() {
        let temp = tempfile::tempdir().unwrap();
        let log = EventLog::open(&temp.path().join("write-failure.sqlite"))
            .await
            .unwrap();
        let notices = log.subscribe_commits();
        log.connection.run(|db| Box::pin(async move {
            sqlx::query("CREATE TRIGGER fail_directory BEFORE INSERT ON transcript_directory BEGIN SELECT RAISE(ABORT,'directory write failure'); END").execute(db).await?;
            Ok(())
        })).await.unwrap();
        let write = EventWrite::plain(event(
            "bare",
            "turn",
            "open",
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    source_messages: Vec::new(),
                    content: "literal".into(),
                    request_fingerprint: None,
                },
            },
        ))
        .unwrap();
        assert!(log.append(&write).await.is_err());
        assert_eq!(*notices.borrow(), 0);
        assert!(log.prefix(16, 65536).await.unwrap().events.is_empty());
        log.connection
            .run(|db| {
                Box::pin(async move {
                    assert_eq!(
                        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM transcript_failures")
                            .fetch_one(&mut *db)
                            .await?,
                        0
                    );
                    sqlx::query("DROP TRIGGER fail_directory")
                        .execute(db)
                        .await?;
                    Ok(())
                })
            })
            .await
            .unwrap();
        log.close().await.unwrap();
    }
    #[test]
    fn projection_classification_does_not_hide_storage_or_invariant_errors() {
        assert_eq!(
            optional_failure(&ProjectionError::Invalid("invalid view").into()),
            Some(("invalid", "invalid view")),
        );
        assert!(optional_failure(&StoreError::Sqlite(rusqlite::Error::InvalidQuery)).is_none());
        assert!(
            optional_failure(&StoreError::InvalidTransition("unrelated invariant".into()))
                .is_none()
        );
    }
}
