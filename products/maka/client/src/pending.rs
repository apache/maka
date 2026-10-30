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

use crate::{Client, Result};
use maka_capabilities::call::ReadResource;
use serde_json::Value;
use sqlx::Connection;
use std::{collections::HashSet, sync::Arc};

const FILE_CHUNK_BYTES: usize = 64 * 1024;

/// One immutable resource selected before its Host session exists.
pub struct PendingFile {
    pub id: String,
    pub resource: Arc<dyn ReadResource>,
}

#[derive(Clone, Debug)]
pub struct PendingFileMetadata {
    pub name: String,
    pub bytes: usize,
}

impl Client {
    async fn pending_owner(&self) -> Result<String> {
        serde_json::to_string(&self.draft_key("agent", "desktop-new", "desktop").await?)
            .map_err(|error| error.to_string())
    }
    pub async fn pending_draft(&self) -> Result<(u64, Value)> {
        let owner = self.pending_owner().await?;
        let row: Option<(i64, String)> =
            sqlx::query_as("SELECT revision,state FROM desktop_drafts WHERE owner=?")
                .bind(owner)
                .fetch_optional(&self.0.journal.pool)
                .await
                .map_err(|error| error.to_string())?;
        match row {
            Some((revision, state)) => Ok((
                revision as u64,
                serde_json::from_str(&state).map_err(|error| error.to_string())?,
            )),
            None => Ok((0, Value::Null)),
        }
    }
    pub async fn pending_file(&self, id: &str) -> Result<PendingFileMetadata> {
        let (name, bytes): (String, i64) =
            sqlx::query_as("SELECT name,length FROM desktop_draft_files WHERE owner=? AND id=?")
                .bind(self.pending_owner().await?)
                .bind(id)
                .fetch_one(&self.0.journal.pool)
                .await
                .map_err(|error| error.to_string())?;
        Ok(PendingFileMetadata {
            name,
            bytes: usize::try_from(bytes).map_err(|error| error.to_string())?,
        })
    }
    pub async fn pending_file_chunk(&self, id: &str, offset: usize) -> Result<Vec<u8>> {
        sqlx::query_scalar(
            "SELECT bytes FROM desktop_draft_chunks WHERE owner=? AND id=? AND offset=?",
        )
        .bind(self.pending_owner().await?)
        .bind(id)
        .bind(i64::try_from(offset).map_err(|error| error.to_string())?)
        .fetch_one(&self.0.journal.pool)
        .await
        .map_err(|error| error.to_string())
    }
    pub async fn save_pending_draft(
        &self,
        expected: u64,
        state: Value,
        ids: Vec<String>,
        files: Vec<PendingFile>,
    ) -> Result<u64> {
        if expected >= 9_007_199_254_740_991 {
            return Err("Desktop draft revision exhausted".into());
        }
        let owner = self.pending_owner().await?;
        let client = self.clone();
        let runtime = tokio::runtime::Handle::current();
        // Resource reads can do native work. Keep the whole streamed write on a
        // blocking worker while SQLite retains the single atomic revision boundary.
        let write = async move {
            let mut connection = client
                .0
                .journal
                .pool
                .acquire()
                .await
                .map_err(|error| error.to_string())?;
            let mut tx = connection
                .begin_with("BEGIN IMMEDIATE")
                .await
                .map_err(|error| error.to_string())?;
            let actual: Option<i64> =
                sqlx::query_scalar("SELECT revision FROM desktop_drafts WHERE owner=?")
                    .bind(&owner)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(|error| error.to_string())?;
            if actual.unwrap_or(0) as u64 != expected {
                return Err(
                    "The desktop draft changed in another window. Reopen it before editing.".into(),
                );
            }
            let encoded_ids = serde_json::to_string(&ids).map_err(|error| error.to_string())?;
            let known: HashSet<String> = sqlx::query_scalar(
                "SELECT id FROM desktop_draft_files WHERE owner=? AND id IN (SELECT value FROM json_each(?))",
            )
            .bind(&owner).bind(&encoded_ids).fetch_all(&mut *tx).await
            .map_err(|error| error.to_string())?.into_iter().collect();
            for file in files {
                if known.contains(&file.id) {
                    continue;
                }
                let metadata = file.resource.metadata();
                let name = metadata["name"]
                    .as_str()
                    .ok_or("Selected file name is missing")?;
                let bytes = file.resource.bytes();
                let inserted = sqlx::query(
                    "INSERT OR IGNORE INTO desktop_draft_files(owner,id,name,length) VALUES(?,?,?,?)",
                )
                .bind(&owner).bind(&file.id).bind(name)
                .bind(i64::try_from(bytes).map_err(|error| error.to_string())?)
                .execute(&mut *tx).await.map_err(|error| error.to_string())?;
                if inserted.rows_affected() == 0 {
                    continue;
                }
                for offset in (0..bytes).step_by(FILE_CHUNK_BYTES) {
                    let end = bytes.min(offset + FILE_CHUNK_BYTES);
                    let chunk = file.resource.read(offset..end)?;
                    if chunk.len() != end - offset {
                        return Err("Selected file returned a different byte range".into());
                    }
                    sqlx::query(
                        "INSERT INTO desktop_draft_chunks(owner,id,offset,bytes) VALUES(?,?,?,?)",
                    )
                    .bind(&owner)
                    .bind(&file.id)
                    .bind(offset as i64)
                    .bind(chunk)
                    .execute(&mut *tx)
                    .await
                    .map_err(|error| error.to_string())?;
                }
            }
            let missing: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM json_each(?) wanted LEFT JOIN desktop_draft_files files ON files.owner=? AND files.id=wanted.value WHERE files.id IS NULL)",
            )
            .bind(&encoded_ids).bind(&owner).fetch_one(&mut *tx).await
            .map_err(|error| error.to_string())?;
            if missing {
                return Err("Desktop draft attachment is missing".into());
            }
            sqlx::query("DELETE FROM desktop_draft_files WHERE owner=? AND id NOT IN (SELECT value FROM json_each(?))")
                .bind(&owner).bind(encoded_ids).execute(&mut *tx).await.map_err(|error| error.to_string())?;
            let revision = expected + 1;
            sqlx::query("INSERT INTO desktop_drafts(owner,revision,state) VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET revision=excluded.revision,state=excluded.state")
                .bind(&owner).bind(revision as i64).bind(state.to_string()).execute(&mut *tx).await.map_err(|error| error.to_string())?;
            tx.commit().await.map_err(|error| error.to_string())?;
            Ok(revision)
        };
        tokio::task::spawn_blocking(move || runtime.block_on(write))
            .await
            .map_err(|error| format!("Desktop draft writer failed: {error}"))?
    }
}
