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

//! Discovery owns an explicit initialization gate. Concurrent prepare calls help
//! advance the same owner cursor; rendering/finish cannot observe partial work.
use super::*;

#[derive(Clone)]
pub(super) struct Logical {
    previous: Option<SemanticSelection>,
    phase: u8,
    changes: Option<semantic::SemanticChangeCursor>,
    source_cursor: Option<semantic::GroupCursor>,
    anchor: bool,
    branch: u8,
    expansion: Option<Expansion>,
}
#[derive(Clone)]
struct Expansion {
    current: u64,
    leader: Option<u64>,
}
impl Logical {
    pub(super) fn new(previous: Option<SemanticSelection>) -> Self {
        Self {
            previous,
            phase: 0,
            changes: None,
            source_cursor: None,
            anchor: false,
            branch: 0,
            expansion: None,
        }
    }
}
async fn edges(
    db: &mut SqliteConnection,
    selection: &SemanticSelection,
    group: u64,
) -> Result<
    Option<(
        maka_agent_facts::history::semantic::SemanticRow,
        maka_agent_facts::history::semantic::SemanticRow,
    )>,
    StoreError,
> {
    let mut cursor = None;
    let mut first = None;
    let mut last = None;
    loop {
        let page = semantic::rows(db, selection, cursor, 256, Some(group)).await?;
        for row in page.rows {
            if first.is_none() {
                first = Some(row.clone());
            }
            last = Some(row);
        }
        cursor = page.next;
        if cursor.is_none() {
            break;
        }
    }
    Ok(first.zip(last))
}
pub(super) async fn logical_batch(
    db: &mut SqliteConnection,
    build: &PreparedBuild,
    state: &mut Logical,
) -> Result<bool, StoreError> {
    let root: Option<String> =
        sqlx::query_scalar("SELECT root FROM context_prepared_builds WHERE id=? AND retiring=0")
            .bind(&build.id)
            .fetch_one(&mut *db)
            .await?;
    let mut ready = false;
    for _ in 0..16 {
        match state.phase {
            0 => {
                if state.previous.is_some() {
                    let page = semantic::changes(
                        db,
                        &build.selection,
                        build.previous_revision,
                        state.changes,
                        64,
                    )
                    .await?;
                    for change in page.changes {
                        mark_dirty(db, &build.id, change.order.source_sequence).await?;
                    }
                    state.changes = page.next;
                    if state.changes.is_none() {
                        state.phase = 1;
                    }
                } else {
                    let page = semantic::initial_groups(
                        db,
                        &build.selection,
                        state.source_cursor,
                        state.anchor,
                        64,
                    )
                    .await?;
                    for sequence in page.groups {
                        mark_dirty(db, &build.id, sequence).await?;
                    }
                    state.source_cursor = page.next;
                    if state.source_cursor.is_none() {
                        if state.anchor {
                            state.phase = 2;
                        } else {
                            state.anchor = true;
                        }
                    }
                }
            }
            1 => {
                let page = semantic::selection_dirty_groups(
                    db,
                    state.previous.as_ref().expect("warm discovery"),
                    &build.selection,
                    state.branch,
                    state.source_cursor,
                    64,
                )
                .await?;
                for sequence in page.groups {
                    mark_dirty(db, &build.id, sequence).await?;
                }
                state.source_cursor = page.next;
                if state.source_cursor.is_none() {
                    state.branch += 1;
                    if state.branch == 5 {
                        state.phase = 2;
                    }
                }
            }
            2 => {
                let sequence:Option<i64>=sqlx::query_scalar("SELECT group_sequence FROM context_prepared_dirty WHERE build_id=? AND covered=0 ORDER BY group_sequence LIMIT 1").bind(&build.id).fetch_optional(&mut *db).await?;
                let Some(sequence) = sequence else {
                    state.phase = 3;
                    continue;
                };
                if let Some(old) = tree::covering(db, root.as_deref(), sequence as u64).await? {
                    for member in old.members {
                        mark_dirty(db, &build.id, member).await?;
                        sqlx::query("UPDATE context_prepared_dirty SET covered=1 WHERE build_id=? AND group_sequence=?").bind(&build.id).bind(member as i64).execute(&mut *db).await?;
                    }
                }
                sqlx::query("UPDATE context_prepared_dirty SET covered=1 WHERE build_id=? AND group_sequence=?").bind(&build.id).bind(sequence).execute(&mut *db).await?;
            }
            3 => {
                if state.expansion.is_none() {
                    let sequence:Option<i64>=sqlx::query_scalar("SELECT group_sequence FROM context_prepared_dirty WHERE build_id=? AND expanded=0 ORDER BY group_sequence LIMIT 1").bind(&build.id).fetch_optional(&mut *db).await?;
                    let Some(sequence) = sequence else {
                        ready = true;
                        break;
                    };
                    let mut current = sequence as u64;
                    if edges(db, &build.selection, current).await?.is_none() {
                        sqlx::query("UPDATE context_prepared_dirty SET expanded=1 WHERE build_id=? AND group_sequence=?").bind(&build.id).bind(sequence).execute(&mut *db).await?;
                        let before =
                            semantic::neighbor(db, &build.selection, current, true).await?;
                        let after =
                            semantic::neighbor(db, &build.selection, current, false).await?;
                        match (before, after) {
                            (Some(before), Some(after)) if joins(&before, &after) => {
                                current = before.order.source_sequence
                            }
                            _ => continue,
                        }
                    }
                    state.expansion = Some(Expansion {
                        current,
                        leader: None,
                    });
                }
                let expansion = state.expansion.as_mut().expect("expansion cursor");
                let (first, last) = edges(db, &build.selection, expansion.current)
                    .await?
                    .ok_or_else(|| invalid("semantic neighbor has no group"))?;
                if expansion.leader.is_none() {
                    if let Some(previous) =
                        semantic::neighbor(db, &build.selection, first.order.source_sequence, true)
                            .await?
                        && joins(&previous, &first)
                    {
                        expansion.current = previous.order.source_sequence;
                        continue;
                    }
                    expansion.leader = Some(expansion.current);
                }
                mark_dirty(db, &build.id, expansion.current).await?;
                sqlx::query("UPDATE context_prepared_dirty SET covered=1,expanded=1,leader_sequence=? WHERE build_id=? AND group_sequence=?")
                    .bind(expansion.leader.map(|n|n as i64)).bind(&build.id).bind(expansion.current as i64).execute(&mut *db).await?;
                if let Some(next) =
                    semantic::neighbor(db, &build.selection, last.order.source_sequence, false)
                        .await?
                    && joins(&last, &next)
                {
                    expansion.current = next.order.source_sequence;
                } else {
                    state.expansion = None;
                }
            }
            _ => unreachable!(),
        }
    }
    if ready {
        sqlx::query("UPDATE context_prepared_builds SET discovered=1 WHERE id=?")
            .bind(&build.id)
            .execute(db)
            .await?;
    }
    Ok(ready)
}

