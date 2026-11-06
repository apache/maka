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

//! Root catalogue reads use one database revision and indexed keyset pages.
use super::RootStore;
use crate::{
    EventLog, StoreError,
    sessions::{
        CatalogFilter, CatalogKey, CatalogPosition, CatalogScope, MAX_SESSION_PAGE,
        SessionOutcomePage, SessionPage, SessionPosition, SessionRecord,
    },
};
use rusqlite::{Connection as SqliteConnection, OptionalExtension};
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}

/// Unpublished creations and retired Sessions never enter the live catalog.
pub(crate) fn session_visible(db: &SqliteConnection, id: &str) -> Result<bool, StoreError> {
    Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM session_control s JOIN session_creations r ON r.session_id=s.id
        WHERE s.id=?1 AND r.ready=1 AND r.visible=1
        AND NOT EXISTS(SELECT 1 FROM session_retirements d WHERE d.session_id=s.id AND d.remove_session=1))", rusqlite::params![id], |row| row.get(0))?)
}

pub(crate) fn require_snapshot(db: &SqliteConnection, expected: i64) -> Result<(), StoreError> {
    let actual: i64 = db.query_row(
        "SELECT revision FROM session_catalog_revision WHERE singleton=1",
        rusqlite::params![],
        |row| row.get(0),
    )?;
    if actual != expected {
        return Err(StoreError::RevisionConflict {
            expected: expected.to_string(),
            actual: actual.to_string(),
        });
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
struct CatalogRevision {
    revision: i64,
}
impl CatalogRevision {
    fn revision(&self, scope: &CatalogScope, filter: CatalogFilter) -> Result<String, StoreError> {
        // Keep the canonical revision in the opaque wire token. The query
        // digest prevents a cursor from broadening owner/selection/filter scope.
        let query = hex::encode(Sha256::digest(serde_json::to_vec(&(scope, filter))?));
        Ok(format!(
            "root-catalog-v1:{}:{}",
            query,
            hex::encode(serde_json::to_vec(self)?)
        ))
    }
}

async fn counter(log: &EventLog) -> Result<i64, StoreError> {
    log.validate_root()?;
    log.connection
        .read(|db| {
            let counter: i64 = db.query_row(
                "SELECT revision FROM session_catalog_revision WHERE singleton=1",
                rusqlite::params![],
                |row| row.get(0),
            )?;
            if counter < 0 {
                return Err(invalid("invalid catalog revision"));
            }
            Ok(counter)
        })
        .await
}

impl RootStore {
    async fn catalog_version(&self) -> Result<CatalogRevision, StoreError> {
        self.require_open()?;
        Ok(CatalogRevision {
            revision: counter(&self.log).await?,
        })
    }

    pub async fn catalog_revision(
        &self,
        scope: CatalogScope,
        filter: CatalogFilter,
    ) -> Result<String, StoreError> {
        EventLog::catalog_selection_valid(&scope, filter)?;
        self.catalog_version().await?.revision(&scope, filter)
    }

    pub async fn scoped_sessions<T: DeserializeOwned + Send + 'static>(
        &self,
        scope: CatalogScope,
        expected_revision: Option<&str>,
        position: SessionPosition<'_>,
        filter: CatalogFilter,
    ) -> Result<SessionPage<T>, StoreError> {
        self.root_session_page(scope, expected_revision, position, MAX_SESSION_PAGE, filter)
            .await
    }

    pub async fn scoped_session_outcomes<T: DeserializeOwned + Send + 'static>(
        &self,
        scope: CatalogScope,
        expected_revision: Option<&str>,
        position: SessionPosition<'_>,
        filter: CatalogFilter,
    ) -> Result<SessionOutcomePage<T>, StoreError> {
        self.root_session_outcomes_page(
            scope,
            expected_revision,
            position,
            MAX_SESSION_PAGE,
            filter,
        )
        .await
    }

    pub async fn list_sessions<T: DeserializeOwned + Send + 'static>(
        &self,
        expected_revision: Option<&str>,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<SessionPage<T>, StoreError> {
        self.root_session_page(
            CatalogScope::Profile,
            expected_revision,
            cursor.into(),
            limit,
            CatalogFilter {
                roots_only: false,
                archived_only: false,
                include_archived: true,
                pending_only: false,
            },
        )
        .await
    }

    async fn root_session_page<T: DeserializeOwned + Send + 'static>(
        &self,
        scope: CatalogScope,
        expected_revision: Option<&str>,
        position: SessionPosition<'_>,
        limit: usize,
        filter: CatalogFilter,
    ) -> Result<SessionPage<T>, StoreError> {
        let page = self
            .root_session_outcomes_page(scope, expected_revision, position, limit, filter)
            .await?;
        let sessions = page
            .sessions
            .into_iter()
            .map(|entry| entry.map_err(|unreadable| unreadable.error))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(SessionPage {
            revision: page.revision,
            sessions,
            pending_session_count: page.pending_session_count,
            next_cursor: page.next_cursor,
            previous_cursor: page.previous_cursor,
        })
    }

    async fn root_session_outcomes_page<T: DeserializeOwned + Send + 'static>(
        &self,
        scope: CatalogScope,
        expected_revision: Option<&str>,
        position: SessionPosition<'_>,
        limit: usize,
        filter: CatalogFilter,
    ) -> Result<SessionOutcomePage<T>, StoreError> {
        self.require_open()?;
        EventLog::catalog_selection_valid(&scope, filter)?;
        if limit == 0 || i64::try_from(limit).is_err() {
            return Err(invalid("invalid session page size"));
        }
        match position {
            SessionPosition::Start => {}
            SessionPosition::At(id) | SessionPosition::After(id) | SessionPosition::Before(id) => {
                crate::sessions::validate_id(id)?
            }
        }
        if matches!(
            position,
            SessionPosition::After(_) | SessionPosition::Before(_)
        ) && expected_revision.is_none()
        {
            return Err(invalid("session continuation requires catalog revision"));
        }
        let anchor = match position {
            SessionPosition::Start => None,
            SessionPosition::At(id) => Some((0, id.to_owned())),
            SessionPosition::After(id) => Some((1, id.to_owned())),
            SessionPosition::Before(id) => Some((2, id.to_owned())),
        };
        let expected = expected_revision.map(str::to_owned);
        let mut selection = crate::sessions::CatalogQuery::new(&scope, filter)?;
        selection.published_only = true;
        self.log
            .connection
            .read(move |db| {
                let tx = rusqlite::Transaction::new_unchecked(
                    db,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                let revision: i64 = tx.query_row(
                    "SELECT revision FROM session_catalog_revision WHERE singleton=1",
                    rusqlite::params![],
                    |row| row.get(0),
                )?;
                let revision = CatalogRevision { revision }.revision(&scope, filter)?;
                if let Some(expected) = expected
                    && expected != revision
                {
                    return Err(StoreError::RevisionConflict {
                        expected,
                        actual: revision,
                    });
                }
                let position = if let Some((kind, id)) = anchor {
                    if session_visible(&tx, &id)? {
                        match CatalogKey::read(&tx, &id)? {
                            Some(key) => match kind {
                                0 => CatalogPosition::At(key),
                                1 => CatalogPosition::After(key),
                                _ => CatalogPosition::Before(key),
                            },
                            None => CatalogPosition::Start,
                        }
                    } else {
                        CatalogPosition::Start
                    }
                } else {
                    CatalogPosition::Start
                };
                let mut candidates = selection.ids(&tx, &position, limit)?;
                if candidates.is_empty()
                    && let CatalogPosition::At(key) = &position
                {
                    candidates =
                        selection.ids(&tx, &CatalogPosition::Before(key.clone()), limit)?;
                }

                let previous_cursor = if let Some(key) = candidates.first() {
                    (!selection
                        .ids(&tx, &CatalogPosition::Before(key.clone()), 1)?
                        .is_empty())
                    .then(|| key.id.clone())
                } else {
                    None
                };
                let next_cursor = if let Some(key) = candidates.last() {
                    (!selection
                        .ids(&tx, &CatalogPosition::After(key.clone()), 1)?
                        .is_empty())
                    .then(|| key.id.clone())
                } else {
                    None
                };
                let mut sessions = Vec::with_capacity(candidates.len());
                for key in candidates {
                    match crate::sessions::read(&tx, &key.id) {
                        Ok(Some(record)) => sessions.push(Ok(record)),
                        Ok(None) => return Err(StoreError::SessionNotFound),
                        Err(error)
                            if matches!(
                                error,
                                StoreError::Json(_)
                                    | StoreError::InvalidTransition(_)
                                    | StoreError::Projection(_)
                            ) =>
                        {
                            sessions.push(Err(crate::sessions::UnreadableSession {
                                id: key.id,
                                error,
                            }))
                        }
                        Err(error) => return Err(error),
                    }
                }
                let pending_session_count = selection.pending_count(&tx)?;
                tx.rollback()?;
                Ok(SessionOutcomePage {
                    revision,
                    sessions,
                    pending_session_count,
                    next_cursor,
                    previous_cursor,
                })
            })
            .await
    }

    pub async fn get_session<T: DeserializeOwned + Send + 'static>(
        &self,
        id: &str,
    ) -> Result<Option<SessionRecord<T>>, StoreError> {
        self.require_open()?;
        crate::sessions::validate_id(id)?;
        Ok(self
            .log
            .root_catalog_records(vec![id.to_owned()], None)
            .await?
            .pop())
    }

    pub async fn session_is_available(&self, id: &str) -> Result<bool, StoreError> {
        self.require_open()?;
        crate::sessions::validate_id(id)?;
        let id = id.to_owned();
        self.log
            .connection
            .read(move |db| session_visible(db, &id))
            .await
    }
}

