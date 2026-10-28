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

//! Optional bodies for selected directory rows. This never repairs metadata.
use super::read::sql_position;
use crate::StoreError;
use maka_agent_facts::history::RowPosition;
use sha2::{Digest, Sha256};
use sqlx::sqlite::SqliteWorkerConnection;
use sqlx::{Connection, QueryBuilder, Sqlite, SqliteConnection};

// The ordinary retained database is at most 32 MiB. One active producer may
// exceed that target so tiny fragment/sibling reads do not repeatedly emit it.
// This does not bound a complete operation's projection or live journal peak.
const RETAINED_PAGES: i64 = 8192;

pub(crate) async fn initialize(db: &mut SqliteConnection) -> Result<(), StoreError> {
    sqlx::raw_sql(
        "PRAGMA temp_store=FILE;
         PRAGMA temp.page_size=4096;
         PRAGMA temp.auto_vacuum=FULL;
         PRAGMA temp.cache_size=-4096;
         PRAGMA temp.synchronous=OFF;
         PRAGMA temp.journal_mode=DELETE;
         CREATE TABLE temp.transcript_rows (
             session_id TEXT NOT NULL, source_sequence INTEGER NOT NULL CHECK(source_sequence>=1),
             item_index INTEGER NOT NULL CHECK(item_index>=0), turn_id TEXT NOT NULL,
             message_id TEXT NOT NULL, payload BLOB NOT NULL, digest TEXT NOT NULL,
             total_bytes INTEGER NOT NULL CHECK(total_bytes>0),
             PRIMARY KEY(session_id,source_sequence,item_index), UNIQUE(session_id,message_id)
         );
         CREATE TABLE temp.transcript_text (
             session_id TEXT NOT NULL, source_sequence INTEGER NOT NULL CHECK(source_sequence>=1),
             item_index INTEGER NOT NULL CHECK(item_index>=0),
             field TEXT NOT NULL CHECK(field IN ('body','thinking')),
             timestamp INTEGER NOT NULL, role TEXT NOT NULL, body BLOB NOT NULL,
             PRIMARY KEY(session_id,source_sequence,item_index,field)
         );
         CREATE TABLE temp.transcript_sessions (
             session_id TEXT PRIMARY KEY, copy_identity TEXT
         );
         CREATE TABLE temp.transcript_active_source (
             singleton INTEGER PRIMARY KEY CHECK(singleton=1),
             session_id TEXT NOT NULL, source_sequence INTEGER NOT NULL
         );",
    )
    .execute(&mut *db)
    .await?;
    Ok(())
}

/// Keep every ensured row pinned until the original operation has consumed it,
/// including final history boundaries. All work stays on the observation owner.
pub(super) fn run<'c, T: Send + 'c>(
    db: &'c mut SqliteConnection,
    read: impl for<'a> FnOnce(
        &'a mut SqliteConnection,
    ) -> crate::connection::BoxFuture<'a, Result<T, StoreError>>
    + Send
    + 'c,
) -> crate::connection::BoxFuture<'c, Result<T, StoreError>> {
    Box::pin(async move {
        let mut tx = db.begin().await?;
        let before: i64 = sqlx::query_scalar("SELECT total_changes()")
            .fetch_one(&mut *tx)
            .await?;
        match read(&mut tx).await {
            Ok(value) => {
                let after: i64 = sqlx::query_scalar("SELECT total_changes()")
                    .fetch_one(&mut *tx)
                    .await?;
                tx.commit().await?;
                // Cache fills and retained-source changes require maintenance.
                // An unchanged fragment cannot add reclaimable bodies, even
                // when its retained producer alone exceeds the page target.
                if after != before {
                    trim(db).await?;
                }
                Ok(value)
            }
            Err(error) => {
                // Preserve the canonical read failure. No maintenance follows an
                // unsuccessful read or a rollback with an uncertain result.
                let _ = tx.rollback().await;
                Err(error)
            }
        }
    })
}

