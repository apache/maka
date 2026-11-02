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

//! Durable session control metadata. Execution history remains in runtime_events.

mod activity;
mod admission;
mod catalog;
pub(crate) use admission::retain;
pub(crate) use catalog::{CatalogKey, CatalogPosition, Selection as CatalogQuery};
pub(crate) mod copy;
pub use copy::{AbandonRevision, SessionCopy, SessionCopyResult};
mod execution;
mod import;
mod material;
pub use material::MaterialCollection;
mod metadata;
mod origin;
mod processes;
pub(crate) mod removal;
pub use origin::PluginSession;
pub use removal::{
    RemovalAuthority, RemovalPlan, RemoveFamilyResult, SessionRemovalResult, SessionRetirement,
};
pub(crate) mod read_state;
pub(crate) use activity::{initialize_execution, project_execution, register_functions};
pub use execution::{CatalogMessage, SessionExecution, SessionExecutionState};
pub(crate) use execution::{advance_revision, has_active_invocation};
pub use metadata::SessionMutation;
pub use read_state::SessionReadState;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sqlx::{Connection, Row, SqliteConnection};

use crate::{EventLog, StoreError};

pub const MAX_SESSION_PAGE: usize = 32;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SessionRecord<T> {
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
    /// Exact stored configuration basis, independent of execution-driven revision.
    #[serde(skip)]
    pub configuration_digest: String,
    #[serde(default)]
    pub read_state: SessionReadState,
    /// Bounded execution projection read in the same snapshot as metadata.
    #[serde(skip)]
    pub execution: Option<SessionExecution>,
    /// Message activity does not imply a local execution (for example, imported history).
    #[serde(skip)]
    pub last_message: Option<CatalogMessage>,
    /// Oldest unresolved interaction, read from canonical facts in the same snapshot.
    #[serde(skip)]
    pub pending_interaction_since: Option<u64>,
    pub lineage: Option<Box<maka_agent_facts::session::Lineage>>,
    pub copy_state: Option<maka_agent_facts::session::CopyState>,
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
            read_state: self.read_state,
            execution: self.execution,
            last_message: self.last_message,
            pending_interaction_since: self.pending_interaction_since,
            lineage: self.lineage,
            copy_state: self.copy_state,
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
        identity: maka_agent_facts::execution::WorkspaceIdentity,
    },
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct CatalogFilter {
    pub archived_only: bool,
    pub include_archived: bool,
    pub pending_only: bool,
}

#[derive(Clone, Debug)]
pub struct SessionPage<T> {
    pub revision: String,
    pub sessions: Vec<SessionRecord<T>>,
    /// All unresolved-interaction sessions in this scope, independent of page size.
    pub pending_session_count: u64,
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
        self.validate_root()?;
        validate_id(id)?;
        let (id, fingerprint) = (id.to_owned(), fingerprint.to_owned());
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    probe(&mut tx, &id, &fingerprint).await
                })
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
        self.validate_root()?;
        validate_id(id)?;
        validate_time(now)?;
        let configuration = serde_json::to_string(configuration)?;
        let (id, fingerprint) = (id.to_owned(), fingerprint.to_owned());
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                    if let Some(record) = probe(&mut tx, &id, &fingerprint).await? {
                        origin::check(&mut tx, &id, origin.as_ref()).await?;
                        return Ok(record);
                    }
                    if let Some(origin) = &origin {
                        origin::insert(&mut tx, origin).await?;
                    }
                    insert(&mut tx, &id, &fingerprint, &configuration, now).await?;
                    let record = read(&mut tx, &id)
                        .await?
                        .ok_or(StoreError::SessionNotFound)?;
                    tx.commit().await.map_err(StoreError::CommitUnknown)?;
                    Ok(record)
                })
            })
            .await
    }

    /// Whether ordinary reads may see this Session. Archiving preserves visibility;
    /// removing hides it before physical cleanup. This is not caller authorization
    /// or admission for new work, and does not decode the Session's metadata.
    pub async fn session_is_available(&self, id: &str) -> Result<bool, StoreError> {
        self.validate_root()?;
        validate_id(id)?;
        let id = id.to_owned();
        self.connection
            .read(move |connection| {
                Box::pin(async move {
                    Ok(sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM session_control WHERE id = ?1)
                         AND NOT EXISTS(SELECT 1 FROM session_retirements
                                        WHERE session_id = ?1 AND remove_session != 0)",
                    )
                    .bind(id)
                    .fetch_one(connection)
                    .await?)
                })
            })
            .await
    }

    pub async fn get_session<T: DeserializeOwned + Send + 'static>(
        &self,
        id: &str,
    ) -> Result<Option<SessionRecord<T>>, StoreError> {
        self.validate_root()?;
        validate_id(id)?;
        let id = id.to_owned();
        self.connection
            .read(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    if removal::read(&mut tx, &id)
                        .await?
                        .is_some_and(SessionRetirement::removes)
                    {
                        return Ok(None);
                    }
                    read(&mut tx, &id).await
                })
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
                archived_only: false,
                include_archived: true,
                pending_only: false,
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

