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

use crate::{EventLog, StoreError};
use maka_runtime::{artifact::content_digest, composition::RequestComposition, event::EventWrite};
use sqlx::SqliteConnection;

pub(crate) async fn insert(
    connection: &mut SqliteConnection,
    write: &EventWrite,
) -> Result<(), StoreError> {
    validate_retry(
        connection,
        write.event(),
        write.composition().map(|surface| surface.digest()),
    )
    .await?;
    if let maka_runtime::event::Fact::ModelRequested {
        purpose: maka_runtime::context::ModelPurpose::Summary,
        source_scope,
        source_high_water,
        ..
    } = &write.event().fact
    {
        let first: Option<Option<String>> = sqlx::query_scalar(
            "SELECT c.digest FROM runtime_events r LEFT JOIN model_request_compositions c ON c.event_id=r.event_id
             WHERE r.invocation_id=?1 AND r.kind='model_requested' AND r.event_id!=?2
               AND json_extract(r.event_json,'$.fact.purpose')='summary'
               AND json_extract(r.event_json,'$.fact.source_scope')=json(?3)
               AND json_extract(r.event_json,'$.fact.source_high_water')=?4
             ORDER BY r.sequence LIMIT 1",
        ).bind(&write.event().invocation.invocation_id).bind(&write.event().id)
            .bind(serde_json::to_string(source_scope)?).bind(*source_high_water as i64)
            .fetch_optional(&mut *connection).await?;
        if first.is_some_and(|digest| {
            digest.as_deref() != write.composition().map(|surface| surface.digest())
        }) {
            return Err(StoreError::InvalidTransition(
                "summary repair changed frozen composition".into(),
            ));
        }
    }
    let Some(surface) = write.composition() else {
        return Ok(());
    };
    sqlx::query("INSERT INTO request_compositions (digest, surface) VALUES (?, ?) ON CONFLICT(digest) DO NOTHING")
        .bind(surface.digest()).bind(surface.bytes()).execute(&mut *connection).await?;
    // A digest is an index, not permission to disregard inconsistent stored bytes.
    let identical: bool =
        sqlx::query_scalar("SELECT surface = ? FROM request_compositions WHERE digest = ?")
            .bind(surface.bytes())
            .bind(surface.digest())
            .fetch_one(&mut *connection)
            .await?;
    if !identical {
        return Err(StoreError::EventConflict);
    }
    sqlx::query("INSERT INTO model_request_compositions (event_id, digest) VALUES (?, ?)")
        .bind(&write.event().id)
        .bind(surface.digest())
        .execute(connection)
        .await?;
    Ok(())
}

/// Replaying a frozen Main request cannot replace its capability/model surface.
/// This runs inside live append and bundle validation, after causal validation.
pub(crate) async fn validate_retry(
    connection: &mut SqliteConnection,
    event: &maka_runtime::event::RuntimeEvent,
    digest: Option<&str>,
) -> Result<(), StoreError> {
    let maka_runtime::event::Fact::ModelRequested {
        purpose: maka_runtime::context::ModelPurpose::Main,
        source_high_water,
        ..
    } = &event.fact
    else {
        return Ok(());
    };
    let prior: Option<Option<String>> = sqlx::query_scalar(
        "SELECT c.digest FROM runtime_events r LEFT JOIN model_request_compositions c ON c.event_id=r.event_id
         WHERE r.invocation_id=?1 AND r.kind='model_requested' AND r.event_id!=?2 AND r.sequence>?3
           AND json_remove(json_extract(r.event_json,'$.fact'),'$.step_id')=json_remove(json(?4),'$.step_id')
         ORDER BY r.sequence LIMIT 1"
    ).bind(&event.invocation.invocation_id).bind(&event.id).bind(*source_high_water as i64)
        .bind(serde_json::to_string(&event.fact)?).fetch_optional(connection).await?;
    if prior.is_some_and(|prior| prior.as_deref() != digest) {
        return Err(StoreError::InvalidTransition(
            "main retry changed frozen composition".into(),
        ));
    }
    Ok(())
}

pub(crate) async fn verify_replay(
    connection: &mut SqliteConnection,
    write: &EventWrite,
) -> Result<(), StoreError> {
    let stored: Option<(String, Vec<u8>)> = sqlx::query_as(
        "SELECT digest, surface FROM request_compositions JOIN model_request_compositions USING(digest) WHERE event_id = ?"
    ).bind(&write.event().id).fetch_optional(connection).await?;
    match (stored, write.composition()) {
        (None, None) => Ok(()),
        (Some((digest, bytes)), Some(surface))
            if digest == surface.digest() && bytes == surface.bytes() =>
        {
            Ok(())
        }
        _ => Err(StoreError::EventConflict),
    }
}

impl EventLog {
    pub async fn request_composition(
        &self,
        session: &str,
        event_id: &str,
    ) -> Result<Option<RequestComposition>, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session)?;
        crate::sessions::validate_id(event_id)?;
        let (session, event_id) = (session.to_owned(), event_id.to_owned());
        self.connection.run(move |connection| Box::pin(async move {
            let row: Option<(String, Vec<u8>)> = sqlx::query_as(
                "SELECT composition.digest, composition.surface FROM request_compositions AS composition
                 JOIN model_request_compositions AS request ON request.digest = composition.digest
                 JOIN runtime_events AS event ON event.event_id = request.event_id
                 WHERE request.event_id = ? AND json_extract(event.event_json, '$.invocation.session_id') = ?"
            ).bind(event_id).bind(session).fetch_optional(connection).await?;
            row.map(|(digest, bytes)| {
                if content_digest(&bytes) != digest { return Err(StoreError::InvalidTransition("request composition integrity mismatch".into())); }
                let surface: RequestComposition = serde_json::from_slice(&bytes)?;
                surface.clone().freeze().map_err(|error| StoreError::InvalidTransition(error.into()))?;
                Ok(surface)
            }).transpose()
        })).await
    }
}
