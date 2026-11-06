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
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::event::StoredEvent;
use maka_agent_facts::interaction::InteractionRecord;
use serde::de::DeserializeOwned;

mod delivery;
mod message;
pub use message::{AssistantExcerpt, MessageObservation, WorkOrigin};
pub(crate) mod streams;
mod tools;
pub use delivery::{StoreStreamEvent, StreamEventPage, StreamFact, ToolSettlement};
pub use streams::{AssistantStreamSeed, CompactionProgress};
pub use tools::ToolStreamSeed;

/// Metadata, latest root Turn and catch-up cursor from the same SQL snapshot.
pub struct SessionObservation<T> {
    pub session: sessions::SessionRecord<T>,
    pub root_turn: Option<turns::TurnBoundary>,
    pub through_sequence: u64,
    pub active_streams: Vec<AssistantStreamSeed>,
    pub active_tools: Vec<ToolStreamSeed>,
    pub compacting: Option<CompactionProgress>,
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
    pub workspace_revision: u64,
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
        sessions::validate_id(event_id)?;
        if through > i64::MAX as u64 {
            return Err(invalid("invalid event fence"));
        }
        let invocation = invocation.clone();
        let event_id = event_id.to_owned();
        self.connection.read(move |connection| {
            let sql = format!("SELECT e.sequence,e.event_header,{columns} FROM runtime_events e {joins} WHERE e.event_id=?1 AND e.sequence<=?2
                 AND (e.event_header IS NOT NULL AND e.event_session=?3)
                 AND json_extract(e.event_header,'$.invocation.turn_id')=?4",
                columns=crate::canonical::COLUMNS,joins=crate::canonical::JOINS);
            let mut statement = connection.prepare_cached(&sql)?;
            let mut rows = statement.query(rusqlite::params![event_id,through as i64,invocation.session_id,invocation.turn_id])?;
            rows.next()?.map(|row|Ok(StoredEvent {sequence:sequence_number(row.get(0)?)?,event:serde_json::from_str(&crate::canonical::json(row)?)?})).transpose()
        }).await
    }

    pub async fn observation_versions(
        &self,
        sessions: &[String],
    ) -> Result<std::collections::BTreeMap<String, ObservationVersion>, StoreError> {
        for id in sessions {
            crate::sessions::validate_id(id)?;
        }
        let sessions = serde_json::to_string(sessions)?;
        self.connection.read(move |connection| {
            let rows: Vec<(String, i64, i64, i64, i64)> = connection.prepare_cached("SELECT session.id, session.revision,
                    COALESCE((SELECT revision FROM message_queue_state WHERE session_id = session.id), 0),
                    COALESCE((SELECT sequence FROM event_log INDEXED BY event_material_owner
                        WHERE invocation_id IS NOT NULL
                        AND (event_header IS NOT NULL AND event_session=session.id)
                        ORDER BY sequence DESC LIMIT 1), 0),
                    COALESCE((SELECT metadata_epoch FROM workspace_bindings binding WHERE binding.id=json_extract(session.configuration,'$.workspace.id')),0)
                 FROM session_control session
                 WHERE session.id IN (SELECT value FROM json_each(?))")?.query_map(rusqlite::params![sessions], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,)))?.collect::<Result<Vec<_>, _>>()?;
            rows.into_iter().map(|(id, metadata, queue, event, control)| Ok((id, ObservationVersion {
                metadata: sequence_number(metadata)?,
                queue: sequence_number(queue)?,
                event: sequence_number(event)?,
                workspace_revision: sequence_number(control)?,
            }))).collect()
        }).await
    }

    pub async fn session_projection<T: DeserializeOwned + Send + 'static>(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionProjection<T>>, StoreError> {
        self.session_projection_filtered(session_id, false).await
    }

    pub(crate) async fn root_session_projection<T: DeserializeOwned + Send + 'static>(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionProjection<T>>, StoreError> {
        self.session_projection_filtered(session_id, true).await
    }

    async fn session_projection_filtered<T: DeserializeOwned + Send + 'static>(
        &self,
        session_id: &str,
        published_only: bool,
    ) -> Result<Option<SessionProjection<T>>, StoreError> {
        sessions::validate_id(session_id)?;
        let session_id = session_id.to_owned();
        self.connection
            .read(move |connection| {
                let transaction = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                if published_only
                    && !crate::root_store::catalog::session_visible(&transaction, &session_id)?
                {
                    return Ok(None);
                }
                let result = read_projection(&transaction, &session_id)?;
                transaction.commit()?;
                Ok(result)
            })
            .await
    }

    /// Canonical committed sequence in this store, including other Sessions.
    /// Scoped notification watermarks are hints and may lag this SQL boundary.
    pub async fn committed_sequence(&self) -> Result<u64, StoreError> {
        self.connection
            .read(|connection| high_water(connection))
            .await
    }

    pub async fn observe_session<T: DeserializeOwned + Send + 'static>(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionObservation<T>>, StoreError> {
        self.observe_session_filtered(session_id, false).await
    }

    pub(crate) async fn root_observe_session<T: DeserializeOwned + Send + 'static>(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionObservation<T>>, StoreError> {
        self.observe_session_filtered(session_id, true).await
    }

    async fn observe_session_filtered<T: DeserializeOwned + Send + 'static>(
        &self,
        session_id: &str,
        published_only: bool,
    ) -> Result<Option<SessionObservation<T>>, StoreError> {
        sessions::validate_id(session_id)?;
        let session_id = session_id.to_owned();
        self.connection
            .read(move |connection| {
                let transaction = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                if published_only
                    && !crate::root_store::catalog::session_visible(&transaction, &session_id)?
                {
                    return Ok(None);
                }
                let Some(SessionProjection {
                    session,
                    root_turn,
                    through_sequence,
                    pending_interactions,
                }) = read_projection(&transaction, &session_id)?
                else {
                    return Ok(None);
                };
                let active_streams = streams::read(&transaction, root_turn.as_ref())?;
                let active_tools = tools::read(&transaction, root_turn.as_ref())?;
                let compacting = streams::compacting(&transaction, root_turn.as_ref())?;
                transaction.commit()?;
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
                {
                    let transaction = rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Deferred)?;
                    if through > high_water(&transaction)? {
                        return Err(invalid("observation fence is beyond committed history"));
                    }
                    let mut events: Vec<StoredEvent> = Vec::new();
                    let mut bytes = 0usize;
                    let mut next_after = None;
                    {
                        let mut rows_statement = (transaction).prepare_cached(&format!("SELECT e.sequence,e.canonical_bytes,e.event_header,{columns} FROM runtime_events e {joins}
                             WHERE (e.event_header IS NOT NULL AND e.event_session=?1)
                             AND e.sequence>?2 AND e.sequence<=?3 ORDER BY e.sequence LIMIT ?4",
                             columns=crate::canonical::COLUMNS,joins=crate::canonical::JOINS))?;
let mut rows = rows_statement.query(rusqlite::params![&session_id,after_sql,through_sql,max_events as i64 + 1])?;
                        while let Some(row) = rows.next()? {
                            let size = usize::try_from(row.get::<_, i64>(1)?)
                                .map_err(|_| StoreError::PrefixTooLarge)?;
                            if events.len() == max_events || (!events.is_empty() && size > max_bytes.saturating_sub(bytes))
                            {
                                next_after = events.last().map(|event| event.sequence);
                                break;
                            }
                            let sequence = sequence_number(row.get(0)?)?;
                            let event: RuntimeEvent =
                                serde_json::from_str(&crate::canonical::json(row)?)?;
                            if event.invocation.session_id != session_id {
                                return Err(invalid("stored observation scope changed"));
                            }
                            bytes += size;
                            events.push(StoredEvent { sequence, event });
                        }
                    }
                    transaction.commit()?;
                    Ok(EventPage {
                        events,
                        through_sequence: through,
                        next_after,
                    })
                }
            })
            .await
    }
}

fn read_projection<T: DeserializeOwned + Send>(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<SessionProjection<T>>, StoreError> {
    let Some(session) = sessions::read(connection, session_id)? else {
        return Ok(None);
    };
    Ok(Some(SessionProjection {
        session,
        root_turn: turns::read(connection, session_id, None)?,
        through_sequence: high_water(connection)?,
        pending_interactions: crate::interactions::pending(connection, session_id)?,
    }))
}

pub(crate) fn high_water(connection: &rusqlite::Connection) -> Result<u64, StoreError> {
    sequence_number(
        connection
            .prepare_cached("SELECT COALESCE(MAX(sequence), 0) FROM event_log")?
            .query_row(rusqlite::params![], |row| row.get(0))?,
    )
}
fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
