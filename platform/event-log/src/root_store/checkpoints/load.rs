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

//! Load receipts reference an immutable snapshot; they never create a Session.
use super::*;
use crate::checkpoints::{LoadOperation, LoadRequest, LoadState, LoadedCheckpoint, load_key};
use crate::transcript::{HistoryLimits, HistoryOwner};
use maka_agent_ports::session::history::{HistoryView, Page, Position};
use sqlx::Connection;
use uuid::Uuid;

impl HistoryCheckpoints {
    fn load_request(&self, load: LoadOperation) -> Result<LoadRequest, StoreError> {
        let request = LoadRequest {
            scope: self.scope.clone(),
            session_id: self.session.id().into(),
            load,
        };
        request.validate()?;
        Ok(request)
    }

    pub async fn load_exact(&self, load: LoadOperation) -> Result<LoadedCheckpoint, StoreError> {
        let request = self.load_request(load)?;
        let log = self.session.scoped().await?;
        let gates = self.session.gates.clone();
        read_worker(log, gates.clone(), move |log, objects| async move {
            let _pin = gates
                .write([gates::Key::CheckpointLoad(request.key()?)])
                .await?;
            if let Some((prior, loaded)) = read(&log, request.key()?).await? {
                if prior != request {
                    return Err(invalid("checkpoint load identity conflict"));
                }
                return Ok(loaded);
            }
            let head = journal::read_head(&log, request.scope.clone(), request.session_id.clone())
                .await?
                .filter(|head| head.revision == request.load.revision)
                .ok_or_else(|| invalid("history checkpoint revision unavailable"))?;
            let manifest = objects.manifest(&head.manifest)?;
            if manifest.root_id != objects.root_id()
                || manifest.scope != request.scope
                || manifest.inventory.root_session_id != request.session_id
            {
                return Err(invalid("checkpoint origin differs"));
            }
            if let Some(snapshot) = manifest.workspace() {
                workspace::verify(&objects, snapshot)?;
            }
            claim(&log, request, head, manifest).await
        })
        .await
    }

    pub async fn load_receipt(
        &self,
        load: LoadOperation,
    ) -> Result<Option<LoadedCheckpoint>, StoreError> {
        let request = self.load_request(load)?;
        read(&self.session.scoped().await?, request.key()?)
            .await?
            .map(|(prior, loaded)| {
                if prior != request {
                    return Err(invalid("checkpoint load identity conflict"));
                }
                Ok(loaded)
            })
            .transpose()
    }

    pub async fn loaded_history(
        &self,
        operation: Uuid,
        session: String,
        position: Position,
        thinking: bool,
    ) -> Result<Page, StoreError> {
        let (log, capture, through, _) = self.loaded(operation, &session).await?;
        log.history_view_owned(
            HistoryOwner::snapshot(capture, session),
            through,
            position,
            thinking,
            HistoryView::Text,
            HistoryLimits {
                max_bytes: 32 * 1024,
                max_chunks: Some(8),
                max_json_bytes: 64 * 1024,
            },
        )
        .await
    }

    pub async fn loaded_artifacts(
        &self,
        operation: Uuid,
        session: String,
        offset: u64,
    ) -> Result<crate::artifacts::ArtifactPage, StoreError> {
        let offset = i64::try_from(offset).map_err(|_| StoreError::ArtifactOffset)?;
        let (log, capture, _, revision) = self.loaded(operation, &session).await?;
        log.connection.read(move |db| Box::pin(async move {
            let mut tx = db.begin().await?;
            let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM history_snapshot_artifacts WHERE capture_key=? AND session_id=?")
                .bind(&capture).bind(&session).fetch_one(&mut *tx).await?;
            let rows: Vec<String> = sqlx::query_scalar("SELECT record_json FROM history_snapshot_artifacts WHERE capture_key=? AND session_id=? ORDER BY json_extract(record_json,'$.createdAt') DESC,id ASC LIMIT 32 OFFSET ?")
                .bind(capture).bind(session).bind(offset).fetch_all(&mut *tx).await?;
            let records = rows.into_iter().map(|raw| serde_json::from_str(&raw)).collect::<Result<_,_>>()?;
            Ok(crate::artifacts::ArtifactPage { revision, records, total: total as u64 })
        })).await
    }

