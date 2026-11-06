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

//! Observer-owned disposable read models and bounded optional row bodies.
use super::read::sql_position;
use crate::StoreError;
use maka_agent_facts::history::RowPosition;
use rusqlite::{Connection, OptionalExtension};

use sha2::{Digest, Sha256};

// Retained row/text bodies target 32 MiB, independently of directory/FTS metadata.
// One active producer may exceed the target to avoid repeated fragment emission.
// This does not bound a complete operation's projection or live journal peak.
const RETAINED_BYTES: i64 = 32 * 1024 * 1024;

pub(crate) fn initialize(db: &Connection) -> Result<(), StoreError> {
    db.execute_batch(
        "PRAGMA temp_store=FILE;
         PRAGMA temp.page_size=4096;
         PRAGMA temp.auto_vacuum=FULL;
         PRAGMA temp.cache_size=-4096;
         PRAGMA temp.synchronous=OFF;
         PRAGMA temp.journal_mode=DELETE;
         CREATE TABLE temp.transcript_rows (
             owner_key TEXT NOT NULL, source_sequence INTEGER NOT NULL CHECK(source_sequence>=1),
             item_index INTEGER NOT NULL CHECK(item_index>=0), turn_id TEXT NOT NULL,
             message_id TEXT NOT NULL, payload BLOB NOT NULL, digest TEXT NOT NULL,
             total_bytes INTEGER NOT NULL CHECK(total_bytes>0),
             PRIMARY KEY(owner_key,source_sequence,item_index), UNIQUE(owner_key,message_id)
         );
         CREATE TABLE temp.transcript_text (
             owner_key TEXT NOT NULL, source_sequence INTEGER NOT NULL CHECK(source_sequence>=1),
             item_index INTEGER NOT NULL CHECK(item_index>=0),
             field TEXT NOT NULL CHECK(field IN ('body','thinking')),
             timestamp INTEGER NOT NULL, role TEXT NOT NULL, body BLOB NOT NULL,
             PRIMARY KEY(owner_key,source_sequence,item_index,field)
         );
         CREATE TABLE temp.transcript_sessions (
             owner_key TEXT PRIMARY KEY, copy_identity TEXT
         );
         CREATE TABLE temp.transcript_active_source (
             singleton INTEGER PRIMARY KEY CHECK(singleton=1),
             owner_key TEXT NOT NULL, source_sequence INTEGER NOT NULL
         );",
    )?;
    db.execute_batch(include_str!("read_cache.sql"))?;
    db.execute_batch(
        "CREATE TEMP TABLE transcript_body_cache_bytes (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1), bytes INTEGER NOT NULL CHECK(bytes>=0)
         );
         INSERT INTO temp.transcript_body_cache_bytes VALUES(1,0);
         CREATE TEMP TRIGGER transcript_rows_bytes_insert AFTER INSERT ON transcript_rows BEGIN
            UPDATE transcript_body_cache_bytes SET bytes=bytes+new.total_bytes;
         END;
         CREATE TEMP TRIGGER transcript_rows_bytes_delete AFTER DELETE ON transcript_rows BEGIN
            UPDATE transcript_body_cache_bytes SET bytes=bytes-old.total_bytes;
         END;
         CREATE TEMP TRIGGER transcript_rows_bytes_update AFTER UPDATE ON transcript_rows BEGIN
            UPDATE transcript_body_cache_bytes SET bytes=bytes+new.total_bytes-old.total_bytes;
         END;
         CREATE TEMP TRIGGER transcript_text_bytes_insert AFTER INSERT ON transcript_text BEGIN
            UPDATE transcript_body_cache_bytes SET bytes=bytes+length(new.body);
         END;
         CREATE TEMP TRIGGER transcript_text_bytes_delete AFTER DELETE ON transcript_text BEGIN
            UPDATE transcript_body_cache_bytes SET bytes=bytes-length(old.body);
         END;
         CREATE TEMP TRIGGER transcript_text_bytes_update AFTER UPDATE ON transcript_text BEGIN
            UPDATE transcript_body_cache_bytes SET bytes=bytes+length(new.body)-length(old.body);
         END;",
    )?;
    Ok(())
}

