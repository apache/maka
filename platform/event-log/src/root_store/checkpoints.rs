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

//! Root-owned physical checkpoint work. Caller cancellation never releases SQL
//! or file custody before the original worker has actually stopped.
use super::*;
use crate::checkpoints::{
    Head, Manifest, ObjectRef, Publication, PublicationRequest, PublicationState, Request,
    Revision, Scope, invalid,
};
use std::future::Future;
pub(crate) mod authority;
mod journal;
pub(in crate::root_store) mod load;
mod local;
mod objects;
pub mod portable;
pub(crate) mod restore;
pub(crate) mod workspace;
use crate::checkpoints::repository::VerifiedCheckpoint;
use objects::Objects;

#[derive(Clone)]
pub struct HistoryCheckpoints {
    session: SessionStore,
    scope: Scope,
}

pub use crate::checkpoints::Checkout;

impl RootStore {
    /// Trusted assembly only. The Agent owner must authorize its namespace and Session.
    pub async fn history_checkpoints(
        &self,
        session: &str,
        scope: Scope,
    ) -> Result<HistoryCheckpoints, StoreError> {
        self.require_open()?;
        scope
            .namespace
            .validate()
            .map_err(|e| invalid(e.to_string()))?;
        Ok(HistoryCheckpoints {
            session: self.session(session).await?,
            scope,
        })
    }

    pub(super) async fn recover_checkpoints(&self) -> Result<(), StoreError> {
        {
            let log = &self.log;
            if journal::pending(log, String::new()).await?.is_empty() {
                return Ok(());
            }
            let log = log.scoped(log.clone());
            worker(log, self.gates.clone(), |log, objects| async move {
                let mut after = String::new();
                loop {
                    let entries = journal::pending(&log, after.clone()).await?;
                    if entries.is_empty() {
                        break;
                    }
                    for (key, request, value) in entries {
                        after = key;
                        match value.state {
                            PublicationState::Capturing => {
                                journal::interrupt(&log, request.clone()).await?
                            }
                            PublicationState::Prepared { manifest } => {
                                resume(&log, &objects, &request, manifest).await?;
                            }
                            _ => {}
                        }
                        // A durable cleanup_pending flag survives failures without
                        // making unrelated live Sessions unavailable at startup.
                        let _ = cleanup(&log, &objects, &request).await;
                    }
                }
                Ok(())
            })
            .await?;
        }
        Ok(())
    }
}

impl HistoryCheckpoints {
    /// Resolve trusted source binding before consulting a possibly changed live Session.
    pub async fn original_request(
        &self,
        publication: PublicationRequest,
    ) -> Result<Option<PublicationRequest>, StoreError> {
        journal::original(&self.session.scoped().await?, self.request(publication)?).await
    }
    fn request(&self, publication: PublicationRequest) -> Result<Request, StoreError> {
        let request = Request {
            scope: self.scope.clone(),
            session_id: self.session.id().into(),
            publication,
        };
        request.validate()?;
        Ok(request)
    }

    pub async fn publish(
        &self,
        publication: PublicationRequest,
        snapshot: std::fs::File,
    ) -> Result<Publication, StoreError> {
        if publication.workspace.is_some() {
            return Err(invalid(
                "workspace publication requires its original physical fence",
            ));
        }
        self.publish_inner(publication, snapshot, None).await
    }

    pub async fn publish_fenced(
        &self,
        publication: PublicationRequest,
        snapshot: std::fs::File,
        fence: &WorkspaceFence,
    ) -> Result<Publication, StoreError> {
        fence.validate_owner(&self.session.owner()?.owned_root()?)?;
        self.publish_inner(publication, snapshot, Some(fence.clone()))
            .await
    }

    async fn publish_inner(
        &self,
        publication: PublicationRequest,
        snapshot: std::fs::File,
        fence: Option<WorkspaceFence>,
    ) -> Result<Publication, StoreError> {
        let request = self.request(publication)?;
        let mut log = self.session.scoped().await?;
        if let Some(fence) = &fence {
            log = log.scoped(Arc::new(fence.clone()));
        }
        worker(
            log,
            self.session.gates.clone(),
            move |log, objects| async move {
                let (mut value, inserted) = journal::claim(&log, request.clone()).await?;
                if !inserted {
                    if let PublicationState::Prepared { manifest } = &value.state {
                        value = resume(&log, &objects, &request, manifest.clone()).await?;
                    } else if value.state == PublicationState::Capturing {
                        // The original physical worker owns this unfinished capture.
                        return Ok(value);
                    }
                    return Ok(finish_cleanup(&log, &objects, &request, value).await);
                }
                boundary("claimed");
                let prepared = capture(&objects, &request, snapshot, fence.as_ref());
                let (manifest, verified) = match prepared {
                    Ok(captured) => captured,
                    Err(error) => {
                        // Only capture has run: no Head commit can be outstanding here.
                        journal::interrupt(&log, request.clone()).await?;
                        let _ = cleanup(&log, &objects, &request).await;
                        return Err(error);
                    }
                };
                if let Err(error) = journal::prepare(&log, request.clone(), manifest.clone()).await
                {
                    // The physical capture has ended. Only interrupt Capturing:
                    // an unknown prepare commit may already have retained these bytes.
                    journal::interrupt(&log, request.clone()).await?;
                    let _ = cleanup(&log, &objects, &request).await;
                    return Err(error);
                }
                boundary("prepared");
                // Fresh local capture carries its verification; recovery rechecks retained bytes.
                let value = authority::commit(&log, &objects, &request, manifest, verified).await?;
                boundary("published");
                Ok(finish_cleanup(&log, &objects, &request, value).await)
            },
        )
        .await
    }

