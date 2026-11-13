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

//! Explicit Executor services, driven by the original Agent engine.
use futures_util::{FutureExt, future::BoxFuture};
use maka_agent_ports::executor;
use maka_agent_ports::executor::Admitted;
use maka_agent_ports::executor::Error;
use maka_agent_ports::executor::OutputSink;
use maka_agent_ports::executor::Request;
use maka_agent_ports::executor::Settlement;
use maka_capabilities::call::Identity;
use maka_event_log::RootStore;
use maka_host_runtime::application::{Binding, NativeContext, NativeServices};
use maka_plugin_core::operation::OperationResult;
use maka_plugin_core::operation::{OperationCleanup, OperationOutcome, Receipt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, panic::AssertUnwindSafe, sync::Arc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub(crate) mod attachments;
pub(crate) mod cleanup;
pub(crate) mod external;
pub mod setup;

use maka_agent_api::executor::{Execute, Selection, ServiceExecutor, contract};
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Accepted {
    pub selection: Selection,
    import: String,
    #[serde(default)]
    member: usize,
    basis: String,
}
#[derive(Clone)]
pub(crate) struct Backend {
    pub accepted: Accepted,
    implementation: Implementation,
    host_tools: Option<external::HostTools>,
}
#[derive(Clone)]
enum Implementation {
    Service(Box<ServiceBackend>),
    External(Arc<external::External>),
}
#[derive(Clone)]
struct ServiceBackend {
    services: NativeServices,
    store: Arc<RootStore>,
    deployment: Uuid,
    consumer: maka_plugin_core::composition::InstanceId,
    binding: Binding,
    setup: Option<maka_agent_api::executor::setup::Binding>,
}
#[derive(Default)]
pub(crate) struct Executors(BTreeMap<String, Backend>);
pub(super) enum ActiveDelivery {
    Steer,
    InterruptResume,
    Queue,
}
impl Executors {
    pub(crate) fn setup_binding(&self, executor: &str) -> Result<Binding, String> {
        self.0
            .get(executor)
            .ok_or("agent_executor_unavailable")?
            .setup_binding()?
            .ok_or_else(|| "agent_executor_setup_unavailable".into())
    }

    pub fn capture(
        context: &NativeContext,
        selected: &[ServiceExecutor],
        external: Option<&maka_agent_api::executor::ExternalConfiguration>,
    ) -> Result<Self, String> {
        let mut result = BTreeMap::new();
        for selection in selected {
            maka_agent_facts::executor::ExecutorId::try_from(selection.name.clone())
                .map_err(|_| "agent_executor_name_invalid")?;
            let services = context.services();
            let bindings = services
                .imports()
                .find(|(name, _)| *name == selection.import)
                .map(|(_, bindings)| bindings)
                .ok_or("agent_executor_import_missing")?;
            let binding = bindings
                .get(selection.member)
                .ok_or("agent_executor_member_unavailable")?;
            if binding.contract() != &contract() {
                return Err("agent_executor_contract_invalid".into());
            }
            if let Some(setup) = &selection.setup {
                let target = services
                    .imports()
                    .find(|(name, _)| *name == setup.import)
                    .and_then(|(_, bindings)| bindings.get(setup.member))
                    .ok_or("agent_executor_setup_unavailable")?;
                if target.contract() != &maka_agent_api::executor::setup::contract() {
                    return Err("agent_executor_setup_contract_invalid".into());
                }
            }
            let persistence = context.persistence().ok_or("agent_requires_persistence")?;
            let backend = Backend {
                accepted: Accepted {
                    selection: Selection {
                        executor: selection.name.clone(),
                        settings: Default::default(),
                    },
                    import: selection.import.clone(),
                    member: selection.member,
                    basis: binding.execution_basis().into(),
                },
                host_tools: None,
                implementation: Implementation::Service(Box::new(ServiceBackend {
                    binding: binding.clone(),
                    setup: selection.setup.clone(),
                    services: services.clone(),
                    store: persistence.store().clone(),
                    deployment: persistence.source().deployment,
                    consumer: context.activation().instance().clone(),
                })),
            };
            if result.insert(selection.name.clone(), backend).is_some() {
                return Err("agent_executor_name_ambiguous".into());
            }
        }
        if let Some(configuration) =
            external.filter(|configuration| configuration.enabled_runtimes().next().is_some())
        {
            let services = context.services();
            let declaration =
                services.binding(&maka_plugin_core::contract::ServiceTarget::Export {
                    name: maka_agent_api::EXPORT.into(),
                })?;
            let owner = external::External::capture(context, configuration, declaration)?;
            let backend = Backend {
                accepted: Accepted {
                    selection: Selection {
                        executor: "external".into(),
                        settings: Default::default(),
                    },
                    import: "external".into(),
                    member: 0,
                    basis: owner.basis.clone(),
                },
                host_tools: None,
                implementation: Implementation::External(owner),
            };
            if result.insert("external".into(), backend).is_some() {
                return Err("agent_executor_name_ambiguous".into());
            }
        }
        Ok(Self(result))
    }
    pub fn active_delivery(&self, accepted: &Accepted) -> ActiveDelivery {
        let Ok(backend) = self.restore(accepted) else {
            return ActiveDelivery::Queue;
        };
        if !matches!(backend.implementation, Implementation::External(_)) {
            return ActiveDelivery::Queue;
        }
        match accepted.selection.settings.runtime.as_deref() {
            Some("codex" | "claude") => ActiveDelivery::Steer,
            Some("antigravity") => ActiveDelivery::InterruptResume,
            _ => ActiveDelivery::Queue,
        }
    }
    pub fn contains(&self, executor: &str) -> bool {
        self.0.contains_key(executor)
    }
    pub fn names(&self) -> Vec<String> {
        self.0.keys().cloned().collect()
    }
    pub async fn remove_sessions(&self, sessions: &[String]) -> Result<(), String> {
        for backend in self.0.values() {
            if let Implementation::External(owner) = &backend.implementation {
                owner.remove_sessions(sessions).await?;
            }
        }
        Ok(())
    }
    pub async fn finish(&self) -> Result<(), String> {
        for backend in self.0.values() {
            if let Implementation::External(owner) = &backend.implementation {
                owner.finish().await?;
            }
        }
        Ok(())
    }

    pub async fn external_query(
        &self,
        cwd: String,
        request: Value,
        cancellation: CancellationToken,
    ) -> Result<Option<Value>, Error> {
        let Some(Backend {
            implementation: Implementation::External(owner),
            ..
        }) = self.0.get("external")
        else {
            return Ok(None);
        };
        owner.query(cwd, request, cancellation).await.map(Some)
    }
    pub fn select(&self, selection: Selection) -> Result<Backend, String> {
        selection
            .settings
            .validate()
            .map_err(|_| "agent_executor_settings_invalid")?;
        let mut backend = self
            .0
            .get(&selection.executor)
            .cloned()
            .ok_or("agent_executor_unavailable")?;
        match &backend.implementation {
            Implementation::Service(_) if selection.settings.runtime.is_some() => {
                return Err("agent_executor_runtime_unsupported".into());
            }
            Implementation::External(owner) => {
                if selection.settings.runtime.is_none() {
                    return Err("agent_executor_runtime_required".into());
                }
                owner
                    .require_runtime(selection.settings.runtime.as_deref())
                    .map_err(|error| error.to_string())?;
            }
            _ => {}
        }
        backend.accepted.selection = selection;
        Ok(backend)
    }
    pub fn restore(&self, accepted: &Accepted) -> Result<Backend, String> {
        let backend = self.select(accepted.selection.clone())?;
        if &backend.accepted != accepted {
            return Err("agent_executor_changed".into());
        }
        Ok(backend)
    }
}
impl Backend {
    pub fn bind_host_tools(&mut self, tools: external::HostTools) {
        if matches!(self.implementation, Implementation::External(_)) {
            self.host_tools = Some(tools);
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum RecoveryDescriptor {
    Service { original: ServiceTask },
    Native { binding: external::NativeBinding },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ServiceTask {
    task: maka_agent_facts::durable::ExternalTaskId,
    execution: maka_agent_facts::durable::ExecutionIdentity,
    deployment: Uuid,
    provider: maka_plugin_core::composition::InstanceId,
    package: maka_plugin_core::package::PackageRef,
    export: String,
    reference: maka_plugin_core::operation::RecoveryRef,
}
pub(crate) trait TaskBinding: Send + Sync {
    fn observation_retired(&self) -> CancellationToken;
    fn owner_stop(&self) -> CancellationToken;
    fn admitted_steering_batches(&self) -> BoxFuture<'_, Result<u64, Error>>;
    fn stop_requested(&self) -> BoxFuture<'_, Result<bool, Error>>;
    fn execution_authority(
        &self,
    ) -> Result<Arc<dyn maka_agent_authority::executor::ExecutorAccess>, Error>;
    fn bound(&self, descriptor: RecoveryDescriptor) -> BoxFuture<'_, Result<(), Error>>;
    /// ACK of the durable Host closure verdict, not acceptance of the raw provider outcome.
    fn closed(&self, outcome: executor::Outcome) -> BoxFuture<'_, Result<(), Error>>;
    /// Success transfers cleanup-proof custody; only a committed fact is a durable ACK.
    fn cleanup(&self, cleanup: OperationCleanup) -> BoxFuture<'_, Result<(), Error>>;
}
struct NativeBinding(Arc<dyn TaskBinding>);
impl external::TaskBinding for NativeBinding {
    fn observation_retired(&self) -> CancellationToken {
        self.0.observation_retired()
    }
    fn owner_stop(&self) -> CancellationToken {
        self.0.owner_stop()
    }
    fn admitted_steering_batches(&self) -> BoxFuture<'_, Result<u64, Error>> {
        self.0.admitted_steering_batches()
    }
    fn stop_requested(&self) -> BoxFuture<'_, Result<bool, Error>> {
        self.0.stop_requested()
    }
    fn closed(&self, outcome: executor::Outcome) -> BoxFuture<'_, Result<(), Error>> {
        self.0.closed(outcome)
    }
    fn cleanup(&self, cleanup: OperationCleanup) -> BoxFuture<'_, Result<(), Error>> {
        self.0.cleanup(cleanup)
    }

    fn bound(&self, binding: external::NativeBinding) -> BoxFuture<'_, Result<(), Error>> {
        self.0.bound(RecoveryDescriptor::Native { binding })
    }
}
impl Backend {
    pub(crate) fn source_identity(&self) -> maka_agent_facts::executor::Binding {
        match &self.implementation {
            Implementation::External(owner) => owner.source_identity(),
            Implementation::Service(service) => maka_agent_facts::executor::Binding {
                executor_id: self
                    .accepted
                    .selection
                    .executor
                    .clone()
                    .try_into()
                    .expect("executor identity"),
                package_id: service.binding.package().id.clone(),
                entry_id: service.binding.export().into(),
                activation: service.binding.provider().epoch().to_string(),
            },
        }
    }
    pub(crate) fn setup_binding(&self) -> Result<Option<Binding>, String> {
        let Implementation::Service(service) = &self.implementation else {
            return Ok(None);
        };
        let Some(setup) = &service.setup else {
            return Ok(None);
        };
        service
            .services
            .imports()
            .find(|(name, _)| *name == setup.import)
            .and_then(|(_, bindings)| bindings.get(setup.member))
            .cloned()
            .map(Some)
            .ok_or_else(|| "agent_executor_setup_unavailable".into())
    }

