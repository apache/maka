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
use sqlx::{Connection, SqliteConnection};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AbandonRevision {
    Abandoned,
    Retained,
}

/// Shares the accepting operation's transaction. A receipt survives abandonment
/// so a late worker cannot resurrect a removed draft with its old Session ID.
pub(crate) async fn retain(
    connection: &mut SqliteConnection,
    session: &str,
) -> Result<(), StoreError> {
    match state(connection, session).await? {
        Some(CopyState::Abandoned) => Err(StoreError::SessionNotFound),
        Some(CopyState::Preparing) => {
            sqlx::query("UPDATE session_history_copies SET state='committed' WHERE session_id=?")
                .bind(session)
                .execute(&mut *connection)
                .await?;
            sessions::advance_revision(connection, session).await
        }
        None | Some(CopyState::Committed) => Ok(()),
    }
}

async fn state(
    connection: &mut SqliteConnection,
    session: &str,
) -> Result<Option<CopyState>, StoreError> {
    sqlx::query_scalar::<_, String>("SELECT state FROM session_history_copies WHERE session_id=?")
        .bind(session)
        .fetch_optional(connection)
        .await?
        .map(|value| value.parse().map_err(sessions::invalid))
        .transpose()
}

impl EventLog {
    /// Only unused revisions can disappear. Acceptance, dependent creation and
    /// this decision serialize on the same durable writer; replies are replayable.
    pub async fn abandon_revision(&self, session: &str) -> Result<AbandonRevision, StoreError> {
        self.validate_root()?;
        sessions::validate_id(session)?;
        let session = session.to_owned();
        let observations = self.connection.observations();
        let commits = self.commits.notice();
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                    match state(&mut tx, &session)
                        .await?
                        .ok_or(StoreError::SessionNotFound)?
                    {
                        CopyState::Abandoned => {
                            tx.rollback().await?;
                            observations.purge_session(session).await?;
                            return Ok(AbandonRevision::Abandoned);
                        }
                        CopyState::Committed => return Ok(AbandonRevision::Retained),
                        CopyState::Preparing => {}
                    }
                    // The ledger keeps both identity and allocated family index. Only
                    // destination-owned resources and disposable projections are removed.
                    crate::context::semantic::gc::retire_owner(&mut tx, &session).await?;
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
                        sqlx::query(statement)
                            .bind(&session)
                            .execute(&mut *tx)
                            .await?;
                    }
                    sqlx::query("DELETE FROM session_control WHERE id=?")
                        .bind(&session)
                        .execute(&mut *tx)
                        .await?;
                    sqlx::query(
                        "UPDATE session_history_copies SET state='abandoned' WHERE session_id=?",
                    )
                    .bind(&session)
                    .execute(&mut *tx)
                    .await?;
                    sessions::advance_catalog(&mut tx).await?;
                    tx.commit().await.map_err(StoreError::CommitUnknown)?;
                    commits.material_released();
                    observations.purge_session(session).await?;
                    Ok(AbandonRevision::Abandoned)
                })
            })
            .await
    }
}
