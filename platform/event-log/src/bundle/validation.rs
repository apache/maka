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

use super::format::Record;
use crate::{
    StoreError,
    context::{self, selection::Selection},
};
use maka_agent_facts::context::CheckpointMode;
use maka_agent_facts::context::ModelPurpose;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::event::ToolOutcome;
use rusqlite::{Connection, OptionalExtension, params};

mod artifacts;
mod catalog;
mod copies;
mod material;

pub(super) fn validate(staged: &Connection) -> Result<(), StoreError> {
    prepare(staged, None)?;
    Ok(())
}

pub(super) fn prepare(
    staged: &Connection,
    positions: Option<&super::relocation::Positions>,
) -> Result<Connection, StoreError> {
    let original = Connection::open("")?;
    original.set_db_config(
        rusqlite::config::DbConfig::SQLITE_DBCONFIG_ENABLE_QPSG,
        true,
    )?;
    original.execute_batch(
        "PRAGMA temp_store=FILE;
         PRAGMA page_size=4096;
         PRAGMA cache_size=-4096;",
    )?;
    crate::schema::initialize_connection(&original)?;
    let tx =
        rusqlite::Transaction::new_unchecked(&original, rusqlite::TransactionBehavior::Deferred)?;
    replay(staged, &tx, positions)?;
    tx.commit()?;
    Ok(original)
}

fn replay(
    staged: &Connection,
    original: &Connection,
    positions: Option<&super::relocation::Positions>,
) -> Result<(), StoreError> {
    let header: String = staged
        .prepare_cached("SELECT record_json FROM frames WHERE number=1")?
        .query_row(params![], |row| row.get(0))?;
    let Record::Header {
        source_high_water,
        inventory,
    } = serde_json::from_str(&header)?
    else {
        return Err(invalid("missing staged header"));
    };
    let mut copies = copies::Copies::read(staged, source_high_water, positions)?;
    let source_high_water = positions.map_or(source_high_water, |p| p.fence(source_high_water));
    let mut after = 0i64;
    loop {
        let row: Option<String> = staged.prepare_cached("SELECT record_json FROM frames INDEXED BY source_events WHERE kind='event' AND source_sequence>? ORDER BY source_sequence LIMIT 1")?.query_row(params![after], |row| row.get(0)).optional()?;
        let Some(row) = row else {
            break;
        };
        let Record::Event { sequence, json } = serde_json::from_str(&row)? else {
            unreachable!()
        };
        after = sequence as i64;
        let sequence = positions.map_or(Ok(sequence), |p| p.event(sequence))?;
        copies.install(staged, original, sequence - 1, positions)?;
        let json = match positions {
            Some(positions) => positions.json(original, json)?,
            None => json,
        };
        let event: RuntimeEvent = serde_json::from_str(&json)?;
        for id in [
            &event.id,
            &event.invocation.session_id,
            &event.invocation.turn_id,
            &event.invocation.run_id,
            &event.invocation.invocation_id,
        ] {
            crate::sessions::validate_id(id)?;
        }
        let payload = material::tool(staged, &event)?;
        crate::tool_payloads::verify_binding(&event, payload.as_ref().map(|p| p.len() as i64))?;
        match &event.fact {
            Fact::MessageImported { source, record } => {
                source.validate().map_err(invalid)?;
                record.validate().map_err(invalid)?;
            }
            _ => {
                if !matches!(
                    event.fact,
                    Fact::ToolSettled {
                        outcome: ToolOutcome::Succeeded { .. },
                        ..
                    }
                ) {
                    EventWrite::plain(event.clone()).map_err(|e| invalid(&e.to_string()))?;
                }
                crate::append::history::validate(original, &event)?;
                request(original, &event, sequence)?;
            }
        }
        crate::message_identity::validate(original, &event)?;
        crate::message_identity::validate_source_id(
            original,
            &event.invocation.session_id,
            &event.id,
        )?;
        crate::append::ingress::insert(
            original,
            &event,
            json,
            crate::append::ingress::Position::Imported(Some(sequence)),
        )?;
        crate::message_sources::insert(original, &event)?;
        if let Some(payload) = payload {
            crate::tool_payloads::store_raw(original, &event.id, &payload)?;
        }
        material::composition(staged, original, &event)?;
    }
    // The fence can fall in a gap, or after the last exported proof event.
    copies.install(staged, original, source_high_water, positions)?;
    let mixed: bool = original.prepare_cached("SELECT EXISTS(SELECT 1 FROM runtime_events GROUP BY invocation_id
           HAVING SUM(kind='message_imported')>0 AND COUNT(*)>1)
         OR EXISTS(SELECT 1 FROM runtime_events GROUP BY event_session,json_extract(event_header,'$.invocation.run_id')
           HAVING COUNT(DISTINCT invocation_id)>1)")?.query_row(params![], |row| row.get(0))?;
    if mixed {
        return Err(invalid("imported messages cannot admit an invocation"));
    }
    let mut after = 0i64;
    loop {
        let row: Option<(i64,String)> = original.prepare_cached("SELECT sequence,event_header FROM runtime_events WHERE kind='context_checkpoint_recorded' AND sequence>? ORDER BY sequence LIMIT 1")?.query_row(params![after], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
        let Some((sequence, json)) = row else {
            break;
        };
        let event: RuntimeEvent = serde_json::from_str(&json)?;
        if matches!(&event.fact, Fact::ContextCheckpointRecorded { checkpoint } if matches!(checkpoint.mode, CheckpointMode::Standalone))
        {
            context::validate_checkpoint_terminal(original, &event)?;
        }
        after = sequence;
    }
    material::check_bindings(staged, original)?;
    catalog::validate(staged, original, &inventory, source_high_water)?;
    artifacts::validate(staged, original, &inventory, positions)?;
    super::accounting::validate(staged, original)
}

fn request(db: &Connection, event: &RuntimeEvent, sequence: u64) -> Result<(), StoreError> {
    let Fact::ModelRequested {
        source_scope,
        source_high_water,
        source_capture,
        source_digest,
        checkpoint_event_id,
        effective_source_digest,
        purpose,
        ..
    } = &event.fact
    else {
        return Ok(());
    };
    let selection = Selection::for_invocation(db, &event.invocation)?;
    if *purpose == ModelPurpose::Main {
        context::safety::model_source_unchanged(db, &selection, event)?;
    }
    if source_capture.publication_watermark >= sequence
        || *source_high_water > source_capture.publication_watermark
        || *source_scope != selection.scope
    {
        return Err(invalid(
            "request source is not its preceding selected history",
        ));
    }
    let source = context::evidence::selected(db, &selection, *source_high_water)?;
    if source.digest != *source_digest {
        return Err(invalid("request original source digest mismatch"));
    }
    let baseline = context::read::latest_selected(db, &selection, *source_high_water)?;
    if baseline.as_ref().map(|b| &b.event_id) != checkpoint_event_id.as_ref() {
        return Err(invalid("request original baseline mismatch"));
    }
    let effective = effective_source_digest
        .as_deref()
        .ok_or_else(|| invalid("request lacks effective source evidence"))?;
    crate::archive::validate_summary(
        db,
        &source,
        effective,
        source_capture.publication_watermark + 1,
    )
}

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