#[derive(Clone)]
pub(super) struct Wire {
    warm: bool,
    old_logical: Option<String>,
    phase: u8,
    cursor: i64,
    affected: Option<dependencies::Discovery>,
}
impl Wire {
    pub(super) fn new(warm: bool, old_logical: Option<String>) -> Self {
        Self {
            warm,
            old_logical,
            phase: 0,
            cursor: -1,
            affected: None,
        }
    }
}
pub(super) async fn wire_batch(
    db: &mut SqliteConnection,
    build: &PreparedWireBuild,
    state: &mut Wire,
) -> Result<bool, StoreError> {
    let mut ready = false;
    for _ in 0..16 {
        match state.phase {
            0 => {
                let page = if state.warm {
                    sqlx::query_scalar::<_,i64>("SELECT group_sequence FROM context_prepared_dirty WHERE build_id=? AND group_sequence>? ORDER BY group_sequence LIMIT 64")
                        .bind(&build.view.build_id).bind(state.cursor).fetch_all(&mut *db).await?.into_iter().map(|n|n as u64).collect::<Vec<_>>()
                } else {
                    tree::sequences(db, build.view.root.as_deref(), state.cursor, 64).await?
                };
                if page.is_empty() {
                    state.phase = if state.warm
                        && build.format
                            == maka_agent_facts::model::prompt_source::WireFormat::Anthropic
                    {
                        1
                    } else {
                        2
                    };
                    state.cursor = -1;
                    continue;
                }
                for sequence in page {
                    sqlx::query("INSERT INTO context_prepared_wire_dirty(view_id,group_sequence) VALUES(?,?) ON CONFLICT(view_id,group_sequence) DO NOTHING").bind(&build.id).bind(sequence as i64).execute(&mut *db).await?;
                    state.cursor = sequence as i64;
                }
            }
            1 => {
                if state.affected.is_none() {
                    let sequence:Option<i64>=sqlx::query_scalar("SELECT group_sequence FROM context_prepared_dirty WHERE build_id=? AND group_sequence>? ORDER BY group_sequence LIMIT 1").bind(&build.view.build_id).bind(state.cursor).fetch_optional(&mut *db).await?;
                    let Some(sequence) = sequence else {
                        state.phase = 2;
                        state.cursor = -1;
                        continue;
                    };
                    state.affected = Some(
                        dependencies::Discovery::new(
                            db,
                            &build.view,
                            state.old_logical.as_deref(),
                            sequence as u64,
                        )
                        .await?,
                    );
                    state.cursor = sequence;
                }
                if state
                    .affected
                    .as_mut()
                    .expect("dependency cursor")
                    .advance(db, &build.view, &build.id)
                    .await?
                {
                    state.affected = None;
                }
            }
            2 => {
                let sequence:Option<i64>=sqlx::query_scalar("SELECT group_sequence FROM context_prepared_wire_dirty WHERE view_id=? AND group_sequence>? ORDER BY group_sequence LIMIT 1").bind(&build.id).bind(state.cursor).fetch_optional(&mut *db).await?;
                let Some(sequence) = sequence else {
                    ready = true;
                    break;
                };
                let content =
                    tree::content_id(db, build.view.root.as_deref(), sequence as u64).await?;
                let mut group = tree::group(db, &content).await?;
                if group.messages.is_empty() {
                    group.wire_id = Some(hash(b""));
                    group.wire_bytes = 0;
                    let content = tree::save_group(db, &group).await?;
                    assembly::stage(
                        db,
                        &runtime::InFlight::default(),
                        assembly::Kind::Wire,
                        &build.id,
                        sequence as u64,
                        &content,
                    )
                    .await?;
                }
                state.cursor = sequence;
            }
            _ => unreachable!(),
        }
    }
    if ready {
        sqlx::query(
            "UPDATE context_prepared_wire_views SET discovered=1,discovery_root=NULL WHERE id=?",
        )
        .bind(&build.id)
        .execute(db)
        .await?;
    }
    Ok(ready)
}

