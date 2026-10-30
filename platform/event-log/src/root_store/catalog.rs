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

//! Bounded Root catalogue queries across the fixed Session partitions.
use super::{PARTITION_COUNT, RootStore};
use crate::{
    EventLog, StoreError,
    sessions::{
        CatalogFilter, CatalogKey, CatalogPosition, CatalogScope, MAX_SESSION_PAGE, SessionPage,
        SessionPosition, SessionRecord,
    },
};
use futures_util::future::try_join_all;
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use sqlx::SqliteConnection;

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}

/// A route and its metadata are inspected through the same read-only control
/// attachment and data snapshot. A durable but unpublished creation is hidden.
pub(crate) async fn session_visible(
    db: &mut SqliteConnection,
    partition: usize,
    id: &str,
) -> Result<bool, StoreError> {
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session_control s JOIN root_control.session_routes r ON r.session_id=s.id
        WHERE s.id=?1 AND r.partition=?2 AND r.ready=1 AND r.visible=1
        AND NOT EXISTS(SELECT 1 FROM session_retirements d WHERE d.session_id=s.id AND d.remove_session=1))")
        .bind(id).bind(partition as i64).fetch_one(db).await?)
}

pub(crate) async fn require_snapshot(
    db: &mut SqliteConnection,
    expected: (i64, i64),
) -> Result<(), StoreError> {
    let actual:(i64,i64)=sqlx::query_as("SELECT d.revision,c.revision FROM main.session_catalog_revision d CROSS JOIN root_control.session_catalog_revision c WHERE d.singleton=1 AND c.singleton=1")
        .fetch_one(db).await?;
    if actual != expected {
        return Err(StoreError::RevisionConflict {
            expected: format!("{}:{}", expected.0, expected.1),
            actual: format!("{}:{}", actual.0, actual.1),
        });
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
struct CatalogVector {
    control: i64,
    partitions: [i64; PARTITION_COUNT],
}
impl CatalogVector {
    fn revision(&self, scope: &CatalogScope, filter: CatalogFilter) -> Result<String, StoreError> {
        // Keep the actual bounded vector in the opaque wire token. The query
        // digest prevents a cursor from broadening owner/selection/filter scope.
        let query = hex::encode(Sha256::digest(serde_json::to_vec(&(scope, filter))?));
        Ok(format!(
            "root-catalog-v1:{}:{}",
            query,
            hex::encode(serde_json::to_vec(self)?)
        ))
    }
    fn partition(&self, index: usize) -> (i64, i64) {
        (self.partitions[index], self.control)
    }
}

async fn counter(log: &EventLog) -> Result<i64, StoreError> {
    log.validate_root()?;
    log.connection
        .read(|db| {
            Box::pin(async move {
                let counter: i64 = sqlx::query_scalar(
                    "SELECT revision FROM session_catalog_revision WHERE singleton=1",
                )
                .fetch_one(db)
                .await?;
                if counter < 0 {
                    return Err(invalid("invalid catalog revision"));
                }
                Ok(counter)
            })
        })
        .await
}

impl RootStore {
    async fn catalog_vector(&self) -> Result<CatalogVector, StoreError> {
        self.require_open()?;
        let counters = try_join_all(
            std::iter::once(self.control.as_ref())
                .chain(self.partitions.iter().map(|part| part.as_ref()))
                .map(counter),
        )
        .await?;
        let partitions: [i64; PARTITION_COUNT] = counters[1..]
            .try_into()
            .map_err(|_| invalid("invalid Root partition count"))?;
        Ok(CatalogVector {
            control: counters[0],
            partitions,
        })
    }

    pub async fn catalog_revision(
        &self,
        scope: CatalogScope,
        filter: CatalogFilter,
    ) -> Result<String, StoreError> {
        EventLog::catalog_selection_valid(&scope, filter)?;
        self.catalog_vector().await?.revision(&scope, filter)
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
        self.require_open()?;
        EventLog::catalog_selection_valid(&scope, filter)?;
        if limit == 0 || limit > MAX_SESSION_PAGE {
            return Err(invalid("session page limit must be 1..=32"));
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
        let vector = self.catalog_vector().await?;
        let revision = vector.revision(&scope, filter)?;
        if let Some(expected) = expected_revision
            && expected != revision
        {
            return Err(StoreError::RevisionConflict {
                expected: expected.into(),
                actual: revision,
            });
        }
        let position = match position {
            SessionPosition::Start => CatalogPosition::Start,
            SessionPosition::At(id) | SessionPosition::After(id) | SessionPosition::Before(id) => {
                let key = match self.published_partition(id).await? {
                    Some(index) => self.partitions[index].catalog_key(id).await?,
                    None => CatalogKey {
                        unpinned: true,
                        id: id.to_owned(),
                    },
                };
                CatalogPosition::new(position, key)
            }
        };
        let page = self
            .session_page_at::<T>(&scope, filter, position, limit, vector, revision.clone())
            .await;
        let current = self.catalog_vector().await?;
        if current != vector {
            return Err(StoreError::RevisionConflict {
                expected: revision,
                actual: current.revision(&scope, filter)?,
            });
        }
        page
    }

    async fn catalog_candidates(
        &self,
        scope: &CatalogScope,
        filter: CatalogFilter,
        position: CatalogPosition,
        limit: usize,
        vector: CatalogVector,
        count_pending: bool,
    ) -> Result<(Vec<(CatalogKey, usize)>, u64), StoreError> {
        let selection = crate::sessions::CatalogQuery::new(scope, filter)?;
        let pages = try_join_all(self.partitions.iter().enumerate().map(|(index, log)| {
            log.root_catalog_ids(
                index,
                selection.clone(),
                position.clone(),
                limit,
                vector.partition(index),
                count_pending,
            )
        }))
        .await?;
        let mut candidates = Vec::with_capacity(PARTITION_COUNT * limit);
        let mut pending = 0u64;
        for (index, (ids, count)) in pages.into_iter().enumerate() {
            pending = pending
                .checked_add(count)
                .ok_or_else(|| invalid("pending Session count exhausted"))?;
            candidates.extend(ids.into_iter().map(|id| (id, index)));
        }
        candidates.sort_unstable_by(|left, right| left.0.cmp(&right.0));
        Ok((candidates, pending))
    }

    async fn session_page_at<T: DeserializeOwned + Send + 'static>(
        &self,
        scope: &CatalogScope,
        filter: CatalogFilter,
        position: CatalogPosition,
        limit: usize,
        vector: CatalogVector,
        revision: String,
    ) -> Result<SessionPage<T>, StoreError> {
        let (mut candidates, pending_session_count) = self
            .catalog_candidates(scope, filter, position.clone(), limit, vector, true)
            .await?;
        let mut reverse = position.reverse();
        if candidates.is_empty()
            && let CatalogPosition::At(id) = &position
        {
            candidates = self
                .catalog_candidates(
                    scope,
                    filter,
                    CatalogPosition::Before(id.clone()),
                    limit,
                    vector,
                    false,
                )
                .await?
                .0;
            reverse = true;
        }
        if reverse {
            let keep_from = candidates.len().saturating_sub(limit);
            candidates.drain(..keep_from);
        } else {
            candidates.truncate(limit);
        }
        let previous_cursor = if let Some((first, _)) = candidates.first() {
            let previous = self
                .catalog_candidates(
                    scope,
                    filter,
                    CatalogPosition::Before(first.clone()),
                    1,
                    vector,
                    false,
                )
                .await?
                .0;
            (!previous.is_empty()).then(|| first.id.clone())
        } else {
            None
        };
        let next_cursor = if let Some((last, _)) = candidates.last() {
            let next = self
                .catalog_candidates(
                    scope,
                    filter,
                    CatalogPosition::After(last.clone()),
                    1,
                    vector,
                    false,
                )
                .await?
                .0;
            (!next.is_empty()).then(|| last.id.clone())
        } else {
            None
        };
        let mut selected: [Vec<String>; PARTITION_COUNT] = std::array::from_fn(|_| Vec::new());
        let ordered_ids: Vec<_> = candidates.iter().map(|(key, _)| key.id.clone()).collect();
        for (key, index) in candidates {
            selected[index].push(key.id);
        }
        let pages = try_join_all(
            self.partitions
                .iter()
                .enumerate()
                .filter(|(index, _)| !selected[*index].is_empty())
                .map(|(index, log)| {
                    log.root_catalog_records::<T>(
                        index,
                        selected[index].clone(),
                        Some(vector.partition(index)),
                    )
                }),
        )
        .await?;
        let mut records: std::collections::BTreeMap<_, _> = pages
            .into_iter()
            .flatten()
            .map(|session| (session.id.clone(), session))
            .collect();
        let sessions = ordered_ids
            .into_iter()
            .map(|id| records.remove(&id).ok_or(StoreError::SessionNotFound))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(SessionPage {
            revision,
            sessions,
            pending_session_count,
            next_cursor,
            previous_cursor,
        })
    }

    async fn published_partition(&self, id: &str) -> Result<Option<usize>, StoreError> {
        self.require_open()?;
        self.control.validate_root()?;
        crate::sessions::validate_id(id)?;
        let id = id.to_owned();
        let partition:Option<i64>=self.control.connection.read(move |db|Box::pin(async move {
            Ok(sqlx::query_scalar("SELECT partition FROM session_routes WHERE session_id=? AND ready=1 AND visible=1").bind(id).fetch_optional(db).await?)
        })).await?;
        partition
            .map(|index| {
                usize::try_from(index)
                    .ok()
                    .filter(|index| *index < PARTITION_COUNT)
                    .ok_or_else(|| invalid("invalid Session route"))
            })
            .transpose()
    }

    pub async fn get_session<T: DeserializeOwned + Send + 'static>(
        &self,
        id: &str,
    ) -> Result<Option<SessionRecord<T>>, StoreError> {
        let Some(index) = self.published_partition(id).await? else {
            return Ok(None);
        };
        Ok(self.partitions[index]
            .root_catalog_records(index, vec![id.to_owned()], None)
            .await?
            .pop())
    }

    pub async fn session_is_available(&self, id: &str) -> Result<bool, StoreError> {
        let Some(index) = self.published_partition(id).await? else {
            return Ok(false);
        };
        let id = id.to_owned();
        self.partitions[index]
            .connection
            .read(move |db| Box::pin(async move { session_visible(db, index, &id).await }))
            .await
    }
}

impl RootStore {
    pub async fn session_projection<T: DeserializeOwned + Send + 'static>(
        &self,
        id: &str,
    ) -> Result<Option<crate::observation::SessionProjection<T>>, StoreError> {
        let Some(index) = self.published_partition(id).await? else {
            return Ok(None);
        };
        self.partitions[index]
            .root_session_projection(id, index)
            .await
    }
    pub async fn observe_session<T: DeserializeOwned + Send + 'static>(
        &self,
        id: &str,
    ) -> Result<Option<crate::observation::SessionObservation<T>>, StoreError> {
        let Some(index) = self.published_partition(id).await? else {
            return Ok(None);
        };
        self.partitions[index].root_observe_session(id, index).await
    }

    /// String references still owned by accepted messages or parked activations.
    pub async fn accepted_execution_references(
        &self,
        owner: &str,
        field: &str,
    ) -> Result<std::collections::BTreeSet<String>, StoreError> {
        self.require_open()?;
        self.control.validate_root()?;
        crate::sessions::validate_id(owner)?;
        let message_path = format!(
            "$.execution.basis.{}",
            serde_json::to_string(field).map_err(|error| invalid(&error.to_string()))?
        );
        let checkpoint_path = format!(
            "$.nativeBasis.{}",
            serde_json::to_string(field).map_err(|error| invalid(&error.to_string()))?
        );
        let pages = try_join_all(self.partitions.iter().enumerate().map(|(index, part)| {
            let owner = owner.to_owned();
            let message_path = message_path.clone();
            let checkpoint_path = checkpoint_path.clone();
            part.connection.read(move |db| Box::pin(async move {
                Ok(sqlx::query_scalar::<_, Option<String>>(
                    "SELECT json_extract(a.record_json,?3) FROM message_admissions a
                     JOIN root_control.session_routes r ON r.session_id=a.session_id
                     WHERE r.partition=?2 AND r.ready=1 AND r.visible=1
                     AND json_extract(a.record_json,'$.execution.owner')=?1
                     AND NOT EXISTS(SELECT 1 FROM session_retirements d WHERE d.session_id=a.session_id AND d.remove_session=1)
                     UNION ALL
                     SELECT json_extract(c.checkpoint_json,?4) FROM native_approval_checkpoints c
                     JOIN root_control.session_routes r ON r.session_id=c.session_id
                     WHERE r.partition=?2 AND r.ready=1 AND r.visible=1 AND c.active=1
                     AND substr(c.session_id,1,length(?1))=?1
                     AND NOT EXISTS(SELECT 1 FROM session_retirements d WHERE d.session_id=c.session_id AND d.remove_session=1)"
                ).bind(owner).bind(index as i64).bind(message_path).bind(checkpoint_path).fetch_all(db).await?)
            }))
        })).await?;
        Ok(pages.into_iter().flatten().flatten().collect())
    }

    pub async fn pending_message_sessions(
        &self,
        owner: &str,
        after: Option<&str>,
    ) -> Result<Vec<String>, StoreError> {
        self.require_open()?;
        self.control.validate_root()?;
        crate::sessions::validate_id(owner)?;
        if let Some(after) = after {
            crate::sessions::validate_id(after)?;
        }
        let pages=try_join_all(self.partitions.iter().enumerate().map(|(index,part)| {
            let owner=owner.to_owned(); let after=after.map(str::to_owned);
            part.connection.read(move |db|Box::pin(async move {
                Ok(sqlx::query_scalar::<_,String>("SELECT DISTINCT a.session_id FROM message_admissions a
                 JOIN root_control.session_routes r ON r.session_id=a.session_id
                 WHERE r.partition=?3 AND r.ready=1 AND r.visible=1
                 AND (?1 IS NULL OR a.session_id>?1) AND json_extract(a.record_json,'$.execution.owner')=?2
                 AND NOT EXISTS(SELECT 1 FROM session_retirements d WHERE d.session_id=a.session_id AND d.remove_session=1)
                 ORDER BY a.session_id LIMIT 64")
                    .bind(after).bind(owner).bind(index as i64).fetch_all(db).await?)
            }))
        })).await?;
        let mut ids: Vec<_> = pages.into_iter().flatten().collect();
        ids.sort_unstable();
        ids.truncate(64);
        Ok(ids)
    }

    pub async fn imported_sessions<T: DeserializeOwned + Send + 'static>(
        &self,
        prefix: &str,
        after: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<SessionRecord<T>>, Option<String>), StoreError> {
        self.require_open()?;
        if prefix.is_empty() || !(1..=16).contains(&limit) {
            return Err(invalid("invalid import history query"));
        }
        if let Some(after) = after {
            crate::sessions::validate_id(after)?;
            if !after.starts_with(prefix) {
                return Err(invalid("foreign import cursor"));
            }
        }
        let vector = self.catalog_vector().await?;
        let result = self
            .imported_sessions_at(prefix, after, limit, vector)
            .await;
        let current = self.catalog_vector().await?;
        if current != vector {
            let scope = CatalogScope::IdPrefix(prefix.into());
            let filter = CatalogFilter {
                archived_only: false,
                include_archived: true,
                pending_only: false,
            };
            return Err(StoreError::RevisionConflict {
                expected: vector.revision(&scope, filter)?,
                actual: current.revision(&scope, filter)?,
            });
        }
        result
    }

    async fn imported_sessions_at<T: DeserializeOwned + Send + 'static>(
        &self,
        prefix: &str,
        after: Option<&str>,
        limit: usize,
        vector: CatalogVector,
    ) -> Result<(Vec<SessionRecord<T>>, Option<String>), StoreError> {
        let anchor = if let Some(after) = after {
            let index = self
                .published_partition(after)
                .await?
                .ok_or(StoreError::SessionNotFound)?;
            let after = after.to_owned();
            let expected = vector.partition(index);
            Some(self.partitions[index].connection.read(move |db|Box::pin(async move {
                use sqlx::Connection;
                let mut tx=db.begin().await?; require_snapshot(&mut tx,expected).await?;
                if !session_visible(&mut tx,index,&after).await? {return Err(StoreError::SessionNotFound);}
                sqlx::query_scalar::<_,i64>("SELECT created_at FROM session_imports WHERE session_id=? AND state='published'").bind(after).fetch_optional(&mut *tx).await?.ok_or(StoreError::SessionNotFound)
            })).await?)
        } else {
            None
        };
        let pages=try_join_all(self.partitions.iter().enumerate().map(|(index,part)| {
            let prefix=prefix.to_owned(); let after=after.map(str::to_owned); let expected=vector.partition(index);
            part.connection.read(move |db|Box::pin(async move {
                use sqlx::Connection;
                let mut tx=db.begin().await?; require_snapshot(&mut tx,expected).await?;
                Ok(sqlx::query_as::<_,(i64,String)>("SELECT i.created_at,i.session_id FROM session_imports i JOIN session_control s ON s.id=i.session_id
                 JOIN root_control.session_routes r ON r.session_id=i.session_id
                 WHERE r.partition=?5 AND r.ready=1 AND r.visible=1 AND instr(i.session_id,?1)=1 AND i.state='published'
                 AND (?2 IS NULL OR i.created_at<?2 OR (i.created_at=?2 AND i.session_id<?3))
                 AND NOT EXISTS(SELECT 1 FROM session_retirements d WHERE d.session_id=i.session_id AND d.remove_session=1)
                 ORDER BY i.created_at DESC,i.session_id DESC LIMIT ?4")
                    .bind(prefix).bind(anchor).bind(after).bind((limit+1) as i64).bind(index as i64).fetch_all(&mut *tx).await?)
            }))
        })).await?;
        let mut candidates: Vec<_> = pages
            .into_iter()
            .enumerate()
            .flat_map(|(index, rows)| rows.into_iter().map(move |(time, id)| (time, id, index)))
            .collect();
        candidates.sort_unstable_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
        let next = (candidates.len() > limit).then(|| candidates[limit - 1].1.clone());
        candidates.truncate(limit);
        let mut selected: [Vec<String>; PARTITION_COUNT] = std::array::from_fn(|_| Vec::new());
        for (_, id, index) in &candidates {
            selected[*index].push(id.clone());
        }
        let pages = try_join_all(
            self.partitions
                .iter()
                .enumerate()
                .filter(|(index, _)| !selected[*index].is_empty())
                .map(|(index, part)| {
                    part.root_catalog_records::<T>(
                        index,
                        selected[index].clone(),
                        Some(vector.partition(index)),
                    )
                }),
        )
        .await?;
        let mut records: std::collections::BTreeMap<_, _> = pages
            .into_iter()
            .flatten()
            .map(|record| (record.id.clone(), record))
            .collect();
        let result = candidates
            .into_iter()
            .map(|(_, id, _)| records.remove(&id).ok_or(StoreError::SessionNotFound))
            .collect::<Result<_, _>>()?;
        Ok((result, next))
    }
}

