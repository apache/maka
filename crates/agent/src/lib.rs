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
mod compact;
mod continuation;
mod executor;
pub use executor::ExecutorInput;
mod handoff;
pub use handoff::{HandoffGate, HandoffReservation, HeldHandoff, PendingSeal};
mod history;
mod interactions;
mod model_attempt;
mod model_source;
pub use model_source::{ModelSource, PreparedModel};
pub mod pricing;
mod request_composition;
pub use history::project as project_model_history;
mod prune;
pub mod recovery;
mod runner;
mod running;
mod steps;
pub use running::RunningInvocation;

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use maka_event_log::{EventLog, StoreError};
use maka_js_runtime::CodeExecutor;
use maka_model::{ModelError, ModelExecutor, ProviderConfig};
use maka_runtime::event::{CommitError, Invocation};
use maka_runtime::execution::InvocationConfiguration;
use maka_runtime::input::MessageInput;
use maka_runtime::tools::ToolError;
use maka_tools::ToolCatalog;
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error("session already has an active invocation")]
    Busy,
    #[error("session requires reconciliation before another invocation: {0}")]
    ReconciliationRequired(String),
    #[error("invalid execution input: {0}")]
    InvalidInput(String),
    #[error("execution cancelled")]
    Cancelled,
    #[error("model step limit reached")]
    StepLimit,
    #[error("model output was incomplete; local tools from this response were not executed")]
    ModelIncomplete,
    #[error(transparent)]
    Commit(#[from] CommitError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Model(#[from] ModelError),
    #[error(transparent)]
    Tool(#[from] ToolError),
    #[error("execution worker failed: {0}")]
    Internal(String),
}

#[derive(Clone)]
pub struct RunInput {
    /// Optional for standalone adapters; Host executions supply a public provider source.
    pub model_source: Option<Arc<dyn ModelSource>>,
    pub model_revision: Option<maka_runtime::composition::SourceRevision>,
    /// Public access-path identity; not the transport protocol or adapter name.
    pub provider_id: String,
    pub invocation: Invocation,
    pub context: Option<maka_runtime::context::ModelRequestContext>,
    pub work: RunWork,
    /// Stable domain admission identity, when this invocation was client-issued.
    pub request_fingerprint: Option<String>,
    pub provider: ProviderConfig,
    pub provider_options: Value,
    /// Resolved SDK reply budget; summaries additionally cap their text at 8K.
    pub main_output_limit: Option<u64>,
    /// Current selected-model capability; image bytes are projected per request.
    pub supports_vision: bool,
    pub configuration: InvocationConfiguration,
}

#[derive(Clone)]
pub enum RunWork {
    Handoff {
        source: maka_runtime::continuation::RunBoundary,
        pause: Box<maka_runtime::handoff::HandoffPause>,
        tools: ToolCatalog,
    },
    Continuation {
        source: maka_runtime::continuation::RunBoundary,
        tools: ToolCatalog,
        max_steps: usize,
    },
    Message {
        message: MessageInput,
        source_messages: Vec<maka_runtime::message::RootSourceMessage>,
        tools: ToolCatalog,
        max_steps: usize,
        /// Only a newly submitted client Turn may observe a sealed, unknown prior tool effect.
        allow_prior_unknown: bool,
    },
    ContextCompact,
}

struct Inner {
    pricing: Option<Arc<dyn pricing::Pricing>>,
    log: Arc<EventLog>,
    model: ModelExecutor,
    cells: CodeExecutor,
    code_stores: Mutex<std::collections::HashMap<String, maka_js_runtime::CellStore>>,
    active: Mutex<HashSet<String>>,
    workers: TaskTracker,
}

/// Owns session admission and the entire invocation lifetime, including effects
/// still draining after the caller stops waiting.
#[derive(Clone)]
pub struct Engine(Arc<Inner>);

/// Engine-derived replay proof and its immutable input. Preparation may call
/// plugin providers; durable admission consumes this without calling them again.
pub struct PreparedContinuation {
    engine: std::sync::Weak<Inner>,
    input: RunInput,
    claim: maka_runtime::continuation::ContinuationClaim,
}
impl PreparedContinuation {
    pub fn invocation(&self) -> &Invocation {
        &self.input.invocation
    }
}

impl Engine {
    pub fn new(log: Arc<EventLog>, model: ModelExecutor, cells: CodeExecutor) -> Self {
        Self::create(log, model, cells, None)
    }

    pub fn with_pricing(
        log: Arc<EventLog>,
        model: ModelExecutor,
        cells: CodeExecutor,
        pricing: Arc<dyn pricing::Pricing>,
    ) -> Self {
        Self::create(log, model, cells, Some(pricing))
    }

    fn create(
        log: Arc<EventLog>,
        model: ModelExecutor,
        cells: CodeExecutor,
        pricing: Option<Arc<dyn pricing::Pricing>>,
    ) -> Self {
        Self(Arc::new(Inner {
            pricing,
            log,
            model,
            cells,
            code_stores: Mutex::default(),
            active: Mutex::new(HashSet::new()),
            workers: TaskTracker::new(),
        }))
    }

    pub async fn run(
        &self,
        input: RunInput,
        cancellation: CancellationToken,
    ) -> Result<Invocation, RunError> {
        self.start(input, cancellation).await?.wait().await
    }

    /// Host calls after session retirement has fenced and drained its runs.
    pub fn release_code_store(&self, session: &str) {
        self.0.code_stores.lock().unwrap().remove(session);
    }

    /// Observe replay safety without reserving a source or creating a claim.
    /// Admission validates the claim against current canonical facts.
    pub async fn check_continuation(
        &self,
        input: &RunInput,
        cancellation: &CancellationToken,
    ) -> Result<(), RunError> {
        let (RunWork::Continuation { source, tools, .. } | RunWork::Handoff { source, tools, .. }) =
            &input.work
        else {
            return Err(RunError::InvalidInput("not a continuation request".into()));
        };
        self.0
            .log
            .prepare_prune_candidates(&input.invocation.session_id, None, 0, 0, None)
            .await?;
        continuation::inspect(&self.0, input, source, tools, cancellation)
            .await
            .map(|_| ())
    }

    pub async fn prepare_continuation(
        &self,
        input: RunInput,
        cancellation: &CancellationToken,
    ) -> Result<PreparedContinuation, RunError> {
        let (RunWork::Continuation { source, tools, .. } | RunWork::Handoff { source, tools, .. }) =
            &input.work
        else {
            return Err(RunError::InvalidInput("not a continuation request".into()));
        };
        self.0
            .log
            .prepare_prune_candidates(&input.invocation.session_id, None, 0, 0, None)
            .await?;
        let claim = continuation::prepare(&self.0, &input, source, tools, cancellation).await?;
        Ok(PreparedContinuation {
            engine: Arc::downgrade(&self.0),
            input,
            claim,
        })
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
        self.start_model(prepared.input, Some(prepared.claim), cancellation)
            .await
    }

    /// The owner first stops admissions and requests cancellation. This barrier
    /// also covers workers whose admission waiter was dropped before receiving
    /// a RunningInvocation handle.
    pub async fn drain(&self) {
        self.0.workers.close();
        self.0.workers.wait().await;
    }

    /// Returns only after durable admission. The returned owner covers execution
    /// and draining; dropping it requests cancellation without abandoning effects.
    pub async fn start(
        &self,
        input: RunInput,
        cancellation: CancellationToken,
    ) -> Result<RunningInvocation, RunError> {
        self.start_model(input, None, cancellation).await
    }

    async fn start_model(
        &self,
        input: RunInput,
        claim: Option<maka_runtime::continuation::ContinuationClaim>,
        cancellation: CancellationToken,
    ) -> Result<RunningInvocation, RunError> {
        if input
            .main_output_limit
            .is_some_and(|limit| limit == 0 || limit > 10_000_000_000)
        {
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
            RunWork::Message {
                message, max_steps, ..
            } if *max_steps == 0 || *max_steps > 256 || message.text_bytes() > 64 * 1024 => {
                return Err(RunError::InvalidInput("step or message limit".into()));
            }
            RunWork::Continuation {
                source, max_steps, ..
            } => {
                if *max_steps == 0
                    || *max_steps > 256
                    || source.invocation.session_id != input.invocation.session_id
                    || input
                        .request_fingerprint
                        .as_ref()
                        .is_none_or(|s| !maka_runtime::archive::valid_projection_digest(s))
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
                maka_runtime::message::validate_sources(message, source_messages)
                    .map_err(|reason| RunError::InvalidInput(reason.into()))?;
            }
            _ => {}
        }
        if !std::path::Path::new(&input.configuration.cwd).is_absolute()
            || input.configuration.cwd.len() > 4096
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
        let inner = self.0.clone();
        let invocation = input.invocation.clone();
        let tool_names = Arc::new(match &input.work {
            RunWork::Message { tools, .. }
            | RunWork::Continuation { tools, .. }
            | RunWork::Handoff { tools, .. } => tools.names().into_iter().collect(),
            RunWork::ContextCompact => Default::default(),
        });
        let worker_handoff = handoff.clone();
        self.start_owned(
            invocation,
            tool_names,
            handoff,
            cancellation,
            move |cancellation, admitted| {
                runner::run(inner, input, cancellation, admitted, worker_handoff, claim)
            },
        )
        .await
    }

    async fn start_owned<F, Fut>(
        &self,
        invocation: Invocation,
        tool_names: Arc<HashSet<String>>,
        handoff: Option<HandoffGate>,
        cancellation: CancellationToken,
        run: F,
    ) -> Result<RunningInvocation, RunError>
    where
        F: FnOnce(CancellationToken, tokio::sync::oneshot::Sender<()>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<Invocation, RunError>> + Send + 'static,
    {
        let session_id = invocation.session_id.clone();
        if !self
            .0
            .active
            .lock()
            .map_err(|_| RunError::Internal("admission poisoned".into()))?
            .insert(session_id.clone())
        {
            return Err(RunError::Busy);
        }
        let admission = Admission {
            inner: self.0.clone(),
            session_id,
            handoff: handoff.clone(),
        };
        let cancellation = cancellation.child_token();
        let cancel_on_drop = cancellation.clone().drop_guard();
        let worker_cancellation = cancellation.clone();
        let (admitted, ready) = tokio::sync::oneshot::channel();
        let worker = self.0.workers.spawn(async move {
            let _admission = admission;
            run(worker_cancellation, admitted).await
        });
        if ready.await.is_err() {
            return match worker.await {
                Ok(Err(error)) => Err(error),
                Ok(Ok(_)) => Err(RunError::Internal(
                    "worker omitted durable admission".into(),
                )),
                Err(error) => Err(RunError::Internal(error.to_string())),
            };
        }
        cancel_on_drop.disarm();
        Ok(RunningInvocation::new(
            invocation,
            tool_names,
            cancellation,
            handoff,
            worker,
        ))
    }
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
