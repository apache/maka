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

use super::validate_id;
use crate::{EventLog, StoreError};
use maka_capabilities::storage::Namespace;
use maka_plugin_core::scope::Scope;
use sqlx::{Row, SqliteConnection};

/// Host-bound creation identity, not a caller-provided authorization credential.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginSession {
    pub session_id: String,
    pub creator: Namespace,
    /// Stable identity of the original creation request.
    pub fingerprint: String,
    pub managed: bool,
    /// Session whose current authority the Host used to create this root.
    /// This is a lifecycle dependency, not a business parent or a new grant.
    pub authority_session_id: Option<String>,
}

impl PluginSession {
    pub(super) fn validate(&self) -> Result<(), StoreError> {
        validate_id(&self.session_id)?;
        if let Some(source) = &self.authority_session_id {
            validate_id(source)?;
            if source == &self.session_id {
                return Err(super::invalid("Session cannot authorize its own creation"));
            }
        }
        Ok(())
    }
}

pub(super) async fn check(
    connection: &mut SqliteConnection,
    session: &str,
    requested: Option<&PluginSession>,
) -> Result<(), StoreError> {
    let row = sqlx::query(
        "SELECT package_id, scope_id, fingerprint, managed, authority_session_id
         FROM plugin_sessions WHERE session_id=?",
    )
    .bind(session)
    .fetch_optional(connection)
    .await?;
    let stored = row
        .map(|row| {
            Ok::<_, StoreError>(PluginSession {
                session_id: session.to_owned(),
                creator: Namespace::new(
                    row.try_get::<String, _>("package_id")?,
                    Scope::try_from(row.try_get::<String, _>("scope_id")?)
                        .map_err(|error| super::invalid(&error.to_string()))?,
                )
                .map_err(|error| super::invalid(&error.to_string()))?,
                fingerprint: row.try_get("fingerprint")?,
                managed: row.try_get("managed")?,
                authority_session_id: row.try_get("authority_session_id")?,
            })
        })
        .transpose()?;
    if stored.as_ref() != requested {
        return Err(StoreError::SessionConflict);
    }
    Ok(())
}

pub(super) async fn insert(
    connection: &mut SqliteConnection,
    origin: &PluginSession,
) -> Result<(), StoreError> {
    retain_authority(connection, origin.authority_session_id.as_deref()).await?;
    sqlx::query("INSERT INTO plugin_sessions VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&origin.session_id)
        .bind(origin.creator.package())
        .bind(String::from(origin.creator.scope().clone()))
        .bind(&origin.fingerprint)
        .bind(origin.managed)
        .bind(&origin.authority_session_id)
        .execute(connection)
        .await?;
    Ok(())
}

pub(super) async fn retain_authority(
    connection: &mut SqliteConnection,
    source: Option<&str>,
) -> Result<(), StoreError> {
    if let Some(source) = source {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session_control WHERE id=?)")
                .bind(source)
                .fetch_one(&mut *connection)
                .await?;
        if !exists {
            return Err(StoreError::SessionNotFound);
        }
        super::retain(connection, source).await?;
    }
    Ok(())
}

impl EventLog {
    pub async fn session_manager(&self, session_id: &str) -> Result<Option<Namespace>, StoreError> {
        self.session_plugin(session_id, true).await
    }

    pub async fn session_creator(&self, session_id: &str) -> Result<Option<Namespace>, StoreError> {
        self.session_plugin(session_id, false).await
    }

    async fn session_plugin(
        &self,
        session_id: &str,
        managed_only: bool,
    ) -> Result<Option<Namespace>, StoreError> {
        self.validate_root()?;
        validate_id(session_id)?;
        let session_id = session_id.to_owned();
        self.connection
            .read(move |connection| {
                Box::pin(async move {
                    sqlx::query(
                        "SELECT package_id, scope_id FROM plugin_sessions
                         WHERE session_id = ? AND (NOT ? OR managed = 1)",
                    )
                    .bind(session_id)
                    .bind(managed_only)
                    .fetch_optional(connection)
                    .await?
                    .map(|row| {
                        let scope = Scope::try_from(row.get::<String, _>("scope_id"))
                            .map_err(|error| StoreError::InvalidTransition(error.to_string()))?;
                        Namespace::new(row.get::<String, _>("package_id"), scope)
                            .map_err(|error| StoreError::InvalidTransition(error.to_string()))
                    })
                    .transpose()
                })
            })
            .await
    }
}
