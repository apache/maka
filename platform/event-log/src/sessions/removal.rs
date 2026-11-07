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

use super::{MAX_SAFE_INTEGER, advance_catalog, invalid, validate_id};
use crate::{EventLog, StoreError};
use rusqlite::{OptionalExtension, params};

mod plan;
pub use plan::{RemovalPlan, RemoveFamilyResult};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionRetirement {
    Removing,
    Removed,
    Archiving,
    Archived,
}

impl SessionRetirement {
    pub fn removes(self) -> bool {
        matches!(self, Self::Removing | Self::Removed)
    }

    pub fn pending(self) -> bool {
        matches!(self, Self::Removing | Self::Archiving)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionRemovalResult {
    Accepted(SessionRetirement),
    RevisionConflict { expected: u64, actual: u64 },
}

/// A durable admission fence, not a ban on settling already accepted effects.
pub(crate) fn require_accepting(
    connection: &rusqlite::Connection,
    session: &str,
) -> Result<(), StoreError> {
    if read(connection, session)?.is_some() {
        return Err(StoreError::SessionRetired);
    }
    Ok(())
}

pub(crate) fn require_mutable(
    connection: &rusqlite::Connection,
    session: &str,
) -> Result<(), StoreError> {
    match read(connection, session)? {
        None | Some(SessionRetirement::Archived) => Ok(()),
        Some(SessionRetirement::Archiving) => Err(StoreError::SessionBusy),
        Some(_) => Err(StoreError::SessionRetired),
    }
}

pub(crate) fn read(
    connection: &rusqlite::Connection,
    session: &str,
) -> Result<Option<SessionRetirement>, StoreError> {
    Ok(connection
        .query_row(
            "SELECT remove_session, completed FROM session_retirements WHERE session_id=?",
            params![session],
            |row| Ok((row.get::<_, bool>(0)?, row.get::<_, bool>(1)?)),
        )
        .optional()?
        .map(|(remove, completed)| match (remove, completed) {
            (true, false) => SessionRetirement::Removing,
            (true, true) => SessionRetirement::Removed,
            (false, false) => SessionRetirement::Archiving,
            (false, true) => SessionRetirement::Archived,
        }))
}

impl EventLog {
    /// Check durable owners before deleting external resources, not just before
    /// deleting their metadata. The removal fence prevents new owners appearing.
    pub async fn session_retirement_ready(&self, session: &str) -> Result<bool, StoreError> {
        validate_id(session)?;
        let session = session.to_owned();
        let commits = self.commits.session(&session);
        self.connection
            .run(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Immediate,
                )?;
                if !read(&tx, &session)?.is_some_and(SessionRetirement::pending) {
                    return Ok(false);
                }
                let terminal = crate::native_approvals::settle_retiring_waits(&tx, &session)?;
                let ready = settled(&tx, &session)?;
                if let Some(sequence) = terminal {
                    tx.commit().map_err(StoreError::CommitUnknown)?;
                    commits.publish(sequence);
                } else {
                    tx.rollback()?;
                }
                Ok(ready)
            })
            .await
    }

