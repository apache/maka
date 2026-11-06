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
use sha2::{Digest, Sha256};

/// The indexed column is generated from canonical Session configuration.
const PIN_ORDER: &str = "catalog_unpinned";

/// Pinned first, then newest activity, with stable ID ties.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct CatalogKey {
    pub unpinned: bool,
    pub recency: i64,
    pub id: String,
}
impl CatalogKey {
    pub(crate) fn read(db: &rusqlite::Connection, id: &str) -> Result<Option<Self>, StoreError> {
        let sql = format!("SELECT {PIN_ORDER}, catalog_recency FROM session_control WHERE id = ?");
        Ok(db
            .query_row(&sql, params![id], |row| {
                Ok((row.get::<_, bool>(0)?, row.get::<_, i64>(1)?))
            })
            .optional()?
            .map(|(unpinned, recency)| Self {
                unpinned,
                recency,
                id: id.to_owned(),
            }))
    }
}

#[derive(Clone)]
pub(crate) enum CatalogPosition {
    Start,
    At(CatalogKey),
    After(CatalogKey),
    Before(CatalogKey),
}
impl CatalogPosition {
    pub fn new(position: SessionPosition<'_>, key: CatalogKey) -> Self {
        match position {
            SessionPosition::Start => Self::Start,
            SessionPosition::At(_) => Self::At(key),
            SessionPosition::After(_) => Self::After(key),
            SessionPosition::Before(_) => Self::Before(key),
        }
    }
    pub fn reverse(&self) -> bool {
        matches!(self, Self::Before(_))
    }
}

const PREDICATE: &str = "
    NOT EXISTS (SELECT 1 FROM session_retirements WHERE session_id=id AND remove_session=1)
    AND (?1 = 0 OR (?1 = 1 AND archived = 0) OR (?1 = 2 AND archived = 1))
    AND (?2 IS NULL OR id = ?2)
    AND (?3 IS NULL OR EXISTS (SELECT 1 FROM workspace_bindings binding WHERE binding.id=json_extract(configuration,'$.workspace.id') AND json_extract(binding.workspace_json,'$.path')=?3))
    AND (?4 IS NULL OR substr(id, 1, length(?4)) = ?4)
    AND (?5 = 0 OR EXISTS (
        SELECT 1 FROM interaction_pending pending
        WHERE pending.session_id = session_control.id))
    AND (?6 IS NULL OR EXISTS (SELECT 1 FROM workspace_bindings binding WHERE binding.id=json_extract(configuration,'$.workspace.id') AND json_extract(binding.workspace_json,'$.projectId')=?6))
    AND (?7 IS NULL OR EXISTS (SELECT 1 FROM workspace_bindings binding WHERE binding.id=json_extract(configuration,'$.workspace.id') AND json_extract(binding.workspace_json,'$.identity')=?7))
    AND instr(COALESCE(json_extract(configuration, '$.title'), ''), ?8) > 0";

#[derive(Clone)]
pub(crate) struct Selection {
    pub(crate) published_only: bool,
    session: Option<String>,
    cwd: Option<String>,
    prefix: Option<String>,
    project: Option<String>,
    workspace_identity: Option<String>,
    title_query: String,
    parent: Option<String>,
    filter: CatalogFilter,
}
impl Selection {
    pub(crate) fn new(scope: &CatalogScope, filter: CatalogFilter) -> Result<Self, StoreError> {
        let mut selection = Self {
            published_only: false,
            session: None,
            cwd: None,
            prefix: None,
            project: None,
            workspace_identity: None,
            title_query: String::new(),
            parent: None,
            filter,
        };
        match scope {
            CatalogScope::Session(id) => {
                validate_id(id)?;
                selection.session = Some(id.clone());
            }
            CatalogScope::Workspace(cwd) => selection.cwd = Some(cwd.clone()),
            CatalogScope::IdPrefix(prefix) => {
                validate_id(prefix)?;
                selection.prefix = Some(prefix.clone());
            }
            CatalogScope::Owned {
                id_prefix,
                selection: scope,
                title_query,
            } => {
                validate_id(id_prefix)?;
                selection.prefix = Some(id_prefix.clone());
                selection.title_query.clone_from(title_query);
                match scope {
                    CatalogSelection::All => {}
                    CatalogSelection::Children(id) => {
                        validate_id(id)?;
                        selection.parent = Some(id.clone());
                    }
                    CatalogSelection::Project(project) => {
                        selection.project = Some(project.to_string());
                    }
                    CatalogSelection::Workspace {
                        session_id,
                        identity,
                    } => {
                        validate_id(session_id)?;
                        selection.workspace_identity = Some(identity.clone().into());
                    }
                }
            }
            CatalogScope::Profile => {}
        }
        Ok(selection)
    }

