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

//! Host service execution over the shared plugin lifecycle kernel.
pub mod abi;
pub mod backend;
mod caller;
mod context;
pub mod host;
pub mod logs;
pub mod management;
mod native_context;
pub mod operations;
mod owner;
mod resource_ingress;
pub mod transport;
pub use caller::Caller;
pub use context::Context;
pub use native_context::{NativeContext, NativePersistence, NativeRequest, NativeServices};
pub use resource_ingress::{
    CallResources, RESOURCE_CHUNK_LIMIT, ResourceCapture, ResourceCapturer, ResourceDescriptor,
};
mod requests;
mod subscriptions;
pub use subscriptions::Subscription;

use futures_util::future::BoxFuture;
use maka_capabilities::call::Attachments;
use maka_capabilities::call::Issuer;
use maka_capabilities::call::Scope;
use maka_capabilities::call::Ticket;
use maka_event_log::applications::intents::{CallerConfirmation, RecordedIntent};
use maka_packages::Package;
use maka_plugin_core::{
    composition::{Input, InstanceId},
    contract::{Contract, Interface, MethodMode},
    deployment::DeploymentRef,
    operation::{
        OperationCleanup, OperationObservation, OperationOutcome, OperationReply, Receipt,
        RecoveryRef,
    },
    package::{Implementation, PackageRef, Packages},
    plan::{Plan, RemoteExports},
    runtime::{Activation, Capability, Phase, Published, Status},
};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Write,
    sync::{
        Arc, Weak,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, String>;

/// Runs only after final lifetime and Host policy admission. A handler error does
/// not prove failed cleanup; the owner separately settles Scope resources.
pub trait Handler: Send + Sync + 'static {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, Result<Value>>;
}

/// Trusted Host policy, checked in the same owner turn as core admission.
/// Scope observation, package identity and a binding are not authorization.
pub trait Policy: Send + Sync + 'static {
    fn admit(&self, invocation: Invocation<'_>) -> Result<()>;
    /// Correlate resources across requests from one authenticated original
    /// caller. Called inside final admission, after `admit`, using private Scope
    /// evidence. This observation grants no method or resource access.
    fn caller(&self, _scope: &Scope) -> Option<Caller> {
        None
    }
    /// Authenticate a peer's caller-commit attestation against the original
    /// Scope's private evidence. This is additional to ordinary admission, not
    /// a Host grant or proof of another process's SQLite commit. Default deny.
    /// Checked in the final owner turn before execution, without an await.
    fn confirm_peer_mutation(
        &self,
        _invocation: Invocation<'_>,
        _intent: &CallerConfirmation,
    ) -> Result<()> {
        Err("peer caller confirmation is not authorized".into())
    }
    /// Mutation admission never grants access to historical operation records.
    fn recover(&self, _invocation: RecoveryInvocation<'_>) -> Result<()> {
        Err("operation recovery is not authorized".into())
    }
}

/// Borrowed facts at final admission. Exact execution identities and actual
/// payloads stay distinct from the Scope's private authorization evidence.
#[derive(Clone, Copy)]
pub struct Invocation<'a> {
    pub scope: &'a Scope,
    /// Host-verified original native activation, if this call belongs to native
    /// domain work. This observation does not grant any imported method.
    pub native_origin: Option<&'a Activation>,
    pub consumer: &'a Activation,
    pub provider: &'a Activation,
    pub export: &'a str,
    pub contract: &'a Contract,
    pub method: &'a str,
    pub input: &'a Value,
    pub attachments: &'a Attachments,
}

pub struct RecoveryInvocation<'a> {
    pub scope: &'a Scope,
    pub native_origin: Option<&'a Activation>,
    pub consumer: &'a Activation,
    pub reference: &'a RecoveryRef,
}

/// The actual native owner survives rejected exports and failed close futures.
/// Successful close confirms its resources have settled; dropping a close
/// observer or future is not that confirmation.
pub trait NativeOwner: Send + Sync + 'static {
    /// Start activation-owned background work after exports are published.
    /// Must return promptly; close must settle any work started here, even if
    /// this hook panics. Rejected or already retiring activations never start.
    fn activated(&self) {}
    /// Signal retirement before accepted calls drain. This nonblocking hook may
    /// cancel owned pre-admission work that would otherwise delay those calls.
    /// It does not release resources or acknowledge cleanup; close still owns it.
    fn retiring(&self) {}
    /// Immutable execution facts not represented by the package, configuration
    /// or captured imports, including targets captured by the native factory.
    /// Returning Some attests that these facts fully identify this native
    /// implementation's execution semantics across equivalent activations.
    /// None keeps its bindings specific to the current activation.
    fn execution_basis(&self) -> Option<Value> {
        None
    }
    /// Fence independent producers only when all accepted background work has
    /// settled. Must not block. The returned guard prevents new background
    /// admissions until commit; dropping it resumes ordinary admission.
    /// None conservatively reports busy, including unsupported native owners.
    fn prepare_retirement(&self) -> Option<Box<dyn NativeRetirement>> {
        None
    }
    fn close(&self) -> BoxFuture<'static, Result<()>>;
}
/// An actual native admission fence. Commit permanently stops its producers;
/// physical cleanup still belongs to NativeOwner::close.
pub trait NativeRetirement: Send {
    fn commit(self: Box<Self>);
}
/// For native owners whose work is entirely owned by Application invocations.
impl NativeRetirement for () {
    fn commit(self: Box<Self>) {}
}
impl NativeOwner for () {
    fn prepare_retirement(&self) -> Option<Box<dyn NativeRetirement>> {
        Some(Box::new(()))
    }
    fn close(&self) -> BoxFuture<'static, Result<()>> {
        Box::pin(async { Ok(()) })
    }
}
pub struct NativeActivation {
    pub exports: Result<BTreeMap<String, Published<Arc<dyn Handler>>>>,
    pub owner: Arc<dyn NativeOwner>,
}
type Factory =
    Arc<dyn Fn(NativeContext, Value) -> BoxFuture<'static, NativeActivation> + Send + Sync>;
