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

struct Selection {
    root_partition: Option<usize>,
    session: Option<String>,
    cwd: Option<String>,
    prefix: Option<String>,
    project: Option<String>,
    workspace_identity: Option<String>,
    title_query: String,
    filter: CatalogFilter,
}
impl Selection {
    fn new(scope: &CatalogScope, filter: CatalogFilter) -> Result<Self, StoreError> {
        let mut selection = Self {
            root_partition: None,
            session: None,
            cwd: None,
            prefix: None,
            project: None,
            workspace_identity: None,
            title_query: String::new(),
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

    async fn ids(
        &self,
        connection: &mut SqliteConnection,
        position: SessionPosition<'_>,
        limit: usize,
    ) -> Result<Vec<String>, StoreError> {
        // SQL fragments are closed native state. Every caller value is bound.
        let (comparison, order, cursor) = match position {
            SessionPosition::Start => (">", "ASC", ""),
            SessionPosition::At(cursor) => (">=", "ASC", cursor),
            SessionPosition::After(cursor) => (">", "ASC", cursor),
            SessionPosition::Before(cursor) => ("<", "DESC", cursor),
        };
        let visibility = if self.root_partition.is_some() {
            "AND EXISTS (SELECT 1 FROM root_control.session_routes r WHERE r.session_id=session_control.id AND r.partition=?11 AND r.ready=1 AND r.visible=1)"
        } else {
            ""
        };
        let sql = format!(
            "SELECT id FROM session_control WHERE {PREDICATE} {visibility}
            AND id {comparison} ?9 ORDER BY id {order} LIMIT ?10"
        );
        let query = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(sql))
            .bind(if self.filter.archived_only {
                2
            } else {
                i32::from(!self.filter.include_archived)
            })
            .bind(&self.session)
            .bind(&self.cwd)
            .bind(&self.prefix)
            .bind(self.filter.pending_only)
            .bind(&self.project)
            .bind(&self.workspace_identity)
            .bind(&self.title_query)
            .bind(cursor)
            .bind(limit as i64);
        let query = if let Some(partition) = self.root_partition {
            query.bind(partition as i64)
        } else {
            query
        };
        let mut ids = query.fetch_all(connection).await?;
        if matches!(position, SessionPosition::Before(_)) {
            ids.reverse();
        }
        Ok(ids)
    }

    async fn pending_count(&self, connection: &mut SqliteConnection) -> Result<u64, StoreError> {
        let visibility = if self.root_partition.is_some() {
            "AND EXISTS (SELECT 1 FROM root_control.session_routes r WHERE r.session_id=session_control.id AND r.partition=?9 AND r.ready=1 AND r.visible=1)"
        } else {
            ""
        };
        let sql = format!("SELECT COUNT(*) FROM session_control WHERE {PREDICATE} {visibility}");
        let query = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql))
            .bind(if self.filter.archived_only {
                2
            } else {
                i32::from(!self.filter.include_archived)
            })
            .bind(&self.session)
            .bind(&self.cwd)
            .bind(&self.prefix)
            .bind(true)
            .bind(&self.project)
            .bind(&self.workspace_identity)
            .bind(&self.title_query);
        let query = if let Some(partition) = self.root_partition {
            query.bind(partition as i64)
        } else {
            query
        };
        let count = query.fetch_one(connection).await?;
        u64::try_from(count).map_err(|_| invalid("invalid pending session count"))
    }
}

