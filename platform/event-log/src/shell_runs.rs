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

use crate::{EventLog, StoreError};
mod query;
use maka_agent_facts::shell_run::ShellOutcome;
use maka_agent_facts::shell_run::ShellPatch;
use maka_agent_facts::shell_run::ShellRun;
use maka_agent_facts::shell_run::ShellState;
pub use query::ShellResourcePage;
use sqlx::{Connection, SqliteConnection};

/// A committed resource invalidation, not a substitute for its durable snapshot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellChange {
    pub session_id: String,
    pub id: String,
}

impl From<&ShellRun> for ShellChange {
    fn from(record: &ShellRun) -> Self {
        Self {
            session_id: record.session_id.clone(),
            id: record.id.clone(),
        }
    }
}

impl EventLog {
    /// A terminal orphan is still an unknown effect, not proof of native cleanup.
    pub async fn has_unsettled_shells(&self, session: &str) -> Result<bool, StoreError> {
        self.validate_root()?;
        maka_agent_facts::interaction::entity_id(session).map_err(invalid)?;
        let session = session.to_owned();
        self.connection
            .run(move |connection| Box::pin(async move { unsettled(connection, &session).await }))
            .await
    }

    /// Register before reading snapshots. Lag requires observer reconstruction;
    /// unlike the event log, this ephemeral feed has no replay cursor.
    pub fn subscribe_shell_changes(&self) -> tokio::sync::broadcast::Receiver<ShellChange> {
        self.shell_changes.subscribe()
    }

    /// Durable startup admission; the caller must not spawn until this succeeds.
    pub async fn create_shell_run(&self, record: ShellRun) -> Result<ShellRun, StoreError> {
        self.validate_root()?;
        record.validate().map_err(invalid)?;
        if record.state != ShellState::Starting || record.revision != 1 {
            return Err(invalid("shell creation requires starting at revision one"));
        }
        let raw = encode(&record)?;
        let changes = self.shell_changes.clone();
        let commits = self.commits.session(&record.session_id);
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                    let exists: bool = sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM session_control WHERE id = ?)",
                    )
                    .bind(&record.session_id)
                    .fetch_one(&mut *tx)
                    .await?;
                    if !exists {
                        return Err(StoreError::SessionNotFound);
                    }
                    if crate::workspace_bindings::permission_basis(&mut tx, &record.session_id)
                        .await?
                        != Some(record.permissions.basis)
                    {
                        return Err(invalid("shell launch permission boundary changed"));
                    }
                    let inserted = sqlx::query(
                        "INSERT OR IGNORE INTO shell_runs
                (session_id, id, started_at, active, record_json) VALUES (?, ?, ?, 1, ?)",
                    )
                    .bind(&record.session_id)
                    .bind(&record.id)
                    .bind(record.started_at as i64)
                    .bind(raw)
                    .execute(&mut *tx)
                    .await?;
                    if inserted.rows_affected() != 1 {
                        return Err(StoreError::ShellConflict);
                    }
                    crate::sessions::retain(&mut tx, &record.session_id).await?;
                    tx.commit().await.map_err(StoreError::CommitUnknown)?;
                    // Publish on the independent SQL owner even if the caller
                    // abandoned its response after admission.
                    let _ = changes.send(ShellChange::from(&record));
                    commits.metadata();
                    Ok(record)
                })
            })
            .await
    }

    pub async fn patch_shell_run(
        &self,
        session_id: &str,
        id: &str,
        patch: ShellPatch,
    ) -> Result<ShellRun, StoreError> {
        self.validate_root()?;
        ids(session_id, id)?;
        let (session_id, id) = (session_id.to_owned(), id.to_owned());
        let changes = self.shell_changes.clone();
        let commits = self.commits.session(&session_id);
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                    let current = read(&mut tx, &session_id, &id)
                        .await?
                        .ok_or(StoreError::ShellNotFound)?;
                    let next = current.patched(patch).map_err(invalid)?;
                    if next == current {
                        return Ok(current);
                    }
                    write(&mut tx, &next).await?;
                    tx.commit().await.map_err(StoreError::CommitUnknown)?;
                    let _ = changes.send(ShellChange::from(&next));
                    commits.metadata();
                    Ok(next)
                })
            })
            .await
    }

    pub async fn read_shell_run(
        &self,
        session_id: &str,
        id: &str,
    ) -> Result<Option<ShellRun>, StoreError> {
        self.validate_root()?;
        ids(session_id, id)?;
        let (session_id, id) = (session_id.to_owned(), id.to_owned());
        self.connection
            .run(move |connection| {
                Box::pin(async move { read(connection, &session_id, &id).await })
            })
            .await
    }

    /// Only at Host startup, before any resource admission. No PID attachment or
    /// process replay is attempted. An uncertain commit prevents Host readiness.
    pub async fn recover_shell_runs(&self, now: u64) -> Result<u64, StoreError> {
        self.validate_root()?;
        if now > 9_007_199_254_740_991 {
            return Err(invalid("invalid recovery time"));
        }
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                    let mut count = 0;
                    loop {
                        // One record at a time bounds recovery memory independently of
                        // the number of historical resources. All updates share one commit.
                        let row: Option<(String, String, String)> = sqlx::query_as(
                    "SELECT session_id, id, record_json FROM shell_runs WHERE active = 1 LIMIT 1")
                    .fetch_optional(&mut *tx).await?;
                        let Some((session, id, raw)) = row else { break };
                        let current = decode(&raw, &session, &id)?;
                        if !current.state.active() {
                            return Err(invalid("invalid active shell index"));
                        }
                        let next = current
                            .patched(ShellPatch {
                                state: Some(ShellState::Terminal {
                                    completed_at: now,
                                    outcome: ShellOutcome::Orphaned {
                                        message:
                                            "Runtime Host restarted without a live process handle"
                                                .into(),
                                    },
                                    observed_at: None,
                                }),
                                updated_at: Some(now),
                                ..Default::default()
                            })
                            .map_err(invalid)?;
                        write(&mut tx, &next).await?;
                        count += 1;
                    }
                    tx.commit().await.map_err(StoreError::CommitUnknown)?;
                    Ok(count)
                })
            })
            .await
    }
}