    pub(crate) fn service_binding(&self) -> Option<Binding> {
        match &self.implementation {
            Implementation::Service(service) => Some(service.binding.clone()),
            Implementation::External(_) => None,
        }
    }
    pub(crate) async fn admit_execution(
        &self,
        input: Request,
        binding: Arc<dyn TaskBinding>,
        inputs: Arc<dyn external::Inputs>,
        actual: maka_sandbox::Sandbox,
        isolated: Option<maka_process::isolated::TaskOwner>,
    ) -> Result<Admitted, Error> {
        input
            .settings
            .validate()
            .map_err(|error| Error::Invalid(error.into()))?;
        match &self.implementation {
            Implementation::External(owner) => {
                let isolated = isolated.ok_or_else(|| {
                    Error::IsolationUnavailable(
                        "original prepared private task owner is unavailable".into(),
                    )
                })?;
                owner.admit(
                    input,
                    self.host_tools.clone(),
                    Arc::new(NativeBinding(binding)),
                    inputs,
                    isolated,
                )
            }
            Implementation::Service(service) => {
                let authority = binding.execution_authority()?;
                let body = serde_json::to_value(Execute {
                    task_id: input.task_id,
                    language: input.language,
                    execution: input.execution.clone(),
                    conversation_key: input.conversation_key,
                    message: input.content.text,
                    cwd: input.cwd,
                    instructions: input.instructions,
                    settings: input.settings,
                })
                .map_err(|error| Error::Invalid(error.to_string()))?;
                Ok(Admitted {
                    identity: maka_agent_facts::executor::Binding {
                        executor_id: self
                            .accepted
                            .selection
                            .executor
                            .clone()
                            .try_into()
                            .expect("executor identity"),
                        package_id: service.binding.package().id.clone(),
                        entry_id: service.binding.export().into(),
                        activation: service.binding.provider().epoch().to_string(),
                    },
                    execution: Box::new(Call {
                        service: service.clone(),
                        execution: input.execution,
                        task: input.task_id,
                        body,
                        floor: actual,
                        authority: Arc::new(maka_agent_authority::executor::ExecutorCallContext(
                            authority,
                        )),
                        import: self.accepted.import.clone(),
                        member: self.accepted.member,
                        attachments: input.content.attachments.unwrap_or_default(),
                        binding,
                        inputs,
                    }),
                })
            }
        }
    }
    /// Only read the exact task. This path never constructs Execute or admits a mutation.
    #[expect(
        clippy::too_many_arguments,
        reason = "Observation keeps the original task identity, cursor, custody, authority and settlement owners explicit"
    )]
    pub(crate) async fn observe_task(
        &self,
        request: &Request,
        recovery: &RecoveryDescriptor,
        after: u64,
        expected_prefix: Option<[u8; 32]>,
        descriptor: maka_agent_facts::durable::ContentRef,
        custody: Arc<dyn maka_plugin_core::work::WorkCustody>,
        floor: maka_sandbox::Sandbox,
        output: Arc<dyn OutputSink>,
        lifecycle: Arc<dyn TaskBinding>,
        cancellation: CancellationToken,
    ) -> Settlement {
        match (&self.implementation, recovery) {
            (Implementation::Service(service), RecoveryDescriptor::Service { original }) => {
                let ready = async {
                    if original.task != request.task_id
                        || original.execution != request.execution
                        || original.deployment != service.deployment
                        || &original.provider != service.binding.provider().instance()
                        || &original.package != service.binding.package()
                        || original.export != service.binding.export()
                    {
                        return Err(Error::Unknown);
                    }
                    let intent = service
                        .store
                        .application_intent(
                            service.deployment,
                            service.consumer.clone(),
                            operation(&original.execution, original.task),
                        )
                        .await
                        .map_err(|error| Error::Persistence(error.to_string()))?
                        .ok_or(Error::Unknown)?;
                    if intent.reference != original.reference {
                        return Err(Error::Unknown);
                    }
                    service
                        .services
                        .request_with_work(
                            Identity::Agent {
                                execution: request.execution.clone(),
                                operation_id: None,
                            },
                            cancellation,
                            custody,
                        )
                        .and_then(|request| request.with_sandbox_floor(&floor))
                        .map_err(Error::Provider)
                }
                .await;
                let call = match ready {
                    Ok(call) => call,
                    Err(error) => {
                        return Settlement::new(Err(error), OperationCleanup::Confirmed, ());
                    }
                };
                let retired = lifecycle.observation_retired();
                let result = with_observation_retirement(
                    &call,
                    retired,
                    observe_original_service(
                        &call,
                        service,
                        &self.accepted.import,
                        self.accepted.member,
                        original,
                        after,
                        output,
                        lifecycle,
                        None,
                        None,
                    ),
                )
                .await;
                let root_cleanup = if call.finish().await.is_ok() {
                    OperationCleanup::Confirmed
                } else {
                    OperationCleanup::Unconfirmed
                };
                Settlement::new(result, root_cleanup, RequestOwner::one(call))
            }
            (Implementation::External(owner), RecoveryDescriptor::Native { binding }) => {
                if request.settings != self.accepted.selection.settings {
                    return Settlement::new(
                        Err(Error::Blocked {
                            reason: Box::new(
                                maka_agent_facts::durable::BlockerKind::ExternalTaskUnobservable {
                                    descriptor,
                                },
                            ),
                            diagnostic:
                                "Original native task settings differ from the accepted backend"
                                    .into(),
                        }),
                        OperationCleanup::Confirmed,
                        (),
                    );
                }
                let result = async {
                    match owner
                        .observe_task(
                            request,
                            binding,
                            descriptor,
                            after,
                            expected_prefix,
                            output,
                            Arc::new(NativeBinding(lifecycle.clone())),
                            cancellation,
                        )
                        .await?
                    {
                        external::NativeTaskObservation::Known { outcome } => Ok(outcome),
                        external::NativeTaskObservation::Blocked { reason, diagnostic } => {
                            Err(Error::Blocked {
                                reason: Box::new(reason),
                                diagnostic,
                            })
                        }
                    }
                }
                .await;
                Settlement::new(result, OperationCleanup::Confirmed, ())
            }
            _ => Settlement::new(Err(Error::Unknown), OperationCleanup::Confirmed, ()),
        }
    }
}