    pub(crate) fn ids(
        &self,
        connection: &rusqlite::Connection,
        position: &CatalogPosition,
        limit: usize,
    ) -> Result<Vec<CatalogKey>, StoreError> {
        // SQL fragments are closed native state. Every caller value is bound.
        let (comparison, order, unpinned, recency, cursor) = match position {
            CatalogPosition::Start => (">", "ASC", false, i64::MIN, ""),
            CatalogPosition::At(key) => (">=", "ASC", key.unpinned, key.recency, key.id.as_str()),
            CatalogPosition::After(key) => (">", "ASC", key.unpinned, key.recency, key.id.as_str()),
            CatalogPosition::Before(key) => {
                ("<", "DESC", key.unpinned, key.recency, key.id.as_str())
            }
        };
        let visibility = if self.published_only {
            "AND EXISTS (SELECT 1 FROM session_creations r WHERE r.session_id=session_control.id AND ?11 AND r.ready=1 AND r.visible=1)"
        } else {
            ""
        };
        let parent = if self.parent.is_some() {
            "AND json_extract(configuration, '$.parentSessionId') = ?14"
        } else {
            ""
        };
        let roots = if self.filter.roots_only {
            "AND json_extract(configuration, '$.parentSessionId') IS NULL"
        } else {
            ""
        };
        let sql = format!(
            "SELECT {PIN_ORDER}, catalog_recency, id FROM session_control WHERE {PREDICATE} {visibility} {parent} {roots}
            AND ({PIN_ORDER}, catalog_recency, id) {comparison} (?12, ?13, ?9)
            ORDER BY {PIN_ORDER} {order}, catalog_recency {order}, id {order} LIMIT ?10"
        );
        let mut values = vec![
            rusqlite::types::Value::Integer(if self.filter.archived_only {
                2
            } else {
                i64::from(!self.filter.include_archived)
            }),
            self.session
                .clone()
                .map_or(rusqlite::types::Value::Null, Into::into),
            self.cwd
                .clone()
                .map_or(rusqlite::types::Value::Null, Into::into),
            self.prefix
                .clone()
                .map_or(rusqlite::types::Value::Null, Into::into),
            rusqlite::types::Value::Integer(i64::from(self.filter.pending_only)),
            self.project
                .clone()
                .map_or(rusqlite::types::Value::Null, Into::into),
            self.workspace_identity
                .clone()
                .map_or(rusqlite::types::Value::Null, Into::into),
            self.title_query.clone().into(),
            cursor.to_owned().into(),
            (limit as i64).into(),
            i64::from(self.published_only).into(),
            i64::from(unpinned).into(),
            recency.into(),
        ];
        if let Some(parent) = &self.parent {
            values.push(parent.clone().into());
        }
        let mut ids = connection
            .prepare_cached(&sql)?
            .query_map(rusqlite::params_from_iter(values), |row| {
                Ok(CatalogKey {
                    unpinned: row.get(0)?,
                    recency: row.get(1)?,
                    id: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if position.reverse() {
            ids.reverse();
        }
        Ok(ids)
    }

    pub(crate) fn pending_count(
        &self,
        connection: &rusqlite::Connection,
    ) -> Result<u64, StoreError> {
        let visibility = if self.published_only {
            "AND EXISTS (SELECT 1 FROM session_creations r WHERE r.session_id=session_control.id AND ?9 AND r.ready=1 AND r.visible=1)"
        } else {
            ""
        };
        let parent = if self.parent.is_some() {
            "AND json_extract(configuration, '$.parentSessionId') = ?10"
        } else {
            ""
        };
        // Attention includes children hidden by the normal root-only sidebar;
        // owner, scope, title and archive predicates still match the inbox.
        let sql =
            format!("SELECT COUNT(*) FROM session_control WHERE {PREDICATE} {visibility} {parent}");
        let mut values = vec![
            rusqlite::types::Value::Integer(if self.filter.archived_only {
                2
            } else {
                i64::from(!self.filter.include_archived)
            }),
            self.session
                .clone()
                .map_or(rusqlite::types::Value::Null, Into::into),
            self.cwd
                .clone()
                .map_or(rusqlite::types::Value::Null, Into::into),
            self.prefix
                .clone()
                .map_or(rusqlite::types::Value::Null, Into::into),
            rusqlite::types::Value::Integer(1),
            self.project
                .clone()
                .map_or(rusqlite::types::Value::Null, Into::into),
            self.workspace_identity
                .clone()
                .map_or(rusqlite::types::Value::Null, Into::into),
            self.title_query.clone().into(),
        ];
        if self.published_only || self.parent.is_some() {
            values.push(i64::from(self.published_only).into());
        }
        if let Some(parent) = &self.parent {
            values.push(parent.clone().into());
        }
        let count: i64 =
            connection.query_row(&sql, rusqlite::params_from_iter(values), |row| row.get(0))?;
        u64::try_from(count).map_err(|_| invalid("invalid pending session count"))
    }
}

fn revision(
    connection: &rusqlite::Connection,
    scope: &CatalogScope,
    filter: CatalogFilter,
) -> Result<String, StoreError> {
    let counter: i64 = connection.query_row(
        "SELECT revision FROM session_catalog_revision WHERE singleton = 1",
        params![],
        |row| row.get(0),
    )?;
    Ok(format!(
        "sha256:{}",
        hex::encode(Sha256::digest(serde_json::to_vec(&(
            "session-catalog",
            counter,
            scope,
            filter,
        ))?))
    ))
}

impl EventLog {
    /// Cheap canonical check before materializing another bounded catalog page.
    pub async fn catalog_revision(
        &self,
        scope: CatalogScope,
        filter: CatalogFilter,
    ) -> Result<String, StoreError> {
        Selection::new(&scope, filter)?;
        self.connection
            .read(move |connection| revision(connection, &scope, filter))
            .await
    }

    pub(super) async fn session_page<T: DeserializeOwned + Send + 'static>(
        &self,
        scope: CatalogScope,
        expected_revision: Option<&str>,
        position: SessionPosition<'_>,
        limit: usize,
        filter: CatalogFilter,
    ) -> Result<SessionPage<T>, StoreError> {
        if limit == 0 || i64::try_from(limit).is_err() {
            return Err(invalid("invalid session page size"));
        }
        let cursor = match position {
            SessionPosition::Start => None,
            SessionPosition::At(cursor)
            | SessionPosition::After(cursor)
            | SessionPosition::Before(cursor) => {
                validate_id(cursor)?;
                Some(cursor.to_owned())
            }
        };
        if matches!(
            position,
            SessionPosition::After(_) | SessionPosition::Before(_)
        ) && expected_revision.is_none()
        {
            return Err(invalid("session continuation requires catalog revision"));
        }
        let inclusive = matches!(position, SessionPosition::At(_));
        let reverse = matches!(position, SessionPosition::Before(_));
        let selection = Selection::new(&scope, filter)?;
        let expected_revision = expected_revision.map(str::to_owned);
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                let revision = revision(&tx, &scope, filter)?;
                if let Some(expected) = expected_revision
                    && expected != revision
                {
                    return Err(StoreError::RevisionConflict {
                        expected,
                        actual: revision,
                    });
                }
                let position = match cursor.as_deref() {
                    None => SessionPosition::Start,
                    Some(cursor) if inclusive => SessionPosition::At(cursor),
                    Some(cursor) if reverse => SessionPosition::Before(cursor),
                    Some(cursor) => SessionPosition::After(cursor),
                };
                let position = match position {
                    SessionPosition::Start => CatalogPosition::Start,
                    SessionPosition::At(id)
                    | SessionPosition::After(id)
                    | SessionPosition::Before(id) => match CatalogKey::read(&tx, id)? {
                        Some(key) => CatalogPosition::new(position, key),
                        None => CatalogPosition::Start,
                    },
                };
                let mut ids = selection.ids(&tx, &position, limit)?;
                if ids.is_empty()
                    && let CatalogPosition::At(cursor) = &position
                {
                    ids = selection.ids(&tx, &CatalogPosition::Before(cursor.clone()), limit)?;
                }
                let previous_cursor = if let Some(first) = ids.first()
                    && !selection
                        .ids(&tx, &CatalogPosition::Before(first.clone()), 1)?
                        .is_empty()
                {
                    Some(first.id.clone())
                } else {
                    None
                };
                let next_cursor = if let Some(last) = ids.last()
                    && !selection
                        .ids(&tx, &CatalogPosition::After(last.clone()), 1)?
                        .is_empty()
                {
                    Some(last.id.clone())
                } else {
                    None
                };
                let pending_session_count = selection.pending_count(&tx)?;
                let mut sessions = Vec::with_capacity(ids.len());
                for id in ids {
                    sessions.push(read(&tx, &id.id)?.ok_or(StoreError::SessionNotFound)?);
                }
                Ok(SessionPage {
                    revision,
                    sessions,
                    pending_session_count,
                    next_cursor,
                    previous_cursor,
                })
            })
            .await
    }
}

impl EventLog {
    pub(crate) fn catalog_selection_valid(
        scope: &CatalogScope,
        filter: CatalogFilter,
    ) -> Result<(), StoreError> {
        Selection::new(scope, filter).map(|_| ())
    }

