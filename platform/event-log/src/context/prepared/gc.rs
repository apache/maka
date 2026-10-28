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

//! Bounded cache ownership and incremental reference-count collection.
use super::{
    SemanticSelection,
    lifetime::{Key, PreparedRegistry},
    refs::{Kind as RefKind, RefBatch},
    runtime::InFlight,
};
use crate::StoreError;
use sqlx::{Connection, SqliteConnection};
use std::collections::BTreeSet;

const CACHE_SLOTS: i64 = 256;
const CACHE_BYTES: i64 = 128 * 1024 * 1024;
const METADATA_ROWS: usize = 128;
const WIRE_PIECES: i64 = 128;

pub(super) async fn publish_logical(
    connection: &mut SqliteConnection,
    selection: &SemanticSelection,
    build: &str,
    weight: usize,
) -> Result<(), StoreError> {
    let latest: Option<(i64,i64)> = sqlx::query_as("SELECT b.through_sequence,b.captured_revision FROM context_prepared_heads h JOIN context_prepared_builds b ON b.id=h.build_id WHERE h.session_id=?")
        .bind(&selection.session).fetch_optional(&mut *connection).await?;
    if latest.is_some_and(|(through, revision)| {
        through as u64 > selection.through || revision as u64 > selection.captured_through
    }) {
        return Ok(());
    }
    sqlx::query("INSERT INTO context_prepared_heads(session_id,build_id,touched,logical_weight) VALUES(?,?,CAST(unixepoch('subsec')*1000 AS INTEGER),?)
        ON CONFLICT(session_id) DO UPDATE SET build_id=excluded.build_id,
        touched=excluded.touched,logical_weight=excluded.logical_weight")
        .bind(&selection.session).bind(build).bind(weight.min(i64::MAX as usize) as i64).execute(&mut *connection).await?;
    trim(connection).await
}
pub(super) async fn publish_wire(
    connection: &mut SqliteConnection,
    build: &str,
    wire: &str,
    weight: usize,
) -> Result<(), StoreError> {
    sqlx::query("UPDATE context_prepared_heads SET wire_view_id=?,wire_weight=?,touched=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE build_id=?")
        .bind(wire).bind(weight.min(i64::MAX as usize) as i64).bind(build).execute(&mut *connection).await?;
    trim(connection).await
}
async fn trim(connection: &mut SqliteConnection) -> Result<(), StoreError> {
    loop {
        let (count, bytes): (i64, i64) =
            sqlx::query_as("SELECT COUNT(*),COALESCE(SUM(weight),0) FROM context_prepared_heads")
                .fetch_one(&mut *connection)
                .await?;
        if count <= CACHE_SLOTS && bytes <= CACHE_BYTES {
            return Ok(());
        }
        sqlx::query("DELETE FROM context_prepared_heads WHERE session_id=(SELECT session_id FROM context_prepared_heads ORDER BY touched,session_id LIMIT 1)").execute(&mut *connection).await?;
    }
}

/// Retirement withdraws only cache ownership. Accepted reads retain their own
/// leases, and semantic/canonical material has a separate physical-drain contract.
pub(crate) async fn retire_owner(
    connection: &mut SqliteConnection,
    session: &str,
) -> Result<(), StoreError> {
    sqlx::query("DELETE FROM context_prepared_heads WHERE session_id=?")
        .bind(session)
        .execute(connection)
        .await?;
    Ok(())
}

/// One owner job; no recursive deletion and no full-graph mark phase.
pub(crate) async fn maintain(
    connection: &mut SqliteConnection,
    registry: &PreparedRegistry,
    in_flight: &mut InFlight,
) -> Result<bool, StoreError> {
    let released = registry.take_released(METADATA_ROWS);
    let pending =
        registry.has_released() || !released.is_empty() || has_work(connection, registry).await?;
    if !pending {
        return Ok(false);
    }
    let result = async {
        let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
        for Key { kind, id } in &released {
            sqlx::query("INSERT OR IGNORE INTO context_prepared_retire VALUES(?,?)")
                .bind(kind)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        let mut refs = RefBatch::default();
        let mut rows = METADATA_ROWS;
        let mut retired = Vec::new();
        for _ in 0..16 {
            if rows == 0 {
                break;
            }
            let candidate: Option<(String, String)> = sqlx::query_as(
                "SELECT kind,id FROM context_prepared_retire ORDER BY kind DESC,id LIMIT 1",
            )
            .fetch_optional(&mut *tx)
            .await?;
            let Some((kind, id)) = candidate else {
                break;
            };
            let done = if kind == "wire_view" {
                retire_wire(&mut tx, &mut refs, registry, &id, &mut rows, &mut retired).await?
            } else {
                retire_build(&mut tx, &mut refs, registry, &id, &mut rows, &mut retired).await?
            };
            if done {
                sqlx::query("DELETE FROM context_prepared_retire WHERE kind=? AND id=?")
                    .bind(kind)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
            }
        }
        // Root retirement and object reclamation have independent budgets, so a
        // large cancelled build cannot starve reclaimed nodes or wire bodies.
        refs.flush(&mut tx).await?;
        collect_unreachable(&mut tx).await?;
        tx.commit().await.map_err(StoreError::CommitUnknown)?;
        for (kind, id) in retired {
            in_flight.remove(kind, &id);
        }
        // Live preparations reuse reclaimed pages. The last lease release wakes
        // this owner to shrink idle storage with the existing bounded budget.
        if !registry.has_live() {
            sqlx::query("PRAGMA prepared_cache.incremental_vacuum(128)")
                .execute(&mut *connection)
                .await?;
        }
        Ok(has_work(connection, registry).await? || registry.has_released())
    }
    .await;
    match result {
        Ok(more) => {
            if more {
                registry.wake();
            }
            Ok(more)
        }
        Err(error) => {
            registry.restore_released(released);
            Err(error)
        }
    }
}
async fn has_work(
    connection: &mut SqliteConnection,
    registry: &PreparedRegistry,
) -> Result<bool, StoreError> {
    let roots: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM context_prepared_retire) OR EXISTS(SELECT 1 FROM context_prepared_refs WHERE refs=0) OR EXISTS(SELECT 1 FROM context_prepared_payloads WHERE digest IS NULL)").fetch_one(&mut *connection).await?;
    if roots {
        return Ok(true);
    }
    if registry.has_live() {
        return Ok(false);
    }
    Ok(
        sqlx::query_scalar::<_, i64>("PRAGMA prepared_cache.freelist_count")
            .fetch_one(connection)
            .await?
            > 0,
    )
}
async fn retire_wire(
    connection: &mut SqliteConnection,
    refs: &mut RefBatch,
    registry: &PreparedRegistry,
    id: &str,
    budget: &mut usize,
    retired: &mut Vec<(&'static str, String)>,
) -> Result<bool, StoreError> {
    if registry.live("wire_view", id) {
        return Ok(true);
    }
    let cached: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM context_prepared_heads WHERE wire_view_id=?)",
    )
    .bind(id)
    .fetch_one(&mut *connection)
    .await?;
    if cached {
        return Ok(true);
    }
    retired.push(("wire_view", id.to_owned()));
    let roots: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT root,discovery_root FROM context_prepared_wire_views WHERE id=? AND retiring=0",
    )
    .bind(id)
    .fetch_optional(&mut *connection)
    .await?;
    if let Some((root, discovery)) = roots {
        sqlx::query("UPDATE context_prepared_wire_views SET root=NULL,discovery_root=NULL,retiring=1 WHERE id=?")
            .bind(id).execute(&mut *connection).await?;
        for root in [root, discovery].into_iter().flatten() {
            refs.change(connection, RefKind::Node, &root, -1).await?;
        }
    }
    retire_dirty(
        connection,
        refs,
        "context_prepared_wire_dirty",
        "view_id",
        id,
        budget,
    )
    .await?;
    let remains: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM context_prepared_wire_dirty WHERE view_id=?)",
    )
    .bind(id)
    .fetch_one(&mut *connection)
    .await?;
    if remains {
        return Ok(false);
    }
    // A replaced logical head may have been retained solely by this wire slot.
    // Release that last cache edge only when its wire root is really retired.
    sqlx::query("INSERT OR IGNORE INTO context_prepared_retire SELECT 'build',build_id FROM context_prepared_wire_views WHERE id=?")
        .bind(id).execute(&mut *connection).await?;
    if !retire_pins(connection, refs, "wire_view", id, budget).await? {
        return Ok(false);
    }
    sqlx::query("DELETE FROM context_prepared_wire_views WHERE id=?")
        .bind(id)
        .execute(connection)
        .await?;
    *budget = budget.saturating_sub(1);
    Ok(true)
}
async fn retire_build(
    connection: &mut SqliteConnection,
    refs: &mut RefBatch,
    registry: &PreparedRegistry,
    id: &str,
    budget: &mut usize,
    retired: &mut Vec<(&'static str, String)>,
) -> Result<bool, StoreError> {
    if registry.live("build", id) {
        return Ok(true);
    }
    let cached: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM context_prepared_heads WHERE build_id=?1) OR EXISTS(SELECT 1 FROM context_prepared_wire_views w JOIN context_prepared_heads h ON h.wire_view_id=w.id WHERE w.build_id=?1)")
            .bind(id)
            .fetch_one(&mut *connection)
            .await?;
    if cached {
        return Ok(true);
    }
    retired.push(("build", id.to_owned()));
    let root: Option<Option<String>> =
        sqlx::query_scalar("SELECT root FROM context_prepared_builds WHERE id=? AND retiring=0")
            .bind(id)
            .fetch_optional(&mut *connection)
            .await?;
    if let Some(root) = root {
        sqlx::query("UPDATE context_prepared_builds SET root=NULL,retiring=1 WHERE id=?")
            .bind(id)
            .execute(&mut *connection)
            .await?;
        if let Some(root) = root {
            refs.change(connection, RefKind::Node, &root, -1).await?;
        }
    }
    let wire: Option<String> = sqlx::query_scalar(
        "SELECT id FROM context_prepared_wire_views WHERE build_id=? ORDER BY id LIMIT 1",
    )
    .bind(id)
    .fetch_optional(&mut *connection)
    .await?;
    if let Some(wire) = wire {
        sqlx::query("INSERT OR IGNORE INTO context_prepared_retire VALUES('wire_view',?)")
            .bind(wire)
            .execute(connection)
            .await?;
        return Ok(false);
    }
    retire_dirty(
        connection,
        refs,
        "context_prepared_dirty",
        "build_id",
        id,
        budget,
    )
    .await?;
    let remains: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM context_prepared_dirty WHERE build_id=?)")
            .bind(id)
            .fetch_one(&mut *connection)
            .await?;
    if remains {
        return Ok(false);
    }
    if !retire_pins(connection, refs, "build", id, budget).await? {
        return Ok(false);
    }
    sqlx::query("DELETE FROM context_prepared_builds WHERE id=?")
        .bind(id)
        .execute(connection)
        .await?;
    *budget = budget.saturating_sub(1);
    Ok(true)
}

