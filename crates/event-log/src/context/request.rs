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

use super::{boundary, evidence, invalid, proof, safety, selection::Selection};
use crate::StoreError;
use maka_runtime::{
    context::{CheckpointMode, ModelPurpose, resolve_model_purpose},
    event::{Fact, InvocationInput, RuntimeEvent},
};
use sqlx::SqliteConnection;

pub(super) async fn validate(
    connection: &mut SqliteConnection,
    event: &RuntimeEvent,
) -> Result<(), StoreError> {
    let Fact::ModelRequested {
        purpose,
        source_scope,
        source_high_water,
        source_digest,
        model_id,
        route_identity,
        checkpoint_event_id,
        effective_source_digest,
        ..
    } = &event.fact
    else {
        return Ok(());
    };
    let (opened, opening) = proof::by_kind(
        connection,
        &event.invocation.invocation_id,
        "invocation_opened",
        None,
    )
    .await?;
    let Fact::InvocationOpened { input, .. } = &opening.fact else {
        return Err(invalid("missing opening"));
    };
    if opening.invocation != event.invocation {
        return Err(invalid("request opening identity mismatch"));
    }
    let resolved = resolve_model_purpose(input, *purpose).map_err(invalid)?;
    if resolved == ModelPurpose::Main && matches!(input, InvocationInput::Message { .. }) {
        safety::summary_boundary(connection, &event.invocation.invocation_id).await?;
        return Ok(());
    }
    let selection = Selection::for_opening(connection, &opening).await?;
    let session = &event.invocation.session_id;
    safety::require_safe(connection, session, Some(&event.invocation.invocation_id)).await?;
    if resolved == ModelPurpose::Main {
        safety::model_boundary(connection, &event.invocation.invocation_id, i64::MAX as u64)
            .await?;
    }
    let high = if resolved == ModelPurpose::Summary {
        let mode = match input {
            InvocationInput::ContextCompact { .. } => CheckpointMode::Standalone,
            InvocationInput::Message { .. }
            | InvocationInput::Continuation { .. }
            | InvocationInput::Handoff { .. }
                if *source_high_water < opened =>
            {
                CheckpointMode::PreTurn
            }
            InvocationInput::Message { .. }
            | InvocationInput::Continuation { .. }
            | InvocationInput::Handoff { .. } => CheckpointMode::MidTurn {
                anchor_event_id: opening.id.clone(),
            },
            _ => return Err(invalid("invalid summary opening")),
        };
        boundary::source_fence(
            connection,
            &selection,
            Some(&(opened as i64, opening)),
            &mode,
            source_high_water
                .checked_add(1)
                .ok_or_else(|| invalid("source overflow"))?,
        )
        .await?
    } else {
        safety::model_source_unchanged(
            connection,
            &selection,
            &event.invocation.invocation_id,
            *source_high_water,
        )
        .await?;
        *source_high_water
    };
    if source_scope != &selection.scope
        || high != *source_high_water
        || evidence::selected(connection, &selection, high)
            .await?
            .digest
            != *source_digest
    {
        return Err(invalid("model request source changed"));
    }
    let baseline = super::read::latest_selected(connection, &selection, high).await?;
    if baseline.as_ref().map(|b| &b.event_id) != checkpoint_event_id.as_ref() {
        return Err(invalid(
            "model request omitted or changed the selected baseline",
        ));
    }
    let source = super::SourceEvidence {
        scope: source_scope.clone(),
        high_water: high,
        digest: source_digest.clone(),
    };
    crate::archive::validate_summary(
        connection,
        &source,
        effective_source_digest
            .as_deref()
            .ok_or_else(|| invalid("model request requires effective source evidence"))?,
        i64::MAX as u64,
    )
    .await?;
    if resolved == ModelPurpose::Main {
        return Ok(());
    }
    let first_summary = boundary::summary_start(
        connection,
        &event.invocation.invocation_id,
        source_scope,
        *source_high_water,
        i64::MAX as u64,
    )
    .await?
    .map(|sequence| sequence as i64);
    boundary::admit_summary(
        connection,
        &event.invocation.invocation_id,
        first_summary.map(|value| value as u64),
        *source_high_water,
    )
    .await?;
    let previous_effective: Option<(i64, Option<String>)> = sqlx::query_as(
        "SELECT sequence,json_extract(event_json,'$.fact.effective_source_digest') FROM runtime_events
         WHERE sequence = ?",
    ).bind(first_summary).fetch_optional(&mut *connection).await?;
    if let Some((sequence, expected)) = previous_effective {
        if expected != *effective_source_digest {
            return Err(invalid("summary repair changed effective source"));
        }
        crate::archive::validate_summary(
            connection,
            &source,
            expected
                .as_deref()
                .ok_or_else(|| invalid("summary requires effective source evidence"))?,
            sequence as u64,
        )
        .await?;
    }
    let first: Option<(String, String, i64, String, Option<String>)> = sqlx::query_as(
        "SELECT json_extract(event_json, '$.fact.model_id'), json_extract(event_json, '$.fact.route_identity'),
         json_extract(event_json, '$.fact.source_high_water'), json_extract(event_json, '$.fact.source_digest'),
         json_extract(event_json, '$.fact.checkpoint_event_id') FROM runtime_events
         WHERE sequence = ?",
    ).bind(first_summary).fetch_optional(&mut *connection).await?;
    if first.is_some_and(|(m, r, h, d, p)| {
        m != *model_id
            || r != *route_identity
            || h as u64 != *source_high_water
            || d != *source_digest
            || p != *checkpoint_event_id
    }) {
        return Err(invalid("summary repair changed source or route"));
    }
    Ok(())
}
