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

//! Responses dispatch. Protocol code never enters the model V8 isolate.
use super::super::error::QuotaScope;
use super::{
    decode::Decoder,
    transport::{Exchange, ResponsesLane, Shared},
};
use maka_agent_facts::model::error::ModelError;
use maka_agent_facts::model::error::ProviderFailure;
use maka_agent_facts::model::error::ProviderFailureReason;
use maka_agent_ports::model::Context;
use maka_agent_ports::model::Credentials as ProviderAuth;
use maka_agent_ports::model::Events;
use maka_agent_ports::model::ProviderKind;
use maka_agent_ports::model::Request as ModelRequest;
use maka_capabilities::http;
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

pub async fn stream(
    mut request: ModelRequest,
    context: Context,
    lane: Option<super::Lane>,
    transport: Arc<Shared>,
) -> Result<(), ModelError> {
    let skip = if let Some(lane) = &lane {
        tokio::select! {
            biased;
            _ = context.cancellation.cancelled() => return Err(ModelError::Cancelled),
            skip = lane.prepare(&mut request) => skip,
        }
    } else {
        0
    };
    let lane = lane.map(|lane| lane.transport);
    run(request, skip, context, lane, transport).await
}
fn interruption(
    decoder: &Decoder,
    reason: ProviderFailureReason,
    message: impl Into<String>,
) -> ModelError {
    ModelError::Provider(
        ProviderFailure::new(reason, message, decoder.replay_safe, None)
            .with_retained_output(decoder.retained_output_safe()),
    )
}
async fn wait<T>(
    duration: Duration,
    decoder: &Decoder,
    cancellation: &CancellationToken,
    future: impl Future<Output = T>,
) -> Result<T, ModelError> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(ModelError::Cancelled),
        result = tokio::time::timeout(duration, future) => result.map_err(|_| interruption(
            decoder, ProviderFailureReason::TimedOut, ModelError::TimedOut.to_string(),
        )),
    }
}