impl RootStore {
    pub async fn session_projection<T: DeserializeOwned + Send + 'static>(
        &self,
        id: &str,
    ) -> Result<Option<crate::observation::SessionProjection<T>>, StoreError> {
        self.require_open()?;
        crate::sessions::validate_id(id)?;
        self.log.root_session_projection(id).await
    }
    pub async fn observe_session<T: DeserializeOwned + Send + 'static>(
        &self,
        id: &str,
    ) -> Result<Option<crate::observation::SessionObservation<T>>, StoreError> {
        self.require_open()?;
        crate::sessions::validate_id(id)?;
        self.log.root_observe_session(id).await
    }

    /// String references still owned by accepted messages or parked activations.
    pub async fn accepted_execution_references(
        &self,
        owner: &str,
        field: &str,
    ) -> Result<std::collections::BTreeSet<String>, StoreError> {
        self.require_open()?;
        self.log.validate_root()?;
        crate::sessions::validate_id(owner)?;
        let message_path = format!(
            "$.execution.basis.{}",
            serde_json::to_string(field).map_err(|error| invalid(&error.to_string()))?
        );
        let checkpoint_path = format!(
            "$.nativeBasis.{}",
            serde_json::to_string(field).map_err(|error| invalid(&error.to_string()))?
        );
        let owner = owner.to_owned();
        self.log.connection.read(move |db| {
            let rows: Vec<Option<String>> = db.prepare_cached("SELECT json_extract(a.record_json,?2) FROM message_admissions a
                 JOIN session_creations r ON r.session_id=a.session_id
                 WHERE r.ready=1 AND r.visible=1 AND json_extract(a.record_json,'$.execution.owner')=?1
                 AND NOT EXISTS(SELECT 1 FROM session_retirements d WHERE d.session_id=a.session_id AND d.remove_session=1)
                 UNION ALL SELECT json_extract(c.checkpoint_json,?3) FROM native_approval_checkpoints c
                 JOIN session_creations r ON r.session_id=c.session_id
                 WHERE r.ready=1 AND r.visible=1 AND c.active=1 AND substr(c.session_id,1,length(?1))=?1
                 AND NOT EXISTS(SELECT 1 FROM session_retirements d WHERE d.session_id=c.session_id AND d.remove_session=1)")?.query_map(rusqlite::params![owner.to_owned(), message_path, checkpoint_path], |row| row.get(0))?.collect::<Result<Vec<_>, _>>()?;
            Ok(rows.into_iter().flatten().collect())
        }).await
    }

    pub async fn pending_message_sessions(
        &self,
        owner: &str,
        after: Option<&str>,
    ) -> Result<Vec<String>, StoreError> {
        self.require_open()?;
        self.log.validate_root()?;
        crate::sessions::validate_id(owner)?;
        if let Some(after) = after {
            crate::sessions::validate_id(after)?;
        }
        let owner = owner.to_owned();
        let after = after.map(str::to_owned);
        self.log.connection.read(move |db| {
            Ok(db.prepare_cached("SELECT DISTINCT a.session_id FROM message_admissions a
                 JOIN session_creations r ON r.session_id=a.session_id
                 WHERE r.ready=1 AND r.visible=1
                 AND (?1 IS NULL OR a.session_id>?1) AND json_extract(a.record_json,'$.execution.owner')=?2
                 AND NOT EXISTS(SELECT 1 FROM session_retirements d WHERE d.session_id=a.session_id AND d.remove_session=1)
                 ORDER BY a.session_id LIMIT 64")?.query_map(rusqlite::params![after, owner], |row| row.get(0))?.collect::<Result<Vec<_>, _>>()?)
        }).await
    }

    pub async fn imported_sessions<T: DeserializeOwned + Send + 'static>(
        &self,
        prefix: &str,
        after: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<SessionRecord<T>>, Option<String>), StoreError> {
        self.require_open()?;
        if prefix.is_empty() || limit == 0 || i64::try_from(limit).is_err() {
            return Err(invalid("invalid import history query"));
        }
        if let Some(after) = after {
            crate::sessions::validate_id(after)?;
            if !after.starts_with(prefix) {
                return Err(invalid("foreign import cursor"));
            }
        }
        let prefix = prefix.to_owned();
        let after = after.map(str::to_owned);
        self.log.connection.read(move |db| {

            let tx=rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Deferred)?;
            let anchor: Option<i64> = if let Some(id)=&after {
                if !session_visible(&tx,id)? { return Err(StoreError::SessionNotFound); }
                Some(tx.query_row("SELECT created_at FROM session_imports WHERE session_id=? AND state='published'", rusqlite::params![id], |row| row.get(0)).optional()?.ok_or(StoreError::SessionNotFound)?)
            } else { None };
            let ids: Vec<String> = tx.prepare_cached("SELECT i.session_id FROM session_imports i JOIN session_control s ON s.id=i.session_id
                 JOIN session_creations r ON r.session_id=i.session_id
                 WHERE r.ready=1 AND r.visible=1 AND instr(i.session_id,?1)=1 AND i.state='published'
                 AND (?2 IS NULL OR i.created_at<?2 OR (i.created_at=?2 AND i.session_id<?3))
                 AND NOT EXISTS(SELECT 1 FROM session_retirements d WHERE d.session_id=i.session_id AND d.remove_session=1)
                 ORDER BY i.created_at DESC,i.session_id DESC LIMIT ?4")?.query_map(rusqlite::params![prefix, anchor, after, limit.saturating_add(1) as i64], |row| row.get(0))?.collect::<Result<Vec<_>, _>>()?;
            let next = (ids.len() > limit).then(|| ids[limit - 1].clone());
            let mut records = Vec::with_capacity(ids.len().min(limit));
            for id in ids.into_iter().take(limit) {
                records.push(crate::sessions::read(&tx, &id)?.ok_or(StoreError::SessionNotFound)?);
            }
            tx.commit()?;
            Ok((records, next))
        }).await
    }
}

fn workspace_page(
    db: &SqliteConnection,
    cwd: &str,
    after: &str,
) -> Result<Vec<crate::workspace::WorkspaceSession>, StoreError> {
    let rows = db.prepare_cached("SELECT s.id,s.revision,b.metadata_epoch,json_extract(s.configuration,'$.workspace.metadataEpochAtAttach') AS attached_epoch,
             COALESCE((SELECT MAX(e.sequence) FROM runtime_events e WHERE e.event_header IS NOT NULL AND e.event_session=s.id),0) AS sequence,
             EXISTS(SELECT 1 FROM shell_runs r WHERE r.session_id=s.id AND json_extract(r.record_json,'$.state.outcome.kind')='orphaned') AS orphaned
             FROM workspace_bindings b JOIN session_control s INDEXED BY session_workspace_binding
             ON json_extract(s.configuration,'$.workspace.id')=b.id
             JOIN session_creations route ON route.session_id=s.id
             WHERE json_extract(b.workspace_json,'$.path')=?1 AND s.id>?2
               AND route.ready=1 AND route.visible=1
               AND NOT EXISTS(SELECT 1 FROM session_retirements d WHERE d.session_id=s.id AND d.remove_session=1)
             ORDER BY s.id LIMIT 32")?.query_map(rusqlite::params![cwd, after], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?, row.get::<_, i64>(4)?, row.get::<_, bool>(5)?)))?.collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(id, local, current, attached, sequence, orphaned)| {
            let revision = current
                .checked_sub(attached)
                .filter(|delta| *delta >= 0)
                .and_then(|delta| local.checked_add(delta))
                .filter(|revision| {
                    (0..=maka_agent_facts::interaction::MAX_SAFE_INTEGER as i64).contains(revision)
                })
                .ok_or_else(|| invalid("invalid effective workspace Session revision"))?;
            Ok(crate::workspace::WorkspaceSession {
                session_id: id,
                revision,
                event_sequence: sequence,
                orphaned_shells: orphaned,
            })
        })
        .collect()
}

