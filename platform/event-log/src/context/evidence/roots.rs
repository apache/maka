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

//! Writer-owned source progress. Each admitted event adds two fixed-size
//! prefix rows. Copy bases share a pinned prefix; no canonical bytes are read
//! when deriving a new selection, historical cut, or lineage identity.
use crate::StoreError;
use maka_agent_facts::{
    event::{Fact, StoredEvent},
    input::InvocationInput,
};
use rusqlite::{Connection, OptionalExtension, functions::FunctionFlags, params};
use sha2::{Digest, Sha256};
use sqlx::sqlite::SqliteWorkerConnection;

const NATIVE: &str = "SELECT sequence,hash,ordinal FROM context_source_prefixes WHERE kind=? AND owner=? AND sequence<=? ORDER BY sequence DESC LIMIT 1";

#[derive(Clone)]
struct Prefix {
    high: i64,
    hash: Vec<u8>,
    count: i64,
}
impl Prefix {
    fn empty() -> Self {
        Self {
            high: 0,
            count: 0,
            hash: Sha256::digest(b"maka.source.empty.v1\0").to_vec(),
        }
    }
}
fn hash(domain: &[u8], parts: &[&[u8]]) -> Vec<u8> {
    let mut hash = Sha256::new();
    hash.update(domain);
    for part in parts {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part);
    }
    hash.finalize().to_vec()
}
/// Root prefixes already read every raw event; retain their source chain only for that read.
pub(crate) struct RootDigest(Vec<u8>);

impl RootDigest {
    pub(crate) fn new() -> Self {
        Self(Prefix::empty().hash)
    }

    pub(crate) fn record(&mut self, sequence: i64, json: &str) {
        let sequence = sequence.to_be_bytes();
        let leaf = hash(b"maka.source.leaf.v1\0", &[&sequence, json.as_bytes()]);
        self.0 = hash(b"maka.source.chain.v1\0", &[&self.0, &sequence, &leaf]);
    }

    pub(crate) fn finish(self, cut: i64) -> Result<String, StoreError> {
        let scope = serde_json::to_vec(&maka_agent_facts::event::LogScope::Root)?;
        let mut state = selection_state(&scope, cut);
        selection_component(&mut state, b"all", "", &self.0);
        Ok(format!("sha256:{}", hex::encode(state.finalize())))
    }
}

fn native(db: &Connection, kind: &str, owner: &str, cut: i64) -> rusqlite::Result<Prefix> {
    Ok(db
        .query_row(NATIVE, params![kind, owner, cut], |row| {
            Ok(Prefix {
                high: row.get(0)?,
                hash: row.get(1)?,
                count: row.get(2)?,
            })
        })
        .optional()?
        .unwrap_or_else(Prefix::empty))
}
fn combine(base: Prefix, tail: Prefix) -> Prefix {
    if base.high == 0 {
        return tail;
    }
    if tail.high == 0 {
        return base;
    }
    Prefix {
        high: base.high.max(tail.high),
        count: base.count + tail.count,
        hash: hash(b"maka.source.copy.v1\0", &[&base.hash, &tail.hash]),
    }
}
type CopyPrefixRow = (String, i64, Option<i64>, Option<Vec<u8>>);