async fn read(
    connection: &mut SqliteConnection,
    session: &str,
    id: &str,
) -> Result<Option<ShellRun>, StoreError> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT record_json FROM shell_runs WHERE session_id = ? AND id = ?")
            .bind(session)
            .bind(id)
            .fetch_optional(connection)
            .await?;
    raw.map(|raw| decode(&raw, session, id)).transpose()
}

async fn write(connection: &mut SqliteConnection, record: &ShellRun) -> Result<(), StoreError> {
    let changed = sqlx::query(
        "UPDATE shell_runs SET active = ?, record_json = ? WHERE session_id = ? AND id = ?",
    )
    .bind(record.state.active())
    .bind(encode(record)?)
    .bind(&record.session_id)
    .bind(&record.id)
    .execute(connection)
    .await?;
    if changed.rows_affected() != 1 {
        return Err(StoreError::ShellNotFound);
    }
    Ok(())
}

fn encode(record: &ShellRun) -> Result<String, StoreError> {
    record.validate().map_err(invalid)?;
    let raw = serde_json::to_string(record)?;
    Ok(raw)
}

fn decode(raw: &str, session: &str, id: &str) -> Result<ShellRun, StoreError> {
    let record: ShellRun = serde_json::from_str(raw)?;
    record.validate().map_err(invalid)?;
    if record.session_id != session || record.id != id {
        return Err(invalid("shell record identity mismatch"));
    }
    Ok(record)
}

pub(crate) async fn unsettled(
    connection: &mut sqlx::SqliteConnection,
    session: &str,
) -> Result<bool, StoreError> {
    unsettled_outside(connection, session, None).await
}

pub(crate) async fn unsettled_outside(
    connection: &mut sqlx::SqliteConnection,
    session: &str,
    current_run: Option<&str>,
) -> Result<bool, StoreError> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM shell_runs WHERE session_id = ?
         AND (json_extract(record_json, '$.state.outcome.kind') = 'orphaned'
           OR (active = 1 AND (?2 IS NULL OR
             json_extract(record_json, '$.sourceRunId') IS NOT ?2))))",
    )
    .bind(session)
    .bind(current_run)
    .fetch_one(connection)
    .await?)
}

fn ids(session: &str, id: &str) -> Result<(), StoreError> {
    maka_agent_facts::interaction::entity_id(session).map_err(invalid)?;
    maka_agent_facts::interaction::entity_id(id).map_err(invalid)
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