struct RequestOwner {
    execution: maka_host_runtime::application::NativeRequest,
    observation: Option<maka_host_runtime::application::NativeRequest>,
}
impl RequestOwner {
    fn one(execution: maka_host_runtime::application::NativeRequest) -> Self {
        Self {
            execution,
            observation: None,
        }
    }
    fn requests(&self) -> impl Iterator<Item = &maka_host_runtime::application::NativeRequest> {
        std::iter::once(&self.execution).chain(self.observation.iter())
    }
    async fn finish(&self) -> OperationCleanup {
        let finished =
            futures_util::future::join_all(self.requests().map(|request| request.finish())).await;
        if finished.iter().all(Result::is_ok) {
            OperationCleanup::Confirmed
        } else {
            OperationCleanup::Unconfirmed
        }
    }
}
impl executor::RootSettlementOwner for RequestOwner {
    fn original_root_cleanup_signal(self: Arc<Self>) -> BoxFuture<'static, ()> {
        Box::pin(async move {
            let settled = futures_util::future::join_all(
                self.requests()
                    .map(|request| request.scope().resources.settle()),
            )
            .await;
            if settled.iter().any(Result::is_err) {
                std::future::pending::<()>().await;
            }
        })
    }
    fn original_root_cleanup(&self) -> OperationCleanup {
        let mut confirmed = true;
        let mut errors = Vec::new();
        for request in self.requests() {
            match request.scope().resources.seal() {
                Ok(true) => (),
                Ok(false) => confirmed = false,
                Err(error) => errors.push(error.to_string()),
            }
        }
        if !errors.is_empty() {
            OperationCleanup::Failed {
                diagnostic: errors.join("; "),
            }
        } else if confirmed {
            OperationCleanup::Confirmed
        } else {
            OperationCleanup::Unconfirmed
        }
    }
}
struct Call {
    service: Box<ServiceBackend>,
    execution: maka_agent_facts::durable::ExecutionIdentity,
    task: maka_agent_facts::durable::ExternalTaskId,
    body: Value,
    floor: maka_sandbox::Sandbox,
    authority: Arc<maka_agent_authority::executor::ExecutorCallContext>,
    import: String,
    member: usize,
    attachments: Vec<maka_agent_facts::attachment::AttachmentRef>,
    binding: Arc<dyn TaskBinding>,
    inputs: Arc<dyn external::Inputs>,
}
fn original_task(call: &Call, reference: maka_plugin_core::operation::RecoveryRef) -> ServiceTask {
    ServiceTask {
        task: call.task,
        execution: call.execution.clone(),
        deployment: call.service.deployment,
        provider: call.service.binding.provider().instance().clone(),
        package: call.service.binding.package().clone(),
        export: call.service.binding.export().into(),
        reference,
    }
}
impl Call {
    fn observation_request(
        &self,
        custody: Arc<dyn maka_plugin_core::work::WorkCustody>,
        retired: CancellationToken,
    ) -> Result<maka_host_runtime::application::NativeRequest, Error> {
        self.service
            .services
            .request_with_work(
                Identity::Agent {
                    execution: self.execution.clone(),
                    operation_id: None,
                },
                retired,
                custody,
            )
            .and_then(|request| request.with_sandbox_floor(&self.floor))
            .map_err(Error::Provider)
    }
}
impl executor::Execution for Call {
    fn execute(
        self: Box<Self>,
        custody: Arc<dyn maka_plugin_core::work::WorkCustody>,
        output: Arc<dyn OutputSink>,
        cancellation: CancellationToken,
    ) -> BoxFuture<'static, Settlement> {
        Box::pin(async move {
            let operation = operation(&self.execution, self.task);
            let request = match self.service.services.request_with_work_and_context(
                Identity::Agent {
                    execution: self.execution.clone(),
                    operation_id: Some(operation.to_string()),
                },
                cancellation,
                custody.clone(),
                self.authority.clone(),
            ) {
                Ok(request) => match request.with_sandbox_floor(&self.floor) {
                    Ok(request) => request,
                    Err(error) => {
                        return Settlement::new(
                            Err(Error::Invalid(error)),
                            OperationCleanup::Confirmed,
                            (),
                        );
                    }
                },
                Err(error) => {
                    return Settlement::new(
                        Err(Error::Provider(error)),
                        OperationCleanup::Confirmed,
                        (),
                    );
                }
            };
            let retired = self.binding.observation_retired();
            let mut observation = None;
            let result = with_observation_retirement(&request, retired.clone(), AssertUnwindSafe(async {
                // An existing original operation is observation only, even when its reply is absent.
                let original = self.service.store.application_intent(self.service.deployment,
                    self.service.consumer.clone(), operation).await.map_err(|error| Error::Persistence(error.to_string()))?;
                if let Some(original) = original {
                    let original = original_task(&self, original.reference);
                    self.binding.bound(RecoveryDescriptor::Service { original: original.clone() }).await?;
                    observation = Some(self.observation_request(custody.clone(), retired.clone())?);
                    let observing = observation.as_ref().expect("just-created observation request");
                    return with_observation_retirement(observing, retired.clone(),
                        observe_original_service(observing, &self.service, &self.import, self.member, &original, 0, output, self.binding.clone(), None, None)).await;
                }
                let (artifacts, scope) = self.inputs.artifacts();
                let resources = attachments::capture(artifacts, scope, &request,
                    &self.execution.session_id, self.attachments.clone()).await.map_err(Error::Invalid)?;
                let mut mutation = request.begin_mutation(&self.import, self.member, "execute".into(),
                    self.body.clone(), operation,
                    serde_json::json!({"protocol":2,"taskId":self.task,"execution":self.execution}), resources
                ).map_err(Error::Provider)?.await.map_err(Error::Provider)?;
                let original = self.service.store.application_intent(self.service.deployment,
                    self.service.consumer.clone(), operation).await.map_err(|error| Error::Persistence(error.to_string()))?
                    .ok_or(Error::Unknown)?;
                let original = original_task(&self, original.reference);
                self.binding.bound(RecoveryDescriptor::Service { original: original.clone() }).await?;
                let mut next = 0;
                let mut delivery_error = None;
                while let Some(value) = mutation.recv().await {
                    if delivery_error.is_some() { continue; }
                    let progress = match serde_json::from_value::<maka_agent_api::executor::IndexedOutput>(value) {
                        Ok(progress) => progress,
                        Err(error) => { delivery_error = Some(ServiceProgressError::Protocol(Error::Invalid(error.to_string()))); continue; }
                    };
                    if progress.index != next { delivery_error = Some(ServiceProgressError::Protocol(Error::Unknown)); continue; }
                    if let Err(error) = progress.output.validate() {
                        delivery_error = Some(ServiceProgressError::Protocol(Error::Invalid(error.into())));
                        continue;
                    }
                    match output.emit(progress.output).await {
                        Ok(()) => next += 1,
                        Err(error) => delivery_error = Some(ServiceProgressError::Delivery(error)),
                    }
                }
                let completion = mutation.completion().await;
                if let Some(error) = delivery_error.as_ref().and_then(ServiceProgressError::root_error) {
                    return Err(error.clone());
                }
                observation = Some(self.observation_request(custody.clone(), retired.clone())?);
                let observing = observation.as_ref().expect("just-created observation request");
                with_observation_retirement(observing, retired.clone(),
                    observe_original_service(observing, &self.service, &self.import, self.member,
                        &original, next, output, self.binding.clone(), Some(completion.reply.receipt), delivery_error)).await
            }).catch_unwind()).await.unwrap_or(Err(Error::Unknown));
            // Transport/dispatch errors after handoff do not prove a failed original job.
            let result = result.map_err(|error| match error {
                Error::Provider(_) => Error::Unknown,
                error => error,
            });
            let owner = RequestOwner {
                execution: request,
                observation,
            };
            let root_cleanup = owner.finish().await;
            Settlement::new(result, root_cleanup, owner)
        })
    }
}
async fn with_observation_retirement<F: std::future::Future>(
    request: &maka_host_runtime::application::NativeRequest,
    retired: CancellationToken,
    future: F,
) -> F::Output {
    let done = CancellationToken::new();
    let work = async {
        let result = future.await;
        done.cancel();
        result
    };
    let watch = async {
        tokio::select! {
            () = retired.cancelled() => request.scope().cancellation.cancel(),
            () = done.cancelled() => (),
        }
    };
    tokio::join!(work, watch).0
}