async fn revision(
    connection: &mut SqliteConnection,
    scope: &CatalogScope,
    filter: CatalogFilter,
) -> Result<String, StoreError> {
    let counter: i64 =
        sqlx::query_scalar("SELECT revision FROM session_catalog_revision WHERE singleton = 1")
            .fetch_one(connection)
            .await?;
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
        self.validate_root()?;
        Selection::new(&scope, filter)?;
        self.connection
            .run(move |connection| {
                Box::pin(async move { revision(connection, &scope, filter).await })
            })
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
        self.validate_root()?;
        if limit == 0 || limit > MAX_SESSION_PAGE {
            return Err(invalid("session page limit must be 1..=32"));
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
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    let revision = revision(&mut tx, &scope, filter).await?;
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
                    let mut ids = selection.ids(&mut tx, position, limit).await?;
                    if ids.is_empty()
                        && let SessionPosition::At(cursor) = position
                    {
                        ids = selection
                            .ids(&mut tx, SessionPosition::Before(cursor), limit)
                            .await?;
                    }
                    let previous_cursor = if let Some(first) = ids.first()
                        && !selection
                            .ids(&mut tx, SessionPosition::Before(first), 1)
                            .await?
                            .is_empty()
                    {
                        Some(first.clone())
                    } else {
                        None
                    };
                    let next_cursor = if let Some(last) = ids.last()
                        && !selection
                            .ids(&mut tx, SessionPosition::After(last), 1)
                            .await?
                            .is_empty()
                    {
                        Some(last.clone())
                    } else {
                        None
                    };
                    let pending_session_count = selection.pending_count(&mut tx).await?;
                    let mut sessions = Vec::with_capacity(ids.len());
                    for id in ids {
                        sessions.push(
                            read(&mut tx, &id)
                                .await?
                                .ok_or(StoreError::SessionNotFound)?,
                        );
                    }
                    Ok(SessionPage {
                        revision,
                        sessions,
                        pending_session_count,
                        next_cursor,
                        previous_cursor,
                    })
                })
            })
            .await
    }
}

pub(crate) struct RootCatalogPage<'a> {
    pub position: SessionPosition<'a>,
    pub limit: usize,
    pub count_pending: bool,
}

impl EventLog {
    pub(crate) fn catalog_selection_valid(
        scope: &CatalogScope,
        filter: CatalogFilter,
    ) -> Result<(), StoreError> {
        Selection::new(scope, filter).map(|_| ())
    }

    /// Root-only primitive: IDs, not configuration bodies, cross this bounded fanout.
    pub(crate) async fn root_catalog_ids(
        &self,
        partition: usize,
        scope: CatalogScope,
        filter: CatalogFilter,
        page: RootCatalogPage<'_>,
        expected: (i64, i64),
    ) -> Result<(Vec<String>, u64), StoreError> {
        let RootCatalogPage {
            position,
            limit,
            count_pending,
        } = page;
        self.validate_root()?;
        if partition >= crate::root_store::PARTITION_COUNT
            || limit == 0
            || limit > MAX_SESSION_PAGE + 1
        {
            return Err(invalid("invalid Root catalog page"));
        }
        let (cursor, inclusive, reverse) = match position {
            SessionPosition::Start => (None, false, false),
            SessionPosition::At(id) => (Some(id.to_owned()), true, false),
            SessionPosition::After(id) => (Some(id.to_owned()), false, false),
            SessionPosition::Before(id) => (Some(id.to_owned()), false, true),
        };
        if let Some(cursor) = &cursor {
            validate_id(cursor)?;
        }
        let mut selection = Selection::new(&scope, filter)?;
        selection.root_partition = Some(partition);
        self.connection
            .read(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    crate::root_store::catalog::require_snapshot(&mut tx, expected).await?;
                    let position = match cursor.as_deref() {
                        None => SessionPosition::Start,
                        Some(id) if inclusive => SessionPosition::At(id),
                        Some(id) if reverse => SessionPosition::Before(id),
                        Some(id) => SessionPosition::After(id),
                    };
                    let ids = selection.ids(&mut tx, position, limit).await?;
                    let pending = if count_pending {
                        selection.pending_count(&mut tx).await?
                    } else {
                        0
                    };
                    Ok((ids, pending))
                })
            })
            .await
    }

    pub(crate) async fn root_catalog_records<T: DeserializeOwned + Send + 'static>(
        &self,
        partition: usize,
        ids: Vec<String>,
        expected: Option<(i64, i64)>,
    ) -> Result<Vec<SessionRecord<T>>, StoreError> {
        self.validate_root()?;
        if partition >= crate::root_store::PARTITION_COUNT || ids.len() > MAX_SESSION_PAGE {
            return Err(invalid("invalid Root catalog selection"));
        }
        self.connection
            .read(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    if let Some(expected) = expected {
                        crate::root_store::catalog::require_snapshot(&mut tx, expected).await?;
                    }
                    let mut records = Vec::with_capacity(ids.len());
                    for id in ids {
                        if crate::root_store::catalog::session_visible(&mut tx, partition, &id)
                            .await?
                        {
                            records.push(
                                read(&mut tx, &id)
                                    .await?
                                    .ok_or(StoreError::SessionNotFound)?,
                            );
                        }
                    }
                    Ok(records)
                })
            })
            .await
    }
}
