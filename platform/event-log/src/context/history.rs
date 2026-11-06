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

use super::{ModelContextSource, latest_main, read, safety, selection::Selection};
use crate::{EventLog, StoreError, sequence_number};

/// Logical Turn cuts are resolved against canonical facts, not presentation rows.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(
    tag = "kind",
    content = "turn_id",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum HistoryCut {
    Empty,
    BeforeTurn(String),
    ThroughTurn(String),
    End,
}

/// Evidence for an owned history copy, never a continuation or execution grant.
#[derive(Debug)]
pub struct FrozenSessionHistory {
    pub source_revision: u64,
    /// Freezes effective archives separately from the retained conversation cut.
    pub observed_through: u64,
    pub context: ModelContextSource,
}

#[derive(Debug)]
pub enum HistoryCapture {
    Captured(Box<FrozenSessionHistory>),
    SourceRevisionConflict { expected: u64, actual: u64 },
}

impl EventLog {
    /// Resolve the catalog CAS, complete logical Turn cut, effective archives and
    /// bounded model rendering in one read snapshot. Persisting a copy must still
    /// recheck this evidence in the transaction that publishes the destination.
    pub async fn capture_session_history(
        &self,
        session: &str,
        expected_revision: u64,
        cut: HistoryCut,
        max_events: usize,
        max_bytes: usize,
    ) -> Result<HistoryCapture, StoreError> {
        crate::sessions::validate_id(session)?;
        if expected_revision == 0 || expected_revision > 9_007_199_254_740_991 {
            return Err(invalid("source revision must be a positive safe integer"));
        }
        if let HistoryCut::BeforeTurn(turn) | HistoryCut::ThroughTurn(turn) = &cut {
            crate::sessions::validate_id(turn)?;
        }
        let session = session.to_owned();
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                let actual = crate::workspace_bindings::current_session_revision(&tx, &session)?
                    .ok_or(StoreError::SessionNotFound)?;
                if actual != expected_revision {
                    return Ok(HistoryCapture::SourceRevisionConflict {
                        expected: expected_revision,
                        actual,
                    });
                }
                let observed: i64 = tx
                    .prepare_cached("SELECT COALESCE(MAX(sequence),0) FROM event_log")?
                    .query_row(rusqlite::params![], |row| row.get(0))?;
                let through = resolve_cut(&tx, &session, &cut, observed)?;
                safety::require_safe_through(&tx, &session, None, through)?;
                let selection = Selection::session(&session);
                let archives_before = sequence_number(observed)?.saturating_add(1);
                let latest =
                    latest_main::read_selected_at(&tx, &selection, through, archives_before)?;
                let context = read::materialize_selected(
                    &tx,
                    &selection,
                    through,
                    archives_before,
                    max_events,
                    max_bytes,
                    latest,
                )?;
                tx.commit()?;
                Ok(HistoryCapture::Captured(Box::new(FrozenSessionHistory {
                    source_revision: actual,
                    observed_through: sequence_number(observed)?,
                    context,
                })))
            })
            .await
    }
}

pub(crate) fn resolve_cut(
    connection: &rusqlite::Connection,
    session: &str,
    cut: &HistoryCut,
    observed: i64,
) -> Result<u64, StoreError> {
    let limit = match cut {
        HistoryCut::Empty => 0,
        HistoryCut::End => observed,
        HistoryCut::BeforeTurn(turn) | HistoryCut::ThroughTurn(turn) => {
            let (first, last): (Option<i64>, Option<i64>) = connection.prepare_cached("SELECT MIN(sequence),MAX(sequence) FROM session_history_events
                 WHERE owner_session_id = ?1
                   AND json_extract(event_header,'$.invocation.turn_id') = ?2
                   AND sequence <= ?3
                   AND EXISTS(SELECT 1 FROM session_history_events opening
                       WHERE (opening.kind = 'message_imported' OR (opening.kind = 'invocation_opened'
                         AND json_extract(opening.event_header,'$.fact.input.kind') IN ('message','continuation','handoff')))
                         AND opening.owner_session_id = ?1
                         AND json_extract(opening.event_header,'$.invocation.turn_id') = ?2
                         AND opening.sequence <= ?3)")?.query_row(rusqlite::params![session,turn,observed], |row| Ok((row.get(0)?,row.get(1)?,)))?;
            let (first, last) = first.zip(last).ok_or(StoreError::HistoryTurnMissing)?;
            match cut {
                HistoryCut::BeforeTurn(_) => first - 1,
                HistoryCut::ThroughTurn(_) => last,
                HistoryCut::Empty | HistoryCut::End => unreachable!(),
            }
        }
    };
    let crossing: bool = connection
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM session_history_events
         WHERE owner_session_id = ?1 AND sequence <= ?2
         GROUP BY json_extract(event_header,'$.invocation.turn_id')
         HAVING MIN(sequence) <= ?3 AND MAX(sequence) > ?3)",
        )?
        .query_row(rusqlite::params![session, observed, limit], |row| {
            row.get(0)
        })?;
    if crossing {
        return Err(StoreError::HistoryTurnSplit);
    }
    Selection::session(session).high_water(connection, sequence_number(limit)?)
}

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
