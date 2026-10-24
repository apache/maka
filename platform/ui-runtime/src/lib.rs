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

//! Local component execution. Renderers only read committed frames; JavaScript
//! executes on initialization or input, never during layout/paint.
pub mod abi;
pub mod actions;
pub mod appearance;
pub mod backend;
pub mod budget;
pub mod checkpoint;
mod deployment;
pub mod diff;
pub mod dismiss;
pub mod editor;
pub mod elapsed;
pub mod file;
pub mod focus;
mod frame;
pub use deployment::{CommittedUpdate, DeploymentStatus, PreparedUpdate};
pub mod input;
pub mod locale;
pub mod markdown;
pub mod morph_mark;
mod native;
pub mod operations;
pub mod publication;
pub mod reading;
pub mod rows;
pub mod scene;
pub mod selection_menu;
pub mod shortcut;
pub mod source;
pub mod terminal;
pub mod text;
pub mod text_file;
pub mod textarea;
mod tree;
mod values;
pub use frame::{ComponentOutput, ComponentSlot, Emission, Frame, Surface};
pub use native::{
    ComponentCall, EventOrigin, LabelProps, NativeCapability, NativeComponent, NativeExport,
    NativeRegistry, NativeView, PrepareScene, PreparedScene, label_contract,
};
pub use tree::Candidate;

use maka_packages::Package;
use maka_plugin_core::{
    composition::{ExecutionLocation, Input, InstanceId, PresentationTarget},
    contract::{Contract, Interface, Transport},
    package::{Implementation, PackageRef, Packages, Realm},
    plan::{Plan, Provider},
    runtime::{Activation, Mount, Phase, Published, Resource, Runtime},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    rc::Rc,
    sync::Arc,
    task::{Context, Poll, Waker},
};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Core(#[from] maka_plugin_core::Error),
    #[error("component backend: {0}")]
    Script(String),
    #[error("invalid UI activation or batch: {0}")]
    Invalid(String),
}
pub type Result<T> = std::result::Result<T, Error>;
type ExecutionRealm = Rc<dyn backend::Realm>;

/// Trusted execution setup. A native-only UI does not require a script backend.
#[derive(Clone, Default)]
pub struct ExecutionOptions {
    pub script: Option<Rc<dyn backend::Factory>>,
}

enum Component<V: ?Sized> {
    JavaScript {
        realm: ExecutionRealm,
        callbacks: Rc<dyn backend::Component>,
    },
    Native(Rc<dyn NativeComponent<V>>),
}
// Native input causality is never guest JSON or a retained frame property.
struct Invocation<V: ?Sized> {
    output: ComponentOutput<NativeView<V>>,
}
struct PendingInvocation<V: ?Sized> {
    execution: maka_plugin_core::runtime::Execution<Export<V>>,
    result: InvocationResult<V>,
    realm: Option<ExecutionRealm>,
}
enum InvocationResult<V: ?Sized> {
    Native(backend::Job<ComponentOutput<NativeView<V>>>),
    Script(backend::Job<ComponentOutput<PreparedScene>>),
}
struct CaptureDefinition {
    input: Arc<jsonschema::Validator>,
    output: maka_plugin_core::contract::CaptureOutput,
}
struct ServiceMethod {
    mode: maka_plugin_core::contract::MethodMode,
    input: Arc<jsonschema::Validator>,
    output: Arc<jsonschema::Validator>,
    progress: Option<Arc<jsonschema::Validator>>,
    resources: BTreeMap<String, maka_plugin_core::contract::ResourceSlot>,
}
enum Export<V: ?Sized> {
    Component {
        implementation: Component<V>,
        props: Arc<jsonschema::Validator>,
        events: BTreeMap<String, Arc<jsonschema::Validator>>,
        captures: BTreeMap<String, CaptureDefinition>,
    },
    Surface(PresentationTarget),
    Value(Value),
    Service {
        implementation: std::sync::Arc<dyn actions::NativeService>,
        methods: BTreeMap<String, ServiceMethod>,
    },
}
struct Loaded {
    realm: ExecutionRealm,
    module: Rc<dyn backend::Module>,
    resource: Resource,
    activation: Option<backend::Job<BTreeMap<String, abi::UiExport>>>,
    closing: Option<ModuleClose>,
}
enum ModuleClose {
    Pending(backend::Job<()>),
    Failed(String),
}

