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

//! Disposable identity lookup over immutable opening and steering facts.
use crate::{EventLog, StoreError, sequence_number};
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::event::StoredEvent;
use maka_agent_facts::message::RootSourceMessage;
use sqlx::{Connection, SqliteConnection};

pub(crate) fn roots(event: &RuntimeEvent) -> &[RootSourceMessage] {
    match &event.fact {
        Fact::InvocationOpened {
            input: InvocationInput::Message {
                source_messages, ..
            },
            ..
        } => source_messages,
        Fact::MessageSteered { source, .. } => std::slice::from_ref(source.as_ref()),
        _ => &[],
    }
}
pub(crate) fn identities(event: &RuntimeEvent) -> impl Iterator<Item = &str> {
    roots(event)
        .iter()
        .map(|source| source.message.message_id.as_str())
}
pub(crate) async fn initialize(connection: &mut SqliteConnection) -> Result<(), StoreError> {
    let populated: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM message_sources)")
        .fetch_one(&mut *connection)
        .await?;
    if populated {
        return Ok(());
    }
    let mut tx = connection.begin().await?;
    sqlx::raw_sql(
        "INSERT INTO message_sources
         SELECT json_extract(event_json, '$.invocation.session_id'),
            json_extract(event_json, '$.fact.message.message_id'), event_id
         -- Match runtime_events while using the sparse steering identity index.
         FROM event_log INDEXED BY message_steering_identity
         WHERE kind = 'message_steered' AND invocation_id IS NOT NULL AND event_json IS NOT NULL;
         INSERT INTO message_sources
         SELECT json_extract(e.event_json, '$.invocation.session_id'),
            json_extract(s.value, '$.message_id'), e.event_id
         FROM runtime_events e, json_each(e.event_json, '$.fact.input.source_messages') s
         WHERE e.kind = 'invocation_opened' AND json_extract(e.event_json, '$.fact.input.kind') = 'message'
         AND json_array_length(e.event_json, '$.fact.input.source_messages') > 0;"
    ).execute(&mut *tx).await?;
    tx.commit().await.map_err(StoreError::CommitUnknown)?;
    Ok(())
}
pub(crate) async fn insert(
    connection: &mut SqliteConnection,
    event: &RuntimeEvent,
) -> Result<(), StoreError> {
    for id in identities(event) {
        sqlx::query("INSERT INTO message_sources VALUES (?, ?, ?)")
            .bind(&event.invocation.session_id)
            .bind(id)
            .bind(&event.id)
            .execute(&mut *connection)
            .await?;
    }
    Ok(())
}

#[derive(Debug)]
pub struct RootMessageProof {
    opening: StoredEvent,
    index: usize,
}
impl RootMessageProof {
    pub fn opening(&self) -> &StoredEvent {
        &self.opening
    }
    pub fn source(&self) -> &RootSourceMessage {
        &roots(&self.opening.event)[self.index]
    }
}

