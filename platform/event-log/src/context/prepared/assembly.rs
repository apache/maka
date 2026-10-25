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

//! Build a frozen dirty generation without publishing intermediate tree roots.
//!
//! Dirty rows hold groups alive. Their Cartesian links and the traversal stack
//! live on disk, so a pathological treap height cannot exhaust process memory.
//! Each owner job performs a fixed number of steps; dropping its caller leaves
//! all temporary ownership with the original build's bounded retirement path.
use super::*;

#[derive(Clone, Copy)]
pub(super) enum Kind {
    Logical,
    Wire,
}
impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Logical => "build",
            Self::Wire => "wire_view",
        }
    }
    fn dirty(self) -> &'static str {
        match self {
            Self::Logical => "context_prepared_dirty",
            Self::Wire => "context_prepared_wire_dirty",
        }
    }
    fn key(self) -> &'static str {
        match self {
            Self::Logical => "build_id",
            Self::Wire => "view_id",
        }
    }
    fn owner(self) -> &'static str {
        match self {
            Self::Logical => "context_prepared_builds",
            Self::Wire => "context_prepared_wire_views",
        }
    }
}
#[derive(Default, Serialize, Deserialize)]
struct State {
    cursor: Option<i64>,
    top: Option<i64>,
    root: Option<i64>,
    pending: Option<i64>,
    popped: Option<i64>,
    merging: bool,
    ready: bool,
    depth: i64,
}
#[derive(Clone, Serialize, Deserialize)]
struct Span {
    root: Option<String>,
    low: i64,
    high: i64,
}
#[derive(Clone, Serialize, Deserialize)]
struct Frame {
    low: i64,
    high: i64,
    base: Span,
    dirty: Option<i64>,
    phase: u8,
    sequence: i64,
    content: String,
}
impl Frame {
    fn new(low: i64, high: i64, base: Span, dirty: Option<i64>) -> Self {
        Self {
            low,
            high,
            base,
            dirty,
            phase: 0,
            sequence: 0,
            content: String::new(),
        }
    }
}
struct Dirty {
    content: String,
    left: Option<i64>,
    right: Option<i64>,
    parent: Option<i64>,
}
async fn dirty(
    db: &mut SqliteConnection,
    kind: Kind,
    id: &str,
    sequence: i64,
) -> Result<Dirty, StoreError> {
    let q = format!(
        "SELECT content,cart_left,cart_right,cart_parent FROM {} WHERE {}=? AND group_sequence=?",
        kind.dirty(),
        kind.key()
    );
    let r = sqlx::query(sqlx::AssertSqlSafe(q))
        .bind(id)
        .bind(sequence)
        .fetch_one(db)
        .await?;
    Ok(Dirty {
        content: r.try_get("content")?,
        left: r.try_get("cart_left")?,
        right: r.try_get("cart_right")?,
        parent: r.try_get("cart_parent")?,
    })
}
async fn link(
    db: &mut SqliteConnection,
    kind: Kind,
    id: &str,
    sequence: i64,
    column: &str,
    target: Option<i64>,
) -> Result<(), StoreError> {
    let q = format!(
        "UPDATE {} SET {column}=? WHERE {}=? AND group_sequence=?",
        kind.dirty(),
        kind.key()
    );
    sqlx::query(sqlx::AssertSqlSafe(q))
        .bind(target)
        .bind(id)
        .bind(sequence)
        .execute(db)
        .await?;
    Ok(())
}
async fn write_frame(
    db: &mut SqliteConnection,
    kind: Kind,
    id: &str,
    depth: i64,
    frame: &Frame,
) -> Result<(), StoreError> {
    sqlx::query("INSERT INTO context_prepared_frames(kind,owner_id,depth,frame_json) VALUES(?,?,?,?) ON CONFLICT(kind,owner_id,depth) DO UPDATE SET frame_json=excluded.frame_json")
        .bind(kind.name()).bind(id).bind(depth).bind(encoded(frame)?).execute(db).await?;
    Ok(())
}
async fn read_frame(
    db: &mut SqliteConnection,
    kind: Kind,
    id: &str,
    depth: i64,
) -> Result<(Frame, Option<String>, Option<String>), StoreError> {
    let r=sqlx::query("SELECT frame_json,left_root,right_root FROM context_prepared_frames WHERE kind=? AND owner_id=? AND depth=?")
        .bind(kind.name()).bind(id).bind(depth).fetch_one(db).await?;
    Ok((
        serde_json::from_str(r.try_get("frame_json")?)?,
        r.try_get("left_root")?,
        r.try_get("right_root")?,
    ))
}
// Transfer ownership before deleting the child frame, in the same transaction.
async fn deliver(
    db: &mut SqliteConnection,
    kind: Kind,
    id: &str,
    state: &mut State,
    result: Option<String>,
) -> Result<(), StoreError> {
    if state.depth == 0 {
        let q = format!("UPDATE {} SET root=? WHERE id=?", kind.owner());
        sqlx::query(sqlx::AssertSqlSafe(q))
            .bind(&result)
            .bind(id)
            .execute(&mut *db)
            .await?;
        state.ready = true;
    } else {
        let (mut parent, _, _) = read_frame(db, kind, id, state.depth - 1).await?;
        let column = if parent.phase == 1 {
            parent.phase = 2;
            "left_root"
        } else {
            parent.phase = 4;
            "right_root"
        };
        let q = format!(
            "UPDATE context_prepared_frames SET frame_json=?,{column}=? WHERE kind=? AND owner_id=? AND depth=?"
        );
        sqlx::query(sqlx::AssertSqlSafe(q))
            .bind(encoded(&parent)?)
            .bind(result)
            .bind(kind.name())
            .bind(id)
            .bind(state.depth - 1)
            .execute(&mut *db)
            .await?;
    }
    sqlx::query("DELETE FROM context_prepared_frames WHERE kind=? AND owner_id=? AND depth=?")
        .bind(kind.name())
        .bind(id)
        .bind(state.depth)
        .execute(db)
        .await?;
    state.depth = state.depth.saturating_sub(1);
    Ok(())
}
fn order(sequence: i64) -> (String, i64) {
    (tree::priority(sequence as u64), sequence)
}

