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

mod material;
use maka_agent_facts::artifact::ArtifactSource;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::event::ToolOutcome;
use maka_agent_facts::tool_output::ToolOutput;
use maka_agent_facts::tool_output::decode_raw_tool_result;
pub(crate) use material::{PreparedToolMaterial, encode};
use rusqlite::{Connection as RawConnection, OptionalExtension};

use crate::{EventLog, StoreError};

fn invalid() -> StoreError {
    StoreError::InvalidTransition("missing or inconsistent durable tool payload".into())
}

/// Metadata validation deliberately does not hydrate or hash historical raw.
pub(crate) fn verify_binding(event: &RuntimeEvent, bytes: Option<i64>) -> Result<(), StoreError> {
    match &event.fact {
        Fact::ToolSettled {
            outcome:
                ToolOutcome::Succeeded {
                    raw,
                    model_projection,
                    artifacts,
                    ..
                },
            ..
        } => {
            if raw.bytes == 0
                || bytes.and_then(|n| u64::try_from(n).ok()) != Some(raw.bytes)
                || raw.digest.len() != 71
                || !raw.digest.starts_with("sha256:")
                || !raw.digest.as_bytes()[7..].iter().all(u8::is_ascii_hexdigit)
            {
                return Err(invalid());
            }
            model_projection
                .validate(&event.invocation.session_id)
                .map_err(|_| invalid())?;
            let mut ids = std::collections::HashSet::new();
            let references = crate::artifacts::references::from_event(event);
            for artifact in artifacts {
                if !ids.insert(&artifact.id)
                    || maka_agent_facts::interaction::entity_id(&artifact.id).is_err()
                    || artifact.bytes > 9_007_199_254_740_991
                    || !maka_agent_facts::archive::valid_projection_digest(&artifact.digest)
                    || !references.iter().any(|(reference, _)| {
                        matches!(reference, maka_agent_facts::attachment::StorageRef::SessionFile { session_id, relative_path }
                            if session_id == &event.invocation.session_id && relative_path == &artifact.id)
                    }) {
                    return Err(invalid());
                }
            }
        }
        _ if bytes.is_some() => return Err(invalid()),
        _ => {}
    }
    Ok(())
}

pub(crate) struct PreparedToolWrite {
    raw: Option<PreparedToolMaterial>,
    artifacts: Vec<crate::artifacts::PreparedArtifact>,
}

fn projection_evidence(write: &EventWrite) -> &[maka_agent_facts::artifact::ArtifactEvidence] {
    match &write.event().fact {
        Fact::ToolSettled {
            outcome: ToolOutcome::Succeeded { artifacts, .. },
            ..
        } => artifacts,
        _ => &[],
    }
}

pub(crate) fn prepare(write: &EventWrite) -> Result<PreparedToolWrite, StoreError> {
    let raw = if let Some(bytes) = write.raw_payload() {
        let Fact::ToolSettled {
            outcome: ToolOutcome::Succeeded { raw, .. },
            ..
        } = &write.event().fact
        else {
            return Err(invalid());
        };
        Some(PreparedToolMaterial::new(bytes, &raw.digest)?)
    } else {
        None
    };
    let evidence = projection_evidence(write);
    if evidence.len() != write.projection_artifacts().len() {
        return Err(invalid());
    }
    let artifacts = write
        .projection_artifacts()
        .iter()
        .zip(evidence)
        .map(|(pending, evidence)| {
            let artifact = pending.artifact();
            if artifact.source != ArtifactSource::ToolResultProjection
                || artifact.session_id != write.event().invocation.session_id
                || artifact.turn_id != write.event().invocation.turn_id
            {
                return Err(invalid());
            }
            crate::artifacts::PreparedArtifact::from_projection(pending, evidence)
        })
        .collect::<Result<_, _>>()?;
    Ok(PreparedToolWrite { raw, artifacts })
}

pub(crate) fn insert_prepared(
    connection: &rusqlite::Connection,
    write: &EventWrite,
    prepared: PreparedToolWrite,
) -> Result<(), StoreError> {
    if let Some(raw) = prepared.raw {
        raw.store(connection, &write.event().id)?;
    }
    for (artifact, pending) in prepared
        .artifacts
        .into_iter()
        .zip(write.projection_artifacts())
    {
        crate::artifacts::commit_prepared(connection, artifact, pending.bytes())?;
    }
    Ok(())
}

