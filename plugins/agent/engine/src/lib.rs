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

mod auto_context;
mod cleanup;
mod compact;
mod context_input;
mod continuation;
mod executor;
pub use executor::ExecutorInput;
mod handoff;
pub use handoff::{HandoffGate, HandoffReservation, HeldHandoff, PendingSeal};
mod frozen_request;
mod history;
mod interactions;
mod model_attempt;
mod model_source;
mod prepared_prompt;
mod preview;
pub use model_source::{ModelSource, PreparedModel};
pub mod pricing;
mod request_composition;
pub use history::project as project_model_history;
mod prune;
#[cfg(any(test, feature = "test-support"))]
pub mod retry_fixture;
mod retry_resume;
pub use retry_resume::RetryResumeInput;
mod resume;
pub use resume::{NativeApprovalExecutor, ResumeContinuation, ResumeInput};
mod runner;
mod running;
mod steps;
pub use running::{RunningCompletion, RunningInvocation};

#[derive(Clone, Debug)]
pub enum ActivationExit {
    Terminal(Invocation),
    Parked(maka_event_log::native_approvals::ParkedActivationReceipt),
}

#[derive(Clone, Debug, thiserror::Error)]
#[error("invocation cleanup is unconfirmed")]
pub struct CleanupUnconfirmed;

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use maka_agent_facts::event::CommitError;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::execution::InvocationConfiguration;
use maka_agent_facts::input::MessageInput;
use maka_agent_facts::tools::ToolError;
use maka_event_log::StoreError;
use maka_event_log::root_store::{InvocationEffects, SessionExecutionScope, SessionStore};
use maka_model::{ModelError, ModelExecutor, ProviderConfig};
use maka_tools::CodeExecutor;
use maka_tools::ToolCatalog;
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error("session already has an active invocation")]
    Busy,
    #[error(transparent)]
    SessionState(#[from] maka_session_state::Error),
    /// Preflight became stale; no invocation was opened or source claimed.
    #[error("Session tool loading changed during continuation preparation; prepare again")]
    ContinuationChanged,
    #[error("session requires reconciliation before another invocation: {0}")]
    ReconciliationRequired(String),
    #[error("invalid execution input: {0}")]
    InvalidInput(String),
    #[error("execution cancelled")]
    Cancelled,
    #[error("model output was incomplete; local tools from this response were not executed")]
    ModelIncomplete,
    #[error(transparent)]
    Commit(#[from] CommitError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Model(ModelError),
    #[error(transparent)]
    Tool(ToolError),
    /// Physical ownership is uncertain; an enclosing native owner must retain
    /// its Root and capacity rather than infer cleanup from business completion.
    #[error("execution cleanup is unconfirmed")]
    CleanupUnconfirmed,
    #[error("execution worker failed: {0}")]
    Internal(String),
    #[error("activation checkpoint serialization failed: {0}")]
    Checkpoint(#[source] serde_json::Error),
    #[error("model input preparation failed: {0}")]
    Preparation(#[from] std::io::Error),
    #[error("model input cleanup was not confirmed: {0}")]
    PreparationCleanup(#[source] std::io::Error),
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
struct PreparationCancelled(&'static str);

fn preparation_cancelled(message: &'static str) -> std::io::Error {
    std::io::Error::other(PreparationCancelled(message))
}

impl RunError {
    // Only our cancellation signal is terminal cancellation; I/O and cleanup keep their cause.
    fn preparation(error: std::io::Error) -> Self {
        if error
            .get_ref()
            .is_some_and(|cause| cause.is::<PreparationCancelled>())
        {
            Self::Cancelled
        } else {
            Self::Preparation(error)
        }
    }

    /// Explicit unconfirmed cleanup in this error. Absence is not proof of
    /// cleanup; only the original RunningCompletion carries that observation.
    pub fn is_cleanup_unconfirmed(&self) -> bool {
        matches!(
            self,
            Self::CleanupUnconfirmed
                | Self::PreparationCleanup(_)
                | Self::Model(ModelError::CleanupUnconfirmed)
                | Self::Tool(
                    ToolError::CleanupUnconfirmed(_)
                        | ToolError::OperationCleanupUnconfirmed { .. }
                )
        )
    }
}

impl From<ModelError> for RunError {
    fn from(error: ModelError) -> Self {
        if error.cleanup_unconfirmed() {
            cleanup::unconfirmed();
        }
        Self::Model(error)
    }
}

impl From<ToolError> for RunError {
    fn from(error: ToolError) -> Self {
        if matches!(
            error,
            ToolError::CleanupUnconfirmed(_) | ToolError::OperationCleanupUnconfirmed { .. }
        ) {
            cleanup::unconfirmed();
        }
        Self::Tool(error)
    }
}

/// Immutable native activation evidence, materialized only when execution parks.
/// This evidence carries no execution authority.
pub trait NativeActivationBasis: Send + Sync {
    /// Serialize the accepted basis for a persistent activation checkpoint.
    ///
    /// # Errors
    /// Returns the original serialization error if the accepted basis cannot be encoded.
    fn checkpoint_value(&self) -> serde_json::Result<Value>;
}

#[derive(Clone)]
pub struct RunInput<W = RunWork> {
    /// Optional for standalone adapters; Host executions supply a public provider source.
    pub model_source: Option<Arc<dyn ModelSource>>,
    pub model_revision: Option<maka_agent_facts::composition::SourceRevision>,
    /// Public access-path identity; not the transport protocol or adapter name.
    pub provider_id: String,
    pub invocation: Invocation,
    pub context: Option<maka_agent_facts::context::ModelRequestContext>,
    pub work: W,
    /// Stable domain admission identity, when this invocation was client-issued.
    pub request_fingerprint: Option<String>,
    pub provider: ProviderConfig,
    pub provider_options: Value,
    /// Accepted native activation evidence; it carries no execution authority.
    pub native_activation_basis: Option<Arc<dyn NativeActivationBasis>>,
    /// Resolved SDK reply budget; summaries additionally cap their text at 8K.
    pub main_output_limit: Option<u64>,
    /// Current selected-model capability; image bytes are projected per request.
    pub supports_vision: bool,
    pub configuration: InvocationConfiguration,
}

// Admission owns the submitted body. Running execution owns only settings and
// identity; canonical opening facts supply the body to bounded history reads.
pub type RunSettings = RunInput<()>;

impl RunInput {
    fn into_context(self) -> (RunSettings, RunWork) {
        let Self {
            work,
            model_source,
            model_revision,
            provider_id,
            invocation,
            context,
            request_fingerprint,
            provider,
            provider_options,
            native_activation_basis,
            main_output_limit,
            supports_vision,
            configuration,
        } = self;
        (
            RunInput {
                work: (),
                model_source,
                model_revision,
                provider_id,
                invocation,
                context,
                request_fingerprint,
                provider,
                provider_options,
                native_activation_basis,
                main_output_limit,
                supports_vision,
                configuration,
            },
            work,
        )
    }
}

#[derive(Clone)]
pub enum RunWork {
    Handoff {
        source: maka_agent_facts::continuation::RunBoundary,
        pause: Box<maka_agent_facts::handoff::HandoffPause>,
        tools: ToolCatalog,
    },
    Continuation {
        source: maka_agent_facts::continuation::RunBoundary,
        tools: ToolCatalog,
    },
    Message {
        message: MessageInput,
        source_messages: Vec<maka_agent_facts::message::RootSourceMessage>,
        tools: ToolCatalog,
        /// Only a newly submitted client Turn may observe a sealed, unknown prior tool effect.
        allow_prior_unknown: bool,
    },
    ContextCompact,
}

struct Inner {
    pricing: Option<Arc<dyn pricing::Pricing>>,
    preparation_resources: maka_model::ModelPreparationResources,
    model: ModelExecutor,
    cells: CodeExecutor,
    session_backend: maka_session_state::Backend,
    active: Mutex<HashSet<String>>,
    workers: TaskTracker,
}

/// One selected journal for this run; scheduling and scratch state remain global.
struct RunContext {
    shared: Arc<Inner>,
    log: Arc<SessionStore>,
    attempts: preview::Attempts,
}

impl RunContext {
    fn new(
        shared: Arc<Inner>,
        store: SessionStore,
        invocation: &Invocation,
    ) -> Result<Arc<Self>, RunError> {
        require_session(&store, invocation)?;
        Ok(Arc::new(Self {
            shared,
            log: Arc::new(store),
            attempts: preview::Attempts::default(),
        }))
    }

    async fn start_owned<F, Fut>(
        self: Arc<Self>,
        execution: SessionExecutionScope,
        invocation: Invocation,
        tool_names: Arc<HashSet<String>>,
        handoff: Option<HandoffGate>,
        cancellation: CancellationToken,
        run: F,
    ) -> Result<RunningInvocation, RunError>
    where
        F: FnOnce(
                CancellationToken,
                tokio::sync::oneshot::Sender<()>,
                Arc<InvocationEffects>,
            ) -> Fut
            + Send
            + 'static,
        Fut: std::future::Future<Output = Result<ActivationExit, RunError>> + Send + 'static,
    {
        let session_id = invocation.session_id.clone();
        if !self
            .shared
            .active
            .lock()
            .map_err(|_| RunError::Internal("admission poisoned".into()))?
            .insert(session_id.clone())
        {
            return Err(RunError::Busy);
        }
        let admission = Admission {
            inner: self.shared.clone(),
            session_id,
            handoff: handoff.clone(),
        };
        let cancellation = cancellation.child_token();
        let cancel_on_drop = cancellation.clone().drop_guard();
        let worker_cancellation = cancellation.clone();
        let worker_invocation = invocation.clone();
        let (admitted, ready) = tokio::sync::oneshot::channel();
        let cleanup = cleanup::Evidence::default();
        let preview = self.attempts.subscribe();
        let context = self.clone();
        let worker = self.shared.workers.spawn(async move {
            use futures_util::FutureExt;

            // Only the original worker accepts physical custody. Its lease Drop
            // fences uncertain cleanup, including panic and runtime teardown.
            let _admission = admission;
            let (execution, effects) =
                match execution.accept_invocation(worker_invocation, worker_cancellation.clone()) {
                    Ok(accepted) => accepted,
                    Err(error) => {
                        return RunningCompletion {
                            result: Err(error.into()),
                            cleanup: Ok(()),
                        };
                    }
                };
            let effects = Arc::new(effects);
            let result = cleanup
                .scope(async {
                    // Keep the worker future out of the tracking and cleanup wrapper frames.
                    let result = std::panic::AssertUnwindSafe(Box::pin(async {
                        run(worker_cancellation.clone(), admitted, effects.clone()).await
                    }))
                    .catch_unwind()
                    .await
                    .unwrap_or_else(|_| {
                        worker_cancellation.cancel();
                        Err(cleanup::unconfirmed())
                    });
                    let result = match effects.settle().await {
                        Ok(()) => result,
                        Err(error) => model_attempt::additional_failure(result, error.into()),
                    };
                    model_attempt::seal_unfinished_attempts(&context, result).await
                })
                .await;
            let physical = if cleanup.confirmed()
                && !result.as_ref().is_err_and(RunError::is_cleanup_unconfirmed)
            {
                Ok(())
            } else {
                Err(CleanupUnconfirmed)
            };
            if physical.is_ok() {
                execution.finish();
            } else {
                execution.retain_unconfirmed();
            }
            RunningCompletion {
                result,
                cleanup: physical,
            }
        });
        if ready.await.is_err() {
            return match worker.await {
                Ok(completion) if completion.cleanup.is_err() => Err(RunError::CleanupUnconfirmed),
                Ok(completion) => match completion.result {
                    Err(error) => Err(error),
                    Ok(_) => Err(RunError::Internal(
                        "worker omitted durable admission".into(),
                    )),
                },
                Err(_) => Err(RunError::CleanupUnconfirmed),
            };
        }
        cancel_on_drop.disarm();
        Ok(RunningInvocation::new(
            invocation,
            tool_names,
            cancellation,
            handoff,
            preview,
            worker,
        ))
    }
}

impl Inner {
    fn loaded(&self, session: &str) -> maka_tools::availability::LoadedTools {
        maka_tools::availability::LoadedTools::new(self.session_backend.session(session))
    }
    fn loaded_snapshot(
        &self,
        session: &str,
    ) -> Result<std::collections::BTreeSet<String>, RunError> {
        Ok(self.session_backend.session(session).loaded()?)
    }
    fn clear_loaded(&self, session: &str) -> Result<(), RunError> {
        Ok(self
            .session_backend
            .session(session)
            .update_loaded(std::collections::BTreeSet::clear)?)
    }
}

/// Owns physical session admission and activations, including effects still
/// draining after the caller stops waiting.
#[derive(Clone)]
pub struct Engine(Arc<Inner>);

/// Engine-derived replay proof and its immutable input. Preparation uses registered
/// tools; model steps capture live bindings only after durable admission revalidates
/// the discovery basis. A changed basis requires fresh preparation.
pub struct PreparedContinuation {
    engine: std::sync::Weak<Inner>,
    store: SessionStore,
    input: RunInput,
    claim: continuation::PreparedClaim,
}
impl PreparedContinuation {
    pub fn invocation(&self) -> &Invocation {
        &self.input.invocation
    }
}

impl Engine {
    pub fn new(model: ModelExecutor, cells: CodeExecutor) -> Result<Self, RunError> {
        Self::create(model, cells, None)
    }

    pub fn with_pricing(
        model: ModelExecutor,
        cells: CodeExecutor,
        pricing: Arc<dyn pricing::Pricing>,
    ) -> Result<Self, RunError> {
        Self::create(model, cells, Some(pricing))
    }

    fn create(
        model: ModelExecutor,
        cells: CodeExecutor,
        pricing: Option<Arc<dyn pricing::Pricing>>,
    ) -> Result<Self, RunError> {
        let resources =
            maka_model::ModelPreparationResources::new(maka_model::PreparationPolicy::default())
                .map_err(|error| {
                    RunError::Internal(format!("create preparation resources: {error}"))
                })?;
        Self::with_resources(model, cells, pricing, resources)
    }

    /// Host engines share one explicit preparation allocation capability.
    pub fn with_resources(
        model: ModelExecutor,
        cells: CodeExecutor,
        pricing: Option<Arc<dyn pricing::Pricing>>,
        preparation_resources: maka_model::ModelPreparationResources,
    ) -> Result<Self, RunError> {
        Ok(Self(Arc::new(Inner {
            pricing,
            preparation_resources,
            model,
            cells,
            session_backend: maka_session_state::Backend::temporary()?,
            active: Mutex::new(HashSet::new()),
            workers: TaskTracker::new(),
        })))
    }

    pub async fn run(
        &self,
        store: SessionStore,
        input: RunInput,
        cancellation: CancellationToken,
    ) -> Result<ActivationExit, RunError> {
        self.start(store, input, cancellation).await?.wait().await
    }

    /// Host calls after session retirement has fenced and drained its runs.
    pub fn release_session_state(&self, session: &str) -> Result<(), RunError> {
        Ok(self.0.session_backend.session(session).retire()?)
    }

    /// Observe replay safety without reserving a source or creating a claim.
    /// Model continuation observation does not require a live tool catalog.
    /// Admission validates the claim against current canonical facts and prepares current tools.
    pub async fn check_continuation(
        &self,
        store: &SessionStore,
        input: &RunInput,
        cancellation: &CancellationToken,
    ) -> Result<(), RunError> {
        if !matches!(
            input.work,
            RunWork::Continuation { .. } | RunWork::Handoff { .. }
        ) {
            return Err(RunError::InvalidInput("not a continuation request".into()));
        }
        let execution = store
            .execution_scope(permission_basis(&input.configuration))
            .await?;
        let shared = self.0.clone();
        let input = input.clone();
        let cancellation = cancellation.child_token();
        let observer = cancellation.clone().drop_guard();
        let evidence = cleanup::current();
        let worker = self.0.workers.spawn(evidence.scope(async move {
            let (RunWork::Continuation { source, tools, .. }
            | RunWork::Handoff { source, tools, .. }) = &input.work
            else {
                unreachable!()
            };
            let context = RunContext::new(shared.clone(), execution.store(), &input.invocation)?;
            context
                .log
                .prepare_prune_candidates(&input.invocation.session_id, None, 0, 0, None)
                .await?;
            continuation::inspect(
                &context,
                &input,
                source,
                matches!(input.work, RunWork::Handoff { .. }).then_some(tools),
                &cancellation,
                &shared.loaded_snapshot(&input.invocation.session_id)?,
            )
            .await
            .map(|_| ())
        }));
        let result = worker
            .await
            .map_err(|error| cleanup::preparation_failed(std::io::Error::other(error)))?;
        observer.disarm();
        result
    }

    pub async fn prepare_continuation(
        &self,
        store: SessionStore,
        input: RunInput,
        cancellation: &CancellationToken,
    ) -> Result<PreparedContinuation, RunError> {
        if !matches!(
            input.work,
            RunWork::Continuation { .. } | RunWork::Handoff { .. }
        ) {
            return Err(RunError::InvalidInput("not a continuation request".into()));
        }
        let execution = store
            .execution_scope(permission_basis(&input.configuration))
            .await?;
        let shared = self.0.clone();
        let engine = Arc::downgrade(&self.0);
        let cancellation = cancellation.child_token();
        let observer = cancellation.clone().drop_guard();
        let evidence = cleanup::current();
        let worker = self.0.workers.spawn(evidence.scope(async move {
            let (RunWork::Continuation { source, tools, .. }
            | RunWork::Handoff { source, tools, .. }) = &input.work
            else {
                unreachable!()
            };
            let context = RunContext::new(shared, execution.store(), &input.invocation)?;
            context
                .log
                .prepare_prune_candidates(&input.invocation.session_id, None, 0, 0, None)
                .await?;
            let claim =
                continuation::prepare(&context, &input, source, tools, &cancellation).await?;
            Ok(PreparedContinuation {
                engine,
                store,
                input,
                claim,
            })
        }));
        let result = worker
            .await
            .map_err(|error| cleanup::preparation_failed(std::io::Error::other(error)))?;
        observer.disarm();
        result
    }

    pub async fn start_continuation(
        &self,
        prepared: PreparedContinuation,
        cancellation: CancellationToken,
    ) -> Result<RunningInvocation, RunError> {
        if !std::sync::Weak::ptr_eq(&prepared.engine, &Arc::downgrade(&self.0)) {
            return Err(RunError::InvalidInput(
                "continuation belongs to another Engine".into(),
            ));
        }
        self.start_model(
            prepared.store,
            prepared.input,
            Some(prepared.claim),
            cancellation,
        )
        .await
    }

    /// The owner first stops admissions and requests cancellation. This barrier
    /// also covers workers whose admission waiter was dropped before receiving
    /// a RunningInvocation handle.
    /// Caller must fence admission and request cancellation first. Tracking task
    /// termination alone does not confirm successful resource cleanup; retain
    /// and observe each original RunningCompletion separately.
    pub async fn drain(&self) {
        self.0.workers.close();
        self.0.workers.wait().await;
    }

    /// Returns only after durable admission. The returned owner covers execution
    /// and draining; dropping it requests cancellation without abandoning effects.
    pub async fn start(
        &self,
        store: SessionStore,
        input: RunInput,
        cancellation: CancellationToken,
    ) -> Result<RunningInvocation, RunError> {
        self.start_model(store, input, None, cancellation).await
    }

    async fn start_model(
        &self,
        store: SessionStore,
        input: RunInput,
        claim: Option<continuation::PreparedClaim>,
        cancellation: CancellationToken,
    ) -> Result<RunningInvocation, RunError> {
        if input.main_output_limit.is_some_and(|limit| limit == 0) {
            return Err(RunError::InvalidInput("invalid Main output limit".into()));
        }
        if let Some(context) = &input.context {
            context
                .validate()
                .map_err(|reason| RunError::InvalidInput(reason.into()))?;
        }
        match &input.work {
            RunWork::Handoff { source, pause, .. } => {
                pause
                    .validate(&source.invocation)
                    .map_err(|reason| RunError::InvalidInput(reason.into()))?;
                if input.invocation != pause.intent.successor(&source.invocation)
                    || input.request_fingerprint.is_some()
                    || input.context != pause.execution.context
                    || input.provider_options != pause.execution.provider_options
                    || input.main_output_limit != pause.execution.main_output_limit
                    || input.supports_vision != pause.execution.supports_vision
                    || model_attempt::route_identity(&input)?
                        != pause.execution.replay.route_identity
                {
                    return Err(RunError::InvalidInput(
                        "handoff execution settings changed".into(),
                    ));
                }
            }
            RunWork::Continuation { source, .. } => {
                if source.invocation.session_id != input.invocation.session_id
                    || input
                        .request_fingerprint
                        .as_ref()
                        .is_none_or(|s| !maka_agent_facts::archive::valid_projection_digest(s))
                {
                    return Err(RunError::InvalidInput(
                        "invalid continuation request".into(),
                    ));
                }
            }
            RunWork::ContextCompact
                if input
                    .request_fingerprint
                    .as_ref()
                    .is_none_or(|value| value.is_empty()) =>
            {
                return Err(RunError::InvalidInput(
                    "compaction requires request fingerprint".into(),
                ));
            }
            RunWork::Message {
                message,
                source_messages,
                ..
            } => {
                maka_agent_facts::message::validate_sources(message, source_messages)
                    .map_err(|reason| RunError::InvalidInput(reason.into()))?;
            }
            _ => {}
        }
        if !std::path::Path::new(&input.configuration.cwd).is_absolute()
            || input.configuration.cwd.contains('\0')
            || input
                .configuration
                .model
                .as_ref()
                .is_some_and(|binding| binding.model != input.provider.model)
        {
            return Err(RunError::InvalidInput(
                "invalid invocation configuration".into(),
            ));
        }
        let handoff = (!matches!(input.work, RunWork::ContextCompact)).then(|| {
            let root = match &input.work {
                RunWork::Handoff { pause, .. } => &pause.intent.root_run_id,
                _ => &input.invocation.run_id,
            };
            HandoffGate::new(input.invocation.clone(), root.clone())
        });
        require_session(&store, &input.invocation)?;
        let execution = store
            .execution_scope(permission_basis(&input.configuration))
            .await?;
        let inner = RunContext::new(self.0.clone(), execution.store(), &input.invocation)?;
        let invocation = input.invocation.clone();
        let tool_names = Arc::new(match &input.work {
            RunWork::Message { tools, .. }
            | RunWork::Continuation { tools, .. }
            | RunWork::Handoff { tools, .. } => tools.names().into_iter().collect(),
            RunWork::ContextCompact => Default::default(),
        });
        let worker_handoff = handoff.clone();
        inner
            .clone()
            .start_owned(
                execution,
                invocation,
                tool_names,
                handoff,
                cancellation,
                move |cancellation, admitted, effects| {
                    runner::run(
                        inner,
                        input,
                        cancellation,
                        admitted,
                        worker_handoff,
                        claim,
                        effects,
                    )
                },
            )
            .await
    }
}

fn require_session(store: &SessionStore, invocation: &Invocation) -> Result<(), RunError> {
    if store.id() != invocation.session_id {
        return Err(RunError::InvalidInput(
            "Session store does not match invocation".into(),
        ));
    }
    Ok(())
}

fn permission_basis(
    configuration: &InvocationConfiguration,
) -> Option<maka_agent_facts::workspace::PermissionBasis> {
    configuration
        .workspace_binding
        .map(|binding| maka_agent_facts::workspace::PermissionBasis {
            boundary_revision: configuration.boundary_revision,
            binding,
        })
}

struct Admission {
    inner: Arc<Inner>,
    session_id: String,
    handoff: Option<HandoffGate>,
}

impl Drop for Admission {
    fn drop(&mut self) {
        if let Some(handoff) = &self.handoff {
            handoff.close();
        }
        self.inner.active.lock().unwrap().remove(&self.session_id);
    }
}

#[cfg(test)]
mod session_state_tests;

#[cfg(test)]
mod test_support;
