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
use maka_plugin_core::scope::Scope;
use maka_plugin_core::storage::Namespace;
use rusqlite::{OptionalExtension, params};

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
    pub(crate) fn prepare_record(
        &self,
        connection: &rusqlite::Connection,
        configuration: &serde_json::Value,
        now: u64,
    ) -> Result<super::SessionRecord, StoreError> {
        if let Some(record) = super::probe(connection, &self.session_id, &self.fingerprint)? {
            check(connection, &self.session_id, Some(self))?;
            return Ok(record);
        }
        let workspace_binding =
            if let Some(reference) = crate::workspace_bindings::attached(configuration)? {
                let binding = crate::workspace_bindings::read(connection, reference.id)?.ok_or(
                    StoreError::SessionCreationRejected(
                        crate::root_store::CreationRejection::MissingWorkspaceBinding,
                    ),
                )?;
                if binding.reference() != reference {
                    return Err(StoreError::SessionCreationRejected(
                        crate::root_store::CreationRejection::StaleWorkspaceBinding,
                    ));
                }
                crate::workspace_bindings::effective_boundary(configuration, &binding)?;
                Some(binding)
            } else {
                None
            };
        let revision = crate::workspace_bindings::effective_revision(
            1,
            configuration,
            workspace_binding.as_ref(),
        )?;
        let encoded = serde_json::to_string(configuration)?;
        use sha2::{Digest, Sha256};
        Ok(super::SessionRecord {
            id: self.session_id.clone(),
            revision,
            created_at: now,
            updated_at: now,
            archived: false,
            configuration: configuration.clone(),
            workspace_binding,
            configuration_digest: format!(
                "sha256:{}",
                hex::encode(Sha256::digest(encoded.as_bytes()))
            ),
        })
    }

    pub(crate) fn insert_metadata(
        &self,
        connection: &rusqlite::Connection,
        configuration: &serde_json::Value,
        now: u64,
    ) -> Result<bool, StoreError> {
        if super::probe::<serde_json::Value>(connection, &self.session_id, &self.fingerprint)?
            .is_some()
        {
            check(connection, &self.session_id, Some(self))?;
            return Ok(false);
        }
        insert(connection, self)?;
        super::insert(
            connection,
            &self.session_id,
            &self.fingerprint,
            &serde_json::to_string(configuration)?,
            now,
        )?;
        Ok(true)
    }

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

pub(super) fn check(
    connection: &rusqlite::Connection,
    session: &str,
    requested: Option<&PluginSession>,
) -> Result<(), StoreError> {
    let row = connection
        .query_row(
            "SELECT package_id, scope_id, fingerprint, managed, authority_session_id
         FROM plugin_sessions WHERE session_id=?",
            params![session],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, bool>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()?;
    let stored = row
        .map(|row| {
            Ok::<_, StoreError>(PluginSession {
                session_id: session.to_owned(),
                creator: Namespace::new(
                    row.0,
                    Scope::try_from(row.1).map_err(|error| super::invalid(&error.to_string()))?,
                )
                .map_err(|error| super::invalid(&error.to_string()))?,
                fingerprint: row.2,
                managed: row.3,
                authority_session_id: row.4,
            })
        })
        .transpose()?;
    if stored.as_ref() != requested {
        return Err(StoreError::SessionConflict);
    }
    Ok(())
}

pub(super) fn insert(
    connection: &rusqlite::Connection,
    origin: &PluginSession,
) -> Result<(), StoreError> {
    retain_authority(connection, origin.authority_session_id.as_deref())?;
    connection.execute(
        "INSERT INTO plugin_sessions VALUES (?, ?, ?, ?, ?, ?)",
        params![
            &origin.session_id,
            origin.creator.package(),
            String::from(origin.creator.scope().clone()),
            &origin.fingerprint,
            origin.managed,
            &origin.authority_session_id
        ],
    )?;
    Ok(())
}

pub(super) fn retain_authority(
    connection: &rusqlite::Connection,
    source: Option<&str>,
) -> Result<(), StoreError> {
    if let Some(source) = source {
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM session_control WHERE id=?)",
            params![source],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(StoreError::SessionNotFound);
        }
        super::retain(connection, source)?;
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
        validate_id(session_id)?;
        let session_id = session_id.to_owned();
        self.connection
            .read(move |connection| {
                {
                    connection
                        .query_row(
                            "SELECT package_id, scope_id FROM plugin_sessions
                         WHERE session_id = ? AND (NOT ? OR managed = 1)",
                            params![session_id, managed_only],
                            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                        )
                        .optional()?
                        .map(|row| {
                            let scope = Scope::try_from(row.1).map_err(|error| {
                                StoreError::InvalidTransition(error.to_string())
                            })?;
                            Namespace::new(row.0, scope)
                                .map_err(|error| StoreError::InvalidTransition(error.to_string()))
                        })
                        .transpose()
                }
            })
            .await
    }
}
