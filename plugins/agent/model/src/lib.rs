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

pub use maka_capabilities::model_preparation::{
    ActivePreparation, DirectoryLease, ModelPreparationResources, PreparationPolicy,
    StagedPreparation, WorkLease,
};

mod cleanup;
pub use cleanup::{ModelCleanupObserver, StreamCleanupError, StreamCleanupStage};
mod delta;
pub use maka_agent_facts::model::error::ModelError;
pub use maka_agent_facts::model::error::ProviderFailure;
pub use maka_agent_facts::model::error::ProviderFailureReason;
pub use maka_agent_facts::model::prompt;
pub use maka_agent_facts::model::request::ProviderKind;
pub use maka_agent_facts::model::request::ToolChoiceMode;
pub mod adapters;
mod conversation;
mod network;
pub mod reasoning;
pub use conversation::Conversation;
pub use maka_agent_facts::model::ModelEvent;
pub use maka_agent_facts::model::assembly::StepBuilder;
pub use maka_agent_facts::tools::ToolDefinition;
pub use maka_agent_ports::model::Emission;

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

mod auth;
pub use auth::{AuthResolver, ProviderAuth};

/// Trusted configuration, never exposed to a Code Mode isolate or event log.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter: Option<String>,
    #[serde(skip)]
    pub capabilities: maka_agent_facts::configuration::ModelCapabilities,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_input: Option<maka_agent_facts::configuration::ImageInput>,
    #[serde(skip)]
    pub network: maka_network::Policy,
    pub kind: ProviderKind,
    pub model: String,
    pub base_url: String,
    #[serde(flatten)]
    pub auth: ProviderAuth,
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub headers: std::collections::BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_overlay: Option<serde_json::Map<String, Value>>,
}

/// Provider input projected from canonical facts, never a history authority.
pub struct ModelRequest {
    pub operation: maka_agent_facts::context::ModelOperation,
    pub language: maka_agent_facts::language::Language,
    pub provider: ProviderConfig,
    pub prompt: prompt::Prompt,
    pub tools: Vec<Arc<ToolDefinition>>,
    pub tool_choice: ToolChoiceMode,
    pub provider_options: Value,
    pub max_output_tokens: Option<u64>,
}

impl ProviderConfig {
    pub fn adapter_name(&self) -> &str {
        self.adapter
            .as_deref()
            .unwrap_or_else(|| adapters::name(&self.kind))
    }
    pub fn tool_context(&self) -> maka_agent_facts::tools::ModelToolContext {
        use maka_agent_facts::tools::ProviderToolProtocol;
        maka_agent_facts::tools::ModelToolContext {
            model: self.model.clone(),
            capabilities: self.capabilities,
            provider_tools: match self.kind {
                ProviderKind::OpenaiResponses => Some(ProviderToolProtocol::OpenaiResponses),
                ProviderKind::Anthropic => Some(ProviderToolProtocol::AnthropicMessages),
                _ => None,
            },
        }
    }
}

/// Complete JSON encodings before transport-level prefix reuse.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EncodedRequestBytes {
    pub http: u64,
    pub websocket: Option<u64>,
}
impl EncodedRequestBytes {
    /// Both transports must fit because Responses may fall back to HTTP.
    pub fn largest(self) -> u64 {
        self.http.max(self.websocket.unwrap_or(0))
    }
}

impl ModelRequest {
    /// Counts the complete HTTP JSON body using the selected built-in codec.
    /// Reopens immutable prompt sources without uploading or retaining body bytes.
    pub async fn encoded_request_bytes(&self) -> Result<u64, ModelError> {
        Ok(self.encoded_request_sizes().await?.http)
    }

    /// Counts complete HTTP and, where available, Responses WebSocket JSON bodies.
    pub async fn encoded_request_sizes(&self) -> Result<EncodedRequestBytes, ModelError> {
        adapters::encoded_request_bytes(self).await
    }

    fn into_adapter(self) -> Result<maka_agent_facts::model::request::Request, ModelError> {
        use maka_agent_facts::model::request::Credentials;
        use maka_agent_facts::model::request::Provider;
        use maka_agent_facts::model::request::Request;
        let auth = match self.provider.auth {
            ProviderAuth::ApiKey(key) => Credentials::ApiKey(key),
            ProviderAuth::RequestHeaders(headers) => Credentials::RequestHeaders(headers),
            ProviderAuth::Bound { .. } => {
                return Err(ModelError::Adapter("unresolved model credentials".into()));
            }
        };
        Ok(Request {
            operation: self.operation,
            language: self.language,
            provider: Provider {
                kind: self.provider.kind,
                model: self.provider.model,
                base_url: self.provider.base_url,
                auth,
                headers: self.provider.headers,
                body_overlay: self.provider.body_overlay,
            },
            prompt: self.prompt,
            tools: self.tools,
            tool_choice: self.tool_choice,
            provider_options: self.provider_options,
            max_output_tokens: self.max_output_tokens,
        })
    }
}

