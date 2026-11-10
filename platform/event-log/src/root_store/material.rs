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

//! Root reclaims content nominated by committed domain releases and compacts
//! the resulting free pages. The current reference graph decides what survives.

use super::EventLog;
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
                collect(log).await;
            }
        } => {},
    }
    // Dropping a pending collector only cancels its observer. Already accepted
    // SQL jobs still drain on their original actors before Root releases authority.
}

async fn collect(log: &EventLog) {
    let mut releases = log.commits.subscribe_material_releases();
    loop {
        // A release during a pass remains unread and schedules another pass.
        releases.borrow_and_update();
        loop {
            match reclaim_step(log).await {
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

async fn reclaim_step(log: &EventLog) -> Result<bool, crate::StoreError> {
    log.connection
        .run(|connection| {
            let pending: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM pending_content_releases)", [], |row| row.get(0),
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
                return Ok(true);
            }
            let free: i64 = connection.query_row("PRAGMA freelist_count", [], |row| row.get(0))?;
            if free == 0 {
                return Ok(false);
            }
            let mode: i64 = connection.query_row("PRAGMA auto_vacuum", [], |row| row.get(0))?;
            if mode != 2 {
                return Err(crate::StoreError::UnsupportedDatabase);
            }
            connection.execute_batch("PRAGMA incremental_vacuum(128)")?;
            let remaining: i64 =
                connection.query_row("PRAGMA freelist_count", [], |row| row.get(0))?;
            Ok(remaining != 0 && remaining < free)
        })
        .await
}