    pub async fn receipt(
        &self,
        publication: PublicationRequest,
    ) -> Result<Option<Publication>, StoreError> {
        let request = self.request(publication)?;
        let log = self.session.scoped().await?;
        let Some(mut value) = journal::read(&log, request.clone()).await? else {
            return Ok(None);
        };
        if let PublicationState::Prepared { manifest } = &value.state
            && let Some(receipt) = authority::receipt(&log, &request, manifest.clone()).await?
        {
            value.state = match receipt {
                crate::checkpoints::repository::CommitReceipt::Published { head } => {
                    PublicationState::Published { head }
                }
                crate::checkpoints::repository::CommitReceipt::Conflict { actual } => {
                    PublicationState::Conflict { actual }
                }
            };
        }
        Ok(Some(value))
    }

    pub async fn read_head(&self) -> Result<Option<Head>, StoreError> {
        authority::head(
            &self.session.scoped().await?,
            self.scope.clone(),
            self.session.id().into(),
        )
        .await
    }

    pub async fn checkout_exact(&self, revision: Revision) -> Result<Checkout, StoreError> {
        let scope = self.scope.clone();
        let session = self.session.id().to_owned();
        let log = self.session.scoped().await?;
        worker(
            log,
            self.session.gates.clone(),
            move |log, objects| async move {
                checkout(&log, &objects, scope, session, revision).await
            },
        )
        .await
    }
}

async fn checkout(
    log: &EventLog,
    objects: &Objects,
    scope: Scope,
    session: String,
    revision: Revision,
) -> Result<Checkout, StoreError> {
    let (head, manifest) = selected_checkpoint(log, objects, &scope, &session, revision).await?;
    let snapshot = objects.read(&manifest.history.object)?;
    // Confirm the retained revision again after expensive verification.
    if authority::head(log, scope, session).await?.as_ref() != Some(&head) {
        return Err(invalid("history checkpoint revision unavailable"));
    }
    Ok(Checkout {
        head,
        manifest,
        snapshot,
    })
}

async fn selected_checkpoint(
    log: &EventLog,
    objects: &Objects,
    scope: &Scope,
    session: &str,
    revision: Revision,
) -> Result<(Head, Manifest), StoreError> {
    let head = authority::head(log, scope.clone(), session.to_owned())
        .await?
        .filter(|head| head.revision == revision)
        .ok_or_else(|| invalid("history checkpoint revision unavailable"))?;
    let manifest = objects.manifest(&head.manifest)?;
    let Manifest {
        root_id,
        scope: origin,
        session_id,
        ..
    } = &manifest;
    if root_id != objects.root_id() || origin != scope || session_id != session {
        return Err(invalid("history checkpoint origin differs"));
    }
    if let Some(snapshot) = manifest.workspace() {
        workspace::verify(objects, snapshot)?;
    }
    Ok((head, manifest))
}

fn capture(
    objects: &Objects,
    request: &Request,
    mut snapshot: std::fs::File,
    fence: Option<&WorkspaceFence>,
) -> Result<(ObjectRef, Option<VerifiedCheckpoint>), StoreError> {
    use std::io::{Read, Seek, SeekFrom};
    if !snapshot.metadata()?.is_file() {
        return Err(invalid("checkpoint snapshot is not a regular file"));
    }
    snapshot.seek(SeekFrom::Start(0))?;
    let expected = &request.publication.history.object;
    let limit = expected
        .bytes
        .checked_add(1)
        .ok_or_else(|| invalid("checkpoint snapshot size overflow"))?;
    let mut file = objects.create(request, "snapshot")?;
    let bytes = std::io::copy(&mut snapshot.take(limit), &mut file)?;
    if bytes != expected.bytes {
        return Err(invalid("checkpoint snapshot size differs"));
    }
    file.sync_all()?;
    drop(file);
    let path = objects.staging(request, "snapshot")?;
    let reference = objects::measure(&mut std::fs::File::open(&path)?)?;
    if &reference != expected {
        return Err(invalid("checkpoint snapshot digest or size differs"));
    }
    objects.link_staged(&path, &reference)?;
    boundary("payload");
    let workspace = request
        .publication
        .workspace
        .as_ref()
        .map(|source| {
            let fence = fence.ok_or_else(|| invalid("workspace publication fence missing"))?;
            fence.validate_owner(&objects.owner)?;
            workspace::capture(objects, request, source, fence.directory()?)
        })
        .transpose()?;
    let manifest = Manifest {
        root_id: objects.root_id().into(),
        scope: request.scope.clone(),
        session_id: request.session_id.clone(),
        history: request.publication.history.clone(),
        workspace,
    };
    let reference = objects.publish_manifest(request, &manifest)?;
    objects.finish_capture()?;
    let verified = objects.is_local().then(|| {
        VerifiedCheckpoint::captured(objects.storage().identity(), reference.clone(), manifest)
    });
    Ok((reference, verified))
}

