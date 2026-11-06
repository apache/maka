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

const INSPECTION_CACHE_CAPACITY: usize = 8;

struct CachedInspection {
    key: String,
    log: Arc<EventLog>,
    through: u64,
    session_ids: Vec<String>,
}

enum CacheInsert {
    Cached {
        active: Arc<CachedInspection>,
        retired: Option<Arc<EventLog>>,
    },
    Uncached(Arc<CachedInspection>),
}

#[derive(Default)]
pub(in crate::root_store) struct Inspections {
    entries: std::sync::Mutex<Vec<Arc<CachedInspection>>>,
}

impl Inspections {
    pub(in crate::root_store) fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn get(&self, key: &str) -> Option<Arc<CachedInspection>> {
        let mut entries = self.entries.lock().unwrap();
        let position = entries.iter().position(|entry| entry.key == key)?;
        let entry = entries.remove(position);
        entries.push(entry.clone());
        Some(entry)
    }

    fn insert(&self, candidate: Arc<CachedInspection>) -> CacheInsert {
        let mut entries = self.entries.lock().unwrap();
        if let Some(position) = entries.iter().position(|entry| entry.key == candidate.key) {
            let existing = entries.remove(position);
            entries.push(existing.clone());
            let duplicate = Arc::try_unwrap(candidate)
                .unwrap_or_else(|_| unreachable!("fresh candidate has one owner"))
                .log;
            return CacheInsert::Cached {
                active: existing,
                retired: Some(duplicate),
            };
        }
        if entries.len() >= INSPECTION_CACHE_CAPACITY {
            let Some(idle) = entries
                .iter()
                .position(|entry| Arc::strong_count(entry) == 1)
            else {
                return CacheInsert::Uncached(candidate);
            };
            let evicted = Arc::try_unwrap(entries.remove(idle))
                .unwrap_or_else(|_| unreachable!("idle entry checked under lock"))
                .log;
            entries.push(candidate.clone());
            return CacheInsert::Cached {
                active: candidate,
                retired: Some(evicted),
            };
        }
        entries.push(candidate.clone());
        CacheInsert::Cached {
            active: candidate,
            retired: None,
        }
    }

    pub(in crate::root_store) fn request_shutdown(&self) {
        for entry in self.entries.lock().unwrap().iter() {
            entry.log.request_shutdown();
        }
    }

