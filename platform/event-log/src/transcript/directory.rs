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

//! Disposable metadata reduced from canonical sources on the observation owner.
use super::{emit, read};
use crate::StoreError;
use maka_agent_facts::tool_call::ToolSettlement;
use maka_presentation::{Content, ProjectionError, Row, ToolContent, ToolMetadata, TurnState};
use rusqlite::{Connection as RawConnection, OptionalExtension, params};
use sqlx::SqliteConnection;
use std::collections::HashMap;
use tokio_util::sync::CancellationToken;

pub(crate) use super::emit::source_on_handle;
pub(crate) const RECALL_BODY: &str = super::history::BODY;
const INSERT: &str = "INSERT INTO transcript_directory
 (session_id,source_sequence,item_index,turn_id,message_id,timestamp,role,has_thinking,user_origin,state_status,tool_use_id,tool_name,tool_origin,parent_tool_call_id,parent_operation_id,has_args,result_valid,settlement,is_error,content_kind,tool_title,presentation,duration_ms,context_eligible)
 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)";

#[derive(Clone, Copy)]
enum Need<'a> {
    Directory,
    Recall(&'a CancellationToken),
}

impl Need<'_> {
    fn check(self) -> Result<(), StoreError> {
        if matches!(self, Self::Recall(cancellation) if cancellation.is_cancelled()) {
            return Err(StoreError::InvalidTransition(
                "history search cancelled".into(),
            ));
        }
        Ok(())
    }
}

/// Populate metadata in the caller's observation transaction and canonical snapshot.
pub(crate) async fn ensure(
    connection: &mut SqliteConnection,
    session: &str,
    through: u64,
) -> Result<(), StoreError> {
    let session = session.to_owned();
    connection
        .run_on_worker(move |handle| {
            // SAFETY: the worker exclusively lends this handle; no borrowed value escapes.
            let db = unsafe { RawConnection::from_handle(handle.as_ptr()) }?;
            db.set_prepared_statement_cache_capacity(100);
            ensure_on_handle(&db, &session, through)
        })
        .await?
}

pub(crate) fn ensure_on_handle(
    db: &RawConnection,
    session: &str,
    through: u64,
) -> Result<(), StoreError> {
    ensure_for(db, session, through, Need::Directory)
}

pub(crate) fn ensure_recall_on_handle(
    db: &RawConnection,
    session: &str,
    through: u64,
    cancellation: &CancellationToken,
) -> Result<(), StoreError> {
    ensure_for(db, session, through, Need::Recall(cancellation))
}

