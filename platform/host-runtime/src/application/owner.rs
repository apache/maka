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
mod diagnostics;
use futures_util::{FutureExt, StreamExt, stream::FuturesUnordered};
use maka_event_log::applications::operations::{Dispatch as OperationDispatch, OperationRequest};
use maka_plugin_core::{
    package::Realm,
    plan::{Instance, InstanceEntry, Provider},
    runtime::{Execution, Phase, Resource, Runtime},
};
use std::panic::AssertUnwindSafe;

type Close = BoxFuture<'static, Result<()>>;
type Jobs = FuturesUnordered<BoxFuture<'static, Done>>;

// A refused entry is not a handler error, and a panic is not a definite return.
enum HandlerOutcome {
    NotInvoked(String),
    Returned(Result<Value>),
    Computed,
    Unknown(String),
}

struct Failed {
    _execution: Execution<Service>,
    _scope: Scope,
    _bytes: OwnedSemaphorePermit,
    _attachments: Attachments,
    _resources: OwnedSemaphorePermit,
    _confirmation: Option<Confirmation>,
}
// Cancellation custody for original accepted subscriptions, not completion evidence.
struct Observation {
    provider: Activation,
    consumer: Activation,
    cancellation: CancellationToken,
}
struct Owned {
    exports: Arc<BTreeMap<String, Binding>>,
    imports: Arc<BTreeMap<String, Vec<Binding>>>,
    resource: Resource,
    lifecycle: ActivationLifecycle,
}
enum CodeOwner {
    Native(Arc<dyn NativeOwner>),
    JavaScript { vm: Option<usize> },
}
struct InitializedCode {
    close: Close,
    owner: CodeOwner,
}
// Code custody is independent of Runtime's publication and invocation admission.
enum ActivationLifecycle {
    Initializing { vm: Option<usize> },
    Initialized(InitializedCode),
    Retiring(InitializedCode),
    Closing(CodeOwner),
    // Initializer panics return no owner; failed closes retain their actual owner.
    CleanupUnconfirmed(Option<CodeOwner>),
}
enum Initialization {
    Native(Arc<dyn NativeOwner>),
    JavaScript(Close),
    CleanupUnconfirmed,
}
impl ActivationLifecycle {
    fn initializing(&self) -> bool {
        matches!(self, Self::Initializing { .. })
    }
    fn owner(&self) -> Option<&CodeOwner> {
        match self {
            Self::Initializing { .. } => None,
            Self::Initialized(code) | Self::Retiring(code) => Some(&code.owner),
            Self::Closing(owner) => Some(owner),
            Self::CleanupUnconfirmed(owner) => owner.as_ref(),
        }
    }
    fn native_owner(&self) -> Option<&Arc<dyn NativeOwner>> {
        match self.owner()? {
            CodeOwner::Native(owner) => Some(owner),
            CodeOwner::JavaScript { .. } => None,
        }
    }
    fn vm(&self) -> Option<usize> {
        match self {
            Self::Initializing { vm } => *vm,
            _ => match self.owner()? {
                CodeOwner::Native(_) => None,
                CodeOwner::JavaScript { vm } => *vm,
            },
        }
    }
    fn assign_vm(&mut self, index: usize) {
        let Self::Initializing { vm } = self else {
            unreachable!("only initialization assigns a VM")
        };
        *vm = Some(index);
    }
    fn initialized(&mut self, initialization: Initialization) {
        let Self::Initializing { vm } = self else {
            unreachable!("initializer completes once")
        };
        *self = match initialization {
            Initialization::Native(owner) => {
                let closing = owner.clone();
                Self::Initialized(InitializedCode {
                    close: Box::pin(async move { closing.close().await }),
                    owner: CodeOwner::Native(owner),
                })
            }
            Initialization::JavaScript(close) => Self::Initialized(InitializedCode {
                close,
                owner: CodeOwner::JavaScript { vm: *vm },
            }),
            Initialization::CleanupUnconfirmed => Self::CleanupUnconfirmed(None),
        };
    }
    fn retire(&mut self) -> bool {
        let previous = std::mem::replace(self, Self::CleanupUnconfirmed(None));
        match previous {
            Self::Initialized(code) => {
                *self = Self::Retiring(code);
                true
            }
            other => {
                *self = other;
                false
            }
        }
    }
    fn begin_close(&mut self) -> Option<Close> {
        let previous = std::mem::replace(self, Self::CleanupUnconfirmed(None));
        match previous {
            Self::Retiring(code) => {
                *self = Self::Closing(code.owner);
                Some(code.close)
            }
            other => {
                *self = other;
                None
            }
        }
    }
    fn has_pending_close(&self) -> bool {
        matches!(self, Self::Initialized(_) | Self::Retiring(_))
    }
    fn release_vm(&mut self) {
        let Self::Closing(CodeOwner::JavaScript { vm }) = self else {
            unreachable!("only a closing module releases its VM")
        };
        *vm = None;
    }
    fn cleanup_unconfirmed(&mut self) {
        let Self::Closing(owner) = std::mem::replace(self, Self::CleanupUnconfirmed(None)) else {
            unreachable!("only a closing activation reports cleanup failure")
        };
        *self = Self::CleanupUnconfirmed(Some(owner));
    }
}
enum Done {
    Loaded {
        loaded: Result<Box<maka_event_log::applications::LoadedDeployment>>,
        reply: Option<oneshot::Sender<Result<()>>>,
    },
    IntentRecorded {
        call: Box<Call>,
        recorded: Result<Box<maka_event_log::applications::intents::RecordedIntent>>,
        resource: Resource,
    },
    Initialized {
        activation: Activation,
        exports: Result<BTreeMap<String, Published<Service>>>,
        initialization: Initialization,
    },
    Called {
        parent: Option<Ticket>,
        execution: Execution<Service>,
        result: Result<Value>,
        historical: Option<Box<OperationObservation>>,
        consumer: Activation,
        caller: Box<Scope>,
        scope: Box<Scope>,
        cleanup: Result<()>,
        receipt: Option<Box<Result<OperationObservation>>>,
        reply: Reply,
        _bytes: OwnedSemaphorePermit,
        attachments: Attachments,
        _resources: OwnedSemaphorePermit,
        confirmation: Option<Confirmation>,
    },
    IntentLookedUp {
        consumer: Activation,
        operation: Uuid,
        caller: Box<Scope>,
        resource: Resource,
        parent: Ticket,
        result: Box<Result<Option<CallerIntent>>>,
        reply: oneshot::Sender<Result<Option<CallerIntent>>>,
        _bytes: OwnedSemaphorePermit,
    },
    Recovered {
        consumer: Activation,
        reference: Box<RecoveryRef>,
        caller: Box<Scope>,
        resource: Resource,
        parent: Option<Ticket>,
        result: Box<Result<Option<OperationObservation>>>,
        reply: oneshot::Sender<Result<Option<OperationObservation>>>,
        _bytes: OwnedSemaphorePermit,
    },
    Closed {
        activation: Activation,
        result: Result<()>,
    },
    VmsClosed,
}

