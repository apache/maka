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
use rusqlite::OptionalExtension;

pub(crate) fn insert(
    connection: &rusqlite::Connection,
    write: &EventWrite,
) -> Result<(), StoreError> {
    validate_retry(
        connection,
        write.event(),
        write.composition().map(|surface| surface.digest()),
    )?;
    if let maka_agent_facts::event::Fact::ModelRequested {
        purpose: maka_agent_facts::context::ModelPurpose::Summary,
        source_scope,
        source_high_water,
        ..
    } = &write.event().fact
    {
        let first: Option<Option<String>> = connection.prepare_cached("SELECT c.digest FROM runtime_events r LEFT JOIN model_request_compositions c ON c.event_id=r.event_id
             WHERE r.invocation_id=?1 AND r.kind='model_requested' AND r.event_id!=?2
               AND json_extract(r.event_header,'$.fact.purpose')='summary'
               AND json_extract(r.event_header,'$.fact.source_scope')=json(?3)
               AND json_extract(r.event_header,'$.fact.source_high_water')=?4
             ORDER BY r.sequence LIMIT 1")?.query_row(rusqlite::params![&write.event().invocation.invocation_id, &write.event().id, serde_json::to_string(source_scope)?, *source_high_water as i64], |row| row.get(0)).optional()?;
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
            )?;
        }
        CompositionEvidence::Committed { event_id, digest } => {
            validate_reference(connection, write.event(), event_id, digest)?;
        }
    }
    connection
        .prepare_cached("INSERT INTO model_request_compositions (event_id, digest) VALUES (?, ?)")?
        .execute(rusqlite::params![&write.event().id, surface.digest()])?;
    Ok(())
}

