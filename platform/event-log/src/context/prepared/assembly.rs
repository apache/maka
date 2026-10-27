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

//! Bounded bulk merge with an owner-local execution frontier.
//! Only final dirty routes and immutable changed nodes are written to SQLite.
use super::*;
use runtime::{Generation, InFlight};

#[derive(Clone, Copy)]
pub(super) enum Kind {
    Logical,
    Wire,
}
impl Kind {
    pub(super) fn name(self) -> &'static str {
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
#[derive(Default, Clone)]
struct Progress {
    cursor: Option<i64>,
    pending: Option<i64>,
    carry: Option<i64>,
    root: Option<i64>,
    scanned: bool,
    merging: bool,
    ready: bool,
}
#[derive(Default)]
pub(super) struct State {
    progress: Progress,
    cart: Vec<Cart>,
    frames: Vec<Frame>,
}
struct Cart {
    sequence: i64,
    left: Option<i64>,
}
#[derive(Clone)]
struct Span {
    root: Option<String>,
    low: i64,
    high: i64,
}
#[derive(Clone)]
struct Frame {
    low: i64,
    high: i64,
    base: Span,
    dirty: Option<i64>,
    phase: u8,
    sequence: i64,
    content: String,
    left: Option<String>,
    right: Option<String>,
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
            left: None,
            right: None,
        }
    }
}
enum Undo {
    CartPush,
    CartPop(Cart),
    FramePush,
    FramePop(Frame),
    FrameReplace(Frame),
}
impl State {
    fn push_cart(&mut self, value: Cart, undo: &mut Vec<Undo>) {
        self.cart.push(value);
        undo.push(Undo::CartPush);
    }
    fn pop_cart(&mut self, undo: &mut Vec<Undo>) -> i64 {
        let value = self.cart.pop().expect("pending Cartesian frontier");
        let sequence = value.sequence;
        undo.push(Undo::CartPop(value));
        sequence
    }
    fn push_frame(&mut self, value: Frame, undo: &mut Vec<Undo>) {
        self.frames.push(value);
        undo.push(Undo::FramePush);
    }
    fn replace_frame(&mut self, value: Frame, undo: &mut Vec<Undo>) {
        undo.push(Undo::FrameReplace(std::mem::replace(
            self.frames.last_mut().expect("active merge frame"),
            value,
        )));
    }
    fn rollback(&mut self, progress: Progress, undo: Vec<Undo>) {
        for change in undo.into_iter().rev() {
            match change {
                Undo::CartPush => {
                    self.cart.pop();
                }
                Undo::CartPop(value) => self.cart.push(value),
                Undo::FramePush => {
                    self.frames.pop();
                }
                Undo::FramePop(value) => self.frames.push(value),
                Undo::FrameReplace(value) => {
                    *self.frames.last_mut().expect("undo merge frame") = value;
                }
            }
        }
        self.progress = progress;
    }
}
struct Dirty {
    content: String,
    left: Option<i64>,
    right: Option<i64>,
}
async fn dirty(
    db: &mut SqliteConnection,
    kind: Kind,
    id: &str,
    sequence: i64,
) -> Result<Dirty, StoreError> {
    let q = format!(
        "SELECT content,cart_left,cart_right FROM {} WHERE {}=? AND group_sequence=?",
        kind.dirty(),
        kind.key()
    );
    let row = sqlx::query(sqlx::AssertSqlSafe(q))
        .bind(id)
        .bind(sequence)
        .fetch_one(db)
        .await?;
    Ok(Dirty {
        content: row.try_get("content")?,
        left: row.try_get("cart_left")?,
        right: row.try_get("cart_right")?,
    })
}
async fn finalize(
    db: &mut SqliteConnection,
    kind: Kind,
    id: &str,
    cart: &Cart,
    right: Option<i64>,
) -> Result<(), StoreError> {
    let q = format!(
        "UPDATE {} SET cart_left=?,cart_right=? WHERE {}=? AND group_sequence=?",
        kind.dirty(),
        kind.key()
    );
    sqlx::query(sqlx::AssertSqlSafe(q))
        .bind(cart.left)
        .bind(right)
        .bind(id)
        .bind(cart.sequence)
        .execute(db)
        .await?;
    Ok(())
}
async fn deliver(
    db: &mut SqliteConnection,
    kind: Kind,
    id: &str,
    state: &mut State,
    undo: &mut Vec<Undo>,
    result: Option<String>,
) -> Result<(), StoreError> {
    let frame = state.frames.pop().expect("completed merge frame");
    undo.push(Undo::FramePop(frame));
    if let Some(parent) = state.frames.last() {
        let mut parent = parent.clone();
        if parent.phase == 1 {
            parent.phase = 2;
            parent.left = result;
        } else {
            parent.phase = 4;
            parent.right = result;
        }
        state.replace_frame(parent, undo);
    } else {
        let q = format!("UPDATE {} SET root=? WHERE id=?", kind.owner());
        sqlx::query(sqlx::AssertSqlSafe(q))
            .bind(result)
            .bind(id)
            .execute(db)
            .await?;
        state.progress.ready = true;
    }
    Ok(())
}
fn order(sequence: i64) -> (String, i64) {
    (tree::priority(sequence as u64), sequence)
}

