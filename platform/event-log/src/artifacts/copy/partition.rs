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

//! One bounded source snapshot streamed into an atomic target Artifact receipt.
use super::*;
use crate::EventLog;
use maka_agent_facts::artifact::Artifact;
use maka_agent_ports::execution::CopyAttachment;
use sha2::{Digest, Sha256};
use sqlx::Connection;
use std::io::{Read, Seek, SeekFrom, Write};
use tokio::sync::mpsc;

const CHUNK: usize = 64 * 1024;
enum Frame {
    Header(Artifact, String),
    Chunk(Vec<u8>),
    Complete,
}

impl EventLog {
    pub(crate) async fn copy_attachment_from_partition(
        &self,
        source: EventLog,
        namespace: &maka_capabilities::storage::Namespace,
        request: CopyAttachment,
    ) -> Result<AttachmentRef, StoreError> {
        self.validate_root()?;
        source.validate_root()?;
        request
            .validate()
            .map_err(|error| invalid(&error.to_string()))?;
        let identity = serde_json::to_vec(&(namespace.package(), namespace.scope(), &request))?;
        let id = format!("attachment-{}", hex::encode(Sha256::digest(identity)));
        let mut destination = request.attachment.clone();
        destination.storage_ref = StorageRef::SessionFile {
            session_id: request.target_session_id.clone(),
            relative_path: id.clone(),
        };
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    // Both futures live inside the accepted writer callback. Observer
                    // cancellation cannot abandon either original physical worker.
                    let (sender, receiver) = mpsc::channel(1);
                    let read = source.connection.read(move |connection| {
                        Box::pin(
                            async move { stream(connection, request.attachment, sender).await },
                        )
                    });
                    let write = receive(connection, destination, id, receiver);
                    let (read, write) = tokio::join!(read, write);
                    read?;
                    write
                })
            })
            .await
    }
}

async fn stream(
    connection: &mut SqliteConnection,
    source: AttachmentRef,
    sender: mpsc::Sender<Frame>,
) -> Result<(), StoreError> {
    let StorageRef::SessionFile {
        session_id,
        relative_path,
    } = &source.storage_ref
    else {
        return Err(invalid("Attachment source is not a Session Artifact"));
    };
    let mut tx = connection.begin().await?;
    let result = async {
        let (artifact, digest) = read_record(&mut tx, session_id, relative_path)
            .await?
            .ok_or_else(|| invalid("Delegated attachment source no longer exists"))?;
        artifact.validate_attachment(&source).map_err(invalid)?;
        if artifact.source == ArtifactSource::UserUpload
            && artifact.summary.as_ref() != Some(&digest)
        {
            return Err(StoreError::ArtifactConflict);
        }
        let (rowid, length): (i64, i64) = sqlx::query_as(
            "SELECT c.rowid,length(c.payload) FROM artifacts JOIN artifact_contents c USING(content_sha256) WHERE session_id=? AND id=?",
        )
        .bind(session_id)
        .bind(relative_path)
        .fetch_one(&mut *tx)
        .await?;
        if u64::try_from(length).ok() != Some(artifact.size_bytes) {
            return Err(StoreError::ArtifactConflict);
        }
        let size = artifact.size_bytes;
        if sender.send(Frame::Header(artifact, digest)).await.is_err() {
            return Ok(false);
        }
        let mut offset = 0;
        while offset < size {
            let count = (size - offset).min(CHUNK as u64);
            let bytes = read_chunk(&mut tx, rowid, size, offset, count as usize).await?;
            if bytes.len() as u64 != count {
                return Err(StoreError::ArtifactConflict);
            }
            if sender.send(Frame::Chunk(bytes)).await.is_err() {
                return Ok(false);
            }
            offset += count;
        }
        Ok(true)
    }
    .await;
    tx.rollback().await?;
    if result? {
        let _ = sender.send(Frame::Complete).await;
    }
    Ok(())
}