#[derive(Clone, Default)]
pub struct NativeRegistry(BTreeMap<String, Factory>);
impl NativeRegistry {
    pub fn insert(&mut self, name: String, factory: Factory) -> Result<()> {
        if self.0.contains_key(&name) {
            return Err("duplicate native implementation".into());
        }
        self.0.insert(name, factory);
        Ok(())
    }
}

pub(super) struct Method {
    operation: Option<maka_event_log::applications::operations::OperationTemplate>,
    input: Arc<jsonschema::Validator>,
    output: Arc<jsonschema::Validator>,
    progress: Option<Arc<jsonschema::Validator>>,
}
pub(super) struct Service {
    contract: Arc<Contract>,
    methods: BTreeMap<String, Method>,
    implementation: Arc<dyn Handler>,
}
impl Service {
    fn new(contract: Contract, implementation: Arc<dyn Handler>) -> Result<Self> {
        let Interface::Service { methods } = &contract.interface else {
            return Err("Host export must declare a service".into());
        };
        let mut operations =
            maka_event_log::applications::operations::OperationTemplate::for_contract(&contract)
                .map_err(|e| e.to_string())?;
        let compiled = methods
            .iter()
            .map(|(name, method)| {
                Ok((
                    name.clone(),
                    Method {
                        operation: operations.remove(name),
                        progress: method
                            .progress
                            .as_ref()
                            .map(|schema| {
                                maka_plugin_core::validator(schema).map_err(|e| e.to_string())
                            })
                            .transpose()?,
                        input: maka_plugin_core::validator(&method.input)
                            .map_err(|e| e.to_string())?,
                        output: maka_plugin_core::validator(&method.output)
                            .map_err(|e| e.to_string())?,
                    },
                ))
            })
            .collect::<Result<_>>()?;
        Ok(Self {
            contract: Arc::new(contract),
            methods: compiled,
            implementation,
        })
    }
}

/// An exact consumer/provider registration, never a JSON or name-based grant.
pub struct Binding(
    Capability<Service>,
    Arc<Contract>,
    Arc<str>,
    Arc<maka_plugin_core::package::PackageRef>,
    Arc<AtomicBool>,
);
impl Clone for Binding {
    fn clone(&self) -> Self {
        Self(
            self.0.clone(),
            self.1.clone(),
            self.2.clone(),
            self.3.clone(),
            self.4.clone(),
        )
    }
}
impl Binding {
    /// Read-only facts from the exact captured registration, never a grant.
    pub fn consumer(&self) -> &Activation {
        self.0.consumer()
    }
    pub fn export(&self) -> &str {
        self.0.export()
    }
    pub fn contract(&self) -> &Contract {
        &self.1
    }
    pub fn provider(&self) -> &Activation {
        self.0.provider()
    }
    /// Immutable package of the captured registration, not the desired provider.
    pub fn package(&self) -> &maka_plugin_core::package::PackageRef {
        &self.3
    }
    /// Comparable execution facts of this exact provider and captured imports.
    /// Opaque native providers make this digest activation-specific. Equality
    /// is not authorization or a handle for restoring a registration.
    pub fn execution_basis(&self) -> &str {
        &self.2
    }
    pub fn registration_epoch(&self) -> Uuid {
        self.0.registration_epoch()
    }
    // One-way evidence from actual admission; false never proves liveness.
    fn retired(&self) -> bool {
        self.4.load(Ordering::Relaxed)
    }
    fn mark_retired(&self) {
        self.4.store(true, Ordering::Relaxed);
    }
    fn observe_lifetime(&self, error: &maka_plugin_core::Error) {
        if matches!(error, maka_plugin_core::Error::Retired) {
            self.mark_retired();
        }
    }
}

pub struct Accepted {
    pub id: Uuid,
    result: oneshot::Receiver<QueryCompletion>,
}

/// One current declared import. Missing registrations carry no call authority.
pub enum CapturedImport {
    Ready(Binding),
    Unavailable {
        provider: InstanceId,
        export: String,
        contract: Contract,
    },
}
/// Independent business and executor-cleanup observations from the original Host owner.
pub struct QueryCompletion {
    pub result: Result<Value>,
    pub cleanup: Result<()>,
}
impl Accepted {
    /// Observe business only. This does not acknowledge executor cleanup.
    pub async fn result(self) -> Result<Value> {
        self.completion().await.result
    }
    /// Dropping this observer never cancels execution or acknowledges cleanup.
    pub async fn completion(self) -> QueryCompletion {
        self.result.await.unwrap_or_else(|_| QueryCompletion {
            result: Err("Host executor owner disappeared".into()),
            cleanup: Err("Host executor cleanup unconfirmed: owner disappeared".into()),
        })
    }
}