/// At most 128 metadata rows and 128 32-KiB wire pieces in a single transaction.
/// Incoming reference updates enqueue descendants; they never recursively delete.
pub(crate) async fn collect_unreachable(
    connection: &mut SqliteConnection,
) -> Result<bool, StoreError> {
    let mut refs = RefBatch::default();
    let mut budget = METADATA_ROWS;
    let mut changed = false;
    let mut candidates = BTreeSet::new();
    let mut cursor = (String::new(), String::new());
    while budget > 0 {
        if candidates.is_empty() {
            let page:Vec<(String,String)>=sqlx::query_as("SELECT kind,id FROM context_prepared_refs WHERE refs=0 AND kind IN ('group','node') AND (kind,id)>(?1,?2) ORDER BY kind,id LIMIT ?3")
                .bind(&cursor.0).bind(&cursor.1).bind(budget as i64).fetch_all(&mut *connection).await?;
            if page.is_empty() {
                break;
            }
            cursor = page.last().expect("nonempty zero-reference page").clone();
            for (kind, id) in page {
                let kind = match kind.as_str() {
                    "node" => RefKind::Node,
                    "group" => RefKind::Group,
                    _ => return Err(super::invalid("invalid prepared object kind")),
                };
                candidates.insert((kind, id));
            }
        }
        let (kind, id) = candidates
            .pop_first()
            .expect("pending zero-reference candidate");
        if refs.is_deleted(kind, &id) || refs.count(connection, kind, &id).await? != 0 {
            continue;
        }
        changed = true;
        if kind == RefKind::Group {
            for table in ["context_prepared_mcp_ids", "context_prepared_mcp_refs"] {
                let key = if table == "context_prepared_mcp_ids" {
                    "(call_id,message_index)"
                } else {
                    "call_id"
                };
                let sql = format!(
                    "DELETE FROM {table} WHERE content_id=?1 AND {key} IN (SELECT {columns} FROM {table} WHERE content_id=?1 ORDER BY {columns} LIMIT ?2)",
                    columns = key.trim_matches(['(', ')'])
                );
                let count = sqlx::query(sqlx::AssertSqlSafe(sql))
                    .bind(&id)
                    .bind(budget as i64)
                    .execute(&mut *connection)
                    .await?
                    .rows_affected() as usize;
                budget = budget.saturating_sub(count);
                if budget == 0 {
                    break;
                }
            }
            if budget == 0 {
                break;
            }
            let edges:Option<(Option<String>,Option<String>)>=sqlx::query_as("SELECT json_extract(group_json,'$.logical_content_id'),json_extract(group_json,'$.wire_id') FROM context_prepared_groups WHERE id=?")
                .bind(&id).fetch_optional(&mut *connection).await?;
            sqlx::query("DELETE FROM context_prepared_groups WHERE id=?")
                .bind(&id)
                .execute(&mut *connection)
                .await?;
            if let Some((logical, wire)) = edges {
                if let Some(logical) = logical {
                    release_edge(
                        connection,
                        &mut refs,
                        &mut candidates,
                        RefKind::Group,
                        &logical,
                    )
                    .await?;
                }
                if let Some(wire) = wire {
                    release_edge(connection, &mut refs, &mut candidates, RefKind::Wire, &wire)
                        .await?;
                }
            }
        } else {
            let edges:Option<(Option<String>,Option<String>,String)>=sqlx::query_as("SELECT json_extract(node_json,'$.left'),json_extract(node_json,'$.right'),json_extract(node_json,'$.content') FROM context_prepared_nodes WHERE id=?")
                .bind(&id).fetch_optional(&mut *connection).await?;
            sqlx::query("DELETE FROM context_prepared_nodes WHERE id=?")
                .bind(&id)
                .execute(&mut *connection)
                .await?;
            if let Some((left, right, content)) = edges {
                for child in [left, right].into_iter().flatten() {
                    release_edge(
                        connection,
                        &mut refs,
                        &mut candidates,
                        RefKind::Node,
                        &child,
                    )
                    .await?;
                }
                release_edge(
                    connection,
                    &mut refs,
                    &mut candidates,
                    RefKind::Group,
                    &content,
                )
                .await?;
            }
        }
        refs.remove(connection, kind, &id).await?;
        budget -= 1;
    }
    refs.flush(connection).await?;
    let wire: Option<String> = sqlx::query_scalar(
        "SELECT id FROM context_prepared_refs WHERE kind='wire' AND refs=0 ORDER BY id LIMIT 1",
    )
    .fetch_optional(&mut *connection)
    .await?;
    if let Some(wire) = wire {
        changed = true;
        // Withdraw reuse before deleting any pieces. The same digest can then
        // publish new complete storage while this physical body drains.
        sqlx::query("UPDATE context_prepared_payloads SET digest=NULL WHERE digest=?")
            .bind(&wire)
            .execute(&mut *connection)
            .await?;
        sqlx::query("DELETE FROM context_prepared_refs WHERE kind='wire' AND id=? AND refs=0")
            .bind(wire)
            .execute(&mut *connection)
            .await?;
    }
    let storage: Option<String> = sqlx::query_scalar(
        "SELECT storage_id FROM context_prepared_payloads WHERE digest IS NULL ORDER BY storage_id LIMIT 1",
    )
    .fetch_optional(&mut *connection)
    .await?;
    if let Some(storage) = storage {
        changed = true;
        sqlx::query("DELETE FROM context_prepared_chunks WHERE storage_id=?1 AND piece_index IN (SELECT piece_index FROM context_prepared_chunks WHERE storage_id=?1 ORDER BY piece_index LIMIT ?2)")
            .bind(&storage).bind(WIRE_PIECES).execute(&mut *connection).await?;
        let remains: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM context_prepared_chunks WHERE storage_id=?)",
        )
        .bind(&storage)
        .fetch_one(&mut *connection)
        .await?;
        if !remains {
            sqlx::query(
                "DELETE FROM context_prepared_payloads WHERE storage_id=? AND digest IS NULL",
            )
            .bind(storage)
            .execute(connection)
            .await?;
        }
    }
    Ok(changed)
}