impl EventLog {
    /// Last admitted user-message opening in this session's owned history.
    pub async fn latest_message_opening(
        &self,
        session_id: &str,
    ) -> Result<Option<StoredEvent>, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session_id)?;
        let session = session_id.to_owned();
        self.connection.read(move |connection| Box::pin(async move {
            let row: Option<(i64, String)> = sqlx::query_as(
                "WITH candidates AS (
                 SELECT sequence FROM (
                     SELECT e.sequence FROM runtime_events e
                     WHERE json_extract(e.event_json,'$.invocation.session_id')=?1 AND e.kind='invocation_opened' AND json_extract(e.event_json,'$.fact.input.kind')='message'
                     ORDER BY e.sequence DESC LIMIT 1)
                 UNION ALL
                 SELECT sequence FROM (
                     SELECT h.sequence FROM session_history_members h
                     JOIN runtime_events e ON e.sequence=h.sequence
                     WHERE h.session_id=?1 AND e.kind='invocation_opened' AND json_extract(e.event_json,'$.fact.input.kind')='message'
                     ORDER BY h.sequence DESC LIMIT 1)
                 UNION ALL
                 SELECT sequence FROM (
                     SELECT r.sequence FROM session_revision_sources r
                     JOIN runtime_events e ON e.sequence=r.sequence
                     WHERE r.session_id=?1 AND e.kind='invocation_opened' AND json_extract(e.event_json,'$.fact.input.kind')='message'
                     ORDER BY r.sequence DESC LIMIT 1))
                 SELECT e.sequence,e.event_json FROM runtime_events e
                 WHERE e.sequence=(SELECT MAX(sequence) FROM candidates)"
            ).bind(session).fetch_optional(connection).await?;
            row.map(|(sequence, json)| decode_delivery(sequence, json)).transpose()
        })).await
    }
    /// The earliest user-message opening in owned history, including inherited
    /// prefixes. Later messages and successor invocations cannot become the first.
    pub async fn first_message_opening(
        &self,
        session_id: &str,
    ) -> Result<Option<StoredEvent>, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session_id)?;
        let session = session_id.to_owned();
        self.connection
            .run(move |connection| {
                Box::pin(async move { first_message_opening(connection, &session).await })
            })
            .await
    }

    /// Resolve one exact root source from owned history. A Turn can contain
    /// several queued messages; neither its aggregate nor a UI row is the input.
    pub async fn editable_message(
        &self,
        session_id: &str,
        turn_id: &str,
        message_id: &str,
    ) -> Result<Option<maka_agent_facts::message::EditableMessage>, StoreError> {
        self.validate_root()?;
        for id in [session_id, turn_id, message_id] {
            crate::sessions::validate_id(id)?;
        }
        let (session, turn, message) = (
            session_id.to_owned(),
            turn_id.to_owned(),
            message_id.to_owned(),
        );
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    let row: Option<(i64, String)> = sqlx::query_as(
                        "SELECT e.sequence, e.event_json
                 FROM session_message_sources s JOIN runtime_events e ON e.event_id=s.event_id
                 WHERE s.owner_session_id=?1 AND s.message_id=?2
                   AND (e.kind='invocation_opened' OR e.kind='message_steered')
                   AND json_extract(e.event_json,'$.invocation.turn_id')=?3",
                    )
                    .bind(&session)
                    .bind(&message)
                    .bind(&turn)
                    .fetch_optional(&mut *tx)
                    .await?;
                    let Some((sequence, json)) = row else {
                        return Ok(None);
                    };
                    let proof = decode_root(sequence, json, &message)?;
                    if proof.opening.event.invocation.turn_id != turn {
                        return Err(invalid("source proof Turn changed"));
                    }
                    let result =
                        editable(&mut tx, &session, &proof.opening, proof.source()).await?;
                    tx.commit().await?;
                    Ok(Some(result))
                })
            })
            .await
    }

    /// Resolve an original source identity without inferring ownership from UI rows.
    pub async fn root_message(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> Result<Option<RootMessageProof>, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session_id)?;
        crate::sessions::validate_id(message_id)?;
        let session = session_id.to_owned();
        let message = message_id.to_owned();
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let row: Option<(i64, String)> = sqlx::query_as(
                        "SELECT e.sequence, e.event_json
                 FROM message_sources s JOIN runtime_events e ON e.event_id = s.event_id
                 WHERE s.session_id = ? AND s.message_id = ?
                   AND (e.kind='invocation_opened' OR e.kind='message_steered')",
                    )
                    .bind(&session)
                    .bind(&message)
                    .fetch_optional(connection)
                    .await?;
                    let Some((sequence, json)) = row else {
                        return Ok(None);
                    };
                    let proof = decode_root(sequence, json, &message)?;
                    if proof.opening.event.invocation.session_id != session {
                        return Err(invalid("source proof Session changed"));
                    }
                    Ok(Some(proof))
                })
            })
            .await
    }
}

fn decode_root(sequence: i64, json: String, message: &str) -> Result<RootMessageProof, StoreError> {
    let opening = decode_delivery(sequence, json)?;
    let index = roots(&opening.event)
        .iter()
        .position(|source| source.message.message_id == message)
        .ok_or_else(|| invalid("source proof identity changed"))?;
    Ok(RootMessageProof { opening, index })
}