    pub async fn stream_loaded_artifact<F, Fut>(
        &self,
        operation: Uuid,
        session: String,
        artifact: String,
        offset: u64,
        mut emit: F,
    ) -> Result<(), StoreError>
    where
        F: FnMut(
                Option<(
                    maka_agent_facts::artifact::Artifact,
                    u64,
                    crate::artifacts::ArtifactChunk,
                )>,
            ) -> Fut
            + Send
            + 'static,
        Fut: Future<Output = Result<(), StoreError>> + Send + 'static,
    {
        crate::sessions::validate_id(&artifact)?;
        let (log, capture, _, _) = self.loaded(operation, &session).await?;
        let mut offset = offset;
        loop {
            let (capture, session, artifact) = (capture.clone(), session.clone(), artifact.clone());
            let at = i64::try_from(offset).map_err(|_| StoreError::ArtifactOffset)?;
            let row: Option<(String,i64,Vec<u8>)> = log.connection.read(move |db| Box::pin(async move {
                Ok(sqlx::query_as("SELECT a.record_json,length(c.payload),substr(c.payload,?4+1,32768) FROM history_snapshot_artifacts a JOIN contents c USING(content_sha256) WHERE a.capture_key=?1 AND a.session_id=?2 AND a.id=?3")
                    .bind(capture).bind(session).bind(artifact).bind(at).fetch_optional(db).await?)
            })).await?;
            let Some((raw, total, bytes)) = row else {
                return emit(None).await;
            };
            let total = crate::sequence_number(total)?;
            if offset > total {
                return Err(StoreError::ArtifactOffset);
            }
            let next = offset + bytes.len() as u64;
            emit(Some((
                serde_json::from_str(&raw)?,
                offset,
                crate::artifacts::ArtifactChunk {
                    total_bytes: total,
                    bytes,
                },
            )))
            .await?;
            if next >= total {
                return Ok(());
            }
            offset = next;
        }
    }

    async fn loaded(
        &self,
        operation: Uuid,
        session: &str,
    ) -> Result<(EventLog, String, u64, String), StoreError> {
        crate::sessions::validate_id(session)?;
        let key = load_key(&self.scope, self.session.id(), operation)?;
        let log = self.session.scoped().await?;
        let (_, loaded) = read(&log, key)
            .await?
            .ok_or_else(|| invalid("checkpoint load receipt missing"))?;
        let LoadState::Ready {
            session_ids,
            through,
            ..
        } = &loaded.state
        else {
            return Err(invalid("checkpoint is not ready"));
        };
        if !session_ids.iter().any(|id| id == session) {
            return Err(StoreError::SessionNotFound);
        }
        let digest = loaded.head.manifest.digest;
        let lookup = digest.clone();
        let capture = log
            .connection
            .read(move |db| {
                Box::pin(async move {
                    sqlx::query_scalar("SELECT capture_key FROM history_snapshots WHERE digest=?")
                        .bind(lookup)
                        .fetch_optional(db)
                        .await?
                        .ok_or(StoreError::MaterialCollected)
                })
            })
            .await?;
        Ok((log, capture, *through, digest))
    }
}

async fn read(
    log: &EventLog,
    key: String,
) -> Result<Option<(LoadRequest, LoadedCheckpoint)>, StoreError> {
    log.connection.read(move |db|Box::pin(async move {
        let row:Option<(String,String)>=sqlx::query_as("SELECT request_json,result_json FROM history_checkpoint_loads WHERE load_key=?").bind(key).fetch_optional(db).await?;
        row.map(|(request,result)|Ok((serde_json::from_str(&request)?,serde_json::from_str(&result)?))).transpose()
    })).await
}

async fn claim(
    log: &EventLog,
    request: LoadRequest,
    head: Head,
    manifest: Manifest,
) -> Result<LoadedCheckpoint, StoreError> {
    log.connection.run(move |db|Box::pin(async move {
        let mut tx=db.begin_with("BEGIN IMMEDIATE").await?;
        let current:Option<String>=sqlx::query_scalar("SELECT head_json FROM history_checkpoint_heads WHERE session_id=?").bind(&request.session_id).fetch_optional(&mut *tx).await?;
        if current.as_deref().map(serde_json::from_str::<Head>).transpose()?.as_ref()!=Some(&head) {
            return Err(invalid("history checkpoint revision unavailable"));
        }
        let through:i64=sqlx::query_scalar("SELECT c.through_sequence FROM history_snapshots s JOIN history_snapshot_captures c USING(capture_key) WHERE s.digest=?")
            .bind(&head.manifest.digest).fetch_optional(&mut *tx).await?.ok_or(StoreError::MaterialCollected)?;
        let value=LoadedCheckpoint { head, state:LoadState::Ready {
            session_ids:manifest.inventory.sessions.iter().map(|s|s.id.clone()).collect(),
            through:crate::sequence_number(through)?, workspace:manifest.workspace().cloned(), transfer_digest:manifest.transfer_digest
        }};
        sqlx::query("INSERT INTO history_checkpoint_loads VALUES(?,?,?)")
            .bind(request.key()?).bind(serde_json::to_string(&request)?).bind(serde_json::to_string(&value)?).execute(&mut *tx).await?;
        tx.commit().await.map_err(StoreError::CommitUnknown)?;
        Ok(value)
    })).await
}
