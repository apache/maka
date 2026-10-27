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

//! Host-private prepared message projections. Live leases pin exact views;
//! preparation touches changed semantic groups, never old message payloads.
mod assembly;
mod dependencies;
mod discovery;
pub(crate) mod gc;
pub(crate) mod lifetime;
mod stats;
mod tree;
mod wire;
use super::semantic::{self, SemanticSelection};
use crate::{EventLog, StoreError};
use maka_agent_facts::{
    context::{PreparedContextBreakdown, measure},
    history::semantic::ResolvedRow,
    model::prompt::Message,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row, SqliteConnection};
use tree::{Group, MessageRef};

#[derive(Clone, Debug)]
pub struct PreparedBuild {
    pub key: String,
    pub previous_revision: u64,
    pub captured_revision: u64,
    id: String,
    selection: SemanticSelection,
    lease: lifetime::Lease,
}
#[derive(Clone, Debug)]
pub struct PreparedGroup {
    pub id: String,
}
#[derive(Clone, Debug)]
pub struct PreparedView {
    pub identity: String,
    pub message_count: usize,
    pub breakdown: PreparedContextBreakdown,
    root: Option<String>,
    build_id: String,
    selection: SemanticSelection,
    lease: lifetime::Lease,
}
#[derive(Clone, Debug)]
pub struct PreparedSemanticGroup {
    pub rows: Vec<ResolvedRow>,
    pub manifest: maka_agent_facts::history::media::MediaManifest,
    /// Messages before the requested cursor within this complete logical group.
    pub skip: usize,
}
pub use wire::{
    PreparedWireBuild, PreparedWireCursor, PreparedWireMetadataPage, PreparedWirePage,
    PreparedWireView,
};
fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn encoded<T: Serialize>(value: &T) -> Result<String, StoreError> {
    Ok(serde_json::to_string(value)?)
}
fn group_number(group: &PreparedGroup) -> Result<u64, StoreError> {
    group
        .id
        .parse()
        .map_err(|_| invalid("invalid prepared group"))
}

/// Called inside the operation's transaction, including read snapshots. A live
/// lease protects the immutable build identity from collection until completion.
async fn require_build_session(
    connection: &mut SqliteConnection,
    expected: Option<&str>,
    id: &str,
) -> Result<(), StoreError> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let actual: Option<String> = sqlx::query_scalar(
        "SELECT json_extract(selection_json, '$.session') FROM context_prepared_builds WHERE id=?",
    )
    .bind(id)
    .fetch_optional(connection)
    .await?;
    if actual.as_deref() != Some(expected) {
        return Err(invalid("foreign or missing prepared Session build"));
    }
    Ok(())
}

async fn require_wire_session(
    connection: &mut SqliteConnection,
    expected: Option<&str>,
    id: &str,
) -> Result<(), StoreError> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let actual: Option<String> = sqlx::query_scalar(
        "SELECT json_extract(b.selection_json, '$.session') FROM context_prepared_wire_views w
         JOIN context_prepared_builds b ON b.id=w.build_id WHERE w.id=?",
    )
    .bind(id)
    .fetch_optional(connection)
    .await?;
    if actual.as_deref() != Some(expected) {
        return Err(invalid("foreign or missing prepared Session wire view"));
    }
    Ok(())
}