fn session_prefix(db: &Connection, owner: &str, cut: i64) -> rusqlite::Result<Prefix> {
    let mut owner = owner.to_owned();
    let mut cut = cut;
    let mut tails = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut base = loop {
        if !seen.insert(owner.clone()) {
            return Err(rusqlite::Error::InvalidParameterName(
                "source copy cycle".into(),
            ));
        }
        tails.push(native(db, "session", &owner, cut)?);
        let copy: Option<CopyPrefixRow> = db.query_row(
            "SELECT source,through_sequence,base_high,base_hash FROM context_source_copies WHERE owner=?",[&owner],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional()?;
        let Some((source, through, high, pinned)) = copy else {
            break Prefix::empty();
        };
        if cut >= through
            && let (Some(high), Some(hash)) = (high, pinned)
        {
            break Prefix {
                high,
                hash,
                count: 0,
            };
        }
        owner = source;
        cut = cut.min(through);
    };
    for tail in tails.into_iter().rev() {
        base = combine(base, tail);
    }
    Ok(base)
}
async fn native_on_worker(
    db: &mut SqliteWorkerConnection<'_>,
    kind: &str,
    owner: &str,
    cut: i64,
) -> Result<Prefix, StoreError> {
    let row: Option<(i64, Vec<u8>, i64)> = sqlx::query_as(NATIVE)
        .bind(kind)
        .bind(owner)
        .bind(cut)
        .fetch_optional(db)
        .await?;
    Ok(
        row.map_or_else(Prefix::empty, |(high, hash, count)| Prefix {
            high,
            hash,
            count,
        }),
    )
}

pub(crate) async fn record(
    db: &mut SqliteWorkerConnection<'_>,
    stored: &StoredEvent,
    canonical_json: &str,
) -> Result<(), StoreError> {
    let sequence = i64::try_from(stored.sequence).map_err(|_| StoreError::PrefixTooLarge)?;
    let event = &stored.event;
    let leaf = hash(
        b"maka.source.leaf.v1\0",
        &[&sequence.to_be_bytes(), canonical_json.as_bytes()],
    );
    for (kind, owner) in [
        ("session", event.invocation.session_id.as_str()),
        ("invocation", event.invocation.invocation_id.as_str()),
    ] {
        let previous = native_on_worker(db, kind, owner, i64::MAX).await?;
        if previous.high >= sequence {
            return Err(rusqlite::Error::InvalidParameterName(
                "source append is not monotonic".into(),
            )
            .into());
        }
        let next = hash(
            b"maka.source.chain.v1\0",
            &[&previous.hash, &sequence.to_be_bytes(), &leaf],
        );
        sqlx::query("INSERT INTO context_source_prefixes VALUES(?,?,?,?,?)")
            .bind(kind)
            .bind(owner)
            .bind(sequence)
            .bind(next)
            .bind(previous.count + 1)
            .execute(&mut *db)
            .await?;
    }
    match &event.fact {
        Fact::InvocationOpened { input, .. } => record_lineage(db, stored, input).await?,
        Fact::ToolResultArchived { placeholder } => {
            record_archive(db, stored, placeholder, &leaf).await?
        }
        _ => {}
    }
    Ok(())
}

async fn session_high(
    db: &mut SqliteWorkerConnection<'_>,
    session: &str,
    through: i64,
) -> Result<i64, StoreError> {
    let mut owner = session.to_owned();
    let mut cut = through;
    let mut high = 0;
    let mut seen = std::collections::HashSet::new();
    loop {
        if !seen.insert(owner.clone()) {
            return Err(rusqlite::Error::InvalidParameterName("source copy cycle".into()).into());
        }
        high = high.max(native_on_worker(db, "session", &owner, cut).await?.high);
        let copy: Option<(String, i64, Option<i64>, bool)> = sqlx::query_as(
            "SELECT source,through_sequence,base_high,base_hash IS NOT NULL FROM context_source_copies WHERE owner=?",
        ).bind(&owner).fetch_optional(&mut *db).await?;
        let Some((source, through, pinned_high, pinned_hash)) = copy else {
            return Ok(high);
        };
        if cut >= through
            && pinned_hash
            && let Some(pinned) = pinned_high
        {
            return Ok(high.max(pinned));
        }
        owner = source;
        cut = cut.min(through);
    }
}

fn pin_copy(db: &Connection, owner: &str) -> rusqlite::Result<()> {
    let copy: Option<(String, i64)> = db
        .query_row(
            "SELECT source,through_sequence FROM context_source_copies WHERE owner=?",
            [owner],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((source, through)) = copy {
        let base = session_prefix(db, &source, through)?;
        db.execute(
            "UPDATE context_source_copies SET base_high=?,base_hash=? WHERE owner=?",
            params![base.high, base.hash, owner],
        )?;
    }
    // Copy membership has already been installed at this boundary. Prefixes
    // preserve its exact archive pins even for a later request at an old cut.
    let mut state = Sha256::new();
    state.update(b"maka.archive.copy.v1\0");
    let mut statement = db.prepare(
        "SELECT h.sequence,a.hash FROM session_history_members h
        JOIN context_archive_records a ON a.sequence=h.archive_sequence
        WHERE h.session_id=? ORDER BY h.sequence",
    )?;
    let mut rows = statement.query([owner])?;
    while let Some(row) = rows.next()? {
        let sequence: i64 = row.get(0)?;
        let archive: Vec<u8> = row.get(1)?;
        state.update(sequence.to_be_bytes());
        state.update(archive);
        db.execute("INSERT INTO context_archive_copy_prefixes VALUES(?,?,?) ON CONFLICT(owner,target_sequence) DO UPDATE SET hash=excluded.hash",
            params![owner,sequence,state.clone().finalize().to_vec()])?;
    }
    Ok(())
}
#[derive(serde::Deserialize)]
struct Lineage {
    base: u64,
    run: String,
}

fn ancestry(db: &Connection, invocation: &str, cut: i64) -> rusqlite::Result<Prefix> {
    let (through, root): (i64, Vec<u8>) = db.query_row(
        "SELECT ancestor_through,ancestry_hash FROM context_source_lineages WHERE invocation_id=?",
        [invocation],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if cut >= through {
        return Ok(Prefix {
            high: through,
            hash: root,
            count: 0,
        });
    }
    // A genuinely historical cut can precede a frozen ancestor endpoint.
    // SQLite orders only compact identity metadata; Rust retains one hash.
    let mut statement = db.prepare(
        "WITH RECURSIVE parents(invocation_id,depth) AS (
        SELECT parent_invocation_id,0 FROM context_source_lineages WHERE invocation_id=?1
        UNION ALL SELECT n.parent_invocation_id,p.depth+1 FROM context_source_lineages n
        JOIN parents p ON n.invocation_id=p.invocation_id WHERE n.parent_invocation_id IS NOT NULL)
        SELECT invocation_id FROM parents WHERE invocation_id IS NOT NULL ORDER BY depth DESC",
    )?;
    let mut rows = statement.query([invocation])?;
    let mut prefix = Prefix {
        high: 0,
        hash: Sha256::digest(b"maka.source.lineage.empty.v1\0").to_vec(),
        count: 0,
    };
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let part = native(db, "invocation", &id, cut)?;
        prefix.hash = hash(
            b"maka.source.lineage.link.v1\0",
            &[&prefix.hash, id.as_bytes(), &part.hash],
        );
        prefix.high = prefix.high.max(part.high);
    }
    Ok(prefix)
}
/// Ancestor membership uses at most one jump per set bit of the depth
/// difference. Branches at the same depth compare unequal; no ancestor list
/// or per-descendant transitive closure is constructed.
fn lineage_contains(db: &Connection, selected: &str, candidate: &str) -> rusqlite::Result<bool> {
    let depth = |id: &str| -> rusqlite::Result<Option<i64>> {
        db.query_row(
            "SELECT depth FROM context_lineage_depths WHERE invocation_id=?",
            [id],
            |row| row.get(0),
        )
        .optional()
    };
    let (Some(selected_depth), Some(candidate_depth)) = (depth(selected)?, depth(candidate)?)
    else {
        return Ok(false);
    };
    if candidate_depth > selected_depth {
        return Ok(false);
    }
    let mut remaining = (selected_depth - candidate_depth) as u64;
    let mut current = selected.to_owned();
    while remaining != 0 {
        let level = remaining.trailing_zeros();
        current = db.query_row(
            "SELECT ancestor_id FROM context_lineage_jumps WHERE invocation_id=? AND level=?",
            params![current, level],
            |row| row.get(0),
        )?;
        remaining &= remaining - 1;
    }
    Ok(current == candidate)
}

fn selection_state(scope: &[u8], cut: i64) -> Sha256 {
    let mut state = Sha256::new();
    state.update(b"maka.source.selection.v1\0");
    state.update((scope.len() as u64).to_be_bytes());
    state.update(scope);
    state.update(cut.to_be_bytes());
    state
}

fn selection_component(state: &mut Sha256, tag: &[u8], owner: &str, hash: &[u8]) {
    state.update((tag.len() as u64).to_be_bytes());
    state.update(tag);
    state.update((owner.len() as u64).to_be_bytes());
    state.update(owner.as_bytes());
    state.update(hash);
}

fn identity(
    db: &Connection,
    session: Option<&str>,
    lineage: Option<&str>,
    scope: &[u8],
    cut: i64,
) -> rusqlite::Result<String> {
    let mut state = selection_state(scope, cut);
    let mut high = 0;
    let mut component = |tag: &[u8], owner: &str, prefix: Prefix| {
        selection_component(&mut state, tag, owner, &prefix.hash);
        high = high.max(prefix.high);
    };
    if let Some(lineage) = lineage {
        let lineage: Lineage = serde_json::from_str(lineage)
            .map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))?;
        let session = session.ok_or(rusqlite::Error::InvalidQuery)?;
        let base = i64::try_from(lineage.base).map_err(|_| rusqlite::Error::InvalidQuery)?;
        component(
            b"base",
            session,
            session_prefix(db, session, cut.min(base))?,
        );
        component(b"ancestors", "", ancestry(db, &lineage.run, cut)?);
        component(
            b"run",
            &lineage.run,
            native(db, "invocation", &lineage.run, cut)?,
        );
    } else if let Some(session) = session {
        component(b"all", session, session_prefix(db, session, cut)?);
    } else {
        return Err(rusqlite::Error::InvalidQuery);
    }
    if high != cut {
        return Err(rusqlite::Error::InvalidParameterName(
            "coverage is not a selected source high-water".into(),
        ));
    }
    Ok(format!("sha256:{}", hex::encode(state.finalize())))
}