async fn resume(
    log: &EventLog,
    objects: &Objects,
    request: &Request,
    manifest: ObjectRef,
) -> Result<Publication, StoreError> {
    authority::commit(log, objects, request, manifest, None).await
}

async fn finish_cleanup(
    log: &EventLog,
    objects: &Objects,
    request: &Request,
    mut value: Publication,
) -> Publication {
    // Acknowledged publication does not depend on a second read or cleanup commit.
    match cleanup(log, objects, request).await {
        Ok(cause) => {
            value.cleanup_pending = cause.is_some();
            value.cleanup_error = cause;
        }
        Err(error) => {
            value.cleanup_pending = true;
            value.cleanup_error = Some(format!("cleanup receipt not confirmed: {error}"));
        }
    }
    value
}

async fn cleanup(
    log: &EventLog,
    objects: &Objects,
    request: &Request,
) -> Result<Option<String>, StoreError> {
    boundary("cleanup");
    let cause = objects
        .cleanup(request)
        .err()
        .map(|error| error.to_string());
    journal::record_cleanup(log, request.clone(), cause.clone()).await?;
    Ok(cause)
}

struct PhysicalWork {
    custody: Option<Arc<EventLog>>,
    gates: Arc<gates::Gates>,
    root: Arc<root::RootOwner>,
    complete: bool,
}
impl Drop for PhysicalWork {
    fn drop(&mut self) {
        if self.complete {
            drop(self.custody.take());
            self.gates.finish_work();
        } else {
            self.gates
                .retain_unconfirmed(Arc::new((self.root.clone(), self.custody.take())));
        }
    }
}

async fn worker<T, F, Fut>(
    log: EventLog,
    gates: Arc<gates::Gates>,
    action: F,
) -> Result<T, StoreError>
where
    T: Send + 'static,
    F: FnOnce(EventLog, Objects) -> Fut + Send + 'static,
    Fut: Future<Output = Result<T, StoreError>> + Send + 'static,
{
    physical_worker(log, gates, Objects::open, action).await
}

async fn read_worker<T, F, Fut>(
    log: EventLog,
    gates: Arc<gates::Gates>,
    action: F,
) -> Result<T, StoreError>
where
    T: Send + 'static,
    F: FnOnce(EventLog, Objects) -> Fut + Send + 'static,
    Fut: Future<Output = Result<T, StoreError>> + Send + 'static,
{
    physical_worker(log, gates, Objects::existing, action).await
}

async fn physical_worker<T, F, Fut>(
    log: EventLog,
    gates: Arc<gates::Gates>,
    open: fn(Arc<root::RootOwner>) -> Result<Objects, StoreError>,
    action: F,
) -> Result<T, StoreError>
where
    T: Send + 'static,
    F: FnOnce(EventLog, Objects) -> Fut + Send + 'static,
    Fut: Future<Output = Result<T, StoreError>> + Send + 'static,
{
    let root = log.owned_root()?;
    let storage = log
        .checkpoint
        .as_ref()
        .ok_or_else(|| invalid("checkpoint authority is not configured"))?
        .storage()
        .cloned();
    gates.start_work()?;
    let custody = Arc::new(log);
    let log = custody.scoped(custody.clone());
    let mut work = PhysicalWork {
        custody: Some(custody),
        gates,
        root: root.clone(),
        complete: true,
    };
    let (send, receive) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("history-checkpoint".into())
        .spawn(move || {
            work.complete = false;
            let result = (|| {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()?;
                let mut objects = open(root)?;
                if let Some(storage) = storage {
                    objects.use_shared(storage.objects);
                }
                runtime.block_on(action(log, objects))
            })();
            work.complete = true;
            drop(work);
            let _ = send.send(result);
        })?;
    receive.await.map_err(|_| StoreError::OperationUnknown)?
}

fn boundary(_: &str) {}