/// Cancellation and idle timeout signal the upload, then await its physical
/// source settlement. Dropping request() here could orphan a retained chunk.
async fn request_http(
    network: &dyn maka_agent_ports::model::Transport,
    input: http::Request,
    cancellation: &CancellationToken,
    duration: Duration,
    decoder: &Decoder,
) -> Result<http::Response, ModelError> {
    let upload_cancel = cancellation.child_token();
    let operation = network.request(input, upload_cancel.clone());
    tokio::pin!(operation);
    let timeout = tokio::select! {
        biased;
        _ = cancellation.cancelled() => false,
        result = &mut operation => return result,
        _ = tokio::time::sleep(duration) => true,
    };
    upload_cancel.cancel();
    match operation.await {
        Ok(response) => {
            response.body.cancel();
            response.body.close().await.map_err(|error| match error {
                http::Error::CleanupUnconfirmed => ModelError::CleanupUnconfirmed,
                other => ModelError::Adapter(other.to_string()),
            })?;
        }
        Err(ModelError::Cancelled) => {}
        Err(error) => return Err(error),
    }
    if timeout {
        Err(interruption(
            decoder,
            ProviderFailureReason::TimedOut,
            ModelError::TimedOut.to_string(),
        ))
    } else {
        Err(ModelError::Cancelled)
    }
}
async fn emit(
    decoder: &mut Decoder,
    value: Value,
    quota_scope: QuotaScope,
    sender: &Arc<dyn Events>,
    cancellation: &CancellationToken,
) -> Result<(), ModelError> {
    for event in decoder
        .push(value)
        .map_err(|error| failure(error, quota_scope))?
    {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(ModelError::Cancelled),
            result = sender.emit(event.into()) => result?,
        }
    }
    Ok(())
}
async fn run(
    request: ModelRequest,
    skip: usize,
    context: Context,
    lane: Option<ResponsesLane>,
    transport: Arc<Shared>,
) -> Result<(), ModelError> {
    let Context {
        events: sender,
        cancellation,
        idle_timeout,
        transport: network,
    } = context;
    let quota_scope = QuotaScope::endpoint(&request.provider.base_url);
    let plaintext = match request.provider.kind {
        ProviderKind::OpenResponses(p) => Some(p),
        _ => None,
    };
    let mut body = super::body::RequestBody::new(&request, plaintext, skip)
        .map_err(|error| failure(error, quota_scope))?;
    let mut url = reqwest::Url::parse(&request.provider.base_url)
        .map_err(|_| ModelError::Adapter("invalid Responses endpoint".into()))?;
    url.set_path(&format!("{}/responses", url.path().trim_end_matches('/')));
    let headers = headers(&request)?;
    let mut decoder = Decoder::new(plaintext, &request.tools);
    let lane = lane.filter(|_| {
        request.provider.headers.is_empty()
            && request
                .provider
                .body_overlay
                .as_ref()
                .is_none_or(|value| value.is_empty())
    });
    drop(request);
    if let Some(lane) = lane {
        let exchange = Exchange::new(lane, cancellation.clone(), network.clone(), transport);
        match wait(
            idle_timeout,
            &decoder,
            &cancellation,
            exchange.start(url.to_string(), headers.clone(), body),
        )
        .await?
        .map_err(|error| match error {
            super::Error::Interrupted(message) => {
                interruption(&decoder, ProviderFailureReason::Network, message)
            }
            error => failure(error, quota_scope),
        })? {
            Some(full) => body = full,
            None => {
                while let Some(frame) = wait(idle_timeout, &decoder, &cancellation, exchange.next())
                    .await?
                    .map_err(|error| match error {
                        super::Error::Interrupted(message) => {
                            interruption(&decoder, ProviderFailureReason::StreamTruncated, message)
                        }
                        error => failure(error, quota_scope),
                    })?
                {
                    sender.progress();
                    let value = serde_json::from_str(&frame).map_err(|_| {
                        ModelError::Adapter("invalid Responses WebSocket JSON".into())
                    })?;
                    emit(&mut decoder, value, quota_scope, &sender, &cancellation).await?;
                }
                return decoder.end().map_err(|error| failure(error, quota_scope));
            }
        }
    }
    let response = request_http(
        network.as_ref(),
        http::Request {
            method: http::Method::Post,
            url: url.to_string(),
            headers: headers.into_iter().collect(),
            body: body.http(),
        },
        &cancellation,
        idle_timeout,
        &decoder,
    )
    .await?;
    let retry_at = super::super::retry::at(&response.head);
    let result = read_response(
        &response,
        &mut decoder,
        &sender,
        idle_timeout,
        &cancellation,
        retry_at,
        quota_scope,
    )
    .await
    .map_err(|error| match error {
        ModelError::Provider(failure) => ModelError::Provider(failure.with_retry_at(retry_at)),
        error => error,
    });
    // A provider may finish before it consumes the complete upload. All exits,
    // including terminal SSE, rejection, timeout and cancellation, settle the
    // response's upload lease before this adapter returns.
    response.body.close().await.map_err(|error| match error {
        http::Error::CleanupUnconfirmed => ModelError::CleanupUnconfirmed,
        other => ModelError::Adapter(other.to_string()),
    })?;
    result
}
async fn read_response(
    response: &http::Response,
    decoder: &mut Decoder,
    sender: &Arc<dyn Events>,
    idle_timeout: Duration,
    cancellation: &CancellationToken,
    retry_at: Option<u64>,
    quota_scope: QuotaScope,
) -> Result<(), ModelError> {
    let content_type = header(&response.head, "content-type");
    // Some Responses endpoints omit Content-Type even for a valid event
    // stream. The decoder still validates its frames and terminal outcome.
    let event_stream = content_type.is_none_or(|value| {
        value
            .split(';')
            .next()
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("text/event-stream"))
    });
    if !(200..300).contains(&response.head.status) || !event_stream {
        let status = response.head.status;
        let body_failure = |message: String| {
            super::super::error::Evidence {
                quota_scope,
                ..Default::default()
            }
            .provider(
                super::super::error::http_body_error(status, message),
                false,
                retry_at,
            )
        };
        let mut bytes = Vec::new();
        while let Some(chunk) = wait(idle_timeout, decoder, cancellation, response.body.next())
            .await
            .map_err(|error| {
                if matches!(error, ModelError::Cancelled) {
                    error
                } else {
                    body_failure(error.to_string())
                }
            })?
            .map_err(|error| match error {
                http::Error::Denied => ModelError::Cancelled,
                http::Error::CleanupUnconfirmed => ModelError::CleanupUnconfirmed,
                http::Error::Failed(message) => body_failure(
                    ProviderFailure::new(ProviderFailureReason::Network, message, false, None)
                        .to_string(),
                ),
                error => body_failure(error.to_string()),
            })?
        {
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if (200..300).contains(&status) {
            if value.get("error").is_some_and(|error| {
                error.is_object()
                    && ["code", "type", "message"].iter().any(|key| {
                        error.get(key).is_some_and(|value| {
                            value.is_number()
                                || value.as_str().is_some_and(|value| !value.is_empty())
                        })
                    })
            }) {
                return Err(super::super::error::Evidence {
                    quota_scope,
                    ..Default::default()
                }
                .provider(
                    super::super::error::http_error(status, &bytes),
                    false,
                    retry_at,
                ));
            }
            let message = value["error"]["message"]
                .as_str()
                .or_else(|| value["detail"].as_str())
                .unwrap_or("request rejected");
            let content_type = content_type.unwrap_or("missing Content-Type");
            return Err(ModelError::Adapter(format!(
                "Responses HTTP {status} returned {content_type}, expected text/event-stream: {message}"
            )));
        }
        return Err(super::super::error::Evidence {
            quota_scope,
            ..Default::default()
        }
        .provider(
            super::super::error::http_error(status, &bytes),
            false,
            retry_at,
        ));
    }
    let mut sse = maka_provider_protocol::responses::sse::Sse::default();
    let mut received_event = false;
    let missing_events = || {
        ModelError::Adapter(format!(
            "Responses HTTP {} had missing Content-Type and no SSE events",
            response.head.status
        ))
    };
    while let Some(chunk) = wait(idle_timeout, decoder, cancellation, response.body.next())
        .await
        .map_err(|error| {
            if matches!(error, ModelError::Cancelled) {
                error
            } else if content_type.is_none() && !received_event {
                missing_events()
            } else {
                error
            }
        })?
        .map_err(|error| match error {
            http::Error::Failed(_) if content_type.is_none() && !received_event => missing_events(),
            http::Error::Failed(_) => interruption(
                decoder,
                ProviderFailureReason::Network,
                "Responses stream read failed",
            ),
            http::Error::Denied => ModelError::Cancelled,
            http::Error::CleanupUnconfirmed => ModelError::CleanupUnconfirmed,
            other => ModelError::Adapter(other.to_string()),
        })?
    {
        for byte in chunk {
            if let Some(value) = sse
                .push(byte)
                .map_err(|error| failure(error.into(), quota_scope))?
            {
                received_event = true;
                emit(decoder, value, quota_scope, sender, cancellation).await?;
                if decoder.finished() {
                    return Ok(());
                }
            }
        }
    }
    if content_type.is_none() && !received_event {
        // An untyped JSON/HTML response is not evidence of a retryable stream
        // interruption, whether it ends, stalls, or disconnects.
        return Err(missing_events());
    }
    decoder.end().map_err(|error| failure(error, quota_scope))
}

