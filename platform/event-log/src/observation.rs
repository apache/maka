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

use crate::{EventLog, StoreError, sequence_number, sessions, turns};
use futures_util::TryStreamExt;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::event::StoredEvent;
use maka_agent_facts::interaction::InteractionRecord;
use serde::de::DeserializeOwned;
use sqlx::{Connection, Row};

mod delivery;
mod message;
pub use message::{AssistantExcerpt, MessageObservation, WorkOrigin};
mod streams;
mod tools;
pub use delivery::{StoreStreamEvent, StreamEventPage, StreamFact, ToolSettlement};
pub use streams::AssistantStreamSeed;
pub use tools::ToolStreamSeed;

/// Metadata, latest root Turn and catch-up cursor from the same SQL snapshot.
pub struct SessionObservation<T> {
    pub session: sessions::SessionRecord<T>,
    pub root_turn: Option<turns::TurnBoundary>,
    pub through_sequence: u64,
    pub active_streams: Vec<AssistantStreamSeed>,
    pub active_tools: Vec<ToolStreamSeed>,
    pub compacting: bool,
    pub pending_interactions: Vec<InteractionRecord>,
}

/// Projection-only read: no stream offset aggregation on token wakeups.
pub struct SessionProjection<T> {
    pub session: sessions::SessionRecord<T>,
    pub root_turn: Option<turns::TurnBoundary>,
    pub through_sequence: u64,
    pub pending_interactions: Vec<InteractionRecord>,
}

/// Cheap invalidation basis for an observer, not a delivery or replay cursor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ObservationVersion {
    pub metadata: u64,
    pub queue: u64,
    pub event: u64,
    pub root_control_revision: u64,
}

/// Observation pages are ordered delivery material, not model replay proofs.
pub struct EventPage {
    pub events: Vec<StoredEvent>,
    pub through_sequence: u64,
    /// Continue strictly after this sequence; None means the fence is exhausted.
    pub next_after: Option<u64>,
}

impl EventLog {
    /// Exact, bounded lookup; both Session and logical Turn are authority filters.
    pub async fn execution_event(
        &self,
        invocation: &maka_agent_facts::event::Invocation,
        event_id: &str,
        through: u64,
    ) -> Result<Option<StoredEvent>, StoreError> {
        self.validate_root()?;
        sessions::validate_id(event_id)?;
        if through > i64::MAX as u64 {
            return Err(invalid("invalid event fence"));
        }
        let invocation = invocation.clone();
        let event_id = event_id.to_owned();
        self.connection.read(move |connection| Box::pin(async move {
            let row: Option<(i64, String)> = sqlx::query_as(
                "SELECT sequence, event_json FROM runtime_events WHERE event_id = ?1 AND sequence <= ?2
                 AND (event_json IS NOT NULL AND event_session=?3)
                 AND json_extract(event_json, '$.invocation.turn_id') = ?4"
            ).bind(event_id).bind(through as i64).bind(invocation.session_id).bind(invocation.turn_id)
                .fetch_optional(connection).await?;
            row.map(|(sequence, json)| Ok(StoredEvent {
                sequence: sequence_number(sequence)?, event: serde_json::from_str(&json)?,
            })).transpose()
        })).await
    }

    pub async fn observation_versions(
        &self,
        sessions: &[String],
    ) -> Result<std::collections::BTreeMap<String, ObservationVersion>, StoreError> {
        self.validate_root()?;
        for id in sessions {
            crate::sessions::validate_id(id)?;
        }
        let sessions = serde_json::to_string(sessions)?;
        self.connection.read(move |connection| Box::pin(async move {
            let rows: Vec<(String, i64, i64, i64, i64)> = sqlx::query_as(
                "SELECT session.id, session.revision,
                    COALESCE((SELECT revision FROM message_queue_state WHERE session_id = session.id), 0),
                    COALESCE((SELECT sequence FROM event_log INDEXED BY event_material_owner
                        WHERE invocation_id IS NOT NULL
                        AND (event_json IS NOT NULL AND event_session=session.id)
                        ORDER BY sequence DESC LIMIT 1), 0),
                    control.revision
                 FROM session_control session CROSS JOIN root_app_revision control
                 WHERE session.id IN (SELECT value FROM json_each(?))"
            ).bind(sessions).fetch_all(connection).await?;
            rows.into_iter().map(|(id, metadata, queue, event, control)| Ok((id, ObservationVersion {
                metadata: sequence_number(metadata)?,
                queue: sequence_number(queue)?,
                event: sequence_number(event)?,
                root_control_revision: sequence_number(control)?,
            }))).collect()
        })).await
    }

