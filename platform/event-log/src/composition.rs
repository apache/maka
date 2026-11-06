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
use maka_agent_facts::composition::{CompositionEvidence, RequestComposition};
use maka_agent_facts::event::EventWrite;
use sqlx::{Connection, SqliteConnection};

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
    if let maka_agent_facts::event::Fact::ModelRequested {
        purpose: maka_agent_facts::context::ModelPurpose::Summary,
        source_scope,
        source_high_water,
        ..
    } = &write.event().fact
    {
        let first: Option<Option<String>> = sqlx::query_scalar(
            "SELECT c.digest FROM runtime_events r LEFT JOIN model_request_compositions c ON c.event_id=r.event_id
             WHERE r.invocation_id=?1 AND r.kind='model_requested' AND r.event_id!=?2
               AND json_extract(r.event_header,'$.fact.purpose')='summary'
               AND json_extract(r.event_header,'$.fact.source_scope')=json(?3)
               AND json_extract(r.event_header,'$.fact.source_high_water')=?4
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
    match surface {
        CompositionEvidence::Inline(surface) => {
            store(
                connection,
                surface.digest(),
                surface.value(),
                surface.encoded_len(),
            )
            .await?;
        }
        CompositionEvidence::Committed { event_id, digest } => {
            validate_reference(connection, write.event(), event_id, digest).await?;
        }
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
    event: &maka_agent_facts::event::RuntimeEvent,
    digest: Option<&str>,
) -> Result<(), StoreError> {
    let maka_agent_facts::event::Fact::ModelRequested {
        purpose: maka_agent_facts::context::ModelPurpose::Main,
        source_high_water,
        ..
    } = &event.fact
    else {
        return Ok(());
    };
    let prior: Option<Option<String>> = sqlx::query_scalar(
        "SELECT c.digest FROM runtime_events r LEFT JOIN model_request_compositions c ON c.event_id=r.event_id
         WHERE r.invocation_id=?1 AND r.kind='model_requested' AND r.event_id!=?2 AND r.sequence>?3
           AND json_remove(json_extract(r.event_header,'$.fact'),'$.step_id')=json_remove(json(?4),'$.step_id')
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
    let stored: Option<String> =
        sqlx::query_scalar("SELECT digest FROM model_request_compositions WHERE event_id = ?")
            .bind(&write.event().id)
            .fetch_optional(&mut *connection)
            .await?;
    match (stored, write.composition()) {
        (None, None) => Ok(()),
        (Some(digest), Some(surface)) if digest == surface.digest() => match surface {
            CompositionEvidence::Inline(surface) => {
                if read(connection, &digest).await?.as_ref() == Some(surface.value()) {
                    Ok(())
                } else {
                    Err(StoreError::EventConflict)
                }
            }
            CompositionEvidence::Committed { event_id, digest } => {
                validate_reference(connection, write.event(), event_id, digest).await
            }
        },
        _ => Err(StoreError::EventConflict),
    }
}

// Resolve the original binding rather than accepting a digest from another owner.
// Session retirement removes these bindings, so a collected locator cannot revive bytes.
async fn validate_reference(
    connection: &mut SqliteConnection,
    event: &maka_agent_facts::event::RuntimeEvent,
    event_id: &str,
    digest: &str,
) -> Result<(), StoreError> {
    let stored: Option<String> = sqlx::query_scalar(
        "SELECT c.digest FROM model_request_compositions c
         JOIN runtime_events r ON r.event_id=c.event_id
         WHERE c.event_id=?1 AND r.invocation_id=?2
           AND json_extract(r.event_header,'$.invocation.session_id')=?3",
    )
    .bind(event_id)
    .bind(&event.invocation.invocation_id)
    .bind(&event.invocation.session_id)
    .fetch_optional(connection)
    .await?;
    if stored.as_deref() != Some(digest) {
        return Err(StoreError::InvalidTransition(
            "committed request composition reference is unavailable or differs".into(),
        ));
    }
    Ok(())
}

impl EventLog {
    /// Resolve the frozen request behind a previously validated Main completion.
    pub async fn completed_request_composition(
        &self,
        session: &str,
        sequence: u64,
    ) -> Result<Option<RequestComposition>, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session)?;
        let owned_session = session.to_owned();
        let event_id: Option<String> = self
            .connection
            .read(move |connection| {
                Box::pin(async move {
                    Ok(sqlx::query_scalar(
                        "SELECT r.event_id FROM runtime_events c JOIN runtime_events r
                 ON r.invocation_id=c.invocation_id AND r.operation_id=c.operation_id
                 WHERE c.sequence=?1 AND c.kind='model_completed' AND r.kind='model_requested'
                 AND json_extract(c.event_header,'$.invocation.session_id')=?2",
                    )
                    .bind(sequence as i64)
                    .bind(owned_session)
                    .fetch_optional(connection)
                    .await?)
                })
            })
            .await?;
        match event_id {
            Some(id) => self.request_composition(session, &id).await,
            None => Ok(None),
        }
    }

    pub async fn request_composition(
        &self,
        session: &str,
        event_id: &str,
    ) -> Result<Option<RequestComposition>, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session)?;
        crate::sessions::validate_id(event_id)?;
        let (session, event_id) = (session.to_owned(), event_id.to_owned());
        self.connection.read(move |connection| Box::pin(async move {
            let mut tx=connection.begin().await?;
            let row: Option<String> = sqlx::query_scalar(
                "SELECT composition.digest FROM request_compositions AS composition
                 JOIN model_request_compositions AS request ON request.digest = composition.digest
                 JOIN runtime_events AS event ON event.event_id = request.event_id
                 WHERE request.event_id = ? AND json_extract(event.event_header, '$.invocation.session_id') = ?"
            ).bind(event_id).bind(session).fetch_optional(&mut *tx).await?;
            let result=match row {Some(digest)=>read(&mut tx,&digest).await,None=>Ok(None)};
            tx.rollback().await?;
            result
        })).await
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    dynamic_context: Vec<String>,
    tool_catalog_digest: String,
    provider_options: Option<serde_json::Value>,
    max_output_tokens: Option<u64>,
    sources: Vec<maka_agent_facts::composition::SourceRevision>,
}