    pub(crate) async fn root_catalog_record_outcomes<T: DeserializeOwned + Send + 'static>(
        &self,
        ids: Vec<String>,
        expected: Option<i64>,
    ) -> Result<Vec<Result<SessionRecord<T>, crate::sessions::UnreadableSession>>, StoreError> {
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                if let Some(expected) = expected {
                    crate::root_store::catalog::require_snapshot(&tx, expected)?;
                }
                let mut records = Vec::with_capacity(ids.len());
                for id in ids {
                    if crate::root_store::catalog::session_visible(&tx, &id)? {
                        match read(&tx, &id) {
                            Ok(Some(record)) => records.push(Ok(record)),
                            Ok(None) => return Err(StoreError::SessionNotFound),
                            Err(error)
                                if matches!(
                                    error,
                                    StoreError::Json(_)
                                        | StoreError::InvalidTransition(_)
                                        | StoreError::Projection(_)
                                ) =>
                            {
                                records.push(Err(crate::sessions::UnreadableSession { id, error }));
                            }
                            Err(error) => return Err(error),
                        }
                    }
                }
                Ok(records)
            })
            .await
    }

    pub(crate) async fn root_catalog_records<T: DeserializeOwned + Send + 'static>(
        &self,
        ids: Vec<String>,
        expected: Option<i64>,
    ) -> Result<Vec<SessionRecord<T>>, StoreError> {
        self.root_catalog_record_outcomes(ids, expected)
            .await?
            .into_iter()
            .map(|entry| entry.map_err(|unreadable| unreadable.error))
            .collect()
    }
}
