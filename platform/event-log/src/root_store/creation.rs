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
    #[error("source history is managed by another owner")]
    ManagedSource,
    #[error("source Turn does not exist")]
    HistoryTurnMissing,
    #[error("revision Turn has no editable input")]
    RevisionInputMissing,
    #[error("revision family exhausted")]
    RevisionFamilyExhausted,
    #[error("history cut splits a logical Turn")]
    HistoryTurnSplit,
    #[error("source history is unsettled")]
    HistoryUnsettled,
    #[error("source provider effect is unresolved")]
    HistoryProviderEffectUnresolved,
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
        connection: &mut SqliteConnection,
    ) -> crate::connection::BoxFuture<'_, Result<crate::writeback::Prepared<()>, StoreError>> {
        Box::pin(async move {
            // Recover an existing receipt before inspecting mutable attachments.
            let previous: Option<String> =
                sqlx::query_scalar("SELECT fingerprint FROM session_control WHERE id=?")
                    .bind(&self.id)
                    .fetch_optional(&mut *connection)
                    .await?;
            if let Some(previous) = previous {
                if previous != self.fingerprint {
                    return Err(StoreError::SessionCreationRejected(
                        CreationRejection::IdentityConflict,
                    ));
                }
                return Ok(prepared((), false));
            }
            match crate::sessions::removal::require_accepting(connection, &self.id).await {
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
            )
            .await
            {
                Ok(()) => Ok(prepared((), true)),
                Err(StoreError::SessionConflict) => Err(StoreError::SessionCreationRejected(
                    CreationRejection::IdentityConflict,
                )),
                Err(error) => Err(error),
            }
        })
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
    pub(super) partition: usize,
    pub(super) members: Vec<String>,
}
pub(crate) struct ReservedCreation {
    pub(super) partition: usize,
    pub(super) command: super::routes::Creation,
}
impl crate::writeback::Statement for WriteReservation {
    type Value = ReservedCreation;
    type Output = Self::Value;
    fn execute(
        self,
        connection: &mut SqliteConnection,
    ) -> crate::connection::BoxFuture<'_, Result<crate::writeback::Prepared<Self::Value>, StoreError>>
    {
        Box::pin(async move {
            if let Some(row) = sqlx::query(
                "SELECT creation_id,partition,fingerprint,command,failure FROM session_routes WHERE session_id=?",
            )
            .bind(&self.id)
            .fetch_optional(&mut *connection)
            .await?
            {
                if row.get::<&str, _>("creation_id") != self.id {
                    return Err(StoreError::SessionConflict);
                }
                let previous: super::routes::Creation = serde_json::from_str(row.get("command"))?;
                if row.get::<&str, _>("fingerprint") != self.fingerprint
                    || previous.identity()? != self.command.identity()?
                {
                    return Err(StoreError::SessionConflict);
                }
                if let Some(failure) = row.get::<Option<String>, _>("failure") {
                    return Err(StoreError::SessionCreationRejected(serde_json::from_str(&failure)?));
                }
                return Ok(prepared(
                    ReservedCreation {
                        partition: row.get::<i64, _>("partition") as usize,
                        command: previous,
                    },
                    false,
                ));
            }
            let encoded = serde_json::to_string(&self.command)?;
            for member in self.members {
                let visible = match &self.command {
                    super::routes::Creation::Bundle { configurations, .. } => {
                        configurations.contains_key(&member)
                    }
                    _ => true,
                };
                let occupied: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM session_routes WHERE session_id=?)",
                )
                .bind(&member)
                .fetch_one(&mut *connection)
                .await?;
                if occupied {
                    return Err(StoreError::SessionConflict);
                }
                sqlx::query("INSERT INTO session_routes(session_id,creation_id,partition,fingerprint,command,ready,visible) VALUES(?,?,?,?,?,0,?)")
                    .bind(&member).bind(&self.id).bind(self.partition as i64).bind(&self.fingerprint).bind((member == self.id).then_some(&encoded)).bind(visible).execute(&mut *connection).await?;
            }
            Ok(prepared(
                ReservedCreation {
                    partition: self.partition,
                    command: self.command,
                },
                true,
            ))
        })
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
        connection: &mut SqliteConnection,
    ) -> crate::connection::BoxFuture<'_, Result<crate::writeback::Prepared<()>, StoreError>> {
        Box::pin(async move {
            let changed = if let Some(rejection) = self.rejection {
                sqlx::query(
                    "UPDATE session_routes SET ready=2,failure=? WHERE creation_id=? AND ready=0",
                )
                .bind(serde_json::to_string(&rejection)?)
                .bind(&self.id)
                .execute(&mut *connection)
                .await?
                .rows_affected()
                    != 0
            } else {
                let newly_visible: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session_routes WHERE creation_id=? AND ready=0 AND visible=1)")
                    .bind(&self.id).fetch_one(&mut *connection).await?;
                let changed = sqlx::query(
                    "UPDATE session_routes SET ready=1 WHERE creation_id=? AND ready=0",
                )
                .bind(&self.id)
                .execute(&mut *connection)
                .await?
                .rows_affected()
                    != 0;
                if newly_visible {
                    crate::sessions::advance_catalog(connection).await?;
                }
                changed
            };
            Ok(prepared((), changed))
        })
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
        notification: crate::writeback::Notification::None,
    }
}

#[cfg(test)]
mod tests;