pub(crate) async fn store(
    connection: &mut SqliteConnection,
    digest: &str,
    value: &RequestComposition,
    bytes: usize,
) -> Result<(), StoreError> {
    if sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM request_compositions WHERE digest=?)",
    )
    .bind(digest)
    .fetch_one(&mut *connection)
    .await?
    {
        return Ok(());
    }
    let system = if let Some(text) = &value.system_prompt {
        let bytes = serde_json::to_vec(text)?;
        Some(
            crate::content::put(
                connection,
                &maka_agent_facts::artifact::content_digest(&bytes),
                &bytes,
            )
            .await?,
        )
    } else {
        None
    };
    let metadata = Metadata {
        dynamic_context: value.dynamic_context.clone(),
        tool_catalog_digest: value.tool_catalog_digest.clone(),
        provider_options: value.provider_options.clone(),
        max_output_tokens: value.max_output_tokens,
        sources: value.sources.clone(),
    };
    sqlx::query("INSERT INTO request_compositions(digest,metadata,system_content_id,canonical_bytes) VALUES(?,?,?,?)")
        .bind(digest).bind(serde_json::to_string(&metadata)?).bind(system).bind(bytes as i64).execute(&mut *connection).await?;
    for (ordinal, definition) in value.tools.iter().enumerate() {
        let bytes = serde_json::to_vec(definition)?;
        let content = crate::content::put(
            connection,
            &maka_agent_facts::artifact::content_digest(&bytes),
            &bytes,
        )
        .await?;
        sqlx::query("INSERT INTO composition_tools(composition,ordinal,content_id) VALUES(?,?,?)")
            .bind(digest)
            .bind(ordinal as i64)
            .bind(content)
            .execute(&mut *connection)
            .await?;
    }
    Ok(())
}

pub(crate) async fn read(
    connection: &mut SqliteConnection,
    digest: &str,
) -> Result<Option<RequestComposition>, StoreError> {
    let Some((metadata,system))=sqlx::query_as::<_,(String,Option<Vec<u8>>)>(
        "SELECT r.metadata,c.payload FROM request_compositions r LEFT JOIN contents c ON c.id=r.system_content_id WHERE r.digest=?"
    ).bind(digest).fetch_optional(&mut *connection).await? else {return Ok(None)};
    let metadata: Metadata = serde_json::from_str(&metadata)?;
    let tools:Vec<Vec<u8>>=sqlx::query_scalar("SELECT c.payload FROM composition_tools t JOIN contents c ON c.id=t.content_id WHERE t.composition=? ORDER BY t.ordinal")
        .bind(digest).fetch_all(connection).await?;
    Ok(Some(RequestComposition {
        system_prompt: system
            .map(|bytes| serde_json::from_slice(&bytes))
            .transpose()?,
        tools: tools
            .into_iter()
            .map(|bytes| serde_json::from_slice(&bytes).map(std::sync::Arc::new))
            .collect::<Result<_, _>>()?,
        dynamic_context: metadata.dynamic_context,
        tool_catalog_digest: metadata.tool_catalog_digest,
        provider_options: metadata.provider_options,
        max_output_tokens: metadata.max_output_tokens,
        sources: metadata.sources,
    }))
}

pub(crate) async fn encode(
    connection: &mut SqliteConnection,
    digest: &str,
) -> Result<Vec<u8>, StoreError> {
    let value = read(connection, digest)
        .await?
        .ok_or(StoreError::MaterialCollected)?;
    Ok(serde_json::to_vec(&value)?)
}