/// Bounded stream of runtime events, independent of the selected adapter.
pub struct ModelStream {
    receiver: mpsc::Receiver<Result<Emission, ModelError>>,
    cancellation: CancellationToken,
    worker: StreamWorker,
    cleanup: ModelCleanupObserver,
    output: StreamOutput,
    pending_delta: Option<delta::PendingDelta>,
}

enum StreamWorker {
    Running(tokio::task::JoinHandle<Result<(), StreamCleanupError>>),
    Joined(Result<(), StreamCleanupError>),
}

enum StreamOutput {
    Receiving,
    Finished,
    Ended,
}

impl ModelStream {
    pub fn cleanup_observer(&self) -> ModelCleanupObserver {
        self.cleanup.clone()
    }
    pub async fn next(&mut self) -> Option<Result<Emission, ModelError>> {
        if matches!(self.output, StreamOutput::Ended) {
            return None;
        }
        loop {
            if self.cancellation.is_cancelled() {
                self.pending_delta = None;
            } else if let Some(event) = self.pending_delta.as_mut().and_then(Iterator::next) {
                return Some(Ok(event));
            } else {
                self.pending_delta = None;
            }
            let received = match &mut self.worker {
                StreamWorker::Running(worker) => {
                    tokio::select! {
                        biased;
                        event = self.receiver.recv() => event,
                        result = worker => {
                            let cleanup = result.unwrap_or_else(|error|Err(self.cleanup.unobservable(StreamCleanupStage::Worker,Arc::new(error),None)));
                            let unconfirmed = cleanup.is_err();
                            self.worker = StreamWorker::Joined(cleanup);
                            self.receiver.close();
                            if unconfirmed {
                                self.output = StreamOutput::Ended;
                                return Some(Err(ModelError::CleanupUnconfirmed));
                            }
                            continue;
                        }
                    }
                }
                StreamWorker::Joined(_) => self.receiver.recv().await,
            };
            let result = match received {
                // Preserve the worker's cancellation/deadline cause, but do not
                // keep journaling buffered output after cancellation.
                Some(Ok(_)) if self.cancellation.is_cancelled() => continue,
                Some(Ok(_)) if matches!(self.output, StreamOutput::Finished) => {
                    Err(ModelError::Adapter("event after model finish".into()))
                }
                Some(Ok(value)) => {
                    if matches!(value.event, ModelEvent::Finished { .. }) {
                        self.output = StreamOutput::Finished;
                    }
                    Ok(Some(value))
                }
                Some(Err(error)) => Err(error),
                None => {
                    let finished = matches!(self.output, StreamOutput::Finished);
                    self.output = StreamOutput::Ended;
                    if self.cancellation.is_cancelled() {
                        return Some(Err(ModelError::Cancelled));
                    }
                    return (!finished).then(|| {
                        Err(ModelError::Adapter(
                            "model stream ended without finish".into(),
                        ))
                    });
                }
            };
            match result {
                Ok(None) => continue,
                Ok(Some(Emission {
                    event:
                        ModelEvent::PartDelta {
                            id,
                            text,
                            provider_options,
                        },
                    reservation,
                })) if text.len() > 8 * 1024 => {
                    self.pending_delta = Some(delta::PendingDelta::new(
                        id,
                        text,
                        delta::DeltaKind::Part(provider_options),
                        reservation,
                    ));
                }
                Ok(Some(Emission {
                    event: ModelEvent::ToolInputDelta { id, text },
                    reservation,
                })) if !text.is_empty() => {
                    self.pending_delta = Some(delta::PendingDelta::new(
                        id,
                        text,
                        delta::DeltaKind::ToolInput,
                        reservation,
                    ));
                }
                Ok(Some(event)) => return Some(Ok(event)),
                Err(error) => {
                    self.output = StreamOutput::Ended;
                    self.cancellation.cancel();
                    self.receiver.close();
                    return Some(Err(error));
                }
            }
        }
    }