/// Publish small next-state only after the same batch has committed.
pub(super) async fn logical(
    db: &mut SqliteConnection,
    in_flight: &mut runtime::InFlight,
    build: &PreparedBuild,
) -> Result<bool, StoreError> {
    let key = runtime::InFlight::key(assembly::Kind::Logical, &build.id);
    let Some(runtime::Generation::Logical(state)) = in_flight.generations.get(&key) else {
        return Ok(true);
    };
    let mut next = state.clone();
    let mut tx = db.begin().await?;
    match logical_batch(&mut tx, build, &mut next).await {
        Ok(ready) => {
            tx.commit().await.map_err(StoreError::CommitUnknown)?;
            in_flight.generations.insert(
                key,
                if ready {
                    runtime::Generation::Rendering
                } else {
                    runtime::Generation::Logical(next)
                },
            );
            Ok(ready)
        }
        Err(cause) => match tx.rollback().await {
            Ok(()) => Err(cause),
            Err(cleanup) => Err(StoreError::PreparedRollbackFailed {
                cause: Box::new(cause),
                cleanup,
            }),
        },
    }
}
pub(super) async fn wire(
    db: &mut SqliteConnection,
    in_flight: &mut runtime::InFlight,
    build: &PreparedWireBuild,
) -> Result<bool, StoreError> {
    let key = runtime::InFlight::key(assembly::Kind::Wire, &build.id);
    let Some(runtime::Generation::Wire(state)) = in_flight.generations.get(&key) else {
        return Ok(true);
    };
    let mut next = state.clone();
    let mut tx = db.begin().await?;
    match wire_batch(&mut tx, build, &mut next).await {
        Ok(ready) => {
            tx.commit().await.map_err(StoreError::CommitUnknown)?;
            in_flight.generations.insert(
                key,
                if ready {
                    runtime::Generation::Rendering
                } else {
                    runtime::Generation::Wire(next)
                },
            );
            Ok(ready)
        }
        Err(cause) => match tx.rollback().await {
            Ok(()) => Err(cause),
            Err(cleanup) => Err(StoreError::PreparedRollbackFailed {
                cause: Box::new(cause),
                cleanup,
            }),
        },
    }
}
