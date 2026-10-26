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

use super::*;
use records::{ids, revision};

impl EventLog {
    /// Read metadata and payload in one independent read snapshot. The owned
    /// callback runs synchronously; neither the reader nor its metadata can escape.
    pub async fn with_artifact<T: Send + 'static>(
        &self,
        scope: ArtifactReadScope<'_>,
        artifact_id: &str,
        read: impl FnOnce(&Artifact, &mut dyn std::io::Read) -> T + Send + 'static,
    ) -> Result<Option<T>, StoreError> {
        self.validate_root()?;
        let (session, turn) = match scope {
            ArtifactReadScope::Session(session) => (session.to_owned(), None),
            ArtifactReadScope::Execution(invocation) => {
                crate::sessions::validate_id(&invocation.turn_id)?;
                (
                    invocation.session_id.clone(),
                    Some(invocation.turn_id.clone()),
                )
            }
        };
        ids(&session, Some(artifact_id))?;
        let artifact = artifact_id.to_owned();
        self.connection
            .read(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    let result = async {
                        if turn.is_none() {
                            require_session(&mut tx, &session).await?;
                        }
                        match lookup(&mut tx, &session, &artifact, turn.as_deref()).await? {
                            Some(row) => {
                                with_blob(&mut tx, row, |record, blob| Ok(read(record, blob)))
                                    .await
                                    .map(Some)
                            }
                            None => Ok(None),
                        }
                    }
                    .await;
                    // Cleanup failure takes precedence over a callback's business result.
                    tx.rollback().await?;
                    result
                })
            })
            .await
    }

    /// One read snapshot binds revision, ordering and total; no payload is read.
    pub async fn list_artifacts(
        &self,
        session_id: &str,
        offset: u64,
        limit: usize,
    ) -> Result<ArtifactPage, StoreError> {
        self.validate_root()?;
        ids(session_id, None)?;
        if limit == 0 || limit > 128 || offset > 9_007_199_254_740_991 {
            return Err(invalid("Invalid artifact page bounds"));
        }
        let session_id = session_id.to_owned();
        self.connection
            .read(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    require_session(&mut tx, &session_id).await?;
                    let revision = revision(&mut tx, &session_id).await?;
                    let total: i64 =
                        sqlx::query_scalar("SELECT COUNT(*) FROM artifacts WHERE session_id = ?")
                            .bind(&session_id)
                            .fetch_one(&mut *tx)
                            .await?;
                    let rows: Vec<(String, String)> = sqlx::query_as(
                        "SELECT id, record_json FROM artifacts WHERE session_id = ?
                ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?",
                    )
                    .bind(&session_id)
                    .bind(limit as i64)
                    .bind(offset as i64)
                    .fetch_all(&mut *tx)
                    .await?;
                    let records = rows
                        .into_iter()
                        .map(|(id, raw)| decode(&raw, &session_id, &id))
                        .collect::<Result<_, _>>()?;
                    Ok(ArtifactPage {
                        revision,
                        records,
                        total: total as u64,
                    })
                })
            })
            .await
    }

    pub async fn get_artifact(
        &self,
        session_id: &str,
        artifact_id: &str,
    ) -> Result<ArtifactEntry, StoreError> {
        self.validate_root()?;
        ids(session_id, Some(artifact_id))?;
        let (session_id, artifact_id) = (session_id.to_owned(), artifact_id.to_owned());
        self.connection
            .read(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    require_session(&mut tx, &session_id).await?;
                    let revision = revision(&mut tx, &session_id).await?;
                    let record = read_record(&mut tx, &session_id, &artifact_id)
                        .await?
                        .map(|(record, _)| record);
                    Ok(ArtifactEntry { revision, record })
                })
            })
            .await
    }

    /// Read one bounded window without materializing the entire SQLite BLOB.
    /// Reopening per window is not a replacement for a whole-artifact callback.
    pub async fn read_artifact_chunk(
        &self,
        session_id: &str,
        artifact_id: &str,
        offset: u64,
        limit: usize,
    ) -> Result<Option<ArtifactChunk>, StoreError> {
        self.validate_root()?;
        ids(session_id, Some(artifact_id))?;
        if limit == 0 || offset > 9_007_199_254_740_991 {
            return Err(invalid("Invalid artifact read bounds"));
        }
        let (session, artifact) = (session_id.to_owned(), artifact_id.to_owned());
        self.connection
            .read(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    let result = async {
                        require_session(&mut tx, &session).await?;
                        let Some(row) = lookup(&mut tx, &session, &artifact, None).await? else {
                            return Ok(None);
                        };
                        if offset > row.record.size_bytes {
                            return Err(StoreError::ArtifactOffset);
                        }
                        with_blob(&mut tx, row, |record, blob| {
                            let length = (record.size_bytes - offset).min(limit as u64) as usize;
                            let mut bytes = vec![0; length];
                            blob.read_at_exact(&mut bytes, offset as usize)?;
                            Ok(ArtifactChunk {
                                total_bytes: record.size_bytes,
                                bytes,
                            })
                        })
                        .await
                        .map(Some)
                    }
                    .await;
                    tx.rollback().await?;
                    result
                })
            })
            .await
    }
}

struct Row {
    rowid: i64,
    record: Artifact,
}

async fn lookup(
    connection: &mut sqlx::SqliteConnection,
    session: &str,
    artifact: &str,
    turn: Option<&str>,
) -> Result<Option<Row>, StoreError> {
    let row: Option<(i64, i64, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT rowid, length(payload),
         record_json,
         CASE WHEN length(CAST(content_sha256 AS BLOB)) = 71 THEN content_sha256 END
         FROM artifacts WHERE session_id = ?1 AND id = ?2
         AND (?3 IS NULL OR json_extract(record_json, '$.turnId') = ?3)",
    )
    .bind(session)
    .bind(artifact)
    .bind(turn)
    .fetch_optional(connection)
    .await?;
    row.map(|(rowid, total, raw, digest)| {
        let raw = raw.ok_or_else(|| invalid("Stored artifact metadata is missing"))?;
        digest.ok_or_else(|| invalid("Stored artifact digest exceeds limit"))?;
        let record = decode(&raw, session, artifact)?;
        if u64::try_from(total).ok() != Some(record.size_bytes) {
            return Err(invalid("Stored artifact payload size mismatch"));
        }
        Ok(Row { rowid, record })
    })
    .transpose()
}

async fn with_blob<T>(
    connection: &mut sqlx::SqliteConnection,
    row: Row,
    read: impl FnOnce(&Artifact, &mut rusqlite::blob::Blob<'_>) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    let mut locked = connection.lock_handle().await?;
    // SAFETY: this original SQLx guard excludes worker FFI. The non-owning
    // wrapper and read-only Blob remain in this no-await scope; neither escapes.
    let borrowed = unsafe { rusqlite::Connection::from_handle(locked.as_raw_handle().as_ptr()) }?;
    let mut blob = borrowed.blob_open("main", "artifacts", "payload", row.rowid, true)?;
    let result = if blob.len() as u64 == row.record.size_bytes {
        read(&row.record, &mut blob)
    } else {
        Err(invalid("Stored artifact payload size mismatch"))
    };
    let closed = blob.close();
    drop(borrowed);
    drop(locked);
    closed?;
    result
}