/// Run inside a short owner transaction. `true` means the final root is attached.
pub(super) async fn advance(
    db: &mut SqliteConnection,
    kind: Kind,
    id: &str,
) -> Result<bool, StoreError> {
    require_discovered(db, kind, id).await?;
    let q = format!(
        "SELECT complete FROM {} WHERE id=? AND retiring=0",
        kind.owner()
    );
    if sqlx::query_scalar::<_, bool>(sqlx::AssertSqlSafe(q))
        .bind(id)
        .fetch_one(&mut *db)
        .await?
    {
        return Ok(true);
    }
    let saved: Option<String> = sqlx::query_scalar(
        "SELECT state_json FROM context_prepared_assembly WHERE kind=? AND owner_id=?",
    )
    .bind(kind.name())
    .bind(id)
    .fetch_optional(&mut *db)
    .await?;
    let mut state = if let Some(saved) = saved {
        serde_json::from_str::<State>(&saved)?
    } else {
        let q = format!(
            "SELECT EXISTS(SELECT 1 FROM {} WHERE {}=? AND (done=0 OR content IS NULL))",
            kind.dirty(),
            kind.key()
        );
        if sqlx::query_scalar::<_, bool>(sqlx::AssertSqlSafe(q))
            .bind(id)
            .fetch_one(&mut *db)
            .await?
        {
            return Err(invalid("prepared view has unfinished groups"));
        }
        State::default()
    };
    for _ in 0..64 {
        if state.ready {
            break;
        }
        if !state.merging {
            if state.pending.is_none() {
                let q = format!(
                    "SELECT group_sequence FROM {} WHERE {}=? AND group_sequence>? ORDER BY group_sequence LIMIT 1",
                    kind.dirty(),
                    kind.key()
                );
                state.pending = sqlx::query_scalar(sqlx::AssertSqlSafe(q))
                    .bind(id)
                    .bind(state.cursor.unwrap_or(-1))
                    .fetch_optional(&mut *db)
                    .await?;
                if state.pending.is_none() {
                    let q = format!("SELECT root FROM {} WHERE id=?", kind.owner());
                    let base = Span {
                        root: sqlx::query_scalar(sqlx::AssertSqlSafe(q))
                            .bind(id)
                            .fetch_one(&mut *db)
                            .await?,
                        low: -1,
                        high: i64::MAX,
                    };
                    write_frame(db, kind, id, 0, &Frame::new(-1, i64::MAX, base, state.root))
                        .await?;
                    state.merging = true;
                    continue;
                }
            }
            let current = state.pending.expect("pending Cartesian item");
            if let Some(top) = state.top
                && order(top) > order(current)
            {
                state.popped = Some(top);
                state.top = dirty(db, kind, id, top).await?.parent;
                continue;
            }
            link(db, kind, id, current, "cart_left", state.popped).await?;
            link(db, kind, id, current, "cart_parent", state.top).await?;
            if let Some(top) = state.top {
                link(db, kind, id, top, "cart_right", Some(current)).await?;
            } else {
                state.root = Some(current);
            }
            state.top = Some(current);
            state.cursor = Some(current);
            state.pending = None;
            state.popped = None;
            continue;
        }
        let (mut f, left, right) = read_frame(db, kind, id, state.depth).await?;
        if f.phase == 4 {
            let n = tree::compose(db, f.sequence as u64, f.content, left, right).await?;
            let result = tree::save(db, &n).await?;
            deliver(db, kind, id, &mut state, Some(result)).await?;
            continue;
        }
        let base = if let Some(root) = &f.base.root {
            Some(tree::node(db, root).await?)
        } else {
            None
        };
        let update = if let Some(sequence) = f.dirty {
            Some(dirty(db, kind, id, sequence).await?)
        } else {
            None
        };
        if f.phase == 0 {
            // Normalize one edge per step. Keep native bounds distinct from the
            // requested interval: clipped subtrees must never be reused whole.
            if let Some(n) = &base {
                let sequence = n.sequence as i64;
                if sequence <= f.low {
                    f.base.low = sequence;
                    f.base.root = n.right.clone();
                    write_frame(db, kind, id, state.depth, &f).await?;
                    continue;
                }
                if sequence >= f.high {
                    f.base.high = sequence;
                    f.base.root = n.left.clone();
                    write_frame(db, kind, id, state.depth, &f).await?;
                    continue;
                }
            }
            if let (Some(sequence), Some(n)) = (f.dirty, &update)
                && (sequence <= f.low || sequence >= f.high)
            {
                f.dirty = if sequence <= f.low { n.right } else { n.left };
                write_frame(db, kind, id, state.depth, &f).await?;
                continue;
            }
            if f.dirty.is_none()
                && (f.base.root.is_none() || (f.low <= f.base.low && f.high >= f.base.high))
            {
                deliver(db, kind, id, &mut state, f.base.root).await?;
                continue;
            }
            let chosen_dirty = match (&base, f.dirty) {
                (None, _) => true,
                (Some(_), None) => false,
                (Some(n), Some(s)) => order(s) <= order(n.sequence as i64),
            };
            if chosen_dirty {
                f.sequence = f.dirty.expect("dirty root");
                f.content = update.as_ref().expect("dirty item").content.clone();
            } else {
                let n = base.as_ref().expect("base root");
                f.sequence = n.sequence as i64;
                f.content = n.content.clone();
            }
            f.phase = 1;
        } else {
            debug_assert_eq!(f.phase, 2);
            f.phase = 3;
        }
        let going_left = f.phase == 1;
        let mut child_base = f.base.clone();
        if let Some(n) = base
            && n.sequence as i64 == f.sequence
        {
            child_base.root = if going_left { n.left } else { n.right };
            if going_left {
                child_base.high = f.sequence;
            } else {
                child_base.low = f.sequence;
            }
        }
        let child_dirty = if f.dirty == Some(f.sequence) {
            let n = update.expect("dirty item");
            if going_left { n.left } else { n.right }
        } else {
            f.dirty
        };
        let child = if going_left {
            Frame::new(f.low, f.sequence, child_base, child_dirty)
        } else {
            Frame::new(f.sequence, f.high, child_base, child_dirty)
        };
        write_frame(db, kind, id, state.depth, &f).await?;
        state.depth += 1;
        write_frame(db, kind, id, state.depth, &child).await?;
    }
    sqlx::query("INSERT INTO context_prepared_assembly(kind,owner_id,state_json) VALUES(?,?,?) ON CONFLICT(kind,owner_id) DO UPDATE SET state_json=excluded.state_json")
        .bind(kind.name()).bind(id).bind(encoded(&state)?).execute(db).await?;
    Ok(state.ready)
}