    pub async fn cancel_and_wait(mut self) -> Result<(), StreamCleanupError> {
        self.cancellation.cancel();
        self.receiver.close();
        self.pending_delta = None;
        while self.receiver.try_recv().is_ok() {}
        let original = self.cleanup.clone();
        let joined = async {
            match &mut self.worker {
                StreamWorker::Running(worker) => worker.await.unwrap_or_else(|error| {
                    Err(original.unobservable(StreamCleanupStage::Worker, Arc::new(error), None))
                }),
                StreamWorker::Joined(result) => result.clone(),
            }
        };
        match tokio::time::timeout(Duration::from_secs(6), joined).await {
            Ok(result) => result,
            Err(_) => Err(self.cleanup.pending()),
        }
    }
}

impl Drop for ModelStream {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

#[derive(Clone)]
pub struct ModelExecutor {
    idle_timeout: Duration,
    adapters: std::collections::BTreeMap<String, maka_agent_ports::model::Binding>,
    networks: Arc<network::Pool>,
}

#[derive(Clone, Debug)]
pub enum StreamOpeningError {
    Preparation(ModelError),
    Cleanup(StreamCleanupError),
}
impl std::fmt::Display for StreamOpeningError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Preparation(error) => std::fmt::Display::fmt(error, f),
            Self::Cleanup(error) => std::fmt::Display::fmt(error, f),
        }
    }
}
impl std::error::Error for StreamOpeningError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Preparation(error) => Some(error),
            Self::Cleanup(error) => Some(error),
        }
    }
}

/// A provider login uses the same proxy routing and HTTP implementation as model requests.
pub fn provider_transport(
    policy: &maka_network::Policy,
) -> Result<Arc<dyn maka_agent_ports::model::Transport>, ModelError> {
    network::Pool::default()
        .get(policy)
        .map(|network| network as Arc<dyn maka_agent_ports::model::Transport>)
}

impl ModelExecutor {
    /// Providers and adapters share Host proxy routing and connection pools.
    pub fn transport(
        &self,
        policy: &maka_network::Policy,
    ) -> Result<Arc<dyn maka_agent_ports::model::Transport>, ModelError> {
        self.networks
            .get(policy)
            .map(|network| network as Arc<dyn maka_agent_ports::model::Transport>)
    }

    pub fn new(idle_timeout: Duration) -> Result<Self, ModelError> {
        Self::build(
            idle_timeout,
            maka_agent_facts::composition::SourceRevision {
                kind: maka_agent_facts::composition::SourceKind::ModelAdapter,
                name: "maka-model".into(),
                package_id: "maka-model".into(),
                entry_id: "maka-model".into(),
                activation: uuid::Uuid::new_v4().to_string(),
                revision: env!("CARGO_PKG_VERSION").into(),
            },
        )
    }

    /// Bind compiled protocol implementations to the actual application owner.
    pub fn for_source(
        idle_timeout: Duration,
        source: maka_agent_facts::composition::SourceRevision,
    ) -> Result<Self, ModelError> {
        Self::build(idle_timeout, source)
    }

    fn build(
        idle_timeout: Duration,
        source: maka_agent_facts::composition::SourceRevision,
    ) -> Result<Self, ModelError> {
        if idle_timeout.is_zero() {
            return Err(ModelError::Adapter("invalid model execution limits".into()));
        }
        Ok(Self {
            idle_timeout,
            adapters: adapters::builtin(source),
            networks: Arc::default(),
        })
    }

    /// Replace the compiled bindings supplied by the execution owner.
    pub fn with_adapters(
        mut self,
        adapters: std::collections::BTreeMap<String, maka_agent_ports::model::Binding>,
    ) -> Self {
        self.adapters = adapters;
        self
    }

    pub fn binding(
        &self,
        provider: &ProviderConfig,
    ) -> Result<maka_agent_ports::model::Binding, ModelError> {
        let name = provider.adapter_name();
        self.adapters
            .get(name)
            .cloned()
            .ok_or_else(|| ModelError::Adapter(format!("model adapter is unavailable: {name}")))
    }

    pub async fn stream(
        &self,
        request: ModelRequest,
        cancellation: CancellationToken,
    ) -> Result<ModelStream, ModelError> {
        self.stream_in_conversation(request, cancellation, None)
            .await
    }

    pub async fn stream_in_conversation(
        &self,
        request: ModelRequest,
        cancellation: CancellationToken,
        conversation: Option<Conversation>,
    ) -> Result<ModelStream, ModelError> {
        let binding = self.binding(&request.provider)?;
        self.stream_with_adapter(request, cancellation, conversation, binding)
            .await
    }

    pub async fn stream_with_adapter(
        &self,
        request: ModelRequest,
        cancellation: CancellationToken,
        conversation: Option<Conversation>,
        binding: maka_agent_ports::model::Binding,
    ) -> Result<ModelStream, ModelError> {
        match self
            .stream_with_source(request, cancellation, conversation, binding, None)
            .await
        {
            Ok(stream) => Ok(stream),
            Err(StreamOpeningError::Preparation(error)) => Err(error),
            Err(StreamOpeningError::Cleanup(_)) => {
                unreachable!("an unscoped stream cannot own a source cleanup failure")
            }
        }
    }

