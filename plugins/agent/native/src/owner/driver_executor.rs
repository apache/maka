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

//! Native ownership of an original external task, independent of model attempts.
use crate::executor::{Accepted, Backend, RecoveryDescriptor, TaskBinding, external::Inputs};
use futures_util::{FutureExt, future::BoxFuture, stream};
use maka_agent_authority::{
    executor::{ExecutorAccess, ExecutorCallContext},
    permissions::Access,
};
use maka_agent_engine::{
    ExternalCleanupPublication, ExternalWitness, RunError, cleanup::Evidence, ports::*,
};
use maka_agent_facts::{
    durable::*,
    executor::{NATIVE_TASK_PROTOCOL, TaskDescriptor},
    input::RunInput,
};
use maka_agent_ports::executor::{Error, Outcome, OutputSink, Request, Settlement};
use maka_agent_state::{ContentBlob, Store, fold::RunView};
use maka_host_runtime::application::{Binding, Context};
use maka_plugin_core::operation::OperationCleanup;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use std::{panic::AssertUnwindSafe, sync::Arc};
use tokio::sync::{Mutex, mpsc};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

pub(super) struct DriverExecutor {
    pub state: Store,
    pub state_root: std::path::PathBuf,
    pub backend: Backend,
    pub access: Arc<super::access::RunAccess>,
    pub inputs: Arc<dyn Inputs>,
    pub instructions: Option<String>,
    pub cancellation: CancellationToken,
    pub root_observation: CancellationToken,
    pub prepared_private: Mutex<Option<PrivatePreparation>>,
    pub candidate_capture: std::sync::OnceLock<maka_process::isolated::CandidateCapture>,
    pub publication:
        tokio::sync::OnceCell<Arc<super::driver_executor_publication::calls::LivePublication>>,
    pub cleanup: Evidence,
    pub workers: TaskTracker,
    /// Actual accepted owners, not a second durable task registry.
    pub retained: Arc<Mutex<Vec<RetainedSource>>>,
}
pub(super) enum RetainedSource {
    Resources(Settlement),
    Cleanup(Arc<ExternalCleanupPublication>),
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FrozenInput {
    accepted: Accepted,
    request: Request,
    recovery: Option<RecoveryDescriptor>,
    private_resource: maka_process::isolated::Descriptor,
    publication: Option<ExternalPublicationId>,
}
#[derive(Serialize)]
struct PublicationSource {
    resource: maka_process::isolated::Descriptor,
    original_task_descriptor: ContentRef,
}
struct Publications {
    send: mpsc::Sender<Result<FactId, RunError>>,
    witness: ExternalWitness,
    publication_source: Option<PendingExternalPublication>,
    authority: Option<Arc<dyn ExecutorAccess>>,
    publication: Mutex<PublicationState>,
    frozen: TaskDescriptor<FrozenInput>,
    state: Store,
    root_observation: CancellationToken,
    owner_stop: CancellationToken,
    cleanup_proof: Mutex<OperationCleanup>,
    retained: Arc<Mutex<Vec<RetainedSource>>>,
}
type TaskClosure = (Terminal, Option<String>, Option<ExternalFinalMessage>);
enum MessageState {
    Open,
    Ended(FactId),
    Violated,
}
struct PublicationState {
    cursor: u64,
    messages: std::collections::BTreeMap<String, MessageState>,
    closed: Option<TaskClosure>,
}
enum MessageEvent {
    Start(String),
    Delta(String),
    End(String),
}
impl MessageEvent {
    fn from_output(output: &maka_agent_facts::executor::Output) -> Option<Self> {
        use maka_agent_facts::executor::Output;
        Some(match output {
            Output::MessageStart { message_id } => Self::Start(message_id.clone()),
            Output::OutputDelta { message_id, .. } | Output::ThinkingDelta { message_id, .. } => {
                Self::Delta(message_id.clone())
            }
            Output::MessageEnd { message_id } => Self::End(message_id.clone()),
            _ => return None,
        })
    }
}
fn observe_message(
    messages: &mut std::collections::BTreeMap<String, MessageState>,
    event: MessageEvent,
    fact: FactId,
) {
    use std::collections::btree_map::Entry;
    let message = match &event {
        MessageEvent::Start(message)
        | MessageEvent::Delta(message)
        | MessageEvent::End(message) => message,
    };
    match messages.entry(message.clone()) {
        Entry::Vacant(entry) => {
            entry.insert(if matches!(event, MessageEvent::Start(_)) {
                MessageState::Open
            } else {
                MessageState::Violated
            });
        }
        Entry::Occupied(mut entry) => {
            if matches!(event, MessageEvent::Start(_)) || !matches!(entry.get(), MessageState::Open)
            {
                entry.insert(MessageState::Violated);
            } else if matches!(event, MessageEvent::End(_)) {
                entry.insert(MessageState::Ended(fact));
            }
        }
    }
}
impl PublicationState {
    fn complete(&self, message_id: Option<String>) -> TaskClosure {
        let final_message = match message_id {
            Some(message_id) => match self.messages.get(&message_id) {
                Some(MessageState::Ended(end)) => Some(ExternalFinalMessage {
                    message_id,
                    end: *end,
                }),
                _ => {
                    return Self::rejected(format!(
                        "final message {message_id:?} has no valid MessageEnd"
                    ));
                }
            },
            None => None,
        };
        for (message, state) in &self.messages {
            match state {
                MessageState::Open => {
                    return Self::rejected(format!("message {message:?} is not ended"));
                }
                MessageState::Violated => {
                    return Self::rejected(format!(
                        "message {message:?} has an invalid output lifecycle"
                    ));
                }
                MessageState::Ended(_) => {}
            }
        }
        (Terminal::Completed, None, final_message)
    }
    fn rejected(reason: String) -> TaskClosure {
        (
            Terminal::Failed,
            Some(format!(
                "Host rejected invalid executor completion: {reason}"
            )),
            None,
        )
    }
}
impl Publications {
    async fn publish(&self, observation: ExternalObservation) -> Result<(), Error> {
        let mut publication = self.publication.lock().await;
        self.publish_locked(&mut publication, observation).await
    }
    async fn publish_locked(
        &self,
        publication: &mut PublicationState,
        observation: ExternalObservation,
    ) -> Result<(), Error> {
        let output = matches!(&observation, ExternalObservation::Output(_));
        if output && publication.closed.is_some() {
            return Err(Error::Invalid(
                "executor output after canonical closure".into(),
            ));
        }
        let message = match &observation {
            ExternalObservation::Output(output) => MessageEvent::from_output(output),
            _ => None,
        };
        let next = if output {
            publication
                .cursor
                .checked_add(1)
                .ok_or_else(|| Error::Invalid("external output index overflow".into()))?
        } else {
            publication.cursor
        };
        let fact = self
            .witness
            .record(
                publication.cursor,
                observation,
                UnixMillis(super::now().try_into().expect("Unix milliseconds")),
            )
            .await
            .map_err(|error| Error::Persistence(error.to_string()))?;
        publication.cursor = next;
        if let Some(message) = message {
            observe_message(&mut publication.messages, message, fact);
        }
        // The receipt is durable; notification loss does not change its outcome.
        let _ = self.send.try_send(Ok(fact));
        Ok(())
    }
    async fn accepted(&self) -> bool {
        self.publication.lock().await.closed.is_some()
    }
    async fn closed_in_store(&self, closure: &TaskClosure) -> Result<bool, Error> {
        let request = &self.frozen.payload.request;
        let view = self
            .state
            .frontier(request.execution.run_id)
            .await
            .map_err(|error| Error::Persistence(error.to_string()))?;
        let task = view
            .external
            .as_ref()
            .filter(|task| task.task == request.task_id && task.admitted)
            .ok_or(Error::Unknown)?;
        let Some(existing) = &task.closed else {
            return Ok(false);
        };
        if existing.outcome != closure.0
            || existing.diagnostic != closure.1
            || existing.final_message != closure.2
        {
            return Err(Error::Unknown);
        }
        match (&task.publication, &self.publication_source, &closure.0) {
            (Some(actual), Some(expected), Terminal::Completed)
                if actual.id == expected.publication
                    && actual.task == task.task
                    && actual.source == *expected.source.reference() => {}
            (None, None, Terminal::Completed) => {}
            (None, _, Terminal::Failed | Terminal::Cancelled) => {}
            _ => return Err(Error::Unknown),
        }
        Ok(true)
    }
}
impl OutputSink for Publications {
    fn emit(&self, output: maka_agent_facts::executor::Output) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move {
            output
                .validate()
                .map_err(|error| Error::Invalid(error.into()))?;
            self.publish(ExternalObservation::Output(output)).await
        })
    }
}
impl TaskBinding for Publications {
    fn observation_retired(&self) -> CancellationToken {
        self.root_observation.clone()
    }
    fn owner_stop(&self) -> CancellationToken {
        self.owner_stop.clone()
    }
    fn admitted_steering_batches(&self) -> BoxFuture<'_, Result<u64, Error>> {
        Box::pin(async move {
            self.state
                .external_steering_admitted_batches(
                    self.frozen.payload.request.execution.clone(),
                    self.frozen.payload.request.task_id,
                )
                .await
                .map_err(|error| Error::Persistence(error.to_string()))
        })
    }
    fn stop_requested(&self) -> BoxFuture<'_, Result<bool, Error>> {
        Box::pin(async move {
            let view = self
                .state
                .frontier(self.frozen.payload.request.execution.run_id)
                .await
                .map_err(|error| Error::Persistence(error.to_string()))?;
            if view
                .external
                .as_ref()
                .is_none_or(|task| task.task != self.frozen.payload.request.task_id)
            {
                return Err(Error::Unknown);
            }
            Ok(view.stopped)
        })
    }

    fn execution_authority(&self) -> Result<Arc<dyn ExecutorAccess>, Error> {
        self.authority.clone().ok_or_else(|| {
            Error::IsolationUnavailable("this is not an original live executor preparation".into())
        })
    }

    fn bound(&self, recovery: RecoveryDescriptor) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move {
            let mut frozen = self.frozen.clone();
            frozen.payload.recovery = Some(recovery);
            let descriptor = ContentBlob::json(&frozen)
                .map_err(|error| Error::Persistence(error.to_string()))?;
            self.publish(ExternalObservation::Bound { descriptor })
                .await
        })
    }
    fn closed(&self, outcome: Outcome) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move {
            let mut publication = self.publication.lock().await;
            let closure = match outcome {
                Outcome::Completed { message_id } => publication.complete(message_id),
                Outcome::Cancelled { reason } => (Terminal::Cancelled, reason, None),
                Outcome::Failed { message, .. } => (Terminal::Failed, Some(message), None),
            };
            if let Some(original) = publication.closed.as_ref() {
                return if original == &closure {
                    Ok(())
                } else {
                    Err(Error::Unknown)
                };
            }
            if self.closed_in_store(&closure).await? {
                publication.closed = Some(closure);
                return Ok(());
            }
            let pending = if closure.0 == Terminal::Completed {
                self.publication_source.clone()
            } else {
                None
            };
            let committed = self
                .publish_locked(
                    &mut publication,
                    ExternalObservation::Closed {
                        outcome: closure.0.clone(),
                        diagnostic: closure.1.clone(),
                        final_message: closure.2.clone(),
                        publication: pending,
                    },
                )
                .await;
            if let Err(error) = committed {
                if !self.closed_in_store(&closure).await? {
                    return Err(error);
                }
                tracing::debug!(%error, "Original task closure already committed by its source");
            }
            publication.closed = Some(closure);
            drop(publication);
            Ok(())
        })
    }
    fn cleanup(&self, cleanup: OperationCleanup) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move {
            let mut accepted = self.cleanup_proof.lock().await;
            if *accepted == cleanup {
                return Ok(());
            }
            let publication = Arc::new(self.witness.prepare_cleanup(
                cleanup.clone(),
                UnixMillis(super::now().try_into().expect("Unix milliseconds")),
            ));
            self.retained
                .lock()
                .await
                .push(RetainedSource::Cleanup(publication.clone()));
            *accepted = cleanup;
            match publication.record().await {
                Ok(fact) => {
                    self.retained.lock().await.retain(|source| {
                        !matches!(source, RetainedSource::Cleanup(original) if Arc::ptr_eq(original, &publication))
                    });
                    let _ = self.send.try_send(Ok(fact));
                }
                Err(error) => {
                    tracing::warn!(%error, task = %self.frozen.payload.request.task_id,
                        "original external cleanup proof retained for its durable acknowledgement");
                }
            }
            Ok(())
        })
    }
}
#[expect(
    clippy::large_enum_variant,
    reason = "A connection selects one recovery mode; keep its original recovery payload inline"
)]
enum ConnectionMode {
    Start(PrivatePreparation),
    Observe,
}

