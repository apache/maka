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

//! Durable, domain-independent session control metadata.

mod admission;
mod catalog;
pub(crate) use admission::retain;
pub(crate) use catalog::{CatalogKey, CatalogPosition, Selection as CatalogQuery};
pub(crate) mod metadata;
mod origin;
mod processes;
pub(crate) mod removal;
pub use metadata::SessionMutation;
pub use origin::PluginSession;
pub use removal::{RemovalPlan, RemoveFamilyResult, SessionRemovalResult, SessionRetirement};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{EventLog, StoreError};

pub const MAX_SESSION_PAGE: usize = 32;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SessionRecord<T = serde_json::Value> {
    pub id: String,
    /// Effective metadata revision, including shared binding epoch changes.
    pub revision: u64,
    pub created_at: u64,
    pub updated_at: u64,
    pub archived: bool,
    /// Exact stored configuration, with attachment baselines rather than resolved authority.
    pub configuration: T,
    /// Current binding captured in the same SQL snapshot as the stored configuration.
    #[serde(skip)]
    pub workspace_binding: Option<crate::workspace_bindings::WorkspaceBinding>,
    /// Digest of the exact stored configuration bytes.
    #[serde(skip)]
    pub configuration_digest: String,
}

impl<T> SessionRecord<T> {
    pub fn map_configuration<U>(self, map: impl FnOnce(T) -> U) -> SessionRecord<U> {
        SessionRecord {
            id: self.id,
            revision: self.revision,
            created_at: self.created_at,
            updated_at: self.updated_at,
            archived: self.archived,
            configuration: map(self.configuration),
            workspace_binding: self.workspace_binding,
            configuration_digest: self.configuration_digest,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub enum CatalogScope {
    Profile,
    Session(String),
    Workspace(String),
    /// Server-owned namespace. This is a data filter, never authorization.
    IdPrefix(String),
    /// One owner's catalog query. Every selection remains within its namespace.
    /// This is a data filter; the caller still supplies the original authority.
    Owned {
        id_prefix: String,
        selection: CatalogSelection,
        title_query: String,
    },
}

#[derive(Clone, Debug, Serialize)]
pub enum CatalogSelection {
    All,
    Children(String),
    Project(uuid::Uuid),
    Workspace {
        /// The original owned anchor also participates in continuation identity.
        session_id: String,
        identity: maka_sandbox::workspace::WorkspaceIdentity,
    },
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct CatalogFilter {
    pub roots_only: bool,
    pub archived_only: bool,
    pub include_archived: bool,
}

#[derive(Clone, Debug)]
pub struct SessionPage<T> {
    pub revision: String,
    pub sessions: Vec<SessionRecord<T>>,
    pub next_cursor: Option<String>,
    pub previous_cursor: Option<String>,
}

#[derive(Debug)]
pub struct UnreadableSession {
    pub id: String,
    pub error: StoreError,
}

#[derive(Debug)]
pub struct SessionOutcomePage<T> {
    pub revision: String,
    pub sessions: Vec<Result<SessionRecord<T>, UnreadableSession>>,
    pub next_cursor: Option<String>,
    pub previous_cursor: Option<String>,
}

/// Keyset position within one revisioned session catalog.
#[derive(Clone, Copy, Debug)]
pub enum SessionPosition<'a> {
    Start,
    /// Inclusive anchor for a fresh snapshot; a missing anchor resets to the head.
    At(&'a str),
    After(&'a str),
    Before(&'a str),
}
impl<'a> From<Option<&'a str>> for SessionPosition<'a> {
    fn from(cursor: Option<&'a str>) -> Self {
        cursor.map_or(Self::Start, Self::After)
    }
}

impl EventLog {
    pub async fn probe_session_create<T: DeserializeOwned + Send + 'static>(
        &self,
        id: &str,
        fingerprint: &str,
    ) -> Result<Option<SessionRecord<T>>, StoreError> {
        validate_id(id)?;
        let (id, fingerprint) = (id.to_owned(), fingerprint.to_owned());
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                probe(&tx, &id, &fingerprint)
            })
            .await
    }

    /// Configuration is opaque here; callers must validate its domain semantics.
    pub async fn create_session<T: Serialize + DeserializeOwned + Send + 'static>(
        &self,
        id: &str,
        fingerprint: &str,
        configuration: &T,
        now: u64,
    ) -> Result<SessionRecord<T>, StoreError> {
        self.create_session_owned(id, fingerprint, configuration, now, None)
            .await
    }

    /// Creator identity, optional management and Session creation share one transaction.
    /// Only Host admission supplies the bound package/scope.
    pub async fn create_plugin_session<T: Serialize + DeserializeOwned + Send + 'static>(
        &self,
        claim: &PluginSession,
        configuration: &T,
        now: u64,
    ) -> Result<SessionRecord<T>, StoreError> {
        claim.validate()?;
        self.create_session_owned(
            &claim.session_id,
            &claim.fingerprint,
            configuration,
            now,
            Some(claim.clone()),
        )
        .await
    }

