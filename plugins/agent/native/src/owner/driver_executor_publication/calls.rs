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

//! Live Root publication calls. Frozen descriptors select data, never authority.
use super::{ExecutorPublication, PreparedPublication};
use crate::owner::{Owner, RunAccess, access::reserved_sandbox_floor, now};
use futures_util::{FutureExt, future::BoxFuture};
use maka_agent_api::{contract::WorkspaceAccess, session::ResolvedConfiguration};
use maka_agent_authority::{
    permissions::Access,
    publication::{PublicationAccess, PublicationCallContext},
};
use maka_agent_engine::{
    PublicationWitness, RunError,
    ports::{ExternalPublicationPorts, OriginalLookup, PreparedExternalPublication},
};
use maka_agent_facts::{
    durable::*,
    external_publication::{ExternalPublicationKey, ExternalPublicationOutcome},
    tools::ToolError,
};
use maka_agent_state::{DriverClaim, Store, fold::RunView};
use maka_capabilities::call::{Attachments, Identity, ReadResource};
use maka_fs_tools::publication::{
    PublicationChange, PublicationEntry, PublicationResult, PublishChange, SourceIdentity,
};
use maka_host_runtime::application::{Binding, Context, NativeRequest, NativeServices};
use maka_plugin_core::operation::{
    OperationCleanup, OperationOutcome, OperationReply, OperationResult, Receipt, RecoveryRef,
};
use maka_process::isolated::{BaselineEntry, CandidateCapture};
use maka_sandbox::workspace::PermissionBasis;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    ops::Range,
    panic::AssertUnwindSafe,
    path::Path,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{OnceCell, oneshot, watch};
use tokio_util::task::TaskTracker;

const METHOD: &str = "publishChange";
type PreparedResult = Result<Arc<PreparedPublication>, String>;
type DispatchResult = Result<FactId, String>;

#[derive(Clone)]
pub(in crate::owner) struct LivePublication {
    live: Arc<Live>,
}
struct Live {
    owner: Weak<Owner>,
    access: Arc<RunAccess>,
    task: ExternalTaskId,
    preparer: Option<ExecutorPublication>,
    files: Result<SelectedFiles, String>,
    prepared: OnceCell<Arc<PreparedPublication>>,
    preparation: Mutex<Option<watch::Receiver<Option<PreparedResult>>>>,
    items: Mutex<BTreeMap<ExternalPublicationKey, Arc<OriginalIo>>>,
    workers: TaskTracker,
    active: TaskTracker,
}
struct SelectedFiles {
    services: NativeServices,
    import: String,
    member: usize,
    binding: Binding,
}
#[derive(Default)]
struct OriginalIo {
    requests: Mutex<Vec<RetainedRequest>>,
    dispatch: Mutex<Option<watch::Receiver<Option<DispatchResult>>>>,
    writer_failed: AtomicBool,
    recovery_only: AtomicBool,
}
#[derive(Clone)]
struct RetainedRequest {
    request: Arc<NativeRequest>,
    original: bool,
}
struct ItemRole {
    io: Weak<OriginalIo>,
    live: Weak<Live>,
    access: Arc<RunAccess>,
    prepared: Arc<PreparedPublication>,
    key: ExternalPublicationKey,
    witness: PublicationWitness,
    original: OnceCell<RecoveryRef>,
}

impl LivePublication {
    pub(in crate::owner) fn new(
        owner: Arc<Owner>,
        access: Arc<RunAccess>,
        claim: DriverClaim,
        state: Store,
        task: ExternalTaskId,
        capture: Option<CandidateCapture>,
        workers: TaskTracker,
    ) -> Result<Arc<Self>, RunError> {
        if claim.run() != access.execution().run_id || access.spec().owner != owner.run_owner() {
            return Err(invalid("publication belongs to another actual Root driver"));
        }
        let writer = access.data_writer().map_err(RunError::Internal)?;
        let state = state.with_data_writer(writer)?;
        let files = (|| {
            let expected = maka_workspace_api::files::contract();
            let mut selected = None;
            for (name, providers) in owner.services.imports() {
                for (member, binding) in providers.iter().enumerate() {
                    if binding.contract() != &expected {
                        continue;
                    }
                    if selected.is_some() {
                        return Err(
                            "publication requires one unambiguous captured Files provider".into(),
                        );
                    }
                    selected = Some((name.to_owned(), member, binding.clone()));
                }
            }
            let (import, member, binding) =
                selected.ok_or("captured Files publication capability is unavailable")?;
            let services = owner
                .services
                .select_import_method(&import, member, METHOD)?;
            Ok(SelectedFiles {
                services,
                import,
                member,
                binding,
            })
        })();
        let preparer = capture
            .map(|capture| ExecutorPublication::new(access.clone(), claim, state, task, capture))
            .transpose()?;
        Ok(Arc::new(Self {
            live: Arc::new(Live {
                owner: Arc::downgrade(&owner),
                access,
                task,
                preparer,
                files,
                prepared: OnceCell::new(),
                preparation: Mutex::new(None),
                items: Mutex::new(BTreeMap::new()),
                workers,
                active: TaskTracker::new(),
            }),
        }))
    }

