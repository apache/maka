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
use maka_runtime::{
    context::{CheckpointMode, ModelPurpose},
    event::{EventWrite, Fact, RuntimeEvent, ToolOutcome},
};
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};

mod artifacts;
mod catalog;
mod copies;
mod material;

pub(super) async fn validate(staged: &mut SqliteConnection) -> Result<(), StoreError> {
    prepare(staged, None).await?.close().await?;
    Ok(())
}

pub(super) async fn prepare(
    staged: &mut SqliteConnection,
    positions: Option<&super::relocation::Positions>,
) -> Result<SqliteConnection, StoreError> {
    let mut original = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename("")
            .create_if_missing(true)
            .pragma("temp_store", "FILE")
            .pragma("page_size", "4096")
            .pragma("cache_size", "-4096")
            .pragma("max_page_count", "393216"),
    )
    .await?;
    let result = async {
        crate::schema::initialize_connection(&mut original).await?;
        let mut tx = original.begin().await?;
        replay(staged, &mut tx, positions).await?;
        tx.commit().await?;
        Ok::<_, StoreError>(())
    }
    .await;
    match result {
        Ok(()) => Ok(original),
        Err(error) => {
            original.close().await?;
            Err(error)
        }
    }
}

async fn replay(
    staged: &mut SqliteConnection,
    original: &mut SqliteConnection,
    positions: Option<&super::relocation::Positions>,
) -> Result<(), StoreError> {
    let header: String = sqlx::query_scalar("SELECT record_json FROM frames WHERE number=1")
        .fetch_one(&mut *staged)
        .await?;
    let Record::Header {
        source_high_water,
        inventory,
    } = serde_json::from_str(&header)?
    else {
        return Err(invalid("missing staged header"));
    };
    let mut copies = copies::Copies::read(staged, source_high_water, positions).await?;
    let source_high_water = positions.map_or(source_high_water, |p| p.fence(source_high_water));
    let mut after = 0i64;
    loop {
        let row: Option<String> = sqlx::query_scalar(
            "SELECT record_json FROM frames WHERE kind='event' AND source_sequence>? ORDER BY source_sequence LIMIT 1"
        ).bind(after).fetch_optional(&mut *staged).await?;
        let Some(row) = row else {
            break;
        };
        let Record::Event { sequence, json } = serde_json::from_str(&row)? else {
            unreachable!()
        };
        after = sequence as i64;
        let sequence = positions.map_or(Ok(sequence), |p| p.event(sequence))?;
        copies
            .install(staged, original, sequence - 1, positions)
            .await?;
        let json = match positions {
            Some(positions) => positions.json(original, sequence, json).await?,
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
        let payload = material::tool(staged, &event).await?;
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
                crate::append::history::validate(original, &event).await?;
                request(original, &event, sequence).await?;
            }
        }
        crate::message_identity::validate(original, &event).await?;
        crate::message_identity::validate_source_id(
            original,
            &event.invocation.session_id,
            &event.id,
        )
        .await?;
        sqlx::query("INSERT INTO event_log(sequence,event_id,invocation_id,kind,operation_id,event_json) VALUES(?,?,?,?,?,?)")
            .bind(sequence as i64).bind(&event.id).bind(&event.invocation.invocation_id)
            .bind(event.fact.kind()).bind(event.fact.operation_id()).bind(json)
            .execute(&mut *original).await?;
        crate::message_sources::insert(original, &event).await?;
        if let Some(payload) = payload {
            sqlx::query("INSERT INTO tool_result_payloads(event_id,payload) VALUES(?,?)")
                .bind(&event.id)
                .bind(payload)
                .execute(&mut *original)
                .await?;
        }
        material::composition(staged, original, &event).await?;
    }
    // The fence can fall in a gap, or after the last exported proof event.
    copies
        .install(staged, original, source_high_water, positions)
        .await?;
    let mixed: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM runtime_events GROUP BY invocation_id
           HAVING SUM(kind='message_imported')>0 AND COUNT(*)>1)
         OR EXISTS(SELECT 1 FROM runtime_events GROUP BY event_session,json_extract(event_json,'$.invocation.run_id')
           HAVING COUNT(DISTINCT invocation_id)>1)",
    )
    .fetch_one(&mut *original)
    .await?;
    if mixed {
        return Err(invalid("imported messages cannot admit an invocation"));
    }
    let mut after = 0i64;
    loop {
        let row: Option<(i64,String)> = sqlx::query_as(
            "SELECT sequence,event_json FROM runtime_events WHERE kind='context_checkpoint_recorded' AND sequence>? ORDER BY sequence LIMIT 1"
        ).bind(after).fetch_optional(&mut *original).await?;
        let Some((sequence, json)) = row else {
            break;
        };
        let event: RuntimeEvent = serde_json::from_str(&json)?;
        if matches!(&event.fact, Fact::ContextCheckpointRecorded { checkpoint } if matches!(checkpoint.mode, CheckpointMode::Standalone))
        {
            context::validate_checkpoint_terminal(original, &event).await?;
        }
        after = sequence;
    }
    material::check_bindings(staged, original).await?;
    catalog::validate(staged, original, &inventory, source_high_water).await?;
    artifacts::validate(staged, original, &inventory).await?;
    super::accounting::validate(staged, original).await
}

async fn request(
    db: &mut SqliteConnection,
    event: &RuntimeEvent,
    sequence: u64,
) -> Result<(), StoreError> {
    let Fact::ModelRequested {
        source_scope,
        source_high_water,
        source_digest,
        checkpoint_event_id,
        effective_source_digest,
        purpose,
        ..
    } = &event.fact
    else {
        return Ok(());
    };
    let selection = Selection::for_invocation(db, &event.invocation).await?;
    if *purpose == ModelPurpose::Main {
        context::safety::model_source_unchanged(db, &selection, event).await?;
    }
    if *source_high_water >= sequence || *source_scope != selection.scope {
        return Err(invalid(
            "request source is not its preceding selected history",
        ));
    }
    let source = context::evidence::selected(db, &selection, *source_high_water).await?;
    if source.digest != *source_digest {
        return Err(invalid("request original source digest mismatch"));
    }
    let baseline = context::read::latest_selected(db, &selection, *source_high_water).await?;
    if baseline.as_ref().map(|b| &b.event_id) != checkpoint_event_id.as_ref() {
        return Err(invalid("request original baseline mismatch"));
    }
    let effective = effective_source_digest
        .as_deref()
        .ok_or_else(|| invalid("request lacks effective source evidence"))?;
    crate::archive::validate_summary(db, &source, effective, sequence).await
}

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