enum ServiceObservation {
    Missing,
    // Presence survives a fresh read, but an old Unknown is not its answer.
    FoundBeforeRefresh,
    Found {
        state: maka_agent_api::executor::TaskState,
        has_more: bool,
    },
}

enum ServiceProgressError {
    Protocol(Error),
    Delivery(Error),
}
impl ServiceProgressError {
    fn cause(&self) -> &Error {
        match self {
            Self::Protocol(error) | Self::Delivery(error) => error,
        }
    }
    fn root_error(&self) -> Option<&Error> {
        // Provider protocol/delivery faults cannot contradict a committed SDK failure.
        // Local durability and retirement failures still veto its Host ACK.
        match self {
            Self::Delivery(
                error @ (Error::Persistence(_) | Error::ObservationRetired | Error::Retired),
            ) => Some(error),
            Self::Protocol(_) | Self::Delivery(_) => None,
        }
    }
}
struct ServiceProgress {
    next: u64,
    observed: Option<ServiceObservation>,
    error: Option<ServiceProgressError>,
    conflicting_closure: bool,
}

async fn accept_service_closure(
    progress: &ServiceProgress,
    receipt: &Receipt,
    lifecycle: &dyn TaskBinding,
) -> Result<Option<executor::Outcome>, Error> {
    use maka_agent_api::executor::TaskState;
    if lifecycle.observation_retired().is_cancelled() {
        return Err(Error::ObservationRetired);
    }
    if let Some(error) = progress
        .error
        .as_ref()
        .and_then(ServiceProgressError::root_error)
    {
        return Err(error.clone());
    }
    if let Some(error) = &progress.error {
        match receipt {
            Receipt::Recorded {
                outcome:
                    OperationOutcome::Returned {
                        result: OperationResult::Failure { .. },
                    },
                ..
            } => (),
            Receipt::Recorded {
                outcome: OperationOutcome::Unresolved,
                ..
            } => return Ok(None),
            Receipt::Recorded {
                outcome: OperationOutcome::NotExecuted { .. },
                ..
            } => return Err(Error::Unknown),
            _ => return Err(error.cause().clone()),
        }
    }
    let observed = progress.observed.as_ref();
    let closed = match observed {
        Some(ServiceObservation::Found {
            state: TaskState::Closed { outcome },
            has_more,
        }) => Some((outcome, *has_more)),
        _ => None,
    };
    let outcome = match receipt {
        Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: OperationResult::Success { value },
                },
            ..
        } => match closed {
            Some((outcome, false)) => {
                let expected: executor::Outcome = serde_json::from_value(value.clone())
                    .map_err(|error| Error::Invalid(error.to_string()))?;
                if serde_json::to_value(expected)
                    .map_err(|error| Error::Invalid(error.to_string()))?
                    != serde_json::to_value(outcome)
                        .map_err(|error| Error::Invalid(error.to_string()))?
                {
                    return Err(Error::Unknown);
                }
                outcome.clone()
            }
            _ => {
                return match observed {
                    Some(
                        ServiceObservation::Missing
                        | ServiceObservation::Found {
                            state: TaskState::Unknown { .. },
                            ..
                        },
                    ) => Err(Error::Unknown),
                    _ => Ok(None),
                };
            }
        },
        Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: OperationResult::Failure { diagnostic },
                },
            ..
        } => {
            if progress.conflicting_closure
                || closed.is_some_and(|(outcome, _)| {
                    !matches!(outcome, executor::Outcome::Failed { .. })
                })
            {
                return Err(Error::Unknown);
            }
            executor::Outcome::Failed {
                message: diagnostic.clone(),
                code: None,
                recoverable: false,
            }
        }
        Receipt::Recorded {
            outcome: OperationOutcome::Unknown { .. },
            ..
        } => match closed {
            Some((outcome, false)) => outcome.clone(),
            _ => {
                return match observed {
                    Some(
                        ServiceObservation::Missing
                        | ServiceObservation::Found {
                            state: TaskState::Unknown { .. },
                            ..
                        },
                    ) => Err(Error::Unknown),
                    _ => Ok(None),
                };
            }
        },
        Receipt::Recorded {
            outcome:
                OperationOutcome::NotExecuted {
                    proof:
                        maka_plugin_core::operation::NotExecutedProof::ProviderPreventedBeforeStart,
                },
            cleanup,
        } => {
            if progress.next != 0
                || matches!(
                    observed,
                    Some(ServiceObservation::Found { .. } | ServiceObservation::FoundBeforeRefresh)
                )
            {
                return Err(Error::Unknown);
            }
            let outcome = if lifecycle.stop_requested().await? {
                executor::Outcome::Cancelled {
                    reason: Some("Executor provider prevented before dispatch".into()),
                }
            } else {
                executor::Outcome::Failed {
                    message: "Executor provider prevented before dispatch".into(),
                    code: None,
                    recoverable: false,
                }
            };
            // This exact execute is the only Task creator, and its provider fenced handler entry.
            if *cleanup == OperationCleanup::Confirmed {
                lifecycle.cleanup(OperationCleanup::Confirmed).await?;
            }
            outcome
        }
        Receipt::Recorded {
            outcome: OperationOutcome::Unresolved,
            ..
        } => return Ok(None),
        Receipt::NotRecorded | Receipt::Unavailable { .. } => return Err(Error::Unknown),
    };
    lifecycle.closed(outcome.clone()).await?;
    Ok(Some(outcome))
}