    pub(in crate::owner) fn original_cleanup_confirmed(&self) -> bool {
        if !self.live.active.is_empty() {
            return false;
        }
        self.live
            .items
            .lock()
            .expect("publication originals")
            .values()
            .all(|io| {
                !io.writer_failed.load(Ordering::Acquire)
                    && io
                        .requests
                        .lock()
                        .expect("publication scopes")
                        .iter()
                        .all(|request| matches!(request.request.scope().resources.seal(), Ok(true)))
            })
    }

    /// Arm only after the driver fences publication producers. This closes the
    /// publication-local tracker, never the enclosing driver's shared tracker.
    pub(in crate::owner) fn original_cleanup_signals(&self) -> Vec<BoxFuture<'static, ()>> {
        self.live.active.close();
        let publication = self.clone();
        vec![Box::pin(async move {
            // Source tokens include scope settlement and the actual witness ACK.
            // Snapshot scopes afterwards: an accepted source may still add them.
            publication.live.active.wait().await;
            let resources: Vec<_> = publication
                .live
                .items
                .lock()
                .expect("publication originals")
                .values()
                .flat_map(|io| {
                    io.requests
                        .lock()
                        .expect("publication scopes")
                        .iter()
                        .map(|request| request.request.scope().resources.clone())
                        .collect::<Vec<_>>()
                })
                .collect();
            for resources in resources {
                if resources.settle().await.is_err() {
                    std::future::pending::<()>().await;
                }
            }
            if !publication.original_cleanup_confirmed() {
                std::future::pending::<()>().await;
            }
        })]
    }

    fn witness(&self, witness: PublicationWitness) -> Result<PublicationWitness, RunError> {
        Ok(
            witness
                .with_data_writer(self.live.access.data_writer().map_err(RunError::Internal)?)?,
        )
    }
    fn item_io(&self, key: ExternalPublicationKey) -> Arc<OriginalIo> {
        self.live
            .items
            .lock()
            .expect("publication originals")
            .entry(key)
            .or_default()
            .clone()
    }
    fn check_run(&self, run: RunId) -> Result<(), RunError> {
        if run != self.live.access.execution().run_id {
            return Err(invalid("foreign publication Run"));
        }
        Ok(())
    }
    fn cached(&self, id: ExternalPublicationId) -> Result<Arc<PreparedPublication>, RunError> {
        self.live
            .prepared
            .get()
            .filter(|prepared| prepared.plan.publication == id)
            .cloned()
            .ok_or_else(|| unavailable(id, "original frozen publication material is unavailable"))
    }
}