pub struct Application<V: ?Sized = ()> {
    runtime: Runtime<Export<V>>,
    activations: BTreeMap<InstanceId, Activation>,
    modules: BTreeMap<InstanceId, Loaded>,
    values: BTreeMap<Uuid, values::Imports<V>>,
    views: BTreeMap<Uuid, tree::Mounted<V>>,
    actions: actions::Actions<V>,
    pub(crate) scheduler: tokio::runtime::Handle,
    target: PresentationTarget,
    scene_compiler: Option<Rc<native::SceneCompiler<V>>>,
    render_depth_limit: Option<u16>,
    update_owner: Uuid,
    source: Option<maka_event_log::applications::SourceSnapshot>,
    store: Option<std::sync::Arc<maka_event_log::RootStore>>,
    origins: BTreeMap<Uuid, maka_event_log::applications::SourceSnapshot>,
    effective: Option<maka_plugin_core::deployment::DeploymentRef>,
    deployment_error: Option<String>,
    pending: Vec<maka_plugin_core::plan::Instance>,
    sources: BTreeMap<PackageRef, Package>,
    native: Option<NativeRegistry<V>>,
    script: Option<Rc<dyn backend::Factory>>,
    shared: Option<std::rc::Weak<dyn backend::Realm>>,
    remote_epochs: BTreeMap<maka_plugin_core::plan::RemoteCapability, Uuid>,
    pending_remotes: Vec<actions::RemoteService>,
    closing: bool,
    wake: std::sync::Arc<std::sync::Mutex<Waker>>,
    ui_update: Option<tree::Update<V>>,
    ui_inputs: std::collections::VecDeque<tree::QueuedInput>,
    native_commit: bool,
}

