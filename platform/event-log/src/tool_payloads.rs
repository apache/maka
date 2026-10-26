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

use maka_agent_facts::artifact::ArtifactSource;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::event::ToolOutcome;
use maka_agent_facts::tool_output::ToolOutput;
use maka_agent_facts::tool_output::decode_raw_tool_result;
use rusqlite::{Connection as RawConnection, OptionalExtension, params};
use sqlx::{Connection, SqliteConnection};

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

pub(crate) async fn insert(
    connection: &mut SqliteConnection,
    write: &EventWrite,
) -> Result<(), StoreError> {
    if let Fact::ToolSettled {
        outcome: ToolOutcome::Succeeded { artifacts, .. },
        ..
    } = &write.event().fact
        && *artifacts
            != write
                .projection_artifacts()
                .iter()
                .map(|a| a.evidence())
                .collect::<Vec<_>>()
    {
        return Err(invalid());
    }
    if let Some(payload) = write.raw_payload() {
        sqlx::query("INSERT INTO tool_result_payloads (event_id, payload) VALUES (?, ?)")
            .bind(&write.event().id)
            .bind(payload)
            .execute(&mut *connection)
            .await?;
    }
    for pending in write.projection_artifacts() {
        let artifact = pending.artifact();
        if artifact.source != ArtifactSource::ToolResultProjection
            || artifact.session_id != write.event().invocation.session_id
            || artifact.turn_id != write.event().invocation.turn_id
        {
            return Err(invalid());
        }
        crate::artifacts::commit_in_transaction(connection, artifact.clone(), pending.bytes())
            .await?;
    }
    Ok(())
}

pub(crate) async fn verify_replay(
    connection: &mut SqliteConnection,
    write: &EventWrite,
) -> Result<(), StoreError> {
    let equal: Option<bool> =
        sqlx::query_scalar("SELECT payload = ? FROM tool_result_payloads WHERE event_id = ?")
            .bind(write.raw_payload())
            .bind(&write.event().id)
            .fetch_optional(&mut *connection)
            .await?;
    if match write.raw_payload() {
        Some(_) => equal != Some(true),
        None => equal.is_some(),
    } {
        return Err(StoreError::EventConflict);
    }
    for pending in write.projection_artifacts() {
        crate::artifacts::verify_projection_replay(connection, pending.artifact(), pending.bytes())
            .await?;
    }
    Ok(())
}

const RAW_META: &str = r#"SELECT e.event_json, length(p.payload) FROM runtime_events e
         LEFT JOIN tool_result_payloads p ON p.event_id = e.event_id WHERE e.event_id = ?"#;
const RAW_BYTES: &str =
    r#"SELECT payload FROM tool_result_payloads WHERE event_id = ? AND length(payload) = ?"#;

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
    let row: Option<(String, Option<i64>)> = db
        .prepare_cached(RAW_META)?
        .query_row([&event.id], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
    let Some((canonical, bytes)) = row else {
        return Err(invalid());
    };
    if serde_json::from_str::<RuntimeEvent>(&canonical)? != *event {
        return Err(invalid());
    }
    verify_binding(event, bytes)?;
    let payload: Vec<u8> = db
        .prepare_cached(RAW_BYTES)?
        .query_row(params![&event.id, raw.bytes as i64], |row| row.get(0))?;
    decode_raw_tool_result(&payload, raw).map_err(|_| invalid())
}

impl EventLog {
    /// Full raw resolution is bounded and authorized by canonical event + Session.
    pub async fn resolve_tool_result(
        &self,
        session_id: &str,
        event_id: &str,
    ) -> Result<ToolOutput, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session_id)?;
        let (session_id, event_id) = (session_id.to_owned(), event_id.to_owned());
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    let canonical: Option<String> = sqlx::query_scalar(
                "SELECT event_json FROM runtime_events WHERE event_id = ? AND kind = 'tool_settled'
                 AND json_extract(event_json, '$.invocation.session_id') = ?",
            ).bind(event_id).bind(session_id).fetch_optional(&mut *tx).await?;
                    let event =
                        serde_json::from_str::<RuntimeEvent>(&canonical.ok_or_else(invalid)?)?;
                    let output = tx
                        .run_on_worker(move |handle| {
                            // SAFETY: exclusive callback-local non-owning connection;
                            // raw payload and result are owned, no SQLite object escapes.
                            let borrowed = unsafe { RawConnection::from_handle(handle.as_ptr()) }?;
                            borrowed.set_prepared_statement_cache_capacity(100);
                            resolve_in_transaction(&borrowed, &event)
                        })
                        .await??;
                    tx.commit().await?;
                    Ok(output)
                })
            })
            .await
    }
}