impl ExternalPublicationPorts for LivePublication {
    fn prepare_publication<'a>(
        &'a self,
        view: &'a RunView,
        id: ExternalPublicationId,
    ) -> BoxFuture<'a, Result<PreparedExternalPublication, RunError>> {
        Box::pin(async move {
            self.check_run(view.run)?;
            let pending = view
                .external
                .as_ref()
                .and_then(|task| task.publication.as_ref())
                .filter(|pending| pending.id == id && pending.task == self.live.task)
                .ok_or_else(|| unavailable(id, "original Pending publication is unavailable"))?;
            if self.live.preparer.is_none() {
                return Err(unavailable(
                    id,
                    "original candidate capture capability is unavailable",
                ));
            }
            let mut receiver = {
                let mut preparation = self
                    .live
                    .preparation
                    .lock()
                    .expect("publication preparation");
                preparation
                    .get_or_insert_with(|| {
                        let (sender, receiver) = watch::channel(None);
                        let live = self.live.clone();
                        let token = live.active.token();
                        self.live.workers.spawn(async move {
                            let _token = token;
                            let result = AssertUnwindSafe(
                                live.preparer
                                    .as_ref()
                                    .expect("actual candidate capture checked")
                                    .prepare(),
                            )
                            .catch_unwind()
                            .await;
                            let result = match result {
                                Ok(Ok(prepared)) => {
                                    let prepared = Arc::new(prepared);
                                    assert!(
                                        live.prepared.set(prepared.clone()).is_ok(),
                                        "one original freeze"
                                    );
                                    Ok(prepared)
                                }
                                Ok(Err(error)) => Err(error.to_string()),
                                Err(_) => Err("publication preparation worker panicked".into()),
                            };
                            sender.send_replace(Some(result));
                        });
                        receiver
                    })
                    .clone()
            };
            let prepared = loop {
                if let Some(result) = receiver.borrow().clone() {
                    break result.map_err(|message| unavailable(id, &message))?;
                }
                receiver
                    .changed()
                    .await
                    .map_err(|_| unavailable(id, "original preparation owner disappeared"))?;
            };
            if prepared.plan.publication != id
                || prepared.plan.source != pending.source
                || pending
                    .manifest
                    .as_ref()
                    .is_some_and(|manifest| manifest != prepared.descriptor.reference())
            {
                return Err(invalid(
                    "publication differs from its exact original frozen manifest",
                ));
            }
            Ok(PreparedExternalPublication {
                manifest: prepared.descriptor.clone(),
                item_count: prepared.plan.changes.len() as u64,
                contents: prepared.contents.clone(),
            })
        })
    }

    fn validate_publication_item<'a>(
        &'a self,
        view: &'a RunView,
        key: ExternalPublicationKey,
    ) -> BoxFuture<'a, Result<PermissionBasis, RunError>> {
        Box::pin(async move {
            self.check_run(view.run)?;
            let prepared = self.cached(key.publication)?;
            Ok(self
                .live
                .current(&prepared, key, false)
                .await?
                .permission_basis())
        })
    }

    fn dispatch_publication_item(
        &self,
        run: RunId,
        key: ExternalPublicationKey,
        witness: PublicationWitness,
    ) -> BoxFuture<'_, Result<FactId, RunError>> {
        Box::pin(async move {
            self.check_run(run)?;
            let prepared = self.cached(key.publication)?;
            let witness = self.witness(witness)?;
            let io = self.item_io(key);
            let mut receiver = {
                let mut dispatch = io.dispatch.lock().expect("publication dispatch");
                if dispatch.is_none() && io.recovery_only.load(Ordering::Acquire) {
                    return Err(unknown(key));
                }
                dispatch.get_or_insert_with(|| {
                    let (sender, receiver) = watch::channel(None);
                    let live = self.live.clone();
                    let io = io.clone();
                    let owner = live.owner.upgrade();
                    let token = live.active.token();
                    self.live.workers.spawn(async move {
                        let _token = token;
                        let _owner = owner;
                        let role = Arc::new(ItemRole { io: Arc::downgrade(&io), live: Arc::downgrade(&live), access: live.access.clone(), prepared, key, witness: witness.clone(), original: OnceCell::new() });
                        let result = AssertUnwindSafe(live.dispatch(&io, &role)).catch_unwind().await;
                        let result = match result { Ok(result) => result, Err(_) => { io.writer_failed.store(true, Ordering::Release); Err(invalid("original publication worker panicked")) } };
                        if let Err(error) = &result { tracing::warn!(%error, "publication original dispatch observation failed"); }
                        sender.send_replace(Some(result.map_err(|error| error.to_string())));
                        live.settle_original(&io, &witness).await;
                    });
                    receiver
                }).clone()
            };
            loop {
                if let Some(result) = receiver.borrow().clone() {
                    return result.map_err(|_| unknown(key));
                }
                receiver.changed().await.map_err(|_| unknown(key))?;
            }
        })
    }

    fn lookup_publication_item(
        &self,
        run: RunId,
        key: ExternalPublicationKey,
        witness: PublicationWitness,
    ) -> BoxFuture<'_, Result<OriginalLookup, RunError>> {
        Box::pin(async move {
            self.check_run(run)?;
            self.live.original_key(key).await?;
            let witness = self.witness(witness)?;
            let io = self.item_io(key);
            io.recovery_only.store(true, Ordering::Release);
            let live = self.live.clone();
            let token = live.active.token();
            let (sender, receiver) = oneshot::channel();
            self.live.workers.spawn(async move {
                let _token = token;
                let mut reader = None;
                let result = async {
                    let request = live.request(&io, key)?;
                    reader = Some(request.clone());
                    let original = live.lookup(&request, key).await?;
                    match original {
                        Some(reference) => {
                            ack(&io, witness.bound(reference.clone(), timestamp()).await)?;
                            Ok(OriginalLookup::Found(reference))
                        }
                        None => Ok(OriginalLookup::Absent),
                    }
                }
                .await;
                let _ = sender.send(result);
                if let Some(request) = reader {
                    live.settle_request(&io, &request, None).await;
                }
            });
            receiver.await.map_err(|_| unknown(key))?
        })
    }

    fn observe_publication_item(
        &self,
        run: RunId,
        key: ExternalPublicationKey,
        reference: RecoveryRef,
        witness: PublicationWitness,
    ) -> BoxFuture<'_, Result<FactId, RunError>> {
        Box::pin(async move {
            self.check_run(run)?;
            let bound = self.live.original_key(key).await?;
            if bound
                .as_ref()
                .is_some_and(|original| original != &reference)
            {
                return Err(invalid(
                    "publication observation differs from original canonical reference",
                ));
            }
            self.live.check_reference(key, &reference)?;
            let witness = self.witness(witness)?;
            let io = self.item_io(key);
            io.recovery_only.store(true, Ordering::Release);
            let live = self.live.clone();
            let token = live.active.token();
            let (sender, receiver) = oneshot::channel();
            self.live.workers.spawn(async move {
                let _token = token;
                let mut reader = None;
                let result = async {
                    let request = live.request(&io, key)?;
                    reader = Some(request.clone());
                    let original = live
                        .lookup(&request, key)
                        .await?
                        .ok_or_else(|| unknown(key))?;
                    if original != reference {
                        return Err(invalid(
                            "publication observation differs from original CallerIntent",
                        ));
                    }
                    ack(&io, witness.bound(reference.clone(), timestamp()).await)?;
                    let reply = live.recover(&request, reference).await;
                    let outcome = outcome(&reply)?;
                    ack(&io, witness.observed(reply, outcome, timestamp()).await)
                }
                .await;
                let _ = sender.send(result);
                if let Some(request) = reader {
                    live.settle_request(&io, &request, None).await;
                }
            });
            receiver.await.map_err(|_| unknown(key))?
        })
    }
}