/// Keep every ensured row pinned until the original operation has consumed it,
/// including final history boundaries. All work stays on the observation owner.
pub(crate) fn run<T>(
    db: &rusqlite::Connection,
    read: impl FnOnce(&rusqlite::Connection) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    let tx = rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Deferred)?;
    let before: i64 = tx.query_row("SELECT total_changes()", rusqlite::params![], |row| {
        row.get(0)
    })?;
    match read(&tx) {
        Ok(value) => {
            let after: i64 =
                tx.query_row("SELECT total_changes()", rusqlite::params![], |row| {
                    row.get(0)
                })?;
            tx.commit()?;
            // Cache fills and retained-source changes require maintenance.
            // An unchanged fragment cannot add reclaimable bodies, even
            // when its retained producer alone exceeds the page target.
            if after != before {
                trim(db)?;
            }
            Ok(value)
        }
        Err(StoreError::TranscriptSource { cause, .. }) => match tx.commit() {
            Ok(()) => Err(*cause),
            Err(transaction) => Err(StoreError::ReadCacheTransaction { cause, transaction }),
        },
        Err(error) => match tx.rollback() {
            Ok(()) => Err(error),
            Err(transaction) => Err(StoreError::ReadCacheTransaction {
                cause: Box::new(error),
                transaction,
            }),
        },
    }
}

pub(crate) fn purge(db: &Connection, session: &str) -> Result<(), StoreError> {
    let tx = rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Deferred)?;
    for table in [
        "transcript_text",
        "transcript_rows",
        "transcript_sessions",
        "transcript_active_source",
        "transcript_directory",
        "transcript_failures",
        "transcript_directory_progress",
        "recall_progress",
    ] {
        let query = format!("DELETE FROM temp.{table} WHERE owner_key=?");
        tx.execute(query.as_str(), rusqlite::params![session])?;
    }
    tx.commit()?;
    Ok(())
}

fn trim(db: &Connection) -> Result<(), StoreError> {
    let bytes: i64 = db.query_row(
        "SELECT bytes FROM temp.transcript_body_cache_bytes WHERE singleton=1",
        rusqlite::params![],
        |row| row.get(0),
    )?;
    if bytes <= RETAINED_BYTES {
        return Ok(());
    }
    let tx = rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Deferred)?;
    tx.execute_batch("DELETE FROM temp.transcript_text WHERE NOT EXISTS (
             SELECT 1 FROM temp.transcript_active_source a
             WHERE a.owner_key=transcript_text.owner_key AND a.source_sequence=transcript_text.source_sequence
         );
         DELETE FROM temp.transcript_rows WHERE NOT EXISTS (
             SELECT 1 FROM temp.transcript_active_source a
             WHERE a.owner_key=transcript_rows.owner_key AND a.source_sequence=transcript_rows.source_sequence
         );
         DELETE FROM temp.transcript_sessions WHERE NOT EXISTS (
             SELECT 1 FROM temp.transcript_rows r WHERE r.owner_key=transcript_sessions.owner_key
         );")
    ?;
    // FULL auto-vacuum reclaims free database pages at this commit, including
    // an opened temporary backing file. DELETE alone would retain high-water.
    tx.commit()?;
    Ok(())
}