/// The in-memory frontier changes atomically with this job's SQL transaction.
pub(super) async fn advance(
    db: &mut SqliteConnection,
    in_flight: &mut InFlight,
    kind: Kind,
    id: &str,
) -> Result<bool, StoreError> {
    let mut tx = db.begin().await?;
    require_discovered(&mut tx, kind, id).await?;
    let q = format!(
        "SELECT complete FROM {} WHERE id=? AND retiring=0",
        kind.owner()
    );
    if sqlx::query_scalar::<_, bool>(sqlx::AssertSqlSafe(q))
        .bind(id)
        .fetch_one(&mut *tx)
        .await?
    {
        tx.commit().await.map_err(StoreError::CommitUnknown)?;
        return Ok(true);
    }
    let key = InFlight::key(kind, id);
    let generation = in_flight
        .generations
        .get_mut(&key)
        .ok_or_else(|| invalid("prepared execution frontier is missing"))?;
    let started = matches!(generation, Generation::Rendering);
    if started {
        let q = format!(
            "SELECT EXISTS(SELECT 1 FROM {} WHERE {}=? AND (done=0 OR content IS NULL))",
            kind.dirty(),
            kind.key()
        );
        if sqlx::query_scalar::<_, bool>(sqlx::AssertSqlSafe(q))
            .bind(id)
            .fetch_one(&mut *tx)
            .await?
        {
            return Err(invalid("prepared view has unfinished groups"));
        }
        *generation = Generation::Assembling(State::default());
    }
    let Generation::Assembling(state) = generation else {
        return Err(invalid("prepared generation is not ready for assembly"));
    };
    let progress = state.progress.clone();
    let mut undo = Vec::new();
    match advance_batch(&mut tx, kind, id, state, &mut undo).await {
        Ok(ready) => {
            tx.commit().await.map_err(StoreError::CommitUnknown)?;
            Ok(ready)
        }
        Err(cause) => match tx.rollback().await {
            Ok(()) => {
                state.rollback(progress, undo);
                if started {
                    *generation = Generation::Rendering;
                }
                Err(cause)
            }
            Err(cleanup) => Err(StoreError::PreparedRollbackFailed {
                cause: Box::new(cause),
                cleanup,
            }),
        },
    }
}
async fn advance_batch(
    db: &mut SqliteConnection,
    kind: Kind,
    id: &str,
    state: &mut State,
    undo: &mut Vec<Undo>,
) -> Result<bool, StoreError> {
    for _ in 0..64 {
        if state.progress.ready {
            break;
        }
        if !state.progress.merging {
            if state.progress.pending.is_none() && !state.progress.scanned {
                let q = format!(
                    "SELECT group_sequence FROM {} WHERE {}=? AND group_sequence>? ORDER BY group_sequence LIMIT 1",
                    kind.dirty(),
                    kind.key()
                );
                state.progress.pending = sqlx::query_scalar(sqlx::AssertSqlSafe(q))
                    .bind(id)
                    .bind(state.progress.cursor.unwrap_or(-1))
                    .fetch_optional(&mut *db)
                    .await?;
                state.progress.scanned = state.progress.pending.is_none();
            }
            let pop = state.cart.last().is_some_and(|top| {
                state
                    .progress
                    .pending
                    .is_none_or(|current| order(top.sequence) > order(current))
            });
            if pop {
                finalize(
                    db,
                    kind,
                    id,
                    state.cart.last().expect("Cartesian top"),
                    state.progress.carry,
                )
                .await?;
                state.progress.carry = Some(state.pop_cart(undo));
                continue;
            }
            if let Some(sequence) = state.progress.pending.take() {
                let left = state.progress.carry.take();
                state.push_cart(Cart { sequence, left }, undo);
                state.progress.cursor = Some(sequence);
                continue;
            }
            state.progress.root = state.progress.carry.take();
            let q = format!("SELECT root FROM {} WHERE id=?", kind.owner());
            let base = Span {
                root: sqlx::query_scalar(sqlx::AssertSqlSafe(q))
                    .bind(id)
                    .fetch_one(&mut *db)
                    .await?,
                low: -1,
                high: i64::MAX,
            };
            state.push_frame(Frame::new(-1, i64::MAX, base, state.progress.root), undo);
            state.progress.merging = true;
            continue;
        }
        let mut f = state.frames.last().expect("active merge frame").clone();
        let (left, right) = (f.left.clone(), f.right.clone());
        if f.phase == 4 {
            let n = tree::compose(db, f.sequence as u64, f.content, left, right).await?;
            let result = tree::save(db, &n).await?;
            sqlx::query("INSERT INTO context_prepared_generation_nodes(kind,owner_id,node_id) VALUES(?,?,?) ON CONFLICT(kind,owner_id,node_id) DO NOTHING")
                .bind(kind.name()).bind(id).bind(&result).execute(&mut *db).await?;
            deliver(db, kind, id, state, undo, Some(result)).await?;
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
                    state.replace_frame(f, undo);
                    continue;
                }
                if sequence >= f.high {
                    f.base.high = sequence;
                    f.base.root = n.left.clone();
                    state.replace_frame(f, undo);
                    continue;
                }
            }
            if let (Some(sequence), Some(n)) = (f.dirty, &update)
                && (sequence <= f.low || sequence >= f.high)
            {
                f.dirty = if sequence <= f.low { n.right } else { n.left };
                state.replace_frame(f, undo);
                continue;
            }
            if f.dirty.is_none()
                && (f.base.root.is_none() || (f.low <= f.base.low && f.high >= f.base.high))
            {
                deliver(db, kind, id, state, undo, f.base.root).await?;
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
        state.replace_frame(f, undo);
        state.push_frame(child, undo);
    }
    Ok(state.progress.ready)
}

/// Staging is write-once, including retries before finish starts.
pub(super) async fn stage(
    db: &mut SqliteConnection,
    in_flight: &InFlight,
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
    if in_flight.assembling(kind, id) {
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
        "SELECT discovered FROM {} WHERE id=? AND retiring=0",
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