pub(super) struct Owner {
    dispatch: Weak<Dispatch>,
    runtime: Runtime<Service>,
    // The source input remains the only composition authority; the plan is derived.
    _input: Input,
    // This lease belongs to accepted work, including sticky cleanup failures.
    persisted: Option<(
        maka_event_log::applications::SourceSnapshot,
        Arc<maka_event_log::root_store::RootStore>,
    )>,
    loading_adoption: Option<DeploymentRef>,
    effective: Option<DeploymentRef>,
    origins: BTreeMap<InstanceId, maka_event_log::applications::SourceSnapshot>,
    pending: Vec<Instance>,
    activations: BTreeMap<InstanceId, Activation>,
    owned: BTreeMap<InstanceId, Owned>,
    sources: BTreeMap<PackageRef, Package>,
    native: NativeRegistry,
    issuer: Issuer,
    preparation_resources: maka_capabilities::model_preparation::ModelPreparationResources,
    policy: Arc<dyn Policy>,
    scripts: Option<Arc<dyn backend::Factory>>,
    shared: Option<usize>,
    vms: BTreeMap<usize, Arc<dyn backend::Realm>>,
    next_vm: usize,
    jobs: Jobs,
    terminals: FuturesUnordered<BoxFuture<'static, (usize, String)>>,
    failed: Vec<Failed>,
    observations: BTreeMap<Uuid, Observation>,
    updates: watch::Sender<Snapshot>,
    starting: bool,
    startup_error: Option<String>,
    initialization_failures: BTreeSet<InstanceId>,
    cleanup_error: Option<String>,
    closing: bool,
    closing_vms: bool,
    shutdown_complete: bool,
}
impl Owner {
    // These are independently owned deployment dependencies, not a new config
    // authority. Keep their transfer explicit at this private constructor.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        plan: Plan,
        input: Input,
        sources: BTreeMap<PackageRef, Package>,
        native: NativeRegistry,
        issuer: Issuer,
        preparation_resources: maka_capabilities::model_preparation::ModelPreparationResources,
        policy: Arc<dyn Policy>,
        scripts: Option<Arc<dyn backend::Factory>>,
        updates: watch::Sender<Snapshot>,
        dispatch: Weak<Dispatch>,
        persisted: Option<(
            maka_event_log::applications::SourceSnapshot,
            Arc<maka_event_log::root_store::RootStore>,
        )>,
    ) -> Self {
        Self {
            dispatch,
            pending: plan
                .instances()
                .values()
                .filter(|i| !i.disabled)
                .cloned()
                .collect(),
            runtime: Runtime::new(plan),
            _input: input,
            persisted,
            loading_adoption: None,
            effective: None,
            origins: BTreeMap::new(),
            activations: BTreeMap::new(),
            owned: BTreeMap::new(),
            sources,
            native,
            issuer,
            preparation_resources,
            policy,
            scripts,
            shared: None,
            vms: BTreeMap::new(),
            next_vm: 0,
            jobs: Jobs::new(),
            terminals: FuturesUnordered::new(),
            failed: Vec::new(),
            observations: BTreeMap::new(),
            updates,
            starting: true,
            startup_error: None,
            initialization_failures: BTreeSet::new(),
            cleanup_error: None,
            closing: false,
            closing_vms: false,
            shutdown_complete: false,
        }
    }
    pub async fn run(
        mut self,
        mut commands: mpsc::UnboundedReceiver<Command>,
        mut control: mpsc::Receiver<Retirement>,
        mut adoptions: mpsc::Receiver<Adoption>,
        stop: CancellationToken,
    ) {
        let mut commands_open = true;
        let mut control_open = true;
        let mut adoptions_open = true;
        let mut changes = match self
            .persisted
            .as_ref()
            .map(|(source, store)| store.subscribe_application(source.reference().clone()))
            .transpose()
        {
            Ok(changes) => changes,
            Err(error) => {
                let source = self
                    .persisted
                    .as_ref()
                    .map(|(source, _)| source.reference());
                tracing::error!(target: "maka_host_runtime::application", stage = "source_watch_setup",
                    cause = diagnostics::cause(&error), sql_code = diagnostics::sql_code(&error), os_code = diagnostics::os_code(&error),
                    state_domain = source.map(|source| source.state_domain.as_str()),
                    deployment_id = source.map(|source| tracing::field::display(source.deployment)), source_revision = source.map(|source| source.revision),
                    "Host runtime failure");
                self.startup_error = Some(error.to_string());
                self.stop();
                None
            }
        };
        loop {
            self.drive();
            if self.is_closed() {
                let snapshot = self.snapshot();
                let updates = self.updates.clone();
                // The closing acknowledgement follows all of this owner's drops,
                // including native factories that may retain a store themselves.
                drop(commands);
                drop(control);
                drop(adoptions);
                drop(stop);
                drop(changes);
                drop(self);
                updates.send_replace(snapshot);
                return;
            }
            self.publish();
            tokio::select! {
                _ = stop.cancelled(), if !self.closing => {
                    self.stop();
                    commands.close();
                },
                Some(done) = self.jobs.next(), if !self.jobs.is_empty() => self.complete(done),
                Some((vm, reason)) = self.terminals.next(), if !self.terminals.is_empty() => self.retire_vm(vm, reason),
                // Desired-source reads serialize independently of immediate
                // lifecycle revocation. Only the application root owns ingress.
                adoption = adoptions.recv(), if adoptions_open && self.loading_adoption.is_none() => match adoption {
                    Some(Adoption { source, reply }) => {
                        match self.check_adoption_source(&source) {
                            Err(error) => { let _ = reply.send(Err(error)); }
                            Ok(false) => { let _ = reply.send(Ok(())); }
                            Ok(true) => self.load_adoption(source, Some(reply)),
                        }
                    }
                    None => adoptions_open = false,
                },
                command = control.recv(), if control_open => match command {
                    Some(Retirement { activation, reply }) => {
                        let result = self.runtime.retire(&activation).map(|_| ()).map_err(|e| e.to_string());
                        let _ = reply.send(result);
                    }
                    None => control_open = false,
                },
                change = async {
                    match &mut changes {
                        Some(cursor) => cursor.next().await,
                        None => std::future::pending().await,
                    }
                }, if !self.closing && self.loading_adoption.is_none() => {
                    match change {
                        Ok(source) => {
                            self.observe_source(source);
                        }
                        Err(error) => {
                            let source = self.persisted.as_ref().map(|(source, _)| source.reference());
                            tracing::warn!(target: "maka_host_runtime::application", stage = "source_watch",
                                cause = diagnostics::cause(&error), error = %error, sql_code = diagnostics::sql_code(&error), os_code = diagnostics::os_code(&error),
                                state_domain = source.map(|source| source.state_domain.as_str()),
                                deployment_id = source.map(|source| tracing::field::display(source.deployment)), "Host runtime failure");
                            changes = None;
                            self.startup_error = Some(error.to_string());
                        }
                    }
                },
                command = commands.recv(), if commands_open => match command {
                    Some(command) => self.command(command),
                    None => { commands_open = false; self.stop(); },
                },
                else => std::future::pending::<()>().await,
            }
        }
    }
    fn check_adoption_source(&self, source: &DeploymentRef) -> Result<bool> {
        if self.closing {
            return Err("Host deployment is closing".into());
        }
        let (current, _) = self
            .persisted
            .as_ref()
            .ok_or("persisted deployment required")?;
        let current = current.reference();
        if source.state_domain != current.state_domain || source.deployment != current.deployment {
            return Err("foreign deployment source".into());
        }
        if source.revision < current.revision {
            return Err("stale deployment source".into());
        }
        Ok(source != current)
    }
    fn observe_source(&mut self, source: DeploymentRef) {
        // A retained SQL observation can arrive after a newer explicit adoption.
        // It is not a failed candidate and must not poison healthy readiness.
        if self
            .persisted
            .as_ref()
            .is_some_and(|(current, _)| source.revision <= current.reference().revision)
        {
            return;
        }
        match self.check_adoption_source(&source) {
            Ok(true) => self.load_adoption(source, None),
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(target: "maka_host_runtime::application", stage = "source_observation", cause = "source_rejected",
                    state_domain = %source.state_domain, deployment_id = %source.deployment, source_revision = source.revision,
                    "Host runtime failure");
                self.startup_error = Some(error);
            }
        }
    }
    fn load_adoption(&mut self, source: DeploymentRef, reply: Option<oneshot::Sender<Result<()>>>) {
        let store = self
            .persisted
            .as_ref()
            .expect("validated persisted source")
            .1
            .clone();
        self.loading_adoption = Some(source.clone());
        self.jobs.push(Box::pin(async move {
            let loaded = store
                .load_application_at(&source)
                .await
                .map_err(|error| {
                    tracing::warn!(target: "maka_host_runtime::application", stage = "source_load", cause = diagnostics::cause(&error),
                        sql_code = diagnostics::sql_code(&error), os_code = diagnostics::os_code(&error),
                        state_domain = %source.state_domain, deployment_id = %source.deployment, source_revision = source.revision,
                        "Host runtime failure");
                    error.to_string()
                })
                .and_then(|loaded| loaded.ok_or_else(|| {
                    tracing::warn!(target: "maka_host_runtime::application", stage = "source_load", cause = "source_missing",
                        state_domain = %source.state_domain, deployment_id = %source.deployment, source_revision = source.revision,
                        "Host runtime failure");
                    "committed deployment not found".into()
                }))
                .map(Box::new);
            Done::Loaded { loaded, reply }
        }));
    }
    fn adopt(&mut self, loaded: maka_event_log::applications::LoadedDeployment) -> Result<()> {
        if self.closing {
            return Err("Host deployment is closing".into());
        }
        let (current, _) = self
            .persisted
            .as_ref()
            .ok_or("persisted deployment required")?;
        let (deployment, packages, plan, snapshot) = loaded.into_parts();
        let source = deployment.reference;
        let current = current.reference();
        if source.revision < current.revision {
            return Err("stale deployment source".into());
        }
        if source == *current {
            return Ok(());
        }
        if !deployment.remote_exports.is_empty() {
            return Err("remote Host executor is unavailable".into());
        }
        let input = deployment.input;
        let (plan, sources) = prepare_plan(packages, &self.native, true, plan)?;
        let instances = plan
            .instances()
            .values()
            .filter(|i| !i.disabled)
            .cloned()
            .collect::<Vec<_>>();
        self.runtime.install(plan);
        self.pending = instances
            .into_iter()
            .filter(|i| {
                !self.activations.get(&i.identity).is_some_and(|a| {
                    self.runtime
                        .status(a)
                        .is_ok_and(|s| s.phase == Phase::Active || s.phase == Phase::Loading)
                })
            })
            .collect();
        self.persisted.as_mut().expect("persisted deployment").0 = snapshot;
        self._input = input;
        self.sources = sources;
        self.startup_error = None;
        self.initialization_failures.clear();
        self.starting = true;
        Ok(())
    }
    fn stop(&mut self) {
        self.preparation_resources.close();
        self.closing = true;
        self.starting = false;
        self.pending.clear();
        for activation in self.activations.values() {
            self.runtime
                .retire(activation)
                .expect("activation belongs to this owner");
        }
    }
    fn shutdown_if_idle(&mut self) -> Result<bool> {
        if self.closing {
            return Ok(true);
        }
        if self.starting
            || self.loading_adoption.is_some()
            || !self.jobs.is_empty()
            || self
                .owned
                .values()
                .any(|owned| owned.lifecycle.initializing())
            || self.activations.values().any(|activation| {
                !self
                    .runtime
                    .pending_calls(activation)
                    .is_ok_and(|calls| calls == 0)
            })
        {
            let reason = if self.starting || self.loading_adoption.is_some() {
                "startup"
            } else if !self.jobs.is_empty() {
                "jobs"
            } else {
                "activation"
            };
            tracing::debug!(target: "maka_host_runtime::application", stage = "idle_retirement", reason,
                jobs = self.jobs.len(), failed_cleanup = self.failed.len(),
                "Host idle retirement deferred");
            return Ok(false);
        }
        // No await: invocation admission and source adoption remain serialized
        // with this decision. Each native guard fences its independent producers.
        let mut guards = Vec::new();
        for (id, owned) in &self.owned {
            if let Some(native) = owned.lifecycle.native_owner() {
                match std::panic::catch_unwind(AssertUnwindSafe(|| native.prepare_retirement())) {
                    Ok(Some(guard)) => guards.push(guard),
                    Ok(None) => {
                        let path = self
                            .runtime
                            .desired()
                            .instances()
                            .get(id)
                            .map(|instance| instance.path.join("/"));
                        tracing::debug!(target: "maka_host_runtime::application", stage = "idle_retirement",
                            reason = "native", instance_path = ?path,
                            "Host idle retirement deferred");
                        return Ok(false);
                    }
                    Err(_) => return Err("native idle retirement preparation panicked".into()),
                }
            }
        }
        self.stop();
        for guard in guards {
            if std::panic::catch_unwind(AssertUnwindSafe(|| guard.commit())).is_err() {
                self.cleanup_error
                    .get_or_insert("native idle retirement commit panicked".into());
            }
        }
        Ok(true)
    }
    fn activation_diagnostic_span(&self, activation: &Activation) -> tracing::Span {
        let source = self
            .origins
            .get(activation.instance())
            .map(|source| source.reference());
        tracing::error_span!(target: "maka_host_runtime::application", "host_activation",
            instance_id = ?activation.instance(), activation_id = %activation.epoch(),
            state_domain = source.map(|source| source.state_domain.as_str()),
            deployment_id = source.map(|source| tracing::field::display(source.deployment)), source_revision = source.map(|source| source.revision))
    }
    fn fail_initialization(&mut self, id: InstanceId, error: String) {
        let activation = self.activations.get(&id);
        let source = self.origins.get(&id).map(|source| source.reference());
        tracing::warn!(target: "maka_host_runtime::application", stage = "initialize", cause = "initializer_failed",
            instance_id = ?id, activation_id = activation.map(|activation| tracing::field::display(activation.epoch())),
            state_domain = source.map(|source| source.state_domain.as_str()),
            deployment_id = source.map(|source| tracing::field::display(source.deployment)), source_revision = source.map(|source| source.revision),
            "Host runtime failure");
        let path = self
            .runtime
            .desired()
            .instances()
            .get(&id)
            .map(|instance| instance.path.join("/"))
            .unwrap_or_else(|| format!("{id:?}"));
        self.startup_error
            .get_or_insert_with(|| diagnostic(&format!("plugin {path}: {error}")));
        self.initialization_failures.insert(id.clone());
        if let Some(activation) = self.activations.get(&id) {
            for retired in self.runtime.retire(activation).expect("owned activation") {
                self.initialization_failures
                    .insert(retired.instance().clone());
            }
        }
    }
    fn drive(&mut self) {
        if self.starting {
            let mut progressed = true;
            while progressed {
                progressed = false;
                for instance in std::mem::take(&mut self.pending) {
                    if self.closing || !self.starting {
                        break;
                    }
                    if self.initialization_failures.contains(&instance.identity) {
                        continue;
                    }
                    // A failed provider may already have physically closed. Keep
                    // its dependents out of this source's remaining attempts;
                    // independent initializers retain their own original work.
                    if instance
                        .parent
                        .as_ref()
                        .is_some_and(|id| self.initialization_failures.contains(id))
                        || instance.entry.is_some()
                            && instance.bindings.values().flatten().any(|b| {
                                matches!(&b.provider, Provider::Local { instance, .. }
                                if self.initialization_failures.contains(instance))
                            })
                    {
                        self.initialization_failures.insert(instance.identity);
                        progressed = true;
                        continue;
                    }
                    if self.activations.contains_key(&instance.identity) {
                        self.pending.push(instance);
                        continue;
                    }
                    let active = |id: &InstanceId| {
                        self.activations
                            .get(id)
                            .and_then(|a| self.runtime.status(a).ok())
                            .is_some_and(|s| s.phase == Phase::Active)
                    };
                    if instance.parent.as_ref().is_some_and(|id| !active(id))
                        || instance.entry.is_some()
                            && instance
                                .bindings
                                .values()
                                .flatten()
                                .any(|b| match &b.provider {
                                    Provider::Local { instance, .. } => !active(instance),
                                    Provider::Remote { .. } => true,
                                })
                    {
                        self.pending.push(instance);
                        continue;
                    }
                    progressed = true;
                    let id = instance.identity.clone();
                    if let Err(error) = self.initialize(instance) {
                        self.fail_initialization(id, error);
                    }
                }
            }
            if self.starting
                && self.initialization_failures.is_empty()
                && self
                    .runtime
                    .desired()
                    .instances()
                    .values()
                    .filter(|i| !i.disabled)
                    .all(|instance| {
                        self.activations.get(&instance.identity).is_some_and(|a| {
                            self.runtime
                                .status(a)
                                .is_ok_and(|s| s.phase == Phase::Active)
                        })
                    })
                && self.pending.is_empty()
                && self.activations.values().all(|a| {
                    self.runtime
                        .status(a)
                        .is_ok_and(|s| s.phase == Phase::Active)
                })
            {
                self.starting = false;
                self.effective = self
                    .persisted
                    .as_ref()
                    .map(|(source, _)| source.reference().clone());
            } else if self.pending.is_empty()
                && !self
                    .owned
                    .values()
                    .any(|owned| owned.lifecycle.initializing())
                && !self.initialization_failures.is_empty()
            {
                // All attempts have ended; failed resource cleanup remains
                // separately owned. This source has never fully converged.
                self.starting = false;
            } else if !self.pending.is_empty()
                && !self
                    .owned
                    .values()
                    .any(|owned| owned.lifecycle.initializing())
                && !self.activations.values().any(|a| {
                    self.runtime
                        .status(a)
                        .is_ok_and(|s| s.phase == Phase::Retiring)
                })
            {
                for instance in std::mem::take(&mut self.pending) {
                    self.fail_initialization(
                        instance.identity,
                        "Host dependencies did not become ready".into(),
                    );
                }
                self.starting = false;
            }
        }
        for observation in self.observations.values() {
            if [&observation.provider, &observation.consumer]
                .iter()
                .any(|activation| {
                    matches!(self.runtime.phase(activation), Ok(Phase::Retiring) | Err(_))
                })
            {
                observation.cancellation.cancel();
            }
        }
        for (id, activation) in &self.activations {
            if self
                .runtime
                .status(activation)
                .is_ok_and(|s| s.phase == Phase::Retiring)
                && let Some(owned) = self.owned.get_mut(id)
                && owned.lifecycle.retire()
                && let Some(native) = owned.lifecycle.native_owner()
                && std::panic::catch_unwind(AssertUnwindSafe(|| native.retiring())).is_err()
            {
                self.cleanup_error
                    .get_or_insert("native retirement notification panicked".into());
            }
            if self
                .runtime
                .status(activation)
                .is_ok_and(|s| s.phase == Phase::Retiring)
                && self
                    .runtime
                    .pending_calls(activation)
                    .is_ok_and(|calls| calls == 0)
                && let Some(owned) = self.owned.get_mut(id)
                && let Some(close) = owned.lifecycle.begin_close()
            {
                let activation = activation.clone();
                self.jobs.push(Box::pin(async move {
                    let result = AssertUnwindSafe(close)
                        .catch_unwind()
                        .await
                        .unwrap_or_else(|_| Err("native/module close panicked".into()));
                    Done::Closed { activation, result }
                }));
            }
        }
        let before_cleanup = self.activations.len();
        loop {
            let before = self.activations.len();
            for id in self.activations.keys().cloned().collect::<Vec<_>>() {
                let activation = &self.activations[&id];
                if self
                    .runtime
                    .status(activation)
                    .is_ok_and(|s| s.phase == Phase::Retiring)
                {
                    match self.runtime.finish_cleanup(activation) {
                        Ok(()) => {
                            self.activations.remove(&id);
                            self.origins.remove(&id);
                        }
                        Err(maka_plugin_core::Error::CleanupPending) => {}
                        Err(error) => {
                            self.cleanup_error.get_or_insert(error.to_string());
                        }
                    }
                }
            }
            if before == self.activations.len() {
                break;
            }
        }
        if self.starting && before_cleanup != self.activations.len() {
            self.drive();
            return;
        }
        if self.closing
            && self.jobs.is_empty()
            && !self.closing_vms
            && self.owned.values().all(|owned| {
                !owned.lifecycle.initializing() && !owned.lifecycle.has_pending_close()
            })
            && self.activations.values().all(|activation| {
                self.runtime
                    .pending_calls(activation)
                    .is_ok_and(|calls| calls == 0)
            })
        {
            self.closing_vms = true;
            self.terminals.clear();
            let vms = std::mem::take(&mut self.vms);
            self.shared = None;
            self.jobs.push(Box::pin(async move {
                for vm in vms.into_values() {
                    vm.shutdown().await;
                }
                Done::VmsClosed
            }));
        }
    }
    fn initialize(&mut self, instance: Instance) -> Result<()> {
        let activation = match instance.entry.as_ref() {
            Some(InstanceEntry::Ui(_)) => self.runtime.begin_ui_consumer(&instance.identity),
            _ => self.runtime.begin(&instance.identity),
        }
        .map_err(|e| e.to_string())?;
        self.activations
            .insert(instance.identity.clone(), activation.clone());
        if let Some((source, _)) = &self.persisted {
            self.origins
                .insert(instance.identity.clone(), source.clone());
        }
        let Some(InstanceEntry::Host(entry)) = instance.entry else {
            return self
                .runtime
                .publish(&activation, BTreeMap::new())
                .map_err(|e| e.error.to_string());
        };
        let imports = entry
            .imports
            .keys()
            .map(|name| {
                self.capture_bindings(&activation, name)
                    .map(|bindings| (name.clone(), bindings))
            })
            .collect::<Result<BTreeMap<_, _>>>()?;
        // This fence precedes every asynchronous initialization step, including
        // module readiness. Retire cannot release an initializer's owner early.
        let resource = self
            .runtime
            .own_resource(&activation, "Host service initialization and code")
            .map_err(|e| e.to_string())?;
        self.owned.insert(
            instance.identity.clone(),
            Owned {
                exports: Arc::default(),
                imports: Arc::new(imports),
                resource,
                lifecycle: ActivationLifecycle::Initializing { vm: None },
            },
        );
        let exports = entry
            .exports
            .iter()
            .map(|(name, declaration)| {
                let capability = self
                    .runtime
                    .own_export(&activation, name)
                    .map_err(|e| e.to_string())?;
                Ok((
                    name.clone(),
                    self.capture_binding(capability, Arc::new(declaration.contract.clone()))?,
                ))
            })
            .collect::<Result<BTreeMap<_, _>>>()?;
        self.owned
            .get_mut(&instance.identity)
            .expect("initializing owner")
            .exports = Arc::new(exports);
        match &entry.implementation {
            Implementation::Native { implementation } => {
                let factory = self.native.0[implementation].clone();
                let configuration = instance.configuration;
                let context = NativeContext {
                    activation: activation.clone(),
                    package: instance.package.clone(),
                    services: NativeServices {
                        selected_method: None,
                        activation: activation.clone(),
                        imports: self.owned[activation.instance()].imports.clone(),
                        exports: self.owned[activation.instance()].exports.clone(),
                        dispatch: self.dispatch.clone(),
                        issuer: self.issuer.clone(),
                        preparation_resources: self.preparation_resources.clone(),
                    },
                    persistence: self
                        .persisted
                        .as_ref()
                        .map(|(source, store)| NativePersistence {
                            source: source.reference().clone(),
                            store: store.clone(),
                        }),
                };
                self.jobs.push(Box::pin(async move {
                    let initialized =
                        AssertUnwindSafe(async move { factory(context, configuration).await })
                            .catch_unwind()
                            .await;
                    match initialized {
                        Ok(native) => {
                            let exports = native.exports.and_then(|actual| {
                                actual
                                    .into_iter()
                                    .map(|(name, actual)| {
                                        Ok((
                                            name,
                                            Published {
                                                value: Service::new(
                                                    actual.contract.clone(),
                                                    actual.value,
                                                )?,
                                                contract: actual.contract,
                                            },
                                        ))
                                    })
                                    .collect()
                            });
                            Done::Initialized {
                                activation,
                                exports,
                                initialization: Initialization::Native(native.owner),
                            }
                        }
                        Err(_) => Done::Initialized {
                            activation,
                            exports: Err("native initializer panicked".into()),
                            initialization: Initialization::CleanupUnconfirmed,
                        },
                    }
                }));
            }
            Implementation::JavaScript { module, realm } => {
                let load = (|| {
                    let vm_index = match realm {
                        Realm::Shared => match self.shared {
                            Some(index)
                                if self.vms.get(&index).is_some_and(|vm| !vm.is_terminated()) =>
                            {
                                index
                            }
                            _ => {
                                let index = self.new_vm()?;
                                self.shared = Some(index);
                                index
                            }
                        },
                        Realm::Dedicated => self.new_vm()?,
                    };
                    self.owned
                        .get_mut(&instance.identity)
                        .expect("initialization resource")
                        .lifecycle
                        .assign_vm(vm_index);
                    let vm = &self.vms[&vm_index];
                    let source = std::str::from_utf8(
                        self.sources[&instance.package]
                            .file(module)
                            .ok_or("Host module bytes missing")?,
                    )
                    .map_err(|e| e.to_string())?;
                    vm.load(module.clone(), source.into())
                        .map_err(|e| e.to_string())
                })();
                match load {
                    Ok(module) => {
                        let close_module = module.clone();
                        let close: Close = Box::pin(async move {
                            close_module.close().await.map_err(|e| e.to_string())
                        });
                        self.jobs.push(Box::pin(async move {
                            let exports =
                                AssertUnwindSafe(module.activate(entry, instance.configuration))
                                    .catch_unwind()
                                    .await
                                    .unwrap_or_else(|_| {
                                        Err("JavaScript initializer panicked".into())
                                    });
                            let exports = exports.and_then(|actual| {
                                actual
                                    .into_iter()
                                    .map(|(name, actual)| {
                                        Ok((
                                            name,
                                            Published {
                                                value: Service::new(
                                                    actual.contract.clone(),
                                                    actual.value,
                                                )?,
                                                contract: actual.contract,
                                            },
                                        ))
                                    })
                                    .collect()
                            });
                            Done::Initialized {
                                activation,
                                exports,
                                initialization: Initialization::JavaScript(close),
                            }
                        }));
                    }
                    Err(error) => {
                        // No module was admitted; VM lifetime remains owned by
                        // this deployment and is acknowledged during shutdown.
                        self.jobs.push(Box::pin(async move {
                            Done::Initialized {
                                activation,
                                exports: Err(error),
                                initialization: Initialization::JavaScript(Box::pin(async {
                                    Ok(())
                                })),
                            }
                        }));
                    }
                }
            }
        }
        Ok(())
    }
    fn new_vm(&mut self) -> Result<usize> {
        let index = self.next_vm;
        let next = index.checked_add(1).ok_or("VM identity exhausted")?;
        let vm = self
            .scripts
            .as_ref()
            .ok_or("Host script backend is unavailable")?
            .create()?;
        self.next_vm = next;
        let observed = vm.clone();
        self.terminals.push(Box::pin(async move {
            (index, observed.failed().await.to_string())
        }));
        self.vms.insert(index, vm);
        Ok(index)
    }
    fn retire_vm(&mut self, vm: usize, reason: String) {
        let affected = self
            .owned
            .iter()
            .filter(|(_, owned)| owned.lifecycle.vm() == Some(vm))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in affected {
            if self.starting
                && self
                    .runtime
                    .status(&self.activations[&id])
                    .is_ok_and(|status| status.phase != Phase::Retiring)
            {
                self.fail_initialization(id, reason.clone());
            } else {
                self.runtime
                    .retire(&self.activations[&id])
                    .expect("VM activation belongs to owner");
            }
        }
    }
    fn check_vm(&mut self, provider: &Activation) -> Result<()> {
        if let Some(index) = self
            .owned
            .get(provider.instance())
            .and_then(|owned| owned.lifecycle.vm())
            && self.vms.get(&index).is_some_and(|vm| vm.is_terminated())
        {
            self.retire_vm(index, "Host JavaScript execution domain terminated".into());
            return Err("Host JavaScript execution domain terminated".into());
        }
        Ok(())
    }
    fn capture_bindings(&self, consumer: &Activation, import: &str) -> Result<Vec<Binding>> {
        self.runtime
            .bind(consumer, import)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|capability| {
                let contract = self
                    .runtime
                    .inspect(&capability)
                    .map_err(|e| e.to_string())?
                    .contract
                    .clone();
                self.capture_binding(capability, contract)
            })
            .collect()
    }
    fn capture_binding(
        &self,
        capability: Capability<Service>,
        contract: Arc<Contract>,
    ) -> Result<Binding> {
        let instance = self
            .runtime
            .instance(capability.provider())
            .map_err(|e| e.to_string())?;
        let owned = self
            .owned
            .get(capability.provider().instance())
            .ok_or("provider has no captured imports")?;
        // Use the actual activation's retained plan and captured imports,
        // never the desired plan or a newly resolved dependency. Child
        // digests carry the dependency closure without retaining values.
        let imports: BTreeMap<_, Vec<_>> = owned
            .imports
            .iter()
            .map(|(name, bindings)| {
                (
                    name,
                    bindings.iter().map(Binding::execution_basis).collect(),
                )
            })
            .collect();
        // Own exports follow the caller's logical owner across activations;
        // capability epochs still fence admission to the original activation.
        let native = if capability.consumer() == capability.provider() {
            None
        } else {
            owned
                .lifecycle
                .native_owner()
                .map(|owner| {
                    std::panic::catch_unwind(AssertUnwindSafe(|| owner.execution_basis()))
                        .map(|basis| match basis {
                            Some(facts) => serde_json::json!({"facts": facts}),
                            None => {
                                serde_json::json!({"activation": capability.provider().epoch()})
                            }
                        })
                        .map_err(|_| "native execution basis panicked")
                })
                .transpose()?
        };
        let mut basis = serde_json::json!({
            "identity": instance.identity, "parent": instance.parent,
            "package": instance.package, "disabled": instance.disabled,
            "configuration": instance.configuration, "entry": instance.entry,
            "bindings": instance.bindings, "exports": instance.exports,
            "imports": imports, "export": capability.export(), "contract": contract.as_ref(),
            "native": native,
        });
        basis.sort_all_objects();
        let digest = maka_agent_facts::artifact::content_digest(
            &serde_json::to_vec(&basis).map_err(|e| e.to_string())?,
        );
        Ok(Binding(
            capability,
            contract,
            digest.into(),
            Arc::new(instance.package.clone()),
            Arc::new(AtomicBool::new(false)),
        ))
    }
    fn capture_ui(
        &self,
        source: &DeploymentRef,
        consumer: &InstanceId,
    ) -> Result<BTreeMap<String, Vec<Binding>>> {
        if self.closing {
            return Err("Host deployment is closing".into());
        }
        let (current, _) = self
            .persisted
            .as_ref()
            .ok_or("persisted deployment required")?;
        if current.reference() != source {
            return Err("UI deployment source changed before binding".into());
        }
        let instance = self
            .runtime
            .desired()
            .instances()
            .get(consumer)
            .filter(|instance| !instance.disabled)
            .ok_or("UI consumer is not declared and enabled")?;
        let entry = instance.ui_entry().ok_or("UI consumer required")?;
        let activation = self
            .activations
            .get(consumer)
            .filter(|activation| {
                self.runtime
                    .status(activation)
                    .is_ok_and(|status| status.phase == Phase::Active)
            })
            .ok_or("UI consumer is not active")?;
        entry
            .imports
            .keys()
            .map(|name| {
                self.capture_bindings(activation, name)
                    .map(|bindings| (name.clone(), bindings))
            })
            .collect()
    }
    fn capture_import(&self, consumer: &InstanceId, import: &str) -> Result<CapturedImport> {
        if self.closing {
            return Err("Host deployment is closing".into());
        }
        let instance = self
            .runtime
            .desired()
            .instances()
            .get(consumer)
            .filter(|instance| !instance.disabled)
            .ok_or("Host consumer is not declared and enabled")?;
        if !instance
            .entry
            .as_ref()
            .is_some_and(|entry| entry.imports().contains_key(import))
        {
            return Err("Host consumer import is not declared".into());
        }
        let [declared] = instance
            .bindings
            .get(import)
            .map(Vec::as_slice)
            .unwrap_or(&[])
        else {
            return Err("Host import requires one explicitly selected provider".into());
        };
        let Provider::Local {
            instance: provider,
            export,
        } = &declared.provider
        else {
            return Err("Host import requires a local provider".into());
        };
        if let Some(activation) = self.activations.get(consumer)
            && self
                .runtime
                .status(activation)
                .is_ok_and(|status| status.phase == Phase::Active)
        {
            let mut bindings = self.capture_bindings(activation, import)?;
            if let Some(binding) = bindings.pop() {
                if !bindings.is_empty()
                    || binding.provider().instance() != provider
                    || binding.export() != export
                    || binding.contract() != &declared.declaration.contract
                {
                    return Err("Host registration differs from its declared import".into());
                }
                return Ok(CapturedImport::Ready(binding));
            }
        }
        Ok(CapturedImport::Unavailable {
            provider: provider.clone(),
            export: export.clone(),
            contract: declared.declaration.contract.clone(),
        })
    }
    fn command(&mut self, command: Command) {
        match command {
            Command::ShutdownIdle { reply } => {
                let _ = reply.send(self.shutdown_if_idle());
            }
            Command::CaptureImport {
                consumer,
                import,
                reply,
            } => {
                let _ = reply.send(self.capture_import(&consumer, &import));
            }
            Command::CaptureUi {
                source,
                consumer,
                reply,
            } => {
                let _ = reply.send(self.capture_ui(&source, &consumer));
            }
            Command::Bind {
                consumer,
                import,
                reply,
            } => {
                let result = if self.closing {
                    Err("Host deployment is closing".into())
                } else {
                    self.capture_bindings(&consumer, &import)
                };
                let _ = reply.send(result);
            }
            Command::Call(call) => {
                let Call {
                    mut parent,
                    binding,
                    mut kind,
                    method,
                    input,
                    scope,
                    attachments,
                    capture,
                    admitted,
                    bytes,
                    resources,
                } = *call;
                let operation = kind.operation();
                if kind.closed() && parent.is_none() {
                    return;
                }
                let admission = (|| {
                    if self.closing
                        || !self.issuer.owns(&scope)
                        || scope.cancellation.is_cancelled()
                    {
                        return Err("foreign or closed Host invocation".into());
                    }
                    self.check_native_origin(&scope)?;
                    self.check_vm(binding.0.consumer())
                        .inspect_err(|_| binding.mark_retired())?;
                    self.check_vm(binding.provider())
                        .inspect_err(|_| binding.mark_retired())?;
                    let service = self.runtime.inspect(&binding.0).map_err(|error| {
                        binding.observe_lifetime(&error);
                        error.to_string()
                    })?;
                    service
                        .methods
                        .get(&method)
                        .ok_or_else(|| "undeclared service method".to_string())?
                        .input
                        .validate(&input)
                        .map_err(|e| e.to_string())?;
                    let Interface::Service { methods } = &service.contract.interface else {
                        unreachable!()
                    };
                    let declared_method = &methods[&method];
                    if operation.is_some_and(|id| id.is_nil())
                        || match declared_method.mode {
                            MethodMode::Query => {
                                operation.is_some() || matches!(kind, CallKind::Subscription { .. })
                            }
                            MethodMode::Mutation => operation.is_none(),
                            MethodMode::Subscription => {
                                !matches!(kind, CallKind::Subscription { .. })
                            }
                        }
                    {
                        return Err("service method mode or operation identity mismatch".into());
                    }
                    let request = operation
                        .map(|operation| {
                            let source = self
                                .origins
                                .get(binding.0.consumer().instance())
                                .ok_or("durable mutation requires original deployment source")?;
                            service.methods[&method]
                                .operation
                                .as_ref()
                                .expect("mutation template")
                                .prepare(OperationRequest {
                                    source: source.reference().clone(),
                                    namespace: binding.provider().instance().clone(),
                                    consumer: binding.0.consumer().instance().clone(),
                                    export: binding.0.export().into(),
                                    method: method.clone(),
                                    contract: (),
                                    operation,
                                    input: input.clone(),
                                    capture,
                                    origin: serde_json::to_value(&scope.identity)
                                        .map_err(|error| error.to_string())?,
                                })
                                .map_err(|e| e.to_string())
                        })
                        .transpose()?;
                    let reference = request.as_ref().map(|request| request.reference().clone());
                    if let Some(reference) = &reference {
                        check_reference(reference)?;
                        if kind
                            .expected()
                            .is_some_and(|expected| expected != reference)
                        {
                            return Err("prepared original reference no longer matches".into());
                        }
                    }
                    let authenticated_caller =
                        match std::panic::catch_unwind(AssertUnwindSafe(|| {
                            let Interface::Service { methods } = &service.contract.interface else {
                                unreachable!()
                            };
                            let definition = &methods[&method];
                            let declared = &definition.resources;
                            if attachments.keys().any(|slot| !declared.contains_key(slot))
                                || declared.iter().any(|(slot, resource_type)| {
                                    match attachments.get(slot) {
                                        Some(resource) => {
                                            resource.resource_type() != resource_type.resource_type
                                        }
                                        None => !resource_type.optional,
                                    }
                                })
                            {
                                return Err("Host attachment slots or types mismatch".into());
                            }
                            let size = resource_ingress::attachment_size(&attachments)?;
                            let input_size = kind.input_size(&input)?.max(1);
                            let bytes_needed = size
                                .descriptors
                                .checked_add(input_size)
                                .ok_or("Host input budget exhausted")?;
                            let payload_charge = usize::try_from(resource_ingress::charge(
                                size.payload,
                                resource_ingress::RESOURCE_WINDOW,
                            ))
                            .map_err(|_| "invalid payload charge")?;
                            let input_charge = usize::try_from(resource_ingress::charge(
                                bytes_needed,
                                resource_ingress::INPUT_WINDOW,
                            ))
                            .map_err(|_| "invalid input charge")?;
                            if size.payload != admitted.payload
                                || size.descriptors > admitted.descriptors
                                || payload_charge != resources.num_permits()
                                || input_charge > bytes.num_permits()
                            {
                                return Err(
                                    "Host attachment descriptor changed before admission".into()
                                );
                            }
                            let invocation = Invocation {
                                scope: &scope,
                                native_origin: self.native_origin(&scope),
                                selected_native_method: self
                                    .issuer
                                    .evidence::<native_context::NativeOrigin>(&scope)
                                    .filter(|origin| origin.is_direct(&scope))
                                    .and_then(|origin| origin.selected_method.as_deref())
                                    .filter(|selected| selected.matches(&binding, &method)),
                                consumer: binding.0.consumer(),
                                provider: binding.provider(),
                                export: binding.export(),
                                contract: &service.contract,
                                method: &method,
                                input: &input,
                                attachments: &attachments,
                            };
                            self.policy.admit(invocation)?;
                            if let Some(intent) = kind.peer_intent() {
                                self.policy.confirm_peer_mutation(invocation, intent)?;
                            }
                            Ok::<_, String>(self.policy.caller(&scope))
                        })) {
                            Ok(result) => result?,
                            Err(_) => {
                                let error =
                                    "Host admission policy or attachment descriptor panicked"
                                        .to_string();
                                return Err(error);
                            }
                        };
                    if scope.cancellation.is_cancelled() {
                        return Err("Host invocation was revoked".into());
                    }
                    if matches!(
                        kind,
                        CallKind::PrepareMutation { .. } | CallKind::PendingMutation { .. }
                    ) {
                        return Ok((None, None, request, reference, authenticated_caller, None));
                    }
                    let progress = service.methods[&method].progress.clone();
                    let child = scope.child().map_err(|e| e.to_string())?;
                    let execution = self.runtime.admit(&binding.0).map_err(|error| {
                        binding.observe_lifetime(&error);
                        error.to_string()
                    })?;
                    Ok((
                        Some(execution),
                        Some(child),
                        request,
                        reference,
                        authenticated_caller,
                        progress,
                    ))
                })();
                match admission {
                    Err(error) => {
                        drop(kind.take_confirmation());
                        drop((attachments, resources, bytes, input, scope));
                        if let Some(ticket) = parent.take() {
                            ticket.complete(Ok(()));
                        }
                        kind.reject(error);
                    }
                    Ok((execution, child, request, reference, authenticated_caller, progress)) => {
                        if let CallKind::PrepareMutation { reply, .. } = kind {
                            let _ = reply.send(Ok(PreparedMutation {
                                reference: reference.expect("mutation reference"),
                                invocation: Some(PreparedInvocation {
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
                                }),
                            }));
                            return;
                        }
                        if let CallKind::PendingMutation {
                            operation,
                            recovery,
                            reply,
                        } = kind
                        {
                            let kind = CallKind::Mutation {
                                operation,
                                confirmation: None,
                                reply,
                            };
                            let request = request.expect("checked original mutation");
                            let resource = match self.runtime.own_resource(
                                binding.0.consumer(),
                                "original caller intent persistence",
                            ) {
                                Ok(resource) => resource,
                                Err(error) => {
                                    drop((
                                        attachments,
                                        resources,
                                        bytes,
                                        input,
                                        scope,
                                        capture,
                                        recovery,
                                        request,
                                        binding,
                                    ));
                                    if let Some(ticket) = parent.take() {
                                        ticket.complete(Ok(()));
                                    }
                                    kind.reject(error.to_string());
                                    return;
                                }
                            };
                            // Capture the original activation's checked source before any
                            // adoption can replace the desired deployment snapshot.
                            let source = self.origins[request.consumer()].clone();
                            let store = self
                                .persisted
                                .as_ref()
                                .expect("persisted mutation")
                                .1
                                .clone();
                            if let Some(ticket) = &mut parent {
                                ticket.start();
                            }
                            let call = Box::new(Call {
                                parent,
                                binding,
                                kind,
                                method,
                                input,
                                scope,
                                attachments,
                                capture,
                                admitted,
                                bytes,
                                resources,
                            });
                            // Persistence owns no child Execution. Return the exact captured
                            // call to this owner for final admission after the SQL task ends.
                            self.jobs.push(Box::pin(async move {
                                let recorded = store
                                    .record_application_intent_from(
                                        &source,
                                        request.consumer().clone(),
                                        reference.expect("checked original reference"),
                                        recovery,
                                    )
                                    .await
                                    .map(Box::new)
                                    .map_err(|e| format!("caller intent was not confirmed: {e}"));
                                Done::IntentRecorded {
                                    call,
                                    recorded,
                                    resource,
                                }
                            }));
                            return;
                        }
                        let execution = execution.expect("accepted execution");
                        let child = child.expect("accepted child scope");
                        let is_subscription = matches!(kind, CallKind::Subscription { .. });
                        let confirmation = kind.take_confirmation();
                        if is_subscription {
                            self.observations.insert(
                                execution.id(),
                                Observation {
                                    provider: execution.provider().clone(),
                                    consumer: binding.0.consumer().clone(),
                                    cancellation: child.cancellation.clone(),
                                },
                            );
                        }
                        let caller = scope;
                        let scope = child;
                        let consumer = binding.0.consumer().clone();
                        let store = self.persisted.as_ref().map(|(_, store)| store.clone());
                        if let Some(ticket) = &mut parent {
                            ticket.start();
                        }
                        let (mut output, stream) = kind.accept(
                            execution.id(),
                            reference.clone(),
                            execution.value().methods[&method].output.clone(),
                            progress,
                            scope.cancellation.clone(),
                        );
                        let mut context = Context {
                            stream: stream.clone(),
                            caller: authenticated_caller,
                            native_context: self
                                .issuer
                                .evidence::<native_context::NativeOrigin>(&scope)
                                .filter(|origin| {
                                    origin.activation == consumer && origin.is_direct(&caller)
                                })
                                .filter(|origin| {
                                    origin
                                        .selected_method
                                        .as_deref()
                                        .is_none_or(|selected| selected.matches(&binding, &method))
                                })
                                .and_then(|origin| origin.caller_context.clone()),
                            scope: scope.clone(),
                            consumer: execution.provider().clone(),
                            requester: consumer.clone(),
                            operation: reference.clone(),
                            operation_scope: None,
                            state: store
                                .as_ref()
                                .ok_or_else(|| {
                                    "provider state requires original Root persistence".to_string()
                                })
                                .and_then(|store| {
                                    let provider = execution.provider();
                                    let instance = self
                                        .runtime
                                        .instance(provider)
                                        .map_err(|error| error.to_string())?;
                                    let source = self.origins[provider.instance()].reference();
                                    let namespace = maka_plugin_core::storage::Namespace::new(
                                        instance.package.id.clone(),
                                        maka_plugin_core::scope::Scope::Profile,
                                    )
                                    .map_err(|error| error.to_string())?;
                                    Ok(crate::storage::Storage::new(
                                        store.clone(),
                                        crate::storage::instance_prefix(
                                            &source.state_domain,
                                            source.deployment,
                                            provider.instance(),
                                        ),
                                        namespace,
                                    ))
                                }),
                            attachments: attachments.clone(),
                            imports: self.owned[execution.provider().instance()].imports.clone(),
                            exports: self.owned[execution.provider().instance()].exports.clone(),
                            dispatch: self.dispatch.clone(),
                        };
                        let is_mutation = operation.is_some();
                        self.jobs.push(Box::pin(async move {
                            let mut historical = None;
                            let mut claim = None;
                            let mut operation_store = None;
                            let mut receipt = None;
                            let dispatched = if let Some(request) = request {
                                let store = store.as_ref().expect("persisted mutation");
                                let dispatched = async {
                                    let selected = store.operation(request.reference())?;
                                    let result = selected.dispatch_prepared_operation(request).await;
                                    operation_store = Some(selected);
                                    result
                                }.await;
                                match dispatched.map_err(|error| operation_failure(
                                    "operation_dispatch", &error,
                                    reference.as_ref().expect("original operation reference"), execution.id(),
                                )) {
                                    Ok(OperationDispatch::New(new)) => {
                                        claim = Some(new);
                                        Ok(())
                                    }
                                    Ok(OperationDispatch::Existing(observation)) => {
                                        historical = Some(Box::new(observation));
                                        Ok(())
                                    }
                                    Err(error) => {
                                        receipt = Some(Err(error.clone()));
                                        Err(error)
                                    }
                                }
                            } else { Ok(()) };
                            let entry = dispatched.and_then(|()| {
                                if historical.is_some() { return Ok(()); }
                                if scope.cancellation.is_cancelled() {
                                    return Err("Host invocation was revoked before callback".into());
                                }
                                if let Some(claim) = &claim {
                                    operation_store.as_ref().expect("original operation store")
                                        .start_operation(claim)
                                        .map_err(|error| operation_failure(
                                            "operation_start", &error, claim.reference(), execution.id(),
                                        ))?;
                                    context.operation_scope = Some(claim.auxiliary_scope());
                                }
                                Ok(())
                            });
                            // No suspension separates the original start fence and handler
                            // entry. An old auxiliary scope cannot acquire work before start.
                            let mut state = None;
                            let mut handler = match entry {
                                Err(error) => HandlerOutcome::NotInvoked(error),
                                Ok(()) if historical.is_some() => HandlerOutcome::Returned(Ok(Value::Null)),
                                Ok(()) => {
                                    let invocation = async {
                                        let service = execution.value();
                                        let value = service.implementation.call(method.clone(), input, context).await?;
                                        if let Some(output) = value.value()
                                            && (!is_subscription || !output.is_null()) {
                                                service.methods[&method].output.validate(output)
                                                    .map_err(|error| HandlerError::Returned { diagnostic: error.to_string() })?;
                                            }
                                        Ok(value)
                                    };
                                    match AssertUnwindSafe(invocation).catch_unwind().await {
                                        Ok(Ok(HandlerValue::Json(value))) => HandlerOutcome::Returned(Ok(value)),
                                        Ok(Ok(HandlerValue::Commit { value, state: change })) if is_mutation && claim.is_some() => {
                                            state = Some(change);
                                            HandlerOutcome::Returned(Ok(value))
                                        }
                                        Ok(Ok(HandlerValue::Computed { state: change })) if is_mutation && claim.is_some() => {
                                            state = Some(change);
                                            HandlerOutcome::Computed
                                        }
                                        Ok(Ok(HandlerValue::Commit { .. } | HandlerValue::Computed { .. })) => HandlerOutcome::Returned(Err(
                                            "pure state completion requires a durable mutation".into(),
                                        )),
                                        Ok(Err(HandlerError::Returned { diagnostic })) => HandlerOutcome::Returned(Err(diagnostic)),
                                        Ok(Err(HandlerError::Unknown { diagnostic })) => HandlerOutcome::Unknown(diagnostic),
                                        Err(_) => HandlerOutcome::Unknown("Host service executor panicked".into()),
                                    }
                                }
                            };
                            if let Some(stream) = stream { stream.close(); }
                            if let Some(claim) = &claim {
                                let store = operation_store.as_ref().expect("original operation store");
                                let state_commit = if let Some(state) = state {
                                    Some(match &handler {
                                        HandlerOutcome::Returned(Ok(value)) => state.commit(claim, value.clone()).await,
                                        HandlerOutcome::Computed => state.commit_result(claim, execution.value().methods[&method].output.clone()).await,
                                        _ => unreachable!("only an original successful or computed completion carries state"),
                                    })
                                } else { None };
                                if let Some(Ok(observation)) = &state_commit
                                    && matches!(handler, HandlerOutcome::Computed) {
                                        handler = match &observation.outcome {
                                            OperationOutcome::Returned { result: OperationResult::Success { value } } => HandlerOutcome::Returned(Ok(value.clone())),
                                            OperationOutcome::Returned { result: OperationResult::Failure { diagnostic } } => HandlerOutcome::Returned(Err(diagnostic.clone())),
                                            _ => HandlerOutcome::Unknown("computed completion has no original Returned outcome".into()),
                                        };
                                    }
                                if let Some(Err(error)) = &state_commit {
                                    let diagnostic = operation_failure("operation_state_commit", error, claim.reference(), execution.id());
                                    handler = if super::completion::state_rejected(error) {
                                        let diagnostic = match error.underlying() {
                                            maka_event_log::StoreError::StatementRejected { diagnostic, .. } => diagnostic.clone(),
                                            _ => diagnostic,
                                        };
                                        HandlerOutcome::Returned(Err(diagnostic))
                                    } else {
                                        HandlerOutcome::Unknown(diagnostic)
                                    };
                                }
                                let recorded = match state_commit {
                                    Some(Ok(observation)) => Ok(observation),
                                    Some(Err(error)) if super::completion::state_conflict(&error) => Err(error),
                                    _ => match &handler {
                                        HandlerOutcome::Computed => unreachable!("computed completion must settle on its original claim"),
                                        HandlerOutcome::NotInvoked(_) => store.prevent_operation_before_start(claim).await,
                                        HandlerOutcome::Returned(result) => {
                                            let result = match result {
                                                Ok(value) => OperationResult::Success { value: value.clone() },
                                                Err(error) => OperationResult::Failure { diagnostic: diagnostic(error) },
                                            };
                                            store.record_operation_outcome(claim, OperationOutcome::Returned { result }).await
                                        }
                                        HandlerOutcome::Unknown(error) => store.record_operation_outcome(claim, OperationOutcome::Unknown {
                                            diagnostic: diagnostic(error),
                                        }).await,
                                    },
                                };
                                receipt = Some(recorded.map_err(|error| operation_failure(
                                    "operation_outcome", &error, claim.reference(), execution.id(),
                                )));
                            }
                            if is_mutation && historical.is_none() {
                                let receipt = receipt.get_or_insert_with(|| Err("operation receipt unavailable; read original reference".into()));
                                output.publish_receipt(receipt);
                            }
                            // SQL failures affect receipt knowledge, never whether we drain
                            // the actual executor or independently attempt its cleanup write.
                            let cleanup = AssertUnwindSafe(scope.finish()).catch_unwind().await
                                .map_err(|_| "Host service cleanup panicked".to_string())
                                .and_then(|result| result.map_err(|e| e.to_string()));
                            let (result, cleanup) = match handler {
                                HandlerOutcome::Computed => (Err("computed completion has no original receipt".into()), cleanup),
                                HandlerOutcome::NotInvoked(error) => (Err(error), cleanup),
                                HandlerOutcome::Returned(result) => (result, cleanup),
                                HandlerOutcome::Unknown(error) => (Err(error), cleanup),
                            };
                            if let Some(claim) = &claim {
                                let settled_cleanup = match &cleanup {
                                    Ok(()) => OperationCleanup::Confirmed,
                                    Err(error) => OperationCleanup::Failed { diagnostic: diagnostic(error) },
                                };
                                let recorded = operation_store.as_ref().expect("original operation store")
                                    .record_operation_cleanup(claim, settled_cleanup).await
                                    .map_err(|error| operation_failure(
                                        "operation_cleanup", &error, claim.reference(), execution.id(),
                                    ));
                                // Do not hide an earlier failed/uncertain outcome write with a
                                // successful cleanup write. Both errors remain observable.
                                receipt = Some(match (receipt.take().expect("original outcome attempt"), recorded) {
                                    (Ok(_), recorded) => recorded,
                                    (Err(error), Ok(_)) => Err(error),
                                    (Err(outcome), Err(cleanup)) => Err(format!("{outcome}; {cleanup}")),
                                });
                            }
                            Done::Called { parent, execution, result, historical, consumer, caller: Box::new(caller),
                                scope: Box::new(scope), cleanup, receipt: receipt.map(Box::new), reply: output, _bytes: bytes, attachments, _resources: resources, confirmation }
                        }));
                    }
                }
            }
            Command::LookupIntent {
                consumer,
                operation,
                scope,
                mut parent,
                reply,
                _bytes,
            } => {
                let admission = self
                    .intent_lookup_gate(&consumer, operation, &scope)
                    .and_then(|source| {
                        let store = self
                            .persisted
                            .as_ref()
                            .ok_or("caller intent lookup requires an owned State Root")?
                            .1
                            .clone();
                        let resource = self
                            .runtime
                            .own_resource(&consumer, "original caller intent lookup")
                            .map_err(|e| e.to_string())?;
                        Ok((source.deployment, store, resource))
                    });
                match admission {
                    Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                    Ok((deployment, store, resource)) => {
                        parent.start();
                        self.jobs.push(Box::pin(async move {
                            let result = store
                                .application_intent(
                                    deployment,
                                    consumer.instance().clone(),
                                    operation,
                                )
                                .await
                                .map_err(|e| e.to_string());
                            Done::IntentLookedUp {
                                consumer,
                                operation,
                                caller: Box::new(scope),
                                resource,
                                parent,
                                result: Box::new(result),
                                reply,
                                _bytes,
                            }
                        }));
                    }
                }
            }
            Command::Recover {
                consumer,
                reference,
                scope,
                mut parent,
                reply,
                _bytes,
            } => {
                let admission = self
                    .recovery_gate(&consumer, &reference, &scope)
                    .and_then(|()| {
                        let store = self
                            .persisted
                            .as_ref()
                            .ok_or("operation recovery requires an owned State Root")?
                            .1
                            .clone();
                        let resource = self
                            .runtime
                            .own_resource(&consumer, "original operation receipt lookup")
                            .map_err(|e| e.to_string())?;
                        Ok((store, resource))
                    });
                match admission {
                    Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                    Ok((store, resource)) => {
                        if let Some(ticket) = &mut parent {
                            ticket.start();
                        }
                        self.jobs.push(Box::pin(async move {
                            let result = async {
                                store.operation(&reference)?.operation_observation().await
                            }
                            .await
                            .map_err(|e| e.to_string());
                            Done::Recovered {
                                consumer,
                                reference,
                                caller: Box::new(scope),
                                resource,
                                parent,
                                result: Box::new(result),
                                reply,
                                _bytes,
                            }
                        }));
                    }
                }
            }
        }
    }
    fn native_origin<'a>(&self, scope: &'a Scope) -> Option<&'a Activation> {
        self.issuer
            .evidence::<native_context::NativeOrigin>(scope)
            .map(|origin| &origin.activation)
    }
    fn check_native_origin(&mut self, scope: &Scope) -> Result<()> {
        if let Some(origin) = self.issuer.evidence::<native_context::NativeOrigin>(scope) {
            let origin = &origin.activation;
            self.check_vm(origin)?;
            if self
                .runtime
                .status(origin)
                .map_err(|error| error.to_string())?
                .phase
                != Phase::Active
            {
                return Err("native work origin is not active".into());
            }
        }
        Ok(())
    }
    fn intent_lookup_gate(
        &mut self,
        consumer: &Activation,
        operation: Uuid,
        scope: &Scope,
    ) -> Result<DeploymentRef> {
        if self.closing || !self.issuer.owns(scope) || scope.cancellation.is_cancelled() {
            return Err("foreign or closed Host caller intent lookup".into());
        }
        self.check_native_origin(scope)?;
        self.check_vm(consumer)?;
        if self
            .runtime
            .status(consumer)
            .map_err(|e| e.to_string())?
            .phase
            != Phase::Active
        {
            return Err("Host caller intent consumer is not active".into());
        }
        let source = self
            .origins
            .get(consumer.instance())
            .ok_or("caller intent lookup requires the original consumer source")?
            .reference()
            .clone();
        std::panic::catch_unwind(AssertUnwindSafe(|| {
            self.policy.lookup_intent(IntentLookupInvocation {
                scope,
                native_origin: self.native_origin(scope),
                selected_native_method: self
                    .issuer
                    .evidence::<native_context::NativeOrigin>(scope)
                    .filter(|origin| origin.is_direct(scope))
                    .and_then(|origin| origin.selected_method.as_deref())
                    .filter(|selected| selected.binding.consumer() == consumer),
                consumer,
                source: &source,
                operation,
            })
        }))
        .map_err(|_| "Host caller intent lookup policy panicked".to_string())??;
        if scope.cancellation.is_cancelled() {
            return Err("Host caller intent lookup was revoked".into());
        }
        Ok(source)
    }
    fn recovery_gate(
        &mut self,
        consumer: &Activation,
        reference: &RecoveryRef,
        scope: &Scope,
    ) -> Result<()> {
        if self.closing || !self.issuer.owns(scope) || scope.cancellation.is_cancelled() {
            return Err("foreign or closed Host recovery invocation".into());
        }
        self.check_native_origin(scope)?;
        self.check_vm(consumer)?;
        if self
            .runtime
            .status(consumer)
            .map_err(|e| e.to_string())?
            .phase
            != Phase::Active
        {
            return Err("Host recovery consumer is not active".into());
        }
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            self.policy.recover(RecoveryInvocation {
                scope,
                native_origin: self.native_origin(scope),
                selected_native_method: self
                    .issuer
                    .evidence::<native_context::NativeOrigin>(scope)
                    .filter(|origin| origin.is_direct(scope))
                    .and_then(|origin| origin.selected_method.as_deref())
                    .filter(|selected| selected.recovers(consumer, reference)),
                consumer,
                reference,
            })
        }));
        result.map_err(|_| "Host recovery policy panicked".to_string())??;
        if scope.cancellation.is_cancelled() {
            return Err("Host recovery invocation was revoked".into());
        }
        Ok(())
    }
    fn complete(&mut self, done: Done) {
        match done {
            Done::Loaded { loaded, reply } => {
                let source = self.loading_adoption.take();
                let result = match loaded {
                    Ok(loaded) => {
                        let result = self.adopt(*loaded);
                        if result.is_err() && !self.closing {
                            tracing::warn!(target: "maka_host_runtime::application", stage = "source_adoption", cause = "adoption_failed",
                                state_domain = source.as_ref().map(|source| source.state_domain.as_str()),
                                deployment_id = source.as_ref().map(|source| tracing::field::display(source.deployment)), source_revision = source.as_ref().map(|source| source.revision),
                                "Host runtime failure");
                        }
                        result
                    }
                    Err(error) => Err(error),
                };
                if let Err(error) = &result {
                    self.startup_error = Some(error.clone());
                }
                self.publish();
                if let Some(reply) = reply {
                    let _ = reply.send(result);
                }
            }
            Done::IntentRecorded {
                mut call,
                recorded,
                resource,
            } => {
                match recorded {
                    Ok(intent) => {
                        let CallKind::Mutation { confirmation, .. } = &mut call.kind else {
                            unreachable!("recording belongs to a mutation")
                        };
                        *confirmation = Some(Confirmation::Recorded(intent));
                        self.command(Command::Call(call));
                    }
                    Err(error) => {
                        let parent = call.parent.take();
                        let Call {
                            kind,
                            attachments,
                            resources,
                            bytes,
                            input,
                            scope,
                            ..
                        } = *call;
                        drop((attachments, resources, bytes, input, scope));
                        if let Some(ticket) = parent {
                            ticket.complete(Ok(()));
                        }
                        kind.reject(error);
                    }
                }
                self.runtime
                    .complete_resource(&resource, Ok(()))
                    .expect("owned caller intent persistence");
            }
            Done::Initialized {
                activation,
                exports,
                initialization,
            } => {
                let was_retiring = self
                    .runtime
                    .status(&activation)
                    .is_ok_and(|s| s.phase == Phase::Retiring);
                let cleanup_unconfirmed =
                    matches!(initialization, Initialization::CleanupUnconfirmed);
                if cleanup_unconfirmed {
                    self.activation_diagnostic_span(&activation).in_scope(|| {
                        tracing::error!(target: "maka_host_runtime::application", stage = "initialization_cleanup", cause = "cleanup_unconfirmed", "Host runtime failure");
                    });
                }
                let owned = self
                    .owned
                    .get_mut(activation.instance())
                    .expect("initializer has a resource fence");
                owned.lifecycle.initialized(initialization);
                if cleanup_unconfirmed {
                    let reason = "native initialization cleanup is unconfirmed".to_string();
                    self.runtime
                        .complete_resource(&owned.resource, Err(reason.clone()))
                        .expect("owned resource");
                    self.cleanup_error.get_or_insert(reason);
                }
                let result = exports.and_then(|batch| {
                    self.runtime
                        .publish(&activation, batch)
                        .map_err(|e| e.error.to_string())?;
                    if let Some(owner) = owned.lifecycle.native_owner() {
                        std::panic::catch_unwind(AssertUnwindSafe(|| owner.activated()))
                            .map_err(|_| "native activation hook panicked".to_string())?;
                    }
                    Ok(())
                });
                if let Err(error) = result {
                    if self.closing || was_retiring {
                        // A late successful initializer must still close under
                        // its original resource; retirement is not startup failure.
                    } else {
                        self.fail_initialization(activation.instance().clone(), error);
                    }
                }
            }
            Done::Called {
                parent,
                execution,
                result,
                historical,
                consumer,
                caller,
                scope,
                cleanup,
                mut receipt,
                reply,
                _bytes,
                attachments,
                _resources,
                confirmation,
            } => {
                self.observations.remove(&execution.id());
                if let Some(observation) = historical {
                    receipt = Some(Box::new(
                        self.recovery_gate(&consumer, &observation.reference, &caller)
                            .map(|()| *observation),
                    ));
                }
                let _ = self.check_vm(execution.provider());
                let failed = cleanup.is_err();
                if failed {
                    self.activation_diagnostic_span(execution.provider()).in_scope(|| {
                        tracing::error!(target: "maka_host_runtime::application", stage = "execution_cleanup", cause = "cleanup_unconfirmed",
                            execution_id = %execution.id(), consumer_instance_id = ?consumer.instance(), "Host runtime failure");
                    });
                }
                let cleanup_error = cleanup.as_ref().err().cloned();
                self.runtime
                    .settle(&execution, cleanup.clone())
                    .expect("accepted execution belongs to owner");
                if failed {
                    self.cleanup_error
                        .get_or_insert_with(|| cleanup_error.unwrap());
                    self.failed.push(Failed {
                        _execution: execution,
                        _scope: *scope,
                        _bytes,
                        _attachments: attachments,
                        _resources,
                        _confirmation: confirmation,
                    });
                } else {
                    // Confirmed physical cleanup releases caller custody before waking
                    // an observer that may immediately reopen the caller Root.
                    drop((confirmation, attachments, _resources, _bytes, scope));
                }
                if let Some(ticket) = parent {
                    // Failed execution custody is retained by this Host above.
                    // The caller's observation has ended; child cleanup remains
                    // unconfirmed in its own receipt and retained scope.
                    ticket.complete(Ok(()));
                }
                reply.send(result, cleanup, receipt.map(|receipt| *receipt));
            }
            Done::IntentLookedUp {
                consumer,
                operation,
                caller,
                resource,
                parent,
                result,
                reply,
                _bytes,
            } => {
                let result = self
                    .intent_lookup_gate(&consumer, operation, &caller)
                    .and_then(|_| {
                        let intent = (*result)?;
                        if let Some(intent) = &intent {
                            // Only original receipt policy may authorize disclosure of this
                            // target and method; no current binding reconstructs the reference.
                            self.recovery_gate(&consumer, &intent.reference, &caller)?;
                        }
                        Ok(intent)
                    });
                self.runtime
                    .complete_resource(&resource, Ok(()))
                    .expect("owned caller intent lookup");
                parent.complete(Ok(()));
                let _ = reply.send(result);
            }
            Done::Recovered {
                consumer,
                reference,
                caller,
                resource,
                parent,
                result,
                reply,
                _bytes,
            } => {
                let result = self
                    .recovery_gate(&consumer, &reference, &caller)
                    .and(*result);
                self.runtime
                    .complete_resource(&resource, Ok(()))
                    .expect("owned receipt lookup");
                if let Some(ticket) = parent {
                    ticket.complete(Ok(()));
                }
                let _ = reply.send(result);
            }
            Done::Closed { activation, result } => {
                // The last module owns actual domain shutdown under its original
                // resource fence. An empty isolate is not settled code ownership.
                if result.is_ok()
                    && let Some(index) = self.owned[activation.instance()].lifecycle.vm()
                    && self
                        .owned
                        .values()
                        .filter(|owned| owned.lifecycle.vm() == Some(index))
                        .count()
                        == 1
                    && let Some(vm) = self.vms.remove(&index)
                {
                    self.owned
                        .get_mut(activation.instance())
                        .expect("owned module")
                        .lifecycle
                        .release_vm();
                    if self.shared == Some(index) {
                        self.shared = None;
                    }
                    self.jobs.push(Box::pin(async move {
                        vm.shutdown().await;
                        Done::Closed { activation, result }
                    }));
                    return;
                }
                let success = result.is_ok();
                if let Err(error) = &result {
                    self.activation_diagnostic_span(&activation).in_scope(|| {
                        tracing::error!(target: "maka_host_runtime::application", stage = "activation_cleanup", cause = "cleanup_unconfirmed", "Host runtime failure");
                    });
                    self.cleanup_error.get_or_insert(error.clone());
                }
                let owned = self
                    .owned
                    .get_mut(activation.instance())
                    .expect("closing activation has an owner");
                if !success {
                    owned.lifecycle.cleanup_unconfirmed();
                }
                self.runtime
                    .complete_resource(&owned.resource, result)
                    .expect("owned resource");
                if success {
                    self.owned.remove(activation.instance());
                }
            }
            Done::VmsClosed => {
                self.shutdown_complete = true;
            }
        }
    }
    fn is_closed(&self) -> bool {
        self.shutdown_complete && self.cleanup_error.is_none()
    }
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            loading: self.loading_adoption.clone(),
            desired: self
                .persisted
                .as_ref()
                .map(|(source, _)| source.reference().clone()),
            effective: self.effective.clone(),
            starting: self.starting,
            startup_error: self.startup_error.clone(),
            initialization_failures: self.initialization_failures.clone(),
            closing: self.closing,
            closed: self.is_closed(),
            shutdown_complete: self.shutdown_complete,
            cleanup_error: self.cleanup_error.clone(),
            instances: self
                .activations
                .values()
                .map(|a| self.runtime.status(a).expect("live activation"))
                .collect(),
        }
    }
    fn publish(&self) {
        self.updates.send_replace(self.snapshot());
    }
}