/// Staging is write-once, including retries before finish starts.
pub(super) async fn stage(
    db: &mut SqliteConnection,
    kind: Kind,
    id: &str,
    sequence: u64,
    content: &str,
) -> Result<(), StoreError> {
    let q = format!(
        "SELECT content FROM {} WHERE {}=? AND group_sequence=?",
        kind.dirty(),
        kind.key()
    );
    let old: Option<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(q))
        .bind(id)
        .bind(sequence as i64)
        .fetch_one(&mut *db)
        .await?;
    if let Some(old) = old {
        if old != content {
            return Err(invalid("prepared group differs from frozen rendering"));
        }
        return Ok(());
    }
    let frozen: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM context_prepared_assembly WHERE kind=? AND owner_id=?)",
    )
    .bind(kind.name())
    .bind(id)
    .fetch_one(&mut *db)
    .await?;
    if frozen {
        return Err(invalid("prepared generation is frozen"));
    }
    let q = format!(
        "UPDATE {} SET content=?,done=1 WHERE {}=? AND group_sequence=?",
        kind.dirty(),
        kind.key()
    );
    sqlx::query(sqlx::AssertSqlSafe(q))
        .bind(content)
        .bind(id)
        .bind(sequence as i64)
        .execute(db)
        .await?;
    Ok(())
}

pub(super) async fn require_discovered(
    db: &mut SqliteConnection,
    kind: Kind,
    id: &str,
) -> Result<(), StoreError> {
    let q = format!(
        "SELECT discovery_json IS NULL FROM {} WHERE id=? AND retiring=0",
        kind.owner()
    );
    if !sqlx::query_scalar::<_, bool>(sqlx::AssertSqlSafe(q))
        .bind(id)
        .fetch_one(db)
        .await?
    {
        return Err(invalid("prepared discovery is unfinished"));
    }
    Ok(())
}