fn headers(request: &ModelRequest) -> Result<BTreeMap<String, String>, ModelError> {
    let mut headers = BTreeMap::from([
        ("content-type".into(), "application/json".into()),
        ("accept".into(), "text/event-stream".into()),
    ]);
    match &request.provider.auth {
        ProviderAuth::ApiKey(token) => {
            headers.insert("authorization".into(), format!("Bearer {token}"));
        }
        ProviderAuth::RequestHeaders(prepared) => {
            for (name, value) in prepared {
                let name = name.to_ascii_lowercase();
                if headers.get(&name).is_some_and(|existing| existing != value) {
                    return Err(ModelError::Adapter(format!(
                        "Authentication header conflicts with protocol header: {name}"
                    )));
                }
                headers.insert(name, value.clone());
            }
        }
    }
    for (key, value) in &request.provider.headers {
        let key = key.to_ascii_lowercase();
        if headers.get(&key).is_some_and(|existing| existing != value) {
            return Err(ModelError::Adapter(format!(
                "Custom request header conflicts with a generated header: {key}"
            )));
        }
        headers.insert(key, value.clone());
    }
    Ok(headers)
}
fn failure(error: super::Error, quota_scope: QuotaScope) -> ModelError {
    use super::Error;
    match error {
        Error::CleanupUnconfirmed => ModelError::CleanupUnconfirmed,
        Error::Truncated {
            replay_safe,
            retained_output_safe,
        } => ModelError::Provider(
            ProviderFailure::new(
                ProviderFailureReason::StreamTruncated,
                "model stream ended without finish",
                replay_safe,
                None,
            )
            .with_retained_output(retained_output_safe),
        ),
        Error::Provider {
            error,
            observed_output,
            replay_safe,
            retained_output_safe,
        } => {
            let evidence = super::super::error::Evidence {
                quota_scope,
                observed: observed_output,
                unsafe_replay: !replay_safe,
                ..Default::default()
            };
            match evidence.provider(*error, false, None) {
                ModelError::Provider(failure) => {
                    ModelError::Provider(failure.with_retained_output(retained_output_safe))
                }
                error => error,
            }
        }
        error => ModelError::Adapter(error.to_string()),
    }
}

