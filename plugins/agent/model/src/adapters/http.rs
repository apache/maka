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
    fn recovery_contract(
        &self,
        kind: &maka_agent_ports::model::ProviderKind,
        tools: &[Arc<maka_agent_facts::tools::ToolDefinition>],
    ) -> Option<maka_agent_ports::model::RecoveryContract> {
        use maka_agent_ports::model::ProviderKind;
        if tools.iter().any(|tool| tool.provider.is_some()) {
            return None;
        }
        let protocol = match kind {
            ProviderKind::OpenaiChatCompletions | ProviderKind::OpenaiCompatible { .. } => {
                "maka.adapter.chat-completions.local-functions"
            }
            ProviderKind::Anthropic => "maka.adapter.anthropic-messages.local-functions",
            _ => return None,
        };
        Some(maka_agent_ports::model::RecoveryContract {
            protocol: protocol.into(),
            version: 1,
        })
    }
    fn continuation_cursor(
        &self,
        contract: &maka_agent_ports::model::RecoveryContract,
        part: &maka_agent_facts::model::ModelPart,
    ) -> Option<serde_json::Value> {
        use maka_agent_facts::model::{ModelPart, TextKind};
        if contract.version != 1
            || !matches!(
                contract.protocol.as_str(),
                "maka.adapter.chat-completions.local-functions"
                    | "maka.adapter.anthropic-messages.local-functions"
            )
        {
            return None;
        }
        let options = match part {
            ModelPart::Text {
                text_kind,
                provider_options,
                ..
            } => {
                let options = provider_options
                    .as_deref()
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                if *text_kind == TextKind::Thinking
                    && contract.protocol == "maka.adapter.anthropic-messages.local-functions"
                    && !["signature", "redactedData"].iter().any(|key| {
                        options["anthropic"][key]
                            .as_str()
                            .is_some_and(|value| !value.is_empty())
                    })
                {
                    return None;
                }
                options
            }
            ModelPart::ToolCall { call } if !call.provider_executed => call
                .provider_options
                .clone()
                .unwrap_or(serde_json::Value::Null),
            ModelPart::Source { .. } => serde_json::Value::Null,
            _ => return None,
        };
        Some(serde_json::json!({"providerOptions": options}))
    }

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

