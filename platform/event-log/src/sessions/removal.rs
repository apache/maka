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
pub use plan::{RemovalAuthority, RemovalPlan, RemoveFamilyResult};

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

pub(crate) fn preview_removal(
    connection: &rusqlite::Connection,
    session: &str,
    expected: u64,
) -> Result<(SessionRemovalResult, bool), StoreError> {
    if let Some(state) = read(connection, session)? {
        match state {
            SessionRetirement::Removing | SessionRetirement::Removed => {
                return Ok((SessionRemovalResult::Accepted(state), false));
            }
            SessionRetirement::Archiving => return Err(StoreError::SessionBusy),
            SessionRetirement::Archived => {}
        }
    }
    let actual = crate::workspace_bindings::current_session_revision(connection, session)?
        .ok_or(StoreError::SessionNotFound)?;
    if actual != expected {
        return Ok((
            SessionRemovalResult::RevisionConflict { expected, actual },
            false,
        ));
    }
    if actual >= MAX_SAFE_INTEGER {
        return Err(invalid("session revision exhausted"));
    }
    Ok((
        SessionRemovalResult::Accepted(SessionRetirement::Removing),
        true,
    ))
}

pub(crate) fn apply_removal(
    connection: &rusqlite::Connection,
    session: &str,
    expected: u64,
) -> Result<(SessionRemovalResult, bool), StoreError> {
    let (outcome, changed) = preview_removal(connection, session, expected)?;
    if changed {
        plan::fence(connection, session, plan::Action::Remove)?;
    }
    Ok((outcome, changed))
}

impl EventLog {
    /// Check durable owners before deleting external resources, not just before
    /// deleting their metadata. The removal fence prevents new owners appearing.
    pub async fn session_retirement_ready(&self, session: &str) -> Result<bool, StoreError> {
        validate_id(session)?;
        let session = session.to_owned();
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                if !read(&tx, &session)?.is_some_and(SessionRetirement::pending) {
                    return Ok(false);
                }
                settled(&tx, &session)
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
                let (outcome, changed) = apply_removal(&tx, &session, expected)?;
                if changed {
                    tx.commit().map_err(StoreError::CommitUnknown)?;
                    commits.metadata();
                }
                Ok(outcome)
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

    /// The Host has drained live owners and released its workspace resources.
    /// Domain owners must settle their own obligations before this call. The
    /// base row remains as retained identity for independently owned history.
    pub async fn finish_session_retirement(
        &self,
        session: &str,
    ) -> Result<SessionRetirement, StoreError> {
        validate_id(session)?;
        let session = session.to_owned();
        let commits = self.commits.session(&session);
        self.connection
            .run(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Immediate,
                )?;
                let state = read(&tx, &session)?.ok_or(StoreError::SessionNotFound)?;
                if !state.pending() || !settled(&tx, &session)? {
                    return Ok(state);
                }
                if state == SessionRetirement::Removing {
                    tx.execute(
                        "DELETE FROM session_processes WHERE session_id=? AND cleaned=1",
                        params![&session],
                    )?;
                }
                tx.execute(
                    "UPDATE session_retirements SET completed=1 WHERE session_id=?",
                    params![&session],
                )?;
                advance_catalog(&tx)?;
                tx.commit().map_err(StoreError::CommitUnknown)?;
                commits.metadata();
                Ok(if state == SessionRetirement::Removing {
                    SessionRetirement::Removed
                } else {
                    SessionRetirement::Archived
                })
            })
            .await
    }
}

fn settled(connection: &rusqlite::Connection, session: &str) -> Result<bool, StoreError> {
    let unsettled: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM session_processes WHERE session_id=?1 AND cleaned=0)
         OR EXISTS(SELECT 1 FROM host_effects WHERE outcome IS NULL
            AND json_extract(request, '$.boundary.boundary.sessionId')=?1)",
        params![session],
        |row| row.get(0),
    )?;
    Ok(!unsettled)
}
