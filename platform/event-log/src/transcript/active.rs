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

/// The same failed-fragment verdict drives durable rows and live completion frames.
pub(crate) fn interrupted_messages(
    connection: &rusqlite::Connection,
    invocation: &str,
    step: Option<&str>,
    through: u64,
) -> Result<Vec<String>, StoreError> {
    let through_sql = i64::try_from(through).map_err(|_| ProjectionError::OutOfRange)?;
    let selected = super::evidence::selected(connection, invocation, step, through_sql, true)?;
    let mut view = InvocationView::new();
    let mut ids = Vec::new();
    for sequence in selected {
        let fact = evidence::fact(connection, sequence)?;
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
        let invocation = invocation.clone();
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                let fence = evidence::fence(&tx, through)?;
                let id = &invocation.invocation_id;
                let compact: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM runtime_events
                         WHERE invocation_id = ?1 AND sequence <= ?2
                         AND kind = 'invocation_opened'
                         AND json_extract(event_header, '$.fact.input.kind') = 'context_compact')",
                    rusqlite::params![id, fence],
                    |row| row.get(0),
                )?;
                if compact {
                    return Ok(Vec::new());
                }
                let ended: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id = ?1
             AND sequence <= ?2 AND kind = 'invocation_ended')",
                    rusqlite::params![id, fence],
                    |row| row.get(0),
                )?;
                if ended {
                    return Ok(Vec::new());
                }
                let external: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id=?1
                         AND kind='executor_started' AND sequence<=?2)",
                    rusqlite::params![id, fence],
                    |row| row.get(0),
                )?;
                if !external {
                    return Ok(Vec::new());
                }
                let mut view = InvocationView::new();
                let selected = evidence::selected(&tx, id, None, fence, false)?;
                for sequence in selected {
                    let fact = evidence::fact(&tx, sequence)?;
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
            .await
    }
}
