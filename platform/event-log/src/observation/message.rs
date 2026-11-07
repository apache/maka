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

use crate::{EventLog, StoreError, message_resolution::MessageExecution};
use rusqlite::OptionalExtension;

pub struct AssistantExcerpt {
    pub text: String,
    pub complete: bool,
}

/// Exact delivery lineage and its terminal answer from one read snapshot.
pub struct MessageObservation {
    pub execution: MessageExecution,
    pub answer: Option<AssistantExcerpt>,
    /// Exact Run-local count from the same snapshot as delivery and answer.
    pub high_water: u64,
    pub interactions: Vec<maka_agent_facts::interaction::InteractionRecord>,
}

/// Durable work origin, independent of a Session's current tip.
pub enum WorkOrigin {
    Message(String),
    Invocation(String),
}
impl EventLog {
    pub async fn message_observation(
        &self,
        session: &str,
        message: &str,
        offset: u64,
    ) -> Result<MessageObservation, StoreError> {
        self.work_observation(session, WorkOrigin::Message(message.into()), offset, None)
            .await
    }

    /// Delivery lineage, original answer and Run-local boundary share one snapshot.
    pub async fn work_observation(
        &self,
        session: &str,
        origin: WorkOrigin,
        offset: u64,
        answer_invocation: Option<&str>,
    ) -> Result<MessageObservation, StoreError> {
        crate::sessions::validate_id(session)?;
        match &origin {
            WorkOrigin::Message(id) | WorkOrigin::Invocation(id) => {
                crate::sessions::validate_id(id)?
            }
        }
        if let Some(id) = answer_invocation {
            crate::sessions::validate_id(id)?;
        }
        if offset > 9_007_199_254_740_991 {
            return Err(StoreError::InvalidTransition(
                "invalid answer offset".into(),
            ));
        }
        let session = session.to_owned();
        let answer_invocation = answer_invocation.map(str::to_owned);
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                let execution = match origin {
                    WorkOrigin::Message(message) => {
                        crate::message_resolution::owner::execution(&tx, &session, &message)?
                    }
                    WorkOrigin::Invocation(invocation) => {
                        let opening: Option<String> = tx
                            .prepare_cached(
                                "SELECT event_header
                         FROM runtime_events WHERE invocation_id = ?1 AND kind = 'invocation_opened'
                         AND json_extract(event_header, '$.invocation.session_id') = ?2",
                            )?
                            .query_row(rusqlite::params![invocation, &session], |row| row.get(0))
                            .optional()?;
                        match opening {
                            None => MessageExecution::Missing,
                            Some(opening) => {
                                let opening: maka_agent_facts::event::RuntimeEvent =
                                    serde_json::from_str(&opening)?;
                                MessageExecution::Owned(Box::new(
                                    crate::message_resolution::owner::lineage(
                                        &tx,
                                        &opening.invocation,
                                    )?,
                                ))
                            }
                        }
                    }
                };
                observe(
                    &tx,
                    &session,
                    execution,
                    offset,
                    answer_invocation.as_deref(),
                )
            })
            .await
    }
}