/// Checked original invocation data, not accepted work or effect authority.
/// Holds original input/resource capacity and a Scope ticket until dispatch/drop;
/// the binding does not own its service value.
pub struct PreparedMutation {
    reference: RecoveryRef,
    invocation: Option<PreparedInvocation>,
}
struct PreparedInvocation {
    binding: Binding,
    method: String,
    input: Value,
    scope: Scope,
    attachments: Attachments,
    capture: Option<Uuid>,
    admitted: resource_ingress::AttachmentSize,
    bytes: OwnedSemaphorePermit,
    resources: OwnedSemaphorePermit,
    // Last: inert drop releases physical custody before acknowledging its Scope.
    parent: Option<Ticket>,
}
impl PreparedMutation {
    pub fn reference(&self) -> &RecoveryRef {
        &self.reference
    }
    pub fn consumer(&self) -> &Activation {
        self.invocation
            .as_ref()
            .expect("original invocation")
            .binding
            .consumer()
    }
}
impl Drop for PreparedMutation {
    fn drop(&mut self) {
        if let Some(mut invocation) = self.invocation.take() {
            let parent = invocation.parent.take();
            drop(invocation);
            if let Some(ticket) = parent {
                ticket.complete(Ok(()));
            }
        }
    }
}

/// An accepted mutation always retains its original reference, even when its
/// result observer loses the owner. Only a recorded receipt confirms journal facts.
pub struct Mutation {
    pub id: Uuid,
    pub reference: RecoveryRef,
    result: oneshot::Receiver<MutationCompletion>,
    progress: Option<subscriptions::Items>,
}
/// Receipt knowledge and this request's actual executor cleanup are independent.
/// A historical receipt describes the original operation, not a new lookup's cleanup.
pub struct MutationCompletion {
    pub reply: OperationReply,
    pub cleanup: Result<()>,
}
impl Mutation {
    /// Ordered transient progress, never an operation receipt or cleanup proof.
    /// Historical replay produces no new items. Dropping this reader closes
    /// demand without cancelling the original mutation Scope.
    pub async fn recv(&mut self) -> Option<Value> {
        match &mut self.progress {
            Some(progress) => progress.recv().await,
            None => None,
        }
    }
    /// Observe original receipt knowledge only; this does not acknowledge cleanup.
    pub async fn result(self) -> OperationReply {
        self.completion().await.reply
    }
    /// Original owner reports actual cleanup independently of receipt persistence.
    /// Losing this observer neither cancels execution nor acknowledges cleanup.
    pub async fn completion(mut self) -> MutationCompletion {
        // Receipt-only callers still consume progress, avoiding backpressure
        // deadlock without pretending that these items were durably recorded.
        while self.recv().await.is_some() {}
        drop(self.progress.take());
        self.result.await.unwrap_or_else(|_| MutationCompletion {
            reply: OperationReply {
                reference: self.reference,
                receipt: Receipt::Unavailable {
                    diagnostic: "Host executor owner disappeared; read original receipt".into(),
                },
            },
            cleanup: Err("Host executor cleanup unconfirmed: owner disappeared".into()),
        })
    }
}

#[derive(Clone, Default)]
pub struct Snapshot {
    /// Exact source currently being read/preflighted; not an adopted input or grant.
    pub loading: Option<DeploymentRef>,
    /// Latest validated committed source adopted by this owner.
    pub desired: Option<DeploymentRef>,
    /// Last source whose complete plan actually converged.
    pub effective: Option<DeploymentRef>,
    pub starting: bool,
    pub startup_error: Option<String>,
    /// Failed initializers and their dependent instances in the desired source.
    /// Cleanup may still be pending; only a new source permits another attempt.
    pub initialization_failures: BTreeSet<InstanceId>,
    pub closing: bool,
    pub closed: bool,
    pub cleanup_error: Option<String>,
    pub instances: Vec<Status>,
}

/// The deployment root owns its stop signal. Ordinary clients cannot keep that
/// root alive; root Drop requests retirement, never acknowledges cleanup.
pub struct Application {
    client: Client,
    adoptions: mpsc::Sender<Adoption>,
    stop: CancellationToken,
    source: Option<DeploymentRef>,
}
impl Drop for Application {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}
#[derive(Clone)]
pub struct Client {
    dispatch: Arc<Dispatch>,
    control: mpsc::Sender<Retirement>,
    updates: watch::Receiver<Snapshot>,
}

struct Dispatch {
    commands: mpsc::UnboundedSender<Command>,
    bytes: Arc<Semaphore>,
    resources: Arc<Semaphore>,
}