impl DriverExecutor {
    pub(super) async fn original_cleanup_signals(self: &Arc<Self>) -> Vec<BoxFuture<'static, ()>> {
        let source = self.clone();
        let mut signals: Vec<BoxFuture<'static, ()>> = vec![Box::pin(async move {
            source.workers.wait().await;
            let mut signals = source
                .retained
                .lock()
                .await
                .iter()
                .filter_map(|source| match source {
                    RetainedSource::Resources(owner)
                        if owner.root_cleanup != OperationCleanup::Confirmed =>
                    {
                        Some(owner.original_root_cleanup_signal())
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();
            if let Some(publication) = source.publication.get() {
                signals.extend(publication.original_cleanup_signals());
            }
            futures_util::future::join_all(signals).await;
        })];
        signals.push(Box::pin(self.root_observation.clone().cancelled_owned()));
        if let Some(owner) = self.access.owner.upgrade() {
            signals.push(Box::pin(owner.stop.clone().cancelled_owned()));
        }
        signals
    }

    pub(super) async fn original_cleanup_confirmed(&self) -> Result<bool, RunError> {
        if !self.root_observation.is_cancelled() || !self.workers.is_empty() {
            return Ok(false);
        }
        let cleanups = {
            let mut retained = self.retained.lock().await;
            retained.retain_mut(|source| match source {
                RetainedSource::Resources(settlement) => {
                    settlement.observe_root_cleanup();
                    settlement.root_cleanup != OperationCleanup::Confirmed
                }
                RetainedSource::Cleanup(_) => true,
            });
            retained
                .iter()
                .filter_map(|source| match source {
                    RetainedSource::Cleanup(publication) => Some(publication.clone()),
                    RetainedSource::Resources(_) => None,
                })
                .collect::<Vec<_>>()
        };
        for publication in cleanups {
            publication.reconcile().await?;
            self.retained.lock().await.retain(|source| {
                !matches!(source, RetainedSource::Cleanup(original) if Arc::ptr_eq(original, &publication))
            });
        }
        let publication_confirmed = self
            .publication
            .get()
            .is_none_or(|publication| publication.original_cleanup_confirmed());
        Ok(self.retained.lock().await.is_empty()
            && self.workers.is_empty()
            && publication_confirmed)
    }

    async fn publication_source(
        &self,
        run: RunId,
        id: ExternalPublicationId,
    ) -> Result<Arc<super::driver_executor_publication::calls::LivePublication>, RunError> {
        let unavailable = |diagnostic: &str| {
            RunError::from(BlockerKind::ExternalPublicationUnavailable {
                publication: id,
                diagnostic: diagnostic.into(),
            })
        };
        if run != self.access.execution().run_id {
            return Err(unavailable("foreign publication execution"));
        }
        let view = self.state.frontier(run).await?;
        let task = view
            .external
            .as_ref()
            .filter(|task| {
                task.publication
                    .as_ref()
                    .is_some_and(|publication| publication.id == id)
            })
            .ok_or_else(|| unavailable("original pending publication is unavailable"))?;
        self.publication
            .get_or_try_init(|| async {
                let capture = self.candidate_capture.get().cloned();
                let owner = self
                    .access
                    .owner
                    .upgrade()
                    .ok_or_else(|| unavailable("original native owner is closed"))?;
                super::driver_executor_publication::calls::LivePublication::new(
                    owner,
                    self.access.clone(),
                    self.access.claim().clone(),
                    self.state.clone(),
                    task.task,
                    capture,
                    self.workers.clone(),
                )
            })
            .await
            .cloned()
    }

    /// Revoke only this Root's observation. The private task retains its own owner.
    pub(super) async fn retire_root_observation(&self) -> Result<(), RunError> {
        if !self.root_observation.is_cancelled()
            && !self.workers.is_empty()
            && self
                .access
                .owner
                .upgrade()
                .is_some_and(|owner| !owner.stop.is_cancelled())
        {
            let view = self.state.frontier(self.access.execution().run_id).await?;
            if view.external.as_ref().is_some_and(|task| {
                task.closed.is_some() && task.cleanup != OperationCleanup::Confirmed
            }) {
                return Ok(());
            }
        }
        self.root_observation.cancel();
        Ok(())
    }

    async fn decode(
        &self,
        run: RunId,
        task: ExternalTaskId,
        reference: ContentRef,
    ) -> Result<TaskDescriptor<FrozenInput>, RunError> {
        let bytes = self.state.content(run, reference.clone()).await?;
        let frozen: TaskDescriptor<FrozenInput> =
            serde_json::from_slice(&bytes).map_err(|_| blocked(reference.clone()))?;
        if frozen.protocol != NATIVE_TASK_PROTOCOL {
            return Err(blocked(reference));
        }
        if frozen.payload.request.execution != *self.access.execution()
            || frozen.payload.request.execution.run_id != run
            || frozen.payload.request.task_id != task
        {
            return Err(blocked(reference));
        }
        Ok(frozen)
    }
    async fn fresh_authority(
        &self,
        request: &Request,
        cancellation: &CancellationToken,
    ) -> Result<maka_sandbox::Sandbox, RunError> {
        let configuration = self.access.live_configuration().await?;
        self.authority_floor(request, cancellation, configuration)
            .await
    }
    async fn authority_floor(
        &self,
        request: &Request,
        cancellation: &CancellationToken,
        configuration: maka_agent_api::session::ResolvedConfiguration,
    ) -> Result<maka_sandbox::Sandbox, RunError> {
        if cancellation.is_cancelled() || self.root_observation.is_cancelled() {
            return Err(RunError::Cancelled);
        }
        if configuration.workspace.path != request.cwd {
            return Err(RunError::InvalidInput(
                "external task workspace changed".into(),
            ));
        }
        let owner = self
            .access
            .owner
            .upgrade()
            .ok_or_else(|| RunError::Internal("original native owner closed".into()))?;
        let reserved =
            super::access::reserved_sandbox_floor(&owner.store, &configuration.workspace)
                .await
                .map_err(RunError::InvalidInput)?;
        let state_root = self.state_root.clone();
        let ceiling = self.access.spec().permission_ceiling.sandbox.clone();
        tokio::task::spawn_blocking(move || {
            maka_fs_tools::directory::open(
                std::path::Path::new(&configuration.workspace.path),
                &configuration.workspace.directory_identity,
            )
            .map_err(|error| error.to_string())?;
            maka_workspace_support::sandbox(
                &configuration.workspace,
                configuration.permissions.access,
                &state_root,
            )
            .and_then(|(sandbox, _)| {
                sandbox
                    .intersect(&ceiling)
                    .and_then(|sandbox| sandbox.intersect(&reserved))
                    .map_err(|error| error.to_string())
            })
        })
        .await
        .map_err(|error| RunError::Internal(error.to_string()))?
        .map_err(RunError::InvalidInput)
    }
    async fn connection(
        &self,
        frozen: TaskDescriptor<FrozenInput>,
        descriptor: ContentRef,
        after: u64,
        mode: ConnectionMode,
        witness: ExternalWitness,
    ) -> Result<ExternalConnection, RunError> {
        let view = self
            .state
            .frontier(frozen.payload.request.execution.run_id)
            .await?;
        let task = view
            .external
            .as_ref()
            .ok_or_else(|| blocked(descriptor.clone()))?;
        if task.task != frozen.payload.request.task_id || !task.admitted || task.observed != after {
            return Err(blocked(descriptor));
        }
        let (prefix, messages) =
            task_prefix(&self.state, view.run, task.task, after, view.revision).await?;
        let witness =
            witness.with_data_writer(self.access.data_writer().map_err(RunError::Internal)?)?;
        let cancellation = self.cancellation.child_token();
        let (send, recv) = mpsc::channel(1);
        if self.root_observation.is_cancelled() {
            return Err(RunError::Cancelled);
        }
        let floor = match &mode {
            ConnectionMode::Start(prepared) => prepared.actual.clone(),
            ConnectionMode::Observe => {
                let configuration = self.access.observation_configuration().await?;
                self.authority_floor(
                    &frozen.payload.request,
                    &self.root_observation,
                    configuration,
                )
                .await?
            }
        };
        let fresh = matches!(&mode, ConnectionMode::Start(_));
        let (authority, prepared): (Option<Arc<dyn ExecutorAccess>>, Option<PrivatePreparation>) =
            match mode {
                ConnectionMode::Start(prepared) => match self.backend.service_binding() {
                    Some(binding) => (
                        Some(Arc::new(ExecutionAuthority {
                            access: self.access.clone(),
                            state: self.state.clone(),
                            binding,
                            profile_binding: self
                                .backend
                                .setup_binding()
                                .map_err(RunError::InvalidInput)?,
                            task: task.task,
                            inputs: self.inputs.clone(),
                            root_observation: self.root_observation.clone(),
                            prepared: Mutex::new(Some(prepared)),
                        })),
                        None,
                    ),
                    None => (None, Some(prepared)),
                },
                ConnectionMode::Observe => (None, None),
            };
        if task.live_workspace != frozen.payload.publication.is_none() {
            return Err(blocked(descriptor));
        }
        let publication_source = frozen
            .payload
            .publication
            .map(|publication| {
                let source = ContentBlob::json(
                    &maka_agent_facts::external_publication::ExternalPublicationSource {
                        schema_version: SCHEMA_VERSION,
                        execution: frozen.payload.request.execution.clone(),
                        task: frozen.payload.request.task_id,
                        payload: PublicationSource {
                            resource: frozen.payload.private_resource.clone(),
                            original_task_descriptor: task.descriptor.clone(),
                        },
                    },
                )?;
                Ok::<_, RunError>(PendingExternalPublication {
                    publication,
                    source,
                })
            })
            .transpose()?;
        let owner_stop = self
            .access
            .owner
            .upgrade()
            .ok_or(RunError::Cancelled)?
            .stop
            .clone();
        let publications = Arc::new(Publications {
            owner_stop,
            publication_source,
            state: self.state.clone(),
            root_observation: self.root_observation.clone(),
            authority,
            send: send.clone(),
            frozen: frozen.clone(),
            witness,
            publication: Mutex::new(PublicationState {
                cursor: after,
                messages,
                closed: task.closed.as_ref().map(|closed| {
                    (
                        closed.outcome.clone(),
                        closed.diagnostic.clone(),
                        closed.final_message.clone(),
                    )
                }),
            }),
            cleanup_proof: Mutex::new(task.cleanup.clone()),
            retained: self.retained.clone(),
        });
        let backend = self.backend.clone();
        let custody = self.access.custody().clone();
        let inputs = self.inputs.clone();
        let cleanup = self.cleanup.clone();
        let retained = self.retained.clone();
        self.workers.spawn(async move {
            let work = async {
                let settlement = if fresh {
                    let actual = if let Some(prepared) = &prepared {
                        prepared.actual.clone()
                    } else {
                        floor.clone()
                    };
                    let isolated = prepared.map(|prepared| prepared.owner);
                    let admitted = backend
                        .admit_execution(
                            frozen.payload.request.clone(),
                            publications.clone(),
                            inputs,
                            actual,
                            isolated,
                        )
                        .await
                        .map_err(|error| external_error(error, descriptor.clone()))?;
                    admitted
                        .execution
                        .execute(custody, publications.clone(), cancellation)
                        .await
                } else {
                    let recovery = frozen
                        .payload
                        .recovery
                        .as_ref()
                        .ok_or_else(|| blocked(descriptor.clone()))?;
                    backend
                        .observe_task(
                            &frozen.payload.request,
                            recovery,
                            after,
                            Some(prefix),
                            descriptor.clone(),
                            custody.clone(),
                            floor,
                            publications.clone(),
                            publications.clone(),
                            publications.observation_retired(),
                        )
                        .await
                };
                let result = if publications.accepted().await {
                    if let Err(error) = &settlement.result {
                        tracing::error!(%error, "Original executor teardown failed after canonical closure ACK");
                    }
                    Ok(())
                } else { match settlement.result.clone() {
                    Ok(outcome) => publications
                        .closed(outcome)
                        .await
                        .map_err(|error| external_error(error, descriptor.clone())),
                    Err(error) => Err(external_error(error, descriptor.clone())),
                }};
                if !matches!(settlement.root_cleanup, OperationCleanup::Confirmed) {
                    let _ = cleanup.unconfirmed();
                    retained
                        .lock()
                        .await
                        .push(RetainedSource::Resources(settlement));
                    return Err(RunError::CleanupUnconfirmed);
                }
                result?;
                drop(settlement);
                Ok(())
            };
            let result = AssertUnwindSafe(work)
                .catch_unwind()
                .await
                .unwrap_or_else(|_| {
                    let _ = cleanup.unconfirmed();
                    Err(RunError::CleanupUnconfirmed)
                });
            if let Err(error) = result {
                if publications.accepted().await {
                    tracing::error!(%error, "Original executor resources remain unsettled after canonical closure ACK");
                } else {
                    let _ = send.send(Err(error)).await;
                }
            }
        });
        Ok(Box::pin(stream::unfold(recv, |mut recv| async move {
            recv.recv().await.map(|item| (item, recv))
        })))
    }
}
impl ExternalPorts for DriverExecutor {
    fn prepare_external<'a>(
        &'a self,
        view: &'a RunView,
        task: ExternalTaskId,
    ) -> BoxFuture<'a, Result<PreparedExternal, RunError>> {
        Box::pin(async move {
            let BackendSpec::Executor { selection, .. } = &view.spec.backend else {
                return Err(RunError::InvalidInput(
                    "model Run cannot prepare an external task".into(),
                ));
            };
            if view.run != self.access.execution().run_id
                || selection != &self.backend.accepted.selection
            {
                return Err(RunError::InvalidInput(
                    "external backend differs from admitted Run".into(),
                ));
            }
            let input: RunInput = serde_json::from_slice(
                &self
                    .state
                    .content(view.run, view.spec.input.clone())
                    .await?,
            )
            .map_err(|error| RunError::InvalidInput(error.to_string()))?;
            let RunInput::Message { content, .. } = input else {
                return Err(RunError::InvalidInput(
                    "external runtime requires original message input".into(),
                ));
            };
            let live_workspace = self.backend.service_binding().is_none();
            let request = Request {
                task_id: task,
                language: view.spec.language,
                execution: self.access.execution().clone(),
                conversation_key: view.spec.session_id.clone(),
                content,
                cwd: view.spec.workspace.clone(),
                instructions: self.instructions.clone(),
                settings: selection.settings.clone(),
            };
            let actual = self.fresh_authority(&request, &self.cancellation).await?;
            let basis = self.access.live_configuration().await?.permission_basis();
            let mut slot = self.prepared_private.lock().await;
            if let Some(prepared) = slot.as_ref() {
                if prepared.task != task || prepared.basis != basis {
                    return Err(RunError::InvalidInput("original private preparation no longer matches this task and permission epoch".into()));
                }
                return Ok(PreparedExternal {
                    live_workspace,
                    descriptor: prepared.descriptor.clone(),
                    contents: vec![],
                });
            }
            if self.candidate_capture.get().is_some() {
                return Err(RunError::InvalidInput(
                    "original private launch owner was already consumed".into(),
                ));
            }
            let agent = self.access.owner.upgrade().ok_or_else(|| {
                RunError::Internal("original native executor owner is unavailable".into())
            })?;
            let source = std::path::Path::new(&request.cwd);
            let (owner, capture) = if live_workspace {
                let owner = maka_process::isolated::TaskOwner::prepare_live(
                    source,
                    &self.state_root,
                    &agent.helper,
                    self.cancellation.child_token(),
                )
                .await
                .map_err(isolation_error)?;
                (owner, None)
            } else {
                let managed_profile = self
                    .backend
                    .setup_binding()
                    .map_err(RunError::InvalidInput)?
                    .is_some();
                let privacy = tokio::task::spawn_blocking(move || {
                    if managed_profile {
                        super::setup::managed_profile_policy()
                    } else {
                        Ok(maka_sandbox::filesystem::Policy::uniform(
                            maka_sandbox::filesystem::Access::Write,
                        ))
                    }
                })
                .await
                .map_err(|error| RunError::Internal(error.to_string()))?
                .map_err(|error| RunError::InvalidInput(error.to_string()))?;
                let owner = maka_process::isolated::TaskOwner::prepare(
                    source,
                    &self.state_root,
                    &agent.helper,
                    &actual,
                    &privacy,
                    self.cancellation.child_token(),
                )
                .await
                .map_err(isolation_error)?;
                tokio::task::spawn_blocking(move || {
                    let capture = owner.candidate_capture()?;
                    Ok::<_, maka_process::isolated::Error>((owner, Some(capture)))
                })
                .await
                .map_err(|error| RunError::Internal(error.to_string()))?
                .map_err(isolation_error)?
            };
            if self.access.live_configuration().await?.permission_basis() != basis {
                return Err(RunError::InvalidInput(
                    "private workspace preparation permission epoch changed".into(),
                ));
            }
            self.fresh_authority(&request, &self.cancellation).await?;
            let private_resource = owner.descriptor();
            if let Some(capture) = capture {
                self.candidate_capture.set(capture).map_err(|_| {
                    RunError::InvalidInput("original private candidate owner already exists".into())
                })?;
            }
            let frozen = TaskDescriptor {
                protocol: NATIVE_TASK_PROTOCOL.into(),
                source: self.backend.source_identity(),
                payload: FrozenInput {
                    accepted: self.backend.accepted.clone(),
                    request,
                    recovery: None,
                    private_resource,
                    publication: (!live_workspace).then(ExternalPublicationId::new),
                },
            };
            let descriptor = ContentBlob::json(&frozen)?;
            *slot = Some(PrivatePreparation {
                task,
                owner,
                actual,
                basis,
                descriptor: descriptor.clone(),
            });
            Ok(PreparedExternal {
                live_workspace,
                descriptor,
                contents: vec![],
            })
        })
    }
    fn start_external(
        &self,
        run: RunId,
        task: ExternalTaskId,
        descriptor: ContentRef,
        witness: ExternalWitness,
    ) -> BoxFuture<'_, Result<ExternalConnection, RunError>> {
        Box::pin(async move {
            let frozen = self.decode(run, task, descriptor.clone()).await?;
            if frozen.payload.recovery.is_some() || frozen.payload.accepted != self.backend.accepted
            {
                return Err(blocked(descriptor));
            }
            let actual = self
                .fresh_authority(&frozen.payload.request, &self.cancellation)
                .await?;
            let basis = self.access.live_configuration().await?.permission_basis();
            let prepared = self
                .prepared_private
                .lock()
                .await
                .take()
                .ok_or_else(|| blocked(descriptor.clone()))?;
            if prepared.task != task
                || prepared.owner.descriptor().resource_ref
                    != frozen.payload.private_resource.resource_ref
                || prepared.basis != basis
                || !actual
                    .contains(&prepared.actual)
                    .map_err(|error| RunError::InvalidInput(error.to_string()))?
            {
                return Err(blocked(descriptor));
            }
            self.connection(
                frozen,
                descriptor,
                0,
                ConnectionMode::Start(prepared),
                witness,
            )
            .await
        })
    }
    fn observe_external(
        &self,
        run: RunId,
        task: ExternalTaskId,
        descriptor: ContentRef,
        after_index: u64,
        witness: ExternalWitness,
    ) -> BoxFuture<'_, Result<ExternalConnection, RunError>> {
        Box::pin(async move {
            let frozen = self.decode(run, task, descriptor.clone()).await?;
            if frozen.payload.recovery.is_none() {
                return Err(blocked(descriptor));
            }
            self.connection(
                frozen,
                descriptor,
                after_index,
                ConnectionMode::Observe,
                witness,
            )
            .await
        })
    }
}
fn blocked(descriptor: ContentRef) -> RunError {
    RunError::from(BlockerKind::ExternalTaskUnobservable { descriptor })
}
fn external_error(error: Error, descriptor: ContentRef) -> RunError {
    match error {
        Error::Cancelled => RunError::Cancelled,
        Error::IsolationUnavailable(message) => RunError::IsolationUnavailable(message),
        Error::Blocked { reason, .. } => RunError::Blocked(reason),
        Error::ObservationRetired | Error::Unknown | Error::CleanupUnconfirmed => {
            blocked(descriptor)
        }
        error @ (Error::Invalid(_) | Error::Persistence(_)) => {
            tracing::warn!(%error, "Original external task could not be observed");
            blocked(descriptor)
        }
        error => RunError::Internal(error.to_string()),
    }
}