fn ensure_for(
    db: &RawConnection,
    session: &str,
    through: u64,
    need: Need<'_>,
) -> Result<(), StoreError> {
    need.check()?;
    let through = read::sql_number(through)?;
    let high: i64 = db
        .prepare_cached("SELECT COALESCE(MAX(sequence),0) FROM event_log")?
        .query_row([], |row| row.get(0))?;
    if through > high {
        return Err(StoreError::InvalidTransition(
            "transcript fence exceeds committed log".into(),
        ));
    }
    let removed: bool = db.prepare_cached("SELECT EXISTS(SELECT 1 FROM session_retirements WHERE session_id=?1 AND remove_session=1)")?
        .query_row([session], |row| row.get(0))?;
    if removed {
        return Err(StoreError::SessionNotFound);
    }
    // Canonical membership retains copied material. A bare imported owner can
    // lose its own material without a session retirement row.
    let unavailable: bool = db.prepare_cached("SELECT EXISTS(SELECT 1 FROM event_log INDEXED BY event_retired_material_owner WHERE event_session=?1 AND sequence<=?2 AND event_header IS NULL AND invocation_id IS NOT NULL)")?
        .query_row(params![session,through], |row| row.get(0))?;
    if unavailable {
        return Err(StoreError::InvalidTransition(
            "history source material is unavailable".into(),
        ));
    }
    let identity: Option<String> = db.prepare_cached("SELECT json_array(source_session_id,source_revision,through_sequence,observed_through,request_json,lineage_json,bundle_digest,state) FROM session_history_copies WHERE session_id=?1")?
        .query_row([session], |row| row.get(0)).optional()?;
    let identity = identity.unwrap_or_default();
    let previous: Option<(String,i64)> = db.prepare_cached("SELECT copy_identity,through_sequence FROM temp.transcript_directory_progress WHERE session_id=?1")?
        .query_row([session], |row| Ok((row.get(0)?,row.get(1)?))).optional()?;
    let directory_after = match previous {
        Some((prior, progress)) if prior == identity => progress,
        Some(_) => {
            for table in [
                "transcript_directory",
                "transcript_failures",
                "transcript_directory_progress",
                "transcript_text",
                "transcript_rows",
                "transcript_sessions",
                "transcript_active_source",
            ] {
                db.prepare_cached(&format!("DELETE FROM temp.{table} WHERE session_id=?1"))?
                    .execute([session])?;
            }
            crate::recall::maintenance::reset_session(db, session)?;
            0
        }
        None => 0,
    };
    let recall_after: Option<i64> = match need {
        Need::Directory => None,
        Need::Recall(_) => Some(db.prepare_cached("SELECT COALESCE((SELECT through_source_sequence FROM recall_progress WHERE session_id=?1),0)")?
            .query_row([session], |row| row.get(0))?),
    };
    let after = recall_after.map_or(directory_after, |recall| directory_after.min(recall));
    if after < through {
        let sql = format!(
            "SELECT e.sequence FROM runtime_events e WHERE e.event_session=?1 AND e.sequence>?2 AND e.sequence<=?3 AND {} UNION SELECT e.sequence FROM session_history_members h JOIN runtime_events e ON e.sequence=h.sequence WHERE h.session_id=?1 AND e.sequence>?2 AND e.sequence<=?3 AND {} ORDER BY sequence",
            emit::ELIGIBLE,
            emit::ELIGIBLE
        );
        let mut statement = db.prepare_cached(&sql)?;
        let mut sources = statement.query(params![session, after, through])?;
        while let Some(row) = sources.next()? {
            need.check()?;
            let source: i64 = row.get(0)?;
            let missing_directory = source > directory_after;
            let missing_recall = recall_after.is_some_and(|recall| source > recall);
            if !missing_directory {
                let failed: bool = db.prepare_cached("SELECT EXISTS(SELECT 1 FROM transcript_failures WHERE session_id=?1 AND source_sequence=?2)")?
                    .query_row(params![session,source], |row| row.get(0))?;
                if failed {
                    continue;
                }
            }
            let rows = match emit::source_on_handle(db, session, source) {
                Ok(rows) => rows,
                Err(error) if missing_directory => {
                    record_failure(db, session, source, error)?;
                    continue;
                }
                Err(error) => return Err(error),
            };
            need.check()?;
            if missing_directory && !record_rows(db, session, source, &rows)? {
                continue;
            }
            if missing_recall {
                crate::recall::maintenance::record_rows(db, session, source, &rows)?;
            }
        }
    }
    // Both watermarks cover zero-row sources and explicit cached failures.
    if directory_after < through {
        db.prepare_cached("INSERT INTO temp.transcript_directory_progress(session_id,copy_identity,through_sequence) VALUES(?1,?2,?3) ON CONFLICT(session_id) DO UPDATE SET copy_identity=excluded.copy_identity,through_sequence=excluded.through_sequence")?
            .execute(params![session,identity,through])?;
    }
    if recall_after.is_some_and(|recall| recall < through) {
        crate::recall::maintenance::mark_progress(db, session, through)?;
    }
    need.check()?;
    let failure: Option<(i64,String,Option<String>)> = db.prepare_cached("SELECT source_sequence,category,reason FROM transcript_failures WHERE session_id=?1 AND source_sequence<=?2 ORDER BY source_sequence LIMIT 1")?
        .query_row(params![session,through], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?;
    if let Some((source, category, reason)) = failure {
        let cause = if category == "namespace" {
            StoreError::TranscriptConflict
        } else {
            StoreError::InvalidTransition(format!(
                "history source {source}: {category}: {}",
                reason.as_deref().unwrap_or("source unavailable")
            ))
        };
        return Err(StoreError::TranscriptSource {
            source_sequence: crate::sequence_number(source)?,
            cause: Box::new(cause),
        });
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

fn record_failure(
    db: &RawConnection,
    session: &str,
    source: i64,
    error: StoreError,
) -> Result<(), StoreError> {
    let Some((category, reason)) = optional_failure(&error) else {
        return Err(error);
    };
    db.prepare_cached("INSERT INTO transcript_failures(session_id,source_sequence,category,reason) VALUES(?1,?2,?3,?4)")?
        .execute(params![session,source,category,reason])?;
    Ok(())
}

fn record_rows(
    db: &RawConnection,
    session: &str,
    source: i64,
    rows: &[Row],
) -> Result<bool, StoreError> {
    let mut ids = HashMap::new();
    for row in rows {
        let (sequence, item) = read::sql_position(row.position)?;
        let prior: Option<(i64,i64)> = db.prepare_cached("SELECT source_sequence,item_index FROM transcript_directory WHERE session_id=?1 AND message_id=?2")?
            .query_row(params![session,&row.message.id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
        let prior = prior.or_else(|| ids.insert(row.message.id.as_str(), (sequence, item)));
        if let Some((claimed_source, claimed_item)) = prior {
            db.prepare_cached("INSERT INTO transcript_failures(session_id,source_sequence,category,message_id,claimant_source_sequence,claimant_item_index,attempted_item_index,reason) VALUES(?1,?2,'namespace',?3,?4,?5,?6,'message identity is already claimed')")?
                .execute(params![session,source,&row.message.id,claimed_source,claimed_item,item])?;
            return Ok(false);
        }
    }
    // Finish fallible small metadata conversions before publishing any source rows.
    let metadata = rows
        .iter()
        .map(|row| {
            Ok((
                read::sql_position(row.position)?,
                read::sql_number(row.message.ts)?,
                Metadata::from_content(&row.message.content, &row.message.id)?,
            ))
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    let mut insert = db.prepare_cached(INSERT)?;
    for (row, ((sequence, item), timestamp, metadata)) in rows.iter().zip(metadata) {
        insert.execute(params![
            session,
            sequence,
            item,
            &row.message.turn_id,
            &row.message.id,
            timestamp,
            metadata.role,
            metadata.has_thinking,
            metadata.user_origin,
            metadata.state_status,
            metadata.tool_use_id,
            metadata.tool_name,
            metadata.tool_origin,
            metadata.parent_tool_call_id,
            metadata.parent_operation_id,
            metadata.has_args,
            metadata.result_valid,
            metadata.settlement,
            metadata.is_error,
            metadata.content_kind,
            metadata.tool_title,
            metadata.presentation,
            metadata.duration_ms,
            metadata.context_eligible,
        ])?;
    }
    Ok(true)
}

struct Metadata<'row> {
    role: &'static str,
    has_thinking: bool,
    user_origin: Option<String>,
    state_status: Option<&'static str>,
    tool_use_id: Option<&'row str>,
    tool_name: Option<&'row str>,
    tool_origin: Option<&'static str>,
    parent_tool_call_id: Option<&'row str>,
    parent_operation_id: Option<&'row str>,
    has_args: Option<bool>,
    result_valid: Option<bool>,
    settlement: Option<&'static str>,
    is_error: Option<bool>,
    content_kind: Option<&'static str>,
    tool_title: Option<String>,
    presentation: Option<&'row str>,
    duration_ms: Option<i64>,
    context_eligible: bool,
}

impl<'row> Metadata<'row> {
    fn from_content(content: &'row Content, message_id: &'row str) -> Result<Self, StoreError> {
        let mut metadata = Self {
            role: match content {
                Content::ContextCompacted { .. } => "context_compacted",
                Content::ModelInterruption { .. } => "model_interruption",
                Content::SystemNote { .. } => "system_note",
                Content::User { .. } => "user",
                Content::Assistant { .. } => "assistant",
                Content::TokenUsage { .. } => "token_usage",
                Content::ToolCall { .. } => "tool_call",
                Content::ToolActivity { .. } => "tool_activity",
                Content::ToolResult { .. } => "tool_result",
                Content::TurnState { .. } => "turn_state",
            },
            has_thinking: false,
            user_origin: None,
            state_status: None,
            tool_use_id: None,
            tool_name: None,
            tool_origin: None,
            parent_tool_call_id: None,
            parent_operation_id: None,
            has_args: None,
            result_valid: None,
            settlement: None,
            is_error: None,
            content_kind: None,
            tool_title: None,
            presentation: None,
            duration_ms: None,
            context_eligible: false,
        };
        match content {
            Content::ContextCompacted { duration_ms } => {
                metadata.duration_ms = Some(read::sql_number(*duration_ms)?)
            }
            Content::ModelInterruption { message } => {
                metadata.context_eligible = !message.is_empty()
            }
            Content::User {
                origin,
                text,
                display_text,
                attachments,
                directory_references,
                ..
            } => {
                metadata.user_origin = origin.as_ref().map(serde_json::to_string).transpose()?;
                metadata.context_eligible = !display_text.as_ref().unwrap_or(text).is_empty()
                    || attachments.as_ref().is_some_and(|items| !items.is_empty())
                    || directory_references
                        .as_ref()
                        .is_some_and(|items| !items.is_empty());
            }
            Content::Assistant { text, thinking, .. } => {
                metadata.has_thinking = thinking.is_some();
                metadata.context_eligible = !text.is_empty();
            }
            Content::ToolCall {
                tool_name,
                metadata: origin,
                ..
            } => {
                metadata.tool_use_id = Some(message_id);
                metadata.tool_name = Some(tool_name);
                metadata.has_args = Some(true);
                metadata.context_eligible = true;
                metadata.with_tool_origin(origin);
            }
            Content::ToolActivity {
                tool_use_id,
                tool_name,
                title,
                presentation,
            } => {
                metadata.tool_use_id = Some(tool_use_id);
                metadata.tool_name = Some(tool_name);
                metadata.tool_title = title.as_ref().map(serde_json::to_string).transpose()?;
                metadata.presentation = presentation.as_deref();
            }
            Content::ToolResult {
                tool_use_id,
                settlement,
                is_error,
                content,
                metadata: origin,
            } => {
                metadata.tool_use_id = Some(tool_use_id);
                metadata.result_valid = Some(true);
                metadata.settlement = settlement.map(|settlement| match settlement {
                    ToolSettlement::Returned => "returned",
                    ToolSettlement::Failed => "failed",
                    ToolSettlement::Unknown => "unknown",
                    ToolSettlement::Rejected => "rejected",
                });
                metadata.is_error = Some(*is_error);
                metadata.content_kind = Some(match content {
                    ToolContent::Text { .. } => "text",
                    ToolContent::Json { .. } => "json",
                    ToolContent::Operation { .. } => "operation",
                    ToolContent::Image { .. } => "image",
                });
                metadata.context_eligible = true;
                metadata.with_tool_origin(origin);
            }
            Content::TurnState { state } => {
                metadata.state_status = Some(match state {
                    TurnState::Running => "running",
                    TurnState::Completed => "completed",
                    TurnState::Failed { .. } => {
                        metadata.context_eligible = true;
                        "failed"
                    }
                    TurnState::Aborted { .. } => "aborted",
                });
            }
            Content::SystemNote { .. } | Content::TokenUsage { .. } => {}
        }
        Ok(metadata)
    }

    fn with_tool_origin(&mut self, origin: &'row ToolMetadata) {
        self.tool_origin = Some(match origin {
            ToolMetadata::Imported { .. } => "imported",
            ToolMetadata::Provider { .. } => "provider",
            ToolMetadata::HostSdk {
                parent_tool_call_id,
                parent_operation_id,
                ..
            } => {
                self.parent_tool_call_id = parent_tool_call_id.as_deref();
                self.parent_operation_id = parent_operation_id.as_deref();
                "host_sdk"
            }
            ToolMetadata::CodeMode {
                parent_tool_call_id,
                parent_operation_id,
                ..
            } => {
                self.parent_tool_call_id = Some(parent_tool_call_id);
                self.parent_operation_id = Some(parent_operation_id);
                "code_mode"
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