impl Live {
    async fn current(
        &self,
        prepared: &PreparedPublication,
        key: ExternalPublicationKey,
        admitted: bool,
    ) -> Result<ResolvedConfiguration, RunError> {
        self.selected_files(key.publication)?;
        let view = self.access.fresh().await.map_err(RunError::Internal)?;
        let task = view
            .external
            .as_ref()
            .filter(|task| task.task == self.task && task.admitted && task.closed.is_some())
            .ok_or_else(|| invalid("publication requires original known task closure"))?;
        let publication = task
            .publication
            .as_ref()
            .filter(|publication| publication.id == key.publication)
            .ok_or_else(|| invalid("publication has no canonical Pending source"))?;
        if view.stopped
            || view.terminal.is_some()
            || view.cancelled_by_risk
            || view
                .blockers
                .values()
                .any(|blocker| blocker.decision.is_none() && blocker.resolved_by.is_none())
        {
            return Err(RunError::Cancelled);
        }
        if prepared.plan.publication != key.publication
            || prepared.plan.task != task.task
            || prepared.plan.source != publication.source
            || publication.abandoned
            || publication.manifest.as_ref() != Some(prepared.descriptor.reference())
            || publication.item_count != Some(prepared.plan.changes.len() as u64)
            || key.index >= prepared.plan.changes.len() as u64
            || key.index != publication.settled
            || (if admitted {
                publication.admitted != key.index + 1
                    || publication
                        .items
                        .get(&key.index)
                        .is_none_or(|item| item.key != key || item.basis != prepared.plan.basis)
            } else {
                publication.admitted != key.index || publication.items.contains_key(&key.index)
            })
        {
            return Err(invalid(
                "publication item differs from its original canonical frontier",
            ));
        }
        let configuration = self.access.live_configuration().await?;
        if configuration.permission_basis() != prepared.plan.basis
            || self.access.spec().permission_basis != prepared.plan.basis
            || Path::new(&configuration.workspace.path) != prepared.candidate().snapshot().source()
            || configuration.permissions.access == WorkspaceAccess::ReadOnly
        {
            return Err(invalid(
                "publication source workspace or current permission epoch changed",
            ));
        }
        Ok(configuration)
    }

