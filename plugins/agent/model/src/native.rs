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

//! Native provider sessions own wire state and use only Host-scoped transport.
mod anthropic_body;
mod anthropic_documents;
mod body;
mod chat_completions;
mod error;
mod events;
mod media;
mod prompt;
mod request;
#[cfg(test)]
mod upload_tests;
pub(crate) mod wire;
use crate::{ModelError, ProviderFailureReason};
use maka_agent_facts::model::budget;
use maka_agent_ports::model::{Context, Emission, Lifetime, ProviderAdapter, Request, Session};
use maka_capabilities::http;
use maka_provider_protocol::{anthropic, chat_completions as chat, output::Event};
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
pub(super) struct Adapter(Arc<Shared>);
impl ProviderAdapter for Adapter {
    fn enforces_idle_timeout(&self) -> bool {
        true
    }
    fn open(
        &self,
        _: Lifetime,
        _: CancellationToken,
    ) -> futures_util::future::BoxFuture<'_, Result<Arc<dyn Session>, ModelError>> {
        let shared = self.0.clone();
        Box::pin(async move { Ok(Arc::new(Native(shared)) as Arc<dyn Session>) })
    }
}
struct Native(Arc<Shared>);
impl Session for Native {
    fn stream(
        &self,
        request: Request,
        context: Context,
    ) -> futures_util::future::BoxFuture<'static, Result<(), ModelError>> {
        let shared = self.0.clone();
        Box::pin(async move { run(request, &context, shared).await })
    }
}
enum Decoder {
    Anthropic {
        stream: Box<anthropic::stream::Stream>,
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
fn failure(error: maka_provider_protocol::Error) -> ModelError {
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
                        anthropic_body::body(fields.clone(), wire.clone(), context.clone())
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
        if !(200..300).contains(&status) || !sse {
            let retry_after = retry_after(&response.head);
            let read = read_body(&body.0, &response.head, context).await;
            let bytes = match read {
                Ok(bytes) => bytes,
                Err(ModelError::Provider(failure))
                    if failure.reason() == ProviderFailureReason::Network
                        && !(200..300).contains(&status) =>
                {
                    return Err(events.evidence.provider(
                        error::http_error(status, &[]),
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
                .map_err(|_| ModelError::TimedOut)?
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
fn upload_error(error: ModelError) -> http::Error {
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
            http::Error::Failed(_) => ModelError::Provider(crate::ProviderFailure::new(
                ProviderFailureReason::Network,
                "error body interrupted",
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
fn retry_after(head: &http::Head) -> Option<u64> {
    let delay = if let Some(ms) = header(head, "retry-after-ms") {
        ms.parse::<f64>().ok()?
    } else {
        let seconds = header(head, "retry-after")?;
        if let Ok(seconds) = seconds.parse::<f64>() {
            seconds * 1000.0
        } else {
            let date = jiff::fmt::rfc2822::parse(seconds).ok()?;
            let now = jiff::Timestamp::now().as_millisecond();
            (date.timestamp().as_millisecond() - now) as f64
        }
    };
    (delay.is_finite() && delay > 0.0 && delay <= 2_147_483_647.0).then_some(delay.ceil() as u64)
}