pub(crate) async fn purge(db: &mut SqliteConnection, session: &str) -> Result<(), StoreError> {
    let mut tx = db.begin().await?;
    for table in [
        "transcript_text",
        "transcript_rows",
        "transcript_sessions",
        "transcript_active_source",
    ] {
        let query = format!("DELETE FROM temp.{table} WHERE session_id=?");
        sqlx::query(sqlx::AssertSqlSafe(query.as_str()))
            .bind(session)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn trim(db: &mut SqliteConnection) -> Result<(), StoreError> {
    let pages: i64 = sqlx::query_scalar("PRAGMA temp.page_count")
        .fetch_one(&mut *db)
        .await?;
    if pages <= RETAINED_PAGES {
        return Ok(());
    }
    let mut tx = db.begin().await?;
    sqlx::raw_sql(
        "DELETE FROM temp.transcript_text WHERE NOT EXISTS (
             SELECT 1 FROM temp.transcript_active_source a
             WHERE a.session_id=transcript_text.session_id AND a.source_sequence=transcript_text.source_sequence
         );
         DELETE FROM temp.transcript_rows WHERE NOT EXISTS (
             SELECT 1 FROM temp.transcript_active_source a
             WHERE a.session_id=transcript_rows.session_id AND a.source_sequence=transcript_rows.source_sequence
         );
         DELETE FROM temp.transcript_sessions WHERE NOT EXISTS (
             SELECT 1 FROM temp.transcript_rows r WHERE r.session_id=transcript_sessions.session_id
         );",
    )
    .execute(&mut *tx)
    .await?;
    // FULL auto-vacuum reclaims free database pages at this commit, including
    // an opened temporary backing file. DELETE alone would retain high-water.
    tx.commit().await?;
    Ok(())
}

async fn retain_source(
    db: &mut SqliteWorkerConnection<'_>,
    session: &str,
    source: i64,
) -> Result<(), StoreError> {
    sqlx::query("INSERT INTO temp.transcript_active_source VALUES(1,?1,?2)
        ON CONFLICT(singleton) DO UPDATE SET session_id=excluded.session_id,source_sequence=excluded.source_sequence
        WHERE transcript_active_source.session_id!=excluded.session_id OR transcript_active_source.source_sequence!=excluded.source_sequence")
        .bind(session).bind(source).execute(db).await?;
    Ok(())
}

pub(super) async fn ensure(
    tx: &mut SqliteConnection,
    session: &str,
    position: RowPosition,
) -> Result<(), StoreError> {
    let session = session.to_owned();
    crate::connection::worker_query(tx, move |worker| {
        Box::pin(async move { ensure_on_worker(worker, &session, position).await })
    })
    .await
}

pub(super) async fn ensure_on_worker(
    db: &mut SqliteWorkerConnection<'_>,
    session: &str,
    position: RowPosition,
) -> Result<(), StoreError> {
    let (source, item) = sql_position(position)?;
    let (turn, message, copy_identity): (String, String, Option<String>) = sqlx::query_as(
        "SELECT turn_id,message_id,(SELECT json_array(source_session_id,source_revision,through_sequence,observed_through,bundle_digest) FROM session_history_copies WHERE session_id=?1) FROM transcript_directory WHERE session_id=?1 AND source_sequence=?2 AND item_index=?3",
    ).bind(session).bind(source).bind(item).fetch_optional(&mut *db).await?
        .ok_or_else(|| StoreError::InvalidTransition("history row was not found".into()))?;
    // A copied base can replace previously readable bare claimants. Its durable
    // marker changes in the same snapshot as the directory, never on appends.
    let previous: Option<(Option<String>,)> =
        sqlx::query_as("SELECT copy_identity FROM temp.transcript_sessions WHERE session_id=?")
            .bind(session)
            .fetch_optional(&mut *db)
            .await?;
    if previous
        .as_ref()
        .is_some_and(|(previous,)| previous != &copy_identity)
    {
        sqlx::query("DELETE FROM temp.transcript_text WHERE session_id=?")
            .bind(session)
            .execute(&mut *db)
            .await?;
        sqlx::query("DELETE FROM temp.transcript_rows WHERE session_id=?")
            .bind(session)
            .execute(&mut *db)
            .await?;
    }
    if previous.as_ref().map(|(identity,)| identity) != Some(&copy_identity) {
        sqlx::query("INSERT INTO temp.transcript_sessions VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET copy_identity=excluded.copy_identity")
            .bind(session).bind(copy_identity).execute(&mut *db).await?;
    }
    let cached: Option<(String, String)> = sqlx::query_as(
        "SELECT turn_id,message_id FROM temp.transcript_rows WHERE session_id=?1 AND source_sequence=?2 AND item_index=?3",
    ).bind(session).bind(source).bind(item).fetch_optional(&mut *db).await?;
    if let Some(identity) = cached {
        if identity != (turn, message) {
            return Err(StoreError::TranscriptConflict);
        }
        retain_source(db, session, source).await?;
        return Ok(());
    }
    // S is the cache unit: emission already owns every original row from this
    // selected producer. Retain these rows once, never replayed earlier sources.
    // Text remains demand-driven per visited row. A hit needs no sibling fill.
    let rows = super::emit::source_on_worker(db, session, position.source_sequence).await?;
    if !rows.iter().any(|row| row.position == position) {
        return Err(StoreError::TranscriptConflict);
    }
    // Bound statement size and extra encoded bytes, not producer size. One
    // oversized row still works; no further siblings join its batch. Every
    // batch stays inside the caller's original read transaction.
    let mut rows = rows.iter().peekable();
    while rows.peek().is_some() {
        let mut encoded = Vec::with_capacity(32);
        let mut encoded_bytes = 0;
        for row in rows.by_ref().take(32) {
            if row.position.source_sequence != position.source_sequence {
                return Err(StoreError::TranscriptConflict);
            }
            let (_, item) = sql_position(row.position)?;
            let payload = serde_json::to_vec(&row.message)?;
            let bytes = i64::try_from(payload.len()).map_err(|_| StoreError::PrefixTooLarge)?;
            let digest = format!("sha256:{}", hex::encode(Sha256::digest(&payload)));
            encoded_bytes += payload.len();
            encoded.push((item, &row.message, payload, digest, bytes));
            if encoded_bytes >= 64 * 1024 {
                break;
            }
        }
        let mut identities =
            QueryBuilder::<Sqlite>::new("WITH wanted(item_index,turn_id,message_id) AS (");
        identities.push_values(&encoded, |mut values, (item, message, ..)| {
            values
                .push_bind(item)
                .push_bind(&message.turn_id)
                .push_bind(&message.id);
        });
        identities.push(") SELECT count(*) FROM wanted JOIN transcript_directory d ON d.item_index=wanted.item_index AND d.turn_id=wanted.turn_id AND d.message_id=wanted.message_id WHERE d.session_id=")
            .push_bind(session).push(" AND d.source_sequence=").push_bind(source);
        let matched: i64 = identities.build_query_scalar().fetch_one(&mut *db).await?;
        if matched != encoded.len() as i64 {
            return Err(StoreError::TranscriptConflict);
        }
        let mut insert = QueryBuilder::<Sqlite>::new(
            "INSERT OR IGNORE INTO temp.transcript_rows (session_id,source_sequence,item_index,turn_id,message_id,payload,digest,total_bytes) ",
        );
        insert.push_values(
            &encoded,
            |mut values, (item, message, payload, digest, bytes)| {
                values
                    .push_bind(session)
                    .push_bind(source)
                    .push_bind(item)
                    .push_bind(&message.turn_id)
                    .push_bind(&message.id)
                    .push_bind(payload)
                    .push_bind(digest)
                    .push_bind(bytes);
            },
        );
        insert.build().execute(&mut *db).await?;
        // A conflict must preserve an existing body and fail the entire read.
        // Compare every field even when INSERT OR IGNORE changed no rows.
        let mut verify = QueryBuilder::<Sqlite>::new(
            "WITH wanted(item_index,turn_id,message_id,payload,digest,total_bytes) AS (",
        );
        verify.push_values(
            &encoded,
            |mut values, (item, message, payload, digest, bytes)| {
                values
                    .push_bind(item)
                    .push_bind(&message.turn_id)
                    .push_bind(&message.id)
                    .push_bind(payload)
                    .push_bind(digest)
                    .push_bind(bytes);
            },
        );
        verify.push(") SELECT count(*) FROM wanted JOIN temp.transcript_rows c ON c.item_index=wanted.item_index AND c.turn_id=wanted.turn_id AND c.message_id=wanted.message_id AND c.payload=wanted.payload AND c.digest=wanted.digest AND c.total_bytes=wanted.total_bytes WHERE c.session_id=")
            .push_bind(session).push(" AND c.source_sequence=").push_bind(source);
        let matched: i64 = verify.build_query_scalar().fetch_one(&mut *db).await?;
        if matched != encoded.len() as i64 {
            return Err(StoreError::TranscriptConflict);
        }
    }
    retain_source(db, session, source).await?;
    Ok(())
}

#[cfg(test)]
#[path = "bodycache_tests.rs"]
mod tests;
