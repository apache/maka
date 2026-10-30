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

//! Model protocol implementations captured by their execution owner.
use futures_util::future::BoxFuture;
pub use maka_agent_facts::model::ModelEvent;
pub use maka_agent_facts::model::error::ModelError as Error;
pub use maka_agent_facts::model::prompt::Message;
pub use maka_agent_facts::model::request::Credentials;
pub use maka_agent_facts::model::request::Provider;
pub use maka_agent_facts::model::request::ProviderKind;
pub use maka_agent_facts::model::request::Request;
pub use maka_agent_facts::model::retry_transport::RetryTransportPhase;
use maka_capabilities::http;
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

/// Scoped I/O is supplied after Host model admission. Implementations cannot
/// replace routing policy or reconstruct this capability from a Session ID.
pub trait Transport: Send + Sync {
    /// Process-local routing identity, excluding the serialized credential.
    /// A changed routing policy must invalidate cached connections.
    fn identity(&self) -> u64;
    /// Cancellation is acknowledged only after the upload source and its
    /// transport-retained bytes drain. Callers cancel this token and await the
    /// future; dropping a pending request cannot confirm resource settlement.
    fn request(
        &self,
        request: http::Request,
        cancellation: CancellationToken,
    ) -> BoxFuture<'_, Result<http::Response, Error>>;
    fn connect(&self, request: Connect) -> BoxFuture<'_, Result<Arc<dyn Socket>, Error>>;
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Connect {
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum Frame {
    Text(String),
    Binary(Vec<u8>),
}
/// One outstanding reader and writer. Cancelling a pending receive must not
/// consume the next frame; dropping the last handle closes the connection.
pub type TextStream = std::pin::Pin<
    Box<dyn futures_util::Stream<Item = Result<http::Bytes, Error>> + Send + 'static>,
>;

pub trait Socket: Send + Sync {
    fn send(&self, frame: Frame) -> BoxFuture<'_, Result<(), Error>>;
    /// One UTF-8 text message, produced under transport backpressure. Chunks
    /// may split UTF-8 code points. Dropping an active send retires the socket:
    /// a partial message must never be resumed or followed by another request.
    fn send_text(&self, chunks: TextStream) -> BoxFuture<'_, Result<(), Error>>;
    fn receive(&self) -> BoxFuture<'_, Result<Option<Frame>, Error>>;
    fn close(&self) -> BoxFuture<'_, Result<(), Error>>;
}
/// A model event and the in-flight bytes it owns. Consumers release the
/// reservation after journaling; retained response text has a separate lifetime.
#[derive(Debug)]
pub struct Emission {
    pub event: ModelEvent,
    pub reservation: Option<Arc<tokio::sync::OwnedSemaphorePermit>>,
}

impl From<ModelEvent> for Emission {
    fn from(event: ModelEvent) -> Self {
        Self {
            event,
            reservation: None,
        }
    }
}

pub trait Events: Send + Sync {
    /// Observed provider progress (including heartbeats and partial wire items)
    /// resets the idle deadline without inventing a canonical model event.
    fn progress(&self) {}
    /// Backpressure is observed before the next event is produced.
    fn emit(&self, event: Emission) -> BoxFuture<'_, Result<(), Error>>;
}
/// A fresh materialization of the already committed request input.
pub struct MaterializedPrompt {
    pub prompt: maka_agent_facts::model::prompt_source::Prompt,
    pub cleanup: Arc<dyn http::UploadCleanup>,
}

/// Rebuilds only frozen request bytes using the original scoped authority.
/// Implementations must not retain the preceding materialization.
pub trait FrozenPrompt: Send + Sync {
    fn open(
        &self,
        cancellation: CancellationToken,
    ) -> BoxFuture<'_, Result<MaterializedPrompt, Error>>;
}

#[derive(Clone)]
pub struct RequestSource {
    pub cleanup: Arc<dyn http::UploadCleanup>,
    pub frozen: Arc<dyn FrozenPrompt>,
}

#[derive(Clone)]
pub struct Context {
    pub transport: Arc<dyn Transport>,
    pub events: Arc<dyn Events>,
    pub cancellation: CancellationToken,
    pub idle_timeout: Duration,
    pub source: Option<RequestSource>,
}
/// Disposable per-conversation optimization state, never a history authority.
pub trait Session: Send + Sync {
    fn stream(&self, request: Request, context: Context) -> BoxFuture<'static, Result<(), Error>>;
    /// Observe semantic transport consumption, including automatic fallback.
    fn retry_transport_phase(&self) -> RetryTransportPhase {
        RetryTransportPhase::Primary
    }
    /// Restore a fresh session before streaming; unsupported fallback fails closed.
    fn restore_retry_transport_phase(&self, phase: RetryTransportPhase) -> Result<(), Error> {
        match phase {
            RetryTransportPhase::Primary => Ok(()),
            RetryTransportPhase::Fallback => Err(Error::Adapter(
                "model session does not support restoring fallback transport".into(),
            )),
        }
    }
    /// Select an unused fallback after the caller exhausts replay-safe retries
    /// and drains the failed stream. Returns true only when transport changes;
    /// this never sends a request or authorizes replay itself.
    fn try_switch_fallback_transport(&self) -> bool {
        false
    }
    fn needs_confirmation(&self) -> bool {
        false
    }
    /// Check committed history projected by Host after local tool settlement.
    /// This is not a plugin claim or permission to change canonical history.
    fn confirm<'a>(
        &'a self,
        _prompt: &'a maka_agent_facts::model::prompt_source::Prompt,
        _settled_tool_call_ids: &'a [&'a str],
        _response_id: Option<&'a str>,
    ) -> BoxFuture<'a, bool> {
        Box::pin(async { false })
    }
}
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Lifetime {
    Request,
    Conversation,
}
pub trait ProviderAdapter: Send + Sync {
    /// Complete stream items have provider-confirmed boundaries, rather than
    /// being synthesized by an SDK when an incomplete stream is closed.
    fn supports_item_acceptance(&self) -> bool {
        false
    }

    /// Owns idle deadlines for external I/O and returns protocol-aware failures.
    /// Local event backpressure is not provider silence. Other adapters retain
    /// the executor watchdog; cancellation and cleanup always remain bounded.
    fn enforces_idle_timeout(&self) -> bool {
        false
    }

    fn open(
        &self,
        lifetime: Lifetime,
        cancellation: CancellationToken,
    ) -> BoxFuture<'_, Result<Arc<dyn Session>, Error>>;
}
/// One immutable protocol binding, retained through retries and stream cleanup.
#[derive(Clone)]
pub struct Binding(Arc<BoundAdapter>);
struct BoundAdapter {
    provider: Arc<dyn ProviderAdapter>,
    source: maka_agent_facts::composition::SourceRevision,
}
impl Binding {
    pub fn new(
        provider: Arc<dyn ProviderAdapter>,
        source: maka_agent_facts::composition::SourceRevision,
    ) -> Self {
        Self(Arc::new(BoundAdapter { provider, source }))
    }
    pub fn supports_item_acceptance(&self) -> bool {
        self.0.provider.supports_item_acceptance()
    }
    pub fn enforces_idle_timeout(&self) -> bool {
        self.0.provider.enforces_idle_timeout()
    }
    pub async fn open(
        &self,
        lifetime: Lifetime,
        cancellation: CancellationToken,
    ) -> Result<Arc<dyn Session>, Error> {
        self.0.provider.open(lifetime, cancellation).await
    }
    pub fn same_registration(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
    pub fn source(&self) -> &maka_agent_facts::composition::SourceRevision {
        &self.0.source
    }
}