async fn retire_pins(
    connection: &mut SqliteConnection,
    refs: &mut RefBatch,
    kind: &str,
    id: &str,
    budget: &mut usize,
) -> Result<bool, StoreError> {
    let removed:Vec<String>=sqlx::query_scalar("DELETE FROM context_prepared_generation_nodes WHERE kind=?1 AND owner_id=?2 AND node_id IN (SELECT node_id FROM context_prepared_generation_nodes WHERE kind=?1 AND owner_id=?2 ORDER BY node_id LIMIT ?3) RETURNING node_id")
        .bind(kind).bind(id).bind(*budget as i64).fetch_all(&mut *connection).await?;
    *budget = budget.saturating_sub(removed.len());
    for node in removed {
        refs.change(connection, RefKind::Node, &node, -1).await?;
    }
    let remains: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM context_prepared_generation_nodes WHERE kind=? AND owner_id=?)",
    )
    .bind(kind)
    .bind(id)
    .fetch_one(&mut *connection)
    .await?;
    if remains {
        return Ok(false);
    }
    Ok(true)
}

async fn retire_dirty(
    connection: &mut SqliteConnection,
    refs: &mut RefBatch,
    table: &str,
    key: &str,
    id: &str,
    budget: &mut usize,
) -> Result<(), StoreError> {
    let sql = format!(
        "DELETE FROM {table} WHERE {key}=?1 AND group_sequence IN (SELECT group_sequence FROM {table} WHERE {key}=?1 ORDER BY group_sequence LIMIT ?2) RETURNING content"
    );
    let removed: Vec<Option<String>> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(*budget as i64)
        .fetch_all(&mut *connection)
        .await?;
    *budget = budget.saturating_sub(removed.len());
    for content in removed.into_iter().flatten() {
        refs.change(connection, RefKind::Group, &content, -1)
            .await?;
    }
    Ok(())
}
async fn release_edge(
    connection: &mut SqliteConnection,
    refs: &mut RefBatch,
    candidates: &mut BTreeSet<(RefKind, String)>,
    kind: RefKind,
    id: &str,
) -> Result<(), StoreError> {
    if refs.change(connection, kind, id, -1).await? == 0 && kind != RefKind::Wire {
        candidates.insert((kind, id.to_owned()));
    }
    Ok(())
}