async fn task_prefix(
    state: &Store,
    run: RunId,
    task: ExternalTaskId,
    count: u64,
    through: u64,
) -> Result<([u8; 32], std::collections::BTreeMap<String, MessageState>), RunError> {
    let mut messages = std::collections::BTreeMap::new();
    let mut revision = 0;
    let mut index = 0;
    let mut digest = [0; 32];
    while index < count {
        let page = state.history(run, revision, 128).await?;
        if page.is_empty() {
            return Err(RunError::Internal(
                "canonical external output prefix is missing".into(),
            ));
        }
        let mut outputs = Vec::new();
        for recorded in page {
            if recorded.revision > through {
                return Err(RunError::Internal(
                    "canonical external prefix exceeds its original cut".into(),
                ));
            }
            revision = recorded.revision;
            if let Fact::ExternalTaskObserved {
                task: original,
                index: position,
                output,
            } = recorded.fact
            {
                if original != task || position != index {
                    return Err(RunError::Internal(
                        "canonical external output prefix is not contiguous".into(),
                    ));
                }
                if let Some(event) = MessageEvent::from_output(&output) {
                    observe_message(&mut messages, event, recorded.id);
                }
                outputs.push(output);
                index += 1;
                if index == count {
                    break;
                }
            }
        }
        if outputs.is_empty() && revision >= through {
            return Err(RunError::Internal(
                "canonical external output prefix is incomplete".into(),
            ));
        }
        digest = tokio::task::spawn_blocking(move || {
            for output in outputs {
                let bytes = serde_json::to_vec(&output)
                    .map_err(|error| RunError::Internal(error.to_string()))?;
                let mut hash = Sha256::new();
                hash.update(digest);
                hash.update(Sha256::digest(bytes));
                digest = hash.finalize().into();
            }
            Ok::<_, RunError>(digest)
        })
        .await
        .map_err(|error| RunError::Internal(error.to_string()))??;
    }
    Ok((digest, messages))
}