fn decode_delivery(sequence: i64, json: String) -> Result<StoredEvent, StoreError> {
    let event: RuntimeEvent = serde_json::from_str(&json)?;
    match &event.fact {
        Fact::InvocationOpened {
            input:
                InvocationInput::Message {
                    content,
                    source_messages,
                    ..
                },
            ..
        } => maka_agent_facts::message::validate_sources(content, source_messages)
            .map_err(invalid)?,
        Fact::MessageSteered { message, source } => {
            maka_agent_facts::event::validate_steered_source(
                message,
                source,
                &event.invocation.session_id,
            )
            .map_err(invalid)?;
        }
        _ => return Err(invalid("source proof has no canonical input")),
    }
    for source in roots(&event) {
        if let Some(intent) = &source.submitted_intent {
            maka_agent_facts::input::validate_selection_session(
                &intent.input_selection_sources,
                &event.invocation.session_id,
            )
            .map_err(invalid)?;
        }
    }
    Ok(StoredEvent {
        sequence: sequence_number(sequence)?,
        event,
    })
}

async fn editable(
    connection: &mut SqliteConnection,
    session: &str,
    opening: &StoredEvent,
    source: &RootSourceMessage,
) -> Result<maka_agent_facts::message::EditableMessage, StoreError> {
    let mut content = source.unprepared_content.clone();
    if opening.event.invocation.session_id != session {
        for attachment in content.attachments.iter_mut().flatten() {
            if let maka_agent_facts::attachment::StorageRef::SessionFile {
                session_id,
                relative_path,
            } = &attachment.storage_ref
            {
                attachment.storage_ref = crate::artifacts::history::resolve(
                    connection,
                    session,
                    session_id,
                    relative_path,
                )
                .await?
                .ok_or_else(|| invalid("editable source Artifact is missing"))?;
            }
        }
    }
    Ok(maka_agent_facts::message::EditableMessage {
        message_id: source.message.message_id.clone(),
        turn_id: opening.event.invocation.turn_id.clone(),
        content,
        intent: source.submitted_intent.clone(),
    })
}
fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}

/// Shared with auxiliary admission, inside its write transaction.
pub(crate) async fn first_message_opening(
    connection: &mut SqliteConnection,
    session: &str,
) -> Result<Option<StoredEvent>, StoreError> {
    let row: Option<(i64, String, String)> = sqlx::query_as(
        "WITH candidates AS (
                 SELECT sequence FROM (
                     SELECT e.sequence FROM runtime_events e
                     WHERE e.event_json IS NOT NULL AND e.event_session=?1 AND ((e.kind='invocation_opened' AND json_extract(e.event_json,'$.fact.input.kind')='message') OR (e.kind='message_imported' AND json_extract(e.event_json,'$.fact.record.content.kind')='user'))
                     ORDER BY e.sequence ASC LIMIT 1)
                 UNION ALL
                 SELECT sequence FROM (
                     SELECT h.sequence FROM session_history_members h
                     JOIN runtime_events e ON e.sequence=h.sequence
                     WHERE h.session_id=?1 AND ((e.kind='invocation_opened' AND json_extract(e.event_json,'$.fact.input.kind')='message') OR (e.kind='message_imported' AND json_extract(e.event_json,'$.fact.record.content.kind')='user'))
                     ORDER BY h.sequence ASC LIMIT 1)
                 UNION ALL
                 SELECT sequence FROM (
                     SELECT r.sequence FROM session_revision_sources r
                     JOIN runtime_events e ON e.sequence=r.sequence
                     WHERE r.session_id=?1 AND ((e.kind='invocation_opened' AND json_extract(e.event_json,'$.fact.input.kind')='message') OR (e.kind='message_imported' AND json_extract(e.event_json,'$.fact.record.content.kind')='user'))
                     ORDER BY r.sequence ASC LIMIT 1))
                 SELECT e.sequence,e.event_json,e.kind FROM runtime_events e
                 WHERE e.sequence=(SELECT MIN(sequence) FROM candidates)"
    ).bind(session).fetch_optional(connection).await?;
    match row {
        Some((sequence, json, kind)) if kind == "invocation_opened" => {
            decode_delivery(sequence, json).map(Some)
        }
        _ => Ok(None),
    }
}