impl<V: ?Sized + 'static> Application<V> {
    /// Unsaved, query-only preview. Production executions load their owned source
    /// through `start_from_store`; this constructor has no DeploymentRef.
    pub fn new(
        input: &Input,
        bytes: Vec<Package>,
        timer: tokio::runtime::Handle,
        options: ExecutionOptions,
        native: NativeRegistry<V>,
        remotes: actions::RemoteServices,
    ) -> Result<Self> {
        Self::new_owned(input, bytes, timer, options, native, remotes, None)
    }

    /// Loads the owned original source and exact bytes before executing any code.
    /// Static remote observations come only from that source; endpoints remain
    /// separate trusted registrations. Construct on the presentation owner thread.
    pub async fn start_from_store(
        store: std::sync::Arc<maka_event_log::RootStore>,
        source: maka_plugin_core::deployment::DeploymentRef,
        target: PresentationTarget,
        timer: tokio::runtime::Handle,
        options: ExecutionOptions,
        native: NativeRegistry<V>,
        registrations: Vec<actions::RemoteService>,
    ) -> Result<Self> {
        let loaded = store
            .load_application_at(&source)
            .await
            .map_err(|e| Error::Invalid(e.to_string()))?
            .ok_or_else(|| Error::Invalid("UI deployment not found".into()))?;
        Self::start_loaded(store, loaded, target, timer, options, native, registrations).await
    }

    /// Use the launcher's original checked snapshot; no second storage read.
    pub async fn start_loaded(
        store: std::sync::Arc<maka_event_log::RootStore>,
        loaded: maka_event_log::applications::LoadedDeployment,
        target: PresentationTarget,
        timer: tokio::runtime::Handle,
        options: ExecutionOptions,
        mut native: NativeRegistry<V>,
        registrations: Vec<actions::RemoteService>,
    ) -> Result<Self> {
        store
            .check_application(&loaded)
            .map_err(|e| Error::Invalid(e.to_string()))?;
        if loaded.source().input.environment.location != ExecutionLocation::Ui
            || loaded.source().input.environment.presentation != Some(target)
        {
            return Err(Error::Invalid("stored presentation target mismatch".into()));
        }
        let (source, packages, plan, snapshot) = loaded.into_parts();
        operations::provide(&mut native, source.reference.clone(), store.clone())?;
        let remotes = actions::RemoteServices {
            declarations: source
                .remote_exports
                .into_iter()
                .map(|r| (r.capability, r.declaration))
                .collect(),
            registrations,
        };
        let candidate = deployment::prepare_plan(
            &source.input.environment,
            plan,
            packages
                .into_iter()
                .map(|p| (p.application_ref(), p))
                .collect(),
            &native,
        )?;
        let mut app = Self::new_prepared(
            candidate,
            timer,
            options,
            native,
            remotes,
            Some((snapshot, store)),
        )?;
        app.wait_ready().await?;
        Ok(app)
    }

    /// The committed source adopted by this executor; status reports convergence.
    pub fn source(&self) -> Option<&maka_plugin_core::deployment::DeploymentRef> {
        self.source.as_ref().map(|source| source.reference())
    }

    fn new_owned(
        input: &Input,
        bytes: Vec<Package>,
        timer: tokio::runtime::Handle,
        options: ExecutionOptions,
        native: NativeRegistry<V>,
        remotes: actions::RemoteServices,
        persisted: Option<(
            maka_event_log::applications::SourceSnapshot,
            std::sync::Arc<maka_event_log::RootStore>,
        )>,
    ) -> Result<Self> {
        let candidate = deployment::prepare(input, bytes, &native, &remotes.declarations)?;
        Self::new_prepared(candidate, timer, options, native, remotes, persisted)
    }

    fn new_prepared(
        candidate: deployment::Candidate,
        timer: tokio::runtime::Handle,
        options: ExecutionOptions,
        native: NativeRegistry<V>,
        remotes: actions::RemoteServices,
        persisted: Option<(
            maka_event_log::applications::SourceSnapshot,
            std::sync::Arc<maka_event_log::RootStore>,
        )>,
    ) -> Result<Self> {
        let deployment::Candidate {
            plan,
            sources,
            instances: pending,
            target,
        } = candidate;
        let (source, store) = match persisted {
            Some((source, store)) => (Some(source), Some(store)),
            None => (None, None),
        };
        let mut app = Self {
            runtime: Runtime::new(plan),
            activations: BTreeMap::new(),
            modules: BTreeMap::new(),
            values: BTreeMap::new(),
            views: BTreeMap::new(),
            actions: actions::Actions::default(),
            target,
            scene_compiler: native.scene_compiler.clone(),
            render_depth_limit: native.render_depth_limit,
            scheduler: timer.clone(),
            update_owner: Uuid::new_v4(),
            effective: None,
            source,
            store,
            origins: BTreeMap::new(),
            deployment_error: None,
            pending,
            sources,
            native: Some(native),
            script: options.script,
            shared: None,
            remote_epochs: BTreeMap::new(),
            pending_remotes: Vec::new(),
            closing: false,
            wake: std::sync::Arc::new(std::sync::Mutex::new(Waker::noop().clone())),
            ui_update: None,
            ui_inputs: std::collections::VecDeque::new(),
            native_commit: false,
        };
        for remote in remotes.registrations {
            app.remote_epochs
                .insert(remote.target.clone(), remote.registration_epoch);
            let value = service_export(remote.implementation, &remote.contract)?;
            app.runtime
                .attach_remote(
                    remote.target,
                    remote.registration_epoch,
                    Published {
                        contract: remote.contract,
                        value,
                    },
                )
                .map_err(|rejected| Error::Core(rejected.error))?;
        }
        while !app.pending.is_empty() {
            let before = app.pending.len();
            for instance in std::mem::take(&mut app.pending) {
                if !app.activation_ready(&instance) {
                    app.pending.push(instance);
                    continue;
                }
                let identity = instance.identity.clone();
                if let Err(error) = app.activate_instance(instance) {
                    if app.runtime.desired().recovery().is_none() {
                        return Err(error);
                    }
                    if let Some(activation) = app.activations.get(&identity) {
                        app.runtime.retire(activation)?;
                    }
                    app.deployment_error.get_or_insert(error.to_string());
                }
            }
            if app.pending.len() == before {
                if app.runtime.desired().recovery().is_some() && app.deployment_error.is_some() {
                    break;
                }
                if app
                    .modules
                    .values()
                    .any(|loaded| loaded.activation.is_some())
                {
                    break;
                }
                return Err(Error::Invalid("UI dependencies are not ready".into()));
            }
        }
        if app.deployment_error.is_none() && !app.deployment_status().converging {
            app.effective = app.source().cloned();
        }
        Ok(app)
    }

    fn activate_instance(&mut self, instance: maka_plugin_core::plan::Instance) -> Result<()> {
        let activation = self.runtime.begin(&instance.identity)?;
        self.activations
            .insert(instance.identity.clone(), activation.clone());
        if let Some(source) = &self.source {
            self.origins.insert(activation.epoch(), source.clone());
        }
        if let Some(entry) = &instance.entry {
            self.capture_values(&activation, &entry.imports)?;
        }
        let mut batch = BTreeMap::new();
        if let Some(entry) = &instance.entry {
            match &entry.implementation {
                Implementation::Native { implementation } => {
                    let values = self.values_snapshot(&activation)?;
                    for (name, actual) in self.native.as_ref().expect("open UI registry").activate(
                        implementation,
                        &instance.configuration,
                        &values,
                    )? {
                        let value = match actual.value {
                            NativeCapability::Surface(target) => Export::Surface(target),
                            NativeCapability::Value(value) => {
                                values::export(value, &actual.contract)?
                            }
                            NativeCapability::Service(implementation) => {
                                service_export(implementation, &actual.contract)?
                            }
                            NativeCapability::Component(component) => {
                                let Interface::Component {
                                    props,
                                    events,
                                    captures,
                                } = &actual.contract.interface
                                else {
                                    unreachable!()
                                };
                                Export::Component {
                                    implementation: Component::Native(component),
                                    props: maka_plugin_core::validator(props)
                                        .map_err(|error| Error::Invalid(error.to_string()))?,
                                    events: event_schemas(events)?,
                                    captures: capture_schemas(captures)?,
                                }
                            }
                        };
                        batch.insert(
                            name,
                            Published {
                                contract: actual.contract,
                                value,
                            },
                        );
                    }
                }
                Implementation::JavaScript { module, realm } => {
                    let realm = match realm {
                        Realm::Shared => self
                            .shared
                            .as_ref()
                            .and_then(std::rc::Weak::upgrade)
                            .filter(|realm| realm.failure().is_none()),
                        Realm::Dedicated => None,
                    };
                    let realm = match realm {
                        Some(realm) => realm,
                        None => self
                            .script
                            .as_ref()
                            .ok_or_else(|| {
                                Error::Invalid("UI script backend is unavailable".into())
                            })?
                            .create(self.scheduler.clone())?,
                    };
                    if matches!(
                        entry.implementation,
                        Implementation::JavaScript {
                            realm: Realm::Shared,
                            ..
                        }
                    ) {
                        self.shared = Some(Rc::downgrade(&realm));
                    }
                    let package = &self.sources[&instance.package];
                    let source = std::str::from_utf8(
                        package
                            .file(module)
                            .ok_or_else(|| Error::Invalid("entry bytes missing".into()))?,
                    )
                    .map_err(|error| Error::Invalid(error.to_string()))?;
                    let loaded = realm.load(module, source)?;
                    let resource = self
                        .runtime
                        .own_resource(&activation, "foreground module")?;
                    self.modules.insert(
                        instance.identity.clone(),
                        Loaded {
                            realm: realm.clone(),
                            module: loaded,
                            resource,
                            activation: None,
                            closing: None,
                        },
                    );
                    let loaded = &self.modules[&instance.identity].module;
                    let values = self.values_snapshot(&activation)?;
                    let job = loaded.activate(&instance.configuration, &values)?;
                    self.modules
                        .get_mut(&instance.identity)
                        .expect("loaded module")
                        .activation = Some(job);
                    return Ok(());
                }
            }
        }
        self.runtime
            .publish(&activation, batch)
            .map_err(|rejected| Error::Core(rejected.error))?;
        Ok(())
    }

    fn publish_script_exports(
        &mut self,
        id: InstanceId,
        actual: BTreeMap<String, abi::UiExport>,
    ) -> Result<()> {
        let activation = self.activations[&id].clone();
        if self.runtime.phase(&activation)? == Phase::Retiring {
            return Ok(());
        }
        let realm = self.modules[&id].realm.clone();
        let mut batch = BTreeMap::new();
        for (name, actual) in actual {
            let (contract, component) = match actual {
                abi::UiExport::Value { contract, value } => {
                    let value = values::export(value, &contract)?;
                    batch.insert(name, Published { contract, value });
                    continue;
                }
                abi::UiExport::Component {
                    contract,
                    component,
                } => (contract, component),
            };
            if !matches!(contract.interface, Interface::Component { .. }) || component.is_empty() {
                return Err(Error::Invalid(
                    "local JS export must declare a component".into(),
                ));
            }
            let Interface::Component {
                props,
                events,
                captures,
            } = &contract.interface
            else {
                unreachable!()
            };
            let props = maka_plugin_core::validator(props)
                .map_err(|error| Error::Invalid(error.to_string()))?;
            let events = event_schemas(events)?;
            let compiled_captures = capture_schemas(captures)?;
            let callbacks = self.modules[&id]
                .module
                .component(&component, !captures.is_empty())?;
            batch.insert(
                name,
                Published {
                    contract,
                    value: Export::Component {
                        props,
                        events,
                        captures: compiled_captures,
                        implementation: Component::JavaScript {
                            realm: realm.clone(),
                            callbacks,
                        },
                    },
                },
            );
        }
        self.runtime
            .publish(&activation, batch)
            .map_err(|rejected| Error::Core(rejected.error))?;
        Ok(())
    }

    fn poll_script_activations(&mut self) -> Result<bool> {
        let mut completed = Vec::new();
        let wake = self.waker();
        let mut cx = Context::from_waker(&wake);
        for (id, loaded) in &mut self.modules {
            if let Some(job) = loaded.activation.as_mut()
                && let Poll::Ready(result) = Pin::new(job).poll(&mut cx)
            {
                loaded.activation = None;
                completed.push((id.clone(), result));
            }
        }
        let progressed = !completed.is_empty();
        let mut failure = None;
        for (id, result) in completed {
            match result.and_then(|exports| self.publish_script_exports(id.clone(), exports)) {
                Ok(()) => {}
                Err(error) => {
                    self.runtime.retire(&self.activations[&id])?;
                    self.deployment_error.get_or_insert(error.to_string());
                    failure.get_or_insert(error);
                }
            }
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(progressed),
        }
    }

    fn close_module(&mut self, id: &InstanceId) -> Result<bool> {
        let wake = self.waker();
        let loaded = self.modules.get_mut(id).expect("owned module");
        if loaded.closing.is_none() {
            loaded.closing = Some(ModuleClose::Pending(loaded.module.close()?));
        }
        let job = match loaded.closing.as_mut().expect("module close") {
            ModuleClose::Pending(job) => job,
            ModuleClose::Failed(reason) => return Err(Error::Script(reason.clone())),
        };
        let mut cx = Context::from_waker(&wake);
        let Poll::Ready(result) = Pin::new(job).poll(&mut cx) else {
            return Ok(false);
        };
        self.runtime.complete_resource(
            &loaded.resource,
            result.as_ref().map(|_| ()).map_err(ToString::to_string),
        )?;
        if let Err(error) = result {
            loaded.closing = Some(ModuleClose::Failed(error.to_string()));
            return Err(error);
        }
        self.modules.remove(id);
        Ok(true)
    }

    /// Replace the embedding's wake destination; no guest or native work is run.
    /// Production renderers prepare their original native resources before the
    /// logical candidate is published. Pure runtime callers can commit directly.
    pub fn defer_native_commit(&mut self) {
        self.native_commit = true;
    }

    pub fn set_waker(&mut self, wake: Waker) {
        *self.wake.lock().expect("UI wake destination") = wake;
    }

    pub fn waker(&self) -> Waker {
        self.wake.lock().expect("UI wake destination").clone()
    }
    /// Native resources retain a stable notification destination while startup
    /// and interactive executors replace the actual task waker.
    pub fn wake_callback(&self) -> impl Fn() + Send + Sync + 'static {
        let wake = self.wake.clone();
        move || {
            let wake = wake.lock().expect("UI wake destination").clone();
            wake.wake();
        }
    }

    /// Startup can await convergence before native input is installed. During an
    /// active surface the embedding instead advances this same owner on wakeups.
    pub async fn wait_ready(&mut self) -> Result<()> {
        std::future::poll_fn(|cx| {
            self.set_waker(cx.waker().clone());
            if let Err(error) = self.advance_deployment()
                && self.runtime.desired().recovery().is_none()
            {
                return Poll::Ready(Err(error));
            }
            if self.deployment_error.is_some()
                && self.runtime.desired().recovery().is_some()
                && self
                    .modules
                    .values()
                    .all(|loaded| loaded.activation.is_none())
            {
                return Poll::Ready(Ok(()));
            }
            if self.deployment_converging() {
                Poll::Pending
            } else {
                Poll::Ready(Ok(()))
            }
        })
        .await
    }

    /// Await admitted logical work from a noninteractive asynchronous caller.
    /// Interactive embeddings advance this owner on wakeups instead of waiting.
    pub async fn wait_idle(&mut self) -> Result<()> {
        std::future::poll_fn(|cx| {
            self.set_waker(cx.waker().clone());
            if let Err(error) = self.advance_ui() {
                return Poll::Ready(Err(error));
            }
            if !self.ui_pending() {
                Poll::Ready(Ok(()))
            } else {
                Poll::Pending
            }
        })
        .await
    }

    /// Await initial mount preparation before installing an interactive surface.
    pub async fn wait_frame(&mut self, mount: &Mount) -> Result<()> {
        std::future::poll_fn(|cx| {
            self.set_waker(cx.waker().clone());
            if let Err(error) = self.advance_ui() {
                return Poll::Ready(Err(error));
            }
            if self.views.contains_key(&mount.id()) {
                Poll::Ready(Ok(()))
            } else if self.ui_update.is_some() {
                Poll::Pending
            } else {
                Poll::Ready(Err(Error::Invalid(
                    "initial UI frame was not committed".into(),
                )))
            }
        })
        .await
    }

    fn begin_invoke(
        &mut self,
        mount: &Mount,
        call: &backend::Call,
        previous: Option<&NativeView<V>>,
    ) -> Result<PendingInvocation<V>> {
        let values = self.mount_values(mount)?;
        let execution = self.runtime.admit_mount(mount)?;
        let Export::Component { implementation, .. } = execution.value() else {
            unreachable!()
        };
        let (result, realm) = match implementation {
            Component::JavaScript { realm, callbacks } => (
                InvocationResult::Script(
                    callbacks
                        .call(
                            call.clone(),
                            values,
                            self.scene_compiler
                                .as_ref()
                                .expect("preflight compiler")
                                .prepare
                                .clone(),
                        )
                        .unwrap_or_else(|error| backend::Job::ready(Err(error))),
                ),
                Some(realm.clone()),
            ),
            Component::Native(component) => (
                InvocationResult::Native(component.start(
                    call.as_native(),
                    previous,
                    &values,
                    &self.scheduler,
                )),
                None,
            ),
        };
        Ok(PendingInvocation {
            execution,
            result,
            realm,
        })
    }

    fn poll_invocation(
        &mut self,
        pending: &mut PendingInvocation<V>,
        cx: &mut Context<'_>,
    ) -> Poll<Result<Invocation<V>>> {
        let result = match &mut pending.result {
            InvocationResult::Native(job) => {
                let Poll::Ready(result) = Pin::new(job).poll(cx) else {
                    return Poll::Pending;
                };
                result
            }
            InvocationResult::Script(job) => {
                let Poll::Ready(result) = Pin::new(job).poll(cx) else {
                    return Poll::Pending;
                };
                result.and_then(|output| {
                    let view = (self
                        .scene_compiler
                        .as_ref()
                        .expect("preflight compiler")
                        .finish)(output.frame.view)?;
                    // The checked source is retained separately for guest accounting.
                    Ok(ComponentOutput {
                        frame: Frame {
                            revision: output.frame.revision,
                            state: output.frame.state,
                            surface: output.frame.surface,
                            view,
                        },
                        events: output.events,
                        actions: output.actions,
                        cancel: output.cancel,
                        subscriptions: output.subscriptions,
                    })
                })
            }
        };
        let failed_realm = if matches!(result, Err(Error::Script(_))) {
            pending.realm.clone()
        } else {
            None
        };
        let Export::Component { events, .. } = pending.execution.value() else {
            unreachable!()
        };
        let result = result.and_then(|output| {
            for event in &output.events {
                events
                    .get(&event.name)
                    .ok_or_else(|| Error::Invalid("undeclared component emission".into()))?
                    .validate(&event.value)
                    .map_err(|error| Error::Invalid(error.to_string()))?;
            }
            output.frame.validate_metadata().map_err(Error::Invalid)?;
            Ok(output)
        });
        self.runtime.settle(&pending.execution, Ok(()))?; // Only declarative scene preparation.
        if let Some(realm) = failed_realm {
            for (id, loaded) in &self.modules {
                if Rc::ptr_eq(&loaded.realm, &realm) {
                    if self.runtime.status(&self.activations[id])?.phase != Phase::Retiring {
                        self.deployment_error.get_or_insert_with(|| {
                            result
                                .as_ref()
                                .err()
                                .map(ToString::to_string)
                                .unwrap_or_else(|| "foreground domain failed".into())
                        });
                    }
                    self.runtime.retire(&self.activations[id])?;
                }
            }
        }
        self.sync_subscription_demand();
        Poll::Ready(result.map(|output| Invocation { output }))
    }

    fn validate_surface(&mut self, mount: &Mount, frame: &Frame<NativeView<V>>) -> Result<()> {
        let provider = self.runtime.mount_provider(mount)?.clone();
        let surface = frame
            .surface
            .as_ref()
            .ok_or_else(|| Error::Invalid("launch component must request a surface".into()))?;
        if surface.target() != self.target {
            return Err(Error::Invalid("surface variant mismatch".into()));
        }
        let handles = self.runtime.bind(&provider, surface.binding())?;
        if handles.len() != 1 {
            return Err(Error::Invalid(
                "one explicit surface binding required".into(),
            ));
        }
        let valid = matches!(self.runtime.inspect(&handles[0])?, Export::Surface(target) if *target == self.target);
        if !valid {
            return Err(Error::Invalid("surface target mismatch".into()));
        }
        Ok(())
    }

    pub fn can_shutdown(&self) -> bool {
        self.views.is_empty() && self.actions.accepted_count() == 0 && self.ui_update.is_none()
    }

    pub fn scheduler(&self) -> &tokio::runtime::Handle {
        &self.scheduler
    }

    pub fn frame(&self, mount: &Mount) -> Result<&Frame<NativeView<V>, Arc<Value>>> {
        self.views
            .get(&mount.id())
            .map(|view| &view.frame)
            .ok_or_else(|| Error::Invalid("mount has no committed frame".into()))
    }
    pub fn close(
        &mut self,
        mount: &Mount,
        native_cleanup: std::result::Result<(), String>,
    ) -> Result<()> {
        self.runtime.retire_mount(mount)?;
        self.sync_subscription_demand();
        self.runtime.complete_mount(mount, native_cleanup)?;
        self.views.remove(&mount.id());
        Ok(())
    }
    /// Stops callbacks without asserting that the renderer/platform has closed
    /// any native resources. `close` requires a separate real acknowledgement.
    pub fn retire(&mut self, mount: &Mount) -> Result<()> {
        self.runtime.retire_mount(mount)?;
        self.sync_subscription_demand();
        Ok(())
    }
    /// Capture the exact attachment when installing a transport disconnect callback.
    /// The target identifies a source reference; only this token identifies its lifetime.
    pub fn remote_activation(
        &self,
        target: &maka_plugin_core::plan::RemoteCapability,
    ) -> Result<Activation> {
        self.runtime
            .activations()
            .find(|a| a.remote_target() == Some(target))
            .cloned()
            .ok_or(maka_plugin_core::Error::Retired.into())
    }
    /// Late notifications cannot retire a replacement attachment or another kernel.
    /// Accepted calls stay with the original attachment until actual cleanup.
    pub fn retire_remote(&mut self, attachment: &Activation) -> Result<()> {
        if attachment.remote_target().is_none() {
            return Err(Error::Invalid("remote attachment required".into()));
        }
        self.runtime.retire(attachment)?;
        self.sync_subscription_demand();
        Ok(())
    }

    pub fn is_retiring(&self, mount: &Mount) -> bool {
        !self
            .runtime
            .mount_phase(mount)
            .is_ok_and(|phase| phase != Phase::Retiring)
    }

    /// Stop admission and release module registrations. Native adapters must
    /// first confirm each mount's actual close through `close`; pending native
    /// cleanup remains an error rather than an implicit shutdown acknowledgement.
    pub fn shutdown(&mut self) -> Result<()> {
        self.closing = true;
        self.pending.clear();
        self.pending_remotes.clear();
        for activation in self.runtime.activations().cloned().collect::<Vec<_>>() {
            self.runtime.retire(&activation)?;
        }
        self.sync_subscription_demand();
        self.actions.queue.clear();
        self.actions.outcomes.clear();
        for id in self.modules.keys().cloned().collect::<Vec<_>>() {
            self.close_module(&id)?;
        }
        // Children must finish before their parent. The checked plan has no
        // ownership cycles; a fixed point with owners left is genuine pending
        // work/resources/mounts, not a reason to discard them.
        loop {
            let pending = self.runtime.activations().cloned().collect::<Vec<_>>();
            let before = pending.len();
            for activation in pending {
                match self.runtime.finish_cleanup(&activation) {
                    Ok(()) => {
                        if activation.remote_target().is_none() {
                            self.activations.remove(activation.instance());
                            self.values.remove(&activation.epoch());
                            self.origins.remove(&activation.epoch());
                        }
                    }
                    Err(maka_plugin_core::Error::CleanupPending) => {}
                    Err(error) => return Err(error.into()),
                }
            }
            let remaining = self.runtime.activations().count();
            if remaining == 0 {
                // RootStore's independent owner confirms its actual SQL close.
                // This only releases the UI execution's custody after cleanup.
                self.native.take();
                self.sources.clear();
                self.remote_epochs.clear();
                self.store.take();
                return Ok(());
            }
            if remaining == before {
                return Err(maka_plugin_core::Error::CleanupPending.into());
            }
        }
    }
}