impl EventLog {
    pub async fn prepare_model_view(
        &self,
        selection: SemanticSelection,
        policy: &str,
    ) -> Result<PreparedBuild, StoreError> {
        self.validate_root()?;
        self.check_bound_session(&selection.session)?;
        let policy = policy.to_owned();
        let registry = self.prepared.clone();
        let build = self.connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin().await?;
            let key = hash(encoded(&(&selection.session, &selection.lineage, selection.after, selection.anchor_sequence, &policy))?.as_bytes());
            let identity = hash(encoded(&(&key, &selection))?.as_bytes());
            let exists: Option<(String,i64,Option<String>)> = sqlx::query_as("SELECT id,previous_revision,parent_id FROM context_prepared_builds WHERE identity=? AND retiring=0")
                .bind(&identity).fetch_optional(&mut *tx).await?;
            if let Some((id, previous, parent)) = exists {
                let parent: Option<String> = sqlx::query_scalar("SELECT id FROM context_prepared_builds WHERE id=? AND retiring=0")
                    .bind(parent).fetch_optional(&mut *tx).await?;
                let base = parent.as_deref().map(|id| registry.acquire("build",id,None)).transpose()?;
                let lease = registry.acquire("build",&id,base)?;
                tx.commit().await?;
                return Ok(PreparedBuild { key, previous_revision:previous as u64, captured_revision:selection.captured_through, id, selection, lease });
            }
            let parent = sqlx::query("SELECT b.id,b.root,b.selection_json FROM context_prepared_heads h JOIN context_prepared_builds b ON b.id=h.build_id
                WHERE h.session_id=? AND b.cache_key=? AND b.complete=1 AND b.retiring=0 AND b.through_sequence<=? AND b.captured_revision<=? AND b.before_sequence<=?")
                .bind(&selection.session).bind(&key).bind(selection.through as i64).bind(selection.captured_through as i64)
                .bind(selection.before.min(i64::MAX as u64) as i64).fetch_optional(&mut *tx).await?;
            let (parent_id,root,previous,previous_selection) = if let Some(parent) = parent {
                let old: SemanticSelection = serde_json::from_str(parent.try_get("selection_json")?)?;
                let since = old.through.min(old.captured_through).min(old.before.saturating_sub(1));
                (Some(parent.try_get::<String,_>("id")?),parent.try_get::<Option<String>,_>("root")?,since,Some(old))
            } else { (None,None,0,None) };
            let id = uuid::Uuid::new_v4().to_string();
            let base = parent_id.as_deref().map(|id| registry.acquire("build",id,None)).transpose()?;
            let lease = registry.acquire("build",&id,base)?;
            sqlx::query("INSERT INTO context_prepared_builds(id,identity,cache_key,selection_json,through_sequence,captured_revision,before_sequence,previous_revision,root,parent_id,discovery_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
                .bind(&id).bind(identity).bind(&key).bind(encoded(&selection)?).bind(selection.through as i64)
                .bind(selection.captured_through as i64).bind(selection.before.min(i64::MAX as u64) as i64)
                .bind(previous as i64).bind(&root).bind(parent_id).bind(encoded(&discovery::Logical::new(previous_selection))?).execute(&mut *tx).await?;
            tx.commit().await?;
            registry.wake();
            Ok(PreparedBuild { key, previous_revision:previous, captured_revision:selection.captured_through, id, selection, lease })
        })).await?;
        loop {
            let chunk_build = build.clone();
            let ready = self
                .connection
                .run(move |connection| {
                    Box::pin(async move {
                        let mut tx = connection.begin().await?;
                        let ready = discovery::logical(&mut tx, &chunk_build).await?;
                        tx.commit().await?;
                        Ok(ready)
                    })
                })
                .await?;
            if ready {
                break;
            }
        }
        Ok(build)
    }

    pub async fn prepared_dirty_groups(
        &self,
        build: &PreparedBuild,
        after: Option<&str>,
        limit: usize,
    ) -> Result<Vec<PreparedGroup>, StoreError> {
        self.validate_root()?;
        let expected_session = self.expected_session.clone();
        let scope_id = build.id.clone();
        build.lease.validate(&self.prepared)?;
        self.check_bound_session(&build.selection.session)?;
        let id = build.id.clone();
        let after = after
            .map(str::parse::<i64>)
            .transpose()
            .map_err(|_| invalid("invalid prepared group cursor"))?
            .unwrap_or(-1);
        if limit == 0 {
            return Err(invalid("prepared page limit must be positive"));
        }
        let lease = build.lease.clone();
        self.connection.read_interruptible(move |connection|Box::pin(async move {
            let mut scope_transaction = connection.begin().await?;
            let connection = &mut *scope_transaction;
            require_build_session(connection, expected_session.as_deref(), &scope_id).await?;
                    let _lease = lease;
            assembly::require_discovered(connection,assembly::Kind::Logical,&id).await?;
            let groups:Vec<i64>=sqlx::query_scalar("SELECT group_sequence FROM context_prepared_dirty WHERE build_id=? AND group_sequence>? AND done=0 ORDER BY group_sequence LIMIT ?")
                .bind(id).bind(after).bind(limit.min(1024) as i64).fetch_all(connection).await?;
            Ok(groups.into_iter().map(|id|PreparedGroup{id:id.to_string()}).collect())
        })).await
    }

    pub async fn prepared_group_rows(
        &self,
        build: &PreparedBuild,
        group: &PreparedGroup,
    ) -> Result<Vec<ResolvedRow>, StoreError> {
        self.validate_root()?;
        let expected_session = self.expected_session.clone();
        let scope_id = build.id.clone();
        build.lease.validate(&self.prepared)?;
        self.check_bound_session(&build.selection.session)?;
        let selection = build.selection.clone();
        let id = build.id.clone();
        let group = group_number(group)?;
        let lease = build.lease.clone();
        self.connection
            .read_interruptible(move |connection| {
                Box::pin(async move {
                    let mut scope_transaction = connection.begin().await?;
                    let connection = &mut *scope_transaction;
                    require_build_session(connection, expected_session.as_deref(), &scope_id)
                        .await?;
                    let _lease = lease;
                    let members = members(connection, &id, group).await?;
                    let mut all = Vec::new();
                    for member in members {
                        all.extend(group_metadata(connection, &selection, member).await?);
                    }
                    semantic::resolve(connection, all).await
                })
            })
            .await
    }

    pub async fn finish_prepared(&self, build: &PreparedBuild) -> Result<PreparedView, StoreError> {
        self.validate_root()?;
        let expected_session = self.expected_session.clone();
        let scope_id = build.id.clone();
        build.lease.validate(&self.prepared)?;
        self.check_bound_session(&build.selection.session)?;
        loop {
            let id = build.id.clone();
            let lease = build.lease.clone();
            let expected = expected_session.clone();
            let ready = self
                .connection
                .run(move |connection| {
                    Box::pin(async move {
                        let _lease = lease;
                        let mut tx = connection.begin().await?;
                        require_build_session(&mut tx, expected.as_deref(), &id).await?;
                        let ready =
                            assembly::advance(&mut tx, assembly::Kind::Logical, &id).await?;
                        tx.commit().await?;
                        Ok(ready)
                    })
                })
                .await?;
            if ready {
                break;
            }
        }
        let build = build.clone();
        self.connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin().await?;
            require_build_session(&mut tx, expected_session.as_deref(), &scope_id).await?;
            let pending: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM context_prepared_dirty WHERE build_id=? AND done=0)").bind(&build.id).fetch_one(&mut *tx).await?;
            if pending { return Err(invalid("prepared view has unrendered groups")); }
            let root: Option<String> = sqlx::query_scalar("SELECT root FROM context_prepared_builds WHERE id=? AND retiring=0").bind(&build.id).fetch_one(&mut *tx).await?;
            let (message_count,breakdown) = tree::totals(&mut tx,root.as_deref()).await?;
            let first = sqlx::query("UPDATE context_prepared_builds SET complete=1 WHERE id=? AND complete=0").bind(&build.id).execute(&mut *tx).await?.rows_affected() > 0;
            if first {
                let weight = tree::weight(&mut tx,root.as_deref()).await?;
                gc::publish_logical(&mut tx,&build.selection,&build.id,weight).await?;
            }
            tx.commit().await?;
            build.lease.wake();
            Ok(PreparedView { identity:root.clone().unwrap_or_else(||hash(b"empty prepared prefix")), message_count, breakdown, root, selection:build.selection, build_id:build.id, lease:build.lease })
        })).await
    }

    /// Resolve one complete logical group and its frozen media snapshot with
    /// one tree search in the selected view's original read transaction.
    pub async fn prepared_semantic_group(
        &self,
        view: &PreparedView,
        cursor: usize,
    ) -> Result<Option<PreparedSemanticGroup>, StoreError> {
        self.validate_root()?;
        let expected_session = self.expected_session.clone();
        let scope_id = view.build_id.clone();
        view.lease.validate(&self.prepared)?;
        self.check_bound_session(&view.selection.session)?;
        if cursor > view.message_count {
            return Err(invalid("invalid prepared semantic cursor"));
        }
        let view = view.clone();
        self.connection
            .read_interruptible(move |connection| {
                Box::pin(async move {
                    let mut scope_transaction = connection.begin().await?;
                    let connection = &mut *scope_transaction;
                    require_build_session(connection, expected_session.as_deref(), &scope_id)
                        .await?;
                    let _lease = view.lease;
                    if cursor == view.message_count {
                        return Ok(None);
                    }
                    let (_, base, group) =
                        tree::seek(connection, view.root.as_deref(), cursor).await?;
                    let mut rows = Vec::new();
                    for member in group.members {
                        rows.extend(group_metadata(connection, &view.selection, member).await?);
                    }
                    Ok(Some(PreparedSemanticGroup {
                        rows: semantic::resolve(connection, rows).await?,
                        manifest: group.manifest,
                        skip: cursor - base,
                    }))
                })
            })
            .await
    }
    /// Resolve a complete group by its sequence, including zero-width groups,
    /// with its frozen media snapshot in one original read transaction.
    /// The returned group starts at its beginning, so `skip` is always zero.
    pub async fn prepared_view_group(
        &self,
        view: &PreparedView,
        group: &PreparedGroup,
    ) -> Result<PreparedSemanticGroup, StoreError> {
        self.validate_root()?;
        let expected_session = self.expected_session.clone();
        let scope_id = view.build_id.clone();
        view.lease.validate(&self.prepared)?;
        self.check_bound_session(&view.selection.session)?;
        let view = view.clone();
        let sequence = group_number(group)?;
        self.connection
            .read_interruptible(move |connection| {
                Box::pin(async move {
                    let mut scope_transaction = connection.begin().await?;
                    let connection = &mut *scope_transaction;
                    require_build_session(connection, expected_session.as_deref(), &scope_id)
                        .await?;
                    let _lease = view.lease;
                    let group = tree::find(connection, view.root.as_deref(), sequence).await?;
                    let mut rows = Vec::new();
                    for member in group.members {
                        rows.extend(group_metadata(connection, &view.selection, member).await?);
                    }
                    Ok(PreparedSemanticGroup {
                        rows: semantic::resolve(connection, rows).await?,
                        manifest: group.manifest,
                        skip: 0,
                    })
                })
            })
            .await
    }

    /// Prefix identity visits only tree paths and bounded group metadata. It
    /// neither reads payload chunks nor walks every preceding message.
    pub async fn prepared_prefix_identity(
        &self,
        view: &PreparedView,
        message_count: usize,
    ) -> Result<String, StoreError> {
        self.validate_root()?;
        let expected_session = self.expected_session.clone();
        let scope_id = view.build_id.clone();
        view.lease.validate(&self.prepared)?;
        self.check_bound_session(&view.selection.session)?;
        if message_count > view.message_count {
            return Err(invalid("prepared prefix exceeds view"));
        }
        let root = view.root.clone();
        let lease = view.lease.clone();
        self.connection
            .read_interruptible(move |connection| {
                Box::pin(async move {
                    let mut scope_transaction = connection.begin().await?;
                    let connection = &mut *scope_transaction;
                    require_build_session(connection, expected_session.as_deref(), &scope_id)
                        .await?;
                    let _lease = lease;
                    Ok(tree::prefix(connection, root.as_deref(), message_count)
                        .await?
                        .unwrap_or_else(|| hash(b"empty prepared prefix")))
                })
            })
            .await
    }
}

