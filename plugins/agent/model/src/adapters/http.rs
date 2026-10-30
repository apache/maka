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

use super::{anthropic, anthropic_documents, body, error, events, request};
#[cfg(test)]
mod upload_tests;
use crate::{ModelError, ProviderFailureReason};
use maka_agent_facts::model::budget;
use maka_agent_ports::model::{Context, Emission, Lifetime, ProviderAdapter, Request, Session};
use maka_capabilities::http;
use maka_provider_protocol::{
    anthropic as protocol_anthropic, chat_completions as chat, output::Event,
};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

// Backpressure for queued output, not a maximum response/event size. An atomic
// event larger than this window owns the entire window until consumed; ordinary
// deltas share it by bytes. Active streams retain no artificial admission lease.
const OUTPUT_WINDOW: u32 = 32 * 1024 * 1024;
const RESPONSE_LIMIT: usize = 8 * 1024 * 1024;
struct Shared {
    output: Arc<Semaphore>,
    without_usage: Mutex<HashSet<(u64, String)>>,
}
impl Default for Shared {
    fn default() -> Self {
        Self {
            output: Arc::new(Semaphore::new(OUTPUT_WINDOW as usize)),
            without_usage: Mutex::default(),
        }
    }
}
#[derive(Default)]
pub(super) struct HttpAdapter(Arc<Shared>);
impl ProviderAdapter for HttpAdapter {
    fn enforces_idle_timeout(&self) -> bool {
        true
    }
    fn open(
        &self,
        _: Lifetime,
        _: CancellationToken,
    ) -> futures_util::future::BoxFuture<'_, Result<Arc<dyn Session>, ModelError>> {
        let shared = self.0.clone();
        Box::pin(async move { Ok(Arc::new(HttpSession(shared)) as Arc<dyn Session>) })
    }
}
struct HttpSession(Arc<Shared>);
impl Session for HttpSession {
    fn stream(
        &self,
        request: Request,
        context: Context,
    ) -> futures_util::future::BoxFuture<'static, Result<(), ModelError>> {
        let shared = self.0.clone();
        Box::pin(async move { run(request, &context, shared).await })
    }
}
pub(super) enum Decoder {
    Anthropic {
        stream: Box<protocol_anthropic::stream::Stream>,
        documents: Option<anthropic_documents::Documents>,
    },
    Chat(Box<chat::Stream>),
}
impl Decoder {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<Event>, ModelError> {
        let mut next_id = || uuid::Uuid::new_v4().to_string();
        match self {
            Self::Anthropic { stream, .. } => {
                stream.push(bytes, &mut next_id, |_| {}).map_err(failure)
            }
            Self::Chat(stream) => {
                let mut events = stream.push(bytes, &mut next_id).map_err(failure)?;
                if stream.terminal() {
                    events.extend(stream.finish(&mut next_id).map_err(failure)?);
                }
                Ok(events)
            }
        }
    }
    async fn resolve(
        &self,
        events: &mut [Event],
        cancellation: &CancellationToken,
    ) -> Result<(), ModelError> {
        if let Self::Anthropic {
            documents: Some(documents),
            ..
        } = self
        {
            documents.resolve(events, cancellation).await?;
        }
        Ok(())
    }
    fn finish(&mut self) -> Result<Vec<Event>, ModelError> {
        match self {
            Self::Anthropic { stream, .. } => Ok(stream.finish()),
            Self::Chat(stream) => stream
                .finish(&mut || uuid::Uuid::new_v4().to_string())
                .map_err(failure),
        }
    }
}
pub(super) fn failure(error: maka_provider_protocol::Error) -> ModelError {
    ModelError::Adapter(error.to_string())
}

