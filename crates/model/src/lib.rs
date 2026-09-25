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

mod delta;
mod events;
pub use maka_runtime::model::error::{ModelError, ProviderFailure, ProviderFailureReason};
pub use maka_runtime::model::prompt;
pub use maka_runtime::model::request::ProviderKind;
pub mod adapters;
mod conversation;
mod network;
pub mod reasoning;
mod sdk;
mod step;
pub use conversation::Conversation;
pub use maka_runtime::{model::ModelEvent, tools::ToolDefinition};
pub use step::StepBuilder;

use maka_js_runtime::trusted::TrustedRuntime;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::sync::{Semaphore, mpsc};
use tokio_util::sync::CancellationToken;

mod auth;
pub use auth::{AuthResolver, ProviderAuth};
use maka_runtime::model::budget;

/// Trusted configuration, never exposed to a Code Mode isolate or event log.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter: Option<String>,
    #[serde(skip)]
    pub capabilities: maka_runtime::configuration::ModelCapabilities,
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
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequest {
    pub provider: ProviderConfig,
    pub prompt: Vec<prompt::Message>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolDefinition>,
    pub provider_options: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
}

impl ProviderConfig {
    pub fn adapter_name(&self) -> &str {
        self.adapter
            .as_deref()
            .unwrap_or_else(|| adapters::name(&self.kind))
    }
    pub fn tool_context(&self) -> maka_runtime::tools::ModelToolContext {
        use maka_runtime::tools::ProviderToolProtocol;
        maka_runtime::tools::ModelToolContext {
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
    fn into_adapter(self) -> Result<maka_runtime::model::request::Request, ModelError> {
        use maka_runtime::model::request::{Credentials, Provider, Request};
        let auth = match self.provider.auth {
            ProviderAuth::ApiKey(key) => Credentials::ApiKey(key),
            ProviderAuth::RequestHeaders(headers) => Credentials::RequestHeaders(headers),
            ProviderAuth::Bound { .. } => {
                return Err(ModelError::Adapter("unresolved model credentials".into()));
            }
        };
        Ok(Request {
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
    receiver: mpsc::Receiver<Result<ModelEvent, ModelError>>,
    cancellation: CancellationToken,
    worker: Option<tokio::task::JoinHandle<()>>,
    finished: bool,
    pending_delta: Option<delta::PendingDelta>,
    ended: bool,
}

impl ModelStream {
    pub async fn next(&mut self) -> Option<Result<ModelEvent, ModelError>> {
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
                        if result.is_err() {
                            self.ended = true;
                            return Some(Err(ModelError::Adapter("model adapter worker failed".into())));
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
                    self.finished = matches!(value, ModelEvent::Finished { .. });
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
                Ok(Some(ModelEvent::PartDelta {
                    id,
                    text,
                    provider_options,
                })) if text.len() > 8 * 1024 => {
                    self.pending_delta = Some(delta::PendingDelta::new(id, text, provider_options));
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

    pub async fn cancel_and_wait(mut self) {
        self.cancellation.cancel();
        self.receiver.close();
        if let Some(worker) = self.worker.take() {
            let _ = worker.await;
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
    permits: Arc<Semaphore>,
    idle_timeout: Duration,
    catalog: maka_plugins::contributions::Catalog,
    _standalone: Option<Arc<maka_plugins::fiber::Fiber>>,
    networks: Arc<network::Pool>,
}

/// One opportunistically reserved slot, tied to the executor that owns it.
/// A stream retains the slot until its worker drains; repairs reuse it afterward.
pub struct ModelReservation {
    executor: ModelExecutor,
    permit: Arc<tokio::sync::OwnedSemaphorePermit>,
}

impl ModelReservation {
    pub async fn stream_with_adapter(
        &mut self,
        request: ModelRequest,
        cancellation: CancellationToken,
        binding: maka_plugins::model::Binding,
    ) -> Result<ModelStream, ModelError> {
        if Arc::strong_count(&self.permit) != 1 {
            return Err(ModelError::Adapter(
                "reserved model stream has not drained".into(),
            ));
        }
        self.executor
            .stream_reserved(
                request,
                cancellation,
                None,
                binding,
                Some(self.permit.clone()),
            )
            .await
    }
}

impl ModelExecutor {
    /// Acquire atomically without queuing ahead of foreground work. Retaining
    /// one of two available slots leaves room for a foreground request.
    pub fn try_reserve_background(&self) -> Option<ModelReservation> {
        let mut permits = self.permits.clone().try_acquire_many_owned(2).ok()?;
        drop(permits.split(1)?);
        Some(ModelReservation {
            executor: self.clone(),
            permit: Arc::new(permits),
        })
    }
    /// Providers and adapters share Host proxy routing and connection pools.
    pub fn transport(
        &self,
        policy: &maka_network::Policy,
    ) -> Result<Arc<dyn maka_plugins::model::Transport>, ModelError> {
        self.networks.get(policy)
    }

    pub fn new(concurrency: usize, idle_timeout: Duration) -> Result<Self, ModelError> {
        Self::with_runtime(TrustedRuntime::default(), concurrency, idle_timeout)
    }

    pub fn with_runtime(
        runtime: TrustedRuntime,
        concurrency: usize,
        idle_timeout: Duration,
    ) -> Result<Self, ModelError> {
        if concurrency == 0 || idle_timeout.is_zero() {
            return Err(ModelError::Adapter("invalid model execution limits".into()));
        }
        let (catalog, owner) = adapters::standalone(runtime)?;
        Ok(Self {
            permits: Arc::new(Semaphore::new(concurrency)),
            idle_timeout,
            catalog,
            _standalone: Some(owner),
            networks: Arc::default(),
        })
    }

    /// Use the embedding Host's ordinary plugin catalog. No builtin fallback.
    pub fn with_catalog(mut self, catalog: maka_plugins::contributions::Catalog) -> Self {
        self.catalog = catalog;
        self._standalone = None;
        self
    }

    pub fn binding(
        &self,
        provider: &ProviderConfig,
    ) -> Result<maka_plugins::model::Binding, ModelError> {
        self.binding_in_scope(provider, &maka_plugins::composition::Scope::Profile)
    }

    pub fn binding_in_scope(
        &self,
        provider: &ProviderConfig,
        scope: &maka_plugins::composition::Scope,
    ) -> Result<maka_plugins::model::Binding, ModelError> {
        adapters::resolve(&self.catalog.capture(scope), provider.adapter_name())
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
        binding: maka_plugins::model::Binding,
    ) -> Result<ModelStream, ModelError> {
        self.stream_reserved(request, cancellation, conversation, binding, None)
            .await
    }

    async fn stream_reserved(
        &self,
        mut request: ModelRequest,
        cancellation: CancellationToken,
        conversation: Option<Conversation>,
        binding: maka_plugins::model::Binding,
        reservation: Option<Arc<tokio::sync::OwnedSemaphorePermit>>,
    ) -> Result<ModelStream, ModelError> {
        for tool in &request.tools {
            if let Some(provider) = &tool.provider {
                provider
                    .validate()
                    .map_err(|error| ModelError::Adapter(error.into()))?;
                let protocol = request.provider.tool_context().provider_tools;
                let compatible = match protocol {
                    Some(maka_runtime::tools::ProviderToolProtocol::OpenaiResponses) => {
                        provider.id.starts_with("openai.")
                    }
                    Some(maka_runtime::tools::ProviderToolProtocol::AnthropicMessages) => {
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
        // This request crosses JSON.parse into the SDK. Root pins impose their
        // own narrower policy; the generic boundary must not round JS numbers.
        if request
            .max_output_tokens
            .is_some_and(|value| value == 0 || value > 9_007_199_254_740_991)
        {
            return Err(ModelError::Adapter(
                "maxOutputTokens must be a positive JavaScript safe integer".into(),
            ));
        }
        request.prompt = reasoning::project(request.prompt, &request.provider.kind);
        let cancellation = cancellation.child_token();
        let permit = if let Some(permit) = reservation {
            permit
        } else {
            Arc::new(tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(ModelError::Cancelled),
                permit = self.permits.clone().acquire_owned() =>
                    permit.map_err(|error| ModelError::Adapter(error.to_string()))?,
            })
        };
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(ModelError::Cancelled),
            result = auth::resolve(&mut request.provider.auth) => result?,
        }
        let (sender, receiver) = mpsc::channel(4);
        let worker_cancel = cancellation.clone();
        let idle_timeout = self.idle_timeout;
        let lease = binding.admit()?;
        let network = self.networks.get(&request.provider.network)?;
        let request = request.into_adapter()?;
        budget::bytes(&request, 32 * 1024 * 1024)?;
        let worker = tokio::spawn(async move {
            let _permit = permit;
            let failure_sender = sender.clone();
            let _lease = lease;
            let adapter_cancel = worker_cancel.child_token();
            let _settlement = adapter_cancel.clone().drop_guard();
            let (activity, mut progress) = tokio::sync::watch::channel(tokio::time::Instant::now());
            let events: Arc<dyn maka_plugins::model::Events> = Arc::new(ChannelEvents {
                sender,
                activity,
                total: std::sync::atomic::AtomicU32::new(0),
            });
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
                                maka_plugins::model::Lifetime::Request,
                                adapter_cancel.clone(),
                            )
                            .await?
                    }
                };
                session
                    .stream(
                        request,
                        maka_plugins::model::Context {
                            events,
                            cancellation: adapter_cancel.clone(),
                            idle_timeout,
                            transport: network,
                        },
                    )
                    .await
            };
            tokio::pin!(operation);
            let result = loop {
                let deadline = *progress.borrow_and_update() + idle_timeout;
                let cause = tokio::select! {
                    biased;
                    result = &mut operation => break result,
                    _ = worker_cancel.cancelled() => ModelError::Cancelled,
                    _ = tokio::time::sleep_until(deadline) => ModelError::TimedOut,
                    Ok(()) = progress.changed() => continue,
                };
                adapter_cancel.cancel();
                // JS callbacks are signalled and given their bounded cleanup
                // window. A stuck native adapter cannot hold Host admission forever.
                let _ = tokio::time::timeout(Duration::from_secs(6), &mut operation).await;
                break Err(cause);
            };
            if let Err(error) = result {
                let _ = failure_sender.send(Err(error)).await;
            }
        });
        Ok(ModelStream {
            receiver,
            cancellation,
            worker: Some(worker),
            finished: false,
            pending_delta: None,
            ended: false,
        })
    }
}

struct ChannelEvents {
    total: std::sync::atomic::AtomicU32,
    sender: mpsc::Sender<Result<ModelEvent, ModelError>>,
    activity: tokio::sync::watch::Sender<tokio::time::Instant>,
}
impl maka_plugins::model::Events for ChannelEvents {
    fn progress(&self) {
        self.activity.send_replace(tokio::time::Instant::now());
    }
    fn emit(
        &self,
        event: ModelEvent,
    ) -> futures_util::future::BoxFuture<'_, Result<(), ModelError>> {
        Box::pin(async move {
            let bytes = budget::bytes(&event, 8 * 1024 * 1024)?;
            self.total
                .fetch_update(
                    std::sync::atomic::Ordering::Relaxed,
                    std::sync::atomic::Ordering::Relaxed,
                    |total| {
                        total
                            .checked_add(bytes)
                            .filter(|total| *total <= 64 * 1024 * 1024)
                    },
                )
                .map_err(|_| ModelError::Adapter("model output exceeds 64 MiB".into()))?;
            self.progress();
            self.sender
                .send(Ok(event))
                .await
                .map_err(|_| ModelError::Cancelled)
        })
    }
}