fn service_export<V: ?Sized>(
    implementation: std::sync::Arc<dyn actions::NativeService>,
    contract: &Contract,
) -> Result<Export<V>> {
    let Interface::Service { methods } = &contract.interface else {
        return Err(Error::Invalid("service contract required".into()));
    };
    let mut compiled = BTreeMap::new();
    for (name, method) in methods {
        compiled.insert(
            name.clone(),
            ServiceMethod {
                mode: method.mode,
                input: maka_plugin_core::validator(&method.input)
                    .map_err(|e| Error::Invalid(e.to_string()))?,
                output: maka_plugin_core::validator(&method.output)
                    .map_err(|e| Error::Invalid(e.to_string()))?,
                progress: method
                    .progress
                    .as_ref()
                    .map(|schema| maka_plugin_core::validator(schema))
                    .transpose()
                    .map_err(|e| Error::Invalid(e.to_string()))?,
                resources: method.resources.clone(),
            },
        );
    }
    Ok(Export::Service {
        implementation,
        methods: compiled,
    })
}

fn event_schemas(
    events: &BTreeMap<String, maka_plugin_core::Schema>,
) -> Result<BTreeMap<String, Arc<jsonschema::Validator>>> {
    events
        .iter()
        .map(|(name, schema)| {
            maka_plugin_core::validator(schema)
                .map(|schema| (name.clone(), schema))
                .map_err(|error| Error::Invalid(error.to_string()))
        })
        .collect()
}