    pub async fn session_projection<T: DeserializeOwned + Send + 'static>(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionProjection<T>>, StoreError> {
        self.session_projection_filtered(session_id, None).await
    }

    pub(crate) async fn root_session_projection<T: DeserializeOwned + Send + 'static>(
        &self,
        session_id: &str,
        partition: usize,
    ) -> Result<Option<SessionProjection<T>>, StoreError> {
        self.session_projection_filtered(session_id, Some(partition))
            .await
    }

    async fn session_projection_filtered<T: DeserializeOwned + Send + 'static>(
        &self,
        session_id: &str,
        partition: Option<usize>,
    ) -> Result<Option<SessionProjection<T>>, StoreError> {
        self.validate_root()?;
        sessions::validate_id(session_id)?;
        let session_id = session_id.to_owned();
        self.connection
            .read(move |connection| {
                Box::pin(async move {
                    let mut transaction = connection.begin().await?;
                    if let Some(partition) = partition
                        && !crate::root_store::catalog::session_visible(
                            &mut transaction,
                            partition,
                            &session_id,
                        )
                        .await?
                    {
                        return Ok(None);
                    }
                    let result = read_projection(&mut transaction, &session_id).await?;
                    transaction.commit().await?;
                    Ok(result)
                })
            })
            .await
    }

    pub async fn observe_session<T: DeserializeOwned + Send + 'static>(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionObservation<T>>, StoreError> {
        self.observe_session_filtered(session_id, None).await
    }

    pub(crate) async fn root_observe_session<T: DeserializeOwned + Send + 'static>(
        &self,
        session_id: &str,
        partition: usize,
    ) -> Result<Option<SessionObservation<T>>, StoreError> {
        self.observe_session_filtered(session_id, Some(partition))
            .await
    }

    async fn observe_session_filtered<T: DeserializeOwned + Send + 'static>(
        &self,
        session_id: &str,
        partition: Option<usize>,
    ) -> Result<Option<SessionObservation<T>>, StoreError> {
        self.validate_root()?;
        sessions::validate_id(session_id)?;
        let session_id = session_id.to_owned();
        self.connection
            .read(move |connection| {
                Box::pin(async move {
                    let mut transaction = connection.begin().await?;
                    if let Some(partition) = partition
                        && !crate::root_store::catalog::session_visible(
                            &mut transaction,
                            partition,
                            &session_id,
                        )
                        .await?
                    {
                        return Ok(None);
                    }
                    let Some(SessionProjection {
                        session,
                        root_turn,
                        through_sequence,
                        pending_interactions,
                    }) = read_projection(&mut transaction, &session_id).await?
                    else {
                        return Ok(None);
                    };
                    let active_streams =
                        streams::read(&mut transaction, root_turn.as_ref()).await?;
                    let active_tools = tools::read(&mut transaction, root_turn.as_ref()).await?;
                    let compacting =
                        streams::compacting(&mut transaction, root_turn.as_ref()).await?;
                    transaction.commit().await?;
                    Ok(Some(SessionObservation {
                        session,
                        root_turn,
                        through_sequence,
                        active_streams,
                        active_tools,
                        compacting,
                        pending_interactions,
                    }))
                })
            })
            .await
    }

    /// Subscribe to commit wakeups before taking the initial fence. Catch-up
    /// consumes only (after, through]; later commits cannot change this page.
    pub async fn session_events(
        &self,
        session_id: &str,
        after: u64,
        through: u64,
        max_events: usize,
        max_bytes: usize,
    ) -> Result<EventPage, StoreError> {
        self.validate_root()?;
        sessions::validate_id(session_id)?;
        if after > through || max_events == 0 || max_events > 512 || max_bytes == 0 {
            return Err(invalid("invalid observation page bounds"));
        }
        let after_sql = i64::try_from(after).map_err(|_| invalid("invalid observation cursor"))?;
        let through_sql =
            i64::try_from(through).map_err(|_| invalid("invalid observation fence"))?;
        let session_id = session_id.to_owned();
        self.connection
            .read(move |connection| {
                Box::pin(async move {
                    let mut transaction = connection.begin().await?;
                    if through > high_water(&mut transaction).await? {
                        return Err(invalid("observation fence is beyond committed history"));
                    }
                    let mut events: Vec<StoredEvent> = Vec::new();
                    let mut bytes = 0usize;
                    let mut next_after = None;
                    {
                        let mut rows = sqlx::query(
                            "SELECT sequence, length(CAST(event_json AS BLOB)), event_json FROM runtime_events
                             WHERE (event_json IS NOT NULL AND event_session=?1)
                             AND sequence > ?2 AND sequence <= ?3 ORDER BY sequence LIMIT ?4",
                        )
                        .bind(&session_id)
                        .bind(after_sql)
                        .bind(through_sql)
                        .bind(max_events as i64 + 1)
                        .fetch(&mut *transaction);
                        while let Some(row) = rows.try_next().await? {
                            let size = usize::try_from(row.try_get::<i64, _>(1)?)
                                .map_err(|_| StoreError::PrefixTooLarge)?;
                            if events.len() == max_events || (!events.is_empty() && size > max_bytes.saturating_sub(bytes))
                            {
                                next_after = events.last().map(|event| event.sequence);
                                break;
                            }
                            let sequence = sequence_number(row.try_get(0)?)?;
                            let event: RuntimeEvent =
                                serde_json::from_str(row.try_get::<&str, _>(2)?)?;
                            if event.invocation.session_id != session_id {
                                return Err(invalid("stored observation scope changed"));
                            }
                            bytes += size;
                            events.push(StoredEvent { sequence, event });
                        }
                    }
                    transaction.commit().await?;
                    Ok(EventPage {
                        events,
                        through_sequence: through,
                        next_after,
                    })
                })
            })
            .await
    }
}

async fn read_projection<T: DeserializeOwned + Send>(
    connection: &mut sqlx::SqliteConnection,
    session_id: &str,
) -> Result<Option<SessionProjection<T>>, StoreError> {
    let Some(session) = sessions::read(connection, session_id).await? else {
        return Ok(None);
    };
    Ok(Some(SessionProjection {
        session,
        root_turn: turns::read(connection, session_id, None).await?,
        through_sequence: high_water(connection).await?,
        pending_interactions: crate::interactions::pending(connection, session_id).await?,
    }))
}

pub(crate) async fn high_water(connection: &mut sqlx::SqliteConnection) -> Result<u64, StoreError> {
    sequence_number(
        sqlx::query_scalar("SELECT COALESCE(MAX(sequence), 0) FROM event_log")
            .fetch_one(connection)
            .await?,
    )
}
fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
