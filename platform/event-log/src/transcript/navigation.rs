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
use maka_agent_facts::{configuration::validation::MAX_SAFE_INTEGER, history::RowPosition};
use maka_presentation::navigation::{
    RecordedTurnState, TurnContribution, TurnLandmark, TurnStateMessage, truncate,
};
use sqlx::{Connection, Row};
use std::collections::HashMap;

mod queries;

pub struct TurnPage {
    pub contributions: Vec<TurnContribution>,
    pub next_position: Option<RowPosition>,
}

impl EventLog {
    /// Visible raw history fence, including running Turns, captured with Session existence.
    pub async fn navigation_fence(&self, session: &str) -> Result<Option<u64>, StoreError> {
        self.validate_root()?;
        sessions::validate_id(session)?;
        let session = session.to_owned();
        self.connection
            .read(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    let exists: bool = sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM session_control WHERE id = ?)",
                    )
                    .bind(&session)
                    .fetch_one(&mut *tx)
                    .await?;
                    if !exists {
                        return Err(StoreError::SessionNotFound);
                    }
                    let raw: Option<i64> = sqlx::query_scalar(queries::FENCE)
                        .bind(&session)
                        .fetch_one(&mut *tx)
                        .await?;
                    raw.map(sequence_number).transpose()
                })
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
        self.validate_root()?;
        sessions::validate_id(session)?;
        let through_sql = super::read::sql_number(through)?;
        let position = position.map(sql_position).transpose()?;
        if !(1..=128).contains(&limit) {
            return Err(invalid("invalid contribution limit"));
        }
        let session = session.to_owned();
        self.connection
            .observe(move |connection| {
                super::bodycache::run(connection, move |tx| Box::pin(async move {
                    super::directory::check_read(tx, &session, through).await?;
                    let rows = sqlx::query(queries::ROWS)
                        .bind(&session)
                        .bind(through_sql)
                        .bind(position.map(|p| p.0))
                        .bind(position.map(|p| p.1))
                        .fetch_all(&mut *tx)
                        .await?;
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
                        let position = row_position(row.try_get(0)?, row.try_get(1)?)?;
                        let turn: String = row.try_get(2)?;
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
                            let role: String = row.try_get(3)?;
                            let kind: String = row.try_get(4)?;
                            if role == "user" && matches!(kind.as_str(), "invocation_opened" | "message_steered") {
                                contribution.user_prompt_preview = preview(tx,&session,position,256).await?;
                            }
                        }
                        if row.try_get::<String,_>(3)? == "turn_state" {
                            super::bodycache::ensure(tx,&session,position).await?;
                            let bytes: Vec<u8> = sqlx::query_scalar("SELECT payload FROM temp.transcript_rows WHERE session_id=?1 AND source_sequence=?2 AND item_index=?3")
                                .bind(&session).bind(sql_position(position)?.0).bind(sql_position(position)?.1).fetch_one(&mut *tx).await?;
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
                }))
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
        self.validate_root()?;
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
                super::bodycache::run(connection, move |tx| Box::pin(async move {
                    super::directory::check_read(tx, &session, through).await?;
                    if let Some(turn) = turn {
                        let bounds: Option<(i64, i64, i64, i64)> = sqlx::query_as(queries::BOUNDS)
                            .bind(&session).bind(&turn).bind(through_sql).fetch_optional(&mut *tx).await?;
                        let Some((first_source, first_index, last_source, last_index)) = bounds else { return Ok(vec![]); };
                        let prompt: Option<(i64,i64)> = sqlx::query_as(
                            "SELECT row.source_sequence,row.item_index FROM transcript_directory row JOIN runtime_events source ON source.sequence=row.source_sequence
                             WHERE row.session_id=?1 AND row.turn_id=?2 AND row.source_sequence<=?3 AND row.role='user'
                             AND source.kind IN ('invocation_opened','message_steered') ORDER BY row.source_sequence,row.item_index LIMIT 1")
                            .bind(&session).bind(&turn).bind(through_sql).fetch_optional(&mut *tx).await?;
                        let label = if let Some((source,item)) = prompt { preview(tx,&session,row_position(source,item)?,96).await? } else { None };

                        return Ok(vec![TurnLandmark {
                            turn_id: turn, position: row_position(first_source, first_index)?, last_position: row_position(last_source, last_index)?,
                            label: label.unwrap_or_default(),
                        }]);
                    }
                    let selected: Vec<String> = sqlx::query_scalar(queries::LANDMARKS)
                        .bind(&session)
                        .bind(through_sql)
                        .bind(limit as i64)
                        .fetch_all(&mut *tx)
                        .await?;
                    let mut result = Vec::new();
                    for invocation in selected {
                        if let Some(row) = sqlx::query(queries::PROMPT)
                            .bind(&session)
                            .bind(&invocation)
                            .bind(through_sql)
                            .fetch_optional(&mut *tx)
                            .await?
                        {
                            let label = preview(tx,&session,row_position(row.try_get(1)?,row.try_get(2)?)?,96).await?;
                            if let Some(label) = label {
                                let turn_id: String = row.try_get(0)?;
                                let (first_source, first_index, last_source, last_index): (i64, i64, i64, i64) = sqlx::query_as(queries::BOUNDS)
                                    .bind(&session).bind(&turn_id).bind(through_sql).fetch_one(&mut *tx).await?;
                                result.push(TurnLandmark {
                                    position: row_position(first_source, first_index)?,
                                    last_position: row_position(last_source, last_index)?,
                                    turn_id,
                                    label,
                                });
                            }
                        }
                    }

                    Ok(result)
                }))
            })
            .await
    }
}

async fn preview(
    db: &mut sqlx::SqliteConnection,
    session: &str,
    position: RowPosition,
    budget: i64,
) -> Result<Option<String>, StoreError> {
    super::bodycache::ensure(db, session, position).await?;
    sqlx::query_scalar("SELECT navigation_preview(COALESCE(json_extract(payload,'$.displayText'),json_extract(payload,'$.text')),?4) FROM temp.transcript_rows WHERE session_id=?1 AND source_sequence=?2 AND item_index=?3")
        .bind(session).bind(sql_position(position)?.0).bind(sql_position(position)?.1).bind(budget).fetch_one(db).await.map_err(Into::into)
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