    fn request(
        &self,
        io: &OriginalIo,
        key: ExternalPublicationKey,
    ) -> Result<Arc<NativeRequest>, RunError> {
        let owner = self
            .owner
            .upgrade()
            .ok_or_else(|| invalid("actual publication owner closed"))?;
        let request = self
            .selected_files(key.publication)?
            .services
            .request_with_work(
                Identity::Agent {
                    execution: self.access.execution().clone(),
                    operation_id: Some(operation_id(key)),
                },
                owner.stop.child_token(),
                self.access.custody().clone(),
            )
            .map_err(RunError::Internal)?;
        let request = Arc::new(request);
        io.requests
            .lock()
            .expect("publication scopes")
            .push(RetainedRequest {
                request: request.clone(),
                original: false,
            });
        Ok(request)
    }
    async fn floor(
        &self,
        configuration: &ResolvedConfiguration,
    ) -> Result<maka_sandbox::Sandbox, RunError> {
        let owner = self
            .owner
            .upgrade()
            .ok_or_else(|| invalid("actual publication owner closed"))?;
        let workspace = configuration.workspace.clone();
        let mode = configuration.permissions.access;
        let state_root = self.access.state_root()?;
        let ceiling = self.access.spec().permission_ceiling.sandbox.clone();
        let reserved = reserved_sandbox_floor(&owner.store, &workspace)
            .await
            .map_err(RunError::Internal)?;
        tokio::task::spawn_blocking(move || {
            let (current, _) = maka_workspace_support::sandbox(&workspace, mode, &state_root)
                .map_err(RunError::Internal)?;
            current
                .intersect(&ceiling)
                .and_then(|floor| floor.intersect(&reserved))
                .map_err(|error| RunError::Internal(error.to_string()))
        })
        .await
        .map_err(|error| RunError::Internal(error.to_string()))?
    }
    async fn dispatch(
        self: &Arc<Self>,
        io: &OriginalIo,
        role: &Arc<ItemRole>,
    ) -> Result<FactId, RunError> {
        // Every failure in this setup precedes the sole SDK enqueue.
        let setup = async {
            let configuration = self.current(&role.prepared, role.key, true).await?;
            let floor = self.floor(&configuration).await?;
            let attachments = content_resource(role.prepared.clone(), role.key.index).await?;
            let owner = self
                .owner
                .upgrade()
                .ok_or_else(|| invalid("actual publication owner closed"))?;
            let files = self.selected_files(role.key.publication)?;
            let request = files
                .services
                .request_with_work_and_context(
                    Identity::Agent {
                        execution: self.access.execution().clone(),
                        operation_id: Some(operation_id(role.key)),
                    },
                    owner.stop.child_token(),
                    self.access.custody().clone(),
                    Arc::new(PublicationCallContext(role.clone())),
                )
                .map_err(RunError::Internal)?
                .with_sandbox_floor(&floor)
                .map_err(RunError::Internal)?;
            let request = Arc::new(request);
            io.requests
                .lock()
                .expect("publication scopes")
                .push(RetainedRequest {
                    request: request.clone(),
                    original: true,
                });
            // Recheck Stop and current epoch after potentially slow immutable content capture.
            self.current(&role.prepared, role.key, true).await?;
            let input = serde_json::to_value(PublishChange {
                publication: role.key.publication,
                index: role.key.index,
            })
            .map_err(|error| invalid(&error.to_string()))?;
            let operation =
                crate::tools::operation_uuid(self.access.execution(), &operation_id(role.key));
            let future = request
                .begin_mutation(
                    &files.import,
                    files.member,
                    METHOD.into(),
                    input,
                    operation,
                    recovery(role.key),
                    attachments,
                )
                .map_err(RunError::Internal)?;
            Ok::<_, RunError>((request, future))
        }
        .await;
        let (request, pending) = match setup {
            Ok(original) => original,
            Err(error) => {
                return ack(
                    io,
                    role.witness
                        .prevented_before_host_admission(error.to_string(), timestamp())
                        .await,
                );
            }
        };
        let reply = match pending.await {
            Ok(mutation) => {
                self.check_fresh_reference(role.key, &mutation.reference)?;
                role.bind(mutation.reference.clone()).await?;
                mutation.result().await
            }
            Err(error) => {
                tracing::warn!(%error, "original publication enqueue response unknown; looking up original intent");
                let reference = self
                    .lookup(&request, role.key)
                    .await?
                    .ok_or_else(|| unknown(role.key))?;
                role.bind(reference.clone()).await?;
                self.recover(&request, reference).await
            }
        };
        let outcome = outcome(&reply)?;
        let result = role.witness.observed(reply, outcome, timestamp()).await;
        if result.is_err() {
            io.writer_failed.store(true, Ordering::Release);
        }
        result
    }
    async fn lookup(
        &self,
        request: &NativeRequest,
        key: ExternalPublicationKey,
    ) -> Result<Option<RecoveryRef>, RunError> {
        let bound = self.original_key(key).await?;
        let files = self.selected_files(key.publication)?;
        let operation = crate::tools::operation_uuid(self.access.execution(), &operation_id(key));
        let unavailable = |diagnostic| {
            RunError::from(BlockerKind::CurrentAuthorityUnavailable {
                stage: AuthorityStage::BackendScope,
                diagnostic,
            })
        };
        let intent = request
            .lookup_intent(operation)
            .map_err(unavailable)?
            .await
            .map_err(unavailable)?;
        let Some(intent) = intent else {
            if bound.is_some() {
                return Err(unknown(key));
            }
            return Ok(None);
        };
        if intent.recovery != recovery(key)
            || intent.consumer != *request.requester().instance()
            || intent.consumer != *files.binding.consumer().instance()
        {
            return Err(invalid(
                "original publication CallerIntent differs from fixed item",
            ));
        }
        self.check_fresh_reference(key, &intent.reference)?;
        if bound
            .as_ref()
            .is_some_and(|original| original != &intent.reference)
        {
            return Err(invalid(
                "original CallerIntent differs from canonical publication binding",
            ));
        }
        Ok(Some(intent.reference))
    }
    fn selected_files(
        &self,
        publication: ExternalPublicationId,
    ) -> Result<&SelectedFiles, RunError> {
        let files = self
            .files
            .as_ref()
            .map_err(|diagnostic| unavailable(publication, diagnostic))?;
        let owner = self
            .owner
            .upgrade()
            .ok_or_else(|| unavailable(publication, "actual Files owner is unavailable"))?;
        let actual = owner
            .services
            .imports()
            .find(|(name, _)| *name == files.import.as_str())
            .and_then(|(_, bindings)| bindings.get(files.member))
            .ok_or_else(|| unavailable(publication, "captured Files binding is unavailable"))?;
        if actual.execution_basis() != files.binding.execution_basis() {
            return Err(unavailable(publication, "captured Files binding changed"));
        }
        Ok(files)
    }
    async fn original_key(
        &self,
        key: ExternalPublicationKey,
    ) -> Result<Option<RecoveryRef>, RunError> {
        let view = self.access.fresh().await.map_err(RunError::Internal)?;
        let task = view
            .external
            .as_ref()
            .filter(|task| task.task == self.task && task.admitted && task.closed.is_some())
            .ok_or_else(|| {
                unavailable(
                    key.publication,
                    "original known task closure is unavailable",
                )
            })?;
        task.publication
            .as_ref()
            .filter(|publication| {
                publication.id == key.publication
                    && publication.task == task.task
                    && publication.manifest.is_some()
                    && publication
                        .item_count
                        .is_some_and(|count| key.index < count)
                    && key.index < publication.admitted
            })
            .ok_or_else(|| {
                unavailable(
                    key.publication,
                    "original canonical prepared publication is unavailable",
                )
            })?;
        let owner = self
            .owner
            .upgrade()
            .ok_or_else(|| invalid("actual publication owner closed"))?;
        // The frontier omits settled Applied items; their indexed originals remain canonical.
        let item = owner
            .durable
            .publication_item(view.run, key)
            .await?
            .filter(|item| item.key == key)
            .ok_or_else(|| {
                unavailable(
                    key.publication,
                    "publication item has no original canonical admission",
                )
            })?;
        Ok(item.original)
    }
    fn check_reference(
        &self,
        key: ExternalPublicationKey,
        reference: &RecoveryRef,
    ) -> Result<(), RunError> {
        let operation = crate::tools::operation_uuid(self.access.execution(), &operation_id(key));
        if reference.operation != operation || reference.method != METHOD {
            return Err(invalid("original publication operation selector differs"));
        }
        if !reference
            .contract
            .matches(&maka_workspace_api::files::contract(), METHOD)
            .map_err(|error| unavailable(key.publication, &error.to_string()))?
        {
            return Err(unavailable(
                key.publication,
                "original Files publication result codec is incompatible",
            ));
        }
        Ok(())
    }
    fn check_fresh_reference(
        &self,
        key: ExternalPublicationKey,
        reference: &RecoveryRef,
    ) -> Result<(), RunError> {
        self.check_reference(key, reference)?;
        let files = self.selected_files(key.publication)?;
        if reference.namespace != *files.binding.provider().instance()
            || reference.export != files.binding.export()
        {
            return Err(invalid(
                "fresh publication reference differs from captured Host capability",
            ));
        }
        Ok(())
    }
    async fn recover(&self, request: &NativeRequest, reference: RecoveryRef) -> OperationReply {
        let result = match request.recover(reference.clone()) {
            Ok(result) => result.await,
            Err(error) => Err(error),
        };
        let receipt = match result {
            Ok(Some(observation)) => Receipt::Recorded {
                outcome: observation.outcome,
                cleanup: observation.cleanup,
            },
            Ok(None) => Receipt::NotRecorded,
            Err(diagnostic) => Receipt::Unavailable { diagnostic },
        };
        OperationReply { reference, receipt }
    }
    async fn settle_original(&self, io: &OriginalIo, witness: &PublicationWitness) {
        let originals: Vec<_> = io
            .requests
            .lock()
            .expect("publication scopes")
            .iter()
            .filter(|request| request.original)
            .map(|request| request.request.clone())
            .collect();
        if originals.is_empty() {
            // Setup proved no SDK handoff and created no scope at all.
            let _ = ack(
                io,
                witness
                    .cleanup(OperationCleanup::Confirmed, timestamp())
                    .await,
            );
        } else {
            for request in originals {
                self.settle_request(io, &request, Some(witness)).await;
            }
        }
    }
    async fn settle_request(
        &self,
        io: &OriginalIo,
        request: &Arc<NativeRequest>,
        original: Option<&PublicationWitness>,
    ) {
        if let Err(error) = request.scope().resources.settle().await {
            tracing::warn!(%error, "publication original scope cleanup unconfirmed");
            io.writer_failed.store(true, Ordering::Release);
            return;
        }
        if let Some(witness) = original
            && ack(
                io,
                witness
                    .cleanup(OperationCleanup::Confirmed, timestamp())
                    .await,
            )
            .is_err()
        {
            return;
        }
        io.requests
            .lock()
            .expect("publication scopes")
            .retain(|retained| !Arc::ptr_eq(&retained.request, request));
    }
}