fn operation_failure(
    stage: &'static str,
    error: &maka_event_log::StoreError,
    original: &RecoveryRef,
    execution: Uuid,
) -> String {
    tracing::error!(target: "maka_host_runtime::application", stage, cause = diagnostics::cause(error),
        sql_code = diagnostics::sql_code(error), os_code = diagnostics::os_code(error),
        operation_id = %original.operation, execution_id = %execution,
        state_domain = %original.source.state_domain, deployment_id = %original.source.deployment, source_revision = original.source.revision,
        "Host runtime failure");
    format!("{stage} was not confirmed; read original receipt: {error}")
}

pub(super) fn diagnostic(error: &str) -> String {
    // Keep the encoded diagnostic within the journal budget as well as its
    // raw UTF-8 size. A control character may occupy six JSON bytes.
    let mut size = 0;
    let mut end = 0;
    for (offset, character) in error.char_indices() {
        let bytes = match character {
            '"' | '\\' | '\n' | '\r' | '\t' | '\u{08}' | '\u{0c}' => 2,
            '\u{00}'..='\u{1f}' => 6,
            _ => character.len_utf8(),
        };
        if size + bytes > 64 * 1024 - 64 {
            break;
        }
        size += bytes;
        end = offset + character.len_utf8();
    }
    let mut diagnostic = error[..end].to_owned();
    if end < error.len() {
        diagnostic.push('…');
    }
    diagnostic
}