async fn run(request: Request, context: &Context, shared: Arc<Shared>) -> Result<(), ModelError> {
    let mut response_body = None;
    let result = run_inner(request, context, shared, &mut response_body).await;
    if let Some(body) = response_body {
        body.cancel();
        body.close().await.map_err(body_error)?;
    }
    result
}
async fn run_inner(
    request: Request,
    context: &Context,
    shared: Arc<Shared>,
    response_body: &mut Option<Arc<dyn http::Body>>,
) -> Result<(), ModelError> {
    let quota_scope = error::QuotaScope::endpoint(&request.provider.base_url);
    let mut prepared = tokio::select! {
        biased;
        _ = context.cancellation.cancelled() => return Err(ModelError::Cancelled),
        result = request::prepare(request) => result?,
    };
    let route = (context.transport.identity(), prepared.url.clone());
    let remembered = prepared.compatible
        && shared
            .without_usage
            .lock()
            .expect("usage cache")
            .contains(&route);
    if remembered {
        prepared
            .body
            .as_object_mut()
            .expect("request object")
            .remove("stream_options");
    }
    let mut events = events::Events::new(prepared.anthropic);
    events.evidence.quota_scope = quota_scope;
    let mut retried = remembered;
    loop {
        let response = dispatch(
            context,
            http::Request {
                method: http::Method::Post,
                url: prepared.url.clone(),
                headers: prepared.headers.clone(),
                body: if let Some((source, options, language)) = &prepared.chat {
                    let fields = prepared.body.clone();
                    let source = source.clone();
                    let options = options.clone();
                    let language = *language;
                    http::RequestBody::replayable(move || {
                        body::chat(fields.clone(), source.clone(), options.clone(), language)
                    })
                } else {
                    let (wire, context) = prepared
                        .anthropic_source
                        .as_ref()
                        .expect("Anthropic encoding");
                    let fields = prepared.body.clone();
                    let wire = wire.clone();
                    let context = context.clone();
                    http::RequestBody::replayable(move || {
                        anthropic::body(fields.clone(), wire.clone(), context.clone())
                            .unwrap_or_else(|error| {
                                http::RequestBody::stream(futures_util::stream::once(async move {
                                    Err(upload_error(error))
                                }))
                            })
                    })
                },
            },
        )
        .await
        .map_err(|error| events.evidence.transport(error))?;
        *response_body = Some(response.body.clone());
        let body = BodyGuard(response.body);
        context.events.progress();
        let status = response.head.status;
        let sse = header(&response.head, "content-type").is_some_and(|mime| {
            mime.split(';')
                .next()
                .is_some_and(|v| v.trim().eq_ignore_ascii_case("text/event-stream"))
        });
        let retry_after = super::retry::at(&response.head);
        events.evidence.retry_at_unix_ms = retry_after;
        if !(200..300).contains(&status) || !sse {
            let read = read_body(&body.0, &response.head, context).await;
            let bytes = match read {
                Ok(bytes) => bytes,
                Err(error)
                    if !(200..300).contains(&status)
                        && (matches!(error, ModelError::TimedOut)
                            || matches!(&error, ModelError::Provider(failure)
                                if failure.reason() == ProviderFailureReason::Network)) =>
                {
                    return Err(events.evidence.provider(
                        error::http_body_error(status, error),
                        prepared.anthropic,
                        retry_after,
                    ));
                }
                Err(error) => return Err(error),
            };
            if prepared.compatible
                && !retried
                && status == 400
                && prepared.body.get("stream_options").is_some()
            {
                let text = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
                if text.contains("stream_options") || text.contains("include_usage") {
                    {
                        let mut cache = shared.without_usage.lock().expect("usage cache");
                        if cache.len() >= 1024 {
                            cache.clear();
                        }
                        cache.insert(route.clone());
                    }
                    prepared
                        .body
                        .as_object_mut()
                        .expect("request object")
                        .remove("stream_options");
                    retried = true;
                    body.0.close().await.map_err(body_error)?;
                    continue;
                }
            }
            return Err(events.evidence.provider(
                error::http_error(status, &bytes),
                prepared.anthropic,
                retry_after,
            ));
        }
        // Request bytes have been dispatched. Retain only the decoder and
        // protocol metadata while receiving; output owns its actual queue budget.
        drop(prepared.body);
        drop(prepared.anthropic_source.take());
        drop(prepared.chat.take());
        loop {
            let chunk = tokio::time::timeout(context.idle_timeout, body.0.next())
                .await
                .map_err(|_| {
                    events.evidence.interrupted(
                        ProviderFailureReason::TimedOut,
                        ModelError::TimedOut.to_string(),
                    )
                })?
                .map_err(|error| match error {
                    http::Error::Denied => ModelError::Cancelled,
                    http::Error::CleanupUnconfirmed => ModelError::CleanupUnconfirmed,
                    http::Error::Failed(_) => events.evidence.interrupted(
                        ProviderFailureReason::Network,
                        "model HTTP transport interrupted",
                    ),
                    other => ModelError::Adapter(other.to_string()),
                })?;
            match chunk {
                Some(bytes) => {
                    context.events.progress();
                    // Bound the vector of decoded events even if an HTTP peer
                    // combines many records into one transport chunk.
                    for bytes in bytes.chunks(16 * 1024) {
                        let mut decoded = prepared.decoder.push(bytes)?;
                        prepared
                            .decoder
                            .resolve(&mut decoded, &context.cancellation)
                            .await?;
                        emit(decoded, &mut events, context, &shared).await?;
                        if events.finished {
                            body.0.close().await.map_err(body_error)?;
                            return Ok(());
                        }
                    }
                }
                None => {
                    let mut decoded = prepared.decoder.finish()?;
                    prepared
                        .decoder
                        .resolve(&mut decoded, &context.cancellation)
                        .await?;
                    emit(decoded, &mut events, context, &shared).await?;
                    return if events.finished {
                        Ok(())
                    } else {
                        Err(events.evidence.interrupted(
                            ProviderFailureReason::StreamTruncated,
                            "model stream ended without finish",
                        ))
                    };
                }
            }
        }
    }
}
pub(super) fn upload_error(error: ModelError) -> http::Error {
    match error {
        ModelError::CleanupUnconfirmed => http::Error::CleanupUnconfirmed,
        ModelError::Cancelled => http::Error::Denied,
        error => http::Error::Invalid(error.to_string()),
    }
}