    async fn create_session_owned<T: Serialize + DeserializeOwned + Send + 'static>(
        &self,
        id: &str,
        fingerprint: &str,
        configuration: &T,
        now: u64,
        origin: Option<PluginSession>,
    ) -> Result<SessionRecord<T>, StoreError> {
        validate_id(id)?;
        validate_time(now)?;
        let configuration = serde_json::to_string(configuration)?;
        let (id, fingerprint) = (id.to_owned(), fingerprint.to_owned());
        self.connection
            .run(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Immediate,
                )?;
                if let Some(record) = probe(&tx, &id, &fingerprint)? {
                    origin::check(&tx, &id, origin.as_ref())?;
                    return Ok(record);
                }
                if let Some(origin) = &origin {
                    origin::insert(&tx, origin)?;
                }
                insert(&tx, &id, &fingerprint, &configuration, now)?;
                let record = read(&tx, &id)?.ok_or(StoreError::SessionNotFound)?;
                tx.commit().map_err(StoreError::CommitUnknown)?;
                Ok(record)
            })
            .await
    }

    /// Whether ordinary reads may see this Session. Archiving preserves visibility;
    /// removing hides it before physical cleanup. This is not caller authorization
    /// or admission for new work, and does not decode the Session's metadata.
    pub async fn session_is_available(&self, id: &str) -> Result<bool, StoreError> {
        validate_id(id)?;
        let id = id.to_owned();
        self.connection
            .read(move |connection| {
                {
                    Ok(connection.query_row(
                        "SELECT EXISTS(SELECT 1 FROM session_control WHERE id = ?1)
                         AND NOT EXISTS(SELECT 1 FROM session_retirements
                                        WHERE session_id = ?1 AND remove_session != 0)",
                        params![id],
                        |row| row.get(0),
                    )?)
                }
            })
            .await
    }

    pub async fn get_session<T: DeserializeOwned + Send + 'static>(
        &self,
        id: &str,
    ) -> Result<Option<SessionRecord<T>>, StoreError> {
        validate_id(id)?;
        let id = id.to_owned();
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                if removal::read(&tx, &id)?.is_some_and(SessionRetirement::removes) {
                    return Ok(None);
                }
                read(&tx, &id)
            })
            .await
    }

    /// A continuation requires the revision returned with its first page.
    pub async fn list_sessions<T: DeserializeOwned + Send + 'static>(
        &self,
        expected_revision: Option<&str>,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<SessionPage<T>, StoreError> {
        self.session_page(
            CatalogScope::Profile,
            expected_revision,
            cursor.into(),
            limit,
            CatalogFilter {
                roots_only: false,
                archived_only: false,
                include_archived: true,
            },
        )
        .await
    }

    /// Metadata within a Host-authorized scope; never plugin-defined SQL.
    pub async fn scoped_sessions<T: DeserializeOwned + Send + 'static>(
        &self,
        scope: CatalogScope,
        expected_revision: Option<&str>,
        position: SessionPosition<'_>,
        filter: CatalogFilter,
    ) -> Result<SessionPage<T>, StoreError> {
        self.session_page(scope, expected_revision, position, MAX_SESSION_PAGE, filter)
            .await
    }
}

