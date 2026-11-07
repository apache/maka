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

use crate::{EventLog, StoreError, sessions};
use maka_agent_facts::session::CopyState;
use rusqlite::{OptionalExtension, params};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AbandonRevision {
    Abandoned,
    Retained,
}

/// Shares the accepting operation's transaction. A receipt survives abandonment
/// so a late worker cannot resurrect a removed draft with its old Session ID.
pub(crate) fn retain(connection: &rusqlite::Connection, session: &str) -> Result<(), StoreError> {
    match state(connection, session)? {
        Some(CopyState::Abandoned) => Err(StoreError::SessionNotFound),
        Some(CopyState::Preparing) => {
            connection.execute(
                "UPDATE session_history_copies SET state='committed' WHERE session_id=?",
                params![session],
            )?;
            sessions::advance_revision(connection, session)
        }
        None | Some(CopyState::Committed) => Ok(()),
    }
}

fn state(
    connection: &rusqlite::Connection,
    session: &str,
) -> Result<Option<CopyState>, StoreError> {
    connection
        .query_row(
            "SELECT state FROM session_history_copies WHERE session_id=?",
            params![session],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .map(|value| value.parse().map_err(sessions::invalid))
        .transpose()
}

impl EventLog {
    /// Only unused revisions can disappear. Acceptance, dependent creation and
    /// this decision serialize on the same durable writer; replies are replayable.
    pub async fn abandon_revision(&self, session: &str) -> Result<AbandonRevision, StoreError> {
        sessions::validate_id(session)?;
        let session_id = session.to_owned();
        let observations = self.connection.observations();
        let commits = self.commits.notice();
        let result = self
            .connection
            .run(move |connection| {
                let session = session_id;
                {
                    let tx = rusqlite::Transaction::new_unchecked(
                        connection,
                        rusqlite::TransactionBehavior::Immediate,
                    )?;
                    match state(&tx, &session)?.ok_or(StoreError::SessionNotFound)? {
                        CopyState::Abandoned => {
                            tx.rollback()?;
                            return Ok(AbandonRevision::Abandoned);
                        }
                        CopyState::Committed => return Ok(AbandonRevision::Retained),
                        CopyState::Preparing => {}
                    }
                    // The ledger keeps both identity and allocated family index. Only
                    // destination-owned resources and disposable projections are removed.
                    crate::context::semantic::gc::retire_owner(&tx, &session)?;
                    for statement in [
                        "DELETE FROM session_history_artifacts WHERE session_id=?",
                        "DELETE FROM session_history_members WHERE session_id=?",
                        "DELETE FROM session_revision_sources WHERE session_id=?",
                        "DELETE FROM catalog_messages WHERE session_id=?",
                        "DELETE FROM session_read_state WHERE session_id=?",
                        "DELETE FROM artifacts WHERE session_id=?",
                        "DELETE FROM artifact_catalog WHERE session_id=?",
                        "DELETE FROM message_queue_state WHERE session_id=?",
                    ] {
                        tx.execute(statement, params![&session])?;
                    }
                    tx.execute("DELETE FROM session_control WHERE id=?", params![&session])?;
                    tx.execute(
                        "UPDATE session_history_copies SET state='abandoned' WHERE session_id=?",
                        params![&session],
                    )?;
                    sessions::advance_catalog(&tx)?;
                    tx.commit().map_err(StoreError::CommitUnknown)?;
                    commits.material_released();
                    Ok(AbandonRevision::Abandoned)
                }
            })
            .await?;
        if result == AbandonRevision::Abandoned {
            observations.purge_session(session.to_owned()).await?;
        }
        Ok(result)
    }
}