fn body_error(error: http::Error) -> ModelError {
    match error {
        http::Error::CleanupUnconfirmed => ModelError::CleanupUnconfirmed,
        http::Error::Denied => ModelError::Cancelled,
        error => ModelError::Adapter(error.to_string()),
    }
}

fn observe_upload(
    input: http::RequestBody,
    activity: tokio::sync::watch::Sender<tokio::time::Instant>,
) -> http::RequestBody {
    input.inspect(move |chunk| {
        if chunk.as_ref().is_ok_and(|bytes| !bytes.is_empty()) {
            activity.send_replace(tokio::time::Instant::now());
        }
    })
}

async fn dispatch(
    context: &Context,
    mut request: http::Request,
) -> Result<http::Response, ModelError> {
    let (activity, mut progress) = tokio::sync::watch::channel(tokio::time::Instant::now());
    request.body = observe_upload(request.body, activity);
    let cancellation = context.cancellation.child_token();
    let pending = context.transport.request(request, cancellation.clone());
    tokio::pin!(pending);
    let cause = loop {
        let deadline = *progress.borrow_and_update() + context.idle_timeout;
        break tokio::select! {
            biased;
            result = &mut pending => return result,
            _ = context.cancellation.cancelled() => ModelError::Cancelled,
            Ok(()) = progress.changed() => continue,
            _ = tokio::time::sleep_until(deadline) => ModelError::TimedOut,
        };
    };
    cancellation.cancel();
    match pending.await {
        Ok(response) => {
            response.body.cancel();
            response.body.close().await.map_err(body_error)?;
        }
        Err(error) if error.cleanup_unconfirmed() => return Err(error),
        Err(_) => {}
    }
    Err(cause)
}

