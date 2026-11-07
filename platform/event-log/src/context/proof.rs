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

use super::{boundary, invalid, selection::Selection};
use crate::{StoreError, sequence_number};
use maka_agent_facts::context::ContextCheckpoint;
use maka_agent_facts::context::ModelPurpose;
use maka_agent_facts::context::TextSummary;
use maka_agent_facts::context::resolve_model_purpose;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::RuntimeEvent;

pub(super) fn by_id(
    connection: &rusqlite::Connection,
    id: &str,
) -> Result<(u64, RuntimeEvent), StoreError> {
    let sql = format!(
        "SELECT e.sequence,e.event_header,{} FROM runtime_events e {} WHERE e.event_id=?",
        crate::canonical::COLUMNS,
        crate::canonical::JOINS
    );
    let mut statement = connection.prepare_cached(&sql)?;
    let mut rows = statement.query([id])?;
    decode(rows.next()?)
}

pub(super) fn by_kind(
    connection: &rusqlite::Connection,
    invocation: &str,
    kind: &str,
    operation: Option<&str>,
) -> Result<(u64, RuntimeEvent), StoreError> {
    let operation_filter = if operation.is_some() {
        " AND e.operation_id=?3"
    } else {
        ""
    };
    let sql = format!(
        "SELECT e.sequence,e.event_header,{} FROM runtime_events e {} WHERE e.invocation_id=?1 AND e.kind=?2{operation_filter}",
        crate::canonical::COLUMNS,
        crate::canonical::JOINS
    );
    let mut statement = connection.prepare_cached(&sql)?;
    if let Some(operation) = operation {
        let mut rows = statement.query(rusqlite::params![invocation, kind, operation])?;
        decode(rows.next()?)
    } else {
        let mut rows = statement.query(rusqlite::params![invocation, kind])?;
        decode(rows.next()?)
    }
}

fn decode(row: Option<&rusqlite::Row<'_>>) -> Result<(u64, RuntimeEvent), StoreError> {
    let row = row.ok_or_else(|| invalid("missing proof event"))?;
    let json = crate::canonical::json(row)?;
    Ok((
        sequence_number(row.get("sequence")?)?,
        serde_json::from_str(&json)?,
    ))
}

