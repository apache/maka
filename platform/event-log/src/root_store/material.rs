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

//! Root reclaims content nominated by committed domain releases, recompresses
//! legacy raw `contents` rows in bounded batches outside the write lock, and
//! compacts the resulting free pages back to the OS.

use super::EventLog;
use crate::content::{
    RECOMPRESS_DEFAULT_BATCH_BYTES, RecompressCandidates, apply_recompressed_batch,
    compress_candidates, compress_oversized_candidate, fetch_recompress_candidates,
};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

pub(super) async fn maintain(
    log: &EventLog,
    ready: oneshot::Receiver<()>,
    stop: CancellationToken,
) {
    tokio::select! {
        biased;
        () = stop.cancelled() => {},
        () = async {
            if ready.await.is_ok() {
                collect(log, &stop).await;
            }
        } => {},
    }
    // Dropping a pending collector only cancels its observer. Already accepted
    // SQL jobs still drain on their original actors before Root releases authority.
}

async fn collect(log: &EventLog, stop: &CancellationToken) {
    let mut releases = log.commits.subscribe_material_releases();
    loop {
        if stop.is_cancelled() {
            return;
        }
        // A release during a pass remains unread and schedules another pass.
        releases.borrow_and_update();
        loop {
            if stop.is_cancelled() {
                return;
            }
            match reclaim_step(log, stop).await {
                Ok(true) => {}
                Ok(false) => break,
                Err(error) => {
                    // A later release or reopen resumes the durable work.
                    eprintln!("Root material compaction failed: {error}");
                    break;
                }
            }
        }
        if releases.changed().await.is_err() {
            return;
        }
    }
}

enum StepAction {
    Done,
    Continue,
    Recompress(crate::content::RecompressCandidates),
}

async fn reclaim_step(log: &EventLog, stop: &CancellationToken) -> Result<bool, crate::StoreError> {
    let action = log
        .connection
        .run(|connection| {
            let pending: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM pending_content_releases)",
                [],
                |row| row.get(0),
            )?;
            if pending {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Immediate,
                )?;
                tx.execute(
                    "WITH batch AS MATERIALIZED (SELECT content_id FROM pending_content_releases ORDER BY content_id LIMIT 128)
                     DELETE FROM pending_content_releases WHERE content_id IN (SELECT content_id FROM batch)",
                    [],
                )?;
                tx.commit().map_err(crate::StoreError::CommitUnknown)?;
                return Ok(StepAction::Continue);
            }
            let free: i64 = connection.query_row("PRAGMA freelist_count", [], |row| row.get(0))?;
            if free > 0 {
                let mode: i64 =
                    connection.query_row("PRAGMA auto_vacuum", [], |row| row.get(0))?;
                if mode != 2 {
                    return Err(crate::StoreError::UnsupportedDatabase);
                }
                incremental_vacuum(connection, 512)?;
                let remaining: i64 =
                    connection.query_row("PRAGMA freelist_count", [], |row| row.get(0))?;
                if remaining < free {
                    return Ok(StepAction::Continue);
                }
            }
            match fetch_recompress_candidates(connection, RECOMPRESS_DEFAULT_BATCH_BYTES)? {
                Some(candidates) => Ok(StepAction::Recompress(candidates)),
                None => Ok(StepAction::Done),
            }
        })
        .await?;

    let StepAction::Recompress(candidates) = action else {
        return Ok(matches!(action, StepAction::Continue));
    };

    // Compress outside the SQLite writer actor so live reads/writes never stall.
    let prepared = match candidates {
        RecompressCandidates::Batch {
            rows,
            next_cursor,
            target_max_id,
        } => tokio::task::spawn_blocking(move || {
            compress_candidates(rows, next_cursor, target_max_id)
        })
        .await
        .map_err(|err| crate::StoreError::Io(std::io::Error::other(err)))??,
        RecompressCandidates::Oversized {
            id,
            content_sha256,
            raw_len,
            next_cursor,
            target_max_id,
        } => {
            let cancel = stop.clone();
            log.connection
                .read(move |connection| {
                    compress_oversized_candidate(
                        connection,
                        id,
                        content_sha256,
                        raw_len,
                        next_cursor,
                        target_max_id,
                        Some(&cancel),
                    )
                })
                .await?
        }
    };

    let report = log
        .connection
        .run(move |connection| apply_recompressed_batch(connection, prepared))
        .await?;
    Ok(!report.done || report.recompressed > 0)
}

/// Drain all rows yielded by `PRAGMA incremental_vacuum(pages)`.
///
/// SQLite yields one `SQLITE_ROW` per freed page; `Connection::execute_batch` only steps
/// once and therefore reclaims at most a single page per call instead of `pages`.
fn incremental_vacuum(
    connection: &rusqlite::Connection,
    pages: u32,
) -> Result<(), crate::StoreError> {
    let mut stmt = connection.prepare(&format!("PRAGMA incremental_vacuum({pages})"))?;
    let mut rows = stmt.query([])?;
    while rows.next()?.is_some() {}
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::incremental_vacuum;
    use rusqlite::Connection;

    #[test]
    fn incremental_vacuum_drains_requested_page_batch_not_single_page() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA auto_vacuum = INCREMENTAL;
             CREATE TABLE t(id INTEGER PRIMARY KEY, payload BLOB);",
        )
        .unwrap();
        let blob = vec![b'x'; 4000];
        for i in 0..200i64 {
            conn.execute("INSERT INTO t(id, payload) VALUES(?1, ?2)", (i, &blob))
                .unwrap();
        }
        conn.execute("DELETE FROM t", []).unwrap();
        let free_before: i64 = conn
            .query_row("PRAGMA freelist_count", [], |r| r.get(0))
            .unwrap();
        assert!(
            free_before >= 150,
            "expected substantial freelist before vacuum, got {free_before}"
        );

        incremental_vacuum(&conn, 512).unwrap();

        let free_after: i64 = conn
            .query_row("PRAGMA freelist_count", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            free_after, 0,
            "single incremental_vacuum(512) call must drain all {free_before} free pages, left {free_after}"
        );
    }
}
