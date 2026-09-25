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

use super::{boundary, evidence, invalid, selection::Selection};
use crate::{StoreError, sequence_number};
use maka_runtime::{
    context::{ContextCheckpoint, ModelPurpose, TextSummary, resolve_model_purpose},
    event::{Fact, RuntimeEvent},
};
use sqlx::SqliteConnection;

pub(super) async fn by_id(
    connection: &mut SqliteConnection,
    id: &str,
) -> Result<(u64, RuntimeEvent), StoreError> {
    decode(sqlx::query_as("SELECT sequence, CASE WHEN length(CAST(event_json AS BLOB)) <= 8388608 THEN event_json END
        FROM runtime_events WHERE event_id = ?").bind(id).fetch_optional(connection).await?)
}

pub(super) async fn by_kind(
    connection: &mut SqliteConnection,
    invocation: &str,
    kind: &str,
    operation: Option<&str>,
) -> Result<(u64, RuntimeEvent), StoreError> {
    decode(sqlx::query_as("SELECT sequence, CASE WHEN length(CAST(event_json AS BLOB)) <= 8388608 THEN event_json END
        FROM runtime_events WHERE invocation_id = ? AND kind = ? AND (? IS NULL OR operation_id = ?)")
        .bind(invocation).bind(kind).bind(operation).bind(operation).fetch_optional(connection).await?)
}

fn decode(row: Option<(i64, Option<String>)>) -> Result<(u64, RuntimeEvent), StoreError> {
    let (sequence, json) = row.ok_or_else(|| invalid("missing proof event"))?;
    let json = json.ok_or_else(|| invalid("proof event exceeds bounded reader capacity"))?;
    Ok((sequence_number(sequence)?, serde_json::from_str(&json)?))
}

pub(super) async fn validate(
    connection: &mut SqliteConnection,
    event: &RuntimeEvent,
    sequence: u64,
    checkpoint: &ContextCheckpoint,
) -> Result<(), StoreError> {
    checkpoint.validate().map_err(invalid)?;
    let (opened, opening) = by_kind(
        connection,
        &event.invocation.invocation_id,
        "invocation_opened",
        None,
    )
    .await?;
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
    let selection = Selection::for_opening(connection, &opening).await?;
    if boundary::source_fence(
        connection,
        &selection,
        Some(&(opened as i64, opening.clone())),
        &checkpoint.mode,
        checkpoint
            .covered_through
            .checked_add(1)
            .ok_or_else(|| invalid("coverage overflow"))?,
    )
    .await?
        != checkpoint.covered_through
    {
        return Err(invalid("coverage is not the complete closed source"));
    }
    if evidence::selected(connection, &selection, checkpoint.covered_through)
        .await?
        .digest
        != checkpoint.source_digest
    {
        return Err(invalid("source digest changed"));
    }
    let (requested, request) = by_kind(
        connection,
        &event.invocation.invocation_id,
        "model_requested",
        Some(&checkpoint.summary_step_id),
    )
    .await?;
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
    )
    .await?
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
    )
    .await?;
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
    let changed_route: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id = ?1 AND kind = 'model_requested' AND sequence >= ?9 AND sequence < ?2
         AND json_extract(event_json, '$.fact.purpose') = 'summary'
         AND json_extract(event_json, '$.fact.source_high_water') = ?5
         AND json_extract(event_json, '$.fact.source_scope') = json(?10)
         AND (json_extract(event_json, '$.fact.model_id') != ?3 OR json_extract(event_json, '$.fact.route_identity') != ?4
           OR json_extract(event_json, '$.fact.source_high_water') != ?5 OR json_extract(event_json, '$.fact.source_digest') != ?6
           OR json_extract(event_json, '$.fact.checkpoint_event_id') IS NOT ?7
           OR json_extract(event_json, '$.fact.effective_source_digest') IS NOT ?8))",
    ).bind(&event.invocation.invocation_id).bind(sequence as i64)
        .bind(model_id).bind(route_identity).bind(checkpoint.covered_through as i64).bind(&checkpoint.source_digest)
        .bind(&checkpoint.previous_checkpoint_id).bind(effective_source_digest).bind(first_summary as i64).bind(serde_json::to_string(source_scope)?).fetch_one(&mut *connection).await?;
    if changed_route {
        return Err(invalid("summary request route changed"));
    }
    let (completed, completion) = by_kind(
        connection,
        &event.invocation.invocation_id,
        "model_completed",
        Some(&checkpoint.summary_step_id),
    )
    .await?;
    let Fact::ModelCompleted { output, .. } = &completion.fact else {
        return Err(invalid("missing summary completion"));
    };
    if completion.invocation != event.invocation
        || !(opened < requested && requested < completed && completed < sequence)
        || TextSummary::from_model_step(output, checkpoint.previous_checkpoint_id.is_none())
            .map_err(|_| invalid("invalid completed summary"))?
            != checkpoint.summary
    {
        return Err(invalid("summary does not match its completed model step"));
    }
    Ok(())
}