async fn workspace_page(
    log: &EventLog,
    partition: usize,
    cwd: &str,
    after: &str,
    expected: (i64, i64),
) -> Result<Vec<crate::workspace::WorkspaceSession>, StoreError> {
    let cwd = cwd.to_owned();
    let after = after.to_owned();
    log.connection.read(move |db|Box::pin(async move {
        use sqlx::{Connection,Row};
        let mut tx=db.begin().await?; require_snapshot(&mut tx,expected).await?;
        let rows=sqlx::query("SELECT s.id,s.revision,b.metadata_epoch,json_extract(s.configuration,'$.workspace.metadataEpochAtAttach') AS attached_epoch,
             COALESCE((SELECT MAX(e.sequence) FROM runtime_events e WHERE e.event_json IS NOT NULL AND e.event_session=s.id),0) AS sequence,
             EXISTS(SELECT 1 FROM shell_runs r WHERE r.session_id=s.id AND json_extract(r.record_json,'$.state.outcome.kind')='orphaned') AS orphaned
             FROM workspace_bindings b JOIN session_control s INDEXED BY session_workspace_binding
             ON json_extract(s.configuration,'$.workspace.id')=b.id
             JOIN root_control.session_routes route ON route.session_id=s.id
             WHERE json_extract(b.workspace_json,'$.path')=?1 AND s.id>?2
               AND route.partition=?3 AND route.ready=1 AND route.visible=1
               AND NOT EXISTS(SELECT 1 FROM session_retirements d WHERE d.session_id=s.id AND d.remove_session=1)
             ORDER BY s.id LIMIT 32")
            .bind(cwd).bind(after).bind(partition as i64).fetch_all(&mut *tx).await?;
        rows.into_iter().map(|row| {
            let local:i64=row.try_get("revision")?; let current:i64=row.try_get("metadata_epoch")?; let attached:i64=row.try_get("attached_epoch")?;
            let revision=current.checked_sub(attached).filter(|delta|*delta>=0).and_then(|delta|local.checked_add(delta))
                .filter(|revision|(0..=maka_agent_facts::interaction::MAX_SAFE_INTEGER as i64).contains(revision))
                .ok_or_else(||invalid("invalid effective workspace Session revision"))?;
            Ok(crate::workspace::WorkspaceSession {session_id:row.try_get("id")?,revision,event_sequence:row.try_get("sequence")?,orphaned_shells:row.try_get("orphaned")?})
        }).collect()
    })).await
}

impl RootStore {
    pub async fn workspace_fence(
        &self,
        cwd: &str,
    ) -> Result<crate::workspace::WorkspaceFence, StoreError> {
        let vector = self.catalog_vector().await?;
        let pages = try_join_all(self.partitions.iter().enumerate().map(
            |(index, part)| async move {
                let mut rows = Vec::new();
                let mut after = String::new();
                loop {
                    let page =
                        workspace_page(part, index, cwd, &after, vector.partition(index)).await?;
                    let complete = page.len() < MAX_SESSION_PAGE;
                    if let Some(last) = page.last() {
                        after.clone_from(&last.session_id);
                    }
                    rows.extend(page);
                    if complete {
                        return Ok::<_, StoreError>(rows);
                    }
                }
            },
        ))
        .await;
        let current = self.catalog_vector().await?;
        if current != vector {
            let scope = CatalogScope::Workspace(cwd.into());
            let filter = CatalogFilter {
                archived_only: false,
                include_archived: true,
                pending_only: false,
            };
            return Err(StoreError::RevisionConflict {
                expected: vector.revision(&scope, filter)?,
                actual: current.revision(&scope, filter)?,
            });
        }
        let mut rows: Vec<_> = pages?.into_iter().flatten().collect();
        rows.sort_unstable_by(|a, b| a.session_id.cmp(&b.session_id));
        Ok(crate::workspace::WorkspaceFence(rows))
    }

    pub async fn workspace_has_other_session(
        &self,
        cwd: &str,
        session: &str,
    ) -> Result<bool, StoreError> {
        crate::sessions::validate_id(session)?;
        let scope = CatalogScope::Workspace(cwd.into());
        let filter = CatalogFilter {
            archived_only: false,
            include_archived: true,
            pending_only: false,
        };
        let vector = self.catalog_vector().await?;
        // Two IDs per partition suffice: the excluded Session occupies at most one.
        let candidates = self
            .catalog_candidates(&scope, filter, CatalogPosition::Start, 2, vector, false)
            .await;
        let current = self.catalog_vector().await?;
        if current != vector {
            return Err(StoreError::RevisionConflict {
                expected: vector.revision(&scope, filter)?,
                actual: current.revision(&scope, filter)?,
            });
        }
        Ok(candidates?.0.iter().any(|(key, _)| key.id != session))
    }
}

#[cfg(test)]
mod tests;
