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

use super::{invalid, proof, read, safety, selection::Selection};
use crate::StoreError;
use maka_agent_facts::context::CheckpointMode;
use maka_agent_facts::context::CompactOutcome;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;

pub(crate) fn validate_append(
    connection: &rusqlite::Connection,
    event: &RuntimeEvent,
) -> Result<(), StoreError> {
    super::request::validate(connection, event)?;
    match &event.fact {
        Fact::ContextCheckpointRecorded { checkpoint } => {
            safety::current_opening(
                connection,
                &event.invocation.session_id,
                Some(&event.invocation.invocation_id),
            )?;
            safety::require_safe(
                connection,
                &event.invocation.session_id,
                Some(&event.invocation.invocation_id),
            )?;
            safety::settled_boundary(connection, &event.invocation.invocation_id, i64::MAX as u64)?;
            let (_, opening) = proof::by_kind(
                connection,
                &event.invocation.invocation_id,
                "invocation_opened",
                None,
            )?;
            let selection = Selection::for_opening(connection, &opening)?;
            let current = read::latest_record(connection, &selection, i64::MAX as u64)?
                .map(|record| record.event.id);
            if current != checkpoint.previous_checkpoint_id {
                return Err(invalid("checkpoint predecessor changed before adoption"));
            }
            validate_checkpoint(connection, event)?;
        }
        Fact::InvocationEnded { outcome } => {
            let compact: bool = connection
                .prepare_cached(
                    "SELECT json_extract(event_header, '$.fact.input.kind') = 'context_compact'
                 FROM runtime_events WHERE invocation_id = ? AND kind = 'invocation_opened'",
                )?
                .query_row(rusqlite::params![&event.invocation.invocation_id], |row| {
                    row.get(0)
                })?;
            match outcome {
                InvocationOutcome::ContextCompactFinished { outcome } => {
                    if !compact {
                        return Err(invalid("compact terminal belongs to ordinary invocation"));
                    }
                    if let CompactOutcome::Compacted { checkpoint_id } = outcome {
                        let (_, checkpoint) = proof::by_id(connection, checkpoint_id)?;
                        if checkpoint.invocation != event.invocation
                            || !matches!(checkpoint.fact, Fact::ContextCheckpointRecorded { .. })
                        {
                            return Err(invalid("terminal references another checkpoint"));
                        }
                    }
                    let pending: bool = connection.prepare_cached("SELECT EXISTS(SELECT 1 FROM runtime_events d WHERE invocation_id = ? AND kind IN ('tool_dispatched','model_requested')
                         AND NOT EXISTS(SELECT 1 FROM runtime_events t WHERE t.invocation_id = d.invocation_id AND t.operation_id = d.operation_id
                           AND t.kind IN ('tool_settled','model_completed','model_interrupted')))")?.query_row(rusqlite::params![&event.invocation.invocation_id], |row| row.get(0))?;
                    if pending {
                        return Err(invalid("compact terminal has unresolved execution"));
                    }
                }
                InvocationOutcome::Completed if compact => {
                    return Err(invalid("compact requires a domain terminal"));
                }
                _ => {}
            }
        }
        _ => {}
    }
    Ok(())
}

/// Validate only the newly admitted checkpoint edge. Its predecessor was
/// already admitted by this same writer (or the import boundary).
fn validate_checkpoint(
    connection: &rusqlite::Connection,
    event: &RuntimeEvent,
) -> Result<(), StoreError> {
    let Fact::ContextCheckpointRecorded { checkpoint } = &event.fact else {
        return Err(invalid("expected checkpoint"));
    };
    let selection = proof::validate(connection, event, i64::MAX as u64, checkpoint)?;
    let latest = read::latest_selected(connection, &selection, checkpoint.covered_through)?;
    if latest.as_ref().map(|baseline| &baseline.event_id)
        != checkpoint.previous_checkpoint_id.as_ref()
    {
        return Err(invalid("predecessor is not the selected source baseline"));
    }
    if let Some(previous) = latest
        && previous.checkpoint.covered_through >= checkpoint.covered_through
    {
        return Err(invalid("checkpoint coverage must advance"));
    }
    let source = super::evidence::selected(connection, &selection, checkpoint.covered_through)?;
    if source.digest != checkpoint.source_digest {
        return Err(invalid("source digest changed"));
    }
    Ok(())
}

pub(crate) fn require_terminal(
    connection: &rusqlite::Connection,
    checkpoint: &RuntimeEvent,
) -> Result<(), StoreError> {
    let (_, terminal) = proof::by_kind(
        connection,
        &checkpoint.invocation.invocation_id,
        "invocation_ended",
        None,
    )?;
    if terminal.invocation != checkpoint.invocation
        || !matches!(&terminal.fact,
        Fact::InvocationEnded { outcome: InvocationOutcome::ContextCompactFinished { outcome: CompactOutcome::Compacted { checkpoint_id } } } if checkpoint_id == &checkpoint.id)
    {
        return Err(invalid("checkpoint lacks its atomic compacted terminal"));
    }
    Ok(())
}

pub(crate) fn validate_batch(
    connection: &rusqlite::Connection,
    events: &[EventWrite],
) -> Result<(), StoreError> {
    for write in events {
        if matches!(&write.event().fact, Fact::ContextCheckpointRecorded { checkpoint } if matches!(checkpoint.mode, CheckpointMode::Standalone))
        {
            require_terminal(connection, write.event())?;
        }
    }
    Ok(())
}