fn observe(
    tx: &rusqlite::Connection,
    session: &str,
    execution: MessageExecution,
    offset: u64,
    answer_invocation: Option<&str>,
) -> Result<MessageObservation, StoreError> {
    let answer = match &execution {
        MessageExecution::Owned(boundary) | MessageExecution::Shared(boundary)
            if boundary.state.terminal_outcome().is_some()
                && answer_invocation.is_none_or(|id| id == boundary.invocation.invocation_id) =>
        {
            // Do not hydrate model/tool bodies or scan another Run's output.
            // Blob slicing preserves NUL and bounds bytes, not characters.
            let page: Option<(Option<Vec<u8>>, i64)> = tx.prepare_cached("SELECT substr(CAST(text AS BLOB), ?2, 16388), length(CAST(text AS BLOB)) FROM (
                            SELECT completed.sequence, (
                                SELECT group_concat(text, '') FROM (
                                    SELECT json_extract(delta.event_header, '$.fact.output.text') AS text
                                    FROM runtime_events delta
                                    WHERE delta.invocation_id=?1 AND delta.kind='executor_observed'
                                        AND json_extract(delta.event_header, '$.fact.output.messageId')=json_extract(completed.event_header, '$.fact.message_id')
                                        AND json_extract(delta.event_header, '$.fact.output.type')='output_delta'
                                        AND delta.sequence<completed.sequence
                                    ORDER BY delta.sequence
                                )
                            ) AS text FROM runtime_events completed
                            WHERE completed.invocation_id = ?1 AND completed.kind = 'executor_completed'
                            UNION ALL
                            SELECT event.sequence, (
                                SELECT group_concat(json_extract(body, '$.text'), '') FROM (
                                    SELECT CASE json_extract(part.value, '$.kind')
                                        WHEN 'own' THEN json_extract(part.value, '$.data.part')
                                        WHEN 'ref' THEN (
                                            SELECT json_extract(original.event_header, '$.fact.event.data.part')
                                            FROM runtime_events original
                                            WHERE original.event_id = json_extract(part.value, '$.data.event_id')
                                              AND original.invocation_id = event.invocation_id
                                              AND original.sequence < event.sequence
                                              AND original.kind = 'model_observed'
                                              AND json_extract(original.event_header, '$.fact.step_id') = event.operation_id
                                              AND json_extract(original.event_header, '$.fact.event.kind') = 'part'
                                              AND json_extract(original.event_header, '$.fact.event.data.ordinal') = json_extract(part.value, '$.data.ordinal')
                                        ) END AS body
                                    FROM json_each(event.event_header, '$.fact.output.parts') part
                                    ORDER BY CAST(part.key AS INTEGER)
                                ) WHERE json_extract(body, '$.kind') = 'text'
                                    AND json_extract(body, '$.text_kind') = 'text'
                            ) AS text
                            FROM runtime_events event WHERE invocation_id = ?1 AND kind = 'model_completed'
                        ) WHERE text IS NOT NULL AND trim(text) != ''
                        ORDER BY sequence DESC LIMIT 1")?.query_row(rusqlite::params![&boundary.invocation.invocation_id,offset as i64 + 1], |row| Ok((row.get(0)?,row.get(1)?,))).optional()?;
            page.map(|(bytes, total)| {
                if offset > total as u64 {
                    return Err(StoreError::InvalidTransition(
                        "answer cursor exceeds answer length".into(),
                    ));
                }
                let bytes = match bytes {
                    Some(bytes) => bytes,
                    None if offset == total as u64 => Vec::new(),
                    None => {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "answer slice is missing before its end",
                        )
                        .into());
                    }
                };
                let text = match std::str::from_utf8(&bytes) {
                    Ok(text) => text,
                    Err(error) if error.error_len().is_none() && error.valid_up_to() > 0 => {
                        std::str::from_utf8(&bytes[..error.valid_up_to()])
                            .expect("validated UTF-8 prefix")
                    }
                    Err(_) => {
                        return Err(StoreError::InvalidTransition(
                            "answer cursor is not a UTF-8 boundary".into(),
                        ));
                    }
                };
                let end = text.floor_char_boundary(text.len().min(16384));
                Ok(AssistantExcerpt {
                    text: text[..end].into(),
                    complete: offset + end as u64 >= total as u64,
                })
            })
            .transpose()?
        }
        _ => None,
    };
    let interactions = match &execution {
        MessageExecution::Owned(boundary) | MessageExecution::Shared(boundary)
            if boundary.state.terminal_outcome().is_none() =>
        {
            crate::interactions::pending(tx, session)?
                .into_iter()
                .filter(|record| {
                    record.turn_id == boundary.invocation.turn_id
                        && record.run_id == boundary.invocation.run_id
                })
                .collect()
        }
        _ => Vec::new(),
    };

    let high_water = match &execution {
        MessageExecution::Owned(boundary) | MessageExecution::Shared(boundary) => {
            let count: i64 = tx
                .prepare_cached("SELECT COUNT(*) FROM runtime_events WHERE invocation_id = ?")?
                .query_row(
                    rusqlite::params![&boundary.invocation.invocation_id],
                    |row| row.get(0),
                )?;
            count as u64
        }
        _ => 0,
    };
    Ok(MessageObservation {
        execution,
        answer,
        interactions,
        high_water,
    })
}