pub(super) enum Command {
    ShutdownIdle {
        reply: oneshot::Sender<Result<bool>>,
    },
    CaptureImport {
        consumer: InstanceId,
        import: String,
        reply: oneshot::Sender<Result<CapturedImport>>,
    },
    CaptureUi {
        source: DeploymentRef,
        consumer: InstanceId,
        reply: oneshot::Sender<Result<BTreeMap<String, Vec<Binding>>>>,
    },
    Bind {
        consumer: Activation,
        import: String,
        reply: oneshot::Sender<Result<Vec<Binding>>>,
    },
    Call(Box<Call>),
    Recover {
        consumer: Activation,
        reference: Box<RecoveryRef>,
        scope: Scope,
        parent: Option<Ticket>,
        reply: oneshot::Sender<Result<Option<OperationObservation>>>,
        _bytes: OwnedSemaphorePermit,
    },
}
pub(super) struct Call {
    kind: CallKind,
    binding: Binding,
    method: String,
    input: Value,
    scope: Scope,
    attachments: Attachments,
    capture: Option<Uuid>,
    admitted: resource_ingress::AttachmentSize,
    bytes: OwnedSemaphorePermit,
    resources: OwnedSemaphorePermit,
    parent: Option<Ticket>,
}
pub(super) enum CallKind {
    PrepareMutation {
        operation: Uuid,
        reply: oneshot::Sender<Result<PreparedMutation>>,
    },
    Query(oneshot::Sender<Result<Accepted>>),
    Subscription {
        reply: oneshot::Sender<Result<Subscription>>,
    },
    Mutation {
        operation: Uuid,
        confirmation: Option<Confirmation>,
        reply: oneshot::Sender<Result<Mutation>>,
    },
}
// Only the local variant holds a caller Root lease. Peer observations must pass
// the final confirmation policy; the actual token stays in the caller process.
pub(super) enum Confirmation {
    Recorded(Box<RecordedIntent>),
    Peer(Box<CallerConfirmation>),
}
impl Confirmation {
    fn reference(&self) -> &RecoveryRef {
        match self {
            Self::Recorded(recorded) => &recorded.intent().reference,
            Self::Peer(intent) => &intent.reference,
        }
    }
}
impl CallKind {
    fn operation(&self) -> Option<Uuid> {
        match self {
            Self::Query(_) | Self::Subscription { .. } => None,
            Self::Mutation { operation, .. } | Self::PrepareMutation { operation, .. } => {
                Some(*operation)
            }
        }
    }
    fn closed(&self) -> bool {
        match self {
            Self::Query(reply) => reply.is_closed(),
            Self::Subscription { reply, .. } => reply.is_closed(),
            Self::Mutation { reply, .. } => reply.is_closed(),
            Self::PrepareMutation { reply, .. } => reply.is_closed(),
        }
    }
    fn reject(self, error: String) {
        match self {
            Self::Query(reply) => {
                let _ = reply.send(Err(error));
            }
            Self::Subscription { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::Mutation { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::PrepareMutation { reply, .. } => {
                let _ = reply.send(Err(error));
            }
        }
    }
    fn take_confirmation(&mut self) -> Option<Confirmation> {
        match self {
            Self::Mutation { confirmation, .. } => confirmation.take(),
            _ => None,
        }
    }
    fn peer_intent(&self) -> Option<&CallerConfirmation> {
        match self {
            Self::Mutation {
                confirmation: Some(Confirmation::Peer(intent)),
                ..
            } => Some(intent),
            _ => None,
        }
    }
    fn expected(&self) -> Option<&RecoveryRef> {
        match self {
            Self::Mutation {
                confirmation: Some(confirmation),
                ..
            } => Some(confirmation.reference()),
            _ => None,
        }
    }
    fn accept(
        self,
        id: Uuid,
        reference: Option<RecoveryRef>,
        validator: Arc<jsonschema::Validator>,
        progress: Option<Arc<jsonschema::Validator>>,
        stop: CancellationToken,
    ) -> (Reply, Option<subscriptions::Emitter>) {
        match self {
            Self::PrepareMutation { .. } => unreachable!("preparation cannot accept execution"),
            Self::Query(reply) => {
                let (output, result) = oneshot::channel();
                let _ = reply.send(Ok(Accepted { id, result }));
                (Reply::Query(output), None)
            }
            Self::Subscription { reply } => {
                let (output, result) = oneshot::channel();
                let (subscriber, emitter) =
                    subscriptions::channel(Accepted { id, result }, validator, stop);
                let _ = reply.send(Ok(subscriber));
                (Reply::Query(output), Some(emitter))
            }
            Self::Mutation { reply, .. } => {
                let reference = reference.expect("admitted mutation reference");
                let (output, result) = oneshot::channel();
                let (progress, emitter) = match progress {
                    Some(validator) => {
                        let (items, emitter) = subscriptions::items(validator, stop.child_token());
                        (Some(items), Some(emitter))
                    }
                    None => (None, None),
                };
                let _ = reply.send(Ok(Mutation {
                    id,
                    reference: reference.clone(),
                    result,
                    progress,
                }));
                (
                    Reply::Mutation {
                        reference: Box::new(reference),
                        reply: output,
                    },
                    emitter,
                )
            }
        }
    }
}
pub(super) enum Reply {
    Query(oneshot::Sender<QueryCompletion>),
    Mutation {
        reference: Box<RecoveryRef>,
        reply: oneshot::Sender<MutationCompletion>,
    },
}
impl Reply {
    fn send(
        self,
        result: Result<Value>,
        cleanup: Result<()>,
        receipt: Option<Result<OperationObservation>>,
    ) {
        match self {
            Self::Query(reply) => {
                let _ = reply.send(QueryCompletion { result, cleanup });
            }
            Self::Mutation { reference, reply } => {
                let receipt = match receipt.expect("mutation completion carries receipt knowledge")
                {
                    Ok(observation) => {
                        assert_eq!(*reference, observation.reference);
                        Receipt::Recorded {
                            outcome: observation.outcome,
                            cleanup: observation.cleanup,
                        }
                    }
                    Err(error) => Receipt::Unavailable {
                        diagnostic: owner::diagnostic(&error),
                    },
                };
                let _ = reply.send(MutationCompletion {
                    reply: OperationReply {
                        reference: *reference,
                        receipt,
                    },
                    cleanup,
                });
            }
        }
    }
}
pub(super) struct Adoption {
    source: DeploymentRef,
    reply: oneshot::Sender<Result<()>>,
}
pub(super) struct Retirement {
    activation: Activation,
    reply: oneshot::Sender<Result<()>>,
}

impl Application {
    pub fn start(
        input: Input,
        packages: Vec<Package>,
        native: NativeRegistry,
        issuer: Issuer,
        policy: Arc<dyn Policy>,
        scripts: Option<Arc<dyn backend::Factory>>,
    ) -> Result<Self> {
        Self::start_owned(input, packages, native, issuer, policy, scripts, None, None)
    }

    /// Loads the original source and exact bytes in one storage snapshot.
    /// The execution owner retains the storage lease through actual cleanup.
    pub async fn start_from_store(
        store: Arc<maka_event_log::root_store::RootStore>,
        deployment: Uuid,
        native: NativeRegistry,
        issuer: Issuer,
        policy: Arc<dyn Policy>,
        scripts: Option<Arc<dyn backend::Factory>>,
    ) -> Result<Self> {
        let loaded = store
            .load_application(deployment)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("deployment not found")?;
        Self::start_loaded(store, loaded, native, issuer, policy, scripts)
    }

    /// Start a committed snapshot belonging to the same live original Root.
    pub fn start_loaded(
        store: Arc<maka_event_log::root_store::RootStore>,
        loaded: maka_event_log::applications::LoadedDeployment,
        mut native: NativeRegistry,
        issuer: Issuer,
        policy: Arc<dyn Policy>,
        scripts: Option<Arc<dyn backend::Factory>>,
    ) -> Result<Self> {
        store
            .check_application(&loaded)
            .map_err(|error| error.to_string())?;
        // Persisted remote declarations are compatibility observations. This
        // executor has no trusted remote transport and cannot turn them into grants.
        if !loaded.source().remote_exports.is_empty() {
            return Err("remote Host executor is unavailable".into());
        }
        operations::provide(&mut native)?;
        management::provide(&mut native)?;
        logs::provide(&mut native)?;
        let (source, packages, plan, snapshot) = loaded.into_parts();
        Self::start_owned(
            source.input,
            packages,
            native,
            issuer,
            policy,
            scripts,
            Some((snapshot, store)),
            Some(plan),
        )
    }

    /// Adopt exact committed bytes without granting plugin code a management capability.
    /// Success acknowledges desired input, not activation or cleanup completion.
    pub async fn adopt_committed(&self, source: DeploymentRef) -> Result<()> {
        let (reply, result) = oneshot::channel();
        self.adoptions
            .try_send(Adoption { source, reply })
            .map_err(|e| e.to_string())?;
        result
            .await
            .map_err(|_| "Host owner disappeared during adoption".to_string())?
    }

    /// The source this root originally started from; live progress is in Snapshot.
    pub fn source(&self) -> Option<&DeploymentRef> {
        self.source.as_ref()
    }

    #[allow(clippy::too_many_arguments)]
    fn start_owned(
        input: Input,
        packages: Vec<Package>,
        native: NativeRegistry,
        issuer: Issuer,
        policy: Arc<dyn Policy>,
        scripts: Option<Arc<dyn backend::Factory>>,
        persisted: Option<(
            maka_event_log::applications::SourceSnapshot,
            Arc<maka_event_log::root_store::RootStore>,
        )>,
        plan: Option<Plan>,
    ) -> Result<Self> {
        let (plan, sources) = match plan {
            Some(plan) => prepare_plan(packages, &native, persisted.is_some(), plan)?,
            None => prepare(&input, packages, &native, persisted.is_some())?,
        };
        let scheduler = tokio::runtime::Handle::try_current().map_err(|e| e.to_string())?;
        let (commands, receiver) = mpsc::unbounded_channel();
        let (control, controls) = mpsc::channel(16);
        let (adoptions, adoption_requests) = mpsc::channel(16);
        let (updates, observations) = watch::channel(Snapshot {
            starting: true,
            ..Default::default()
        });
        let stop = CancellationToken::new();
        let dispatch = Arc::new(Dispatch {
            commands,
            bytes: Arc::new(Semaphore::new(resource_ingress::INPUT_WINDOW)),
            resources: Arc::new(Semaphore::new(resource_ingress::RESOURCE_WINDOW)),
        });
        let client = Client {
            dispatch: dispatch.clone(),
            control,
            updates: observations,
        };
        let source = persisted
            .as_ref()
            .map(|(source, _)| source.reference().clone());
        scheduler.spawn(
            owner::Owner::new(
                plan,
                input,
                sources,
                native,
                issuer,
                policy,
                scripts,
                updates,
                Arc::downgrade(&dispatch),
                persisted,
            )
            .run(receiver, controls, adoption_requests, stop.clone()),
        );
        Ok(Self {
            client,
            adoptions,
            stop,
            source,
        })
    }
    pub fn client(&self) -> Client {
        self.client.clone()
    }
    pub async fn ready(&self) -> Result<()> {
        self.client.ready().await
    }
    pub async fn shutdown(&self) -> Result<()> {
        self.stop.cancel();
        self.wait_closed().await
    }
    /// Atomically retire only if invocations and native background work are
    /// idle. A busy result preserves admission. Success awaits real cleanup;
    /// dropping this observer never cancels an already committed retirement.
    pub async fn shutdown_if_idle(&self) -> Result<bool> {
        if self.client.snapshot().closing {
            self.wait_closed().await?;
            return Ok(true);
        }
        let (reply, receive) = oneshot::channel();
        self.client
            .dispatch
            .commands
            .send(Command::ShutdownIdle { reply })
            .map_err(|_| "Host owner disappeared before idle retirement".to_string())?;
        if !receive
            .await
            .map_err(|_| "Host owner disappeared before idle retirement".to_string())??
        {
            return Ok(false);
        }
        self.wait_closed().await?;
        Ok(true)
    }
    async fn wait_closed(&self) -> Result<()> {
        let mut updates = self.client.updates.clone();
        loop {
            let snapshot = updates.borrow().clone();
            if let Some(error) = snapshot.cleanup_error {
                return Err(error);
            }
            if snapshot.closed {
                return Ok(());
            }
            updates
                .changed()
                .await
                .map_err(|_| "Host owner disappeared before cleanup".to_string())?;
        }
    }
}
impl Client {
    pub fn snapshot(&self) -> Snapshot {
        self.updates.borrow().clone()
    }
    pub async fn ready(&self) -> Result<()> {
        let mut updates = self.updates.clone();
        loop {
            let snapshot = updates.borrow().clone();
            if let Some(error) = snapshot.startup_error {
                return Err(error);
            }
            if snapshot.starting
                && let Some(error) = snapshot.cleanup_error
            {
                return Err(error);
            }
            if snapshot.closing {
                return Err("Host deployment is closing".into());
            }
            if !snapshot.starting {
                return Ok(());
            }
            updates
                .changed()
                .await
                .map_err(|_| "Host owner disappeared during startup".to_string())?;
        }
    }
    /// Observe one current instance without requiring unrelated startup work to
    /// succeed. The returned activation still needs exact binding and admission.
    pub async fn ready_instance(&self, id: &InstanceId) -> Result<Activation> {
        let mut updates = self.updates.clone();
        loop {
            let snapshot = updates.borrow().clone();
            if snapshot.closing {
                return Err("Host deployment is closing".into());
            }
            if snapshot.initialization_failures.contains(id) {
                return Err("Host instance failed to initialize".into());
            }
            if let Some(status) = snapshot
                .instances
                .iter()
                .find(|s| s.activation.instance() == id && s.phase == Phase::Active)
            {
                return Ok(status.activation.clone());
            }
            if !snapshot.starting {
                return Err("Host instance is unavailable".into());
            }
            updates
                .changed()
                .await
                .map_err(|_| "Host owner disappeared during instance startup".to_string())?;
        }
    }
    /// Capture all imports from one enabled UI consumer in its exact adopted source.
    /// Source adoption and dependency initialization use the owner's notifications.
    pub async fn capture_ui(
        &self,
        source: DeploymentRef,
        consumer: InstanceId,
    ) -> Result<BTreeMap<String, Vec<Binding>>> {
        let mut updates = self.updates.clone();
        loop {
            let snapshot = updates.borrow().clone();
            if snapshot.closing {
                return Err("Host deployment is closing".into());
            }
            if let Some(desired) = &snapshot.desired {
                if desired.state_domain != source.state_domain
                    || desired.deployment != source.deployment
                {
                    return Err("foreign UI deployment source".into());
                }
                if desired.revision > source.revision {
                    return Err("UI deployment source was superseded".into());
                }
                if desired == &source {
                    if snapshot.initialization_failures.contains(&consumer) {
                        return Err("UI service dependency failed to initialize".into());
                    }
                    if snapshot.instances.iter().any(|status| {
                        status.activation.instance() == &consumer && status.phase == Phase::Active
                    }) {
                        break;
                    }
                    if !snapshot.starting {
                        return Err("UI consumer is unavailable".into());
                    }
                }
            }
            if snapshot.loading.is_none()
                && let Some(error) = snapshot.startup_error
            {
                return Err(error);
            }
            updates
                .changed()
                .await
                .map_err(|_| "Host owner disappeared during UI binding capture".to_string())?;
        }
        let (reply, result) = oneshot::channel();
        self.dispatch
            .commands
            .send(Command::CaptureUi {
                source,
                consumer,
                reply,
            })
            .map_err(|error| error.to_string())?;
        result
            .await
            .map_err(|_| "Host deployment is closed".to_string())?
    }
    pub async fn bind(&self, consumer: Activation, import: String) -> Result<Vec<Binding>> {
        let (reply, result) = oneshot::channel();
        self.dispatch
            .commands
            .send(Command::Bind {
                consumer,
                import,
                reply,
            })
            .map_err(|e| e.to_string())?;
        result
            .await
            .map_err(|_| "Host deployment is closed".to_string())?
    }
    /// Capture one declared provider from the current checked plan and its
    /// actual registration in the same owner turn. This never waits or activates.
    pub async fn capture_import(
        &self,
        consumer: InstanceId,
        import: String,
    ) -> Result<CapturedImport> {
        let (reply, result) = oneshot::channel();
        self.dispatch
            .commands
            .send(Command::CaptureImport {
                consumer,
                import,
                reply,
            })
            .map_err(|e| e.to_string())?;
        result
            .await
            .map_err(|_| "Host deployment is closed".to_string())?
    }
    pub async fn start(
        &self,
        binding: Binding,
        method: String,
        input: Value,
        scope: Scope,
        attachments: CallResources,
    ) -> Result<Accepted> {
        attachments.check_scope(&scope)?;
        let (reply, result) = oneshot::channel();
        self.dispatch.enqueue(
            binding,
            method,
            input,
            scope,
            attachments,
            None,
            CallKind::Query(reply),
        )?;
        result
            .await
            .map_err(|_| "Host deployment is closed".to_string())?
    }
    /// Starts an independently cancellable stream. Dropping the subscriber (or
    /// this admission future) requests cancellation, never confirms cleanup.
    pub async fn subscribe(
        &self,
        binding: Binding,
        method: String,
        input: Value,
        scope: Scope,
        attachments: CallResources,
    ) -> Result<Subscription> {
        attachments.check_scope(&scope)?;
        let scope = scope.child().map_err(|e| e.to_string())?;
        let guard = scope.cancellation.clone().drop_guard();
        let (reply, result) = oneshot::channel();
        self.dispatch.enqueue(
            binding,
            method,
            input,
            scope,
            attachments,
            None,
            CallKind::Subscription { reply },
        )?;
        let subscriber = result
            .await
            .map_err(|_| "Host deployment is closed".to_string())??;
        guard.disarm();
        Ok(subscriber)
    }
    /// Checks and captures the original invocation without dispatching an effect.
    #[allow(clippy::too_many_arguments)]
    pub fn prepare_mutation(
        &self,
        binding: Binding,
        method: String,
        input: Value,
        scope: Scope,
        operation: Uuid,
        attachments: CallResources,
    ) -> BoxFuture<'static, Result<PreparedMutation>> {
        // Queue and reserve original custody synchronously. A concurrent close
        // cannot acknowledge this request between publication and first poll.
        let queued = (|| {
            attachments.check_scope(&scope)?;
            let ticket = if attachments.captured() {
                None
            } else {
                Some(scope.resources.reserve().map_err(|e| e.to_string())?)
            };
            let (reply, result) = oneshot::channel();
            self.dispatch.enqueue(
                binding,
                method,
                input,
                scope,
                attachments,
                ticket,
                CallKind::PrepareMutation { operation, reply },
            )?;
            Ok::<_, String>(result)
        })();
        Box::pin(async move {
            queued?
                .await
                .map_err(|_| "Host deployment is closed".to_string())?
        })
    }
    /// Requires caller persistence, then rechecks the original invocation at dispatch.
    pub async fn mutate(
        &self,
        prepared: PreparedMutation,
        recorded: RecordedIntent,
    ) -> Result<Mutation> {
        self.dispatch_mutation(prepared, Some(Confirmation::Recorded(Box::new(recorded))))
            .await
    }
    /// Dispatches an authenticated peer adapter's caller-commit attestation.
    /// JSON observations do not prove commit or authorize execution: the Host's
    /// final `Policy::confirm_peer_mutation` must check the original private
    /// Scope evidence and exact caller source/consumer/request, in addition to
    /// `Policy::admit`. It defaults to refusal. No Host caller intent is written.
    /// The caller adapter must retain its actual `RecordedIntent` until remote
    /// cleanup is confirmed; this observation cannot own the remote caller Root.
    pub async fn mutate_from_peer(
        &self,
        prepared: PreparedMutation,
        intent: CallerConfirmation,
    ) -> Result<Mutation> {
        intent.validate().map_err(|e| e.to_string())?;
        self.dispatch_mutation(prepared, Some(Confirmation::Peer(Box::new(intent))))
            .await
    }
    /// The trusted Host gateway is the caller: persist its original intent in
    /// this Application's Root before final admission and execution. Ordinary
    /// peer transports must use their caller's recorded confirmation instead.
    pub async fn mutate_owned(&self, prepared: PreparedMutation) -> Result<Mutation> {
        self.dispatch_mutation(prepared, None).await
    }
    async fn dispatch_mutation(
        &self,
        mut prepared: PreparedMutation,
        confirmation: Option<Confirmation>,
    ) -> Result<Mutation> {
        if confirmation
            .as_ref()
            .is_some_and(|value| &prepared.reference != value.reference())
        {
            return Err("caller intent disagrees with original preparation".into());
        }
        let reference = prepared.reference.clone();
        let PreparedInvocation {
            binding,
            method,
            input,
            scope,
            attachments,
            capture,
            admitted,
            bytes,
            resources,
            parent,
        } = prepared.invocation.take().expect("original invocation");
        let (reply, result) = oneshot::channel();
        self.dispatch
            .commands
            .send(Command::Call(Box::new(Call {
                parent,
                kind: CallKind::Mutation {
                    operation: reference.operation,
                    confirmation,
                    reply,
                },
                binding,
                method,
                input,
                scope,
                attachments,
                capture,
                admitted,
                bytes,
                resources,
            })))
            .map_err(|e| e.to_string())?;
        result
            .await
            .map_err(|_| "Host deployment is closed".to_string())?
    }
    /// A fixed-root observation; no current provider is resolved or invoked.
    pub async fn recover(
        &self,
        consumer: Activation,
        reference: RecoveryRef,
        scope: Scope,
    ) -> Result<Option<OperationObservation>> {
        self.dispatch
            .recover(consumer, reference, scope, None)?
            .await
            .map_err(|_| "Host deployment is closed".to_string())?
    }
    pub async fn retire(&self, activation: Activation) -> Result<()> {
        let (reply, result) = oneshot::channel();
        self.control
            .try_send(Retirement { activation, reply })
            .map_err(|e| e.to_string())?;
        result
            .await
            .map_err(|_| "Host deployment is closed".to_string())?
    }
    pub fn activation(&self, id: &InstanceId) -> Result<Activation> {
        self.updates
            .borrow()
            .instances
            .iter()
            .find(|s| s.activation.instance() == id)
            .map(|s| s.activation.clone())
            .ok_or_else(|| "activation unavailable".into())
    }
}

fn check_reference(reference: &RecoveryRef) -> Result<usize> {
    maka_plugin_core::json::check_delivery(
        &serde_json::to_value(reference).map_err(|e| e.to_string())?,
        usize::MAX,
    )
    .map_err(|e| e.to_string())
}

fn json_size<T: serde::Serialize + ?Sized>(value: &T) -> Result<usize> {
    struct Count(usize);
    impl Write for Count {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self
                .0
                .checked_add(bytes.len())
                .ok_or_else(|| std::io::Error::other("service JSON length overflow"))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count(0);
    serde_json::to_writer(&mut count, value).map_err(|e| e.to_string())?;
    Ok(count.0)
}

impl Dispatch {
    // Transfer each actual work owner explicitly; none is encoded as a grant.
    #[allow(clippy::too_many_arguments)]
    fn enqueue(
        &self,
        binding: Binding,
        method: String,
        input: Value,
        scope: Scope,
        attachments: CallResources,
        parent: Option<Ticket>,
        kind: CallKind,
    ) -> Result<()> {
        // Early validation also drops physical input before its inert ticket.
        let custody = (attachments, parent);
        let size = maka_plugin_core::json::value_size(&input, usize::MAX)?;
        if method.is_empty() {
            return Err("invalid service method".into());
        }
        let resource_ingress::Reserved {
            attachments,
            bytes,
            resources,
            admitted,
            parent,
            ..
        } = self.resources(custody.0, &scope, size, custody.1)?;
        let capture = (kind.operation().is_some() && !attachments.is_empty()).then(Uuid::new_v4);
        self.commands
            .send(Command::Call(Box::new(Call {
                parent,
                kind,
                binding,
                method,
                input,
                scope,
                attachments,
                capture,
                admitted,
                bytes,
                resources,
            })))
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    fn recover(
        &self,
        consumer: Activation,
        reference: RecoveryRef,
        scope: Scope,
        parent: Option<Ticket>,
    ) -> Result<oneshot::Receiver<Result<Option<OperationObservation>>>> {
        let size = check_reference(&reference)?;
        let bytes = self
            .bytes
            .clone()
            .try_acquire_many_owned(resource_ingress::charge(
                size.max(1),
                resource_ingress::INPUT_WINDOW,
            ))
            .map_err(|_| "Host recovery budget exhausted")?;
        let (reply, result) = oneshot::channel();
        self.commands
            .send(Command::Recover {
                consumer,
                reference: Box::new(reference),
                scope,
                parent,
                reply,
                _bytes: bytes,
            })
            .map_err(|e| e.to_string())?;
        Ok(result)
    }
}

/// Validate an entire candidate before changing any live activation.
fn prepare(
    input: &Input,
    packages: Vec<Package>,
    native: &NativeRegistry,
    durable: bool,
) -> Result<(Plan, BTreeMap<PackageRef, Package>)> {
    let mut declarations = Packages::default();
    for package in &packages {
        declarations
            .insert_checked(
                package.application_ref(),
                package
                    .manifest()
                    .application
                    .as_ref()
                    .ok_or("application package declaration required")?
                    .clone(),
            )
            .map_err(|e| e.to_string())?;
    }
    let plan =
        Plan::prepare(input, &declarations, &RemoteExports::new()).map_err(|e| e.to_string())?;
    prepare_plan(packages, native, durable, plan)
}

fn prepare_plan(
    packages: Vec<Package>,
    native: &NativeRegistry,
    durable: bool,
    plan: Plan,
) -> Result<(Plan, BTreeMap<PackageRef, Package>)> {
    let sources = packages
        .into_iter()
        .map(|p| (p.application_ref(), p))
        .collect();
    for instance in plan.instances().values().filter(|i| !i.disabled) {
        if let Some(entry) = instance.host_entry() {
            for export in entry.exports.values() {
                let Interface::Service { methods } = &export.contract.interface else {
                    return Err("Host service executor requires service exports".into());
                };
                if methods
                    .values()
                    .any(|m| m.mode == MethodMode::Mutation && !durable)
                {
                    return Err("durable mutation requires a State Root".into());
                }
            }
            if let Implementation::Native { implementation } = &entry.implementation
                && !native.0.contains_key(implementation)
            {
                return Err(format!(
                    "native implementation unavailable: {implementation}"
                ));
            }
        }
    }
    Ok((plan, sources))
}