async fn receive(
    connection: &mut SqliteConnection,
    destination: AttachmentRef,
    id: String,
    mut receiver: mpsc::Receiver<Frame>,
) -> Result<AttachmentRef, StoreError> {
    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
    let Some(Frame::Header(mut artifact, digest)) = receiver.recv().await else {
        return Err(invalid("Attachment source snapshot unavailable"));
    };
    let StorageRef::SessionFile { session_id, .. } = &destination.storage_ref else {
        unreachable!()
    };
    require_session(&mut tx, session_id).await?;
    let existing = read_record(&mut tx, session_id, &id).await?;
    artifact.session_id = session_id.clone();
    artifact.id = id.clone();
    artifact.turn_id = id.clone();
    artifact.created_at = match &existing {
        Some((record, _)) => record.created_at,
        None => std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| invalid(&error.to_string()))?
            .as_millis()
            .try_into()
            .map_err(|_| invalid("clock overflow"))?,
    };
    artifact.validate().map_err(invalid)?;
    artifact
        .validate_attachment(&destination)
        .map_err(invalid)?;
    let retry = existing.is_some();
    if let Some((record, recorded_digest)) = existing
        && (record != artifact || recorded_digest != digest)
    {
        return Err(StoreError::ArtifactConflict);
    }
    // Existing local bytes are compared throughout the stream even when the
    // destination reference is new. Only a newly allocated body is writable.
    let shared = sqlx::query("INSERT INTO artifact_contents(content_sha256,payload) VALUES (?,zeroblob(?)) ON CONFLICT(content_sha256) DO NOTHING")
        .bind(&digest).bind(artifact.size_bytes as i64).execute(&mut *tx).await?.rows_affected() == 0;
    if retry && !shared {
        return Err(StoreError::ArtifactConflict);
    }
    let (rowid, length): (i64, i64) = sqlx::query_as(
        "SELECT rowid,length(payload) FROM artifact_contents WHERE content_sha256=?",
    )
    .bind(&digest)
    .fetch_one(&mut *tx)
    .await?;
    if u64::try_from(length).ok() != Some(artifact.size_bytes) {
        return Err(StoreError::ArtifactConflict);
    }
    let mut offset = 0;
    let mut hash = Sha256::new();
    loop {
        match receiver.recv().await {
            Some(Frame::Chunk(bytes)) => {
                if bytes.is_empty() || offset + bytes.len() as u64 > artifact.size_bytes {
                    return Err(StoreError::ArtifactConflict);
                }
                transfer(&mut tx, rowid, artifact.size_bytes, offset, &bytes, shared).await?;
                hash.update(&bytes);
                offset += bytes.len() as u64;
            }
            Some(Frame::Complete) => break,
            _ => return Err(invalid("Attachment source snapshot incomplete")),
        }
    }
    if offset != artifact.size_bytes || format!("sha256:{}", hex::encode(hash.finalize())) != digest
    {
        return Err(StoreError::ArtifactConflict);
    }
    if !retry {
        // Canonical positions belong to each partition's sequence domain. A new
        // reference freezes only when first consumed in this target partition.
        sqlx::query("INSERT INTO artifacts (session_id,id,created_at,record_json,content_sha256,canonical_at,lookup_digest) VALUES (?,?,?,?,?,NULL,?)")
            .bind(session_id).bind(&id).bind(artifact.created_at as i64)
            .bind(serde_json::to_string(&artifact)?).bind(&digest)
            .bind(crate::artifacts::identity::artifact_lookup_digest(session_id, &id).as_slice())
            .execute(&mut *tx).await?;
        advance(&mut tx, session_id).await?;
    }
    tx.commit().await.map_err(StoreError::CommitUnknown)?;
    Ok(destination)
}

async fn read_chunk(
    connection: &mut SqliteConnection,
    rowid: i64,
    size: u64,
    offset: u64,
    count: usize,
) -> Result<Vec<u8>, StoreError> {
    with_blob(connection, rowid, size, true, move |blob| {
        let mut bytes = vec![0; count];
        blob.seek(SeekFrom::Start(offset))?;
        blob.read_exact(&mut bytes)?;
        Ok(bytes)
    })
    .await
}