pub(crate) async fn insert(
    tx: &mut SqliteConnection,
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
        let binding =
            crate::workspace_bindings::read::<serde_json::Value>(tx, reference.id).await?;
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
    let reserved: Option<String> =
        sqlx::query_scalar("SELECT fingerprint FROM plugin_sessions WHERE session_id = ?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    if reserved.is_some_and(|reserved| reserved != fingerprint) {
        return Err(StoreError::SessionConflict);
    }
    let inserted = sqlx::query(
        "INSERT INTO session_control
         (id, fingerprint, revision, created_at, updated_at, archived, configuration, catalog_activity_at)
         SELECT ?1, ?2, 1, ?3, ?4, 0, ?5, COALESCE((
             SELECT message_at FROM catalog_messages INDEXED BY catalog_latest_message
             WHERE session_id = ?1 ORDER BY message_at DESC, sequence DESC, ordinal DESC LIMIT 1
         ), 0)
         WHERE NOT EXISTS (SELECT 1 FROM session_control WHERE id = ?1)
           AND NOT EXISTS (SELECT 1 FROM session_history_copies WHERE session_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM session_retirements WHERE session_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM context_source_prefixes p
             CROSS JOIN event_log e ON e.sequence=p.sequence
             JOIN imported_invocations i ON i.invocation_id=e.invocation_id
             WHERE p.kind='session' AND p.owner=?1)
           AND NOT EXISTS (SELECT 1 FROM session_imports WHERE session_id = ?1 AND state != 'published')",
    )
    .bind(id)
    .bind(fingerprint)
    .bind(now as i64)
    .bind(now as i64)
    .bind(configuration)
    .execute(&mut *tx)
    .await?;
    if inserted.rows_affected() != 1 {
        return Err(StoreError::SessionConflict);
    }
    advance_catalog(tx).await
}

pub(crate) async fn read<T: DeserializeOwned>(
    connection: &mut SqliteConnection,
    id: &str,
) -> Result<Option<SessionRecord<T>>, StoreError> {
    let raw = sqlx::query(
        "SELECT id, revision, created_at, updated_at, archived, configuration,
            (SELECT lineage_json FROM session_history_copies WHERE session_id = id),
            (SELECT state FROM session_history_copies WHERE session_id = id)
         FROM session_control WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&mut *connection)
    .await?;
    if let Some(row) = raw {
        let configuration: String = row.try_get(5)?;
        let configuration_digest =
            maka_agent_facts::artifact::content_digest(configuration.as_bytes());
        let configuration_value: serde_json::Value = serde_json::from_str(&configuration)?;
        let workspace_binding =
            crate::workspace_bindings::resolve(connection, &configuration_value).await?;
        let revision = crate::workspace_bindings::effective_revision(
            number(&row, 1)?,
            &configuration_value,
            workspace_binding.as_ref(),
        )?;
        let configuration = serde_json::from_value(configuration_value)?;
        let lineage = row
            .try_get::<Option<String>, _>(6)?
            .map(|json| serde_json::from_str(&json))
            .transpose()?;
        let copy_state = row
            .try_get::<Option<String>, _>(7)?
            .map(|state| state.parse().map_err(invalid))
            .transpose()?;
        let execution = execution::read(connection, id).await?;
        let last_message = execution::last_message(connection, id).await?;
        let read_state = read_state::read(connection, id).await?;
        let pending_since: Option<i64> = sqlx::query_scalar(
            "SELECT MIN(created_at) FROM all_interaction_pending WHERE session_id = ?",
        )
        .bind(id)
        .fetch_one(&mut *connection)
        .await?;
        let pending_interaction_since = pending_since
            .map(|time| u64::try_from(time).map_err(|_| invalid("invalid interaction timestamp")))
            .transpose()?;
        Ok(Some(SessionRecord {
            id: row.try_get(0)?,
            revision,
            created_at: number(&row, 2)?,
            updated_at: number(&row, 3)?,
            archived: row.try_get(4)?,
            configuration,
            workspace_binding,
            configuration_digest,
            execution,
            last_message,
            read_state,
            pending_interaction_since,
            lineage,
            copy_state,
        }))
    } else {
        Ok(None)
    }
}

pub(crate) async fn advance_catalog(connection: &mut SqliteConnection) -> Result<(), StoreError> {
    if sqlx::query(
        "UPDATE session_catalog_revision SET revision = revision + 1 WHERE singleton = 1 AND revision < ?",
    ).bind(MAX_SAFE_INTEGER as i64).execute(connection).await?.rows_affected() != 1 {
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

fn number(row: &sqlx::sqlite::SqliteRow, column: usize) -> Result<u64, StoreError> {
    let value: i64 = row.try_get(column)?;
    if value < 0 || value > MAX_SAFE_INTEGER as i64 {
        return Err(invalid("stored session number exceeds safe integer range"));
    }
    Ok(value as u64)
}

async fn probe<T: DeserializeOwned>(
    connection: &mut SqliteConnection,
    id: &str,
    fingerprint: &str,
) -> Result<Option<SessionRecord<T>>, StoreError> {
    removal::require_accepting(connection, id).await?;
    if fingerprint.is_empty() {
        return Err(invalid("invalid session fingerprint"));
    }
    let previous: Option<String> =
        sqlx::query_scalar("SELECT fingerprint FROM session_control WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *connection)
            .await?;
    if previous.is_some_and(|previous| previous != fingerprint) {
        return Err(StoreError::SessionConflict);
    }
    read(connection, id).await
}