async fn emit(
    decoded: Vec<Event>,
    events: &mut events::Events,
    context: &Context,
    shared: &Shared,
) -> Result<(), ModelError> {
    for event in decoded {
        if let Some(event) = events.push(event)? {
            let size = budget::reservation(&event, OUTPUT_WINDOW)?;
            let reservation = tokio::select! {
                biased;
                _ = context.cancellation.cancelled() => return Err(ModelError::Cancelled),
                result = shared.output.clone().acquire_many_owned(size) => result.map_err(|_| ModelError::Cancelled)?,
            };
            tokio::select! {
                biased;
                _ = context.cancellation.cancelled() => return Err(ModelError::Cancelled),
                result = context.events.emit(Emission { event, reservation: Some(Arc::new(reservation)) }) => result?,
            }
        }
        if events.finished {
            break;
        }
    }
    Ok(())
}
struct BodyGuard(Arc<dyn http::Body>);
impl Drop for BodyGuard {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
fn header<'a>(head: &'a http::Head, name: &str) -> Option<&'a str> {
    head.headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .and_then(|(_, value)| std::str::from_utf8(value).ok())
}
async fn read_body(
    body: &Arc<dyn http::Body>,
    head: &http::Head,
    context: &Context,
) -> Result<Vec<u8>, ModelError> {
    let limit = || ModelError::Adapter("provider response body exceeds 8 MiB".into());
    if header(head, "content-length")
        .and_then(|n| n.parse::<usize>().ok())
        .is_some_and(|n| n > RESPONSE_LIMIT)
    {
        return Err(limit());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = tokio::time::timeout(context.idle_timeout, body.next())
        .await
        .map_err(|_| ModelError::TimedOut)?
        .map_err(|error| match error {
            http::Error::Denied => ModelError::Cancelled,
            http::Error::CleanupUnconfirmed => ModelError::CleanupUnconfirmed,
            http::Error::Failed(message) => ModelError::Provider(crate::ProviderFailure::new(
                ProviderFailureReason::Network,
                message,
                true,
                None,
            )),
            other => ModelError::Adapter(other.to_string()),
        })?
    {
        context.events.progress();
        if chunk.len() > RESPONSE_LIMIT - bytes.len() {
            return Err(limit());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
mod quota_scope_tests {
    use super::*;
    use futures_util::{StreamExt, future::BoxFuture};
    use maka_agent_ports::model::{Connect, Credentials, Events, Provider, Socket, Transport};
    use std::{
        sync::atomic::{AtomicBool, Ordering},
        time::Duration,
    };

    struct NoEvents;
    impl Events for NoEvents {
        fn emit(&self, _: Emission) -> BoxFuture<'_, Result<(), ModelError>> {
            Box::pin(async { panic!("a rejected request cannot emit model output") })
        }
    }

    #[derive(Clone, Default)]
    struct Rejection {
        read: Arc<AtomicBool>,
        closed: Arc<AtomicBool>,
    }
    impl http::Body for Rejection {
        fn next(&self) -> BoxFuture<'_, Result<Option<Vec<u8>>, http::Error>> {
            Box::pin(async move {
                Ok((!self.read.swap(true, Ordering::SeqCst)).then(|| {
                    br#"{"error":{"code":"1308","message":"original quota diagnostic"}}"#.to_vec()
                }))
            })
        }
        fn cancel(&self) {}
        fn close(&self) -> BoxFuture<'_, Result<(), http::Error>> {
            Box::pin(async move {
                self.closed.store(true, Ordering::SeqCst);
                Ok(())
            })
        }
    }
    impl Transport for Rejection {
        fn identity(&self) -> u64 {
            1
        }
        fn connect(&self, _: Connect) -> BoxFuture<'_, Result<Arc<dyn Socket>, ModelError>> {
            Box::pin(async { panic!("the HTTP quota boundary cannot open a WebSocket") })
        }
        fn request(
            &self,
            request: http::Request,
            _: CancellationToken,
        ) -> BoxFuture<'_, Result<http::Response, ModelError>> {
            Box::pin(async move {
                let mut upload = request.body.into_stream();
                while let Some(bytes) = upload.next().await {
                    bytes.unwrap();
                }
                Ok(http::Response {
                    head: http::Head {
                        status: 429,
                        url: request.url,
                        headers: vec![
                            ("content-type".into(), b"application/json".to_vec()),
                            ("retry-after".into(), b"18000".to_vec()),
                        ],
                    },
                    body: Arc::new(self.clone()),
                })
            })
        }
    }

    #[tokio::test(start_paused = true)]
    async fn http_dispatch_keeps_quota_scope_original_diagnostics_and_retry_deadline() {
        for (endpoint, reason) in [
            (
                "https://api.z.ai/api/coding/paas/v4",
                ProviderFailureReason::QuotaExhausted,
            ),
            (
                "https://foreign.invalid/v1",
                ProviderFailureReason::RateLimit,
            ),
        ] {
            let response = Rejection::default();
            let context = Context {
                transport: Arc::new(response.clone()),
                events: Arc::new(NoEvents),
                cancellation: CancellationToken::new(),
                idle_timeout: Duration::from_secs(10),
            };
            let before = crate::ProviderFailure::now_unix_ms();
            let start = tokio::time::Instant::now();
            let error = run(
                Request {
                    language: Default::default(),
                    provider: Provider {
                        kind: crate::ProviderKind::OpenaiCompatible {
                            name: "fixture".into(),
                        },
                        model: "quota-fixture".into(),
                        base_url: endpoint.into(),
                        auth: Credentials::ApiKey("fixture".into()),
                        headers: Default::default(),
                        body_overlay: None,
                    },
                    prompt: vec![crate::prompt::Message::user("hello")].into(),
                    tools: vec![],
                    provider_options: serde_json::Value::Null,
                    max_output_tokens: None,
                },
                &context,
                Arc::new(Shared::default()),
            )
            .await
            .unwrap_err();
            let after = crate::ProviderFailure::now_unix_ms();
            let ModelError::Provider(failure) = error else {
                panic!("typed quota evidence lost: {error}")
            };
            assert_eq!(failure.reason(), reason);
            assert_eq!(
                failure.retryable(),
                reason == ProviderFailureReason::RateLimit
            );
            assert!(failure.replay_safe());
            assert_eq!(failure.status(), Some(429));
            assert_eq!(failure.code(), Some("1308"));
            assert_eq!(failure.message(), "original quota diagnostic");
            assert!(
                (before + 18_000_000..=after + 18_000_000)
                    .contains(&failure.retry_at_unix_ms().unwrap())
            );
            assert_eq!(start.elapsed(), Duration::ZERO);
            assert!(response.closed.load(Ordering::SeqCst));
        }
    }
}