pub(super) struct PrivatePreparation {
    task: ExternalTaskId,
    owner: maka_process::isolated::TaskOwner,
    actual: maka_sandbox::Sandbox,
    basis: maka_sandbox::workspace::PermissionBasis,
    descriptor: ContentBlob,
}
struct ExecutionAuthority {
    access: Arc<super::access::RunAccess>,
    state: Store,
    binding: Binding,
    profile_binding: Option<Binding>,
    task: ExternalTaskId,
    inputs: Arc<dyn Inputs>,
    root_observation: CancellationToken,
    prepared: Mutex<Option<PrivatePreparation>>,
}
impl ExecutorAccess for ExecutionAuthority {
    fn observation_retired(&self) -> CancellationToken {
        self.root_observation.clone()
    }
    fn stop_requested(&self) -> BoxFuture<'_, Result<bool, Error>> {
        Box::pin(async move {
            let view = self
                .state
                .frontier(self.access.execution().run_id)
                .await
                .map_err(|error| Error::Persistence(error.to_string()))?;
            if view
                .external
                .as_ref()
                .is_none_or(|task| task.task != self.task)
            {
                return Err(Error::Unknown);
            }
            Ok(view.stopped)
        })
    }
    fn task_id(&self) -> ExternalTaskId {
        self.task
    }
    fn execution(&self) -> &ExecutionIdentity {
        self.access.execution()
    }
    fn validate<'a>(&'a self, context: &'a Context) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            let actual = context
                .native_context::<ExecutorCallContext>()
                .ok_or_else(|| {
                    Error::IsolationUnavailable(
                        "original native executor call context is unavailable".into(),
                    )
                })?;
            if !std::ptr::addr_eq(Arc::as_ptr(&actual.0), self as *const Self)
                || context.scope().identity.agent() != Some(self.access.execution())
                || context
                    .work_custody()
                    .is_none_or(|work| !Arc::ptr_eq(work, self.access.custody()))
                || (context.requester() != self.binding.consumer()
                    && context.requester() != self.binding.provider())
            {
                return Err(Error::Invalid(
                    "executor call does not hold its original issuer and work capability".into(),
                ));
            }
            self.access.data_writer().map_err(Error::Persistence)?;
            let view = self
                .state
                .frontier(self.access.execution().run_id)
                .await
                .map_err(|error| Error::Persistence(error.to_string()))?;
            let task = view.external.as_ref().ok_or(Error::Unknown)?;
            if task.task != self.task || !task.admitted {
                return Err(Error::Unknown);
            }
            // Original cleanup is permitted after business closure; it cannot prepare another job.
            if context.requester() == self.binding.provider()
                && context
                    .operation()
                    .is_some_and(|reference| reference.method == "close")
            {
                return Ok(());
            }
            let current = self.access.fresh().await.map_err(Error::Invalid)?;
            if current.stopped
                || current.terminal.is_some()
                || task.closed.is_some()
                || current
                    .blockers
                    .values()
                    .any(|blocker| blocker.decision.is_none() && blocker.resolved_by.is_none())
            {
                return Err(Error::Retired);
            }
            self.access
                .live_configuration()
                .await
                .map_err(|error| Error::Invalid(error.to_string()))?;
            Ok(())
        })
    }
    fn publish_form<'a>(
        &'a self,
        context: &'a Context,
        record: &'a maka_agent_facts::interaction::InteractionRecord,
    ) -> BoxFuture<'a, Result<Option<maka_agent_facts::interaction::InteractionOutcome>, String>>
    {
        Box::pin(async move {
            self.validate(context)
                .await
                .map_err(|error| error.to_string())?;
            let operation = context
                .operation()
                .ok_or("executor_form_requires_mutation")?;
            let operation_id = context
                .scope()
                .identity
                .operation_id()
                .ok_or("executor_form_requires_operation")?;
            let maka_agent_facts::interaction::InteractionRequest::Form {
                tool_use_id,
                requester,
                ..
            } = &record.request
            else {
                return Err("executor_form_request_kind_invalid".into());
            };
            let expected_id = format!(
                "form_{}",
                hex::encode(Sha256::digest(
                    serde_json::to_vec(operation).expect("operation identity")
                ))
            );
            if context.requester() != self.binding.provider()
                || operation.method != "ask"
                || context
                    .operation_scope()
                    .is_none_or(|scope| scope.reference() != operation)
                || !operation
                    .contract
                    .matches(&maka_interactions_api::forms::contract(), "ask")
                    .map_err(|error| error.to_string())?
                || *requester
                    != (maka_agent_facts::capability::FormRequester {
                        name: "Agent".into(),
                        source: None,
                    })
                || record.execution != *self.access.execution()
                || record.request_id != expected_id
                || *tool_use_id
                    != maka_agent_facts::tool_call::tool_use_id(
                        record.execution.run_id,
                        operation_id,
                    )
                || record.outcome.is_some()
            {
                return Err("executor_form_original_operation_mismatch".into());
            }
            record.request.validate().map_err(str::to_owned)?;
            if self.root_observation.is_cancelled() || context.scope().cancellation.is_cancelled() {
                return Err("executor_form_producer_cancelled".into());
            }
            let publication = maka_agent_authority::interaction_wait::publish(
                self.access.as_ref(),
                context,
                record,
            );
            tokio::pin!(publication);
            tokio::select! {
                biased;
                () = self.root_observation.cancelled() => {
                    context.scope().cancellation.cancel();
                    publication.await
                }
                result = &mut publication => result,
            }
        })
    }
    fn prepare_private_task<'a>(
        &'a self,
        context: &'a Context,
        selected: &'a maka_process::Command,
    ) -> BoxFuture<'a, Result<maka_process::isolated::TaskOwner, Error>> {
        Box::pin(async move {
            self.validate(context).await?;
            if context.requester() != self.binding.provider()
                || context
                    .operation()
                    .is_none_or(|reference| !matches!(reference.method.as_str(), "run" | "launch"))
            {
                return Err(Error::Invalid(
                    "only the selected original provider may prepare its private task".into(),
                ));
            }
            let prepared = self.prepared.lock().await.take().ok_or_else(|| {
                Error::IsolationUnavailable(
                    "original private task preparation was already consumed".into(),
                )
            })?;
            let configuration = self
                .access
                .live_configuration()
                .await
                .map_err(|error| Error::Invalid(error.to_string()))?;
            if prepared.task != self.task
                || configuration.permission_basis() != prepared.basis
                || !context
                    .scope()
                    .sandbox_floor()
                    .contains(&prepared.actual)
                    .map_err(|error| Error::Invalid(error.to_string()))?
            {
                return Err(Error::IsolationUnavailable("current executor restrictions no longer contain the original private preparation".into()));
            }
            let mut owner = match &self.profile_binding {
                Some(binding) => {
                    let agent = self.access.owner.upgrade().ok_or(Error::Retired)?;
                    let broker = super::setup::profile::ProfileBroker::new(&agent, binding)
                        .map_err(|error| Error::IsolationUnavailable(error.to_string()))?;
                    broker
                        .seed_current_profile(prepared.owner)
                        .await
                        .map_err(|error| Error::IsolationUnavailable(error.to_string()))?
                }
                None => prepared.owner,
            };
            owner
                .bind_command(selected, context.scope().sandbox_floor())
                .await
                .map_err(|error| Error::IsolationUnavailable(error.to_string()))?;
            let mut options = tokio::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            options.mode(0o600);
            let mut history = options
                .open(
                    owner
                        .inputs()
                        .join(maka_agent_authority::executor::HISTORY_FILE),
                )
                .await
                .map_err(|error| Error::Invalid(error.to_string()))?;
            self.inputs
                .write_history(self.task, None, &mut history)
                .await?;
            use tokio::io::AsyncWriteExt;
            history
                .flush()
                .await
                .map_err(|error| Error::Invalid(error.to_string()))?;
            self.validate(context).await?;
            Ok(owner)
        })
    }
}

