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

use super::read::{row_position, sql_position};
use crate::{EventLog, StoreError, sequence_number, sessions};
use maka_agent_facts::{
    configuration::validation::MAX_SAFE_INTEGER, history::RowPosition, message::MessageOrigin,
};
use maka_presentation::navigation::{
    RecordedTurnState, TurnContribution, TurnLandmark, TurnStateMessage, truncate,
};
use rusqlite::OptionalExtension;
use std::collections::HashMap;

mod queries;

pub struct TurnPage {
    pub contributions: Vec<TurnContribution>,
    pub next_position: Option<RowPosition>,
}

impl EventLog {
    /// Visible raw history fence, including running Turns, captured with Session existence.
    pub async fn navigation_fence(&self, session: &str) -> Result<Option<u64>, StoreError> {
        sessions::validate_id(session)?;
        let session = session.to_owned();
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                let exists: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM session_control WHERE id = ?)",
                    rusqlite::params![&session],
                    |row| row.get(0),
                )?;
                if !exists {
                    return Err(StoreError::SessionNotFound);
                }
                let raw: Option<i64> =
                    tx.query_row(queries::FENCE, rusqlite::params![&session], |row| {
                        row.get(0)
                    })?;
                raw.map(sequence_number).transpose()
            })
            .await
    }

    /// A bounded message-index walk. Contributions may split a logical Turn;
    /// the original client merges them by Turn ID and recorded-state position.
    pub async fn navigation_turns(
        &self,
        session: &str,
        through: u64,
        position: Option<RowPosition>,
        limit: usize,
    ) -> Result<TurnPage, StoreError> {
        sessions::validate_id(session)?;
        let through_sql = super::read::sql_number(through)?;
        let position = position.map(sql_position).transpose()?;
        if !(1..=128).contains(&limit) {
            return Err(invalid("invalid contribution limit"));
        }
        let session = session.to_owned();
        self.connection
            .observe(move |connection| {
                super::bodycache::run(connection, move |tx| {
                    super::directory::ensure(tx, &session, through)?;
                    let rows = tx.prepare_cached(queries::ROWS)?.query_map(rusqlite::params![&session, through_sql, position.map(|p| p.0), position.map(|p| p.1)], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?,)))?.collect::<Result<Vec<_>, _>>()
                        ?;
                    let mut contributions: Vec<TurnContribution> = Vec::new();
                    let mut indices = HashMap::new();
                    let mut next_position = None;
                    // Charge the full envelope, including the largest serialized pair metadata.
                    let envelope = serde_json::json!({
                        "sessionId": session, "throughSequence": through, "contributions": [],
                        "nextPosition": { "sourceSequence": MAX_SAFE_INTEGER, "itemIndex": MAX_SAFE_INTEGER }
                    });
                    let budget = (192_usize * 1024).saturating_sub(serde_json::to_vec(&envelope)?.len());
                    let mut bytes = 0usize;
                    for (index, row) in rows.into_iter().enumerate() {
                        let position = row_position(row.0, row.1)?;
                        let turn: String = row.2;
                        if index == 256
                            || !indices.contains_key(&turn) && contributions.len() == limit
                        {
                            next_position = Some(position);
                            break;
                        }
                        let previous = indices.get(&turn).copied();
                        let (mut contribution, old_bytes) = match previous {
                            Some(index) => {
                                let old: &TurnContribution = &contributions[index];
                                (old.clone(), serde_json::to_vec(old)?.len() + 1)
                            }
                            None => (
                                TurnContribution {
                                    turn_id: turn.clone(),
                                    first_position: position,
                                    latest_state: None,
                                    user_prompt_preview: None,
                                },
                                0,
                            ),
                        };
                        if contribution.user_prompt_preview.is_none() {
                            let role = &row.3;
                            let kind = &row.4;
                            if role == "user" && matches!(kind.as_str(), "invocation_opened" | "message_steered") {
                                contribution.user_prompt_preview = preview(tx,&session,position,256)?;
                            }
                        }
                        if row.3 == "turn_state" {
                            super::bodycache::ensure(tx,&session,position)?;
                            let bytes: Vec<u8> = tx.query_row("SELECT payload FROM temp.transcript_rows WHERE owner_key=?1 AND source_sequence=?2 AND item_index=?3", rusqlite::params![&session, sql_position(position)?.0, sql_position(position)?.1], |row| row.get(0))?;
                            let mut message: TurnStateMessage = serde_json::from_slice(&bytes)?;
                            if message.turn_id != contribution.turn_id {
                                return Err(StoreError::TranscriptConflict);
                            }
                            message.abort_source =
                                message.abort_source.map(|s| truncate(&s, 128).to_owned());
                            message.error_class =
                                message.error_class.map(|s| truncate(&s, 128).to_owned());
                            contribution.latest_state =
                                Some(RecordedTurnState { position, message });
                        }
                        let updated_bytes =
                            bytes - old_bytes + serde_json::to_vec(&contribution)?.len() + 1;
                        if !contributions.is_empty() && updated_bytes > budget {
                            next_position = Some(position);
                            break;
                        }
                        bytes = updated_bytes;
                        if let Some(index) = previous {
                            contributions[index] = contribution;
                        } else {
                            indices.insert(turn, contributions.len());
                            contributions.push(contribution);
                        }
                    }

                    Ok(TurnPage {
                        contributions,
                        next_position,
                    })
                })
            })
            .await
    }

    /// Rank unique Turn openings in SQL; load only selected labels and row bounds.
    pub async fn navigation_landmarks(
        &self,
        session: &str,
        through: u64,
        limit: usize,
        turn: Option<&str>,
    ) -> Result<Vec<TurnLandmark>, StoreError> {
        sessions::validate_id(session)?;
        let through_sql = super::read::sql_number(through)?;
        if let Some(turn) = turn {
            sessions::validate_id(turn)?;
        }
        let turn = turn.map(str::to_owned);
        if !(1..=64).contains(&limit) {
            return Err(invalid("invalid landmark limit"));
        }
        let session = session.to_owned();
        self.connection
            .observe(move |connection| {
                super::bodycache::run(connection, move |tx| {
                    super::directory::ensure(tx, &session, through)?;
                    if let Some(turn) = turn {
                        let bounds: Option<(i64, i64, i64, i64)> = tx.query_row(queries::BOUNDS, rusqlite::params![&session, &turn, through_sql], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).optional()?;
                        let Some((first_source, first_index, last_source, last_index)) = bounds else { return Ok(vec![]); };
                        let prompt: Option<(i64,i64,Option<String>)> = tx.query_row("SELECT row.source_sequence,row.item_index,row.user_origin FROM transcript_directory row JOIN runtime_events source ON source.sequence=row.source_sequence
                             WHERE row.owner_key=?1 AND row.turn_id=?2 AND row.source_sequence<=?3 AND row.role='user'
                             AND source.kind IN ('invocation_opened','message_steered') ORDER BY row.source_sequence,row.item_index LIMIT 1", rusqlite::params![&session, &turn, through_sql], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?,))).optional()?;
                        let (label, origin) = match prompt {
                            Some((source,item,origin)) => (preview(tx,&session,row_position(source,item)?,96)?, decode_origin(origin)?),
                            None => (None, None),
                        };

                        return Ok(vec![TurnLandmark {
                            turn_id: turn, position: row_position(first_source, first_index)?, last_position: row_position(last_source, last_index)?,
                            label: label.unwrap_or_default(),
                            origin,
                        }]);
                    }
                    let selected: Vec<String> = tx.prepare_cached(queries::LANDMARKS)?.query_map(rusqlite::params![&session, through_sql, limit as i64], |row| row.get(0))?.collect::<Result<Vec<_>, _>>()
                        ?;
                    let mut result = Vec::new();
                    for invocation in selected {
                        if let Some(row) = tx.query_row(queries::PROMPT, rusqlite::params![&session, &invocation, through_sql], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, Option<String>>(3)?,))).optional()
                            ?
                        {
                            let label = preview(tx,&session,row_position(row.1,row.2)?,96)?;
                            if let Some(label) = label {
                                let turn_id: String = row.0;
                                let (first_source, first_index, last_source, last_index): (i64, i64, i64, i64) = tx.query_row(queries::BOUNDS, rusqlite::params![&session, &turn_id, through_sql], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?;
                                result.push(TurnLandmark {
                                    position: row_position(first_source, first_index)?,
                                    last_position: row_position(last_source, last_index)?,
                                    turn_id,
                                    label,
                                    origin: decode_origin(row.3)?,
                                });
                            }
                        }
                    }

                    Ok(result)
                })
            })
            .await
    }
}

