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

mod delta;
pub use maka_agent_facts::model::error::ModelError;
pub use maka_agent_facts::model::error::ProviderFailure;
pub use maka_agent_facts::model::error::ProviderFailureReason;
pub use maka_agent_facts::model::prompt;
pub use maka_agent_facts::model::request::ProviderKind;
pub mod adapters;
mod conversation;
mod network;
pub mod reasoning;
mod step;
pub use conversation::Conversation;
pub use maka_agent_facts::model::ModelEvent;
pub use maka_agent_facts::tools::ToolDefinition;
pub use maka_agent_ports::model::Emission;
pub use step::StepBuilder;

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
    pub language: maka_agent_facts::language::Language,
    pub provider: ProviderConfig,
    pub prompt: prompt::Prompt,
    pub tools: Vec<ToolDefinition>,
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

impl ModelRequest {
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
            provider_options: self.provider_options,
            max_output_tokens: self.max_output_tokens,
        })
    }
}

/// Bounded stream of runtime events, independent of the selected adapter.
pub struct ModelStream {
    receiver: mpsc::Receiver<Result<Emission, ModelError>>,
    cancellation: CancellationToken,
    worker: Option<tokio::task::JoinHandle<Result<(), StreamCleanupError>>>,
    cleanup: Result<(), StreamCleanupError>,
    finished: bool,
    pending_delta: Option<delta::PendingDelta>,
    ended: bool,
}

/// Physical stream ownership was lost or a cancelled adapter failed to drain.
/// This is separate from a provider's ordinary business failure.
#[derive(Clone, Debug, thiserror::Error)]
#[error("model stream cleanup is unconfirmed")]
pub struct StreamCleanupError;

impl ModelStream {
    pub async fn next(&mut self) -> Option<Result<Emission, ModelError>> {
        if self.ended {
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
            let received = if let Some(worker) = self.worker.as_mut() {
                tokio::select! {
                    biased;
                    event = self.receiver.recv() => event,
                    result = worker => {
                        self.worker = None;
                        self.receiver.close();
                        self.cleanup = result.unwrap_or(Err(StreamCleanupError));
                        if self.cleanup.is_err() {
                            self.ended = true;
                            return Some(Err(ModelError::CleanupUnconfirmed));
                        }
                        continue;
                    }
                }
            } else {
                self.receiver.recv().await
            };
            let result = match received {
                // Preserve the worker's cancellation/deadline cause, but do not
                // keep journaling buffered output after cancellation.
                Some(Ok(_)) if self.cancellation.is_cancelled() => continue,
                Some(Ok(_)) if self.finished => {
                    Err(ModelError::Adapter("event after model finish".into()))
                }
                Some(Ok(value)) => {
                    self.finished = matches!(value.event, ModelEvent::Finished { .. });
                    Ok(Some(value))
                }
                Some(Err(error)) => Err(error),
                None => {
                    self.ended = true;
                    if self.cancellation.is_cancelled() {
                        return Some(Err(ModelError::Cancelled));
                    }
                    return (!self.finished).then(|| {
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
                    self.ended = true;
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
        if let Some(worker) = self.worker.take() {
            self.cleanup = worker.await.unwrap_or(Err(StreamCleanupError));
        }
        self.cleanup.clone()
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

/// A provider login uses the same proxy routing and HTTP implementation as model requests.
pub fn provider_transport(
    policy: &maka_network::Policy,
) -> Result<Arc<dyn maka_agent_ports::model::Transport>, ModelError> {
    network::Pool::default().get(policy)
}

impl ModelExecutor {
    /// Providers and adapters share Host proxy routing and connection pools.
    pub fn transport(
        &self,
        policy: &maka_network::Policy,
    ) -> Result<Arc<dyn maka_agent_ports::model::Transport>, ModelError> {
        self.networks.get(policy)
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
        mut request: ModelRequest,
        cancellation: CancellationToken,
        conversation: Option<Conversation>,
        binding: maka_agent_ports::model::Binding,
    ) -> Result<ModelStream, ModelError> {
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
        let cancellation = cancellation.child_token();
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(ModelError::Cancelled),
            result = auth::resolve(&mut request.provider.auth) => result?,
        }
        let (sender, receiver) = mpsc::channel(4);
        let worker_cancel = cancellation.clone();
        let idle_timeout = self.idle_timeout;
        let watchdog = !binding.enforces_idle_timeout();
        let network = self.networks.get(&request.provider.network)?;
        let request = request.into_adapter()?;
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
            });
            let operation = async {
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
                        },
                    )
                    .await
            };
            tokio::pin!(operation);
            let mut cleanup = Ok(());
            let result = loop {
                let deadline = *progress.borrow_and_update() + idle_timeout;
                let cause = tokio::select! {
                    biased;
                    result = &mut operation => break result,
                    _ = worker_cancel.cancelled() => ModelError::Cancelled,
                    _ = tokio::time::sleep_until(deadline), if watchdog => ModelError::TimedOut,
                    Ok(()) = progress.changed() => continue,
                };
                adapter_cancel.cancel();
                // Give the original adapter a bounded cleanup window. Expiry
                // reports unknown physical cleanup; its owner must keep its fence.
                match tokio::time::timeout(Duration::from_secs(6), &mut operation).await {
                    Err(_) => cleanup = Err(StreamCleanupError),
                    Ok(Err(error)) if error.cleanup_unconfirmed() => {
                        cleanup = Err(StreamCleanupError)
                    }
                    _ => {}
                }
                break Err(cause);
            };
            if let Err(error) = result {
                if error.cleanup_unconfirmed() {
                    cleanup = Err(StreamCleanupError);
                }
                let _ = failure_sender.send(Err(error)).await;
            }
            cleanup
        });
        Ok(ModelStream {
            receiver,
            cancellation,
            worker: Some(worker),
            cleanup: Ok(()),
            finished: false,
            pending_delta: None,
            ended: false,
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

#[cfg(test)]
mod stream_tests;

pub use adapters::wire::{
    EncodedWire, FrozenWire, SummaryWireBound, WireEncoding, WirePlan, WireSink, WireWrite,
};