fn retain_source(db: &rusqlite::Connection, session: &str, source: i64) -> Result<(), StoreError> {
    db.execute("INSERT INTO temp.transcript_active_source VALUES(1,?1,?2)
        ON CONFLICT(singleton) DO UPDATE SET owner_key=excluded.owner_key,source_sequence=excluded.source_sequence
        WHERE transcript_active_source.owner_key!=excluded.owner_key OR transcript_active_source.source_sequence!=excluded.source_sequence", rusqlite::params![session, source])?;
    Ok(())
}

pub(super) fn ensure(
    tx: &Connection,
    session: &str,
    position: RowPosition,
) -> Result<(), StoreError> {
    ensure_on_worker(tx, session, position)
}

pub(super) fn ensure_on_worker(
    db: &rusqlite::Connection,
    session: &str,
    position: RowPosition,
) -> Result<(), StoreError> {
    ensure_for_owner_on_worker(
        db,
        &super::HistoryOwner::Session(session.to_owned()),
        position,
    )
}

pub(super) fn ensure_for_owner_on_worker(
    db: &rusqlite::Connection,
    owner: &super::HistoryOwner,
    position: RowPosition,
) -> Result<(), StoreError> {
    let session = owner.key();
    let (source, item) = sql_position(position)?;
    let (turn, message, copy_identity): (String, String, Option<String>) = db.query_row("SELECT turn_id,message_id,(SELECT json_array(source_session_id,source_revision,through_sequence,observed_through,bundle_digest) FROM session_history_copies WHERE session_id=?1) FROM transcript_directory WHERE owner_key=?1 AND source_sequence=?2 AND item_index=?3", rusqlite::params![session, source, item], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?,))).optional()?
        .ok_or_else(|| StoreError::InvalidTransition("history row was not found".into()))?;
    // A copied base can replace previously readable bare claimants. Its durable
    // marker changes in the same snapshot as the directory, never on appends.
    let previous: Option<(Option<String>,)> = db
        .query_row(
            "SELECT copy_identity FROM temp.transcript_sessions WHERE owner_key=?",
            rusqlite::params![session],
            |row| Ok((row.get(0)?,)),
        )
        .optional()?;
    if previous
        .as_ref()
        .is_some_and(|(previous,)| previous != &copy_identity)
    {
        db.execute(
            "DELETE FROM temp.transcript_text WHERE owner_key=?",
            rusqlite::params![session],
        )?;
        db.execute(
            "DELETE FROM temp.transcript_rows WHERE owner_key=?",
            rusqlite::params![session],
        )?;
    }
    if previous.as_ref().map(|(identity,)| identity) != Some(&copy_identity) {
        db.execute("INSERT INTO temp.transcript_sessions VALUES(?,?) ON CONFLICT(owner_key) DO UPDATE SET copy_identity=excluded.copy_identity", rusqlite::params![session, copy_identity])?;
    }
    let cached: Option<(String, String)> = db.query_row("SELECT turn_id,message_id FROM temp.transcript_rows WHERE owner_key=?1 AND source_sequence=?2 AND item_index=?3", rusqlite::params![session, source, item], |row| Ok((row.get(0)?, row.get(1)?,))).optional()?;
    if let Some(identity) = cached {
        if identity != (turn, message) {
            return Err(StoreError::TranscriptConflict);
        }
        retain_source(db, session, source)?;
        return Ok(());
    }
    // S is the cache unit: emission already owns every original row from this
    // selected producer. Retain these rows once, never replayed earlier sources.
    // Text remains demand-driven per visited row. A hit needs no sibling fill.
    let rows = super::emit::source_for_owner_on_worker(db, owner, position.source_sequence)?;
    if !rows.iter().any(|row| row.position == position) {
        return Err(StoreError::TranscriptConflict);
    }
    let mut identity = db.prepare_cached("SELECT EXISTS(SELECT 1 FROM transcript_directory WHERE owner_key=?1 AND source_sequence=?2 AND item_index=?3 AND turn_id=?4 AND message_id=?5)")?;
    let mut insert = db.prepare_cached("INSERT OR IGNORE INTO temp.transcript_rows (owner_key,source_sequence,item_index,turn_id,message_id,payload,digest,total_bytes) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)")?;
    let mut verify = db.prepare_cached("SELECT EXISTS(SELECT 1 FROM temp.transcript_rows WHERE owner_key=?1 AND source_sequence=?2 AND item_index=?3 AND turn_id=?4 AND message_id=?5 AND payload=?6 AND digest=?7 AND total_bytes=?8)")?;
    for row in &rows {
        if row.position.source_sequence != position.source_sequence {
            return Err(StoreError::TranscriptConflict);
        }
        let (_, item) = sql_position(row.position)?;
        let matched: bool = identity.query_row(
            rusqlite::params![session, source, item, &row.message.turn_id, &row.message.id],
            |row| row.get(0),
        )?;
        if !matched {
            return Err(StoreError::TranscriptConflict);
        }
        let payload = serde_json::to_vec(&row.message)?;
        let bytes = i64::try_from(payload.len()).map_err(|_| StoreError::PrefixTooLarge)?;
        let digest = format!("sha256:{}", hex::encode(Sha256::digest(&payload)));
        let parameters = rusqlite::params![
            session,
            source,
            item,
            &row.message.turn_id,
            &row.message.id,
            &payload,
            &digest,
            bytes
        ];
        insert.execute(parameters)?;
        let matched: bool = verify.query_row(parameters, |row| row.get(0))?;
        if !matched {
            return Err(StoreError::TranscriptConflict);
        }
    }
    retain_source(db, session, source)?;
    Ok(())
}

#[cfg(test)]
mod tests;