fn decode_origin(origin: Option<String>) -> Result<Option<MessageOrigin>, StoreError> {
    Ok(origin
        .map(|value| serde_json::from_str(&value))
        .transpose()?)
}

fn preview(
    db: &rusqlite::Connection,
    session: &str,
    position: RowPosition,
    budget: i64,
) -> Result<Option<String>, StoreError> {
    super::bodycache::ensure(db, session, position)?;
    db.query_row("SELECT navigation_preview(COALESCE(json_extract(payload,'$.displayText'),json_extract(payload,'$.text')),?4) FROM temp.transcript_rows WHERE owner_key=?1 AND source_sequence=?2 AND item_index=?3", rusqlite::params![session, sql_position(position)?.0, sql_position(position)?.1, budget], |row| row.get(0)).map_err(Into::into)
}

/// SQLite borrows the selected string; only the bounded preview is allocated in Rust.
pub(crate) fn register(connection: &rusqlite::Connection) -> Result<(), StoreError> {
    use rusqlite::functions::FunctionFlags;
    connection.create_scalar_function(
        "navigation_preview",
        2,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let text = ctx.get_raw(0).as_str()?;
            let bytes =
                usize::try_from(ctx.get::<i64>(1)?).map_err(|_| rusqlite::Error::InvalidQuery)?;
            let text = maka_presentation::navigation::prompt_preview(text, bytes);
            Ok((!text.is_empty()).then(|| text.to_owned()))
        },
    )?;
    Ok(())
}

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