pub(crate) fn insert(
    tx: &rusqlite::Connection,
    id: &str,
    fingerprint: &str,
    configuration: &str,
    now: u64,
) -> Result<(), StoreError> {
    validate_id(id)?;
    validate_time(now)?;
    // Creation admission must distinguish missing/stale authority from storage
    // failures. Read the raw binding before resolving effective epochs: a future
    // attachment epoch is stale, not an arithmetic error that poisons recovery.
    let configuration_value: serde_json::Value = serde_json::from_str(configuration)?;
    if let Some(reference) = crate::workspace_bindings::attached(&configuration_value)? {
        let binding = crate::workspace_bindings::read::<serde_json::Value>(tx, reference.id)?;
        let rejection = match binding {
            None => Some(crate::root_store::CreationRejection::MissingWorkspaceBinding),
            Some(binding) if binding.reference() != reference => {
                Some(crate::root_store::CreationRejection::StaleWorkspaceBinding)
            }
            Some(binding) => {
                crate::workspace_bindings::effective_boundary(&configuration_value, &binding)?;
                None
            }
        };
        if let Some(rejection) = rejection {
            return Err(StoreError::SessionCreationRejected(rejection));
        }
    }
    let reserved: Option<String> = tx
        .query_row(
            "SELECT fingerprint FROM plugin_sessions WHERE session_id = ?",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    if reserved.is_some_and(|reserved| reserved != fingerprint) {
        return Err(StoreError::SessionConflict);
    }
    let inserted = tx.execute(
        "INSERT INTO session_control
         (id, fingerprint, revision, created_at, updated_at, archived, configuration, catalog_activity_at)
         SELECT ?1, ?2, 1, ?3, ?3, 0, ?4, 0
         WHERE NOT EXISTS (SELECT 1 FROM session_control WHERE id = ?1)
           AND NOT EXISTS (SELECT 1 FROM session_retirements WHERE session_id = ?1)",
        params![id, fingerprint, now as i64, configuration],
    )?;
    if inserted != 1 {
        return Err(StoreError::SessionConflict);
    }
    advance_catalog(tx)
}

pub(crate) fn read<T: DeserializeOwned>(
    connection: &rusqlite::Connection,
    id: &str,
) -> Result<Option<SessionRecord<T>>, StoreError> {
    let raw = connection
        .query_row(
            "SELECT id, revision, created_at, updated_at, archived, configuration
         FROM session_control WHERE id = ?",
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, bool>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .optional()?;
    if let Some(row) = raw {
        let configuration: String = row.5;
        use sha2::{Digest, Sha256};
        let configuration_digest = format!(
            "sha256:{}",
            hex::encode(Sha256::digest(configuration.as_bytes()))
        );
        let configuration_value: serde_json::Value = serde_json::from_str(&configuration)?;
        let workspace_binding =
            crate::workspace_bindings::resolve(connection, &configuration_value)?;
        let revision = crate::workspace_bindings::effective_revision(
            number(row.1)?,
            &configuration_value,
            workspace_binding.as_ref(),
        )?;
        let configuration = serde_json::from_value(configuration_value)?;
        Ok(Some(SessionRecord {
            id: row.0,
            revision,
            created_at: number(row.2)?,
            updated_at: number(row.3)?,
            archived: row.4,
            configuration,
            workspace_binding,
            configuration_digest,
        }))
    } else {
        Ok(None)
    }
}

pub(crate) fn advance_catalog(connection: &rusqlite::Connection) -> Result<(), StoreError> {
    if connection.execute("UPDATE session_catalog_revision SET revision = revision + 1 WHERE singleton = 1 AND revision < ?", params![MAX_SAFE_INTEGER as i64])? != 1 {
        return Err(invalid("session catalog revision exhausted"));
    }
    Ok(())
}

pub(crate) fn validate_id(id: &str) -> Result<(), StoreError> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(invalid("invalid session ID"));
    }
    Ok(())
}

pub(crate) fn validate_time(now: u64) -> Result<(), StoreError> {
    if now > MAX_SAFE_INTEGER {
        return Err(invalid("timestamp exceeds safe integer range"));
    }
    Ok(())
}

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}

fn number(value: i64) -> Result<u64, StoreError> {
    if value < 0 || value > MAX_SAFE_INTEGER as i64 {
        return Err(invalid("stored session number exceeds safe integer range"));
    }
    Ok(value as u64)
}

fn probe<T: DeserializeOwned>(
    connection: &rusqlite::Connection,
    id: &str,
    fingerprint: &str,
) -> Result<Option<SessionRecord<T>>, StoreError> {
    removal::require_accepting(connection, id)?;
    if fingerprint.is_empty() {
        return Err(invalid("invalid session fingerprint"));
    }
    let previous: Option<String> = connection
        .query_row(
            "SELECT fingerprint FROM session_control WHERE id = ?",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    if previous.is_some_and(|previous| previous != fingerprint) {
        return Err(StoreError::SessionConflict);
    }
    read(connection, id)
}

pub(crate) fn advance_revision(
    connection: &rusqlite::Connection,
    id: &str,
) -> Result<(), StoreError> {
    if crate::workspace_bindings::current_session_revision(connection, id)?
        .is_some_and(|revision| revision >= MAX_SAFE_INTEGER)
    {
        return Err(invalid("session revision exhausted"));
    }
    let changed = connection.execute(
        "UPDATE session_control SET revision = revision + 1 WHERE id = ? AND revision < ?",
        params![id, MAX_SAFE_INTEGER as i64],
    )?;
    if changed == 1 {
        advance_catalog(connection)?;
    } else if connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM session_control WHERE id = ?)",
        params![id],
        |row| row.get(0),
    )? {
        return Err(invalid("session revision exhausted"));
    }
    Ok(())
}
