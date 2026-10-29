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
use serde_json::Value;
use sqlx::{Connection, Row};

pub struct PendingFile {
    pub id: String,
    pub name: String,
    pub bytes: Vec<u8>,
}
impl Client {
    async fn pending_owner(&self) -> Result<String> {
        serde_json::to_string(&self.draft_key("agent", "desktop-new", "desktop").await?)
            .map_err(|e| e.to_string())
    }
    pub async fn pending_draft(&self) -> Result<(u64, Value)> {
        let owner = self.pending_owner().await?;
        let row: Option<(i64, String)> =
            sqlx::query_as("SELECT revision,state FROM desktop_drafts WHERE owner=?")
                .bind(owner)
                .fetch_optional(&self.0.journal.pool)
                .await
                .map_err(|e| e.to_string())?;
        match row {
            Some((revision, state)) => Ok((
                revision as u64,
                serde_json::from_str(&state).map_err(|e| e.to_string())?,
            )),
            None => Ok((0, Value::Null)),
        }
    }
    pub async fn pending_file_ids(&self) -> Result<Vec<String>> {
        sqlx::query_scalar("SELECT id FROM desktop_draft_files WHERE owner=?")
            .bind(self.pending_owner().await?)
            .fetch_all(&self.0.journal.pool)
            .await
            .map_err(|e| e.to_string())
    }
    pub async fn pending_file(&self, id: &str) -> Result<PendingFile> {
        let row = sqlx::query("SELECT name,bytes FROM desktop_draft_files WHERE owner=? AND id=?")
            .bind(self.pending_owner().await?)
            .bind(id)
            .fetch_one(&self.0.journal.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(PendingFile {
            id: id.into(),
            name: row.get(0),
            bytes: row.get(1),
        })
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
        let mut connection = self
            .0
            .journal
            .pool
            .acquire()
            .await
            .map_err(|e| e.to_string())?;
        let mut tx = connection
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|e| e.to_string())?;
        let actual: Option<i64> =
            sqlx::query_scalar("SELECT revision FROM desktop_drafts WHERE owner=?")
                .bind(&owner)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        if actual.unwrap_or(0) as u64 != expected {
            return Err(
                "The desktop draft changed in another window. Reopen it before editing.".into(),
            );
        }
        for file in files {
            sqlx::query(
                "INSERT OR IGNORE INTO desktop_draft_files(owner,id,name,bytes) VALUES(?,?,?,?)",
            )
            .bind(&owner)
            .bind(file.id)
            .bind(file.name)
            .bind(file.bytes)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        }
        for id in &ids {
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM desktop_draft_files WHERE owner=? AND id=?)",
            )
            .bind(&owner)
            .bind(id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
            if !exists {
                return Err("Desktop draft attachment is missing".into());
            }
        }
        let ids = serde_json::to_string(&ids).map_err(|e| e.to_string())?;
        sqlx::query("DELETE FROM desktop_draft_files WHERE owner=? AND id NOT IN (SELECT value FROM json_each(?))").bind(&owner).bind(ids).execute(&mut *tx).await.map_err(|e| e.to_string())?;
        let revision = expected + 1;
        sqlx::query("INSERT INTO desktop_drafts(owner,revision,state) VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET revision=excluded.revision,state=excluded.state").bind(&owner).bind(revision as i64).bind(state.to_string()).execute(&mut *tx).await.map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(revision)
    }
}