impl RootStore {
    pub async fn workspace_fence(
        &self,
        cwd: &str,
    ) -> Result<crate::workspace::WorkspaceFence, StoreError> {
        self.require_open()?;
        let cwd = cwd.to_owned();
        self.log
            .connection
            .read(move |db| {
                let tx = rusqlite::Transaction::new_unchecked(
                    db,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                let mut rows = Vec::new();
                let mut after = String::new();
                loop {
                    let page = workspace_page(&tx, &cwd, &after)?;
                    let complete = page.len() < MAX_SESSION_PAGE;
                    if let Some(last) = page.last() {
                        after.clone_from(&last.session_id);
                    }
                    rows.extend(page);
                    if complete {
                        break;
                    }
                }
                tx.commit()?;
                Ok(crate::workspace::WorkspaceFence(rows))
            })
            .await
    }

    pub async fn workspace_has_other_session(
        &self,
        cwd: &str,
        session: &str,
    ) -> Result<bool, StoreError> {
        crate::sessions::validate_id(session)?;
        let scope = CatalogScope::Workspace(cwd.into());
        let filter = CatalogFilter {
            roots_only: false,
            archived_only: false,
            include_archived: true,
            pending_only: false,
        };
        self.require_open()?;
        let mut selection = crate::sessions::CatalogQuery::new(&scope, filter)?;
        selection.published_only = true;
        let session = session.to_owned();
        self.log
            .connection
            .read(move |db| {
                {
                    // At most one candidate can be the excluded Session.
                    Ok(selection
                        .ids(db, &CatalogPosition::Start, 2)?
                        .iter()
                        .any(|key| key.id != session))
                }
            })
            .await
    }
}

#[cfg(test)]
mod tests;