async fn mark_dirty(
    connection: &mut SqliteConnection,
    id: &str,
    group: u64,
) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT OR IGNORE INTO context_prepared_dirty(build_id,group_sequence) VALUES(?,?)",
    )
    .bind(id)
    .bind(group as i64)
    .execute(connection)
    .await?;
    Ok(())
}

const GROUP_MEMBERS_SQL: &str = "SELECT group_sequence FROM context_prepared_dirty WHERE build_id=? AND COALESCE(leader_sequence,group_sequence)=? ORDER BY group_sequence";
async fn members(
    connection: &mut SqliteConnection,
    id: &str,
    group: u64,
) -> Result<Vec<u64>, StoreError> {
    let values: Vec<i64> = sqlx::query_scalar(GROUP_MEMBERS_SQL)
        .bind(id)
        .bind(group as i64)
        .fetch_all(connection)
        .await?;
    Ok(values.into_iter().map(|value| value as u64).collect())
}
async fn group_metadata(
    connection: &mut SqliteConnection,
    selection: &SemanticSelection,
    group: u64,
) -> Result<Vec<maka_agent_facts::history::semantic::SemanticRow>, StoreError> {
    let mut cursor = None;
    let mut rows = Vec::new();
    loop {
        let page = semantic::rows(connection, selection, cursor, 256, Some(group)).await?;
        rows.extend(page.rows);
        cursor = page.next;
        if cursor.is_none() {
            break;
        }
    }
    Ok(rows)
}
fn role(row: &maka_agent_facts::history::semantic::SemanticRow) -> u8 {
    use maka_agent_facts::history::semantic::SemanticKind;
    match row.kind {
        SemanticKind::ToolResult { .. }
        | SemanticKind::Notification { .. }
        | SemanticKind::UnknownTool { .. } => 1,
        _ => 0,
    }
}
fn joins(
    left: &maka_agent_facts::history::semantic::SemanticRow,
    right: &maka_agent_facts::history::semantic::SemanticRow,
) -> bool {
    role(left) != 0 && role(left) == role(right)
}

#[cfg(test)]
mod tests;

#[cfg(test)]
#[path = "prepared/assembly_tests.rs"]
mod assembly_tests;