/// Validate the proof and return its exact source selection. The chain reader
/// must also verify every raw source digest before accepting the chain.
pub(super) fn validate(
    connection: &rusqlite::Connection,
    event: &RuntimeEvent,
    sequence: u64,
    checkpoint: &ContextCheckpoint,
) -> Result<Selection, StoreError> {
    checkpoint.validate().map_err(invalid)?;
    let (opened, opening) = by_kind(
        connection,
        &event.invocation.invocation_id,
        "invocation_opened",
        None,
    )?;
    let Fact::InvocationOpened {
        input,
        configuration,
    } = &opening.fact
    else {
        return Err(invalid("checkpoint writer has no canonical opening"));
    };
    if opening.invocation != event.invocation {
        return Err(invalid("checkpoint opening identity mismatch"));
    }
    let selection = Selection::for_opening(connection, &opening)?;
    if boundary::source_fence(
        connection,
        &selection,
        Some(&(opened as i64, opening.clone())),
        &checkpoint.mode,
        checkpoint
            .covered_through
            .checked_add(1)
            .ok_or_else(|| invalid("coverage overflow"))?,
    )? != checkpoint.covered_through
    {
        return Err(invalid("coverage is not the complete closed source"));
    }
    let (requested, request) = by_kind(
        connection,
        &event.invocation.invocation_id,
        "model_requested",
        Some(&checkpoint.summary_step_id),
    )?;
    let Fact::ModelRequested {
        model_id,
        source_scope,
        source_high_water,
        source_digest,
        checkpoint_event_id,
        route_identity,
        purpose,
        effective_source_digest,
        ..
    } = &request.fact
    else {
        return Err(invalid("missing summary request"));
    };
    let first_summary = boundary::summary_start(
        connection,
        &event.invocation.invocation_id,
        source_scope,
        *source_high_water,
        sequence,
    )?
    .ok_or_else(|| invalid("missing summary attempt"))?;
    crate::archive::validate_summary(
        connection,
        &super::SourceEvidence {
            scope: source_scope.clone(),
            high_water: *source_high_water,
            digest: source_digest.clone(),
        },
        effective_source_digest
            .as_deref()
            .ok_or_else(|| invalid("summary requires effective source evidence"))?,
        first_summary,
    )?;
    if resolve_model_purpose(input, *purpose).map_err(invalid)? != ModelPurpose::Summary
        || request.invocation != event.invocation
        || source_scope != &selection.scope
        || *source_high_water != checkpoint.covered_through
        || source_digest != &checkpoint.source_digest
        || checkpoint_event_id != &checkpoint.previous_checkpoint_id
        || route_identity.len() != 71
        || !route_identity.starts_with("sha256:")
        || !route_identity.as_bytes()[7..]
            .iter()
            .all(u8::is_ascii_hexdigit)
        || model_id.is_empty()
        || configuration
            .as_ref()
            .and_then(|c| c.model.as_ref())
            .is_some_and(|m| &m.model != model_id)
    {
        return Err(invalid(
            "summary request does not prove checkpoint source or model",
        ));
    }
    let changed_route: bool = connection.prepare_cached("SELECT EXISTS(SELECT 1 FROM event_log INDEXED BY context_summary_round
         WHERE invocation_id = ?1 AND event_header IS NOT NULL AND kind = 'model_requested' AND sequence >= ?9 AND sequence < ?2
         AND json_extract(event_header, '$.fact.purpose') = 'summary'
         AND json_extract(event_header, '$.fact.source_high_water') = ?5
         AND json_extract(event_header, '$.fact.source_scope') = json(?10)
         AND (json_extract(event_header, '$.fact.model_id') != ?3 OR json_extract(event_header, '$.fact.route_identity') != ?4
           OR json_extract(event_header, '$.fact.source_high_water') != ?5 OR json_extract(event_header, '$.fact.source_digest') != ?6
           OR json_extract(event_header, '$.fact.checkpoint_event_id') IS NOT ?7
           OR json_extract(event_header, '$.fact.effective_source_digest') IS NOT ?8))")?.query_row(rusqlite::params![&event.invocation.invocation_id,sequence as i64,model_id,route_identity,checkpoint.covered_through as i64,&checkpoint.source_digest,&checkpoint.previous_checkpoint_id,effective_source_digest,first_summary as i64,serde_json::to_string(source_scope)?], |row| row.get(0))?;
    if changed_route {
        return Err(invalid("summary request route changed"));
    }
    let (completed, completion) = by_kind(
        connection,
        &event.invocation.invocation_id,
        "model_completed",
        Some(&checkpoint.summary_step_id),
    )?;
    let Fact::ModelCompleted { output, .. } = &completion.fact else {
        return Err(invalid("missing summary completion"));
    };
    let parts = crate::model_items::resolve_parts(connection, &completion)?;
    if completion.invocation != event.invocation
        || !(opened < requested && requested < completed && completed < sequence)
    {
        return Err(invalid("checkpoint completion identity mismatch"));
    }
    match &checkpoint.summary {
        maka_agent_facts::context::CheckpointContent::Text(text) => {
            if matches!(&request.fact, Fact::ModelRequested { context: Some(context), .. } if !context.operation.is_inference())
            {
                return Err(invalid("native request cannot install a text checkpoint"));
            }
            if TextSummary::from_parts(
                output.finish_reason,
                parts.iter().map(|record| record.part.as_ref()),
            )
            .map_err(|_| invalid("invalid completed summary"))?
            .text
                != *text
            {
                return Err(invalid("summary does not match its completed model step"));
            }
        }
        maka_agent_facts::context::CheckpointContent::CodexNative {
            item_digest,
            estimated_tokens,
        } => {
            let Fact::ModelRequested {
                context: Some(context),
                ..
            } = &request.fact
            else {
                return Err(invalid("native checkpoint has no producer context"));
            };
            if context.operation != maka_agent_facts::context::ModelOperation::CodexCompaction
                || context.codex.is_none()
                || output.usage.output_tokens.or(context.context_window) != Some(*estimated_tokens)
                || output.finish_reason != maka_agent_facts::model::ModelFinishReason::Stop
                || output
                    .compaction
                    .as_ref()
                    .map(|output| output.digest())
                    .as_ref()
                    != Some(item_digest)
            {
                return Err(invalid(
                    "native checkpoint does not match its completed model step",
                ));
            }
        }
    }
    Ok(selection)
}
