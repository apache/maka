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

//! Isolated private protocol tasks. Their original worker settles the process
//! group on cancellation, independently of the observer and its replies.
use super::*;
use maka_agent_authority::executor::Error as ExecutorError;
use maka_agent_authority::executor::ExecutorCallContext;
use maka_agent_authority::setup::ActualSetupContext;
use maka_plugin_core::runtime::Activation;
use maka_plugin_core::{
    composition::InstanceId,
    deployment::DeploymentRef,
    operation::{OperationCleanup, RecoveryProtocol, RecoveryRef},
    plan::RemoteCapability,
};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

mod worker;
use maka_workspace_api::protocol::{
    CHUNK_BYTES, Close, Completion, EXPORT, Input, Launch, Observation, Observe, Progress, Run,
    Stream, Written, contract,
};
pub(super) fn provide(registry: &mut NativeRegistry) -> Result<(), String> {
    registry.insert(
        maka_workspace_api::protocol::IMPLEMENTATION.into(),
        Arc::new(|context, input| {
            Box::pin(async move {
                let source = context
                    .persistence()
                    .map(|persistence| persistence.source().clone());
                let namespace = context.activation().instance().clone();
                match Processes::open(context, input).await {
                    Ok(owner) => NativeActivation {
                        exports: Ok(BTreeMap::from([(
                            EXPORT.into(),
                            maka_plugin_core::runtime::Published {
                                contract: contract(),
                                value: Arc::new(Service {
                                    owner: owner.clone(),
                                    source: source.expect("process persistence validated"),
                                    namespace,
                                }) as Arc<dyn Handler>,
                            },
                        )])),
                        owner: Arc::new(super::Service(owner)),
                    },
                    Err(error) => NativeActivation {
                        exports: Err(error),
                        owner: Arc::new(()),
                    },
                }
            })
        }),
    )
}
#[derive(Clone)]
enum Role {
    Runtime(Arc<ExecutorCallContext>),
    Setup(Arc<ActualSetupContext>),
}
impl Role {
    fn same(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Runtime(a), Self::Runtime(b)) => Arc::ptr_eq(a, b),
            (Self::Setup(a), Self::Setup(b)) => Arc::ptr_eq(a, b),
            _ => false,
        }
    }
    async fn validate(&self, context: &Context) -> Result<(), HandlerError> {
        match self {
            Self::Runtime(access) => access.0.validate(context).await.map_err(diagnostic),
            Self::Setup(access) => access.0.validate(context).await.map_err(diagnostic),
        }
    }
    async fn prepare(
        &self,
        context: &Context,
        selected: &maka_process::Command,
    ) -> Result<maka_process::isolated::TaskOwner, HandlerError> {
        match self {
            Self::Runtime(access) => access
                .0
                .prepare_private_task(context, selected)
                .await
                .map_err(diagnostic),
            Self::Setup(access) => access
                .0
                .prepare_private_process(context, selected)
                .await
                .map_err(diagnostic),
        }
    }
}
struct Write {
    bytes: Option<Vec<u8>>,
    reply: oneshot::Sender<Result<Written, String>>,
}
struct Control {
    consumer: Activation,
    authority: Role,
    input: mpsc::Sender<Write>,
    close: mpsc::Sender<oneshot::Sender<Result<Written, String>>>,
}
#[derive(Default)]
pub(super) struct Controls(Mutex<BTreeMap<Uuid, Arc<Control>>>);
struct ControlResidency<'a> {
    controls: &'a Controls,
    id: Uuid,
}
impl Drop for ControlResidency<'_> {
    fn drop(&mut self) {
        self.controls.0.lock().unwrap().remove(&self.id);
    }
}
pub(super) struct Service {
    owner: Arc<Processes>,
    source: DeploymentRef,
    namespace: InstanceId,
}