#[expect(
    clippy::too_many_arguments,
    reason = "Original service observation binds the exact service, task cursor, output, lifecycle and prior receipt"
)]
async fn observe_original_service(
    request: &maka_host_runtime::application::NativeRequest,
    service: &ServiceBackend,
    import: &str,
    member: usize,
    original: &ServiceTask,
    after: u64,
    output: Arc<dyn OutputSink>,
    lifecycle: Arc<dyn TaskBinding>,
    receipt: Option<Receipt>,
    progress_error: Option<ServiceProgressError>,
) -> Result<executor::Outcome, Error> {
    let key = operation(&original.execution, original.task);
    let intent = service
        .store
        .application_intent(service.deployment, service.consumer.clone(), key)
        .await
        .map_err(|error| Error::Persistence(error.to_string()))?
        .ok_or(Error::Unknown)?;
    if intent.reference != original.reference
        || intent.caller.deployment != service.deployment
        || intent.consumer != service.consumer
        || original.deployment != service.deployment
        || original.provider != *service.binding.provider().instance()
        || original.package != *service.binding.package()
        || original.export != service.binding.export()
        || original.reference.operation != key
        || original.reference.namespace != original.provider
        || original.reference.export != original.export
        || original.reference.method != "execute"
        || intent.recovery
            != serde_json::json!({
                "protocol":2, "taskId":original.task, "execution":original.execution,
            })
    {
        return Err(Error::Unknown);
    }
    observe_service(
        request,
        &service.store,
        import,
        member,
        original,
        after,
        output,
        lifecycle,
        receipt,
        progress_error,
    )
    .await
}

