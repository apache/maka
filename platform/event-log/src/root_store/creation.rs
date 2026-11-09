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

use super::*;
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::Value;

/// Confirmed, rolled-back admission outcomes. Storage failures never become a
/// rejected request; they retain their recovery obligation and original error.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
pub enum CreationRejection {
    #[error("Session identity is already occupied")]
    IdentityConflict,
    #[error("source revision changed from {expected} to {actual}")]
    SourceRevisionConflict { expected: u64, actual: u64 },
    #[error("creation dependency is missing")]
    MissingDependency,
    #[error("Session identity has been retired")]
    Retired,
    #[error("workspace binding does not exist")]
    MissingWorkspaceBinding,
    #[error("workspace attachment changed before creation")]
    StaleWorkspaceBinding,
}

pub(super) fn validate_configuration(configuration: &Value) -> Result<(), StoreError> {
    if crate::workspace_bindings::attached(configuration)?.is_some() {
        let boundary = configuration
            .get("boundary_revision")
            .and_then(Value::as_u64)
            .filter(|revision| *revision <= 9_007_199_254_740_991);
        if boundary.is_none() {
            return Err(StoreError::InvalidTransition(
                "invalid Session permission boundary".into(),
            ));
        }
    }
    Ok(())
}

pub(super) async fn commit(
    store: &EventLog,
    id: &str,
    fingerprint: &str,
    configuration: Value,
    now: u64,
) -> Result<Option<CreationRejection>, StoreError> {
    match store
        .connection
        .write(
            WriteCreation {
                id: id.to_owned(),
                fingerprint: fingerprint.to_owned(),
                configuration,
                now,
            },
            store.commits.session(id),
        )
        .await
    {
        Ok(()) => Ok(None),
        Err(StoreError::SessionCreationRejected(rejection)) => Ok(Some(rejection)),
        Err(error) => Err(error),
    }
}