fn header<'a>(head: &'a http::Head, name: &str) -> Option<&'a str> {
    head.headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .and_then(|(_, value)| std::str::from_utf8(value).ok())
}

#[cfg(test)]
mod upload_settlement_tests {
    use super::*;
    use futures_util::future::BoxFuture;
    use maka_agent_ports::model::{Connect, Socket, Transport};
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::Notify;

    #[derive(Default)]
    struct Draining {
        entered: Notify,
        cancelled: Notify,
        release: Notify,
        settled: AtomicBool,
        unknown: bool,
    }
    impl Transport for Draining {
        fn identity(&self) -> u64 {
            0
        }
        fn request(
            &self,
            input: http::Request,
            cancellation: CancellationToken,
        ) -> BoxFuture<'_, Result<http::Response, ModelError>> {
            Box::pin(async move {
                let _input = input;
                self.entered.notify_one();
                cancellation.cancelled().await;
                self.cancelled.notify_one();
                self.release.notified().await;
                self.settled.store(true, Ordering::SeqCst);
                Err(if self.unknown {
                    ModelError::CleanupUnconfirmed
                } else {
                    ModelError::Cancelled
                })
            })
        }
        fn connect(&self, _: Connect) -> BoxFuture<'_, Result<Arc<dyn Socket>, ModelError>> {
            Box::pin(async { Err(ModelError::Adapter("unused fixture transport".into())) })
        }
    }
    #[derive(Clone, Copy)]
    enum ResponseEnd {
        Completed,
        Cancelled,
        Disconnected,
        CleanupUnknown,
    }
    struct HeldResponse {
        reading: Notify,
        release: Notify,
        closed: AtomicBool,
        end: ResponseEnd,
    }
    impl http::Body for HeldResponse {
        fn next(&self) -> BoxFuture<'_, Result<Option<Vec<u8>>, http::Error>> {
            Box::pin(async move {
                self.reading.notify_one();
                self.release.notified().await;
                match self.end {
                    ResponseEnd::Completed | ResponseEnd::CleanupUnknown => Ok(Some(
                        b"data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n".to_vec(),
                    )),
                    ResponseEnd::Disconnected => Err(http::Error::Failed("connection lost".into())),
                    ResponseEnd::Cancelled => unreachable!("cancelled read must be abandoned"),
                }
            })
        }
        fn cancel(&self) {}
        fn close(&self) -> BoxFuture<'_, Result<(), http::Error>> {
            Box::pin(async move {
                self.closed.store(true, Ordering::SeqCst);
                if matches!(self.end, ResponseEnd::CleanupUnknown) {
                    Err(http::Error::CleanupUnconfirmed)
                } else {
                    Ok(())
                }
            })
        }
    }
    struct Uploaded {
        response: Arc<HeldResponse>,
        owner: std::sync::Weak<()>,
    }
    impl Transport for Uploaded {
        fn identity(&self) -> u64 {
            0
        }
        fn request(
            &self,
            input: http::Request,
            _: CancellationToken,
        ) -> BoxFuture<'_, Result<http::Response, ModelError>> {
            use futures_util::StreamExt;
            Box::pin(async move {
                assert!(
                    self.owner.upgrade().is_some(),
                    "upload must retain its source owner"
                );
                let replay = input.body.replay().expect("Responses upload is replayable");
                let mut original = input.body.into_stream();
                let mut bytes = Vec::new();
                while let Some(chunk) = original.next().await {
                    bytes.extend_from_slice(&chunk.unwrap());
                }
                drop(original);
                assert!(
                    self.owner.upgrade().is_some(),
                    "replay must retain its source owner"
                );
                let mut replay = replay.into_stream();
                let mut replayed = Vec::new();
                while let Some(chunk) = replay.next().await {
                    replayed.extend_from_slice(&chunk.unwrap());
                }
                drop(replay);
                assert_eq!(bytes, replayed);
                let body: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(body["model"], "fixture");
                assert_eq!(body["input"][0]["content"][0]["text"], "hello");
                Ok(http::Response {
                    head: http::Head {
                        status: 200,
                        url: input.url,
                        headers: vec![("content-type".into(), b"text/event-stream".to_vec())],
                    },
                    body: self.response.clone(),
                })
            })
        }
        fn connect(&self, _: Connect) -> BoxFuture<'_, Result<Arc<dyn Socket>, ModelError>> {
            Box::pin(async { Err(ModelError::Adapter("unused fixture transport".into())) })
        }
    }
    struct Sink;
    impl Events for Sink {
        fn emit(
            &self,
            _: maka_agent_ports::model::Emission,
        ) -> BoxFuture<'_, Result<(), ModelError>> {
            Box::pin(async { Ok(()) })
        }
    }

    #[tokio::test]
    async fn settled_upload_releases_request_owner_while_response_is_pending() {
        use maka_agent_facts::{
            language::Language,
            model::{
                prompt::Message,
                prompt_source::{Prompt, PromptInstructions},
            },
        };
        for end in [
            ResponseEnd::Completed,
            ResponseEnd::Cancelled,
            ResponseEnd::Disconnected,
            ResponseEnd::CleanupUnknown,
        ] {
            let owner = Arc::new(());
            let weak = Arc::downgrade(&owner);
            let response = Arc::new(HeldResponse {
                reading: Notify::new(),
                release: Notify::new(),
                closed: AtomicBool::new(false),
                end,
            });
            let network = Arc::new(Uploaded {
                response: response.clone(),
                owner: weak.clone(),
            });
            let request = ModelRequest {
                language: Language::En,
                provider: maka_agent_ports::model::Provider {
                    kind: ProviderKind::OpenaiResponses,
                    model: "fixture".into(),
                    base_url: "https://fixture.invalid/v1".into(),
                    auth: ProviderAuth::ApiKey("fixture-key".into()),
                    headers: BTreeMap::new(),
                    body_overlay: None,
                },
                prompt: Prompt::from_messages(vec![Message::user("hello")])
                    .with_instruction_source(PromptInstructions::empty().with_owner(owner)),
                tools: vec![],
                provider_options: serde_json::json!({}),
                max_output_tokens: None,
            };
            let cancellation = CancellationToken::new();
            let mut task = tokio::spawn(run(
                request,
                0,
                Context {
                    events: Arc::new(Sink),
                    cancellation: cancellation.clone(),
                    idle_timeout: Duration::from_secs(10),
                    transport: network,
                },
                None,
                Arc::new(Shared::default()),
            ));
            tokio::select! {
                _ = response.reading.notified() => {}
                result = &mut task => panic!("adapter ended before held response: {result:?}"),
            }
            assert!(
                !task.is_finished(),
                "provider response must still be pending"
            );
            assert!(
                weak.upgrade().is_none(),
                "settled uploads must not leave their owner in the original request"
            );
            if matches!(end, ResponseEnd::Cancelled) {
                cancellation.cancel();
            } else {
                response.release.notify_one();
            }
            let result = task.await.unwrap();
            match end {
                ResponseEnd::Completed => assert!(result.is_ok(), "{result:?}"),
                ResponseEnd::Cancelled => assert!(matches!(result, Err(ModelError::Cancelled))),
                ResponseEnd::Disconnected => assert!(matches!(
                    result,
                    Err(ModelError::Provider(failure))
                        if failure.reason() == ProviderFailureReason::Network && failure.replay_safe()
                )),
                ResponseEnd::CleanupUnknown => {
                    assert!(matches!(result, Err(ModelError::CleanupUnconfirmed)))
                }
            }
            assert!(response.closed.load(Ordering::SeqCst));
        }
    }

    #[tokio::test]
    async fn cancellation_and_idle_timeout_wait_for_upload_settlement() {
        for (timeout, unknown) in [(false, false), (true, false), (false, true), (true, true)] {
            let network = Arc::new(Draining {
                unknown,
                ..Default::default()
            });
            let cancellation = CancellationToken::new();
            let task_network = network.clone();
            let task_cancel = cancellation.clone();
            let task = tokio::spawn(async move {
                let decoder = Decoder::new(None, &[]);
                request_http(
                    task_network.as_ref(),
                    http::Request {
                        method: http::Method::Post,
                        url: "http://fixture.invalid".into(),
                        headers: vec![],
                        body: Default::default(),
                    },
                    &task_cancel,
                    if timeout {
                        Duration::from_millis(10)
                    } else {
                        Duration::from_secs(10)
                    },
                    &decoder,
                )
                .await
            });
            network.entered.notified().await;
            if !timeout {
                cancellation.cancel();
            }
            network.cancelled.notified().await;
            assert!(
                !task.is_finished(),
                "the deadline must not discard an unsettled upload future"
            );
            assert!(!network.settled.load(Ordering::SeqCst));
            network.release.notify_one();
            let result = task.await.unwrap();
            if unknown {
                assert!(
                    matches!(result, Err(ModelError::CleanupUnconfirmed)),
                    "cancellation must not hide unconfirmed cleanup"
                );
            } else if timeout {
                assert!(
                    matches!(result, Err(ModelError::Provider(failure)) if failure.reason() == ProviderFailureReason::TimedOut)
                );
            } else {
                assert!(matches!(result, Err(ModelError::Cancelled)));
            }
            assert!(network.settled.load(Ordering::SeqCst));
        }
    }
}