async fn record_lineage(
    db: &mut SqliteWorkerConnection<'_>,
    stored: &StoredEvent,
    input: &InvocationInput,
) -> Result<(), StoreError> {
    let event = &stored.event;
    let sequence = stored.sequence as i64;
    let (parent, base, through, root) = if matches!(input, InvocationInput::Message { .. }) {
        (
            None,
            session_high(db, &event.invocation.session_id, sequence - 1).await?,
            0,
            Sha256::digest(b"maka.source.lineage.empty.v1\0").to_vec(),
        )
    } else if let Some(claim) = input.inherited_claim() {
        let parent = claim.source.invocation.invocation_id.as_str();
        let prior: Vec<u8> = sqlx::query_scalar(
            "SELECT ancestry_hash FROM context_source_lineages WHERE invocation_id=?",
        )
        .bind(parent)
        .fetch_one(&mut *db)
        .await?;
        let part = native_on_worker(db, "invocation", parent, sequence - 1).await?;
        let root = hash(
            b"maka.source.lineage.link.v1\0",
            &[&prior, parent.as_bytes(), &part.hash],
        );
        (Some(parent), claim.base.high_water as i64, part.high, root)
    } else {
        return Ok(());
    };
    let identity = serde_json::to_string(&event.invocation)?;
    sqlx::query("INSERT INTO context_source_lineages VALUES(?,?,?,?,?,?,?)")
        .bind(&event.invocation.invocation_id)
        .bind(parent)
        .bind(base)
        .bind(through)
        .bind(root)
        .bind(sequence)
        .bind(identity)
        .execute(db)
        .await?;
    Ok(())
}