pub(crate) struct WriteCreation {
    id: String,
    fingerprint: String,
    configuration: Value,
    now: u64,
}
impl crate::writeback::Statement for WriteCreation {
    type Value = ();
    type Output = ();
    fn execute(
        self,
        connection: &SqliteConnection,
    ) -> Result<crate::writeback::Prepared<()>, StoreError> {
        {
            let command = super::routes::Creation::Session {
                configuration: self.configuration.clone(),
                created_at: self.now,
            };
            if let Some((fingerprint,encoded))=connection.query_row("SELECT fingerprint,command FROM session_creations WHERE session_id=? AND session_id=creation_id", rusqlite::params![&self.id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).optional()? {
                let previous:super::routes::Creation=serde_json::from_str(&encoded)?;
                if fingerprint!=self.fingerprint || previous.identity()?!=command.identity()? {
                    return Err(StoreError::SessionCreationRejected(CreationRejection::IdentityConflict));
                }
                return Ok(prepared((),false));
            }
            match crate::sessions::removal::require_accepting(connection, &self.id) {
                Ok(()) => {}
                Err(StoreError::SessionRetired) => {
                    return Err(StoreError::SessionCreationRejected(
                        CreationRejection::Retired,
                    ));
                }
                Err(error) => return Err(error),
            }
            match crate::sessions::insert(
                connection,
                &self.id,
                &self.fingerprint,
                &serde_json::to_string(&self.configuration)?,
                self.now,
            ) {
                Ok(()) => {
                    connection.execute("INSERT INTO session_creations(session_id,creation_id,fingerprint,command,ready,visible) VALUES(?1,?1,?2,?3,1,1)", rusqlite::params![&self.id, &self.fingerprint, serde_json::to_string(&command)?])?;
                    Ok(prepared((), true))
                }
                Err(StoreError::SessionConflict) => Err(StoreError::SessionCreationRejected(
                    CreationRejection::IdentityConflict,
                )),
                Err(error) => Err(error),
            }
        }
    }
    fn committed(value: ()) -> Self::Output {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(error, StoreError::SessionCreationRejected(_))
    }
}

pub(crate) struct WriteReservation {
    pub(super) id: String,
    pub(super) fingerprint: String,
    pub(super) command: super::routes::Creation,
    pub(super) members: Vec<String>,
}
pub(crate) struct ReservedCreation {
    pub(super) command: super::routes::Creation,
}
impl WriteReservation {
    pub(super) fn existing(
        connection: &SqliteConnection,
        id: &str,
        fingerprint: &str,
        command: &super::routes::Creation,
    ) -> Result<Option<ReservedCreation>, StoreError> {
        let row = connection.query_row(
            "SELECT creation_id,fingerprint,command,failure FROM session_creations WHERE session_id=?",
            rusqlite::params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?)),
        ).optional()?;
        let Some((creation_id, previous_fingerprint, encoded, failure)) = row else {
            return Ok(None);
        };
        let previous: super::routes::Creation = serde_json::from_str(&encoded)?;
        if creation_id != id
            || previous_fingerprint != fingerprint
            || previous.identity()? != command.identity()?
        {
            return Err(StoreError::SessionConflict);
        }
        if let Some(failure) = failure {
            return Err(StoreError::SessionCreationRejected(serde_json::from_str(
                &failure,
            )?));
        }
        Ok(Some(ReservedCreation { command: previous }))
    }
}
impl crate::writeback::Statement for WriteReservation {
    type Value = ReservedCreation;
    type Output = Self::Value;
    fn execute(
        self,
        connection: &SqliteConnection,
    ) -> Result<crate::writeback::Prepared<Self::Value>, StoreError> {
        {
            if let Some(previous) =
                Self::existing(connection, &self.id, &self.fingerprint, &self.command)?
            {
                return Ok(prepared(previous, false));
            }
            let encoded = serde_json::to_string(&self.command)?;
            for member in self.members {
                let visible = true;
                let occupied: bool = connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM session_creations WHERE session_id=?)",
                    rusqlite::params![&member],
                    |row| row.get(0),
                )?;
                if occupied {
                    return Err(StoreError::SessionConflict);
                }
                connection.execute("INSERT INTO session_creations(session_id,creation_id,fingerprint,command,ready,visible) VALUES(?,?,?,?,0,?)", rusqlite::params![&member, &self.id, &self.fingerprint, (member == self.id).then_some(&encoded), visible])?;
            }
            Ok(prepared(
                ReservedCreation {
                    command: self.command,
                },
                true,
            ))
        }
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::SessionConflict | StoreError::SessionCreationRejected(_)
        )
    }
}

pub(crate) struct WritePublication {
    pub(super) id: String,
    pub(super) rejection: Option<CreationRejection>,
}
impl crate::writeback::Statement for WritePublication {
    type Value = ();
    type Output = ();
    fn execute(
        self,
        connection: &SqliteConnection,
    ) -> Result<crate::writeback::Prepared<()>, StoreError> {
        {
            let changed = if let Some(rejection) = self.rejection {
                connection.execute("UPDATE session_creations SET ready=2,failure=? WHERE creation_id=? AND ready=0", rusqlite::params![serde_json::to_string(&rejection)?, &self.id])?

                    != 0
            } else {
                let newly_visible: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM session_creations WHERE creation_id=? AND ready=0 AND visible=1)", rusqlite::params![&self.id], |row| row.get(0))?;
                let changed = connection.execute(
                    "UPDATE session_creations SET ready=1 WHERE creation_id=? AND ready=0",
                    rusqlite::params![&self.id],
                )? != 0;
                if newly_visible {
                    crate::sessions::advance_catalog(connection)?;
                }
                changed
            };
            Ok(prepared((), changed))
        }
    }
    fn committed(value: ()) -> Self::Output {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(error, StoreError::InvalidTransition(_))
    }
}

fn prepared<T>(value: T, changed: bool) -> crate::writeback::Prepared<T> {
    crate::writeback::Prepared {
        value,
        changed,
        notification: crate::writeback::Notification::NONE,
    }
}

#[cfg(test)]
mod tests;