pub fn surface_contract(target: PresentationTarget) -> Contract {
    let resource = match target {
        PresentationTarget::Tui => "surface.tui",
    };
    Contract {
        name: format!("maka.ui.{resource}"),
        version: 1,
        transport: Transport::Local,
        interface: Interface::Resource {
            resource: resource.into(),
            schema: json!({"type":"object","additionalProperties":false}).into(),
        },
    }
}

fn capture_schemas(
    captures: &BTreeMap<String, maka_plugin_core::contract::Capture>,
) -> Result<BTreeMap<String, CaptureDefinition>> {
    captures
        .iter()
        .map(|(name, c)| {
            Ok((
                name.clone(),
                CaptureDefinition {
                    input: maka_plugin_core::validator(&c.input)
                        .map_err(|e| Error::Invalid(e.to_string()))?,
                    output: c.output.clone(),
                },
            ))
        })
        .collect()
}

pub use native::surface_native;
pub use native::{IMPLEMENTATION as LABEL_IMPLEMENTATION, native as label_native};

#[cfg(test)]
mod export_schema_tests {
    use super::*;

    #[test]
    fn event_schema_changes_and_invalid_replacements_remain_checked() {
        let events = BTreeMap::from([("submitted".into(), json!({"type":"string"}).into())]);
        let original = event_schemas(&events).unwrap();
        assert!(original["submitted"].validate(&json!("value")).is_ok());
        assert!(original["submitted"].validate(&json!(true)).is_err());
        let changed = event_schemas(&BTreeMap::from([(
            "submitted".into(),
            json!({"type":"boolean"}).into(),
        )]))
        .unwrap();
        assert!(changed["submitted"].validate(&json!(true)).is_ok());
        assert!(changed["submitted"].validate(&json!("value")).is_err());
        assert!(matches!(
            event_schemas(&BTreeMap::from([(
                "submitted".into(),
                json!({"type":"invalid"}).into()
            ),])),
            Err(Error::Invalid(_))
        ));
    }

    #[test]
    fn actual_value_exports_validate_each_value_against_the_complete_schema() {
        let mut contract = Contract {
            name: "example.Value".into(),
            version: 1,
            transport: Transport::Local,
            interface: Interface::Value {
                schema: json!({"type":"string"}).into(),
            },
        };
        assert!(matches!(
            values::export::<()>(json!("value"), &contract),
            Ok(Export::Value(_))
        ));
        assert!(values::export::<()>(json!(true), &contract).is_err());
        contract.interface = Interface::Value {
            schema: json!({"type":"boolean"}).into(),
        };
        assert!(matches!(
            values::export::<()>(json!(true), &contract),
            Ok(Export::Value(_))
        ));
        assert!(values::export::<()>(json!("value"), &contract).is_err());
        contract.interface = Interface::Value {
            schema: json!({"type":"invalid"}).into(),
        };
        assert!(values::export::<()>(json!(true), &contract).is_err());
    }
}