#[derive(Clone)]
enum BodyEncoding {
    Chat(
        chat::request::PromptOptions,
        maka_agent_facts::language::Language,
    ),
    Anthropic(Arc<protocol_anthropic::prompt::streaming::Context>),
}
impl BodyEncoding {
    fn body(
        &self,
        fields: super::http_header::Header,
        prompt: crate::prompt::Prompt,
    ) -> Result<http::RequestBody, ModelError> {
        match self {
            Self::Chat(options, language) => {
                Ok(body::chat(fields, prompt, options.clone(), *language))
            }
            Self::Anthropic(metadata) => {
                let wire = prompt
                    .wire(crate::prompt::WireFormat::Anthropic)
                    .ok_or_else(|| {
                        ModelError::Adapter("reopened request lacks its Anthropic wire".into())
                    })?
                    .clone();
                anthropic::body(fields, wire, metadata.clone())
            }
        }
    }
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
    let request::Prepared {
        url,
        headers,
        body,
        mut decoder,
        compatible,
        mut anthropic_source,
        mut chat,
    } = prepared;
    let mut encoded_header = tokio::select! {
        biased;
        _ = context.cancellation.cancelled() => return Err(ModelError::Cancelled),
        header = super::http_header::Header::freeze(body) => header,
    };
    let mut events = events::Events::new();
    events.evidence.quota_scope = quota_scope;
    let mut retried = remembered;
    let encoding = if let Some((_, options, language)) = &chat {
        BodyEncoding::Chat(options.clone(), *language)
    } else {
        BodyEncoding::Anthropic(
            anthropic_source
                .as_ref()
                .expect("Anthropic encoding")
                .1
                .clone(),
        )
    };
    loop {
        let upload = if let Some(source) = &context.source {
            let (initial, cleanup) = if let Some((prompt, _, _)) = chat.take() {
                (
                    encoding.body(encoded_header.clone(), prompt)?,
                    source.cleanup.clone(),
                )
            } else if let Some((wire, metadata)) = anthropic_source.take() {
                (
                    anthropic::body(encoded_header.clone(), wire, metadata)?,
                    source.cleanup.clone(),
                )
            } else {
                let materialized = source.frozen.open(context.cancellation.clone()).await?;
                let body = encoding.body(encoded_header.clone(), materialized.prompt);
                match body {
                    Ok(body) => (body, materialized.cleanup),
                    Err(error) => {
                        materialized.cleanup.close().await.map_err(body_error)?;
                        return Err(error);
                    }
                }
            };
            let fields = encoded_header.clone();
            let frozen = source.frozen.clone();
            let encoding = encoding.clone();
            http::RequestBody::with_replay(initial.with_cleanup(cleanup), move |cancellation| {
                let fields = fields.clone();
                let frozen = frozen.clone();
                let encoding = encoding.clone();
                Box::pin(async move {
                    let materialized = frozen.open(cancellation).await.map_err(upload_error)?;
                    match encoding.body(fields, materialized.prompt) {
                        Ok(body) => Ok(body.with_cleanup(materialized.cleanup)),
                        Err(error) => {
                            materialized.cleanup.close().await?;
                            Err(upload_error(error))
                        }
                    }
                })
            })
        } else if let Some((prompt, options, language)) = &chat {
            let fields = encoded_header.clone();
            let prompt = prompt.clone();
            let options = options.clone();
            let language = *language;
            http::RequestBody::replayable(move || {
                body::chat(fields.clone(), prompt.clone(), options.clone(), language)
            })
        } else {
            let (wire, metadata) = anthropic_source.as_ref().expect("Anthropic encoding");
            let fields = encoded_header.clone();
            let wire = wire.clone();
            let metadata = metadata.clone();
            http::RequestBody::replayable(move || {
                anthropic::body(fields.clone(), wire.clone(), metadata.clone()).unwrap_or_else(
                    |error| {
                        http::RequestBody::stream(futures_util::stream::once(async move {
                            Err(upload_error(error))
                        }))
                    },
                )
            })
        };
        let response = dispatch(
            context,
            http::Request {
                method: maka_plugin_core::http::Method::Post,
                url: url.clone(),
                headers: headers.clone(),
                body: upload,
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
                    return Err(events
                        .evidence
                        .provider(error::http_body_error(status, error), retry_after));
                }
                Err(error) => return Err(error),
            };
            if compatible && !retried && status == 400 && encoded_header.has_stream_options() {
                let text = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
                if text.contains("stream_options") || text.contains("include_usage") {
                    {
                        let mut cache = shared.without_usage.lock().expect("usage cache");
                        if cache.len() >= 1024 {
                            cache.clear();
                        }
                        cache.insert(route.clone());
                    }
                    encoded_header = tokio::select! {
                        biased;
                        _ = context.cancellation.cancelled() => return Err(ModelError::Cancelled),
                        header = encoded_header.without_usage() => header,
                    };
                    retried = true;
                    body.0.close().await.map_err(body_error)?;
                    continue;
                }
            }
            return Err(events
                .evidence
                .provider(error::http_error(status, &bytes), retry_after));
        }
        // Request bytes have been dispatched. Retain only the decoder and
        // protocol metadata while receiving; output owns its actual queue budget.
        drop(encoded_header);
        drop(anthropic_source.take());
        drop(chat.take());
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
                        let mut decoded = decoder.push(bytes)?;
                        decoder.resolve(&mut decoded, &context.cancellation).await?;
                        emit(decoded, &mut events, context, &shared).await?;
                        if events.finished {
                            body.0.close().await.map_err(body_error)?;
                            return Ok(());
                        }
                    }
                }
                None => {
                    let mut decoded = decoder.finish()?;
                    decoder.resolve(&mut decoded, &context.cancellation).await?;
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
