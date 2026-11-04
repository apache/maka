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

//! Checkpoint inspections never enter the live Root's Session routes or recovery queues.
use super::*;
use crate::checkpoints::{LoadOperation, LoadRequest, LoadState, LoadedCheckpoint, load_key};
use maka_agent_ports::session::history::{Page, Position};
use sqlx::Connection;
use std::collections::BTreeMap;
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
        let gates = self.session.gates.clone();
        let log = self.session.scoped().await?;
        worker(log, gates.clone(), move |log, objects| async move {
            let _pin = gates
                .write([gates::Key::CheckpointLoad(request.key()?)])
                .await?;
            if let Some((prior, loaded)) = read(&log, request.key()?).await? {
                if prior != request {
                    return Err(invalid("checkpoint load identity conflict"));
                }
                return match loaded.state {
                    LoadState::Preparing => resume(&log, &objects, &request, loaded).await,
                    _ => Ok(loaded),
                };
            }
            let selected = checkout(
                &log,
                &objects,
                request.scope.clone(),
                request.session_id.clone(),
                request.load.revision,
            )
            .await?;
            // Durable request and pinned material precede any destination writes.
            // Recheck Head at the claim's linearization point.
            let loaded = claim(&log, request.clone(), selected.head).await?;
            boundary("load_prepared");
            resume(&log, &objects, &request, loaded).await
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
            .map(|(prior, value)| {
                if prior != request {
                    return Err(invalid("checkpoint load identity conflict"));
                }
                Ok(value)
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
        self.with_loaded(operation, session.clone(), move |log, through| async move {
            maka_agent_ports::session::history::Read {
                session_id: session.clone(),
                through: Some(through),
                position,
                include_thinking: thinking,
            }
            .validate()
            .map_err(|error| invalid(error.to_string()))?;
            log.history_text(
                &session,
                through,
                position,
                thinking,
                crate::transcript::HistoryLimits {
                    max_bytes: 32 * 1024,
                    max_chunks: Some(8),
                    max_json_bytes: 64 * 1024,
                },
            )
            .await
        })
        .await
    }

    pub async fn loaded_artifacts(
        &self,
        operation: Uuid,
        session: String,
        offset: u64,
    ) -> Result<crate::artifacts::ArtifactPage, StoreError> {
        self.with_loaded(operation, session.clone(), move |log, _| async move {
            log.list_artifacts(&session, offset, 32).await
        })
        .await
    }

    pub async fn loaded_artifact(
        &self,
        operation: Uuid,
        session: String,
        artifact: String,
        offset: u64,
    ) -> Result<
        Option<(
            maka_agent_facts::artifact::Artifact,
            crate::artifacts::ArtifactChunk,
        )>,
        StoreError,
    > {
        self.with_loaded(operation, session.clone(), move |log, _| async move {
            let Some(record) = log.get_artifact(&session, &artifact).await?.record else {
                return Ok(None);
            };
            let chunk = log
                .read_artifact_chunk(&session, &artifact, offset, 32 * 1024)
                .await?
                .ok_or_else(|| invalid("inspection artifact payload missing"))?;
            Ok(Some((record, chunk)))
        })
        .await
    }

    async fn with_loaded<T, F, Fut>(
        &self,
        operation: Uuid,
        session: String,
        action: F,
    ) -> Result<T, StoreError>
    where
        T: Send + 'static,
        F: FnOnce(Arc<EventLog>, u64) -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, StoreError>> + Send + 'static,
    {
        let key = load_key(&self.scope, self.session.id(), operation)?;
        let log = self.session.scoped().await?;
        let gates = self.session.gates.clone();
        worker(log, gates.clone(), move |log, objects| async move {
            let _pin = gates
                .write([gates::Key::CheckpointLoad(key.clone())])
                .await?;
            let (request, loaded) = read(&log, key)
                .await?
                .ok_or_else(|| invalid("checkpoint inspection missing"))?;
            let LoadState::Ready {
                ref session_ids,
                through,
                ..
            } = loaded.state
            else {
                return Err(invalid("checkpoint inspection is not ready"));
            };
            if !session_ids.contains(&session) {
                return Err(StoreError::SessionNotFound);
            }
            let target = destination(&objects, &request, false).await?;
            let result = async {
                verify_receipt(&target, &objects, &request, &loaded).await?;
                action(target.clone(), through).await
            }
            .await;
            close(target, result).await
        })
        .await
    }
}

impl RootStore {
    pub(in crate::root_store) async fn recover_checkpoint_loads(&self) -> Result<(), StoreError> {
        for partition in &self.partitions {
            let log = partition.scoped(partition.clone());
            let pending = log.connection.read(|db| Box::pin(async move {
                Ok(sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM history_checkpoint_loads WHERE json_extract(result_json,'$.state.kind')='preparing')").fetch_one(db).await?)
            })).await?;
            if !pending {
                continue;
            }
            worker(log, self.gates.clone(), move |log, objects| async move {
                let mut after = String::new();
                loop {
                    let cursor = after.clone();
                    let pending: Vec<String> = log.connection.read(move |db| Box::pin(async move {
                        Ok(sqlx::query_scalar("SELECT load_key FROM history_checkpoint_loads WHERE json_extract(result_json,'$.state.kind')='preparing' AND load_key>? ORDER BY load_key LIMIT 32").bind(cursor).fetch_all(db).await?)
                    })).await?;
                    if pending.is_empty() {
                        break;
                    }
                    for key in pending {
                        after = key.clone();
                        let (request, loaded) = read(&log, key)
                            .await?
                            .ok_or_else(|| invalid("checkpoint load disappeared"))?;
                        if let Err(error) = resume(&log, &objects, &request, loaded.clone()).await {
                            // Missing/corrupt material does not authorize recapture or block normal startup.
                            // SQL/IO uncertainty keeps Preparing for a later original-material retry.
                            if matches!(
                                error,
                                StoreError::InvalidTransition(_) | StoreError::SessionConflict
                            ) {
                                write(
                                    &log,
                                    &request,
                                    LoadedCheckpoint {
                                        state: LoadState::Unavailable,
                                        ..loaded
                                    },
                                )
                                .await?;
                            } else {
                                eprintln!("Checkpoint inspection recovery remains pending: {error}");
                            }
                        }
                    }
                }
                Ok(())
            })
            .await?;
        }
        Ok(())
    }
}

async fn read(
    log: &EventLog,
    key: String,
) -> Result<Option<(LoadRequest, LoadedCheckpoint)>, StoreError> {
    log.connection.read(move |db| Box::pin(async move {
        let row: Option<(String, String)> = sqlx::query_as("SELECT request_json,result_json FROM history_checkpoint_loads WHERE load_key=?").bind(key).fetch_optional(db).await?;
        row.map(|(request, result)| Ok((serde_json::from_str(&request)?, serde_json::from_str(&result)?))).transpose()
    })).await
}
async fn claim(
    log: &EventLog,
    request: LoadRequest,
    head: Head,
) -> Result<LoadedCheckpoint, StoreError> {
    log.connection
        .run(move |db| {
            Box::pin(async move {
                let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
                let current: Option<String> = sqlx::query_scalar(
                    "SELECT head_json FROM history_checkpoint_heads WHERE session_id=?",
                )
                .bind(&request.session_id)
                .fetch_optional(&mut *tx)
                .await?;
                if current
                    .map(|v| serde_json::from_str::<Head>(&v))
                    .transpose()?
                    .as_ref()
                    != Some(&head)
                {
                    return Err(invalid("history checkpoint revision unavailable"));
                }
                let value = LoadedCheckpoint {
                    head,
                    state: LoadState::Preparing,
                };
                sqlx::query("INSERT INTO history_checkpoint_loads VALUES(?,?,?)")
                    .bind(request.key()?)
                    .bind(serde_json::to_string(&request)?)
                    .bind(serde_json::to_string(&value)?)
                    .execute(&mut *tx)
                    .await?;
                tx.commit().await.map_err(StoreError::CommitUnknown)?;
                Ok(value)
            })
        })
        .await
}
async fn write(
    log: &EventLog,
    request: &LoadRequest,
    value: LoadedCheckpoint,
) -> Result<LoadedCheckpoint, StoreError> {
    let key = request.key()?;
    log.connection
        .run(move |db| {
            Box::pin(async move {
                let result = sqlx::query(
                    "UPDATE history_checkpoint_loads SET result_json=? WHERE load_key=?",
                )
                .bind(serde_json::to_string(&value)?)
                .bind(key)
                .execute(db)
                .await?;
                if result.rows_affected() != 1 {
                    return Err(invalid("checkpoint load receipt missing"));
                }
                Ok(value)
            })
        })
        .await
}

async fn destination(
    objects: &Objects,
    request: &LoadRequest,
    create: bool,
) -> Result<Arc<EventLog>, StoreError> {
    // Only this private module can open the inspection database. No live routes,
    // execution configuration, recovery scheduler or EventLog handle are exported.
    let path = objects.inspection(&request.key()?, create)?;
    Ok(Arc::new(
        EventLog::open_owned(&path, Some(objects.owner.clone()), OpenPurpose::Execution).await?,
    ))
}
async fn close<T>(target: Arc<EventLog>, result: Result<T, StoreError>) -> Result<T, StoreError> {
    if let Err(error) = target.shutdown().await {
        // Keep the physical worker, Root custody and per-inspection gate until SQL ends.
        target.drain().await;
        return Err(error);
    }
    result
}
fn manifest(
    objects: &Objects,
    request: &LoadRequest,
    loaded: &LoadedCheckpoint,
) -> Result<Manifest, StoreError> {
    let value = objects.manifest(&loaded.head.manifest)?;
    let (Manifest::NativeHistory {
        root_id,
        scope,
        inventory,
        ..
    }
    | Manifest::NativeSession {
        root_id,
        scope,
        inventory,
        ..
    }) = &value;
    if loaded.head.revision != request.load.revision
        || root_id != objects.root_id()
        || scope != &request.scope
        || inventory.root_session_id != request.session_id
    {
        return Err(invalid("checkpoint inspection origin differs"));
    }
    Ok(value)
}
async fn verify_receipt(
    target: &EventLog,
    objects: &Objects,
    request: &LoadRequest,
    loaded: &LoadedCheckpoint,
) -> Result<(), StoreError> {
    let (Manifest::NativeHistory {
        transfer_digest,
        inventory,
        ..
    }
    | Manifest::NativeSession {
        transfer_digest,
        inventory,
        ..
    }) = manifest(objects, request, loaded)?;
    let receipt = target
        .bundle_import_receipt(&transfer_digest, &request.binding()?)
        .await?
        .ok_or_else(|| invalid("checkpoint inspection import receipt missing"))?;
    if receipt.root_session_id != inventory.root_session_id
        || receipt.session_ids
            != inventory
                .sessions
                .iter()
                .map(|s| s.id.clone())
                .collect::<Vec<_>>()
    {
        return Err(invalid("checkpoint inspection inventory differs"));
    }
    Ok(())
}
async fn resume(
    log: &EventLog,
    objects: &Objects,
    request: &LoadRequest,
    loaded: LoadedCheckpoint,
) -> Result<LoadedCheckpoint, StoreError> {
    let source = manifest(objects, request, &loaded)?;
    let workspace = source.workspace().cloned();
    if let Some(snapshot) = &workspace {
        super::workspace::verify(objects, snapshot)?;
        objects.inspection_workspace(&request.key()?, snapshot)?;
    }
    let (Manifest::NativeHistory {
        inventory,
        transfer_digest,
        ..
    }
    | Manifest::NativeSession {
        inventory,
        transfer_digest,
        ..
    }) = &source;
    let target = destination(objects, request, true).await?;
    let result = async {
        if target.bundle_import_receipt(transfer_digest, &request.binding()?).await?.is_none() {
            // An unclaimed nonempty database is never adopted or overwritten.
            let nonempty = target.connection.read(|db| Box::pin(async move {
                Ok(sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM session_control) OR EXISTS(SELECT 1 FROM event_log)").fetch_one(db).await?)
            })).await?;
            if nonempty {
                return Err(invalid("checkpoint inspection destination is occupied"));
            }
            let file = objects.read(source.bundle())?;
            let mut staged = StagedBundle::read(tokio::fs::File::from_std(file))
                .await.map_err(bundle_error)?;
            let checked = async {
                staged.validate_history().await.map_err(bundle_error)?;
                if staged.summary().inventory != *inventory
                    || staged.summary().digest != *transfer_digest
                {
                    return Err(invalid("checkpoint inspection bundle differs from manifest"));
                }
                Ok(())
            }.await;
            if let Err(error) = checked {
                staged.close().await.map_err(bundle_error)?;
                return Err(error);
            }
            let configurations = inventory.sessions.iter()
                .map(|session| (session.id.clone(), serde_json::json!({"kind":"checkpoint_inspection"})))
                .collect::<BTreeMap<_,_>>();
            target.import_bundle(staged, &request.binding()?, configurations)
                .await.map_err(bundle_error)?;
        }
        verify_receipt(&target, objects, request, &loaded).await?;
        Ok(LoadState::Ready {
            session_ids: inventory.sessions.iter().map(|s| s.id.clone()).collect(),
            through: target.committed_sequence().await?,
            workspace,
        })
    }.await;
    let state = close(target, result).await?;
    boundary("load_imported");
    let value = write(log, request, LoadedCheckpoint { state, ..loaded }).await?;
    boundary("load_recorded");
    Ok(value)
}