    pub async fn stream_with_source(
        &self,
        mut request: ModelRequest,
        cancellation: CancellationToken,
        conversation: Option<Conversation>,
        binding: maka_agent_ports::model::Binding,
        source: Option<maka_agent_ports::model::RequestSource>,
    ) -> Result<ModelStream, StreamOpeningError> {
        let cancellation = cancellation.child_token();
        let prepared = async {
            for tool in &request.tools {
                if let Some(provider) = &tool.provider {
                    provider
                        .validate()
                        .map_err(|error| ModelError::Adapter(error.into()))?;
                    let protocol = request.provider.tool_context().provider_tools;
                    let compatible = match protocol {
                        Some(maka_agent_facts::tools::ProviderToolProtocol::OpenaiResponses) => {
                            provider.id.starts_with("openai.")
                        }
                        Some(maka_agent_facts::tools::ProviderToolProtocol::AnthropicMessages) => {
                            provider.id.starts_with("anthropic.")
                        }
                        None => false,
                    };
                    if !compatible {
                        return Err(ModelError::Adapter(
                            "provider tool does not match the selected adapter".into(),
                        ));
                    }
                }
            }
            // Public requests also cross JSON clients. Keep their integer contract
            // independent of the selected provider implementation.
            if request
                .max_output_tokens
                .is_some_and(|value| value == 0 || value > 9_007_199_254_740_991)
            {
                return Err(ModelError::Adapter(
                    "maxOutputTokens must be a positive JavaScript safe integer".into(),
                ));
            }
            request.prompt = reasoning::normalize(request.prompt, &request.provider.kind)?;
            if let Some(source) = &source {
                source.frozen.authorize(cancellation.clone()).await?;
            }
            let authenticated = tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err(ModelError::Cancelled),
                result = auth::resolve(&mut request.provider.auth) => result,
            };
            if let Err(error) = &authenticated
                && error.cleanup_unconfirmed()
            {
                return Err(error.clone());
            }
            if let Some(source) = &source {
                source.frozen.authorize(cancellation.clone()).await?;
            }
            authenticated?;
            if let Some(limit) = request
                .provider
                .image_input
                .as_ref()
                .and_then(|image| image.request_bytes)
            {
                let measured = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => Err(ModelError::Cancelled),
                    result = request.encoded_request_sizes() => result,
                };
                if measured
                    .as_ref()
                    .is_err_and(|error| error.cleanup_unconfirmed())
                {
                    return Err(measured.err().expect("failed physical preparation"));
                }
                if let Some(source) = &source {
                    source.frozen.authorize(cancellation.clone()).await?;
                }
                let bytes = measured?.largest();
                if bytes > limit {
                    return Err(ModelError::ImageInputPayloadTooLarge { bytes, limit });
                }
            }
            let network = self.networks.get(&request.provider.network)?;
            let request = request.into_adapter()?;
            Ok((request, network))
        }
        .await;
        let (request, network) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                let error = if !error.cleanup_unconfirmed() {
                    source
                        .as_ref()
                        .and_then(|source| source.frozen.authorization_failure())
                        .unwrap_or(error)
                } else {
                    error
                };
                if let Some(source) = source {
                    if error.cleanup_unconfirmed() {
                        return Err(StreamOpeningError::Cleanup(
                            StreamCleanupError::Unobservable {
                                stage: StreamCleanupStage::Adapter,
                                cause: Arc::new(error),
                                original: source.frozen.authorization_failure().map(Arc::new),
                                material: Some(source),
                            },
                        ));
                    }
                    if let Err(cleanup) = source.cleanup.close().await {
                        return Err(StreamOpeningError::Cleanup(
                            StreamCleanupError::Unobservable {
                                stage: StreamCleanupStage::Source,
                                cause: Arc::new(cleanup),
                                original: Some(Arc::new(error)),
                                material: Some(source),
                            },
                        ));
                    }
                }
                return Err(StreamOpeningError::Preparation(error));
            }
        };
        let (sender, receiver) = mpsc::channel(4);
        let worker_cancel = cancellation.clone();
        let idle_timeout = self.idle_timeout;
        let watchdog = !binding.enforces_idle_timeout();
        let (cleanup_sender, cleanup_observer) = ModelCleanupObserver::channel(source.clone());
        let original_cleanup = cleanup_observer.clone();
        let worker = tokio::spawn(async move {
            let failure_sender = sender.clone();
            let adapter_cancel = worker_cancel.child_token();
            let _settlement = adapter_cancel.clone().drop_guard();
            let (activity, mut progress) = tokio::sync::watch::channel(tokio::time::Instant::now());
            let events: Arc<dyn maka_agent_ports::model::Events> =
                Arc::new(ChannelEvents { sender, activity });
            let network = Arc::new(network::Call {
                transport: network,
                events: events.clone(),
                cancellation: adapter_cancel.clone(),
                source: source.clone(),
            });
            let operation = async {
                if let Some(source) = &source {
                    source.frozen.authorize(adapter_cancel.clone()).await?;
                }
                let session = match conversation {
                    Some(conversation) => {
                        conversation
                            .session(&binding, adapter_cancel.clone())
                            .await?
                    }
                    None => {
                        binding
                            .open(
                                maka_agent_ports::model::Lifetime::Request,
                                adapter_cancel.clone(),
                            )
                            .await?
                    }
                };
                session
                    .stream(
                        request,
                        maka_agent_ports::model::Context {
                            events,
                            cancellation: adapter_cancel.clone(),
                            idle_timeout,
                            transport: network,
                            source: source.clone(),
                        },
                    )
                    .await
            };
            let mut operation = Box::pin(operation);
            let mut original_cause = None;
            let (reported, result) = loop {
                let deadline = *progress.borrow_and_update() + idle_timeout;
                let cause = tokio::select! {
                    biased;
                    result=&mut operation=>break (false,result),
                    _=worker_cancel.cancelled()=>ModelError::Cancelled,
                    _=tokio::time::sleep_until(deadline),if watchdog=>ModelError::TimedOut,
                    Ok(())=progress.changed()=>continue,
                };
                original_cause = Some(Arc::new(cause.clone()));
                cleanup_sender.send_replace(cleanup::Observation::Running(original_cause.clone()));
                adapter_cancel.cancel();
                let _ = failure_sender.send(Err(cause)).await;
                // The caller's six-second budget never owns or drops this original future.
                break (true, operation.as_mut().await);
            };
            drop(operation);
            adapter_cancel.cancel();
            if !reported {
                if let Err(error) = &result {
                    let cause = source
                        .as_ref()
                        .and_then(|source| source.frozen.authorization_failure())
                        .unwrap_or_else(|| error.clone());
                    original_cause = Some(Arc::new(cause.clone()));
                    cleanup_sender
                        .send_replace(cleanup::Observation::Running(original_cause.clone()));
                    let _ = failure_sender.send(Err(cause)).await;
                }
            }
            let cleanup = if let Err(error) = result {
                if error.cleanup_unconfirmed() {
                    Err(original_cleanup.unobservable(
                        StreamCleanupStage::Adapter,
                        Arc::new(error),
                        original_cause.clone(),
                    ))
                } else {
                    Ok(())
                }
            } else {
                Ok(())
            };
            let cleanup = match cleanup {
                Err(error) => Err(error),
                Ok(()) => match &source {
                    Some(source) => source.cleanup.close().await.map_err(|error| {
                        original_cleanup.unobservable(
                            StreamCleanupStage::Source,
                            Arc::new(error),
                            original_cause,
                        )
                    }),
                    None => Ok(()),
                },
            };
            match &cleanup {
                Ok(()) => {
                    original_cleanup.release_material();
                    cleanup_sender.send_replace(cleanup::Observation::Confirmed);
                }
                Err(error) => {
                    cleanup_sender.send_replace(cleanup::Observation::Unobservable(error.clone()));
                }
            }
            cleanup
        });
        Ok(ModelStream {
            receiver,
            cancellation,
            worker: StreamWorker::Running(worker),
            cleanup: cleanup_observer,
            output: StreamOutput::Receiving,
            pending_delta: None,
        })
    }
}

struct ChannelEvents {
    sender: mpsc::Sender<Result<Emission, ModelError>>,
    activity: tokio::sync::watch::Sender<tokio::time::Instant>,
}
impl maka_agent_ports::model::Events for ChannelEvents {
    fn progress(&self) {
        self.activity.send_replace(tokio::time::Instant::now());
    }
    fn emit(&self, event: Emission) -> futures_util::future::BoxFuture<'_, Result<(), ModelError>> {
        Box::pin(async move {
            self.progress();
            self.sender
                .send(Ok(event))
                .await
                .map_err(|_| ModelError::Cancelled)
        })
    }
}

pub use adapters::wire::{
    EncodedWire, FrozenWire, SummaryWireBound, WireEncoding, WirePlan, WireSink, WireWrite,
};