async fn record_archive(
    db: &mut SqliteWorkerConnection<'_>,
    stored: &StoredEvent,
    placeholder: &maka_agent_facts::archive::ArchivedPlaceholder,
    leaf: &[u8],
) -> Result<(), StoreError> {
    let event = &stored.event;
    let (target, invocation, identity, operation, is_error): (i64, String, String, String, bool) =
        sqlx::query_as("SELECT sequence,invocation_id,json_extract(event_json,'$.invocation'),operation_id,
           json_extract(event_json,'$.fact.outcome.kind')='failed' FROM runtime_events WHERE event_id=?")
            .bind(&placeholder.identity.runtime_event_id).fetch_one(&mut *db).await?;
    let encoded = serde_json::to_string(placeholder)?;
    sqlx::query("INSERT INTO context_archive_records VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .bind(stored.sequence as i64)
        .bind(&event.invocation.session_id)
        .bind(&event.invocation.invocation_id)
        .bind(target)
        .bind(invocation)
        .bind(&placeholder.identity.runtime_event_id)
        .bind(leaf)
        .bind(encoded)
        .bind(identity)
        .bind(operation)
        .bind(is_error)
        .execute(db)
        .await?;
    Ok(())
}

pub(crate) fn register(db: &Connection) -> Result<(), StoreError> {
    // SQLite owns these borrowed handles. Nested statements are synchronous
    // and finish on the same worker/transaction before the callback returns.
    db.create_scalar_function(
        "context_lineage_contains",
        2,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DIRECTONLY,
        |ctx| {
            let selected: Option<String> = ctx.get(0)?;
            let candidate: String = ctx.get(1)?;
            let Some(selected) = selected else {
                return Ok(false);
            };
            let db = unsafe { ctx.get_connection() }?;
            lineage_contains(&db, &selected, &candidate)
        },
    )?;
    db.create_scalar_function(
        "context_source_pin_copy",
        1,
        FunctionFlags::SQLITE_UTF8,
        |ctx| {
            let owner: String = ctx.get(0)?;
            let db = unsafe { ctx.get_connection() }?;
            pin_copy(&db, &owner)?;
            Ok(0)
        },
    )?;
    db.create_scalar_function(
        "context_source_identity",
        4,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DIRECTONLY,
        |ctx| {
            let session: Option<String> = ctx.get(0)?;
            let lineage: Option<String> = ctx.get(1)?;
            let scope: Vec<u8> = ctx.get(2)?;
            let cut: i64 = ctx.get(3)?;
            let db = unsafe { ctx.get_connection() }?;
            let result = match identity(&db, session.as_deref(), lineage.as_deref(), &scope, cut) {
                Ok(value) => Ok(value),
                Err(rusqlite::Error::InvalidParameterName(message)) => Err(message),
                Err(error) => return Err(error),
            };
            serde_json::to_string(&result)
                .map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))
        },
    )?;
    Ok(())
}