    pub(in crate::root_store) fn take_all(&self) -> Vec<Arc<EventLog>> {
        std::mem::take(&mut *self.entries.lock().unwrap())
            .into_iter()
            .map(|entry| entry.log.clone())
            .collect()
    }
}

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
                    LoadState::Preparing => resume(&log, &objects, &request, loaded, None).await,
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
            resume(&log, &objects, &request, loaded, Some(selected.manifest)).await
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

    /// Stream through one read-only inspection connection, with bounded chunks.
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
        self.with_loaded(operation, session.clone(), move |log, _| async move {
            let Some(record) = log.get_artifact(&session, &artifact).await?.record else {
                return emit(None).await;
            };
            let mut offset = offset;
            loop {
                let chunk = log
                    .read_artifact_chunk(&session, &artifact, offset, 32 * 1024)
                    .await?
                    .ok_or_else(|| invalid("inspection artifact payload missing"))?;
                let next = offset + chunk.bytes.len() as u64;
                let done = next >= chunk.total_bytes;
                if !done && next == offset {
                    return Err(invalid("inspection artifact made no progress"));
                }
                emit(Some((record.clone(), offset, chunk))).await?;
                if done {
                    return Ok(());
                }
                offset = next;
            }
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
        let work = self.session.control_dependency()?;
        let pin = gates
            .read([gates::Key::CheckpointLoad(key.clone())])
            .await?;
        if let Some(entry) = self.inspections.get(&key) {
            log.owned_root()?.validate_current()?;
            if !entry.session_ids.contains(&session) {
                return Err(StoreError::SessionNotFound);
            }
            let scoped = Arc::new(entry.log.scoped(Arc::new((log, work, pin, entry.clone()))));
            return action(scoped, entry.through).await;
        }
        drop((work, pin));
        let inspections = self.inspections.clone();
        let session_store = self.session.clone();
        read_worker(log, gates.clone(), move |log, objects| async move {
            let pin = gates
                .read([gates::Key::CheckpointLoad(key.clone())])
                .await?;
            if let Some(entry) = inspections.get(&key) {
                if !entry.session_ids.contains(&session) {
                    return Err(StoreError::SessionNotFound);
                }
                let work = session_store.control_dependency()?;
                let scoped = Arc::new(entry.log.scoped(Arc::new((log, work, pin, entry.clone()))));
                return action(scoped, entry.through).await;
            }
            let (request, loaded) = read(&log, key.clone())
                .await?
                .ok_or_else(|| invalid("checkpoint inspection missing"))?;
            let LoadState::Ready {
                ref session_ids,
                through,
                ref transfer_digest,
                ..
            } = loaded.state
            else {
                return Err(invalid("checkpoint inspection is not ready"));
            };
            if !session_ids.contains(&session) {
                return Err(StoreError::SessionNotFound);
            }
            let path = objects.inspection(&request.key()?, false)?;
            let target = Arc::new(
                EventLog::open_checkpoint_inspection(&path, objects.owner.clone(), through).await?,
            );
            let verified = async {
                let receipt = target
                    .bundle_import_receipt(transfer_digest, &request.binding()?)
                    .await?
                    .ok_or_else(|| invalid("checkpoint inspection import receipt missing"))?;
                if receipt.root_session_id != request.session_id
                    || &receipt.session_ids != session_ids
                {
                    return Err(invalid("checkpoint inspection inventory differs"));
                }
                Ok(())
            }
            .await;
            if let Err(error) = verified {
                return close(target, Err(error)).await;
            }
            let candidate = Arc::new(CachedInspection {
                key,
                log: target,
                through,
                session_ids: session_ids.clone(),
            });
            match inspections.insert(candidate) {
                CacheInsert::Cached { active, retired } => {
                    if let Some(retired) = retired {
                        close(retired, Ok(())).await?;
                    }
                    let work = session_store.control_dependency()?;
                    let scoped = Arc::new(active.log.scoped(Arc::new((
                        log,
                        work,
                        pin,
                        active.clone(),
                    ))));
                    action(scoped, active.through).await
                }
                CacheInsert::Uncached(entry) => {
                    let scoped = Arc::new(entry.log.scoped(Arc::new((log, pin))));
                    let result = action(scoped, entry.through).await;
                    close(entry.log.clone(), result).await
                }
            }
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
                        if let Err(error) =
                            resume(&log, &objects, &request, loaded.clone(), None).await
                        {
                            // Missing/corrupt material does not authorize recapture or block normal startup.
                            // SQL/IO uncertainty keeps Preparing for a later original-material retry.
                            let permanently_unavailable = match &error {
                                StoreError::InvalidTransition(_)
                                | StoreError::SessionConflict
                                | StoreError::EventConflict
                                | StoreError::ArtifactConflict => true,
                                StoreError::Io(io) => io.kind() == std::io::ErrorKind::NotFound,
                                _ => false,
                            };
                            if permanently_unavailable {
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
pub(super) async fn claim(
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
    let Manifest {
        root_id,
        scope,
        inventory,
        ..
    } = &value;
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
    let Manifest {
        transfer_digest,
        inventory,
        ..
    } = manifest(objects, request, loaded)?;
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
    verified_manifest: Option<Manifest>,
) -> Result<LoadedCheckpoint, StoreError> {
    let source = match verified_manifest {
        Some(source) => source,
        None => {
            let source = manifest(objects, request, &loaded)?;
            if let Some(snapshot) = source.workspace() {
                super::workspace::verify(objects, snapshot)?;
            }
            source
        }
    };
    let workspace = source.workspace().cloned();
    let Manifest {
        inventory,
        transfer_digest,
        ..
    } = &source;
    let inspection_path = objects.inspection(&request.key()?, true)?;
    let target = Arc::new(
        EventLog::open_owned(
            &inspection_path,
            Some(objects.owner.clone()),
            OpenPurpose::Execution,
        )
        .await?,
    );
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
            transfer_digest: transfer_digest.clone(),
            workspace,
        })
    }.await;
    let state = close(target, result).await?;
    std::fs::File::open(&inspection_path)?.sync_all()?;
    std::fs::File::open(
        inspection_path
            .parent()
            .ok_or_else(|| invalid("inspection directory missing"))?,
    )?
    .sync_all()?;
    boundary("load_imported");
    let value = write(log, request, LoadedCheckpoint { state, ..loaded }).await?;
    boundary("load_recorded");
    Ok(value)
}