pub(crate) fn verify_replay(
    connection: &rusqlite::Connection,
    write: &EventWrite,
) -> Result<(), StoreError> {
    let stored: Option<String> = connection
        .prepare_cached("SELECT raw_digest FROM tool_result_payloads WHERE event_id = ?")?
        .query_row([&write.event().id], |row| row.get(0))
        .optional()?;
    let expected = match &write.event().fact {
        Fact::ToolSettled {
            outcome: ToolOutcome::Succeeded { raw, .. },
            ..
        } if write.raw_payload().is_some() => Some(raw.digest.as_str()),
        _ => None,
    };
    if stored.as_deref() != expected {
        return Err(StoreError::EventConflict);
    }
    for (pending, evidence) in write
        .projection_artifacts()
        .iter()
        .zip(projection_evidence(write))
    {
        crate::artifacts::verify_projection_replay(
            connection,
            pending.artifact(),
            pending.bytes(),
            &evidence.digest,
        )?;
    }
    Ok(())
}

fn raw_meta() -> String {
    format!(
        "SELECT e.event_header, p.raw_bytes AS payload_bytes,{} FROM runtime_events e {}
         LEFT JOIN tool_result_payloads p ON p.event_id=e.event_id WHERE e.event_id=?",
        crate::canonical::COLUMNS,
        crate::canonical::JOINS
    )
}
/// Selected T2 only; proof and original payload reads share the caller snapshot.
pub(crate) fn resolve_in_transaction(
    db: &RawConnection,
    event: &RuntimeEvent,
) -> Result<ToolOutput, StoreError> {
    let Fact::ToolSettled {
        outcome: ToolOutcome::Succeeded { raw, .. },
        ..
    } = &event.fact
    else {
        return Err(invalid());
    };
    let row = db
        .prepare_cached(&raw_meta())?
        .query_row([&event.id], |row| {
            Ok((
                crate::canonical::json_on_handle(row).map(|json| json.into_owned()),
                row.get::<_, Option<i64>>("payload_bytes")?,
            ))
        })
        .optional()?;
    let Some((canonical, bytes)) = row else {
        return Err(invalid());
    };
    if serde_json::from_str::<RuntimeEvent>(&canonical?)? != *event {
        return Err(invalid());
    }
    verify_binding(event, bytes)?;
    let output = material::read_on_handle(db, &event.id)?;
    let encoded = serde_json::to_vec(&output)?;
    decode_raw_tool_result(&encoded, raw).map_err(|_| invalid())
}

impl EventLog {
    /// Full raw resolution is bounded and authorized by canonical event + Session.
    pub async fn resolve_tool_result(
        &self,
        session_id: &str,
        event_id: &str,
    ) -> Result<ToolOutput, StoreError> {
        crate::sessions::validate_id(session_id)?;
        let (session_id, event_id) = (session_id.to_owned(), event_id.to_owned());
        self.connection
            .read(move |connection| {
                {
                    let tx = rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Deferred)?;
                    let row = tx.prepare_cached(&(format!(
                        "SELECT e.event_header,{} FROM runtime_events e {} WHERE e.event_id=? AND e.kind='tool_settled'
                         AND json_extract(e.event_header,'$.invocation.session_id')=?",
                        crate::canonical::COLUMNS, crate::canonical::JOINS
                    )))?.query_row(rusqlite::params![event_id, session_id], |row| Ok(crate::canonical::json(row).map(|v|v.into_owned()))).optional()?
                        .ok_or_else(invalid)?;
                    let event = serde_json::from_str::<RuntimeEvent>(&row?)?;
                    let output = resolve_in_transaction(&tx, &event)?;
                    tx.commit()?;
                    Ok(output)
                }
            })
            .await
    }
}

pub(crate) fn store_raw(
    connection: &rusqlite::Connection,
    event: &str,
    bytes: &[u8],
) -> Result<(), StoreError> {
    material::store(
        connection,
        event,
        bytes,
        &maka_agent_facts::artifact::content_digest(bytes),
    )
}