// Stable ownership observations, not a serializable Activation or a live grant.
#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
enum Origin {
    Local(InstanceId),
    Remote(RemoteCapability),
}
impl Origin {
    fn of(actual: &Activation) -> Self {
        match actual.remote_target() {
            Some(target) => Self::Remote(target.clone()),
            None => Self::Local(actual.instance().clone()),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Source {
    Runtime {
        #[serde(rename = "taskId")]
        task_id: maka_agent_facts::durable::ExternalTaskId,
        execution: maka_agent_facts::durable::ExecutionIdentity,
    },
    Setup {
        operation: RecoveryRef,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u32,
    id: Uuid,
    source: Source,
    resource_ref: String,
    operation: RecoveryRef,
    consumer: Origin,
}

fn record_namespace() -> Result<maka_plugin_core::storage::Namespace, HandlerError> {
    maka_plugin_core::storage::Namespace::new(
        maka_workspace_api::protocol::IMPLEMENTATION,
        maka_plugin_core::scope::Scope::Profile,
    )
    .map_err(diagnostic)
}

impl Handler for Service {
    fn call(
        &self,
        method: String,
        value: Value,
        context: Context,
    ) -> BoxFuture<'static, HandlerResult> {
        let owner = self.owner.clone();
        let source = self.source.clone();
        let namespace = self.namespace.clone();
        Box::pin(async move {
            let provider = Service {
                owner: owner.clone(),
                source,
                namespace,
            };
            if method == "observe" {
                let input: Observe = serde_json::from_value(value).map_err(diagnostic)?;
                return provider.observe(input, &context).await;
            }
            let original = context.operation().ok_or("protocol_requires_mutation")?;
            if matches!(method.as_str(), "run" | "launch") {
                provider.validate_original(original)?;
                if original.method != method {
                    return Err("Protocol method differs from its original dispatch".into());
                }
            }
            let authority = authority(&context)?;
            // Setup cleanup is restricted to the captured original Control;
            // cancelled setup cannot prepare or input a new process.
            if method != "close" || matches!(&authority, Role::Runtime(_)) {
                authority.validate(&context).await?;
            }
            let value = match method.as_str() {
                "run" => {
                    let input: Run = serde_json::from_value(value).map_err(diagnostic)?;
                    if input.additional_permissions.is_some() || input.justification.is_some() {
                        return Err(unavailable(
                            "Protocol tasks use the actual executor ceiling; serialized additional permissions cannot elevate it",
                        ));
                    }
                    return owner
                        .run_protocol(input.executable, input.args, input.env, authority, &context)
                        .await;
                }
                "launch" => {
                    let input: Launch = serde_json::from_value(value).map_err(diagnostic)?;
                    return owner
                        .run_protocol(input.executable, input.args, input.env, authority, &context)
                        .await;
                }
                "input" => {
                    let input: Input = serde_json::from_value(value).map_err(diagnostic)?;
                    if input
                        .bytes
                        .as_ref()
                        .is_some_and(|bytes| bytes.len() > CHUNK_BYTES)
                    {
                        return Err("Protocol input exceeds 8 KiB".into());
                    }
                    if input.additional_permissions.is_some() || input.justification.is_some() {
                        return Err(unavailable(
                            "Protocol input cannot reconstruct additional permissions",
                        ));
                    }
                    let control = owner.protocol_control(input.id, &authority, &context)?;
                    let (reply, result) = oneshot::channel();
                    control
                        .input
                        .send(Write {
                            bytes: input.bytes,
                            reply,
                        })
                        .await
                        .map_err(diagnostic)?;
                    serde_json::to_value(
                        result
                            .await
                            .map_err(diagnostic)?
                            .map_err(HandlerError::from)?,
                    )
                    .map_err(diagnostic)?
                }
                "close" => {
                    let input: Close = serde_json::from_value(value).map_err(diagnostic)?;
                    let control = owner.protocol_control(input.id, &authority, &context)?;
                    let (reply, result) = oneshot::channel();
                    control.close.send(reply).await.map_err(diagnostic)?;
                    serde_json::to_value(
                        result
                            .await
                            .map_err(diagnostic)?
                            .map_err(HandlerError::from)?,
                    )
                    .map_err(diagnostic)?
                }
                _ => return Err("protocol_method_unavailable".into()),
            };
            Ok(HandlerValue::Json(value))
        })
    }
}
impl Service {
    fn validate_original(&self, original: &RecoveryRef) -> Result<(), HandlerError> {
        original.validate().map_err(diagnostic)?;
        let expected = contract();
        if original.source.state_domain != self.source.state_domain
            || original.source.deployment != self.source.deployment
            || original.namespace != self.namespace
            || original.export != EXPORT
            || !matches!(original.method.as_str(), "run" | "launch")
            || original.contract.name != expected.name
            || original.contract.version != expected.version
            || original.contract.transport != expected.transport
            || original.recovery != RecoveryProtocol::JournalV1
        {
            return Err(unavailable(
                "Original protocol reference belongs to another provider or contract",
            ));
        }
        Ok(())
    }

    async fn observe(&self, input: Observe, context: &Context) -> HandlerResult {
        use maka_process::isolated::{
            self, CleanupEvidence, Descriptor, EvidenceInterest, EvidenceWatch,
        };

        self.validate_original(&input.original)?;
        let entry = self
            .owner
            .store
            .plugin_data(
                &record_namespace()?,
                &format!("{}protocol/{}", self.owner.prefix, input.original.operation),
            )
            .await
            .map_err(diagnostic)?;
        let value = entry
            .and_then(|entry| match entry.data {
                maka_plugin_core::storage::Data::Present(value) => Some(value),
                maka_plugin_core::storage::Data::Deleted => None,
            })
            .ok_or_else(|| unavailable("Original protocol resource record is unavailable"))?;
        let record: Record = serde_json::from_value(value).map_err(diagnostic)?;
        if record.version != 1
            || record.id != input.original.operation
            || record.operation != input.original
            || record.consumer != Origin::of(context.requester())
        {
            return Err(unavailable(
                "Protocol cleanup observation does not own this original resource",
            ));
        }
        if context.scope().cancellation.is_cancelled() {
            return Ok(HandlerValue::Json(Value::Null));
        }
        let descriptor = Descriptor {
            resource_ref: record.resource_ref.clone().into(),
        };
        let mut custody = context.scope().resources.reserve().map_err(diagnostic)?;
        custody.start();
        // Subscribe before reading the level; only the immutable provider record
        // selects the protected resource, never a caller-supplied descriptor.
        let mut watch = match EvidenceWatch::open(&descriptor, EvidenceInterest::Cleanup).await {
            Ok(watch) => watch,
            Err(error) => {
                custody.complete(Ok(()));
                return Err(diagnostic(error));
            }
        };
        let result = async {
            let mut previous = None;
            loop {
                if context.scope().cancellation.is_cancelled() || self.owner.drain.is_cancelled() {
                    return Ok(HandlerValue::Json(Value::Null));
                }
                // Do not cancel this actual read: its blocking worker must finish
                // before this request can close its own resource fence.
                let cleanup = match isolated::cleanup_evidence(&descriptor).await.map_err(diagnostic)? {
                    Some(CleanupEvidence::NeverLaunched { .. } | CleanupEvidence::GroupClosed { .. }) => OperationCleanup::Confirmed,
                    None => OperationCleanup::Unconfirmed,
                };
                if context.scope().cancellation.is_cancelled() { return Ok(HandlerValue::Json(Value::Null)); }
                if previous.as_ref() != Some(&cleanup) {
                    context.emit(serde_json::to_value(Observation {
                        original: record.operation.clone(), id: record.id, cleanup: cleanup.clone(),
                    }).map_err(diagnostic)?).await?;
                    previous = Some(cleanup.clone());
                }
                if cleanup == OperationCleanup::Confirmed { return Ok(HandlerValue::Json(Value::Null)); }
                tokio::select! {
                    biased;
                    () = context.scope().cancellation.cancelled() => return Ok(HandlerValue::Json(Value::Null)),
                    () = self.owner.drain.cancelled() => return Ok(HandlerValue::Json(Value::Null)),
                    changed = watch.changed() => { changed.map_err(diagnostic)?; },
                }
            }
        }.await;
        match watch.close().await {
            Ok(()) => {
                custody.complete(Ok(()));
                result
            }
            Err(error) => {
                let diagnostic = error.to_string();
                custody.unconfirmed(diagnostic.clone(), (record, descriptor));
                result?;
                Err(HandlerError::Unknown { diagnostic })
            }
        }
    }
}

fn authority(context: &Context) -> Result<Role, HandlerError> {
    if let Some(access) = context.native_context::<ExecutorCallContext>() {
        return Ok(Role::Runtime(access));
    }
    if let Some(access) = context.native_context::<ActualSetupContext>() {
        if context.work_custody().is_some() {
            return Err(unavailable("Setup cannot borrow Agent work custody"));
        }
        return Ok(Role::Setup(access));
    }
    Err(unavailable(
        "Protocol process requires its original native Runtime or Setup capability",
    ))
}

fn unavailable(message: &str) -> HandlerError {
    ExecutorError::IsolationUnavailable(message.into())
        .to_string()
        .into()
}
fn diagnostic(error: impl std::fmt::Display) -> HandlerError {
    error.to_string().into()
}
impl Processes {
    fn protocol_control(
        &self,
        id: Uuid,
        authority: &Role,
        context: &Context,
    ) -> Result<Arc<Control>, HandlerError> {
        let control = self
            .protocol
            .0
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or("Protocol task is not live in this provider")?;
        if &control.consumer != context.requester() || !control.authority.same(authority) {
            return Err("Protocol task belongs to another original executor call".into());
        }
        Ok(control)
    }
    async fn run_protocol(
        &self,
        executable: String,
        args: Vec<String>,
        env: BTreeMap<String, String>,
        authority: Role,
        context: &Context,
    ) -> HandlerResult {
        if self.drain.is_cancelled() {
            return Err("Protocol provider is draining".into());
        }
        let specification = maka_capabilities::process::Command {
            executable,
            args,
            env,
            lifetime: maka_capabilities::process::Lifetime::Invocation,
        };
        specification.validate().map_err(diagnostic)?;
        let mut command = maka_process::Command::private_task(specification.executable);
        for argument in specification.args {
            command.arg(argument);
        }
        for (key, value) in specification.env {
            command.env(key, value);
        }
        let isolated = authority.prepare(context, &command).await?;
        let descriptor = isolated.descriptor();
        let resource_ref = descriptor
            .resource_ref
            .to_str()
            .ok_or("Private protocol resource path is not UTF-8")?
            .to_owned();
        let original = context.operation().expect("protocol mutation checked");
        let id = original.operation;
        // The resource receipt is provider bookkeeping. The helper owns durable
        // stdin/stdout/stderr and its private workspace outside the Root.
        let namespace = record_namespace()?;
        let source = match &authority {
            Role::Runtime(access) => Source::Runtime {
                task_id: access.0.task_id(),
                execution: access.0.execution().clone(),
            },
            Role::Setup(_) => Source::Setup {
                operation: original.clone(),
            },
        };
        let record = Record {
            version: 1,
            id,
            source,
            resource_ref: resource_ref.clone(),
            operation: original.clone(),
            consumer: Origin::of(context.requester()),
        };
        self.store
            .plugin_data_batch(
                &namespace,
                vec![maka_plugin_core::storage::Mutation {
                    key: format!("{}protocol/{id}", self.prefix),
                    expected_revision: None,
                    data: maka_plugin_core::storage::Data::Present(
                        serde_json::to_value(record).map_err(diagnostic)?,
                    ),
                }],
            )
            .await
            .map_err(diagnostic)?;
        let (input, receive) = mpsc::channel(8);
        let (close, closing) = mpsc::channel(1);
        let control = Arc::new(Control {
            consumer: context.requester().clone(),
            authority: authority.clone(),
            input,
            close,
        });
        {
            let mut controls = self.protocol.0.lock().unwrap();
            if controls.len() >= 32 {
                return Err("Protocol process capacity exhausted".into());
            }
            controls.insert(id, control);
        }
        let _residency = ControlResidency {
            controls: &self.protocol,
            id,
        };
        worker::run(
            self,
            context,
            id,
            resource_ref,
            isolated,
            authority,
            command,
            receive,
            closing,
        )
        .await
    }
}