impl ItemRole {
    async fn bind(&self, reference: RecoveryRef) -> Result<RecoveryRef, RunError> {
        let original = self
            .original
            .get_or_try_init(|| async {
                let result = self.witness.bound(reference.clone(), timestamp()).await;
                if let Some(io) = self.io.upgrade() {
                    ack(&io, result)?;
                } else {
                    result?;
                }
                Ok::<_, RunError>(reference.clone())
            })
            .await?;
        if original != &reference {
            return Err(invalid("publication original reference changed"));
        }
        Ok(original.clone())
    }
}
impl PublicationAccess for ItemRole {
    fn execution(&self) -> &ExecutionIdentity {
        self.access.execution()
    }
    fn task(&self) -> ExternalTaskId {
        self.prepared.plan.task
    }
    fn publication(&self) -> ExternalPublicationId {
        self.key.publication
    }
    fn index(&self) -> u64 {
        self.key.index
    }
    fn permission_basis(&self) -> &PermissionBasis {
        &self.prepared.plan.basis
    }
    fn change(&self) -> &PublicationChange {
        &self.prepared.plan.changes[self.key.index as usize]
    }
    fn source(&self) -> &SourceIdentity {
        &self.prepared.plan.root
    }
    fn validate<'a>(
        &'a self,
        context: &'a Context,
    ) -> BoxFuture<'a, Result<ResolvedConfiguration, ToolError>> {
        Box::pin(async move {
            let native = context
                .native_context::<PublicationCallContext>()
                .ok_or_else(|| failed("publication actual native role missing"))?;
            if !std::ptr::addr_eq(native.0.as_ref(), self as &dyn PublicationAccess)
                || context.scope().identity.agent() != Some(self.access.execution())
                || context.scope().identity.operation_id() != Some(operation_id(self.key).as_str())
                || context
                    .work_custody()
                    .is_none_or(|custody| !Arc::ptr_eq(custody, self.access.custody()))
            {
                return Err(failed(
                    "publication role lacks its original actual identity or custody",
                ));
            }
            let live = self
                .live
                .upgrade()
                .ok_or_else(|| failed("publication original live owner gone"))?;
            let files = live
                .selected_files(self.key.publication)
                .map_err(|error| failed(&error.to_string()))?;
            if context.requester() != files.binding.consumer() {
                return Err(failed("publication captured native activation changed"));
            }
            let reference = context
                .operation()
                .ok_or_else(|| failed("publication original Host operation missing"))?;
            live.check_fresh_reference(self.key, reference)
                .map_err(|error| failed(&error.to_string()))?;
            match (
                &self.change().candidate,
                context.attachments().get("content"),
            ) {
                (PublicationEntry::File { content, .. }, Some(resource))
                    if resource.resource_type()
                        == maka_plugin_core::contract::binary_resource_type()
                        && resource.encoding()
                            == maka_capabilities::call::ResourceEncoding::Bytes
                        && resource.bytes() as u64 == content.bytes => {}
                (PublicationEntry::File { .. }, _) | (_, Some(_)) => {
                    return Err(failed("publication fixed content resource differs"));
                }
                (_, None) => {}
            }
            live.current(&self.prepared, self.key, true)
                .await
                .map_err(|error| failed(&error.to_string()))
        })
    }
    fn bind_original<'a>(
        &'a self,
        context: &'a Context,
    ) -> BoxFuture<'a, Result<RecoveryRef, ToolError>> {
        Box::pin(async move {
            self.validate(context).await?;
            let reference = context
                .operation()
                .expect("validated actual original operation")
                .clone();
            let live = self
                .live
                .upgrade()
                .ok_or_else(|| failed("publication original live owner gone"))?;
            // The handler's actual operation is checked against the authorized caller journal,
            // including its frozen selector correlation, before any filesystem write.
            let io = live
                .items
                .lock()
                .expect("publication originals")
                .get(&self.key)
                .cloned()
                .ok_or_else(|| failed("publication original IO owner missing"))?;
            let request = live
                .request(&io, self.key)
                .map_err(|error| failed(&error.to_string()))?;
            let original = live.lookup(&request, self.key).await;
            live.settle_request(&io, &request, None).await;
            let original = original
                .map_err(|error| ToolError::OutcomeUnknown(error.to_string()))?
                .ok_or_else(|| {
                    ToolError::OutcomeUnknown(
                        "publication original CallerIntent is unavailable".into(),
                    )
                })?;
            if original != reference {
                return Err(failed("publication Host CallerIntent reference changed"));
            }
            self.bind(reference)
                .await
                .map_err(|error| ToolError::Persistence(error.to_string()))
        })
    }
}

