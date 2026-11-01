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

//! Prepare immutable material for an event reference in the original transaction.
use super::{recipe::Projection, source};
use crate::StoreError;
use sha2::{Digest, Sha256};
use sqlx::sqlite::SqliteWorkerConnection;
use std::io::Read;
pub(crate) async fn prepare(
    worker: &mut SqliteWorkerConnection<'_>,
    projection: &Projection<'_>,
) -> Result<i64, StoreError> {
    let original = projection.json.as_bytes();
    let digest = Sha256::digest(original);
    let inserted=sqlx::query("INSERT INTO event_bodies(digest,raw_bytes,sqlite_json_bytes,payload) VALUES(?1,?2,?3,?4) ON CONFLICT(digest) DO NOTHING")
        .bind(digest.as_slice()).bind(original.len() as i64).bind(projection.sqlite_json_bytes() as i64).bind(original)
        .execute(&mut *worker).await?;
    if inserted.rows_affected() == 1 {
        return Ok(inserted.last_insert_rowid());
    }
    let (id, bytes): (i64, i64) =
        sqlx::query_as("SELECT id,raw_bytes FROM event_bodies WHERE digest=?")
            .bind(digest.as_slice())
            .fetch_one(&mut *worker)
            .await?;
    if bytes != original.len() as i64 {
        return Err(StoreError::EventConflict);
    }
    {
        // SAFETY: the worker callback exclusively owns this original handle.
        // The borrowed wrapper and its BLOB readers close before returning.
        let raw = unsafe { rusqlite::Connection::from_handle(worker.as_raw_handle().as_ptr()) }?;
        source::with_material(&raw, id, bytes as u64, |reader| {
            let mut position = 0;
            let mut buffer = [0; 32 * 1024];
            loop {
                let count = reader.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                if original.get(position..position + count) != Some(&buffer[..count]) {
                    return Err(StoreError::EventConflict);
                }
                position += count;
            }
            if position != original.len() {
                return Err(StoreError::EventConflict);
            }
            Ok(())
        })?;
        drop(raw);
    }
    Ok(id)
}