async fn transfer(
    connection: &mut SqliteConnection,
    rowid: i64,
    size: u64,
    offset: u64,
    bytes: &[u8],
    retry: bool,
) -> Result<(), StoreError> {
    with_blob(connection, rowid, size, retry, |blob| {
        blob.seek(SeekFrom::Start(offset))?;
        if retry {
            let mut previous = vec![0; bytes.len()];
            blob.read_exact(&mut previous)?;
            if previous != bytes {
                return Err(StoreError::ArtifactConflict);
            }
        } else {
            blob.write_all(bytes)?;
        }
        Ok(())
    })
    .await
}

async fn with_blob<T: Send>(
    connection: &mut SqliteConnection,
    rowid: i64,
    size: u64,
    readonly: bool,
    action: impl FnOnce(&mut rusqlite::blob::Blob<'_>) -> Result<T, StoreError> + Send,
) -> Result<T, StoreError> {
    let mut locked = connection.lock_handle().await?;
    // SAFETY: the original SQLx guard excludes its worker FFI; neither the
    // non-owning wrapper nor the incremental blob escapes this no-await block.
    let borrowed = unsafe { rusqlite::Connection::from_handle(locked.as_raw_handle().as_ptr()) }?;
    let mut blob = borrowed.blob_open("main", "artifact_contents", "payload", rowid, readonly)?;
    let result = if blob.len() as u64 == size {
        action(&mut blob)
    } else {
        Err(StoreError::ArtifactConflict)
    };
    let closed = blob.close();
    drop(borrowed);
    drop(locked);
    closed?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::{
        artifact::{ArtifactKind, content_digest},
        attachment::AttachmentKind,
    };
    use serde_json::json;
    use std::sync::Arc;

    #[tokio::test]
    async fn stream_retains_source_snapshot_after_concurrent_artifact_deletion() {
        let directory = tempfile::tempdir().unwrap();
        let log = Arc::new(
            EventLog::open(&directory.path().join("source.sqlite"))
                .await
                .unwrap(),
        );
        log.create_session("source", "source", &json!({}), 1)
            .await
            .unwrap();
        let bytes = vec![19; 3 * CHUNK + 1];
        log.commit_artifact(
            Artifact {
                id: "file".into(),
                session_id: "source".into(),
                turn_id: "upload".into(),
                created_at: 1,
                name: "file.bin".into(),
                kind: ArtifactKind::File,
                size_bytes: bytes.len() as u64,
                mime_type: Some("application/octet-stream".into()),
                source: ArtifactSource::UserUpload,
                summary: Some(content_digest(&bytes)),
            },
            bytes.clone(),
        )
        .await
        .unwrap();
        let source = AttachmentRef {
            kind: AttachmentKind::Other,
            name: "file.bin".into(),
            mime_type: "application/octet-stream".into(),
            bytes: bytes.len() as u64,
            storage_ref: StorageRef::SessionFile {
                session_id: "source".into(),
                relative_path: "file".into(),
            },
        };
        let (sender, mut receiver) = mpsc::channel(1);
        let owner = log.clone();
        let read = tokio::spawn(async move {
            owner
                .connection
                .read(move |connection| Box::pin(stream(connection, source, sender)))
                .await
        });
        assert!(matches!(receiver.recv().await, Some(Frame::Header(..))));
        // The producer cannot buffer the remaining artifact while this channel
        // is paused. The source writer nevertheless commits independently.
        log.connection
            .run(|connection| {
                Box::pin(async move {
                    sqlx::query("DELETE FROM artifacts WHERE session_id='source' AND id='file'")
                        .execute(connection)
                        .await?;
                    Ok(())
                })
            })
            .await
            .unwrap();
        let mut observed = Vec::new();
        loop {
            match receiver.recv().await {
                Some(Frame::Chunk(chunk)) => observed.extend(chunk),
                Some(Frame::Complete) => break,
                _ => panic!("source snapshot lost"),
            }
        }
        assert_eq!(observed, bytes);
        read.await.unwrap().unwrap();
        Arc::try_unwrap(log)
            .ok()
            .expect("source reader released")
            .close()
            .await
            .unwrap();
    }
}
