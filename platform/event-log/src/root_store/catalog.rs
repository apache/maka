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
use rusqlite::Connection as SqliteConnection;
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
                                StoreError::Json(_) | StoreError::InvalidTransition(_)
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
                tx.rollback()?;
                Ok(SessionOutcomePage {
                    revision,
                    sessions,
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