/// This owns an already-open immutable candidate FD, never a path-based reopen.
struct CandidateResource {
    file: Mutex<File>,
    _owner: Arc<PreparedPublication>,
    content: ContentRef,
    bytes: usize,
}
impl ReadResource for CandidateResource {
    fn resource_type(&self) -> maka_plugin_core::contract::ResourceType {
        maka_plugin_core::contract::binary_resource_type()
    }
    fn bytes(&self) -> usize {
        self.bytes
    }
    fn metadata(&self) -> Value {
        json!({"digest":self.content.digest,"bytes":self.content.bytes})
    }
    fn read(&self, range: Range<usize>) -> Result<Vec<u8>, String> {
        if range.end > self.bytes
            || range
                .end
                .checked_sub(range.start)
                .is_none_or(|length| length > maka_host_runtime::application::RESOURCE_CHUNK_LIMIT)
        {
            return Err("invalid publication content range".into());
        }
        let mut file = self.file.lock().map_err(|error| error.to_string())?;
        file.seek(SeekFrom::Start(range.start as u64))
            .map_err(|error| error.to_string())?;
        let mut bytes = vec![0; range.end - range.start];
        file.read_exact(&mut bytes)
            .map_err(|error| error.to_string())?;
        Ok(bytes)
    }
}
async fn content_resource(
    prepared: Arc<PreparedPublication>,
    index: u64,
) -> Result<Attachments, RunError> {
    tokio::task::spawn_blocking(move || {
        let change = prepared
            .plan
            .changes
            .get(index as usize)
            .ok_or_else(|| invalid("publication index outside original manifest"))?;
        let PublicationEntry::File { content, .. } = &change.candidate else {
            return Ok(Attachments::new());
        };
        let content = content.clone();
        let BaselineEntry::File { file, .. } = prepared.candidate().open_entry(&change.path)?
        else {
            return Err(invalid("original candidate file changed type"));
        };
        let bytes = usize::try_from(content.bytes)
            .map_err(|_| invalid("publication content exceeds platform address range"))?;
        let resource: Arc<dyn ReadResource> = Arc::new(CandidateResource {
            file: Mutex::new(file),
            _owner: prepared,
            content,
            bytes,
        });
        Ok(Attachments::from([("content".into(), resource)]))
    })
    .await
    .map_err(|error| RunError::Internal(error.to_string()))?
}
fn outcome(reply: &OperationReply) -> Result<ExternalPublicationOutcome, RunError> {
    use ExternalPublicationOutcome as O;
    Ok(match &reply.receipt {
        Receipt::Recorded { outcome, .. } => match outcome {
            OperationOutcome::Returned {
                result: OperationResult::Success { value },
            } => match serde_json::from_value::<PublicationResult>(value.clone()).map_err(
                |error| {
                    invalid(&format!(
                        "original FS publication result is invalid: {error}"
                    ))
                },
            )? {
                PublicationResult::Applied => O::Applied,
                PublicationResult::Conflict { .. } => O::Conflict,
                PublicationResult::Unsupported { .. } => O::Unsupported,
                PublicationResult::NotAttempted { .. } => O::NotAttempted,
            },
            OperationOutcome::Returned {
                result: OperationResult::Failure { .. },
            } => O::Failed,
            OperationOutcome::NotExecuted { .. } => O::NotExecuted,
            OperationOutcome::Unresolved | OperationOutcome::Unknown { .. } => O::Unknown,
        },
        Receipt::NotRecorded | Receipt::Unavailable { .. } => O::Unknown,
    })
}
fn ack<T>(io: &OriginalIo, result: Result<T, RunError>) -> Result<T, RunError> {
    if result.is_err() {
        io.writer_failed.store(true, Ordering::Release);
    }
    result
}
fn operation_id(key: ExternalPublicationKey) -> String {
    format!("publication:{}:{}", key.publication, key.index)
}
fn recovery(key: ExternalPublicationKey) -> Value {
    json!({"publication":key.publication,"index":key.index})
}
fn timestamp() -> UnixMillis {
    UnixMillis(now().try_into().expect("Unix milliseconds"))
}
fn invalid(message: &str) -> RunError {
    RunError::InvalidInput(message.into())
}
fn failed(message: &str) -> ToolError {
    ToolError::Failed(message.into())
}
fn unavailable(publication: ExternalPublicationId, diagnostic: &str) -> RunError {
    RunError::from(BlockerKind::ExternalPublicationUnavailable {
        publication,
        diagnostic: diagnostic.into(),
    })
}
fn unknown(key: ExternalPublicationKey) -> RunError {
    RunError::from(BlockerKind::ExternalPublicationItem {
        key,
        reason: maka_agent_facts::external_publication::ExternalPublicationBlocker::Unknown,
    })
}
