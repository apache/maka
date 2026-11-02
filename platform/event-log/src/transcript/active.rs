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

use super::evidence;
use crate::{EventLog, StoreError};
use maka_agent_facts::event::Invocation;
use maka_presentation::{Content, InvocationView, Message, ProjectionError};
use sqlx::Connection;

/// The same failed-fragment verdict drives durable rows and live completion frames.
pub(crate) async fn interrupted_messages(
    connection: &mut sqlx::SqliteConnection,
    invocation: &str,
    step: Option<&str>,
    through: u64,
) -> Result<Vec<String>, StoreError> {
    let through_sql = i64::try_from(through).map_err(|_| ProjectionError::OutOfRange)?;
    let selected =
        super::evidence::selected(connection, invocation, step, through_sql, true).await?;
    let mut view = InvocationView::new();
    let mut ids = Vec::new();
    for sequence in selected {
        let fact = evidence::fact(connection, sequence).await?;
        let rows = view.push(&fact)?;
        if fact.sequence == through {
            ids.extend(rows.into_iter().filter_map(|row| {
                matches!(
                    row.message.content,
                    Content::Assistant {
                        interrupted: true,
                        ..
                    }
                )
                .then_some(row.message.id)
            }));
        }
    }
    Ok(ids)
}
impl EventLog {
    /// Read an active executor overlay at a historical fence. Model preview belongs
    /// to the attempt reader and has no SQL reconstruction path.
    pub async fn active_transcript(
        &self,
        invocation: &Invocation,
        through: u64,
    ) -> Result<Vec<Message>, StoreError> {
        super::read::sql_number(through)?;
        self.validate_root()?;
        let invocation = invocation.clone();
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    let fence = evidence::fence(&mut tx, through).await?;
                    let id = &invocation.invocation_id;
                    let compact: bool = sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM runtime_events
                         WHERE invocation_id = ?1 AND sequence <= ?2
                         AND kind = 'invocation_opened'
                         AND json_extract(event_header, '$.fact.input.kind') = 'context_compact')",
                    )
                    .bind(id)
                    .bind(fence)
                    .fetch_one(&mut *tx)
                    .await?;
                    if compact {
                        return Ok(Vec::new());
                    }
                    let ended: bool = sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id = ?1
             AND sequence <= ?2 AND kind = 'invocation_ended')",
                    )
                    .bind(id)
                    .bind(fence)
                    .fetch_one(&mut *tx)
                    .await?;
                    if ended {
                        return Ok(Vec::new());
                    }
                    let external: bool = sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id=?1
                         AND kind='executor_started' AND sequence<=?2)",
                    )
                    .bind(id)
                    .bind(fence)
                    .fetch_one(&mut *tx)
                    .await?;
                    if !external {
                        return Ok(Vec::new());
                    }
                    let mut view = InvocationView::new();
                    let selected = evidence::selected(&mut tx, id, None, fence, false).await?;
                    for sequence in selected {
                        let fact = evidence::fact(&mut tx, sequence).await?;
                        if fact.event.invocation != invocation {
                            return Err(ProjectionError::Invalid(
                                "active transcript invocation mismatch",
                            )
                            .into());
                        }
                        view.push(&fact)?;
                    }
                    Ok(view.overlay())
                })
            })
            .await
    }
}
