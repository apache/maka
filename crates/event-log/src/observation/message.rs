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
use sqlx::Connection;

pub struct AssistantExcerpt {
    pub text: String,
    pub complete: bool,
}

/// Exact delivery lineage and its terminal answer from one read snapshot.
pub struct MessageObservation {
    pub execution: MessageExecution,
    pub answer: Option<AssistantExcerpt>,
    pub interactions: Vec<maka_runtime::interaction::InteractionRecord>,
}

impl EventLog {
    pub async fn message_observation(
        &self,
        session: &str,
        message: &str,
        offset: u64,
    ) -> Result<MessageObservation, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session)?;
        crate::sessions::validate_id(message)?;
        if offset > 9_007_199_254_740_991 {
            return Err(StoreError::InvalidTransition(
                "invalid answer offset".into(),
            ));
        }
        let (session, message) = (session.to_owned(), message.to_owned());
        self.connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin().await?;
            let execution = crate::message_resolution::owner::execution(&mut tx, &session, &message).await?;
            let answer = match &execution {
                MessageExecution::Owned(boundary) | MessageExecution::Shared(boundary)
                    if boundary.state.terminal_outcome().is_some() => {
                    // Do not hydrate model/tool bodies or scan another Run's output.
                    // Blob slicing preserves NUL and bounds bytes, not characters.
                    let page: Option<(Vec<u8>, i64)> = sqlx::query_as(
                        "SELECT substr(CAST(text AS BLOB), ?2, 16388), length(CAST(text AS BLOB)) FROM (
                            SELECT sequence, json_extract(event_json, '$.fact.text') AS text
                            FROM runtime_events WHERE invocation_id = ?1 AND kind = 'executor_completed'
                            UNION ALL
                            SELECT event.sequence, (
                                SELECT group_concat(json_extract(part.value, '$.text'), '')
                                FROM json_each(event.event_json, '$.fact.output.parts') part
                                WHERE json_extract(part.value, '$.kind') = 'text'
                                  AND json_extract(part.value, '$.text_kind') = 'text'
                            ) AS text
                            FROM runtime_events event WHERE invocation_id = ?1 AND kind = 'model_completed'
                        ) WHERE text IS NOT NULL AND trim(text) != ''
                        ORDER BY sequence DESC LIMIT 1"
                    ).bind(&boundary.invocation.invocation_id).bind(offset as i64 + 1).fetch_optional(&mut *tx).await?;
                    page.map(|(bytes, total)| {
                        if offset > total as u64 {
                            return Err(StoreError::InvalidTransition("answer cursor exceeds answer length".into()));
                        }
                        let text = match std::str::from_utf8(&bytes) {
                            Ok(text) => text,
                            Err(error) if error.error_len().is_none() && error.valid_up_to() > 0 =>
                                std::str::from_utf8(&bytes[..error.valid_up_to()]).expect("validated UTF-8 prefix"),
                            Err(_) => return Err(StoreError::InvalidTransition("answer cursor is not a UTF-8 boundary".into())),
                        };
                        let end = text.floor_char_boundary(text.len().min(16384));
                        Ok(AssistantExcerpt { text: text[..end].into(), complete: offset + end as u64 >= total as u64 })
                    }).transpose()?
                }
                _ => None,
            };
            let interactions = match &execution {
                MessageExecution::Owned(boundary) | MessageExecution::Shared(boundary)
                    if boundary.state.terminal_outcome().is_none() => {
                    crate::interactions::pending(&mut tx, &session).await?.into_iter()
                        .filter(|record| record.turn_id == boundary.invocation.turn_id
                            && record.run_id == boundary.invocation.run_id).collect()
                }
                _ => Vec::new(),
            };
            Ok(MessageObservation { execution, answer, interactions })
        })).await
    }
}