    /// Private cleanup metadata remains until resources are released. Ordinary
    /// Session queries no longer expose a logically removed Session.
    pub async fn retiring_session<T: serde::de::DeserializeOwned + Send + 'static>(
        &self,
        session: &str,
    ) -> Result<Option<super::SessionRecord<T>>, StoreError> {
        validate_id(session)?;
        let session = session.to_owned();
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                if !read(&tx, &session)?.is_some_and(SessionRetirement::pending) {
                    return Ok(None);
                }
                super::read(&tx, &session)
            })
            .await
    }

    /// Retrying an accepted removal observes its receipt before today's revision.
    /// The caller must authorize this exact Session independently of the receipt.
    pub async fn begin_session_removal(
        &self,
        session: &str,
        expected: u64,
    ) -> Result<SessionRemovalResult, StoreError> {
        validate_id(session)?;
        if expected == 0 || expected > MAX_SAFE_INTEGER {
            return Err(invalid("invalid expected Session revision"));
        }
        let session = session.to_owned();
        let commits = self.commits.session(&session);
        self.connection
            .run(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Immediate,
                )?;
                if let Some(state) = read(&tx, &session)? {
                    match state {
                        SessionRetirement::Removing | SessionRetirement::Removed => {
                            return Ok(SessionRemovalResult::Accepted(state));
                        }
                        SessionRetirement::Archiving => return Err(StoreError::SessionBusy),
                        SessionRetirement::Archived => {}
                    }
                }
                let actual = crate::workspace_bindings::current_session_revision(&tx, &session)?
                    .ok_or(StoreError::SessionNotFound)?;
                if actual != expected {
                    return Ok(SessionRemovalResult::RevisionConflict { expected, actual });
                }
                let approval_revoked = plan::fence(&tx, &session, plan::Action::Remove)?;
                tx.commit().map_err(StoreError::CommitUnknown)?;
                commits.metadata();
                if approval_revoked {
                    commits.activations();
                }
                Ok(SessionRemovalResult::Accepted(SessionRetirement::Removing))
            })
            .await
    }

    pub async fn session_retirement(
        &self,
        session: &str,
    ) -> Result<Option<SessionRetirement>, StoreError> {
        validate_id(session)?;
        let session = session.to_owned();
        self.connection
            .read(move |connection| read(connection, &session))
            .await
    }

    /// Bounded recovery scan; the fence is durable even if its requester vanished.
    pub async fn pending_session_retirements(
        &self,
        after: Option<&str>,
    ) -> Result<Vec<String>, StoreError> {
        if let Some(after) = after {
            validate_id(after)?;
        }
        let after = after.map(str::to_owned);
        self.connection
            .read(move |connection| {
                {
                    Ok(connection
                        .prepare_cached(
                            "SELECT session_id FROM session_retirements WHERE completed=0
                 AND (?1 IS NULL OR session_id>?1) ORDER BY session_id LIMIT 32",
                        )?
                        .query_map(params![after], |row| row.get(0))?
                        .collect::<std::result::Result<Vec<_>, _>>()?)
                }
            })
            .await
    }

    /// The Host has drained in-memory owners and cleaned owned workspace resources.
    /// Recheck durable settlement before dropping control metadata. Original log
    /// evidence stays available to copies; history ownership is not execution authority.
    pub async fn finish_session_retirement(
        &self,
        session: &str,
    ) -> Result<SessionRetirement, StoreError> {
        validate_id(session)?;
        let session_id = session.to_owned();
        let commits = self.commits.session(&session_id);
        let observations = self.connection.observations();
        let state = self
            .connection
            .run(move |connection| {
                let session = session_id;
                {
                    let tx = rusqlite::Transaction::new_unchecked(
                        connection,
                        rusqlite::TransactionBehavior::Immediate,
                    )?;
                    let state = read(&tx, &session)?.ok_or(StoreError::SessionNotFound)?;
                    if !state.pending() {
                        tx.rollback()?;
                        return Ok(state);
                    }
                    let native_terminal =
                        crate::native_approvals::settle_retiring_waits(&tx, &session)?;
                    if !settled(&tx, &session)? {
                        if let Some(sequence) = native_terminal {
                            tx.commit().map_err(StoreError::CommitUnknown)?;
                            commits.publish(sequence);
                        }
                        return Ok(state);
                    }
                    if state == SessionRetirement::Archiving {
                        tx.execute(
                            "UPDATE session_retirements SET completed=1 WHERE session_id=?",
                            params![&session],
                        )?;
                        advance_catalog(&tx)?;
                        tx.commit().map_err(StoreError::CommitUnknown)?;
                        if let Some(sequence) = native_terminal {
                            commits.publish(sequence);
                        } else {
                            commits.metadata();
                        }
                        return Ok(SessionRetirement::Archived);
                    }
                    // Membership is retained proof, not a disposable UI projection:
                    // descendants may pin an archive whose writer inherited its target.
                    // Verifying that archive/checkpoint still needs the writer's cut.
                    crate::context::semantic::gc::retire_owner(&tx, &session)?;
                    for statement in [
                        "DELETE FROM session_history_artifacts WHERE session_id=?",
                        "DELETE FROM session_revision_sources WHERE session_id=?",
                        "DELETE FROM catalog_messages WHERE session_id=?",
                        "DELETE FROM session_read_state WHERE session_id=?",
                        "DELETE FROM artifacts WHERE session_id=?",
                        "DELETE FROM artifact_catalog WHERE session_id=?",
                        "DELETE FROM shell_runs WHERE session_id=?",
                        "DELETE FROM session_processes WHERE session_id=?",
                        "DELETE FROM message_queue_state WHERE session_id=?",
                        "DELETE FROM session_control WHERE id=?",
                    ] {
                        tx.execute(statement, params![&session])?;
                    }
                    tx.execute(
                        "UPDATE session_retirements SET completed=1 WHERE session_id=?",
                        params![&session],
                    )?;
                    advance_catalog(&tx)?;
                    tx.commit().map_err(StoreError::CommitUnknown)?;
                    commits.material_released();
                    if let Some(sequence) = native_terminal {
                        commits.publish(sequence);
                    } else {
                        commits.metadata();
                    }
                    Ok(SessionRetirement::Removed)
                }
            })
            .await?;
        if state == SessionRetirement::Removed {
            observations.purge_session(session.to_owned()).await?;
        }
        Ok(state)
    }
}

fn settled(connection: &rusqlite::Connection, session: &str) -> Result<bool, StoreError> {
    if super::has_active_invocation(connection, session)? {
        return Ok(false);
    }
    let unsettled: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM shell_runs WHERE session_id=?1 AND
            (active=1 OR json_extract(record_json, '$.state.outcome.kind')='orphaned'))
         OR EXISTS(SELECT 1 FROM session_processes WHERE session_id=?1 AND cleaned=0)
         OR EXISTS(SELECT 1 FROM host_effects WHERE outcome IS NULL
            AND json_extract(request, '$.boundary.boundary.sessionId')=?1)
         OR EXISTS(SELECT 1 FROM interaction_pending WHERE session_id=?1)
         OR EXISTS(SELECT 1 FROM message_admissions WHERE session_id=?1)
         OR EXISTS(SELECT 1 FROM event_log a WHERE a.kind='auxiliary_model_started'
            AND json_extract(a.event_header,'$.source.kind')='session_title'
            AND json_extract(a.event_header,'$.session_id')=?1
            AND NOT EXISTS(SELECT 1 FROM event_log s WHERE s.kind='auxiliary_model_settled'
                AND json_extract(s.event_header,'$.request_id')=a.event_id))",
        params![session],
        |row| row.get(0),
    )?;
    Ok(!unsettled)
}
