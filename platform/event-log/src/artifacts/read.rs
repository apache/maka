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
                {
                    let tx = rusqlite::Transaction::new_unchecked(
                        connection,
                        rusqlite::TransactionBehavior::Deferred,
                    )?;
                    let result = (|| {
                        if turn.is_none() {
                            require_session(&tx, &session)?;
                        }
                        match lookup(&tx, &session, &artifact, turn.as_deref())? {
                            Some(row) => {
                                with_blob(&tx, row, |record, blob| Ok(read(record, blob))).map(Some)
                            }
                            None => Ok(None),
                        }
                    })();
                    // Cleanup failure takes precedence over a callback's business result.
                    tx.rollback()?;
                    result
                }
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
        ids(session_id, None)?;
        if limit == 0 || limit > 128 || offset > 9_007_199_254_740_991 {
            return Err(invalid("Invalid artifact page bounds"));
        }
        let session_id = session_id.to_owned();
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                require_session(&tx, &session_id)?;
                let revision = revision(&tx, &session_id)?;
                let total: i64 = tx
                    .prepare_cached("SELECT COUNT(*) FROM artifacts WHERE session_id = ?")?
                    .query_row(rusqlite::params![&session_id], |row| row.get(0))?;
                let rows: Vec<(String, String)> = tx
                    .prepare_cached(
                        "SELECT id, record_json FROM artifacts WHERE session_id = ?
                ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?",
                    )?
                    .query_map(
                        rusqlite::params![&session_id, limit as i64, offset as i64],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )?
                    .collect::<Result<Vec<_>, _>>()?;
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
            .await
    }

    pub async fn get_artifact(
        &self,
        session_id: &str,
        artifact_id: &str,
    ) -> Result<ArtifactEntry, StoreError> {
        ids(session_id, Some(artifact_id))?;
        let (session_id, artifact_id) = (session_id.to_owned(), artifact_id.to_owned());
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                require_session(&tx, &session_id)?;
                let revision = revision(&tx, &session_id)?;
                let record = read_record(&tx, &session_id, &artifact_id)?.map(|(record, _)| record);
                Ok(ArtifactEntry { revision, record })
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
        ids(session_id, Some(artifact_id))?;
        if limit == 0 || offset > 9_007_199_254_740_991 {
            return Err(invalid("Invalid artifact read bounds"));
        }
        let (session, artifact) = (session_id.to_owned(), artifact_id.to_owned());
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                let result = (|| {
                    require_session(&tx, &session)?;
                    let Some(row) = lookup(&tx, &session, &artifact, None)? else {
                        return Ok(None);
                    };
                    if offset > row.record.size_bytes {
                        return Err(StoreError::ArtifactOffset);
                    }
                    with_blob(&tx, row, |record, blob| {
                        let length = (record.size_bytes - offset).min(limit as u64) as usize;
                        let mut bytes = vec![0; length];
                        blob.read_at_exact(&mut bytes, offset as usize)?;
                        Ok(ArtifactChunk {
                            total_bytes: record.size_bytes,
                            bytes,
                        })
                    })
                    .map(Some)
                })();
                tx.rollback()?;
                result
            })
            .await
    }
}

struct Row {
    rowid: i64,
    record: Artifact,
}

fn lookup(
    connection: &rusqlite::Connection,
    session: &str,
    artifact: &str,
    turn: Option<&str>,
) -> Result<Option<Row>, StoreError> {
    let row: Option<(i64, i64, Option<String>, Option<String>)> = connection.prepare_cached("SELECT c.rowid, length(c.payload),
         record_json,
         CASE WHEN length(CAST(artifacts.content_sha256 AS BLOB)) = 71 THEN artifacts.content_sha256 END
         FROM artifacts JOIN contents c USING(content_sha256) WHERE session_id = ?1 AND artifacts.id = ?2
         AND (?3 IS NULL OR json_extract(record_json, '$.turnId') = ?3)")?.query_row(rusqlite::params![session, artifact, turn], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?,))).optional()?;
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

fn with_blob<T>(
    connection: &rusqlite::Connection,
    row: Row,
    read: impl FnOnce(&Artifact, &mut rusqlite::blob::Blob<'_>) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    let mut blob = connection.blob_open("main", "contents", "payload", row.rowid, true)?;
    let result = if blob.len() as u64 == row.record.size_bytes {
        read(&row.record, &mut blob)
    } else {
        Err(invalid("Stored artifact payload size mismatch"))
    };
    let closed = blob.close();
    closed?;
    result
}