#[expect(
    clippy::too_many_arguments,
    reason = "Service observation binds the exact Root, service, task cursor, output, lifecycle and prior receipt"
)]
async fn observe_service(
    request: &maka_host_runtime::application::NativeRequest,
    store: &RootStore,
    import: &str,
    member: usize,
    original: &ServiceTask,
    next: u64,
    output: Arc<dyn OutputSink>,
    lifecycle: Arc<dyn TaskBinding>,
    receipt: Option<Receipt>,
    progress_error: Option<ServiceProgressError>,
) -> Result<executor::Outcome, Error> {
    use maka_agent_api::executor::{Observe, TaskObservation, TaskState};
    use maka_host_runtime::application::Subscription;

    enum Source {
        Unopened,
        Admitting {
            admission: BoxFuture<'static, Result<Subscription, String>>,
            unresolved_at_open: bool,
        },
        Reading {
            subscription: Subscription,
            unresolved_at_open: bool,
        },
        Waiting {
            refresh_after_resolution: bool,
            error: Option<Error>,
        },
        Failed,
    }
    enum Event {
        Admitted(Result<Subscription, String>),
        Observed(Option<Value>),
    }
    impl Source {
        async fn next(&mut self) -> Event {
            match self {
                Self::Admitting { admission, .. } => Event::Admitted(admission.await),
                Self::Reading { subscription, .. } => Event::Observed(subscription.recv().await),
                Self::Unopened | Self::Waiting { .. } | Self::Failed => {
                    std::future::pending().await
                }
            }
        }
    }

    let known_outcome = |receipt: &Receipt| {
        matches!(
            receipt,
            Receipt::Recorded {
                outcome: OperationOutcome::Returned { .. } | OperationOutcome::NotExecuted { .. },
                ..
            }
        )
    };
    let unresolved = |receipt: &Receipt| {
        matches!(
            receipt,
            Receipt::Recorded {
                outcome: OperationOutcome::Unresolved,
                ..
            }
        )
    };
    let retired = lifecycle.observation_retired();
    let mut changes = store.subscribe_changes();
    changes.borrow_and_update();
    let mut latest = match receipt {
        Some(receipt) if known_outcome(&receipt) => receipt,
        Some(_) | None => original_service_receipt(request, original).await?,
    };
    let mut source = Source::Unopened;
    let mut progress = ServiceProgress {
        next,
        observed: None,
        error: progress_error,
        conflicting_closure: false,
    };
    loop {
        if retired.is_cancelled() {
            return Err(Error::ObservationRetired);
        }
        if let Some(changed) = changes.changed().now_or_never() {
            changed.map_err(|error| Error::Persistence(error.to_string()))?;
            changes.borrow_and_update();
            if !known_outcome(&latest) {
                latest = original_service_receipt(request, original).await?;
            }
        }
        let complete_page = matches!(
            &progress.observed,
            Some(ServiceObservation::Found {
                state: TaskState::Closed { .. },
                has_more: false
            })
        );
        // Only an original Unresolved read can refresh; its replacement opens stable.
        let refreshing = matches!(
            &source,
            Source::Waiting {
                refresh_after_resolution: true,
                ..
            }
        ) && !unresolved(&latest)
            && !complete_page;
        let fresh_source = matches!(&source, Source::Unopened) || refreshing;
        if fresh_source {
            let admission = request.subscribe(
                import,
                member,
                "observe".into(),
                serde_json::to_value(Observe {
                    task_id: original.task,
                    after_index: Some(progress.next),
                })
                .map_err(|error| Error::Invalid(error.to_string()))?,
                maka_capabilities::call::Attachments::default(),
            );
            source = Source::Admitting {
                admission: match admission {
                    Ok(admission) => admission,
                    Err(error) => futures_util::future::ready(Err(error)).boxed(),
                },
                unresolved_at_open: unresolved(&latest),
            };
            if refreshing {
                progress.observed = match progress.observed.take() {
                    Some(
                        ServiceObservation::Found { .. } | ServiceObservation::FoundBeforeRefresh,
                    ) => Some(ServiceObservation::FoundBeforeRefresh),
                    Some(ServiceObservation::Missing) | None => None,
                };
            }
        }

        // Ready admission/items may supply a conflict or physical proof; Known failure never waits for them.
        let event = match source.next().now_or_never() {
            Some(event) => event,
            None => {
                if let Some(outcome) =
                    accept_service_closure(&progress, &latest, lifecycle.as_ref()).await?
                {
                    return Ok(outcome);
                }
                if !unresolved(&latest) {
                    if let Source::Waiting {
                        error: Some(error), ..
                    } = &source
                    {
                        return Err(error.clone());
                    }
                    if matches!(&source, Source::Waiting { .. } | Source::Failed) {
                        return Err(Error::Unknown);
                    }
                }
                tokio::select! {
                    biased;
                    () = retired.cancelled() => return Err(Error::ObservationRetired),
                    () = request.scope().cancellation.cancelled() => return Err(Error::Cancelled),
                    changed = changes.changed() => {
                        changed.map_err(|error| Error::Persistence(error.to_string()))?;
                        changes.borrow_and_update();
                        if !known_outcome(&latest) {
                            latest = original_service_receipt(request, original).await?;
                        }
                        continue;
                    }
                    event = source.next() => event,
                }
            }
        };
        match event {
            Event::Admitted(Ok(subscription)) => {
                let Source::Admitting {
                    unresolved_at_open, ..
                } = &source
                else {
                    unreachable!("only an opening source produces admission");
                };
                source = Source::Reading {
                    subscription,
                    unresolved_at_open: *unresolved_at_open,
                };
            }
            Event::Admitted(Err(error)) => {
                let Source::Admitting {
                    unresolved_at_open, ..
                } = &source
                else {
                    unreachable!("only an opening source produces admission");
                };
                source = Source::Waiting {
                    refresh_after_resolution: *unresolved_at_open,
                    error: Some(Error::Provider(error)),
                };
                if !known_outcome(&latest) {
                    changes.borrow_and_update();
                    latest = original_service_receipt(request, original).await?;
                }
            }
            Event::Observed(value) => {
                let Source::Reading {
                    unresolved_at_open, ..
                } = &source
                else {
                    unreachable!("only an admitted source produces observations");
                };
                let refresh_after_resolution = *unresolved_at_open;
                let Some(value) = value else {
                    source = Source::Waiting {
                        refresh_after_resolution,
                        error: Some(Error::Unknown),
                    };
                    continue;
                };
                let page: TaskObservation = match serde_json::from_value(value) {
                    Ok(page) => page,
                    Err(error) => {
                        progress.error.get_or_insert(ServiceProgressError::Protocol(
                            Error::Invalid(error.to_string()),
                        ));
                        source = Source::Failed;
                        continue;
                    }
                };
                match page {
                    TaskObservation::Missing => {
                        if progress.observed.is_none() {
                            progress.observed = Some(ServiceObservation::Missing);
                        }
                        source = Source::Waiting {
                            refresh_after_resolution,
                            error: None,
                        };
                        continue;
                    }
                    TaskObservation::Found {
                        task_id,
                        observed: through,
                        has_more,
                        outputs,
                        state,
                        cleanup,
                    } => {
                        if task_id != original.task {
                            progress
                                .error
                                .get_or_insert(ServiceProgressError::Protocol(Error::Unknown));
                            source = Source::Failed;
                            continue;
                        }
                        if matches!(
                            &latest,
                            Receipt::Recorded {
                                outcome: OperationOutcome::NotExecuted { .. },
                                ..
                            }
                        ) {
                            return Err(Error::Unknown);
                        }
                        if matches!(&state, TaskState::Closed { outcome } if !matches!(outcome, executor::Outcome::Failed { .. }))
                        {
                            progress.conflicting_closure = true;
                        }
                        if outputs.len() > 256
                            || progress.next.checked_add(outputs.len() as u64) != Some(through)
                            || outputs
                                .iter()
                                .zip(progress.next..through)
                                .any(|(record, index)| record.index != index)
                        {
                            progress
                                .error
                                .get_or_insert(ServiceProgressError::Protocol(Error::Unknown));
                            source = Source::Failed;
                            continue;
                        }
                        lifecycle.cleanup(cleanup).await?;
                        if progress.error.is_none() {
                            for record in outputs {
                                if let Err(error) = record.output.validate() {
                                    progress.error = Some(ServiceProgressError::Protocol(
                                        Error::Invalid(error.into()),
                                    ));
                                    break;
                                }
                                if let Err(error) = output.emit(record.output).await {
                                    progress.error = Some(ServiceProgressError::Delivery(error));
                                    break;
                                }
                                progress.next += 1;
                            }
                        }
                        if progress.error.is_some() {
                            source = Source::Failed;
                        } else {
                            let wait = !has_more && matches!(&state, TaskState::Closed { .. })
                                || matches!(&state, TaskState::Unknown { .. });
                            progress.observed = Some(ServiceObservation::Found { state, has_more });
                            if wait {
                                source = Source::Waiting {
                                    refresh_after_resolution,
                                    error: None,
                                };
                                if refresh_after_resolution
                                    && matches!(
                                        &progress.observed,
                                        Some(ServiceObservation::Found {
                                            state: TaskState::Unknown { .. },
                                            ..
                                        })
                                    )
                                {
                                    continue;
                                }
                            }
                        }
                    }
                }
                if let Some(outcome) =
                    accept_service_closure(&progress, &latest, lifecycle.as_ref()).await?
                {
                    return Ok(outcome);
                }
            }
        }
    }
}
async fn original_service_receipt(
    request: &maka_host_runtime::application::NativeRequest,
    original: &ServiceTask,
) -> Result<Receipt, Error> {
    let latest = request
        .recover(original.reference.clone())
        .map_err(Error::Provider)?
        .await
        .map_err(Error::Provider)?;
    match latest {
        Some(latest) if latest.reference == original.reference => Ok(Receipt::Recorded {
            outcome: latest.outcome,
            cleanup: latest.cleanup,
        }),
        Some(_) => Err(Error::Unknown),
        None => Ok(Receipt::NotRecorded),
    }
}
fn operation(
    execution: &maka_agent_facts::durable::ExecutionIdentity,
    task: maka_agent_facts::durable::ExternalTaskId,
) -> Uuid {
    Uuid::from_bytes(
        Sha256::digest(
            serde_json::to_vec(&("maka.agent.executor.v2", execution, task))
                .expect("executor operation identity"),
        )[..16]
            .try_into()
            .expect("UUID digest"),
    )
}