#[cfg(test)]
mod quota_tests {
    use super::*;
    use futures_util::future::BoxFuture;
    use maka_agent_ports::model::Emission;
    use serde_json::json;

    struct NoEvents;
    impl Events for NoEvents {
        fn emit(&self, _: Emission) -> BoxFuture<'_, Result<(), ModelError>> {
            Box::pin(async { panic!("a failed response must not emit model output") })
        }
    }

    // SSE and WebSocket frames both enter this decoder/emission boundary.
    #[tokio::test]
    async fn responses_quota_frame_keeps_scope_diagnostics_and_replay_safety() {
        let sender: Arc<dyn Events> = Arc::new(NoEvents);
        for (endpoint, reason) in [
            (
                "https://api.z.ai/api/paas/v4",
                ProviderFailureReason::QuotaExhausted,
            ),
            ("https://other.invalid", ProviderFailureReason::RateLimit),
        ] {
            let mut decoder = Decoder::new(None, &[]);
            decoder
                .push(json!({"type":"response.future_call.in_progress"}))
                .unwrap();
            let error = emit(
                &mut decoder,
                json!({"type":"response.failed","response":{"error":{"type":"rate_limit_error","code":"1308","message":"original quota diagnostic"}}}),
                QuotaScope::endpoint(endpoint),
                &sender,
                &CancellationToken::new(),
            ).await.unwrap_err();
            let ModelError::Provider(failure) = error else {
                panic!("expected typed response failure: {error}")
            };
            assert_eq!(failure.reason(), reason);
            assert_eq!(failure.message(), "original quota diagnostic");
            assert_eq!(failure.code(), Some("1308"));
            assert!(!failure.replay_safe());
            assert_eq!(
                failure.retryable(),
                reason == ProviderFailureReason::RateLimit
            );
        }
    }
}
