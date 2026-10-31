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
use crate::bundle::{BundleError, StagedBundle};
use crate::checkpoints::{
    Head, Manifest, ObjectRef, Publication, PublicationRequest, PublicationState, Request,
    Revision, Scope, invalid,
};
use std::future::Future;
mod journal;
mod objects;
use objects::Objects;

#[derive(Clone)]
pub struct HistoryCheckpoints {
    session: SessionStore,
    scope: Scope,
}

#[derive(Debug)]
pub struct Checkout {
    pub head: Head,
    pub manifest: Manifest,
    /// Verified, rewound bytes; this is history material, not activation authority.
    pub bundle: std::fs::File,
}

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
        for partition in &self.partitions {
            if journal::pending(partition, String::new()).await?.is_empty() {
                continue;
            }
            let log = partition.scoped(partition.clone());
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
    ) -> Result<Publication, StoreError> {
        let request = self.request(publication)?;
        let log = self.session.scoped().await?;
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
                let prepared = capture(&log, &objects, &request).await;
                let manifest = match prepared {
                    Ok(manifest) => manifest,
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
                // capture already validated these immutable objects; recovery
                // independently verifies retained bytes before resuming.
                let value = journal::commit(&log, request.clone(), manifest).await?;
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
        journal::read(&self.session.scoped().await?, request).await
    }

    pub async fn read_head(&self) -> Result<Option<Head>, StoreError> {
        journal::read_head(
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
                let head = journal::read_head(&log, scope.clone(), session.clone())
                    .await?
                    .filter(|head| head.revision == revision)
                    .ok_or_else(|| invalid("history checkpoint revision unavailable"))?;
                let manifest = objects.manifest(&head.manifest)?;
                let Manifest::NativeHistory {
                    root_id,
                    scope: origin,
                    inventory,
                    ..
                } = &manifest;
                if root_id != objects.root_id()
                    || origin != &scope
                    || inventory.root_session_id != session
                {
                    return Err(invalid("history checkpoint origin differs"));
                }
                let bundle = objects.read(manifest.bundle())?;
                // Confirm the retained revision again after expensive verification.
                if journal::read_head(&log, scope, session).await?.as_ref() != Some(&head) {
                    return Err(invalid("history checkpoint revision unavailable"));
                }
                Ok(Checkout {
                    head,
                    manifest,
                    bundle,
                })
            },
        )
        .await
    }
}

fn bundle_error(error: BundleError) -> StoreError {
    match error {
        BundleError::Store(error) => error,
        BundleError::CandidateSetStale => invalid("confirmed checkpoint subtree changed"),
    }
}

async fn capture(
    log: &EventLog,
    objects: &Objects,
    request: &Request,
) -> Result<ObjectRef, StoreError> {
    let file = tokio::fs::File::from_std(objects.create(request, "bundle")?);
    let (file, summary) = log
        .export_bundle(
            &request.session_id,
            &request.publication.confirmed_subtree_digest,
            file,
        )
        .await
        .map_err(bundle_error)?;
    file.sync_all().await?;
    drop(file);
    let bundle = objects.publish(&objects.staging(request, "bundle")?)?;
    boundary("payload");
    let manifest = Manifest::NativeHistory {
        root_id: objects.root_id().into(),
        scope: request.scope.clone(),
        inventory: summary.inventory,
        bundle,
        transfer_digest: summary.digest,
    };
    validate_bundle(objects, &manifest).await?;
    objects.publish_manifest(request, &manifest)
}

async fn validate_bundle(objects: &Objects, manifest: &Manifest) -> Result<(), StoreError> {
    let Manifest::NativeHistory {
        inventory,
        bundle,
        transfer_digest,
        ..
    } = manifest;
    let file = tokio::fs::File::from_std(objects.read(bundle)?);
    let mut staged = StagedBundle::read(file).await.map_err(bundle_error)?;
    let result = async {
        if &staged.summary().inventory != inventory
            || &staged.summary().digest != transfer_digest
            || staged.summary().bytes != bundle.bytes
        {
            return Err(invalid("checkpoint manifest and bundle differ"));
        }
        staged.validate_history().await.map_err(bundle_error)
    }
    .await;
    let closed = staged.close().await.map_err(bundle_error);
    result.and(closed)
}

async fn verify(
    objects: &Objects,
    request: &Request,
    reference: &ObjectRef,
) -> Result<(), StoreError> {
    let manifest = objects.manifest(reference)?;
    let Manifest::NativeHistory {
        root_id,
        scope,
        inventory,
        ..
    } = &manifest;
    if root_id != objects.root_id()
        || scope != &request.scope
        || inventory.root_session_id != request.session_id
        || inventory.subtree_digest != request.publication.confirmed_subtree_digest
    {
        return Err(invalid("checkpoint manifest origin or membership differs"));
    }
    validate_bundle(objects, &manifest).await
}

async fn resume(
    log: &EventLog,
    objects: &Objects,
    request: &Request,
    manifest: ObjectRef,
) -> Result<Publication, StoreError> {
    match verify(objects, request, &manifest).await {
        Ok(()) => journal::commit(log, request.clone(), manifest).await,
        Err(error) => journal::unavailable(log, request.clone(), manifest, error.to_string()).await,
    }
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
    gates: Arc<gates::Gates>,
    root: Arc<root::RootOwner>,
    complete: bool,
}
impl Drop for PhysicalWork {
    fn drop(&mut self) {
        if self.complete {
            self.gates.finish_work();
        } else {
            self.gates.retain_unconfirmed(self.root.clone());
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
    let root = log.owned_root()?;
    gates.start_work()?;
    let mut work = PhysicalWork {
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
                let objects = Objects::open(root)?;
                runtime.block_on(action(log, objects))
            })();
            work.complete = true;
            drop(work);
            let _ = send.send(result);
        })?;
    receive.await.map_err(|_| StoreError::OperationUnknown)?
}

#[cfg(not(test))]
fn boundary(_: &str) {}
#[cfg(test)]
fn boundary(phase: &str) {
    if std::env::var("MAKA_CHECKPOINT_TEST_PHASE").ok().as_deref() == Some(phase) {
        let path = std::env::var_os("MAKA_CHECKPOINT_TEST_READY").expect("test ready path");
        std::fs::write(path, phase).unwrap();
        loop {
            std::thread::park();
        }
    }
}

#[cfg(all(test, unix))]
mod tests;