fn isolation_error(error: maka_process::isolated::Error) -> RunError {
    match error {
        maka_process::isolated::Error::IsolationUnavailable(message) => {
            RunError::IsolationUnavailable(message)
        }
        maka_process::isolated::Error::Cancelled => RunError::Cancelled,
        error => RunError::InvalidInput(error.to_string()),
    }
}

impl maka_agent_engine::ports::ExternalPublicationPorts for DriverExecutor {
    fn prepare_publication<'a>(
        &'a self,
        view: &'a RunView,
        id: ExternalPublicationId,
    ) -> BoxFuture<'a, Result<maka_agent_engine::ports::PreparedExternalPublication, RunError>>
    {
        Box::pin(async move {
            self.publication_source(view.run, id)
                .await?
                .prepare_publication(view, id)
                .await
        })
    }
    fn validate_publication_item<'a>(
        &'a self,
        view: &'a RunView,
        key: maka_agent_facts::external_publication::ExternalPublicationKey,
    ) -> BoxFuture<'a, Result<maka_sandbox::workspace::PermissionBasis, RunError>> {
        Box::pin(async move {
            self.publication_source(view.run, key.publication)
                .await?
                .validate_publication_item(view, key)
                .await
        })
    }
    fn dispatch_publication_item(
        &self,
        run: RunId,
        key: maka_agent_facts::external_publication::ExternalPublicationKey,
        witness: maka_agent_engine::PublicationWitness,
    ) -> BoxFuture<'_, Result<FactId, RunError>> {
        Box::pin(async move {
            self.publication_source(run, key.publication)
                .await?
                .dispatch_publication_item(run, key, witness)
                .await
        })
    }
    fn lookup_publication_item(
        &self,
        run: RunId,
        key: maka_agent_facts::external_publication::ExternalPublicationKey,
        witness: maka_agent_engine::PublicationWitness,
    ) -> BoxFuture<'_, Result<maka_agent_engine::ports::OriginalLookup, RunError>> {
        Box::pin(async move {
            self.publication_source(run, key.publication)
                .await?
                .lookup_publication_item(run, key, witness)
                .await
        })
    }
    fn observe_publication_item(
        &self,
        run: RunId,
        key: maka_agent_facts::external_publication::ExternalPublicationKey,
        reference: maka_plugin_core::operation::RecoveryRef,
        witness: maka_agent_engine::PublicationWitness,
    ) -> BoxFuture<'_, Result<FactId, RunError>> {
        Box::pin(async move {
            self.publication_source(run, key.publication)
                .await?
                .observe_publication_item(run, key, reference, witness)
                .await
        })
    }
}