/// Replaying a frozen Main request cannot replace its capability/model surface.
/// This runs inside live append and bundle validation, after causal validation.
pub(crate) fn validate_retry(
    connection: &rusqlite::Connection,
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
    let prior: Option<Option<String>> = connection.prepare_cached("SELECT c.digest FROM runtime_events r LEFT JOIN model_request_compositions c ON c.event_id=r.event_id
         WHERE r.invocation_id=?1 AND r.kind='model_requested' AND r.event_id!=?2 AND r.sequence>?3
           AND json_remove(json_extract(r.event_header,'$.fact'),'$.step_id')=json_remove(json(?4),'$.step_id')
         ORDER BY r.sequence LIMIT 1")?.query_row(rusqlite::params![&event.invocation.invocation_id, &event.id, *source_high_water as i64, serde_json::to_string(&event.fact)?], |row| row.get(0)).optional()?;
    if prior.is_some_and(|prior| prior.as_deref() != digest) {
        return Err(StoreError::InvalidTransition(
            "main retry changed frozen composition".into(),
        ));
    }
    Ok(())
}

pub(crate) fn verify_replay(
    connection: &rusqlite::Connection,
    write: &EventWrite,
) -> Result<(), StoreError> {
    let stored: Option<String> = connection
        .prepare_cached("SELECT digest FROM model_request_compositions WHERE event_id = ?")?
        .query_row(rusqlite::params![&write.event().id], |row| row.get(0))
        .optional()?;
    match (stored, write.composition()) {
        (None, None) => Ok(()),
        (Some(digest), Some(surface)) if digest == surface.digest() => match surface {
            CompositionEvidence::Inline(surface) => {
                if read(connection, &digest)?.as_ref() == Some(surface.value()) {
                    Ok(())
                } else {
                    Err(StoreError::EventConflict)
                }
            }
            CompositionEvidence::Committed { event_id, digest } => {
                validate_reference(connection, write.event(), event_id, digest)
            }
        },
        _ => Err(StoreError::EventConflict),
    }
}

// Resolve the original binding rather than accepting a digest from another owner.
// Session retirement removes these bindings, so a collected locator cannot revive bytes.
fn validate_reference(
    connection: &rusqlite::Connection,
    event: &maka_agent_facts::event::RuntimeEvent,
    event_id: &str,
    digest: &str,
) -> Result<(), StoreError> {
    let stored: Option<String> = connection
        .prepare_cached(
            "SELECT c.digest FROM model_request_compositions c
         JOIN runtime_events r ON r.event_id=c.event_id
         WHERE c.event_id=?1 AND r.invocation_id=?2
           AND json_extract(r.event_header,'$.invocation.session_id')=?3",
        )?
        .query_row(
            rusqlite::params![
                event_id,
                &event.invocation.invocation_id,
                &event.invocation.session_id
            ],
            |row| row.get(0),
        )
        .optional()?;
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
        crate::sessions::validate_id(session)?;
        let owned_session = session.to_owned();
        let event_id: Option<String> = self
            .connection
            .read(move |connection| {
                {
                    Ok(connection
                        .prepare_cached(
                            "SELECT r.event_id FROM runtime_events c JOIN runtime_events r
                 ON r.invocation_id=c.invocation_id AND r.operation_id=c.operation_id
                 WHERE c.sequence=?1 AND c.kind='model_completed' AND r.kind='model_requested'
                 AND json_extract(c.event_header,'$.invocation.session_id')=?2",
                        )?
                        .query_row(rusqlite::params![sequence as i64, owned_session], |row| {
                            row.get(0)
                        })
                        .optional()?)
                }
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
        crate::sessions::validate_id(session)?;
        crate::sessions::validate_id(event_id)?;
        let (session, event_id) = (session.to_owned(), event_id.to_owned());
        self.connection.read(move |connection| {
            let tx=rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Deferred)?;
            let row: Option<String> = tx.prepare_cached("SELECT composition.digest FROM request_compositions AS composition
                 JOIN model_request_compositions AS request ON request.digest = composition.digest
                 JOIN runtime_events AS event ON event.event_id = request.event_id
                 WHERE request.event_id = ? AND json_extract(event.event_header, '$.invocation.session_id') = ?")?.query_row(rusqlite::params![event_id, session], |row| row.get(0)).optional()?;
            let result=match row {Some(digest)=>read(&tx,&digest),None=>Ok(None)};
            tx.rollback()?;
            result
        }).await
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

pub(crate) fn store(
    connection: &rusqlite::Connection,
    digest: &str,
    value: &RequestComposition,
    bytes: usize,
) -> Result<(), StoreError> {
    if connection
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM request_compositions WHERE digest=?)")?
        .query_row(rusqlite::params![digest], |row| row.get(0))?
    {
        return Ok(());
    }
    let system = if let Some(text) = &value.system_prompt {
        let bytes = serde_json::to_vec(text)?;
        Some(crate::content::put(
            connection,
            &maka_agent_facts::artifact::content_digest(&bytes),
            &bytes,
        )?)
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
    connection.prepare_cached("INSERT INTO request_compositions(digest,metadata,system_content_id,canonical_bytes) VALUES(?,?,?,?)")?.execute(rusqlite::params![digest, serde_json::to_string(&metadata)?, system, bytes as i64])?;
    for (ordinal, definition) in value.tools.iter().enumerate() {
        let bytes = serde_json::to_vec(definition)?;
        let content = crate::content::put(
            connection,
            &maka_agent_facts::artifact::content_digest(&bytes),
            &bytes,
        )?;
        connection
            .prepare_cached(
                "INSERT INTO composition_tools(composition,ordinal,content_id) VALUES(?,?,?)",
            )?
            .execute(rusqlite::params![digest, ordinal as i64, content])?;
    }
    Ok(())
}

pub(crate) fn read(
    connection: &rusqlite::Connection,
    digest: &str,
) -> Result<Option<RequestComposition>, StoreError> {
    let Some((metadata,system))=connection.prepare_cached("SELECT r.metadata,c.payload FROM request_compositions r LEFT JOIN contents c ON c.id=r.system_content_id WHERE r.digest=?")?.query_row(rusqlite::params![digest], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<Vec<u8>>>(1)?,))).optional()? else {return Ok(None)};
    let metadata: Metadata = serde_json::from_str(&metadata)?;
    let tools:Vec<Vec<u8>>=connection.prepare_cached("SELECT c.payload FROM composition_tools t JOIN contents c ON c.id=t.content_id WHERE t.composition=? ORDER BY t.ordinal")?.query_map(rusqlite::params![digest], |row| row.get(0))?.collect::<Result<Vec<_>, _>>()?;
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

pub(crate) fn encode(
    connection: &rusqlite::Connection,
    digest: &str,
) -> Result<Vec<u8>, StoreError> {
    let value = read(connection, digest)?.ok_or(StoreError::MaterialCollected)?;
    Ok(serde_json::to_vec(&value)?)
}
